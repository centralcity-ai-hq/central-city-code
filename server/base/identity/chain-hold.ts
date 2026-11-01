import type { Database } from '../../database.js';
import type { Address } from '../../../shared/base/chains.js';

/** Whether this address holds anything on this chain. May throw: unknown never frees an agent. */
export type WalletFunds = (chainId: number, address: Address) => Promise<boolean>;

/**
 * The chain holding an agent, when it isn't this one. One chain per agent for now. A live identity
 * holds it, and so does a wallet whose funds can't be reached once the agent is on another chain. A
 * wallet never used doesn't: only derived, no spending limit, nothing on it. That is what picking a
 * chain after making a wallet leaves behind. It doesn't hold an agent already live on this chain (a
 * stray wallet from a lost race).
 */
export async function chainHolding(
  db: Pick<Database, 'query'>,
  funds: WalletFunds | undefined,
  agentId: string,
  chainId: number,
): Promise<number | null> {
  const identity = await db.query<{ chain_id: number }>(
    `SELECT chain_id FROM base_identities
     WHERE agent_id = $1 AND chain_id <> $2 AND state <> 'failed' LIMIT 1`,
    [agentId, chainId],
  );
  if (identity.rows[0]) return identity.rows[0].chain_id;
  const wallets = await db.query<{ chain_id: number; address: Address; spare: boolean }>(
    `SELECT w.chain_id, w.address,
            (w.state = 'derived' AND NOT EXISTS (
               SELECT 1 FROM base_spend_permissions p WHERE p.wallet_id = w.wallet_id)) AS spare
     FROM base_wallets w
     WHERE w.agent_id = $1 AND w.chain_id <> $2 AND NOT EXISTS (
       SELECT 1 FROM base_identities i
       WHERE i.agent_id = $1 AND i.chain_id = $2 AND i.state <> 'failed')`,
    [agentId, chainId],
  );
  for (const wallet of wallets.rows) {
    const chain = Number(wallet.chain_id);
    if (!wallet.spare || !funds) return chain;
    const holds = await funds(chain, wallet.address).catch(() => true);
    if (holds) return chain;
  }
  return null;
}
