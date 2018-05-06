/* global artifacts */
var TierionNetworkToken = artifacts.require('./TierionNetworkToken.sol')

// This deploys the TierionNetworkToken token using the default account as the owner.
module.exports = function (deployer, network, accounts) {
  deployer.deploy(TierionNetworkToken)
}
