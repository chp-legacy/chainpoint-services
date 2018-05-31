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

const env = require('../parse-env.js')('eth-tnt-tx')
const _ = require('lodash')
const restify = require('restify')
const ethers = require('ethers')
const retry = require('async-retry')
const tntDefinition = require('../eth-tnt/TierionNetworkToken.json')

// This value is set once the connection has been established
let redis = null

// This value is set by the updateETHGasPriceAsync function at regular intervals
let recommendedGasPrice = null

// Key for the Redis set of recent gas prices, the higher price over the
// entire timeframe will be used
const GAS_PRICE_HISTORY_KEY = 'ETH_TNT_Tx:GasPriceHistory'

const network = env.isProduction ? ethers.providers.networks.homestead : ethers.providers.networks.ropsten
const tntSourceWalletPK = env.ETH_TNT_SOURCE_WALLET_PK
const tntContractAddr = tntDefinition.networks[env.isProduction ? '1' : '3'].address
const etherscanProvider = new ethers.providers.EtherscanProvider(network, env.ETH_ETHERSCAN_API_KEY)
const infuraProvider = new ethers.providers.InfuraProvider(network, env.ETH_INFURA_API_KEY)
const fallbackProvider = new ethers.providers.FallbackProvider([infuraProvider, etherscanProvider])
const readContract = new ethers.Contract(tntContractAddr, tntDefinition.abi, infuraProvider)
const wallet = new ethers.Wallet(tntSourceWalletPK, fallbackProvider)
const writeContract = new ethers.Contract(tntContractAddr, tntDefinition.abi, wallet)

// validate addresses are individually well formed
let isEthereumAddr = (address) => {
  return /^0x[0-9a-f]{40}$/i.test(address)
}

async function updateETHGasPriceAsync () {
  // Price history is kept in a sorted set with the score set to the timestamp
  // On each add to this set, we prune element from the set older than 1 hour
  // The highest price in the set is used for the next transaction
  // Doing so guards against momentary dips in price estimation that may result
  // in long processing times for transactions.
  try {
    let currentTimestamp = Date.now()
    let newExpireTimestamp = currentTimestamp + 60 * 60 * 1000 // one hour from now
    // Get the latest gas price recommendation
    let currentGasPrice = await fallbackProvider.getGasPrice()
    // Add lastest gas price to sorted set
    await redis.zadd(GAS_PRICE_HISTORY_KEY, newExpireTimestamp, currentGasPrice.toString())
    // Prune sorted set items older than 1 hour
    await redis.zremrangebyscore(GAS_PRICE_HISTORY_KEY, '-inf', currentTimestamp)
    // Retrieve the entire set and find the largest value
    let prices = await redis.zrangebyscore(GAS_PRICE_HISTORY_KEY, currentTimestamp, '+inf')
    // find the highest price in that set and update recommendedGasPrice
    prices = prices.map((price) => parseInt(price))
    recommendedGasPrice = Math.max(...prices)
    // liberally increase this value by 50% to maximize confirmation speed
    recommendedGasPrice *= 1.5
    // enforce a minimum of 10 Gwei
    recommendedGasPrice = Math.max(recommendedGasPrice, 10000000000)
    console.log(`New price received : ${currentGasPrice} : Updated recommended price : ${recommendedGasPrice}`)
  } catch (error) {
    console.error(`ERROR : Could not update ETH recommended gas price : ${error.message}`)
  }
}

async function getBalanceByTNTAddrV1Async (req, res, next) {
  // Verify address
  if (!req.params.hasOwnProperty('tnt_addr')) {
    return next(new restify.InvalidArgumentError('invalid JSON body, missing tnt_addr'))
  }

  if (_.isEmpty(req.params.tnt_addr)) {
    return next(new restify.InvalidArgumentError('invalid JSON body, empty tnt_addr'))
  }

  // use local wallet address when /balance/wallet requested
  let tntTargetAddress = req.params.tnt_addr
  if (tntTargetAddress === 'wallet') tntTargetAddress = wallet.address

  if (!tntTargetAddress.startsWith('0x')) tntTargetAddress = `0x${tntTargetAddress}`

  if (!isEthereumAddr(tntTargetAddress)) {
    return next(new restify.InvalidArgumentError('invalid JSON body, malformed tnt_addr'))
  }

  try {
    await retry(async bail => {
      let grainsBalance = await readContract.balanceOf(tntTargetAddress)
      let grainsBalanceString = grainsBalance.toString()
      let tntBalance = grainsBalance.div(10 ** 8)
      let tntBalanceString = tntBalance.toString()

      res.send({
        balance: grainsBalanceString
      })

      console.log(`Balance requested for ${tntTargetAddress}: ${grainsBalanceString} grains (${tntBalanceString} TNT)`)

      return next()
    }, {
      retries: 10,        // The maximum amount of times to retry the operation. Default is 10
      factor: 1,        // The exponential factor to use. Default is 2
      minTimeout: 100,   // The number of milliseconds before starting the first retry. Default is 1000
      maxTimeout: 1000,
      onRetry: (error) => { console.error(`Transfer error : ${error.message}`) }
    })
  } catch (error) {
    // if we get this far, transfer has failed, return an error
    return next(new restify.InternalServerError('server error on balance check'))
  }
}

async function postTransferV1Async (req, res, next) {
  if (req.contentType() !== 'application/json') {
    return next(new restify.InvalidArgumentError('invalid content type'))
  }

  // Verify address
  if (!req.params.hasOwnProperty('to_addr')) {
    return next(new restify.InvalidArgumentError('invalid JSON body, missing to_addr'))
  }

  if (_.isEmpty(req.params.to_addr)) {
    return next(new restify.InvalidArgumentError('invalid JSON body, empty to_addr'))
  }

  if (!isEthereumAddr(req.params.to_addr)) {
    return next(new restify.InvalidArgumentError('invalid JSON body, malformed to_addr'))
  }

  // Verify value
  if (!req.params.hasOwnProperty('value')) {
    return next(new restify.InvalidArgumentError('invalid JSON body, missing \'value\''))
  }

  let grains = parseInt(req.params.value)
  if (_.isNaN(grains)) {
    return next(new restify.InvalidArgumentError('invalid number specified for \'value\''))
  }

  try {
    await retry(async bail => {
      let tx = await writeContract.transfer(req.params.to_addr, grains, {
        gasLimit: 60000,
        gasPrice: recommendedGasPrice || 10000000000 // Use 10 Gwei as default if recommendedGasPrice is not set
      })

      console.log(`Transfered TNT to ${req.params.to_addr} : ${grains} grains (${ethers.utils.bigNumberify(grains).div(10 ** 8)} TNT) : TX INFO : ${JSON.stringify(tx)}`)

      res.send({
        trx_id: tx.hash
      })

      return next()
    }, {
      retries: 10,        // The maximum amount of times to retry the operation. Default is 10
      factor: 1,        // The exponential factor to use. Default is 2
      minTimeout: 100,   // The number of milliseconds before starting the first retry. Default is 1000
      maxTimeout: 1000,
      onRetry: (error) => { console.error(`Transfer error : ${error.message}`) }
    })
  } catch (error) {
    // if we get this far, transfer has failed, return an error
    return next(new restify.InternalServerError('server error on transfer'))
  }
}

module.exports = {
  getBalanceByTNTAddrV1Async: getBalanceByTNTAddrV1Async,
  postTransferV1Async: postTransferV1Async,
  updateETHGasPriceAsync: updateETHGasPriceAsync,
  setRedis: (r) => { redis = r }
}
