import type { Transaction } from '../../database.js';

/** Acquire the union before manifest binding or treasury balance reservation.
 * Every fleet creator must use this order; caller keeps the transaction open.
 */
export async function lockFleetWallets(
  tx: Transaction,
  workspaceId: string,
  chainId: number,
  treasuryWalletId: string,
  agentIds: readonly string[],
): Promise<void> {
  const ids = [...agentIds];
  if (!treasuryWalletId || ids.length === 0 || new Set(ids).size !== ids.length)
    throw new Error('Invalid fleet wallet set.');
  const { rows } = await tx.query<{ wallet_id: string; agent_id: string }>(
    `SELECT wallet_id, agent_id FROM base_wallets
     WHERE operator_id = $1 AND chain_id = $2
       AND (wallet_id = $3 OR agent_id = ANY($4::text[]))
     ORDER BY wallet_id FOR UPDATE`,
    [workspaceId, chainId, treasuryWalletId, ids],
  );
  if (!rows.some((row) => row.wallet_id === treasuryWalletId))
    throw new Error('Fleet treasury unavailable.');
  const found = new Set(rows.map((row) => row.agent_id));
  if (ids.some((id) => !found.has(id))) throw new Error('Fleet recipient wallet unavailable.');
}
