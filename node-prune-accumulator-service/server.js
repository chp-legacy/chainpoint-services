/* Copyright (C) 2017 Tierion
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
*/

// load all environment variables into env object
const env = require('./lib/parse-env.js')('prune-accumulator')

const amqp = require('amqplib')
const r = require('redis')
const utils = require('./lib/utils.js')
const bluebird = require('bluebird')
const debugPkg = require('debug')
const nodeResque = require('node-resque')
const exitHook = require('exit-hook')
const { URL } = require('url')

const cachedProofState = require('./lib/models/cachedProofStateModels.js')

var debug = {
  general: debugPkg('prune-accumulator:general'),
  tasking: debugPkg('prune-accumulator:tasking')
}

const PRUNE_HASHES_KEY = 'PruneAggStateHashes'

// Variable indicating if accumulation pool is currently being drained
let POOL_DRAINING = false

// The number of items to include in a single batch delete command
let pruneBatchSize = 500

// The channel used for all amqp communication
// This value is set once the connection has been established
var amqpChannel = null

// This value is set once the connection has been established
let redis = null

// This value is set once the connection has been established
let taskQueue = null

async function consumePruneMessageAsync (msg) {
  if (msg !== null) {
    let hashId = msg.content.toString()

    try {
      // add the hashId to the redis set
      await redis.saddAsync(PRUNE_HASHES_KEY, hashId)
      amqpChannel.ack(msg)
    } catch (error) {
      amqpChannel.nack(msg)
      console.error(env.RMQ_WORK_IN_PRUNE_ACC_QUEUE, 'consume message nacked')
    }
  }
}

async function drainHashPoolAsync () {
  if (!POOL_DRAINING) {
    POOL_DRAINING = true

    let currentHashCount = await redis.scardAsync(PRUNE_HASHES_KEY)
    let pruneBatchesNeeded = Math.ceil(currentHashCount / pruneBatchSize)
    debug.general(`${currentHashCount} hash_ids currently in pool`)
    for (let x = 0; x < pruneBatchesNeeded; x++) {
      let hashIds = await redis.spopAsync(PRUNE_HASHES_KEY, pruneBatchSize)
      // delete the agg_states proof state rows for these hash_ids
      try {
        await taskQueue.enqueue('task-handler-queue', `prune_agg_states_ids`, [hashIds])
        debug.tasking(`${hashIds.length} hash_ids queued for deletion`)
      } catch (error) {
        console.error(`Could not enqueue prune task : ${error.message}`)
      }
    }

    POOL_DRAINING = false
  }
}

/**
 * Opens a storage connection
 **/
async function openStorageConnectionAsync () {
  let dbConnected = false
  while (!dbConnected) {
    try {
      await cachedProofState.openConnectionAsync()
      debug.general('Sequelize connection established')
      dbConnected = true
    } catch (error) {
      // catch errors when attempting to establish connection
      console.error('Cannot establish Sequelize connection. Attempting in 5 seconds...')
      await utils.sleep(5000)
    }
  }
}

/**
 * Opens a Redis connection
 *
 * @param {string} connectionString - The connection string for the Redis instance, an Redis URI
 */
function openRedisConnection (redisURI) {
  redis = r.createClient(redisURI)
  redis.on('ready', () => {
    bluebird.promisifyAll(redis)
    cachedProofState.setRedis(redis)
    debug.general('Redis connection established')
  })
  redis.on('error', async (err) => {
    console.error(`A redis error has ocurred: ${err}`)
    redis.quit()
    redis = null
    cachedProofState.setRedis(null)
    POOL_DRAINING = false
    console.error('Cannot establish Redis connection. Attempting in 5 seconds...')
    await utils.sleep(5000)
    openRedisConnection(redisURI)
  })
}

/**
 * Opens an AMPQ connection and channel
 * Retry logic is included to handle losses of connection
 *
 * @param {string} connectionString - The connection string for the RabbitMQ instance, an AMQP URI
 */
async function openRMQConnectionAsync (connectionString) {
  let rmqConnected = false
  while (!rmqConnected) {
    try {
      // connect to rabbitmq server
      let conn = await amqp.connect(connectionString)
      // create communication channel
      let chan = await conn.createConfirmChannel()
      // the connection and channel have been established
      chan.assertQueue(env.RMQ_WORK_IN_PRUNE_ACC_QUEUE, { durable: true })
      chan.prefetch(env.RMQ_PREFETCH_COUNT_PRUNE_ACC)
      amqpChannel = chan
      // Continuously load the agg_ids to be accumulated and pruned in batches
      chan.consume(env.RMQ_WORK_IN_PRUNE_ACC_QUEUE, (msg) => {
        consumePruneMessageAsync(msg)
      })
      // if the channel closes for any reason, attempt to reconnect
      conn.on('close', async () => {
        console.error('Connection to RMQ closed.  Reconnecting in 5 seconds...')
        amqpChannel = null
        await utils.sleep(5000)
        await openRMQConnectionAsync(connectionString)
      })
      debug.general('RabbitMQ connection established')
      rmqConnected = true
    } catch (error) {
      // catch errors when attempting to establish connection
      console.error('Cannot establish RabbitMQ connection. Attempting in 5 seconds...')
      await utils.sleep(5000)
    }
  }
}

/**
 * Initializes the connection to the Resque queue when Redis is ready
 */
async function initResqueQueueAsync () {
  // wait until redis is initialized
  let redisReady = (redis !== null)
  while (!redisReady) {
    await utils.sleep(100)
    redisReady = (redis !== null)
  }
  const redisURI = new URL(env.REDIS_CONNECT_URI)
  var connectionDetails = {
    host: redisURI.hostname,
    port: redisURI.port,
    namespace: 'resque'
  }

  const queue = new nodeResque.Queue({ connection: connectionDetails })
  queue.on('error', function (error) { debug.general(error) })
  await queue.connect()
  taskQueue = queue

  exitHook(async () => {
    await queue.end()
  })

  debug.general('Resque queue connection established')
}

// This initalizes all the JS intervals that fire all aggregator events
function startIntervals () {
  debug.general('starting intervals')

  // PERIODIC TIMERS
  setInterval(() => drainHashPoolAsync(), 5000)
}

// process all steps need to start the application
async function start () {
  try {
    // init DB
    await openStorageConnectionAsync()
    // init Redis
    openRedisConnection(env.REDIS_CONNECT_URI)
    // init RabbitMQ
    await openRMQConnectionAsync(env.RABBITMQ_CONNECT_URI)
    // init Resque queue
    await initResqueQueueAsync()
    // init interval functions
    startIntervals()
    debug.general('startup completed successfully')
  } catch (error) {
    console.error(`An error has occurred on startup: ${error.message}`)
    process.exit(1)
  }
}

// get the whole show started
start()
