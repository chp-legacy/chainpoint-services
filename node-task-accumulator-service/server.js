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
const utils = require('./lib/utils.js')
const debugPkg = require('debug')
const connections = require('./lib/connections.js')

var debug = {
  general: debugPkg('task-accumulator:general'),
  pruneAgg: debugPkg('task-accumulator:prune_agg'),
  writeAuditLog: debugPkg('task-accumulator:write_audit_log'),
  updateAuditScore: debugPkg('task-accumulator:update_audit_score')
}
// direct debug to output over STDOUT
debugPkg.log = console.info.bind(console)

let PRUNE_AGG_STATES_POOL = []
let AUDIT_LOG_WRITE_POOL = []
let AUDIT_SCORE_UPDATE_POOL = []

// Variable indicating if prune agg states accumulation pool is currently being drained
let PRUNE_AGG_STATES_POOL_DRAINING = false

// The number of items to include in a single batch delete command
let pruneAggStatesBatchSize = 500

// Variable indicating if audit log write accumulation pool is currently being drained
let AUDIT_LOG_WRITE_POOL_DRAINING = false

// The number of items to include in a single batch audit log write command
let auditLogWriteBatchSize = 500

// Variable indicating if update node audit score accumulation pool is currently being drained
let AUDIT_SCORE_UPDATE_POOL_DRAINING = false

// The number of items to include in a single batch node audit score update (insert on conflict update) command
let auditScoreUpdateBatchSize = 1000

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
      case 'update_node_audit_score':
        // Consumes an audit score update message from the task handler
        // accumulates audit score update tasks and issues batch to task handler
        consumeUpdateAuditScoreMessageAsync(msg)
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

    // add msg to the hash object so that we can ack it later
    let hashObj = {
      hashId: hashId,
      msg: msg
    }
    PRUNE_AGG_STATES_POOL.push(hashObj)
  }
}

async function consumeWriteAuditLogMessageAsync (msg) {
  if (msg !== null) {
    let auditDataJSON = msg.content.toString()

    // add msg to the auditData object so that we can ack it later
    let auditDataObj = {
      auditDataJSON: auditDataJSON,
      msg: msg
    }
    AUDIT_LOG_WRITE_POOL.push(auditDataObj)
  }
}

async function consumeUpdateAuditScoreMessageAsync (msg) {
  if (msg !== null) {
    let scoreUpdateJSON = msg.content.toString()

    // add msg to the scoreUpdate object so that we can ack it later
    let scoreUpdateObj = {
      scoreUpdateJSON: scoreUpdateJSON,
      msg: msg
    }
    AUDIT_SCORE_UPDATE_POOL.push(scoreUpdateObj)
  }
}

async function drainPruneAggStatesPoolAsync () {
  if (!PRUNE_AGG_STATES_POOL_DRAINING && amqpChannel != null) {
    PRUNE_AGG_STATES_POOL_DRAINING = true

    let currentHashCount = PRUNE_AGG_STATES_POOL.length
    let pruneBatchesNeeded = Math.ceil(currentHashCount / pruneAggStatesBatchSize)
    if (currentHashCount > 0) debug.pruneAgg(`${currentHashCount} hash_ids currently in pool`)
    for (let x = 0; x < pruneBatchesNeeded; x++) {
      let pruneAggStatesObjs = PRUNE_AGG_STATES_POOL.splice(0, pruneAggStatesBatchSize)
      let hashIds = pruneAggStatesObjs.map((item) => item.hashId)
      // delete the agg_states proof state rows for these hash_ids
      try {
        await taskQueue.enqueue('task-handler-queue', `prune_agg_states_ids`, [hashIds])
        debug.pruneAgg(`${hashIds.length} hash_ids queued for deletion`)

        // This batch has been submitted to task handler successfully
        // ack consumption of all original messages part of this batch
        pruneAggStatesObjs.forEach((item) => {
          if (item.msg !== null) {
            amqpChannel.ack(item.msg)
          }
        })
      } catch (error) {
        console.error(`Could not enqueue prune task : ${error.message}`)
        // nack consumption of all original messages part of this batch
        pruneAggStatesObjs.forEach((item) => {
          if (item.msg !== null) {
            amqpChannel.nack(item.msg)
          }
        })
      }
    }

    PRUNE_AGG_STATES_POOL_DRAINING = false
  }
}

async function drainAuditLogWritePoolAsync () {
  if (!AUDIT_LOG_WRITE_POOL_DRAINING && amqpChannel != null) {
    AUDIT_LOG_WRITE_POOL_DRAINING = true

    let currentPendingWriteCount = AUDIT_LOG_WRITE_POOL.length
    let writeBatchesNeeded = Math.ceil(currentPendingWriteCount / auditLogWriteBatchSize)
    if (currentPendingWriteCount > 0) debug.writeAuditLog(`${currentPendingWriteCount} pending audit log writes currently in pool`)
    for (let x = 0; x < writeBatchesNeeded; x++) {
      let pendingWriteObjs = AUDIT_LOG_WRITE_POOL.splice(0, auditLogWriteBatchSize)
      let auditDataJSON = pendingWriteObjs.map((item) => item.auditDataJSON)
      // write the audit log items to the database
      try {
        await taskQueue.enqueue('task-handler-queue', `write_audit_log_items`, [auditDataJSON])
        debug.writeAuditLog(`${auditDataJSON.length} audit log items queued for writing`)

        // This batch has been submitted to task handler successfully
        // ack consumption of all original messages part of this batch
        pendingWriteObjs.forEach((item) => {
          if (item.msg !== null) {
            amqpChannel.ack(item.msg)
          }
        })
      } catch (error) {
        console.error(`Could not enqueue write task : ${error.message}`)
        // nack consumption of all original messages part of this batch
        pendingWriteObjs.forEach((item) => {
          if (item.msg !== null) {
            amqpChannel.nack(item.msg)
          }
        })
      }
    }

    AUDIT_LOG_WRITE_POOL_DRAINING = false
  }
}

async function drainAuditScoreUpdatePoolAsync () {
  if (!AUDIT_SCORE_UPDATE_POOL_DRAINING && amqpChannel != null) {
    AUDIT_SCORE_UPDATE_POOL_DRAINING = true

    let currentPendingUpdateCount = AUDIT_SCORE_UPDATE_POOL.length
    let updateBatchesNeeded = Math.ceil(currentPendingUpdateCount / auditScoreUpdateBatchSize)
    if (currentPendingUpdateCount > 0) debug.updateAuditScore(`${currentPendingUpdateCount} pending audit score updates currently in pool`)
    for (let x = 0; x < updateBatchesNeeded; x++) {
      let pendingUpdateObjs = AUDIT_SCORE_UPDATE_POOL.splice(0, auditScoreUpdateBatchSize)
      let scoreUpdateJSON = pendingUpdateObjs.map((item) => item.scoreUpdateJSON)
      // update audit scores in the database
      try {
        await taskQueue.enqueue('task-handler-queue', `update_audit_score_items`, [scoreUpdateJSON])
        debug.updateAuditScore(`${scoreUpdateJSON.length} audit score items queued for updating`)

        // This batch has been submitted to task handler successfully
        // ack consumption of all original messages part of this batch
        pendingUpdateObjs.forEach((item) => {
          if (item.msg !== null) {
            amqpChannel.ack(item.msg)
          }
        })
      } catch (error) {
        console.error(`Could not enqueue update task : ${error.message}`)
        // nack consumption of all original messages part of this batch
        pendingUpdateObjs.forEach((item) => {
          if (item.msg !== null) {
            amqpChannel.nack(item.msg)
          }
        })
      }
    }

    AUDIT_SCORE_UPDATE_POOL_DRAINING = false
  }
}

/**
 * Opens a Redis connection
 *
 * @param {string} redisURI - The connection string for the Redis instance, an Redis URI
 */
function openRedisConnection (redisURIs) {
  connections.openRedisConnection(redisURIs,
    (newRedis) => {
      redis = newRedis
      initResqueQueueAsync()
    }, () => {
      redis = null
      taskQueue = null
      PRUNE_AGG_STATES_POOL_DRAINING = false
      AUDIT_LOG_WRITE_POOL_DRAINING = false
      setTimeout(() => { openRedisConnection(redisURIs) }, 5000)
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
        // un-acked messaged will be requeued, so clear all work in progress
        PRUNE_AGG_STATES_POOL = []
        AUDIT_LOG_WRITE_POOL = []
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
  taskQueue = await connections.initResqueQueueAsync(redis, 'resque')
}

// This initalizes all the JS intervals that fire all aggregator events
function startIntervals () {
  debug.general('starting intervals')

  // PERIODIC TIMERS
  setInterval(() => drainPruneAggStatesPoolAsync(), 1000)
  setInterval(() => drainAuditLogWritePoolAsync(), 1000)
  setInterval(() => drainAuditScoreUpdatePoolAsync(), 1000)
}

// process all steps need to start the application
async function start () {
  try {
    // init Redis
    openRedisConnection(env.REDIS_CONNECT_URIS)
    // init RabbitMQ
    await openRMQConnectionAsync(env.RABBITMQ_CONNECT_URI)
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
