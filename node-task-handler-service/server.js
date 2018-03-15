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

const r = require('redis')
const nodeResque = require('node-resque')
const utils = require('./lib/utils.js')
const exitHook = require('exit-hook')
const { URL } = require('url')
const debugPkg = require('debug')
const semver = require('semver')
const retry = require('async-retry')
const bluebird = require('bluebird')
const rp = require('request-promise-native')

// TweetNaCl.js
// see: http://ed25519.cr.yp.to
// see: https://github.com/dchest/tweetnacl-js#signatures
const nacl = require('tweetnacl')
nacl.util = require('tweetnacl-util')

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

const cachedProofState = require('./lib/models/cachedProofStateModels.js')
const nodeAuditLog = require('./lib/models/NodeAuditLog.js')
const cachedAuditChallenge = require('./lib/models/cachedAuditChallenge.js')

// pull in variables defined in shared database models
let nodeAuditSequelize = nodeAuditLog.sequelize
let NodeAuditLog = nodeAuditLog.NodeAuditLog
let Op = nodeAuditSequelize.Op

// The acceptable time difference between Node and Core for a timestamp to be considered valid, in milliseconds
const ACCEPTABLE_DELTA_MS = 5000 // 5 seconds

// The maximum age of a node audit response to accept
const MAX_NODE_RESPONSE_CHALLENGE_AGE_MIN = 75

// The minimum credit balance to receive awards and be publicly advertised
const MIN_PASSING_CREDIT_BALANCE = 10800

// This value is set once the connection has been established
let redis = null

const pluginOptions = {
  plugins: ['DelayQueueLock', 'QueueLock'],
  pluginOptions: {
    DelayQueueLock: {},
    QueueLock: {}
  }
}
const jobs = {
  // tasks from proof-state service (and prune accumulator), bulk deletion of old proof state data
  'prune_agg_states_ids': Object.assign({ perform: pruneAggStatesByIdsAsync }, pluginOptions),
  'prune_cal_states_ids': Object.assign({ perform: pruneCalStatesByIdsAsync }, pluginOptions),
  'prune_anchor_btc_agg_states_ids': Object.assign({ perform: pruneAnchorBTCAggStatesByIdsAsync }, pluginOptions),
  'prune_btctx_states_ids': Object.assign({ perform: pruneBTCTxStatesByIdsAsync }, pluginOptions),
  'prune_btchead_states_ids': Object.assign({ perform: pruneBTCHeadStatesByIdsAsync }, pluginOptions),
  // tasks from the audit producer service
  'audit_node': Object.assign({ perform: performAuditAsync }, pluginOptions),
  'prune_audit_log_ids': Object.assign({ perform: pruneAuditLogsByIdsAsync }, pluginOptions)
}

// ******************************************************
// tasks from proof-state service (and prune accumulator)
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

async function performAuditAsync (tntAddr, publicUri, currentCreditBalance) {
  let publicIPPass = false
  let nodeMSDelta = null
  let timePass = false
  let calStatePass = false
  let minCreditsPass = false
  let nodeVersion = null
  let nodeVersionPass = false

  // perform the minimum credit check
  minCreditsPass = (currentCreditBalance >= MIN_PASSING_CREDIT_BALANCE)

  // if there is no public_uri set for this Node, fail all remaining audit tests and continue to the next
  if (!publicUri) {
    await addAuditToLogAsync(tntAddr, null, Date.now(), publicIPPass, nodeMSDelta, timePass, calStatePass, minCreditsPass, nodeVersion, nodeVersionPass)
    return `performAuditAsync : no publicUri defined for address ${tntAddr}`
  }

  let configResultsBody
  let configResultTime
  try {
    configResultsBody = await getNodeConfigObjectAsync(publicUri)
    configResultTime = Date.now()
  } catch (error) {
    let resultText = `getNodeConfigObjectAsync : GET failed for ${publicUri}: ${error.message}`
    if (error.statusCode) resultText = `getNodeConfigObjectAsync : GET failed with status code ${error.statusCode} for ${publicUri}: ${error.message}`
    await addAuditToLogAsync(tntAddr, publicUri, Date.now(), publicIPPass, nodeMSDelta, timePass, calStatePass, minCreditsPass, nodeVersion, nodeVersionPass)
    return resultText
  }

  if (!configResultsBody) {
    await addAuditToLogAsync(tntAddr, publicUri, configResultTime, publicIPPass, nodeMSDelta, timePass, calStatePass, minCreditsPass, nodeVersion, nodeVersionPass)
    return `getNodeConfigObjectAsync : GET failed with empty result for ${publicUri}`
  }
  if (!configResultsBody.calendar) {
    await addAuditToLogAsync(tntAddr, publicUri, configResultTime, publicIPPass, nodeMSDelta, timePass, calStatePass, minCreditsPass, nodeVersion, nodeVersionPass)
    return `getNodeConfigObjectAsync : GET failed with missing calendar data for ${publicUri}`
  }
  if (!configResultsBody.time) {
    await addAuditToLogAsync(tntAddr, publicUri, configResultTime, publicIPPass, nodeMSDelta, timePass, calStatePass, minCreditsPass, nodeVersion, nodeVersionPass)
    return `getNodeConfigObjectAsync : GET failed with missing time for ${publicUri}`
  }
  if (!configResultsBody.version) {
    await addAuditToLogAsync(tntAddr, publicUri, configResultTime, publicIPPass, nodeMSDelta, timePass, calStatePass, minCreditsPass, nodeVersion, nodeVersionPass)
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
    nodeVersionPass = semver.satisfies(nodeVersion, `>=${env.MIN_NODE_VERSION_EXISTING}`)
  } catch (error) {
    nodeVersionPass = false
  }

  await addAuditToLogAsync(tntAddr, publicUri, configResultTime, publicIPPass, nodeMSDelta, timePass, calStatePass, minCreditsPass, nodeVersion, nodeVersionPass)

  let results = {}
  results.auditAt = configResultTime
  results.publicIPPass = publicIPPass
  results.timePass = timePass
  results.calStatePass = calStatePass
  results.minCreditsPass = minCreditsPass
  results.nodeVersionPass = nodeVersionPass

  return `Audit complete for ${tntAddr} at ${publicUri} : Pass = ${publicIPPass && timePass && calStatePass && minCreditsPass && nodeVersionPass}`
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

// ****************************************************
// support functions for all tasks
// ****************************************************

async function getNodeConfigObjectAsync (publicUri) {
  // perform the /config checks for the Node
  let nodeResponse
  let options = {
    headers: [
      {
        name: 'Content-Type',
        value: 'application/json'
      }
    ],
    method: 'GET',
    uri: `${publicUri}/config`,
    json: true,
    gzip: true,
    timeout: 2500,
    resolveWithFullResponse: true
  }

  nodeResponse = await rp(options)
  return nodeResponse.body
}

async function addAuditToLogAsync (tntAddr, publicUri, auditTime, publicIPPass, nodeMSDelta, timePass, calStatePass, minCreditsPass, nodeVersion, nodeVersionPass) {
  try {
    await retry(async bail => {
      await NodeAuditLog.create({
        tntAddr: tntAddr,
        publicUri: publicUri,
        auditAt: auditTime,
        publicIPPass: publicIPPass,
        nodeMSDelta: nodeMSDelta,
        timePass: timePass,
        calStatePass: calStatePass,
        minCreditsPass: minCreditsPass,
        nodeVersion: nodeVersion,
        nodeVersionPass: nodeVersionPass
      })
    }, {
      retries: 5,    // The maximum amount of times to retry the operation. Default is 10
      factor: 1,       // The exponential factor to use. Default is 2
      minTimeout: 200,   // The number of milliseconds before starting the first retry. Default is 1000
      maxTimeout: 400,
      randomize: true
    })
  } catch (error) {
    let errorMessage = `addAuditToLogAsync : write error : ${tntAddr} : ${error.message}`
    throw errorMessage
  }
}

// ****************************************************
// startup / syncing functions
// ****************************************************

/**
 * Opens a storage connection
 **/
async function openStorageConnectionAsync () {
  let dbConnected = false
  while (!dbConnected) {
    try {
      await nodeAuditSequelize.sync({ logging: false })
      await cachedAuditChallenge.getAuditChallengeSequelize().sync({ logging: false })
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
  redis.on('ready', async () => {
    bluebird.promisifyAll(redis)
    cachedAuditChallenge.setRedis(redis)
    debug.general('Redis connection established')
  })
  redis.on('error', async (err) => {
    console.error(`A redis error has ocurred: ${err}`)
    redis.quit()
    redis = null
    cachedAuditChallenge.setRedis(null)
    console.error('Cannot establish Redis connection. Attempting in 5 seconds...')
    await utils.sleep(5000)
    openRedisConnection(redisURI)
  })
}

async function cleanUpWorkersAndRequequeJobsAsync (connectionDetails) {
  const queue = new nodeResque.Queue({ connection: connectionDetails })
  await queue.connect()
  // Delete stuck workers and move their stuck job to the failed queue
  await queue.cleanOldWorkers(TASK_TIMEOUT_MS)
  // Get the count of jobs in the failed queue
  let failedCount = await queue.failedCount()
  // Retrieve failed jobs in batches of 100
  // First, determine the batch ranges to retrieve
  let batchSize = 100
  let failedBatches = []
  for (let x = 0; x < failedCount; x += batchSize) {
    failedBatches.push({ start: x, end: x + batchSize - 1 })
  }
  // Retrieve the failed jobs for each batch and collect in 'failedJobs' array
  let failedJobs = []
  for (let x = 0; x < failedBatches.length; x++) {
    let failedJobSet = await queue.failed(failedBatches[x].start, failedBatches[x].end)
    failedJobs = failedJobs.concat(failedJobSet)
  }
  // For each job, remove the job from the failed queue and requeue to its original queue
  for (let x = 0; x < failedJobs.length; x++) {
    debug.worker(`Requeuing job: ${failedJobs[x].payload.queue} : ${failedJobs[x].payload.class} : ${failedJobs[x].error}`)
    await queue.retryAndRemoveFailed(failedJobs[x])
  }
}

async function initResqueWorkerAsync () {
  let redisReady = (redis !== null)
  while (!redisReady) {
    await utils.sleep(100)
    redisReady = (redis !== null)
  }

  const redisURI = new URL(env.REDIS_CONNECT_URI)
  const connectionDetails = {
    host: redisURI.hostname,
    port: redisURI.port,
    namespace: 'resque'
  }
  var multiWorkerConfig = {
    connection: connectionDetails,
    queues: ['task-handler-queue'],
    minTaskProcessors: 10,
    maxTaskProcessors: 100
  }

  await cleanUpWorkersAndRequequeJobsAsync(connectionDetails)

  const multiWorker = new nodeResque.MultiWorker(multiWorkerConfig, jobs)

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
  multiWorker.on('internalError', (error) => { console.error(`multiWorker : intneral error : ${error}`) })
  // multiWorker.on('multiWorkerAction', (verb, delay) => { debug.multiworker(`*** checked for worker status : ${verb} : event loop delay : ${delay}ms)`) })

  multiWorker.start()

  exitHook(async () => {
    await multiWorker.end()
  })

  debug.general('Resque worker connection established')
}

// process all steps need to start the application
async function start () {
  try {
    // init DB
    await openStorageConnectionAsync()
    // init Redis
    openRedisConnection(env.REDIS_CONNECT_URI)
    // init Resque worker
    await initResqueWorkerAsync()
    debug.general('startup completed successfully')
  } catch (error) {
    console.error(`An error has occurred on startup: ${error.message}`)
    process.exit(1)
  }
}

// get the whole show started
start()
