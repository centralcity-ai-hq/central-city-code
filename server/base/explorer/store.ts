/*
 * The "On Base" data of the Agent Explorer, read only from our own registration records
 * (base_identities with its wallet and short id). A row is listed only when Central City sent the
 * registration itself AND has seen its mint on Base (mint_seen_at), in one of two states:
 *
 *   final       state 'confirmed': the final id, handed over under the bound key, both operations
 *               final, owner and tokenURI checked at the finalized block (identity/service.ts).
 *   finalizing  the identity service's 'registered' stage: a verified mint (our own register
 *               receipt, our URI) and the hand-over of that id both at least SAFE, nothing lost or
 *               mismatched. Its id is the provisional one, published only with this label. Once
 *               the mint is final the service stores that same id as the final one while it waits
 *               for the hand-over to confirm: still finalizing, never dropped in between.
 *
 * and always: the canonical registry of the chain, the agent's own wallet and short id,
 * and agent_card_uri == https://centralcity.ai/a/<short id>. Rows still registering, failed,
 * rechecking or of another registry are never listed or counted.
 *
 * Published per row: on-chain values (id, agent wallet, mint account, transactions, blocks), the
 * times Central City saw and confirmed them, and the display name only while the agent's card is
 * public. Never the agent id, the owner's own wallet, key references, operation keys or
 * workspace ids. Leaving these out does not make one owner's agents unlinkable: every agent wallet
 * of one person has that person's owner key as an owner, so once deployed, anyone can link those
 * wallets on Base (docs/base/WALLET-THREAT-MODEL.md, the privacy row; CCA-143).
 */
import { getAddress } from 'viem';
import type { Database } from '../../database.js';
import { PUBLIC_CARDS_READY } from '../../agent-rows/public-cards-schema.js';
import { BASE_NETWORKS } from '../../../shared/base/chains.js';
import { ARC_NETWORKS } from '../../../shared/chains.js';
import {
  AGENT_URI_ORIGIN,
  ON_BASE_PAGE_SIZE,
  ON_BASE_TX_SEARCH_AVAILABLE,
  onBaseSearchReadings,
  type OnBasePassport,
  type OnBaseSearchNotice,
  type OnBaseRow,
} from '../../../shared/base/on-base.js';
import {
  RATING_DECIMALS,
  RATING_TAG,
  starsOf,
  type CountedRating,
} from '../../../shared/base/rating-score.js';

type Queryable = Pick<Database, 'query'>;

/** Candidates the Explorer list reads per step before joining (newestListed). */
export const LIST_CANDIDATES = 200;

/** The newest-first order key: ERC-8004 ids count up, so a higher id registered later. */
export const BASE_ID = 'COALESCE(i.erc8004_agent_id, i.provisional_agent_id)';

/**
 * The transaction that minted the id, or NULL when it is not known for certain. Never another
 * transaction of the registration: before migration 85, tx_hash could hold the hand-over.
 *   1. mint_tx_hash: the receipt the identity service verified (or took from the final register
 *      operation) when it stored the id;
 *   2. else the register operation the row pinned as its evidence (mint_op_id), when it is final;
 *   3. else (rows from before 85, whose mint was never pinned) the one final register operation
 *      of this agent's register family on this chain; with two or more (a retry whose earlier
 *      attempt minted a second, unused id) it is ambiguous, so NULL.
 */
const MINT_TX = `COALESCE(i.mint_tx_hash,
  (SELECT o.tx_hash FROM base_chain_ops o
    WHERE o.idempotency_key = i.mint_op_id AND o.kind = 'register' AND o.status = 'final'
      AND o.chain_id = i.chain_id AND o.tx_hash IS NOT NULL),
  (SELECT CASE WHEN count(*) = 1 THEN min(o.tx_hash) END FROM base_chain_ops o
    WHERE o.kind = 'register' AND o.status = 'final' AND o.chain_id = i.chain_id
      AND o.tx_hash IS NOT NULL
      AND (o.idempotency_key = 'identity:register:' || i.chain_id || ':' || i.agent_id
        OR left(o.idempotency_key, length(i.chain_id::text) + length(i.agent_id) + 20)
          = 'identity:register:' || i.chain_id || ':' || i.agent_id || ':')))`;

/**
 * LISTED's conditions on base_identities alone (no join): the Explorer list picks its newest
 * candidates with these through the base id index (migration 255), then joins only those.
 */
/**
 * Each address as base_wallets.spender_address may hold it: lower case and checksummed (EIP-55),
 * so an exact match can read base_wallets_spender instead of lower(spender_address), which no
 * production index serves. Anything that is not a 0x address is left out.
 */
export function spenderForms(addresses: readonly string[]): string[] {
  const forms = new Set<string>();
  for (const address of addresses) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) continue;
    forms.add(address.toLowerCase());
    forms.add(getAddress(address));
  }
  return [...forms];
}

export const LISTED_IDENTITY = `i.chain_id = $1 AND lower(i.registry_address) = lower($2)
  AND i.mint_seen_at IS NOT NULL
  AND (
    (i.state = 'confirmed' AND i.erc8004_agent_id IS NOT NULL
      AND i.handover_id = i.erc8004_agent_id)
    OR (i.state = 'submitted'
      AND (i.erc8004_agent_id IS NULL OR i.erc8004_agent_id = i.provisional_agent_id)
      AND i.provisional_agent_id IS NOT NULL AND i.mint_op_id IS NOT NULL
      AND i.mint_lost_at IS NULL AND i.destination_mismatch IS NULL
      AND i.mint_finality IN ('safe','final')
      AND i.handover_id = i.provisional_agent_id AND i.handover_tx_hash IS NOT NULL
      AND i.handover_finality IN ('safe','final'))
  )`;

/** The rows the explorer may list (see the header). $1 chain id, $2 registry, $3 URI origin. */
export const LISTED = `${LISTED_IDENTITY}
  AND i.agent_card_uri = $3 || '/a/' || s.short_id`;

export const FROM = `FROM base_identities i
  JOIN base_wallets w ON w.agent_id = i.agent_id AND w.chain_id = i.chain_id
  JOIN base_short_ids s ON s.agent_id = i.agent_id`;

const COLUMNS = `i.agent_id, ${BASE_ID}::text AS base_id, (i.state = 'confirmed') AS final,
  s.short_id, w.address AS agent_wallet, w.spender_address AS mint_account,
  ${MINT_TX} AS mint_tx, i.mint_block::text AS registration_block,
  i.handover_block::text AS handover_block,
  GREATEST(i.mint_block, i.handover_block)::text AS recorded_block,
  i.mint_seen_at::text AS seen_at, i.updated_at::text AS updated_at`;

/**
 * The agent's current public manifest revision: the agent in its workspace document, not revoked,
 * at its current manifest revision, with visibility 'public' (the card route's rule,
 * server/autonomy/index.ts). The FROM ... LIMIT 1 of a LATERAL joined onto a subquery aliased `l`
 * that has an `agent_id` column. The agent is read with workspace_agent() (one lookup, both storage
 * modes; migration 254 makes it one pass that stops at the match), never by expanding a fleet
 * workspace's ~19.5k agents into rows for each listed agent. Read only until agent_public_cards
 * (migration 280) holds every agent; that table keeps this same rule.
 */
const PUBLIC_REVISION = `FROM workspaces ws
  CROSS JOIN LATERAL (SELECT workspace_agent(ws.operator_id, ws.data, l.agent_id) AS a OFFSET 0) x
  JOIN agent_manifests m ON m.agent_id = l.agent_id AND m.revision = (x.a->>'revision')::int
  WHERE ws.operator_id = (SELECT operator_id FROM agent_manifests WHERE agent_id = l.agent_id LIMIT 1)
    AND x.a->>'revokedAt' IS NULL
    AND m.manifest->'spec'->>'visibility' = 'public'
    AND NOT ${PUBLIC_CARDS_READY}
  LIMIT 1`;

/**
 * The current public display name (PUBLIC_REVISION's rule); anything else has no name here.
 * Joined onto a subquery aliased `l` that has an `agent_id` column (pay/store.ts too). One index
 * probe of agent_public_cards (migration 280) per row, never the owner's workspace document; until
 * that table is backfilled, PUBLIC_REVISION's read of the workspace.
 */
export const PUBLIC_NAME = `LEFT JOIN LATERAL (
  (SELECT c.name FROM agent_public_cards c WHERE c.agent_id = l.agent_id AND ${PUBLIC_CARDS_READY})
  UNION ALL
  (SELECT NULLIF(btrim(m.manifest->'metadata'->>'displayName'), '') AS name
  ${PUBLIC_REVISION})
  LIMIT 1
) p ON true`;

/**
 * The current public manifest (PUBLIC_REVISION's rule) of every agent `ids` names, as rows
 * (agent_id, manifest, name); an agent whose card is not public now is not among them. `ids` is
 * a query of one column of agent ids, which may name a CTE of the statement it is used in.
 *
 * Read from agent_public_cards (migration 280): one index probe per agent and its manifest at that
 * revision. Until that table is backfilled, each workspace's agents are read ONCE per statement
 * (workspace_agents, both storage modes), however many of them are asked for, then matched by id:
 * the first agent in array order with the id, not revoked, its current revision public. Use as a
 * CTE (`p AS (${publicManifestsOf('SELECT agent_id FROM l')})`) and join it on agent_id; it takes
 * no parameters.
 */
export const publicManifestsOf = (ids: string) => `SELECT c.agent_id, m.manifest, c.name
  FROM agent_public_cards c
  JOIN agent_manifests m ON m.agent_id = c.agent_id AND m.revision = c.revision
  WHERE c.agent_id IN (SELECT q.agent_id FROM (${ids}) AS q(agent_id)) AND ${PUBLIC_CARDS_READY}
  UNION ALL
  SELECT pm.* FROM (WITH pm_want AS MATERIALIZED (
    SELECT w.agent_id,
      (SELECT operator_id FROM agent_manifests WHERE agent_id = w.agent_id LIMIT 1) AS ws_id
    FROM (SELECT DISTINCT q.agent_id FROM (${ids}) AS q(agent_id)) w),
  pm_all AS MATERIALIZED (
    SELECT ws.operator_id AS ws_id, wa.ordinal, wa.agent->>'id' AS agent_id,
      wa.agent->>'revision' AS revision, wa.agent->>'revokedAt' IS NULL AS live
    FROM workspaces ws
    CROSS JOIN LATERAL workspace_agents(ws.operator_id, ws.data) wa
    WHERE ws.operator_id IN (SELECT ws_id FROM pm_want)),
  pm_cur AS (
    SELECT DISTINCT ON (a.agent_id) a.agent_id, a.revision, a.live
    FROM pm_all a JOIN pm_want w ON w.agent_id = a.agent_id AND w.ws_id = a.ws_id
    ORDER BY a.agent_id, a.ordinal)
  SELECT c.agent_id, m.manifest,
    NULLIF(btrim(m.manifest->'metadata'->>'displayName'), '') AS name
  FROM pm_cur c
  JOIN agent_manifests m ON m.agent_id = c.agent_id AND m.revision = c.revision::int
  WHERE c.live AND m.manifest->'spec'->>'visibility' = 'public') pm
  WHERE NOT ${PUBLIC_CARDS_READY}`;

interface Row {
  agent_id: string;
  base_id: string;
  final: boolean;
  short_id: string;
  agent_wallet: string;
  mint_account: string;
  mint_tx: string | null;
  registration_block: string | null;
  handover_block: string | null;
  recorded_block: string | null;
  seen_at: string;
  updated_at: string;
  name: string | null;
}

/**
 * Rated agents (the explorer's "Rated agents" number): how many distinct Base IDs on chain $1 have
 * at least one rating sent through Central City whose own operation is a 'rate' on that chain,
 * FINAL on Base and not reverted (the finality listScores counts by). Every rated agent and every
 * rater, nothing else filtered.
 *
 * Cost: one index-only count of base_rated_agents (migration 121), which the database keeps as
 * ratings turn final: one narrow row per rated agent, never a walk of the ratings or of
 * base_chain_ops, and no workspace document. The routes run it through one shared public_stats
 * row, about once per RATED_TTL_MS globally (routes.ts), never per request.
 */
export const RATED_AGENTS_SQL = `SELECT count(*)::text AS rated
  FROM base_rated_agents WHERE chain_id = $1`;

const blockOf = (value: string | null) => (value === null ? null : Number(value));

/**
 * What Central City's records say Base held, and as of when: the agent wallet, which the identity
 * service checked as ownerOf (at the finalized block before 'confirmed'; at a safe block while
 * finalizing), at the newest block of the stored evidence, recorded at updated_at. The routes
 * replace it with the server's own ownerOf read whenever Base answers.
 */
export interface RecordedOwner {
  owner: string;
  block: number | null;
  at: number;
}

const recordedOf = (row: Row): RecordedOwner => ({
  owner: getAddress(row.agent_wallet),
  block: blockOf(row.recorded_block),
  at: Number(row.updated_at),
});

function rowOf(row: Row): OnBaseRow {
  return {
    baseId: row.base_id,
    // Central City metadata, only while the card is public; never a claim made on chain.
    name: row.name ?? '',
    owner: getAddress(row.agent_wallet),
    short: row.short_id,
    // Only when it is known for certain; never another transaction in its place.
    ...(row.mint_tx ? { mintTx: row.mint_tx } : {}),
    status: row.final ? 'final' : 'finalizing',
    ...(row.final ? {} : { finalizingSince: Number(row.seen_at) }),
  };
}

/**
 * What the search text can mean (onBaseSearchReadings); every reading that fits is tried, each in
 * its own branch through its own index (list). A name needs a run of ON_BASE_NAME_MIN letters or
 * digits, which the trigram index can serve; a shorter one read every registration.
 */
export interface ParsedQuery {
  baseId: string | null;
  shortId: string | null;
  address: string | null;
  txHash: string | null;
  /** A LIKE pattern for the public name (wildcards escaped), or null. */
  name: string | null;
  notice: OnBaseSearchNotice | null;
}

export function parseQuery(text: string): ParsedQuery {
  const r = onBaseSearchReadings(text);
  return {
    baseId: r.baseId,
    shortId: r.shortId,
    address: r.address,
    txHash: r.txHash,
    name: r.name ? `%${r.text.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null,
    notice: r.notice,
  };
}

export interface OnBaseStoreOptions {
  /** A Base network, or Arc (shared/chains.ts) for the explorer's On Arc view. */
  chainId: number;
  /** The agent URI origin (tests); defaults to https://centralcity.ai. */
  uriOrigin?: string;
}

export function createOnBaseStore(db: Queryable, options: OnBaseStoreOptions) {
  const registry =
    (
      BASE_NETWORKS as Record<
        number,
        (typeof BASE_NETWORKS)[keyof typeof BASE_NETWORKS] | undefined
      >
    )[options.chainId]?.contracts.identityRegistry ??
    (ARC_NETWORKS as Record<number, (typeof ARC_NETWORKS)[keyof typeof ARC_NETWORKS] | undefined>)[
      options.chainId
    ]?.contracts.identityRegistry ??
    '';
  const origin = options.uriOrigin ?? AGENT_URI_ORIGIN;

  /**
   * The newest `limit` listed rows older than `before`, in list order: candidates are read from
   * base_identities alone, LIST_CANDIDATES at a time in base id order, and only those are joined and
   * checked against the full LISTED; a batch that keeps too few reads the next one.
   */
  async function newestListed(before: string | undefined, limit: number): Promise<Row[]> {
    const found: Row[] = [];
    let after: { baseId: string; agentId: string } | null = null;
    for (;;) {
      const params: unknown[] = [options.chainId, registry];
      const p = (value: unknown) => {
        params.push(value);
        return `$${params.length}`;
      };
      const bound: string = after
        ? `(${BASE_ID}, i.agent_id) < (${p(after.baseId)}::numeric, ${p(after.agentId)}::text)`
        : before !== undefined
          ? `${BASE_ID} < ${p(before)}::numeric`
          : 'TRUE';
      const candidates: Array<{ agent_id: string; base_id: string }> = (
        await db.query<{ agent_id: string; base_id: string }>(
          `SELECT i.agent_id, ${BASE_ID}::text AS base_id FROM base_identities i
         WHERE ${LISTED_IDENTITY} AND ${bound}
         ORDER BY ${BASE_ID} DESC, i.agent_id DESC LIMIT ${LIST_CANDIDATES}`,
          params,
        )
      ).rows;
      if (candidates.length) {
        const { rows } = await db.query<Row>(
          `WITH l AS (
             SELECT ${COLUMNS} ${FROM}
             WHERE ${LISTED} AND i.agent_id = ANY($4::text[])
             ORDER BY ${BASE_ID} DESC, i.agent_id DESC LIMIT ${limit - found.length}),
           p AS (${publicManifestsOf('SELECT agent_id FROM l')})
           SELECT l.*, p.name FROM l LEFT JOIN p ON p.agent_id = l.agent_id
           ORDER BY l.base_id::numeric DESC, l.agent_id DESC`,
          [options.chainId, registry, origin, candidates.map((candidate) => candidate.agent_id)],
        );
        found.push(...rows);
      }
      if (found.length >= limit || candidates.length < LIST_CANDIDATES)
        return found.slice(0, limit);
      const last: { agent_id: string; base_id: string } = candidates[candidates.length - 1]!;
      after = { baseId: last.base_id, agentId: last.agent_id };
    }
  }

  /**
   * Newest first, ON_BASE_PAGE_SIZE per page, older than `before` (a base id) when given. A search
   * text with no reading it can answer (routes.ts refuses it first: onBaseUnsupportedReading) reads
   * nothing and is an empty page with its notice.
   */
  async function list(input: { before?: string; q?: string }) {
    const params: unknown[] = [options.chainId, registry, origin];
    const p = (value: unknown) => {
      params.push(value);
      return `$${params.length}`;
    };
    const where = [LISTED];
    if (input.before !== undefined) where.push(`${BASE_ID} < ${p(input.before)}::numeric`);
    const query = input.q === undefined ? null : parseQuery(input.q);
    // The exact readings, each its own branch through its own index: the Base ID through
    // base_identities_base_id (255), the short id through base_short_ids' primary key, the agent
    // wallet through base_wallets_address_lower (247). In one OR they span base_identities,
    // base_short_ids and base_wallets, which no index serves: a 6-digit text (a Base ID and a
    // short id) walked every registration (5.4 s at 1M).
    const limit = ON_BASE_PAGE_SIZE + 1;
    const order = `ORDER BY ${BASE_ID} DESC, i.agent_id DESC LIMIT ${limit}`;
    const branch = (from: string, hit: string) =>
      `(SELECT ${COLUMNS}, TRUE AS id_hit ${from} WHERE ${where.join(' AND ')} AND ${hit} ${order})`;
    const exact: string[] = [];
    if (query?.baseId) exact.push(branch(FROM, `${BASE_ID} = ${p(query.baseId)}::numeric`));
    if (query?.shortId) exact.push(branch(FROM, `s.short_id = ${p(query.shortId)}`));
    // The agent wallet (owner) only: the owner's own wallet is not published here, so not
    // searchable (on Base it is visible as an owner of each deployed agent wallet, CCA-143).
    if (query?.address) exact.push(branch(FROM, `lower(w.address) = ${p(query.address)}`));
    // A transaction is not searched until its indexes are built (ON_BASE_TX_SEARCH_AVAILABLE,
    // migration 291): routes.ts answers it 503 first, and here it reads nothing.
    if (query?.txHash && ON_BASE_TX_SEARCH_AVAILABLE) {
      const hash = p(query.txHash);
      exact.push(
        branch(
          FROM,
          `(lower(${MINT_TX}) = ${hash} OR lower(i.tx_hash) = ${hash} OR lower(i.handover_tx_hash) = ${hash})`,
        ),
      );
    }
    const notice = query?.notice === 'name-min' ? ('name-min' as const) : undefined;
    if (query && !exact.length && !query.name) return { ...pageOf([]), notice };
    const exactRows = exact.join('\n           UNION ALL ');
    let sql: string;
    // A name reading while agent_public_cards (migration 280) is still being backfilled: the
    // former fallback (every registration's manifests, then their workspaces) could not finish
    // within the search's statement timeout at production size, so every search with a name
    // reading, ids included, answered busy. Now the exact readings are answered in full from
    // their own indexes, the name from the cards the table already holds, and the page says that
    // names may be missing (incomplete) until the backfill is ready. Never a full scan.
    const backfill = query?.name
      ? (
          await db.query<{ ready: boolean }>(
            'SELECT ready FROM agent_public_cards_backfill WHERE id = 1',
          )
        ).rows[0]
      : undefined;
    if (query?.name && !backfill?.ready) {
      const name = p(query.name);
      // A card row, where there is one, is the current public name by the card route's rule (its
      // triggers keep it on every write since the migration); an agent without one yet (only an
      // id hit can be) gets its name by that same rule from its workspace (publicManifestsOf).
      const { rows } = await db.query<Row>(
        `WITH l AS (
           (SELECT ${COLUMNS}, FALSE AS id_hit ${FROM}
             JOIN agent_public_cards c ON c.agent_id = i.agent_id
             WHERE ${where.join(' AND ')} AND c.name ILIKE ${name} ${order})
           ${exactRows ? `UNION ALL ${exactRows}` : ''}),
         u AS (SELECT DISTINCT ON (l.agent_id) l.* FROM l ORDER BY l.agent_id, l.id_hit DESC),
         k AS MATERIALIZED (
           SELECT u.*, c.agent_id IS NOT NULL AS carded, c.name AS card_name
           FROM u LEFT JOIN agent_public_cards c ON c.agent_id = u.agent_id
           ORDER BY u.base_id::numeric DESC, u.agent_id DESC LIMIT ${limit}),
         pm AS (${publicManifestsOf('SELECT agent_id FROM k WHERE NOT k.carded')})
         SELECT k.*, CASE WHEN k.carded THEN k.card_name ELSE pm.name END AS name
         FROM k LEFT JOIN pm ON pm.agent_id = k.agent_id
         ORDER BY k.base_id::numeric DESC, k.agent_id DESC LIMIT ${limit}`,
        params,
      );
      return { ...pageOf(rows), incomplete: true as const, notice };
    }
    if (!query) {
      // No search: newest candidates from base_identities alone (through the base id index), then
      // the join and the card check for those only, then names for the page's rows only. Joining
      // first made every list read join all registrations (862,893 rows, 21 s, 23 Oct 2026).
      const rows = await newestListed(input.before, limit);
      return pageOf(rows);
    } else if (query.name) {
      // A name search reads the current public names (agent_public_cards, migration 280) through
      // their trigram index: the newest `limit` rows the name finds, the newest `limit` each exact
      // reading finds, then the page of all. A former or private name is not in that table. The
      // backfill is ready here (read above; it never turns back).
      sql = `WITH l AS (
          (SELECT ${COLUMNS}, FALSE AS id_hit ${FROM}
            JOIN agent_public_cards c ON c.agent_id = i.agent_id
            WHERE ${where.join(' AND ')} AND c.name ILIKE ${p(query.name)} ${order})
          ${exactRows ? `UNION ALL ${exactRows}` : ''}),
        u AS (SELECT DISTINCT ON (l.agent_id) l.* FROM l ORDER BY l.agent_id, l.id_hit DESC)
        SELECT u.*, c.name FROM u LEFT JOIN agent_public_cards c ON c.agent_id = u.agent_id
        ORDER BY u.base_id::numeric DESC, u.agent_id DESC LIMIT ${limit}`;
    } else {
      // Without a name reading: the exact readings alone, the page first (one agent may be found
      // by more than one), then the current public names of only those rows (publicManifestsOf,
      // either state of the backfill).
      sql = `WITH u AS (SELECT DISTINCT ON (b.agent_id) b.* FROM (${exactRows}) b ORDER BY b.agent_id),
        l AS MATERIALIZED (
          SELECT u.* FROM u ORDER BY u.base_id::numeric DESC, u.agent_id DESC LIMIT ${limit}),
        p AS (${publicManifestsOf('SELECT agent_id FROM l')})
        SELECT l.*, p.name FROM l LEFT JOIN p ON p.agent_id = l.agent_id
        ORDER BY l.base_id::numeric DESC, l.agent_id DESC LIMIT ${limit}`;
    }
    const { rows } = await db.query<Row>(sql, params);
    return { ...pageOf(rows), notice };
  }

  function pageOf(rows: Row[]) {
    const page = rows.slice(0, ON_BASE_PAGE_SIZE);
    return {
      items: page.map((row) => ({
        row: rowOf(row),
        recorded: recordedOf(row),
        agentWallet: getAddress(row.agent_wallet),
      })),
      nextBefore: rows.length > ON_BASE_PAGE_SIZE ? page[page.length - 1].base_id : null,
      /** True while names may be missing from this page (see list); absent when it is complete. */
      incomplete: undefined as true | undefined,
      /** Set when the text was too short to be a name and only its exact readings were read. */
      notice: undefined as 'name-min' | undefined,
    };
  }

  /** One listed agent's passport by base id; null when it is not listed. */
  async function passport(
    baseId: string,
  ): Promise<{ passport: OnBasePassport; recorded: RecordedOwner } | null> {
    const { rows } = await db.query<Row>(
      `SELECT l.*, p.name FROM (
         SELECT ${COLUMNS} ${FROM} WHERE ${LISTED} AND ${BASE_ID} = $4::numeric
         ORDER BY (i.state = 'confirmed') DESC, i.agent_id LIMIT 1) l
       ${PUBLIC_NAME}`,
      [options.chainId, registry, origin, baseId],
    );
    const row = rows[0];
    if (!row) return null;
    const base = rowOf(row);
    const passport: OnBasePassport = {
      ...base,
      registry,
      // Central City's record of the agent's own wallet; owner is what Base says holds the id.
      agentWallet: getAddress(row.agent_wallet),
      mintAccount: getAddress(row.mint_account),
      ...(row.mint_tx ? { registrationTx: row.mint_tx } : {}),
      registeredAt: Number(row.seen_at),
      final: row.final
        ? {
            block: blockOf(row.handover_block ?? row.registration_block),
            // A confirmed row is never written again: updated_at is when it was confirmed.
            at: Number(row.updated_at),
          }
        : null,
      // Read from Base by the routes (head.ts); until then, not read.
      reputation: {
        readAtBlock: null,
        readAt: null,
        count: 0,
        entries: [],
        score: null,
        scoredBy: [],
      },
    };
    return { passport, recorded: recordedOf(row) };
  }

  /**
   * The listed agents among these addresses, by an agent's wallet or its registration smart
   * account: lower-case address -> its Base ID and public display name ('' while its card is not
   * public). An address of anything else is not in the map.
   */
  async function listedByAddress(
    addresses: readonly string[],
  ): Promise<Map<string, { name: string; baseId: string }>> {
    const listed = new Map<string, { name: string; baseId: string }>();
    if (addresses.length === 0) return listed;
    // The matching wallets first, each side through an index production has: lower(address)
    // through base_wallets_address_lower, the spender as stored (checksummed or lower case, so
    // both forms are asked for) through base_wallets_spender (spender_address, chain_id); then only
    // their identities: matching lower(spender_address)
    // through a VALUES lateral after the join could not use an index and walked every listed
    // identity for an agent with many raters (24 Oct 2026: passports of rated agents > 60 s).
    const { rows } = await db.query<{ address: string; base_id: string; name: string | null }>(
      `WITH hit AS (
         SELECT w.agent_id, lower(w.address) AS address FROM base_wallets w
          WHERE w.chain_id = $1 AND lower(w.address) = ANY($4::text[])
         UNION
         SELECT w.agent_id, lower(w.spender_address) FROM base_wallets w
          WHERE w.spender_address = ANY($5::text[]) AND w.chain_id = $1)
       , l AS (
         SELECT DISTINCT ON (hit.address) hit.address, i.agent_id, ${BASE_ID}::text AS base_id
         FROM hit
         JOIN base_identities i ON i.agent_id = hit.agent_id AND i.chain_id = $1
         JOIN base_wallets w ON w.agent_id = i.agent_id AND w.chain_id = i.chain_id
         JOIN base_short_ids s ON s.agent_id = i.agent_id
         WHERE ${LISTED}
         ORDER BY hit.address, (i.state = 'confirmed') DESC, i.agent_id),
       p AS (${publicManifestsOf('SELECT agent_id FROM l')})
       SELECT l.address, l.base_id, p.name FROM l LEFT JOIN p ON p.agent_id = l.agent_id`,
      [
        options.chainId,
        registry,
        origin,
        [...new Set(addresses.map((a) => a.toLowerCase()))],
        spenderForms(addresses),
      ],
    );
    for (const row of rows) listed.set(row.address, { name: row.name ?? '', baseId: row.base_id });
    return listed;
  }

  /**
   * The rater wallets among these addresses (shared/base/rating-score.ts): the own wallet of a
   * listed agent with a FINAL Base ID (never a finalizing one, never a registration smart
   * account). Lower case; an address of anything else is not in the set.
   *
   * `rated`: the rated agent's own wallet. A wallet with the same owner key as the rated wallet is
   * never its rater (CCA-144): the rating route refuses a person's own agents, and a rating sent
   * directly on Base between two wallets of one owner key does not count either. Only the owner
   * key is compared, which Base already shows (CCA-143): leaving a rater out reveals no link
   * Central City's own records would add.
   */
  async function raterWallets(
    addresses: readonly string[],
    rated: string | null = null,
  ): Promise<Set<string>> {
    if (addresses.length === 0) return new Set();
    const { rows } = await db.query<{ address: string }>(
      `SELECT DISTINCT lower(w.address) AS address ${FROM}
       WHERE ${LISTED} AND i.state = 'confirmed' AND lower(w.address) = ANY($4::text[])
         AND NOT EXISTS (SELECT 1 FROM base_wallets r
           WHERE r.chain_id = $1 AND lower(r.address) = $5::text
             AND lower(r.owner_address) = lower(w.owner_address))`,
      [
        options.chainId,
        registry,
        origin,
        [...new Set(addresses.map((a) => a.toLowerCase()))],
        rated ? rated.toLowerCase() : null,
      ],
    );
    return new Set(rows.map((row) => row.address));
  }

  /**
   * The wallets that rated this Base ID through Central City (base_wallet_withdrawals kind 'rate',
   * its operation final on Base and not reverted; listScores' rule), lower case, at most `limit`,
   * the most recent raters first. The passport's feedback read asks these of Base when the
   * registry's own client list cannot be read (head.ts); raterWallets still decides who counts.
   */
  async function recordedRaters(baseId: string, limit: number): Promise<string[]> {
    const { rows } = await db.query<{ address: string }>(
      `SELECT lower(rw.address) AS address
       FROM base_wallet_withdrawals r
       JOIN base_chain_ops o
         ON o.idempotency_key = r.chain_op_key AND o.kind = 'rate' AND o.chain_id = r.chain_id
           AND o.status = 'final' AND o.error_code IS DISTINCT FROM 'USEROP_REVERTED'
       JOIN base_wallets rw ON rw.wallet_id = r.wallet_id
       WHERE r.kind = 'rate' AND r.chain_id = $1 AND r.rated_base_id = $2::numeric
       GROUP BY lower(rw.address)
       ORDER BY max(o.block_number) DESC NULLS LAST, lower(rw.address)
       LIMIT $3`,
      [options.chainId, baseId, limit],
    );
    return rows.map((row) => row.address);
  }

  /**
   * The ratings the list's score counts, for a page of agents in ONE query (never one per row):
   * Base ID -> the latest counted rating of each rater wallet, for shared/base/rating-score.ts
   * averageOf. Central City's own records only, no chain read: a rating (base_wallet_withdrawals
   * kind 'rate') counts when
   *
   *   - its own operation (base_chain_ops, its chain_op_key) is a 'rate' on this chain that is
   *     FINAL on Base and did not revert: the finality the rest of the explorer lists by;
   *   - it rates this Base ID on this chain;
   *   - its wallet is a rater (raterWallets: the own wallet of a listed agent with a final Base
   *     ID), never the rated agent's own wallet `agentWallet`.
   *
   * Latest is the one in the highest block (the registry counts each client's feedback in the
   * order it lands), then the highest nonce. Its stars are rating_value / 20 (the table allows
   * only 20 to 100). A Base ID nobody counts for is not in the map.
   */
  async function listScores(
    agents: readonly { baseId: string; agentWallet: string }[],
  ): Promise<Map<string, CountedRating[]>> {
    const scores = new Map<string, CountedRating[]>();
    if (agents.length === 0) return scores;
    const { rows } = await db.query<{
      base_id: string;
      rater: string;
      rating_value: number;
    }>(
      `SELECT DISTINCT ON (r.rated_base_id, lower(rw.address))
         r.rated_base_id::text AS base_id, lower(rw.address) AS rater, r.rating_value
       FROM unnest($4::numeric[], $5::text[]) AS t(base_id, wallet)
       JOIN base_wallet_withdrawals r
         ON r.kind = 'rate' AND r.chain_id = $1 AND r.rated_base_id = t.base_id
       JOIN base_chain_ops o
         ON o.idempotency_key = r.chain_op_key AND o.kind = 'rate' AND o.chain_id = r.chain_id
           AND o.status = 'final' AND o.error_code IS DISTINCT FROM 'USEROP_REVERTED'
       JOIN base_wallets rw ON rw.wallet_id = r.wallet_id
       WHERE lower(rw.address) <> t.wallet
         AND EXISTS (SELECT 1 ${FROM} WHERE ${LISTED} AND i.state = 'confirmed'
           AND lower(w.address) = lower(rw.address))
       ORDER BY r.rated_base_id, lower(rw.address), o.block_number DESC NULLS LAST,
         r.nonce DESC, r.withdrawal_id DESC`,
      [
        options.chainId,
        registry,
        origin,
        agents.map((agent) => agent.baseId),
        agents.map((agent) => agent.agentWallet.toLowerCase()),
      ],
    );
    for (const row of rows) {
      // The passport's own check of a rating's value (the table already allows only these).
      const stars = starsOf({
        client: row.rater,
        index: 0n,
        value: BigInt(row.rating_value),
        decimals: RATING_DECIMALS,
        tag1: RATING_TAG,
      });
      if (stars === null) continue;
      const counted = scores.get(row.base_id) ?? [];
      // The registry's index is not in the records; averageOf counts only the stars.
      counted.push({ client: row.rater, index: 0n, stars });
      scores.set(row.base_id, counted);
    }
    return scores;
  }

  /**
   * The totals, and the newest block in the stored evidence with the time it was recorded (when
   * the server read that block from Base).
   */
  async function totals(now: number) {
    const { rows } = await db.query<{
      on_base: string;
      finalizing: string;
      new24h: string;
      newest_block: string | null;
      newest_at: string | null;
    }>(
      `WITH listed AS (
         SELECT (i.state = 'confirmed') AS final, i.mint_seen_at AS seen,
                GREATEST(i.mint_block, i.handover_block) AS block, i.updated_at
         ${FROM} WHERE ${LISTED}),
       newest AS (
         SELECT block, updated_at FROM listed WHERE block IS NOT NULL
         ORDER BY updated_at DESC, block DESC LIMIT 1)
       SELECT count(*)::text AS on_base,
              count(*) FILTER (WHERE NOT final)::text AS finalizing,
              count(*) FILTER (WHERE seen >= $4::bigint)::text AS new24h,
              (SELECT block::text FROM newest) AS newest_block,
              (SELECT updated_at::text FROM newest) AS newest_at
       FROM listed`,
      [options.chainId, registry, origin, now - 24 * 60 * 60_000],
    );
    const row = rows[0];
    return {
      onBase: Number(row?.on_base ?? 0),
      finalizingNow: Number(row?.finalizing ?? 0),
      new24h: Number(row?.new24h ?? 0),
      recorded:
        row?.newest_block && row.newest_at
          ? { block: Number(row.newest_block), at: Number(row.newest_at) }
          : null,
    };
  }

  /** RATED_AGENTS_SQL on this chain: the number of rated agents. */
  async function ratedAgents(): Promise<number> {
    const { rows } = await db.query<{ rated: string }>(RATED_AGENTS_SQL, [options.chainId]);
    return Number(rows[0]?.rated ?? 0);
  }

  /**
   * What a listed agent has been paid (Operation Directory D4): its passport's totals, by short id.
   * Counted from Central City's own payment records, never from Base directly: a payment counts
   * once it is FINAL (final_at is set in the transaction that records its withdrawal final), in
   * USDC, sent to this agent's own wallet as a Central City payment from another agent's wallet.
   * Public numbers never depend on who owns the payer: an owner filter would add Central City's
   * own account records to what these counts reveal. That keeps the counts from adding a link; it
   * does not hide which agents share an owner, which their deployed wallets' shared owner key
   * already shows on Base (CCA-143). Every such payment is
   * a real, final USDC transfer with its fee, visible on Base, and a wallet can never pay itself
   * (the schema's recipient <> sender check, repeated here). Totals only: no payers, no notes.
   * null when the short id is not a listed agent (the explorer's rule).
   */
  async function earnings(
    short: string,
  ): Promise<{ paidTimes: number; totalRaw: bigint; lastPaidAt: number | null } | null> {
    const { rows } = await db.query<{
      agent_id: string;
      paid: string;
      total: string | null;
      last_at: string | null;
    }>(
      `SELECT l.agent_id, e.paid::text AS paid, e.total::text AS total, e.last_at::text AS last_at
       FROM (SELECT i.agent_id, w.wallet_id, w.address ${FROM}
             WHERE ${LISTED} AND s.short_id = $4
             ORDER BY (i.state = 'confirmed') DESC, i.agent_id LIMIT 1) l
       CROSS JOIN LATERAL (
         SELECT count(*) AS paid, sum(x.amount_raw) AS total, max(pm.final_at) AS last_at
         FROM base_wallet_payments pm
         JOIN base_wallet_withdrawals x
           ON x.withdrawal_id = pm.withdrawal_id AND x.token = 'USDC'
             AND x.wallet_id = pm.sender_wallet_id AND lower(x.destination) = lower(l.address)
         WHERE pm.recipient_agent_id = l.agent_id AND pm.recipient_wallet_id = l.wallet_id
           AND pm.chain_id = $1 AND pm.final_at IS NOT NULL
           AND pm.sender_wallet_id <> l.wallet_id) e`,
      [options.chainId, registry, origin, short],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      paidTimes: Number(row.paid),
      totalRaw: BigInt(row.total ?? '0'),
      lastPaidAt: row.last_at === null ? null : Number(row.last_at),
    };
  }

  /**
   * What a listed agent paid for services (the passport's "Paid for services"), by short id, under
   * the listing rule of earnings above: null exactly when earnings is null. Totals of its paid
   * service calls (Feed pay, server/feed/pay), in ONE aggregate over the agent's own wallet:
   *
   *   - a call counts once its payment is confirmed on Base: payment_state 'settled' with its
   *     transaction (tx_hash), whether or not the service then answered (paid_no_result counts);
   *   - only calls paid from this agent's own wallet on this chain: the call's wallet_id, the link
   *     the engine stores when it reserves a call for an agent (its spender is that wallet's own);
   *   - the total is what the calls paid: the price. For a fee-on-top call (pay_kind 'x402') that is
   *     amount_raw; for a fee-included call ('included', a service sold by a Central City agent)
   *     amount_raw is the seller's 90% and the price is amount_raw + fee_raw;
   *   - its Central City fee counts only once the fee's own transaction is final: fee on top,
   *     fee_state 'charged' (set only from a final operation that did not revert) with its
   *     transaction; fee included, the fee moves in the payment's own transaction, where
   *     fee_state is 'charged' at inclusion, so it counts once that payment is final
   *     (pay_final_at). An included fee is part of the total as well.
   *
   * The settled calls of one wallet come from the partial index feed_pay_calls_paid (migration
   * 120). Totals only: never inputs, results, errors, call ids, hosts, transactions or who started
   * a call.
   */
  async function servicePayments(short: string): Promise<{
    paidCalls: number;
    totalRaw: bigint;
    feeRaw: bigint;
    lastPaidAt: number | null;
    sponsoredFirstPurchase: { priceRaw: bigint; paidAt: number } | null;
  } | null> {
    const { rows } = await db.query<{
      agent_id: string;
      paid: string;
      total: string | null;
      fee: string | null;
      last_at: string | null;
    }>(
      `SELECT l.agent_id, x.paid::text AS paid, x.total::text AS total, x.fee::text AS fee,
              x.last_at::text AS last_at
       FROM (SELECT i.agent_id, w.wallet_id ${FROM}
             WHERE ${LISTED} AND s.short_id = $4
             ORDER BY (i.state = 'confirmed') DESC, i.agent_id LIMIT 1) l
       CROSS JOIN LATERAL (
         SELECT count(*) AS paid,
                sum(c.amount_raw + CASE WHEN c.pay_kind = 'included' THEN c.fee_raw ELSE 0 END)
                  AS total,
                sum(c.fee_raw) FILTER (WHERE c.fee_state = 'charged' AND c.fee_tx_hash IS NOT NULL
                  AND (c.pay_kind <> 'included' OR c.pay_final_at IS NOT NULL)) AS fee,
                max(c.settled_at) AS last_at
         FROM feed_pay_calls c
         WHERE c.wallet_id = l.wallet_id AND c.payment_state = 'settled' AND c.tx_hash IS NOT NULL
           AND c.agent_id = l.agent_id AND c.chain_id = $1) x`,
      [options.chainId, registry, origin, short],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      paidCalls: Number(row.paid),
      totalRaw: BigInt(row.total ?? '0'),
      feeRaw: BigInt(row.fee ?? '0'),
      lastPaidAt: row.last_at === null ? null : Number(row.last_at),
      sponsoredFirstPurchase: await sponsoredFirstPurchase(row.agent_id),
    };
  }

  /**
   * The agent's first purchase paid by Central City (server/feed/pay/sponsored.ts), once paid on
   * Base; by its agent index. A database without that table (an older schema) answers null.
   */
  async function sponsoredFirstPurchase(
    agentId: string,
  ): Promise<{ priceRaw: bigint; paidAt: number } | null> {
    const { rows } = await db
      .query<{ gross: string; at: string }>(
        `SELECT gross_raw::text AS gross, updated_at::text AS at FROM feed_pay_sponsored_calls
         WHERE agent_id = $1 AND state IN ('paid','delivered','paid_no_result')
         ORDER BY updated_at LIMIT 1`,
        [agentId],
      )
      .catch(() => ({ rows: [] as { gross: string; at: string }[] }));
    const row = rows[0];
    return row ? { priceRaw: BigInt(row.gross), paidAt: Number(row.at) } : null;
  }

  /**
   * The passport's paidTimes (earnings above, same rule) for many agents in ONE query: agent id ->
   * final Central City USDC payments to its own wallet from other agents' wallets, whoever owns
   * them. Agents never paid are not in the map.
   */
  async function paidCounts(agentIds: readonly string[]): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    if (agentIds.length === 0) return counts;
    const { rows } = await db.query<{ agent_id: string; paid: string }>(
      `SELECT pm.recipient_agent_id AS agent_id, count(*)::text AS paid
       FROM base_wallet_payments pm
       JOIN base_wallets rw
         ON rw.wallet_id = pm.recipient_wallet_id AND rw.agent_id = pm.recipient_agent_id
       JOIN base_wallet_withdrawals x
         ON x.withdrawal_id = pm.withdrawal_id AND x.token = 'USDC'
           AND x.wallet_id = pm.sender_wallet_id AND lower(x.destination) = lower(rw.address)
       WHERE pm.recipient_agent_id = ANY($2::text[]) AND pm.chain_id = $1
         AND pm.final_at IS NOT NULL AND pm.sender_wallet_id <> rw.wallet_id
       GROUP BY pm.recipient_agent_id`,
      [options.chainId, [...new Set(agentIds)]],
    );
    for (const row of rows) counts.set(row.agent_id, Number(row.paid));
    return counts;
  }

  return {
    list,
    passport,
    paidCounts,
    listedByAddress,
    raterWallets,
    recordedRaters,
    listScores,
    totals,
    ratedAgents,
    earnings,
    servicePayments,
    registry,
  };
}

export type OnBaseStore = ReturnType<typeof createOnBaseStore>;
