/*
 * Looks up an agent's Central City passport: present only when the agent is a Base agent, i.e. it
 * has a wallet, a short id and a confirmed ERC-8004 identity on the same chain. Mainnet wins over
 * the test network when both exist.
 * Reads only confirmed rows and only the final `erc8004_agent_id`; the identity service's
 * provisional columns (migration 85: provisional_agent_id, mint_*, handover_*) are never read here.
 */
import type { Database } from '../../database.js';
import type { PassportInput } from '../../../shared/base/passport.js';

export async function basePassport(db: Database, agentId: string): Promise<PassportInput | null> {
  const { rows } = await db.query<{
    short_id: string;
    chain_id: number;
    registry_address: string;
    erc8004_agent_id: string;
    address: string;
    updated_at: string;
  }>(
    `SELECT s.short_id, i.chain_id, i.registry_address, i.erc8004_agent_id::text AS erc8004_agent_id,
            w.address, i.updated_at::text AS updated_at
     FROM base_identities i
     JOIN base_wallets w ON w.agent_id = i.agent_id AND w.chain_id = i.chain_id
     JOIN base_short_ids s ON s.agent_id = i.agent_id
     WHERE i.agent_id = $1 AND i.state = 'confirmed' AND i.erc8004_agent_id IS NOT NULL
     ORDER BY (i.chain_id = 8453) DESC, i.chain_id
     LIMIT 1`,
    [agentId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    shortId: row.short_id,
    chainId: row.chain_id,
    registry: row.registry_address,
    erc8004AgentId: row.erc8004_agent_id,
    wallet: row.address,
    issuedAt: Number(row.updated_at),
  };
}
