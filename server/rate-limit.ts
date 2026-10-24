import { createHash, createHmac } from 'node:crypto';
import type { Database } from './database.js';

/** Failed password attempts allowed per account name and per deployment in one window. */
/**
 * Sign-in budgets. Attempts are counted per account name and client address (/64 for IPv6), so
 * one source cannot lock out an owner signing in from elsewhere; failures per account name have
 * a higher ceiling across all sources. There is deliberately no deployment-wide lock.
 */
export const LOGIN_FAILURES = {
  perAccountAddress: 10,
  perAccount: 100,
  windowMs: 15 * 60_000,
} as const;

export interface RateLimitResult {
  allowed: boolean;
  /** Milliseconds until the current window ends; 0 when allowed. */
  retryAfterMs: number;
}
export interface RateLimiter {
  hit(key: string, limit: number, windowMs: number): Promise<RateLimitResult>;
  /** Hits already counted in the key's current window, without counting a new one. */
  count(key: string, windowMs: number): Promise<number>;
}

/**
 * Per-process fixed windows starting at a key's first hit. Memory is bounded: when full, a
 * short sweep drops expired windows and then the least recently used keys are evicted. A key
 * under active attack keeps being touched, so eviction reaches idle keys first. There is no
 * global fail-closed denial (the shared limiter's outage policy is in outageMode).
 */
export class MemoryRateLimiter implements RateLimiter {
  private readonly entries = new Map<string, { count: number; until: number }>();
  constructor(
    private readonly now: () => number = Date.now,
    readonly maxKeys = 10_000,
    private readonly strict = strictClassificationDefault(),
  ) {
    if (!Number.isSafeInteger(maxKeys) || maxKeys < 1) throw new Error('maxKeys must be positive.');
  }
  get size(): number {
    return this.entries.size;
  }
  async hit(key: string, limit: number, windowMs: number): Promise<RateLimitResult> {
    return this.hitSync(key, limit, windowMs);
  }
  async count(key: string, _windowMs: number): Promise<number> {
    if (this.strict) assertClassified(key);
    const current = this.entries.get(key);
    return current && current.until > this.now() ? current.count : 0;
  }
  hitSync(key: string, limit: number, windowMs: number): RateLimitResult {
    if (this.strict) assertClassified(key);
    const time = this.now();
    let current = this.entries.get(key);
    if (current) this.entries.delete(key);
    if (current && current.until <= time) current = undefined;
    if (!current) {
      this.makeRoom(time);
      current = { count: 0, until: time + windowMs };
    }
    // Re-insert to mark as most recently used.
    this.entries.set(key, current);
    current.count++;
    return current.count > limit
      ? { allowed: false, retryAfterMs: Math.max(1, current.until - time) }
      : { allowed: true, retryAfterMs: 0 };
  }
  private makeRoom(time: number): void {
    if (this.entries.size < this.maxKeys) return;
    let scanned = 0;
    for (const [key, value] of this.entries) {
      if (value.until <= time) this.entries.delete(key);
      if (++scanned >= 64) break;
    }
    while (this.entries.size >= this.maxKeys) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }
}

/**
 * Stored counter keys are HMAC-SHA256 under CITY_RATE_LIMIT_KEY (required in hosted mode), so
 * enumerating IPv4 addresses cannot reverse them. Without the key (local development and tests)
 * they fall back to plain SHA-256, which only obscures the address.
 */
export function storedKeyHash(windowMs: number, key: string): string {
  const material = `${windowMs}\n${key}`;
  const secret = process.env.CITY_RATE_LIMIT_KEY;
  return secret
    ? createHmac('sha256', secret).update(material).digest('hex')
    : createHash('sha256').update(material).digest('hex');
}

/**
 * How a bucket behaves when the shared (PostgreSQL) limiter is unavailable. Buckets are classified
 * by the key prefix before the first ':' so call sites need no changes.
 *
 * - FAIL_CLOSED: anonymous, sign-in, credential-issuing and claim buckets. A per-instance fallback
 *   would multiply these limits by the number of serverless instances exactly during a flood, so
 *   they answer 429 with a short Retry-After until the shared limiter answers again.
 * - DEGRADED: authenticated or high-volume buckets. They keep a per-instance memory fallback, but
 *   at 1/DEGRADED_LIMIT_DIVISOR of the limit, so a few instances together stay near the budget.
 *
 * A prefix in neither list fails closed. tests/rate-limit.test.ts checks that every prefix used
 * under server/ is classified explicitly.
 */
export const FAIL_CLOSED_PREFIXES: readonly string[] = [
  // The Agent Explorer's Service calls searches, one bucket for every client together
  // (server/base/explorer/calls.ts): searches scan the payment table, so they share one budget.
  'explorer-calls-search',
  // Newsletter subscribe attempts and the signed link POSTs (server/email/index.ts).
  'newsletter',
  'newsletter-link',
  // Anonymous creation and the anonymous MCP endpoint.
  'anon',
  'anon-create',
  'anon-create-site',
  'anon-create-network',
  'anon-create-region',
  'anon-mcp',
  'ai-ws',
  'ai-ws-create',
  'ai-ws-create-site',
  'ai-ws-create-network',
  'ai-ws-create-region',
  // Sign-in, registration and the OAuth authorization server.
  'register',
  'login',
  'login-attempt',
  'login-fail',
  'oauth-register',
  'oauth-register-day',
  'oauth-authorize',
  'oauth-token',
  // Sign in with Google (docs/GOOGLE_SIGNIN.md): starting, the callback and unlinking.
  'google-start',
  'google-callback',
  'google-unlink',
  'elric-age',
  'elric-age-view',
  // Claims, enrollment and credential or invite issuing.
  'claim',
  'claim-ip',
  'ws-claim',
  'ws-claim-ip',
  'ws-claim-preview',
  'enroll',
  'assistant-issue',
  'ws-key-issue',
  'join-link',
  'join-link-read',
  'room-link',
  'room-join',
  // Deleting a room erases it for every member: never unbounded during an outage.
  'room-delete',
  // The host's bulk "Mute all AIs" / "Unmute all AIs" touches every member of a room.
  'room-bulk-mute',
  // Owner actions that reach other owners or the network.
  'xconn-req',
  // Room invitations to other owners' agents, and their answers (rooms/invitations.ts).
  'room-invite-send',
  'room-invite-answer',
  'wake-webhook',
  // Room repos: binding calls GitHub with the App JWT (docs/ROOM_REPOS.md).
  'room-repo-bind',
  'room-repo-bind-owner',
  // Apply writes a branch, a commit and a draft PR to GitHub.
  'room-repo-apply',
  // Answers: publishing reaches other owners, and reuse reports and flags feed ranking and
  // hiding, so they are abuse-sensitive. The report allowances only stop counting when refused.
  'result-publish-owner',
  'result-publish-net',
  'result-publish-agent',
  'result-report-net',
  'result-report-network',
  'result-flag-principal',
  'result-reuse-principal',
  // Hosted responder: saving a key calls the provider, so these must never become an open
  // oracle for testing stolen keys during an outage; settings writes follow.
  'responder-key',
  'responder-key-ip',
  'responder-settings',
  // Base Pay P2c: an agent paying on its own, per grant or key. It moves the owner's money without
  // the owner present, so it is never unbounded during an outage.
  'agent-pay',
  // city_pay_status, per grant or key and per workspace: it pays nothing, but a payment in flight
  // is read from the bundler and Base (and may be resent), so it fails closed like city_pay.
  'agent-pay-status',
  // Reply budgets (S2b): they protect the owner's money, so they fail closed too.
  'responder-room',
  'responder-agent-room',
  'responder-pair',
  'responder-pair-day',
  'responder-unclaimed-day',
  // Feed requests (server/feed/requests.ts): anyone may post, report and close with a manage
  // token, signed in or not, so every write budget is abuse-sensitive.
  'feed-post',
  'feed-post-day',
  'feed-post-site',
  'feed-post-network',
  'feed-post-region',
  'feed-post-global',
  'feed-post-owner',
  'feed-post-owner-day',
  'feed-post-owner-global',
  'feed-post-signed',
  'feed-post-signed-day',
  'feed-post-signed-site',
  'feed-post-signed-network',
  'feed-post-signed-region',
  'feed-report',
  'feed-report-site',
  'feed-report-network',
  'feed-report-region',
  'feed-report-global',
  'feed-manage',
  // Feed Respond (server/feed/respond.ts): a response reaches another owner's inbox.
  'feed-respond',
  // Feed pay (server/feed/pay): a quote reaches an outside service; a call (Feed or MCP) moves the
  // agent's money. Never unbounded during an outage.
  'feed-pay-quote',
  'feed-pay-call',
  // The sponsored first purchase's calls (server/feed/pay/sponsored-routes.ts).
  'sfp-call',
  'sfp-credit',
  'feed-pay-agents',
  'feed-pay-mcp',
  // The services:sell tools (server/feed/offers/tools.ts): writes to public listings.
  'feed-offers-mcp',
  // A same-key re-read of a call (MCP): it pays nothing, but it can resume the call's work, so it
  // fails closed like the rest of Feed pay (the call itself goes on; the AI reads it again later).
  'feed-pay-mcp-read',
];
export const DEGRADED_PREFIXES: readonly string[] = [
  'ip',
  'ip-auth',
  'guest-api',
  'owner-api',
  'guest-mcp',
  'ip-lookup',
  'runtime',
  'assistant',
  'workspace-key',
  'msg-send',
  'xsend-in',
  'xsend-pair',
  // Private messages between room members, per pair (server/messaging/room-direct.ts).
  'room-dm-pair',
  // "Delete conversation" in Messages: hides a thread for its own owner only.
  'msg-hide',
  'room-create',
  'room-post-owner',
  'room-post-agent',
  'room-post-all',
  // AI self-reported status changes per member agent (ride on posts; member-says.ts).
  'room-status',
  // Searches inside a room (read-only, members only).
  'room-search',
  // Room pins (pin and unpin writes) and on-demand handoff briefs, per owner (members only).
  'room-pin',
  'room-brief',
  // A person's own Needs-you dismissals and console read marks, per owner (members only).
  'room-needs-you',
  'room-read',
  'room-task-create',
  'room-task-claim',
  // Peer review requests and answers per agent (each one mentions and wakes a member).
  'room-task-review',
  'room-task-comment',
  // Room repos: member reads of the connected repository (GitHub's own limits still apply).
  'room-repo-read',
  'room-repo-propose',
  'room-repo-review',
  'room-repo-read-owner',
  // Signed-in wake streams and long-polls (city_mentions wait=) must keep working in an outage.
  'wake-wait-owner',
  'wake-wait-ip',
  // The per-agent (and per-connector-grant) shares of the long-poll budget.
  'wake-wait-agent',
  'wake-wait-grant',
  'wake-stream-owner',
  'wake-stream-ip',
  // Authenticated, read-only asks.
  'result-ask-owner',
  'result-ask-net',
  'result-ask-agent',
  // Elric's private room catch-up per signed-in caller (each may cost a model call).
  'elric-catch-up',
  // Base Pay per signed-in person, each its own bucket: recipient lookups (read Base, store a
  // lookup), incoming reads (may refresh payments from Base), payments (read Base, prepare).
  'pay-lookup',
  'pay-incoming',
  'pay-create',
  // Base Wallet reads per signed-in person: one withdrawal (may bring it up to date from Base)
  // and the spending limits (read from Base each time).
  'wallet-read',
  'wallet-limits-read',
  // city_request_search reads of the public request list, per workspace (read-only).
  'feed-read-owner',
];
/** Degraded buckets allow limit / this per instance while the shared limiter is unavailable. */
export const DEGRADED_LIMIT_DIVISOR = 4;
/** Retry-After for fail-closed buckets while the shared limiter is unavailable. */
export const FAIL_CLOSED_RETRY_MS = 5_000;

const failClosed = new Set(FAIL_CLOSED_PREFIXES);
const degradedSet = new Set(DEGRADED_PREFIXES);
export type LimiterOutageMode = 'fail-closed' | 'degraded';
function prefixOf(key: string): string {
  const colon = key.indexOf(':');
  return colon < 0 ? key : key.slice(0, colon);
}
export function outageMode(key: string): LimiterOutageMode {
  const prefix = prefixOf(key);
  if (failClosed.has(prefix)) return 'fail-closed';
  return degradedSet.has(prefix) ? 'degraded' : 'fail-closed';
}

/**
 * Strict classification: every hit and count checks that the key's prefix is in one of the two
 * lists and throws otherwise, so any test that reaches an unclassified bucket fails, whatever way
 * the key was built. On by default under the test runner (NODE_ENV=test, or Node's test runner,
 * which sets NODE_TEST_CONTEXT in each test file's process); production keeps the fail-closed
 * default for an unknown prefix instead of throwing. Both limiters also take it as an option.
 */
export function strictClassificationDefault(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV === 'test' || env.NODE_TEST_CONTEXT !== undefined;
}
export class UnclassifiedRateLimitKeyError extends Error {
  constructor(readonly prefix: string) {
    super(
      `Rate-limit key prefix "${prefix}" has no outage policy; add it to FAIL_CLOSED_PREFIXES or DEGRADED_PREFIXES in server/rate-limit.ts.`,
    );
  }
}
export function assertClassified(key: string): void {
  const prefix = prefixOf(key);
  if (failClosed.has(prefix) || degradedSet.has(prefix)) return;
  const error = new UnclassifiedRateLimitKeyError(prefix);
  // Route error handlers turn this into a generic 500; print the prefix so the failing test says why.
  console.error(error.message);
  throw error;
}

/**
 * Why the shared limiter was unavailable. The limiter shares the application pool (3 clients,
 * 5 s acquisition timeout), so on a busy instance a pool acquisition timeout counts as an outage
 * even while PostgreSQL itself is healthy: fail-closed buckets then answer 429 with a 5 s
 * Retry-After. That is intended; it is reported separately so it can be told apart from a
 * database failure.
 */
export type LimiterOutageCause = 'pool-timeout' | 'database';
/** node-postgres reports an exhausted acquisition wait with this message. */
export function outageCause(error: unknown): LimiterOutageCause {
  const message = error instanceof Error ? error.message : '';
  return /timeout exceeded when trying to connect|acquisition timeout/i.test(message)
    ? 'pool-timeout'
    : 'database';
}
export interface LimiterOutageEvent {
  metric: 'rate_limit_shared_unavailable';
  mode: LimiterOutageMode;
  /** Outage decisions of this mode since the previous report (at most one report a minute). */
  count: number;
  /** How many of them were pool acquisition timeouts rather than database errors. */
  pool_timeouts: number;
}
/** Default outage reporter: one structured warning per mode per minute, never keys or errors. */
export function throttledOutageLog(
  now: () => number = Date.now,
  write: (line: string) => void = (line) => console.warn(line),
): (mode: LimiterOutageMode, cause?: LimiterOutageCause) => void {
  const pending = { 'fail-closed': 0, degraded: 0 };
  const pendingPool = { 'fail-closed': 0, degraded: 0 };
  const last = { 'fail-closed': -Infinity, degraded: -Infinity };
  return (mode, cause = 'database') => {
    pending[mode]++;
    if (cause === 'pool-timeout') pendingPool[mode]++;
    const time = now();
    if (time - last[mode] < 60_000) return;
    last[mode] = time;
    const event: LimiterOutageEvent = {
      metric: 'rate_limit_shared_unavailable',
      mode,
      count: pending[mode],
      pool_timeouts: pendingPool[mode],
    };
    pending[mode] = 0;
    pendingPool[mode] = 0;
    write(JSON.stringify(event));
  };
}

/** The last part of every window in which LocalShed leaves each decision to the shared limiter. */
export const SHED_SKEW_MARGIN_MS = 1_000;

/** Start of the clock-aligned fixed window holding `time`; the shared row and LocalShed use it. */
export function windowStartOf(time: number, windowMs: number): number {
  return Math.floor(time / windowMs) * windowMs;
}

/**
 * Per-instance pre-check in front of the shared limiter. All hits of one key update one row, so a
 * flood from one client queues on that row's lock while holding clients of the small application
 * pool. This check refuses the excess of such a flood before it reaches the database.
 *
 * It counts, per key, window length, limit and clock-aligned window (windowStartOf, as the shared
 * row), only the hits this instance saw the shared limiter count in that same window: a hit whose
 * query failed, or that the row counted in another window, is left out. The shared row counts
 * every hit of the key and window length (refused ones too) and never decreases within a window,
 * so it is at least this local count. Once the local count plus the new hit exceeds the limit, the
 * shared count after that hit would too: the shared limiter would refuse it, and it is refused
 * here without a query, with the Retry-After the shared limiter gives (the end of the window).
 * Otherwise the shared limiter decides exactly as before. Counting too few is always safe: it only
 * sends more hits to the shared limiter. A hit refused here never reaches the row, so the row stops
 * growing during a refused flood: count() still reads at least the limit, but another limit on the
 * same key and window length sees only the hits that reached the row.
 *
 * Another instance whose clock runs slightly ahead can start the next shared window (or clean the
 * row up) a little early, so in the last `skewMarginMs` of each window every hit goes to the
 * shared limiter. A count applies only to the exact window it was counted in, so a clock that
 * moves back never carries it into another window. Memory is bounded: at `maxKeys`, a short sweep
 * drops ended windows and then the least recently used entries are evicted; forgetting a count
 * only sends its hits to the shared limiter again. There are no timers.
 */
export class LocalShed {
  private readonly entries = new Map<string, { end: number; count: number }>();
  constructor(
    readonly maxKeys = 10_000,
    readonly skewMarginMs = SHED_SKEW_MARGIN_MS,
  ) {
    if (!Number.isSafeInteger(maxKeys) || maxKeys < 1) throw new Error('maxKeys must be positive.');
    if (!Number.isFinite(skewMarginMs) || skewMarginMs < 0)
      throw new Error('skewMarginMs must not be negative.');
  }
  get size(): number {
    return this.entries.size;
  }
  /** Retry-After in ms when the hit can be refused without the shared limiter, otherwise null. */
  refuse(key: string, limit: number, windowMs: number, time: number): number | null {
    if (!(windowMs > 0) || !Number.isFinite(windowMs)) return null;
    const id = `${windowMs}\n${limit}\n${key}`;
    const entry = this.entries.get(id);
    if (!entry) return null;
    const end = windowStartOf(time, windowMs) + windowMs;
    if (entry.end !== end) {
      if (entry.end <= time) this.entries.delete(id);
      return null;
    }
    // The comparison the shared limiter makes on its count after this hit (count > limit).
    if (!(entry.count + 1 > limit) || time >= end - this.skewMarginMs) return null;
    // Re-insert to mark as most recently used: a key under a flood is never the one evicted.
    this.entries.delete(id);
    this.entries.set(id, entry);
    return Math.max(1, end - time);
  }
  /**
   * Records one hit the shared limiter counted: computed at `time` for the window starting at
   * `windowStart`, and counted in the row whose window ends at `countedEnd` (its expires_at). A
   * later row window means another instance already started the next window: the hit is left out.
   */
  counted(
    key: string,
    limit: number,
    windowMs: number,
    windowStart: number,
    countedEnd: number,
    time: number,
  ): void {
    if (!(windowMs > 0) || !Number.isFinite(windowMs)) return;
    const end = windowStart + windowMs;
    if (countedEnd !== end) return;
    const id = `${windowMs}\n${limit}\n${key}`;
    let entry = this.entries.get(id);
    // A late answer for a window this instance has left (or a clock that moved back).
    if (entry && entry.end > end) return;
    if (entry) this.entries.delete(id);
    if (entry && entry.end < end) entry = undefined;
    if (!entry) {
      this.makeRoom(time);
      entry = { end, count: 0 };
    }
    entry.count++;
    this.entries.set(id, entry);
  }
  private makeRoom(time: number): void {
    if (this.entries.size < this.maxKeys) return;
    let scanned = 0;
    for (const [id, entry] of this.entries) {
      if (entry.end <= time) this.entries.delete(id);
      if (++scanned >= 64) break;
    }
    while (this.entries.size >= this.maxKeys) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }
}

/**
 * Fixed windows aligned to the clock and stored in PostgreSQL, so every hosted instance shares
 * one counter per key. One upsert per hit; keys go through storedKeyHash. A hit that LocalShed
 * proves the shared limiter would refuse is refused without the upsert (`shedHits` counts them).
 * Expired rows are removed opportunistically in bounded batches. If the database is unavailable,
 * fail-closed buckets deny with FAIL_CLOSED_RETRY_MS and degraded buckets use the per-instance
 * memory limiter at a reduced limit (see outageMode). `outages` counts both, per mode.
 */
export class PostgresRateLimiter implements RateLimiter {
  private hits = 0;
  constructor(
    private readonly db: Database,
    private readonly now: () => number = Date.now,
    private readonly fallback: RateLimiter = new MemoryRateLimiter(now),
    private readonly cleanupEvery = 200,
    private readonly report: (
      mode: LimiterOutageMode,
      cause: LimiterOutageCause,
    ) => void = throttledOutageLog(now),
    private readonly strict = strictClassificationDefault(),
    /** The per-instance pre-check; null sends every hit to the database. */
    private readonly shed: LocalShed | null = new LocalShed(),
  ) {}
  readonly outages = { 'fail-closed': 0, degraded: 0 };
  /** Outage decisions caused by a pool acquisition timeout (a subset of `outages`). */
  poolTimeouts = 0;
  /** Hits refused by the per-instance pre-check without a database query. */
  shedHits = 0;
  private outage(key: string, error: unknown): LimiterOutageMode {
    const mode = outageMode(key);
    const cause = outageCause(error);
    this.outages[mode]++;
    if (cause === 'pool-timeout') this.poolTimeouts++;
    this.report(mode, cause);
    return mode;
  }
  async hit(key: string, limit: number, windowMs: number): Promise<RateLimitResult> {
    if (this.strict) assertClassified(key);
    const time = this.now();
    const shedRetryAfterMs = this.shed?.refuse(key, limit, windowMs, time) ?? null;
    if (shedRetryAfterMs !== null) {
      this.shedHits++;
      return { allowed: false, retryAfterMs: shedRetryAfterMs };
    }
    const windowStart = windowStartOf(time, windowMs);
    const keyHash = storedKeyHash(windowMs, key);
    let row: { count: number | string; expires_at: number | string } | undefined;
    try {
      row = (
        await this.db.query<{ count: number | string; expires_at: number | string }>(
          `INSERT INTO rate_limits(key_hash,window_start,count,expires_at) VALUES($1,$2,1,$3)
           ON CONFLICT (key_hash) DO UPDATE SET
             count = CASE WHEN rate_limits.window_start >= EXCLUDED.window_start
               THEN LEAST(rate_limits.count + 1, 2147483647) ELSE 1 END,
             window_start = GREATEST(rate_limits.window_start, EXCLUDED.window_start),
             expires_at = GREATEST(rate_limits.expires_at, EXCLUDED.expires_at)
           RETURNING count,expires_at`,
          [keyHash, windowStart, windowStart + windowMs],
        )
      ).rows[0];
    } catch (error) {
      if (this.outage(key, error) === 'fail-closed')
        return { allowed: false, retryAfterMs: FAIL_CLOSED_RETRY_MS };
      return this.fallback.hit(
        key,
        Math.max(1, Math.floor(limit / DEGRADED_LIMIT_DIVISOR)),
        windowMs,
      );
    }
    if (row) this.shed?.counted(key, limit, windowMs, windowStart, Number(row.expires_at), time);
    if (++this.hits % this.cleanupEvery === 0) await this.cleanup(time);
    const count = Number(row?.count ?? 1);
    return count > limit
      ? { allowed: false, retryAfterMs: Math.max(1, Number(row!.expires_at) - time) }
      : { allowed: true, retryAfterMs: 0 };
  }
  async count(key: string, windowMs: number): Promise<number> {
    if (this.strict) assertClassified(key);
    const time = this.now();
    const windowStart = windowStartOf(time, windowMs);
    const keyHash = storedKeyHash(windowMs, key);
    try {
      const row = (
        await this.db.query<{ count: number | string }>(
          'SELECT count FROM rate_limits WHERE key_hash=$1 AND window_start>=$2',
          [keyHash, windowStart],
        )
      ).rows[0];
      return Number(row?.count ?? 0);
    } catch (error) {
      // Callers compare the count with their limit: a fail-closed bucket reads as exhausted, and a
      // degraded one scales its per-instance count as the reduced hit limit does.
      if (this.outage(key, error) === 'fail-closed') return Number.MAX_SAFE_INTEGER;
      return (await this.fallback.count(key, windowMs)) * DEGRADED_LIMIT_DIVISOR;
    }
  }
  /** Deletes at most `batch` expired windows. */
  async cleanup(time = this.now(), batch = 500): Promise<void> {
    try {
      await this.db.query(
        'DELETE FROM rate_limits WHERE key_hash IN (SELECT key_hash FROM rate_limits WHERE expires_at<=$1 LIMIT $2)',
        [time, batch],
      );
    } catch {
      // Cleanup is best effort; counters stay correct because windows are keyed by start time.
    }
  }
}

/**
 * Limiter key for a client address. IPv4 (including IPv4-mapped IPv6) is used as is; IPv6 is
 * grouped by its /64 prefix, because a single subscriber usually controls a whole /64 and could
 * otherwise rotate addresses to evade per-address limits. Use for every address-keyed limit.
 */
export function clientAddressKey(ip: string): string {
  const address = ip
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/%.*$/, '');
  const mapped = /^(?:::|(?:0{1,4}:){5})ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(address);
  if (mapped) return mapped[1]!;
  // IPv4-mapped IPv6 in hex form (::ffff:c000:201) is the IPv4 address 192.0.2.1.
  const mappedHex = /^(?:::|(?:0{1,4}:){5})ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(address);
  if (mappedHex) {
    const high = Number.parseInt(mappedHex[1]!, 16);
    const low = Number.parseInt(mappedHex[2]!, 16);
    return [high >> 8, high & 255, low >> 8, low & 255].join('.');
  }
  if (!address.includes(':')) return address;
  const [head = '', tail = ''] = address.split('::');
  const left = head ? head.split(':') : [];
  const right = address.includes('::') ? (tail ? tail.split(':') : []) : [];
  if (right.length && right[right.length - 1]!.includes('.')) right.splice(-1, 1, '0', '0');
  const groups = address.includes('::')
    ? [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right]
    : left;
  return `${groups
    .slice(0, 4)
    .map((group) => (group || '0').replace(/^0+(?=.)/, ''))
    .join(':')}::/64`;
}

/**
 * Nested address scopes for anti-flood limits on anonymous (unclaimed) creation. `source` is
 * exactly `clientAddressKey(ip)` (IPv4 address or IPv6 /64); `site` is the IPv6 /56 (IPv4 /24)
 * `network` the IPv6 /48 (IPv4 /16) and `region` the IPv6 /32 (IPv4 /8), because one subscriber or hoster commonly controls a
 * whole /56 or /48 and could otherwise rotate /64s to multiply every per-source limit.
 */
export function clientAddressPrefixes(ip: string): {
  source: string;
  site: string;
  network: string;
  region: string;
} {
  const source = clientAddressKey(ip);
  if (!source.endsWith('::/64')) {
    const octets = source.split('.');
    if (octets.length !== 4) return { source, site: source, network: source, region: source };
    return {
      source,
      site: `${octets.slice(0, 3).join('.')}.0/24`,
      network: `${octets.slice(0, 2).join('.')}.0.0/16`,
      region: `${octets[0]}.0.0.0/8`,
    };
  }
  const groups = source.slice(0, -'::/64'.length).split(':');
  const fourth = Number.parseInt(groups[3] ?? '0', 16);
  const siteGroup = (Number.isFinite(fourth) ? fourth & 0xff00 : 0).toString(16);
  const head = groups.slice(0, 3).join(':');
  return {
    source,
    site: `${head}:${siteGroup}::/56`,
    network: `${head}::/48`,
    region: `${groups.slice(0, 2).join(':')}::/32`,
  };
}

/** A bearer credential that names a principal: guest room credential, workspace key, OAuth access. */
const PRINCIPAL_BEARER = /^Bearer ((crc|ccw|cca)_[A-Za-z0-9_-]{43})$/;
/** How far above the per-principal request limit the per-address floor for credentialed traffic sits. */
export const PRINCIPAL_ADDRESS_FACTOR = 10;

/**
 * Resolvers from a presented credential to a stable principal id. Sessions, workspace keys and
 * OAuth grants share one bucket per owner (`owner-api:`), so minting more keys or grants does not
 * multiply an owner's budget; each guest room credential is its own agent (`guest-api:`).
 * Each returns null for an
 * unknown, revoked or expired credential. A resolver left out means that credential kind is not
 * accepted on this surface (it is then treated as no credential at all: per address).
 */
export interface PrincipalResolvers {
  guest?: (token: string) => Promise<{ agent_id: string } | null>;
  workspaceKey?: (token: string) => Promise<{ operatorId: string } | null>;
  accessToken?: (token: string) => Promise<{ operatorId: string } | null>;
  /** A session cookie value; resolves to the operator id. */
  session?: (token: string) => Promise<string | null>;
}

/** A credential presented on a request: an opaque token and how to resolve it to a limiter key. */
export interface PresentedPrincipal {
  /** Cache key: kind plus the token (hashed before it is stored). */
  token: string;
  resolve: () => Promise<string | null>;
}

/**
 * The credential a request presents, if any, in the shape `limitRequestRate` takes. A recognised
 * bearer wins over a session cookie. Only the format is checked here; validity is resolved later,
 * after the per-address floor is charged.
 */
export function presentedPrincipal(
  authorization: string | undefined,
  sessionCookie: string | undefined,
  r: PrincipalResolvers,
): PresentedPrincipal | null {
  const bearer = PRINCIPAL_BEARER.exec(authorization ?? '');
  if (bearer) {
    const token = bearer[1]!;
    const kind = bearer[2]!;
    if (kind === 'crc' && r.guest) {
      const guest = r.guest;
      return {
        token,
        resolve: async () => {
          const found = await guest(token);
          return found ? `guest-api:${found.agent_id}` : null;
        },
      };
    }
    if (kind === 'ccw' && r.workspaceKey) {
      const verify = r.workspaceKey;
      return {
        token,
        resolve: async () => {
          const found = await verify(token);
          return found ? `owner-api:${found.operatorId}` : null;
        },
      };
    }
    if (kind === 'cca' && r.accessToken) {
      const verify = r.accessToken;
      return {
        token,
        resolve: async () => {
          const found = await verify(token);
          return found ? `owner-api:${found.operatorId}` : null;
        },
      };
    }
  }
  if (sessionCookie && sessionCookie.length <= 128 && r.session) {
    const verify = r.session;
    return {
      token: `session:${sessionCookie}`,
      resolve: async () => {
        const operator = await verify(sessionCookie);
        return operator ? `owner-api:${operator}` : null;
      },
    };
  }
  return null;
}

/**
 * Short-lived, bounded memo of credential -> principal key, so the per-request limit does not add
 * a database round trip for every request of an active principal. Only valid credentials are
 * remembered (an invalid one is resolved again, behind the address floor). A credential revoked
 * within the TTL keeps its principal bucket for at most that long; the route still rejects it.
 */
export class PrincipalCache {
  private readonly entries = new Map<string, { key: string; expires: number }>();
  constructor(
    private readonly clock: () => number = Date.now,
    private readonly ttlMs = 60_000,
    readonly maxEntries = 50_000,
  ) {}
  get size(): number {
    return this.entries.size;
  }
  async resolve(presented: PresentedPrincipal): Promise<string | null> {
    const id = createHash('sha256').update(presented.token).digest('base64url');
    const time = this.clock();
    const hit = this.entries.get(id);
    if (hit && hit.expires > time) return hit.key;
    if (hit) this.entries.delete(id);
    const key = await presented.resolve();
    if (key) {
      if (this.entries.size >= this.maxEntries)
        this.entries.delete(this.entries.keys().next().value!);
      this.entries.set(id, { key, expires: time + this.ttlMs });
    }
    return key;
  }
}

/**
 * The general request limit. AI agents and assistants of thousands of unrelated people share the
 * egress addresses of their cloud providers, so a request carrying a valid credential (session
 * cookie, workspace key, OAuth access token, guest room credential) is limited per principal
 * (`perMinute`), with the address kept as a floor `PRINCIPAL_ADDRESS_FACTOR` times higher
 * (`ip-auth:`). The floor is charged before the credential is resolved, so lookups per address stay
 * bounded; an invalid credential is charged to the plain per-address bucket as well, so garbage
 * tokens buy nothing. Requests without a credential are limited per address (`ip:`), as before.
 */
export async function limitRequestRate(
  limit: (key: string, max: number, windowMs: number) => Promise<void>,
  ip: string,
  presented: PresentedPrincipal | null,
  perMinute: number,
  cache?: PrincipalCache,
): Promise<void> {
  const address = clientAddressKey(ip);
  if (!presented) return limit(`ip:${address}`, perMinute, 60_000);
  await limit(`ip-auth:${address}`, perMinute * PRINCIPAL_ADDRESS_FACTOR, 60_000);
  const principal = cache ? await cache.resolve(presented) : await presented.resolve();
  if (principal) await limit(principal, perMinute, 60_000);
  else await limit(`ip:${address}`, perMinute, 60_000);
}
