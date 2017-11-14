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

// PostgreSQL DB storage adapter
let Sequelize = require('sequelize')

const envalid = require('envalid')

const env = envalid.cleanEnv(process.env, {
  POSTGRES_CONNECT_PROTOCOL: envalid.str({ default: 'postgres:', desc: 'Postgres server connection protocol' }),
  POSTGRES_CONNECT_USER: envalid.str({ default: 'chainpoint', desc: 'Postgres server connection user name' }),
  POSTGRES_CONNECT_PW: envalid.str({ default: 'chainpoint', desc: 'Postgres server connection password' }),
  POSTGRES_CONNECT_HOST: envalid.str({ default: 'postgres', desc: 'Postgres server connection host' }),
  POSTGRES_CONNECT_PORT: envalid.num({ default: 5432, desc: 'Postgres server connection port' }),
  POSTGRES_CONNECT_DB: envalid.str({ default: 'chainpoint', desc: 'Postgres server connection database name' })
})

// How many hours any piece of proof state data is retained until pruned
const PROOF_STATE_EXPIRE_HOURS = 3

// Connection URI for Postgres
const POSTGRES_CONNECT_URI = `${env.POSTGRES_CONNECT_PROTOCOL}//${env.POSTGRES_CONNECT_USER}:${env.POSTGRES_CONNECT_PW}@${env.POSTGRES_CONNECT_HOST}:${env.POSTGRES_CONNECT_PORT}/${env.POSTGRES_CONNECT_DB}`

const sequelize = new Sequelize(POSTGRES_CONNECT_URI, { logging: null, operatorsAliases: false })

// table for state data connecting individual hashes to aggregation roots
let AggStates = sequelize.define('agg_states', {
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
      fields: ['updated_at']
    }
  ],
    // enable timestamps
  timestamps: true,
    // don't use camelcase for automatically added attributes but underscore style
    // so updatedAt will be updated_at
  underscored: true
})

// table for state data connecting aggregation roots to calendar block hashes
let CalStates = sequelize.define('cal_states', {
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
let AnchorBTCAggStates = sequelize.define('anchor_btc_agg_states', {
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
let BtcTxStates = sequelize.define('btctx_states', {
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
let BtcHeadStates = sequelize.define('btchead_states', {
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

let HashTrackerLog = sequelize.define('hash_tracker_log', {
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
  let results = await sequelize.query(`SELECT a.hash_id FROM agg_states a 
    INNER JOIN cal_states c ON c.agg_id = a.agg_id 
    INNER JOIN anchor_btc_agg_states aa ON aa.cal_id = c.cal_id 
    INNER JOIN btctx_states tx ON tx.anchor_btc_agg_id = aa.anchor_btc_agg_id 
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

async function getAggStateObjectsByAggIdAsync (aggId) {
  let results = await AggStates.findAll({
    where: {
      agg_id: aggId
    }
  })
  return results
}

async function getCalStateObjectsByCalIdAsync (calId) {
  let results = await CalStates.findAll({
    where: {
      cal_id: calId
    }
  })
  return results
}

async function getAnchorBTCAggStateObjectsByAnchorBTCAggIdAsync (anchorBTCAggId) {
  let results = await AnchorBTCAggStates.findAll({
    where: {
      anchor_btc_agg_id: anchorBTCAggId
    }
  })
  return results
}

async function getBTCTxStateObjectsByBTCTxIdAsync (btcTxId) {
  let results = await BtcTxStates.findAll({
    where: {
      btctx_id: btcTxId
    }
  })
  return results
}

async function getBTCHeadStateObjectsByBTCHeadIdAsync (btcHeadId) {
  let results = await BtcHeadStates.findAll({
    where: {
      btchead_id: btcHeadId
    }
  })
  return results
}

async function writeAggStateObjectAsync (stateObject) {
  let stateString = JSON.stringify(stateObject.agg_state)
  await sequelize.query(`INSERT INTO agg_states (hash_id, hash, agg_id, agg_state, created_at, updated_at)
    VALUES ('${stateObject.hash_id}', '${stateObject.hash}', '${stateObject.agg_id}', '${stateString}', clock_timestamp(), clock_timestamp())
    ON CONFLICT (hash_id)
    DO UPDATE SET (hash, agg_id, agg_state, updated_at) = ('${stateObject.hash}', '${stateObject.agg_id}', '${stateString}', clock_timestamp())
    WHERE agg_states.hash_id = '${stateObject.hash_id}'`)
  return true
}

async function writeAggStateObjectsAsync (stateObjects) {
  let writeTime = new Date()
  let newStateObjects = stateObjects.map((stateObject) => {
    return {
      hash_id: stateObject.hash_id,
      hash: stateObject.hash,
      agg_id: stateObject.agg_id,
      agg_state: JSON.stringify(stateObject.agg_state),
      created_at: writeTime,
      updated_at: writeTime
    }
  })
  for (let x = 0; x < newStateObjects.length; x++) {
    await sequelize.query(`INSERT INTO agg_states (hash_id, hash, agg_id, agg_state, created_at, updated_at)
      VALUES ('${newStateObjects[x].hash_id}', '${newStateObjects[x].hash}', '${newStateObjects[x].agg_id}', '${newStateObjects[x].agg_state}', clock_timestamp(), clock_timestamp())
      ON CONFLICT (hash_id)
      DO UPDATE SET (hash, agg_id, agg_state, updated_at) = ('${newStateObjects[x].hash}', '${newStateObjects[x].agg_id}', '${newStateObjects[x].agg_state}', clock_timestamp())
      WHERE agg_states.hash_id = '${newStateObjects[x].hash_id}'`)
  }
  return true
}

async function writeAggStateObjectsBulkAsync (stateObjects, transaction) {
  let newAggStates = stateObjects.map((stateObject) => {
    return {
      hash_id: stateObject.hash_id,
      hash: stateObject.hash,
      agg_id: stateObject.agg_id,
      agg_state: JSON.stringify(stateObject.agg_state)
    }
  })
  await AggStates.bulkCreate(newAggStates, { transaction: transaction })
  return true
}

async function writeCalStateObjectAsync (stateObject) {
  let stateString = JSON.stringify(stateObject.cal_state)
  await sequelize.query(`INSERT INTO cal_states (agg_id, cal_id, cal_state, created_at, updated_at)
    VALUES ('${stateObject.agg_id}', '${stateObject.cal_id}', '${stateString}', clock_timestamp(), clock_timestamp())
    ON CONFLICT (agg_id)
    DO UPDATE SET (cal_id, cal_state, updated_at) = ('${stateObject.cal_id}', '${stateString}', clock_timestamp())
    WHERE cal_states.agg_id = '${stateObject.agg_id}'`)
  return true
}

async function writeAnchorBTCAggStateObjectAsync (stateObject) {
  let stateString = JSON.stringify(stateObject.anchor_btc_agg_state)
  await sequelize.query(`INSERT INTO anchor_btc_agg_states (cal_id, anchor_btc_agg_id, anchor_btc_agg_state, created_at, updated_at)
    VALUES ('${stateObject.cal_id}', '${stateObject.anchor_btc_agg_id}', '${stateString}', clock_timestamp(), clock_timestamp())
    ON CONFLICT (cal_id)
    DO UPDATE SET (anchor_btc_agg_id, anchor_btc_agg_state, updated_at) = ('${stateObject.anchor_btc_agg_id}', '${stateString}', clock_timestamp())
    WHERE anchor_btc_agg_states.cal_id = '${stateObject.cal_id}'`)
  return true
}

async function writeBTCTxStateObjectAsync (stateObject) {
  let stateString = JSON.stringify(stateObject.btctx_state)
  await sequelize.query(`INSERT INTO btctx_states (anchor_btc_agg_id, btctx_id, btctx_state, created_at, updated_at)
    VALUES ('${stateObject.anchor_btc_agg_id}', '${stateObject.btctx_id}', '${stateString}', clock_timestamp(), clock_timestamp())
    ON CONFLICT (anchor_btc_agg_id)
    DO UPDATE SET (btctx_id, btctx_state, updated_at) = ('${stateObject.btctx_id}', '${stateString}', clock_timestamp())
    WHERE btctx_states.anchor_btc_agg_id = '${stateObject.anchor_btc_agg_id}'`)
  return true
}

async function writeBTCHeadStateObjectAsync (stateObject) {
  let stateString = JSON.stringify(stateObject.btchead_state)
  await sequelize.query(`INSERT INTO btchead_states (btctx_id, btchead_height, btchead_state, created_at, updated_at)
    VALUES ('${stateObject.btctx_id}', '${stateObject.btchead_height}', '${stateString}', clock_timestamp(), clock_timestamp())
    ON CONFLICT (btctx_id)
    DO UPDATE SET (btchead_height, btchead_state, updated_at) = ('${stateObject.btchead_height}', '${stateString}', clock_timestamp())
    WHERE btchead_states.btctx_id = '${stateObject.btctx_id}'`)
  return true
}

async function logAggregatorEventForHashIdAsync (hashId, hash) {
  await sequelize.query(`INSERT INTO hash_tracker_logs (hash_id, hash, aggregator_at, steps_complete, created_at, updated_at)
    VALUES ('${hashId}', '${hash}', clock_timestamp(), 1, clock_timestamp(), clock_timestamp())
    ON CONFLICT (hash_id)
    DO UPDATE SET (hash, aggregator_at, steps_complete, updated_at) = ('${hash}', clock_timestamp(), hash_tracker_logs.steps_complete + 1, clock_timestamp())
    WHERE hash_tracker_logs.hash_id = '${hashId}'`)
  return true
}

async function logAggregatorEventsForHashIdsAsync (hashesInfo) {
  let writeTime = new Date()
  let newHashesInfo = hashesInfo.map((hashInfo) => {
    return {
      hash_id: hashInfo.hash_id,
      hash: hashInfo.hash,
      aggregator_at: writeTime,
      steps_complete: 1,
      created_at: writeTime,
      updated_at: writeTime
    }
  })
  for (let x = 0; x < newHashesInfo.length; x++) {
    await sequelize.query(`INSERT INTO hash_tracker_logs (hash_id, hash, aggregator_at, steps_complete, created_at, updated_at)
    VALUES ('${newHashesInfo[x].hash_id}', '${newHashesInfo[x].hash}', clock_timestamp(), 1, clock_timestamp(), clock_timestamp())
    ON CONFLICT (hash_id)
    DO UPDATE SET (hash, aggregator_at, steps_complete, updated_at) = ('${newHashesInfo[x].hash}', clock_timestamp(), hash_tracker_logs.steps_complete + 1, clock_timestamp())
    WHERE hash_tracker_logs.hash_id = '${newHashesInfo[x].hash_id}'`)
  }
  return true
}

async function logAggregatorEventsForHashIdsBulkAsync (hashesInfo, transaction) {
  let writeTime = new Date()
  let newHashTrackerLogs = hashesInfo.map((hashInfo) => {
    return {
      hash_id: hashInfo.hash_id,
      hash: hashInfo.hash,
      aggregator_at: writeTime,
      calendar_at: null,
      btc_at: null,
      eth_at: null,
      steps_complete: 1
    }
  })
  await HashTrackerLog.bulkCreate(newHashTrackerLogs, { transaction: transaction })
  return true
}

async function logCalendarEventForHashIdAsync (hashId) {
  await sequelize.query(`INSERT INTO hash_tracker_logs (hash_id, calendar_at, steps_complete, created_at, updated_at)
    VALUES ('${hashId}', clock_timestamp(), 1, clock_timestamp(), clock_timestamp())
    ON CONFLICT (hash_id)
    DO UPDATE SET (calendar_at, steps_complete, updated_at) = (clock_timestamp(), hash_tracker_logs.steps_complete + 1, clock_timestamp())
    WHERE hash_tracker_logs.hash_id = '${hashId}'`)
  return true
}

async function logBtcEventForHashIdAsync (hashId) {
  await sequelize.query(`INSERT INTO hash_tracker_logs (hash_id, btc_at, steps_complete, created_at, updated_at)
    VALUES ('${hashId}', clock_timestamp(), 1, clock_timestamp(), clock_timestamp())
    ON CONFLICT (hash_id)
    DO UPDATE SET (btc_at, steps_complete, updated_at) = (clock_timestamp(), hash_tracker_logs.steps_complete + 1, clock_timestamp())
    WHERE hash_tracker_logs.hash_id = '${hashId}'`)
  return true
}

async function logEthEventForHashIdAsync (hashId) {
  await sequelize.query(`INSERT INTO hash_tracker_logs (hash_id, eth_at, steps_complete, created_at, updated_at)
    VALUES ('${hashId}', clock_timestamp(), 1, clock_timestamp(), clock_timestamp())
    ON CONFLICT (hash_id)
    DO UPDATE SET (eth_at, steps_complete, updated_at) = (clock_timestamp(), hash_tracker_logs.steps_complete + 1, clock_timestamp())
    WHERE hash_tracker_logs.hash_id = '${hashId}'`)
  return true
}

async function pruneAggStatesAsync () {
  let cutoffDate = new Date(Date.now() - PROOF_STATE_EXPIRE_HOURS * 60 * 60 * 1000)
  let resultCount = await AggStates.destroy({ where: { updated_at: { $lt: cutoffDate } } })
  return resultCount
}

async function pruneHashTrackerLogsAsync () {
  let cutoffDate = new Date(Date.now() - PROOF_STATE_EXPIRE_HOURS * 60 * 60 * 1000)
  let resultCount = await HashTrackerLog.destroy({ where: { created_at: { $lt: cutoffDate } } })
  return resultCount
}

async function pruneCalStatesAsync () {
  let cutoffDate = new Date(Date.now() - PROOF_STATE_EXPIRE_HOURS * 60 * 60 * 1000)
  let resultCount = await CalStates.destroy({ where: { created_at: { $lt: cutoffDate } } })
  return resultCount
}

async function pruneAnchorBTCAggStatesAsync () {
  let cutoffDate = new Date(Date.now() - PROOF_STATE_EXPIRE_HOURS * 60 * 60 * 1000)
  let resultCount = await AnchorBTCAggStates.destroy({ where: { created_at: { $lt: cutoffDate } } })
  return resultCount
}

async function pruneBtcTxStatesAsync () {
  let cutoffDate = new Date(Date.now() - PROOF_STATE_EXPIRE_HOURS * 60 * 60 * 1000)
  let resultCount = await BtcTxStates.destroy({ where: { created_at: { $lt: cutoffDate } } })
  return resultCount
}

async function pruneBtcHeadStatesAsync () {
  let cutoffDate = new Date(Date.now() - PROOF_STATE_EXPIRE_HOURS * 60 * 60 * 1000)
  let resultCount = await BtcHeadStates.destroy({ where: { created_at: { $lt: cutoffDate } } })
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
  getAggStateObjectsByAggIdAsync: getAggStateObjectsByAggIdAsync,
  getCalStateObjectsByCalIdAsync: getCalStateObjectsByCalIdAsync,
  getAnchorBTCAggStateObjectsByAnchorBTCAggIdAsync: getAnchorBTCAggStateObjectsByAnchorBTCAggIdAsync,
  getBTCTxStateObjectsByBTCTxIdAsync: getBTCTxStateObjectsByBTCTxIdAsync,
  getBTCHeadStateObjectsByBTCHeadIdAsync: getBTCHeadStateObjectsByBTCHeadIdAsync,
  writeAggStateObjectAsync: writeAggStateObjectAsync,
  writeAggStateObjectsBulkAsync: writeAggStateObjectsBulkAsync,
  writeAggStateObjectsAsync: writeAggStateObjectsAsync,
  writeCalStateObjectAsync: writeCalStateObjectAsync,
  writeAnchorBTCAggStateObjectAsync: writeAnchorBTCAggStateObjectAsync,
  writeBTCTxStateObjectAsync: writeBTCTxStateObjectAsync,
  writeBTCHeadStateObjectAsync: writeBTCHeadStateObjectAsync,
  logAggregatorEventForHashIdAsync: logAggregatorEventForHashIdAsync,
  logAggregatorEventsForHashIdsBulkAsync: logAggregatorEventsForHashIdsBulkAsync,
  logAggregatorEventsForHashIdsAsync: logAggregatorEventsForHashIdsAsync,
  logCalendarEventForHashIdAsync: logCalendarEventForHashIdAsync,
  logBtcEventForHashIdAsync: logBtcEventForHashIdAsync,
  logEthEventForHashIdAsync: logEthEventForHashIdAsync,
  pruneAggStatesAsync: pruneAggStatesAsync,
  pruneHashTrackerLogsAsync: pruneHashTrackerLogsAsync,
  pruneCalStatesAsync: pruneCalStatesAsync,
  pruneAnchorBTCAggStatesAsync: pruneAnchorBTCAggStatesAsync,
  pruneBtcTxStatesAsync: pruneBtcTxStatesAsync,
  pruneBtcHeadStatesAsync: pruneBtcHeadStatesAsync,
  sequelize: sequelize
}
