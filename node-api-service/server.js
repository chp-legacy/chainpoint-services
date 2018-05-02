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
const env = require('./lib/parse-env.js')('api')

const { promisify } = require('util')
const utils = require('./lib/utils.js')
const amqp = require('amqplib')
const restify = require('restify')
const corsMiddleware = require('restify-cors-middleware')
const hashes = require('./lib/endpoints/hashes.js')
const nodes = require('./lib/endpoints/nodes.js')
const proofs = require('./lib/endpoints/proofs.js')
const verify = require('./lib/endpoints/verify.js')
const calendar = require('./lib/endpoints/calendar.js')
const config = require('./lib/endpoints/config.js')
const root = require('./lib/endpoints/root.js')
const cnsl = require('consul')
const connections = require('./lib/connections.js')

// The redis connection used for all redis communication
// This value is set once the connection has been established
let redis = null

const bunyan = require('bunyan')

var logger = bunyan.createLogger({
  name: 'audit',
  stream: process.stdout
})

// RESTIFY SETUP
// 'version' : all routes will default to this version
let server = restify.createServer({
  name: 'chainpoint',
  version: '1.0.0',
  log: logger
})

// LOG EVERY REQUEST
// server.pre(function (request, response, next) {
//   request.log.info({ req: [request.url, request.method, request.rawHeaders] }, 'API-REQUEST')
//   next()
// })

let consul = null

// Clean up sloppy paths like //todo//////1//
server.pre(restify.pre.sanitizePath())

// Checks whether the user agent is curl. If it is, it sets the
// Connection header to "close" and removes the "Content-Length" header
// See : http://restify.com/#server-api
server.pre(restify.pre.userAgentConnection())

// CORS
// See : https://github.com/TabDigital/restify-cors-middleware
// See : https://github.com/restify/node-restify/issues/1151#issuecomment-271402858
//
// Test w/
//
// curl \
// --verbose \
// --request OPTIONS \
// http://127.0.0.1:8080/hashes \
// --header 'Origin: http://localhost:9292' \
// --header 'Access-Control-Request-Headers: Origin, Accept, Content-Type' \
// --header 'Access-Control-Request-Method: POST'
//
var cors = corsMiddleware({
  preflightMaxAge: 600,
  origins: ['*']
})
server.pre(cors.preflight)
server.use(cors.actual)

server.use(restify.gzipResponse())
server.use(restify.queryParser())
server.use(restify.bodyParser({
  maxBodySize: env.MAX_BODY_SIZE
}))

// API RESOURCES

// submit hash(es)
server.post({ path: '/hashes', version: '1.0.0' }, hashes.postHashV1Async)
// get a single proof with a single hash_id
server.get({ path: '/proofs/:hash_id', version: '1.0.0' }, proofs.getProofsByIDV1Async)
// get multiple proofs with 'hashids' header param
server.get({ path: '/proofs', version: '1.0.0' }, proofs.getProofsByIDV1Async)
// verify one or more proofs
server.post({ path: '/verify', version: '1.0.0' }, verify.postProofsForVerificationV1)
// get the block objects for the calendar in the specified block range
server.get({ path: '/calendar/blockrange/:index', version: '1.0.0' }, calendar.getCalBlockRangeV2Async)
// get the block hash for the calendar at the specified hieght
server.get({ path: '/calendar/:height/hash', version: '1.0.0' }, calendar.getCalBlockHashByHeightV1Async)
// get the dataVal item for the calendar at the specified hieght
server.get({ path: '/calendar/:height/data', version: '1.0.0' }, calendar.getCalBlockDataByHeightV1Async)
// get the block object for the calendar at the specified hieght
server.get({ path: '/calendar/:height', version: '1.0.0' }, calendar.getCalBlockByHeightV1Async)
// get random subset of nodes list
server.get({ path: '/nodes/random', version: '1.0.0' }, nodes.getNodesRandomV1Async)
// get nodes blacklist
server.get({ path: '/nodes/blacklist', version: '1.0.0' }, nodes.getNodesBlacklistV1Async)
// register a new node
server.post({ path: '/nodes', version: '1.0.0' }, nodes.postNodeV1Async)
// update an existing node
server.put({ path: '/nodes/:tnt_addr', version: '1.0.0' }, nodes.putNodeV1Async)
// get configuration information for this stack
server.get({ path: '/config', version: '1.0.0' }, config.getConfigInfoV1Async)
// get heartbeat
server.get({ path: '/heartbeat', version: '1.0.0' }, root.getHeartbeatV1)
// teapot
server.get({ path: '/', version: '1.0.0' }, root.getV1)

/**
 * Opens a storage connection
 **/
async function openStorageConnectionAsync () {
  let dbConnected = false
  while (!dbConnected) {
    try {
      await hashes.getSequelize().sync({ logging: false })
      await nodes.getRegisteredNodeSequelize().sync({ logging: false })
      await calendar.getCalendarBlockSequelize().sync({ logging: false })
      await verify.getCalendarBlockSequelize().sync({ logging: false })
      await config.getAuditChallengeSequelize().sync({ logging: false })
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
      chan.assertQueue(env.RMQ_WORK_OUT_AGG_QUEUE, { durable: true })
      chan.prefetch(env.RMQ_PREFETCH_COUNT_API)
      // set 'amqpChannel' so that publishers have access to the channel
      hashes.setAMQPChannel(chan)
      // if the channel closes for any reason, attempt to reconnect
      conn.on('close', async () => {
        console.error('Connection to RMQ closed.  Reconnecting in 5 seconds...')
        hashes.setAMQPChannel(null)
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

/**
 * Opens a Redis connection
 *
 * @param {string} redisURI - The connection string for the Redis instance, an Redis URI
 */
function openRedisConnection (redisURI) {
  connections.openRedisConnection(redisURI,
    (newRedis) => {
      redis = newRedis
      hashes.setRedis(redis)
      config.setRedis(redis)
    }, () => {
      redis = null
      hashes.setRedis(null)
      config.setRedis(null)
      setTimeout(() => { openRedisConnection(redisURI) }, 5000)
    })
}

// This initalizes all the consul watches
function startWatches () {
  console.log('starting watches')

  // Continuous watch on the consul key holding the NIST object.
  var nistWatch = consul.watch({ method: consul.kv.get, options: { key: env.NIST_KEY } })

  // Store the updated NIST data on change
  nistWatch.on('change', function (data, res) {
    // process only if a value has been returned and it is different than what is already stored
    if (data && data.Value && hashes.getNistLatest() !== data.Value) {
      hashes.setNistLatest(data.Value)
    }
  })

  nistWatch.on('error', function (err) {
    console.error('nistWatch error: ', err)
  })

  // Continuous watch on the consul key holding the regNodesLimit count.
  var regNodesLimitWatch = consul.watch({ method: consul.kv.get, options: { key: env.REG_NODES_LIMIT_KEY } })

  // Store the updated regNodesLimit count on change
  regNodesLimitWatch.on('change', function (data, res) {
    // process only if a value has been returned
    if (data && data.Value) {
      nodes.setRegNodesLimit(data.Value)
    }
  })

  regNodesLimitWatch.on('error', function (err) {
    console.error('regNodesLimitWatch error: ', err)
  })

  // Continuous watch on the consul key holding the regNodesLimit count.
  var minNodeVersionExistingWatch = consul.watch({ method: consul.kv.get, options: { key: env.MIN_NODE_VERSION_EXISTING_KEY } })

  // Store the updated regNodesLimit count on change
  minNodeVersionExistingWatch.on('change', function (data, res) {
    // process only if a value has been returned
    if (data && data.Value) {
      config.setMinNodeVersionExisting(data.Value)
      nodes.setMinNodeVersionExisting(data.Value)
    }
  })

  minNodeVersionExistingWatch.on('error', function (err) {
    console.error('minNodeVersionExistingWatch error: ', err)
  })

  // Continuous watch on the consul key holding the regNodesLimit count.
  var minNodeVersionNewWatch = consul.watch({ method: consul.kv.get, options: { key: env.MIN_NODE_VERSION_NEW_KEY } })

  // Store the updated regNodesLimit count on change
  minNodeVersionNewWatch.on('change', function (data, res) {
    // process only if a value has been returned
    if (data && data.Value) {
      nodes.setMinNodeVersionNew(data.Value)
    }
  })

  minNodeVersionNewWatch.on('error', function (err) {
    console.error('minNodeVersionNewWatch error: ', err)
  })

  // Continuous watch on the consul key holding the moat recent audit challenge key.
  var recentChallengeKeyWatch = consul.watch({ method: consul.kv.get, options: { key: env.AUDIT_CHALLENGE_RECENT_KEY } })

  // Store the updated regNodesLimit count on change
  recentChallengeKeyWatch.on('change', function (data, res) {
    // process only if a value has been returned
    if (data && data.Value) config.setMostRecentChallengeKey(data.Value)
  })

  recentChallengeKeyWatch.on('error', function (err) {
    console.error('recentChallengeKeyWatch error: ', err)
  })

  consul.kv.get(env.REG_NODES_LIMIT_KEY, function (err, result) {
    if (err) {
      console.error(err)
    } else {
      // Only create key if it doesn't exist or has no value, default value of 0
      if (!result) {
        consul.kv.set(env.REG_NODES_LIMIT_KEY, '0', function (err, result) {
          if (err) throw err
          console.log(`Created ${env.REG_NODES_LIMIT_KEY} key`)
        })
      }
    }
  })

  consul.kv.get(env.MIN_NODE_VERSION_EXISTING_KEY, function (err, result) {
    if (err) {
      console.error(err)
    } else {
      // Only create key if it doesn't exist or has no value, default value of 0
      if (!result) {
        consul.kv.set(env.MIN_NODE_VERSION_EXISTING_KEY, '0.0.1', function (err, result) {
          if (err) throw err
          console.log(`Created ${env.MIN_NODE_VERSION_EXISTING_KEY} key`)
        })
      }
    }
  })

  consul.kv.get(env.MIN_NODE_VERSION_NEW_KEY, function (err, result) {
    if (err) {
      console.error(err)
    } else {
      // Only create key if it doesn't exist or has no value, default value of 0
      if (!result) {
        consul.kv.set(env.MIN_NODE_VERSION_NEW_KEY, '0.0.1', function (err, result) {
          if (err) throw err
          console.log(`Created ${env.MIN_NODE_VERSION_NEW_KEY} key`)
        })
      }
    }
  })
}

// Instruct REST server to begin listening for request
function listenRestify (callback) {
  server.listen(8080, (err) => {
    if (err) return callback(err)
    console.log(`${server.name} listening at ${server.url}`)
    return callback(null)
  })
}
// make awaitable async version for startListening function
let listenRestifyAsync = promisify(listenRestify)

// process all steps need to start the application
async function start () {
  if (env.NODE_ENV === 'test') return
  try {
    // init consul
    consul = cnsl({ host: env.CONSUL_HOST, port: env.CONSUL_PORT })
    config.setConsul(consul)
    console.log('Consul connection established')
    // init Redis
    openRedisConnection(env.REDIS_CONNECT_URI)
    // init DB
    await openStorageConnectionAsync()
    // init RabbitMQ
    await openRMQConnectionAsync(env.RABBITMQ_CONNECT_URI)
    // init watches
    startWatches()
    // Init Restify
    await listenRestifyAsync()
    console.log('startup completed successfully')
  } catch (error) {
    console.error(`An error has occurred on startup: ${error.message}`)
    process.exit(1)
  }
}

// get the whole show started
start()

// export these functions for testing purposes
module.exports = {
  setRedis: (redisClient) => {
    redis = redisClient
    proofs.setRedis(redis)
    hashes.setRedis(redis)
  },
  setAMQPChannel: (chan) => {
    hashes.setAMQPChannel(chan)
  },
  setNistLatest: (val) => { hashes.setNistLatest(val) },
  setHashesRegisteredNode: (regNode) => { hashes.setHashesRegisteredNode(regNode) },
  setNodesRegisteredNode: (regNode) => { nodes.setNodesRegisteredNode(regNode) },
  server: server,
  config: config,
  setRegNodesLimit: (val) => { nodes.setLimitDirect(val) },
  overrideGetTNTGrainsBalanceForAddressAsync: (func) => { nodes.overrideGetTNTGrainsBalanceForAddressAsync(func) }
}
