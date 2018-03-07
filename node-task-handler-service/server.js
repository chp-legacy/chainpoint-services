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

const storageClient = require('./lib/models/cachedProofStateModels.js')

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
    let delCount = await storageClient.pruneAggStatesRangeAsync(startTime, endTime)
    console.log(`Deleted ${delCount} rows from agg_states between ${startTime} and ${endTime}`)
  } catch (error) {
    console.error(`Could not delete rows from agg_states between ${startTime} and ${endTime} : ${error.message}`)
  }
}

async function pruneCalStatesRangeAsync (startTime, endTime) {
  try {
    let delCount = await storageClient.pruneCalStatesRangeAsync(startTime, endTime)
    console.log(`Deleted ${delCount} rows from cal_states between ${startTime} and ${endTime}`)
  } catch (error) {
    console.error(`Could not delete rows from cal_states between ${startTime} and ${endTime} : ${error.message}`)
  }
}

async function pruneAnchorBTCAggStatesRangeAsync (startTime, endTime) {
  try {
    let delCount = await storageClient.pruneAnchorBTCAggStatesRangeAsync(startTime, endTime)
    console.log(`Deleted ${delCount} rows from anchor_btc_agg_states between ${startTime} and ${endTime}`)
  } catch (error) {
    console.error(`Could not delete rows from anchor_btc_agg_states between ${startTime} and ${endTime} : ${error.message}`)
  }
}

async function pruneBTCTxStatesRangeAsync (startTime, endTime) {
  try {
    let delCount = await storageClient.pruneBTCTxStatesRangeAsync(startTime, endTime)
    console.log(`Deleted ${delCount} rows from btctx_states between ${startTime} and ${endTime}`)
  } catch (error) {
    console.error(`Could not delete rows from btctx_states between ${startTime} and ${endTime} : ${error.message}`)
  }
}

async function pruneBTCHeadStatesRangeAsync (startTime, endTime) {
  try {
    let delCount = await storageClient.pruneBTCHeadStatesRangeAsync(startTime, endTime)
    console.log(`Deleted ${delCount} rows from btchead_states between ${startTime} and ${endTime}`)
  } catch (error) {
    console.error(`Could not delete rows from btchead_states between ${startTime} and ${endTime} : ${error.message}`)
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

  var connectionDetails = {
    host: 'redis',
    port: 6379,
    namespace: 'resque'
  }

  const worker = new nodeResque.Worker({ connection: connectionDetails, queues: ['task-handler-queue'] }, jobs)

  await worker.connect()
  await worker.workerCleanup() // cleanup any previous improperly shutdown workers on this host
  worker.start()

  process.on('SIGINT', async () => {
    console.log('SIGINT : stopping all workers...')
    await worker.stop()
    console.log('SIGINT : all workers stopped : exiting')
    process.exit()
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
