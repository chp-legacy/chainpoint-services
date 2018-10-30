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
const env = require('./lib/parse-env.js')('cal')

const _ = require('lodash')
const MerkleTools = require('merkle-tools')
const amqp = require('amqplib')
const uuidv1 = require('uuid/v1')
const crypto = require('crypto')
const calendarBlock = require('./lib/models/CalendarBlock.js')
const cachedProofState = require('./lib/models/cachedProofStateModels.js')
const coreNetworkState = require('./lib/models/CoreNetworkState.js')
const cnsl = require('consul')
const utils = require('./lib/utils.js')
const rp = require('request-promise-native')
const leaderElection = require('exp-leader-election')
const schedule = require('node-schedule')
const debugPkg = require('debug')
const connections = require('./lib/connections.js')

// See : https://github.com/zeit/async-retry
const retry = require('async-retry')

const Sequelize = require('sequelize-cockroachdb')
const Op = Sequelize.Op

var debug = {
  general: debugPkg('calendar:general'),
  genesis: debugPkg('calendar:block:genesis'),
  calendar: debugPkg('calendar:block:calendar'),
  btcAnchor: debugPkg('calendar:block:btcAnchor'),
  btcConfirm: debugPkg('calendar:block:btcConfirm'),
  reward: debugPkg('calendar:block:reward'),
  nist: debugPkg('calendar:block:nist')
}
// direct debug to output over STDOUT
debugPkg.log = console.info.bind(console)

// TweetNaCl.js
// see: http://ed25519.cr.yp.to
// see: https://github.com/dchest/tweetnacl-js#signatures
const nacl = require('tweetnacl')
nacl.util = require('tweetnacl-util')

// The leadership status for this instance of the calendar service
let IS_LEADER = false

// Pass SIGNING_SECRET_KEY as Base64 encoded bytes
const signingSecretKeyBytes = nacl.util.decodeBase64(env.SIGNING_SECRET_KEY)
const signingKeypair = nacl.sign.keyPair.fromSecretKey(signingSecretKeyBytes)

const zeroStr = '0000000000000000000000000000000000000000000000000000000000000000'

// The merkle tools object for building trees and generating proof paths
const merkleTools = new MerkleTools()

// The channel used for all amqp communication
// This value is set once the connection has been established
let amqpChannel = null

// The latest NIST data
// This value is updated from consul events as changes are detected
let nistLatest = null

// pull in variables defined in shared CalendarBlock module
const calBlockSequelize = calendarBlock.sequelize
const CalendarBlock = calendarBlock.CalendarBlock
const pgClientPool = calendarBlock.pgClientPool

let consul = null

// Calculate the hash of the signing public key bytes
// to allow lookup of which pubkey was used to sign
// a block. Handles different organizations signing blocks
// with different keys and key rotation by those orgs.
// When a Base64 pubKey is published publicly it should also
// be accompanied by this hash of its bytes to serve
// as a fingerprint.
function calcSigningPubKeyHashHex (pubKey) {
  return crypto.createHash('sha256').update(pubKey).digest('hex')
}
const signingPubKeyHashHex = calcSigningPubKeyHashHex(signingKeypair.publicKey)

// Calculate a deterministic block hash and return a Buffer hash value
function calcBlockHashHex (block) {
  let prefixString = `${block.id.toString()}:${block.time.toString()}:${block.version.toString()}:${block.stackId.toString()}:${block.type.toString()}:${block.dataId.toString()}`
  let prefixBuffer = Buffer.from(prefixString, 'utf8')
  let dataValBuffer = utils.isHex(block.dataVal) ? Buffer.from(block.dataVal, 'hex') : Buffer.from(block.dataVal, 'utf8')
  let prevHashBuffer = Buffer.from(block.prevHash, 'hex')

  return crypto.createHash('sha256').update(Buffer.concat([
    prefixBuffer,
    dataValBuffer,
    prevHashBuffer
  ])).digest('hex')
}

// Calculate a base64 encoded signature over the block hash
function calcBlockHashSigB64 (blockHashHex) {
  return nacl.util.encodeBase64(nacl.sign.detached(nacl.util.decodeUTF8(blockHashHex), signingKeypair.secretKey))
}

// The write function used by all block creation functions to write to calendar blockchain
async function writeBlockAsync (client, height, type, dataId, dataVal, prevHash) {
  let b = {}
  b.id = height
  b.time = Math.trunc(Date.now() / 1000)
  b.version = 1
  b.stackId = env.CHAINPOINT_CORE_BASE_URI
  b.type = type
  b.dataId = dataId
  b.dataVal = dataVal
  b.prevHash = prevHash

  let blockHashHex = calcBlockHashHex(b)
  b.hash = blockHashHex

  // pre-pend Base64 signature with truncated chars of SHA256 hash of the
  // pubkey bytes, joined with ':', to allow for lookup of signing pubkey.
  b.sig = [signingPubKeyHashHex.slice(0, 12), calcBlockHashSigB64(blockHashHex)].join(':')

  const insertBlockSQL = 'INSERT INTO chainpoint_calendar_blockchain (id, time, version, stack_id, type, data_id, data_val, prev_hash, hash, sig) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *'
  const insertBlockData = [b.id, b.time, b.version, b.stackId, b.type, b.dataId, b.dataVal, b.prevHash, b.hash, b.sig]
  let insertResult = await client.query(insertBlockSQL, insertBlockData)
  let block = insertResult.rows[0]
  // add block fields to mirror those of the CalendarBlock model so all processes may use this block object
  block.stackId = block.stack_id
  block.dataId = block.data_id
  block.dataVal = block.data_val
  block.prevHash = block.prev_hash
  return block
}

async function createGenesisBlockAsync () {
  // Initialize client, execute ,and release here
  // This is an exception to other block type since there is no transaction needed
  const client = await pgClientPool.connect()
  debug.genesis(`createGenesisBlockAsync : begin`)
  await writeBlockAsync(client, 0, 'gen', '0', zeroStr, zeroStr, 'GENESIS')
  await client.release()
  debug.genesis(`createGenesisBlockAsync : end`)
}

async function createCalendarBlockAsync (root) {
  debug.calendar(`createCalendarBlockAsync : begin`)
  try {
    let block = await executeRetryableBlockWriteTransactionAsync('cal', null, root.toString(), debug.calendar)
    debug.calendar(`createCalendarBlockAsync : end`)
    return block
  } catch (error) {
    throw new Error(`createCalendarBlockAsync : could not write calendar block : ${error.message}`)
  }
}

async function createNistBlockAsync (nistDataObj) {
  debug.nist(`createNistBlockAsync : begin`)
  try {
    let dataId = nistDataObj.split(':')[0].toString() // the epoch timestamp for this NIST entry
    let dataVal = nistDataObj.split(':')[1].toString() // the hex value for this NIST entry
    let block = await executeRetryableBlockWriteTransactionAsync('nist', dataId, dataVal, debug.nist)
    debug.nist(`createNistBlockAsync : end`)
    return block
  } catch (error) {
    throw new Error(`createNistBlockAsync : could not write NIST block : ${error.message}`)
  }
}

async function createBtcAnchorBlockAsync (root) {
  debug.btcAnchor(`createBtcAnchorBlockAsync : begin`)
  try {
    let block = await executeRetryableBlockWriteTransactionAsync('btc-a', '', root.toString(), debug.btcAnchor)
    debug.btcAnchor(`createBtcAnchorBlockAsync : end`)
    return block
  } catch (error) {
    throw new Error(`createBtcAnchorBlockAsync : failed to write btc-a block : ${error.message}`)
  }
}

async function createBtcConfirmBlockAsync (height, root) {
  debug.btcConfirm(`createBtcConfirmBlockAsync : begin`)
  try {
    let block = await executeRetryableBlockWriteTransactionAsync('btc-c', height.toString(), root.toString(), debug.btcConfirm)
    debug.btcConfirm(`createBtcConfirmBlockAsync : end`)
    return block
  } catch (error) {
    throw new Error(`createBtcConfirmBlockAsync : could not write BTC confirm block : ${error.message}`)
  }
}

async function createRewardBlockAsync (dataId, dataVal) {
  debug.reward(`createRewardBlockAsync : begin`)
  try {
    let block = await executeRetryableBlockWriteTransactionAsync('reward', dataId.toString(), dataVal.toString(), debug.reward)
    debug.reward(`createRewardBlockAsync : end`)
    return block
  } catch (error) {
    throw new Error(`createRewardBlockAsync : could not write reward block : ${error.message}`)
  }
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
      case 'btctx':
        if (env.ANCHOR_BTC === 'enabled') {
          // Consumes a tx message from the btctx service
          consumeBtcTxMessageAsync(msg)
        } else {
          // BTC anchoring has been disabled, ack message and do nothing
          debug.general(`processMessage : [btctx] publish message acked : BTC disabled : ${msg.btctx_id}`)
          amqpChannel.ack(msg)
        }
        break
      case 'btcmon':
        if (env.ANCHOR_BTC === 'enabled') {
          // Consumes a mon message from the btcmon service
          consumeBtcMonMessageAsync(msg)
        } else {
          // BTC anchoring has been disabled, ack message and do nothing
          debug.general(`processMessage : [btcmon] publish message acked : BTC disabled : ${msg.btctx_id}`)
          amqpChannel.ack(msg)
        }
        break
      case 'reward':
        consumeRewardMessageAsync(msg)
        break
      default:
        console.error('processMessage : unknown message type', msg.properties.type)
        // cannot handle unknown type messages, ack message and do nothing
        amqpChannel.ack(msg)
    }
  }
}

async function writeTransactionAsync (blockType, dataId, dataVal, debuglogger) {
  const client = await pgClientPool.connect()
  debuglogger(`writeTransactionAsync : begin`)

  await client.query('BEGIN')

  // Attempt the work.
  try {
    // Read the most recent block, as we need the id and hash values for use in the subsequent block
    let prevBlockResult = await client.query('SELECT id, hash FROM chainpoint_calendar_blockchain ORDER BY id DESC LIMIT 1')
    if (prevBlockResult.rows.length === 0) throw new Error(`No genesis block found`)

    let prevBlock = {
      id: prevBlockResult.rows[0].id,
      hash: prevBlockResult.rows[0].hash
    }
    debuglogger(`writeTransactionAsync : previous block : ${prevBlock.id} : ${prevBlock.hash}`)

    let newId = parseInt(prevBlock.id, 10) + 1
    // cal blocks use the newId as the dataId, if dataId is null, set it to the value of newId
    if (dataId === null) dataId = newId.toString()
    let newBlock = await writeBlockAsync(client, newId, blockType, dataId, dataVal, prevBlock.hash)
    debuglogger(`writeTransactionAsync : new block : ${newBlock.id} : ${newBlock.hash}`)

    await client.query('COMMIT')
    await client.release()
    debuglogger(`writeTransactionAsync : end`)

    return newBlock
  } catch (error) {
    try {
      await client.query('ROLLBACK')
      debuglogger(`writeTransactionAsync : rollback : complete`)
    } catch (error) {
      debuglogger(`writeTransactionAsync : rollback : ${error.message}`)
    }
    await client.release()
    throw error
  }
}

async function executeRetryableBlockWriteTransactionAsync (blockType, dataId, dataVal, debuglogger) {
  let newBlock = await retry(async bail => {
    let newBlock = await writeTransactionAsync(blockType, dataId, dataVal, debuglogger)
    return newBlock
  }, {
    retries: 25, // The maximum amount of times to retry the operation. Default is 10
    factor: 1, // The exponential factor to use. Default is 2
    minTimeout: 5, // The number of milliseconds before starting the first retry. Default is 1000
    maxTimeout: 100,
    onRetry: (error) => { debuglogger(`executeRetryableBlockWriteTransactionAsync : retrying : writing block : ${blockType} : ${error.message}`) }
  })

  return newBlock
}

async function consumeBtcTxMessageAsync (msg) {
  debug.general(`consumeBtcTxMessageAsync : begin`)
  if (msg !== null) {
    let btcTxObj = JSON.parse(msg.content.toString())

    // add a small delay to prevent btc-mon from attempting to monitor a transaction
    // before the Bitcore API even acknowledges the existence of the transaction (404)
    await utils.sleep(30000)

    // queue up message containing updated proof state bound for proof state service
    let stateObj = {}
    stateObj.anchor_btc_agg_id = btcTxObj.anchor_btc_agg_id
    stateObj.btctx_id = btcTxObj.btctx_id
    let anchorBTCAggRoot = btcTxObj.anchor_btc_agg_root
    let btctxBody = btcTxObj.btctx_body
    let prefix = btctxBody.substr(0, btctxBody.indexOf(anchorBTCAggRoot))
    let suffix = btctxBody.substr(btctxBody.indexOf(anchorBTCAggRoot) + anchorBTCAggRoot.length)
    stateObj.btctx_state = {}
    stateObj.btctx_state.ops = [
      { l: prefix },
      { r: suffix },
      { op: 'sha-256-x2' }
    ]

    try {
      try {
        await amqpChannel.sendToQueue(env.RMQ_WORK_OUT_STATE_QUEUE, Buffer.from(JSON.stringify(stateObj)), { persistent: true, type: 'btctx' })
        // New message has been published
        // debug.general(env.RMQ_WORK_OUT_STATE_QUEUE, '[btctx] publish message acked')
      } catch (error) {
        // An error as occurred publishing a message
        console.error(env.RMQ_WORK_OUT_STATE_QUEUE, '[btctx] publish message nacked')
        console.error(`consumeBtcTxMessageAsync : Unable to publish state message : ${error.message}`)
        throw new Error()
      }

      try {
        await amqpChannel.sendToQueue(env.RMQ_WORK_OUT_BTCMON_QUEUE, Buffer.from(JSON.stringify({ tx_id: btcTxObj.btctx_id })), { persistent: true })
        // New message has been published
        // debug.general(env.RMQ_WORK_OUT_BTCMON_QUEUE, 'publish message acked')
      } catch (error) {
        // An error as occurred publishing a message
        console.error(env.RMQ_WORK_OUT_BTCMON_QUEUE, 'publish message nacked')
        console.error(`consumeBtcTxMessageAsync : Unable to publish btcmon message : ${error.message}`)
        throw new Error()
      }
    } catch (error) {
      amqpChannel.nack(msg)
      console.error(env.RMQ_WORK_IN_CAL_QUEUE, '[btctx] consume message nacked', btcTxObj.btctx_id)
      return
    }

    amqpChannel.ack(msg)
    debug.general(`consumeBtcTxMessageAsync : [btctx] consume message acked : ${btcTxObj.btctx_id}`)
  }

  debug.general(`consumeBtcTxMessageAsync : end`)
}

async function consumeBtcMonMessageAsync (msg) {
  if (msg !== null) {
    processBtcMonMessage(msg)
  }
}

async function consumeRewardMessageAsync (msg) {
  if (msg !== null) {
    processRewardMessage(msg)
  }
}

// Build Merkle tree from aggregation root objects
function generateCalendarTree (aggregationRootObjects) {
  debug.general(`generateCalendarTree : begin`)

  let treeDataObj = null
  // create merkle tree only if there is at least one root to process
  if (aggregationRootObjects.length > 0) {
    // clear the merkleTools instance to prepare for a new tree
    merkleTools.resetTree()

    // get root values from root objects
    let leaves = aggregationRootObjects.map((rootObj) => {
      return rootObj.agg_root
    })

    // Add every root in rootsForTree to new Merkle tree
    merkleTools.addLeaves(leaves)
    merkleTools.makeTree()

    // Collect and store the Merkle root and proofs in an object
    treeDataObj = {}
    treeDataObj.cal_root = merkleTools.getMerkleRoot()

    let proofData = aggregationRootObjects.map((rootItem, index) => {
      // push the agg_id and corresponding proof onto the array
      let proofDataItem = {}
      proofDataItem.agg_id = rootItem.agg_id
      let proof = merkleTools.getProof(index)
      proofDataItem.proof = utils.formatAsChainpointV3Ops(proof, 'sha-256')
      return proofDataItem
    })
    treeDataObj.proofData = proofData
    debug.general(`generateCalendarTree : aggregationRootObjects length : ${aggregationRootObjects.length}`)
  }
  debug.general(`generateCalendarTree : end`)
  return treeDataObj
}

// Write tree to calendar block DB
async function persistCalendarTreeAsync (treeDataObj) {
  debug.calendar(`persistCalendarTreeAsync : begin`)

  // if the amqp channel is null (closed), processing should not continue,
  // throw an error to force retry. Do this before any other DB or CPU time is
  // wasted within the lock around this function. Also helps ensure a cal block
  // is not written if RMQ writes will likely fail after it.
  if (amqpChannel === null) {
    throw new Error(`persistCalendarTreeAsync : amqpChannel is null : force retry`)
  }

  let block
  try {
    // Store Merkle root of calendar in DB and chain to previous calendar entries
    block = await createCalendarBlockAsync(treeDataObj.cal_root.toString('hex'))
  } catch (error) {
    throw new Error(`persistCalendarTreeAsync : unable to create calendar block : ${error.message}`)
  }
  debug.calendar(`persistCalendarTreeAsync : end`)
  return block
}

// Aggregate all block hashes on chain since last BTC aggregation, add new
// BTC anchor block to calendar, add new proof state entries, anchor root
async function aggregateAndAnchorBTCAsync (blocks) {
  debug.btcAnchor(`aggregateAndAnchorBTCAsync : begin`)

  // if the amqp channel is null (closed), processing should not continue,
  // defer to next interval. Do this before any other DB or CPU time is
  // wasted within the lock around this function.
  if (amqpChannel === null) {
    debug.btcAnchor('aggregateAndAnchorBTCAsync : amqpChannel is null : returning')
    return
  }

  let treeData = {}
  try {
    // Build merkle tree with block hashes
    let leaves = blocks.map((blockObj) => {
      return blockObj.hash
    })

    // clear the merkleTools instance to prepare for a new tree
    merkleTools.resetTree()

    // Add every blockHash in blocks to new Merkle tree
    merkleTools.addLeaves(leaves)
    merkleTools.makeTree()

    treeData.anchor_btc_agg_id = uuidv1()
    treeData.anchor_btc_agg_root = merkleTools.getMerkleRoot().toString('hex')

    let proofData = blocks.reduce((result, block, index) => {
      // for calendar type blocks only, push the cal_id and corresponding proof onto the array
      if (block.type === 'cal') {
        let proofDataItem = {}
        proofDataItem.cal_id = block.id
        let proof = merkleTools.getProof(index)
        proofDataItem.proof = utils.formatAsChainpointV3Ops(proof, 'sha-256')
        result.push(proofDataItem)
      }
      return result
    }, [])
    treeData.proofData = proofData

    debug.btcAnchor(`aggregateAndAnchorBTCAsync : blocks.length : ${blocks.length}`)

    // Create new BTC anchor block with resulting tree root
    await createBtcAnchorBlockAsync(treeData.anchor_btc_agg_root)
  } catch (error) {
    throw new Error(`aggregateAndAnchorBTCAsync error: ${error.message}`)
  }

  debug.btcAnchor(`aggregateAndAnchorBTCAsync : end`)
  return treeData
}

// Get the id of that most recent btc-a block
async function lastBtcAnchorBlockIdAsync () {
  debug.btcAnchor('lastBtcAnchorBlockIdAsync : begin')
  let lastBtcAnchorBlock
  try {
    lastBtcAnchorBlock = await CalendarBlock.findOne({ where: { type: 'btc-a' }, attributes: ['id'], order: [['id', 'DESC']] })
  } catch (error) {
    throw new Error(`unable to retrieve most recent BTC anchor block : ${error.message}`)
  }

  let id = lastBtcAnchorBlock ? parseInt(lastBtcAnchorBlock.id, 10) : null
  debug.btcAnchor(`lastBtcAnchorBlockIdAsync : last block ID : ${id}`)
  return id
}

// queue messages for state service with cal state data and ack original messages
async function queueCalStateDataMessageAsync (treeDataObj, block) {
  // create proof state objects for each aggregation root in the tree bound for proof state service
  let calStateData = {}
  calStateData.cal_id = block.id
  // Build the anchors uris using the locations configured in CHAINPOINT_CORE_BASE_URI
  let BASE_URIS = [env.CHAINPOINT_CORE_BASE_URI]
  let uris = BASE_URIS.map((uri) => `${uri}/calendar/${block.id}/hash`)
  calStateData.anchor = {
    anchor_id: block.id,
    uris: uris
  }

  // decalre ops extending proof path beyond cal_root to calendar block's block_hash
  let opsToBlockHash = [
    { l: `${block.id}:${block.time}:${block.version}:${block.stackId}:${block.type}:${block.dataId}` },
    { r: block.prevHash },
    { op: 'sha-256' }
  ]
  calStateData.proofData = treeDataObj.proofData.map((proofDataItem) => {
    return { agg_id: proofDataItem.agg_id, proof: [...proofDataItem.proof, ...opsToBlockHash] }
  })

  try {
    await amqpChannel.sendToQueue(env.RMQ_WORK_OUT_STATE_QUEUE, Buffer.from(JSON.stringify(calStateData)), { persistent: true, type: 'cal_batch' })
  } catch (error) {
    // An error as occurred publishing a message
    console.error(`queueCalStateDataMessageAsync : ${env.RMQ_WORK_OUT_STATE_QUEUE} [cal] publish message nacked`)
    throw new Error(`queueCalStateDataMessageAsync : Unable to publish state message : ${error.message}`)
  }
}

// queue message for state service with btc-a state data
async function queueBtcAStateDataMessageAsync (treeDataObj) {
  // create proof state objects for each cal_id in the tree bound for proof state service
  let btcAnchorStateData = {}
  btcAnchorStateData.anchor_btc_agg_id = treeDataObj.anchor_btc_agg_id
  btcAnchorStateData.proofData = treeDataObj.proofData.map((proofDataItem) => {
    return { cal_id: proofDataItem.cal_id, proof: proofDataItem.proof }
  })

  try {
    // Publish new message
    await amqpChannel.sendToQueue(env.RMQ_WORK_OUT_STATE_QUEUE, Buffer.from(JSON.stringify(btcAnchorStateData)), { persistent: true, type: 'anchor_btc_agg_batch' })
    // debug.btcConfirm(env.RMQ_WORK_OUT_STATE_QUEUE, '[anchor_btc_agg] publish message acked')
  } catch (error) {
    console.error('queueBtcAStateDataAsync : [anchor_btc_agg] publish message nacked')
    console.error(`queueBtcAStateDataAsync : unable to publish state message : ${error.message}`)
    return
  }

  let anchorData = {
    anchor_btc_agg_id: treeDataObj.anchor_btc_agg_id,
    anchor_btc_agg_root: treeDataObj.anchor_btc_agg_root
  }

  // Send anchorData to the BTC tx service for anchoring
  try {
    // Publish new message
    await amqpChannel.sendToQueue(env.RMQ_WORK_OUT_BTCTX_QUEUE, Buffer.from(JSON.stringify(anchorData)), { persistent: true })
    // debug.general(env.RMQ_WORK_OUT_BTCTX_QUEUE, 'publish message acked')
  } catch (error) {
    console.error(`queueBtcAStateDataAsync : ${env.RMQ_WORK_OUT_BTCTX_QUEUE} publish message nacked`)
    console.error(`queueBtcAStateDataAsync : unable to btctx message : ${error.message}`)
  }
}

// queue message for state service with btc-c state data and ack original message
async function queueBtcCStateDataAsync (msg, block) {
  let btcMonObj = JSON.parse(msg.content.toString())
  let btctxId = btcMonObj.btctx_id
  let btcheadHeight = btcMonObj.btchead_height
  let proofPath = btcMonObj.path

  // queue up message containing updated proof state bound for proof state service
  let stateObj = {}
  stateObj.btctx_id = btctxId
  stateObj.btchead_height = btcheadHeight
  stateObj.btchead_state = {}
  stateObj.btchead_state.ops = utils.formatAsChainpointV3Ops(proofPath, 'sha-256-x2')

  // Build the anchors uris using the locations configured in CHAINPOINT_CORE_BASE_URI
  let BASE_URIS = [env.CHAINPOINT_CORE_BASE_URI]
  let uris = BASE_URIS.map((uri) => `${uri}/calendar/${block.id}/data`)
  stateObj.btchead_state.anchor = {
    anchor_id: btcheadHeight.toString(),
    uris: uris
  }

  try {
    // Publish new message
    await amqpChannel.sendToQueue(env.RMQ_WORK_OUT_STATE_QUEUE, Buffer.from(JSON.stringify(stateObj)), { persistent: true, type: 'btcmon' })
    // debug.btcConfirm(env.RMQ_WORK_OUT_STATE_QUEUE, '[btcmon] publish message acked')
  } catch (error) {
    amqpChannel.nack(msg)
    console.error('queueBtcCStateDataAsync : [btcmon] consume message nacked', stateObj.btctx_id)
    console.error(`queueBtcCStateDataAsync : unable to publish state message : ${error.message}`)
  }

  amqpChannel.ack(msg)
  debug.btcConfirm('queueBtcCStateDataAsync: consume message acked', stateObj.btctx_id)
}

async function sendTNTRewardAsync (ethAddr, tntGrains) {
  let options = {
    headers: [
      {
        name: 'Content-Type',
        value: 'application/json'
      }
    ],
    method: 'POST',
    uri: `${env.ETH_TNT_TX_CONNECT_URI}/transfer`,
    body: {
      to_addr: ethAddr,
      value: tntGrains
    },
    json: true,
    gzip: true,
    timeout: 30000,
    resolveWithFullResponse: true
  }

  try {
    let rewardResponse = await rp(options)
    let nodeRewardTxId = rewardResponse.body.trx_id
    debug.reward(`sendTNTRewardAsync : ${tntGrains} grains (${tntGrains / 10 ** 8} TNT) transferred to ETH address ${ethAddr} in transaction ${nodeRewardTxId}`)
    return nodeRewardTxId
  } catch (error) {
    console.error(`sendTNTRewardAsync : ${tntGrains} grains (${tntGrains / 10 ** 8} TNT) failed to be transferred to ETH address ${ethAddr}: ${error.message}`)
    return null
  }
}

async function initializeCalendarBlock0Async () {
  try {
    // Is a genesis block needed? If not move on.
    let blockCount
    try {
      blockCount = await CalendarBlock.count()
    } catch (error) {
      throw new Error(`unable to count calendar blocks: ${error.message}`)
    }
    if (blockCount === 0) {
      try {
        await createGenesisBlockAsync()
      } catch (error) {
        throw new Error(`unable to create genesis block : ${error.message}`)
      }
    } else {
      debug.general(`openStorageConnectionAsync : initializeCalendarBlock0Async : no genesis block needed: ${blockCount} block(s) found`)
    }
  } catch (error) {
    console.error(`openStorageConnectionAsync : initializeCalendarBlock0Async : unable to create genesis block : ${error.message}`)
  }
}

async function processCalendarInterval () {
  try {
    // Get agg_state objects since last calendar aggregation
    let lastProcessedTimestamp = await coreNetworkState.getLastAggStateProcessedForCalBlockTimestamp()
    if (lastProcessedTimestamp === null) {
      // there is no entry found, most likely first run, default to 60 seconds ago
      lastProcessedTimestamp = Date.now() - 60000
    } else {
      // look back an additional 500ms to account for possible latency between CRDB instances
      lastProcessedTimestamp = lastProcessedTimestamp - 500
    }
    let thisIntervalEndTimestamp = Date.now()
    let aggStates = await cachedProofState.getAggStateInfoSinceTimestampAsync(lastProcessedTimestamp)
    let aggregationRootObjects = aggStates.map((aggStateObj) => {
      return { agg_id: aggStateObj.agg_id, agg_root: aggStateObj.agg_root }
    })

    debug.calendar(`scheduleJob : calendar : aggregationRootObjects.length : ${aggregationRootObjects.length}`)
    if (aggregationRootObjects.length === 0) return

    // Build Merkle tree and proofs for each aggregation object
    let treeDataObj = generateCalendarTree(aggregationRootObjects)

    // Write tree to calendar block DB
    let block = await persistCalendarTreeAsync(treeDataObj)

    // Queue message for state service
    await queueCalStateDataMessageAsync(treeDataObj, block)

    // Update global state table
    try {
      await coreNetworkState.setLastAggStateProcessedForCalBlockTimestamp(thisIntervalEndTimestamp)
    } catch (error) {
      throw new Error(`setLastAggStateProcessedForCalBlockTimestamp failed with value ${thisIntervalEndTimestamp}`)
    }
  } catch (error) {
    // an error has occurred
    console.error(`scheduleJob : processCalendarInterval : ${error.message}`)
  }
}

async function processNistInterval () {
  try {
    await createNistBlockAsync(nistLatest)
  } catch (error) {
    console.error(`scheduleJob : processNistInterval : unable to create NIST block : ${error.message}`)
  }
}

async function processBtcAnchorInterval () {
  try {
    // Get ALL calendar blocks since last btc-a aggregation
    let lastProcessedCalHeight = await coreNetworkState.getLastCalBlockHeightProcessedForBtcABlock()
    if (lastProcessedCalHeight === null) {
      // there is no entry found, most likely first run, default to most recent btc-a block
      lastProcessedCalHeight = await lastBtcAnchorBlockIdAsync()
    }
    let blocks = await CalendarBlock.findAll({ where: { id: { [Op.gt]: lastProcessedCalHeight } }, attributes: ['id', 'type', 'hash'], order: [['id', 'ASC']] })
    debug.btcAnchor('scheduleJob : calendar : processBtcAnchorInterval : btc blocks.length to anchor : %d', blocks.length)
    if (blocks.length === 0) return

    // Build tree and write new btc-a to calendar
    let treeData = await aggregateAndAnchorBTCAsync(blocks)

    // Queue message for state service
    await queueBtcAStateDataMessageAsync(treeData)

    // Update global state table
    let thisIntervalEndBlockHeight
    try {
      // find latest block in treeData, save as a marker for next interval
      thisIntervalEndBlockHeight = blocks.reduce((value, block) => block.id > value ? block.id : value, -1)
      // In the unlikely event that 0 blocks were added in this interval, do nothing
      if (thisIntervalEndBlockHeight === -1) return
      // otherwise, set the most recent block of this interval to use to determine the start of the next interval
      await coreNetworkState.setLastCalBlockHeightProcessedForBtcABlock(thisIntervalEndBlockHeight)
    } catch (error) {
      throw new Error(`setLastCalBlockHeightProcessedForBtcABlock failed with value ${thisIntervalEndBlockHeight}`)
    }
  } catch (error) {
    console.error(`scheduleJob : processBtcAnchorInterval : unable to aggregate and create BTC anchor block : ${error.message}`)
  }
}

async function processBtcMonMessage (msg) {
  debug.btcConfirm(`consumeBtcMonMessageAsync : processBtcMonMessage : begin`)
  try {
    let btcMonObj = JSON.parse(msg.content.toString())
    let btctxId = btcMonObj.btctx_id
    let btcheadHeight = btcMonObj.btchead_height
    let btcheadRoot = btcMonObj.btchead_root

    // Store Merkle root of BTC block in chain
    try {
      let block = await createBtcConfirmBlockAsync(btcheadHeight, btcheadRoot)

      // queue message for state service and ack original message
      setImmediate(() => { queueBtcCStateDataAsync(msg, block) })
    } catch (error) {
      // an error occurred and this message could not be processed, nack and try again later
      amqpChannel.nack(msg)
      console.error('consumeBtcMonMessageAsync : processBtcMonMessage : [btcmon] consume message nacked', btctxId)
      throw new Error(`unable to create btc-c block : ${error.message}`)
    }

    debug.btcConfirm(`consumeBtcMonMessageAsync : processBtcMonMessage : end`)
  } catch (error) {
    console.error(`consumeBtcMonMessageAsync : processBtcMonMessage : ${error.message}`)
  }
}

async function processRewardMessage (msg) {
  debug.reward(`consumeRewardMessageAsync : processRewardMessage : begin`)
  let rewardMsgObj = JSON.parse(msg.content.toString())
  debug.reward('consumeRewardMessageAsync : processRewardMessage : rewardMsgObj : %j', rewardMsgObj)

  try {
    // transfer TNT according to random reward message selection
    let nodeRewardTxId = ''
    let coreRewardTxId = ''
    let nodeRewardETHAddr = rewardMsgObj.node.address
    let nodeTNTGrainsRewardShare = rewardMsgObj.node.amount
    let coreRewardEthAddr = rewardMsgObj.core ? rewardMsgObj.core.address : null
    let coreTNTGrainsRewardShare = rewardMsgObj.core ? rewardMsgObj.core.amount : 0

    // check to be sure a sufficient TNT balance exists to pay out rewards,
    // log an error if the TNT balance is too low.
    try {
      let requiredMinimumBalance = nodeTNTGrainsRewardShare + coreTNTGrainsRewardShare
      let currentBalance = await getTNTGrainsBalanceForWalletAsync()
      if (currentBalance >= requiredMinimumBalance) {
        debug.reward(`consumeRewardMessageAsync : processRewardMessage : Minimum balance for wallet OK, needed ${requiredMinimumBalance} of ${currentBalance} grains`)
      } else {
        console.error(`consumeRewardMessageAsync : processRewardMessage : Insufficient balance for wallet, needed ${requiredMinimumBalance} of ${currentBalance} grains`)
      }
    } catch (error) {
      console.error(`consumeRewardMessageAsync : processRewardMessage : Could not verify minimum balance for wallet : ${error.message}`)
    }

    debug.reward('consumeRewardMessageAsync : processRewardMessage : nodeRewardETHAddr : %s : nodeTNTGrainsRewardShare : %s', nodeRewardETHAddr, nodeTNTGrainsRewardShare)
    nodeRewardTxId = await sendTNTRewardAsync(nodeRewardETHAddr, nodeTNTGrainsRewardShare)

    // Reward TNT to Core operator if enabled
    if (coreTNTGrainsRewardShare > 0) {
      debug.reward('consumeRewardMessageAsync : processRewardMessage : coreRewardEthAddr : %s : coreTNTGrainsRewardShare : %s', coreRewardEthAddr, coreTNTGrainsRewardShare)
      coreRewardTxId = await sendTNTRewardAsync(coreRewardEthAddr, coreTNTGrainsRewardShare)
    }

    // Construct the reward block data
    let dataId = nodeRewardTxId
    let dataVal = [rewardMsgObj.node.address, rewardMsgObj.node.amount].join(':')

    if (rewardMsgObj.core) {
      dataId = [dataId, coreRewardTxId].join(':')
      dataVal = [dataVal, rewardMsgObj.core.address, rewardMsgObj.core.amount].join(':')
    }

    try {
      if (dataId === null) throw new Error('TNT reward failed to send, nodeRewardTxId is null')
      await createRewardBlockAsync(dataId, dataVal)

      amqpChannel.ack(msg)
      debug.reward(`consumeRewardMessageAsync : processRewardMessage : acked message w/ address : ${rewardMsgObj.node.address}`)
    } catch (error) {
      // ack consumption of original message to avoid distribution again
      amqpChannel.ack(msg)
      throw new Error(`createRewardBlockAsync : unable to create reward block for address : ${rewardMsgObj.node.address} : ${error.message}`)
    }
  } catch (error) {
    console.error(`consumeRewardMessageAsync : processRewardMessage : ${error.message}`)
  }
}

async function getTNTGrainsBalanceForWalletAsync () {
  let options = {
    headers: [
      {
        name: 'Content-Type',
        value: 'application/json'
      }
    ],
    method: 'GET',
    uri: `${env.ETH_TNT_TX_CONNECT_URI}/balance/wallet`,
    json: true,
    gzip: true,
    timeout: 60000,
    resolveWithFullResponse: true
  }

  try {
    let balanceResponse = await rp(options)
    let balanceTNTGrains = balanceResponse.body.balance
    let intBalance = parseInt(balanceTNTGrains)
    if (intBalance >= 0) {
      return intBalance
    } else {
      throw new Error(`Bad TNT balance value: ${balanceTNTGrains}`)
    }
  } catch (error) {
    throw new Error(`TNT balance read error: ${error.message}`)
  }
}

/**
 * Opens a storage connection
 **/
async function openStorageConnectionAsync () {
  let modelSqlzArray = [
    cachedProofState.sequelize,
    calBlockSequelize,
    coreNetworkState.sequelize
  ]
  await connections.openStorageConnectionAsync(modelSqlzArray, debug)

  // Pre-check the current Calendar block count.
  // Trigger creation of the genesis block if needed
  try {
    let blockCount = await CalendarBlock.count()
    if (blockCount === 0) {
      debug.general('openStorageConnectionAsync : create genesis block')
      await initializeCalendarBlock0Async()
    } else {
      debug.general('openStorageConnectionAsync : CalendarBlock.count : %d', blockCount)
    }
  } catch (error) {
    throw new Error(`openStorageConnectionAsync : unable to count calendar blocks: ${error.message}`)
  }

  debug.general('openStorageConnectionAsync : end')
}

/**
 * Opens a Redis connection
 *
 * @param {string} redisURI - The connection string for the Redis instance, an Redis URI
 */
function openRedisConnection (redisURIs) {
  connections.openRedisConnection(redisURIs,
    (newRedis) => {
      cachedProofState.setRedis(newRedis)
    }, () => {
      cachedProofState.setRedis(null)
      setTimeout(() => { openRedisConnection(redisURIs) }, 5000)
    }, debug)
}

/**
 * Opens an AMPQ connection and channel
 * Retry logic is included to handle losses of connection
 *
 * @param {string} connectURI - The connection URI for the RabbitMQ instance
 */
async function openRMQConnectionAsync (connectURI) {
  await connections.openStandardRMQConnectionAsync(amqp, connectURI,
    [env.RMQ_WORK_IN_CAL_QUEUE, env.RMQ_WORK_OUT_STATE_QUEUE, env.RMQ_WORK_OUT_BTCTX_QUEUE, env.RMQ_WORK_OUT_BTCMON_QUEUE],
    env.RMQ_PREFETCH_COUNT_CAL,
    { queue: env.RMQ_WORK_IN_CAL_QUEUE, method: (msg) => { processMessage(msg) } },
    (chan) => { amqpChannel = chan },
    () => {
      amqpChannel = null
      setTimeout(() => { openRMQConnectionAsync(connectURI) }, 5000)
    },
    debug
  )
}

async function performLeaderElection () {
  IS_LEADER = false
  connections.performLeaderElection(leaderElection,
    env.CALENDAR_LEADER_KEY, env.CONSUL_HOST, env.CONSUL_PORT, env.CHAINPOINT_CORE_BASE_URI,
    () => { IS_LEADER = true },
    () => { IS_LEADER = false },
    debug)
}

// Initializes all the consul watches
function startConsulWatches () {
  let watches = [{
    key: env.NIST_KEY,
    onChange: (data, res) => {
      // process only if a value has been returned and it is different than what is already stored
      if (data && data.Value && nistLatest !== data.Value) {
        debug.nist(`startConsulWatches : nistLatest : ${data.Value}`)
        nistLatest = data.Value
      }
    },
    onError: null
  }]
  connections.startConsulWatches(consul, watches, null, debug)
}

// SCHEDULED ACTIONS
// ////////////////////////////////////////////
async function scheduleActionsAsync () {
  // Cron like scheduler. Params are:
  // sec min hour day_of_month month day_of_week

  // calendar : run every 10 seconds, in every zone.
  // Help de-conflict across zones by running at a random
  // offset from 0 seconds.
  // e.g.
  //   0,10,20,30,40,50 * * * * *
  //   1,11,21,31,41,51 * * * * *
  let calRandomIntervalBase = _.random(9)
  let calRandomInterval = _.map([0, 10, 20, 30, 40, 50], function (interval) {
    interval += calRandomIntervalBase
    return interval
  })

  let cronScheduleCalendarAnchor = `${calRandomInterval.join(',')} * * * * *`
  debug.calendar(`scheduleJob : calendar : cronScheduleCalendarAnchor : %s`, cronScheduleCalendarAnchor)
  schedule.scheduleJob(cronScheduleCalendarAnchor, async () => {
    if (IS_LEADER) {
      processCalendarInterval()
    }
  })

  // NIST : run every 30 min at 25 and 55 minute marks
  // so as not to conflict with activity at the top and bottom
  // of the hour. Runs only in a single leader elected zone so
  // no de-confliction should be required.
  schedule.scheduleJob('0 25,55 * * * *', async () => {
    debug.nist(`scheduleJob : NIST : leader? : ${IS_LEADER}`)

    // Don't add a NIST block unless this Calendar is the zone leader
    // and there is NIST data available.
    if (IS_LEADER && !_.isEmpty(nistLatest)) {
      processNistInterval()
    }
  })

  // BTC anchor : run every 60 min
  let cronScheduleBtcAnchor = `0 0 * * * *`
  debug.btcAnchor(`scheduleJob : BTC anchor : cronScheduleBtcAnchor : ${cronScheduleBtcAnchor}`)
  schedule.scheduleJob(cronScheduleBtcAnchor, async () => {
    if (IS_LEADER && env.ANCHOR_BTC === 'enabled') {
      debug.btcAnchor(`scheduleJob : BTC anchor : ANCHOR_BTC enabled`)
      // Create a btc-a block
      try {
        processBtcAnchorInterval()
      } catch (error) {
        console.error(`scheduleJob : BTC anchor : ${error.message}`)
      }
    } else {
      if (IS_LEADER) debug.btcAnchor(`scheduleJob : BTC anchor : ANCHOR_BTC disabled`)
    }
  })
}

// process all steps need to start the application
async function start () {
  debug.general('start : begin')

  if (env.NODE_ENV === 'test') {
    debug.general('start : NODE_ENV === test : return')
    return
  }

  try {
    // init consul
    debug.general('start : init consul')
    consul = connections.initConsul(cnsl, env.CONSUL_HOST, env.CONSUL_PORT, debug)
    debug.general('start : init Sequelize connection')
    await openStorageConnectionAsync()
    debug.general('start : init Redis connection')
    openRedisConnection(env.REDIS_CONNECT_URIS)
    debug.general('start : perform leader election')
    performLeaderElection()
    debug.general('start : init RabbitMQ connection')
    await openRMQConnectionAsync(env.RABBITMQ_CONNECT_URI)
    debug.general('start : init Consul watches')
    startConsulWatches()
    debug.general('start : init scheduled actions')
    await scheduleActionsAsync()
    debug.general('start : complete')
  } catch (error) {
    console.error(`start : An error has occurred on startup: ${error.message}`)
    process.exit(1)
  }
}

// get the whole show started
start()
