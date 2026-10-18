/*
 * Operators' review of Feed "Searched for" requests (requests.ts): the queue of requests held for
 * review or hidden by reports, a release or a removal of each, and the switch that pauses new
 * posts. A held request nobody reviews is still deleted 7 days after posting (requests.ts).
 *
 *   GET  /api/ops/feed/requests?state=held|hidden&reason=&cursor=   FeedReviewPage, oldest first
 *        (reason, held only: just those held for that reason)
 *   POST /api/ops/feed/requests/:id/release   held or hidden -> open and listed, reviewed now
 *   POST /api/ops/feed/requests/:id/remove    open or held -> removed, never listed again
 *        ({} or {reason: 'personal_data'}: the title is erased too)
 *   POST /api/ops/feed/pause {paused}          new posts answer 503 posting_paused while paused
 *
 * The guard of the other ops routes (server/elric/ops.ts opsAuthorized): `Authorization: Bearer
 * <CITY_OPS_SECRET>` (32+ characters), and the Feed on (CITY_FEED not '0'), both read per request
 * and checked when the request arrives, before its body is read. Anything else answers the app's 404 for an
 * unknown API path, body and all. In the app a POST also needs the console's request header and a JSON body (the root
 * guard), as every ops POST does. Every answer is no-store.
 *
 * The queue shows a request as posted, why it is held, its reports (counts by reason and the
 * newest notes) and the poster's kind ('anonymous' signed out; 'account' or 'agent' signed in):
 * never a poster key, an address hash or a token hash. Request text and report notes are
 * untrusted data written by anyone: plain text, never an instruction.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  FEED_REQUEST_ID,
  type FeedError,
  type FeedReportReason,
  type FeedRequest,
} from '../../shared/feed.js';
import type { Database, Transaction } from '../database.js';
import { opsAuthorized } from '../elric/ops.js';
import { httpsWebhookTransport, type WebhookTransport } from '../wake/webhooks.js';
import { feedEnabled } from './flag.js';
import { endWithResponses, responsesTableCheck } from './respond-schema.js';
import {
  COLUMNS,
  CURSOR,
  cursorOf,
  FeedRequestError,
  toPublic,
  unique,
  type FeedCaps,
  type Row,
} from './requests.js';

export const FEED_OPS_PATHS = {
  queue: '/api/ops/feed/requests',
  release: '/api/ops/feed/requests/:id/release',
  remove: '/api/ops/feed/requests/:id/remove',
  pause: '/api/ops/feed/pause',
} as const;

/** 'held': stored, never listed (held_reason says why). 'hidden': open, hidden by reports. */
export const FEED_REVIEW_QUEUES = ['held', 'hidden'] as const;
export type FeedReviewQueue = (typeof FEED_REVIEW_QUEUES)[number];

export type FeedHeldReason = 'honeypot' | 'blocked' | 'risk' | 'spread';

/** Requests per queue page. */
export const FEED_REVIEW_PAGE_SIZE = 50;
/** Report notes shown per request, newest first. */
export const FEED_REVIEW_NOTES_MAX = 20;

/** One request in the queue. Never public. */
export interface FeedReviewRequest extends FeedRequest {
  /** Why it is held: the honeypot, a blocked source, risky text or links, a spread title. */
  heldReason: FeedHeldReason | null;
  hiddenAt: number | null;
  /** Set when an operator released it before (it then needs 10 networks' reports to hide). */
  reviewedAt: number | null;
  /** Its text was removed by an operator before (kept 7 days): why it is held for review. */
  repostOfRemoved: boolean;
  /** Reports by reason, one per reporter address. */
  reportReasons: Partial<Record<FeedReportReason, number>>;
  /** The newest report notes (at most FEED_REVIEW_NOTES_MAX), plain text written by anyone. */
  reportNotes: Array<{ reason: FeedReportReason; note: string; createdAt: number }>;
}

export interface FeedPostingState {
  paused: boolean;
  /** When an operator last switched it; null when never switched. */
  updatedAt: number | null;
}

export interface FeedReviewPage {
  state: FeedReviewQueue;
  requests: FeedReviewRequest[];
  /** ?cursor= for the next page (newer ones); null on the last page. */
  next: string | null;
  posting: FeedPostingState;
}

/** What a release or a removal did. */
export interface FeedReviewOutcome {
  id: string;
  state: 'open' | 'removed';
  reviewedAt: number;
  expiresAt: number;
}

export interface FeedReviewDeps {
  db: Database;
  clock?: () => number;
  /** Where CITY_OPS_SECRET and CITY_FEED are read, per request (the app passes process.env). */
  env: Record<string, string | undefined>;
  /** The Feed's event sink (feedEventLog in the app). */
  log?: (event: string, fields: Record<string, unknown>) => void;
  /**
   * The open caps posting holds (requests.ts, the same values: the app passes requests.caps): a
   * release of a held request holds them too.
   */
  caps: Pick<FeedCaps, 'openPerSource' | 'openPerOwner' | 'openGlobal'>;
  /** Tests only: requests per queue page. */
  pageSize?: number;
}

interface ReviewRow extends Row {
  held_reason: FeedHeldReason | null;
  report_count: number;
}

export const FEED_HELD_REASONS: readonly FeedHeldReason[] = [
  'honeypot',
  'blocked',
  'risk',
  'spread',
];

/** The queue query. */
export interface FeedReviewQuery {
  state: FeedReviewQueue;
  /** Held ones only: just those held for this reason. */
  reason: FeedHeldReason | null;
  cursor: string | null;
}

const num = (value: string | number | null) => (value === null ? null : Number(value));

/**
 * Reads the queue query: state is required; reason only with state=held; unknown parameters
 * answer null (400).
 */
export function readFeedReviewQuery(params: Record<string, unknown>): FeedReviewQuery | null {
  for (const key of Object.keys(params))
    if (!['state', 'reason', 'cursor'].includes(key)) return null;
  const state = FEED_REVIEW_QUEUES.find((queue) => queue === params.state);
  if (!state) return null;
  let reason: FeedHeldReason | null = null;
  if (params.reason !== undefined && params.reason !== '') {
    reason = FEED_HELD_REASONS.find((held) => held === params.reason) ?? null;
    if (!reason || state !== 'held') return null;
  }
  if (params.cursor !== undefined && params.cursor !== '') {
    if (typeof params.cursor !== 'string' || !CURSOR.test(params.cursor)) return null;
    return { state, reason, cursor: params.cursor };
  }
  return { state, reason, cursor: null };
}

export function createFeedReview(deps: FeedReviewDeps) {
  const { db } = deps;
  const clock = deps.clock ?? Date.now;
  // Whether Respond's table exists (migration 108, respond-schema.ts; the whole app always has it).
  const hasResponses = responsesTableCheck();
  const log = deps.log ?? (() => {});
  const pageSize = deps.pageSize ?? FEED_REVIEW_PAGE_SIZE;
  const { caps } = deps;

  const refuse = (status: number, code: FeedError['code'], message: string): never => {
    throw new FeedRequestError(status, code, message);
  };
  const notFound = () => refuse(404, 'request_not_found', 'This request is not on the Feed.');
  const gone = () =>
    refuse(409, 'request_closed', 'This request is already closed, expired or removed.');

  async function posting(): Promise<FeedPostingState> {
    const row = (
      await db.query<{ enabled: boolean; updated_at: string | number }>(
        "SELECT enabled, updated_at FROM feed_flags WHERE name='posting'",
      )
    ).rows[0];
    return {
      paused: row !== undefined && !row.enabled,
      updatedAt: row ? Number(row.updated_at) : null,
    };
  }

  /** Oldest first, so what waited longest (and is deleted first) comes first. */
  async function queue(
    state: FeedReviewQueue,
    cursor: string | null,
    reason: FeedHeldReason | null = null,
  ): Promise<FeedReviewPage> {
    const now = clock();
    const params: unknown[] = [];
    const where: string[] = [];
    // A held request stays held past its expiry (it can still be removed); a hidden one leaves
    // the queue when it expires.
    if (state === 'held') {
      where.push("state='held'");
      if (reason) {
        params.push(reason);
        where.push(`held_reason=$${params.length}`);
      }
    } else {
      params.push(now);
      where.push(`state='open' AND hidden_at IS NOT NULL AND expires_at>$${params.length}`);
    }
    const after = cursor ? CURSOR.exec(cursor) : null;
    if (after) {
      params.push(Number(after[1]), `req_${after[2]}`);
      where.push(`(created_at, id) > ($${params.length - 1}, $${params.length})`);
    }
    params.push(pageSize + 1);
    const rows = (
      await db.query<ReviewRow & { repost_of_removed: boolean }>(
        `SELECT ${COLUMNS}, held_reason, report_count,
            EXISTS (SELECT 1 FROM feed_requests AS removed
              WHERE removed.title_key=feed_requests.title_key
                AND removed.content_key=feed_requests.content_key AND removed.state='removed'
                AND coalesce(removed.held_reason, '') NOT IN ('honeypot','blocked'))
              AS repost_of_removed
           FROM feed_requests
          WHERE ${where.join(' AND ')} ORDER BY created_at, id LIMIT $${params.length}`,
        params,
      )
    ).rows;
    const page = rows.slice(0, pageSize);
    const ids = page.map((row) => row.id);
    const reasons = new Map<string, FeedReviewRequest['reportReasons']>();
    const notes = new Map<string, FeedReviewRequest['reportNotes']>();
    if (ids.length) {
      for (const row of (
        await db.query<{ request_id: string; reason: FeedReportReason; reports: string | number }>(
          `SELECT request_id, reason, count(*) AS reports FROM feed_request_reports
            WHERE request_id = ANY($1::text[]) GROUP BY request_id, reason`,
          [ids],
        )
      ).rows)
        reasons.set(row.request_id, {
          ...reasons.get(row.request_id),
          [row.reason]: Number(row.reports),
        });
      for (const row of (
        await db.query<{
          request_id: string;
          reason: FeedReportReason;
          note: string;
          created_at: string | number;
        }>(
          `SELECT request_id, reason, note, created_at FROM (
             SELECT request_id, reason, note, created_at, row_number() OVER (
                 PARTITION BY request_id ORDER BY created_at DESC, reporter_hash) AS n
               FROM feed_request_reports WHERE request_id = ANY($1::text[]) AND note IS NOT NULL
           ) AS newest WHERE n <= $2 ORDER BY created_at DESC`,
          [ids, FEED_REVIEW_NOTES_MAX],
        )
      ).rows)
        notes.set(row.request_id, [
          ...(notes.get(row.request_id) ?? []),
          { reason: row.reason, note: row.note, createdAt: Number(row.created_at) },
        ]);
    }
    const last = page[page.length - 1];
    return {
      state,
      requests: page.map((row) => ({
        ...toPublic(row, now),
        reportCount: Number(row.report_count),
        heldReason: row.held_reason,
        hiddenAt: num(row.hidden_at),
        reviewedAt: num(row.reviewed_at),
        repostOfRemoved: row.repost_of_removed === true,
        reportReasons: reasons.get(row.id) ?? {},
        reportNotes: notes.get(row.id) ?? [],
      })),
      next: rows.length > pageSize && last ? cursorOf(Number(last.created_at), last.id) : null,
      posting: await posting(),
    };
  }

  const outcomeOf = (row: Row): FeedReviewOutcome => ({
    id: row.id,
    state: row.state === 'open' ? 'open' : 'removed',
    reviewedAt: Number(row.reviewed_at),
    expiresAt: Number(row.expires_at),
  });

  /**
   * Held or hidden -> open, listed until its own expiry, never extended: one that expired while
   * in review stays as it is (409 request_closed), so a release never lists stale text. A held
   * request becomes one more open request of its poster, so it holds the open caps posting holds
   * (409 review_conflict over them): an operator never lists more than the poster could post.
   */
  async function release(id: string): Promise<FeedReviewOutcome> {
    const now = clock();
    let released: Row;
    let before: { from: 'held' | 'hidden'; heldReason: FeedHeldReason | null; reportCount: number };
    try {
      released = await db.transaction(async (tx: Transaction) => {
        const poster = (
          await tx.query<{ poster_key: string; poster_kind: string }>(
            'SELECT poster_key, poster_kind FROM feed_requests WHERE id=$1',
            [id],
          )
        ).rows[0];
        if (!poster) return notFound();
        // The poster's posting lock (requests.ts): the cap count holds against a post in flight.
        await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
          `feed-post\n${poster.poster_key}`,
        ]);
        const row = (
          await tx.query<ReviewRow>(
            `SELECT ${COLUMNS}, held_reason, report_count FROM feed_requests WHERE id=$1 FOR UPDATE`,
            [id],
          )
        ).rows[0];
        if (!row) return notFound();
        if (row.state !== 'held' && row.state !== 'open') return gone();
        if (Number(row.expires_at) <= now)
          return refuse(409, 'request_closed', 'This request has expired: it stays as it is.');
        if (row.state === 'open' && row.hidden_at === null)
          return refuse(409, 'review_conflict', 'This request is not in review: it is listed.');
        if (row.state === 'held') {
          // Counted as posting counts them; a hidden one is open, so it is counted already.
          const open = await tx.query<{ mine: string | number; all: string | number }>(
            `SELECT count(*) FILTER (WHERE poster_key=$1) AS mine, count(*) AS all
               FROM feed_requests WHERE state='open' AND expires_at>$2`,
            [poster.poster_key, now],
          );
          const perPoster =
            poster.poster_kind === 'anonymous' ? caps.openPerSource : caps.openPerOwner;
          if (Number(open.rows[0]?.mine ?? 0) >= perPoster)
            return refuse(
              409,
              'review_conflict',
              `Its poster has ${perPoster} open requests already: release it once one ends, or remove it.`,
            );
          if (Number(open.rows[0]?.all ?? 0) >= caps.openGlobal)
            return refuse(409, 'review_conflict', 'The Feed is full right now: release it later.');
        }
        before = {
          from: row.state === 'held' ? 'held' : 'hidden',
          heldReason: row.held_reason,
          reportCount: Number(row.report_count),
        };
        // An open copy past its expiry no longer counts (as when posting): expire it now, with
        // its responses (Respond).
        await endWithResponses(
          tx,
          await hasResponses(tx),
          `UPDATE feed_requests SET state='expired', closed_at=expires_at, reply=NULL
            WHERE content_key=$1 AND state='open' AND expires_at<=$2
            RETURNING id, closed_at AS end_at`,
          [row.content_key, now],
        );
        return (
          await tx.query<Row>(
            // Open again, nothing held about it any more (the log keeps why it was).
            `UPDATE feed_requests SET state='open', hidden_at=NULL, held_reason=NULL, reviewed_at=$2
              WHERE id=$1 RETURNING ${COLUMNS}`,
            [id, now],
          )
        ).rows[0]!;
      });
    } catch (error) {
      // The same text is open and visible already (only one may be): this copy stays in review.
      if (unique(error, 'feed_requests_content'))
        return refuse(
          409,
          'review_conflict',
          'The same text is already open on the Feed. Remove this copy instead.',
        );
      throw error;
    }
    // Logs are the only lasting record of a review: what it was and why.
    log('feed.request_released', { id, ...before! });
    return outcomeOf(released);
  }

  /**
   * Open (listed or hidden) or held -> removed: never listed again, the reply handle erased, its
   * responses (Respond) ended in the same transaction.
   * Whatever its expiry: one past it (held, or open and not swept yet) is removed all the same,
   * which only takes it further off. The row is kept 7 days after the review (requests.ts sweep)
   * and, while kept, the same text posted again is held for review instead of listed. Kept for
   * that hold only (its title_key and content_key): its description, display name and report
   * notes are erased at once. The title stays for the record, unless the removal is for personal
   * data, which the title can be too: the operator says so (reason 'personal_data'), or a report
   * on it gave that reason. Then the title is erased as well and none of the text is kept longer.
   */
  async function remove(
    id: string,
    options: { reason?: 'personal_data' } = {},
  ): Promise<FeedReviewOutcome> {
    const now = clock();
    const result = await db.transaction(async (tx: Transaction) => {
      const row = (
        await tx.query<ReviewRow>(
          `SELECT ${COLUMNS}, held_reason, report_count FROM feed_requests WHERE id=$1 FOR UPDATE`,
          [id],
        )
      ).rows[0];
      if (!row) return null;
      if (row.state !== 'open' && row.state !== 'held') return 'gone' as const;
      const personalData =
        options.reason === 'personal_data' ||
        (
          await tx.query(
            "SELECT 1 FROM feed_request_reports WHERE request_id=$1 AND reason='personal_data' LIMIT 1",
            [id],
          )
        ).rows.length > 0;
      const removed = (
        await tx.query<Row>(
          `UPDATE feed_requests
              SET state='removed', reviewed_at=$2, reply=NULL, description='', display_name=NULL,
                  title=CASE WHEN $3::boolean THEN '' ELSE title END
            WHERE id=$1 RETURNING ${COLUMNS}`,
          [id, now, personalData],
        )
      ).rows[0]!;
      await tx.query('UPDATE feed_request_reports SET note=NULL WHERE request_id=$1', [id]);
      // Its responses (Respond) end with it.
      if (await hasResponses(tx))
        await endWithResponses(tx, true, 'SELECT $1::text AS id, $2::bigint AS end_at', [id, now]);
      return {
        removed,
        before: {
          from: row.state === 'held' ? 'held' : row.hidden_at === null ? 'listed' : 'hidden',
          heldReason: row.held_reason,
          reportCount: Number(row.report_count),
          personalData,
        },
      };
    });
    if (result === null) return notFound();
    if (result === 'gone') return gone();
    log('feed.request_removed', { id, ...result.before });
    return outcomeOf(result.removed);
  }

  /** The 'posting' switch requests.ts reads before every new post (a retry is still answered). */
  async function pause(paused: boolean): Promise<FeedPostingState> {
    const now = clock();
    const wasPaused = await db.transaction(async (tx: Transaction) => {
      const row = (
        await tx.query<{ enabled: boolean }>(
          "SELECT enabled FROM feed_flags WHERE name='posting' FOR UPDATE",
        )
      ).rows[0];
      await tx.query(
        `INSERT INTO feed_flags (name, enabled, updated_at, updated_by) VALUES ('posting', $1, $2, 'ops')
       ON CONFLICT (name) DO UPDATE
         SET enabled=EXCLUDED.enabled, updated_at=EXCLUDED.updated_at, updated_by=EXCLUDED.updated_by`,
        [!paused, now],
      );
      return row !== undefined && !row.enabled;
    });
    // Every switch is logged, one that changes nothing too, with the value before it.
    log(paused ? 'feed.posting_paused' : 'feed.posting_resumed', { wasPaused });
    return { paused, updatedAt: now };
  }

  return { queue, release, remove, pause, posting };
}

const emptyBody = z.object({}).strict();
const removeBody = z.object({ reason: z.literal('personal_data').optional() }).strict();
const pauseBody = z.object({ paused: z.boolean() }).strict();

export function registerFeedReviewRoutes(app: FastifyInstance, deps: FeedReviewDeps): void {
  const review = createFeedReview(deps);

  const fail = (reply: FastifyReply, error: unknown) => {
    if (!(error instanceof FeedRequestError) || error.code === null) throw error;
    return reply.code(error.statusCode).send({
      error: error.message,
      code: error.code,
      retryable: error.retryable,
    } satisfies FeedError);
  };
  const invalid = (reply: FastifyReply, error: string) =>
    reply.code(400).send({ error, code: 'invalid_request', retryable: false } satisfies FeedError);
  /**
   * Route options: the secret and the flag are checked on arrival, before the body is read; a
   * refusal is the ops routes' 404, the same for a missing secret, a wrong one and the flag off.
   */
  const guarded = () => ({
    bodyLimit: 1024,
    onRequest: async (request: FastifyRequest, reply: FastifyReply) => {
      reply.header('Cache-Control', 'no-store');
      if (
        !feedEnabled(deps.env) ||
        !opsAuthorized(request.headers.authorization, deps.env.CITY_OPS_SECRET)
      )
        return reply.code(404).send({ error: 'Unknown API route' });
    },
  });
  const idOf = (request: FastifyRequest) => {
    const id = (request.params as { id?: unknown }).id;
    return typeof id === 'string' && FEED_REQUEST_ID.test(id) ? id : null;
  };

  app.get(FEED_OPS_PATHS.queue, guarded(), async (request, reply) => {
    const query = readFeedReviewQuery((request.query ?? {}) as Record<string, unknown>);
    if (!query)
      return invalid(
        reply,
        'Use state=held or state=hidden, optionally reason (held only: honeypot, blocked, risk or spread) and cursor.',
      );
    return reply.send(await review.queue(query.state, query.cursor, query.reason));
  });

  const reviewRoute = <T>(
    path: string,
    schema: z.ZodType<T>,
    refusal: string,
    act: (id: string, body: T) => Promise<FeedReviewOutcome>,
  ) =>
    app.post(path, guarded(), async (request, reply) => {
      const body = schema.safeParse(request.body ?? {});
      if (!body.success) return invalid(reply, refusal);
      const id = idOf(request);
      if (!id)
        return fail(
          reply,
          new FeedRequestError(404, 'request_not_found', 'This request is not on the Feed.'),
        );
      try {
        return reply.send(await act(id, body.data));
      } catch (error) {
        return fail(reply, error);
      }
    });
  reviewRoute(FEED_OPS_PATHS.release, emptyBody, 'Send an empty JSON object.', (id) =>
    review.release(id),
  );
  reviewRoute(
    FEED_OPS_PATHS.remove,
    removeBody,
    'Send an empty JSON object, or {"reason": "personal_data"}.',
    (id, body) => review.remove(id, body),
  );

  app.post(FEED_OPS_PATHS.pause, guarded(), async (request, reply) => {
    const body = pauseBody.safeParse(request.body ?? {});
    if (!body.success) return invalid(reply, 'Send {paused: true} or {paused: false}.');
    return reply.send(await review.pause(body.data.paused));
  });
}

/** A held or hidden request alerts operators at most once per this window, per kind (per process). */
export const FEED_REVIEW_ALERT_EVERY_MS = 15 * 60_000;
/** Time allowed for the alert webhook. */
const ALERT_TIMEOUT_MS = 5_000;

/** Held requests that alert: risky text and a spread title. */
const ALERTING_HELD_REASONS: ReadonlySet<string> = new Set<FeedHeldReason>(['risk', 'spread']);

const ALERTS: Readonly<Record<string, string>> = {
  'feed.request_held': `Feed: a new request is held for review (${FEED_OPS_PATHS.queue}?state=held).`,
  'feed.request_hidden': `Feed: reports hid a request; it waits for review (${FEED_OPS_PATHS.queue}?state=hidden).`,
};

/**
 * The Feed's event sink (createFeedRequests, the review routes): one JSON line per event, and for
 * a request that became hidden, or held as risky or spread, also a POST to CITY_OPS_ALERT_WEBHOOK when set (read per
 * event; the webhook and transport of the other ops alerts, server/elric/ops.ts), at most once
 * per FEED_REVIEW_ALERT_EVERY_MS per kind: anyone can post, so a flood is one alert. The alert
 * names no request, text or poster (the queue has them). Never throws.
 */
export function feedEventLog(
  env: Record<string, string | undefined>,
  options: {
    transport?: WebhookTransport;
    log?: (line: string) => void;
    clock?: () => number;
  } = {},
): (event: string, fields: Record<string, unknown>) => void {
  const line = options.log ?? ((text: string) => console.warn(text));
  const clock = options.clock ?? Date.now;
  const transport = options.transport ?? httpsWebhookTransport;
  const last = new Map<string, number>();
  return (event, fields) => {
    line(JSON.stringify({ event, ...fields }));
    const text = ALERTS[event];
    const url = env.CITY_OPS_ALERT_WEBHOOK;
    if (!text || !url) return;
    // Anyone can fill the honeypot or post from a blocked source: those wait in the queue
    // (reason=honeypot|blocked) without an alert, so they can neither page operators nor use up
    // the window a real held request needs.
    if (event === 'feed.request_held' && !ALERTING_HELD_REASONS.has(String(fields.reason))) return;
    const now = clock();
    if (now - (last.get(event) ?? -Infinity) < FEED_REVIEW_ALERT_EVERY_MS) return;
    last.set(event, now);
    try {
      void transport(
        url,
        JSON.stringify({ text, event }),
        { 'content-type': 'application/json' },
        ALERT_TIMEOUT_MS,
      )
        .then(({ status }) => {
          if (status < 200 || status >= 300)
            line(JSON.stringify({ event: 'feed.alert_failed', status }));
        })
        .catch(() => line(JSON.stringify({ event: 'feed.alert_failed' })));
    } catch {
      line(JSON.stringify({ event: 'feed.alert_failed' }));
    }
  };
}
