/* Copyright (C) 2018 Tierion
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
const env = require('./lib/parse-env.js')('task-accumulator')

const amqp = require('amqplib')
const r = require('redis')
const utils = require('./lib/utils.js')
const bluebird = require('bluebird')
const debugPkg = require('debug')
const nodeResque = require('node-resque')
const exitHook = require('exit-hook')
const { URL } = require('url')

var debug = {
  general: debugPkg('task-accumulator:general'),
  pruneAgg: debugPkg('task-accumulator:prune_agg'),
  writeAuditLog: debugPkg('task-accumulator:write_audit_log')
}
// direct debug to output over STDOUT
debugPkg.log = console.info.bind(console)

const PRUNE_AGG_STATES_KEY = 'Task_Acc:PruneAggStates'
const AUDIT_LOG_WRITES_KEY = 'Task_Acc:AuditLogWrites'

// Variable indicating if prune agg states accumulation pool is currently being drained
let PRUNE_AGG_STATES_POOL_DRAINING = false

// The number of items to include in a single batch delete command
let pruneAggStatesBatchSize = 500

// Variable indicating if audit log write accumulation pool is currently being drained
let AUDIT_LOG_WRITE_POOL_DRAINING = false

// The number of items to include in a single batch audit log write command
let auditLogWriteBatchSize = 500

// The channel used for all amqp communication
// This value is set once the connection has been established
var amqpChannel = null

// This value is set once the connection has been established
let redis = null

// This value is set once the connection has been established
let taskQueue = null

/**
* Parses a message and performs the required work for that message
*
* @param {amqp message object} msg - The AMQP message received from the queue
*/
function processMessage (msg) {
  if (msg !== null) {
    // determine the source of the message and handle appropriately
    switch (msg.properties.type) {
      case 'prune_agg':
        // Consumes a prune message from the proof gen
        // accumulates prune tasks and issues batch to task handler
        consumePruneAggMessageAsync(msg)
        break
      case 'write_audit_log':
        // Consumes an audit log write message from the task handler
        // accumulates audit log write tasks and issues batch to task handler
        consumeWriteAuditLogMessageAsync(msg)
        break
      default:
        // This is an unknown state type
        console.error(`Unknown state type: ${msg.properties.type}`)
        // cannot handle unknown type messages, ack message and do nothing
        amqpChannel.ack(msg)
    }
  }
}

async function consumePruneAggMessageAsync (msg) {
  if (msg !== null) {
    let hashId = msg.content.toString()

    try {
      // add the hashId to the redis set
      await redis.saddAsync(PRUNE_AGG_STATES_KEY, hashId)
      amqpChannel.ack(msg)
    } catch (error) {
      amqpChannel.nack(msg)
      console.error(env.RMQ_WORK_IN_TASK_ACC_QUEUE, `[${msg.properties.type}] consume message nacked`)
    }
  }
}

async function consumeWriteAuditLogMessageAsync (msg) {
  if (msg !== null) {
    let auditDataJSON = msg.content.toString()

    try {
      // add the hashId to the redis set
      await redis.saddAsync(AUDIT_LOG_WRITES_KEY, auditDataJSON)
      amqpChannel.ack(msg)
    } catch (error) {
      amqpChannel.nack(msg)
      console.error(env.RMQ_WORK_IN_TASK_ACC_QUEUE, `[${msg.properties.type}] consume message nacked`)
    }
  }
}

async function drainPruneAggStatesPoolAsync () {
  if (!PRUNE_AGG_STATES_POOL_DRAINING) {
    PRUNE_AGG_STATES_POOL_DRAINING = true

    let pooledHashIds = await redis.smembersAsync(PRUNE_AGG_STATES_KEY)
    let pooledHashIdsCount = pooledHashIds.length
    if (pooledHashIdsCount > 0) debug.pruneAgg(`${pooledHashIdsCount} hash_ids currently in pool`)
    for (let x = 0; x < pooledHashIdsCount; x += pruneAggStatesBatchSize) {
      let rangeStart = pruneAggStatesBatchSize * x
      let rangeEnd = rangeStart + pruneAggStatesBatchSize
      let hashIds = pooledHashIds.slice(rangeStart, rangeEnd)
      // delete the agg_states proof state rows for these hash_ids
      try {
        await taskQueue.enqueue('task-handler-queue', `prune_agg_states_ids`, [hashIds])
        debug.pruneAgg(`${hashIds.length} hash_ids queued for deletion`)
        // process suceeded, remove items from redis
        hashIds.unshift(PRUNE_AGG_STATES_KEY)
        await redis.send_commandAsync('srem', hashIds)
      } catch (error) {
        console.error(`Could not enqueue prune task : ${error.message}`)
      }
    }

    PRUNE_AGG_STATES_POOL_DRAINING = false
  }
}

async function drainAuditLogWritePoolAsync () {
  if (!AUDIT_LOG_WRITE_POOL_DRAINING) {
    AUDIT_LOG_WRITE_POOL_DRAINING = true

    let pooledPendingWrites = await redis.smembersAsync(AUDIT_LOG_WRITES_KEY)
    let pooledPendingWritesCount = pooledPendingWrites.length
    if (pooledPendingWritesCount > 0) debug.writeAuditLog(`${pooledPendingWritesCount} pending audit log writes currently in pool`)
    for (let x = 0; x < pooledPendingWritesCount; x += auditLogWriteBatchSize) {
      let rangeStart = auditLogWriteBatchSize * x
      let rangeEnd = rangeStart + auditLogWriteBatchSize
      let pendingWrites = pooledPendingWrites.slice(rangeStart, rangeEnd)
      // delete the agg_states proof state rows for these hash_ids
      try {
        await taskQueue.enqueue('task-handler-queue', `write_audit_log_items`, [pendingWrites])
        debug.writeAuditLog(`${pendingWrites.length} audit log items queued for writing`)
        // process suceeded, remove items from redis
        pendingWrites.unshift(AUDIT_LOG_WRITES_KEY)
        await redis.send_commandAsync('srem', pendingWrites)
      } catch (error) {
        console.error(`Could not enqueue write task : ${error.message}`)
      }
    }

    AUDIT_LOG_WRITE_POOL_DRAINING = false
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
    debug.general('Redis connection established')
  })
  redis.on('error', async (err) => {
    console.error(`A redis error has ocurred: ${err}`)
    redis.quit()
    redis = null
    PRUNE_AGG_STATES_POOL_DRAINING = false
    AUDIT_LOG_WRITE_POOL_DRAINING = false
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
      chan.assertQueue(env.RMQ_WORK_IN_TASK_ACC_QUEUE, { durable: true })
      chan.prefetch(env.RMQ_PREFETCH_COUNT_TASK_ACC)
      amqpChannel = chan
      // Continuously load the agg_ids to be accumulated and pruned in batches
      chan.consume(env.RMQ_WORK_IN_TASK_ACC_QUEUE, (msg) => {
        processMessage(msg)
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
  setInterval(() => drainPruneAggStatesPoolAsync(), 1000)
  setInterval(() => drainAuditLogWritePoolAsync(), 1000)
}

// process all steps need to start the application
async function start () {
  try {
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
