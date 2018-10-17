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

const registeredNode = require('./lib/models/RegisteredNode.js')
const utils = require('./lib/utils.js')
const calendarBlock = require('./lib/models/CalendarBlock.js')
const cachedAuditChallenge = require('./lib/models/cachedAuditChallenge.js')
const nodeAuditLog = require('./lib/models/NodeAuditLog.js')
const crypto = require('crypto')
const rnd = require('random-number-csprng')
const MerkleTools = require('merkle-tools')
const heartbeats = require('heartbeats')
const leaderElection = require('exp-leader-election')
const cnsl = require('consul')
const connections = require('./lib/connections.js')

let consul = null

let redis = null

// This value is set once the connection has been established
let taskQueue = null

// The leadership status for this instance of the audit producer service
let IS_LEADER = false

// The lifespan of audit log entries
const AUDIT_LOG_EXPIRE_HOURS = 6

// the amount of credits to top off all Nodes with daily
const creditTopoffAmount = 86400

// The lifespan of balance pass redis entries
const BALANCE_PASS_EXPIRE_MINUTES = 60 * 24 // 1 day

// create a heartbeat for every 200ms
// 1 second heartbeats had a drift that caused occasional skipping of a whole second
// decreasing the interval of the heartbeat and checking current time resolves this
const HEARTBEAT_INTERVAL_MS = 200

let heart = heartbeats.createHeart(HEARTBEAT_INTERVAL_MS)

// The merkle tools object for building trees and generating proof paths
const merkleTools = new MerkleTools()

// pull in variables defined in shared database models
let regNodeSequelize = registeredNode.sequelize
let RegisteredNode = registeredNode.RegisteredNode
let calBlockSequelize = calendarBlock.sequelize
let CalendarBlock = calendarBlock.CalendarBlock
let nodeAuditSequelize = nodeAuditLog.sequelize
let NodeAuditLog = nodeAuditLog.NodeAuditLog
let Op = regNodeSequelize.Op

// Retrieve all registered Nodes with public_uris for auditing.
async function auditNodesAsync (opts = { e2eAudit: false }) {
  // get list of all public Registered Nodes to audit
  let publicNodesReadyForAudit = []
  try {
    let sqlQuery = `SELECT rn.tnt_addr, rn.public_uri, rn.tnt_credit, rn.pass_count, rn.fail_count, rn.consecutive_passes, 
                   rn.consecutive_fails, rn.created_at, rn.updated_at, al.audit_at, al.public_ip_pass, al.public_uri AS audit_uri, 
                   al.node_ms_delta, al.time_pass, al.cal_state_pass, al.min_credits_pass, al.node_version, 
                   al.node_version_pass, al.tnt_balance_grains, al.tnt_balance_pass
                   FROM chainpoint_registered_nodes rn
                   LEFT JOIN (
                     SELECT DISTINCT ON (al2.tnt_addr) al2.tnt_addr, al2.audit_at, al2.public_ip_pass, al2.public_uri, 
                     al2.node_ms_delta, al2.time_pass, al2.cal_state_pass, al2.min_credits_pass, al2.node_version, 
                     al2.node_version_pass, al2.tnt_balance_grains, al2.tnt_balance_pass
                     FROM chainpoint_node_audit_log AS al2
                     ORDER BY al2.tnt_addr, al2.audit_at DESC
                   ) AS al
                   ON rn.tnt_addr = al.tnt_addr
                   WHERE rn.public_uri IS NOT NULL`
    publicNodesReadyForAudit = await regNodeSequelize.query(sqlQuery, { type: regNodeSequelize.QueryTypes.SELECT })
    console.log(`${publicNodesReadyForAudit.length} public Nodes ready for audit were found`)
  } catch (error) {
    let message = `Could not retrieve public Node data : ${error.message}`
    throw new Error(message)
  }

  // get the total active node count, needed to deliver to Nodes during audit process
  let activePublicNodeCount = await RegisteredNode.count({ where: { audit_score: { [Op.gt]: 0 }, consecutive_fails: { [Op.lt]: 144 } } })

  // iterate through each public Registered Node, queue up an audit task for task handler
  for (let publicNodeReadyForAudit of publicNodesReadyForAudit) {
    try {
      let taskHandlerArgs = (function () {
        let defaultRetryCount = 0

        if (opts.e2eAudit === true) return [publicNodeReadyForAudit.public_uri, defaultRetryCount]
        else return [ publicNodeReadyForAudit, activePublicNodeCount ]
      })()

      await taskQueue.enqueue(
        'task-handler-queue',
        (opts.e2eAudit === true) ? 'e2e_audit_public_node' : `audit_public_node`,
        taskHandlerArgs
      )
    } catch (error) {
      console.error(`Could not enqueue ${(opts.e2eAudit === true) ? 'e2e_' : ''}audit_public_node task : ${error.message}`)
    }
  }
  console.log(`${(opts.e2eAudit === true) ? 'E2E ' : ''}Audit public tasks queued for task-handler`)

  // Short circuit this function if this is an E2E Audit. At this point, we have queued all Public nodes that will be
  // processed by 'e2e_audit_public_node' and have no need to perform an e2e audit of private nodes.
  if (opts.e2eAudit) {
    return
  }

  // get list of all private Registered Nodes to audit
  let privateNodesReadyForAudit = []
  try {
    let sqlQuery = `SELECT rn.tnt_addr, rn.public_uri
                   FROM chainpoint_registered_nodes rn
                   WHERE rn.public_uri IS NULL`
    privateNodesReadyForAudit = await regNodeSequelize.query(sqlQuery, { type: regNodeSequelize.QueryTypes.SELECT })
    console.log(`${privateNodesReadyForAudit.length} private Nodes ready for audit were found`)
  } catch (error) {
    let message = `Could not retrieve private Node data : ${error.message}`
    throw new Error(message)
  }

  // iterate through each public Registered Node, queue up an audit task for task handler
  for (let privateNodeReadyForAudit of privateNodesReadyForAudit) {
    try {
      await taskQueue.enqueue(
        'task-handler-queue',
        `audit_private_node`,
        [
          privateNodeReadyForAudit
        ])
    } catch (error) {
      console.error(`Could not enqueue audit_private_node task : ${error.message}`)
    }
  }
  console.log(`Audit private tasks queued for task-handler`)

  try {
    let decPrivateNodesQuery = `UPDATE chainpoint_registered_nodes SET audit_score = GREATEST(audit_score - 1, 0) WHERE public_uri IS NULL`
    await regNodeSequelize.query(decPrivateNodesQuery, { type: regNodeSequelize.QueryTypes.UPDATE })
  } catch (error) {
    let message = `Could not decrement private Node scores by 1 : ${error.message}`
    throw new Error(message)
  }
  console.log(`Private Node scores decremented by 1`)

  // wait 1 minute and then prune any old data from the table
  setTimeout(() => { pruneAuditDataAsync() }, 60000)
}

// Generate a new audit challenge for the Nodes. Audit challenges should be refreshed hourly.
// Audit challenges include a timestamp, minimum block height, maximum block height, and a nonce
async function generateAuditChallengeAsync () {
  try {
    let currentBlockHeight
    let topBlock = await CalendarBlock.findOne({ attributes: ['id'], order: [['id', 'DESC']] })
    if (topBlock) {
      currentBlockHeight = parseInt(topBlock.id, 10)
    } else {
      console.error('Cannot generate challenge, no genesis block found')
      return
    }
    // calculate min and max values with special exception for low block count
    let challengeTime = Date.now()
    let challengeMaxBlockHeight = currentBlockHeight > 2000 ? currentBlockHeight - 1000 : currentBlockHeight
    let randomNum = await rnd(10, 1000)
    let challengeMinBlockHeight = challengeMaxBlockHeight - randomNum
    if (challengeMinBlockHeight < 0) challengeMinBlockHeight = 0
    let challengeNonce = crypto.randomBytes(32).toString('hex')

    let challengeSolution = await calculateChallengeSolutionAsync(challengeMinBlockHeight, challengeMaxBlockHeight, challengeNonce)

    let auditChallenge = await cachedAuditChallenge.setNewAuditChallengeAsync(challengeTime, challengeMinBlockHeight, challengeMaxBlockHeight, challengeNonce, challengeSolution)

    console.log(`New challenge generated: ${auditChallenge}`)
  } catch (error) {
    console.error(`Could not generate audit challenge: ${error.message}`)
  }
}

async function calculateChallengeSolutionAsync (min, max, nonce) {
  let blocks = await CalendarBlock.findAll({ where: { id: { [Op.between]: [min, max] } }, order: [['id', 'ASC']] })

  if (blocks.length === 0) throw new Error('No blocks returned to create challenge tree')

  merkleTools.resetTree()

  // retrieve all block hashes from blocks array
  let leaves = blocks.map((block) => {
    let blockHashBuffer = Buffer.from(block.hash, 'hex')
    return blockHashBuffer
  })
  // add the nonce to the head of the leaves array
  leaves.unshift(Buffer.from(nonce, 'hex'))

  // Add every hash in leaves to new Merkle tree
  merkleTools.addLeaves(leaves)
  merkleTools.makeTree()

  // calculate the merkle root, the solution to the challenge
  let challengeSolution = merkleTools.getMerkleRoot().toString('hex')

  return challengeSolution
}

async function performCreditTopoffAsync (creditAmount) {
  try {
    await RegisteredNode.update({ tntCredit: creditAmount }, { where: { tntCredit: { [Op.lt]: creditAmount } } })
    console.log(`All Nodes topped off to ${creditAmount} credits`)
  } catch (error) {
    console.error(`Unable to perform credit topoff: ${error.message}`)
  }
}

async function pruneAuditDataAsync () {
  const cutoffTimestamp = Date.now() - AUDIT_LOG_EXPIRE_HOURS * 60 * 60 * 1000

  // select all the audit id values that are ready to be pruned
  let auditIds = await NodeAuditLog.findAll({ where: { audit_at: { [Op.lte]: cutoffTimestamp } }, attributes: ['id'] })
  // get an array of ids from the results
  auditIds = auditIds.map((item) => { return item.id })

  let pruneBatchTasks = []
  let pruneBatchSize = 500

  while (auditIds.length > 0) {
    let batch = auditIds.splice(0, pruneBatchSize)
    pruneBatchTasks.push(batch)
  }

  // create and issue individual delete tasks for each batch
  for (let pruneBatchTask of pruneBatchTasks) {
    try {
      await taskQueue.enqueue('task-handler-queue', `prune_audit_log_ids`, [pruneBatchTask])
    } catch (error) {
      console.error(`Could not enqueue prune task : ${error.message}`)
    }
  }
}

// Retrieved new audit log data since LAST_AUDIT_AT_PROCESSED and
// creates/updates balance check redis keys as needed
async function pollForNewAuditDataAsync () {
  const LAST_AUDIT_AT_PROCESSED_KEY = 'AuditProducer:BalanceChecks:LastAuditAtProcessed'

  try {
    // retrieve the LAST_AUDIT_AT_PROCESSED_KEY value
    let lastAuditAtProcessed = await redis.get(LAST_AUDIT_AT_PROCESSED_KEY)
    if (lastAuditAtProcessed == null) {
      // this value has not been initialized yet, set to 45 minutes ago
      lastAuditAtProcessed = Date.now() - 45 * 60 * 1000
    }

    // retrieve all log entries since LAST_AUDIT_AT_PROCESSED
    let logItems = await NodeAuditLog.findAll({ where: { auditAt: { [Op.gt]: lastAuditAtProcessed } }, attributes: ['tntAddr', 'auditAt', 'tntBalanceGrains', 'tntBalancePass'], order: [['auditAt', 'ASC']], raw: true })
    if (!logItems || logItems.length === 0) return
    lastAuditAtProcessed = logItems[logItems.length - 1].auditAt

    // only keep log items where the balance check has passed
    logItems = logItems.filter((logItem) => logItem.tntBalancePass)

    // for all log items, if the balance check passed, add/refresh a 24 hour lived value in redis confirming the pass
    let multi = redis.multi()

    logItems.forEach((logItem) => {
      multi.set(`${env.BALANCE_CHECK_KEY_PREFIX}:${logItem.tntAddr}`, logItem.tntBalanceGrains, 'EX', BALANCE_PASS_EXPIRE_MINUTES * 60)
    })

    // finally, update LAST_AUDIT_AT_PROCESSED_KEY to the value of the most recent audit_at value in logItems
    multi.set(LAST_AUDIT_AT_PROCESSED_KEY, lastAuditAtProcessed)

    await multi.exec()
    if (logItems.length > 0) console.log(`${logItems.length} Node balance check Redis entries added/refreshed.`)
  } catch (error) {
    console.error(`An error occurred while polling for new audit data and creating balance check entries in: ${error.message}`)
  }
}

/**
 * Opens a storage connection
 **/
async function openStorageConnectionAsync () {
  let modelSqlzArray = [
    nodeAuditSequelize,
    calBlockSequelize,
    regNodeSequelize,
    cachedAuditChallenge.getAuditChallengeSequelize()
  ]
  await connections.openStorageConnectionAsync(modelSqlzArray)
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
      initResqueQueueAsync()
    }, () => {
      redis = null
      cachedAuditChallenge.setRedis(null)
      taskQueue = null
      setTimeout(() => { openRedisConnection(redisURIs) }, 5000)
    })
}

async function performLeaderElection () {
  IS_LEADER = false
  connections.performLeaderElection(leaderElection,
    env.AUDIT_PRODUCER_LEADER_KEY, env.CONSUL_HOST, env.CONSUL_PORT, env.CHAINPOINT_CORE_BASE_URI,
    () => { IS_LEADER = true },
    () => { IS_LEADER = false }
  )
}

async function checkForGenesisBlockAsync () {
  let genesisBlock
  while (!genesisBlock) {
    try {
      genesisBlock = await CalendarBlock.findOne({ where: { id: 0 } })
      // if the genesis block does not exist, wait 5 seconds and try again
      if (!genesisBlock) await utils.sleep(5000)
    } catch (error) {
      console.error(`Unable to query calendar: ${error.message}`)
      process.exit(1)
    }
  }
  console.log(`Genesis block found, calendar confirmed to exist`)
}

/**
 * Initializes the connection to the Resque queue when Redis is ready
 */
async function initResqueQueueAsync () {
  taskQueue = await connections.initResqueQueueAsync(redis, 'resque')
}

// This initializes the JS intervals that checks for new audit data
function startIntervals () {
  let intervals = [{ function: pollForNewAuditDataAsync, ms: 60000 }]
  connections.startIntervals(intervals)
}

function setGenerateNewChallengeTrigger () {
  let currentMinute = new Date().getUTCMinutes()

  // determine the minutes of the hour to run process based on NEW_AUDIT_CHALLENGES_PER_HOUR
  let newChallengeMinutes = []
  let minuteOfHour = 0
  while (minuteOfHour < 60) {
    newChallengeMinutes.push(minuteOfHour)
    minuteOfHour += (60 / env.NEW_AUDIT_CHALLENGES_PER_HOUR)
  }

  heart.createEvent(1, async function (count, last) {
    let now = new Date()

    // if we are on a new minute
    if (now.getUTCMinutes() !== currentMinute) {
      currentMinute = now.getUTCMinutes()
      if (newChallengeMinutes.includes(currentMinute) && IS_LEADER) {
        try {
          await generateAuditChallengeAsync()
        } catch (error) {
          console.error('generateAuditChallengeAsync err: ', error.message)
        }
      }
    }
  })
}

function setPerformNodeAuditTrigger () {
  let currentMinute = new Date().getUTCMinutes()

  // determine the minutes of the hour to run process based on NODE_AUDIT_ROUNDS_PER_HOUR
  let nodeAuditRoundsMinutes = []
  let minuteOfHour = 0
  // offset interval to spread the work around the clock a little bit,
  // to prevent everything from happening at the top of the hour
  let offset = Math.floor((60 / env.NODE_AUDIT_ROUNDS_PER_HOUR) / 2)
  while (minuteOfHour < 60) {
    let offsetMinutes = minuteOfHour + offset + ((minuteOfHour + offset) < 60 ? 0 : -60)
    nodeAuditRoundsMinutes.push(offsetMinutes)
    minuteOfHour += (60 / env.NODE_AUDIT_ROUNDS_PER_HOUR)
  }

  heart.createEvent(1, async function (count, last) {
    let now = new Date()

    // if we are on a new minute
    if (now.getUTCMinutes() !== currentMinute) {
      currentMinute = now.getUTCMinutes()
      if (nodeAuditRoundsMinutes.includes(currentMinute) && IS_LEADER) {
        try {
          await auditNodesAsync()
        } catch (error) {
          console.error(`auditNodesAsync : error : ${error.message}`)
        }
      }
    }
  })
}

function setPerformE2ENodeAuditTrigger () {
  let currentDay = new Date().getUTCDate()

  heart.createEvent(5, async function (count, last) {
    let now = new Date()
    // Run e2eAuditNodesAsync() once a day, and only if we are on a new day
    if (now.getUTCDate() !== currentDay && IS_LEADER) {
      currentDay = now.getUTCDate()
      try {
        await auditNodesAsync({ e2eAudit: true })
      } catch (error) {
        console.error(`e2eAuditNodesAsync : error : ${error.message}`)
      }
    }
  })
}

function setPerformCreditTopoffTrigger () {
  let currentDay = new Date().getUTCDate()

  heart.createEvent(5, async function (count, last) {
    let now = new Date()

    // if we are on a new day
    if (now.getUTCDate() !== currentDay) {
      currentDay = now.getUTCDate()
      await performCreditTopoffAsync(creditTopoffAmount)
    }
  })
}

async function setTimedTriggeredEventsAsync () {
  // attempt to generate a new audit challenge on startup
  if (IS_LEADER) {
    try {
      await generateAuditChallengeAsync()
    } catch (error) {
      console.error('generateAuditChallengeAsync err: ', error.message)
    }
  }

  setGenerateNewChallengeTrigger()
  setPerformNodeAuditTrigger()
  setPerformE2ENodeAuditTrigger()
  setPerformCreditTopoffTrigger()
}

// process all steps need to start the application
async function start () {
  if (env.NODE_ENV === 'test') return
  try {
    // init consul
    consul = connections.initConsul(cnsl, env.CONSUL_HOST, env.CONSUL_PORT)
    cachedAuditChallenge.setConsul(consul)
    // init DB
    await openStorageConnectionAsync()
    // init Redis
    openRedisConnection(env.REDIS_CONNECT_URIS)
    // init consul and perform leader election
    performLeaderElection()
    // ensure at least 1 calendar block exist
    await checkForGenesisBlockAsync()
    // init interval functions
    startIntervals()
    // start main processing
    await setTimedTriggeredEventsAsync()
    console.log('startup completed successfully')
  } catch (error) {
    console.error(`An error has occurred on startup: ${error.message}`)
    process.exit(1)
  }
}

// get the whole show started
start()
