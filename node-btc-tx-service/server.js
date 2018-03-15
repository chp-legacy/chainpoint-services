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
const env = require('./lib/parse-env.js')('btc-tx')

const amqp = require('amqplib')
const BlockchainAnchor = require('blockchain-anchor')
const btcTxLog = require('./lib/models/BtcTxLog.js')
const utils = require('./lib/utils.js')

// The channel used for all amqp communication
// This value is set once the connection has been established
let amqpChannel = null

// pull in variables defined in shared BtcTxLog module
let sequelize = btcTxLog.sequelize
let BtcTxLog = btcTxLog.BtcTxLog

// Initialize BlockchainAnchor object
let anchor = new BlockchainAnchor({
  btcUseTestnet: !env.isProduction,
  service: 'insightapi',
  insightApiBase: env.INSIGHT_API_BASE_URI,
  insightFallback: true
})

// The write function used write all btc tx log events
let logBtcTxDataAsync = async (txResult) => {
  let row = {}
  row.txId = txResult.txId
  row.publishDate = txResult.publishDate
  row.rawTx = txResult.rawTx
  row.feeSatoshiPerByte = parseInt(txResult.feeSatoshiPerByte)
  row.feePaidSatoshi = parseInt(txResult.feePaidSatoshi)
  row.stackId = env.CHAINPOINT_CORE_BASE_URI

  try {
    let newRow = await BtcTxLog.create(row)
    console.log(`$BTC log: tx_id: ${newRow.get({ plain: true }).txId}`)
    return newRow.get({ plain: true })
  } catch (error) {
    throw new Error(`BTC log create error: ${error.message}: ${error.stack}`)
  }
}

/**
* Send a POST request to /wallet/:id/send with a POST body
* containing an OP_RETURN TX
*
* @param {string} hash - The hash to embed in an OP_RETURN
*/
const sendTxToBTCAsync = async (hash) => {
  let privateKeyWIF = env.BITCOIN_WIF

  let feeSatPerByte
  let feeTotalSatoshi
  try {
    feeSatPerByte = await anchor.btcGetEstimatedFeeRateSatPerByteAsync()
    // if the fee exceeds the maximum, revert to BTC_MAX_FEE_SAT_PER_BYTE for the fee
    if (feeSatPerByte > env.BTC_MAX_FEE_SAT_PER_BYTE) {
      console.error(`Fee of ${feeSatPerByte} sat per byte exceeded BTC_MAX_FEE_SAT_PER_BYTE of ${env.BTC_MAX_FEE_SAT_PER_BYTE}`)
      feeSatPerByte = env.BTC_MAX_FEE_SAT_PER_BYTE
    }
    let feeExtra = 1.1 // the factor to use to increase the final transaction fee in order to better position this transaction for fast confirmation
    feeSatPerByte = Math.ceil(feeSatPerByte * feeExtra) // Math.ceil to keep the value an integer, as expected in the log db
    let averageTxInBytes = 235 // 235 represents the average btc anchor transaction size in bytes
    feeTotalSatoshi = feeSatPerByte * averageTxInBytes
  } catch (error) {
    throw new Error(`Error retrieving estimated fee: ${error.message}`)
  }

  let txResult
  try {
    txResult = await anchor.btcOpReturnAsync(privateKeyWIF, hash, feeTotalSatoshi)
    txResult.publishDate = Date.now()
    txResult.feeSatoshiPerByte = feeSatPerByte
    txResult.feePaidSatoshi = feeTotalSatoshi
    return txResult
  } catch (error) {
    throw new Error(`Error sending anchor transaction: ${error.message}`)
  }
}

/**
* Parses a message and performs the required work for that message
*
* @param {amqp message object} msg - The AMQP message received from the queue
*/
async function processIncomingAnchorBTCJobAsync (msg) {
  if (msg !== null) {
    let messageObj = JSON.parse(msg.content.toString())
    // the value to be anchored, likely a merkle root hex string
    let anchorData = messageObj.anchor_btc_agg_root

    // if amqpChannel is null for any reason, dont bother sending transaction until that is resolved, return error
    if (!amqpChannel) throw new Error('no amqpConnection available')

    try {
      // create and publish the transaction
      let txResult
      try {
        txResult = await sendTxToBTCAsync(anchorData)
      } catch (error) {
        throw new Error(`Unable to publish BTC transaction: ${error.message}`)
      }

      // log the btc tx transaction
      let newLogEntry
      try {
        newLogEntry = await logBtcTxDataAsync(txResult)
        console.log(newLogEntry)
      } catch (error) {
        throw new Error(`Unable to log BTC transaction: ${error.message}`)
      }

      // queue return message for calendar containing the new transaction information
      // adding btc transaction id and full transaction body to original message and returning
      messageObj.btctx_id = txResult.txId
      messageObj.btctx_body = txResult.rawTx
      try {
        await amqpChannel.sendToQueue(env.RMQ_WORK_OUT_CAL_QUEUE, Buffer.from(JSON.stringify(messageObj)), { persistent: true, type: 'btctx' })
        console.log(env.RMQ_WORK_OUT_CAL_QUEUE, '[btctx] publish message acked', messageObj.btctx_id)
      } catch (error) {
        console.error(env.RMQ_WORK_OUT_CAL_QUEUE, '[btctx] publish message nacked', messageObj.btctx_id)
        throw new Error(`Unable to publish to RMQ_WORK_OUT_CAL_QUEUE: ${error.message}`)
      }
      amqpChannel.ack(msg)
    } catch (error) {
      // An error has occurred publishing the transaction, nack consumption of message
      // set a 30 second delay for nacking this message to prevent a flood of retries hitting insight api
      let retryMS = 30000
      console.error(`Unable to process BTC anchor message: ${error.message}: Retrying in ${retryMS / 1000} seconds`)
      setTimeout(() => {
        amqpChannel.nack(msg)
        console.error(env.RMQ_WORK_IN_BTCTX_QUEUE, 'consume message nacked')
      }, retryMS)
    }
  }
}

/**
 * Opens a storage connection
 **/
async function openStorageConnectionAsync (callback) {
  let dbConnected = false
  while (!dbConnected) {
    try {
      await sequelize.sync({ logging: false })
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
      chan.assertQueue(env.RMQ_WORK_IN_BTCTX_QUEUE, { durable: true })
      chan.assertQueue(env.RMQ_WORK_OUT_CAL_QUEUE, { durable: true })
      chan.prefetch(env.RMQ_PREFETCH_COUNT_BTCTX)
      amqpChannel = chan
      // Receive and process messages meant to initiate btc tx generation and publishing
      chan.consume(env.RMQ_WORK_IN_BTCTX_QUEUE, (msg) => {
        processIncomingAnchorBTCJobAsync(msg)
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

// process all steps need to start the application
async function start () {
  if (env.NODE_ENV === 'test') return
  try {
    // init DB
    await openStorageConnectionAsync()
    // init RabbitMQ
    await openRMQConnectionAsync(env.RABBITMQ_CONNECT_URI)
    console.log('startup completed successfully')
  } catch (error) {
    console.error(`An error has occurred on startup: ${error.message}`)
    process.exit(1)
  }
}

// get the whole show started
start()
