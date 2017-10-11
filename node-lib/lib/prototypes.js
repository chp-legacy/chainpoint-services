/**
 * env required for tnt to credit rate
 */
const env = require('./parse-env.js')
const BigNumber = require('bignumber.js')

/**
 * Format TNT Amount for Token Transfer
 * @return {number}
 */
Number.prototype.tntToGrains = function () {
  return new BigNumber(this.valueOf()).times(10 ** 8).toNumber()
}

/**
 * Format TNT Amount from Token Transfer
 * @return {number}
 */
Number.prototype.grainsToTNT = function () {
  return new BigNumber(this.valueOf()).dividedBy(10 ** 8).toNumber()
}

/**
 * Format TNT Amount from Token Transfer to TNT Credit
 * @return {number}
 */
Number.prototype.grainsToCredits = function () {
  return new BigNumber(this.valueOf()).times(env.TNT_TO_CREDIT_RATE).dividedBy(10 ** 8).toNumber()
}
