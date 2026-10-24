import type { Transaction as Tx } from './database.js';
import { iso, type StoredAgent, type Workspace } from './model.js';

/**
 * Runtime presence (last authenticated heartbeat and monotonic sequence) and replay nonces live
 * in their own rows. Runtime authentication and pure heartbeats lock only the agent's presence
 * row, never the owner's workspace row. Workspace JSON keeps `announcedOnline` so online/offline
 * transitions remain audited events; its lastSeenAt/lastSequence are a legacy seed and cache.
 */
export type PresenceIdentity = { operatorId: string; agentId: string; credentialHash: string };
type PresenceRow = {
  agent_id: string;
  credential_hash?: string | null;
  last_seen_at: number | string | null;
  sequence: number | string;
};

/** Nonces remain beyond the whole acceptance window of a future-dated request. */
export const NONCE_RETENTION_MS = 130_000;

async function credentialCurrent(tx: Tx, identity: PresenceIdentity): Promise<boolean> {
  return (
    (
      await tx.query(
        'SELECT agent_id FROM credentials WHERE agent_id=$1 AND operator_id=$2 AND token_hash=$3',
        [identity.agentId, identity.operatorId, identity.credentialHash],
      )
    ).rows.length > 0
  );
}

/**
 * Locks the agent's presence row, creating it on first use from the legacy workspace fields so
 * an upgraded database keeps its accepted sequence baseline.
 */
async function lockPresence(tx: Tx, identity: PresenceIdentity, time: number): Promise<void> {
  const lock = () =>
    tx.query<PresenceRow>(
      'SELECT agent_id,last_seen_at,sequence,credential_hash FROM agent_presence WHERE agent_id=$1 AND operator_id=$2 FOR UPDATE',
      [identity.agentId, identity.operatorId],
    );
  const existing = (await lock()).rows[0];
  if (existing) {
    // A row written under another credential (a racing old-credential request, or a rotation by
    // an older build) must not carry its sequence or last-seen time into this credential.
    if (existing.credential_hash !== identity.credentialHash)
      await tx.query(
        `UPDATE agent_presence SET credential_hash=$2,
          sequence=CASE WHEN credential_hash IS NULL THEN sequence ELSE -1 END,
          last_seen_at=CASE WHEN credential_hash IS NULL THEN last_seen_at ELSE NULL END
        WHERE agent_id=$1`,
        [identity.agentId, identity.credentialHash],
      );
    return;
  }
  const legacy = (
    await tx.query<{ agent: Partial<StoredAgent> }>(
      'SELECT workspace_agent(w.operator_id, w.data, $2) AS agent FROM workspaces w WHERE w.operator_id=$1',
      [identity.operatorId, identity.agentId],
    )
  ).rows[0]?.agent;
  const seen = legacy?.lastSeenAt ? Date.parse(legacy.lastSeenAt) : NaN;
  const sequence = Number.isSafeInteger(legacy?.lastSequence) ? legacy!.lastSequence! : -1;
  await tx.query(
    'INSERT INTO agent_presence(agent_id,operator_id,last_seen_at,sequence,updated_at,credential_hash) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT (agent_id) DO NOTHING',
    [
      identity.agentId,
      identity.operatorId,
      Number.isFinite(seen) ? seen : null,
      sequence,
      time,
      identity.credentialHash,
    ],
  );
  // A concurrent insert may have won; re-run the credential reconciliation on its row.
  await lockPresence(tx, identity, time);
}

export type NonceResult = 'ok' | 'unauthorized' | 'replayed' | 'capacity';

/**
 * Records a runtime nonce. Serialized per agent by the presence row lock so the per-agent live
 * nonce cap is exact. Expired nonces are removed only for this agent (bounded by the cap).
 */
export async function acceptNonce(
  tx: Tx,
  identity: PresenceIdentity,
  nonce: string,
  time: number,
  maxLive: number,
): Promise<NonceResult> {
  await lockPresence(tx, identity, time);
  if (!(await credentialCurrent(tx, identity))) return 'unauthorized';
  await tx.query('DELETE FROM replay_nonces WHERE agent_id=$1 AND expires_at<=$2', [
    identity.agentId,
    time,
  ]);
  const count = Number(
    (
      await tx.query<{ count: string | number }>(
        'SELECT count(*) AS count FROM replay_nonces WHERE agent_id=$1',
        [identity.agentId],
      )
    ).rows[0]?.count ?? 0,
  );
  if (count >= maxLive) return 'capacity';
  const inserted = await tx.query(
    'INSERT INTO replay_nonces(agent_id,nonce,expires_at) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING nonce',
    [identity.agentId, nonce, time + NONCE_RETENTION_MS],
  );
  return inserted.rows.length ? 'ok' : 'replayed';
}

export type HeartbeatResult = 'ok' | 'unauthorized' | 'stale';

/** Accepts a strictly increasing heartbeat sequence without touching the workspace row. */
export async function recordHeartbeat(
  tx: Tx,
  identity: PresenceIdentity,
  sequence: number,
  time: number,
): Promise<HeartbeatResult> {
  await lockPresence(tx, identity, time);
  if (!(await credentialCurrent(tx, identity))) return 'unauthorized';
  const updated = await tx.query(
    'UPDATE agent_presence SET sequence=$2,last_seen_at=$3,updated_at=$3 WHERE agent_id=$1 AND sequence<$2 RETURNING agent_id',
    [identity.agentId, sequence, time],
  );
  return updated.rows.length ? 'ok' : 'stale';
}

/** Rotation resets presence in the same transaction that replaces the credential. */
export async function resetPresence(tx: Tx, agentId: string): Promise<void> {
  await tx.query(
    'UPDATE agent_presence SET sequence=-1,last_seen_at=NULL,credential_hash=NULL WHERE agent_id=$1',
    [agentId],
  );
}

/**
 * Applies authoritative presence rows to a workspace read. Agents without a row (hosted
 * demonstrations, or runtimes that have not authenticated since the upgrade) keep their stored
 * fields, which preserves synthetic hosted presence.
 */
export async function overlayPresence(
  tx: Pick<Tx, 'query'>,
  operatorId: string,
  workspace: Workspace,
): Promise<void> {
  if (!workspace.agents.some((agent) => agent.mode === 'external')) return;
  // One JSON value instead of one result row per agent: the same rows (the unlocked snapshot read
  // takes them this way too), far cheaper to transfer and decode in a workspace of thousands.
  const rows = (
    await tx.query<{ presence: Pick<PresenceRow, 'agent_id' | 'last_seen_at' | 'sequence'>[] }>(
      `SELECT ${PRESENCE_JSON_SQL} AS presence`,
      [operatorId],
    )
  ).rows[0]?.presence;
  applyPresence(workspace, rows ?? []);
}

/** The presence rows of a workspace as one JSON array (`$1` is the operator id). */
export const PRESENCE_JSON_SQL = `(SELECT COALESCE(json_agg(json_build_object('agent_id',p.agent_id,
  'last_seen_at',p.last_seen_at,'sequence',p.sequence)),'[]'::json)
  FROM agent_presence p WHERE p.operator_id=$1)`;

/** Applies presence rows (as overlayPresence reads them) to the workspace's external agents. */
export function applyPresence(
  workspace: Workspace,
  rows: Pick<PresenceRow, 'agent_id' | 'last_seen_at' | 'sequence'>[],
): void {
  if (!rows.length) return;
  const byId = new Map(rows.map((row) => [row.agent_id, row]));
  for (const agent of workspace.agents) {
    const row = byId.get(agent.id);
    if (!row || agent.mode !== 'external') continue;
    agent.lastSeenAt = row.last_seen_at === null ? null : iso(Number(row.last_seen_at));
    agent.lastSequence = Number(row.sequence);
  }
}

/** Reads one agent's online announcement without loading or locking the workspace row. */
export async function announcedOnline(
  tx: Pick<Tx, 'query'>,
  operatorId: string,
  agentId: string,
): Promise<boolean> {
  const row = (
    await tx.query<{ online: boolean | null }>(
      "SELECT (workspace_agent(w.operator_id, w.data, $2)->>'announcedOnline')::boolean AS online FROM workspaces w WHERE w.operator_id=$1",
      [operatorId, agentId],
    )
  ).rows[0];
  return row?.online === true;
}
