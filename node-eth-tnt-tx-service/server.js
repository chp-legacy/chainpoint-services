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
const env = require('./lib/parse-env.js')('eth-tnt-tx')

const restify = require('restify')
const connections = require('./lib/connections.js')
const tntFunctions = require('./lib/endpoints/tntFunctions.js')

// RESTIFY SETUP
// 'version' : all routes will default to this version
let server = restify.createServer({
  name: 'eth-tx',
  version: '1.0.0'
})

// Clean up sloppy paths like //todo//////1//
server.pre(restify.pre.sanitizePath())

// Checks whether the user agent is curl. If it is, it sets the
// Connection header to "close" and removes the "Content-Length" header
// See : http://restify.com/#server-api
server.pre(restify.pre.userAgentConnection())

server.use(restify.gzipResponse())
server.use(restify.queryParser())
server.use(restify.bodyParser({
  maxBodySize: env.MAX_BODY_SIZE
}))

// API RESOURCES

// get the TNT balance for a specific TNT address in grains
server.get({ path: '/balance/:tnt_addr/', version: '1.0.0' }, tntFunctions.getBalanceByTNTAddrV1Async)
// send TNT grains to an address
server.post({ path: '/transfer/', version: '1.0.0' }, tntFunctions.postTransferV1Async)

/**
 * Opens a Redis connection
 *
 * @param {string} redisURI - The connection string for the Redis instance, an Redis URI
 */
function openRedisConnection (redisURIs) {
  connections.openRedisConnection(redisURIs,
    (newRedis) => {
      tntFunctions.setRedis(newRedis)
    }, () => {
      tntFunctions.setRedis(null)
      setTimeout(() => { openRedisConnection(redisURIs) }, 5000)
    })
}

function startIntervals () {
  let intervals = [{
    function: () => {
      tntFunctions.updateETHGasPriceAsync()
    },
    immediate: true, // run this once immediately
    ms: 600000 // every ten minutes
  }]
  connections.startIntervals(intervals)
}

// process all steps need to start the application
async function start () {
  if (env.NODE_ENV === 'test') return
  try {
    // init Redis
    openRedisConnection(env.REDIS_CONNECT_URIS)
    // Init Restify
    await connections.listenRestifyAsync(server, env.LISTEN_TX_PORT)
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
