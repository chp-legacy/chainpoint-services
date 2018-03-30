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

const crypto = require('crypto')
const restify = require('restify')
const _ = require('lodash')
const moment = require('moment')
var validUrl = require('valid-url')
const registeredNode = require('../models/RegisteredNode.js')
const nodeAuditLog = require('../models/NodeAuditLog.js')
const url = require('url')
const ip = require('ip')
const utils = require('../utils.js')
const semver = require('semver')
const rp = require('request-promise-native')
const tntUnits = require('../tntUnits.js')

const env = require('../parse-env.js')('api')

let registeredNodeSequelize = registeredNode.sequelize
let RegisteredNode = registeredNode.RegisteredNode
let nodeAuditLogSequelize = nodeAuditLog.sequelize
let NodeAuditLog = nodeAuditLog.NodeAuditLog
let Op = registeredNodeSequelize.Op

// This value is set once the connection has been established
let taskQueue = null

// The maximum  number of registered Nodes allowed
// This value is updated from consul events as changes are detected
let regNodesLimit = 0

// The number of results to return when responding to a random nodes query
const RANDOM_NODES_RESULT_LIMIT = 5

// The number of recent audit log entries to return
const AUDIT_HISTORY_COUNT = 10 // at current rate, 5 hours worth

// The minimium TNT grains required to operate a Node
const minGrainsBalanceNeeded = env.MIN_TNT_GRAINS_BALANCE_FOR_REWARD

// validate eth address is well formed
let isEthereumAddr = (address) => {
  return /^0x[0-9a-fA-F]{40}$/i.test(address)
}

let isHMAC = (hmac) => {
  return /^[0-9a-fA-F]{64}$/i.test(hmac)
}

/**
 * GET /nodes/:tnt_addr retrieve handler
 *
 * Retrieve an existing registered Node
 */
async function getNodeByTNTAddrV1Async (req, res, next) {
  if (!req.params.hasOwnProperty('tnt_addr')) {
    return next(new restify.InvalidArgumentError('invalid JSON body, missing tnt_addr'))
  }

  if (_.isEmpty(req.params.tnt_addr)) {
    return next(new restify.InvalidArgumentError('invalid JSON body, empty tnt_addr'))
  }

  let lowerCasedTntAddrParam
  if (!isEthereumAddr(req.params.tnt_addr)) {
    return next(new restify.InvalidArgumentError('invalid JSON body, malformed tnt_addr'))
  } else {
    lowerCasedTntAddrParam = req.params.tnt_addr.toLowerCase()
  }

  /*

  This endpoint with be publicly accessible, reserving hmac code here if we decide to restore auth

  if (!req.params.hasOwnProperty('hmac')) {
    return next(new restify.InvalidArgumentError('invalid JSON body, missing hmac'))
  }

  if (_.isEmpty(req.params.hmac)) {
    return next(new restify.InvalidArgumentError('invalid JSON body, empty hmac'))
  }

  if (!isHMAC(req.params.hmac)) {
    return next(new restify.InvalidArgumentError('invalid JSON body, invalid hmac'))
  }
  */

  let regNode
  let recentAudits
  try {
    regNode = await RegisteredNode.findOne({ where: { tntAddr: lowerCasedTntAddrParam } })
    if (!regNode) {
      res.status(404)
      res.noCache()
      res.send({ code: 'NotFoundError', message: '' })
      return next()
    }
  } catch (error) {
    console.error(`Could not retrieve RegisteredNode: ${error.message}`)
    return next(new restify.InternalServerError('could not retrieve RegisteredNode'))
  }

  try {
    recentAudits = await NodeAuditLog.findAll({ where: { tntAddr: lowerCasedTntAddrParam }, attributes: ['auditAt', 'publicIPPass', 'timePass', 'calStatePass', 'minCreditsPass'], order: [['auditAt', 'DESC']], limit: AUDIT_HISTORY_COUNT })
  } catch (error) {
    console.error(`Could not retrieve NodeAuditLog items: ${error.message}`)
    return next(new restify.InternalServerError('could not retrieve NodeAuditLog items'))
  }

  let result = {
    recent_audits: recentAudits.map((audit) => {
      return {
        time: parseInt(audit.auditAt),
        public_ip_test: audit.publicIPPass,
        time_test: audit.timePass,
        calendar_state_test: audit.calStatePass,
        minimum_credits_test: audit.minCreditsPass
      }
    })
  }

  res.cache('public', { maxAge: 900 })
  res.send(result)
  return next()
}

/**
 * GET /nodes retrieve handler
 *
 * Retrieve a random subset of registered and healthy Nodes
 */
async function getNodesRandomV1Async (req, res, next) {
  // get a list of random healthy Nodes
  let regNodesTableName = RegisteredNode.getTableName()
  let nodeAuditLogTableName = NodeAuditLog.getTableName()
  let thirtyMinutesAgo = Date.now() - 30 * 60 * 1000
  let sqlQuery = `SELECT rn.public_uri FROM ${regNodesTableName} rn 
                  WHERE rn.public_uri IS NOT NULL AND rn.tnt_addr IN (
                    SELECT DISTINCT al.tnt_addr FROM ${nodeAuditLogTableName} al 
                    WHERE tnt_addr IS NOT NULL AND al.public_ip_pass = TRUE AND al.time_pass = TRUE AND al.cal_state_pass = TRUE AND al.min_credits_pass = true AND al.node_version_pass = true AND al.audit_at >= ${thirtyMinutesAgo}
                  )
                  ORDER BY RANDOM() LIMIT ${RANDOM_NODES_RESULT_LIMIT}`
  let rndNodes = await registeredNodeSequelize.query(sqlQuery, { type: registeredNodeSequelize.QueryTypes.SELECT })

  // build well formatted result array
  rndNodes = rndNodes.map((rndNode) => {
    return {
      public_uri: rndNode.public_uri
    }
  })

  res.cache('public', { maxAge: 60 })

  // randomize results order, limit, and send
  res.send(rndNodes)
  return next()
}

/**
 * GET /nodes/blacklist retrieve handler
 *
 * Retrieve an IP blacklist that can be pulled by Nodes to
 * block connnections from abusive IPs
 */
async function getNodesBlacklistV1Async (req, res, next) {
  let list = { blacklist: [] }
  res.cache('public', { maxAge: 600 })
  res.send(list)
  return next()
}

/**
 * POST /node create handler
 *
 * Create a new registered Node
 */
async function postNodeV1Async (req, res, next) {
  if (req.contentType() !== 'application/json') {
    return next(new restify.InvalidArgumentError('invalid content type'))
  }

  let minNodeVersionOK = false
  if (req.headers && req.headers['x-node-version']) {
    let nodeVersion = req.headers['x-node-version']
    try {
      minNodeVersionOK = semver.satisfies(nodeVersion, `>=${env.MIN_NODE_VERSION_NEW}`)
    } catch (error) {
      return next(new restify.UpgradeRequiredError(`Node version ${env.MIN_NODE_VERSION_NEW} or greater required`))
    }
  }
  if (!minNodeVersionOK) {
    return next(new restify.UpgradeRequiredError(`Node version ${env.MIN_NODE_VERSION_NEW} or greater required`))
  }

  if (!req.params.hasOwnProperty('tnt_addr')) {
    return next(new restify.InvalidArgumentError('invalid JSON body, missing tnt_addr'))
  }

  if (_.isEmpty(req.params.tnt_addr)) {
    return next(new restify.InvalidArgumentError('invalid JSON body, empty tnt_addr'))
  }

  let lowerCasedTntAddrParam
  if (!isEthereumAddr(req.params.tnt_addr)) {
    return next(new restify.InvalidArgumentError('invalid JSON body, malformed tnt_addr'))
  } else {
    lowerCasedTntAddrParam = req.params.tnt_addr.toLowerCase()
  }

  let lowerCasedPublicUri = req.params.public_uri ? req.params.public_uri.toString().toLowerCase() : null
  // if an public_uri is provided, it must be valid
  if (lowerCasedPublicUri && !_.isEmpty(lowerCasedPublicUri)) {
    if (!validUrl.isWebUri(lowerCasedPublicUri)) {
      return next(new restify.InvalidArgumentError('invalid JSON body, invalid public_uri'))
    }

    let parsedPublicUri = url.parse(lowerCasedPublicUri)
    // ensure that hostname is an IP
    if (!utils.isIP(parsedPublicUri.hostname)) return next(new restify.InvalidArgumentError('public_uri hostname must be an IP'))
    // ensure that it is not a private IP
    if (ip.isPrivate(parsedPublicUri.hostname)) return next(new restify.InvalidArgumentError('public_uri hostname must not be a private IP'))
    // disallow 0.0.0.0
    if (parsedPublicUri.hostname === '0.0.0.0') return next(new restify.InvalidArgumentError('0.0.0.0 not allowed in public_uri'))
  }

  try {
    let count = await RegisteredNode.count({ where: { tntAddr: lowerCasedTntAddrParam } })
    if (count >= 1) {
      return next(new restify.ConflictError('the Ethereum address provided is already registered'))
    }
  } catch (error) {
    console.error(`Unable to count registered Nodes: ${error.message}`)
    return next(new restify.InternalServerError('unable to count registered Nodes'))
  }

  if (lowerCasedPublicUri && !_.isEmpty(lowerCasedPublicUri)) {
    try {
      let count = await RegisteredNode.count({ where: { publicUri: lowerCasedPublicUri } })
      if (count >= 1) {
        return next(new restify.ConflictError('the public URI provided is already registered'))
      }
    } catch (error) {
      console.error(`Unable to count registered Nodes: ${error.message}`)
      return next(new restify.InternalServerError('unable to count registered Nodes'))
    }
  }

  // check to see if the Node has the min balance required for Node operation
  try {
    let nodeBalance = await getTNTGrainsBalanceForAddressAsync(lowerCasedTntAddrParam)
    if (nodeBalance < minGrainsBalanceNeeded) {
      let minTNTBalanceNeeded = tntUnits.grainsToTNT(minGrainsBalanceNeeded)
      return next(new restify.ForbiddenError(`TNT address ${lowerCasedTntAddrParam} does not have the minimum balance of ${minTNTBalanceNeeded} TNT for Node operation`))
    }
  } catch (error) {
    return next(new restify.InternalServerError(`unable to check address balance: ${error.message}`))
  }

  // Do the registered Node count last to be as close to the creation of the record
  // as possible and avoid overrages to the extent we can.
  try {
    let totalCount = await RegisteredNode.count()
    if (totalCount >= regNodesLimit) {
      return next(new restify.ForbiddenError('Maximum number of Node registrations has been reached'))
    }
  } catch (error) {
    console.error(`Unable to count registered Nodes: ${error.message}`)
    return next(new restify.InternalServerError('unable to count registered Nodes'))
  }

  let randHMACKey = crypto.randomBytes(32).toString('hex')

  let newNode
  try {
    newNode = await RegisteredNode.create({
      tntAddr: lowerCasedTntAddrParam,
      publicUri: lowerCasedPublicUri,
      hmacKey: randHMACKey,
      tntCredit: 86400
    })
  } catch (error) {
    console.error(`Could not create RegisteredNode for ${lowerCasedTntAddrParam} at ${lowerCasedPublicUri}: ${error.message}`)
    return next(new restify.InternalServerError(`could not create RegisteredNode for ${lowerCasedTntAddrParam} at ${lowerCasedPublicUri}`))
  }

  res.send({
    tnt_addr: newNode.tntAddr,
    public_uri: newNode.publicUri,
    hmac_key: newNode.hmacKey
  })
  return next()
}

/**
 * PUT /node/:tnt_addr update handler
 *
 * Updates an existing registered Node
 */
async function putNodeV1Async (req, res, next) {
  if (req.contentType() !== 'application/json') {
    return next(new restify.InvalidArgumentError('invalid content type'))
  }

  let minNodeVersionOK = false
  if (req.headers && req.headers['x-node-version']) {
    let nodeVersion = req.headers['x-node-version']
    try {
      minNodeVersionOK = semver.satisfies(nodeVersion, `>=${env.MIN_NODE_VERSION_EXISTING}`)
    } catch (error) {
      return next(new restify.UpgradeRequiredError(`Node version ${env.MIN_NODE_VERSION_EXISTING} or greater required`))
    }
  }
  if (!minNodeVersionOK) {
    return next(new restify.UpgradeRequiredError(`Node version ${env.MIN_NODE_VERSION_EXISTING} or greater required`))
  }

  if (!req.params.hasOwnProperty('tnt_addr')) {
    return next(new restify.InvalidArgumentError('invalid JSON body, missing tnt_addr'))
  }

  if (_.isEmpty(req.params.tnt_addr)) {
    return next(new restify.InvalidArgumentError('invalid JSON body, empty tnt_addr'))
  }

  let lowerCasedTntAddrParam
  if (!isEthereumAddr(req.params.tnt_addr)) {
    return next(new restify.InvalidArgumentError('invalid JSON body, malformed tnt_addr'))
  } else {
    lowerCasedTntAddrParam = req.params.tnt_addr.toLowerCase()
  }

  let lowerCasedPublicUri = req.params.public_uri ? req.params.public_uri.toString().toLowerCase() : null
  // if an public_uri is provided, it must be valid
  if (lowerCasedPublicUri && !_.isEmpty(lowerCasedPublicUri)) {
    if (!validUrl.isWebUri(lowerCasedPublicUri)) {
      return next(new restify.InvalidArgumentError('invalid JSON body, invalid public_uri'))
    }
    let parsedPublicUri = url.parse(lowerCasedPublicUri)
    // ensure that hostname is an IP
    if (!utils.isIP(parsedPublicUri.hostname)) return next(new restify.InvalidArgumentError('public_uri hostname must be an IP'))
    // ensure that it is not a private IP
    if (ip.isPrivate(parsedPublicUri.hostname)) return next(new restify.InvalidArgumentError('public_uri hostname must not be a private IP'))
    // disallow 0.0.0.0
    if (parsedPublicUri.hostname === '0.0.0.0') return next(new restify.InvalidArgumentError('0.0.0.0 not allowed in public_uri'))

    try {
      let count = await RegisteredNode.count({ where: { publicUri: lowerCasedPublicUri, tntAddr: { [Op.ne]: lowerCasedTntAddrParam } } })
      if (count >= 1) {
        return next(new restify.ConflictError('the public URI provided is already registered'))
      }
    } catch (error) {
      console.error(`Unable to count registered Nodes: ${error.message}`)
      return next(new restify.InternalServerError('unable to count registered Nodes'))
    }
  }

  if (!req.params.hasOwnProperty('hmac')) {
    return next(new restify.InvalidArgumentError('invalid JSON body, missing hmac'))
  }

  if (_.isEmpty(req.params.hmac)) {
    return next(new restify.InvalidArgumentError('invalid JSON body, empty hmac'))
  }

  if (!isHMAC(req.params.hmac)) {
    return next(new restify.InvalidArgumentError('invalid JSON body, invalid hmac'))
  }

  try {
    let regNode = await RegisteredNode.find({ where: { tntAddr: lowerCasedTntAddrParam } })
    if (!regNode) {
      res.status(404)
      res.noCache()
      res.send({ code: 'NotFoundError', message: 'could not find registered Node' })
      return next()
    }

    // HMAC-SHA256(hmac-key, TNT_ADDRESS|IP|YYYYMMDDHHmm)
    // Forces Nodes to be within +/- 1 min of Core to generate a valid HMAC
    let formattedDateInt = parseInt(moment().utc().format('YYYYMMDDHHmm'))
    let acceptableHMACs = []
    // build an array af acceptable hmac values with -1 minute, current minute, +1 minute
    for (let x = -1; x <= 1; x++) {
      // use req.params.tnt_addr below instead of lowerCasedTntAddrParam to preserve
      // formatting submitted from Node and used in that Node's calculation
      // use req.params.public_uri below instead of lowerCasedPublicUri to preserve
      // formatting submitted from Node and used in that Node's calculation
      let formattedTimeString = (formattedDateInt + x).toString()
      let hmacTxt = [req.params.tnt_addr, req.params.public_uri, formattedTimeString].join('')
      let calculatedHMAC = crypto.createHmac('sha256', regNode.hmacKey).update(hmacTxt).digest('hex')
      acceptableHMACs.push(calculatedHMAC)
    }
    if (!_.includes(acceptableHMACs, req.params.hmac)) {
      return next(new restify.InvalidArgumentError('Invalid authentication HMAC provided - Try NTP sync'))
    }

    if (lowerCasedPublicUri == null || _.isEmpty(lowerCasedPublicUri)) {
      regNode.publicUri = null
    } else {
      regNode.publicUri = lowerCasedPublicUri
    }

    // check to see if the Node has the min balance required for Node operation
    try {
      let nodeBalance = await getTNTGrainsBalanceForAddressAsync(lowerCasedTntAddrParam)
      if (nodeBalance < minGrainsBalanceNeeded) {
        let minTNTBalanceNeeded = tntUnits.grainsToTNT(minGrainsBalanceNeeded)
        return next(new restify.ForbiddenError(`TNT address ${lowerCasedTntAddrParam} does not have the minimum balance of ${minTNTBalanceNeeded} TNT for Node operation`))
      }
    } catch (error) {
      return next(new restify.InternalServerError(`unable to check address balance: ${error.message}`))
    }

    await regNode.save()
  } catch (error) {
    console.error(`Could not update RegisteredNode: ${error.message}`)
    return next(new restify.InternalServerError('could not update RegisteredNode'))
  }

  res.send({
    tnt_addr: lowerCasedTntAddrParam,
    public_uri: req.params.public_uri
  })
  return next()
}

/**
 * POST /node/balancetest handler
 *
 * Create a new registered Node
 */
async function postNodeBalanceTestV1Async (req, res, next) {
  if (req.contentType() !== 'application/json') {
    return next(new restify.InvalidArgumentError('invalid content type'))
  }

  if (!req.params.hasOwnProperty('count')) {
    return next(new restify.InvalidArgumentError('invalid JSON body, missing count'))
  }

  let count = parseInt(req.params.count)
  if (count < 1 || count > 10000 || isNaN(count)) {
    return next(new restify.InvalidArgumentError('count must be an integer between 1 and 10,000'))
  }

  // create an array of `count` size containing random TNT addresses from the tnt addr list
  let tntAddrs = []
  for (let x = 0; x < count; x++) {
    let rnd = Math.floor(Math.random() * 1000)
    tntAddrs.push(tntAddrList[rnd])
  }
  // Queue a check balance task for each of the addresses in that array
  tntAddrs.forEach(async (tntAddr) => {
    await taskQueue.enqueue('task-handler-queue', `TNT_balance_check`, [tntAddr])
  })

  res.send({
    message: 'OK',
    count: count
  })
  return next()
}

function updateRegNodesLimit (count) {
  try {
    let newRegNodesLimit = parseInt(count)
    if (!(newRegNodesLimit >= 0) || newRegNodesLimit === null) throw new Error('Bad regNodesLimit value')
    regNodesLimit = newRegNodesLimit
    console.log(`Registered Nodes limit updated to ${count}`)
  } catch (error) {
    // the regNodesLimit value being set must be bad
    console.error(error.message)
  }
}

let getTNTGrainsBalanceForAddressAsync = async (tntAddress) => {
  let ethTntTxUri = env.ETH_TNT_TX_CONNECT_URI

  let options = {
    headers: [
      {
        name: 'Content-Type',
        value: 'application/json'
      }
    ],
    method: 'GET',
    uri: `${ethTntTxUri}/balance/${tntAddress}`,
    json: true,
    gzip: true,
    timeout: 10000,
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

module.exports = {
  getRegisteredNodeSequelize: () => { return registeredNodeSequelize },
  getNodeAuditLogSequelize: () => { return nodeAuditLogSequelize },
  getNodesRandomV1Async: getNodesRandomV1Async,
  getNodesBlacklistV1Async: getNodesBlacklistV1Async,
  getNodeByTNTAddrV1Async: getNodeByTNTAddrV1Async,
  postNodeV1Async: postNodeV1Async,
  postNodeBalanceTestV1Async: postNodeBalanceTestV1Async,
  putNodeV1Async: putNodeV1Async,
  setNodesRegisteredNode: (regNode) => { RegisteredNode = regNode },
  setNodesNodeAuditLog: (nodeAuditLog) => { NodeAuditLog = nodeAuditLog },
  setRegNodesLimit: (val) => { updateRegNodesLimit(val) },
  setLimitDirect: (val) => { regNodesLimit = val },
  overrideGetTNTGrainsBalanceForAddressAsync: (func) => { getTNTGrainsBalanceForAddressAsync = func },
  setTaskQueue: (val) => { taskQueue = val }
}

let tntAddrList = [
  '0x50b389fc5a07e5ec335007267400aa8a2d89bcf1',
  '0x4c5cf7275bacf271512e02d966e751c2e34b3d85',
  '0x2f023b0aaf597457e49876e3becb5f9a013203a7',
  '0xf32166fbefb6f74c1f892b85fb69e594dd023706',
  '0x8777b12bbaf92cac8eda82d962e8744823cc2e90',
  '0x18b3a842cc645eeb466509055068dd62994c49e0',
  '0x3f4ab1f6773069b6ac04c669950442c15f5a257f',
  '0x6b7d727a482d56d090def613d2fecf5ec0079ee2',
  '0x390b3c56f66b00eada50ba38e8b49eacca64b98a',
  '0x58c6f9d07ae9806441e6605d3f2fed0814ea2e37',
  '0xee4f0666a34e7c6a80004dccd544a7d9f2c8cb1c',
  '0x5a970acfc99db067004edd47554c497efdeb4418',
  '0xcd651a1502c1ee4a1a1d51d590f76e94a7893b7a',
  '0xcc1e1f3fcd5ce632bbb1650e7d074412059625f0',
  '0xba55c191ed9ae5460738dafc999a51d3a58fba29',
  '0x3056aefd83f56055fb3b3eaae8fa7bf6e0dbc572',
  '0xa82f85480f68d86a027056fb8993885287f7ccec',
  '0x7df74150e13fc2362d3b2ea582ed70a744cc2d44',
  '0x04652dc07eeecb25cf36281c8c4aab589b886a8a',
  '0x0d8972118f697706ebd1358892aeee2e16a23abe',
  '0xc744f0186e2a5a4566586e3b1c36128e20fd87f2',
  '0x14dff23af496b93075f18ea93c098d536460eda6',
  '0xaa15a81748faa24acb48c1736f09978e724c1fae',
  '0x6c349bd98fba08a3651b49ab8a5d7ebb1a3ee1e5',
  '0x4e80f5521616e93247f0f7f7aeefeea4587e3d3d',
  '0xd5401136db5e00ef76b269abbd05c214ea58a2a6',
  '0x828d82cccf5dbee50a06ad77b0e1b65cb57b58cc',
  '0x5abde1ee8c8bf348b9efd0166709edc25b7a6255',
  '0xead9d47be7a4a0bccd9c1dbf0060f04321024e4f',
  '0x9c7a1e1fa3d25d99734efecbb3b1fde7d315194f',
  '0x8626e18790a0cb3b63c0a28f84fa0c456276d125',
  '0x5150915375d02b23565995aee5617101b6e39a2e',
  '0x4347d4fdd7ee1cfcfb3a7aeaed951e00b854f9e8',
  '0xf06248ae4e040231ccfc910a0ad6308e7735e4ed',
  '0x9f8f52749f607fbc1b04b89fe12e5a0f163d7d2d',
  '0xb584f09a54baf436d6758c264e97cdcb554ebb1a',
  '0xf8e355c40f0cd8810901f33e0885b03a951caede',
  '0xf2c431baa962a3bb19b668d87b2310d499066417',
  '0x315c806486d479856834ee8a51100dd5c8b4a1e8',
  '0x3646c2efb000397947072aec69388f254b8599b6',
  '0x2303bc79ea01a8c5db2e0c0c89f3404c9bfe9e6b',
  '0xc6691ed3aa6721b75d209a6ae5192840a382129d',
  '0xaa41235fd3eac2124a04c9ce3f4d004baf401bf2',
  '0xb3c74e8478cb91b17d0f78e3d0e3ea574c9fe2f8',
  '0xd403c988700c3518894e75109337efa6cab1f482',
  '0x69ab9aaa1a072ca4ca60f33451f0c07772ddd5c9',
  '0xd9128d1e232003d12612ef2c8acdcf429ff9b4d4',
  '0x6bf48b2b67062910e147d77e60a9f159714a916f',
  '0x1247ac052d67d65a6c9792a0e0adc6f6c181dd4f',
  '0xa8fd12ae6051c1c4738e1528ea2ea94c1d5e0bd8',
  '0x0d49174410bad2f3784e052f57aa2a81bf990c65',
  '0xd07d47485eb4ba7b841158cb316ba04129aa583c',
  '0xd5d331f40fbacf4e5e4a380e426b2e5a0acfdfa2',
  '0x5191e99d9bc40b92342de5d25435667204386e36',
  '0x7d79e1fe27469e25ee57577f73ee274186984ecd',
  '0x2ce350dcf5e05e517a661aad22cd22cde23802b8',
  '0xfd2c26230c0102ad16507eb66e6fd762c297877a',
  '0x75abb757ab883d7e7478301a75f85daab8baa457',
  '0xd1858a7e1ae5201f8137c49b831e206ea631288f',
  '0xd68cb396b9437a5380abe08f04a9f7ee029dd8d8',
  '0x57b865ff0d228cd783f8f2a69fbbcfeeaf57d8ae',
  '0xa80c621d994a7d20232485c7588a231671159bba',
  '0xe253c12ae98b621511560c1271747b1718764f0d',
  '0x29d721bb99627a96c114037c6da768a8b27e9409',
  '0xf05d7e6e835b816b600cdcd39b9a98a99e858ba8',
  '0x479de169bb50bb203dd0dd66679b1cb9214852bf',
  '0x4d074901c7717306cd63898a1f060faeb83de6c4',
  '0xb94177b5241a6d0cd69ab58dcffd21847e388dbf',
  '0x5cfd8fec819d9ee381b7fd6e3cca23a382e2ffe6',
  '0x1aa7ab1efef4ac17187dec1863c1a8f2f7c6ae75',
  '0xa9aca5de2c7f5286d183802ea38f317e0ffcf8f4',
  '0x378da7c5f361d0f807e697a720821fb31f98d2c8',
  '0xf087d18a9468d0122ea2f0eed1e8fbbd4c970c14',
  '0xb4b9253da55676620a0951082030cc341a89872d',
  '0xe9771785abe393b60907a076cd55c48fa1d02b64',
  '0x7c0f1accf0e1a286bf2640d4e2f4cb381d475319',
  '0x3ed72dc3fe73b96d6a45e0ffaf462412a2ea31e3',
  '0x71b147f5da0fbdd2b0e7821880e4883ba2ab5251',
  '0x79c5edf364378a39d17381d4126bc8eb7692e87b',
  '0xcd5f9283ff3acdc352609aa33efa0dfbe8baee01',
  '0x7be80e67448f9d88f2dc77ba787a3061e3222c48',
  '0xbd583638a2bcd8f15aa5bdf903b45f23b2de6e24',
  '0x831a760573dee831c9758b98fc75c48b1d995c30',
  '0xb84925f7e62fe2597aeb0ea7134373c80464f88d',
  '0x1e155fcfec8fcec5256643fc1058ca182697aa5b',
  '0x869fcf788de78fee97f86082cf0f8d7a1609a301',
  '0x498d10f6e7f6305a544fd6481016bb0650c1b7c8',
  '0xede74c7e8c3b0e0f6ed0b302c5447bac2617661a',
  '0xa5951f8f1c65206210d7553d966e5e644bece09b',
  '0xd6c14194ec02a8467d6d58b6ecba02bb7c551b94',
  '0x1bfba5fdaf0038a3874c54303175edf86b786f55',
  '0x859f35c5164d2a755c9d6c86ef9f30ebd4511971',
  '0xb83d0974f5010e4d9a80fc80a977266a44d3c5a2',
  '0xa71e530a83828622c1283b44e58626685ddf5bb2',
  '0xfd16c61a2a60621e0d8d1d9929a5d288541a1fd5',
  '0xd48b81c3c75e1d99f0f67e36c2040daf13888b2f',
  '0xc41b3edf5bb6e66dcdcec7136ce79fc720ce1fdb',
  '0xebbf2c2f91bfbe8636b8c9d56e3e7c537d1d3ff8',
  '0x2591c99d9c518fd1c642a59bf5a90f2dd4786e93',
  '0x56af5786592510b8f263f47c179e4be95b3fd527',
  '0x5de32ddf18dc1e46bdef3bbd348878e318ab46e1',
  '0xfee4962f7f5b311eaaa42b84e60448ce64d62292',
  '0x06574282d5227ee7d8ee21021ab9098f5701e243',
  '0xf72cd64018c054061bdc5024357e6ca7e135fef3',
  '0x1a72b503de66e83ac9cfc0e4f19b9e602afacba1',
  '0xe81517e1e6d8145f7ac412963118cadb54acb6a1',
  '0xb5c3e37cbab445f77c0358aada88dec2fe1a19a6',
  '0x553aff8f904bbafecad9885280868cee885ec9ed',
  '0x78b0d00bedc52b66d9df67e27cbb56338a6611fb',
  '0x8659b1c621d3fc0cc3cc1a5cc637d6706a6330ca',
  '0x68c2c0488b8984a4796dcc366afa0e813efe02e3',
  '0x1e9e844fb23e05a501ad1553e41f9e17cd283bc4',
  '0x8a6e4bd308e6ad266ac9e95ded299f42d810f7e1',
  '0x4e930cc01fa876d544026b348ba85a44e0e5f5ed',
  '0x8a7b0a903235826e733218cc918d4cb00cbd1f76',
  '0x83b16df52ebac758501856e306a4db634b233a0b',
  '0x7087dc078d09dedcb6d4a9eeb12448b035dd2eaf',
  '0xad8211539085b7730026a04271e173ebef07f71b',
  '0xa67c305745270dc8118352e5597d87612f73bac4',
  '0x1ac4333e90e0137028c049178f26c51c74fd311a',
  '0xf96cc13a91741d7d872dfcc9969943b215e8b650',
  '0x3c6d8afe9723bf64220bf8eaf3cf58bb4e326cef',
  '0xfe02795dd00de2a105710d862c75861b6be83546',
  '0x988a422418925d8cbaacacdcba69f0f9f6ccf264',
  '0x7fadea2f33e5f17cc98ac9a587dffbf57c11d793',
  '0xfc936946578e7e8f483e27cb225974bf8cb3bfd6',
  '0x74c85ceccffedfb6dbb77c814da589828ae85d5a',
  '0x527499022f44a23321b6b2fd4384ae1a67bbb080',
  '0xe565ca0796193f0d1e6cec36e32d71edc62350a5',
  '0xf5a25d93a0db0b2252079e04909042a7ff009ede',
  '0x3fcb477022048a642633912a0cdc866774f34641',
  '0x7b219e88632df0c7983c2c9a04bc6708bf7c4e34',
  '0x61cde4aa614df891825a2cccd8b165cb9cb54efd',
  '0x1b24ea88bb1635de8f02d66e97f791227aea07c7',
  '0xc1f804d0065f24f9ed52d1857d39a2fe55b3339a',
  '0x072d409ed30c9e080b64303dd307267ad0544ef3',
  '0xcf41cef9c24cb93eaf1dcb2593e74701fbb8f8d6',
  '0xada323113232f1906c8bd91da0e8fd9bc390955b',
  '0xdf875bad0c963c7e45e06acbe2b6fa319ec380a8',
  '0x949383776ff10907b2a0d20107a898328ebf1a89',
  '0x75cde90e123f6ae9bbfddd84fb065617bb7fad6a',
  '0xd28575765327e59b264ecd81ca343c3e6907b738',
  '0x216caa680f79ea9565f0e0c11575a4d7b4c8ffde',
  '0x15f909247a1626139693a6cc92692e9c61f0892b',
  '0x3bd6025f1baea4151a7dd9dde51da7222d873609',
  '0x8eb05c830efc1be9f1ff0c523d2d84e252e604a0',
  '0x2593ebe5da4610bccf17fa7443bf8e8c6577ad71',
  '0x44cde31b19a243f5c2fe974d3052fb36345f5dd4',
  '0xcd8f26e23f1f8085b097ca4109532de71a588076',
  '0xfe628a6ca3d6bf129053b78b0c2055f3bffe58b0',
  '0xc5e4a996b8e03ac590a5896f88e7c3689fe8a6ae',
  '0x76ef190e963fa78a1c37d95e7568ab0cbf725900',
  '0xd6b792ed456c9fb3159eb6c5ce8f790574e34640',
  '0x5fc6f10a9d4d4b9fc426002d2cd9117c5543cd1c',
  '0x18555a1ee12b85e9b263e43528af8f023e727389',
  '0x40960aee91cf42020ebeb3f238ee68bd39e93229',
  '0xbffdb662b2ea2db7a675b20d94ac5735942d662d',
  '0x89eedd41f415d2bf87d83da344e49912c1d81371',
  '0x1b927e64115456ebf56d6b9c1f76b15d2025798c',
  '0xfb87a1f8d822cb996e7623e20b91c896da7c420e',
  '0x52496b2c46e5abb66f353703c00bb7a2b1675d70',
  '0x84540ae10f8b8c24e76ba41cdc477684b9dfa453',
  '0xe582ce7e417e8508cc85e4352abc0578e2abd0b7',
  '0x67ad87cb50d976b9f222353762c2e9c81cfcf14f',
  '0x42c4b0e7c77ae03ca2cf4424665942b008223017',
  '0xc594bb6f0b10dd6b227948dd44a039fa045bd0ce',
  '0x64238e982be3f810389bef084359275a933e268e',
  '0x20f54a32de4759ce18bd4d452b8698be80f7618d',
  '0x2d80e91d9e0b0461ca2841c7862e5cfe33fcf748',
  '0xe37ad7085aadebeb97698e6ad6467ddeee2e7526',
  '0x673696ba7720f0f35e60b299545c1c723341e125',
  '0xb32eb5cfadd582543b8933466bee3a50a2cfb48a',
  '0x31375c9b8169e909165fa9e5337abd79f8fced1d',
  '0xb6482668a893269df4d67d438d6f967893f4bc5f',
  '0x32006235d4b6957a8506269587d0f8685c5a72b5',
  '0xd629954d35e42d1107bb8fc9ef862d2f4ce5f189',
  '0x964805cc48f6599378ac44fec21f78e942047e53',
  '0x056474e7e8d42cffe121f418fa3e5dde69ea97d2',
  '0x883d5d5aa4f78bd6cbd32c573eec825b02870882',
  '0xb92f9f3b6cf004589732cf8f89a4e338ad818e29',
  '0x6b660726400697bb9c8c55c0def79745d80d19f9',
  '0x6a78b020064bf9afe82aebd023346da14a576113',
  '0x637924c46c7f97167616d540dd4c72c8882adcc7',
  '0x77883f81f011af6f0d0436b968246a5b4622f617',
  '0xc041fc8330ddb381fcd36160672322c990d41c1f',
  '0xc8a5881b442507b84d3045ae175b8631d3add55c',
  '0x1e79ba838e75e7320ce8a53e6a24b07d40ca2823',
  '0x0fb8cc76a54a2a791440513abe2c69a74dcfa816',
  '0xa90b38a241d29080b720cc1f9e5313a467fe47eb',
  '0x4c2bfef47fa690535eb44e65bb06b3064e7057e7',
  '0x36e7c0acca5178f953188c9f3be4895f4bc23437',
  '0xdd0c6b6788d677aeee34a010a4bb0cad0c999a5a',
  '0x532fdfeb70643a87add40f3720ce6717f18383f5',
  '0x05ae36c1914f174ab33f12eaf59ef08c1338e8e8',
  '0xa08ad0b909082f6f953d7e949eaf6a476f5654f4',
  '0x9c2b060bf9a591798e6697bdb3fbb3f054a00364',
  '0xba171a7412fe1edc3d37fd3307e8adbf55656cc5',
  '0x7a4a27f8cbc2b4c6dd1bf04896e5993ed1888e94',
  '0x861bbefecd8214a4786348777326feb049c35853',
  '0x1ebf3deaccb8ee6d36639f137b1be89671bf3ee8',
  '0xc147eb5471fc3e7aa9e488de99c8508c1b0a0ad4',
  '0x1aa21a481423066cc3be7b4d1f4567d44a004b2c',
  '0x141cf895decf4050598a44080126aba765013619',
  '0x8d36d47c280e8b3f8a9f88b64e134f21b644cee0',
  '0x41c5846f91dc53f24ad0f043801122b6b7a45e73',
  '0xb3ffdeb8089af1f90750ff4d5c8da9ba0c082cd6',
  '0x9523beec5bde06b7edaf0c5d0cffd64373f7d931',
  '0xfd7e0da727fb581866d58284226670cb521c353e',
  '0x9fd3ebcff0095c804967f0dab08f7497ab3b9575',
  '0x9b9ed920cc9113d9e71c622dbd820a541fb7a955',
  '0x982422c0bde3141c2a0992005581c8518ce2537f',
  '0x82b1beb775bb936198be911bbf9550c8feb6d68e',
  '0xeb96e390631a6bc22b8981565235f4db3b9d128d',
  '0x95561eaacc7686901ad072d484a18cf315992365',
  '0x1ad3a58ef68f6c8ad1cbfa6fe7716a9d3e8d32da',
  '0x445a7c7968aa5e8622c34a0ea0f8e1ffd6b71bd9',
  '0xcabbbc29f289dd5f13316f1057192249837368ba',
  '0xc01b96c9b42bc321613b73303a02a9bcd4ee246b',
  '0x0171366eafe17072fdd7fdbc2ac5b392efb1529f',
  '0xff6e6116877df6e6f342bbc4afeec1991af5bd20',
  '0xa12c9f10135e726a7b1d7bb3e44c5ac7e2cd66aa',
  '0x1d569b04fe30f9c4e8e1177ec3b60f766c1ca7ce',
  '0x9e7a520633b1e73ab2effced5956a481583d7b0c',
  '0xac6b3d2960596ca9a2c6ff03ddc53c1da0a9f50a',
  '0x21d037b21ac03e9b69b4484f6b588c0f953a76a9',
  '0x01eb77d49a486297c6ea0fc860b7353f51e4577b',
  '0x1f8208922338edf4e28167652b7d4d6b53690a06',
  '0xe6b78253ea783c24a4b80667e4dd3aaa05ebfa7a',
  '0x86f9f4de1aa1df8f620f8d583e107b635c2f23fb',
  '0xdaa2432dff05a8f09ccc994eaaa6c9afe3a9e180',
  '0x7b8f8571dc5ea1845e316793e2672d4eaee7757d',
  '0xfc518012bc748eaa764ed9aa99e003d2549b7a78',
  '0x4054de346c56c011bc263dcbbada81fff2dd45b1',
  '0xc9479848d968603a0163ecc4a131e2b24e9b6c2e',
  '0x07426a1a308f2610a33bed323cdb445c0e96bff9',
  '0x6cf9b7d7df312d9519c7f1671791a9ea051257c6',
  '0xaf01d3c2622fbb509754abe437e93c7849180e40',
  '0xad1d828fb4bca76d48310126e7f1c45784dcc7bb',
  '0x18e6494c0c07bc43e893614f0d288a92543cb395',
  '0xb20bfaaf03ec97f8ce106f04b25c821c45ff5f81',
  '0xceada26994f060c2e87b3610dd41470db6840c14',
  '0xb6a6ec35a031efe81e9c02c09fe1b15ac35c3cc1',
  '0xc29963a1d8233c09d92010acbac3ffbc4d0e6f82',
  '0x1c08485e80e4305bd3a910565e72c84edb0bce69',
  '0x1f35f33b18024b9f542e6c548e867d0128a14fd5',
  '0x0b65bb2330923c91e9e18656a839558eef3f18e5',
  '0x7694fe7bf80a272e2638493cfc778fdf7510d8db',
  '0x64c7068c8012eba77f522c632c382c55a4f7ec74',
  '0x6dbd385ba3ba7f15affe2e94c40967d715f48e32',
  '0x8cdf738cc539b5d5ff47075f80f9d103d1c1dd04',
  '0x5b7780183dc1bf6a0c1e24aae5d5f8e3faec5fa9',
  '0x4d12929e2e50526dc6679e424e0a7e43f1dc2fce',
  '0x3d46c5d20f8275fd4d4f53cfa9798b52e0a719a2',
  '0x88e33281df8ce0e9903e9834dc278443da7cac82',
  '0xd8a467fdcdcd8e27391b8ad2ecb3b4a345b42610',
  '0x99147caa3ae267b74d3bb4093988a6c8bfe38cbc',
  '0x3581428612d672e9129f0dc75cbf7b43a78d8b71',
  '0xf966b345bd3a9e0887c5cfdf5f0148067b45fc28',
  '0xc9cc3786dc8350b6c9222bc75a6c3985e5ae5a75',
  '0x8caf4d3909a9de2855616d72a8455817e20bfe78',
  '0x2e68f34c224499fe62c60a528bf2d8451bf480f5',
  '0x7bc79459ba1d13dfd9bd35995c1f16c71b3f6d85',
  '0x780a459dbc4cef79e63385efa9291d4f91b56600',
  '0x1f068bf19eff34460868da414f04f11e0819d62d',
  '0xc0440a862639ecba707aeba0851e9f039b087b40',
  '0x94b194c5d82ff9b3fbcffd944b554bd79033bf69',
  '0x3c4fe9689c19d8fcff9dc7584a1be028a47cfa50',
  '0x55cd3d6149947ecc9a29e14ca305c7fd67771197',
  '0x0a5cca37bbfffa4830084ffba278ee8bec034cc7',
  '0x547288f765e652adc834e46e8015c340e33b7363',
  '0x3266411fdfb393c802b2a75089f1aa5af990c876',
  '0xb94521a1851d5c7743299a2d921db58616eccbee',
  '0x1eb40898b97c31044c3b43ed6cc1a65d79aec1ae',
  '0xfe3071aa5071482ff022a55860e4e9859af33bf0',
  '0x065972d566aefedd71609061cb1ca9ac13441469',
  '0xe7f90472329ec459e45aa9ba9244460abd4811ec',
  '0x5b9fa13c49f5c35250d155ebef5fcc88b068cd3b',
  '0x9d054da0462b9b8516bfa9aecdf334b6b94d2634',
  '0x117a5c97c8c274fe065bada6bbfd2d47fde60e63',
  '0x042e3dd5491a9d22783b462246e25b774e31f3b0',
  '0xe4565085760508b5b165f6fc26189027ee0337aa',
  '0x4d82302ffaf2c9162d0eed66c9e425031588a8a3',
  '0x738e27d79bd8d114a740d464a6a54ac35d4cea36',
  '0x1a68a659a5dcd827e65afd046ae4ce346a0b95b4',
  '0x53e0b60de353fd86a59c178a0297011337399b67',
  '0x6e47df002e9e51b19de3768d4be8e03fb0eae72c',
  '0xbfa7aff1a9aa181dbd647299baec6610d3f2cc2f',
  '0x10f57cd62744147e8cc66c1e016c0a18cd1c574c',
  '0xecae6c4caf7eb2ba1f6d0a6cdf6eca2cab6e9d09',
  '0xc63ad6730165f27cd1016df337a7c89b2b143d09',
  '0x4ed1d0392006eb86824ee9e583c9092731e4ddc1',
  '0x0ad7bce1c5cb5b163baf59b822f42ac4c164dacc',
  '0x32a1837a5b1e24141db37e993c5de63fbefc8d47',
  '0xb5f81de19b4836eefdb23028f7cdb8115b64b2d2',
  '0x604d0fd02830c50c2dcf697bd68f1edd9e4e9892',
  '0x1a32993243e7f2357f6517c94f3807a07785894c',
  '0x996bf0607f39e7549d4d902f7a7f1d21f07f7a6f',
  '0xb65737020397df3af5dd546d36d14637f77b877f',
  '0x4c366172448decc1855bce909c9509d193b028d3',
  '0x512b40a94b1691abcbb0b769aa413df810610818',
  '0xe5d1f77f768581f813277f4a6bc24011121fe4e4',
  '0x860c8ae2892a0f0d03bb40e22e9ecfe61ab8c870',
  '0xfe7f4ec51d496dbc02a6e74fd9fdddc2d0490c7a',
  '0xf2fb766af1c7a60816ff692ac4133e59a7de4e1e',
  '0x2a4d89f82e9b5aeb1f40d68261779f0395120469',
  '0x0a2dd326078c3d8ee2507a29556c8c47611e4a66',
  '0x569708df868b4d2622741bb24375519fb3d52cca',
  '0x31c96c146a36d6c25eded60f55f265291c35a457',
  '0x10e1680ff558a4b52ca86173586a08a34a35646e',
  '0x01d80850c9ab1e1143088248700dace1615295db',
  '0xffc91377ba8b323a7d5e174ee7839c1c2c47cc48',
  '0x7eb8a5421e72fd2f894acc00da11ac76b358d4d0',
  '0x5a549f09e17d71ea38dca7c289a2ff212e5a7d9e',
  '0x0c94c5c8b78dde896c072dd1c0c424924d7906f4',
  '0xa4212c6cc60eb097cd33a5d22a975d0ff6171d43',
  '0x39f4a2b0175d626d68d020c99cab9314dd979122',
  '0x9e861b7e5597908d281b405938d7c51218583d81',
  '0xa3bcba465f1653a501e77485ea4cef9d2581a849',
  '0x5350872c302407d74d2c3c34be6d350ecf83bdaf',
  '0xaa1a6d188c5b0ce208b7d09c9bc67669faa448e6',
  '0x8b216ebc33f7c525eef3bd3d657c4710c36e07bd',
  '0x8174a38c497db7708ebf5ad8d85ef1673b07ea87',
  '0xb24cd98719843962c711414f545e12bc3c783e88',
  '0x1f1c6d2546f0f0af4e68ba7d5ff75e7a9ed54b58',
  '0x54f5c522d10551fd7572aef75d3f26701c57e24d',
  '0x6d040811ff26574740febccf181e5dd53de2e046',
  '0x844aef58e22e5fe9c79661822c7facb4cb086aa7',
  '0x547bd1bb455e96d1e52cf2126ac7a43e94796fbc',
  '0xc24d29c34c430f026e4ce357ca30cb6372a0502b',
  '0x6920bc1689d4bb04b3da368705e5db500182c681',
  '0x3ba9f6a2930bf700e1b4027039299dc129ddb271',
  '0x844c0b04fc3385b929ae4bcc6e3929da6a0daa0a',
  '0x722c41fb9c9dadee27ffd4ea24b0727da172b926',
  '0xe81d182764bf668c0c722e334768070d23c1f314',
  '0x73ba7679fd647af6e17c3a232b173a532a68cb12',
  '0x40d212c473f9769aec59750588632256b55b0f5e',
  '0xd9613d7710d0cee296d06aa3e9e46a33cf4f803a',
  '0x6c2d81b28749f6b0a487a78da2d63a2409577416',
  '0xa7cedff278ffd281c46394dd9163c521de9903e5',
  '0x64f8e2e9a3918f83a958d886c1fe0be6e9b54bc3',
  '0x73ab0ab56c3abeb0c7d6d4e16a2e34572c7859a1',
  '0x05effabc64aa995aad78708aa2d5d2410566a1e1',
  '0x8ac5ed58ff53b8d2c50a14dddb79c1a8b7703658',
  '0x517115d5d39feb1064f3453a373681a969d97e3f',
  '0x5f4003722b343ee372a69c871914e445cf579057',
  '0xd5c73601de2e32252fab2e49ce3e1f4771252293',
  '0x5b8fde55b6925621129d44ef2d121097471cddb9',
  '0x684689688a7f52d0c13d83b3ebd4e6321b8c2d61',
  '0x588be245a25495c735f571703e8445d8829cef79',
  '0x792fd72735740eec41f2b8e34ebbcdf7ad5c8de6',
  '0xa9d1aa10ea356b0075b7de6ed6b20dae5909f413',
  '0xca8ab19d8a81091a1a3082825230e88d3dc5d280',
  '0x1767e3ce4f7ca638a9fc9abc997ed4e4d50eb4b6',
  '0xce38f2db6476fed00a4d92972e45ec10c180e9dc',
  '0x3d897b5b8ce94750ec6bed5dcc05af4304d3717d',
  '0x6dd08bcad8fd09c88f6be7d461dc5fa6199681af',
  '0x8da310de9d66386f93942075fc72c0a66d682924',
  '0x082e64e11bada1b05bcb3cc20d552d863ca03f06',
  '0xebd368124194c025f00b38f5b9a30872806d6c9a',
  '0xed65c9d0b6be20be95da69a8fe13dcafb773be3f',
  '0xe50121c0a782760999cebe502a6994b9e257d58e',
  '0x9f8efd9778b1f7e2ac088be79be1057d932836f6',
  '0x0d3832d13263db6054e7ced8b337082028db0777',
  '0xcc9b6d854d29b44bfbce29b97a7cf0b093b1b14d',
  '0xf1f865410e146b638fe2d7fb2cc686f9b913a532',
  '0x198ac1694cbc5d06cb5acd407021f36f95f89207',
  '0x44ecb390978057be9ce9777d7541c8d7aaf31c6b',
  '0x634c2c7fba3dcd33c946c21f113c4546bcdf4597',
  '0xc0376a4dc7017f8ccd3e46fc3b6280a1c10daf72',
  '0xf6ec24bd2679b3705be58e995a9f9468c11e2b2f',
  '0xb09285194dce2b15da15c5bc3ac68cd4f70b5c24',
  '0x0e6e5f7baec87906f99b8018c38ad65b21680e49',
  '0x713e11d6ceb190e084ddaea9080c22491887faf9',
  '0x0c273dcbedc220ff833d43ad0c41781b27c0341e',
  '0xcbe6a48f6e55b0e709c4a0bdeaa167daa8bf9c24',
  '0x731960f6e8bc44d3bdd9ec0f851e7bb09f98bc97',
  '0xb2f71b73a4376ecbe36a19f4122c060314f541e1',
  '0x78ea757015a345576eda7ff28637a255da88e3be',
  '0x5690a3592a9de2e6527500ce0caef160391292f9',
  '0xe1bacda4b5256f6e2539c15b65c8bb8678309940',
  '0x791d00bcbe6b396d70e6e608489191f3b919cd17',
  '0x0d83ce44a768304f6b1a28ae25234e31d9e81e4e',
  '0xfd17497925402a243e1c0c083254371f4424269f',
  '0x26defd168bf474e0ad9871b1b3be0c7834d69e47',
  '0xd2499a1c0a4c5df5c6298fc82559158114069d45',
  '0xbaa11c6d083883120b9a1e63dc5303d0f61fb09b',
  '0x3a6e797125bda13f9554044bb0ffcf0928258605',
  '0xcd38b82e68fdcca4434d1a26e1851972afea2b5e',
  '0xc3d2ba826fab786248158bc3f59ec8ca8b534fb8',
  '0x43eac783deeffacb91e3f8c6819511c20104d36c',
  '0x303b54d8c06b79f4347f06367124c6a7af908800',
  '0xe803737a5479ede6d9ef99e0b081c45605e66bc4',
  '0x119f81a3b3142d35d19e2f70be0756d9230462b0',
  '0xed493263b291edd4ebfbe40388731642f16dcdb0',
  '0x58d6e358222c6649ece998269a836bb227bc9b9d',
  '0xaa8ee49e5662a2622c4273351298c3ec6e64bf8c',
  '0xdd9fcd9960a0ad8cadc1827d33672bfffc432666',
  '0x1dc3e71c8cd2a40901870b90a37fe2b5ad0d24e0',
  '0xb505aa8c0dfff178ac651cbf87cc784a754847f0',
  '0x5b5b7f80689adbf5c9923dddf1a4c06911b2cc50',
  '0xa53e99989dafdf21b569520cd640fd889385bcc2',
  '0x147120c066f9269fef20eba7afb0122d14b99b8b',
  '0x039df051998b13dda8ab9d850f4b13b1ec68e1d4',
  '0x20825d3cab2c497c7fc570b37c399f84e95ddc73',
  '0xf23f5a1d65ca82fa782fc1af2f5beecd6edb2613',
  '0x9c79aef1d586452220ff23fa6b7791fcae1e7edb',
  '0x11f923575af89403f91b5708f2457f7629e0f03b',
  '0x4e74333946df92ab82a0417efffe28f44b2abf93',
  '0x85b6f88b203366acfb9b9f755ca88c6796161f49',
  '0x5f5c7d5a21c6d739b554b4e3a78f3aa09b0f5b72',
  '0xd4417284b92c56f1e0c4e382d7a44d792559ced1',
  '0x97ee44d1e2bbe5989aaeeddb865374fa92164a61',
  '0x7abe6f3489829ca1eddc23568a7da907a0365d49',
  '0x40f67657f52e3baba39e85cacf69a3fdb2c3c2c1',
  '0xe4d8378a0ab4d29a8559ccc05996f2feb68d386a',
  '0x40369ff403f79ab19ad7f3ed3c708cb32871bcad',
  '0xf67cbf53109bebaefc03664bd966be4ea99a5791',
  '0x57cc58019745e020e1d86d324cc13bf5ee7f5355',
  '0x674bb7443560bcfdfc583dab94d393b4c3e0a65d',
  '0x8b0dc3e993848c8587f14f521ab96ab89e0000d1',
  '0xc1e37f08d6447642507f2f4324bc6f51c54d9024',
  '0x3da35522d2da72470636129a3d493ded8e461a6c',
  '0xc6cf5bfcdc967d825e6facbb63f516a51cafa109',
  '0x0078b51b3b7545a66724084d0da7cc0ab4f8dad8',
  '0xd2f6cc7320b642ca89a40817af304beb8e8e94f7',
  '0xf89443cbb94094830c4d04a903d927278ba4e7cc',
  '0xfd914f40fcd14a7c5f5d3a4b4bd5fc99df6b7d85',
  '0xba618745f1e6da3fb123e393bf75975ef8815f3a',
  '0x93a53de27561e974da9d21728e02ee61c4c124f4',
  '0x17991c0cc126e8ebe3766a47b804c6cd486415bb',
  '0xe30e56df3a2eae767d417c1de991743a322ed4c3',
  '0x3711a0208228b75aed8e2fff7ec8fbc8fff2bf6c',
  '0x451d8b42720d686705cd4f964079752691991850',
  '0xb43fe0a877d57997c3dc5dcc10943c433a616b61',
  '0xa374ff945408daf2464ff3732f8c74c2fa4df33f',
  '0xac984427955da7e17da9f3f06cfdd6bdbe6df878',
  '0x6b5c21e57e7ea89f813816fa42e2f0e0876cd9d2',
  '0xfd40ae598335adf57290e538a92655eb8c76fc33',
  '0x494449fbd45eb3fa7fb47404a8947275f457c4b4',
  '0xd863a48d291112c6b4c06064c9526c3a6813ded6',
  '0x4beaa96b5fd1a48d628ae5f5ee89c17049e849d1',
  '0xd619f3a6329a47778564bb109e6f6aefeb51ddee',
  '0x4fedd82afe9500b6a92454448e08318bc7b17684',
  '0x598e101ec645cb0ddbb7909244a231ebd1b3b484',
  '0x94f08b8f850786d08fd5ed782162bca358f35bb8',
  '0xa958c4f79ebdfabab4141a2a2bb17ac6848ca185',
  '0xc92f18b2d712bb95d1e23559867db3b5d77d089a',
  '0x7d5332ca7920e5fd5188a444832ebd8cd6e5b3f9',
  '0x109d0f32edf302e6b36eccabe5064c2b1b043c28',
  '0x3b53144be63ebe2199460f8c00bc1125fc211686',
  '0xd43ce12cb609094047acd443aae7bcf048fd2ca6',
  '0x74ded57eb455af41ad60e1624d8d28bfe66b33e8',
  '0x4b3c984d60f243bc2c39bbdc742f22c53e2d0d20',
  '0xb0f8483d608350cfb1cd682a95b5f24528b244d1',
  '0x7116b8a3c2049d6d94f537715df59525345262cd',
  '0xc62a2bb52b3389f558452303163b0e40a8b9a3c3',
  '0xf683706eda1eb2f2d79dca2371d6efe0120d73c5',
  '0x80ae55e39aecddb696af74d8fc058927e47fc7fa',
  '0x702223d43b29caf6fc2b535e3f983ae5a300cf9b',
  '0xab68ecad870114cafda1acc7687231723d43da9c',
  '0x380e9cc1417797a3c729ff037de4b824c06eb088',
  '0xb9bcf0580a476c8c8388e9a15e30429664927698',
  '0x65cd9e3616b1f9fc1638821cbd2d96d455f93e22',
  '0x967d9f874ac7706d1b028fcf540faf17967a6b9e',
  '0x8bcde14b6f971292107f16a3ef6737c3f3d6abb5',
  '0x80cac1e9045fa119d311c02b6b5b512398708951',
  '0x04556993798755b660e212d14de10886cdd5f8a5',
  '0xbc838cc3b602a23325ace101bc97c5f7ee300178',
  '0xe348c6468ca8ce7d8251555f1e2ad9ac0d866ac5',
  '0x2ac30051df11dd6a21349221475a55ac64806cc6',
  '0xb3cff24014e4e9c3c90c47b6888e25c7ad4abac5',
  '0x2dc37ff13828bb90d9bbaaef8ae520a5ea9429ad',
  '0x4bc51ac01a3a3b44779b9036434962fe90ab0e01',
  '0xf25f6fe6a07ed1fa8d80ce1732704418504613b7',
  '0x94a74dc3febf56a2ab0ceb894cf1068a2e39808c',
  '0x4489bd8ff37542e6c6d4700ddd53f8d5d70f14b4',
  '0x27ef4b5482c15c89b05030745fd55fd8d10a891d',
  '0x0ce3026cac88da4c4aa22f3c1a44ebe4f981b584',
  '0xb17890c5156edb6d4c660d0343a4632c7d89df67',
  '0x435597667accfa8e68b6e9c385de6bafd3ab78ed',
  '0x3bda08c04c83bd8aaa2e49ca68387b2f04b929c6',
  '0xe8c140ba37e7d25c6989332c906dcc24527870d9',
  '0xe167bc50f3158887ddfed7fe598a0a85e3708c38',
  '0xd54c31c5eacd54c9a944cf29e41fb80256289606',
  '0xcce0981d643dd6e7e243c9a090df9fca8e831f46',
  '0x7615b73e9618668da0f2dee594c63f60bec1195e',
  '0xdd40b33efb7800d1ce40806b3665f60ed27cc493',
  '0xe8a847501809f8b7b57938cd31bbd834b32a792d',
  '0xb5ac49f71f86326c5723d9205945a41daefbb899',
  '0xea673585cf34cca23562f4e601d32f54233044db',
  '0xe1a0685203e645589df531b4670b8ebd8fb1af52',
  '0x9cade92ee8a73bb715d73973ff037093be3f2d96',
  '0x6963d58bb5ea6ff7835a504eef8bd0ea702b7015',
  '0xb468457feeec870f6ac1dab7d3f64880717bc2d6',
  '0x9e8c67ab400f455388de496ca1c6fa855e8eaff1',
  '0x0671dc34309185e0f41f93d8d650301400b4717c',
  '0x2e1a2172b65d7a3632c9df9c76f32171174bb0c1',
  '0xe35e49d7858d3fb98cc13439d84881873b11f292',
  '0x54244005a7529756a82bdb967367dec98b4e13c8',
  '0x6ae9ceadd2f87a2c48a6bf2584bc21fed519ee50',
  '0xe8fd031265230fcd4e06961c88178fe8c63273d5',
  '0xea3d7c3aa5c97a28c3f6b471e693dc86caf99077',
  '0x2db8d4048805d3cdb03a7b00a50915a23989fdec',
  '0x13433fbdbfeb126df0bda987218c6dcdcf6e4982',
  '0xa0a8d45c1bb1d0fc60dca5932a304a87263bb931',
  '0x406a0f42d1c4015d2a123fb41498a104eeb62714',
  '0xff0587172556c46c0b487d5c8fdd1f7589db9f2e',
  '0x44cdaeaf52db56f9e56039901c4ad93b9497a220',
  '0x5b86ee6f2680459b0a5857aba7d202117b983ff5',
  '0x05188f3f1b7403bc839b9a6571193859e3c2d5d9',
  '0xca689706159243c5156f6c4afe370012d654ff14',
  '0x999344f57dc09d727f19089188511d0506b3ddd8',
  '0x52eed3d284963f1dfc282c47ab4566a0e6b0efde',
  '0x5dd5b15c265c6bd5a3714252822d377cdc62afb9',
  '0x0eb747a488a75849e977aa3931147a50beffe814',
  '0x96b80f5052b6f456acc9d652a094f5451d10786a',
  '0x068b42fdbb359b300fb4352c7d77d91b96e92c64',
  '0x422528a8fddf0fb219e7127388aedd0fb2b5c3e9',
  '0x739978b1ebf85c43f91fc56e55f272668d97a4b2',
  '0xefcd1790b5cf8f70d8f8c5118e7add9725721af5',
  '0xa81849924343bd1b8c65a07cef32ee000261fd5f',
  '0x78016abfef7ad302831a52557235a6ffc965ae89',
  '0xabe5b918611197556eb36f1d1e86e023d9a82a4b',
  '0x5fc4f0767bcf16cf81b4ad20d2affe5c089b6f69',
  '0x90001d60210bb29c9389d6af9bd3096e62e1d7cf',
  '0xf173a87362b7d8c004128469c18e13adaa2f9f50',
  '0x28fd2b6c4479a8fadc2fdb2c6714e83d48b5e59a',
  '0xa8ab4151abb642ccb5dbb8dbf1fcc411177fd7ab',
  '0x112812e8d91be1bdbb5fde8b307beea7574ba067',
  '0x77b7965208c002ef28bd3a10fbb69942d4de705e',
  '0xf916317afdbb6597783b2448200c3684ddf95e0b',
  '0x86661b3ace5cf1f2119fc3a1e58d726df95c4515',
  '0x4cad5000331edf570f84fb28cbc1b1185b0e6628',
  '0x1c0dac3838fbc7d194ea18c4246d4f4592a74324',
  '0x17ee615548b501d35adf89e213ebda5cd08a4968',
  '0xd143c6bd79aa849b979d7d91036dadf2bbd9bad2',
  '0x00846f15eaf906fed0737dec32753dffa8a9d3fa',
  '0xaa66ae7cf4e42c3669a4ec23a5a8ad410cb4ccba',
  '0x1063cc335d6ec54042bdbdc6673404e639860c62',
  '0x414a7bebadb2538588143cc3255261bb2351d612',
  '0x824a5f55956f82b0764600112bf58eece76a0730',
  '0xfbddf39ed2690e84b32c87d4c0921a2f7d0b08c9',
  '0x67235db1d21aabdd99010312d2645c95d66fbf7b',
  '0x12a498b1a421fb73d557d09889f68ea1d5f65165',
  '0x76fd100a306e2f890a256ec2a8a2821a922a01c6',
  '0x024db6ec0c9fce1aa1532627d1392ba941dfd706',
  '0xdd842a41e5d823af853e7164425063177b793c11',
  '0x23280903d3412beb946ee3774316665c9d436601',
  '0xa2f41feca1ff07b512d1b2f619a56f1c3e985ebb',
  '0xfc4d7d98a89bc760184b15696ac9c650f1b26921',
  '0x41414036b13edf82541fa1403644790b1e57eab3',
  '0xb6b34c6e252528cd8b65e82278a72668534f9dd1',
  '0x4832cf888b45d207aaf80be51f2024bd32e092bd',
  '0xf97e27919d95bc93dc218f854acf7dab91446d8c',
  '0xb719194ed486b34c15037c1bb1ab80d60f7ff6e0',
  '0xd610588ec0550a77855083441c362805d7b5aa10',
  '0x6e44716009364c1ef180ea66665e0b316370e637',
  '0xc59b4139587a7d671e8422518e49e566fce0cdb1',
  '0x8463c60363d601391c5bb58ee8299137685ce84a',
  '0x9dc026d48c2223008ef9455921401c3f3c26e421',
  '0x8d33172b662340d381056401ebe48a6df769a622',
  '0xabaf5a7323b9f891399b711d2260944c3286fb48',
  '0x748447e420651ddf549f053509157a1ccd48cc6b',
  '0xd592afaf4c39ece4028e89a1ad29f2083503437a',
  '0xfdc1c773f09d39ca359ed99ae0131fee87743584',
  '0x6bc81c406eb5852284046d042807e4a9c3ce3bad',
  '0xbfe60f9b553029f4edd23f4d1ce31ec123fc277c',
  '0x0b212f16e17e44d1d613605042b72cb84ea1c5ff',
  '0x8ac776e9a2e9ba321ae7577cacdb82185c74b01e',
  '0xf5622d5ad821214b2d0b8856d83849f09dcfbe69',
  '0x80d7ff2b1abe8a63509fc9f8ce0dda647a31b17d',
  '0xa829d0f9b4198ea449ef3a56971d6a69746800b5',
  '0xf839a447a536b924d32db32a5ef1f730fd701890',
  '0x31c0ea896c2fb169f4e8287a81cb590af1474ac2',
  '0x9953dfa58a8d3575f2000db713b9a321a64cef50',
  '0xa706965647ceca053e78b4f881d90665d98ba1be',
  '0x2ebc3916dd8608132b9f18c7a3eb612d8e7781d0',
  '0x06ebb4647b90eea2a4f292c011ca43a373c09c8a',
  '0x238afcbff6184cdf67d11740d0a8d97109675115',
  '0xb9d9132c4ba2efb52aec38aa8b976b08b8529e60',
  '0xa2a675dd2a30aab0c90a4d7840bb67ec70038c7d',
  '0xe5192a6b2950c19a8c91fbf5d64073db6c2d734f',
  '0xcff9220d39801bc728085acde59ff41d545d2550',
  '0x2ffb872874076c73c0c2832909c01e8f8c79b840',
  '0x53212259bc005ba705280103b35b5263a08aa100',
  '0xd4feebe7d216f105f744c36b95f61b0d337f36a9',
  '0x9ee441bf8ff4c703efdcbf27cc8c4ec1e78bff9f',
  '0x1fee50e80bb5a6de5665499cb11ef0daa2c1506a',
  '0x57979969723928f9abdfff73e614bc5e20fe72df',
  '0x0355adbd7add074811deeb5e04ca9aaab9cd98bc',
  '0xb3bc022ab61da9c53704a89fa4b5e47a70ccb425',
  '0xeef04140568a5cdc91460852eddd0aec2872b06c',
  '0x342d9cb28b5d139da17700c08e18e1177737f512',
  '0x4e4606e126c3627700fa1e4fa4e55377f31ec04d',
  '0xeb24f1b99c7a31ead65e5d747d395073d14f397d',
  '0x2bb4a1ad2504d70096143d7a6b43542ad42c0228',
  '0x2ae61c5f3752c7d1c8f57df8abd529d980351775',
  '0xa6dc6b24c42e0a960c2b0bd2379d24c93951bf34',
  '0x235fc7d5b9cc59f63ae425a698763e3e47936a4f',
  '0x23dee00aacf8b7321e016ea0778fed86186ed651',
  '0xe248341def97706f0f85e0a508451e8623965bab',
  '0x114cfd9c11468a696015e65f4c99f5c617c35583',
  '0x25f4aad372958274ecc55662869c0604ddcd58a1',
  '0x5c3ebf4f8b326229a0bae449d2bce5d4580ab927',
  '0x12780c9bece35ba3f1649a6eb7cc547e117ea7c9',
  '0x0836db92f4262e6e7eb438566031c884c2e19093',
  '0xbc6d531df39d2509ec18105271d9ee4c0b933b85',
  '0xc7f236bc9d7c9ed6575ebb7e27116ae6c28bcacd',
  '0xb2e7ee1f98382d485ee067d075f952a8148decc5',
  '0x193779d4315ef5192da72e59519b8901a56c17a7',
  '0xc84a94a0fdfa043ebbada3df7abdee442dceac64',
  '0x38f9136e4f0611c26b5e202fc82c8e7ff2bff7d9',
  '0x67d88ebeb46a758dd4fc0d42ad380a0fadb46358',
  '0xeb4c5dc489024bbeb9f3b933218e4fe790515d78',
  '0xc50a337b9c57fb5a4679c63434813206148a1ef6',
  '0xf6b5af35c4ac54b7bc2c93283f6e5e43129c5e28',
  '0x0803dd1e35e92354310562b31903c43a1f79bce6',
  '0x78588250ae88bfb62e7b4105cf395bbe2d7cf87f',
  '0x4d272cd0e8971bdfca8c3248b751d762f72fd993',
  '0x850267c193d00b10cc173c36d8ec0949bc526ae2',
  '0x526b12748339486632220d9b6e9320cd9f18ab57',
  '0x4e9dc8ce464ad5cdfa274773c17d38d43c677883',
  '0x3ad86aad7ff0a465e9697034bde1b8b7192108b6',
  '0xde907db43ad9e5b1397108f56775223592a6c4b5',
  '0xe76437edc6c0df7ac201879676ba9777f749c042',
  '0xd7a5e5d79f2ee4fd4403f3dcb6b0acd9f44f7333',
  '0x5e7be09b8253c9668d1a7f9dbd73f0649b80fecc',
  '0x530a1bb281e997f519c4f3ed17140277db7b76b2',
  '0x8ffc5134741ff9938e5a6f2848a826659740b294',
  '0x9752232716d75eb7f727384d9fbcd0aed4954d78',
  '0x79ab19b9d19f9ea904e3b2e41d9ca78676074fab',
  '0x0bf1b809393a9cfebaa10e5f8b1848293f7adfc4',
  '0x1773de7ce4b4f9f9f60a90fa3cbd07ae4b55f91f',
  '0x02bf999be7c08335a47d825402899c9ee9ae17c9',
  '0x57adcd49105a322a8422187e333a9bef9d2e432c',
  '0xa6d1fc38f0a0f6889a6f56b57a56b0380bbab55b',
  '0xf2784a2891241fd2233d4bcaf7f01b1a91fc5783',
  '0xc93a03c3a9f8b41b11d814a137826cb8f1efeb25',
  '0x6602ef5c62f39c579463ee9f448d128daf36ef13',
  '0xd20ba3ea7dac3af819327f7a81babb9447a33921',
  '0x21482b3b05476064be0e6cbbef64c48debe05a44',
  '0x58555b354cb54839c76ee3998256db45ca623108',
  '0x4ba420887f29d59bb47d6e02a4f734e553002f39',
  '0x4b2737d94e3fd453bd7c521fd45d2b1cf8fc5bed',
  '0x9db839acdf121df9f98cc6ac969740de126b3533',
  '0xc968be76e5dec1b9320ee7924bf661338248cb30',
  '0x5c37b333958772e8b231042c7266da9e6c88afe0',
  '0xe84d8f1018c42811fbd1a8df5c43e9f70ff462cc',
  '0x22ddbae018bb6c66d71f5f10464b53cf69c0afb6',
  '0xe471c63ed45b97e26ed7f35851c8bf55d62f0eb5',
  '0x4ed9d20350bb4ad39bc9a4fcd0d28c2b782464d9',
  '0xfdc80337f17a8b3480f84d5dc7318cf037417a97',
  '0x8d034066264439465eb1c2a70ae9c887ea7f1ac8',
  '0xed0e89f0b5eba218a74d507ef1aefd6bc5eff91d',
  '0x5be1a21097cb2d7915a8e1eb00fa9fdd87b327f5',
  '0x3e4a25734583cc7a4ac434ae36f297db359f3b4b',
  '0x3451fb2e6d76edac85410eda400fa1fabb88bc5a',
  '0xb0acee89f57f9916ac46b3387245fdd999c97fea',
  '0xf6ef7517d660e775e21398c6e6b2f9e263a48014',
  '0x043e18422afd7fbf3671b72bb7770b85722b7386',
  '0x1fc479544931259f55bf197d7dc5fe56d97b1358',
  '0xc858f7af781ef455cbad70a53001a4e91bbb0de0',
  '0x1c9b34d83da0d0ac0c852d9a239a69276010760e',
  '0xb467603254578f0d11e183e5b1c3cbcf4f08b33c',
  '0x6cb86e1f8fa50d75e5d8daf4cbda9dbe5f22a1fb',
  '0xac740ddbc7c107f9a2b554e36e9bc2071bdfc600',
  '0xb023f8f962a98b5e542c43e7b5774c5464b631bc',
  '0xbfb0ecafda93535a34f0fea732edb6a75e9f7455',
  '0x3bf62ff96d5c516e55d4ed4bbe261701669e6913',
  '0x6d66029893c507650cebc4c7d66f0830c3d28194',
  '0x3d04ba825928db311ff7be5d7b10a5d5edfa8cdb',
  '0x4e978b01c837ef642f2c93d3766bbf53438cf933',
  '0x0a89ec8e35dab56ed704cc334a20f8b1c8851490',
  '0x1de0daf4cf14b218ab41953480454beb4acb391c',
  '0xc5ca5bbae206e093cdb48be8d3d25608bf37f1aa',
  '0x59d3d40339e79109589814ada71881493bdd085b',
  '0x0e3388c327d7ee66aa208d0f244ab69c284176fb',
  '0xafcfbcc401fafa8328c0c8c2136aa4b15e63d803',
  '0x06e9435b20653bed74cdd7cf61143a4125caa1c5',
  '0xb2e92768757fbc581534d94269662abf0b3c808f',
  '0x6f8aeeb067b929ac55958b6760adea07dd22eed8',
  '0x69ae8b1dcb4f95fbbc413ac8db1a895684469c58',
  '0x9a6b8ddbfd0c2cf60ed539fe813feaf9f9608e4e',
  '0x8d6536c2a042b6bace9023e4f2050d49a67091a1',
  '0x9ecf67c160589df73f14bb24cb1ef96335108f05',
  '0x43cf1a7d71979b67c561ee226e864dbf9ce8d470',
  '0xeea6b7eeb225ee6ec5936ce5fc63e6b2a2f21082',
  '0x42cca196b029c20e7e69e657cd0f5ba79ee71cd6',
  '0x52b2bcc86f8f58ef1811f7a8f99add2971f68cf7',
  '0x7a85fbdb5cc7ad66e5f6874ebca8a5040cca29fb',
  '0x1f94783b98203a3a5540c8076b3490388ca37d0d',
  '0xd6b8170f991c738c8b86c7b4ec4d1b35bfbe3644',
  '0x0f52bdda53bdede09c582e6db40f0002a63a173d',
  '0x53dd55eff6037f68b30e99fa979d0b4c021c2026',
  '0x6f89722416098cec3d4f1c55773e69e51260fcbf',
  '0x7660da3b7710b7ac1b811192880e83fdc2f9c2bf',
  '0x40dcbcab5e53bae10205e5c1fbd1b8b636fe15a5',
  '0x6baf404e96eaa869e0739c2cdc8235367cc26ace',
  '0x858c125bd239de7bb6f7022608a2a06a142aaddf',
  '0xf0350c60f8a6fa0fafa81a7f17ebf3d4db5902e7',
  '0x7182f2edf478cac087de042f5e50d63fc9610226',
  '0xa7f4525cc6ff39ad14dc8da6129e0ff87071e8f5',
  '0xbad1fe403f0cf01e4ce6954e7fb9c41455be261b',
  '0x1d649fb106b5f28fb996d086dc01a403a8b06d11',
  '0xcf8b41825c669746ac1512e78c5ceb55d42affdb',
  '0x2f07bfdfe4ee25e207eb9cd9f2bc85fc0153042e',
  '0x52bbcd05841a55148284bab9e62c0b5b6e9de6ef',
  '0xa5ce1dec8e564e8de2c1c01397d795d519391bc2',
  '0x42e42ae10fb43eca1c7946928f0d68069204d0d2',
  '0x720d7eb37a30b62f6a0c25d563376710a932edb4',
  '0xd2b065ed40432c8fe579bed9dd44bd1caa054870',
  '0x29434d62abef62fd6dbbbb258a4edce57ee607d8',
  '0x07c168d6c5b3c8b2d191de57f2e279b856b73b5f',
  '0x6389872747c48100328ec924ecffead2858f8650',
  '0xa70fb266db99ce7a1fb7fdec3200b9865b2588b3',
  '0x3b7889016c28d7c7504ca0540b795b01213f93e1',
  '0x780e4d11d181543ec54b2751cf5560048165ff93',
  '0x607eec23c1b5ce5698622aa0b2aa0e8906580265',
  '0x17b8d16981d753174c5ebec475277b59d34239ca',
  '0x562c0ea96d4bdbe3f9ed75fab4264bd4155401f3',
  '0xac92c6f6e2778836b6cffdc953f66d65aa475685',
  '0xf0c01d755f018bba1c775691c513015e8610e903',
  '0xe9c7b20ea24ff97f4f101a5b2c26ffcaf6c8af3a',
  '0x13ea9f9f5dd763ff02c88ac29195b28243bf2308',
  '0x08e7371a0799d465976844acc10bc7d17dbb7ae9',
  '0x91eb2dfadddd310ea08d274b9bb24c1a6cbc1a93',
  '0xe18d47174705d94ecdc96bf049593e4048de513d',
  '0xdf861d314af23b77576035a5e0d1064914efa991',
  '0x8c947b455ed6eb55326e8d5e052d27b0b1b3f7e0',
  '0x8d3665b79aba248226c5fd1c2293ce9665575f00',
  '0x45a06bc2710ecde00e8c5a555ff27b89c14b4828',
  '0x0c75d1081db2cce88a953af00b77be2a3ab8b373',
  '0x630fe4c2abc6b4b3eab6e82d00777b9eac637907',
  '0x58a464aeb3628101f3cc5c22b6324e86bbc47de4',
  '0xfa21f6d39810abc1fbf2f7ea1fca8f138420c97c',
  '0xb5182f95cb9793993f4dbc5920ee50437849f451',
  '0xec61cf819dc1e9ed555aaed1f779e3014a8d2456',
  '0x38db6288f809b7900d50d9459be3d6cbe1ed060b',
  '0x9d381f57be803d6e3d365f758e4483b35ae8397d',
  '0xc1e6dd05dd67f9f14d76cc58fede3c31643ab1e3',
  '0x132dee7c5a730a2e850ce03f25d8634888725953',
  '0x0a59757bfc9e875475e09dd6f642faa8c0246a38',
  '0xa1484bfee9eb092b2e97ba3b86c96ec5d68b3d65',
  '0x8bd85d96554af0c4e8e872b17c19f971b54976ff',
  '0xcf77167a0502b199180457450957aa2ab82f2b1b',
  '0x30cee16d1f5b0b79fc66c4b4e2c53750a9e0e209',
  '0x54f0fd02f3e823de1590b77cd3177aec272845d1',
  '0x725e1ec0585b8b09d838d23b0aa2353a2f25f2dc',
  '0x4013f231b85e62bc9de90220ac5fe9db5e9dd7bc',
  '0xc563d6ee39db862aacf0f63c0c2bffaab211f4b2',
  '0xfb7b852793d1f7494bea7ba56f2bcac22bfe73c8',
  '0x9105532885291029aa3c4590fc9aa5c25c920924',
  '0x26bfd8916619cbe1465e810b355221871ce46352',
  '0xe4c9ed95317fee77ea44b9683fa5c604e14dc5e5',
  '0x4ea92125bf6872befa0f6b8d90b43b0e7bc7e556',
  '0x47a947f21f104ab1231b75155d7102eb681fd8fa',
  '0x398b9b85a51ce79ce811b349b4faf88e7fcbd634',
  '0xbddd1bde07f00cf1dbeb751d7eccfc97ce546d73',
  '0x313f6fed69c406f26532216a108a6c59bef9353b',
  '0x18709cba767b662400d66e8c39ff33b714f5789a',
  '0xd0c2c908cfa5414437f7dda45051d31c53c24050',
  '0x69ecdad34c7d37f22d5f230348e80131f085886c',
  '0x594dc2290a68cf331317efbeb96bf0cb6c8a3a1e',
  '0xb1bcb955a4e1c97c2a2110951070a662e2ca1aab',
  '0xd9df6d81edfe8ba9c3c0fe59ab915d9cc8d50819',
  '0xac2358b0c7301a45b9a09d3f53699e7fcdbefe96',
  '0xb0ac6aa73260526938f62a8240d8051a8e995b2d',
  '0x9cfc62e6d0a7c7aef4967ebc93906f732ebdc47b',
  '0xa2ff10548b9ebd54cf008f7cbaec1930335060b7',
  '0x42feace232d545e701944b8744c23c5814381f35',
  '0x2beeaecbf3e197b0419bbb65e20999991a0fccec',
  '0xb5621f07900e98095d0b69e0edd7e6f6af53459c',
  '0x65c7c395cc5d83f7ee291ccd12cee24ef86d27e1',
  '0xd3cb92b572afa59c77696b1a7ef1c04965ba3930',
  '0x3ff5a813e9cf3b4dd3cfbee70669450259eeee8f',
  '0xebf91d0e52fae27ccc3f1c28c068a102f39ad5ed',
  '0xbb08680ae5f257d7d80d5b41cd233c3965c6a22e',
  '0x234a9c701f5b7a9eb3617a6dad5b7b62069a8883',
  '0xf22b3986640bc9494229f38770fa090ee6400853',
  '0xea4ebb016a8c36281411d3c9daea05cb2880b09f',
  '0xf34e19f7e03fa995ea3cfba7a1cfac3b38b96a3a',
  '0x5268f4fe10827d066a0834f67ca9473644583426',
  '0x42c7755eebade811b3e91fa42b7040764eadd758',
  '0xcea7ba3c1247c07cb8882cd3963f09b2a1a3cdd9',
  '0xd52e55ab867d57061d8a5fc77d93719aca34f8e9',
  '0x14235da8bfa5ff752f8d106fe4e235b90f22cb71',
  '0x81a9d726a7420d1ba10e963b7c26628a78fc058d',
  '0xad26595ce574a132f45a7298de540754584545e9',
  '0x8bed5cbf0c02f64ab448dfdd6c6f3d5ff4e29ca4',
  '0x8bd9a4b8121631ef0fc22db2ca490aeafdc45a03',
  '0xefaa6e8c15183464703edb1224825be742672411',
  '0x0c868f5a2c90676ad535e73516387c61dca75bfe',
  '0x5b56f331be326f561dff69aff5ba6da406e6e4f4',
  '0xdef1c90ab64d4993f4fd34b02f9cb0e61d3aad75',
  '0x83ab32b3b3b66790b0d56428d9b6f139172914d5',
  '0x3cf5a3c8e2b588ff0b2646b8b8c5743308679ad9',
  '0x6eb04f68ff68b3fee2f305e8c2f0563fbbe51aec',
  '0x1321f6f3a18b0732c86031454854f093c4496e74',
  '0xe60585d5fa0b7ec606b5a28afadb0fe47075001a',
  '0x0823eedc8bd55026a9d715a5f593ed2c3ee9a5f6',
  '0x31f9130b881c00491f8c2d04aa0befa61a5daa64',
  '0xb2d27e5e5440bd8ee69f4a1ee31257ba89af51fa',
  '0x22e2c26f7870b6950880ca847cd87106b39da9f4',
  '0x0f34d339b643d70f5e981976a1bc3fb74c60e70c',
  '0x42c2697169e6943036a02fbbec6494706b33158d',
  '0xb7f9536231f1cf5c7089bbd61ea69e02d74a4416',
  '0xe09691ba7cc4f7321aee480552e116268ab7c956',
  '0x5c87a5c6d8bba2606b540623d99a88ebac444117',
  '0x64730e505e1d046b61f87b9b20021acc99d294cb',
  '0x7969e9172d54079b11d9a4b144085778f45a1360',
  '0x7968ed613067296d51fe90e94b7168558036d374',
  '0xd987c22af5db0e336e0bc0cb54131fe010905c58',
  '0xde6995dbad0043428faa597f04cfe221e26fdf48',
  '0xa082c812fc785192a7be79b93660d8642bd5297f',
  '0x2090a8c7d31ea0a41e4db93a297cb801796be4fd',
  '0xdfe2a6923f7cd57095095d410974b610b76ade95',
  '0xf45255c910e85f1407fe59360f38c6f8d20198ee',
  '0x9039ede91907f2581b181db73e36680545467da3',
  '0xb564198e5eb810d50bd0bb762c2f42096ba5a55e',
  '0x092689decc261bd210c1c93dba98d1f02a1f7058',
  '0xaeaaa75b713f750bb5b12aed0f76363f3d0aa0e0',
  '0xafc4f436a544b2b189cd6519e3e76b1ff2d8afa6',
  '0x9707e8cc310b206a943be5dd1abb518cfdfec339',
  '0x9300e7a2bad1b2b528b6eae5f5ad69138cf1349b',
  '0x95cd8605f53220c289bb87f383487cf5d7e3e28c',
  '0xa612c0fa5481b3ce2b3af68388611b7ed7410849',
  '0xf62a93561ac9023aafec64815579d845f62634e2',
  '0xec209210a0d6a3a92214cd6dcbd893f8b52d5fd0',
  '0x25f12eac2952f29fc9c7df6a60a36f4649956d6b',
  '0x69a8160675a20b9e8e7fc01612b8311fcde58652',
  '0x493174aa577dd7cd4fe82ce55824f1f0683a61fb',
  '0x333b96a3b69bf05458ae7843d83926e9d508b87d',
  '0x4350a22cb396647b6f60e41d204ef7707f8e0936',
  '0x4661e5e543237787e064d9489bce548059edd8ae',
  '0x87a04415e356a15fe7b117986a7da88369014f83',
  '0xcf55db3799772e5546f10a440abda30cb61fe3e6',
  '0x756ee4142cad301f5e4368fe773265fc5f192e11',
  '0xab4130791ce425efeea0a423aa987e50ec6b8b6b',
  '0xf5b972c32f2813bd9628ccdd99bc81fb3b922dda',
  '0xa4de1ca106897b787dbdb6d0548b84d6dfd54e44',
  '0x91c5194dd146c85baf9c4d1a1d68da96c4a92fa9',
  '0xefe8c8fda6e01abede56dab279d5723550b8d0cd',
  '0x8bca4050f61b4bc1c525bd60adda27f64f79890c',
  '0x91136ce0244a0b96751fa4a71f75a79c12b3c4d1',
  '0x86ccb0c8b05bc41429a54d08da098f9145d9f48e',
  '0x377b96fc54da842bec26b06bd144aef6809a9885',
  '0x48994b6403ebc4486605f96074c4916a0038ce3c',
  '0xaf3768e39a6fdc414c98ade15927966e26757d26',
  '0x283be0236954dc78da2283c6b36bd6569abba545',
  '0x1e3c2df90687873a0fbcfa500fe5764db320a8cc',
  '0x51240d8af603853da2affad7a0746c1379e78eb3',
  '0x87117e7270aa6e1ac2813969f6ef5ff8df23ee7a',
  '0xe3184e6409f1714e1345f08bbd163a5d6f69d71a',
  '0x718936307cd9d131dcd9a97a4da4424bd4056ca4',
  '0x8cfe1767c2c6b9b5f73b00cbe291ac0c7194b1e0',
  '0xd3ff95c38197b530ba835f003268d9959bd96cc6',
  '0x32f2b03acd467c48a92e2709b4faf2c6f6d05531',
  '0xfef8fe3233fac486c2be2e9860ddbd0f61c292f1',
  '0xa7a6f958b29e9d9b2bdf74b0eaedef0f41f19e2d',
  '0x00562477d97bc3560acd0c678eb880250024aeb0',
  '0xa0bbb0af9b38186823b0dabb4aef46b6e6c25435',
  '0x41ab79f9317ee4633833ae97508b609ca6beabd0',
  '0x3873518716f8fe2aee865cc279d81f318c997771',
  '0x5609c7b558650ea075a74dd27c40abb69c937690',
  '0x77ee2e9a1796aa3235c606ce935a7c49a05f146b',
  '0x831372e6db0cf9517791635c8554f0d4a8c52f50',
  '0x4199e2a042682cd964ab00a141368fb8c5e484b1',
  '0xb1afba82a0e239b5cba4817962c6c47797764ac1',
  '0xad0da763578e69a3d9bd126c405e7fae6b981fc6',
  '0xbd945095314e66055d453afc983294d9ae46db2d',
  '0x29c7c77bdf34f01356f57dcfc09f5db53b037fd4',
  '0xa1a71985841cc8200d764512dfea2a667bf3c479',
  '0xf339de7e404c494ffa7d16d3cd646fdf57a4cefa',
  '0xdeade7cbdd8c1537505ecc0295bbdb53370eafb9',
  '0xd48f1ed89e6fa18772e509b33442fc12773e22aa',
  '0x3016c29c682ead9dcba8a2a69874c5165a280f64',
  '0xffe1cc84911685dfcbaf6be49e5830321b587650',
  '0x2cd4b3b462645bf89058e40f36f33461b116b9ff',
  '0x33d60b51b734a0b577a933794fbd9a00014674f9',
  '0x775b8d514b19a470bdc322fe2a0fda2f0808d074',
  '0x416d48f43664994d50259e5f9b416070b3be55ff',
  '0x492392e90210bba2624731412b49b1ca6bde2305',
  '0x87993c2dc0178d4c7cc783cd2c821c4dd3702915',
  '0x1c5d8e80495a0c83b4142d8cc19a068f925b1aaa',
  '0x0374b9e3a638e25ecab66ce33af92412d50faa03',
  '0x3f287c06a4a2fda517acd144d68ce9aaa3c66b58',
  '0xe8e7486374c348ca8f4fb956a1d16f0bdee734c4',
  '0xe36d49c6521195f690c5bff3f4fdcabb7f20d8a2',
  '0x3bbf95437347279fe13d4c1f8edf1c1ca02ad556',
  '0xdd6af499b1570ad15e6659dfa48eab4713e3c27f',
  '0x396c0cced2844e33236f0479f8fe8c03cf2c31a5',
  '0xfe4505c7ab172a697de573af59e9d2fcb8352dc6',
  '0x7e95d62ad0820ad54b0b6c33ca3466db55198e1d',
  '0x07a81f82966634227cca99e506409e6c78b92876',
  '0xbf1971093bc94d9893a7e92e8031e8dd951aa3c6',
  '0xebd712db099378cd9d4316bc8e55c4bc3654e052',
  '0xd4b52db6475f1f4fe7404521e4f6cae511f256ef',
  '0x835d2ad2de30236570bb31969d4184f279677466',
  '0x20abf8968507a220a1a0094eb81491b59fdf16fa',
  '0x8954707d2f5f8e73eec3359f258215fe63304bb3',
  '0x1aab14b660e74b39599c126f6d0f22cb68094f9e',
  '0xf355ee1fbd6f494f1c2ad51326a10b3a9ed7979d',
  '0x0cb73a6a50b5e9fdc1583700ce5bf760dd5af666',
  '0x69b04e4f2d3b4257df66d457ba46ed4327b9b0c5',
  '0xb18ee8e171ff3dbcbb2bb525c379b03f30e0fc68',
  '0x1e7f5b0e914aa74cfffb129b199aadd230ed17f5',
  '0xbfc806c72713e824d41def3756b1b57f245bac17',
  '0x3662b9dc1403c9e9f84a87ec2fc1ab8d923b3c5b',
  '0xdd73d6fd8bf32aed61ab3fb7213f1b5175732867',
  '0x5b7ad62c71eb744d3f47fc3db9b33e1d784ccbb5',
  '0x33301dcd7baf69c07eed39f55b6cc862ef868d2f',
  '0xbe4acb5a60d3b5526e00d520b4f9305fb094b22e',
  '0x414a43a6ffb889a4ac5fa5ccd91bb44095181689',
  '0xbb76203a140a3ca4384691b57d3e03c44a93082f',
  '0x64912f619ae9f02cc7db44911a186a447d33786c',
  '0xb47eb04a3b1d1a2bfb6dc614c07d90d5abc02ebc',
  '0x50d139a83b2fb9e478b036e75b69796d5186901e',
  '0x53fca1795b4f21b1bf53380d5fd12e5ae4b2ce8f',
  '0xa1b53aadc08e89f973b153e66941ffe9a1b26974',
  '0x30a26b365030afede73e4bca71568d9a5e29f91a',
  '0x21cb53118c397d8241b4e9e9a918ab2a560b320f',
  '0x8d0a9b0ea3bfe82dddf58676eb9da8931a038a9b',
  '0x6bc10f6d7bf3f75368b9f584c84a3a0d46fabaf9',
  '0xd5529f5a88bab49ef3a5d20a8cdd72524aff220f',
  '0xbbff1270f1782e1a3c6b599a0aac67b960c0877c',
  '0x2df223be6f2237c41f71b3c63674cceaca83ac38',
  '0x4274e52cfbf8dea9557b98188be272818e05b21d',
  '0x81cf343d27664ef4066af51e8767866efe633cec',
  '0x9fe51f0fde71273e6b9ebbac49a0f7045bf011c0',
  '0x9b5fd58770645e9f1eb10dbb42ed299fec068527',
  '0x49c4aef3028226071225c0b609ca863890db84c8',
  '0xdf01a242ab60b852377926a745e164c5ebfd6238',
  '0x30e5c8008fb13c221387ebdd27142d83b026eec7',
  '0x1a4673dc7a6f86ededcc0e674df71c3117fc11eb',
  '0x1a1e92d64de3d4fdd23f54d9bb82e4d5fbbef78f',
  '0x3585b06ba65884dd3dd3890d9e0901a7a8c9c36b',
  '0xc85fac96643d24a52602317fc6b1059ca6a20219',
  '0x3950e8470679f7406067fabc53128db7c6f69047',
  '0xc9b0e5fa495122cee99e7675bc81c08b5e2ab117',
  '0xae08a32f20499dfe5bca9f1cbd203b7796885861',
  '0xa2e31221b318f6492b156f4ab97a5eb2910a9f05',
  '0xebae245c9c9bcae9478cf2b4d8ddd5c994d57c03',
  '0x1ade75707ca98825922c551f8877a279f1bab1a7',
  '0xd9b0585a3e2fe8c9a6bedcffb9d0f7c0c9838e7e',
  '0xdb7f2b9d337b0f6b7f608c476d81b8da86ed55b5',
  '0xb5dd5e97f10082db6b46f98a9fa82bb6dd1bef71',
  '0xaa8fb0f76d6d9206fc114e8b7239760d1eb25919',
  '0x980c1df366104780149b21a0b69f6f72bb7c99cd',
  '0x5fda95b89757df944f14130b2ffaaeff60b9b991',
  '0x50dcacd52dae1a202b5c6c3e576fc5504e389c26',
  '0xbb061b020eb168b9574ef10ee74f426b4165b84c',
  '0xfd1995d4e58c86aa9fee5ddb0acb834e9bd76cb0',
  '0x583c94aa18b15002eec8fc13e6db1b49e98cd145',
  '0x208ca684801693ab863acabcfc61fbc90bc7fe53',
  '0x2a5518c3c0cd2aea41b2957ed07f0a6b4fd8a505',
  '0xf327ff0e8f27201aa749a1cea08a82e099866c2f',
  '0xeab20756f32edd231b3e0ad8515823e076eaf820',
  '0xc91d2c12bdc870488bf14f1f6d0224d9e59d8a00',
  '0xf562c9749f9a6e8ceea2cc4a4d4e8c47021ea0af',
  '0xa82f85480f68d86a027056fb8993885287f7ccec',
  '0x6bded24ec93950df46e22d0c02471ce158501681',
  '0xdcbfa2cda428dbd97c3a32b41224f5b687f1eaa9',
  '0x4fe119f8a9ba26b2ea27bb682cae0707c0515d95',
  '0x29461d580fa7757fed9a4077b00dc7d25293e3dd',
  '0x9854a1edfff1eaf784ff0095af400b1c171e51a0',
  '0x9751304a3f187b080a8934c5818793f87362794b',
  '0x195340f969c5aa1f01926924ad504c43a0736b30',
  '0x49ecd39ef24349071eed1df26f2fcf2e01cd648b',
  '0x1eaa4e46d5d5170efa0e71d783b481e282810fa8',
  '0xdc58049a3fd67d830c25546f0962c5cbc4015d0f',
  '0x14819ab59d07c0128ee6a68192711dd83b3b36b5',
  '0xa0e2fa851090f16239f05a430cc3439e2d27a3f7',
  '0xb6f41bca8b161a2bbb874d269a6c4a9801465d2d',
  '0xa70be8d9725313e31bb428d99ed853bf174c029b',
  '0xfb7cd573b5f9ee0ab736683615ac03576b605962',
  '0xed89950d18fcf1ebc3134b51cbdc6f8a1dbf0f91',
  '0xdee060516e171168e4390f53bb8327401402bb55',
  '0x3f4e3df17314d59639ecdcf98ef67f06176bd367',
  '0x9c2ff409d1f872f01d19530d559b23fe15e44d26',
  '0xb4627672ee52660a9e453ec541834e04583f3602',
  '0x6d23ad23934f19061fcf320f81d1014d99551c9d',
  '0x8763ba2bfde4743097de9a0cfa1b48a2ffb274e8',
  '0x5d3c5e1472da50faf58fbf8210de8854114e2532',
  '0x6434fa5226a79c5ed92295f67c1d015b17bfa9e0',
  '0xea73919ff498766d993bb148ab14da443c5dfe78',
  '0x41cbd1a9baa2ffe03b4f58e659da5e6c3f3c6b8f',
  '0x968a32ace34fc0124731d7163aded8c428031465',
  '0x1af99ff542ce5ce4faa7638e4f828731203ceee9',
  '0x682c907ce6569c8d09484fa5e55efcc75eeb7bf4',
  '0x3a6dc55893e5b2869f01bf71a564d62c1c6843bc',
  '0x6c9ced9b588237bc4ca82b75078cac2c8a22b74d',
  '0x9357d271243b44dd2de07212815ad7691b5e8c47',
  '0x906370eb9a451a37a546e9c320e2aa54d8876f5d',
  '0xf5ab89428c2ef0f3b4dc5676c476f5db91e99873',
  '0x36b3c9d7a64cdb22ee068ad54908097ad017c6cb',
  '0xb0ff44fb04b506493e64239ede15aae36274580c',
  '0xc2ccbffdd285b1fc715898b22d74f03dacb55cb5',
  '0xb752519ea8ec3d2d33fbb3e28ff1eb60eb03cfc1',
  '0x32512c2348aa02346f0c2c614d96b270b06096fb',
  '0x837656d29ebdbd2f1193ac53fb7319332aafb660',
  '0xe908666bf99dc8f038486ab7f71edf117f532f57'
]
