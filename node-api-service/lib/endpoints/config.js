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

const env = require('../parse-env.js')('api')

const calendarBlock = require('../models/CalendarBlock.js')
const cachedAuditChallenge = require('../models/cachedAuditChallenge.js')
const restify = require('restify')

let CalendarBlock = calendarBlock.CalendarBlock

let consul
let NODE_AGGREGATION_INTERVAL_SECONDS

function consulGetKey (key) {
  return new Promise((resolve, reject) => {
    consul.kv.get(key, function (err, result) {
      if (err) reject(err)

      resolve(result)
    })
  })
}

function getCorePublicKeyList () {
  return {
    '09b0ec65fa25': 'Q88brO55SfkY5S0Rbnyh3gh1s6izAj9v4BSWVF1dce0=',
    'fcbc2ba6c808': 'UWJSQwBjlvlkSirJcdFKP4zGQIq1mfrk7j0xV0CZ9yI='
  }
}

// the minimum audit passing Node version for existing registered Nodes, set by consul
let minNodeVersionExisting = null

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
    let node_aggregation_interval_seconds = NODE_AGGREGATION_INTERVAL_SECONDS || (await consulGetKey(env.NODE_AGGREGATION_INTERVAL_SECONDS_KEY)) // eslint-disable-line

    result = {
      chainpoint_core_base_uri: env.CHAINPOINT_CORE_BASE_URI,
      public_keys: getCorePublicKeyList(),
      calendar: {
        height: parseInt(topCoreBlock.id),
        audit_challenge: mostRecentChallenge || undefined
      },
      node_aggregation_interval_seconds: node_aggregation_interval_seconds,
      core_eth_address: coreEthAddress,
      node_min_version: minNodeVersionExisting
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
  setConsul: async (c) => {
    consul = c
    NODE_AGGREGATION_INTERVAL_SECONDS = (await consulGetKey(env.NODE_AGGREGATION_INTERVAL_SECONDS_KEY)) || env.NODE_AGGREGATION_INTERVAL_SECONDS_DEFAULT
    cachedAuditChallenge.setConsul(c)
  },
  setNodeAggregationInterval: (val = 5) => { NODE_AGGREGATION_INTERVAL_SECONDS = val },
  setMostRecentChallengeKey: (key) => { cachedAuditChallenge.setMostRecentChallengeKey(key) },
  getAuditChallengeSequelize: () => { return cachedAuditChallenge.getAuditChallengeSequelize() },
  setMinNodeVersionExisting: (v) => { minNodeVersionExisting = v }
}
