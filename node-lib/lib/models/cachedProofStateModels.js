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
  operatorsAliases: false,
  pool: {
    max: 20,
    min: 0,
    idle: 10000,
    acquire: 10000,
    evict: 10000
  }
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
// In the event of Redis failure, function calls will return successfully as long as DB calls succeed
// Optimally, values will be cached and read from Redis where appropriate
let redis = null

// How many hours any piece of proof state data is retained before pruning
const PROOF_STATE_EXPIRE_HOURS = 6
// How many hours any piece of proof state data is cached
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
    },
    raw: true
  })
  return results
}

async function getHashIdsByAggIdsAsync (aggIds) {
  let results = await AggStates.findAll({
    attributes: ['hash_id'],
    where: {
      agg_id: { [Op.in]: aggIds }
    },
    raw: true
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
    },
    raw: true
  })
  return result
}

async function getAggStateObjectsByHashIdsAsync (hashIds) {
  let results = await AggStates.findAll({
    where: {
      hash_id: { [Op.in]: hashIds }
    },
    raw: true
  })
  return results
}

async function getCalStateObjectByAggIdAsync (aggId) {
  let redisKey = `${CAL_STATE_KEY_PREFIX}:${aggId}`
  if (redis) {
    try {
      let cacheResult = await redis.getAsync(redisKey)
      if (cacheResult) return JSON.parse(cacheResult)
    } catch (error) {
      console.error(`Redis read error : getCalStateObjectByAggIdAsync : ${error.message}`)
    }
  }
  let result = await CalStates.findOne({
    where: {
      agg_id: aggId
    },
    raw: true
  })
  // We've made it this far, so either redis is null,
  // or more likely, there was no cache hit and the database was queried.
  // Store the query result in redis to cache for next request
  if (redis) {
    try {
      await redis.setAsync(redisKey, JSON.stringify(result), 'EX', PROOF_STATE_CACHE_EXPIRE_MINUTES * 60)
    } catch (error) {
      console.error(`Redis write error : getCalStateObjectByAggIdAsync : ${error.message}`)
    }
  }
  return result
}

async function getCalStateObjectsByAggIdsAsync (aggIds) {
  let aggIdData = aggIds.map((aggId) => { return { aggId: aggId, data: null } })

  if (redis) {
    let multi = redis.multi()

    aggIdData.forEach((aggIdDataTableItem) => {
      multi.get(`${CAL_STATE_KEY_PREFIX}:${aggIdDataTableItem.aggId}`)
    })

    let redisResults
    try {
      redisResults = await multi.execAsync()
    } catch (error) {
      console.error(`Redis write error : getCalStateObjectsByAggIdsAsync : ${error.message}`)
    }

    // assign the redis results to the corresponding item in aggIdDataTable
    aggIdData = aggIdData.map((item, index) => { item.data = redisResults[index]; return item })

    let nullDataCount = aggIdData.reduce((total, item) => item.data === null ? total : ++total, 0)
    // if all data was retrieved from redis, we are done, return it
    if (nullDataCount === 0) return aggIdData.map((item) => item.data)
  }

  // get an array of aggIds that we need cal state data for
  let aggIdsNullData = aggIdData.filter((item) => item.data === null).map((item) => item.aggId)
  let dbResult = await CalStates.findAll({
    where: {
      agg_id: { [Op.in]: aggIdsNullData }
    },
    raw: true
  })
  // construct a final result array from the aggIdDataTable data and from dbResult
  let cachedData = aggIdData.filter((item) => item.data != null).map((item) => JSON.parse(item.data))

  let finalResult = [...dbResult, ...cachedData]

  // We've made it this far, so either redis is null,
  // or more likely, there was no cache hit for some data and the database was queried.
  // Store the query result in redis to cache for next request
  if (redis) {
    let multi = redis.multi()

    dbResult.forEach((dbRow) => {
      multi.set(`${CAL_STATE_KEY_PREFIX}:${dbRow.agg_id}`, JSON.stringify(dbRow), 'EX', PROOF_STATE_CACHE_EXPIRE_MINUTES * 60)
    })

    try {
      await multi.execAsync()
    } catch (error) {
      console.error(`Redis write error : getCalStateObjectsByAggIdsAsync : ${error.message}`)
    }
  }
  return finalResult
}

async function getAnchorBTCAggStateObjectByCalIdAsync (calId) {
  let redisKey = `${ANCHOR_BTC_AGG_STATE_KEY_PREFIX}:${calId}`
  if (redis) {
    try {
      let cacheResult = await redis.getAsync(redisKey)
      if (cacheResult) return JSON.parse(cacheResult)
    } catch (error) {
      console.error(`Redis read error : getAnchorBTCAggStateObjectByCalIdAsync : ${error.message}`)
    }
  }
  let result = await AnchorBTCAggStates.findOne({
    where: {
      cal_id: calId
    },
    raw: true
  })
  // We've made it this far, so either redis is null,
  // or more likely, there was no cache hit and the database was queried.
  // Store the query result in redis to cache for next request
  if (redis) {
    try {
      await redis.setAsync(redisKey, JSON.stringify(result), 'EX', PROOF_STATE_CACHE_EXPIRE_MINUTES * 60)
    } catch (error) {
      console.error(`Redis write error : getAnchorBTCAggStateObjectByCalIdAsync : ${error.message}`)
    }
  }
  return result
}

async function getBTCTxStateObjectByAnchorBTCAggIdAsync (anchorBTCAggId) {
  let redisKey = `${BTC_TX_STATE_KEY_PREFIX}:${anchorBTCAggId}`
  if (redis) {
    try {
      let cacheResult = await redis.getAsync(redisKey)
      if (cacheResult) return JSON.parse(cacheResult)
    } catch (error) {
      console.error(`Redis read error : getBTCTxStateObjectByAnchorBTCAggIdAsync : ${error.message}`)
    }
  }
  let result = await BtcTxStates.findOne({
    where: {
      anchor_btc_agg_id: anchorBTCAggId
    },
    raw: true
  })
  // We've made it this far, so either redis is null,
  // or more likely, there was no cache hit and the database was queried.
  // Store the query result in redis to cache for next request
  if (redis) {
    try {
      await redis.setAsync(redisKey, JSON.stringify(result), 'EX', PROOF_STATE_CACHE_EXPIRE_MINUTES * 60)
    } catch (error) {
      console.error(`Redis write error : getBTCTxStateObjectByAnchorBTCAggIdAsync : ${error.message}`)
    }
  }
  return result
}

async function getBTCHeadStateObjectByBTCTxIdAsync (btcTxId) {
  let redisKey = `${BTC_HEAD_STATE_KEY_PREFIX}:${btcTxId}`
  if (redis) {
    try {
      let cacheResult = await redis.getAsync(redisKey)
      if (cacheResult) return JSON.parse(cacheResult)
    } catch (error) {
      console.error(`Redis read error : getBTCHeadStateObjectByBTCTxIdAsync : ${error.message}`)
    }
  }
  let result = await BtcHeadStates.findOne({
    where: {
      btctx_id: btcTxId
    },
    raw: true
  })
  // We've made it this far, so either redis is null,
  // or more likely, there was no cache hit and the database was queried.
  // Store the query result in redis to cache for next request
  if (redis) {
    try {
      await redis.setAsync(redisKey, JSON.stringify(result), 'EX', PROOF_STATE_CACHE_EXPIRE_MINUTES * 60)
    } catch (error) {
      console.error(`Redis write error : getBTCHeadStateObjectByBTCTxIdAsync : ${error.message}`)
    }
  }
  return result
}

async function writeAggStateObjectsBulkAsync (stateObjects) {
  let insertCmd = 'INSERT INTO chainpoint_proof_agg_states (hash_id, hash, agg_id, agg_state, created_at, updated_at) VALUES '

  let insertValues = stateObjects.map((stateObject) => {
    // use sequelize.escape() to sanitize input values just to be safe
    let hashId = sequelize.escape(stateObject.hash_id)
    let hash = sequelize.escape(stateObject.hash)
    let aggId = sequelize.escape(stateObject.agg_id)
    let aggState = sequelize.escape(JSON.stringify(stateObject.agg_state))
    return `(${hashId}, ${hash}, ${aggId}, ${aggState}, now(), now())`
  })

  insertCmd = insertCmd + insertValues.join(', ') + ' ON CONFLICT (hash_id) DO NOTHING'

  await sequelize.query(insertCmd, { type: sequelize.QueryTypes.INSERT })
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
    try {
      let redisKey = `${CAL_STATE_KEY_PREFIX}:${stateObject.agg_id}`
      await redis.setAsync(redisKey, JSON.stringify(calStateObject), 'EX', PROOF_STATE_CACHE_EXPIRE_MINUTES * 60)
    } catch (error) {
      console.error(`Redis write error : writeCalStateObjectAsync : ${error.message}`)
    }
  }
  return true
}

async function writeCalStateObjectsBulkAsync (stateObjects) {
  let insertCmd = 'INSERT INTO chainpoint_proof_cal_states (agg_id, cal_id, cal_state, created_at, updated_at) VALUES '

  stateObjects = stateObjects.map((stateObj) => { stateObj.cal_state = JSON.stringify(stateObj.cal_state); return stateObj })
  let insertValues = stateObjects.map((stateObject) => {
    // use sequelize.escape() to sanitize input values just to be safe
    let aggId = sequelize.escape(stateObject.agg_id)
    let calId = sequelize.escape(stateObject.cal_id)
    let calState = sequelize.escape(stateObject.cal_state)
    return `(${aggId}, ${calId}, ${calState}, now(), now())`
  })

  insertCmd = insertCmd + insertValues.join(', ') + ' ON CONFLICT (agg_id) DO NOTHING'

  await sequelize.query(insertCmd, { type: sequelize.QueryTypes.INSERT })

  // Store the state object in redis to cache for next request
  if (redis) {
    let multi = redis.multi()

    stateObjects.forEach((stateObj) => {
      multi.set(`${CAL_STATE_KEY_PREFIX}:${stateObj.agg_id}`, JSON.stringify(stateObj), 'EX', PROOF_STATE_CACHE_EXPIRE_MINUTES * 60)
    })

    try {
      await multi.execAsync()
    } catch (error) {
      console.error(`Redis write error : writeCalStateObjectsBulkAsync : ${error.message}`)
    }
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
    try {
      let redisKey = `${ANCHOR_BTC_AGG_STATE_KEY_PREFIX}:${stateObject.calId}`
      await redis.setAsync(redisKey, JSON.stringify(anchorBTCAggStateObject), 'EX', PROOF_STATE_CACHE_EXPIRE_MINUTES * 60)
    } catch (error) {
      console.error(`Redis write error : writeAnchorBTCAggStateObjectAsync : ${error.message}`)
    }
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
    try {
      let redisKey = `${BTC_TX_STATE_KEY_PREFIX}:${stateObject.anchor_btc_agg_id}`
      await redis.setAsync(redisKey, JSON.stringify(btcTxStateObject), 'EX', PROOF_STATE_CACHE_EXPIRE_MINUTES * 60)
    } catch (error) {
      console.error(`Redis write error : writeBTCTxStateObjectAsync : ${error.message}`)
    }
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
    try {
      let redisKey = `${BTC_HEAD_STATE_KEY_PREFIX}:${stateObject.btctx_id}`
      await redis.setAsync(redisKey, JSON.stringify(btcHeadStateObject), 'EX', PROOF_STATE_CACHE_EXPIRE_MINUTES * 60)
    } catch (error) {
      console.error(`Redis write error : writeBTCHeadStateObjectAsync : ${error.message}`)
    }
  }
  return true
}

async function pruneProofStateTableByIdsAsync (model, pkColumnName, ids) {
  // create whereClause object to allow for dynamic column assignment in WHERE
  let whereClause = {}
  whereClause[pkColumnName] = { [Op.in]: ids }
  let pruneCount = await model.destroy({ where: whereClause })
  return pruneCount
}

async function pruneAggStatesByIdsAsync (ids) {
  return pruneProofStateTableByIdsAsync(AggStates, 'hash_id', ids)
}

async function pruneCalStatesByIdsAsync (ids) {
  return pruneProofStateTableByIdsAsync(CalStates, 'agg_id', ids)
}

async function pruneAnchorBTCAggStatesByIdsAsync (ids) {
  return pruneProofStateTableByIdsAsync(AnchorBTCAggStates, 'cal_id', ids)
}

async function pruneBTCTxStatesByIdsAsync (ids) {
  return pruneProofStateTableByIdsAsync(BtcTxStates, 'anchor_btc_agg_id', ids)
}

async function pruneBTCHeadStatesByIdsAsync (ids) {
  return pruneProofStateTableByIdsAsync(BtcHeadStates, 'btctx_id', ids)
}

async function getExpiredPKValuesForModel (modelName) {
  let model = null
  let pkColName = null
  switch (modelName) {
    case 'agg_states':
      model = AggStates
      pkColName = 'hash_id'
      break
    case 'cal_states':
      model = CalStates
      pkColName = 'agg_id'
      break
    case 'anchor_btc_agg_states':
      model = AnchorBTCAggStates
      pkColName = 'cal_id'
      break
    case 'btctx_states':
      model = BtcTxStates
      pkColName = 'anchor_btc_agg_id'
      break
    case 'btchead_states':
      model = BtcHeadStates
      pkColName = 'btctx_id'
      break
  }
  if (model === null) throw new Error(`Unknown modelName : ${modelName}`)
  let pruneCutoffDate = new Date(Date.now() - PROOF_STATE_EXPIRE_HOURS * 60 * 60 * 1000)
  let primaryKeyVals = await model.findAll({ where: { created_at: { [Op.lte]: pruneCutoffDate } }, raw: true, attributes: [pkColName] })
  primaryKeyVals = primaryKeyVals.map((item) => { return item[pkColName] })
  return primaryKeyVals
}

module.exports = {
  openConnectionAsync: openConnectionAsync,
  getHashIdsByAggIdAsync: getHashIdsByAggIdAsync,
  getHashIdsByAggIdsAsync: getHashIdsByAggIdsAsync,
  getHashIdsByBtcTxIdAsync: getHashIdsByBtcTxIdAsync,
  getAggStateObjectByHashIdAsync: getAggStateObjectByHashIdAsync,
  getAggStateObjectsByHashIdsAsync: getAggStateObjectsByHashIdsAsync,
  getCalStateObjectByAggIdAsync: getCalStateObjectByAggIdAsync,
  getCalStateObjectsByAggIdsAsync: getCalStateObjectsByAggIdsAsync,
  getAnchorBTCAggStateObjectByCalIdAsync: getAnchorBTCAggStateObjectByCalIdAsync,
  getBTCTxStateObjectByAnchorBTCAggIdAsync: getBTCTxStateObjectByAnchorBTCAggIdAsync,
  getBTCHeadStateObjectByBTCTxIdAsync: getBTCHeadStateObjectByBTCTxIdAsync,
  writeAggStateObjectsBulkAsync: writeAggStateObjectsBulkAsync,
  writeCalStateObjectAsync: writeCalStateObjectAsync,
  writeCalStateObjectsBulkAsync: writeCalStateObjectsBulkAsync,
  writeAnchorBTCAggStateObjectAsync: writeAnchorBTCAggStateObjectAsync,
  writeBTCTxStateObjectAsync: writeBTCTxStateObjectAsync,
  writeBTCHeadStateObjectAsync: writeBTCHeadStateObjectAsync,
  pruneAggStatesByIdsAsync: pruneAggStatesByIdsAsync,
  pruneCalStatesByIdsAsync: pruneCalStatesByIdsAsync,
  pruneAnchorBTCAggStatesByIdsAsync: pruneAnchorBTCAggStatesByIdsAsync,
  pruneBTCTxStatesByIdsAsync: pruneBTCTxStatesByIdsAsync,
  pruneBTCHeadStatesByIdsAsync: pruneBTCHeadStatesByIdsAsync,
  getExpiredPKValuesForModel: getExpiredPKValuesForModel,
  sequelize: sequelize,
  setRedis: (r) => { redis = r }
}
