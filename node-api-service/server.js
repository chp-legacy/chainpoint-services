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
const env = require('./lib/parse-env.js')('api')

const { promisify } = require('util')
const utils = require('./lib/utils.js')
const amqp = require('amqplib')
const async = require('async')
const restify = require('restify')
const corsMiddleware = require('restify-cors-middleware')
const webSocket = require('ws')
const hashes = require('./lib/endpoints/hashes.js')
const nodes = require('./lib/endpoints/nodes.js')
const proofs = require('./lib/endpoints/proofs.js')
const verify = require('./lib/endpoints/verify.js')
const calendar = require('./lib/endpoints/calendar.js')
const config = require('./lib/endpoints/config.js')
const subscribe = require('./lib/endpoints/subscribe.js')
const root = require('./lib/endpoints/root.js')
const r = require('redis')
const bluebird = require('bluebird')
const cnsl = require('consul')

// The channel used for all amqp communication
// This value is set once the connection has been established
let amqpChannel = null

// The redis connection used for all redis communication
// This value is set once the connection has been established
let redis = null

// Generate a v1 UUID (time-based)
// see: https://github.com/broofa/node-uuid
const uuidv1 = require('uuid/v1')

// Set a unique identifier for this instance of API Service
// This is used to associate API Service instances with websocket connections
const APIServiceInstanceId = uuidv1()

// Initial an object that will hold all open websocket connections
let WebSocketConnections = {}

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

server.pre(function (request, response, next) {
  request.log.info({ req: [request.url, request.method, request.rawHeaders] }, 'API-REQUEST')
  next()
})

let consul = null

// Create a WS server to run in association with the Restify server
let webSocketServer = new webSocket.Server({ server: server.server })
// Handle new web socket connections
webSocketServer.on('connection', (ws) => {
  // set up ping to keep connection open over long periods of inactivity
  let pingInterval = setInterval(() => { ws.ping('ping') }, 1000 * 45)
  // retrieve the unique identifier for this connection
  let wsConnectionId = ws.upgradeReq.headers['sec-websocket-key']
  // save this connection to the open connection registry
  WebSocketConnections[wsConnectionId] = ws
  // when a message is received, process it as a subscription request
  ws.on('message', (hashIds) => subscribe.subscribeForProofs(APIServiceInstanceId, ws, wsConnectionId, hashIds))
  // when a connection closes, remove it from the open connection registry
  ws.on('close', () => {
    // remove this connection from the open connections object
    delete WebSocketConnections[wsConnectionId]
    // remove ping interval
    clearInterval(pingInterval)
  })
  ws.on('error', (e) => console.error(`Websocket error has occurred: ${e}`))
})

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
// http://127.0.0.1:8080/hash \
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
// get nodes list
// server.get({ path: '/nodes/:tnt_addr', version: '1.0.0' }, nodes.getNodeByTNTAddrV1Async)
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
* Parses a proof message and performs the required work for that message
*
* @param {amqp message object} msg - The AMQP message received from the queue
*/
function processProofMessage (msg) {
  if (msg !== null) {
    if (redis) {
      let proofReadyObj = JSON.parse(msg.content.toString())

      async.waterfall([
        (callback) => {
          // get the target websocket if it is on this instance, otherwise null
          let targetWebsocket = WebSocketConnections[proofReadyObj.cx_id] || null
          // if the target websocket is not on this instance, there is no work to do, return
          if (targetWebsocket === null) return callback(null)
          // get the proof for the given hashId
          redis.get(proofReadyObj.hash_id, (err, proofBase64) => {
            if (err) return callback(err)
            // if proof is not found, return null to skip the rest of the process
            if (proofBase64 == null) return callback(null)
            // deliver proof over websocket if websocket was found on this instance
            let proofResponse = {
              hash_id: proofReadyObj.hash_id,
              proof: proofBase64
            }
            targetWebsocket.send(JSON.stringify(proofResponse))
            return callback(null)
          })
        }
      ], (err) => {
        if (err) {
          amqpChannel.nack(msg)
          console.error(env.RMQ_WORK_IN_API_QUEUE, 'consume message nacked')
        } else {
          amqpChannel.ack(msg)
          // console.log(env.RMQ_WORK_IN_API_QUEUE, 'consume message acked')
        }
      })
    } else {
      // redis is not initialized, nack and requeue 5 seconds later
      setTimeout(() => {
        amqpChannel.nack(msg)
        console.log(env.RMQ_WORK_IN_API_QUEUE, 'consume message nacked - redis null')
      }, 5000)
    }
  }
}

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
      await nodes.getNodeAuditLogSequelize().sync({ logging: false })
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
      amqpChannel = chan
      hashes.setAMQPChannel(chan)
      // assert headers exchange for receiving proofs
      chan.assertExchange(env.RMQ_INCOMING_EXCHANGE, 'headers', { durable: true })
      let q = chan.assertQueue(env.RMQ_WORK_IN_API_QUEUE, { durable: true })
      let opts = { 'api_id': APIServiceInstanceId, 'x-match': 'all' }
      chan.bindQueue(q.queue, env.RMQ_INCOMING_EXCHANGE, '', opts)
      chan.consume(q.queue, (msg) => {
        processProofMessage(msg)
      })
      // if the channel closes for any reason, attempt to reconnect
      conn.on('close', async () => {
        console.error('Connection to RMQ closed.  Reconnecting in 5 seconds...')
        amqpChannel = null
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
 * @param {string} connectionString - The connection string for the Redis instance, an Redis URI
 */
function openRedisConnection (redisURI) {
  redis = r.createClient(redisURI)
  redis.on('ready', () => {
    bluebird.promisifyAll(redis)
    proofs.setRedis(redis)
    subscribe.setRedis(redis)
    console.log('Redis connection established')
  })
  redis.on('error', async (err) => {
    console.error(`A redis error has ocurred: ${err}`)
    redis.quit()
    redis = null
    proofs.setRedis(null)
    subscribe.setRedis(null)
    console.error('Cannot establish Redis connection. Attempting in 5 seconds...')
    await utils.sleep(5000)
    openRedisConnection(redisURI)
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
  setRedis: (redisClient) => { redis = redisClient },
  setAMQPChannel: (chan) => {
    amqpChannel = chan
    hashes.setAMQPChannel(chan)
  },
  setNistLatest: (val) => { hashes.setNistLatest(val) },
  setHashesRegisteredNode: (regNode) => { hashes.setHashesRegisteredNode(regNode) },
  setNodesRegisteredNode: (regNode) => { nodes.setNodesRegisteredNode(regNode) },
  setNodesNodeAuditLog: (nodeAuditLog) => { nodes.setNodesNodeAuditLog(nodeAuditLog) },
  server: server,
  config: config
}
