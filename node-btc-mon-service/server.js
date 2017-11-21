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
const env = require('./lib/parse-env.js')('btc-mon')

const MerkleTools = require('merkle-tools')
const BlockchainAnchor = require('blockchain-anchor')
const amqp = require('amqplib')
const utils = require('./lib/utils.js')

// An array of all Bitcoin transaction id objects needing to be monitored.
// Will be filled as new trasnactions ids arrive on the queue.
let BTCTXIDS = []

// The merkle tools object for building trees and generating proof paths
const merkleTools = new MerkleTools()

// The channel used for all amqp communication
// This value is set once the connection has been established
var amqpChannel = null

// Initialize BlockchainAnchor object
let anchor = new BlockchainAnchor({
  btcUseTestnet: !env.isProduction,
  service: 'insightapi',
  insightApiBase: env.INSIGHT_API_BASE_URI,
  insightFallback: true
})

function consumeBtcTxIdMessage (msg) {
  if (msg !== null) {
    let btcTxIdObj = JSON.parse(msg.content.toString())

    // add msg to the btc tx id object so that we can ack it once requisite confirmations
    // are achieved and monitoring for this tx id is completed
    btcTxIdObj.msg = msg
    BTCTXIDS.push(btcTxIdObj)
  }
}

// Iterate through all BTCTXIDS objects, checking the confirmation count for each transaction
// If MIN_BTC_CONFIRMS is reached for a given transaction, retrieve the state data needed
// to build the proof path from the transaction to the block header merkle root value and
// return that information to calendar service, ack message.
let monitorTransactionsAsync = async () => {
  // if the amqp channel is null (closed), processing should not continue, defer to next monitorTransactions call
  if (amqpChannel === null) return

  // process each set of btctxid data
  let btcTxIdsToMonitor = BTCTXIDS.splice(0)
  console.log(`Btc Tx monitoring process starting for ${btcTxIdsToMonitor.length} transaction(s)`)

  for (let index = 0; index < btcTxIdsToMonitor.length; index++) {
    let btcTxIdObj = btcTxIdsToMonitor[index]

    try {
      // Get BTC Transaction Stats
      let txStats = await anchor.btcGetTxStatsAsync(btcTxIdObj.tx_id)
      if (txStats.confirmations < env.MIN_BTC_CONFIRMS) {
        // nack consumption of this message
        amqpChannel.nack(btcTxIdObj.msg)
        console.log(`${txStats.id} monitoring requeued: ${txStats.confirmations} of ${env.MIN_BTC_CONFIRMS} confirmations`)
        continue
      }

      // if ready, Get BTC Block Stats with Transaction Ids
      let blockStats = await anchor.btcGetBlockStatsAsync(txStats.blockHash)
      let txIndex = blockStats.txIds.indexOf(txStats.id)
      if (txIndex === -1) throw new Error(`transaction ${txStats.id} not found in block ${txStats.blockHeight}`)
      // adjusting for endieness, reverse txids for further processing
      for (let x = 0; x < blockStats.txIds.length; x++) {
        blockStats.txIds[x] = blockStats.txIds[x].match(/.{2}/g).reverse().join('')
      }

      if (blockStats.txIds.length === 0) throw new Error(`No transactions found in block ${txStats.blockHeight}`)

      // build BTC merkle tree with txIds
      merkleTools.resetTree()
      merkleTools.addLeaves(blockStats.txIds)
      merkleTools.makeBTCTree(true)
      let rootValueBuffer = merkleTools.getMerkleRoot()
      // re-adjust for endieness, reverse and convert back to hex
      let rootValueHex = rootValueBuffer.toString('hex').match(/.{2}/g).reverse().join('')
      if (rootValueHex !== blockStats.merkleRoot) throw new Error(`calculated merkle root (${rootValueHex}) does not match block merkle root (${blockStats.merkleRoot}) for tx ${txStats.id}`)
      // get proof path from tx to block root
      let proofPath = merkleTools.getProof(txIndex)
      // send data back to calendar
      let messageObj = {}
      messageObj.btctx_id = txStats.id
      messageObj.btchead_height = txStats.blockHeight
      messageObj.btchead_root = rootValueHex
      messageObj.path = proofPath
      try {
        await amqpChannel.sendToQueue(env.RMQ_WORK_OUT_CAL_QUEUE, Buffer.from(JSON.stringify(messageObj)), { persistent: true, type: 'btcmon' })
        console.log(env.RMQ_WORK_OUT_CAL_QUEUE, '[btcmon] publish message acked', messageObj.btctx_id)
      } catch (error) {
        console.error(env.RMQ_WORK_OUT_CAL_QUEUE, '[btcmon] publish message nacked', messageObj.btctx_id)
        throw new Error(error.message)
      }
      // if minimim confirms have been achieved and return message to calendar published, ack consumption of this message
      amqpChannel.ack(btcTxIdObj.msg)
      console.log(btcTxIdObj.tx_id + ' confirmed and processed')
      // console.log(env.RMQ_WORK_IN_BTCMON_QUEUE, 'consume message acked')
    } catch (error) {
      console.error(error.message)
      // nack consumption of this message
      amqpChannel.nack(btcTxIdObj.msg)
      console.error(env.RMQ_WORK_IN_BTCMON_QUEUE, 'consume message nacked')
    }
  }

  console.log(`Btc Tx monitoring process complete`)
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
      chan.assertQueue(env.RMQ_WORK_IN_BTCMON_QUEUE, { durable: true })
      chan.assertQueue(env.RMQ_WORK_OUT_CAL_QUEUE, { durable: true })
      chan.prefetch(env.RMQ_PREFETCH_COUNT_BTCMON)
      amqpChannel = chan
      // Continuously load the HASHES from RMQ with hash objects to process)
      chan.consume(env.RMQ_WORK_IN_BTCMON_QUEUE, (msg) => {
        consumeBtcTxIdMessage(msg)
      })
      // if the channel closes for any reason, attempt to reconnect
      conn.on('close', async () => {
        console.error('Connection to RMQ closed.  Reconnecting in 5 seconds...')
        amqpChannel = null
        // un-acked messaged will be requeued, so clear all work in progress
        BTCTXIDS = []
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

function startIntervals () {
  setInterval(() => monitorTransactionsAsync(), env.MONITOR_INTERVAL_SECONDS * 1000)
}

// process all steps need to start the application
async function start () {
  if (env.NODE_ENV === 'test') return
  try {
    // init RabbitMQ
    await openRMQConnectionAsync(env.RABBITMQ_CONNECT_URI)
    // init interval functions
    startIntervals()
    console.log('startup completed successfully')
  } catch (error) {
    console.error(`An error has occurred on startup: ${error.message}`)
    process.exit(1)
  }
}

// get the whole show started
start()

// export these functions for unit tests
module.exports = {
  getBTCTXIDS: function () { return BTCTXIDS },
  setBTCTXIDS: function (btctxids) { BTCTXIDS = btctxids },
  getAMQPChannel: function () { return amqpChannel },
  setAMQPChannel: (chan) => { amqpChannel = chan },
  openRMQConnectionAsync: openRMQConnectionAsync,
  consumeBtcTxIdMessage: consumeBtcTxIdMessage,
  monitorTransactionsAsync: monitorTransactionsAsync
}
