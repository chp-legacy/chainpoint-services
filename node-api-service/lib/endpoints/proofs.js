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

const restify = require('restify')
const env = require('../parse-env.js')('api')
const uuidValidate = require('uuid-validate')
const rp = require('request-promise-native')

// The custom MIME type for JSON proof array results containing Base64 encoded proof data
const BASE64_MIME_TYPE = 'application/vnd.chainpoint.json+base64'

// The custom MIME type for JSON proof array results containing Base64 encoded proof data
const JSONLD_MIME_TYPE = 'application/vnd.chainpoint.ld+json'

/**
 * GET /proofs/:hash_id handler
 *
 * Expects a path parameter 'hash_id' in the form of a Version 1 UUID
 *
 * Returns a chainpoint proof for the requested Hash ID
 */
async function getProofsByIDV1Async (req, res, next) {
  let hashIds = []

  // check if hash_id parameter was included
  if (req.params && req.params.hash_id) {
    // a hash_id was specified in the url, so use that hash_id only

    if (!uuidValidate(req.params.hash_id, 1)) {
      return next(new restify.InvalidArgumentError('invalid request: bad hash_id'))
    }

    hashIds.push(req.params.hash_id)
  } else if (req.headers && req.headers.hashids) {
    // no hash_id was specified in url, read from headers.hashids
    hashIds = req.headers.hashids.split(',')
  }

  // ensure at least one hash_id was submitted
  if (hashIds.length === 0) {
    return next(new restify.InvalidArgumentError('invalid request: at least one hash id required'))
  }

  // ensure that the request count does not exceed the maximum setting
  if (hashIds.length > env.GET_PROOFS_MAX_REST) {
    return next(new restify.InvalidArgumentError('invalid request: too many hash ids (' + env.GET_PROOFS_MAX_REST + ' max)'))
  }

  try {
    let requestedType = req.accepts(JSONLD_MIME_TYPE) ? JSONLD_MIME_TYPE : BASE64_MIME_TYPE
    let hashIdResults = await getProofsFromProofProxyAsync(hashIds.join(), requestedType)
    res.contentType = 'application/json'
    res.noCache()
    res.send(hashIdResults)
    return next()
  } catch (error) {
    return next(new restify.InternalError(error.message))
  }
}

async function getProofsFromProofProxyAsync (hashIds, requestedType) {
  let options = {
    headers: {
      'Accept': requestedType,
      'hashids': hashIds,
      'core': true
    },
    method: 'GET',
    uri: `https://proofs.chainpoint.org/proofs`,
    json: true,
    gzip: true,
    timeout: 2000,
    resolveWithFullResponse: true
  }

  try {
    let proofProxyResponse = await rp(options)
    let proofArray = proofProxyResponse.body
    return proofArray
  } catch (error) {
    throw new Error(`Could not complete request to Proof Proxy : ${error.message}`)
  }
}

module.exports = {
  getProofsByIDV1Async: getProofsByIDV1Async
}
