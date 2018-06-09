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

// table for state data connecting individual hashes to aggregation roots
let CoreNetworkState = sequelize.define('chainpoint_core_network_state', {
  stateKey: { type: Sequelize.STRING, primaryKey: true, field: 'state_key', allowNull: false },
  stateValue: { type: Sequelize.STRING, field: 'state_value', allowNull: false }
}, {
    // enable timestamps
  timestamps: true,
    // don't use camelcase for automatically added attributes but underscore style
    // so updatedAt will be updated_at
  underscored: true,
  indexes: [
    {
      unique: true,
      fields: ['state_key', 'state_value']
    }
  ]
})

const LAST_AGG_STATE_PROCESSED_FOR_CAL_BLOCK_TIMESTAMP = 'LAST_AGG_STATE_PROCESSED_FOR_CAL_BLOCK_TIMESTAMP'
const LAST_CAL_BLOCK_HEIGHT_PROCESSED_FOR_BTC_A_BLOCK = 'LAST_CAL_BLOCK_HEIGHT_PROCESSED_FOR_BTC_A_BLOCK'

async function getLastAggStateProcessedForCalBlockTimestamp () {
  let results = await CoreNetworkState.find({ where: { stateKey: LAST_AGG_STATE_PROCESSED_FOR_CAL_BLOCK_TIMESTAMP }, raw: true })
  return results ? results.stateValue : null
}

async function setLastAggStateProcessedForCalBlockTimestamp (value) {
  let stateObject = {
    stateKey: LAST_AGG_STATE_PROCESSED_FOR_CAL_BLOCK_TIMESTAMP,
    stateValue: value.toString()
  }
  await CoreNetworkState.upsert(stateObject)
}

async function getLastCalBlockHeightProcessedForBtcABlock () {
  let results = await CoreNetworkState.find({ where: { stateKey: LAST_CAL_BLOCK_HEIGHT_PROCESSED_FOR_BTC_A_BLOCK }, raw: true })
  return results ? results.stateValue : null
}

async function setLastCalBlockHeightProcessedForBtcABlock (value) {
  let stateObject = {
    stateKey: LAST_CAL_BLOCK_HEIGHT_PROCESSED_FOR_BTC_A_BLOCK,
    stateValue: value.toString()
  }
  await CoreNetworkState.upsert(stateObject)
}

module.exports = {
  getLastAggStateProcessedForCalBlockTimestamp: getLastAggStateProcessedForCalBlockTimestamp,
  getLastCalBlockHeightProcessedForBtcABlock: getLastCalBlockHeightProcessedForBtcABlock,
  setLastAggStateProcessedForCalBlockTimestamp: setLastAggStateProcessedForCalBlockTimestamp,
  setLastCalBlockHeightProcessedForBtcABlock: setLastCalBlockHeightProcessedForBtcABlock,
  sequelize: sequelize
}
