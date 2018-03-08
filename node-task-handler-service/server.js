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
const env = require('./lib/parse-env.js')('task-handler')

const r = require('redis')
const nodeResque = require('node-resque')
const utils = require('./lib/utils.js')
const exitHook = require('exit-hook')
const { URL } = require('url')

const cachedProofState = require('./lib/models/cachedProofStateModels.js')

// This value is set once the connection has been established
let redis = null

const jobs = {
  'prune_agg_states': {
    perform: pruneAggStatesRangeAsync
  },
  'prune_cal_states': {
    perform: pruneCalStatesRangeAsync
  },
  'prune_anchor_btc_agg_states': {
    perform: pruneAnchorBTCAggStatesRangeAsync
  },
  'prune_btctx_states': {
    perform: pruneBTCTxStatesRangeAsync
  },
  'prune_btchead_states': {
    perform: pruneBTCHeadStatesRangeAsync
  }
}

async function pruneAggStatesRangeAsync (startTime, endTime) {
  try {
    let delCount = await cachedProofState.pruneAggStatesRangeAsync(startTime, endTime)
    return `Deleted ${delCount} rows from agg_states between ${startTime} and ${endTime}`
  } catch (error) {
    let errorMessage = `Could not delete rows from agg_states between ${startTime} and ${endTime} : ${error.message}`
    throw errorMessage
  }
}

async function pruneCalStatesRangeAsync (startTime, endTime) {
  try {
    let delCount = await cachedProofState.pruneCalStatesRangeAsync(startTime, endTime)
    return `Deleted ${delCount} rows from cal_states between ${startTime} and ${endTime}`
  } catch (error) {
    let errorMessage = `Could not delete rows from cal_states between ${startTime} and ${endTime} : ${error.message}`
    throw errorMessage
  }
}

async function pruneAnchorBTCAggStatesRangeAsync (startTime, endTime) {
  try {
    let delCount = await cachedProofState.pruneAnchorBTCAggStatesRangeAsync(startTime, endTime)
    return `Deleted ${delCount} rows from anchor_btc_agg_states between ${startTime} and ${endTime}`
  } catch (error) {
    let errorMessage = `Could not delete rows from anchor_btc_agg_states between ${startTime} and ${endTime} : ${error.message}`
    throw errorMessage
  }
}

async function pruneBTCTxStatesRangeAsync (startTime, endTime) {
  try {
    let delCount = await cachedProofState.pruneBTCTxStatesRangeAsync(startTime, endTime)
    return `Deleted ${delCount} rows from btctx_states between ${startTime} and ${endTime}`
  } catch (error) {
    let errorMessage = `Could not delete rows from btctx_states between ${startTime} and ${endTime} : ${error.message}`
    throw errorMessage
  }
}

async function pruneBTCHeadStatesRangeAsync (startTime, endTime) {
  try {
    let delCount = await cachedProofState.pruneBTCHeadStatesRangeAsync(startTime, endTime)
    return `Deleted ${delCount} rows from btchead_states between ${startTime} and ${endTime}`
  } catch (error) {
    let errorMessage = `Could not delete rows from btchead_states between ${startTime} and ${endTime} : ${error.message}`
    throw errorMessage
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
    console.log('Redis connection established')
  })
  redis.on('error', async (err) => {
    console.error(`A redis error has ocurred: ${err}`)
    redis.quit()
    redis = null
    console.error('Cannot establish Redis connection. Attempting in 5 seconds...')
    await utils.sleep(5000)
    openRedisConnection(redisURI)
  })
}

async function initResqueWorkerAsync () {
  let redisReady = (redis !== null)
  while (!redisReady) {
    await utils.sleep(100)
    redisReady = (redis !== null)
  }

  const redisURI = new URL(env.REDIS_CONNECT_URI)
  var multiWorkerConfig = {
    connection: {
      host: redisURI.hostname,
      port: redisURI.port,
      namespace: 'resque'
    },
    queues: ['task-handler-queue'],
    minTaskProcessors: 10,
    maxTaskProcessors: 100
  }

  const multiWorker = new nodeResque.MultiWorker(multiWorkerConfig, jobs)

  multiWorker.on('start', (workerId) => { console.log(`worker[${workerId}] : started`) })
  multiWorker.on('end', (workerId) => { console.log(`worker[${workerId}] : ended`) })
  multiWorker.on('cleaning_worker', (workerId, worker, pid) => { console.log(`worker[${workerId}] : cleaning old worker : ${worker}`) })
  // multiWorker.on('poll', (workerId, queue) => { console.log(`worker[${workerId}] : polling : ${queue}`) })
  // multiWorker.on('job', (workerId, queue, job) => { console.log(`worker[${workerId}] : working job : ${queue} : ${JSON.stringify(job)}`) })
  multiWorker.on('reEnqueue', (workerId, queue, job, plugin) => { console.log(`worker[${workerId}] : re-enqueuing job : ${queue} : ${JSON.stringify(job)}`) })
  multiWorker.on('success', (workerId, queue, job, result) => { console.log(`worker[${workerId}] : success : ${queue} : ${result}`) })
  multiWorker.on('failure', (workerId, queue, job, failure) => { console.error(`worker[${workerId}] : failure : ${queue} : ${failure}`) })
  multiWorker.on('error', (workerId, queue, job, error) => { console.error(`worker[${workerId}] : error : ${queue} : ${error}`) })
  // multiWorker.on('pause', (workerId) => { console.log(`worker[${workerId}] : paused`) })
  multiWorker.on('internalError', (error) => { console.error(`multiWorker : intneral error : ${error}`) })
  // multiWorker.on('multiWorkerAction', (verb, delay) => { console.log(`*** checked for worker status : ${verb} : event loop delay : ${delay}ms)`) })

  multiWorker.start()

  exitHook(async () => {
    await multiWorker.end()
  })

  console.log('Resque worker connection established')
}

// process all steps need to start the application
async function start () {
  try {
    // init Redis
    openRedisConnection(env.REDIS_CONNECT_URI)
    // init Resque worker
    await initResqueWorkerAsync()
    console.log('startup completed successfully')
  } catch (error) {
    console.error(`An error has occurred on startup: ${error.message}`)
    process.exit(1)
  }
}

// get the whole show started
start()
