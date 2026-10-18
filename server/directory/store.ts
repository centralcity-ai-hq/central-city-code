/*
 * Operation Directory D1 (shared/directory.ts): the owner's "Show in the directory" settings and
 * the public directory search, from Central City's own records only (no chain read).
 *
 * Listed, all of:
 *   - its owner turned on "Show in the directory" (agent_directory.listed; no row = off);
 *   - the Agent Explorer lists it (server/base/explorer/store.ts LISTED: our own registration on
 *     the canonical registry, seen on Base, the agent's own wallet and short id, our agent URI)
 *     with a FINAL Base ID (state 'confirmed'), never a finalizing one;
 *   - its card is public now (PUBLIC_MANIFEST: not revoked, current revision, visibility 'public')
 *     with a display name.
 * Turning the card private or revoking the agent takes it out at once; the switch stays as the
 * owner left it.
 *
 * A card publishes the Base ID, the passport's short id, the public name, description and skill
 * names, the Central City score (the explorer list's own: listScores + averageOf) and whether the
 * owner accepts invitations. Never the agent id, the owner, a wallet or its balance, or a
 * workspace id.
 *
 * The listed set is opt-in and small, so a search loads its matching candidates (at most
 * DIRECTORY_CANDIDATES_MAX, newest Base IDs first), scores them in one query, then filters, sorts
 * and pages in memory; the cursor is the offset into that order. Past the cap the oldest matches
 * drop out of the search; when the directory grows that far it moves to a stored score and a keyset
 * cursor.
 */
import type { Database } from '../database.js';
import { type BaseChainId } from '../../shared/base/chains.js';
import { averageOf, type CityScore } from '../../shared/base/rating-score.js';
import {
  DIRECTORY_LIMITS,
  type DirectoryCard,
  type DirectoryPage,
  type DirectoryQuery,
  type DirectorySettings,
} from '../../shared/directory.js';
import { AGENT_URI_ORIGIN } from '../../shared/base/on-base.js';
import {
  BASE_ID,
  FROM,
  LISTED,
  PUBLIC_MANIFEST,
  PUBLIC_NAME,
  createOnBaseStore,
  parseQuery,
} from '../base/explorer/store.js';
import { CAPABILITY_SKILLS } from '../manifest/agent-card.js';

type Queryable = Pick<Database, 'query'>;

/** Candidates one search loads at most (see the header). */
export const DIRECTORY_CANDIDATES_MAX = 1000;
/** The description a card shows, after trimming. */
export const DIRECTORY_DESCRIPTION_MAX = 200;

/** No row: not listed, invitations asked. */
export const DIRECTORY_DEFAULTS: DirectorySettings = { listed: false, invitations: 'ask' };

interface CandidateRow {
  agent_id: string;
  base_id: string;
  short_id: string;
  agent_wallet: string;
  invitations: 'ask' | 'never';
  manifest: {
    metadata?: { displayName?: unknown; description?: unknown };
    spec?: { skills?: unknown; capabilities?: unknown };
  };
}

const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');

/**
 * The skill names a card shows: the manifest's own skills, else its capabilities by the names the
 * agent card gives them (server/manifest/agent-card.ts compileAgentCard), the first few only.
 */
export function skillNames(spec: CandidateRow['manifest']['spec']): string[] {
  const skills = Array.isArray(spec?.skills) ? spec.skills : [];
  const names = skills.length
    ? skills.map((skill) => text((skill as { name?: unknown } | null)?.name))
    : (Array.isArray(spec?.capabilities) ? spec.capabilities : []).map((capability) =>
        typeof capability === 'string' ? (CAPABILITY_SKILLS[capability]?.name ?? capability) : '',
      );
  return names.filter(Boolean).slice(0, DIRECTORY_LIMITS.skillsShown);
}

/** The page cursor: the offset into the search's order, base64url. */
export const cursorOf = (offset: number) => Buffer.from(String(offset)).toString('base64url');

/** A cursor's offset, or 0 (the first page) for anything this server did not write. */
export function offsetOf(cursor: string | null): number {
  if (cursor === null) return 0;
  const decoded = Buffer.from(cursor, 'base64url').toString();
  if (!/^[1-9][0-9]{0,5}$/.test(decoded) || cursorOf(Number(decoded)) !== cursor) return 0;
  return Number(decoded);
}

/** Tenths of a score's average ("4.6" -> 46), for exact comparison. */
const tenthsOf = (score: CityScore) => {
  const [whole, tenth = '0'] = score.average.split('.');
  return Number(whole) * 10 + Number(tenth);
};

const byBaseIdDesc = (a: DirectoryCard, b: DirectoryCard) => {
  const x = BigInt(a.baseId),
    y = BigInt(b.baseId);
  return x === y ? 0 : x > y ? -1 : 1;
};

/** Best rated: average, then raters, then the newer Base ID; unrated last (newest first). */
function byBestRated(a: DirectoryCard, b: DirectoryCard): number {
  if (a.score && b.score) {
    const average = tenthsOf(b.score) - tenthsOf(a.score);
    if (average) return average;
    const raters = b.score.raters - a.score.raters;
    if (raters) return raters;
  } else if (a.score || b.score) return a.score ? -1 : 1;
  return byBaseIdDesc(a, b);
}

export interface DirectoryStoreOptions {
  chainId: BaseChainId;
  /** The agent URI origin (tests); defaults to https://centralcity.ai. */
  uriOrigin?: string;
}

export function createDirectoryStore(db: Queryable, options: DirectoryStoreOptions) {
  const onBase = createOnBaseStore(db, options);
  const listedParams = [options.chainId, onBase.registry, options.uriOrigin ?? AGENT_URI_ORIGIN];

  async function settings(agentId: string): Promise<DirectorySettings> {
    const { rows } = await db.query<DirectorySettings>(
      'SELECT listed, invitations FROM agent_directory WHERE agent_id = $1',
      [agentId],
    );
    const row = rows[0];
    return row ? { listed: row.listed, invitations: row.invitations } : { ...DIRECTORY_DEFAULTS };
  }

  /**
   * Whether the agent may be listed now: the explorer lists it with a FINAL Base ID and its card
   * is public with a name (the header). Checked when the owner turns listing on; the search checks
   * it again on every read.
   */
  async function eligible(agentId: string): Promise<boolean> {
    const { rows } = await db.query(
      `SELECT 1 FROM (
         SELECT i.agent_id ${FROM}
         WHERE ${LISTED} AND i.state = 'confirmed' AND i.agent_id = $4 LIMIT 1) l
       ${PUBLIC_NAME}
       WHERE p.name IS NOT NULL`,
      [...listedParams, agentId],
    );
    return rows.length > 0;
  }

  /**
   * Writes the given fields (the others keep their value, or the default) and answers them all.
   * One upsert, so it takes the row lock: it waits for a room invitation accept that holds the
   * row FOR SHARE (or a send that holds it FOR UPDATE) and is read by any that comes after it
   * (server/rooms/invitations.ts).
   */
  async function save(
    agentId: string,
    patch: Partial<DirectorySettings>,
  ): Promise<DirectorySettings> {
    const { rows } = await db.query<DirectorySettings>(
      `INSERT INTO agent_directory (agent_id, listed, invitations)
       VALUES ($1, COALESCE($2::boolean, false), COALESCE($3::text, 'ask'))
       ON CONFLICT (agent_id) DO UPDATE SET
         listed = COALESCE($2::boolean, agent_directory.listed),
         invitations = COALESCE($3::text, agent_directory.invitations),
         updated_at = now()
       RETURNING listed, invitations`,
      [agentId, patch.listed ?? null, patch.invitations ?? null],
    );
    return { listed: rows[0].listed, invitations: rows[0].invitations };
  }

  async function search(query: DirectoryQuery): Promise<DirectoryPage> {
    const params: unknown[] = [...listedParams];
    const p = (value: unknown) => {
      params.push(value);
      return `$${params.length}`;
    };
    const where = [`NULLIF(btrim(pm.manifest->'metadata'->>'displayName'), '') IS NOT NULL`];
    if (query.q) {
      // Literal text: LIKE's wildcards and its escape character escaped (explorer parseQuery).
      const like = p(`%${query.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
      const ids = p(Object.keys(CAPABILITY_SKILLS));
      const names = p(Object.values(CAPABILITY_SKILLS).map((skill) => skill.name));
      const array = (path: string) =>
        `CASE WHEN jsonb_typeof(${path}) = 'array' THEN ${path} ELSE '[]'::jsonb END`;
      const skills = array(`pm.manifest->'spec'->'skills'`);
      const capabilities = array(`pm.manifest->'spec'->'capabilities'`);
      // A Base ID ("123", "#123") or a passport number ("CC-AbC123", "AbC123") also finds the
      // agent itself, as the explorer's search reads them (parseQuery).
      const read = parseQuery(query.q);
      const idHits: string[] = [];
      if (read.baseId) idHits.push(`l.base_id = ${p(read.baseId)}`);
      if (read.shortId) idHits.push(`l.short_id = ${p(read.shortId)}`);
      // The skills as the card names them (skillNames): its own skills, else its capabilities.
      where.push(`(${idHits.map((hit) => `${hit} OR `).join('')}pm.manifest->'metadata'->>'displayName' ILIKE ${like}
        OR pm.manifest->'metadata'->>'description' ILIKE ${like}
        OR EXISTS (SELECT 1 FROM jsonb_array_elements(${skills}) sk WHERE sk->>'name' ILIKE ${like})
        OR (jsonb_array_length(${skills}) = 0 AND EXISTS (
          SELECT 1 FROM jsonb_array_elements_text(${capabilities}) c
          LEFT JOIN unnest(${ids}::text[], ${names}::text[]) AS cs(id, name) ON cs.id = c
          WHERE COALESCE(cs.name, c) ILIKE ${like})))`);
    }
    const { rows } = await db.query<CandidateRow>(
      `SELECT l.agent_id, l.base_id, l.short_id, l.agent_wallet, l.invitations, pm.manifest FROM (
         SELECT i.agent_id, ${BASE_ID}::text AS base_id, s.short_id, w.address AS agent_wallet,
                d.invitations
         ${FROM}
         JOIN agent_directory d ON d.agent_id = i.agent_id AND d.listed
         WHERE ${LISTED} AND i.state = 'confirmed') l
       ${PUBLIC_MANIFEST}
       WHERE ${where.join(' AND ')}
       ORDER BY l.base_id::numeric DESC, l.agent_id DESC
       LIMIT ${DIRECTORY_CANDIDATES_MAX}`,
      params,
    );
    // One query for every candidate's score (the explorer list's records and rule).
    // ...and one for every candidate's payments (the passport's earnings rule).
    const [scores, paid] = await Promise.all([
      onBase.listScores(
        rows.map((row) => ({ baseId: row.base_id, agentWallet: row.agent_wallet })),
      ),
      onBase.paidCounts(rows.map((row) => row.agent_id)),
    ]);
    let cards: DirectoryCard[] = rows.map((row) => ({
      baseId: row.base_id,
      short: row.short_id,
      name: text(row.manifest.metadata?.displayName),
      description: text(row.manifest.metadata?.description).slice(0, DIRECTORY_DESCRIPTION_MAX),
      skills: skillNames(row.manifest.spec),
      score: averageOf(scores.get(row.base_id) ?? []),
      // The passport's "Paid" count (final payments from other agents), 0 when never paid.
      paidTimes: paid.get(row.agent_id) ?? 0,
      invitable: row.invitations === 'ask',
      // No per-agent last-activity record to read cheaply yet.
      activeAt: null,
    }));
    if (query.minRating > 0)
      cards = cards.filter((card) => card.score && tenthsOf(card.score) >= query.minRating * 10);
    // Newest keeps the query's newest-first order; most paid sorts by paidTimes, then newest
    // (a stable sort over that order).
    if (query.sort === 'best_rated') cards.sort(byBestRated);
    if (query.sort === 'most_paid') cards.sort((a, b) => (b.paidTimes ?? 0) - (a.paidTimes ?? 0));
    // A cursor past the end (the list shrank since it was handed out) is an empty last page, not
    // page 1 again: a client paging until next is null would see every card twice.
    const start = offsetOf(query.before);
    const end = start + DIRECTORY_LIMITS.pageSize;
    return {
      agents: cards.slice(start, end),
      next: end < cards.length ? cursorOf(end) : null,
    };
  }

  return { settings, eligible, save, search };
}

export type DirectoryStore = ReturnType<typeof createDirectoryStore>;
