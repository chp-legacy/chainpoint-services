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

// How many hours any piece of proof state data is retained until pruned
const PROOF_STATE_EXPIRE_HOURS = 12

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

let HashTrackerLog = sequelize.define('chainpoint_proof_hash_tracker_log', {
  hash_id: { type: Sequelize.UUID, primaryKey: true },
  hash: { type: Sequelize.STRING },
  aggregator_at: { type: Sequelize.DATE },
  calendar_at: { type: Sequelize.DATE },
  btc_at: { type: Sequelize.DATE },
  eth_at: { type: Sequelize.DATE },
  steps_complete: { type: Sequelize.INTEGER }
}, {
  indexes: [
    {
      fields: ['steps_complete']
    },
    {
      name: 'hash_id_and_steps_complete',
      fields: ['hash_id', 'steps_complete']
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
  let result = await CalStates.findOne({
    where: {
      agg_id: aggId
    }
  })
  return result
}

async function getAnchorBTCAggStateObjectByCalIdAsync (calId) {
  let result = await AnchorBTCAggStates.findOne({
    where: {
      cal_id: calId
    }
  })
  return result
}

async function getBTCTxStateObjectByAnchorBTCAggIdAsync (anchorBTCAggId) {
  let result = await BtcTxStates.findOne({
    where: {
      anchor_btc_agg_id: anchorBTCAggId
    }
  })
  return result
}

async function getBTCHeadStateObjectByBTCTxIdAsync (btcTxId) {
  let result = await BtcHeadStates.findOne({
    where: {
      btctx_id: btcTxId
    }
  })
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
  return true
}

async function writeBTCTxStateObjectAsync (stateObject) {
  let BTCTxStateObject = {
    anchor_btc_agg_id: stateObject.anchor_btc_agg_id,
    btctx_id: stateObject.btctx_id,
    btctx_state: JSON.stringify(stateObject.btctx_state)
  }
  await BtcTxStates.upsert(BTCTxStateObject)
  return true
}

async function writeBTCHeadStateObjectAsync (stateObject) {
  let btcHeadHeight = parseInt(stateObject.btchead_height, 10)
  if (isNaN(btcHeadHeight)) throw new Error(`btchead_height value '${stateObject.cal_id}' is not an integer`)
  let BTCHeadStateObject = {
    btctx_id: stateObject.btctx_id,
    btchead_height: btcHeadHeight,
    btchead_state: JSON.stringify(stateObject.btchead_state)
  }
  await BtcHeadStates.upsert(BTCHeadStateObject)
  return true
}

async function logAggregatorEventsForHashIdsBulkAsync (hashesInfo) {
  let logWriteTime = new Date()
  let newHashTrackerLogs = hashesInfo.map((hashInfo) => {
    return {
      hash_id: hashInfo.hash_id,
      hash: hashInfo.hash,
      aggregator_at: logWriteTime,
      calendar_at: null,
      btc_at: null,
      eth_at: null,
      steps_complete: 1
    }
  })
  await HashTrackerLog.bulkCreate(newHashTrackerLogs)
  return true
}

async function logCalendarEventForHashIdAsync (hashId) {
  let logWriteTime = new Date()
  let hashTrackerLogObject = {
    calendar_at: logWriteTime,
    steps_complete: sequelize.literal('steps_complete + 1')
  }
  await HashTrackerLog.update(hashTrackerLogObject, { where: { hash_id: hashId } })
  return true
}

async function logBtcEventForHashIdAsync (hashId) {
  let logWriteTime = new Date()
  let hashTrackerLogObject = {
    btc_at: logWriteTime,
    steps_complete: sequelize.literal('steps_complete + 1')
  }
  await HashTrackerLog.update(hashTrackerLogObject, { where: { hash_id: hashId } })
  return true
}

async function pruneAggStatesAsync () {
  let cutoffDate = new Date(Date.now() - PROOF_STATE_EXPIRE_HOURS * 60 * 60 * 1000)
  let resultCount = await AggStates.destroy({ where: { created_at: { [Op.lt]: cutoffDate } } })
  return resultCount
}

async function pruneHashTrackerLogsAsync () {
  let cutoffDate = new Date(Date.now() - PROOF_STATE_EXPIRE_HOURS * 60 * 60 * 1000)
  let resultCount = await HashTrackerLog.destroy({ where: { created_at: { [Op.lt]: cutoffDate } } })
  return resultCount
}

async function pruneCalStatesAsync () {
  let cutoffDate = new Date(Date.now() - PROOF_STATE_EXPIRE_HOURS * 60 * 60 * 1000)
  let resultCount = await CalStates.destroy({ where: { created_at: { [Op.lt]: cutoffDate } } })
  return resultCount
}

async function pruneAnchorBTCAggStatesAsync () {
  let cutoffDate = new Date(Date.now() - PROOF_STATE_EXPIRE_HOURS * 60 * 60 * 1000)
  let resultCount = await AnchorBTCAggStates.destroy({ where: { created_at: { [Op.lt]: cutoffDate } } })
  return resultCount
}

async function pruneBtcTxStatesAsync () {
  let cutoffDate = new Date(Date.now() - PROOF_STATE_EXPIRE_HOURS * 60 * 60 * 1000)
  let resultCount = await BtcTxStates.destroy({ where: { created_at: { [Op.lt]: cutoffDate } } })
  return resultCount
}

async function pruneBtcHeadStatesAsync () {
  let cutoffDate = new Date(Date.now() - PROOF_STATE_EXPIRE_HOURS * 60 * 60 * 1000)
  let resultCount = await BtcHeadStates.destroy({ where: { created_at: { [Op.lt]: cutoffDate } } })
  return resultCount
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
  logAggregatorEventsForHashIdsBulkAsync: logAggregatorEventsForHashIdsBulkAsync,
  logCalendarEventForHashIdAsync: logCalendarEventForHashIdAsync,
  logBtcEventForHashIdAsync: logBtcEventForHashIdAsync,
  pruneAggStatesAsync: pruneAggStatesAsync,
  pruneHashTrackerLogsAsync: pruneHashTrackerLogsAsync,
  pruneCalStatesAsync: pruneCalStatesAsync,
  pruneAnchorBTCAggStatesAsync: pruneAnchorBTCAggStatesAsync,
  pruneBtcTxStatesAsync: pruneBtcTxStatesAsync,
  pruneBtcHeadStatesAsync: pruneBtcHeadStatesAsync,
  sequelize: sequelize
}
