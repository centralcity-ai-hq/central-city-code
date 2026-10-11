/*
 * The agent wallet this browser expects, derived here (Operation Base Wallet). Every agent wallet
 * is the Coinbase Smart Wallet the pinned factory makes with CREATE2 from exactly [the owner's
 * wallet key, SpendPermissionManager] at the agent's account index (server/base/chain/derive.ts,
 * server/base/wallet/service.ts). The same math runs here, so the browser never shows a funding
 * address, or signs for a wallet, that isn't the one its own key makes for this agent: a
 * substituted address is refused, not trusted. Tests keep this equal to the server's derivation.
 */
import {
  encodeAbiParameters,
  getAddress,
  getContractAddress,
  keccak256,
  sha256,
  stringToBytes,
  type Hex,
} from 'viem';
import { BASE_NETWORKS } from '../../../shared/base/chains';
import { WALLET_CHAIN_ID } from '../../../shared/base/wallet-network';

const NETWORK = BASE_NETWORKS[WALLET_CHAIN_ID];

/**
 * Init-code hash of the Coinbase Smart Wallet v1 proxy for the pinned factory, as the factory's
 * initCodeHash() answers it on Base and Base Sepolia (server/base/chain/derive.ts INIT_CODE_HASHES).
 */
const INIT_CODE_HASH: Hex = '0x5153041b4b8e36c84ca233b2fb610f85b8831b5e56a365618f507f8784fe034e';
const FACTORY = getAddress('0x0BA5ED0c6AA8c49038F819E587E2633c4A9F428a');

/**
 * The account index a wallet is made with for this agent: SHA-256 of a domain-separated prefix and
 * the exact agent id (server/base/wallet/service.ts accountIndexFor; a test keeps them equal).
 */
export function walletAccountIndex(agentId: string): bigint {
  return BigInt(sha256(stringToBytes(`cc.base.wallet.v1:${agentId}`)));
}

/** The wallet [owner key, SpendPermissionManager] makes at this agent's index, on this network. */
export function expectedWallet(owner: string, agentId: string): `0x${string}` {
  if (getAddress(NETWORK.contracts.smartWalletFactory) !== FACTORY)
    throw new Error('This network’s wallet factory isn’t the one this page derives for.');
  const owners = [getAddress(owner), NETWORK.contracts.spendPermissionManager].map((each) =>
    encodeAbiParameters([{ type: 'address' }], [getAddress(each)]),
  );
  const salt = keccak256(
    encodeAbiParameters(
      [{ type: 'bytes[]' }, { type: 'uint256' }],
      [owners, walletAccountIndex(agentId)],
    ),
  );
  return getContractAddress({
    opcode: 'CREATE2',
    from: FACTORY,
    salt,
    bytecodeHash: INIT_CODE_HASH,
  });
}

/** Whether `wallet` is exactly the wallet `owner`'s key makes for this agent. */
export function isOwnWallet(wallet: string, owner: string, agentId: string): boolean {
  try {
    return getAddress(wallet) === expectedWallet(owner, agentId);
  } catch {
    return false;
  }
}
