import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Database } from '../server/database.js';
import { createFeedRequests, type FeedCaps } from '../server/feed/requests.js';
import {
  FEED_OPS_PATHS,
  FEED_REVIEW_ALERT_EVERY_MS,
  feedEventLog,
  registerFeedReviewRoutes,
  type FeedReviewOutcome,
  type FeedReviewPage,
} from '../server/feed/review.js';
import { registerFeedRoutes } from '../server/feed/routes.js';
import { FEED_REQUESTS_SQL } from '../server/feed/schema.js';
import { MemoryRateLimiter } from '../server/rate-limit.js';
import {
  FEED_LIMITS,
  FEED_PATHS,
  type FeedRequestPage,
  type PostedFeedRequest,
} from '../shared/feed.js';

/*
 * The operators' review queue of Feed requests (server/feed/review.ts): the ops secret and the
 * CITY_FEED flag, the held and hidden queues, release, removal, the posting pause, the 7-day
 * deletion and the alerts. Runs the public routes and the ops routes on an in-memory database.
 * Synthetic, low-entropy data only.
 */

type Ctx = { after: (fn: () => Promise<unknown> | unknown) => void };

const START = Date.UTC(2026, 9, 13, 12);
const DAY = 86_400_000;
const HASHING = 'feed-review-test-hashing-secret-0123456789';
const OPS = 'feed-review-test-ops-secret-000000000001';
const BEARER = `Bearer ${OPS}`;

interface Harness {
  app: FastifyInstance;
  db: Database;
  env: Record<string, string | undefined>;
  clock: { now: number };
  session: { value: { ownerId: string } | null };
  events: Array<{ event: string } & Record<string, unknown>>;
  sweep: () => Promise<void>;
}

async function harness(
  t: Ctx,
  options: { pageSize?: number; caps?: Partial<FeedCaps> } = {},
): Promise<Harness> {
  const pg = await PGlite.create('memory://');
  t.after(() => pg.close());
  await pg.exec(
    `CREATE TABLE operators (id text PRIMARY KEY);
     INSERT INTO operators SELECT 'ws-' || n FROM generate_series(1, 3) AS n;`,
  );
  await pg.exec(FEED_REQUESTS_SQL);
  const db: Database = {
    query: (sql, params) => pg.query(sql, params) as never,
    exec: (sql) => pg.exec(sql),
    transaction: (action) => pg.transaction((tx) => action(tx as never)),
    close: () => pg.close(),
  };
  const clock = { now: START };
  const limiter = new MemoryRateLimiter(() => clock.now);
  const limit = async (key: string, max: number, windowMs: number) => {
    const result = await limiter.hit(key, max, windowMs);
    if (!result.allowed)
      throw Object.assign(new Error('Too many requests. Try again later.'), { statusCode: 429 });
  };
  const env: Harness['env'] = { CITY_FEED: '1', CITY_OPS_SECRET: OPS };
  const session: Harness['session'] = { value: null };
  const events: Harness['events'] = [];
  const log = (event: string, fields: Record<string, unknown>) => events.push({ event, ...fields });
  const caps: Partial<FeedCaps> = {
    postsPerSourceHour: 50,
    postsPerSourceDay: 50,
    ...options.caps,
  };
  const requests = createFeedRequests({
    db,
    clock: () => clock.now,
    secret: () => HASHING,
    limit,
    caps,
    log,
  });
  const app = Fastify();
  t.after(() => app.close());
  registerFeedRoutes(app, {
    requests,
    enabled: () => env.CITY_FEED === '1',
    limit,
    signedIn: async () => session.value,
  });
  registerFeedReviewRoutes(app, {
    db,
    clock: () => clock.now,
    env,
    log,
    caps: requests.caps,
    ...(options.pageSize ? { pageSize: options.pageSize } : {}),
  });
  return { app, db, env, clock, session, events, sweep: requests.sweep };
}

function body(title: string, extra: Record<string, unknown> = {}) {
  return { title, description: `Details for ${title}.`, idempotencyKey: randomUUID(), ...extra };
}

/** A different /24 site per n, all in one /16 network. */
const ip = (n: number) => `198.51.${n}.7`;
/** A different /16 network per n. */
const far = (n: number) => `10.${n}.0.9`;

async function posted(h: Harness, payload: Record<string, unknown>, from = ip(1)) {
  const response = await h.app.inject({
    method: 'POST',
    url: FEED_PATHS.requests,
    payload,
    remoteAddress: from,
  });
  assert.equal(response.statusCode, 201, response.body);
  return (response.json() as PostedFeedRequest).request;
}

/** Held for review: a risky money request (requests.ts held_reason 'risk'). */
const risky = (h: Harness, title = 'Send money to my cousin abroad', from = ip(1)) =>
  posted(h, body(title), from);

async function hide(h: Harness, id: string, reports: Array<[string, string, string?]>) {
  for (const [from, reason, note] of reports) {
    const response = await h.app.inject({
      method: 'POST',
      url: FEED_PATHS.report.replace(':id', id),
      payload: { reason, ...(note ? { note } : {}) },
      remoteAddress: from,
    });
    assert.equal(response.statusCode, 202);
  }
}

function ops(
  h: Harness,
  method: 'GET' | 'POST',
  url: string,
  payload?: unknown,
  authorization: string | null = BEARER,
) {
  return h.app.inject({
    method,
    url,
    headers: authorization === null ? {} : { authorization },
    ...(method === 'POST' ? { payload: (payload ?? {}) as object } : {}),
  });
}

async function queue(h: Harness, state: 'held' | 'hidden', cursor?: string) {
  const response = await ops(
    h,
    'GET',
    `${FEED_OPS_PATHS.queue}?state=${state}${cursor ? `&cursor=${cursor}` : ''}`,
  );
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.headers['cache-control'], 'no-store');
  return response.json() as FeedReviewPage;
}

const releasePath = (id: string) => FEED_OPS_PATHS.release.replace(':id', id);
const removePath = (id: string) => FEED_OPS_PATHS.remove.replace(':id', id);

async function listed(h: Harness) {
  const response = await h.app.inject({ url: FEED_PATHS.requests });
  return (response.json() as FeedRequestPage).requests.map((request) => request.id);
}

const publicStatus = async (h: Harness, id: string) =>
  (await h.app.inject({ url: FEED_PATHS.request.replace(':id', id) })).statusCode;

test('ops routes: no secret, a wrong or short one, another header and the flag off all answer the same 404', async (t) => {
  const h = await harness(t);
  const held = await risky(h);
  const routes = [
    ['GET', `${FEED_OPS_PATHS.queue}?state=held`],
    ['POST', releasePath(held.id)],
    ['POST', removePath(held.id)],
    ['POST', FEED_OPS_PATHS.pause],
  ] as const;
  const refusals: Array<[string, string | undefined, string | null, string]> = [
    ['no header', OPS, null, '1'],
    ['a wrong secret', OPS, `Bearer ${'x'.repeat(OPS.length)}`, '1'],
    ['the secret without Bearer', OPS, OPS, '1'],
    ['another scheme', OPS, `Basic ${OPS}`, '1'],
    ['no secret configured', undefined, BEARER, '1'],
    ['a short secret configured', 'short-ops-secret', 'Bearer short-ops-secret', '1'],
    ['CITY_FEED off', OPS, BEARER, '0'],
  ];
  for (const [label, configured, header, flag] of refusals) {
    h.env.CITY_OPS_SECRET = configured;
    h.env.CITY_FEED = flag;
    for (const [method, url] of routes) {
      const response = await ops(h, method, url, { paused: true }, header);
      assert.equal(response.statusCode, 404, `${label}: ${method} ${url}`);
      assert.deepEqual(response.json(), { error: 'Unknown API route' }, label);
      assert.equal(response.headers['cache-control'], 'no-store', label);
    }
  }
  // Checked before the body is read: an oversized body answers the same 404.
  h.env.CITY_OPS_SECRET = OPS;
  const big = await ops(
    h,
    'POST',
    FEED_OPS_PATHS.pause,
    { paused: true, pad: 'x'.repeat(5_000) },
    null,
  );
  assert.equal(big.statusCode, 404);
  // Nothing changed: the request is still held, posting is not paused.
  h.env.CITY_FEED = '1';
  const row = await h.db.query<{ state: string }>('SELECT state FROM feed_requests WHERE id=$1', [
    held.id,
  ]);
  assert.equal(row.rows[0]!.state, 'held');
  assert.equal((await h.db.query("SELECT 1 FROM feed_flags WHERE name='posting'")).rows.length, 0);
  // The right secret with the flag on: the queue answers.
  assert.equal((await queue(h, 'held')).requests.length, 1);
});

test('the held queue: oldest first, why each is held, the poster kind, never a key or hash', async (t) => {
  const h = await harness(t);
  const money = await posted(
    h,
    body('Send money to my cousin abroad', {
      capabilities: ['transfer', 'family'],
      budgetUsdc: '25',
      deadline: START + 3 * DAY,
      reply: 'https://desk.example.org/cousin',
      displayName: 'Harbor desk',
    }),
  );
  h.clock.now += 60_000;
  const bot = await posted(
    h,
    body('Translate a short letter', { website: 'https://spam.example' }),
    ip(2),
  );
  h.clock.now += 60_000;
  h.session.value = { ownerId: 'ws-1' };
  const account = await risky(h, 'Need fifty gift cards bought', ip(3));
  h.session.value = null;
  h.clock.now += 60_000;
  const open = await posted(h, body('Paint a garden fence'), ip(4));

  const page = await queue(h, 'held');
  assert.deepEqual(
    page.requests.map((request) => request.id),
    [money.id, bot.id, account.id],
  );
  assert.equal(page.next, null);
  assert.equal(page.state, 'held');
  assert.deepEqual(page.posting, { paused: false, updatedAt: null });
  const [first, second, third] = page.requests;
  assert.deepEqual(first, {
    id: money.id,
    title: 'Send money to my cousin abroad',
    description: 'Details for Send money to my cousin abroad.',
    capabilities: ['transfer', 'family'],
    budget: {
      raw: '25000000',
      decimals: 6,
      display: '25',
      asset: 'USDC',
      network: 'eip155:8453',
    },
    deadline: START + 3 * DAY,
    reply: 'https://desk.example.org/cousin',
    postedBy: { kind: 'anonymous', displayName: 'Harbor desk' },
    status: 'held',
    createdAt: START,
    expiresAt: START + 3 * DAY,
    closedAt: null,
    reportCount: 0,
    heldReason: 'risk',
    hiddenAt: null,
    reviewedAt: null,
    repostOfRemoved: false,
    reportReasons: {},
    reportNotes: [],
  });
  assert.equal(second!.heldReason, 'honeypot');
  assert.deepEqual(third!.postedBy, { kind: 'account', displayName: null });
  assert.equal(third!.heldReason, 'risk');
  assert.ok(!page.requests.some((request) => request.id === open.id));

  // No poster key, address hash, token hash or workspace id is ever in the answer.
  const raw = JSON.stringify(page);
  const secrets = await h.db.query<Record<string, string | null>>(
    `SELECT poster_key, source_hash, site_hash, content_key, manage_hash,
            idempotency_hash, owner_id FROM feed_requests`,
  );
  for (const row of secrets.rows)
    for (const value of Object.values(row)) if (value) assert.ok(!raw.includes(value), value);

  // The alerts name the request, never its text.
  const held = h.events.filter((event) => event.event === 'feed.request_held');
  assert.deepEqual(
    held.map((event) => [event.id, event.reason]),
    [
      [money.id, 'risk'],
      [bot.id, 'honeypot'],
      [account.id, 'risk'],
    ],
  );
  assert.ok(!JSON.stringify(h.events).includes('cousin'));

  // The query: the state is required, nothing else is read.
  for (const query of ['', '?state=open', '?state=held&q=x', '?state=held&cursor=nope']) {
    const response = await ops(h, 'GET', `${FEED_OPS_PATHS.queue}${query}`);
    assert.equal(response.statusCode, 400, query);
    assert.equal(response.json().code, 'invalid_request');
  }
});

test('the hidden queue: report counts by reason and the newest notes', async (t) => {
  const h = await harness(t);
  const request = await posted(h, body('Find a band for a wedding'));
  await hide(h, request.id, [
    [far(1), 'spam'],
    [far(2), 'scam', 'Asks for a deposit before anything.'],
    [far(3), 'spam', 'Posted on every board.'],
  ]);
  assert.deepEqual(await listed(h), []);
  assert.deepEqual(
    h.events.filter((event) => event.event === 'feed.request_hidden'),
    [{ event: 'feed.request_hidden', id: request.id }],
  );
  assert.deepEqual((await queue(h, 'held')).requests, []);
  const [item] = (await queue(h, 'hidden')).requests;
  assert.equal(item!.id, request.id);
  assert.equal(item!.status, 'hidden');
  assert.equal(item!.hiddenAt, START);
  assert.equal(item!.reportCount, 3);
  assert.deepEqual(item!.reportReasons, { spam: 2, scam: 1 });
  assert.deepEqual(item!.reportNotes.map((note) => [note.reason, note.note]).sort(), [
    ['scam', 'Asks for a deposit before anything.'],
    ['spam', 'Posted on every board.'],
  ]);
  // A hidden request leaves the queue when it expires.
  h.clock.now = START + FEED_LIMITS.requestTtlMs + 1;
  assert.deepEqual((await queue(h, 'hidden')).requests, []);
});

test('queue paging: oldest first, no overlap, next null on the last page', async (t) => {
  const h = await harness(t, { pageSize: 2 });
  const ids: string[] = [];
  for (const [n, title] of [
    'Send money to a friend',
    'Need gift cards bought',
    'Send money home',
  ].entries()) {
    ids.push((await risky(h, title, ip(n + 1))).id);
    h.clock.now += 1_000;
  }
  const first = await queue(h, 'held');
  assert.deepEqual(
    first.requests.map((request) => request.id),
    ids.slice(0, 2),
  );
  assert.ok(first.next);
  const second = await queue(h, 'held', first.next!);
  assert.deepEqual(
    second.requests.map((request) => request.id),
    ids.slice(2),
  );
  assert.equal(second.next, null);
});

test('release: a held request is listed until its own expiry; a hidden one again, harder to hide', async (t) => {
  const h = await harness(t);
  const held = await risky(h);
  h.clock.now = START + DAY;
  const response = await ops(h, 'POST', releasePath(held.id));
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.deepEqual(response.json() as FeedReviewOutcome, {
    id: held.id,
    state: 'open',
    reviewedAt: START + DAY,
    expiresAt: held.expiresAt,
  });
  assert.deepEqual(await listed(h), [held.id]);
  assert.equal(await publicStatus(h, held.id), 200);
  assert.deepEqual((await queue(h, 'held')).requests, []);
  assert.ok(
    h.events.some((event) => event.event === 'feed.request_released' && event.id === held.id),
  );
  // Released already: it is not in review any more.
  const again = await ops(h, 'POST', releasePath(held.id));
  assert.equal(again.statusCode, 409);
  assert.deepEqual(again.json(), {
    error: 'This request is not in review: it is listed.',
    code: 'review_conflict',
    retryable: false,
  });

  const reported = await posted(h, body('Find a band for a wedding'), ip(2));
  await hide(h, reported.id, [
    [far(1), 'spam'],
    [far(2), 'spam'],
    [far(3), 'spam'],
  ]);
  assert.ok(!(await listed(h)).includes(reported.id));
  assert.equal((await ops(h, 'POST', releasePath(reported.id))).statusCode, 200);
  assert.ok((await listed(h)).includes(reported.id));
  assert.deepEqual((await queue(h, 'hidden')).requests, []);
  // Reviewed: three more networks no longer hide it (requests.ts asks for ten).
  await hide(h, reported.id, [
    [far(4), 'spam'],
    [far(5), 'spam'],
    [far(6), 'spam'],
  ]);
  assert.ok((await listed(h)).includes(reported.id));
});

test('release refuses what expired in review, what is listed, a copy of open text and unknown ids', async (t) => {
  const h = await harness(t);
  const soon = await posted(
    h,
    body('Send money to my landlord', { deadline: START + 2 * 3_600_000 }),
  );
  assert.equal(soon.status, 'held');
  h.clock.now = START + 3 * 3_600_000;
  const expired = await ops(h, 'POST', releasePath(soon.id));
  assert.equal(expired.statusCode, 409);
  assert.equal(expired.json().code, 'request_closed');
  const row = await h.db.query<{ state: string; reviewed_at: unknown }>(
    'SELECT state, reviewed_at FROM feed_requests WHERE id=$1',
    [soon.id],
  );
  assert.deepEqual(row.rows[0], { state: 'held', reviewed_at: null });
  // Still removable.
  assert.equal((await ops(h, 'POST', removePath(soon.id))).statusCode, 200);

  // The same text open from another poster: only one may be listed, the held copy stays held.
  const payload = body('Tune an upright piano');
  const bot = await posted(h, { ...payload, website: 'https://spam.example' }, ip(5));
  assert.equal(bot.status, 'held');
  const real = await posted(h, { ...payload, idempotencyKey: randomUUID() }, ip(6));
  assert.equal(real.status, 'open');
  const copy = await ops(h, 'POST', releasePath(bot.id));
  assert.equal(copy.statusCode, 409);
  assert.equal(copy.json().code, 'review_conflict');
  assert.equal((await queue(h, 'held')).requests[0]!.id, bot.id);

  // A hidden request whose poster posted the same text again (allowed): the same refusal.
  const hidden = await posted(h, body('Repair a wooden chair'), ip(7));
  await hide(h, hidden.id, [
    [far(1), 'spam'],
    [far(2), 'spam'],
    [far(3), 'spam'],
  ]);
  await posted(h, body('Repair a wooden chair', { description: hidden.description }), ip(7));
  assert.equal((await ops(h, 'POST', releasePath(hidden.id))).json().code, 'review_conflict');

  for (const id of ['req_aaaaaaaaaaaaaaaaaaaa', 'nope']) {
    const unknown = await ops(h, 'POST', releasePath(id));
    assert.equal(unknown.statusCode, 404, id);
    assert.equal(unknown.json().code, 'request_not_found');
  }
  const withBody = await ops(h, 'POST', releasePath(bot.id), { force: true });
  assert.equal(withBody.statusCode, 400);
});

test('remove: held, hidden or listed requests come off for good, the reply handle erased', async (t) => {
  const h = await harness(t);
  const held = await risky(h);
  const open = await posted(
    h,
    body('Paint a garden fence', { reply: 'https://desk.example.org/fence' }),
    ip(2),
  );
  const hidden = await posted(h, body('Find a band for a wedding'), ip(3));
  await hide(h, hidden.id, [
    [far(1), 'spam'],
    [far(2), 'spam'],
    [far(3), 'spam'],
  ]);
  h.clock.now = START + 60_000;
  for (const request of [held, open, hidden]) {
    const response = await ops(h, 'POST', removePath(request.id));
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.json() as FeedReviewOutcome, {
      id: request.id,
      state: 'removed',
      reviewedAt: START + 60_000,
      expiresAt: request.expiresAt,
    });
    assert.equal(await publicStatus(h, request.id), 404);
  }
  assert.deepEqual(await listed(h), []);
  assert.deepEqual((await queue(h, 'held')).requests, []);
  assert.deepEqual((await queue(h, 'hidden')).requests, []);
  const rows = await h.db.query<{ state: string; reply: string | null }>(
    'SELECT state, reply FROM feed_requests WHERE id=$1',
    [open.id],
  );
  assert.deepEqual(rows.rows[0], { state: 'removed', reply: null });
  assert.equal(h.events.filter((event) => event.event === 'feed.request_removed').length, 3);
  // A removed request cannot be released or removed again; a closed one is not removable.
  assert.equal((await ops(h, 'POST', releasePath(open.id))).json().code, 'request_closed');
  assert.equal((await ops(h, 'POST', removePath(open.id))).json().code, 'request_closed');
  const closable = await h.app.inject({
    method: 'POST',
    url: FEED_PATHS.requests,
    payload: body('Walk a dog twice'),
    remoteAddress: ip(9),
  });
  const { request, manageToken } = closable.json() as PostedFeedRequest;
  await h.app.inject({
    method: 'POST',
    url: FEED_PATHS.close.replace(':id', request.id),
    payload: { manageToken },
    remoteAddress: ip(9),
  });
  const closed = await ops(h, 'POST', removePath(request.id));
  assert.equal(closed.statusCode, 409);
  assert.equal(closed.json().code, 'request_closed');
});

test('pause: new posts answer 503 posting_paused (retryable) until resumed; a retry is still answered', async (t) => {
  const h = await harness(t);
  const first = body('Water the plants');
  await posted(h, first);
  h.clock.now = START + 60_000;
  const paused = await ops(h, 'POST', FEED_OPS_PATHS.pause, { paused: true });
  assert.equal(paused.statusCode, 200, paused.body);
  assert.equal(paused.headers['cache-control'], 'no-store');
  assert.deepEqual(paused.json(), { paused: true, updatedAt: START + 60_000 });
  const refused = await h.app.inject({
    method: 'POST',
    url: FEED_PATHS.requests,
    payload: body('Feed the cat'),
    remoteAddress: ip(2),
  });
  assert.equal(refused.statusCode, 503);
  assert.deepEqual(refused.json(), {
    error: 'Posting is paused for now. Try again later.',
    code: 'posting_paused',
    retryable: true,
  });
  // A retry of a post that went through is answered as before.
  const retry = await h.app.inject({
    method: 'POST',
    url: FEED_PATHS.requests,
    payload: first,
    remoteAddress: ip(1),
  });
  assert.equal(retry.statusCode, 200);
  assert.deepEqual((await queue(h, 'held')).posting, { paused: true, updatedAt: START + 60_000 });
  const flag = await h.db.query<{ enabled: boolean; updated_by: string }>(
    "SELECT enabled, updated_by FROM feed_flags WHERE name='posting'",
  );
  assert.deepEqual(flag.rows[0], { enabled: false, updated_by: 'ops' });

  for (const bad of [{}, { paused: 'yes' }, { paused: true, until: 1 }]) {
    const response = await ops(h, 'POST', FEED_OPS_PATHS.pause, bad);
    assert.equal(response.statusCode, 400, JSON.stringify(bad));
  }
  const resumed = await ops(h, 'POST', FEED_OPS_PATHS.pause, { paused: false });
  assert.deepEqual(resumed.json(), { paused: false, updatedAt: START + 60_000 });
  await posted(h, body('Feed the cat'), ip(2));
  assert.deepEqual(
    h.events.map((event) => event.event).filter((event) => event.startsWith('feed.posting')),
    ['feed.posting_paused', 'feed.posting_resumed'],
  );
});

test('the 7-day deletion takes held requests nobody reviewed and removals a week on; a released one lives to its expiry', async (t) => {
  const h = await harness(t);
  const released = await risky(h, 'Send money to a friend', ip(1));
  const removed = await risky(h, 'Need gift cards bought', ip(2));
  const waiting = await risky(h, 'Send money home', ip(3));
  h.clock.now = START + 6 * DAY;
  assert.equal((await ops(h, 'POST', releasePath(released.id))).statusCode, 200);
  assert.equal((await ops(h, 'POST', removePath(removed.id))).statusCode, 200);
  h.clock.now = START + 8 * DAY;
  await h.sweep();
  const left = await h.db.query<{ id: string; state: string }>(
    'SELECT id, state FROM feed_requests ORDER BY created_at',
  );
  // A removal is kept 7 days after the review, not after the posting.
  assert.deepEqual(left.rows, [
    { id: released.id, state: 'open' },
    { id: removed.id, state: 'removed' },
  ]);
  assert.ok(!left.rows.some((row) => row.id === waiting.id));
  assert.deepEqual(await listed(h), [released.id]);
  h.clock.now = START + 13 * DAY;
  await h.sweep();
  const later = await h.db.query<{ id: string }>('SELECT id FROM feed_requests');
  assert.deepEqual(later.rows, [{ id: released.id }]);
  // Then its own lifecycle: expired at its expiry, deleted 30 days later.
  h.clock.now = released.expiresAt + 1;
  await h.sweep();
  assert.deepEqual(await listed(h), []);
  h.clock.now = released.expiresAt + 31 * DAY;
  await h.sweep();
  assert.equal((await h.db.query('SELECT id FROM feed_requests')).rows.length, 0);
});

test('release holds the open caps posting holds; a hidden one is counted already', async (t) => {
  const h = await harness(t);
  // Held first, then the source fills its open cap (10) with listed requests.
  const held = [];
  for (const n of [1, 2]) held.push(await risky(h, `Send money to cousin number ${n}`));
  for (let n = 1; n <= 10; n++) await posted(h, body(`Teach guitar lesson number ${n}`));
  const over = await ops(h, 'POST', releasePath(held[0]!.id));
  assert.equal(over.statusCode, 409, over.body);
  assert.equal(over.json().code, 'review_conflict');
  const row = await h.db.query<{ state: string; reviewed_at: unknown }>(
    'SELECT state, reviewed_at FROM feed_requests WHERE id=$1',
    [held[0]!.id],
  );
  assert.deepEqual(row.rows[0], { state: 'held', reviewed_at: null });
  const open = async () =>
    Number(
      (
        await h.db.query<{ n: string | number }>(
          "SELECT count(*) AS n FROM feed_requests WHERE state='open' AND hidden_at IS NULL",
        )
      ).rows[0]!.n,
    );
  assert.equal(await open(), 10);

  // A hidden request of a poster at the cap is open already: releasing it adds nothing.
  const ids = await listed(h);
  await hide(h, ids[0]!, [
    [far(1), 'spam'],
    [far(2), 'spam'],
    [far(3), 'spam'],
  ]);
  assert.equal((await ops(h, 'POST', releasePath(ids[0]!))).statusCode, 200);
  assert.equal(await open(), 10);

  // Once one ends, one held request may be released, and no more.
  assert.equal((await ops(h, 'POST', removePath(ids[1]!))).statusCode, 200);
  assert.equal((await ops(h, 'POST', releasePath(held[0]!.id))).statusCode, 200);
  assert.equal((await ops(h, 'POST', releasePath(held[1]!.id))).json().code, 'review_conflict');
  assert.equal(await open(), 10);
});

test('remove: an older request stays on record 7 days after the removal; its text posted again is held', async (t) => {
  const h = await harness(t);
  const old = await posted(h, body('Find a tutor for chess lessons'), ip(1));
  await hide(h, old.id, [
    [far(1), 'spam'],
    [far(2), 'spam'],
    [far(3), 'spam'],
  ]);
  h.clock.now = START + 10 * DAY;
  assert.equal((await ops(h, 'POST', removePath(old.id))).statusCode, 200);
  await h.sweep();
  const kept = await h.db.query<{ state: string }>('SELECT state FROM feed_requests WHERE id=$1', [
    old.id,
  ]);
  assert.deepEqual(kept.rows, [{ state: 'removed' }]);
  const reports = await h.db.query('SELECT 1 FROM feed_request_reports WHERE request_id=$1', [
    old.id,
  ]);
  assert.equal(reports.rows.length, 3);

  // The same text, from the same address or another one: held for review, never listed.
  const again = await posted(
    h,
    body('Find a tutor for chess lessons', { description: old.description }),
    ip(1),
  );
  const elsewhere = await posted(
    h,
    body('Find a tutor for chess lessons', { description: old.description }),
    ip(4),
  );
  assert.equal(again.status, 'held');
  assert.equal(elsewhere.status, 'held');
  assert.deepEqual(await listed(h), []);
  const reasons = await h.db.query<{ held_reason: string }>(
    'SELECT held_reason FROM feed_requests WHERE id = ANY($1::text[])',
    [[again.id, elsewhere.id]],
  );
  assert.deepEqual(reasons.rows, [{ held_reason: 'risk' }, { held_reason: 'risk' }]);

  // A week after the removal the record goes, and the text may be listed again.
  h.clock.now = START + 17 * DAY;
  await h.sweep();
  const gone = await h.db.query('SELECT 1 FROM feed_requests WHERE id=$1', [old.id]);
  assert.equal(gone.rows.length, 0);
  const fresh = await posted(
    h,
    body('Find a tutor for chess lessons', { description: old.description }),
    ip(5),
  );
  assert.equal(fresh.status, 'open');
});

test('remove: an open request past its expiry, not swept yet, is removed all the same', async (t) => {
  const h = await harness(t);
  const request = await posted(h, body('Find a plumber for a leak'), ip(1));
  h.clock.now = request.expiresAt + 1_000;
  // Release refuses it (it would list stale text); a removal only takes it further off.
  assert.equal((await ops(h, 'POST', releasePath(request.id))).json().code, 'request_closed');
  const removed = await ops(h, 'POST', removePath(request.id));
  assert.equal(removed.statusCode, 200, removed.body);
  assert.deepEqual(removed.json() as FeedReviewOutcome, {
    id: request.id,
    state: 'removed',
    reviewedAt: request.expiresAt + 1_000,
    expiresAt: request.expiresAt,
  });
  assert.equal(await publicStatus(h, request.id), 404);
});

test('alerts: one JSON line per event; held and hidden also reach the ops webhook, throttled, without the request', async () => {
  const lines: string[] = [];
  const sent: Array<{ url: string; body: string }> = [];
  let status = 200;
  let now = START;
  const env: Record<string, string | undefined> = {};
  const log = feedEventLog(env, {
    log: (line) => lines.push(line),
    clock: () => now,
    transport: async (url, payload) => {
      sent.push({ url, body: payload });
      if (status === 0) throw new Error('offline');
      return { status };
    },
  });
  const flush = () => new Promise((resolve) => setImmediate(resolve));

  // No webhook configured: the line only.
  log('feed.request_held', { id: 'req_aaaaaaaaaaaaaaaaaaaa', reason: 'risk' });
  assert.deepEqual(lines, [
    JSON.stringify({ event: 'feed.request_held', id: 'req_aaaaaaaaaaaaaaaaaaaa', reason: 'risk' }),
  ]);
  assert.equal(sent.length, 0);

  env.CITY_OPS_ALERT_WEBHOOK = 'https://alerts.example.org/feed';
  log('feed.request_held', { id: 'req_bbbbbbbbbbbbbbbbbbbb', reason: 'honeypot' });
  log('feed.request_held', { id: 'req_cccccccccccccccccccc', reason: 'risk' });
  log('feed.request_hidden', { id: 'req_dddddddddddddddddddd' });
  log('feed.request_released', { id: 'req_dddddddddddddddddddd' });
  await flush();
  assert.equal(
    sent.length,
    2,
    'one per kind in the window; a honeypot hold and a release never alert',
  );
  assert.equal(sent[0]!.url, 'https://alerts.example.org/feed');
  assert.deepEqual(JSON.parse(sent[0]!.body), {
    text: 'Feed: a new request is held for review (/api/ops/feed/requests?state=held).',
    event: 'feed.request_held',
  });
  assert.equal(JSON.parse(sent[1]!.body).event, 'feed.request_hidden');
  assert.ok(!sent.some((alert) => alert.body.includes('req_')));
  assert.equal(lines.length, 5);

  // After the window it alerts again; a failure is a line, never a throw.
  now += FEED_REVIEW_ALERT_EVERY_MS;
  status = 500;
  log('feed.request_held', { id: 'req_eeeeeeeeeeeeeeeeeeee', reason: 'risk' });
  await flush();
  assert.equal(sent.length, 3);
  assert.equal(lines.at(-1), JSON.stringify({ event: 'feed.alert_failed', status: 500 }));
  now += FEED_REVIEW_ALERT_EVERY_MS;
  status = 0;
  log('feed.request_hidden', { id: 'req_ffffffffffffffffffff' });
  await flush();
  assert.equal(lines.at(-1), JSON.stringify({ event: 'feed.alert_failed' }));
});

test('a removed copy from a blocked source never sends the real post to review', async (t) => {
  const h = await harness(t);
  // The bot's source is blocked (read from a post of its own), so its copy of someone's text is
  // held as 'blocked'; an operator removes it.
  const first = await posted(
    h,
    body('Sort a crate of records', { website: 'https://x.test' }),
    ip(5),
  );
  const { source_hash } = (
    await h.db.query<{ source_hash: string }>('SELECT source_hash FROM feed_requests WHERE id=$1', [
      first.id,
    ])
  ).rows[0]!;
  await h.db.query(
    'INSERT INTO feed_source_blocks (source_hash, expires_at, created_at) VALUES ($1, $2, $3)',
    [source_hash, START + DAY, START],
  );
  const text = body('Mend a torn sail');
  const bot = await posted(h, { ...text, idempotencyKey: randomUUID() }, ip(5));
  assert.equal(bot.status, 'held');
  const held = await h.db.query<{ held_reason: string }>(
    'SELECT held_reason FROM feed_requests WHERE id=$1',
    [bot.id],
  );
  assert.equal(held.rows[0]!.held_reason, 'blocked');
  assert.equal((await ops(h, 'POST', removePath(bot.id))).statusCode, 200);
  // The real poster's identical post is listed, not held.
  const real = await posted(h, { ...text, idempotencyKey: randomUUID() }, ip(1));
  assert.equal(real.status, 'open');
  assert.deepEqual(await listed(h), [real.id]);
  assert.ok(!(await queue(h, 'held')).requests.some((request) => request.id === real.id));
});

test('a removed honeypot or blocked copy never sends the real post to review; other removals do', async (t) => {
  const h = await harness(t);
  // A bot posts someone's text with the honeypot filled; an operator removes it.
  const text = body('Fix a garden gate latch');
  const bot = await posted(
    h,
    { ...text, idempotencyKey: randomUUID(), website: 'https://x.test' },
    ip(5),
  );
  assert.equal(bot.status, 'held');
  assert.equal((await ops(h, 'POST', removePath(bot.id))).statusCode, 200);
  // The real poster's identical post is listed, not held.
  const real = await posted(h, { ...text, idempotencyKey: randomUUID() }, ip(1));
  assert.equal(real.status, 'open');
  assert.deepEqual(await listed(h), [real.id]);
  assert.deepEqual((await queue(h, 'held')).requests, []);

  // A blocked source's copy, removed, does not count either.
  await h.db.query("UPDATE feed_requests SET held_reason='blocked' WHERE id=$1", [bot.id]);
  assert.equal((await ops(h, 'POST', removePath(real.id))).statusCode, 200);
  // ...but removing the real one does: its text posted again is held, and the queue says why.
  const again = await posted(h, { ...text, idempotencyKey: randomUUID() }, ip(2));
  assert.equal(again.status, 'held');
  const [item] = (await queue(h, 'held')).requests;
  assert.equal(item!.id, again.id);
  assert.equal(item!.heldReason, 'risk');
  assert.equal(item!.repostOfRemoved, true);
});

test('remove erases the description, the display name and the report notes at once; for personal data the title too; the keys still hold a repost', async (t) => {
  const h = await harness(t);
  const request = await posted(
    h,
    body('Find a tutor for chess lessons', {
      description: 'Call Sam on the number in my profile.',
      displayName: 'Harbor desk',
    }),
    ip(1),
  );
  await hide(h, request.id, [
    [far(1), 'personal_data', 'It shows a phone number.'],
    [far(2), 'personal_data', 'Phone number in the text.'],
    [far(3), 'spam'],
  ]);
  const removed = await ops(h, 'POST', removePath(request.id));
  assert.equal(removed.statusCode, 200, removed.body);
  const row = await h.db.query<Record<string, unknown>>(
    'SELECT title, description, display_name, reply FROM feed_requests WHERE id=$1',
    [request.id],
  );
  // Reported as personal data: the title can be that data too, so it goes as well.
  assert.deepEqual(row.rows[0], {
    title: '',
    description: '',
    display_name: null,
    reply: null,
  });
  const notes = await h.db.query<{ note: string | null }>(
    'SELECT note FROM feed_request_reports WHERE request_id=$1',
    [request.id],
  );
  assert.deepEqual(
    notes.rows.map((report) => report.note),
    [null, null, null],
  );
  // The same text posted again is still held for review.
  const again = await posted(
    h,
    body('Find a tutor for chess lessons', {
      description: 'Call Sam on the number in my profile.',
    }),
    ip(4),
  );
  assert.equal(again.status, 'held');
  const [item] = (await queue(h, 'held')).requests;
  assert.equal(item!.id, again.id);
  assert.equal(item!.repostOfRemoved, true);
  assert.deepEqual(
    h.events.filter((event) => event.event === 'feed.request_removed').map((e) => e.personalData),
    [true],
  );
});

test('remove for personal data: the operator says so, or a report did; any other removal keeps the title', async (t) => {
  const h = await harness(t);
  const titleOf = async (id: string) =>
    (await h.db.query<{ title: string }>('SELECT title FROM feed_requests WHERE id=$1', [id]))
      .rows[0]!.title;
  // Held (never listed, so never reported): the operator names the reason.
  const held = await risky(h, 'Send money to my neighbour at 12 Mill Lane');
  for (const payload of [
    { reason: 'spam' },
    { reason: 'personal_data', note: 'x' },
    { personal: true },
  ]) {
    const refused = await ops(h, 'POST', removePath(held.id), payload);
    assert.equal(refused.statusCode, 400, JSON.stringify(payload));
    assert.equal(refused.json().code, 'invalid_request');
  }
  assert.equal(
    (await ops(h, 'POST', removePath(held.id), { reason: 'personal_data' })).statusCode,
    200,
  );
  assert.equal(await titleOf(held.id), '');
  // Hidden by spam reports and removed with {}: the title stays for the record.
  const spam = await posted(h, body('Find a band for a wedding'), ip(3));
  await hide(h, spam.id, [
    [far(1), 'spam'],
    [far(2), 'spam'],
    [far(3), 'spam'],
  ]);
  assert.equal((await ops(h, 'POST', removePath(spam.id))).statusCode, 200);
  assert.equal(await titleOf(spam.id), 'Find a band for a wedding');
  // Listed, one personal data report among others (not enough to hide it), removed with {}.
  const reported = await posted(h, body('Walk the dog at 12 Mill Lane'), ip(4));
  await hide(h, reported.id, [[far(4), 'personal_data', 'Names a neighbour.']]);
  assert.equal((await ops(h, 'POST', removePath(reported.id))).statusCode, 200);
  assert.equal(await titleOf(reported.id), '');
  assert.deepEqual(
    h.events.filter((event) => event.event === 'feed.request_removed').map((e) => e.personalData),
    [true, false, true],
  );
  // The repost hold reads only the keys: the same text is still held after the title is gone.
  const again = await posted(h, body('Walk the dog at 12 Mill Lane'), ip(6));
  assert.equal(again.status, 'held');
});

test('every review leaves a log line with what it was: state, reason, reports; a pause the value before it', async (t) => {
  const h = await harness(t);
  const held = await risky(h);
  const hidden = await posted(h, body('Find a band for a wedding'), ip(3));
  await hide(h, hidden.id, [
    [far(1), 'spam'],
    [far(2), 'spam'],
    [far(3), 'spam'],
  ]);
  const listedOne = await posted(h, body('Paint a garden fence'), ip(4));
  assert.equal((await ops(h, 'POST', releasePath(held.id))).statusCode, 200);
  assert.equal((await ops(h, 'POST', releasePath(hidden.id))).statusCode, 200);
  assert.equal((await ops(h, 'POST', removePath(listedOne.id))).statusCode, 200);
  assert.equal((await ops(h, 'POST', removePath(held.id))).statusCode, 200);
  const reviews = h.events.filter((event) =>
    ['feed.request_released', 'feed.request_removed'].includes(event.event),
  );
  assert.deepEqual(reviews, [
    {
      event: 'feed.request_released',
      id: held.id,
      from: 'held',
      heldReason: 'risk',
      reportCount: 0,
    },
    {
      event: 'feed.request_released',
      id: hidden.id,
      from: 'hidden',
      heldReason: null,
      reportCount: 3,
    },
    {
      event: 'feed.request_removed',
      id: listedOne.id,
      from: 'listed',
      heldReason: null,
      reportCount: 0,
      personalData: false,
    },
    // Released before: nothing held about it any more.
    {
      event: 'feed.request_removed',
      id: held.id,
      from: 'listed',
      heldReason: null,
      reportCount: 0,
      personalData: false,
    },
  ]);
  const reason = await h.db.query<{ held_reason: string | null }>(
    'SELECT held_reason FROM feed_requests WHERE id=$1',
    [hidden.id],
  );
  assert.deepEqual(reason.rows[0], { held_reason: null });

  // A pause that changes nothing is logged too, with the value before it.
  for (const paused of [true, true, false, false])
    assert.equal((await ops(h, 'POST', FEED_OPS_PATHS.pause, { paused })).statusCode, 200);
  assert.deepEqual(
    h.events.filter((event) => event.event.startsWith('feed.posting')),
    [
      { event: 'feed.posting_paused', wasPaused: false },
      { event: 'feed.posting_paused', wasPaused: true },
      { event: 'feed.posting_resumed', wasPaused: true },
      { event: 'feed.posting_resumed', wasPaused: false },
    ],
  );
  // Logs name ids and reasons, never the text.
  assert.ok(!JSON.stringify(h.events).includes('wedding'));
});

test('the held queue reads one reason at a time; hidden takes none', async (t) => {
  const h = await harness(t);
  const money = await risky(h);
  const bot = await posted(
    h,
    body('Translate a short letter', { website: 'https://x.test' }),
    ip(2),
  );
  const byReason = async (reason: string) =>
    (
      await ops(h, 'GET', `${FEED_OPS_PATHS.queue}?state=held&reason=${reason}`)
    ).json() as FeedReviewPage;
  assert.deepEqual(
    (await byReason('honeypot')).requests.map((request) => request.id),
    [bot.id],
  );
  assert.deepEqual(
    (await byReason('risk')).requests.map((request) => request.id),
    [money.id],
  );
  assert.deepEqual((await byReason('spread')).requests, []);
  for (const query of ['?state=held&reason=other', '?state=hidden&reason=risk']) {
    const response = await ops(h, 'GET', `${FEED_OPS_PATHS.queue}${query}`);
    assert.equal(response.statusCode, 400, query);
    assert.equal(response.json().code, 'invalid_request');
  }
});

test('release holds the per-owner and the site-wide open caps too', async (t) => {
  const h = await harness(t, { caps: { openPerOwner: 1, openGlobal: 3 } });
  h.session.value = { ownerId: 'ws-1' };
  const held = await risky(h, 'Send money to my cousin abroad', ip(1));
  assert.equal(held.status, 'held');
  await posted(h, body('Teach a guitar lesson'), ip(1));
  const over = await ops(h, 'POST', releasePath(held.id));
  assert.equal(over.statusCode, 409, over.body);
  assert.match(over.json().error, /has 1 open requests/);
  // Another workspace's held request meets the site-wide cap instead.
  h.session.value = { ownerId: 'ws-2' };
  const other = await risky(h, 'Send money to my aunt abroad', ip(2));
  h.session.value = null;
  await posted(h, body('Walk a dog at noon'), ip(3));
  await posted(h, body('Water the plants'), ip(4));
  const full = await ops(h, 'POST', releasePath(other.id));
  assert.equal(full.statusCode, 409, full.body);
  assert.equal(full.json().error, 'The Feed is full right now: release it later.');
});

test('the hidden queue never shows a poster key, an address hash or a token hash either', async (t) => {
  const h = await harness(t);
  h.session.value = { ownerId: 'ws-1' };
  const request = await posted(h, body('Find a band for a wedding'), ip(1));
  h.session.value = null;
  await hide(h, request.id, [
    [far(1), 'spam', 'Posted on every board.'],
    [far(2), 'spam'],
    [far(3), 'scam'],
  ]);
  const page = await queue(h, 'hidden');
  assert.deepEqual(
    page.requests.map((item) => item.id),
    [request.id],
  );
  const raw = JSON.stringify(page);
  const secrets = await h.db.query<Record<string, string | null>>(
    `SELECT poster_key, source_hash, site_hash, content_key, title_key, manage_hash,
            idempotency_hash, owner_id FROM feed_requests`,
  );
  const reporters = await h.db.query<Record<string, string>>(
    'SELECT reporter_hash, reporter_site, reporter_network FROM feed_request_reports',
  );
  for (const row of [...secrets.rows, ...reporters.rows])
    for (const value of Object.values(row)) if (value) assert.ok(!raw.includes(value), value);
});

test('alerts: a honeypot or blocked hold is a log line only and never uses the alert window', async () => {
  const sent: string[] = [];
  const lines: string[] = [];
  const log = feedEventLog(
    { CITY_OPS_ALERT_WEBHOOK: 'https://alerts.example.org/feed' },
    {
      log: (line) => lines.push(line),
      clock: () => START,
      transport: async (_url, payload) => {
        sent.push(payload);
        return { status: 200 };
      },
    },
  );
  for (let n = 0; n < 5; n++) {
    log('feed.request_held', { id: 'req_aaaaaaaaaaaaaaaaaaaa', reason: 'honeypot' });
    log('feed.request_held', { id: 'req_bbbbbbbbbbbbbbbbbbbb', reason: 'blocked' });
  }
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sent.length, 0);
  assert.equal(lines.length, 10);
  // The first real one still alerts at once; a spread title alerts as risky text does.
  log('feed.request_held', { id: 'req_cccccccccccccccccccc', reason: 'spread' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sent.length, 1);
  assert.equal(JSON.parse(sent[0]!).event, 'feed.request_held');
});
