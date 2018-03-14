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
const cnsl = require('consul')
const utils = require('./lib/utils.js')
const rp = require('request-promise-native')
const leaderElection = require('exp-leader-election')
const schedule = require('node-schedule')
const debugPkg = require('debug')

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

// An array of all Merkle tree roots from aggregators needing
// to be processed. Will be filled as new roots arrive on the queue.
let AGGREGATION_ROOTS = []

// The channel used for all amqp communication
// This value is set once the connection has been established
let amqpChannel = null

// The latest NIST data
// This value is updated from consul events as changes are detected
let nistLatest = null

// The URI to use for requests to the eth-tnt-tx service
const ethTntTxUri = env.ETH_TNT_TX_CONNECT_URI

// pull in variables defined in shared CalendarBlock module
const sequelize = calendarBlock.sequelize
const CalendarBlock = calendarBlock.CalendarBlock
const pgClientPool = calendarBlock.pgClientPool

const consul = cnsl({ host: env.CONSUL_HOST, port: env.CONSUL_PORT })
debug.general('consul connection established')

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
    let dataVal = nistDataObj.split(':')[1].toString()  // the hex value for this NIST entry
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
      case 'aggregator':
        consumeAggRootMessage(msg)
        break
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
    retries: 25,        // The maximum amount of times to retry the operation. Default is 10
    factor: 1,        // The exponential factor to use. Default is 2
    minTimeout: 5,   // The number of milliseconds before starting the first retry. Default is 1000
    maxTimeout: 100,
    onRetry: (error) => { debuglogger(`executeRetryableBlockWriteTransactionAsync : retrying : writing block : ${blockType} : ${error.message}`) }
  })

  return newBlock
}

function consumeAggRootMessage (msg) {
  if (msg !== null) {
    let rootObj = JSON.parse(msg.content.toString())

    // add msg to the root object so that we can ack it during the persistCalendarTreeAsync process
    rootObj.msg = msg
    AGGREGATION_ROOTS.push(rootObj)
  }
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

/**
 * Converts proof path array output from the merkle-tools package
 * to a Chainpoint v3 ops array
 *
 * @param {proof object array} proof - The proof array generated by merkle-tools
 * @param {string} op - The hash type performed throughout merkle tree construction (sha-256, sha-512, sha-256-x2, etc.)
 * @returns {ops object array}
 */
function formatAsChainpointV3Ops (proof, op) {
  proof = proof.map((item) => {
    if (item.left) {
      return { l: item.left }
    } else {
      return { r: item.right }
    }
  })
  let ChainpointV3Ops = []
  for (let x = 0; x < proof.length; x++) {
    ChainpointV3Ops.push(proof[x])
    ChainpointV3Ops.push({ op: op })
  }
  return ChainpointV3Ops
}

// Take work off of the AGGREGATION_ROOTS array and build Merkle tree
function generateCalendarTree (rootsForTree) {
  debug.general(`generateCalendarTree : begin`)

  let treeDataObj = null
  // create merkle tree only if there is at least one root to process
  if (rootsForTree.length > 0) {
    // clear the merkleTools instance to prepare for a new tree
    merkleTools.resetTree()

    // get root values from root objects
    let leaves = rootsForTree.map((rootObj) => {
      return rootObj.agg_root
    })

    // Add every root in rootsForTree to new Merkle tree
    merkleTools.addLeaves(leaves)
    merkleTools.makeTree()

    // Collect and store the Merkle root and proofs in an object
    treeDataObj = {}
    treeDataObj.cal_root = merkleTools.getMerkleRoot()

    let treeSize = merkleTools.getLeafCount()
    let proofData = []
    for (let x = 0; x < treeSize; x++) {
      // push the agg_id and corresponding proof onto the array
      let proofDataItem = {}
      proofDataItem.agg_id = rootsForTree[x].agg_id
      proofDataItem.agg_msg = rootsForTree[x].msg
      let proof = merkleTools.getProof(x)
      proofDataItem.proof = formatAsChainpointV3Ops(proof, 'sha-256')
      proofData.push(proofDataItem)
    }
    treeDataObj.proofData = proofData
    debug.general(`generateCalendarTree : rootsForTree length : ${rootsForTree.length}`)
  }
  debug.general(`generateCalendarTree : end`)
  return treeDataObj
}

// Write tree to calendar block DB and also to proof state service via RMQ
async function persistCalendarTreeAsync (treeDataObj) {
  debug.calendar(`persistCalendarTreeAsync : begin`)

  // if the amqp channel is null (closed), processing should not continue,
  // throw an error to force retry. Do this before any other DB or CPU time is
  // wasted within the lock around this function. Also helps ensure a cal block
  // is not written if RMQ writes will likely fail after it.
  if (amqpChannel === null) {
    throw new Error(`persistCalendarTreeAsync : amqpChannel is null : force retry`)
  }

  // get an array of messages to be acked or nacked in this process
  let messages = treeDataObj.proofData.map((proofDataItem) => {
    return proofDataItem.agg_msg
  })

  let block
  try {
    // Store Merkle root of calendar in DB and chain to previous calendar entries
    block = await createCalendarBlockAsync(treeDataObj.cal_root.toString('hex'))
  } catch (error) {
    _.forEach(messages, (message) => {
      // nack consumption of all original messages part of this aggregation event
      if (message !== null) {
        amqpChannel.nack(message)
        let rootObj = JSON.parse(message.content.toString())
        console.error(env.RMQ_WORK_IN_CAL_QUEUE, '[aggregator] consume message nacked', rootObj.agg_id)
      }
    })
    throw new Error(error.message)
  }
  debug.calendar(`persistCalendarTreeAsync : end`)
  return block
}

// Aggregate all block hashes on chain since last BTC anchor block, add new
// BTC anchor block to calendar, add new proof state entries, anchor root
async function aggregateAndAnchorBTCAsync (lastBtcAnchorBlockId) {
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
    // Retrieve ALL Calendar blocks since last anchor block created by any stack.
    // This will change when we determine an approach to allow only a single zone to anchor.
    // stackId: env.CHAINPOINT_CORE_BASE_URI may be removed after single anchor implementation

    // Use last BTC anchor block ID from global var 'lastBtcAnchorBlockId'
    // set at top and bottom of hour just prior to requesting this lock.
    if (!lastBtcAnchorBlockId) lastBtcAnchorBlockId = -1
    let blocks = await CalendarBlock.findAll({ where: { id: { [Op.gt]: lastBtcAnchorBlockId }, stackId: env.CHAINPOINT_CORE_BASE_URI }, attributes: ['id', 'type', 'hash'], order: [['id', 'ASC']] })
    // debug.btcAnchor('aggregateAndAnchorBTCAsync : btc blocks to anchor : %o', blocks)
    debug.btcAnchor('aggregateAndAnchorBTCAsync : btc blocks.length to anchor : %d', blocks.length)

    if (blocks.length === 0) {
      debug.btcAnchor('aggregateAndAnchorBTCAsync : No blocks to anchor since last btc-a : returning')
      return
    }

    // Build merkle tree with block hashes
    let leaves = blocks.map((blockObj) => {
      return blockObj.hash
    })

    // clear the merkleTools instance to prepare for a new tree
    merkleTools.resetTree()

    // Add every blockHash in blocks to new Merkle tree
    merkleTools.addLeaves(leaves)
    merkleTools.makeTree()

    // get the total count of leaves in this aggregation
    let treeSize = merkleTools.getLeafCount()

    treeData.anchor_btc_agg_id = uuidv1()
    treeData.anchor_btc_agg_root = merkleTools.getMerkleRoot().toString('hex')

    let proofData = []
    for (let x = 0; x < treeSize; x++) {
      // for calendar type blocks only, push the cal_id and corresponding proof onto the array
      if (blocks[x].type === 'cal') {
        let proofDataItem = {}
        proofDataItem.cal_id = blocks[x].id
        let proof = merkleTools.getProof(x)
        proofDataItem.proof = formatAsChainpointV3Ops(proof, 'sha-256')
        proofData.push(proofDataItem)
      }
    }
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

// Get the id of that most recent btc-a block for the current stackId
async function lastBtcAnchorBlockIdForStackIdAsync () {
  debug.btcAnchor('lastBtcAnchorBlockForStackId : begin')
  let lastBtcAnchorBlockForStack
  try {
    lastBtcAnchorBlockForStack = await CalendarBlock.findOne({ where: { type: 'btc-a', stackId: env.CHAINPOINT_CORE_BASE_URI }, attributes: ['id', 'hash', 'time', 'stackId'], order: [['id', 'DESC']] })
  } catch (error) {
    throw new Error(`unable to retrieve most recent BTC anchor block : ${error.message}`)
  }

  let id = lastBtcAnchorBlockForStack ? parseInt(lastBtcAnchorBlockForStack.id, 10) : null
  debug.btcAnchor(`lastBtcAnchorBlockIdForStackIdAsync : last block ID : ${id}`)
  return id
}

// queue messages for state service with cal state data and ack original messages
async function queueCalStateDataAsync (treeDataObj, block) {
  // get an array of messages to be acked or nacked in this process
  let messages = treeDataObj.proofData.map((proofDataItem) => {
    return proofDataItem.agg_msg
  })

  // queue proof state messages for each aggregation root in the tree
  // for each aggregation root, queue up message containing
  // updated proof state bound for proof state service
  for (let x = 0; x < treeDataObj.proofData.length; x++) {
    let proofDataItem = treeDataObj.proofData[x]
    let stateObj = {}
    stateObj.agg_id = proofDataItem.agg_id
    stateObj.cal_id = block.id
    stateObj.cal_state = {}
    // add ops connecting agg_root to cal_root
    stateObj.cal_state.ops = proofDataItem.proof
    // add ops extending proof path beyond cal_root to calendar block's block_hash
    stateObj.cal_state.ops.push({ l: `${block.id}:${block.time}:${block.version}:${block.stackId}:${block.type}:${block.dataId}` })
    stateObj.cal_state.ops.push({ r: block.prevHash })
    stateObj.cal_state.ops.push({ op: 'sha-256' })

    // Build the anchors uris using the locations configured in CHAINPOINT_CORE_BASE_URI
    let BASE_URIS = [env.CHAINPOINT_CORE_BASE_URI]
    let uris = []
    for (let x = 0; x < BASE_URIS.length; x++) uris.push(`${BASE_URIS[x]}/calendar/${block.id}/hash`)
    stateObj.cal_state.anchor = {
      anchor_id: block.id,
      uris: uris
    }

    try {
      await amqpChannel.sendToQueue(env.RMQ_WORK_OUT_STATE_QUEUE, Buffer.from(JSON.stringify(stateObj)), { persistent: true, type: 'cal' })
      // New message has been published
      // debug.general(env.RMQ_WORK_OUT_STATE_QUEUE, '[cal] publish message acked')
    } catch (error) {
      // An error as occurred publishing a message
      console.error(`queueCalStateDataAsync : ${env.RMQ_WORK_OUT_STATE_QUEUE} [cal] publish message nacked`)
      console.error(`queueCalStateDataAsync : Unable to publish state message : ${error.message}`)
      _.forEach(messages, (message) => {
        // nack consumption of all original messages part of this aggregation event
        if (message !== null) {
          amqpChannel.nack(message)
          let rootObj = JSON.parse(message.content.toString())
          console.error(`queueCalStateDataAsync : [aggregator] consume message nacked : ${rootObj.agg_id}`)
        }
      })
      return
    }
  }

  _.forEach(messages, (message) => {
    if (message !== null) {
      // ack consumption of all original messages part of this aggregation event
      let rootObj = JSON.parse(message.content.toString())
      amqpChannel.ack(message)
      debug.calendar(`queueCalStateDataAsync : [aggregator] consume message acked : ${rootObj.agg_id}`)
    }
  })
}

// queue messages for state service with btc-a state data
async function queueBtcAStateDataAsync (treeData) {
  // For each calendar record block in the tree, add proof state
  // item containing proof ops from block_hash to anchor_btc_agg_root
  // queue up message containing updated proof state bound for proof state service
  for (let x = 0; x < treeData.proofData.length; x++) {
    let proofDataItem = treeData.proofData[x]

    let stateObj = {}
    stateObj.cal_id = proofDataItem.cal_id
    stateObj.anchor_btc_agg_id = treeData.anchor_btc_agg_id
    stateObj.anchor_btc_agg_state = {}
    stateObj.anchor_btc_agg_state.ops = proofDataItem.proof

    try {
      // Publish new message
      await amqpChannel.sendToQueue(env.RMQ_WORK_OUT_STATE_QUEUE, Buffer.from(JSON.stringify(stateObj)), { persistent: true, type: 'anchor_btc_agg' })
      // debug.btcConfirm(env.RMQ_WORK_OUT_STATE_QUEUE, '[anchor_btc_agg] publish message acked')
    } catch (error) {
      console.error('queueBtcAStateDataAsync : [anchor_btc_agg] publish message nacked')
      console.error(`queueBtcAStateDataAsync : unable to publish state message : ${error.message}`)
      return
    }
  }

  let anchorData = {
    anchor_btc_agg_id: treeData.anchor_btc_agg_id,
    anchor_btc_agg_root: treeData.anchor_btc_agg_root
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
  stateObj.btchead_state.ops = formatAsChainpointV3Ops(proofPath, 'sha-256-x2')

  // Build the anchors uris using the locations configured in CHAINPOINT_CORE_BASE_URI
  let BASE_URIS = [env.CHAINPOINT_CORE_BASE_URI]
  let uris = []
  for (let x = 0; x < BASE_URIS.length; x++) uris.push(`${BASE_URIS[x]}/calendar/${block.id}/data`)
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
    uri: `${ethTntTxUri}/transfer`,
    body: {
      to_addr: ethAddr,
      value: tntGrains
    },
    json: true,
    gzip: true,
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
  let rootsForTree = AGGREGATION_ROOTS.splice(0)
  try {
    // this must not be retried since it mutates state.
    let treeDataObj = generateCalendarTree(rootsForTree)
    if (!_.isEmpty(treeDataObj)) {
      let block = await persistCalendarTreeAsync(treeDataObj)

      // queue messages for state service
      setImmediate(() => { queueCalStateDataAsync(treeDataObj, block) })
    } else {
      debug.calendar('scheduleJob : processCalendarInterval : no treeData (hashes) to process for calendar interval')
    }
  } catch (error) {
    // an error has occured, return the rootsForTree back to AGGREGATION_ROOTS
    // to be processed at the next interval
    AGGREGATION_ROOTS = rootsForTree.concat(AGGREGATION_ROOTS)
    console.error(`scheduleJob : processCalendarInterval : unable to create calendar block : ${error.message}`)
  }
}

async function processNistInterval () {
  try {
    await createNistBlockAsync(nistLatest)
  } catch (error) {
    console.error(`scheduleJob : processNistInterval : unable to create NIST block : ${error.message}`)
  }
}

async function processBtcAnchorInterval (lastBtcAnchorBlockId) {
  try {
    let treeData = await aggregateAndAnchorBTCAsync(lastBtcAnchorBlockId)

    // queue messages for state service
    setImmediate(() => { queueBtcAStateDataAsync(treeData) })
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
    let rewardTNTAddr // the TNT address from which rewards are sent for this Core
    try {
      let ethWallet = JSON.parse(env.ETH_WALLET)
      rewardTNTAddr = ethWallet.address
      if (!rewardTNTAddr.startsWith('0x')) rewardTNTAddr = `0x${rewardTNTAddr}`
      let requiredMinimumBalance = nodeTNTGrainsRewardShare + coreTNTGrainsRewardShare
      let currentBalance = await getTNTGrainsBalanceForAddressAsync(rewardTNTAddr)
      if (currentBalance >= requiredMinimumBalance) {
        debug.reward(`consumeRewardMessageAsync : processRewardMessage : Minimum balance for ${rewardTNTAddr} OK, needed ${requiredMinimumBalance} of ${currentBalance} grains`)
      } else {
        console.error(`consumeRewardMessageAsync : processRewardMessage : Insufficient balance for ${rewardTNTAddr}, needed ${requiredMinimumBalance} of ${currentBalance} grains`)
      }
    } catch (error) {
      console.error(`consumeRewardMessageAsync : processRewardMessage : Could not verify minimum balance for ${rewardTNTAddr} : ${error.message}`)
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
      await createRewardBlockAsync(dataId, dataVal)

      amqpChannel.ack(msg)
      debug.reward('consumeRewardMessageAsync : processRewardMessage : acked message w/ address : %s', rewardMsgObj.node.address)
    } catch (error) {
      // ack consumption of original message to avoid distribution again
      amqpChannel.ack(msg)
      console.error('consumeRewardMessageAsync : processRewardMessage : message acked with for address : %s : %s', rewardMsgObj.node.address, error.message)
      throw new Error(`unable to create reward block : ${error.message}`)
    }
  } catch (error) {
    console.error(`consumeRewardMessageAsync : processRewardMessage : ${error.message}`)
  }
}

async function getTNTGrainsBalanceForAddressAsync (tntAddress) {
  let ethTntTxUri = env.ETH_TNT_TX_CONNECT_URI

  let options = {
    headers: [
      {
        name: 'Content-Type',
        value: 'application/json'
      }
    ],
    method: 'GET',
    uri: `${ethTntTxUri}/balance/${tntAddress}`,
    json: true,
    gzip: true,
    timeout: 10000,
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
  debug.general('openStorageConnectionAsync : begin')
  let dbConnected = false
  while (!dbConnected) {
    try {
      await sequelize.sync({ logging: false })
      debug.general('openStorageConnectionAsync : connection established')
      dbConnected = true
    } catch (error) {
      console.error('openStorageConnectionAsync : cannot establish Sequelize connection. Attempting in 5 seconds...')
      await utils.sleep(5000)
    }
  }

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
 * Opens an AMPQ connection and channel
 * Retry logic is included to handle losses of connection
 *
 * @param {string} connectionString - The connection string for the RabbitMQ instance, an AMQP URI
 */
async function openRMQConnectionAsync (connectionString) {
  debug.general('openRMQConnectionAsync : begin')
  let rmqConnected = false
  while (!rmqConnected) {
    try {
      // connect to rabbitmq server
      let conn = await amqp.connect(connectionString)
      // create communication channel
      let chan = await conn.createConfirmChannel()
      // the connection and channel have been established
      chan.assertQueue(env.RMQ_WORK_IN_CAL_QUEUE, { durable: true })
      chan.assertQueue(env.RMQ_WORK_OUT_STATE_QUEUE, { durable: true })
      chan.assertQueue(env.RMQ_WORK_OUT_BTCTX_QUEUE, { durable: true })
      chan.assertQueue(env.RMQ_WORK_OUT_BTCMON_QUEUE, { durable: true })
      chan.prefetch(env.RMQ_PREFETCH_COUNT_CAL)
      // set 'amqpChannel' so that publishers have access to the channel
      amqpChannel = chan
      chan.consume(env.RMQ_WORK_IN_CAL_QUEUE, (msg) => {
        processMessage(msg)
      })
      // if the channel closes for any reason, attempt to reconnect
      conn.on('close', async () => {
        console.error('openRMQConnectionAsync : connection to RMQ closed.  Reconnecting in 5 seconds...')
        amqpChannel = null
        // un-acked messaged will be requeued, so clear all work in progress
        AGGREGATION_ROOTS = []
        await utils.sleep(5000)
        await openRMQConnectionAsync(connectionString)
      })
      debug.general('openRMQConnectionAsync : connection established')
      rmqConnected = true
    } catch (error) {
      // catch errors when attempting to establish connection
      console.error('openRMQConnectionAsync : cannot establish RabbitMQ connection. Attempting in 5 seconds...')
      await utils.sleep(5000)
    }
  }
  debug.general('openRMQConnectionAsync : end')
}

async function performLeaderElection () {
  IS_LEADER = false
  let leaderElectionConfig = {
    key: env.CALENDAR_LEADER_KEY,
    consul: {
      host: env.CONSUL_HOST,
      port: env.CONSUL_PORT,
      ttl: 15,
      lockDelay: 1
    }
  }

  leaderElection(leaderElectionConfig)
    .on('gainedLeadership', function () {
      debug.general('leaderElection : elected! : %s', env.CHAINPOINT_CORE_BASE_URI)
      IS_LEADER = true
    })
    .on('error', function () {
      console.error('leaderElection : on error : lock session invalidated')
      IS_LEADER = false
    })
}

// Initalizes all the consul watches
function startConsulWatches () {
  debug.general('startConsulWatches : begin')

  // Continuous watch on the consul key holding the NIST object.
  var nistWatch = consul.watch({ method: consul.kv.get, options: { key: env.NIST_KEY } })

  // Store the updated nist object on change
  nistWatch.on('change', async function (data, res) {
    // process only if a value has been returned and it is different than what is already stored
    if (data && data.Value && nistLatest !== data.Value) {
      debug.nist('startConsulWatches : nistLatest : %s', data.Value)
      nistLatest = data.Value
    }
  })

  nistWatch.on('error', function (err) {
    console.error('startConsulWatches : nistWatch : ', err)
  })

  debug.general('startConsulWatches : end')
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
    if (AGGREGATION_ROOTS.length > 0) {
      debug.calendar(`scheduleJob : calendar : AGGREGATION_ROOTS.length : %d`, AGGREGATION_ROOTS.length)
      processCalendarInterval()
    } else {
      debug.calendar(`scheduleJob : calendar : AGGREGATION_ROOTS.length : 0`)
    }
  })

  // NIST : run every 30 min at 25 and 55 minute marks
  // so as not to conflict with activity at the top and bottom
  // of the hour. Runs only in a single leader elected zone so
  // no de-confliction should be required.
  schedule.scheduleJob('0 25,55 * * * *', async () => {
    debug.nist(`scheduleJob : NIST : leader? : ${IS_LEADER}`)

    // Don't consume a lock unless this Calendar is the zone leader
    // and there is NIST data available.
    if (IS_LEADER && !_.isEmpty(nistLatest)) {
      processNistInterval()
    }
  })

  // BTC anchor : run every 60 min, in every zone,
  // at the top and bottom of the hour. Pick a random second
  // at the top of the hour to de-conflict zones running the same code.
  let cronScheduleBtcAnchor = `${_.random(59)} 0 * * * *`
  debug.btcAnchor(`scheduleJob : BTC anchor : cronScheduleBtcAnchor : ${cronScheduleBtcAnchor}`)
  schedule.scheduleJob(cronScheduleBtcAnchor, async () => {
    if (env.ANCHOR_BTC === 'enabled') {
      debug.btcAnchor(`scheduleJob : BTC anchor : ANCHOR_BTC enabled`)
      // Look up last anchor block in DB outside of a lock to reduce
      // time spent inside the lock which is blocking for all other
      // lock users.
      try {
        // Set global var with last anchor block ID for use inside lock.
        // Doing it this way since we can't pass params to lock.
        let lastBtcAnchorBlockId = await lastBtcAnchorBlockIdForStackIdAsync()
        processBtcAnchorInterval(lastBtcAnchorBlockId)
      } catch (error) {
        console.error(`scheduleJob : BTC anchor : ${error.message}`)
      }
    } else {
      debug.btcAnchor(`scheduleJob : BTC anchor : ANCHOR_BTC disabled`)
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
    debug.general('start : init Sequelize connection')
    await openStorageConnectionAsync()
    debug.general('start : init consul and perform leader election')
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
