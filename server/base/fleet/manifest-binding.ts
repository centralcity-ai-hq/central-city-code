import type { Transaction } from '../../database.js';
import { manifestHash, type ManifestEntry } from '../../../shared/base/manifest.js';

/** Call inside job creation's transaction, before inserting budgets or reservations.
 * Row locks keep the stored identity stable until that transaction commits. This is
 * manifest binding only; the caller must also verify signature, authority and caps.
 */
export async function bindFleetManifest(
  tx: Transaction,
  workspaceId: string,
  chainId: number,
  entries: readonly ManifestEntry[],
  signedHash: string,
): Promise<readonly ManifestEntry[]> {
  // Snapshot caller data before the first await; later mutations cannot alter the binding.
  if (!Array.isArray(entries)) throw new Error('Invalid fleet manifest.');
  const length = entries.length;
  const snapshot: ManifestEntry[] = [];
  for (let index = 0; index < length; index++) {
    const entry = entries[index];
    if (!entry || typeof entry !== 'object') throw new Error('Invalid fleet manifest.');
    const { ordinal, agentId, owner, wallet, derivationVersion } = entry;
    if (
      typeof ordinal !== 'number' ||
      typeof agentId !== 'string' ||
      typeof owner !== 'string' ||
      typeof wallet !== 'string' ||
      typeof derivationVersion !== 'number'
    )
      throw new Error('Invalid fleet manifest.');
    snapshot.push({ ordinal, agentId, owner, wallet, derivationVersion });
  }
  if (manifestHash(snapshot).toLowerCase() !== signedHash.toLowerCase())
    throw new Error('Fleet manifest hash mismatch.');
  const { rows } = await tx.query<{
    agent_id: string;
    owner_address: string;
    address: string;
    derivation: { version?: number };
    state: string;
  }>(
    `SELECT agent_id, owner_address, address, derivation, state FROM base_wallets
     WHERE operator_id = $1 AND chain_id = $2 AND agent_id = ANY($3::text[])
     ORDER BY agent_id FOR UPDATE`,
    [workspaceId, chainId, snapshot.map((entry) => entry.agentId)],
  );
  const wallets = new Map(rows.map((row) => [row.agent_id, row]));
  if (wallets.size !== snapshot.length) throw new Error('Fleet wallet binding unavailable.');
  for (const entry of snapshot) {
    const row = wallets.get(entry.agentId);
    if (
      !row ||
      !['derived', 'deployed'].includes(row.state) ||
      row.owner_address.toLowerCase() !== entry.owner.toLowerCase() ||
      row.address.toLowerCase() !== entry.wallet.toLowerCase() ||
      row.derivation?.version !== entry.derivationVersion
    )
      throw new Error('Fleet wallet binding mismatch.');
  }
  return Object.freeze(snapshot.map((entry) => Object.freeze(entry)));
}
