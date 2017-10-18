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

const restify = require('restify')
const env = require('../parse-env.js')('api')
const utils = require('../utils.js')
const BLAKE2s = require('blake2s-js')
const _ = require('lodash')
const crypto = require('crypto')
const registeredNode = require('../models/RegisteredNode.js')

const TNT_CREDIT_COST_POST_HASH = 1

// The redis connection used for all redis communication
// This value is set once the connection has been established
let redis = null

// Generate a v1 UUID (time-based)
// see: https://github.com/broofa/node-uuid
const uuidv1 = require('uuid/v1')

// The channel used for all amqp communication
// This value is set once the connection has been established
let amqpChannel = null

// The latest NIST data
// This value is updated from consul events as changes are detected
let nistLatest = null
let nistLatestEpoch = null

// pull in variables defined in shared RegisteredNode module
let sequelize = registeredNode.sequelize
let RegisteredNode = registeredNode.RegisteredNode

/**
 * Converts an array of hash strings to a object suitable to
 * return to HTTP clients.
 *
 * @param {string} hash - A hash string to process
 * @returns {Object} An Object with 'hash_id', 'hash', 'nist', 'submitted_at' and 'processing_hints' properties
 *
 */
function generatePostHashResponse (hash, regNode) {
  hash = hash.toLowerCase()

  let hashNIST = nistLatest || ''

  // Compute a five byte BLAKE2s hash of the
  // timestamp that will be embedded in the UUID.
  // This allows the UUID to verifiably reflect the
  // combined NTP time, the hash submitted, and the current
  // NIST Beacon value if available. Thus these values
  // are represented both in the BLAKE2s hash and in
  // the full timestamp embedded in the v1 UUID.
  //
  // RFC 4122 allows the MAC address in a version 1
  // (or 2) UUID to be replaced by a random 48-bit Node ID,
  // either because the node does not have a MAC address, or
  // because it is not desirable to expose it. In that case, the
  // RFC requires that the least significant bit of the first
  // octet of the Node ID should be set to `1`. This code
  // uses a five byte BLAKE2s hash as a verifier in place
  // of the MAC address. This also prevents leakage of server
  // info.
  //
  // This value can be checked on receipt of the hash_id UUID
  // by extracting the bytes of the last segment of the UUID.
  // e.g. If the UUID is 'b609358d-7979-11e7-ae31-01ba7816bf8f'
  // the Node ID hash is the six bytes shown in '01ba7816bf8f'.
  // Any client that can access the timestamp in the UUID,
  // the NIST Beacon value, and the original hash can recompute
  // the verification hash and compare it.
  //
  // The UUID can also be verified for correct time by a
  // client that itself has an accurate NTP clock at the
  // moment when returned to the client. This allows
  // a client to verify, likely within a practical limit
  // of approximately 500ms depending on network latency,
  // the accuracy of the returned UUIDv1 timestamp.
  //
  // See JS API for injecting time and Node ID in the UUID API:
  // https://github.com/kelektiv/node-uuid/blob/master/README.md
  //
  let timestampDate = new Date()
  let timestampMS = timestampDate.getTime()
  // 5 byte length BLAKE2s hash w/ personalization
  let h = new BLAKE2s(5, { personalization: Buffer.from('CHAINPNT') })
  let hashStr = [
    timestampMS.toString(),
    timestampMS.toString().length,
    hash,
    hash.length,
    hashNIST,
    hashNIST.length
  ].join(':')

  h.update(Buffer.from(hashStr))

  let hashId = uuidv1({
    msecs: timestampMS,
    node: Buffer.concat([Buffer.from([0x01]), h.digest()])
  })

  let result = {}
  result.hash_id = hashId
  result.hash = hash
  result.nist = hashNIST
  result.submitted_at = utils.formatDateISO8601NoMs(timestampDate)
  result.processing_hints = {
    cal: utils.formatDateISO8601NoMs(utils.addSeconds(timestampDate, 10)),
    eth: utils.formatDateISO8601NoMs(utils.addMinutes(timestampDate, 41)),
    btc: utils.formatDateISO8601NoMs(utils.addMinutes(timestampDate, 61))
  }
  result.tnt_credit_balance = parseFloat(regNode.tntCredit)

  return result
}

/**
 * POST /hash handler
 *
 * Expects a JSON body with the form:
 *   {"hash": "11cd8a380e8d5fd3ac47c1f880390341d40b11485e8ae946d8fa3d466f23fe89"}
 *
 * The `hash` key must reference valid hex string representing the hash to anchor.
 *
 * Each hash must be:
 * - in Hexadecimal form [a-fA-F0-9]
 * - minimum 40 chars long (e.g. 20 byte SHA1)
 * - maximum 128 chars long (e.g. 64 byte SHA512)
 * - an even length string
 */
async function postHashV1Async (req, res, next) {
  // validate content-type sent was 'application/json'
  if (req.contentType() !== 'application/json') {
    return next(new restify.InvalidArgumentError('invalid content type'))
  }

  // validate authorization header key exists
  if (!req.headers || !req.headers.authorization) {
    return next(new restify.InvalidCredentialsError('authorization denied: missing authorization key'))
  }

  // validate authorization value is well formatted
  var authValueSegments = req.headers.authorization.split(' ')
  if (authValueSegments.length !== 2 || !/^bearer$/i.test(authValueSegments[0])) {
    return next(new restify.InvalidCredentialsError('authorization denied: bad authorization value'))
  }

  // validate tnt-address header key exists
  if (!req.headers['tnt-address']) {
    return next(new restify.InvalidCredentialsError('authorization denied: missing tnt-address key'))
  }

  // validate tnt-address value
  let tntAddrHeaderParam
  if (!/^0x[0-9a-f]{40}$/i.test(req.headers['tnt-address'])) {
    return next(new restify.InvalidCredentialsError('authorization denied: invalid tnt-address value'))
  } else {
    tntAddrHeaderParam = req.headers['tnt-address'].toLowerCase()
  }

  // validate params has parse a 'hash' key
  if (!req.params.hasOwnProperty('hash')) {
    return next(new restify.InvalidArgumentError('invalid JSON body: missing hash'))
  }

  // validate 'hash' is a string
  if (!_.isString(req.params.hash)) {
    return next(new restify.InvalidArgumentError('invalid JSON body: bad hash submitted'))
  }

  // validate hash param is a valid hex string
  let isValidHash = /^([a-fA-F0-9]{2}){20,64}$/.test(req.params.hash)
  if (!isValidHash) {
    return next(new restify.InvalidArgumentError('invalid JSON body: bad hash submitted'))
  }

  // if NIST value is present, ensure NTP time is >= latest NIST value
  if (nistLatest) {
    let NTPEpoch = Math.ceil(Date.now() / 1000) + 1 // round up and add 1 second forgiveness in time sync
    if (NTPEpoch < nistLatestEpoch) {
      // this shoud never occur, log and return error
      console.error(`Bad NTP time generated in UUID: NTP ${NTPEpoch} < NIST ${nistLatestEpoch}`)
      return next(new restify.InternalServerError('Bad NTP time'))
    }
  }

  // validate amqp channel has been established
  if (!amqpChannel) {
    return next(new restify.InternalServerError('Message could not be delivered'))
  }

  // Validate the calculated HMAC
  let regNode = null
  try {
    // Try to retrieve from Redis cache first
    try {
      regNode = await redis.hgetallAsync(`tntAddr:cachedHMAC:${tntAddrHeaderParam}`)
    } catch (error) {
      console.log(error)
    }

    // If Redis cache had no value, retrieve from CRDB instead
    if (_.isEmpty(regNode)) {
      regNode = await RegisteredNode.findOne({ where: { tntAddr: tntAddrHeaderParam }, attributes: ['tntAddr', 'hmacKey', 'tntCredit'] })
      if (_.isEmpty(regNode)) {
        return next(new restify.InvalidCredentialsError('authorization denied: unknown tnt-address'))
      }

      // Set the found Node in cache, expiring in 24 hours, for next time
      try {
        await redis.hmsetAsync(`tntAddr:cachedHMAC:${tntAddrHeaderParam}`, {tntAddr: regNode.tntAddr, hmacKey: regNode.hmacKey, tntCredit: regNode.tntCredit})
        await redis.expire(`tntAddr:cachedHMAC:${tntAddrHeaderParam}`, 60 * 60 * 24)
      } catch (error) {
        console.log(error)
      }
    }

    let hash = crypto.createHmac('sha256', regNode.hmacKey)
    let hmac = hash.update(regNode.tntAddr).digest('hex')
    if (authValueSegments[1] !== hmac) {
      return next(new restify.InvalidCredentialsError('authorization denied: bad hmac value'))
    }

    // Disable temporarily
    // if (regNode.tntCredit < TNT_CREDIT_COST_POST_HASH) {
    //   return next(new restify.NotAuthorizedError(`insufficient tntCredit remaining: ${regNode.tntCredit}`))
    // }

    // Disable temporarily
    // decrement tntCredit by TNT_CREDIT_COST_POST_HASH
    // await regNode.decrement({ tntCredit: TNT_CREDIT_COST_POST_HASH })
  } catch (error) {
    return next(new restify.InvalidCredentialsError(`authorization denied: ${error.message}`))
  }

  let responseObj = generatePostHashResponse(req.params.hash, regNode)

  let hashObj = {
    hash_id: responseObj.hash_id,
    hash: responseObj.hash,
    nist: responseObj.nist
  }

  try {
    await amqpChannel.sendToQueue(env.RMQ_WORK_OUT_AGG_QUEUE, Buffer.from(JSON.stringify(hashObj)), { persistent: true })
  } catch (error) {
    console.error(env.RMQ_WORK_OUT_AGG_QUEUE, 'publish message nacked')
    return next(new restify.InternalServerError('Message could not be delivered'))
  }
  // console.log(env.RMQ_WORK_OUT_AGG_QUEUE, 'publish message acked')

  res.send(responseObj)
  return next()
}

function updateNistVars (nistValue) {
  try {
    let nistTimestampString = nistValue.split(':')[0].toString()
    let nistTimestampInt = parseInt(nistTimestampString) // epoch in seconds
    if (!nistTimestampInt) throw new Error('Bad NIST time encountered, skipping NTP/UUID > NIST validation')
    nistLatest = nistValue
    nistLatestEpoch = nistTimestampInt
  } catch (error) {
    // the nist value being set must be bad, disable UUID / NIST validation until valid value is received
    console.error(error.message)
    nistLatest = null
    nistLatestEpoch = null
  }
}

module.exports = {
  getSequelize: () => { return sequelize },
  postHashV1Async: postHashV1Async,
  generatePostHashResponse: generatePostHashResponse,
  setAMQPChannel: (chan) => { amqpChannel = chan },
  getNistLatest: () => { return nistLatest },
  setNistLatest: (val) => { updateNistVars(val) },
  setHashesRegisteredNode: (regNode) => { RegisteredNode = regNode },
  setRedis: (redisClient) => { redis = redisClient }
}
