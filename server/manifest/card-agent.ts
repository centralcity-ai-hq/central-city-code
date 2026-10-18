/**
 * The agent behind an Agent Card, shared by the card route (`/a2a/<id>/.well-known/agent-card.json`,
 * server/autonomy/index.ts) and the agent link (`/a/<id>`, server/base/identity/short-links.ts),
 * which reads the public card directly instead of requesting the card route.
 */
import type { Database } from '../database.js';
import type { ResolvedAgentManifest } from '../../shared/manifest.js';
import { compileAgentCard, type AgentCard } from './agent-card.js';
import { basePassport } from '../base/identity/passport.js';
import { passportExtension } from '../../shared/base/passport.js';

export interface CardAgent {
  operatorId: string;
  /** The operator's kind ('owner' for a person's workspace). */
  kind: string;
  manifest: ResolvedAgentManifest;
}

/**
 * How long one server instance trusts its copy of a workspace's card index. Approved 15 Oct 2026: a
 * revoke, rename or visibility change may show on public cards up to 60 s late, so a crawler
 * walking a large workspace unpacks it once a minute per instance instead of once per card.
 */
export const CARD_INDEX_TTL_MS = 60_000;
const CARD_INDEX_WORKSPACES = 256;

interface CardIndex {
  db: Database;
  readAt: number;
  until: number;
  kind: string;
  /** Agent id to its current manifest revision (0 without a manifest). */
  revisions: Map<string, number>;
  revoked: Set<string>;
}

/** Instances' clocks may differ by this much (manifest created_at is the writer's clock). */
const CLOCK_SKEW_MS = 5_000;

/** Per workspace; an entry read from another database (tests run many in one process) is a miss. */
const byWorkspace = new Map<string, { db: Database; reading: Promise<CardIndex> } | CardIndex>();

async function readCardIndex(db: Database, operatorId: string, now: number): Promise<CardIndex> {
  const { rows } = await db.query<{
    kind: string;
    id: string | null;
    revision: number | null;
    revoked: boolean | null;
  }>(
    `SELECT o.kind, a->>'id' AS id, COALESCE((a->>'revision')::int, 0) AS revision,
            a->>'revokedAt' IS NOT NULL AS revoked
       FROM workspaces w
       JOIN operators o ON o.id=w.operator_id
       LEFT JOIN LATERAL jsonb_array_elements(w.data->'agents') a ON true
      WHERE w.operator_id=$1`,
    [operatorId],
  );
  const revisions = new Map<string, number>();
  const revoked = new Set<string>();
  for (const row of rows) {
    if (!row.id) continue;
    revisions.set(row.id, Number(row.revision) || 0);
    if (row.revoked) revoked.add(row.id);
  }
  return {
    db,
    readAt: now,
    until: now + CARD_INDEX_TTL_MS,
    kind: rows[0]?.kind ?? '',
    revisions,
    revoked,
  };
}

/**
 * The workspace's card index, read at most once per TTL per instance (concurrent misses share one
 * read; the least recently used workspace is dropped first). `fresh`: this call read it.
 */
async function cardIndex(
  db: Database,
  operatorId: string,
  now: number,
): Promise<{ index: CardIndex; fresh: boolean }> {
  const cached = byWorkspace.get(operatorId);
  if (cached?.db === db) {
    if ('reading' in cached) return { index: await cached.reading, fresh: false };
    if (cached.until > now) {
      byWorkspace.delete(operatorId);
      byWorkspace.set(operatorId, cached);
      return { index: cached, fresh: false };
    }
  }
  const reading = readCardIndex(db, operatorId, now);
  const pending = { db, reading };
  byWorkspace.set(operatorId, pending);
  try {
    const index = await reading;
    if (byWorkspace.get(operatorId) === pending) {
      byWorkspace.delete(operatorId);
      byWorkspace.set(operatorId, index);
      while (byWorkspace.size > CARD_INDEX_WORKSPACES)
        byWorkspace.delete(byWorkspace.keys().next().value!);
    }
    return { index, fresh: true };
  } catch (error) {
    if (byWorkspace.get(operatorId) === pending) byWorkspace.delete(operatorId);
    throw error;
  }
}

/**
 * Drops this instance's card index for a workspace after one of its agents was revoked, so this
 * instance shows it at once; other instances within the TTL. (A new agent or a new manifest
 * revision is seen at once on every instance: see cardAgent.)
 */
export function forgetCardIndex(operatorId: string): void {
  byWorkspace.delete(operatorId);
}

/**
 * The agent in its workspace, not revoked, at its current manifest revision; null when it has no
 * card at all. Who may see the card (N5: public, or the owner) is the caller's rule.
 */
export async function cardAgent(
  db: Database,
  agentId: string,
  now = Date.now(),
): Promise<CardAgent | null> {
  const latest = (
    await db.query<{ operator_id: string; revision: number; created_at: string | number }>(
      `SELECT operator_id, revision, created_at FROM agent_manifests WHERE agent_id=$1
        ORDER BY revision DESC LIMIT 1`,
      [agentId],
    )
  ).rows[0];
  if (!latest) return null;
  let { index, fresh } = await cardIndex(db, latest.operator_id, now);
  const known = index.revisions.get(agentId);
  // The index is older than what the manifests say: a newer revision of a known agent (a rename,
  // a visibility change; never served from the index, whatever the clocks say), or an agent the
  // index has not seen with a manifest written since it was read (a new agent; an agent long gone
  // from its workspace is not read again). Read the index again unless this call just did.
  const behind =
    known === undefined
      ? Number(latest.created_at) > index.readAt - CLOCK_SKEW_MS
      : known < Number(latest.revision);
  if (behind && !fresh) {
    forgetCardIndex(latest.operator_id);
    ({ index } = await cardIndex(db, latest.operator_id, now));
  }
  const revision = index.revisions.get(agentId);
  if (!revision || index.revoked.has(agentId)) return null;
  return manifestAt(db, agentId, latest.operator_id, index.kind, revision);
}

async function manifestAt(
  db: Database,
  agentId: string,
  operatorId: string,
  kind: string,
  revision: number,
): Promise<CardAgent | null> {
  const manifest = (
    await db.query<{ manifest: ResolvedAgentManifest }>(
      'SELECT manifest FROM agent_manifests WHERE agent_id=$1 AND revision=$2',
      [agentId, revision],
    )
  ).rows[0]?.manifest;
  if (!manifest) return null;
  return { operatorId, kind, manifest };
}

/** The card as the card route compiles it (unsigned), with the Base passport when there is one. */
export async function compileCardFor(
  db: Database,
  agentId: string,
  manifest: ResolvedAgentManifest,
  origin: string,
): Promise<AgentCard> {
  const passport = await basePassport(db, agentId);
  return compileAgentCard(manifest, {
    agentId,
    baseUrl: origin,
    provider: { organization: 'Central City', url: origin },
    ...(passport ? { extensions: [passportExtension(passport)] } : {}),
  });
}

/** The agent's public card (unsigned), or null when it has none or it is not public. */
export async function publicAgentCard(
  db: Database,
  agentId: string,
  origin: string,
  now = Date.now(),
): Promise<AgentCard | null> {
  const found = await cardAgent(db, agentId, now);
  if (!found || found.manifest.spec.visibility !== 'public') return null;
  return compileCardFor(db, agentId, found.manifest, origin);
}
