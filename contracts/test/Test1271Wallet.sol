// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

/// @notice Test-only contract wallet: answers ERC-1271 for signatures of its owner key, like a
/// smart account does. Used by scripts/protocol/router3-fork-check.ts; never deployed on mainnet.
contract Test1271Wallet {
    address public immutable owner;

    constructor(address owner_) {
        owner = owner_;
    }

    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4) {
        if (signature.length != 65) return 0xffffffff;
        bytes32 r = bytes32(signature[0:32]);
        bytes32 s = bytes32(signature[32:64]);
        uint8 v = uint8(signature[64]);
        return ecrecover(hash, v, r, s) == owner ? bytes4(0x1626ba7e) : bytes4(0xffffffff);
    }
}
