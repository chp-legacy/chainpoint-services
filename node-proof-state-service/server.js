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
const env = require('./lib/parse-env.js')('state')

const amqp = require('amqplib')
const utils = require('./lib/utils.js')
const leaderElection = require('exp-leader-election')
const connections = require('./lib/connections.js')

const cachedProofState = require('./lib/models/cachedProofStateModels.js')

// The channel used for all amqp communication
// This value is set once the connection has been established
var amqpChannel = null

// The leadership status for this instance of the proof state service
let IS_LEADER = false

// The redis connection used for all redis communication
// This value is set once the connection has been established
let redis = null

// This value is set once the connection has been established
let taskQueue = null

const CAL_STATE_WRITE_BATCH_SIZE = 200
const CAL_PROOF_GEN_BATCH_SIZE = 2500
const ANCHOR_BTC_STATE_WRITE_BATCH_SIZE = 200
const BTC_PROOF_GEN_BATCH_SIZE = 2500

/**
* Writes the state data to persistent storage and logs aggregation event
*
* @param {amqp message object} msg - The AMQP message received from the queue
*/
async function ConsumeAggregationMessageAsync (msg) {
  let messageObj = JSON.parse(msg.content.toString())

  let stateObjects = []
  for (let x = 0; x < messageObj.proofData.length; x++) {
    let stateObj = {}
    stateObj.hash_id = messageObj.proofData[x].hash_id
    stateObj.hash = messageObj.proofData[x].hash
    stateObj.agg_id = messageObj.agg_id
    stateObj.agg_state = {}
    stateObj.agg_state.ops = messageObj.proofData[x].proof
    stateObjects.push(stateObj)
  }

  try {
    // Store this state information
    await cachedProofState.writeAggStateObjectsBulkAsync(stateObjects)

    let aggObj = {}
    aggObj.agg_id = messageObj.agg_id
    aggObj.agg_root = messageObj.agg_root

    try {
      await amqpChannel.sendToQueue(env.RMQ_WORK_OUT_CAL_QUEUE, Buffer.from(JSON.stringify(aggObj)), { persistent: true, type: 'aggregator' })
      console.log(env.RMQ_WORK_OUT_CAL_QUEUE, '[aggregator] publish message acked', aggObj.agg_id)
    } catch (error) {
      console.error(`${env.RMQ_WORK_OUT_CAL_QUEUE} [aggregator] publish message nacked ${aggObj.agg_id}`)
      throw new Error(error.message)
    }

    // New states has been written, events logged, and cal message queued, ack consumption of original message
    amqpChannel.ack(msg)
    console.log(`${msg.fields.routingKey} [${msg.properties.type}] consume message acked`)
  } catch (error) {
    amqpChannel.nack(msg)
    console.error(`${msg.fields.routingKey} [${msg.properties.type}] consume message nacked: ${error.message}`)
  }
}

/**
* Writes the state data to persistent storage and queues proof ready messages bound for the proof gen
*
* @param {amqp message object} msg - The AMQP message received from the queue
*/
async function ConsumeCalendarMessageAsync (msg) {
  let messageObj = JSON.parse(msg.content.toString())
  let stateObj = {}
  stateObj.agg_id = messageObj.agg_id
  stateObj.cal_id = messageObj.cal_id
  stateObj.cal_state = messageObj.cal_state

  try {
    // CRDB
    let rows = await cachedProofState.getHashIdsByAggIdAsync(stateObj.agg_id)

    await cachedProofState.writeCalStateObjectAsync(stateObj)

    for (let x = 0; x < rows.length; x++) {
      let hashIdRow = rows[x]
      // construct a calendar 'proof ready' message for a given hash
      let dataOutObj = {}
      dataOutObj.hash_id = hashIdRow.hash_id
      try {
        await amqpChannel.sendToQueue(env.RMQ_WORK_OUT_GEN_QUEUE, Buffer.from(JSON.stringify(dataOutObj)), { persistent: true, type: 'cal' })
      } catch (error) {
        console.error(env.RMQ_WORK_OUT_GEN_QUEUE, '[cal] publish message nacked')
        throw new Error(error.message)
      }
    }
    // New messages have been published, ack consumption of original message
    amqpChannel.ack(msg)
    console.log(msg.fields.routingKey, '[' + msg.properties.type + '] consume message acked')
  } catch (error) {
    console.error(`Unable to process calendar message: ${error.message}`)
    // An error as occurred publishing a message, nack consumption of original message
    amqpChannel.nack(msg)
    console.error(`${msg.fields.routingKey} [${msg.properties.type}] consume message nacked: ${error.message}`)
  }
}

/**
* Writes the state data to persistent storage and queues proof ready messages bound for the proof gen
*
* @param {amqp message object} msg - The AMQP message received from the queue
*/
async function ConsumeCalendarBatchMessageAsync (msg) {
  let messageObj = JSON.parse(msg.content.toString())

  // transform batch message data into cal_state objects ready for insertion
  let stateObjs = messageObj.proofData.map((proofDataItem) => {
    return {
      agg_id: proofDataItem.agg_id,
      cal_id: messageObj.cal_id,
      cal_state: { ops: proofDataItem.proof, anchor: messageObj.anchor }
    }
  })

  try {
    // Get all the hash_ids for all the agg_ids part of this calendar block
    let aggIds = stateObjs.map((item) => item.agg_id)
    let hashIdRows = await cachedProofState.getHashIdsByAggIdsAsync(aggIds)
    let hashIds = hashIdRows.map((item) => item.hash_id)

    // Write the cal state objects to the database
    // The writes are split into batches to limit the total insert query size
    // CRDB has a query limit of 256k
    while (stateObjs.length > 0) {
      await cachedProofState.writeCalStateObjectsBulkAsync(stateObjs.splice(0, CAL_STATE_WRITE_BATCH_SIZE))
    }

    while (hashIds.length > 0) {
      // construct a calendar 'proof ready' message for a batch of hashes
      let dataOutObj = {}
      dataOutObj.hash_ids = hashIds.splice(0, CAL_PROOF_GEN_BATCH_SIZE)
      try {
        await amqpChannel.sendToQueue(env.RMQ_WORK_OUT_GEN_QUEUE, Buffer.from(JSON.stringify(dataOutObj)), { persistent: true, type: 'cal_batch' })
      } catch (error) {
        console.error(env.RMQ_WORK_OUT_GEN_QUEUE, '[cal] publish message nacked')
        throw new Error(error.message)
      }
    }

    // New messages have been published, ack consumption of original message
    amqpChannel.ack(msg)
    console.log(msg.fields.routingKey, '[' + msg.properties.type + '] consume message acked')
  } catch (error) {
    console.error(`Unable to process calendar message: ${error.message}`)
    // An error as occurred publishing a message, nack consumption of original message
    amqpChannel.nack(msg)
    console.error(`${msg.fields.routingKey} [${msg.properties.type}] consume message nacked: ${error.message}`)
  }
}

/**
* Writes the state data to persistent storage
*
* @param {amqp message object} msg - The AMQP message received from the queue
*/
async function ConsumeAnchorBTCAggMessageAsync (msg) {
  let messageObj = JSON.parse(msg.content.toString())
  let stateObj = {}
  stateObj.cal_id = messageObj.cal_id
  stateObj.anchor_btc_agg_id = messageObj.anchor_btc_agg_id
  stateObj.anchor_btc_agg_state = messageObj.anchor_btc_agg_state

  try {
    await cachedProofState.writeAnchorBTCAggStateObjectAsync(stateObj)

    // New message has been published and event logged, ack consumption of original message
    amqpChannel.ack(msg)
    console.log(`${msg.fields.routingKey} [${msg.properties.type}] consume message acked`)
  } catch (error) {
    amqpChannel.nack(msg)
    console.error(`${msg.fields.routingKey} [${msg.properties.type}] consume message nacked: ${error.message}`)
  }
}

/**
* Writes the state data to persistent storage
*
* @param {amqp message object} msg - The AMQP message received from the queue
*/
async function ConsumeAnchorBTCAggBatchMessageAsync (msg) {
  let messageObj = JSON.parse(msg.content.toString())

  // transform batch message data into cal_state objects ready for insertion
  let stateObjs = messageObj.proofData.map((proofDataItem) => {
    return {
      cal_id: proofDataItem.cal_id,
      anchor_btc_agg_id: messageObj.anchor_btc_agg_id,
      anchor_btc_agg_state: { ops: proofDataItem.proof }
    }
  })

  try {
    // Write the anchor_btc_agg state objects to the database
    // The writes are split into batches to limit the total insert query size
    // CRDB has a query limit of 256k
    while (stateObjs.length > 0) {
      await cachedProofState.writeAnchorBTCAggStateObjectsAsync(stateObjs.splice(0, ANCHOR_BTC_STATE_WRITE_BATCH_SIZE))
    }

    // New message has been published and event logged, ack consumption of original message
    amqpChannel.ack(msg)
    console.log(`${msg.fields.routingKey} [${msg.properties.type}] consume message acked`)
  } catch (error) {
    amqpChannel.nack(msg)
    console.error(`${msg.fields.routingKey} [${msg.properties.type}] consume message nacked: ${error.message}`)
  }
}

/**
* Writes the state data to persistent storage
*
* @param {amqp message object} msg - The AMQP message received from the queue
*/
async function ConsumeBtcTxMessageAsync (msg) {
  let messageObj = JSON.parse(msg.content.toString())
  let stateObj = {}
  stateObj.anchor_btc_agg_id = messageObj.anchor_btc_agg_id
  stateObj.btctx_id = messageObj.btctx_id
  stateObj.btctx_state = messageObj.btctx_state

  try {
    await cachedProofState.writeBTCTxStateObjectAsync(stateObj)

    // New message has been published and event logged, ack consumption of original message
    amqpChannel.ack(msg)
    console.log(`${msg.fields.routingKey} [${msg.properties.type}] consume message acked`)
  } catch (error) {
    amqpChannel.nack(msg)
    console.error(`${msg.fields.routingKey} [${msg.properties.type}] consume message nacked: ${error.message}`)
  }
}

/**
* Writes the state data to persistent storage and queues proof ready messages bound for the proof state service
*
* @param {amqp message object} msg - The AMQP message received from the queue
*/
async function ConsumeBtcMonMessageAsync (msg) {
  let messageObj = JSON.parse(msg.content.toString())
  let stateObj = {}
  stateObj.btctx_id = messageObj.btctx_id
  stateObj.btchead_height = messageObj.btchead_height
  stateObj.btchead_state = messageObj.btchead_state

  try {
    // Get all the hash_ids included in this btc_tx
    let hashIdRows = await cachedProofState.getHashIdsByBtcTxIdAsync(stateObj.btctx_id)
    let hashIds = hashIdRows.map((item) => item.hash_id)

    await cachedProofState.writeBTCHeadStateObjectAsync(stateObj)

    while (hashIds.length > 0) {
      // construct a btc 'proof ready' message for a batch of hashes
      let dataOutObj = {}
      dataOutObj.hash_ids = hashIds.splice(0, BTC_PROOF_GEN_BATCH_SIZE)
      try {
        await amqpChannel.sendToQueue(env.RMQ_WORK_OUT_GEN_QUEUE, Buffer.from(JSON.stringify(dataOutObj)), { persistent: true, type: 'btc_batch' })
      } catch (error) {
        console.error(env.RMQ_WORK_OUT_GEN_QUEUE, '[cal] publish message nacked')
        throw new Error(error.message)
      }
    }

    // New messages have been published, ack consumption of original message
    amqpChannel.ack(msg)
    console.log(msg.fields.routingKey, '[' + msg.properties.type + '] consume message acked')
  } catch (error) {
    console.error(`Unable to process btc mon message: ${error.message}`)
    // An error as occurred publishing a message, nack consumption of original message
    amqpChannel.nack(msg)
    console.error(`${msg.fields.routingKey} [${msg.properties.type}] consume message nacked: ${error.message}`)
  }
}

/**
* Prunes proof state data and hash tracker logs
* All hashb data that is logged as complete will be removed from all relevant tables
* This is required to be run regularly in order to keep the proof state database from growing too large
*
*/
async function PruneStateDataAsync () {
  try {
    // CRDB
    // remove all rows from agg_states that are older than the expiration age
    let results = await queueProofStatePruningTasks('agg_states')
    if (results.rowCount) console.log(`Pruning agg_states - ${results.rowCount} row(s) to be deleted in ${results.batchCount} batches`)
    // remove all rows from cal_states that are older than the expiration age
    results = await queueProofStatePruningTasks('cal_states')
    if (results.rowCount) console.log(`Pruned cal_states - ${results.rowCount} row(s) to be deleted in ${results.batchCount} batches`)
    // remove all rows from anchor_btc_agg_states that are older than the expiration age
    results = await queueProofStatePruningTasks('anchor_btc_agg_states')
    if (results.rowCount) console.log(`Pruned anchor_btc_agg_states - ${results.rowCount} row(s) to be deleted in ${results.batchCount} batches`)
    // remove all rows from btctx_states that are older than the expiration age
    results = await queueProofStatePruningTasks('btctx_states')
    if (results.rowCount) console.log(`Pruned btctx_states - ${results.rowCount} row(s) to be deleted in ${results.batchCount} batches`)
    // remove all rows from btchead_states that are older than the expiration age
    results = await queueProofStatePruningTasks('btchead_states')
    if (results.rowCount) console.log(`Pruned btchead_states - ${results.rowCount} row(s) to be deleted in ${results.batchCount} batches`)
  } catch (error) {
    console.error(`Unable to complete pruning process: ${error.message}`)
  }
}

async function queueProofStatePruningTasks (modelName) {
  // determine the primary key ids for each batch
  let primaryKeyValues = await cachedProofState.getExpiredPKValuesForModel(modelName)
  let pruneBatchTasks = []
  let pruneBatchSize = 500

  while (primaryKeyValues.length > 0) {
    let batch = primaryKeyValues.splice(0, pruneBatchSize)

    pruneBatchTasks.push(batch)
    console.log(`Created pruning batch for ${modelName} table ${batch[0]}...`)
  }

  // create and issue individual delete tasks for each batch
  for (let x = 0; x < pruneBatchTasks.length; x++) {
    try {
      await taskQueue.enqueue('task-handler-queue', `prune_${modelName}_ids`, [pruneBatchTasks[x]])
    } catch (error) {
      console.error(`Could not enqueue prune task : ${error.message}`)
    }
  }

  let results = {
    rowCount: primaryKeyValues.length,
    batchCount: pruneBatchTasks.length
  }

  return results
}

/**
* Parses a message and performs the required work for that message
*
* @param {amqp message object} msg - The AMQP message received from the queue
*/
function processMessage (msg) {
  if (msg !== null) {
    // determine the source of the message and handle appropriately
    switch (msg.properties.type) {
      case 'aggregator':
        // Consumes a state message from the Aggregator service
        // Stores state information and logs event in hash tracker
        ConsumeAggregationMessageAsync(msg)
        break
      case 'cal':
        // Consumes a calendar state message from the Calendar service
        // Stores state information and publishes proof ready messages bound for the proof gen service
        ConsumeCalendarMessageAsync(msg)
        break
      case 'cal_batch':
        // Consumes a calendar batch state message from the Calendar service
        // Stores the batch of state information and publishes proof ready messages bound for the proof gen service
        ConsumeCalendarBatchMessageAsync(msg)
        break
      case 'anchor_btc_agg':
        // Consumes a anchor BTC aggregation state message from the Calendar service
        // Stores state information for anchor agregation events
        ConsumeAnchorBTCAggMessageAsync(msg)
        break
      case 'anchor_btc_agg_batch':
        // Consumes a anchor BTC aggregation state message from the Calendar service
        // Stores state information for anchor agregation events
        ConsumeAnchorBTCAggBatchMessageAsync(msg)
        break
      case 'btctx':
        // Consumes a btctx state message from the Calendar service
        // Stores state information for btctx events
        ConsumeBtcTxMessageAsync(msg)
        break
      case 'btcmon':
        // Consumes a btcmon state message from the Calendar service
        // Stores state information for btcmon events
        ConsumeBtcMonMessageAsync(msg)
        break
      default:
        // This is an unknown state type
        console.error(`Unknown state type: ${msg.properties.type}`)
        // cannot handle unknown type messages, ack message and do nothing
        amqpChannel.ack(msg)
    }
  }
}

async function performLeaderElection () {
  IS_LEADER = false
  let leaderElectionConfig = {
    key: env.PROOF_STATE_LEADER_KEY,
    consul: {
      host: env.CONSUL_HOST,
      port: env.CONSUL_PORT,
      ttl: 15,
      lockDelay: 1
    }
  }

  leaderElection(leaderElectionConfig)
    .on('gainedLeadership', function () {
      console.log(`leaderElection : elected `)
      IS_LEADER = true
    })
    .on('error', function (err) {
      console.error(`leaderElection : error : lock session invalidated : ${err}`)
      IS_LEADER = false
    })
}

/**
 * Opens a storage connection
 **/
async function openStorageConnectionAsync () {
  let dbConnected = false
  while (!dbConnected) {
    try {
      await cachedProofState.openConnectionAsync()
      console.log('Sequelize connection established')
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
 * @param {string} redisURI - The connection string for the Redis instance, an Redis URI
 */
function openRedisConnection (redisURI) {
  connections.openRedisConnection(redisURI,
    (newRedis) => {
      redis = newRedis
      cachedProofState.setRedis(redis)
    }, () => {
      redis = null
      cachedProofState.setRedis(null)
      setTimeout(() => { openRedisConnection(redisURI) }, 5000)
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
      chan.assertQueue(env.RMQ_WORK_IN_STATE_QUEUE, { durable: true })
      chan.assertQueue(env.RMQ_WORK_OUT_GEN_QUEUE, { durable: true })
      chan.assertQueue(env.RMQ_WORK_OUT_CAL_QUEUE, { durable: true })
      chan.prefetch(env.RMQ_PREFETCH_COUNT_STATE)
      amqpChannel = chan
      // Continuously load the HASHES from RMQ with hash objects to process
      chan.consume(env.RMQ_WORK_IN_STATE_QUEUE, (msg) => {
        processMessage(msg)
      })
      // if the channel closes for any reason, attempt to reconnect
      conn.on('close', async () => {
        console.error('Connection to RMQ closed.  Reconnecting in 5 seconds...')
        amqpChannel = null
        await utils.sleep(5000)
        await openRMQConnectionAsync(connectionString)
      })
      console.log('RabbitMQ connection established')
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
async function initResqueQueueAsync (redisURI) {
  // wait until redis is initialized
  let redisReady = (redis !== null)
  while (!redisReady) {
    await utils.sleep(100)
    redisReady = (redis !== null)
  }
  taskQueue = await connections.initResqueQueueAsync(redisURI, 'resque')
}

function startIntervals () {
  setInterval(async () => {
    if (IS_LEADER) {
      await PruneStateDataAsync()
    }
  }, env.PRUNE_FREQUENCY_MINUTES * 60 * 1000)
}

// process all steps need to start the application
async function start () {
  if (env.NODE_ENV === 'test') return
  try {
    // init consul and perform leader election
    performLeaderElection()
    // init DB
    await openStorageConnectionAsync()
    // init Redis
    openRedisConnection(env.REDIS_CONNECT_URI)
    // init RabbitMQ
    await openRMQConnectionAsync(env.RABBITMQ_CONNECT_URI)
    // init Resque queue
    await initResqueQueueAsync(env.REDIS_CONNECT_URI)
    // Init intervals
    startIntervals()
    console.log('startup completed successfully')
  } catch (error) {
    console.error(`An error has occurred on startup: ${error.message}`)
    process.exit(1)
  }
}

// get the whole show started
start()
