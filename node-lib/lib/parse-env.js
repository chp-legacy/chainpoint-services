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

const envalid = require('envalid')

const validateAggInterval = envalid.makeValidator(x => {
  if (x >= 250 && x <= 10000) return x
  else throw new Error('Value must be between 250 and 10000, inclusive')
})
const validateMaxHashes = envalid.makeValidator(x => {
  if (x >= 100 && x <= 25000) return x
  else throw new Error('Value must be between 100 and 25000, inclusive')
})
const validateMonitorRange = envalid.makeValidator(x => {
  if (x >= 10 && x <= 600) return x
  else throw new Error('Value must be between 10 and 600, inclusive')
})
const validateMinConfirmRange = envalid.makeValidator(x => {
  if (x >= 1 && x <= 16) return x
  else throw new Error('Value must be between 1 and 16, inclusive')
})
const validateFactorOfSixty = envalid.makeValidator(x => {
  if (x > 0 && x <= 20 && 60 % x === 0) return x
  else throw new Error('Value must be a factor of 60, and no greater than 20')
})
const validateFactorOfSixtyUpToSixty = envalid.makeValidator(x => {
  if (x > 0 && x <= 60 && 60 % x === 0) return x
  else throw new Error('Value must be a factor of 60')
})
const validateETHAddress = envalid.makeValidator(x => {
  if (/^0x[0-9a-f]{40}$/i.test(x)) return x.toLowerCase()
  else throw new Error('Value must be a well formatted Ethereum address')
})
const validateETHAddressesCSV = envalid.makeValidator(x => {
  if (/^((0x[0-9a-f]{40})(,(0x[0-9a-f]{40}))*)+$/i.test(x)) return x.toLowerCase()
  else throw new Error('Value must be a comma separated list of well formatted Ethereum addresses')
})

let envDefinitions = {
  // The following variables are exposed by this stack's /config endpoint
  //
  // CHAINPOINT_CORE_BASE_URI: Base URI for this Chainpoint Core stack of services
  // ANCHOR_BTC: flag for enabling and disabling BTC anchoring
  // ANCHOR_ETH: flag for enabling and disabling ETH anchoring
  // PROOF_EXPIRE_MINUTES: The lifespan of stored proofs, in minutes
  // GET_PROOFS_MAX_REST: The maximum number of proofs that can be requested in one GET /proofs request
  // POST_VERIFY_PROOFS_MAX: The maximum number of proofs allowed to be verified in one request

  // ***********************************************************************
  // * Global variables with default values
  // ***********************************************************************

  // Chainpoint stack related variables
  NODE_ENV: envalid.str({ default: 'production', desc: 'The type of environment in which the service is running' }),

  // Proof retention setting
  PROOF_EXPIRE_MINUTES: envalid.num({ default: 1440, desc: 'The lifespan of stored proofs, in minutes' }),

  // Anchor to external blockchains toggle variables
  // Using string values in place of a Bool due to issues with storing bool values in K8s secrets
  ANCHOR_BTC: envalid.str({ choices: ['enabled', 'disabled'], default: 'disabled', desc: 'String flag for enabling and disabling BTC anchoring' }),
  ANCHOR_ETH: envalid.str({ choices: ['enabled', 'disabled'], default: 'disabled', desc: 'String flag for enabling and disabling ETH anchoring' }),

  // Consul related variables and keys
  CONSUL_HOST: envalid.str({ default: 'consul', desc: 'Consul server host' }),
  CONSUL_PORT: envalid.num({ default: 8500, desc: 'Consul server port' }),
  NIST_KEY: envalid.str({ default: 'service/nist/latest', desc: 'The consul key to write to, watch to receive updated NIST object' }),
  REG_NODES_LIMIT_KEY: envalid.str({ default: 'service/api/nodelimit', desc: 'The consul key to write to, watch to receive updated registered Nodes limit' }),
  CALENDAR_LOCK_KEY: envalid.str({ default: 'service/calendar/blockchain/lock', desc: 'Key used for acquiring calendar write locks' }),

  // RabbitMQ related variables
  RABBITMQ_CONNECT_URI: envalid.url({ default: 'amqp://chainpoint:chainpoint@rabbitmq', desc: 'Connection string w/ credentials for RabbitMQ' }),
  RMQ_WORK_OUT_STATE_QUEUE: envalid.str({ default: 'work.proofstate', desc: 'The queue name for outgoing message to the proof state service' }),
  RMQ_WORK_OUT_CAL_QUEUE: envalid.str({ default: 'work.cal', desc: 'The queue name for outgoing message to the calendar service' }),
  RMQ_WORK_OUT_AGG_QUEUE: envalid.str({ default: 'work.agg', desc: 'The queue name for outgoing message to the aggregator service' }),
  RMQ_WORK_OUT_BTCTX_QUEUE: envalid.str({ default: 'work.btctx', desc: 'The queue name for outgoing message to the btc tx service' }),
  RMQ_WORK_OUT_BTCMON_QUEUE: envalid.str({ default: 'work.btcmon', desc: 'The queue name for outgoing message to the btc mon service' }),
  RMQ_WORK_OUT_GEN_QUEUE: envalid.str({ default: 'work.gen', desc: 'The queue name for outgoing message to the proof gen service' }),
  RMQ_WORK_OUT_API_QUEUE: envalid.str({ default: 'work.api', desc: 'The queue name for outgoing message to the api service' }),
  RMQ_WORK_OUT_AUDIT_QUEUE: envalid.str({ default: 'work.audit', desc: 'The queue name for outgoing message to the audit consumer service' }),

  // Redis related variables
  REDIS_CONNECT_URI: envalid.url({ devDefault: 'redis://redis:6379', desc: 'The Redis server connection URI' }),

  MIN_NODE_VERSION_EXISTING: envalid.str({ default: '1.3.0', desc: 'The minimum acceptable Node version for existing registrations and to pass audits' }),
  MIN_NODE_VERSION_NEW: envalid.str({ default: '1.3.0', desc: 'The minimum acceptable Node version for new registrations' }),

  // Service Specific Variables

  // Aggregator service specific variables
  RMQ_PREFETCH_COUNT_AGG: envalid.num({ default: 0, desc: 'The maximum number of messages sent over the channel that can be awaiting acknowledgement, 0 = no limit' }),
  RMQ_WORK_IN_AGG_QUEUE: envalid.str({ default: 'work.agg', desc: 'The queue name for message consumption originating from the api service' }),
  AGGREGATION_INTERVAL: validateAggInterval({ default: 1000, desc: 'The frequency of the aggregation process, in milliseconds' }),
  HASHES_PER_MERKLE_TREE: validateMaxHashes({ default: 25000, desc: 'The maximum number of hashes to be used when constructing an aggregation tree' }),

  // API service specific variables
  RMQ_PREFETCH_COUNT_API: envalid.num({ default: 0, desc: 'The maximum number of messages sent over the channel that can be awaiting acknowledgement, 0 = no limit' }),
  GET_PROOFS_MAX_REST: envalid.num({ default: 250, desc: 'The maximum number of proofs that can be requested in one GET /proofs request' }),
  MAX_BODY_SIZE: envalid.num({ default: 131072, desc: 'Max body size in bytes for incoming requests' }),
  POST_VERIFY_PROOFS_MAX: envalid.num({ default: 1000, desc: 'The maximum number of proofs allowed to be verified in one request' }),

  // BTC Mon service specific variables
  RMQ_PREFETCH_COUNT_BTCMON: envalid.num({ default: 0, desc: 'The maximum number of messages sent over the channel that can be awaiting acknowledgement, 0 = no limit' }),
  RMQ_WORK_IN_BTCMON_QUEUE: envalid.str({ default: 'work.btcmon', desc: 'The queue name for message consumption originating from the calendar service' }),
  MONITOR_INTERVAL_SECONDS: validateMonitorRange({ default: 30, desc: 'The frequency that transactions are monitored for new confirmations, in seconds' }),
  MIN_BTC_CONFIRMS: validateMinConfirmRange({ default: 6, desc: 'The number of confirmations needed before the transaction is considered ready for proof delivery' }),

  // BTC Tx service specific variables
  RMQ_PREFETCH_COUNT_BTCTX: envalid.num({ default: 0, desc: 'The maximum number of messages sent over the channel that can be awaiting acknowledgement, 0 = no limit' }),
  RMQ_WORK_IN_BTCTX_QUEUE: envalid.str({ default: 'work.btctx', desc: 'The queue name for message consumption originating from the calendar service' }),
  // This is to safeguard against the service returning a very high value in error
  // and to impose a common sense limit on the highest fee per byte to allow.
  // MAX BTC to spend = AverageTxSizeBytes * BTC_MAX_FEE_SAT_PER_BYTE / 100000000
  // If we are to limit the maximum fee per transaction to 0.01 BTC, then
  // 0.01 = 235 * BTC_MAX_FEE_SAT_PER_BYTE / 100000000
  // BTC_MAX_FEE_SAT_PER_BYTE = 0.01 *  100000000 / 235
  // BTC_MAX_FEE_SAT_PER_BYTE = 4255
  BTC_MAX_FEE_SAT_PER_BYTE: envalid.num({ default: 4255, desc: 'The maximum feeRateSatPerByte value accepted' }),

  // Calendar service specific variables
  RMQ_PREFETCH_COUNT_CAL: envalid.num({ default: 0, desc: 'The maximum number of messages sent over the channel that can be awaiting acknowledgement, 0 = no limit' }),
  RMQ_WORK_IN_CAL_QUEUE: envalid.str({ default: 'work.cal', desc: 'The queue name for message consumption originating from the aggregator, btc-tx, and btc-mon services' }),
  CALENDAR_LEADER_KEY: envalid.str({ default: 'service/calendar/leader/lock', desc: 'Key used for acquiring audit calendar process leadership locks' }),

  // NIST beacon service specific variables
  NIST_INTERVAL_MS: envalid.num({ default: 60000, desc: 'The frequency to get latest NIST beacon data, in milliseconds' }),

  // Proof Gen service specific variables
  RMQ_PREFETCH_COUNT_GEN: envalid.num({ default: 0, desc: 'The maximum number of messages sent over the channel that can be awaiting acknowledgement, 0 = no limit' }),
  RMQ_WORK_IN_GEN_QUEUE: envalid.str({ default: 'work.gen', desc: 'The queue name for message consumption originating from the proof state service' }),
  RMQ_OUTGOING_EXCHANGE: envalid.str({ default: 'exchange.headers', desc: 'The exchange for publishing messages bound for API Service instances' }),

  // Proof State service specific variables
  RMQ_PREFETCH_COUNT_STATE: envalid.num({ default: 0, desc: 'The maximum number of messages sent over the channel that can be awaiting acknowledgement, 0 = no limit' }),
  RMQ_WORK_IN_STATE_QUEUE: envalid.str({ default: 'work.proofstate', desc: 'The queue name for message consumption originating from the aggregator, calendar, and proof state services' }),
  PRUNE_FREQUENCY_MINUTES: envalid.num({ default: 1, desc: 'The frequency that the proof state and hash tracker log tables have their old, unneeded data pruned, in minutes' }),

  // ETH TNT Listener / TNT TX services specific variables
  ETH_PROVIDER_URI: envalid.url({ default: 'http://testrpc:8545', desc: 'URI to the ETH node provider.' }),
  LISTEN_TX_PORT: envalid.num({ default: 8085, desc: 'Port of the ETH provider.' }),
  TNT_TO_CREDIT_RATE: envalid.num({ default: 200, desc: 'Exchange rate for TNT tokens to Credits. Default is give 200 credits for each TNT token.' }),
  ETH_TNT_TX_CONNECT_URI: envalid.url({ default: 'http://eth-tnt-tx-service:8085', desc: 'The eth-tnt-tx-service REST connection URI' }),
  ETH_WALLET: envalid.str({ default: '', desc: 'The JSON wallet file. Leave empty to not use a wallet for transactions.' }),
  ETH_WALLET_PASSWORD: envalid.str({ default: '', desc: 'The password to unlock the ETH wallet. Leave blank if no wallet is used.' }),

  // TNT Reward service specific variables
  REWARDS_PER_HOUR: validateFactorOfSixty({ default: 2, desc: 'The number of times per hour to calculate and distribute rewards, defaults to 2, must be a factor of 60, no greater than 20' }),
  MIN_CONSECUTIVE_AUDIT_PASSES_FOR_REWARD: envalid.num({ default: 4, desc: 'The minimum number of consecutive audits, where all tests pass, that must occur to be eligible for a reward' }),
  MIN_TNT_GRAINS_BALANCE_FOR_REWARD: envalid.num({ default: 500000000000, desc: 'The minimum balance of TNT, in Grains, that an address must contain in order to be eligible for a reward' }),
  REWARDS_LEADER_KEY: envalid.str({ default: 'service/reward/leader/lock', desc: 'Key used for acquiring reward process leadership locks' }),

  // Audit services specific variables
  RMQ_PREFETCH_COUNT_AUDIT: envalid.num({ default: 0, desc: 'The maximum number of messages sent over the channel that can be awaiting acknowledgement, 0 = no limit' }),
  NEW_AUDIT_CHALLENGES_PER_HOUR: validateFactorOfSixty({ default: 2, desc: 'The number of times per hour to generate new audit challenges, defaults to 2, must be a factor of 60, no greater than 20' }),
  NODE_AUDIT_ROUNDS_PER_HOUR: validateFactorOfSixtyUpToSixty({ default: 2, desc: 'The number of times per hour to perform Node audit rounds, defaults to 60, must be a factor of 60' }),
  RMQ_WORK_IN_AUDIT_QUEUE: envalid.str({ default: 'work.audit', desc: 'The queue name for message consumption originating from the audit producer service' }),
  AUDIT_PRODUCER_LEADER_KEY: envalid.str({ default: 'service/audit-producer/leader/lock', desc: 'Key used for acquiring audit producer process leadership locks' })
}

module.exports = (service) => {
  // Load and validate service specific require variables as needed
  switch (service) {
    case 'api':
      envDefinitions.CHAINPOINT_CORE_BASE_URI = envalid.url({ desc: 'Base URI for this Chainpoint Core stack of services' })
      envDefinitions.ETH_TNT_LISTEN_ADDRS = validateETHAddressesCSV({ desc: 'The addresses used to listen for incoming TNT transfers.  If more that one, separate by commas.' })
      break
    case 'cal':
      envDefinitions.CHAINPOINT_CORE_BASE_URI = envalid.url({ desc: 'Base URI for this Chainpoint Core stack of services' })
      envDefinitions.SIGNING_SECRET_KEY = envalid.str({ desc: 'A Base64 encoded NaCl secret signing key' })
      break
    case 'btc-mon':
      envDefinitions.INSIGHT_API_BASE_URI = envalid.url({ desc: 'The Bitcore Insight-API base URI' })
      break
    case 'btc-tx':
      envDefinitions.CHAINPOINT_CORE_BASE_URI = envalid.url({ desc: 'Base URI for this Chainpoint Core stack of services' })
      envDefinitions.INSIGHT_API_BASE_URI = envalid.url({ desc: 'The Bitcore Insight-API base URI' })
      envDefinitions.BITCOIN_WIF = envalid.str({ desc: 'The Bitcoin private key WIF used for transaction creation' })
      break
    case 'eth-tnt-tx':
      envDefinitions.ETH_TNT_TOKEN_ADDR = validateETHAddress({ desc: 'The address where the contract is on the blockchain.' })
      break
    case 'eth-contracts':
      envDefinitions.ETH_TNT_TOKEN_ADDR = validateETHAddress({ desc: 'The address where the contract is on the blockchain.' })
      break
    case 'eth-tnt-listener':
      envDefinitions.ETH_TNT_LISTEN_ADDRS = validateETHAddressesCSV({ desc: 'The addresses used to listen for incoming TNT transfers.  If more that one, separate by commas.' })
      envDefinitions.ETH_TNT_TOKEN_ADDR = validateETHAddress({ desc: 'The address where the contract is on the blockchain.' })
      break
    case 'tnt-reward':
      envDefinitions.CHAINPOINT_CORE_BASE_URI = envalid.url({ desc: 'Base URI for this Chainpoint Core stack of services' })
      envDefinitions.CORE_REWARD_ETH_ADDR = validateETHAddress({ desc: 'A valid Ethereum address that the Core may receive Core rewards with' })
      envDefinitions.CORE_REWARD_ELIGIBLE = envalid.bool({ desc: 'Boolean indicating if this Core may receive Core TNT rewards' })
      break
  }
  return envalid.cleanEnv(process.env, envDefinitions, {
    strict: true
  })
}
