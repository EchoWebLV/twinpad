import assert from 'assert'

import { type DeployFunction } from 'hardhat-deploy/types'

const contractName = 'LockstepOFT'

// Deploys the Robinhood Chain side of the Lockstep twin: a native OFT (mint/burn).
// The EndpointV2 address comes from @layerzerolabs/lz-evm-sdk-v2 through the network's `eid`
// (robinhood-mainnet 30416 / robinhood-testnet 40451 in hardhat.config.ts).
const deploy: DeployFunction = async (hre) => {
    const { getNamedAccounts, deployments } = hre

    const { deploy } = deployments
    const { deployer } = await getNamedAccounts()

    assert(deployer, 'Missing named deployer account')

    console.log(`Network: ${hre.network.name}`)
    console.log(`Deployer: ${deployer}`)

    const endpointV2Deployment = await hre.deployments.get('EndpointV2')

    const { address } = await deploy(contractName, {
        from: deployer,
        args: [
            'Lockstep', // name
            'LSTP', // symbol
            endpointV2Deployment.address, // LayerZero EndpointV2 on this chain
            deployer, // owner + delegate (move to a multisig or renounce after wiring)
        ],
        log: true,
        skipIfAlreadyDeployed: true,
    })

    console.log(`Deployed contract: ${contractName}, network: ${hre.network.name}, address: ${address}`)
}

deploy.tags = [contractName]

export default deploy
