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
const env = require('./lib/parse-env.js')('audit')

const rp = require('request-promise-native')
const nodeAuditLog = require('./lib/models/NodeAuditLog.js')
const cachedAuditChallenge = require('./lib/models/cachedAuditChallenge.js')
const utils = require('./lib/utils.js')
const amqp = require('amqplib')
const semver = require('semver')
const retry = require('async-retry')
const bluebird = require('bluebird')
const r = require('redis')

// The channel used for all amqp communication
// This value is set once the connection has been established
let amqpChannel = null

let redis = null

// TweetNaCl.js
// see: http://ed25519.cr.yp.to
// see: https://github.com/dchest/tweetnacl-js#signatures
const nacl = require('tweetnacl')
nacl.util = require('tweetnacl-util')

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

async function processMessageAsync (msg) {
  if (msg !== null) {
    // determine the source of the message and handle appropriately
    switch (msg.properties.type) {
      case 'audit':
        // perform an audit task
        await consumeAuditMessage(msg)
        break
      case 'prune':
        // perform a prune task
        await consumePruneMessage(msg)
        break
      default:
        console.error('NodeAudit : processMessage : unknown message type', msg.properties.type)
        // cannot handle unknown type messages, ack message and do nothing
        amqpChannel.ack(msg)
    }
  }
}

async function consumeAuditMessage (msg) {
  if (msg !== null) {
    let auditTaskObj = JSON.parse(msg.content.toString())

    let publicIPPass = false
    let nodeMSDelta = null
    let timePass = false
    let calStatePass = false
    let minCreditsPass = false
    let nodeVersion = null
    let nodeVersionPass = false

    // perform the minimum credit check
    let currentCreditBalance = auditTaskObj.tntCredit
    minCreditsPass = (currentCreditBalance >= MIN_PASSING_CREDIT_BALANCE)

    // if there is no public_uri set for this Node, fail all remaining audit tests and continue to the next
    if (!auditTaskObj.publicUri) {
      await addAuditToLogAsync(auditTaskObj.tntAddr, null, Date.now(), publicIPPass, nodeMSDelta, timePass, calStatePass, minCreditsPass, nodeVersion, nodeVersionPass)
      amqpChannel.ack(msg)
      return
    }

    let configResultsBody
    let configResultTime
    try {
      configResultsBody = await getNodeConfigObjectAsync(auditTaskObj)
      configResultTime = Date.now()
    } catch (error) {
      if (error.statusCode) {
        console.log(`NodeAudit: GET failed with status code ${error.statusCode} for ${auditTaskObj.publicUri}: ${error.message}`)
      } else {
        console.log(`NodeAudit: GET failed for ${auditTaskObj.publicUri}: ${error.message}`)
      }
      await addAuditToLogAsync(auditTaskObj.tntAddr, auditTaskObj.publicUri, Date.now(), publicIPPass, nodeMSDelta, timePass, calStatePass, minCreditsPass, nodeVersion, nodeVersionPass)
      amqpChannel.ack(msg)
      return
    }

    if (!configResultsBody) {
      console.log(`NodeAudit: GET failed with empty result for ${auditTaskObj.publicUri}`)
      await addAuditToLogAsync(auditTaskObj.tntAddr, auditTaskObj.publicUri, configResultTime, publicIPPass, nodeMSDelta, timePass, calStatePass, minCreditsPass, nodeVersion, nodeVersionPass)
      amqpChannel.ack(msg)
      return
    }

    if (!configResultsBody.calendar) {
      console.log(`NodeAudit: GET failed with missing calendar data for ${auditTaskObj.publicUri}`)
      await addAuditToLogAsync(auditTaskObj.tntAddr, auditTaskObj.publicUri, configResultTime, publicIPPass, nodeMSDelta, timePass, calStatePass, minCreditsPass, nodeVersion, nodeVersionPass)
      amqpChannel.ack(msg)
      return
    }
    if (!configResultsBody.time) {
      console.log(`NodeAudit: GET failed with missing time for ${auditTaskObj.publicUri}`)
      await addAuditToLogAsync(auditTaskObj.tntAddr, auditTaskObj.publicUri, configResultTime, publicIPPass, nodeMSDelta, timePass, calStatePass, minCreditsPass, nodeVersion, nodeVersionPass)
      amqpChannel.ack(msg)
      return
    }
    if (!configResultsBody.version) {
      console.log(`NodeAudit: GET failed with missing version for ${auditTaskObj.publicUri}`)
      await addAuditToLogAsync(auditTaskObj.tntAddr, auditTaskObj.publicUri, configResultTime, publicIPPass, nodeMSDelta, timePass, calStatePass, minCreditsPass, nodeVersion, nodeVersionPass)
      amqpChannel.ack(msg)
      return
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
          console.error(`NodeAudit: Could not query for audit challenge: ${nodeAuditResponseTimestamp}`)
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
          console.error(`NodeAudit: No audit challenge record found: ${configResultsBody.calendar.audit_response} | ${configResultTime}, ${minTimestamp}`)
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

    let success = await addAuditToLogAsync(auditTaskObj.tntAddr, auditTaskObj.publicUri, configResultTime, publicIPPass, nodeMSDelta, timePass, calStatePass, minCreditsPass, nodeVersion, nodeVersionPass)

    if (success) {
      let results = {}
      results.auditAt = configResultTime
      results.publicIPPass = publicIPPass
      results.timePass = timePass
      results.calStatePass = calStatePass
      results.minCreditsPass = minCreditsPass
      results.nodeVersionPass = nodeVersionPass

      console.log(`Audit complete for ${auditTaskObj.tntAddr} at ${auditTaskObj.publicUri}: ${JSON.stringify(results)}`)
    }
    amqpChannel.ack(msg)
  }
}

async function consumePruneMessage (msg) {
  if (msg !== null) {
    let pruneTaskObj = JSON.parse(msg.content.toString())
    let startTimestamp, endTimestamp
    try {
      startTimestamp = parseInt(pruneTaskObj.startBound)
      endTimestamp = parseInt(pruneTaskObj.endBound)
      let delCount = await NodeAuditLog.destroy({ where: { audit_at: { [Op.gte]: startTimestamp, [Op.lte]: endTimestamp } } })
      console.log(`${delCount} audit log rows deleted between audit_at values of ${startTimestamp} and ${endTimestamp}`)
      amqpChannel.ack(msg)
    } catch (error) {
      console.error(`NodeAudit: consumePruneMessage : could not delete rows between audit_at values of ${pruneTaskObj.startBound} and ${endTimestamp} : ${error.message}`)
      // wait a minute and try again, maybe CRDB was temporarily unavailable
      setTimeout(() => { amqpChannel.nack(msg) }, 60000)
    }
  }
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
    console.error(`Audit logging error: ${tntAddr}: ${error.message} `)
    return false
  }
  return true
}

async function getNodeConfigObjectAsync (auditTaskObj) {
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
    uri: `${auditTaskObj.publicUri}/config`,
    json: true,
    gzip: true,
    timeout: 2500,
    resolveWithFullResponse: true
  }

  nodeResponse = await rp(options)
  return nodeResponse.body
}

/**
 * Opens a storage connection
 **/
async function openStorageConnectionAsync () {
  let dbConnected = false
  while (!dbConnected) {
    try {
      await nodeAuditSequelize.sync({ logging: false })
      await cachedAuditChallenge.getAuditChallengeSequelize().sync({ logging: false })
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
 * Opens a Redis connection
 *
 * @param {string} connectionString - The connection string for the Redis instance, an Redis URI
 */
function openRedisConnection (redisURI) {
  redis = r.createClient(redisURI)
  redis.on('ready', () => {
    bluebird.promisifyAll(redis)
    cachedAuditChallenge.setRedis(redis)
    console.log('Redis connection established')
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
      chan.assertQueue(env.RMQ_WORK_IN_AUDIT_QUEUE, { durable: true })
      chan.prefetch(env.RMQ_PREFETCH_COUNT_AUDIT)
      amqpChannel = chan
      // Receive and process audit task messages
      chan.consume(env.RMQ_WORK_IN_AUDIT_QUEUE, async (msg) => {
        await processMessageAsync(msg)
      })
      // if the channel closes for any reason, attempt to reconnect
      conn.on('close', async () => {
        console.error('Connection to RMQ closed.  Reconnecting in 5 seconds...')
        amqpChannel = null
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

// process all steps need to start the application
async function start () {
  if (env.NODE_ENV === 'test') return
  try {
    // init DB
    await openStorageConnectionAsync()
    // init Redis
    openRedisConnection(env.REDIS_CONNECT_URI)
    // init RabbitMQ
    await openRMQConnectionAsync(env.RABBITMQ_CONNECT_URI)
    console.log('startup completed successfully')
  } catch (error) {
    console.error(`An error has occurred on startup: ${error.message}`)
    process.exit(1)
  }
}

// get the whole show started
start()
