/*
 * Feed "Searched for" (shared/feed.ts): requests anyone may post, signed in or not. No money
 * moves; a budget is information only.
 *
 * Abuse controls, in the order a POST meets them:
 *   1. the body is parsed and size-checked (routes.ts), the Feed's emergency off (CITY_FEED)
 *      checked; a signed-out poster's idempotency key must be high-entropy (a replay hands back the manage token);
 *   2. a retry with the same idempotency key from the same poster answers the same request
 *      (200) before anything is charged (asked again under the poster's lock, so a double submit
 *      answers the same request too);
 *   3. the 'posting' database switch (feed_flags, set by operators through review.ts) can pause
 *      new posts without a redeploy (503 posting_paused, retryable);
 *   4. rate limits are charged BEFORE any content check, so probing the filters costs budget:
 *      per source address (hour and day), site, network and region and site-wide (signed out);
 *      per workspace, per source address (hour and day), site, network and region in buckets of
 *      their own at ten times the signed-out caps (an address, site or network at most a tenth of
 *      the accounts' budget, a region a quarter), and a separate site-wide budget (signed in), so
 *      a signed-out flood never stops accounts posting and free accounts on a few networks cannot
 *      spend the accounts' budget;
 *   5. text policy (policy.ts): 400 for what the poster can fix;
 *   6. held for review (stored, never listed, answered with status 'held'): the honeypot, an
 *      operator's source block, risky text or links (policy.ts), an agent name with a key, a
 *      recovery phrase or contact details (withheld; one that is only reserved or address-shaped
 *      is withheld, not held), the same title from three or more sites within 24 hours
 *      (honeypot and blocked copies not counted);
 *   7. duplicates (copies on the Feed only: open, visible and unexpired, so a hidden, held,
 *      closed or expired copy never blocks its poster): the same text (anyone), the same title
 *      from the same poster posted within 7 days;
 *   8. caps on open requests per poster and site-wide, checked with the insert under a
 *      per-poster lock.
 *
 * Reports: one per request and reporter address, charged per address, site, network, region and
 * site-wide; reports from reportsToHide distinct networks (IPv4 /16, IPv6 /48) hide the request
 * until an operator looks (10 once an operator restored it), so one person with many sites of
 * one network cannot hide anything. A report always answers the same, whatever it changed.
 *
 * Operators review held and hidden requests (review.ts): a release lists the request again, a
 * removal takes it off for good. Becoming held or hidden logs 'feed.request_held' or
 * 'feed.request_hidden' with the request id (the event sink alerts operators).
 *
 * Upkeep (sweep) runs when the database says it is due (at most every 10 minutes across all
 * instances), from posts and reads: it expires requests, erasing the reply handle, and purges.
 *
 * The client address is never stored: only keyed HMACs of its scopes (the rate-limit key,
 * CITY_RATE_LIMIT_KEY). The reply handle is public and erased at close and expiry. The public
 * name: the anonymous poster's own, an agent's name, none for an account (never a sign-in name).
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  FEED_LIMITS,
  FEED_NETWORK,
  rawToUsdc,
  usdcToRaw,
  type FeedErrorCode,
  type FeedMyRequest,
  type FeedMyRequests,
  type FeedPosterKind,
  type FeedReportReason,
  type FeedRequestPage,
  type FeedRequestQuery,
  type FeedRequestStatus,
  type PostedFeedRequest,
  type PublicFeedRequest,
} from '../../shared/feed.js';
import { highEntropyKey, unclaimedScopeId } from '../autonomy/index.js';
import type { Database, Transaction } from '../database.js';
import { clientAddressPrefixes } from '../rate-limit.js';
import {
  checkDisplayName,
  checkReply,
  checkRequestText,
  cleanLine,
  cleanText,
  codePoints,
  contentKey,
  displayNameHolds,
  foldKey,
  lettersIn,
} from './policy.js';
import { FEED_SEARCH_BUSY_RETRY_AFTER_S, FeedBusyError } from './busy.js';
import { FEED_REQUEST_TEXT } from './schema.js';
import { endWithResponses as endRequests, responsesTableCheck } from './respond-schema.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** The same title from the same poster waits this long after a close before it posts again. */
const REPOST_AFTER_CLOSE_MS = HOUR;

/** Every cap is a default an operator may change with its CITY_LIMIT_FEED_* variable. */
export interface FeedCaps {
  postsPerSourceHour: number;
  postsPerSourceDay: number;
  postsPerSiteHour: number;
  postsPerNetworkHour: number;
  postsPerRegionHour: number;
  postsGlobalHour: number;
  postsPerOwnerHour: number;
  postsPerOwnerDay: number;
  postsOwnersGlobalHour: number;
  openPerSource: number;
  openPerOwner: number;
  openGlobal: number;
  reportsPerSourceHour: number;
  reportsPerSiteHour: number;
  reportsPerNetworkHour: number;
  reportsPerRegionHour: number;
  reportsGlobalHour: number;
  managePerSourceHour: number;
  readsPerMinute: number;
}

export const FEED_CAPS_DEFAULT: Readonly<FeedCaps> = Object.freeze({
  postsPerSourceHour: FEED_LIMITS.postsPerHour,
  postsPerSourceDay: FEED_LIMITS.postsPerDay,
  postsPerSiteHour: 20,
  postsPerNetworkHour: 60,
  postsPerRegionHour: 300,
  postsGlobalHour: 600,
  postsPerOwnerHour: 30,
  postsPerOwnerDay: 100,
  postsOwnersGlobalHour: 600,
  openPerSource: 10,
  openPerOwner: 50,
  openGlobal: 50_000,
  reportsPerSourceHour: 20,
  reportsPerSiteHour: 60,
  reportsPerNetworkHour: 20,
  reportsPerRegionHour: 100,
  reportsGlobalHour: 2_000,
  managePerSourceHour: 30,
  readsPerMinute: 60,
});

/** The signed-in per-address floor sits this far above the signed-out one (shared cloud egress). */
export const SIGNED_IN_ADDRESS_FACTOR = 10;

/**
 * The most of the accounts' site-wide budget one signed-in address scope may spend in an hour, as
 * a fraction: a tenth for an address, a site or a network, a quarter for a region. Spending all of
 * it takes ten networks in four regions.
 */
export const SIGNED_IN_SHARE = { source: 10, site: 10, network: 10, region: 4 } as const;

/**
 * A signed-in address scope's hourly cap: SIGNED_IN_ADDRESS_FACTOR times the signed-out one, and
 * never more than its share of the accounts' site-wide budget (SIGNED_IN_SHARE).
 */
export const signedInScopeCap =
  (caps: FeedCaps) => (cap: number, scope: keyof typeof SIGNED_IN_SHARE) =>
    Math.min(
      cap * SIGNED_IN_ADDRESS_FACTOR,
      Math.max(1, Math.floor(caps.postsOwnersGlobalHour / SIGNED_IN_SHARE[scope])),
    );

export const FEED_CAP_ENV: Readonly<Record<keyof FeedCaps, string>> = Object.freeze(
  Object.fromEntries(
    Object.keys(FEED_CAPS_DEFAULT).map((key) => [
      key,
      `CITY_LIMIT_FEED_${key.replace(/[A-Z]/g, (char) => `_${char}`).toUpperCase()}`,
    ]),
  ) as Record<keyof FeedCaps, string>,
);

export function feedCaps(env: NodeJS.ProcessEnv = process.env): FeedCaps {
  const caps = { ...FEED_CAPS_DEFAULT };
  for (const key of Object.keys(caps) as Array<keyof FeedCaps>) {
    const raw = env[FEED_CAP_ENV[key]];
    if (raw === undefined || raw === '') continue;
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < 1)
      throw new Error(`${FEED_CAP_ENV[key]} must be a positive integer.`);
    caps[key] = value;
  }
  return caps;
}

/**
 * A refusal the routes answer as {error, code, retryable}; code null answers {error} only (the
 * shared 429 shape, and 503 without the hashing secret: the contract has no code for it).
 */
export class FeedRequestError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: FeedErrorCode | null,
    message: string,
    /** True only where asking again later can succeed unchanged (a paused Feed). */
    readonly retryable = false,
  ) {
    super(message);
  }
}

/** Who is posting, decided by the routes from the session, never from the body. */
export type FeedCaller =
  | { kind: 'anonymous'; address: string }
  | {
      kind: 'signed_in';
      address: string;
      /** The workspace the request acts in (owns the request; closes it with its session). */
      ownerId: string;
      /** Posting as one of the workspace's agents (the person's sign-in name never comes here). */
      agent: { id: string; name: string } | null;
    };

/** NewFeedRequest after the routes' schema (types and raw lengths only). */
export interface FeedRequestInput {
  title: string;
  description: string;
  capabilities?: string[];
  budgetUsdc?: string | null;
  deadline?: number | null;
  reply?: string | null;
  displayName?: string | null;
  idempotencyKey: string;
  /** The honeypot field: people never see it, so anything in it marks an automated post. */
  website?: string;
}

export interface FeedRequestsDeps {
  db: Database;
  clock?: () => number;
  /** The keyed-hash secret (CITY_RATE_LIMIT_KEY, at least 32 characters). */
  secret: () => string | undefined;
  /** The shared rate limiter (server/app.ts): throws the shared 429 when over. */
  limit: (key: string, max: number, windowMs: number) => Promise<void>;
  caps?: Partial<FeedCaps>;
  log?: (event: string, fields: Record<string, unknown>) => void;
}

/** A feed_requests row as COLUMNS reads it (review.ts reads it too). */
export interface Row {
  id: string;
  state: 'open' | 'held' | 'closed' | 'expired' | 'removed';
  title: string;
  description: string;
  capabilities: string[];
  budget_raw: string | number | bigint | null;
  deadline_at: string | number | null;
  reply: string | null;
  poster_kind: FeedPosterKind;
  display_name: string | null;
  owner_id: string | null;
  source_hash: string;
  content_key: string;
  manage_hash: string;
  hidden_at: string | number | null;
  reviewed_at: string | number | null;
  created_at: string | number;
  expires_at: string | number;
  closed_at: string | number | null;
}

export const COLUMNS = `id, state, title, description, capabilities, budget_raw, deadline_at, reply,
  poster_kind, display_name, owner_id, source_hash, content_key, manage_hash, hidden_at, reviewed_at,
  created_at, expires_at, closed_at`;

/** Upkeep runs at most this often across all instances (the database decides, feed_flags). */
const SWEEP_EVERY_MS = 10 * 60_000;
/** Each instance asks the database at most this often whether upkeep is due. */
const SWEEP_ASK_MS = 60_000;
/** Full-text search gets this long (ms) before the database stops it. */
const SEARCH_TIMEOUT_MS = 1_500;
/** PostgreSQL query_canceled: what a statement past its statement_timeout answers. */
const SEARCH_TIMED_OUT = '57014';

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';
export function newRequestId(): string {
  return `req_${Array.from(randomBytes(20), (byte) => BASE32[byte & 31]).join('')}`;
}

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const num = (value: string | number | bigint | null) => (value === null ? null : Number(value));

const TAG = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
export const MANAGE_TOKEN = /^ccf_[A-Za-z0-9_-]{43}$/;
/** A list cursor as cursorOf writes it. */
export const CURSOR = /^(\d{1,16})-([a-z2-7]{20})$/;

/** ?cursor= of a page that ends at this request. */
export const cursorOf = (createdAt: number, id: string) => `${createdAt}-${id.slice(4)}`;

/** Page size of the caller's own list: bounded however far the open cap is raised. */
export const minePageSize = (caps: Pick<FeedCaps, 'openPerOwner'>) =>
  Math.min(caps.openPerOwner, FEED_LIMITS.mineOpenPageMax) + FEED_LIMITS.mineMax;

/** Reads the own-list query: only a cursor; anything else answers undefined (400). */
export function readFeedMineQuery(params: Record<string, unknown>): string | null | undefined {
  for (const key of Object.keys(params)) if (key !== 'cursor') return undefined;
  if (params.cursor === undefined || params.cursor === '') return null;
  return typeof params.cursor === 'string' && CURSOR.test(params.cursor)
    ? params.cursor
    : undefined;
}

/** Reads the list query: unknown parameters and an unreadable tag answer null (400). */
export function readFeedRequestQuery(params: Record<string, unknown>): FeedRequestQuery | null {
  for (const key of Object.keys(params)) if (!['q', 'tag', 'cursor'].includes(key)) return null;
  const q = typeof params.q === 'string' ? cleanLine(params.q) : '';
  if (params.q !== undefined && typeof params.q !== 'string') return null;
  let tag: string | null = null;
  if (params.tag !== undefined && params.tag !== '') {
    if (typeof params.tag !== 'string') return null;
    tag = params.tag.trim().toLowerCase();
    if (!TAG.test(tag)) return null;
  }
  const cursor =
    typeof params.cursor === 'string' && CURSOR.test(params.cursor) ? params.cursor : null;
  return { q: Array.from(q).slice(0, FEED_LIMITS.queryMax).join(''), tag, cursor };
}

/**
 * Prefix-matching full-text query over letters and digits only (no tsquery syntax reaches SQL).
 * A lone Latin letter or digit is dropped: that prefix matches nearly everything. A single Han,
 * kana or Hangul character stays, as in the services search: it is a whole word on its own.
 */
export function tsQuery(q: string): string | null {
  const words = (q.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
    .filter((word) => Array.from(word).length >= 2 || !/^[\p{Script=Latin}\p{N}]$/u.test(word))
    .slice(0, 8);
  return words.length ? words.map((word) => `'${word}':*`).join(' & ') : null;
}

function statusOf(row: Row, now: number): FeedRequestStatus {
  if (row.state === 'closed') return 'closed';
  if (row.state === 'expired' || (row.state === 'open' && Number(row.expires_at) <= now))
    return 'expired';
  if (row.state === 'held') return 'held';
  if (row.state !== 'open' || row.hidden_at !== null) return 'hidden';
  return 'open';
}

export function toPublic(row: Row, now: number, status = statusOf(row, now)): PublicFeedRequest {
  const raw = row.budget_raw === null ? null : String(row.budget_raw);
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    capabilities: [...row.capabilities],
    budget:
      raw === null
        ? null
        : { raw, decimals: 6, display: rawToUsdc(raw), asset: 'USDC', network: FEED_NETWORK },
    deadline: num(row.deadline_at),
    reply: row.reply,
    postedBy: { kind: row.poster_kind, displayName: row.display_name },
    status,
    createdAt: Number(row.created_at),
    expiresAt: Number(row.expires_at),
    closedAt: num(row.closed_at),
  };
}

/**
 * A request as its own poster sees it (FEED_PATHS.mine). Hidden shows as held, "in review": the
 * poster learns neither a reason nor that anyone reported it.
 */
function toMine(row: Row, now: number): FeedMyRequest {
  const found = statusOf(row, now);
  const status = found === 'hidden' ? 'held' : found;
  const request = toPublic(row, now, status);
  // Past its expiry but not swept yet: answered as the sweep will store it (no reply handle).
  if (status === 'expired' && request.closedAt === null) {
    request.closedAt = request.expiresAt;
    request.reply = null;
  }
  return { ...request, status, closable: status === 'open' || status === 'held' };
}

/** What the posting transaction did: answered a retry that committed first, or inserted. */
type Posted = { raced: Row } | { inserted: Row };

/** A unique violation of this index (the Postgres error code and the index name). */
export const unique = (error: unknown, index: string) =>
  typeof error === 'object' &&
  error !== null &&
  (error as { code?: unknown }).code === '23505' &&
  String((error as { message?: unknown }).message ?? '').includes(index);

export function createFeedRequests(deps: FeedRequestsDeps) {
  const { db } = deps;
  const clock = deps.clock ?? Date.now;
  const caps: FeedCaps = { ...FEED_CAPS_DEFAULT, ...deps.caps };
  const log = deps.log ?? (() => {});
  let sweepAskAt = 0;
  // Whether Respond's table exists (migration 108, respond-schema.ts; the whole app always has it).
  const hasResponses = responsesTableCheck();
  /**
   * `ending` (an UPDATE of feed_requests that closes or expires rows, without RETURNING) as one
   * statement that also ends those requests' responses (Respond, respond-schema.ts): the request
   * and its responses end together or not at all.
   */
  async function endWithResponses(
    q: Pick<Transaction, 'query'>,
    ending: string,
    params: unknown[],
  ): Promise<void> {
    await endRequests(
      q,
      await hasResponses(q),
      `${ending} RETURNING id, closed_at AS end_at`,
      params,
    );
  }

  function keyed() {
    const secret = deps.secret();
    // Hosted deployments always set it (invitations need it too); without it nothing is written.
    if (!secret || secret.length < 32)
      throw new FeedRequestError(503, null, 'The Feed cannot take posts right now.');
    return {
      secret,
      scopes(address: string) {
        const prefixes = clientAddressPrefixes(address);
        const id = (scope: keyof typeof prefixes) =>
          unclaimedScopeId(secret, `feed-${scope}`, prefixes[scope]);
        return {
          source: id('source'),
          site: id('site'),
          network: id('network'),
          region: id('region'),
        };
      },
    };
  }

  /** Shown once; derived so that a retry with the same idempotency key answers the same token. */
  const manageToken = (secret: string, id: string, idempotencyKey: string) =>
    `ccf_${createHmac('sha256', secret).update(`feed-manage\n${id}\n${idempotencyKey}`).digest('base64url')}`;

  const refuse = (status: number, code: FeedErrorCode, message: string): never => {
    throw new FeedRequestError(status, code, message);
  };
  const invalid = (message: string) => refuse(400, 'invalid_request', message);

  async function postingPaused(): Promise<boolean> {
    const row = (
      await db.query<{ enabled: boolean }>("SELECT enabled FROM feed_flags WHERE name='posting'")
    ).rows[0];
    return row !== undefined && !row.enabled;
  }

  /** The cleaned, checked fields of a new request (throws the refusal). */
  function prepare(input: FeedRequestInput, caller: FeedCaller, now: number) {
    const title = cleanLine(input.title);
    const titleLength = codePoints(title);
    if (titleLength < FEED_LIMITS.requestTitleMin || titleLength > FEED_LIMITS.requestTitleMax)
      invalid(
        `The title needs ${FEED_LIMITS.requestTitleMin} to ${FEED_LIMITS.requestTitleMax} characters.`,
      );
    const description = cleanText(input.description);
    if (codePoints(description) > FEED_LIMITS.requestDescriptionMax)
      invalid(`The description may have at most ${FEED_LIMITS.requestDescriptionMax} characters.`);
    const tags = [
      ...new Set((input.capabilities ?? []).map((tag) => tag.trim().toLowerCase())),
    ].filter(Boolean);
    if (tags.length > FEED_LIMITS.requestTagsMax || !tags.every((tag) => TAG.test(tag)))
      invalid(
        `Use at most ${FEED_LIMITS.requestTagsMax} tags of lowercase letters, digits and dashes.`,
      );
    let budget: string | null = null;
    if (input.budgetUsdc !== undefined && input.budgetUsdc !== null && input.budgetUsdc !== '') {
      budget = usdcToRaw(input.budgetUsdc);
      if (
        budget === null ||
        BigInt(budget) <= 0n ||
        BigInt(budget) > BigInt(usdcToRaw(FEED_LIMITS.budgetMaxUsdc)!)
      )
        invalid(
          `The budget is USDC above 0 and at most ${FEED_LIMITS.budgetMaxUsdc}, with up to 6 decimals.`,
        );
    }
    const deadline = input.deadline ?? null;
    if (
      deadline !== null &&
      (!Number.isSafeInteger(deadline) ||
        deadline < now + FEED_LIMITS.deadlineMinMs ||
        deadline > now + FEED_LIMITS.requestTtlMaxMs)
    )
      invalid('The deadline must be between one hour and 30 days from now.');
    const reply = checkReply(input.reply);
    if (!reply.ok) return invalid(reply.message);
    // The public name: the anonymous poster's own (refused when it breaks a rule), the agent's
    // (cut to length; one that breaks a rule, whole or cut, is withheld, and the request held
    // only when the name carries a key, a recovery phrase or contact details), never an
    // account's sign-in name (an account posts as its kind alone). A name without a letter or
    // digit is no name.
    let displayName: string | null = null;
    let nameHeld = false;
    if (caller.kind === 'anonymous') {
      const name = input.displayName ? cleanLine(input.displayName) : '';
      displayName = lettersIn(name) > 0 ? name : null;
      if (displayName !== null && codePoints(displayName) > FEED_LIMITS.displayNameMax)
        invalid(`The display name may have at most ${FEED_LIMITS.displayNameMax} characters.`);
    } else if (caller.agent) {
      const whole = cleanLine(caller.agent.name);
      const name = Array.from(whole).slice(0, FEED_LIMITS.displayNameMax).join('').trim();
      if (lettersIn(name) > 0) {
        if (checkDisplayName(whole) === null && checkDisplayName(name) === null) displayName = name;
        else nameHeld = displayNameHolds(whole) || displayNameHolds(name);
      } else nameHeld = lettersIn(whole) > 0 && displayNameHolds(whole);
    }
    const checked = checkRequestText({ title, description, displayName, capabilities: tags });
    if (!checked.ok) return invalid(checked.message);
    const expiresAt = Math.min(
      deadline ?? now + FEED_LIMITS.requestTtlMs,
      now + FEED_LIMITS.requestTtlMaxMs,
    );
    return {
      title,
      description: checked.description,
      tags,
      budget,
      deadline,
      reply: reply.reply,
      displayName,
      expiresAt,
      risky: checked.held || reply.held || nameHeld,
    };
  }

  async function charge(
    caller: FeedCaller,
    scopes: ReturnType<ReturnType<typeof keyed>['scopes']>,
  ) {
    if (caller.kind === 'signed_in') {
      await deps.limit(`feed-post-owner:${caller.ownerId}`, caps.postsPerOwnerHour, HOUR);
      await deps.limit(`feed-post-owner-day:${caller.ownerId}`, caps.postsPerOwnerDay, DAY);
      // Accounts are free to make, so every address scope counts too, in buckets of their own
      // (a signed-in poster never spends the signed-out budget of its address).
      const scoped = signedInScopeCap(caps);
      await deps.limit(
        `feed-post-signed:${scopes.source}`,
        scoped(caps.postsPerSourceHour, 'source'),
        HOUR,
      );
      await deps.limit(
        `feed-post-signed-day:${scopes.source}`,
        caps.postsPerSourceDay * SIGNED_IN_ADDRESS_FACTOR,
        DAY,
      );
      await deps.limit(
        `feed-post-signed-site:${scopes.site}`,
        scoped(caps.postsPerSiteHour, 'site'),
        HOUR,
      );
      await deps.limit(
        `feed-post-signed-network:${scopes.network}`,
        scoped(caps.postsPerNetworkHour, 'network'),
        HOUR,
      );
      await deps.limit(
        `feed-post-signed-region:${scopes.region}`,
        scoped(caps.postsPerRegionHour, 'region'),
        HOUR,
      );
      // Accounts have their own site-wide budget: a signed-out flood cannot use it up.
      await deps.limit('feed-post-owner-global', caps.postsOwnersGlobalHour, HOUR);
      return;
    }
    await deps.limit(`feed-post:${scopes.source}`, caps.postsPerSourceHour, HOUR);
    await deps.limit(`feed-post-day:${scopes.source}`, caps.postsPerSourceDay, DAY);
    await deps.limit(`feed-post-site:${scopes.site}`, caps.postsPerSiteHour, HOUR);
    await deps.limit(`feed-post-network:${scopes.network}`, caps.postsPerNetworkHour, HOUR);
    await deps.limit(`feed-post-region:${scopes.region}`, caps.postsPerRegionHour, HOUR);
    await deps.limit('feed-post-global', caps.postsGlobalHour, HOUR);
  }

  async function replay(q: Transaction, posterKey: string, idempotencyHash: string) {
    return (
      await q.query<Row>(
        `SELECT ${COLUMNS} FROM feed_requests WHERE poster_key=$1 AND idempotency_hash=$2`,
        [posterKey, idempotencyHash],
      )
    ).rows[0];
  }

  const replayed = (row: Row, now: number, secret: string, key: string) => ({
    status: 200 as const,
    body: {
      request: toPublic(row, now),
      manageToken: manageToken(secret, row.id, key),
    } satisfies PostedFeedRequest,
  });

  /**
   * Runs the upkeep when the database says it is due: one conditional upsert of the 'sweep' row
   * in feed_flags (its time is the last start; `enabled` means nothing for it), so instances that
   * start cold and never see many posts still keep expiry and erasure going. A failure is logged,
   * never answered.
   */
  async function sweepIfDue(): Promise<void> {
    const now = clock();
    if (now < sweepAskAt) return;
    sweepAskAt = now + SWEEP_ASK_MS;
    try {
      const due = await db.query(
        `INSERT INTO feed_flags (name, enabled, updated_at, updated_by) VALUES ('sweep', true, $1, 'upkeep')
         ON CONFLICT (name) DO UPDATE SET updated_at=EXCLUDED.updated_at
           WHERE feed_flags.updated_at<=$2
         RETURNING name`,
        [now, now - SWEEP_EVERY_MS],
      );
      if (due.rows.length) await sweep();
    } catch {
      log('feed.sweep_failed', {});
    }
  }

  async function post(
    input: FeedRequestInput,
    caller: FeedCaller,
  ): Promise<{ status: 200 | 201; body: PostedFeedRequest }> {
    const now = clock();
    // A replay answers the manage token: a signed-out key must not be guessable by someone on the
    // same address (a shared carrier address or IPv6 /64) who read the public text.
    if (caller.kind === 'anonymous' && !highEntropyKey(input.idempotencyKey))
      invalid(
        'Without signing in, the idempotencyKey must be random: a UUID v4 or at least 22 random letters and digits.',
      );
    const { secret, scopes: scopesOf } = keyed();
    const scopes = scopesOf(caller.address);
    const posterKey = caller.kind === 'signed_in' ? `op:${caller.ownerId}` : `src:${scopes.source}`;
    const idempotencyHash = sha(`feed-idempotency\n${input.idempotencyKey}`);
    const key = contentKey(cleanLine(input.title), cleanText(input.description));

    const answerReplay = (earlier: Row) => {
      if (earlier.content_key !== key && earlier.state !== 'removed')
        invalid('This idempotencyKey was already used for a different request.');
      return replayed(earlier, now, secret, input.idempotencyKey);
    };
    const earlier = await replay(db, posterKey, idempotencyHash);
    if (earlier) return answerReplay(earlier);
    if (await postingPaused())
      throw new FeedRequestError(
        503,
        'posting_paused',
        'Posting is paused for now. Try again later.',
        true,
      );
    await charge(caller, scopes);
    await sweepIfDue();

    const fields = prepare(input, caller, now);
    const titleKey = foldKey(fields.title);
    const id = newRequestId();
    const token = manageToken(secret, id, input.idempotencyKey);
    const posterKind: FeedPosterKind =
      caller.kind === 'anonymous' ? 'anonymous' : caller.agent ? 'agent' : 'account';

    let heldReason: 'honeypot' | 'blocked' | 'risk' | 'spread' | null = null;
    try {
      const outcome = await db.transaction<Posted>(async (tx: Transaction) => {
        // One poster at a time: the open cap and the duplicate checks hold for the insert.
        await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`feed-post\n${posterKey}`]);
        // A retry with the same key that committed while this one waited is answered, not refused.
        const raced = await replay(tx, posterKey, idempotencyHash);
        if (raced) return { raced };
        const blocked = (
          await tx.query(
            'SELECT 1 FROM feed_source_blocks WHERE source_hash=$1 AND expires_at>$2',
            [scopes.source, now],
          )
        ).rows.length;
        heldReason = input.website
          ? 'honeypot'
          : blocked
            ? 'blocked'
            : fields.risky
              ? 'risk'
              : null;
        if (!heldReason) {
          // An open copy past its expiry no longer counts: expire it now (lists already skip it).
          await endWithResponses(
            tx,
            `UPDATE feed_requests SET state='expired', closed_at=expires_at, reply=NULL
              WHERE content_key=$1 AND state='open' AND expires_at<=$2`,
            [key, now],
          );
          // Only a copy that is on the Feed (open, visible, unexpired) counts, so the answer is
          // true: a closed, expired or held copy never stops the poster posting again, and
          // reports never do either.
          const duplicate = await tx.query(
            `SELECT 1 FROM feed_requests WHERE content_key=$1 AND state='open' AND hidden_at IS NULL
             UNION ALL
             SELECT 1 FROM feed_requests WHERE poster_key=$2 AND title_key=$3 AND created_at>$4
               AND state='open' AND hidden_at IS NULL AND expires_at>$5
             LIMIT 1`,
            [key, posterKey, titleKey, now - 7 * DAY, now],
          );
          if (duplicate.rows.length) invalid('This request is already on the Feed.');
          // Closing and posting the same request again would move it to the top of the newest-
          // first Feed each time: the same title from the same poster waits an hour after a close.
          // A copy closed while it was held (held_reason set; a release clears it, review.ts) was
          // never on the Feed, so fixing it and posting again goes through at once.
          const reposted = await tx.query(
            `SELECT 1 FROM feed_requests WHERE poster_key=$1 AND title_key=$2 AND state='closed'
               AND hidden_at IS NULL AND held_reason IS NULL AND closed_at>$3 LIMIT 1`,
            [posterKey, titleKey, now - REPOST_AFTER_CLOSE_MS],
          );
          if (reposted.rows.length)
            invalid('You closed this request less than an hour ago. Post it again later.');
          // Text an operator removed (kept 7 days after the review) goes back to review, by
          // anyone: a removal is never undone by posting it again. A removed honeypot or blocked
          // copy does not count (as in the spread check below): a bot posting someone's text
          // must never send the real post to review. The same text has the same title, so
          // title_key narrows the search to feed_requests_title.
          const removed = await tx.query(
            `SELECT 1 FROM feed_requests WHERE title_key=$2 AND content_key=$1 AND state='removed'
               AND coalesce(held_reason, '') NOT IN ('honeypot','blocked') LIMIT 1`,
            [key, titleKey],
          );
          if (removed.rows.length) heldReason = 'risk';
        }
        if (!heldReason) {
          // Copies held as a honeypot or a blocked source do not count: nobody can push another
          // poster's request into review by posting its title from bots.
          const spread = await tx.query<{ sites: string | number }>(
            `SELECT count(DISTINCT site_hash) AS sites FROM feed_requests
              WHERE title_key=$1 AND created_at>$2 AND site_hash<>$3
                AND (state='open' OR (state='held' AND held_reason NOT IN ('honeypot','blocked')))`,
            [titleKey, now - DAY, scopes.site],
          );
          if (Number(spread.rows[0]?.sites ?? 0) >= 2) heldReason = 'spread';
        }
        if (!heldReason) {
          const open = await tx.query<{ mine: string | number; all: string | number }>(
            `SELECT count(*) FILTER (WHERE poster_key=$1) AS mine, count(*) AS all
               FROM feed_requests WHERE state='open' AND expires_at>$2`,
            [posterKey, now],
          );
          const perPoster = caller.kind === 'signed_in' ? caps.openPerOwner : caps.openPerSource;
          if (Number(open.rows[0]?.mine ?? 0) >= perPoster)
            throw new FeedRequestError(
              429,
              null,
              `At most ${perPoster} open requests at a time. Close one, or wait until one expires.`,
            );
          if (Number(open.rows[0]?.all ?? 0) >= caps.openGlobal)
            throw new FeedRequestError(429, null, 'The Feed is full right now. Try again later.');
        }
        const inserted = (
          await tx.query<Row>(
            `INSERT INTO feed_requests (id, state, title, description, capabilities, budget_raw,
               deadline_at, reply, poster_kind, display_name, owner_id, agent_id, poster_key,
               source_hash, site_hash, content_key, title_key, manage_hash, idempotency_hash,
               held_reason, created_at, expires_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
             RETURNING ${COLUMNS}`,
            [
              id,
              heldReason ? 'held' : 'open',
              fields.title,
              fields.description,
              fields.tags,
              fields.budget,
              fields.deadline,
              fields.reply,
              posterKind,
              fields.displayName,
              caller.kind === 'signed_in' ? caller.ownerId : null,
              caller.kind === 'signed_in' ? (caller.agent?.id ?? null) : null,
              posterKey,
              scopes.source,
              scopes.site,
              key,
              titleKey,
              sha(token),
              idempotencyHash,
              heldReason,
              now,
              fields.expiresAt,
            ],
          )
        ).rows[0]!;
        return { inserted };
      });
      if ('raced' in outcome) return answerReplay(outcome.raced);
      // Operators find it in the review queue by its id (never the poster or the text).
      if (heldReason) log('feed.request_held', { id: outcome.inserted.id, reason: heldReason });
      return {
        status: 201,
        body: { request: toPublic(outcome.inserted, now), manageToken: token },
      };
    } catch (error) {
      if (unique(error, 'feed_requests_idem')) {
        const raced = await replay(db, posterKey, idempotencyHash);
        if (raced) return answerReplay(raced);
      }
      // Also what an operator meets approving a held copy by SQL after its poster posted the same
      // text again: one of the two has to be closed or removed first.
      if (unique(error, 'feed_requests_content')) invalid('This request is already on the Feed.');
      throw error;
    }
  }

  /** Open, visible and unexpired only (every other row is hidden, never probed). */
  const VISIBLE = "state='open' AND hidden_at IS NULL AND expires_at>$1";

  /** One page of the public list; pageSize is the page (the MCP tool asks for smaller ones). */
  async function list(
    query: FeedRequestQuery,
    pageSize: number = FEED_LIMITS.pageSize,
  ): Promise<FeedRequestPage> {
    await sweepIfDue();
    const now = clock();
    const where = [VISIBLE];
    const params: unknown[] = [now];
    const text = tsQuery(query.q);
    if (query.q && !text) return { requests: [], next: null };
    if (text) {
      params.push(text);
      // The expression of the feed_requests_text index (migration 105): title, description, tags.
      where.push(`${FEED_REQUEST_TEXT} @@ to_tsquery('simple', $${params.length})`);
    }
    if (query.tag) {
      params.push([query.tag]);
      where.push(`capabilities @> $${params.length}::text[]`);
    }
    const cursor = query.cursor ? CURSOR.exec(query.cursor) : null;
    if (cursor) {
      params.push(Number(cursor[1]), `req_${cursor[2]}`);
      where.push(`(created_at, id) < ($${params.length - 1}, $${params.length})`);
    }
    params.push(pageSize + 1);
    const rows = await db
      .transaction(async (tx: Transaction) => {
        await tx.query("SELECT set_config('statement_timeout', $1, true)", [
          String(SEARCH_TIMEOUT_MS),
        ]);
        return (
          await tx.query<Row>(
            `SELECT ${COLUMNS} FROM feed_requests WHERE ${where.join(' AND ')}
            ORDER BY created_at DESC, id DESC LIMIT $${params.length}`,
            params,
          )
        ).rows;
      })
      .catch((error: unknown) => {
        // A text search past its own time limit may be slow every time (heavy or crafted words):
        // busy, with a longer wait than a moment of load so callers do not repeat it every few
        // seconds on a loaded database. Never invalid_request: under load ordinary words hit the
        // limit too. The plain list and a tag alone keep the usual wait.
        if (text && (error as { code?: unknown } | null)?.code === SEARCH_TIMED_OUT)
          throw new FeedBusyError(FEED_SEARCH_BUSY_RETRY_AFTER_S, error);
        throw error;
      });
    const page = rows.slice(0, pageSize);
    const last = page[page.length - 1];
    return {
      requests: page.map((row) => toPublic(row, now)),
      next: rows.length > pageSize && last ? cursorOf(Number(last.created_at), last.id) : null,
    };
  }

  /** One open, visible request; null for held, hidden, closed, expired, removed and unknown ids. */
  async function get(id: string): Promise<PublicFeedRequest | null> {
    const now = clock();
    const row = (
      await db.query<Row>(`SELECT ${COLUMNS} FROM feed_requests WHERE ${VISIBLE} AND id=$2`, [
        now,
        id,
      ])
    ).rows[0];
    return row ? toPublic(row, now) : null;
  }

  async function openCount(): Promise<number> {
    await sweepIfDue();
    const row = (
      await db.query<{ open: string | number }>(
        `SELECT count(*) AS open FROM feed_requests WHERE ${VISIBLE}`,
        [clock()],
      )
    ).rows[0];
    return Number(row?.open ?? 0);
  }

  /**
   * The workspace's own requests (posted signed in, as the account or one of its agents), newest
   * first: every one still open or in review, and the newest mineMax closed or expired ones posted
   * within mineWindowMs; removed ones never. Paged (minePageSize, next cursor), so an owner with a
   * raised open cap never gets an answer too large to send. The same owner check as close(), so
   * every open or held one listed closes with the session alone after a reload.
   */
  async function mine(ownerId: string, cursor: string | null = null): Promise<FeedMyRequests> {
    await sweepIfDue();
    const now = clock();
    const pageSize = minePageSize(caps);
    const after = cursor ? CURSOR.exec(cursor) : null;
    const params: unknown[] = [
      `op:${ownerId}`,
      ownerId,
      now,
      now - FEED_LIMITS.requestTtlMaxMs,
      now - FEED_LIMITS.mineWindowMs,
      FEED_LIMITS.mineMax,
      pageSize + 1,
    ];
    let before = 'true';
    if (after) {
      params.push(Number(after[1]), `req_${after[2]}`);
      before = '(created_at, id) < ($8, $9)';
    }
    // Live ones are bounded by the open cap (held ones are purged after 7 days, open ones expire
    // within requestTtlMaxMs); ended ones have a cap of their own (the newest mineMax), so however
    // many end, every live one stays reachable. One order over both, newest first.
    const rows = (
      await db.query<Row>(
        `(SELECT ${COLUMNS} FROM feed_requests
           WHERE poster_key=$1 AND owner_id=$2 AND created_at>$4
             AND (state='held' OR (state='open' AND expires_at>$3)) AND ${before}
           ORDER BY created_at DESC, id DESC LIMIT $7)
         UNION ALL
         (SELECT * FROM (SELECT ${COLUMNS} FROM feed_requests
             WHERE poster_key=$1 AND owner_id=$2 AND created_at>$5
               AND (state IN ('closed','expired') OR (state='open' AND expires_at<=$3))
             ORDER BY created_at DESC, id DESC LIMIT $6) AS ended
           WHERE ${before}
           ORDER BY created_at DESC, id DESC LIMIT $7)
         ORDER BY created_at DESC, id DESC LIMIT $7`,
        params,
      )
    ).rows;
    const page = rows.slice(0, pageSize);
    const last = page[page.length - 1];
    return {
      requests: page.map((row) => toMine(row, now)),
      next: rows.length > pageSize && last ? cursorOf(Number(last.created_at), last.id) : null,
    };
  }

  /** Always answers nothing: a report never says whether it counted. */
  async function report(
    id: string,
    address: string,
    input: { reason: FeedReportReason; note?: string },
  ): Promise<void> {
    const now = clock();
    const scopes = keyed().scopes(address);
    await deps.limit(`feed-report:${scopes.source}`, caps.reportsPerSourceHour, HOUR);
    await deps.limit(`feed-report-site:${scopes.site}`, caps.reportsPerSiteHour, HOUR);
    // Many sites of one network (a free IPv6 /48 holds 256 /56s) are still one reporter budget.
    await deps.limit(`feed-report-network:${scopes.network}`, caps.reportsPerNetworkHour, HOUR);
    await deps.limit(`feed-report-region:${scopes.region}`, caps.reportsPerRegionHour, HOUR);
    await deps.limit('feed-report-global', caps.reportsGlobalHour, HOUR);
    const note = input.note ? cleanText(input.note) : '';
    const hidden = await db.transaction(async (tx: Transaction) => {
      const row = (
        await tx.query<{ source_hash: string; hidden_at: unknown; reviewed_at: unknown }>(
          `SELECT source_hash, hidden_at, reviewed_at FROM feed_requests
            WHERE id=$1 AND state='open' AND expires_at>$2 FOR UPDATE`,
          [id, now],
        )
      ).rows[0];
      // The poster's own address never counts toward hiding its request.
      if (!row || row.source_hash === scopes.source) return false;
      const added = await tx.query(
        `INSERT INTO feed_request_reports
           (request_id, reporter_hash, reporter_site, reporter_network, reason, note, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING RETURNING request_id`,
        [id, scopes.source, scopes.site, scopes.network, input.reason, note || null, now],
      );
      if (!added.rows.length) return false;
      const counts = (
        await tx.query<{ reporters: string | number; networks: string | number }>(
          `SELECT count(*) AS reporters, count(DISTINCT reporter_network) AS networks
             FROM feed_request_reports WHERE request_id=$1`,
          [id],
        )
      ).rows[0]!;
      // Distinct networks (IPv4 /16, IPv6 /48), not sites: one network holds many sites.
      const threshold = row.reviewed_at === null ? FEED_LIMITS.reportsToHide : 10;
      const hide = row.hidden_at === null && Number(counts.networks) >= threshold;
      await tx.query(
        `UPDATE feed_requests SET report_count=$2, hidden_at=CASE WHEN $3::boolean THEN $4::bigint ELSE hidden_at END
          WHERE id=$1`,
        [id, Number(counts.reporters), hide, now],
      );
      return hide;
    });
    // After the commit: the alert never names a request that is not hidden.
    if (hidden) log('feed.request_hidden', { id });
  }

  /** The poster closes with the manage token, or with the session of the workspace that posted. */
  async function close(
    id: string,
    address: string,
    token: string | null,
    ownerId: string | null,
  ): Promise<PublicFeedRequest> {
    const now = clock();
    const scopes = keyed().scopes(address);
    await deps.limit(`feed-manage:${scopes.source}`, caps.managePerSourceHour, HOUR);
    const row = (await db.query<Row>(`SELECT ${COLUMNS} FROM feed_requests WHERE id=$1`, [id]))
      .rows[0];
    const notFound = () => refuse(404, 'request_not_found', 'This request is not on the Feed.');
    if (!row || row.state === 'removed') return notFound();
    const byToken =
      token !== null &&
      timingSafeEqual(Buffer.from(sha(token), 'hex'), Buffer.from(row.manage_hash, 'hex'));
    const byOwner = ownerId !== null && row.owner_id === ownerId;
    if (!byToken && !byOwner) {
      // Hidden and held ones answer like unknown ones, so they cannot be probed.
      const status = statusOf(row, now);
      if (status === 'hidden' || status === 'held') return notFound();
      return refuse(403, 'not_poster', 'Only the poster can close this request.');
    }
    const status = statusOf(row, now);
    if (status === 'closed' || status === 'expired')
      return refuse(409, 'request_closed', 'This request is already closed.');
    // Its responses (Respond) end in the same transaction.
    const closed = await db.transaction(async (tx: Transaction) => {
      const row = (
        await tx.query<Row>(
          `UPDATE feed_requests SET state='closed', closed_at=$2, reply=NULL
            WHERE id=$1 AND state IN ('open','held') RETURNING ${COLUMNS}`,
          [id, now],
        )
      ).rows[0];
      if (row && (await hasResponses(tx)))
        await endRequests(tx, true, 'SELECT $1::text AS id, $2::bigint AS end_at', [id, now]);
      return row;
    });
    if (!closed) return refuse(409, 'request_closed', 'This request is already closed.');
    return toPublic(closed, now);
  }

  /**
   * Bounded upkeep (sweepIfDue): expire what passed its expiry (erasing the reply handle, and with
   * its open responses), delete
   * closed and expired rows 30 days on, held ones 7 days after posting, removed ones 7 days after
   * the removal, and lapsed blocks. A review always moves a request out of 'held' (review.ts), so
   * 'held' here is never reviewed: a released request is open again and lives to its own expiry,
   * and a removal stays on record a full week whatever the request's age (it holds a repost).
   */
  async function sweep(): Promise<void> {
    const now = clock();
    await endWithResponses(
      db,
      `UPDATE feed_requests SET state='expired', closed_at=expires_at, reply=NULL
        WHERE id IN (SELECT id FROM feed_requests WHERE state='open' AND expires_at<=$1 LIMIT 500)`,
      [now],
    );
    await db.query(
      `DELETE FROM feed_requests WHERE id IN (
         SELECT id FROM feed_requests WHERE state IN ('closed','expired') AND closed_at<=$1 LIMIT 500)`,
      [now - 30 * DAY],
    );
    await db.query(
      `DELETE FROM feed_requests WHERE id IN (
         SELECT id FROM feed_requests WHERE state IN ('held','removed') AND created_at<=$1
           AND (CASE WHEN state='removed' THEN coalesce(reviewed_at, created_at) ELSE created_at END)<=$1
         LIMIT 500)`,
      [now - 7 * DAY],
    );
    await db.query('DELETE FROM feed_source_blocks WHERE expires_at<=$1', [now]);
  }

  return { post, list, get, openCount, mine, report, close, sweep, caps };
}

export type FeedRequests = ReturnType<typeof createFeedRequests>;
