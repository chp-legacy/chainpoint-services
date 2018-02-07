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

const env = require('../parse-env.js')('api')

const calendarBlock = require('../models/CalendarBlock.js')
const cachedAuditChallenge = require('../models/cachedAuditChallenge.js')
const restify = require('restify')

let CalendarBlock = calendarBlock.CalendarBlock

function getCorePublicKeyList () {
  return {
    '09b0ec65fa25': 'Q88brO55SfkY5S0Rbnyh3gh1s6izAj9v4BSWVF1dce0=',
    'fcbc2ba6c808': 'UWJSQwBjlvlkSirJcdFKP4zGQIq1mfrk7j0xV0CZ9yI='
  }
}

// get the first entry in the ETH_TNT_LISTEN_ADDRS CSV to publicize
let coreEthAddress = env.ETH_TNT_LISTEN_ADDRS.split(',')[0]

/**
 * GET /config handler
 *
 * Returns a configuration information object
 */
async function getConfigInfoV1Async (req, res, next) {
  let result
  try {
    let topCoreBlock = await CalendarBlock.findOne({ attributes: ['id'], order: [['id', 'DESC']] })
    if (!topCoreBlock) throw new Error('no blocks found on calendar')

    let mostRecentChallenge = await cachedAuditChallenge.getMostRecentChallengeDataSolutionRemovedAsync()

    result = {
      chainpoint_core_base_uri: env.CHAINPOINT_CORE_BASE_URI,
      anchor_btc: env.ANCHOR_BTC,
      anchor_eth: env.ANCHOR_ETH,
      proof_expire_minutes: env.PROOF_EXPIRE_MINUTES,
      get_proofs_max_rest: env.GET_PROOFS_MAX_REST,
      post_verify_proofs_max: env.POST_VERIFY_PROOFS_MAX,
      get_calendar_blocks_max: 1000,
      public_keys: getCorePublicKeyList(),
      calendar: {
        height: parseInt(topCoreBlock.id),
        audit_challenge: mostRecentChallenge || undefined
      },
      core_eth_address: coreEthAddress
    }
  } catch (error) {
    console.error(`Could not generate config object: ${error.message}`)
    return next(new restify.InternalServerError('server error'))
  }

  res.cache('public', { maxAge: 60 })
  res.send(result)
  return next()
}

module.exports = {
  getConfigInfoV1Async: getConfigInfoV1Async,
  setCalendarBlock: (calBlock) => { CalendarBlock = calBlock },
  setRedis: (r) => { cachedAuditChallenge.setRedis(r) },
  setConsul: (c) => { cachedAuditChallenge.setConsul(c) },
  setMostRecentChallengeKey: (key) => { cachedAuditChallenge.setMostRecentChallengeKey(key) },
  getAuditChallengeSequelize: () => { return cachedAuditChallenge.getAuditChallengeSequelize() }
}
