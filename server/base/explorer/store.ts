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
 * workspace ids.
 */
import { getAddress } from 'viem';
import type { Database } from '../../database.js';
import { BASE_NETWORKS, type BaseChainId } from '../../../shared/base/chains.js';
import {
  AGENT_URI_ORIGIN,
  ON_BASE_PAGE_SIZE,
  type OnBasePassport,
  type OnBaseRow,
} from '../../../shared/base/on-base.js';
import {
  RATING_DECIMALS,
  RATING_TAG,
  starsOf,
  type CountedRating,
} from '../../../shared/base/rating-score.js';

type Queryable = Pick<Database, 'query'>;

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

/** The rows the explorer may list (see the header). $1 chain id, $2 registry, $3 URI origin. */
export const LISTED = `i.chain_id = $1 AND lower(i.registry_address) = lower($2)
  AND i.agent_card_uri = $3 || '/a/' || s.short_id
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
 * that has an `agent_id` column.
 */
const PUBLIC_REVISION = `FROM workspaces ws
  CROSS JOIN LATERAL jsonb_array_elements(ws.data->'agents') a
  JOIN agent_manifests m ON m.agent_id = a->>'id' AND m.revision = (a->>'revision')::int
  WHERE ws.operator_id = (SELECT operator_id FROM agent_manifests WHERE agent_id = l.agent_id LIMIT 1)
    AND a->>'id' = l.agent_id AND a->>'revokedAt' IS NULL
    AND m.manifest->'spec'->>'visibility' = 'public'
  LIMIT 1`;

/**
 * The current public display name (PUBLIC_REVISION's rule); anything else has no name here.
 * Joined onto a subquery aliased `l` that has an `agent_id` column (pay/store.ts too).
 */
export const PUBLIC_NAME = `LEFT JOIN LATERAL (
  SELECT NULLIF(btrim(m.manifest->'metadata'->>'displayName'), '') AS name
  ${PUBLIC_REVISION}
) p ON true`;

/**
 * The whole current public manifest as `pm.manifest` (PUBLIC_REVISION's rule), NULL while the
 * agent is private, revoked or unknown. The directory's cards (server/directory/store.ts).
 */
export const PUBLIC_MANIFEST = `LEFT JOIN LATERAL (
  SELECT m.manifest
  ${PUBLIC_REVISION}
) pm ON true`;

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

/** What the search text can mean; every reading that fits is tried (OR). */
export interface ParsedQuery {
  baseId: string | null;
  shortId: string | null;
  address: string | null;
  txHash: string | null;
  /** A LIKE pattern for the public name (wildcards escaped), or null. */
  name: string | null;
}

export function parseQuery(text: string): ParsedQuery {
  // Control characters become spaces: Postgres refuses a NUL in the name pattern (a 500).
  const q = text.replace(/\p{Cc}/gu, ' ').trim();
  return {
    baseId: /^#?(0|[1-9][0-9]{0,77})$/.exec(q)?.[1] ?? null,
    // A short id, alone or as a passport number (CC-<short id>); short ids are case-sensitive.
    shortId: /^(?:[Cc][Cc]-)?([0-9A-Za-z]{6})$/.exec(q)?.[1] ?? null,
    address: /^0x[0-9a-fA-F]{40}$/.test(q) ? q.toLowerCase() : null,
    txHash: /^0x[0-9a-fA-F]{64}$/.test(q) ? q.toLowerCase() : null,
    name:
      q.length >= 2 && !/^0x[0-9a-f]*$/i.test(q)
        ? `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
        : null,
  };
}

export interface OnBaseStoreOptions {
  chainId: BaseChainId;
  /** The agent URI origin (tests); defaults to https://centralcity.ai. */
  uriOrigin?: string;
}

export function createOnBaseStore(db: Queryable, options: OnBaseStoreOptions) {
  const network = BASE_NETWORKS[options.chainId];
  const registry = network.contracts.identityRegistry ?? '';
  const origin = options.uriOrigin ?? AGENT_URI_ORIGIN;

  /** Newest first, ON_BASE_PAGE_SIZE per page, older than `before` (a base id) when given. */
  async function list(input: { before?: string; q?: string }) {
    const params: unknown[] = [options.chainId, registry, origin];
    const p = (value: unknown) => {
      params.push(value);
      return `$${params.length}`;
    };
    const where = [LISTED];
    if (input.before !== undefined) where.push(`${BASE_ID} < ${p(input.before)}::numeric`);
    const query = input.q === undefined ? null : parseQuery(input.q);
    const hits: string[] = [];
    if (query?.baseId) hits.push(`${BASE_ID} = ${p(query.baseId)}::numeric`);
    if (query?.shortId) hits.push(`s.short_id = ${p(query.shortId)}`);
    // The agent wallet (owner) only: the owner's own wallet is not published, so not searchable.
    if (query?.address) hits.push(`lower(w.address) = ${p(query.address)}`);
    if (query?.txHash) {
      const hash = p(query.txHash);
      hits.push(
        `lower(${MINT_TX}) = ${hash}`,
        `lower(i.tx_hash) = ${hash}`,
        `lower(i.handover_tx_hash) = ${hash}`,
      );
    }
    const limit = ON_BASE_PAGE_SIZE + 1;
    let sql: string;
    if (!query) {
      // No search: the page first, then names for its rows only.
      sql = `SELECT l.*, p.name FROM (
          SELECT ${COLUMNS} ${FROM} WHERE ${where.join(' AND ')}
          ORDER BY ${BASE_ID} DESC, i.agent_id DESC LIMIT ${limit}) l
        ${PUBLIC_NAME}
        ORDER BY l.base_id::numeric DESC, l.agent_id DESC`;
    } else {
      const idHit = hits.length ? `(${hits.join(' OR ')})` : 'FALSE';
      // A name search narrows on any revision's name first (an index probe per agent), then keeps
      // only rows whose CURRENT public name matches, so a former or private name never matches.
      const name = query.name ? p(query.name) : null;
      const candidate = name
        ? `(${idHit} OR EXISTS (SELECT 1 FROM agent_manifests mm WHERE mm.agent_id = i.agent_id
             AND mm.manifest->'metadata'->>'displayName' ILIKE ${name}))`
        : idHit;
      sql = `SELECT l.*, p.name FROM (
          SELECT ${COLUMNS}, ${idHit} AS id_hit ${FROM}
          WHERE ${where.join(' AND ')} AND ${candidate}) l
        ${PUBLIC_NAME}
        WHERE l.id_hit${name ? ` OR p.name ILIKE ${name}` : ''}
        ORDER BY l.base_id::numeric DESC, l.agent_id DESC LIMIT ${limit}`;
    }
    const { rows } = await db.query<Row>(sql, params);
    const page = rows.slice(0, ON_BASE_PAGE_SIZE);
    return {
      items: page.map((row) => ({
        row: rowOf(row),
        recorded: recordedOf(row),
        agentWallet: getAddress(row.agent_wallet),
      })),
      nextBefore: rows.length > ON_BASE_PAGE_SIZE ? page[page.length - 1].base_id : null,
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
    const { rows } = await db.query<{ address: string; base_id: string; name: string | null }>(
      `SELECT l.address, l.base_id, p.name FROM (
         SELECT DISTINCT ON (x.address) x.address, i.agent_id, ${BASE_ID}::text AS base_id
         ${FROM}
         CROSS JOIN LATERAL (VALUES (lower(w.address)), (lower(w.spender_address))) x(address)
         WHERE ${LISTED} AND x.address = ANY($4::text[])
         ORDER BY x.address, (i.state = 'confirmed') DESC, i.agent_id) l
       ${PUBLIC_NAME}`,
      [options.chainId, registry, origin, [...new Set(addresses.map((a) => a.toLowerCase()))]],
    );
    for (const row of rows) listed.set(row.address, { name: row.name ?? '', baseId: row.base_id });
    return listed;
  }

  /**
   * The rater wallets among these addresses (shared/base/rating-score.ts): the own wallet of a
   * listed agent with a FINAL Base ID (never a finalizing one, never a registration smart
   * account). Lower case; an address of anything else is not in the set.
   */
  async function raterWallets(addresses: readonly string[]): Promise<Set<string>> {
    if (addresses.length === 0) return new Set();
    const { rows } = await db.query<{ address: string }>(
      `SELECT DISTINCT lower(w.address) AS address ${FROM}
       WHERE ${LISTED} AND i.state = 'confirmed' AND lower(w.address) = ANY($4::text[])`,
      [options.chainId, registry, origin, [...new Set(addresses.map((a) => a.toLowerCase()))]],
    );
    return new Set(rows.map((row) => row.address));
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
   * Public numbers never depend on who owns the payer: an owner filter would let anyone compare
   * these counts with Base transfers and learn which agents share an owner. Every such payment is
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
    };
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
    listScores,
    totals,
    ratedAgents,
    earnings,
    servicePayments,
    registry,
  };
}

export type OnBaseStore = ReturnType<typeof createOnBaseStore>;
