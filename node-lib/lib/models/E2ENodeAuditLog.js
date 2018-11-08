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
  COCKROACH_E2E_AUDIT_TABLE_NAME: envalid.str({ default: 'chainpoint_node_e2e_audit_log', desc: 'CockroachDB table name' }),
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

var E2ENodeAuditLog = sequelize.define(env.COCKROACH_E2E_AUDIT_TABLE_NAME,
  {
    tntAddr: {
      comment: 'A seemingly valid Ethereum address that the Node will send TNT from, or receive rewards with.',
      type: Sequelize.STRING,
      validate: {
        is: ['^0x[0-9a-f]{40}$']
      },
      field: 'tnt_addr',
      allowNull: false
    },
    auditDate: {
      comment: 'The time the audit was performed, (yyyymmdd).',
      type: Sequelize.STRING,
      validate: {
        is: ['[0-9]{8}']
      },
      field: 'audit_date',
      allowNull: false
    },
    publicUri: {
      comment: 'The public URI of the Node at the time of the audit.',
      type: Sequelize.STRING,
      validate: {
        isUrl: true
      },
      field: 'public_uri',
      allowNull: true
    },
    stage: {
      comment: 'Enum-like field with the following possible values ("hash_submission", "proof_retrieval", "proof_verification").',
      type: Sequelize.STRING,
      validate: {
        is: ['(hash_submission|proof_retrieval|proof_verification)']
      },
      field: 'stage',
      allowNull: false
    },
    status: {
      comment: 'Enum-like field with the following possible values ("pending", "passed", "submission_failure", "hash_mismatch_failure", "hash_id_node_validation_failure", "null_proof_failure", "invalid_cal_branch_failure").',
      type: Sequelize.STRING,
      validate: {
        is: ['(pending|passed|submission_failure|hash_mismatch_failure|hash_id_node_validation_failure|null_proof_failure|invalid_cal_branch_failure)']
      },
      field: 'status',
      allowNull: false
    },
    audit_at: {
      comment: 'The time that a "hash_submission" status was captured, in MS since EPOCH.',
      type: Sequelize.INTEGER,
      field: 'audit_at',
      allowNull: false
    }
  },
  {
    // No automatic timestamp fields, we add our own 'audit_at'
    timestamps: false,
    // Disable the modification of table names; By default, sequelize will automatically
    // transform all passed model names (first parameter of define) into plural.
    // if you don't want that, set the following
    freezeTableName: true,
    indexes: [
      {
        unique: false,
        fields: ['tnt_addr']
      },
      {
        unique: false,
        fields: ['audit_date']
      },
      {
        unique: false,
        fields: ['stage']
      }
    ]
  }
)

module.exports = {
  sequelize: sequelize,
  E2ENodeAuditLog: E2ENodeAuditLog
}
