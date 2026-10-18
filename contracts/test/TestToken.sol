// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

/// Test-only USDC stand-in for CentralCityFeeRouter checks: 6 decimals, allowance-checked transferFrom.
/// `failNext` makes the next transferFrom return false instead of reverting, like a non-reverting ERC-20.
contract TestToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    bool public failNext;

    function mint(address to, uint256 value) external {
        balanceOf[to] += value;
    }

    function setFailNext(bool value) external {
        failNext = value;
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        if (failNext) {
            failNext = false;
            return false;
        }
        require(allowance[from][msg.sender] >= value, "allowance");
        require(balanceOf[from] >= value, "balance");
        allowance[from][msg.sender] -= value;
        balanceOf[from] -= value;
        balanceOf[to] += value;
        return true;
    }
}
