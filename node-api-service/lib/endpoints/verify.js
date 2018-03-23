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

const _ = require('lodash')
const chpParse = require('chainpoint-parse')
const restify = require('restify')
const env = require('../parse-env.js')('api')
const calendarBlock = require('../models/CalendarBlock.js')

// pull in variables defined in shared CalendarBlock module
let sequelize = calendarBlock.sequelize
let CalendarBlock = calendarBlock.CalendarBlock

async function ProcessVerifyTasksAsync (verifyTasks) {
  let processedTasks = []

  for (let x = 0; x < verifyTasks.length; x++) {
    let verifyTask = verifyTasks[x]
    let status = verifyTask.status

    if (status === 'malformed') {
      processedTasks.push({
        proof_index: verifyTask.proof_index,
        status: status
      })
    } else {
      let anchors = []
      let totalCount = 0
      let validCount = 0

      let anchorResults = []

      for (let x = 0; x < verifyTask.anchors.length; x++) {
        let anchor = verifyTask.anchors[x]
        let confirmResult = await confirmExpectedValueAsync(anchor.anchor)
        let anchorResult = {
          branch: anchor.branch || undefined,
          type: anchor.anchor.type,
          valid: confirmResult
        }
        totalCount++
        validCount = validCount + (anchorResult.valid === true ? 1 : 0)
        anchorResults.push(anchorResult)
      }

      anchors = anchors.concat(anchorResults)
      if (validCount === 0) {
        status = 'invalid'
      } else if (validCount === totalCount) {
        status = 'verified'
      } else {
        status = 'mixed'
      }

      let result = {
        proof_index: verifyTask.proof_index,
        hash: verifyTask.hash,
        hash_id_node: verifyTask.hash_id_node,
        hash_submitted_node_at: verifyTask.hash_submitted_node_at,
        hash_id_core: verifyTask.hash_id_core,
        hash_submitted_core_at: verifyTask.hash_submitted_core_at,
        anchors: anchors,
        status: status
      }
      processedTasks.push(result)
    }
  }

  return processedTasks
}

function BuildVerifyTaskList (proofs) {
  let results = []
  let proofIndex = 0
  // extract id, time, anchors, and calculate expected values
  _.forEach(proofs, (proof) => {
    let parseObj
    try {
      parseObj = chpParse.parse(proof)
    } catch (error) {
      parseObj = null
    }

    let hash = parseObj ? parseObj.hash : undefined
    let hashIdNode = parseObj !== null ? parseObj.hash_id_node : undefined
    let hashSubmittedNodeAt = parseObj !== null ? parseObj.hash_submitted_node_at : undefined
    let hashIdCore = parseObj !== null ? parseObj.hash_id_core : undefined
    let hashSubmittedCoreAt = parseObj !== null ? parseObj.hash_submitted_core_at : undefined
    let expectedValues = parseObj !== null ? flattenExpectedValues(parseObj.branches) : undefined

    results.push({
      proof_index: proofIndex++,
      hash: hash,
      hash_id_node: hashIdNode,
      hash_submitted_node_at: hashSubmittedNodeAt,
      hash_id_core: hashIdCore,
      hash_submitted_core_at: hashSubmittedCoreAt,
      anchors: expectedValues,
      status: parseObj === null ? 'malformed' : ''
    })
  })
  return results
}

async function confirmExpectedValueAsync (anchorInfo) {
  let anchorId = anchorInfo.anchor_id
  let expectedValue = anchorInfo.expected_value
  let block = null
  switch (anchorInfo.type) {
    case 'cal':
      block = await CalendarBlock.findOne({ where: { type: 'cal', data_id: anchorId }, attributes: ['hash'], raw: true })
      if (!block) return false
      return block.hash === expectedValue
    case 'btc':
      block = await CalendarBlock.findOne({ where: { type: 'btc-c', dataId: anchorId }, attributes: ['dataVal'], raw: true })
      if (!block) return false
      return block.dataVal === expectedValue
    case 'eth':
      break
  }
}

function flattenExpectedValues (branchArray) {
  let results = []
  for (let b = 0; b < branchArray.length; b++) {
    let anchors = branchArray[b].anchors
    if (anchors.length > 0) {
      for (let a = 0; a < anchors.length; a++) {
        results.push({
          branch: branchArray[b].label || undefined,
          anchor: anchors[a]
        })
      }
    }
    if (branchArray[b].branches) {
      results = results.concat(flattenExpectedValues(branchArray[b].branches))
    }
    return results
  }
}

/**
 * POST /verify handler
 *
 * Expects a JSON body with the form:
 *   {"proofs": [ {proofJSON1}, {proofJSON2}, {proofJSON3} ]}
 *   or
 *   {"proofs": [ "proof binary 1", "proof binary 2", "proof binary 3" ]}
 *
 * The `proofs` key must reference a JSON Array of chainpoint proofs.
 * Proofs may be in either JSON form or base64 encoded binary form.
 *
 */
async function postProofsForVerificationV1 (req, res, next) {
  // validate content-type sent was 'application/json'
  if (req.contentType() !== 'application/json') {
    return next(new restify.InvalidArgumentError('invalid content type'))
  }

  // validate params has parse a 'proofs' key
  if (!req.params.hasOwnProperty('proofs')) {
    return next(new restify.InvalidArgumentError('invalid JSON body, missing proofs'))
  }

  // validate proofs param is an Array
  if (!_.isArray(req.params.proofs)) {
    return next(new restify.InvalidArgumentError('invalid JSON body, proofs is not an Array'))
  }

  // validate proofs param Array has at least one hash
  if (_.size(req.params.proofs) < 1) {
    return next(new restify.InvalidArgumentError('invalid JSON body, proofs Array is empty'))
  }

  // validate proofs param Array is not larger than allowed max length
  if (_.size(req.params.proofs) > env.POST_VERIFY_PROOFS_MAX) {
    return next(new restify.InvalidArgumentError(`invalid JSON body, proofs Array max size of ${env.POST_VERIFY_PROOFS_MAX} exceeded`))
  }

  try {
    let verifyTasks = BuildVerifyTaskList(req.params.proofs)
    let verifyResults = await ProcessVerifyTasksAsync(verifyTasks)
    res.send(verifyResults)
    return next()
  } catch (error) {
    console.error(error.message)
    return next(new restify.InternalError('internal error verifying proof(s)'))
  }
}

module.exports = {
  getCalendarBlockSequelize: () => { return sequelize },
  postProofsForVerificationV1: postProofsForVerificationV1
}
