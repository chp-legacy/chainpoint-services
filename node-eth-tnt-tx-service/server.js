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
const env = require('./lib/parse-env.js')('eth-tnt-tx')

const { promisify } = require('util')
const restify = require('restify')
const loadProvider = require('./lib/eth-tnt/providerLoader.js')
const loadToken = require('./lib/eth-tnt/tokenLoader.js')
const TokenOps = require('./lib/eth-tnt/tokenOps.js')
const _ = require('lodash')
var Web3 = require('web3')

// The provider, token contract, and create the TokenOps class
let web3Provider = null
let tokenContract = null
let ops = null

// RESTIFY SETUP
// 'version' : all routes will default to this version
let server = restify.createServer({
  name: 'eth-tx',
  version: '1.0.0'
})

// Clean up sloppy paths like //todo//////1//
server.pre(restify.pre.sanitizePath())

// Checks whether the user agent is curl. If it is, it sets the
// Connection header to "close" and removes the "Content-Length" header
// See : http://restify.com/#server-api
server.pre(restify.pre.userAgentConnection())

server.use(restify.gzipResponse())
server.use(restify.queryParser())
server.use(restify.bodyParser({
  maxBodySize: env.MAX_BODY_SIZE
}))

// API RESOURCES

// validate addresses are individually well formed
let isEthereumAddr = (address) => {
  return /^0x[0-9a-fA-F]{40}$/i.test(address)
}

// get the TNT balance of node in grains
server.get({ path: '/balance/:tnt_addr/', version: '1.0.0' }, (req, res, next) => {
  // Verify address
  if (!req.params.hasOwnProperty('tnt_addr')) {
    return next(new restify.InvalidArgumentError('invalid JSON body, missing tnt_addr'))
  }

  if (_.isEmpty(req.params.tnt_addr)) {
    return next(new restify.InvalidArgumentError('invalid JSON body, empty tnt_addr'))
  }

  if (!isEthereumAddr(req.params.tnt_addr)) {
    return next(new restify.InvalidArgumentError('invalid JSON body, malformed tnt_addr'))
  }

  ops.getBalance(req.params.tnt_addr, (error, grains) => {
    if (error) {
      console.error(error)
      return next(new restify.InternalServerError('server error'))
    }

    res.send({
      balance: grains
    })

    console.log(`Balance requested for ${req.params.tnt_addr}: ${grains} grains (${grains / 10 ** 8} TNT)`)

    return next()
  })
})

// send TNT grains to an address
server.post({ path: '/transfer/', version: '1.0.0' }, (req, res, next) => {
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

  ops.sendTokens(req.params.to_addr, grains, (error, result) => {
    // Check for error
    if (error) {
      console.error(error)
      return next(new restify.InternalServerError('server error'))
    }

    res.send({
      trx_id: result
    })

    console.log(`Transfered TNT to ${req.params.to_addr}: ${grains} grains (${grains / 10 ** 8} TNT)`)

    return next()
  })
})

// Instruct REST server to begin listening for request
function listenRestify (callback) {
  server.listen(env.LISTEN_TX_PORT, (err) => {
    if (err) return callback(err)
    console.log(`${server.name} listening at ${server.url}`)
    return callback(null)
  })
}
// make awaitable async version for startListening function
let listenRestifyAsync = promisify(listenRestify)

// process all steps need to start the application
async function start () {
  if (env.NODE_ENV === 'test') return
  try {
    // Init the web3 provider
    web3Provider = loadProvider(env.ETH_PROVIDER_URI)
    // Set the default account to use for outgoing trxs
    let web3 = new Web3(web3Provider)
    web3.eth.getAccounts((error, accounts) => {
      if (error) {
        console.error(error)
      }
      web3.eth.defaultAccount = accounts[0]
    })

    // Load the token object
    tokenContract = await loadToken(web3Provider, env.ETH_TNT_TOKEN_ADDR)
    ops = new TokenOps(tokenContract)

    // Init Restify
    await listenRestifyAsync()

    console.log('startup completed successfully')
  } catch (error) {
    console.error(`An error has occurred on startup: ${error.message}`)
    process.exit(1)
  }
}

// get the whole show started
setTimeout(start, 10000)

// export these functions for unit tests
module.exports = {}
