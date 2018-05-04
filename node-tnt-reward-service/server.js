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
const env = require('./lib/parse-env.js')('tnt-reward')

const tntUnits = require('./lib/tntUnits.js')
const amqp = require('amqplib')
const calendarBlock = require('./lib/models/CalendarBlock.js')
const registeredCore = require('./lib/models/RegisteredCore.js')
const registeredNode = require('./lib/models/RegisteredNode.js')
const csprng = require('random-number-csprng')
const heartbeats = require('heartbeats')
const leaderElection = require('exp-leader-election')
const connections = require('./lib/connections.js')

// The channel used for all amqp communication
// This value is set once the connection has been established
let amqpChannel = null

// The leadership status for this instance of the reward service
let IS_LEADER = false

// create a heartbeat for every 200ms
// 1 second heartbeats had a drift that caused occasional skipping of a whole second
// decreasing the interval of the heartbeat and checking current time resolves this
let heart = heartbeats.createHeart(200)

// Array of Nodes not eligible to receive rewards under any circumstances
// Initially, this represents all Tierion hosted Nodes
let NODE_REWARD_TNT_ADDR_BLACKLIST = [
  '0xB432aD51fF09623F37690b5C14e7fDdee21A8952'.toLowerCase(),
  '0xF659ed20A589371AD0857f08d9869f6e0cf6625e'.toLowerCase(),
  '0x644CC32cf0Fa4A747c478BD43D1cAce2B3D0c1b9'.toLowerCase(),
  '0xbEAE24B9e07AE50936b582Ce7f75E996f1046436'.toLowerCase(),
  '0x7B37B300C1ED5F6BaE302611789Cb60b3F5A6463'.toLowerCase(),
  '0x444b1B76da517281ef92bc6689C0108b5074addf'.toLowerCase()
]

// pull in variables defined in shared database models
let calBlockSequelize = calendarBlock.sequelize
let CalendarBlock = calendarBlock.CalendarBlock
let registeredCoreSequelize = registeredCore.sequelize
let RegisteredCore = registeredCore.RegisteredCore
let registeredNodeSequelize = registeredNode.sequelize
let RegisteredNode = registeredNode.RegisteredNode
let Op = registeredNodeSequelize.Op

const REWARD_SELECTION_COUNT = 100 // Selecting from the top 100 of audit scores

// Randomly select and deliver token reward from the list
// of registered nodes that meet the minimum audit and TNT balance
// eligibility requirements for receiving TNT rewards
async function performRewardAsync () {
  let candidateNodeAddresses
  try {
    // retrieve a list of the top REWARD_SELECTION_PC public Nodes
    candidateNodeAddresses = await RegisteredNode.findAll({ where: { publicUri: { [Op.ne]: null }, tntAddr: { [Op.notIn]: NODE_REWARD_TNT_ADDR_BLACKLIST } }, attributes: ['tntAddr'], order: [['auditScore', 'DESC'], ['created_at', 'ASC']], limit: REWARD_SELECTION_COUNT })
    if (!candidateNodeAddresses || candidateNodeAddresses.length < 1) {
      console.log('No reward candidiate Nodes were found')
      return
    } else {
      console.log(`${candidateNodeAddresses.length} reward candidiate Nodes were retrieved`)
    }
  } catch (error) {
    let message = `Could not retrieve top scoring Nodes : ${error.message}`
    throw new Error(message)
  }

  // randomly select reward recipient from candidate Nodes
  let rewardIndex = candidateNodeAddresses.length === 1 ? 0 : await csprng(0, candidateNodeAddresses.length - 1)
  let rewardTNTAddr = candidateNodeAddresses[rewardIndex].tntAddr

  // calculate reward share between Node and Core (if applicable)
  let calculatedShares
  try {
    calculatedShares = await calculateCurrentRewardShares()
  } catch (error) {
    let message = `Unable to calculate reward shares: ${error.message}`
    throw new Error(message)
  }

  let nodeTNTGrainsRewardShare = calculatedShares.nodeTNTGrainsRewardShare
  let coreTNTGrainsRewardShare = calculatedShares.coreTNTGrainsRewardShare
  let coreRewardEthAddr = null
  // Determine Core to award, based on that which created the most recent btc-a block
  let selectedCoreStackId = null
  try {
    let lastBtcAnchorBlock = await CalendarBlock.findOne({ where: { type: 'btc-a' }, attributes: ['id', 'stackId'], order: [['id', 'DESC']] })
    if (lastBtcAnchorBlock) selectedCoreStackId = lastBtcAnchorBlock.stackId
  } catch (error) {
    let message = `Unable to query recent btc-a block: ${error.message}`
    throw new Error(message)
  }
  // Get registered Core data for the Core having selectedCoreStackId
  try {
    let selectedCore = await RegisteredCore.findOne({ where: { stackId: selectedCoreStackId } })
    if (selectedCore && selectedCore.rewardEligible) {
      coreRewardEthAddr = selectedCore.tntAddr
    }
  } catch (error) {
    let message = `Unable to query registered core table: ${error.message}`
    throw new Error(message)
  }
  // if the Core is not receiving a reward, distribute Core's share to the Node
  if (!coreRewardEthAddr) {
    nodeTNTGrainsRewardShare = calculatedShares.totalTNTGrainsReward
    coreTNTGrainsRewardShare = 0
  }

  console.log(`${rewardTNTAddr} selected for this reward period`)

  // send reward calculation message to Calendar
  let messageObj = {}
  messageObj.node = {}
  messageObj.node.address = rewardTNTAddr
  messageObj.node.amount = nodeTNTGrainsRewardShare
  if (coreTNTGrainsRewardShare > 0) {
    messageObj.core = {}
    messageObj.core.address = coreRewardEthAddr
    messageObj.core.amount = coreTNTGrainsRewardShare
  }

  try {
    await amqpChannel.sendToQueue(env.RMQ_WORK_OUT_CAL_QUEUE, Buffer.from(JSON.stringify(messageObj)), { persistent: true, type: 'reward' })
    // console.log(env.RMQ_WORK_OUT_CAL_QUEUE, '[reward] publish message acked')
  } catch (error) {
    let message = `${env.RMQ_WORK_OUT_CAL_QUEUE} [reward] publish message nacked`
    throw new Error(message)
  }

  // finally, now that we've sent the reward off to the next service for processing,
  // we must reset the rewarded Node's audit score back to 0
  try {
    await RegisteredNode.update({ auditScore: 0 }, { where: { tntAddr: rewardTNTAddr } })
  } catch (error) {
    let message = `Could not reset audit score to 0 for Node with TNT address ${rewardTNTAddr} : ${error.message}`
    throw new Error(message)
  }
}

/**
 * Calculates the Node and Core reward shares for the current TNT reward Epoch
 *
 * @returns an object containing reward share number in TNT grains
 *
 * {
 *  nodeTNTGrainsRewardShare: integer,
 *  coreTNTGrainsRewardShare: integer,
 *  totalTNTGrainsReward: integer
 * }
 */
async function calculateCurrentRewardShares () {
  /*
  // get current reward period count
  let rewardBlockCount
  try {
    rewardBlockCount = await CalendarBlock.count({ where: { type: 'reward' } })
  } catch (error) {
    throw new Error(`Unable to query reward block count: ${error.message}`)
  }
  */

  // Trigger the new reward amount to be set automatically
  // after a specified time.
  let nextIncreaseTime = new Date('2018-02-28T22:00:00.000Z')
  let now = new Date()

  let nodeTNTRewardShare
  let coreTNTRewardShare

  if (now >= nextIncreaseTime) {
    nodeTNTRewardShare = 1500
    coreTNTRewardShare = 0
  } else {
    nodeTNTRewardShare = 1250
    coreTNTRewardShare = 0
  }

  /*
  switch (true) {
    case (rewardBlockCount < 9600):
      nodeTNTRewardShare = 6210.30
      coreTNTRewardShare = 326.86
      break
    case (rewardBlockCount < 19200):
      nodeTNTRewardShare = 4968.28
      coreTNTRewardShare = 261.49
      break
    case (rewardBlockCount < 28800):
      nodeTNTRewardShare = 3974.66
      coreTNTRewardShare = 209.19
      break
    case (rewardBlockCount < 38400):
      nodeTNTRewardShare = 3179.76
      coreTNTRewardShare = 167.36
      break
    case (rewardBlockCount < 48000):
      nodeTNTRewardShare = 2543.85
      coreTNTRewardShare = 133.89
      break
    case (rewardBlockCount < 57600):
      nodeTNTRewardShare = 2035.11
      coreTNTRewardShare = 107.11
      break
    case (rewardBlockCount < 67200):
      nodeTNTRewardShare = 1628.13
      coreTNTRewardShare = 85.69
      break
    case (rewardBlockCount < 76800):
      nodeTNTRewardShare = 1302.54
      coreTNTRewardShare = 68.55
      break
    case (rewardBlockCount < 86400):
      nodeTNTRewardShare = 1042.07
      coreTNTRewardShare = 54.85
      break
    case (rewardBlockCount < 96000):
      nodeTNTRewardShare = 833.69
      coreTNTRewardShare = 43.88
      break
    case (rewardBlockCount < 105600):
      nodeTNTRewardShare = 666.99
      coreTNTRewardShare = 35.10
      break
    case (rewardBlockCount < 115200):
      nodeTNTRewardShare = 533.63
      coreTNTRewardShare = 28.09
      break
    case (rewardBlockCount < 124800):
      nodeTNTRewardShare = 426.94
      coreTNTRewardShare = 22.47
      break
    case (rewardBlockCount < 134400):
      nodeTNTRewardShare = 341.59
      coreTNTRewardShare = 17.98
      break
  }
  */
  let nodeTNTGrainsRewardShare = tntUnits.tntToGrains(nodeTNTRewardShare)
  let coreTNTGrainsRewardShare = tntUnits.tntToGrains(coreTNTRewardShare)
  return {
    nodeTNTGrainsRewardShare: nodeTNTGrainsRewardShare,
    coreTNTGrainsRewardShare: coreTNTGrainsRewardShare,
    totalTNTGrainsReward: nodeTNTGrainsRewardShare + coreTNTGrainsRewardShare
  }
}

/**
 * Opens an AMPQ connection and channel
 * Retry logic is included to handle losses of connection
 *
 * @param {string} connectURI - The connection URI for the RabbitMQ instance
 */
async function openRMQConnectionAsync (connectURI) {
  await connections.openStandardRMQConnectionAsync(amqp, connectURI,
    [env.RMQ_WORK_OUT_CAL_QUEUE],
    null,
    null,
    (chan) => { amqpChannel = chan },
    () => {
      amqpChannel = null
      setTimeout(() => { openRMQConnectionAsync(connectURI) }, 5000)
    }
  )
}

async function performLeaderElection () {
  IS_LEADER = false
  connections.performLeaderElection(leaderElection,
    env.REWARDS_LEADER_KEY, env.CONSUL_HOST, env.CONSUL_PORT, null,
    () => { IS_LEADER = true },
    () => { IS_LEADER = false }
  )
}

/**
 * Opens a storage connection
 **/
async function openStorageConnectionAsync () {
  let modelSqlzArray = [
    calBlockSequelize,
    registeredCoreSequelize,
    registeredNodeSequelize
  ]
  await connections.openStorageConnectionAsync(modelSqlzArray)
}

/**
 * Check to be sure this Core is registered and will
 * register the Core if it is not.
 **/
async function registerCoreAsync () {
  // Get registered Core data for the Core having stackId = CHAINPOINT_CORE_BASE_URI
  let currentCore
  try {
    currentCore = await RegisteredCore.findOne({ where: { stackId: env.CHAINPOINT_CORE_BASE_URI } })
  } catch (error) {
    throw new Error(`Unable to query registered core table: ${error.message}`)
  }
  if (!currentCore) {
    // the current Core is not registered, so add it to the registration table
    let newCore = {
      stackId: env.CHAINPOINT_CORE_BASE_URI,
      tntAddr: env.CORE_REWARD_ETH_ADDR,
      rewardEligible: env.CORE_REWARD_ELIGIBLE
    }
    try {
      let regCore = await RegisteredCore.create(newCore)
      console.log(`Core ${regCore.stackId} successfully registered`)
    } catch (error) {
      throw new Error(`Unable to register core: ${error.message}`)
    }
  } else {
    console.log(`Core ${currentCore.stackId} registration found`)
  }
}

// Set the TNT Reward interval
function setTNTRewardInterval () {
  let currentMinute = new Date().getUTCMinutes()

  // determine the minutes of the hour to run process based on REWARDS_PER_HOUR
  let rewardMinutes = []
  let minuteOfHour = 0
  while (minuteOfHour < 60) {
    rewardMinutes.push(minuteOfHour)
    minuteOfHour += (60 / env.REWARDS_PER_HOUR)
  }

  heart.createEvent(1, async function (count, last) {
    let now = new Date()

    // if we are on a new minute
    if (now.getUTCMinutes() !== currentMinute) {
      currentMinute = now.getUTCMinutes()
      if (rewardMinutes.includes(currentMinute) && IS_LEADER) {
        try {
          await performRewardAsync()
        } catch (error) {
          console.error(`performRewardAsync  : error : ${error.message}`)
        }
      }
    }
  })
}

// process all steps need to start the application
async function start () {
  if (env.NODE_ENV === 'test') return
  try {
    // init rabbitMQ
    await openRMQConnectionAsync(env.RABBITMQ_CONNECT_URI)
    // init consul and perform leader election
    performLeaderElection()
    // init DB
    await openStorageConnectionAsync()
    // Check Core registration
    await registerCoreAsync()
    // init interval functions
    setTNTRewardInterval()
    console.log('startup completed successfully')
  } catch (error) {
    console.error(`An error has occurred on startup: ${error.message}`)
    process.exit(1)
  }
}

// get the whole show started
start()
