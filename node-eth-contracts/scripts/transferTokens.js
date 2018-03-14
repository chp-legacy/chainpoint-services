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

// load all environment variables into env object
const env = require('../lib/parse-env.js')('eth-contracts')

const loadProvider = require('../loaders/providerLoader.js')
const loadToken = require('../loaders/tokenLoader.js')
const TokenOps = require('../tokenOps.js')

// Verify the correct command line options are passed in
if (process.argv.length !== 4) {
  console.error('Invalid number of params')
  console.log('Usage: node transferTokens.js <send_to_addr> <amt_in_base_units>')
  process.exit(-1)
}

// Load the provider, token contract, and create the TokenOps class
let web3Provider = loadProvider(env.ETH_PROVIDER_URI)
loadToken(web3Provider, env.ETH_TNT_TOKEN_ADDR).then((tokenContract) => {
  let ops = new TokenOps(tokenContract)

  let toAddr = process.argv[2]
  let amt = parseInt(process.argv[3])

  console.log('Sending ' + amt + ' TNT grains to: ' + toAddr)

  ops.sendTokens(toAddr, amt, (error, res) => {
    // Check for error
    if (error) {
      console.log(error)
      process.exit(-1)
    }

    console.log('Tokens have been transferred')
    console.log('Transaction: ' + res)
    process.exit()
  })
})
