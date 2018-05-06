# Node ETH Contracts

This service is responsible for maintaining the ETH contracts being used by the Chainpoint Services.

## Development Env

For development, the docker-compose configuration will bring this image up and deploy the contracts to ganache. The deployed contracts will then be exposed to the other docker images through a volume so they can reference the addresses used in deployment for their specific environment.

The contracts will be deployed to new addresses every time the environment is started and the deployment address is saved to the build/contracts json files.

## Production and Testnet

The deployments to production and testnet Eth networks should be done manually against a real node (e.g. not testrpc).  Once deployed, the resulting json files in build/contracts should be checked back in.  From that point on any other services that run against the testnet/livenet networks can use those json files to reference the deployed contracts.

## Ropsten Testnet

The token contract has been deployed to address `0x91346ff366fc7f7cabf3499f27a29d7372ab6192`.

The name of the token was changed to `Tierion Test Token` with a symbol of `TST`.

```text
Running migration: 1_initial_migration.js
  Deploying Migrations...
  ... 0xd9c304829d1d82d0baa12209c95847102d0dcc59fd270330bd876203d71d4b39
  Migrations: 0x87208fc2cf2bba33bab21d4ecf95766902099484
Saving successful migration to network...
  ... 0xb9d555fc222b7f5cede086ad3dc4c143c46ae7b9f52bfa32fcaeafb3eeadd295
Saving artifacts...
Running migration: 2_deploy_token.js
  Deploying TierionNetworkToken...
  ... 0x083396e668db22894c448932bb598caba148e4a5b06787a9609be7edc8993342
  TierionNetworkToken: 0x91346ff366fc7f7cabf3499f27a29d7372ab6192
Saving successful migration to network...
  ... 0xa92f0744b051c5963edeee0bbfd8d888414dacfa148023819b784c1871995664
```
