// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.20;

/// @dev Minimal 18-decimal ERC-20 standing in for LockstepOFT on an anvil fork. Test only.
contract MockLSTP {
    string public constant name = "Lockstep (mock)";
    string public constant symbol = "LSTP";
    uint8 public constant decimals = 18;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(uint256 supply) { totalSupply = supply; balanceOf[msg.sender] = supply; emit Transfer(address(0), msg.sender, supply); }
    function approve(address s, uint256 v) external returns (bool) { allowance[msg.sender][s] = v; emit Approval(msg.sender, s, v); return true; }
    function transfer(address to, uint256 v) external returns (bool) { return _move(msg.sender, to, v); }
    function transferFrom(address f, address to, uint256 v) external returns (bool) {
        uint256 a = allowance[f][msg.sender];
        if (a != type(uint256).max) { require(a >= v, "allowance"); allowance[f][msg.sender] = a - v; }
        return _move(f, to, v);
    }
    function _move(address f, address to, uint256 v) internal returns (bool) {
        require(balanceOf[f] >= v, "balance"); balanceOf[f] -= v; balanceOf[to] += v; emit Transfer(f, to, v); return true;
    }
}
