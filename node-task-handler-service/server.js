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
const env = require('./lib/parse-env.js')('task-handler')

const amqp = require('amqplib')
const debugPkg = require('debug')
const semver = require('semver')
const retry = require('async-retry')
const rp = require('request-promise-native')
const events = require('events')
const cnsl = require('consul')
const objectHash = require('object-hash')
const crypto = require('crypto')
const connections = require('./lib/connections.js')

// Set the max number of concurrent workers for the multiworker
// and adjust defaultMaxListeners to allow for at least that amount
const MAX_TASK_PROCESSORS = 150
events.EventEmitter.defaultMaxListeners = events.EventEmitter.defaultMaxListeners + MAX_TASK_PROCESSORS

// TweetNaCl.js
// see: http://ed25519.cr.yp.to
// see: https://github.com/dchest/tweetnacl-js#signatures
const nacl = require('tweetnacl')
nacl.util = require('tweetnacl-util')

// Pass SIGNING_SECRET_KEY as Base64 encoded bytes
const signingSecretKeyBytes = nacl.util.decodeBase64(env.SIGNING_SECRET_KEY)
const signingKeypair = nacl.sign.keyPair.fromSecretKey(signingSecretKeyBytes)

let consul = null

// The age of a running job, in miliseconds, for it to be considered stuck/timed out
// This is neccesary to allow resque to determine what is a valid running job, and what
// has been 'stuck' due to service crash/restart. Jobs found in the state are added to the fail queue.
// Workers found with jobs in this state are deleted.
const TASK_TIMEOUT_MS = 60000 // 1 minute timeout

var debug = {
  general: debugPkg('task-handler:general'),
  worker: debugPkg('task-handler:worker'),
  multiworker: debugPkg('task-handler:multiworker')
}
// direct debug to output over STDOUT
debugPkg.log = console.info.bind(console)

// the minimum audit passing Node version for existing registered Nodes, set by consul
let minNodeVersionExisting = null

const cachedProofState = require('./lib/models/cachedProofStateModels.js')
const nodeAuditLog = require('./lib/models/NodeAuditLog.js')
const registeredNode = require('./lib/models/RegisteredNode.js')
const cachedAuditChallenge = require('./lib/models/cachedAuditChallenge.js')

// pull in variables defined in shared database models
let nodeAuditSequelize = nodeAuditLog.sequelize
let NodeAuditLog = nodeAuditLog.NodeAuditLog
let registeredNodeSequelize = registeredNode.sequelize
let Op = nodeAuditSequelize.Op

// The acceptable time difference between Node and Core for a timestamp to be considered valid, in milliseconds
const ACCEPTABLE_DELTA_MS = 5000 // 5 seconds

// The maximum age of a node audit response to accept
const MAX_NODE_RESPONSE_CHALLENGE_AGE_MIN = 75

// The minimum credit balance to receive awards and be publicly advertised
const MIN_PASSING_CREDIT_BALANCE = 10800

// The minimium TNT grains required to operate a Node
const minGrainsBalanceNeeded = env.MIN_TNT_GRAINS_BALANCE_FOR_REWARD

// This value is set once the connection has been established
let redis = null

// The channel used for all amqp communication
// This value is set once the connection has been established
let amqpChannel = null

const pluginOptions = {
  plugins: ['DelayQueueLock', 'QueueLock'],
  pluginOptions: {
    DelayQueueLock: {},
    QueueLock: {}
  }
}
const jobs = {
  // tasks from proof-state service (and task accumulator), bulk deletion of old proof state data
  'prune_agg_states_ids': Object.assign({ perform: pruneAggStatesByIdsAsync }, pluginOptions),
  'prune_cal_states_ids': Object.assign({ perform: pruneCalStatesByIdsAsync }, pluginOptions),
  'prune_anchor_btc_agg_states_ids': Object.assign({ perform: pruneAnchorBTCAggStatesByIdsAsync }, pluginOptions),
  'prune_btctx_states_ids': Object.assign({ perform: pruneBTCTxStatesByIdsAsync }, pluginOptions),
  'prune_btchead_states_ids': Object.assign({ perform: pruneBTCHeadStatesByIdsAsync }, pluginOptions),
  // tasks from the audit producer service
  'audit_public_node': Object.assign({ perform: performAuditPublicAsync }, pluginOptions),
  'audit_private_node': Object.assign({ perform: performAuditPrivateAsync }, pluginOptions),
  'prune_audit_log_ids': Object.assign({ perform: pruneAuditLogsByIdsAsync }, pluginOptions),
  'write_audit_log_items': Object.assign({ perform: writeAuditLogItemsAsync }, pluginOptions),
  'update_audit_score_items': Object.assign({ perform: updateAuditScoreItemsAsync }, pluginOptions),
  // tasks from proof-gen
  'send_to_proof_proxy': Object.assign({ perform: sendToProofProxyAsync }, pluginOptions)
}

// ******************************************************
// tasks from proof-state service (and task accumulator)
// ******************************************************
async function pruneAggStatesByIdsAsync (ids) {
  try {
    let delCount = await cachedProofState.pruneAggStatesByIdsAsync(ids)
    return `Deleted ${delCount} rows from agg_states with ids ${ids[0]}...`
  } catch (error) {
    let errorMessage = `Could not delete rows from agg_states  with ids ${ids[0]}... : ${error.message}`
    throw errorMessage
  }
}

async function pruneCalStatesByIdsAsync (ids) {
  try {
    let delCount = await cachedProofState.pruneCalStatesByIdsAsync(ids)
    return `Deleted ${delCount} rows from cal_states with ids ${ids[0]}...`
  } catch (error) {
    let errorMessage = `Could not delete rows from cal_states with ids ${ids[0]}... : ${error.message}`
    throw errorMessage
  }
}

async function pruneAnchorBTCAggStatesByIdsAsync (ids) {
  try {
    let delCount = await cachedProofState.pruneAnchorBTCAggStatesByIdsAsync(ids)
    return `Deleted ${delCount} rows from anchor_btc_agg_states with ids ${ids[0]}...`
  } catch (error) {
    let errorMessage = `Could not delete rows from anchor_btc_agg_states with ids ${ids[0]}... : ${error.message}`
    throw errorMessage
  }
}

async function pruneBTCTxStatesByIdsAsync (ids) {
  try {
    let delCount = await cachedProofState.pruneBTCTxStatesByIdsAsync(ids)
    return `Deleted ${delCount} rows from btctx_states with ids ${ids[0]}...`
  } catch (error) {
    let errorMessage = `Could not delete rows from btctx_states with ids ${ids[0]}... : ${error.message}`
    throw errorMessage
  }
}

async function pruneBTCHeadStatesByIdsAsync (ids) {
  try {
    let delCount = await cachedProofState.pruneBTCHeadStatesByIdsAsync(ids)
    return `Deleted ${delCount} rows from btchead_states with ids ${ids[0]}...`
  } catch (error) {
    let errorMessage = `Could not delete rows from btchead_states with ids ${ids[0]}... : ${error.message}`
    throw errorMessage
  }
}

// ******************************************************
// tasks from the audit producer service
// ******************************************************

async function performAuditPublicAsync (nodeData, activeNodeCount) {
  let tntAddr = nodeData.tnt_addr
  let publicUri = nodeData.public_uri
  let currentCreditBalance = nodeData.tnt_credit

  let publicIPPass = false
  let nodeMSDelta = null
  let timePass = false
  let calStatePass = false
  let minCreditsPass = false
  let nodeVersion = null
  let nodeVersionPass = false
  let tntBalanceGrains = null
  let tntBalancePass = false

  try {
    tntBalanceGrains = await getTNTBalance(tntAddr)
    tntBalancePass = tntBalanceGrains >= minGrainsBalanceNeeded
  } catch (error) {
    console.error(`performAuditPublicAsync : getTNTBalance : Unable to query for TNT balance for ${tntAddr} : ${error.message}`)
  }

  // perform the minimum credit check
  minCreditsPass = (currentCreditBalance >= MIN_PASSING_CREDIT_BALANCE)

  // if there is no public_uri set for this Node, fail all remaining audit tests and continue to the next
  if (!publicUri) {
    await addAuditToLogAsync(tntAddr, null, Date.now(), publicIPPass, nodeMSDelta, timePass, calStatePass, minCreditsPass, nodeVersion, nodeVersionPass, tntBalanceGrains, tntBalancePass)
    return `performAuditAsync : no publicUri defined for address ${tntAddr}`
  }

  // build the data object containing Node data and last audit data to be sent to
  // the Node in the process of executing an audit on that Node
  // this will be set to NULL if there is no audit history to deliver
  let nodeDataPackage = buildNodeDataPackage(nodeData, activeNodeCount)

  let configResultsBody
  let configResultTime
  try {
    await retry(async bail => {
      configResultsBody = await getNodeConfigObjectAsync(publicUri, nodeDataPackage)
      configResultTime = Date.now()
    }, {
      retries: 3, // The maximum amount of times to retry the operation. Default is 10
      factor: 2, // The exponential factor to use. Default is 2
      minTimeout: 500, // The number of milliseconds before starting the first retry. Default is 1000
      maxTimeout: 5000,
      randomize: false
    })
  } catch (error) {
    let resultText = `getNodeConfigObjectAsync : GET failed for ${publicUri}: ${error.message}`
    if (error.statusCode) resultText = `getNodeConfigObjectAsync : GET failed with status code ${error.statusCode} for ${publicUri}: ${error.message}`
    await addAuditToLogAsync(tntAddr, publicUri, Date.now(), publicIPPass, nodeMSDelta, timePass, calStatePass, minCreditsPass, nodeVersion, nodeVersionPass, tntBalanceGrains, tntBalancePass)
    return resultText
  }

  if (!configResultsBody) {
    await addAuditToLogAsync(tntAddr, publicUri, configResultTime, publicIPPass, nodeMSDelta, timePass, calStatePass, minCreditsPass, nodeVersion, nodeVersionPass, tntBalanceGrains, tntBalancePass)
    return `getNodeConfigObjectAsync : GET failed with empty result for ${publicUri}`
  }
  if (!configResultsBody.calendar) {
    await addAuditToLogAsync(tntAddr, publicUri, configResultTime, publicIPPass, nodeMSDelta, timePass, calStatePass, minCreditsPass, nodeVersion, nodeVersionPass, tntBalanceGrains, tntBalancePass)
    return `getNodeConfigObjectAsync : GET failed with missing calendar data for ${publicUri}`
  }
  if (!configResultsBody.time) {
    await addAuditToLogAsync(tntAddr, publicUri, configResultTime, publicIPPass, nodeMSDelta, timePass, calStatePass, minCreditsPass, nodeVersion, nodeVersionPass, tntBalanceGrains, tntBalancePass)
    return `getNodeConfigObjectAsync : GET failed with missing time for ${publicUri}`
  }
  if (!configResultsBody.version) {
    await addAuditToLogAsync(tntAddr, publicUri, configResultTime, publicIPPass, nodeMSDelta, timePass, calStatePass, minCreditsPass, nodeVersion, nodeVersionPass, tntBalanceGrains, tntBalancePass)
    return `getNodeConfigObjectAsync : GET failed with missing version for ${publicUri}`
  }

  // We've gotten this far, so at least auditedPublicIPAt has passed
  publicIPPass = true

  // check if the Node timestamp is withing the acceptable range
  let nodeAuditTimestamp = Date.parse(configResultsBody.time)
  nodeMSDelta = (nodeAuditTimestamp - configResultTime)
  if (Math.abs(nodeMSDelta) <= ACCEPTABLE_DELTA_MS) {
    timePass = true
  }

  // When a node first comes online, and is still syncing the calendar
  // data, it will not have yet generated the challenge response, and
  // audit_response will be null. In these cases, simply fail the calStatePass
  // audit. If audit_response is not null, verify the cal state for the Node
  if (configResultsBody.calendar.audit_response && configResultsBody.calendar.audit_response !== 'null') {
    let nodeAuditResponse = configResultsBody.calendar.audit_response.split(':')
    let nodeAuditResponseTimestamp = parseInt(nodeAuditResponse[0])
    let nodeAuditResponseSolution = nodeAuditResponse[1]

    // make sure the audit reponse is newer than MAX_CHALLENGE_AGE_MINUTES
    let coreAuditChallenge = null
    let minTimestamp = configResultTime - (MAX_NODE_RESPONSE_CHALLENGE_AGE_MIN * 60 * 1000)
    if (nodeAuditResponseTimestamp >= minTimestamp) {
      try {
        coreAuditChallenge = await cachedAuditChallenge.getChallengeDataByTimeAsync(nodeAuditResponseTimestamp)
      } catch (error) {
        console.error(`getChallengeDataByTimeAsync : Could not query for audit challenge: ${nodeAuditResponseTimestamp}`)
      }

      // check if the Node challenge solution is correct
      if (coreAuditChallenge) {
        let coreAuditChallengeSolution = coreAuditChallenge.split(':')[4].toString()
        let coreChallengeSolution = nacl.util.decodeUTF8(coreAuditChallengeSolution)
        nodeAuditResponseSolution = nacl.util.decodeUTF8(nodeAuditResponseSolution)

        if (nacl.verify(nodeAuditResponseSolution, coreChallengeSolution)) {
          calStatePass = true
        }
      } else {
        console.error(`getChallengeDataByTimeAsync : No audit challenge record found: ${configResultsBody.calendar.audit_response} | ${configResultTime}, ${minTimestamp}`)
      }
    }
  }

  // check if the Node version is acceptable, catch error if version value is invalid
  nodeVersion = configResultsBody.version
  try {
    nodeVersionPass = semver.satisfies(nodeVersion, `>=${minNodeVersionExisting}`)
  } catch (error) {
    nodeVersionPass = false
  }

  await addAuditToLogAsync(tntAddr, publicUri, configResultTime, publicIPPass, nodeMSDelta, timePass, calStatePass, minCreditsPass, nodeVersion, nodeVersionPass, tntBalanceGrains, tntBalancePass)

  return `Public Audit complete for ${tntAddr} at ${publicUri} : Pass = ${publicIPPass && timePass && calStatePass && minCreditsPass && nodeVersionPass && tntBalancePass}`
}

async function performAuditPrivateAsync (nodeData) {
  let tntAddr = nodeData.tnt_addr
  let publicUri = null

  let publicIPPass = false
  let nodeMSDelta = null
  let timePass = false
  let calStatePass = false
  let minCreditsPass = false
  let nodeVersion = null
  let nodeVersionPass = false
  let tntBalanceGrains = null
  let tntBalancePass = false

  try {
    tntBalanceGrains = await getTNTBalance(tntAddr)
    tntBalancePass = tntBalanceGrains >= minGrainsBalanceNeeded
  } catch (error) {
    console.error(`performAuditPrivateAsync : getTNTBalance : Unable to query for TNT balance for ${tntAddr} : ${error.message}`)
  }

  await addAuditToLogAsync(tntAddr, publicUri, Date.now(), publicIPPass, nodeMSDelta, timePass, calStatePass, minCreditsPass, nodeVersion, nodeVersionPass, tntBalanceGrains, tntBalancePass)

  return `Private Audit complete for ${tntAddr} : Balance = ${tntBalanceGrains} TNT grains, Pass = ${tntBalancePass ? 'True' : 'False'}`
}

async function pruneAuditLogsByIdsAsync (ids) {
  try {
    let delCount = await NodeAuditLog.destroy({ where: { id: { [Op.in]: ids } } })
    return `Deleted ${delCount} rows from chainpoint_node_audit_log with ids ${ids[0]}...`
  } catch (error) {
    let errorMessage = `Could not delete rows from chainpoint_node_audit_log with ids ${ids[0]}... : ${error.message}`
    throw errorMessage
  }
}

async function writeAuditLogItemsAsync (auditDataJSON) {
  // auditDataJSON is an array of JSON strings, convert to array of objects
  let auditDataItems = auditDataJSON.map((item) => { return JSON.parse(item) })
  try {
    await retry(async bail => {
      await NodeAuditLog.bulkCreate(auditDataItems)
    }, {
      retries: 5, // The maximum amount of times to retry the operation. Default is 10
      factor: 1, // The exponential factor to use. Default is 2
      minTimeout: 200, // The number of milliseconds before starting the first retry. Default is 1000
      maxTimeout: 400,
      randomize: true
    })
    return `Inserted ${auditDataItems.length} rows into chainpoint_node_audit_log with tntAddrs ${auditDataItems[0].tntAddr}...`
  } catch (error) {
    let errorMessage = `writeAuditLogItemsAsync : bulk write error : ${error.message}`
    throw errorMessage
  }
}

async function updateAuditScoreItemsAsync (scoreUpdatesJSON) {
  // scoreUpdatesJSON is an array of JSON strings, convert to array of objects
  let scoreUpdateItems = scoreUpdatesJSON.map((item) => { return JSON.parse(item) })
  try {
    // This should never actually result in an INSERT operation because the TNT address we intend to update
    // was retrieved from the database already in order to generate that update. This should only update
    // existing records. Doing these updates in this manner allows for the efficient batching of update calls.
    // While an INSERT should never happen, the dummy hmac_key used in the operation is sha256(random()::text)
    // instead of a static string so that it will not be predictable. This is to prevent the very unlikely scenario
    // where an INSERT actually occurs, and the hmac key is known because it is in the code, potentially creating
    // a security risk.
    await retry(async bail => {
      let sqlCmd = `INSERT INTO chainpoint_registered_nodes (tnt_addr, hmac_key, created_at, updated_at, audit_score, pass_count, fail_count, consecutive_passes, consecutive_fails) VALUES `
      sqlCmd += scoreUpdateItems.map((item) => {
        let scoreAddend = item.auditPass ? 1 : -1
        let passAddend = item.auditPass ? 1 : 0
        let failAddend = item.auditPass ? 0 : 1
        let consecPassAddend = item.auditPass ? 1 : 0
        let consecFailAddend = item.auditPass ? 0 : 1
        return `('${item.tntAddr}', sha256(random()::text), now(), now(), ${scoreAddend}, ${passAddend}, ${failAddend}, ${consecPassAddend}, ${consecFailAddend})`
      }).join() + ' '
      sqlCmd += `ON CONFLICT (tnt_addr) DO UPDATE SET (audit_score, pass_count, fail_count, consecutive_passes, consecutive_fails) = 
      (GREATEST(chainpoint_registered_nodes.audit_score + EXCLUDED.audit_score, 0), 
      chainpoint_registered_nodes.pass_count + EXCLUDED.pass_count, 
      chainpoint_registered_nodes.fail_count + EXCLUDED.fail_count, 
      CASE WHEN EXCLUDED.consecutive_passes > 0 THEN chainpoint_registered_nodes.consecutive_passes + EXCLUDED.consecutive_passes ELSE 0 END,
      CASE WHEN EXCLUDED.consecutive_fails > 0 THEN chainpoint_registered_nodes.consecutive_fails + EXCLUDED.consecutive_fails ELSE 0 END)`
      await registeredNodeSequelize.query(sqlCmd, { type: registeredNodeSequelize.QueryTypes.UPDATE })
    }, {
      retries: 5, // The maximum amount of times to retry the operation. Default is 10
      factor: 1, // The exponential factor to use. Default is 2
      minTimeout: 200, // The number of milliseconds before starting the first retry. Default is 1000
      maxTimeout: 400,
      randomize: true
    })
    return `Updated ${scoreUpdateItems.length} audit scores in chainpoint_registered_nodes with tntAddrs ${scoreUpdateItems[0].tntAddr}...`
  } catch (error) {
    let errorMessage = `updateAuditScoreItemsAsync : bulk update error : ${error.message}`
    throw errorMessage
  }
}

// ******************************************************
// tasks from the proof gen service
// ******************************************************
async function chainpointMonitorCoreProofPollerAsync (hashIdCore, opts = {}) {
  try {
    let options = Object.assign({
      headers: {},
      method: 'POST',
      uri: env.CORE_PROOF_POLLER_URL,
      body: { hash_id_core: hashIdCore },
      json: true,
      gzip: true,
      timeout: 300000
    }, opts)
    // Fire and forget the POST to Cloud Function - chainpoint-monitor-coreproof-poller
    // If the core proof was not persisted to Google Storage, a log entry will be created, and its associated Log Sink
    // will write to a bucket which will then invoke an ETL Cloud Function
    await rp(options)
  } catch (_) { } // Supress any errors thrown by the fire-and-forget call to chainpoint-monitor-coreproof-poller cloud function
}

async function sendToProofProxyAsync (hashIdCore, proofBase64) {
  try {
    await retry(async bail => {
      await proofProxyPostAsync(hashIdCore, proofBase64)
    }, {
      retries: 12, // max retries with default exponential factor of 2
      randomize: true // Randomizes the timeouts by multiplying with a factor between 1 to 2.
    })

    // Submit hashIdCore to Google Cloud Function to verify that
    // the core proof has been persisted to Google Storage
    chainpointMonitorCoreProofPollerAsync(hashIdCore)

    return `Core proof sent to proof proxy : ${hashIdCore}`
  } catch (error) {
    await chainpointMonitorCoreProofPollerAsync(hashIdCore, { timeout: 2000 })
    let errorMessage = `sendToProofProxyAsync : send error : ${error.message}`
    throw errorMessage
  }
}

// ****************************************************
// support functions for all tasks
// ****************************************************

function buildNodeDataPackage (nodeData, activeNodeCount) {
  // if there is no audit history, return NULL
  if (nodeData.audit_at === null) return null

  let auditPassed = nodeData.public_ip_pass &&
    nodeData.time_pass &&
    nodeData.cal_state_pass &&
    nodeData.min_credits_pass &&
    nodeData.node_version_pass &&
    nodeData.tnt_balance_pass

  let auditAt = isNaN(parseInt(nodeData.audit_at)) ? null : parseInt(nodeData.audit_at)
  let nodeMSDelta = isNaN(parseInt(nodeData.node_ms_delta)) ? null : parseInt(nodeData.node_ms_delta)
  let tntBalanceGrains = isNaN(parseInt(nodeData.tnt_balance_grains)) ? null : parseInt(nodeData.tnt_balance_grains)
  let passCount = isNaN(parseInt(nodeData.pass_count)) ? null : parseInt(nodeData.pass_count)
  let failCount = isNaN(parseInt(nodeData.fail_count)) ? null : parseInt(nodeData.fail_count)
  let consecutivePassCount = isNaN(parseInt(nodeData.consecutive_passes)) ? null : parseInt(nodeData.consecutive_passes)
  let consecutiveFailCount = isNaN(parseInt(nodeData.consecutive_fails)) ? null : parseInt(nodeData.consecutive_fails)
  let createdAt = isNaN(Date.parse(nodeData.created_at)) ? null : Date.parse(nodeData.created_at)
  let updatedAt = isNaN(Date.parse(nodeData.updated_at)) ? null : Date.parse(nodeData.updated_at)

  let result =
    {
      data: {
        audits: [{
          audit_at: auditAt,
          audit_passed: auditPassed,
          public_ip_pass: nodeData.public_ip_pass,
          public_uri: nodeData.audit_uri,
          node_ms_delta: nodeMSDelta,
          time_pass: nodeData.time_pass,
          cal_state_pass: nodeData.cal_state_pass,
          min_credits_pass: nodeData.min_credits_pass,
          node_version: nodeData.node_version,
          node_version_pass: nodeData.node_version_pass,
          tnt_balance_grains: tntBalanceGrains,
          tnt_balance_pass: nodeData.tnt_balance_pass
        }],
        core: {
          total_active_nodes: activeNodeCount
        },
        node: {
          tnt_addr: nodeData.tnt_addr,
          created_at: createdAt,
          updated_at: updatedAt,
          pass_count: passCount,
          fail_count: failCount,
          consecutive_passes: consecutivePassCount,
          consecutive_fails: consecutiveFailCount
        }
      }
    }

  let dataHashHex = objectHash(result.data)
  let signingPubKeyHashHex = crypto.createHash('sha256').update(signingKeypair.publicKey).digest('hex')

  result.sig = [signingPubKeyHashHex.slice(0, 12), calcSigB64(dataHashHex)].join(':')

  return result
}

// Calculate a base64 encoded signature over the provided hex string
function calcSigB64 (hexData) {
  return nacl.util.encodeBase64(nacl.sign.detached(nacl.util.decodeUTF8(hexData), signingKeypair.secretKey))
}

async function getNodeConfigObjectAsync (publicUri, nodeDataPackage) {
  // perform the /config checks for the Node
  let nodeResponse
  let options = {
    method: 'GET',
    uri: `${publicUri}/config`,
    json: true,
    gzip: true,
    timeout: 2500,
    resolveWithFullResponse: true
  }

  // Include audit history data package if one is provided
  if (nodeDataPackage !== null) {
    let dataStr = JSON.stringify(nodeDataPackage)
    let dataB64 = Buffer.from(dataStr, 'utf8').toString('base64')
    options.headers = { 'data': dataB64 }
  }

  nodeResponse = await rp(options)
  return nodeResponse.body
}

async function addAuditToLogAsync (tntAddr, publicUri, auditTime, publicIPPass, nodeMSDelta, timePass, calStatePass, minCreditsPass, nodeVersion, nodeVersionPass, tntBalanceGrains, tntBalancePass) {
  try {
    let auditData = {
      tntAddr: tntAddr,
      publicUri: publicUri,
      auditAt: auditTime,
      publicIPPass: publicIPPass,
      nodeMSDelta: nodeMSDelta,
      timePass: timePass,
      calStatePass: calStatePass,
      minCreditsPass: minCreditsPass,
      nodeVersion: nodeVersion,
      nodeVersionPass: nodeVersionPass,
      tntBalanceGrains: tntBalanceGrains,
      tntBalancePass: tntBalancePass
    }
    // send audit log result to accumulator to be inserted as part of an audit log insert batch
    await amqpChannel.sendToQueue(env.RMQ_WORK_OUT_TASK_ACC_QUEUE, Buffer.from(JSON.stringify(auditData)), { persistent: true, type: 'write_audit_log' })
  } catch (error) {
    let errorMessage = `${env.RMQ_WORK_OUT_TASK_ACC_QUEUE} [write_audit_log] publish message nacked`
    throw errorMessage
  }

  try {
    let auditPass = publicIPPass && timePass && calStatePass && minCreditsPass && nodeVersionPass && tntBalancePass
    let scoreUpdate = {
      tntAddr: tntAddr,
      auditPass: auditPass
    }
    // send node audit score value update to accumulator to be updated as part of a node audit score update batch
    await amqpChannel.sendToQueue(env.RMQ_WORK_OUT_TASK_ACC_QUEUE, Buffer.from(JSON.stringify(scoreUpdate)), { persistent: true, type: 'update_node_audit_score' })
  } catch (error) {
    let errorMessage = `${env.RMQ_WORK_OUT_TASK_ACC_QUEUE} [update_node_audit_score] publish message nacked`
    throw errorMessage
  }
}

async function proofProxyPostAsync (hashIdCore, proofBase64) {
  let nodeResponse

  let options = {
    headers: {},
    method: 'POST',
    uri: `https://proofs.chainpoint.org/proofs`,
    body: [[hashIdCore, proofBase64]],
    json: true,
    gzip: true,
    timeout: 30 * 1000, // 30sec
    resolveWithFullResponse: true
  }

  // send 'core' header to ensure that the proof is stored in the
  // short lifetime core proofs bucket.
  options.headers['core'] = 'true'

  nodeResponse = await rp(options)
  return nodeResponse.body
}

async function getTNTBalance (tntAddress) {
  let options = {
    method: 'GET',
    uri: `${env.ETH_TNT_TX_CONNECT_URI}/balance/${tntAddress}`,
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

// ****************************************************
// startup / syncing functions
// ****************************************************

/**
 * Opens a storage connection
 **/
async function openStorageConnectionAsync () {
  let modelSqlzArray = [
    registeredNodeSequelize,
    nodeAuditSequelize,
    cachedAuditChallenge.getAuditChallengeSequelize()
  ]
  await connections.openStorageConnectionAsync(modelSqlzArray, debug)
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
      cachedAuditChallenge.setRedis(redis)
      initResqueWorkerAsync()
    }, () => {
      redis = null
      cachedAuditChallenge.setRedis(null)
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
    [env.RMQ_WORK_OUT_TASK_ACC_QUEUE],
    null,
    null,
    (chan) => { amqpChannel = chan },
    () => {
      amqpChannel = null
      setTimeout(() => { openRMQConnectionAsync(connectURI) }, 5000)
    },
    debug
  )
}

async function initResqueWorkerAsync () {
  await connections.initResqueWorkerAsync(
    redis,
    'resque',
    ['task-handler-queue'],
    10,
    MAX_TASK_PROCESSORS,
    TASK_TIMEOUT_MS,
    jobs,
    (multiWorker) => {
      multiWorker.on('start', (workerId) => { debug.worker(`worker[${workerId}] : started`) })
      multiWorker.on('end', (workerId) => { debug.worker(`worker[${workerId}] : ended`) })
      multiWorker.on('cleaning_worker', (workerId, worker, pid) => { debug.worker(`worker[${workerId}] : cleaning old worker : ${worker}`) })
      // multiWorker.on('poll', (workerId, queue) => { debug.worker(`worker[${workerId}] : polling : ${queue}`) })
      // multiWorker.on('job', (workerId, queue, job) => { debug.worker(`worker[${workerId}] : working job : ${queue} : ${JSON.stringify(job)}`) })
      multiWorker.on('reEnqueue', (workerId, queue, job, plugin) => { debug.worker(`worker[${workerId}] : re-enqueuing job : ${queue} : ${JSON.stringify(job)}`) })
      multiWorker.on('success', (workerId, queue, job, result) => { debug.worker(`worker[${workerId}] : success : ${queue} : ${result}`) })
      multiWorker.on('failure', (workerId, queue, job, failure) => { console.error(`worker[${workerId}] : failure : ${queue} : ${failure}`) })
      multiWorker.on('error', (workerId, queue, job, error) => { console.error(`worker[${workerId}] : error : ${queue} : ${error}`) })
      // multiWorker.on('pause', (workerId) => { debug.worker(`worker[${workerId}] : paused`) })
      multiWorker.on('internalError', (error) => { console.error(`multiWorker : internal error : ${error}`) })
      // multiWorker.on('multiWorkerAction', (verb, delay) => { debug.multiworker(`*** checked for worker status : ${verb} : event loop delay : ${delay}ms)`) })
    },
    debug
  )
}

// This initalizes all the consul watches
function startConsulWatches () {
  let watches = [{
    key: env.MIN_NODE_VERSION_EXISTING_KEY,
    onChange: (data, res) => {
      // process only if a value has been returned
      if (data && data.Value) {
        minNodeVersionExisting = data.Value
      }
    },
    onError: null
  }]
  connections.startConsulWatches(consul, watches, null, debug)
}

// process all steps need to start the application
async function start () {
  try {
    // init consul
    consul = connections.initConsul(cnsl, env.CONSUL_HOST, env.CONSUL_PORT, debug)
    // init DB
    await openStorageConnectionAsync()
    // init Redis
    openRedisConnection(env.REDIS_CONNECT_URIS)
    // init RabbitMQ
    await openRMQConnectionAsync(env.RABBITMQ_CONNECT_URI)
    // init Resque worker
    await initResqueWorkerAsync()
    // init consul watches
    startConsulWatches()
    debug.general('startup completed successfully')
  } catch (error) {
    console.error(`An error has occurred on startup: ${error.message}`)
    process.exit(1)
  }
}

// get the whole show started
start()
