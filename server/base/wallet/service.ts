/*
 * Wallet service (docs/base/ARCHITECTURE.md §6.2, §11.1). One counterfactual Coinbase Smart Wallet
 * per agent and chain, owned by [ownerEOA, SpendPermissionManager], plus the agent's spender
 * account. Creating a wallet writes nothing on-chain and costs nothing. Idempotent on
 * (agent, chain): the same agent always gets the same address, from the stored derivation recipe.
 * No key ever leaves the chain module; this service only stores the opaque `spenderKeyRef`.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { Database, Transaction } from '../../database.js';
import { baseNetwork, type Address, type BaseChainId } from '../../../shared/base/chains.js';
import type {
  EnsureWalletInput,
  WalletDerivation,
  WalletService,
  WalletState,
  WalletView,
} from '../../../shared/base/types.js';

/** What the wallet service needs from the chain module (implemented in server/base/chain). */
export interface WalletChainPort {
  /** Counterfactual smart-account address for the ordered owners and index; no RPC write. */
  deriveSmartAccount(
    chainId: BaseChainId,
    owners: Address[],
    accountIndex: bigint,
  ): Promise<Address>;
  /** A new spender smart account; its key stays inside the chain module. */
  createSpender(chainId: BaseChainId): Promise<{ spender: Address; keyRef: string }>;
  /** Marks the spender key as referenced, inside the wallet insert transaction. */
  commitSpender(tx: Transaction, keyRef: string, at?: number): Promise<void>;
  /** The Coinbase Smart Wallet implementation version the factory deploys today. */
  implementationVersion: string;
}

export interface WalletServiceDeps {
  db: Database;
  chain: WalletChainPort;
  env?: { CITY_BASE_MAINNET?: string };
  now?: () => number;
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

interface WalletRow {
  wallet_id: string;
  agent_id: string;
  operator_id: string;
  chain_id: number;
  address: string;
  owner_address: string;
  /** Absent before migration 88. */
  owner_account_id?: string | null;
  spender_address: string;
  derivation: WalletDerivation;
  state: WalletState;
  created_at: string | number;
  updated_at: string | number;
}

const view = (row: WalletRow): WalletView => ({
  walletId: row.wallet_id,
  agentId: row.agent_id,
  workspaceId: row.operator_id,
  chainId: row.chain_id as BaseChainId,
  address: row.address as Address,
  ownerAddress: row.owner_address as Address,
  ownerAccountId: row.owner_account_id ?? null,
  spenderAddress: row.spender_address as Address,
  derivation: row.derivation,
  state: row.state,
  createdAt: Number(row.created_at),
  updatedAt: Number(row.updated_at),
});

/**
 * The account index for an agent: the full 256-bit SHA-256 over a domain-separated prefix and the
 * exact agent id. Stable, independent of creation order and of the id format, and practically
 * collision-free (two agents of one owner never share an address). The factory takes any uint256.
 */
export function accountIndexFor(agentId: string): bigint {
  return BigInt(`0x${createHash('sha256').update(`cc.base.wallet.v1:${agentId}`).digest('hex')}`);
}

export class WalletServiceError extends Error {
  constructor(
    readonly code: 'network_unavailable' | 'invalid_owner' | 'wallet_not_found' | 'wallet_conflict',
    message: string,
  ) {
    super(message);
  }
}

export function createWalletService(deps: WalletServiceDeps): WalletService {
  const now = deps.now ?? Date.now;

  async function load(tx: Transaction, agentId: string, chainId: number) {
    const { rows } = await tx.query<WalletRow>(
      'SELECT * FROM base_wallets WHERE agent_id = $1 AND chain_id = $2',
      [agentId, chainId],
    );
    return rows[0] ?? null;
  }

  /** Binds an unlinked wallet to the person whose vault holds its owner key. */
  async function link(tx: Transaction, row: WalletRow, ownerAccountId: string) {
    const { rows } = await tx.query<WalletRow>(
      `UPDATE base_wallets SET owner_account_id = $2
       WHERE wallet_id = $1 AND owner_account_id IS NULL RETURNING *`,
      [row.wallet_id, ownerAccountId],
    );
    const linked = rows[0] ?? (await load(tx, row.agent_id, row.chain_id));
    if (linked?.owner_account_id !== ownerAccountId)
      throw new WalletServiceError('wallet_conflict', 'This agent already has another wallet.');
    return linked;
  }

  /**
   * A stored wallet answers a repeated ensure only for the same workspace and owner (and, for a
   * vault wallet, the same owner account); anything else is a conflict. A wallet with this owner
   * address but no account yet is adopted by the vault that holds its key.
   */
  async function settle(row: WalletRow, input: EnsureWalletInput, tx?: Transaction) {
    if (
      row.operator_id !== input.workspaceId ||
      row.owner_address.toLowerCase() !== input.ownerAddress.toLowerCase() ||
      (input.ownerAccountId &&
        row.owner_account_id &&
        row.owner_account_id !== input.ownerAccountId)
    )
      throw new WalletServiceError('wallet_conflict', 'This agent already has another wallet.');
    const ownerAccountId = input.ownerAccountId;
    if (!ownerAccountId || row.owner_account_id === ownerAccountId) return view(row);
    if (tx) return view(await link(tx, row, ownerAccountId));
    return view(await deps.db.transaction((inner) => link(inner, row, ownerAccountId)));
  }

  return {
    async ensureWallet(input: EnsureWalletInput): Promise<WalletView> {
      const network = baseNetwork(input.chainId, deps.env);
      if (!network) throw new WalletServiceError('network_unavailable', 'Network not available.');
      if (!ADDRESS.test(input.ownerAddress))
        throw new WalletServiceError('invalid_owner', 'Owner address is invalid.');

      const existing = await load(deps.db, input.agentId, input.chainId);
      if (existing) return settle(existing, input);

      const owners: Address[] = [input.ownerAddress, network.contracts.spendPermissionManager];
      const accountIndex = accountIndexFor(input.agentId);
      const derivation: WalletDerivation = {
        version: 1,
        owners,
        factory: network.contracts.smartWalletFactory,
        implementationVersion: deps.chain.implementationVersion,
        accountIndex: accountIndex.toString(10),
      };
      const address = await deps.chain.deriveSmartAccount(input.chainId, owners, accountIndex);
      const spender = await deps.chain.createSpender(input.chainId);
      const at = now();

      return deps.db.transaction(async (tx) => {
        const { rows } = await tx.query<WalletRow>(
          `INSERT INTO base_wallets (wallet_id, agent_id, operator_id, chain_id, address,
             owner_address, spender_address, spender_key_ref, derivation, state,
             created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'derived',$10,$10)
           ON CONFLICT (agent_id, chain_id) DO NOTHING
           RETURNING *`,
          [
            randomUUID(),
            input.agentId,
            input.workspaceId,
            input.chainId,
            address,
            input.ownerAddress,
            spender.spender,
            spender.keyRef,
            JSON.stringify(derivation),
            at,
          ],
        );
        const won = rows[0];
        const row = won ?? (await load(tx, input.agentId, input.chainId));
        if (!row) throw new WalletServiceError('wallet_conflict', 'Wallet could not be stored.');
        // Only the winning insert commits its key; a losing race leaves it uncommitted, so the
        // orphan cleanup removes it. The loser gets the winner's row, checked like a stored one.
        if (!won) return settle(row, input, tx);
        await deps.chain.commitSpender(tx, spender.keyRef, at);
        await tx.query(
          `INSERT INTO base_audit_events (at, actor, operator_id, agent_id, kind, detail)
           VALUES ($1, $2, $3, $4, 'wallet_derived', $5)`,
          [
            at,
            input.ownerAccountId ?? input.workspaceId,
            input.workspaceId,
            input.agentId,
            JSON.stringify({ chainId: input.chainId, address }),
          ],
        );
        return view(input.ownerAccountId ? await link(tx, row, input.ownerAccountId) : row);
      });
    },

    async getWallet(agentId: string, chainId: BaseChainId) {
      const row = await load(deps.db, agentId, chainId);
      return row ? view(row) : null;
    },

    async freeze(agentId: string, chainId: BaseChainId, actorId: string) {
      return deps.db.transaction(async (tx) => {
        const { rows } = await tx.query<WalletRow>(
          `UPDATE base_wallets SET state = 'frozen', updated_at = $3
           WHERE agent_id = $1 AND chain_id = $2 AND state IN ('derived','deployed')
           RETURNING *`,
          [agentId, chainId, now()],
        );
        const row = rows[0] ?? (await load(tx, agentId, chainId));
        if (!row) throw new WalletServiceError('wallet_not_found', 'No wallet for this agent.');
        if (rows[0])
          await tx.query(
            `INSERT INTO base_audit_events (at, actor, operator_id, agent_id, kind, detail)
             VALUES ($1, $2, $3, $4, 'wallet_frozen', $5)`,
            [now(), actorId, row.operator_id, agentId, JSON.stringify({ chainId })],
          );
        return view(row);
      });
    },
  };
}
