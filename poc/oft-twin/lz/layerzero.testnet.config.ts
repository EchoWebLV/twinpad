import { EndpointId } from '@layerzerolabs/lz-definitions'
import { ExecutorOptionType } from '@layerzerolabs/lz-v2-utilities'
import { generateConnectionsConfig } from '@layerzerolabs/metadata-tools'
import { OAppEnforcedOption, OmniPointHardhat } from '@layerzerolabs/toolbox-hardhat'

import { getOftStoreAddress } from './tasks/solana'

// TESTNET rehearsal: Solana devnet (adapter on a test SPL mint) <-> Robinhood testnet (LockstepOFT).
// Mainnet uses layerzero.config.ts. Run tasks with --oapp-config layerzero.testnet.config.ts

// Note: do not use `address` for EVM OmniPointHardhat contracts; they are resolved through hardhat-deploy.
const robinhoodContract: OmniPointHardhat = {
    eid: EndpointId.ROBINHOOD_V2_TESTNET, // 40451
    contractName: 'LockstepOFT',
}

const solanaContract: OmniPointHardhat = {
    eid: EndpointId.SOLANA_V2_TESTNET, // 40168
    address: getOftStoreAddress(EndpointId.SOLANA_V2_TESTNET), // deployments/solana-testnet/OFT.json, written by lz:oft-adapter:solana:create
}

const EVM_ENFORCED_OPTIONS: OAppEnforcedOption[] = [
    {
        msgType: 1,
        optionType: ExecutorOptionType.LZ_RECEIVE,
        gas: 80000, // OFT mint on arrival
        value: 0,
    },
]

const CU_LIMIT = 200000 // compute units for lz_receive on Solana
const SPL_TOKEN_ACCOUNT_RENT_VALUE = 2039280 // lamports to create the recipient's SPL token account if missing

const SOLANA_ENFORCED_OPTIONS: OAppEnforcedOption[] = [
    {
        msgType: 1,
        optionType: ExecutorOptionType.LZ_RECEIVE,
        gas: CU_LIMIT,
        value: SPL_TOKEN_ACCOUNT_RENT_VALUE,
    },
]

// Simple Config Generator: DVNs are resolved by name from the LayerZero metadata API for both chains.
// 'LayerZero Labs' runs a DVN on Robinhood (0xd01a…5b12) and Solana (4VDj…Lfhb). To add a second required
// verifier once the PoC is proven, extend the array, e.g. [['LayerZero Labs', 'Nethermind'], []].
export default async function () {
    // pathways are bidirectional: declaring [A, B] also creates [B, A]
    const connections = await generateConnectionsConfig([
        [
            solanaContract, // Chain A
            robinhoodContract, // Chain B
            // [ requiredDVNs[], [ optionalDVNs[], threshold ] ]
            [['LayerZero Labs'], []],
            // [ A -> B confirmations (Solana slots), B -> A confirmations (Robinhood blocks) ]
            [32, 15],
            // [ Chain B enforced options, Chain A enforced options ]
            [EVM_ENFORCED_OPTIONS, SOLANA_ENFORCED_OPTIONS],
        ],
    ])

    return {
        contracts: [{ contract: solanaContract }, { contract: robinhoodContract }],
        connections,
    }
}
