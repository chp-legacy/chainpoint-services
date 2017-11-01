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
const env = require('./lib/parse-env.js')('cal')

const async = require('async')
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

// See : https://github.com/zeit/async-retry
const retry = require('async-retry')

const Sequelize = require('sequelize-cockroachdb')
const Op = Sequelize.Op

var debug = {
  general: require('debug')('calendar:general'),
  genesis: require('debug')('calendar:block:genesis'),
  calendar: require('debug')('calendar:block:calendar'),
  btcAnchor: require('debug')('calendar:block:btcAnchor'),
  btcConfirm: require('debug')('calendar:block:btcConfirm'),
  reward: require('debug')('calendar:block:reward'),
  nist: require('debug')('calendar:block:nist')
}

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

// An array of all Btc-Mon messages received and awaiting processing
let BTC_MON_MESSAGES = []

// Most recent Reward message received and awaiting processing
let rewardLatest = null

// The URI to use for requests to the eth-tnt-tx service
let ethTntTxUri = env.ETH_TNT_TX_CONNECT_URI

// The ID of the last BTC anchor block for this stack found at top and bottom of the hour
let lastBtcAnchorBlockId = null

// pull in variables defined in shared CalendarBlock module
let sequelize = calendarBlock.sequelize
let CalendarBlock = calendarBlock.CalendarBlock

let consul = cnsl({ host: env.CONSUL_HOST, port: env.CONSUL_PORT })
debug.general('consul connection established')

// Calculate the hash of the signing public key bytes
// to allow lookup of which pubkey was used to sign
// a block. Handles different organizations signing blocks
// with different keys and key rotation by those orgs.
// When a Base64 pubKey is published publicly it should also
// be accompanied by this hash of its bytes to serve
// as a fingerprint.
let calcSigningPubKeyHashHex = (pubKey) => {
  return crypto.createHash('sha256').update(pubKey).digest('hex')
}
const signingPubKeyHashHex = calcSigningPubKeyHashHex(signingKeypair.publicKey)

// Calculate a deterministic block hash and return a Buffer hash value
let calcBlockHashHex = (block) => {
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
let calcBlockHashSigB64 = (blockHashHex) => {
  return nacl.util.encodeBase64(nacl.sign.detached(nacl.util.decodeUTF8(blockHashHex), signingKeypair.secretKey))
}

// The write function used by all block creation functions to write to calendar blockchain
let writeBlockAsync = async (height, type, dataId, dataVal, prevHash, friendlyName) => {
  debug.general(`writeBlockAsync : begin : ${friendlyName}`)
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

  try {
    let block = await CalendarBlock.create(b)
    debug.general(`writeBlockAsync : wrote ${friendlyName} block : id : ${block.get({ plain: true }).id}`)
    return block.get({ plain: true })
  } catch (error) {
    throw new Error(`writeBlockAsync : ${friendlyName} error : ${error.message}: ${error.stack}`)
  }
}

let createGenesisBlockAsync = async () => {
  debug.genesis(`createGenesisBlockAsync : begin`)
  await writeBlockAsync(0, 'gen', '0', zeroStr, zeroStr, 'GENESIS')
}

let createCalendarBlockAsync = async (root) => {
  debug.calendar(`createCalendarBlockAsync : begin`)
  try {
    let prevBlock = await CalendarBlock.findOne({ attributes: ['id', 'hash'], order: [['id', 'DESC']] })
    if (prevBlock) {
      let newId = parseInt(prevBlock.id, 10) + 1
      debug.calendar(`createCalendarBlockAsync : prevBlock found : ${newId}`)
      return await writeBlockAsync(newId, 'cal', newId.toString(), root.toString(), prevBlock.hash, 'CAL')
    } else {
      throw new Error('no previous block found')
    }
  } catch (error) {
    throw new Error(`createCalendarBlockAsync : could not write calendar block: ${error.message}`)
  }
}

let createNistBlockAsync = async (nistDataObj) => {
  debug.nist(`createNistBlockAsync : begin`)
  try {
    let prevBlock = await CalendarBlock.findOne({ attributes: ['id', 'hash'], order: [['id', 'DESC']] })
    if (prevBlock) {
      let newId = parseInt(prevBlock.id, 10) + 1
      debug.nist(`createNistBlockAsync : prevBlock found : ${newId}`)
      let dataId = nistDataObj.split(':')[0].toString() // the epoch timestamp for this NIST entry
      let dataVal = nistDataObj.split(':')[1].toString()  // the hex value for this NIST entry
      return await writeBlockAsync(newId, 'nist', dataId, dataVal, prevBlock.hash, 'NIST')
    } else {
      throw new Error('no previous block found')
    }
  } catch (error) {
    throw new Error(`createNistBlockAsync : could not write NIST block: ${error.message}`)
  }
}

let createBtcAnchorBlockAsync = async (root) => {
  debug.btcAnchor(`createBtcAnchorBlockAsync : begin`)
  try {
    let prevBlock = await CalendarBlock.findOne({ attributes: ['id', 'hash'], order: [['id', 'DESC']] })
    if (prevBlock) {
      let newId = parseInt(prevBlock.id, 10) + 1
      debug.btcAnchor(`createBtcAnchorBlockAsync : prevBlock found : ${newId} : btc-a : '' : ${root.toString()} : ${prevBlock.hash} : 'BTC-ANCHOR'`)
      return await writeBlockAsync(newId, 'btc-a', '', root.toString(), prevBlock.hash, 'BTC-ANCHOR')
    } else {
      throw new Error('no previous block found')
    }
  } catch (error) {
    throw new Error(`createBtcAnchorBlockAsync : failed to write btc-a block: ${error.message}`)
  }
}

let createBtcConfirmBlockAsync = async (height, root) => {
  debug.btcConfirm(`createBtcConfirmBlockAsync : begin`)
  try {
    let prevBlock = await CalendarBlock.findOne({ attributes: ['id', 'hash'], order: [['id', 'DESC']] })
    if (prevBlock) {
      let newId = parseInt(prevBlock.id, 10) + 1
      debug.btcConfirm(`createBtcConfirmBlockAsync : prevBlock found : ${newId}`)
      return await writeBlockAsync(newId, 'btc-c', height.toString(), root.toString(), prevBlock.hash, 'BTC-CONFIRM')
    } else {
      throw new Error('no previous block found')
    }
  } catch (error) {
    throw new Error(`could not write BTC confirm block: ${error.message}`)
  }
}

let createRewardBlockAsync = async (dataId, dataVal) => {
  debug.reward(`createRewardBlockAsync : begin`)
  try {
    let prevBlock = await CalendarBlock.findOne({ attributes: ['id', 'hash'], order: [['id', 'DESC']] })
    if (prevBlock) {
      let newId = parseInt(prevBlock.id, 10) + 1
      debug.reward(`createRewardBlockAsync : prevBlock found : ${newId}`)
      return await writeBlockAsync(newId, 'reward', dataId.toString(), dataVal.toString(), prevBlock.hash, 'REWARD')
    } else {
      throw new Error('no previous block found')
    }
  } catch (error) {
    throw new Error(`could not write reward block: ${error.message}`)
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
          consumeBtcMonMessage(msg)
        } else {
          // BTC anchoring has been disabled, ack message and do nothing
          debug.general(`processMessage : [btcmon] publish message acked : BTC disabled : ${msg.btctx_id}`)
          amqpChannel.ack(msg)
        }
        break
      case 'reward':
        consumeRewardMessage(msg)
        break
      default:
        console.error('processMessage : unknown message type', msg.properties.type)
        // cannot handle unknown type messages, ack message and do nothing
        amqpChannel.ack(msg)
    }
  }
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

    async.series([
      (callback) => {
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

        amqpChannel.sendToQueue(env.RMQ_WORK_OUT_STATE_QUEUE, Buffer.from(JSON.stringify(stateObj)), { persistent: true, type: 'btctx' },
          (err, ok) => {
            if (err !== null) {
              // An error as occurred publishing a message
              console.error(env.RMQ_WORK_OUT_STATE_QUEUE, '[btctx] publish message nacked')
              return callback(err)
            } else {
              // New message has been published
              // debug.general(env.RMQ_WORK_OUT_STATE_QUEUE, '[btctx] publish message acked')
              return callback(null)
            }
          })
      },
      // inform btc-mon of new tx_id to watch, queue up message bound for BTC mon
      (callback) => {
        amqpChannel.sendToQueue(env.RMQ_WORK_OUT_BTCMON_QUEUE, Buffer.from(JSON.stringify({ tx_id: btcTxObj.btctx_id })), { persistent: true },
          (err, ok) => {
            if (err !== null) {
              // An error as occurred publishing a message
              console.error(env.RMQ_WORK_OUT_BTCMON_QUEUE, 'publish message nacked')
              return callback(err)
            } else {
              // New message has been published
              // debug.general(env.RMQ_WORK_OUT_BTCMON_QUEUE, 'publish message acked')
              return callback(null)
            }
          })
      }
    ], (err, results) => {
      if (err) {
        amqpChannel.nack(msg)
        console.error(env.RMQ_WORK_IN_CAL_QUEUE, '[btctx] consume message nacked', btcTxObj.btctx_id)
      } else {
        amqpChannel.ack(msg)
        debug.general(`consumeBtcTxMessageAsync : [btctx] consume message acked : ${btcTxObj.btctx_id}`)
      }
    })
  }
  debug.general(`consumeBtcTxMessageAsync : end`)
}

function consumeBtcMonMessage (msg) {
  if (msg !== null) {
    BTC_MON_MESSAGES.push(msg)
    try {
      btcConfirmLock.acquire()
    } catch (error) {
      console.error('consumeBtcMonMessage : acquire : ', error.message)
    }
  }
}

function consumeRewardMessage (msg) {
  if (msg !== null) {
    rewardLatest = msg
    try {
      rewardLock.acquire()
    } catch (error) {
      console.error('consumeRewardMessage : acquire : ', error.message)
    }
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
let generateCalendarTree = () => {
  debug.general(`generateCalendarTree : begin`)
  let rootsForTree = AGGREGATION_ROOTS.splice(0)

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
let persistCalendarTreeAsync = async (treeDataObj) => {
  debug.general(`persistCalendarTreeAsync : begin`)
  // get an array of messages to be acked or nacked in this process
  let messages = treeDataObj.proofData.map((proofDataItem) => {
    return proofDataItem.agg_msg
  })

  try {
    // Store Merkle root of calendar in DB and chain to previous calendar entries
    let block = await createCalendarBlockAsync(treeDataObj.cal_root.toString('hex'))

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
        console.error(env.RMQ_WORK_OUT_STATE_QUEUE, '[cal] publish message nacked')
        throw new Error(`Unable to publish state message: ${error.message}`)
      }
    }

    _.forEach(messages, (message) => {
      if (message !== null) {
        // ack consumption of all original messages part of this aggregation event
        let rootObj = JSON.parse(message.content.toString())
        amqpChannel.ack(message)
        debug.general(`persistCalendarTreeAsync : [aggregator] consume message acked : ${rootObj.agg_id}`)
      }
    })
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
  debug.general(`persistCalendarTreeAsync : end`)
}

// Aggregate all block hashes on chain since last BTC anchor block, add new
// BTC anchor block to calendar, add new proof state entries, anchor root
let aggregateAndAnchorBTCAsync = async (lastBtcAnchorBlockId) => {
  debug.btcAnchor(`aggregateAndAnchorBTCAsync : begin`)

  // if the amqp channel is null (closed), processing should not continue,
  // defer to next interval. Do this before any other DB or CPU time is
  // wasted within the lock around this function.
  if (amqpChannel === null) {
    debug.btcAnchor('aggregateAndAnchorBTCAsync : amqpChannel is null : returning')
    return
  }

  try {
    // Retrieve ALL Calendar blocks since last anchor block created by any stack.
    // This will change when we determine an approach to allow only a single zone to anchor.
    if (!lastBtcAnchorBlockId) lastBtcAnchorBlockId = -1
    let blocks = await CalendarBlock.findAll({ where: { id: { [Op.gt]: lastBtcAnchorBlockId } }, attributes: ['id', 'type', 'hash'], order: [['id', 'ASC']] })
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

    let treeData = {}
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

    // For each calendar record block in the tree, add proof state
    // item containing proof ops from block_hash to anchor_btc_agg_root
    async.series([
      (seriesCallback) => {
        // for each calendar block hash, queue up message containing updated
        // proof state bound for proof state service
        async.each(treeData.proofData, (proofDataItem, eachCallback) => {
          let stateObj = {}
          stateObj.cal_id = proofDataItem.cal_id
          stateObj.anchor_btc_agg_id = treeData.anchor_btc_agg_id
          stateObj.anchor_btc_agg_state = {}
          stateObj.anchor_btc_agg_state.ops = proofDataItem.proof

          amqpChannel.sendToQueue(env.RMQ_WORK_OUT_STATE_QUEUE, Buffer.from(JSON.stringify(stateObj)), { persistent: true, type: 'anchor_btc_agg' },
            (err, ok) => {
              if (err !== null) {
                // An error as occurred publishing a message
                console.error('aggregateAndAnchorBTCAsync : [anchor_btc_agg] publish message nacked')
                return eachCallback(err)
              } else {
                // New message has been published
                // debug.general('aggregateAndAnchorBTCAsync : [anchor_btc_agg] publish message acked')
                return eachCallback(null)
              }
            })
        }, (err) => {
          if (err) {
            console.error('aggregateAndAnchorBTCAsync : anchor aggregation had errors ', err.message)
            return seriesCallback(err)
          } else {
            debug.btcAnchor(`aggregateAndAnchorBTCAsync : anchor aggregation complete`)
            return seriesCallback(null)
          }
        })
      },
      (seriesCallback) => {
        // Create anchor_btc_agg message data object for anchoring service(s)
        let anchorData = {
          anchor_btc_agg_id: treeData.anchor_btc_agg_id,
          anchor_btc_agg_root: treeData.anchor_btc_agg_root
        }

        // Send anchorData to the BTC tx service for anchoring
        amqpChannel.sendToQueue(env.RMQ_WORK_OUT_BTCTX_QUEUE, Buffer.from(JSON.stringify(anchorData)), { persistent: true },
          (err, ok) => {
            if (err !== null) {
              console.error(env.RMQ_WORK_OUT_BTCTX_QUEUE, 'publish message nacked')
              return seriesCallback(err)
            } else {
              // debug.general(env.RMQ_WORK_OUT_BTCTX_QUEUE, 'publish message acked')
              return seriesCallback(null)
            }
          })
      }
    ], (err) => {
      if (err) throw new Error(err)
      debug.btcAnchor(`aggregateAndAnchorBTCAsync : complete`)
    })
  } catch (error) {
    throw new Error(`aggregateAndAnchorBTCAsync error: ${error.message}`)
  }
  debug.btcAnchor(`aggregateAndAnchorBTCAsync : end`)
}

// Each of these locks must be defined up front since event handlers
// need to be registered for each. They are all effectively locking the same
// resource since they share the same CALENDAR_LOCK_KEY. The value is
// purely informational and allows you to see which entity is currently
// holding a lock in the Consul admin web app.
//
// See also : https://github.com/hashicorp/consul/blob/master/api/lock.go#L21
//
var lockOpts = {
  key: env.CALENDAR_LOCK_KEY,
  lockwaittime: '60s',
  lockwaittimeout: '60s',
  lockretrytime: '100ms',
  session: {
    behavior: 'delete',
    checks: ['serfHealth'],
    lockdelay: '1ms',
    name: 'calendar-blockchain-lock',
    ttl: '60s'
  }
}

let genesisLock = consul.lock(_.merge({}, lockOpts, { value: 'genesis' }))
let calendarLock = consul.lock(_.merge({}, lockOpts, { value: 'calendar' }))
let nistLock = consul.lock(_.merge({}, lockOpts, { value: 'nist' }))
let btcAnchorLock = consul.lock(_.merge({}, lockOpts, { value: 'btc-anchor' }))
let btcConfirmLock = consul.lock(_.merge({}, lockOpts, { value: 'btc-confirm' }))
let rewardLock = consul.lock(_.merge({}, lockOpts, { value: 'reward' }))

function registerLockEvents (lock, lockName, acquireFunction) {
  debug.general(`registerLockEvents : ${lockName} : begin`)
  lock.on('acquire', () => {
    debug.general(`registerLockEvents : ${lockName} : acquired`)
    acquireFunction()
  })

  lock.on('error', (err) => {
    console.error(`registerLockEvents : ${lockName} : ${err.message}`)
  })

  lock.on('release', () => {
    debug.general(`registerLockEvents : ${lockName} : released`)
  })
}

// LOCK HANDLERS : genesis
registerLockEvents(genesisLock, 'genesisLock', async () => {
  try {
    // The value of the lock determines what function it triggers
    // Is a genesis block needed? If not release lock and move on.
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
        throw new Error(`unable to create genesis block: ${error.message}`)
      }
    } else {
      debug.general(`registerLockEvents : genesisLock : no genesis block needed: ${blockCount} block(s) found`)
    }
  } catch (error) {
    console.error(`registerLockEvents : genesisLock : unable to create genesis block: ${error.message}`)
  } finally {
    // always release lock
    try {
      genesisLock.release()
    } catch (error) {
      console.error(`registerLockEvents : genesisLock : finally release : ${error.message}`)
    }
  }
})

// LOCK HANDLERS : calendar
registerLockEvents(calendarLock, 'calendarLock', async () => {
  try {
    let treeDataObj = generateCalendarTree()
    // if there is some data to process, continue and persist
    if (treeDataObj) {
      await persistCalendarTreeAsync(treeDataObj)
    } else {
      // there is nothing to process in this calendar interval, write nothing, release lock
      debug.general('registerLockEvents : calendarLock : no hashes for this calendar interval')
    }
  } catch (error) {
    console.error(`registerLockEvents : calendarLock : unable to create calendar block: ${error.message}`)
  } finally {
    // always release lock
    try {
      calendarLock.release()
    } catch (error) {
      console.error(`registerLockEvents : calendarLock : finally release : ${error.message}`)
    }
  }
})

// LOCK HANDLERS : nist
registerLockEvents(nistLock, 'nistLock', async () => {
  try {
    await retry(async bail => {
      await createNistBlockAsync(nistLatest)
    }, {
      retries: 15,        // The maximum amount of times to retry the operation. Default is 10
      factor: 1.2,        // The exponential factor to use. Default is 2
      minTimeout: 250,    // The number of milliseconds before starting the first retry. Default is 1000
      onRetry: (error) => { console.error(`registerLockEvents : nistLock : retrying : ${error.message}`) }
    })
  } catch (error) {
    console.error(`registerLockEvents : nistLock : unable to create NIST block after retries : ${error.message}`)
  } finally {
    // always release lock
    try {
      nistLock.release()
    } catch (error) {
      console.error(`registerLockEvents : nistLock : finally release : ${error.message}`)
    }
  }
})

// LOCK HANDLERS : btc-anchor
registerLockEvents(btcAnchorLock, 'btcAnchorLock', async () => {
  try {
    await retry(async bail => {
      // Grab last BTC anchor block ID from global var 'lastBtcAnchorBlockId'
      // set at top and bottom of hour just prior to requesting this lock.
      await aggregateAndAnchorBTCAsync(lastBtcAnchorBlockId)
    }, {
      retries: 15,        // The maximum amount of times to retry the operation. Default is 10
      factor: 1.2,        // The exponential factor to use. Default is 2
      minTimeout: 250,    // The number of milliseconds before starting the first retry. Default is 1000
      onRetry: (error) => { console.error(`registerLockEvents : btcAnchorLock : retrying : ${error.message}`) }
    })
  } catch (error) {
    console.error(`registerLockEvents : btcAnchorLock : unable to aggregate and create BTC anchor block after retries : ${error.message}`)
  } finally {
    // always release lock
    try {
      btcAnchorLock.release()
    } catch (error) {
      console.error(`registerLockEvents : btcAnchorLock : finally release : ${error.message}`)
    }
  }
})

// LOCK HANDLERS : btc-confirm
registerLockEvents(btcConfirmLock, 'btcConfirmLock', async () => {
  try {
    let monMessagesToProcess = BTC_MON_MESSAGES.splice(0)
    // if there are no messages left to process, release lock and return
    if (monMessagesToProcess.length === 0) return

    for (let x = 0; x < monMessagesToProcess.length; x++) {
      let msg = monMessagesToProcess[x]

      let btcMonObj = JSON.parse(msg.content.toString())
      let btctxId = btcMonObj.btctx_id
      let btcheadHeight = btcMonObj.btchead_height
      let btcheadRoot = btcMonObj.btchead_root
      let proofPath = btcMonObj.path

      // Store Merkle root of BTC block in chain
      let block
      try {
        block = await createBtcConfirmBlockAsync(btcheadHeight, btcheadRoot)
      } catch (error) {
        throw new Error(`unable to create btc-c block : ${error.message}`)
      }

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
        await amqpChannel.sendToQueue(env.RMQ_WORK_OUT_STATE_QUEUE, Buffer.from(JSON.stringify(stateObj)), { persistent: true, type: 'btcmon' })
        // New message has been published
        // debug.general(env.RMQ_WORK_OUT_STATE_QUEUE, '[btcmon] publish message acked')
      } catch (error) {
        amqpChannel.nack(msg)
        console.error('registerLockEvents : btcConfirmLock : [btcmon] consume message nacked', stateObj.btctx_id)
        throw new Error(`unable to publish state message: ${error.message}`)
      }

      // ack consumption of all original hash messages part of this aggregation event
      amqpChannel.ack(msg)
      debug.btcConfirm('registerLockEvents : btcConfirmLock : [btcmon] consume message acked', stateObj.btctx_id)
    }
  } catch (error) {
    console.error(`registerLockEvents : btcConfirmLock : ${error.message}`)
  } finally {
    // always release lock
    try {
      btcConfirmLock.release()
    } catch (error) {
      console.error(`registerLockEvents : btcConfirmLock : finally release : ${error.message}`)
    }
  }
})

// LOCK HANDLERS : reward
registerLockEvents(rewardLock, 'rewardLock', async () => {
  let msg = rewardLatest
  let rewardMsgObj = JSON.parse(msg.content.toString())

  try {
    // transfer TNT according to random reward message selection
    let nodeRewardTxId = ''
    let coreRewardTxId = ''
    let nodeRewardETHAddr = rewardMsgObj.node.address
    let nodeTNTGrainsRewardShare = rewardMsgObj.node.amount
    let coreRewardEthAddr = rewardMsgObj.core ? rewardMsgObj.core.address : null
    let coreTNTGrainsRewardShare = rewardMsgObj.core ? rewardMsgObj.core.amount : 0

    // reward TNT to ETH address for selected qualifying Node according to random reward message selection
    let postObject = {
      to_addr: nodeRewardETHAddr,
      value: nodeTNTGrainsRewardShare
    }

    let options = {
      headers: [
        {
          name: 'Content-Type',
          value: 'application/json'
        }
      ],
      method: 'POST',
      uri: `${ethTntTxUri}/transfer`,
      body: postObject,
      json: true,
      gzip: true,
      resolveWithFullResponse: true
    }

    try {
      let rewardResponse = await rp(options)
      nodeRewardTxId = rewardResponse.body.trx_id
      debug.reward(`registerLockEvents : rewardLock : ${nodeTNTGrainsRewardShare} grains (${nodeTNTGrainsRewardShare / 10 ** 8} TNT) transferred to Node using ETH address ${nodeRewardETHAddr} in transaction ${nodeRewardTxId}`)
    } catch (error) {
      console.error(`registerLockEvents : rewardLock : ${nodeTNTGrainsRewardShare} grains (${nodeTNTGrainsRewardShare / 10 ** 8} TNT) failed to be transferred to Node using ETH address ${nodeRewardETHAddr}: ${error.message}`)
    }

    // reward TNT to Core operator according to random reward message selection (if applicable)
    if (coreTNTGrainsRewardShare > 0) {
      let postObject = {
        to_addr: coreRewardEthAddr,
        value: coreTNTGrainsRewardShare
      }

      let options = {
        headers: [
          {
            name: 'Content-Type',
            value: 'application/json'
          }
        ],
        method: 'POST',
        uri: `${ethTntTxUri}/transfer`,
        body: postObject,
        json: true,
        gzip: true,
        resolveWithFullResponse: true
      }

      try {
        let rewardResponse = await rp(options)
        coreRewardTxId = rewardResponse.body.trx_id
        debug.reward(`registerLockEvents : rewardLock : ${coreTNTGrainsRewardShare} grains (${coreTNTGrainsRewardShare / 10 ** 8} TNT) transferred to Core using ETH address ${coreRewardEthAddr} in transaction ${coreRewardTxId}`)
      } catch (error) {
        console.error(`registerLockEvents : rewardLock : ${coreTNTGrainsRewardShare} grains (${coreTNTGrainsRewardShare / 10 ** 8} TNT) failed to be transferred to Core using ETH address ${coreRewardEthAddr}: ${error.message}`)
      }
    }

    // construct the reward block data
    let dataId = nodeRewardTxId
    let dataVal = [rewardMsgObj.node.address, rewardMsgObj.node.amount].join(':')
    if (rewardMsgObj.core) {
      dataId = [dataId, coreRewardTxId].join(':')
      dataVal = [dataVal, rewardMsgObj.core.address, rewardMsgObj.core.amount].join(':')
    }

    try {
      await createRewardBlockAsync(dataId, dataVal)
      // ack consumption of all original hash messages part of this aggregation event
      amqpChannel.ack(msg)
      debug.reward(`registerLockEvents : rewardLock : [reward] consume message acked ${rewardMsgObj.node.address}`)
    } catch (error) {
      // ack consumption of all original message
      // this message must be acked to avoid reward distribution to node from occuring again
      amqpChannel.ack(msg)
      console.error(`registerLockEvents : rewardLock : [reward] consume message acked with error: ${error.message} ${rewardMsgObj.node.address}`)
      throw new Error(`unable to create reward block: ${error.message}`)
    }
  } catch (error) {
    console.error(`registerLockEvents : rewardLock : ${error.message}`)
  } finally {
    // always release lock
    try {
      rewardLock.release()
    } catch (error) {
      console.error(`registerLockEvents : rewardLock : finally release : ${error.message}`)
    }
  }
})

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
  // Trigger creation of the genesis block if needed and
  // don't consume a lock on every service restart if not.
  try {
    let blockCount = await CalendarBlock.count()
    if (blockCount === 0) {
      debug.general('openStorageConnectionAsync : trigger genesisLock')
      genesisLock.acquire()
    } else {
      debug.general('openStorageConnectionAsync : skip genesisLock : CalendarBlock.count : %d', blockCount)
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

// This initalizes all the consul watches and JS intervals that fire all calendar events
function startWatchesAndIntervals () {
  debug.general('startWatchesAndIntervals : begin')

  // Continuous watch on the consul key holding the NIST object.
  var nistWatch = consul.watch({ method: consul.kv.get, options: { key: env.NIST_KEY } })

  // Store the updated nist object on change
  nistWatch.on('change', async function (data, res) {
    // process only if a value has been returned and it is different than what is already stored
    if (data && data.Value && nistLatest !== data.Value) {
      debug.general('startWatchesAndIntervals : nistLatest : %s', data.Value)
      nistLatest = data.Value
    }
  })

  nistWatch.on('error', function (err) {
    console.error('startWatchesAndIntervals : nistWatch : ', err)
  })

  // PERIODIC TIMERS

  // Write a new calendar block
  setInterval(() => {
    try {
      // if the amqp channel is null (closed), processing should not continue, defer to next interval
      if (amqpChannel === null) return
      if (AGGREGATION_ROOTS.length > 0) { // there will be data to process, acquire lock and continue
        calendarLock.acquire()
      }
    } catch (error) {
      console.error(`startWatchesAndIntervals : calendarLock.acquire : ${error.message}`)
    }
  }, env.CALENDAR_INTERVAL_MS)

  debug.general('startWatchesAndIntervals : end')
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
    debug.general('start : init watches and intervals')
    startWatchesAndIntervals()
    debug.general('start : complete')
  } catch (error) {
    console.error(`start : An error has occurred on startup: ${error.message}`)
    process.exit(1)
  }
}

// get the whole show started
start()

async function lastBtcAnchorBlockIdForStackId () {
  debug.btcAnchor('lastBtcAnchorBlockForStackId : begin')
  let lastBtcAnchorBlockForStack
  try {
    lastBtcAnchorBlockForStack = await CalendarBlock.findOne({ where: { type: 'btc-a', stackId: env.CHAINPOINT_CORE_BASE_URI }, attributes: ['id', 'hash', 'time', 'stackId'], order: [['id', 'DESC']] })
  } catch (error) {
    throw new Error(`unable to retrieve most recent BTC anchor block: ${error.message}`)
  }

  let id = lastBtcAnchorBlockForStack ? parseInt(lastBtcAnchorBlockForStack.id, 10) : null
  debug.btcAnchor(`lastBtcAnchorBlockIdForStackId : last block ID : ${id}`)
  return id
}

// Cron like scheduler. Params are:
// sec min hour day_of_month month day_of_week

// nistLock : run every 30 min at 25 and 55 minute marks
// so as not to conflict with activity at the top and bottom
// of the hour. Runs only in a single leader elected zone so
// no de-confliction should be required.
schedule.scheduleJob('0 */25,55 * * * *', () => {
  debug.nist(`scheduleJob : nistLock.acquire : leader? : ${IS_LEADER}`)

  // Don't consume a lock unless this Calendar is the zone leader
  // and there is NIST data available.
  if (IS_LEADER && !_.isEmpty(nistLatest)) {
    try {
      nistLock.acquire()
    } catch (error) {
      console.error('scheduleJob : nistLock.acquire : %s', error.message)
    }
  }
})

// btcAnchorLock : run every 30 min, in every zone,
// at the top and bottom of the hour. Pick a random second
// within the top and bottom of the hour to de-conflict
// zones running the same code.
let cronScheduleBtcAnchor = `${_.random(59)} */30 * * * *`
debug.btcAnchor(`scheduleJob : btcAnchor : cronSchedule : ${cronScheduleBtcAnchor}`)
schedule.scheduleJob(cronScheduleBtcAnchor, () => {
  if (env.ANCHOR_BTC === 'enabled') {
    debug.btcAnchor(`scheduleJob : btcAnchorLock.acquire : ANCHOR_BTC enabled`)
    // Look up last anchor block in DB outside of a lock to reduce
    // time spent inside the lock which is blocking for all other
    // lock users.
    lastBtcAnchorBlockIdForStackId()
    .then((id) => {
      // Set global var with last anchor block ID for use inside lock.
      // Doing it this way since we can't pass params to lock.
      lastBtcAnchorBlockId = id
      debug.btcAnchor(`scheduleJob : btcAnchorLock.acquire : set lastBtcAnchorBlockId : ${lastBtcAnchorBlockId}`)

      try {
        // Now that we've done some heavy DB lifting lets acquire the lock
        btcAnchorLock.acquire()
      } catch (error) {
        console.error('scheduleJob : btcAnchorLock.acquire : %s', error.message)
      }
    })
    .catch(error => {
      lastBtcAnchorBlockId = null
      console.error('scheduleJob : lastBtcAnchorBlockIdForStackId : %s', error.message)
    })
  } else {
    debug.btcAnchor(`scheduleJob : btcAnchorLock.acquire : ANCHOR_BTC disabled`)
  }
})
