/*
 * The chain module's side of the wallet service port (docs/base/ARCHITECTURE.md §6.2, §11.1).
 * Everything here is off-chain and free: addresses are derived locally (CREATE2, no RPC), and a
 * new spender is a fresh key in the keystore plus the counterfactual smart account it owns.
 */
import { getAddress } from 'viem';
import type { Transaction } from '../../database.js';
import { parseKeyRef } from './keystore.js';
import { baseNetwork, type Address, type BaseChainId } from '../../../shared/base/chains.js';
import {
  DERIVATION_VERSION,
  deriveAddressLocal,
  spenderAccountRecipe,
  type DerivationRecipe,
} from './derive.js';

/** The Coinbase Smart Wallet implementation behind the v1 factory (read on-chain, 8 Oct 2026). */
export const IMPLEMENTATION_VERSION =
  'coinbase-smart-wallet-v1:0x000100abaad02f1cfC8Bbe32bD5a564817339E72';

export interface ChainPortDeps {
  keystore: { createSpenderKey(): Promise<{ signer: Address; keyRef: string }> };
  env?: { CITY_BASE_MAINNET?: string };
}

export function createWalletChainPort(deps: ChainPortDeps) {
  const networkFor = (chainId: BaseChainId) => {
    const network = baseNetwork(chainId, deps.env);
    if (!network) throw new Error('Network not available.');
    return network;
  };

  return {
    implementationVersion: IMPLEMENTATION_VERSION,

    /** Counterfactual address for the ordered owners and index; no RPC, no write. */
    async deriveSmartAccount(chainId: BaseChainId, owners: Address[], accountIndex: bigint) {
      const network = networkFor(chainId);
      if (owners.length === 0) throw new Error('A smart account needs at least one owner.');
      if (accountIndex < 0n || accountIndex >= 2n ** 256n) throw new Error('Index out of range.');
      const recipe: DerivationRecipe = {
        version: DERIVATION_VERSION,
        factory: network.contracts.smartWalletFactory,
        owners: owners.map((owner) => getAddress(owner)),
        index: accountIndex,
      };
      return deriveAddressLocal(recipe);
    },

    /**
     * A new spender: a fresh key (encrypted in the keystore) and the smart account it owns. The
     * key row starts uncommitted; rows a wallet never references are removed as orphans.
     */
    async createSpender(chainId: BaseChainId) {
      const network = networkFor(chainId);
      const { signer, keyRef } = await deps.keystore.createSpenderKey();
      return { spender: deriveAddressLocal(spenderAccountRecipe(network, signer)), keyRef };
    },

    /**
     * Marks a spender key as referenced by a wallet. Call it in the same transaction as the wallet
     * insert, so a key is either committed together with its wallet or stays an orphan for cleanup.
     */
    async commitSpender(tx: Transaction, keyRef: string, at = Date.now()) {
      const { keyId } = parseKeyRef(keyRef);
      const { rows } = await tx.query<{ key_id: string }>(
        'UPDATE base_spender_keys SET committed_at = COALESCE(committed_at, $2) WHERE key_id = $1 RETURNING key_id',
        [keyId, at],
      );
      if (!rows[0]) throw new Error('Spender key not found.');
    },
  };
}
