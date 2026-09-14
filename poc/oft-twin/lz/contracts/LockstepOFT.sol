// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.22;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { OFT } from "@layerzerolabs/oft-evm/contracts/OFT.sol";

/// @title Lockstep (LSTP) on Robinhood Chain
/// @notice Native LayerZero OFT. Supply on this chain is minted only when LSTP is locked in the
///         OFT Adapter on Solana and burned when it is sent back, so the pump.fun mint stays the
///         single source of supply. No fees, no taxes, no owner mint: plain ERC-20 for routers and bots.
contract LockstepOFT is OFT {
    constructor(
        string memory _name,
        string memory _symbol,
        address _lzEndpoint,
        address _delegate
    ) OFT(_name, _symbol, _lzEndpoint, _delegate) Ownable(_delegate) {}
}
