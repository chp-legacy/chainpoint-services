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

const env = require('../parse-env.js')('eth-tnt-provider')
const Wallet = require('ethereumjs-wallet')
const Web3 = require('web3')
const ProviderEngine = require('web3-provider-engine')
const WalletSubprovider = require('web3-provider-engine/subproviders/wallet.js')
const Web3Subprovider = require('web3-provider-engine/subproviders/web3.js')

module.exports = (nodeUri) => {
  // Load the env var to figure out which node to connect to
  if (!nodeUri) {
    console.error('ETH_PROVIDER_URI environment variable not set - Exiting...')
    process.exit(-1)
  }

  console.log('nodeUri: ', nodeUri)

  // Check to see if a wallet is being used
  if (env.ETH_WALLET && env.ETH_WALLET !== '') {
    if (!env.ETH_WALLET_PASSWORD || env.ETH_WALLET_PASSWORD === '') {
      console.error('ETH_WALLET_PASSWORD environment variable is not set - See README - Exiting...')
      process.exit(-1)
    }

    if (!env.ETH_WALLET || env.ETH_WALLET === '') {
      console.error('ETH_WALLET is empty - See README - Exiting...')
      process.exit(-1)
    }

    // console.log('env.ETH_WALLET: ', env.ETH_WALLET)

    let wallet = Wallet.fromV3(JSON.parse(env.ETH_WALLET), env.ETH_WALLET_PASSWORD)

    console.log('Using wallet with provider: ' + nodeUri)

    var engine = new ProviderEngine()
    engine.addProvider(new WalletSubprovider(wallet, {}))
    engine.addProvider(new Web3Subprovider(new Web3.providers.HttpProvider(nodeUri)))
    engine.start() // Required by the provider engine.
    return engine
  }

  console.log('Using wallet without provider: ' + nodeUri)
  return new Web3.providers.HttpProvider(nodeUri)
}
