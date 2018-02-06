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

const auditChallenge = require('./AuditChallenge.js')

const CHALLENGE_CACHE_EXPIRE_MINUTES = 60 * 24
const AUDIT_CHALLENGE_KEY_PREFIX = 'AuditChallenge:'
const AUDIT_CHALLENGE_RECENT_KEY = 'service/audit_producer/mostrecentrediskey'

// The most recent challenge redis key, supplied by consul
let MostRecentChallengeKey = null

// The redis connection used for all redis communication
// This value is set once the connection has been established
let redis = null

// The consul connection used for all consul communication
// This value is set once the connection has been established
let consul = null

// pull in variables defined in shared AuditChallenge module
let sequelize = auditChallenge.sequelize
let AuditChallenge = auditChallenge.AuditChallenge

async function getMostRecentChallengeDataAsync () {
  let mostRecentChallengeText = await redis.getAsync(MostRecentChallengeKey)
  // if nothing was found, it is not cached, retrieve from the database and add to cache for future reqeusts
  if (mostRecentChallengeText === null) {
    // get the most recent challenge record
    let mostRecentChallenge = await AuditChallenge.findOne({ order: [['time', 'DESC']] })
    // build the most recent challenge string
    mostRecentChallengeText = `${mostRecentChallenge.time}:${mostRecentChallenge.minBlock}:${mostRecentChallenge.maxBlock}:${mostRecentChallenge.nonce}:${mostRecentChallenge.solution}`
    // build the most recent challenge key
    let mostRecentChallengeKey = `${AUDIT_CHALLENGE_KEY_PREFIX}:${mostRecentChallenge.time}`
    // write this most recent challenge to redis
    await redis.setAsync(mostRecentChallengeKey, mostRecentChallengeText, 'EX', CHALLENGE_CACHE_EXPIRE_MINUTES * 60)
    // this value should automatically be set from consul, but in case it has not ben set yet, set it here
    MostRecentChallengeKey = mostRecentChallengeKey
  }

  return mostRecentChallengeText
}

async function getMostRecentChallengeDataSolutionRemovedAsync () {
  let mostRecentChallengeText = await getMostRecentChallengeDataAsync()
  let mostRecentChallengeTextNoSolution = mostRecentChallengeText ? mostRecentChallengeText.split(':').slice(0, 4).join(':') : null
  return mostRecentChallengeTextNoSolution
}

async function setNewAuditChallenge (challengeTime, challengeMinBlockHeight, challengeMaxBlockHeight, challengeNonce, challengeSolution) {
  // write the new challenge to the database
  let newChallenge = await AuditChallenge.create({
    time: challengeTime,
    minBlock: challengeMinBlockHeight,
    maxBlock: challengeMaxBlockHeight,
    nonce: challengeNonce,
    solution: challengeSolution
  })
  // construct the challenge string
  let auditChallengeText = `${newChallenge.time}:${newChallenge.minBlock}:${newChallenge.maxBlock}:${newChallenge.nonce}:${newChallenge.solution}`
  // build the new challenge redis key
  let newChallengeKey = `${AUDIT_CHALLENGE_KEY_PREFIX}:${newChallenge.time}`
  // write this new challenge to redis
  await redis.setAsync(newChallengeKey, auditChallengeText, 'EX', CHALLENGE_CACHE_EXPIRE_MINUTES * 60)
  // update the most recent key in consul with the new challenge key value
  consul.kv.set(AUDIT_CHALLENGE_RECENT_KEY, newChallengeKey, function (err, result) {
    if (err) throw err
  })
}

module.exports = {
  getSequelize: () => { return sequelize },
  setRedis: (r) => { redis = r },
  setConsul: (c) => { consul = c },
  setAuditChallenge: (ac) => { AuditChallenge = ac },
  setMostRecentChallengeKey: (key) => { MostRecentChallengeKey = key },
  getMostRecentChallengeDataAsync: getMostRecentChallengeDataAsync,
  getMostRecentChallengeDataSolutionRemovedAsync: getMostRecentChallengeDataSolutionRemovedAsync,
  setNewAuditChallenge: setNewAuditChallenge
}
