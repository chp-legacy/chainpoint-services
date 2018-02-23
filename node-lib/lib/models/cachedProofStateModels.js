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

const Sequelize = require('sequelize-cockroachdb')

const envalid = require('envalid')

const env = envalid.cleanEnv(process.env, {
  COCKROACH_HOST: envalid.str({ devDefault: 'roach1', desc: 'CockroachDB host or IP' }),
  COCKROACH_PORT: envalid.num({ default: 26257, desc: 'CockroachDB port' }),
  COCKROACH_DB_NAME: envalid.str({ default: 'chainpoint', desc: 'CockroachDB name' }),
  COCKROACH_DB_USER: envalid.str({ default: 'chainpoint', desc: 'CockroachDB user' }),
  COCKROACH_DB_PASS: envalid.str({ default: '', desc: 'CockroachDB password' }),
  COCKROACH_TLS_CA_CRT: envalid.str({ devDefault: '', desc: 'CockroachDB TLS CA Cert' }),
  COCKROACH_TLS_CLIENT_KEY: envalid.str({ devDefault: '', desc: 'CockroachDB TLS Client Key' }),
  COCKROACH_TLS_CLIENT_CRT: envalid.str({ devDefault: '', desc: 'CockroachDB TLS Client Cert' })
})

// Connect to CockroachDB through Sequelize.
let sequelizeOptions = {
  dialect: 'postgres',
  host: env.COCKROACH_HOST,
  port: env.COCKROACH_PORT,
  logging: false,
  operatorsAliases: false
}

// Present TLS client certificate to production cluster
if (env.isProduction) {
  sequelizeOptions.dialectOptions = {
    ssl: {
      rejectUnauthorized: false,
      ca: env.COCKROACH_TLS_CA_CRT,
      key: env.COCKROACH_TLS_CLIENT_KEY,
      cert: env.COCKROACH_TLS_CLIENT_CRT
    }
  }
}

let sequelize = new Sequelize(env.COCKROACH_DB_NAME, env.COCKROACH_DB_USER, env.COCKROACH_DB_PASS, sequelizeOptions)
let Op = sequelize.Op

const CAL_STATE_KEY_PREFIX = 'CalState'
const ANCHOR_BTC_AGG_STATE_KEY_PREFIX = 'AnchorBTCAggState'
const BTC_TX_STATE_KEY_PREFIX = 'BtcTxState'
const BTC_HEAD_STATE_KEY_PREFIX = 'BtcHeadState'

// The redis connection used for all redis communication
// This value is set once the connection has been established
let redis = null

// How many hours any piece of proof state data is retained until pruned
const PROOF_STATE_EXPIRE_HOURS = 12
const PROOF_STATE_CACHE_EXPIRE_MINUTES = PROOF_STATE_EXPIRE_HOURS * 60

// table for state data connecting individual hashes to aggregation roots
let AggStates = sequelize.define('chainpoint_proof_agg_states', {
  hash_id: { type: Sequelize.UUID, primaryKey: true },
  hash: { type: Sequelize.STRING },
  agg_id: { type: Sequelize.UUID },
  agg_state: { type: Sequelize.TEXT }
}, {
  indexes: [
    {
      unique: false,
      fields: ['agg_id']
    },
    {
      unique: false,
      fields: ['created_at']
    }
  ],
    // enable timestamps
  timestamps: true,
    // don't use camelcase for automatically added attributes but underscore style
    // so updatedAt will be updated_at
  underscored: true
})

// table for state data connecting aggregation roots to calendar block hashes
let CalStates = sequelize.define('chainpoint_proof_cal_states', {
  agg_id: { type: Sequelize.UUID, primaryKey: true },
  cal_id: { type: Sequelize.INTEGER },
  cal_state: { type: Sequelize.TEXT }
}, {
  indexes: [
    {
      unique: false,
      fields: ['cal_id']
    },
    {
      unique: false,
      fields: ['created_at']
    }
  ],
    // enable timestamps
  timestamps: true,
    // don't use camelcase for automatically added attributes but underscore style
    // so updatedAt will be updated_at
  underscored: true
})

// table for state data connecting calendar block hashes to anchor_btc_agg_root
let AnchorBTCAggStates = sequelize.define('chainpoint_proof_anchor_btc_agg_states', {
  cal_id: { type: Sequelize.INTEGER, primaryKey: true },
  anchor_btc_agg_id: { type: Sequelize.UUID },
  anchor_btc_agg_state: { type: Sequelize.TEXT }
}, {
  indexes: [
    {
      unique: false,
      fields: ['anchor_btc_agg_id']
    },
    {
      unique: false,
      fields: ['created_at']
    }
  ],
    // enable timestamps
  timestamps: true,
    // don't use camelcase for automatically added attributes but underscore style
    // so updatedAt will be updated_at
  underscored: true
})

// table for state data connecting one anchor_btc_agg_root to one btctx_id
let BtcTxStates = sequelize.define('chainpoint_proof_btctx_states', {
  anchor_btc_agg_id: { type: Sequelize.UUID, primaryKey: true },
  btctx_id: { type: Sequelize.STRING },
  btctx_state: { type: Sequelize.TEXT }
}, {
  indexes: [
    {
      unique: false,
      fields: ['btctx_id']
    },
    {
      unique: false,
      fields: ['created_at']
    }
  ],
    // enable timestamps
  timestamps: true,
    // don't use camelcase for automatically added attributes but underscore style
    // so updatedAt will be updated_at
  underscored: true
})

// table for state data connecting one one btctx_id to one btchead root value at height btchead_height
let BtcHeadStates = sequelize.define('chainpoint_proof_btchead_states', {
  btctx_id: { type: Sequelize.STRING, primaryKey: true },
  btchead_height: { type: Sequelize.INTEGER },
  btchead_state: { type: Sequelize.TEXT }
}, {
  indexes: [
    {
      unique: false,
      fields: ['btchead_height']
    },
    {
      unique: false,
      fields: ['created_at']
    }
  ],
    // enable timestamps
  timestamps: true,
    // don't use camelcase for automatically added attributes but underscore style
    // so updatedAt will be updated_at
  underscored: true
})

async function openConnectionAsync () {
  // test to see if the service is ready by making a authenticate request to it
  await sequelize.authenticate()
  await assertDBTablesAsync()
}

async function assertDBTablesAsync () {
  await sequelize.sync()
}

async function getHashIdsByAggIdAsync (aggId) {
  let results = await AggStates.findAll({
    attributes: ['hash_id'],
    where: {
      agg_id: aggId
    }
  })
  return results
}

async function getHashIdsByBtcTxIdAsync (btcTxId) {
  let results = await sequelize.query(`SELECT a.hash_id FROM chainpoint_proof_agg_states a 
    INNER JOIN chainpoint_proof_cal_states c ON c.agg_id = a.agg_id 
    INNER JOIN chainpoint_proof_anchor_btc_agg_states aa ON aa.cal_id = c.cal_id 
    INNER JOIN chainpoint_proof_btctx_states tx ON tx.anchor_btc_agg_id = aa.anchor_btc_agg_id 
    WHERE tx.btctx_id = '${btcTxId}'`, { type: sequelize.QueryTypes.SELECT })
  return results
}

async function getAggStateObjectByHashIdAsync (hashId) {
  let result = await AggStates.findOne({
    where: {
      hash_id: hashId
    }
  })
  return result
}

async function getCalStateObjectByAggIdAsync (aggId) {
  let redisKey = `${CAL_STATE_KEY_PREFIX}:${aggId}`
  if (redis) {
    let cacheResult = await redis.getAsync(redisKey)
    if (cacheResult) return JSON.parse(cacheResult)
  }
  let result = await CalStates.findOne({
    where: {
      agg_id: aggId
    }
  })
  // We've made it this far, so either redis is null,
  // or more likely, there was no cache hit and the database was queried.
  // Store the query result in redis to cache for next request
  if (redis) {
    await redis.setAsync(redisKey, JSON.stringify(result), 'EX', PROOF_STATE_CACHE_EXPIRE_MINUTES * 60)
  }
  return result
}

async function getAnchorBTCAggStateObjectByCalIdAsync (calId) {
  let redisKey = `${ANCHOR_BTC_AGG_STATE_KEY_PREFIX}:${calId}`
  if (redis) {
    let cacheResult = await redis.getAsync(redisKey)
    if (cacheResult) return JSON.parse(cacheResult)
  }
  let result = await AnchorBTCAggStates.findOne({
    where: {
      cal_id: calId
    }
  })
  // We've made it this far, so either redis is null,
  // or more likely, there was no cache hit and the database was queried.
  // Store the query result in redis to cache for next request
  if (redis) {
    await redis.setAsync(redisKey, JSON.stringify(result), 'EX', PROOF_STATE_CACHE_EXPIRE_MINUTES * 60)
  }
  return result
}

async function getBTCTxStateObjectByAnchorBTCAggIdAsync (anchorBTCAggId) {
  let redisKey = `${BTC_TX_STATE_KEY_PREFIX}:${anchorBTCAggId}`
  if (redis) {
    let cacheResult = await redis.getAsync(redisKey)
    if (cacheResult) return JSON.parse(cacheResult)
  }
  let result = await BtcTxStates.findOne({
    where: {
      anchor_btc_agg_id: anchorBTCAggId
    }
  })
  // We've made it this far, so either redis is null,
  // or more likely, there was no cache hit and the database was queried.
  // Store the query result in redis to cache for next request
  if (redis) {
    await redis.setAsync(redisKey, JSON.stringify(result), 'EX', PROOF_STATE_CACHE_EXPIRE_MINUTES * 60)
  }
  return result
}

async function getBTCHeadStateObjectByBTCTxIdAsync (btcTxId) {
  let redisKey = `${BTC_HEAD_STATE_KEY_PREFIX}:${btcTxId}`
  if (redis) {
    let cacheResult = await redis.getAsync(redisKey)
    if (cacheResult) return JSON.parse(cacheResult)
  }
  let result = await BtcHeadStates.findOne({
    where: {
      btctx_id: btcTxId
    }
  })
  // We've made it this far, so either redis is null,
  // or more likely, there was no cache hit and the database was queried.
  // Store the query result in redis to cache for next request
  if (redis) {
    await redis.setAsync(redisKey, JSON.stringify(result), 'EX', PROOF_STATE_CACHE_EXPIRE_MINUTES * 60)
  }
  return result
}

async function writeAggStateObjectsBulkAsync (stateObjects) {
  let newAggStates = stateObjects.map((stateObject) => {
    return {
      hash_id: stateObject.hash_id,
      hash: stateObject.hash,
      agg_id: stateObject.agg_id,
      agg_state: JSON.stringify(stateObject.agg_state)
    }
  })
  await AggStates.bulkCreate(newAggStates)
  return true
}

async function writeCalStateObjectAsync (stateObject) {
  let calId = parseInt(stateObject.cal_id, 10)
  if (isNaN(calId)) throw new Error(`cal_id value '${stateObject.cal_id}' is not an integer`)
  let calStateObject = {
    agg_id: stateObject.agg_id,
    cal_id: calId,
    cal_state: JSON.stringify(stateObject.cal_state)
  }
  await CalStates.upsert(calStateObject)
  // Store the state object in redis to cache for next request
  if (redis) {
    let redisKey = `${CAL_STATE_KEY_PREFIX}:${stateObject.agg_id}`
    await redis.setAsync(redisKey, JSON.stringify(calStateObject), 'EX', PROOF_STATE_CACHE_EXPIRE_MINUTES * 60)
  }
  return true
}

async function writeAnchorBTCAggStateObjectAsync (stateObject) {
  let calId = parseInt(stateObject.cal_id, 10)
  if (isNaN(calId)) throw new Error(`cal_id value '${stateObject.cal_id}' is not an integer`)
  let anchorBTCAggStateObject = {
    cal_id: calId,
    anchor_btc_agg_id: stateObject.anchor_btc_agg_id,
    anchor_btc_agg_state: JSON.stringify(stateObject.anchor_btc_agg_state)
  }
  await AnchorBTCAggStates.upsert(anchorBTCAggStateObject)
  // Store the state object in redis to cache for next request
  if (redis) {
    let redisKey = `${ANCHOR_BTC_AGG_STATE_KEY_PREFIX}:${stateObject.calId}`
    await redis.setAsync(redisKey, JSON.stringify(anchorBTCAggStateObject), 'EX', PROOF_STATE_CACHE_EXPIRE_MINUTES * 60)
  }
  return true
}

async function writeBTCTxStateObjectAsync (stateObject) {
  let btcTxStateObject = {
    anchor_btc_agg_id: stateObject.anchor_btc_agg_id,
    btctx_id: stateObject.btctx_id,
    btctx_state: JSON.stringify(stateObject.btctx_state)
  }
  await BtcTxStates.upsert(btcTxStateObject)
  // Store the state object in redis to cache for next request
  if (redis) {
    let redisKey = `${BTC_TX_STATE_KEY_PREFIX}:${stateObject.anchor_btc_agg_id}`
    await redis.setAsync(redisKey, JSON.stringify(btcTxStateObject), 'EX', PROOF_STATE_CACHE_EXPIRE_MINUTES * 60)
  }
  return true
}

async function writeBTCHeadStateObjectAsync (stateObject) {
  let btcHeadHeight = parseInt(stateObject.btchead_height, 10)
  if (isNaN(btcHeadHeight)) throw new Error(`btchead_height value '${stateObject.cal_id}' is not an integer`)
  let btcHeadStateObject = {
    btctx_id: stateObject.btctx_id,
    btchead_height: btcHeadHeight,
    btchead_state: JSON.stringify(stateObject.btchead_state)
  }
  await BtcHeadStates.upsert(btcHeadStateObject)
  // Store the state object in redis to cache for next request
  if (redis) {
    let redisKey = `${BTC_HEAD_STATE_KEY_PREFIX}:${stateObject.btctx_id}`
    await redis.setAsync(redisKey, JSON.stringify(btcHeadStateObject), 'EX', PROOF_STATE_CACHE_EXPIRE_MINUTES * 60)
  }
  return true
}

async function pruneProofStateTableAsync (model, expHours, limit) {
  let cutoffDate = new Date(Date.now() - expHours * 60 * 60 * 1000)
  let totalCount = 0
  let pruneCount = 0
  // continually delete old proof state rows in batches until all are gone
  do {
    pruneCount = await model.destroy({ where: { created_at: { [Op.lt]: cutoffDate } }, limit: limit })
    totalCount += pruneCount
  } while (pruneCount > 0)
  return totalCount
}

async function pruneAggStatesAsync () {
  return pruneProofStateTableAsync(AggStates, PROOF_STATE_EXPIRE_HOURS, 100)
}

async function pruneCalStatesAsync () {
  return pruneProofStateTableAsync(CalStates, PROOF_STATE_EXPIRE_HOURS, 100)
}

async function pruneAnchorBTCAggStatesAsync () {
  return pruneProofStateTableAsync(AnchorBTCAggStates, PROOF_STATE_EXPIRE_HOURS, 100)
}

async function pruneBtcTxStatesAsync () {
  return pruneProofStateTableAsync(BtcTxStates, PROOF_STATE_EXPIRE_HOURS, 100)
}

async function pruneBtcHeadStatesAsync () {
  return pruneProofStateTableAsync(BtcHeadStates, PROOF_STATE_EXPIRE_HOURS, 100)
}

module.exports = {
  openConnectionAsync: openConnectionAsync,
  getHashIdsByAggIdAsync: getHashIdsByAggIdAsync,
  getHashIdsByBtcTxIdAsync: getHashIdsByBtcTxIdAsync,
  getAggStateObjectByHashIdAsync: getAggStateObjectByHashIdAsync,
  getCalStateObjectByAggIdAsync: getCalStateObjectByAggIdAsync,
  getAnchorBTCAggStateObjectByCalIdAsync: getAnchorBTCAggStateObjectByCalIdAsync,
  getBTCTxStateObjectByAnchorBTCAggIdAsync: getBTCTxStateObjectByAnchorBTCAggIdAsync,
  getBTCHeadStateObjectByBTCTxIdAsync: getBTCHeadStateObjectByBTCTxIdAsync,
  writeAggStateObjectsBulkAsync: writeAggStateObjectsBulkAsync,
  writeCalStateObjectAsync: writeCalStateObjectAsync,
  writeAnchorBTCAggStateObjectAsync: writeAnchorBTCAggStateObjectAsync,
  writeBTCTxStateObjectAsync: writeBTCTxStateObjectAsync,
  writeBTCHeadStateObjectAsync: writeBTCHeadStateObjectAsync,
  pruneAggStatesAsync: pruneAggStatesAsync,
  pruneCalStatesAsync: pruneCalStatesAsync,
  pruneAnchorBTCAggStatesAsync: pruneAnchorBTCAggStatesAsync,
  pruneBtcTxStatesAsync: pruneBtcTxStatesAsync,
  pruneBtcHeadStatesAsync: pruneBtcHeadStatesAsync,
  sequelize: sequelize,
  setRedis: (r) => { redis = r }
}
