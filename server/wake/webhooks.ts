import { createHash, createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import type { Database } from '../database.js';
import {
  createPublicLookup,
  isPublicAddress,
  localOnlyHostName,
  type PublicLookup,
} from '../oauth/clients.js';
import { WAKE_LIMITS, WEBHOOK_BACKOFF_MS } from './contract.js';

/**
 * Wake-up webhooks (docs/WAKE.md). A registered HTTPS endpoint receives a small signed
 * POST (Standard Webhooks format) soon after a message or mention concerns its agent. The body
 * carries ids and sequence numbers only, never message contents: the woken agent reads through
 * its normal, authorized tools.
 *
 * Delivery: the event's transaction coalesces one pending row per webhook into `wake_outbox`;
 * after commit this instance drains the outbox (claim rows in one statement, POST with no
 * database connection held, then settle each row in one statement). Failures back off
 * (WEBHOOK_BACKOFF_MS) for at most WAKE_LIMITS.webhookAttempts attempts.
 */

export type WebhookTransport = (
  url: string,
  body: string,
  headers: Record<string, string>,
  timeoutMs: number,
) => Promise<{ status: number }>;

export class WebhookUrlError extends Error {}

/** https, default port, no credentials or fragment, not a literal private or loopback address. */
export function validateWebhookUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new WebhookUrlError('The webhook url is not a valid URL.');
  }
  if (url.protocol !== 'https:' || (url.port && url.port !== '443'))
    throw new WebhookUrlError('Webhook urls must use https on the default port.');
  if (url.username || url.password || url.hash)
    throw new WebhookUrlError('Webhook urls cannot carry credentials or a fragment.');
  const host = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname;
  // The outbound fetchers' one static host rule (trailing dots stripped, every local suffix).
  if (isIP(host) ? !isPublicAddress(host) : localOnlyHostName(host))
    throw new WebhookUrlError('Webhook urls must point to a public host.');
  return url;
}

/** A webhook root key and its public id (a fingerprint, safe to send). */
export interface WebhookKey {
  kid: string;
  key: string;
}
/** Public, non-secret id of a root key, sent as `webhook-key-id` so receivers can tell keys apart. */
export function webhookKeyId(key: string): string {
  return `k_${createHash('sha256').update(`central-city/wake-kid:${key}`).digest('hex').slice(0, 12)}`;
}
/**
 * The wake root key, separate from every other secret: CITY_WAKE_SECRET when set, else
 * HKDF-SHA256(CITY_RATE_LIMIT_KEY, info 'central-city/wake-webhook/v1'). During a rotation
 * CITY_WAKE_SECRET_PREVIOUS keeps signing alongside (docs/WAKE.md).
 */
export function wakeKeys(env: Record<string, string | undefined>, fallback: string): WebhookKey[] {
  const derive = (ikm: string) =>
    Buffer.from(hkdfSync('sha256', ikm, '', 'central-city/wake-webhook/v1', 32)).toString('hex');
  const current = env.CITY_WAKE_SECRET || derive(env.CITY_RATE_LIMIT_KEY || fallback);
  const keys = [current, ...(env.CITY_WAKE_SECRET_PREVIOUS ? [env.CITY_WAKE_SECRET_PREVIOUS] : [])];
  return [...new Set(keys)].map((key) => ({ kid: webhookKeyId(key), key }));
}

/** Derived signing secret (never stored): `whsec_` + base64 of 32 bytes. */
export function webhookSecret(serverSecret: string, id: string, salt: string): string {
  const key = createHmac('sha256', serverSecret).update(`wake-webhook:${id}:${salt}`).digest();
  return `whsec_${key.toString('base64')}`;
}

/** Standard Webhooks signature: `v1,` + base64(HMAC-SHA256(key, `${id}.${timestamp}.${body}`)). */
export function signWebhook(secret: string, id: string, timestamp: number, body: string): string {
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  return `v1,${createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64')}`;
}

/** Receiver-side check (reference for clients and tests): signature and a 5-minute window. */
export function verifyWebhook(
  secret: string,
  headers: Record<string, string | undefined>,
  body: string,
  nowSeconds = Math.floor(Date.now() / 1000),
  toleranceSeconds = 300,
): boolean {
  const id = headers['webhook-id'],
    stamp = headers['webhook-timestamp'],
    signature = headers['webhook-signature'];
  if (!id || !stamp || !signature || !/^\d{1,12}$/.test(stamp)) return false;
  if (Math.abs(nowSeconds - Number(stamp)) > toleranceSeconds) return false;
  const expected = Buffer.from(signWebhook(secret, id, Number(stamp), body));
  return signature.split(' ').some((candidate) => {
    const given = Buffer.from(candidate);
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}

/**
 * Production transport, with the Client ID Metadata Document fetcher's rules: https only,
 * public addresses only (checked at connection time, so DNS rebinding cannot reach private
 * ranges), no redirects (a 3xx is a failure), a strict timeout, response body discarded.
 */
export const httpsWebhookTransport: WebhookTransport = createHttpsWebhookTransport();

/** The production transport; `lookup` replaces the public-address lookup in tests. */
export function createHttpsWebhookTransport(
  options: { lookup?: PublicLookup } = {},
): WebhookTransport {
  return (url, body, headers, timeoutMs) =>
    new Promise((resolve, reject) => {
      let target: URL;
      try {
        target = validateWebhookUrl(url);
      } catch (error) {
        return reject(error);
      }
      // The deadline also cancels a host name lookup still waiting on the name servers.
      const lookups = new AbortController();
      let settled = false;
      const finish = (action: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        lookups.abort();
        action();
      };
      const req = httpsRequest(
        target,
        {
          method: 'POST',
          headers: { ...headers, 'content-length': String(Buffer.byteLength(body)) },
          lookup: (options.lookup ?? createPublicLookup({ signal: lookups.signal })) as never,
          agent: false,
        },
        (res) => {
          let length = 0;
          res.on('data', (chunk: Buffer) => {
            length += chunk.length;
            if (length > 4096) req.destroy();
          });
          res.on('error', () => {});
          res.on('end', () => finish(() => resolve({ status: res.statusCode ?? 0 })));
          res.on('close', () => finish(() => resolve({ status: res.statusCode ?? 0 })));
        },
      );
      const timer = setTimeout(() => {
        req.destroy();
        finish(() => reject(new Error('timeout')));
      }, timeoutMs);
      // A host that resolves only to private addresses reads as any other network failure, so the
      // stored status does not tell which internal names exist.
      req.on('error', () => finish(() => reject(new Error('network'))));
      req.end(body);
    });
}

/** Wake target kinds (migration 26): signed HTTPS webhooks, and hosted responders. */
export type WakeTargetKind = 'https' | 'responder';

/**
 * What an in-process target handler (the responder) did with a claimed wake-up:
 * - `done`: nothing is left to do; the row is deleted (a newer coalesced version is kept);
 * - `retry`: work remains; the row is rescheduled at `at`. There is no attempt-based drop for
 *   handler kinds (review B3): the handler's own expiry bounds the work;
 * - `paused`: the target was disabled by the handler; its row is deleted.
 */
export type TargetOutcome =
  { outcome: 'done' } | { outcome: 'retry'; at: number } | { outcome: 'paused' };

export type Claimed = {
  webhook_id: string;
  agent_id: string;
  kinds: string[];
  event: Record<string, unknown>;
  pending: number;
  version: number;
  attempts: number;
  first_at: string | number;
  url: string | null;
  salt: string;
  owner_id: string;
};

export interface Outbox {
  /**
   * Delivers due wake-ups; waits in-process up to `budgetMs` for short backoffs. The drain has an
   * absolute deadline (now + budgetMs): after its first pass it starts a pass only while at least
   * `minPassMs` is left, and a call that joins a running drain waits at most its own budget.
   */
  drain(budgetMs?: number): Promise<number>;
  /** Deliveries attempted by this instance (tests, metrics). */
  readonly attempts: number;
  /** Stops waiting for retries (app shutdown). */
  close(): void;
}

export function createOutbox(d: {
  db: Pick<Database, 'query'>;
  clock: () => number;
  /** Root keys; the first is current. Every delivery is signed with each. */
  keys: WebhookKey[];
  transport: WebhookTransport;
  /** Delivery attempts before a pending wake-up is dropped (default WAKE_LIMITS.webhookAttempts). */
  maxAttempts?: number;
  /**
   * The target kind this outbox drains (default 'https'). Every query filters by it inside the
   * claim subquery, so one kind's rows never fill another kind's window (review B2).
   */
  kind?: WakeTargetKind;
  /** How long a claimed row stays locked (default: webhook timeout + 15 s). */
  lockMs?: number;
  /** Rows claimed per pass (default 20). */
  claimLimit?: number;
  /**
   * In-process handler for non-HTTP kinds (the responder). `deadline` is the wall-clock time by
   * which the handler must be done (review B5).
   */
  handler?: (row: Claimed, deadline: number) => Promise<TargetOutcome>;
  /**
   * Least time left to start another pass (default: webhook timeout + 1 s). A pass that starts
   * then ends by the deadline: HTTPS deliveries time out, and the handler gets the deadline.
   */
  minPassMs?: number;
}): Outbox {
  const maxAttempts = d.maxAttempts ?? WAKE_LIMITS.webhookAttempts;
  const kind: WakeTargetKind = d.kind ?? 'https';
  const lockMs = d.lockMs ?? 15_000 + WAKE_LIMITS.webhookTimeoutMs;
  const claimLimit = d.claimLimit ?? 20;
  const minPassMs = d.minPassMs ?? WAKE_LIMITS.webhookTimeoutMs + 1_000;
  /** Handler deadline of the current pass, on `d.clock()` (the clock the handler compares with). */
  let deadline = 0;
  /** Absolute wall-clock deadline of the running drain (Date.now()). */
  let until = 0;
  let running: Promise<number> | null = null;
  let again = false;
  let rerun = false;
  let kick: (() => void) | undefined;
  let attempts = 0;
  let closed = false;

  async function pass(): Promise<number> {
    const time = d.clock();
    const claimed = (
      await d.db.query<Claimed>(
        `UPDATE wake_outbox o SET locked_until=$1+$2, attempts=o.attempts+1
         FROM wake_webhooks w
         WHERE w.id=o.webhook_id AND w.disabled_at IS NULL AND o.webhook_id IN (
           -- Only live targets of this kind: rows of a disabled webhook or of another kind must
           -- never fill the claim window (review B1, B2).
           SELECT o2.webhook_id FROM wake_outbox o2 JOIN wake_webhooks w2 ON w2.id=o2.webhook_id
           WHERE o2.kind=$3 AND w2.disabled_at IS NULL AND o2.next_attempt_at<=$1
             AND (o2.locked_until IS NULL OR o2.locked_until<$1)
           ORDER BY o2.next_attempt_at, o2.webhook_id LIMIT $4 FOR UPDATE OF o2 SKIP LOCKED)
         RETURNING o.webhook_id, o.agent_id, o.kinds, o.event, o.pending, o.version, o.attempts, o.first_at, w.url, w.salt, w.owner_id`,
        [time, lockMs, kind, claimLimit],
      )
    ).rows;
    await Promise.all(claimed.map((row) => (d.handler ? handle(row) : deliver(row))));
    return claimed.length;
  }

  /** In-process target (responder): the handler decides; no HTTP, no attempt-based drop (B3). */
  async function handle(row: Claimed): Promise<void> {
    attempts++;
    const version = Number(row.version);
    let result: TargetOutcome;
    try {
      result = await d.handler!(row, deadline);
    } catch {
      result = { outcome: 'retry', at: d.clock() + 30_000 };
    }
    const done = d.clock();
    if (result.outcome === 'paused') {
      await d.db.query('DELETE FROM wake_outbox WHERE webhook_id=$1', [row.webhook_id]);
      return;
    }
    if (result.outcome === 'done') {
      const removed = await d.db.query(
        'DELETE FROM wake_outbox WHERE webhook_id=$1 AND version=$2 RETURNING webhook_id',
        [row.webhook_id, version],
      );
      if (removed.rows.length) return;
      // Mentions arrived while this ran: handle the newer version right away.
      await d.db.query(
        'UPDATE wake_outbox SET locked_until=NULL, attempts=0, next_attempt_at=$2 WHERE webhook_id=$1',
        [row.webhook_id, done],
      );
      again = true;
      return;
    }
    await d.db.query(
      'UPDATE wake_outbox SET locked_until=NULL, next_attempt_at=$2 WHERE webhook_id=$1',
      [row.webhook_id, Math.max(result.at, done)],
    );
  }

  async function deliver(row: Claimed): Promise<void> {
    attempts++;
    if (row.url === null) return; // not an HTTPS target (kind filter makes this unreachable)
    const time = d.clock();
    const version = Number(row.version);
    const id = `evt_${createHash('sha256').update(`${row.webhook_id}:${row.first_at}:${version}`).digest('base64url').slice(0, 24)}`;
    const body = JSON.stringify({
      type: 'city.wake',
      agent_id: row.agent_id,
      kinds: row.kinds,
      pending: Number(row.pending),
      first_at: new Date(Number(row.first_at)).toISOString(),
      latest: row.event,
      sent_at: new Date(time).toISOString(),
    });
    const timestamp = Math.floor(time / 1000);
    let status = 'error';
    let ok = false;
    try {
      const response = await d.transport(
        row.url!,
        body,
        {
          'content-type': 'application/json',
          'user-agent': 'central-city-wake/1',
          'webhook-id': id,
          'webhook-timestamp': String(timestamp),
          // Standard Webhooks allows several space-separated signatures: one per live root key
          // (current first), so a receiver keeps verifying through a key rotation.
          'webhook-signature': d.keys
            .map((key) =>
              signWebhook(webhookSecret(key.key, row.webhook_id, row.salt), id, timestamp, body),
            )
            .join(' '),
          'webhook-key-id': d.keys.map((key) => key.kid).join(' '),
        },
        WAKE_LIMITS.webhookTimeoutMs,
      );
      status = String(response.status);
      ok = response.status >= 200 && response.status < 300;
    } catch (error) {
      status = error instanceof Error && error.message.length < 32 ? error.message : 'error';
    }
    const done = d.clock();
    if (ok) {
      const removed = await d.db.query(
        'DELETE FROM wake_outbox WHERE webhook_id=$1 AND version=$2 RETURNING webhook_id',
        [row.webhook_id, version],
      );
      // Events that arrived during delivery coalesced into a newer version: send that now.
      if (!removed.rows.length) {
        await d.db.query(
          'UPDATE wake_outbox SET locked_until=NULL, attempts=0, next_attempt_at=$2, pending=GREATEST(1, pending-$3) WHERE webhook_id=$1',
          [row.webhook_id, done, Number(row.pending)],
        );
        again = true;
      }
      await d.db.query(
        'UPDATE wake_webhooks SET last_success_at=$2, last_status=$3, consecutive_failures=0 WHERE id=$1',
        [row.webhook_id, done, status],
      );
      return;
    }
    const tries = Number(row.attempts);
    if (tries >= maxAttempts) {
      // Drop only the version that failed; a newer coalesced wake-up starts a fresh series.
      const dropped = await d.db.query(
        'DELETE FROM wake_outbox WHERE webhook_id=$1 AND version=$2 RETURNING webhook_id',
        [row.webhook_id, version],
      );
      if (!dropped.rows.length) {
        await d.db.query(
          'UPDATE wake_outbox SET locked_until=NULL, attempts=0, next_attempt_at=$2, pending=GREATEST(1, pending-$3) WHERE webhook_id=$1',
          [row.webhook_id, done, Number(row.pending)],
        );
        again = true;
      }
    } else
      await d.db.query(
        'UPDATE wake_outbox SET locked_until=NULL, next_attempt_at=$2 WHERE webhook_id=$1',
        [
          row.webhook_id,
          done + WEBHOOK_BACKOFF_MS[Math.min(tries, WEBHOOK_BACKOFF_MS.length - 1)]!,
        ],
      );
    await d.db.query(
      `UPDATE wake_webhooks SET last_failure_at=$2, last_status=$3, consecutive_failures=consecutive_failures+1,
         disabled_at=CASE WHEN consecutive_failures+1 >= $4 THEN $2 ELSE disabled_at END WHERE id=$1`,
      [row.webhook_id, done, status, WAKE_LIMITS.webhookDisableAfter],
    );
    // A webhook that was just disabled keeps no pending wake-up; re-registering starts fresh.
    await d.db.query(
      `DELETE FROM wake_outbox o USING wake_webhooks w
       WHERE o.webhook_id=$1 AND w.id=o.webhook_id AND w.disabled_at IS NOT NULL`,
      [row.webhook_id],
    );
  }

  const left = () => until - Date.now();

  async function run(first: boolean): Promise<number> {
    let total = 0;
    for (let round = 0; round < 50 && !closed; round++) {
      // No pass starts that could not finish by the drain's deadline.
      if (!(first && round === 0) && left() < minPassMs) break;
      deadline = d.clock() + Math.max(0, left());
      again = false;
      const count = await pass();
      total += count;
      if (count === claimLimit || again || rerun) {
        rerun = false;
        continue;
      }
      // Wait in-process for a retry that is due within the budget (short backoffs only).
      const next = (
        await d.db.query<{ at: string | number | null }>(
          `SELECT min(o.next_attempt_at) AS at FROM wake_outbox o JOIN wake_webhooks w ON w.id=o.webhook_id
           WHERE o.kind=$2 AND w.disabled_at IS NULL AND (o.locked_until IS NULL OR o.locked_until < $1)`,
          [d.clock(), kind],
        )
      ).rows[0]?.at;
      if (next === null || next === undefined) break;
      const delay = Number(next) - d.clock();
      if (delay > left() - minPassMs) break;
      // A new signal (kick) ends the wait early so fresh wake-ups never queue behind a backoff.
      if (delay > 0)
        await new Promise<void>((resolve) => {
          const timer = setTimeout(done, delay);
          function done() {
            clearTimeout(timer);
            kick = undefined;
            resolve();
          }
          kick = done;
        });
    }
    return total;
  }

  /** `work`, or `fallback` once `ms` have passed, whichever comes first. */
  function within<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([
      work.finally(() => clearTimeout(timer)),
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), Math.max(0, ms));
        timer.unref?.();
      }),
    ]);
  }

  return {
    drain(budgetMs = 0) {
      // One drain at a time per instance; a signal during a drain runs one more pass after it.
      if (closed) return Promise.resolve(0);
      const mine = Date.now() + budgetMs;
      if (running) {
        rerun = true;
        // The shared deadline never moves past a live caller's own deadline, and this caller
        // waits at most its own budget (no restarted budget).
        until = Math.max(until, mine);
        kick?.();
        return budgetMs > 0 ? within(running, budgetMs, 0) : running;
      }
      until = mine;
      running = (async () => {
        let total = 0;
        let first = true;
        try {
          do {
            rerun = false;
            total += await run(first);
            first = false;
          } while (rerun && !closed && left() >= minPassMs);
        } finally {
          // Cleared synchronously with the last check; a signal after it starts a new drain, and
          // one left behind by the deadline is picked up by the scheduled drain.
          running = null;
        }
        return total;
      })();
      return running;
    },
    get attempts() {
      return attempts;
    },
    close() {
      closed = true;
      kick?.();
    },
  };
}
