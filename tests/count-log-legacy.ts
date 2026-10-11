import { randomBytes, sign } from 'node:crypto';
import type { Database } from '../server/database.js';
import type { SigningKey } from '../server/manifest/keys.js';
import { COUNT_LOG_LOCK_KEY, CREATED_AT_PATTERN } from '../server/count-log/service.js';
import { pendingLeaves } from '../server/count-log/pending.js';
import {
  agentLeafHash,
  checkpointHash,
  subcountsCommitment,
  checkpointSigningInput,
  consistencyProof,
  merkleRoot,
  toHex,
  type Checkpoint,
  type CheckpointBody,
  type Subcounts,
} from '../shared/count-log/index.js';

/*
 * The checkpoint algorithm as it was before the batched, resumable rewrite (one transaction, every
 * leaf in memory, row-by-row inserts). Test-only: the equivalence test runs it and the current
 * code on the same data and requires byte-identical checkpoints and leaves. With `cut`, it also
 * applies the noon cut the obvious way (an agent whose pending row was recorded at or after the
 * cut is left out; an agent without a pending row is left out when its createdAt is at or after
 * the cut and stays in when it has no valid createdAt), as the oracle for the cut semantics.
 */

const day = (time: number) => new Date(time).toISOString().slice(0, 10);

const COUNTED_SQL = `SELECT DISTINCT ON (a.value->>'id')
    a.value->>'id' AS agent_id,
    a.value->>'createdAt' AS created_at,
    o.kind AS kind,
    (a.value->>'revokedAt') IS NOT NULL AS revoked
  FROM workspaces w
  JOIN operators o ON o.id = w.operator_id
  CROSS JOIN LATERAL jsonb_array_elements(COALESCE(w.data->'agents','[]'::jsonb)) AS a(value)
  WHERE a.value->>'demoKey' IS NULL
    AND NOT (w.operator_id = ANY($1::text[]))
  ORDER BY a.value->>'id'`;

type Counted = { agent_id: string; created_at: string | null; kind: string; revoked: boolean };

/** createdAt in epoch ms by the same rule as the checkpoint SQL, or null when it has none. */
function createdMs(createdAt: string | null): number | null {
  if (!createdAt || !new RegExp(CREATED_AT_PATTERN).test(createdAt)) return null;
  const [year, month, date] = createdAt.slice(0, 10).split('-').map(Number) as [
    number,
    number,
    number,
  ];
  if (date > new Date(Date.UTC(year, month, 0)).getUTCDate()) return null;
  return Date.parse(createdAt);
}

export async function legacyCheckpoint(deps: {
  db: Database;
  clock: () => number;
  excludedOperators?: readonly string[];
  signingKey?: SigningKey | null;
  salt?: () => Uint8Array;
  cut?: number;
}): Promise<{ checkpoint: Checkpoint; created: boolean }> {
  const excluded = [...(deps.excludedOperators ?? [])];
  const newSalt = deps.salt ?? (() => randomBytes(32));
  const signHash = (hash: string): Checkpoint['signature'] =>
    deps.signingKey
      ? {
          kid: deps.signingKey.kid,
          sig: sign(null, checkpointSigningInput(hash), deps.signingKey.privateKey).toString(
            'base64url',
          ),
        }
      : null;
  const now = deps.clock();
  const today = day(now);
  return deps.db.transaction(async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock($1)', [COUNT_LOG_LOCK_KEY]);
    const existing = (
      await tx.query<Checkpoint>('SELECT * FROM count_log_checkpoints WHERE date=$1', [today])
    ).rows[0];
    if (existing) throw new Error('legacyCheckpoint: a checkpoint exists for today');
    const previous = (
      await tx.query<{ tree_size: number; hash: string; v: number }>(
        'SELECT tree_size, hash, v FROM count_log_checkpoints ORDER BY date DESC LIMIT 1',
      )
    ).rows[0];
    const counted = (await tx.query<Counted>(COUNTED_SQL, [excluded])).rows;
    const known = new Map(
      (
        await tx.query<{ idx: number; agent_id: string }>(
          'SELECT idx, agent_id FROM count_log_leaves',
        )
      ).rows.map((row) => [row.agent_id, Number(row.idx)]),
    );
    const pending = await pendingLeaves(tx);
    const recordedAt = new Map(
      (
        await tx.query<{ agent_id: string; recorded_at: string | number }>(
          'SELECT agent_id, recorded_at FROM count_log_pending',
        )
      ).rows.map((row) => [row.agent_id, Number(row.recorded_at)]),
    );
    const cut = deps.cut;
    const beforeCut = (agent: Counted) => {
      if (cut === undefined) return true;
      const recorded = recordedAt.get(agent.agent_id);
      if (recorded !== undefined) return recorded < cut;
      // Missed by the feed: its own createdAt decides; without a valid one it stays in.
      const created = createdMs(agent.created_at);
      return created === null || created < cut;
    };
    const fresh = counted
      .filter((agent) => !known.has(agent.agent_id) && beforeCut(agent))
      .map((agent) => ({
        ...agent,
        created_day:
          pending.get(agent.agent_id)?.created_day ??
          (agent.created_at && !Number.isNaN(Date.parse(agent.created_at))
            ? day(Date.parse(agent.created_at))
            : today),
      }))
      .sort((a, b) => {
        if (a.created_day !== b.created_day) return a.created_day < b.created_day ? -1 : 1;
        const pa = pending.get(a.agent_id)?.order;
        const pb = pending.get(b.agent_id)?.order;
        if (pa && pb) {
          if (pa[0] !== pb[0]) return pa[0] < pb[0] ? -1 : 1;
          return pa[1] !== pb[1] ? pa[1] - pb[1] : pa[2] - pb[2];
        }
        if (pa || pb) return pa ? -1 : 1;
        return a.agent_id < b.agent_id ? -1 : 1;
      });
    let next = known.size;
    for (const agent of fresh) {
      const recorded = pending.get(agent.agent_id);
      const salt = recorded?.salt ?? newSalt();
      const leaf = recorded?.leaf ?? (await agentLeafHash(agent.agent_id, salt, agent.created_day));
      await tx.query(
        'INSERT INTO count_log_leaves(idx,agent_id,salt,created_day,leaf_hash,appended_at) VALUES($1,$2,$3,$4,$5,$6)',
        [next, agent.agent_id, Buffer.from(salt), agent.created_day, Buffer.from(leaf), now],
      );
      known.set(agent.agent_id, next++);
    }
    const countedIds = new Set(counted.map((agent) => agent.agent_id));
    const withdrawnIdx = new Set(
      (await tx.query<{ idx: number }>('SELECT idx FROM count_log_withdrawn')).rows.map((row) =>
        Number(row.idx),
      ),
    );
    for (const [agentId, idx] of known)
      if (!countedIds.has(agentId) && !withdrawnIdx.has(idx)) {
        await tx.query(
          "INSERT INTO count_log_withdrawn(idx,reason,day,recorded_at) VALUES($1,'no_longer_counted',$2,$3)",
          [idx, today, now],
        );
        withdrawnIdx.add(idx);
      }
    const subcounts: Subcounts = {
      in_person_accounts: 0,
      in_ai_workspaces: 0,
      unclaimed: 0,
      revoked: 0,
    };
    for (const agent of counted) {
      // Agents the cut left for tomorrow have no leaf yet and are not in the split.
      const idx = known.get(agent.agent_id);
      if (idx === undefined || withdrawnIdx.has(idx)) continue;
      if (agent.kind === 'ai') subcounts.in_ai_workspaces++;
      else if (agent.kind === 'unclaimed') subcounts.unclaimed++;
      else subcounts.in_person_accounts++;
      if (agent.revoked) subcounts.revoked++;
    }
    const leaves = (
      await tx.query<{ leaf_hash: Uint8Array }>(
        'SELECT leaf_hash FROM count_log_leaves ORDER BY idx',
      )
    ).rows.map((row) => new Uint8Array(row.leaf_hash));
    const commitmentSalt = newSalt();
    const body: CheckpointBody = {
      v: 2,
      date: today,
      tree_size: leaves.length,
      withdrawn: withdrawnIdx.size,
      root: toHex(await merkleRoot(leaves)),
      // v2 starts a new chain after v1 (V2_GENESIS_PREV_HASH).
      prev_hash: previous && Number(previous.v) === 2 ? previous.hash : null,
      subcounts_commitment: await subcountsCommitment(subcounts, commitmentSalt),
    };
    const hash = await checkpointHash(body);
    const consistency = previous
      ? (await consistencyProof(leaves, Number(previous.tree_size))).map(toHex)
      : [];
    const checkpoint: Checkpoint = { ...body, hash, signature: signHash(hash), consistency };
    await tx.query(
      `INSERT INTO count_log_checkpoints(date,tree_size,withdrawn,root,prev_hash,hash,subcounts,consistency,signature,created_at,v,subcounts_commitment,subcounts_salt)
       VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb,$10,2,$11,$12)`,
      [
        today,
        body.tree_size,
        body.withdrawn,
        body.root,
        body.prev_hash,
        hash,
        JSON.stringify(subcounts),
        JSON.stringify(consistency),
        checkpoint.signature ? JSON.stringify(checkpoint.signature) : null,
        now,
        body.subcounts_commitment,
        Buffer.from(commitmentSalt),
      ],
    );
    return { checkpoint, created: true };
  });
}
