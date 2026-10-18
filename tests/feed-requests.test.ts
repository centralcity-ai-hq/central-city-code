import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Database, Transaction } from '../server/database.js';
import {
  createFeedRequests,
  FEED_CAPS_DEFAULT,
  FEED_CAP_ENV,
  feedCaps,
  minePageSize,
  signedInScopeCap,
  tsQuery,
  type FeedCaps,
} from '../server/feed/requests.js';
import { NO_SERVICES_YET, registerFeedRoutes, type FeedRouteDeps } from '../server/feed/routes.js';
import { foldKey } from '../server/feed/policy.js';
import {
  FEED_REQUEST_SEARCH_SQL,
  FEED_REQUEST_TEXT,
  FEED_REQUESTS_SQL,
  FEED_REQUEST_TABLES,
  feedRequestSearchMigration,
  feedRequestsMigration,
  registerFeedRequestsMigration,
} from '../server/feed/schema.js';
import { listMigrations, runMigrations } from '../server/migrations.js';
import { FAIL_CLOSED_PREFIXES, MemoryRateLimiter, outageMode } from '../server/rate-limit.js';
import { ROOM_CREDENTIAL_PATTERN } from '../server/rooms/contract.js';
import { ON_BASE_LIVE } from '../server/base/explorer/routes.js';
import {
  FEED_LIMITS,
  FEED_PATHS,
  FEED_REQUEST_ID,
  type FeedMyRequest,
  type FeedMyRequests,
  type FeedRequestPage,
  type FeedStatus,
  type PostedFeedRequest,
  type PublicFeedRequest,
} from '../shared/feed.js';

/*
 * Feed "Searched for" (server/feed): anyone may post a request, signed in or not, behind
 * CITY_FEED. Runs the routes on an in-memory database with the shared rate limiter in memory.
 * Synthetic, low-entropy data only.
 */

type Ctx = { after: (fn: () => Promise<unknown> | unknown) => void };

const START = Date.UTC(2026, 9, 13, 12);
const HASHING = 'feed-requests-test-hashing-secret-0123456789';
const PUBLIC_KEYS = [
  'budget',
  'capabilities',
  'closedAt',
  'createdAt',
  'deadline',
  'description',
  'expiresAt',
  'id',
  'postedBy',
  'reply',
  'status',
  'title',
];

interface Harness {
  app: FastifyInstance;
  db: Database;
  flag: { on: boolean };
  clock: { now: number };
  session: { value: { ownerId: string } | null };
  secret: { value: string | undefined };
  events: string[];
  /** Agents of workspace ws-1, by id: their names. */
  agents: Record<string, string>;
  /** Every rate-limit bucket charged, in order. */
  charged: Array<{ key: string; max: number }>;
}

async function harness(t: Ctx, caps: Partial<FeedCaps> = {}): Promise<Harness> {
  const pg = await PGlite.create('memory://');
  t.after(() => pg.close());
  await pg.exec(
    `CREATE TABLE operators (id text PRIMARY KEY);
     INSERT INTO operators SELECT 'ws-' || n FROM generate_series(1, 12) AS n;`,
  );
  await pg.exec(FEED_REQUESTS_SQL);
  await pg.exec(FEED_REQUEST_SEARCH_SQL);
  const db: Database = {
    query: (sql, params) => pg.query(sql, params) as never,
    exec: (sql) => pg.exec(sql),
    transaction: (action) => pg.transaction((tx) => action(tx as never)),
    close: () => pg.close(),
  };
  const clock = { now: START };
  const limiter = new MemoryRateLimiter(() => clock.now);
  const charged: Harness['charged'] = [];
  const limit = async (key: string, max: number, windowMs: number) => {
    charged.push({ key, max });
    const result = await limiter.hit(key, max, windowMs);
    if (!result.allowed)
      throw Object.assign(new Error('Too many requests. Try again later.'), { statusCode: 429 });
  };
  const flag = { on: true };
  const session: Harness['session'] = { value: null };
  const secret: Harness['secret'] = { value: HASHING };
  const events: string[] = [];
  const agents: Harness['agents'] = { 'agent-1': 'Harbor Scout' };
  const app = Fastify();
  t.after(() => app.close());
  const deps: FeedRouteDeps = {
    requests: createFeedRequests({
      db,
      clock: () => clock.now,
      secret: () => secret.value,
      limit,
      caps,
      log: (event) => events.push(event),
    }),
    enabled: () => flag.on,
    limit,
    signedIn: async () => session.value,
    agentOf: async (ownerId, agentId) =>
      ownerId === 'ws-1' && agents[agentId] !== undefined
        ? { id: agentId, name: agents[agentId] }
        : null,
  };
  registerFeedRoutes(app, deps);
  return { app, db, flag, clock, session, secret, events, agents, charged };
}

function body(title: string, extra: Record<string, unknown> = {}) {
  return {
    title,
    description: `Details for ${title}.`,
    idempotencyKey: randomUUID(),
    ...extra,
  };
}

/** A different /24 site per n, all in one /16 network. */
const ip = (n: number) => `198.51.${n}.7`;
/** A different /16 network per n. */
const far = (n: number) => `10.${n}.0.9`;

function post(h: Harness, payload: Record<string, unknown>, from = ip(1)) {
  return h.app.inject({
    method: 'POST',
    url: FEED_PATHS.requests,
    payload,
    remoteAddress: from,
  });
}

async function posted(h: Harness, payload: Record<string, unknown>, from = ip(1)) {
  const response = await post(h, payload, from);
  assert.equal(response.statusCode, 201, response.body);
  return response.json() as PostedFeedRequest;
}

async function list(h: Harness, query = '') {
  const response = await h.app.inject({ url: `${FEED_PATHS.requests}${query}` });
  assert.equal(response.statusCode, 200, response.body);
  return { page: response.json() as FeedRequestPage, raw: response.body };
}

const titles = (page: FeedRequestPage) => page.requests.map((request) => request.title);
const reportPath = (id: string) => FEED_PATHS.report.replace(':id', id);
const requestPath = (id: string) => FEED_PATHS.request.replace(':id', id);
const closePath = (id: string) => FEED_PATHS.close.replace(':id', id);

test('CITY_FEED off: every route answers 404 not_found', async (t) => {
  const h = await harness(t);
  const { request } = await posted(h, body('Translate a menu into Greek'));
  h.flag.on = false;
  // Signed in changes nothing.
  h.session.value = { ownerId: 'ws-1' };
  const id = request.id;
  for (const [method, url] of [
    ['GET', FEED_PATHS.status],
    ['GET', FEED_PATHS.requests],
    ['GET', requestPath(id)],
    ['POST', FEED_PATHS.requests],
    ['POST', reportPath(id)],
    ['POST', closePath(id)],
    ['GET', FEED_PATHS.mine],
  ] as const) {
    const response = await h.app.inject({
      method,
      url,
      ...(method === 'POST' ? { payload: { reason: 'spam' } } : {}),
    });
    assert.equal(response.statusCode, 404, `${method} ${url}`);
    assert.deepEqual(response.json(), { error: 'Not found.', code: 'not_found', retryable: false });
  }
  h.flag.on = true;
  assert.deepEqual(titles((await list(h)).page), ['Translate a menu into Greek']);
});

test('an anonymous request is posted, listed newest first and counted on the status route', async (t) => {
  const h = await harness(t);
  const first = await posted(
    h,
    body('Summarize forty PDF invoices', {
      description: '  Monthly invoices,\n\n\n\nabout forty pages.  ',
      capabilities: ['PDF', 'summaries', 'pdf'],
      budgetUsdc: '25.50',
      deadline: START + 3 * 86_400_000,
      displayName: '  Dock   office ',
    }),
  );
  assert.match(first.manageToken, /^ccf_[A-Za-z0-9_-]{43}$/);
  assert.match(first.request.id, FEED_REQUEST_ID);
  assert.deepEqual(first.request, {
    id: first.request.id,
    title: 'Summarize forty PDF invoices',
    description: 'Monthly invoices,\n\nabout forty pages.',
    capabilities: ['pdf', 'summaries'],
    budget: {
      raw: '25500000',
      decimals: 6,
      display: '25.5',
      asset: 'USDC',
      network: 'eip155:8453',
    },
    deadline: START + 3 * 86_400_000,
    reply: null,
    postedBy: { kind: 'anonymous', displayName: 'Dock office' },
    status: 'open',
    createdAt: START,
    expiresAt: START + 3 * 86_400_000,
    closedAt: null,
  } satisfies PublicFeedRequest);

  h.clock.now += 1_000;
  await posted(h, body('Label two hundred photos'), ip(2));
  const { page } = await list(h);
  assert.deepEqual(titles(page), ['Label two hundred photos', 'Summarize forty PDF invoices']);
  assert.equal(page.next, null);
  for (const request of page.requests) assert.deepEqual(Object.keys(request).sort(), PUBLIC_KEYS);
  assert.equal(page.requests[0]!.expiresAt, START + 1_000 + FEED_LIMITS.requestTtlMs);
  assert.equal(page.requests[0]!.postedBy.displayName, null);

  const status = await h.app.inject({ url: FEED_PATHS.status });
  assert.equal(status.statusCode, 200);
  assert.equal(status.headers['cache-control'], ON_BASE_LIVE);
  assert.deepEqual(status.json(), { ...NO_SERVICES_YET, openRequests: 2 } satisfies FeedStatus);
});

test('the reply handle: a Base address or an https link, public, erased at close', async (t) => {
  const h = await harness(t, { postsPerSourceHour: 50, postsPerSourceDay: 50 });
  const lower = `0x${'ab'.repeat(20)}`;
  const byAddress = await posted(h, body('Proofread a short story', { reply: lower }));
  assert.match(byAddress.request.reply!, /^0x[0-9a-fA-F]{40}$/);
  assert.equal(byAddress.request.reply!.toLowerCase(), lower);
  assert.notEqual(byAddress.request.reply, lower, 'stored checksummed');
  const byLink = await posted(
    h,
    body('Illustrate a picture book', { reply: 'https://studio.example.org/contact?from=feed#x' }),
    ip(2),
  );
  assert.equal(byLink.request.reply, 'https://studio.example.org/contact');

  const one = await h.app.inject({ url: requestPath(byLink.request.id) });
  assert.equal(one.statusCode, 200);
  assert.equal((one.json() as PublicFeedRequest).reply, 'https://studio.example.org/contact');
  assert.deepEqual(Object.keys(one.json()).sort(), PUBLIC_KEYS);

  // No email, phone, free text, plain http, shortener or a bad checksum.
  for (const reply of [
    'dock.office@example.com',
    '+41 44 555 01 23',
    'ask for harbor desk seven',
    'http://studio.example.org',
    'https://bit.ly/abc',
    `0x${'aB'.repeat(20)}`,
    `0x${'0'.repeat(40)}`,
    'https://example.org/' + 'a'.repeat(200),
  ]) {
    const response = await post(h, body('Bind a small notebook', { reply }), ip(3));
    assert.equal(response.statusCode, 400, `${reply}: ${response.body}`);
    assert.match(response.json().error, /reply handle/);
  }
  // A messenger invite as the handle sends the request to review.
  const held = await posted(
    h,
    body('Tune an old piano', { reply: 'https://t.me/harbordesk' }),
    ip(4),
  );
  assert.equal(held.request.status, 'held');

  const closed = await h.app.inject({
    method: 'POST',
    url: closePath(byAddress.request.id),
    payload: { manageToken: byAddress.manageToken },
    remoteAddress: ip(1),
  });
  assert.equal(closed.statusCode, 200);
  assert.equal((closed.json() as PublicFeedRequest).reply, null);
  const after = await h.db.query<{ reply: string | null }>(
    'SELECT reply FROM feed_requests WHERE id=$1',
    [byAddress.request.id],
  );
  assert.equal(after.rows[0]!.reply, null);
});

test('the honeypot answers like a post but the request is held, never listed', async (t) => {
  const h = await harness(t);
  const response = await post(h, body('Write fifty product blurbs', { website: 'https://x.test' }));
  assert.equal(response.statusCode, 201);
  const { request } = response.json() as PostedFeedRequest;
  assert.equal(request.status, 'held');
  assert.deepEqual((await list(h)).page.requests, []);
  assert.equal((await h.app.inject({ url: requestPath(request.id) })).statusCode, 404);
  assert.deepEqual(h.events, ['feed.request_held']);
  const row = await h.db.query<{ state: string; held_reason: string }>(
    'SELECT state, held_reason FROM feed_requests WHERE id=$1',
    [request.id],
  );
  assert.deepEqual(row.rows[0], { state: 'held', held_reason: 'honeypot' });
  const status = await h.app.inject({ url: FEED_PATHS.status });
  assert.equal((status.json() as FeedStatus).openRequests, 0);
});

test('size limits: 400 invalid_request, and a body over the route limit is refused', async (t) => {
  const h = await harness(t, { postsPerSourceHour: 50, postsPerSourceDay: 50 });
  const cases: Array<Record<string, unknown>> = [
    body('Tiny'),
    body('T'.repeat(5) + ' title '.repeat(20)),
    body('A long description', { description: 'word '.repeat(401) }),
    body('Too many tags here', { capabilities: ['a1', 'b2', 'c3', 'd4', 'e5', 'f6'] }),
    body('A budget too large', { budgetUsdc: '100000.01' }),
    body('A budget of nothing', { budgetUsdc: '0' }),
    body('Deadline far away', { deadline: START + 31 * 86_400_000 }),
    body('Deadline right now', { deadline: START + 60_000 }),
    body('Reply is too long', { reply: `https://example.org/${'c'.repeat(200)}` }),
    body('A guessable retry key', { idempotencyKey: 'retry-key-1' }),
    body('Too many lines here', { description: Array(31).fill('line').join('\n') }),
    body('Unknown field here', { extra: true }),
    { title: 'No idempotency key', description: '' },
  ];
  for (const payload of cases) {
    const response = await post(h, payload);
    assert.equal(
      response.statusCode,
      400,
      `${JSON.stringify(payload).slice(0, 80)}: ${response.body}`,
    );
    assert.equal(response.json().code, 'invalid_request');
    assert.equal(response.json().retryable, false);
  }
  const huge = await post(h, body('Huge body', { description: 'x'.repeat(20_000) }));
  assert.equal(huge.statusCode, 413);
  assert.deepEqual((await list(h)).page.requests, []);
});

test('text policy: contact details, credentials and bad links are refused; links lose their query', async (t) => {
  const h = await harness(t, {
    postsPerSourceHour: 50,
    postsPerSourceDay: 50,
    postsPerSiteHour: 50,
  });
  for (const [title, description, displayName] of [
    ['Email in the text', 'Write to dock.office@example.com please'],
    ['Full-width email', 'Write to dock\uff20example\uff0ecom please'],
    ['Phone in the text', 'Call +41 44 555 01 23 after noon'],
    ['A link in the https://example.com title', ''],
    ['A glued xhttps://example.com title', ''],
    ['Visit scam-site.com today', ''],
    ['Visit scam-site\uff0ecom today', ''],
    ['Shortened link', 'See https://bit.ly/abc for the brief'],
    ['Bare shortened link', 'See bit.ly/3abc for the brief'],
    ['Full-width shortened link', 'See \uff42\uff49\uff54\uff0e\uff4c\uff59/3abc for it'],
    ['Plain http link', 'See http://example.com/brief'],
    ['IP literal link', 'See https://192.0.2.10/brief'],
    ['Three links', 'https://a.example/1 https://b.example/2 https://c.example/3'],
    ['A key in the text', `Use ${'ccw'}_${'a'.repeat(43)} to sign in`],
    ['A repeated run', `Hello ${'!'.repeat(13)}`],
    ['An address as the name', '', 'harbor-deals.net'],
    ['A reserved name', '', 'Central City Support'],
    ['A look-alike name', '', 'Centra1 C\u0456ty'],
    ['A staff name', '', 'Feed Admin'],
  ]) {
    const response = await post(
      h,
      body(title!, { description, ...(displayName ? { displayName } : {}) }),
    );
    assert.equal(response.statusCode, 400, `${title}: ${response.body}`);
    assert.equal(response.json().code, 'invalid_request');
  }
  // Product names shaped like files or frameworks are not addresses.
  for (const title of ['Need a Next.js and ASP.NET developer', 'Fix README.md, e.g. typos'])
    assert.equal((await posted(h, body(title))).request.status, 'open', title);
  const badminton = await posted(
    h,
    body('Find a badminton coach', { displayName: 'Badminton club' }),
  );
  assert.equal(badminton.request.postedBy.displayName, 'Badminton club');
  const ok = await posted(
    h,
    body('Review a draft with a link', {
      description: 'The draft: https://docs.example.org/drafts/harbor?ref=feed#top. Thanks',
    }),
  );
  assert.equal(ok.request.description, 'The draft: https://docs.example.org/drafts/harbor. Thanks');
  const dated = await posted(
    h,
    body('Dates are not phones', { description: 'From 2026-10-14 to 2026-10-20' }),
  );
  assert.equal(dated.request.status, 'open');
});

test('risky money requests and messenger links are held for review, never listed', async (t) => {
  const h = await harness(t, {
    postsPerSourceHour: 50,
    postsPerSourceDay: 50,
    postsPerSiteHour: 50,
  });
  for (const payload of [
    body('Send money to my cousin abroad'),
    body('Need fifty gift cards bought'),
    body('Find a vault deposit with 12% APY'),
    body('Help with a translation', { description: 'Talk to me at https://t.me/harbordesk' }),
    body('Help with a summary', { description: 'Talk to me at t.me/cheapdeals' }),
    body('Help with a poster', { description: 'Talk to me at xhttps://t.me/abc' }),
    body('Help with a letter', {
      description:
        'Talk to me at \uff48\uff54\uff54\uff50\uff53\uff1a\uff0f\uff0f\uff54\uff0e\uff4d\uff45/abc',
    }),
    body('Help with a website', {
      description: 'See \uff48\uff54\uff54\uff50\uff53\uff1a\uff0f\uff0fexample\uff0eorg/brief',
    }),
    body('Help with the PayPal transfer', { capabilities: ['paypal'] }),
  ]) {
    const response = await post(h, payload);
    assert.equal(response.statusCode, 201, `${payload.title}: ${response.body}`);
    const { request } = response.json() as PostedFeedRequest;
    assert.equal(request.status, 'held', payload.title);
    assert.equal((await h.app.inject({ url: requestPath(request.id) })).statusCode, 404);
    const row = await h.db.query<{ held_reason: string }>(
      'SELECT held_reason FROM feed_requests WHERE id=$1',
      [request.id],
    );
    assert.equal(row.rows[0]!.held_reason, 'risk', payload.title);
  }
  assert.deepEqual((await list(h)).page.requests, []);
  // Data about these things is fine.
  await posted(h, body('Chart the gold price for a year'));
  assert.equal((await list(h)).page.requests.length, 1);
});

test('duplicates: the same text from anyone, the same title from the same poster; retries answer the same request', async (t) => {
  const h = await harness(t, { postsPerSourceHour: 50, postsPerSourceDay: 50 });
  const payload = body('Transcribe a podcast episode');
  const first = await posted(h, payload);

  const retry = await post(h, payload);
  assert.equal(retry.statusCode, 200);
  assert.deepEqual(retry.json(), first);

  const changed = await post(h, { ...payload, description: 'Something else entirely.' });
  assert.equal(changed.statusCode, 400);
  assert.match(changed.json().error, /idempotencyKey/);

  const copy = await post(h, { ...body(payload.title), description: payload.description }, ip(9));
  assert.equal(copy.statusCode, 400);
  assert.deepEqual(copy.json(), {
    error: 'This request is already on the Feed.',
    code: 'invalid_request',
    retryable: false,
  });
  const sameTitle = await post(h, body('transcribe a PODCAST episode!', { description: 'Other.' }));
  assert.equal(sameTitle.statusCode, 400);

  // The same title from three sites within a day is held for review.
  await posted(h, body('Design a harbor logo', { description: 'One.' }), ip(20));
  await posted(h, body('Design a harbor logo', { description: 'Two.' }), ip(21));
  const third = await posted(h, body('Design a harbor logo', { description: 'Three.' }), ip(22));
  assert.equal(third.request.status, 'held');
  assert.equal((await list(h)).page.requests.length, 3);
});

test('rate limits: three posts per address per hour, then 429; other addresses still post', async (t) => {
  const h = await harness(t);
  for (let n = 0; n < FEED_LIMITS.postsPerHour; n += 1)
    await posted(h, body(`Hourly request number ${n}`));
  const over = await post(h, body('One request too many'));
  assert.equal(over.statusCode, 429);
  // Refused content still costs budget: the filters cannot be probed for free.
  for (let n = 0; n < FEED_LIMITS.postsPerHour; n += 1)
    assert.equal((await post(h, body('Tiny'), ip(3))).statusCode, 400);
  const afterRefusals = await post(h, body('A valid one after refusals'), ip(3));
  assert.equal(afterRefusals.statusCode, 429, afterRefusals.body);
  await posted(h, body('From another address'), ip(2));
  h.clock.now += 3_600_000 + 1;
  await posted(h, body('An hour later again'));
});

test('ten open requests per address at most', async (t) => {
  const h = await harness(t, { postsPerSourceHour: 50, postsPerSourceDay: 50 });
  for (let n = 0; n < FEED_CAPS_DEFAULT.openPerSource; n += 1)
    await posted(h, body(`Open request number ${n}`));
  const over = await post(h, body('Eleventh open request'));
  assert.equal(over.statusCode, 429);
  assert.match(over.json().error, /At most 10 open requests/);
});

test('reports from three networks hide a request; sites of one network, the poster and repeats do not', async (t) => {
  const h = await harness(t);
  const { request } = await posted(h, body('Find a band for a wedding'), ip(1));
  const report = (from: string, reason = 'spam', id = request.id) =>
    h.app.inject({ method: 'POST', url: reportPath(id), payload: { reason }, remoteAddress: from });

  for (const from of [ip(1), '203.0.113.1', '203.0.113.2', '203.0.113.3', '203.0.113.3']) {
    const response = await report(from);
    assert.equal(response.statusCode, 202);
    assert.deepEqual(response.json(), { ok: true });
  }
  assert.equal(
    (await list(h)).page.requests.length,
    1,
    'one network and the poster do not hide it',
  );
  // Three IPv6 /56 sites of one /48 (one free tunnel) count as one network.
  for (const from of ['2001:db8:1:100::1', '2001:db8:1:200::1', '2001:db8:1:300::1'])
    assert.equal((await report(from, 'scam')).statusCode, 202);
  assert.equal((await list(h)).page.requests.length, 1, 'six sites of two networks');
  assert.equal((await report(far(1), 'personal_data')).statusCode, 202);
  assert.deepEqual((await list(h)).page.requests, [], 'three networks hide it');
  assert.ok(h.events.includes('feed.request_hidden'));

  const row = await h.db.query<{ report_count: number; hidden_at: unknown }>(
    'SELECT report_count, hidden_at FROM feed_requests WHERE id=$1',
    [request.id],
  );
  assert.equal(row.rows[0]!.report_count, 7);
  assert.notEqual(row.rows[0]!.hidden_at, null);
  assert.equal((await h.app.inject({ url: requestPath(request.id) })).statusCode, 404);

  // Unknown ids answer the same; a bad reason or a malformed id do not.
  assert.equal((await report(far(2), 'spam', 'req_aaaaaaaaaaaaaaaaaaaa')).statusCode, 202);
  assert.equal((await report(far(2), 'offensive')).statusCode, 400);
  assert.equal((await report(far(2), 'spam', 'nope')).statusCode, 404);
});

test('a hidden request never stops its poster posting the same text again', async (t) => {
  const h = await harness(t);
  const payload = body('Repair a wooden chair');
  const { request } = await posted(h, payload, ip(1));
  for (const n of [1, 2, 3])
    await h.app.inject({
      method: 'POST',
      url: reportPath(request.id),
      payload: { reason: 'spam' },
      remoteAddress: far(n),
    });
  assert.deepEqual((await list(h)).page.requests, []);
  const again = await posted(h, { ...payload, idempotencyKey: randomUUID() }, ip(1));
  assert.equal(again.request.status, 'open');
  assert.deepEqual(titles((await list(h)).page), ['Repair a wooden chair']);
});

/** The sweep just ran: the next one is not due for a while, so nothing past its expiry is swept. */
const sweepNotDue = (h: Harness) =>
  h.db.query("UPDATE feed_flags SET updated_at=$1 WHERE name='sweep'", [h.clock.now]);

test('only a copy on the Feed blocks posting again: closed (after an hour), expired and held ones never do', async (t) => {
  const h = await harness(t, { postsPerSourceHour: 50, postsPerSourceDay: 50 });
  const onTheFeed = {
    error: 'This request is already on the Feed.',
    code: 'invalid_request',
    retryable: false,
  };
  const again = (payload: Record<string, unknown>) => ({
    ...payload,
    idempotencyKey: randomUUID(),
  });
  const closeWith = (id: string, payload: Record<string, unknown>) =>
    h.app.inject({ method: 'POST', url: closePath(id), payload, remoteAddress: ip(1) });

  // Open: the same text, or the same title in other words, is refused as before.
  const open = body('Proofread a cookbook');
  await posted(h, open);
  for (const copy of [again(open), body('proofread a COOKBOOK!', { description: 'Other.' })]) {
    const refused = await post(h, copy);
    assert.equal(refused.statusCode, 400);
    assert.deepEqual(refused.json(), onTheFeed);
  }

  // Closed by its poster: the same title waits an hour, so a close and repost never moves a
  // request to the top of the Feed; the same day it posts again.
  const tune = body('Tune an old piano');
  const tuned = await posted(h, tune);
  assert.equal(
    (await closeWith(tuned.request.id, { manageToken: tuned.manageToken })).statusCode,
    200,
  );
  for (const copy of [again(tune), body('tune an OLD piano', { description: 'Other.' })]) {
    const soon = await post(h, copy);
    assert.equal(soon.statusCode, 400);
    assert.deepEqual(soon.json(), {
      ...onTheFeed,
      error: 'You closed this request less than an hour ago. Post it again later.',
    });
  }
  // Another poster may post the same title at once.
  const theirs = body('Tune an old piano', { description: 'Another piano.' });
  assert.equal((await posted(h, theirs, far(7))).request.status, 'open');
  h.clock.now = START + 59 * 60_000;
  assert.equal((await post(h, again(tune))).statusCode, 400);

  // Expired (past its deadline, not swept yet): the same request posts again.
  const shoot = body('Find a wedding photographer', { deadline: START + 2 * 3_600_000 });
  await posted(h, shoot);
  h.clock.now = START + 3 * 3_600_000;
  assert.equal((await posted(h, again({ ...shoot, deadline: null }))).request.status, 'open');
  assert.equal((await posted(h, again(tune))).request.status, 'open');

  // The same title in other words, past its expiry and not swept yet: still open in storage
  // (posting expires only a copy of the same text), but no longer on the Feed.
  const bake = body('Bake a birthday cake', { deadline: START + 4 * 3_600_000 });
  await posted(h, bake);
  h.clock.now = START + 5 * 3_600_000;
  await sweepNotDue(h);
  const otherWords = body('Bake a birthday cake', { description: 'Chocolate, for twelve.' });
  assert.equal((await posted(h, otherWords)).request.status, 'open');
  assert.equal(
    (
      await h.db.query<{ open: number }>(
        "SELECT count(*)::int AS open FROM feed_requests WHERE title='Bake a birthday cake' AND state='open'",
      )
    ).rows[0]!.open,
    2,
  );

  // Held for review is not on the Feed either.
  const label = body('Label a box of photos');
  assert.equal((await posted(h, { ...label, website: 'https://x.test' })).request.status, 'held');
  assert.equal((await posted(h, again(label))).request.status, 'open');

  // Signed in: closed with the session, posted again; still refused while that one is open.
  h.session.value = { ownerId: 'ws-1' };
  const fence = body('Paint a garden fence');
  const painted = await posted(h, fence, ip(2));
  const twice = await post(h, again(fence), ip(2));
  assert.equal(twice.statusCode, 400);
  assert.deepEqual(twice.json(), onTheFeed);
  assert.equal((await closeWith(painted.request.id, {})).statusCode, 200);
  assert.equal((await post(h, again(fence), ip(2))).statusCode, 400);
  h.clock.now += 61 * 60_000;
  assert.equal((await posted(h, again(fence), ip(2))).request.status, 'open');

  // One copy of each is listed (and the other poster's piano).
  assert.deepEqual(titles((await list(h)).page).sort(), [
    'Bake a birthday cake',
    'Find a wedding photographer',
    'Label a box of photos',
    'Paint a garden fence',
    'Proofread a cookbook',
    'Tune an old piano',
    'Tune an old piano',
  ]);
});

test('the hour after a close holds only a copy that was on the Feed: one closed while held reposts at once', async (t) => {
  const h = await harness(t, { postsPerSourceHour: 50, postsPerSourceDay: 50 });
  const closeHeld = async (payload: Record<string, unknown>) => {
    const held = await posted(h, payload);
    assert.equal(held.request.status, 'held', String(payload.title));
    const closed = await h.app.inject({
      method: 'POST',
      url: closePath(held.request.id),
      payload: { manageToken: held.manageToken },
      remoteAddress: ip(1),
    });
    assert.equal(closed.statusCode, 200, closed.body);
    return held.request.id;
  };

  // Held as risk (a messenger link), closed by its poster, fixed and posted again: listed.
  await closeHeld(
    body('Help with a harbor map', { description: 'Talk to me at https://t.me/harbordesk' }),
  );
  const fixed = await posted(h, body('Help with a harbor map'));
  assert.equal(fixed.request.status, 'open');

  // Held as a honeypot copy, closed: the same title posts again at once too.
  await closeHeld(body('Sort a crate of records', { website: 'https://x.test' }));
  assert.equal((await posted(h, body('Sort a crate of records'))).request.status, 'open');

  // Held, then released by an operator (review.ts clears held_reason) and closed: it was on the
  // Feed, so the hour holds as for any listed copy.
  const released = await posted(
    h,
    body('Frame a river print', { description: 'Talk to me at https://t.me/framedesk' }),
  );
  assert.equal(released.request.status, 'held');
  await h.db.query(
    "UPDATE feed_requests SET state='open', held_reason=NULL, reviewed_at=$2 WHERE id=$1",
    [released.request.id, START],
  );
  assert.equal(
    (
      await h.app.inject({
        method: 'POST',
        url: closePath(released.request.id),
        payload: { manageToken: released.manageToken },
        remoteAddress: ip(1),
      })
    ).statusCode,
    200,
  );
  const soon = await post(h, body('Frame a river print'));
  assert.equal(soon.statusCode, 400);
  assert.equal(
    soon.json().error,
    'You closed this request less than an hour ago. Post it again later.',
  );

  assert.deepEqual(titles((await list(h)).page).sort(), [
    'Help with a harbor map',
    'Sort a crate of records',
  ]);
});

test('one network cannot spend the report budget of everyone', async (t) => {
  const h = await harness(t, { reportsPerSiteHour: 1_000, reportsGlobalHour: 1_000 });
  const { request } = await posted(h, body('Sew a costume'), ip(1));
  const report = (from: string) =>
    h.app.inject({
      method: 'POST',
      url: reportPath(request.id),
      payload: { reason: 'spam' },
      remoteAddress: from,
    });
  for (let n = 0; n < FEED_CAPS_DEFAULT.reportsPerNetworkHour; n += 1)
    assert.equal((await report(`2001:db8:9:${(n * 256).toString(16)}::1`)).statusCode, 202);
  assert.equal((await report('2001:db8:9:ff00::1')).statusCode, 429);
  assert.equal((await report(far(5))).statusCode, 202, 'other networks still report');
});

test('close: the manage token or the posting workspace; others 403, hidden 404, twice 409', async (t) => {
  const h = await harness(t);
  const { request, manageToken } = await posted(h, body('Record a voice-over'));
  const close = (id: string, payload: Record<string, unknown>) =>
    h.app.inject({ method: 'POST', url: closePath(id), payload, remoteAddress: ip(5) });

  const wrong = await close(request.id, { manageToken: `ccf_${'b'.repeat(43)}` });
  assert.equal(wrong.statusCode, 403);
  assert.equal(wrong.json().code, 'not_poster');
  assert.equal((await close(request.id, {})).statusCode, 403);

  const done = await close(request.id, { manageToken });
  assert.equal(done.statusCode, 200);
  const closed = done.json() as PublicFeedRequest;
  assert.equal(closed.status, 'closed');
  assert.equal(closed.closedAt, START);
  assert.deepEqual(Object.keys(closed).sort(), PUBLIC_KEYS);
  assert.deepEqual((await list(h)).page.requests, []);
  const again = await close(request.id, { manageToken });
  assert.equal(again.statusCode, 409);
  assert.equal(again.json().code, 'request_closed');
  assert.equal((await close('req_aaaaaaaaaaaaaaaaaaaa', { manageToken })).statusCode, 404);

  // Signed in: the workspace that posted closes it with its session.
  h.session.value = { ownerId: 'ws-1' };
  const mine = await posted(h, body('Paint a small mural'), ip(6));
  assert.deepEqual(mine.request.postedBy, { kind: 'account', displayName: null });
  assert.equal((await close(mine.request.id, {})).statusCode, 200);
  h.session.value = { ownerId: 'ws-2' };
  const theirs = await posted(h, body('Edit a short video'), ip(7));
  h.session.value = { ownerId: 'ws-1' };
  assert.equal((await close(theirs.request.id, {})).statusCode, 403);

  // Hidden by reports: a stranger gets the unknown answer, the poster can still close it.
  h.session.value = null;
  const reported = await posted(h, body('Fix a squeaky bicycle'), ip(8));
  for (const n of [30, 31, 32])
    await h.app.inject({
      method: 'POST',
      url: reportPath(reported.request.id),
      payload: { reason: 'spam' },
      remoteAddress: far(n),
    });
  const stranger = await close(reported.request.id, {});
  assert.equal(stranger.statusCode, 404);
  assert.equal(stranger.json().code, 'request_not_found');
  const poster = await close(reported.request.id, { manageToken: reported.manageToken });
  assert.equal(poster.statusCode, 200);
  assert.equal((poster.json() as PublicFeedRequest).status, 'closed');
});

const MY_KEYS = [...PUBLIC_KEYS, 'closable'].sort();

async function mine(h: Harness, cursor?: string) {
  const response = await h.app.inject({
    url: cursor ? `${FEED_PATHS.mine}?cursor=${cursor}` : FEED_PATHS.mine,
    remoteAddress: ip(5),
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.headers['cache-control'], 'no-store');
  const page = response.json() as FeedMyRequests;
  return { requests: page.requests, next: page.next, raw: response.body };
}

const shown = (requests: FeedMyRequest[]) =>
  requests.map((request) => [request.title, request.status, request.closable]);

test("the caller's own requests: signed in only, newest first, in review without a reason, never another poster's", async (t) => {
  const h = await harness(t);
  const signedOut = await h.app.inject({ url: FEED_PATHS.mine });
  assert.equal(signedOut.statusCode, 401);
  assert.equal(signedOut.headers['cache-control'], 'no-store');
  assert.deepEqual(signedOut.json(), { error: 'Sign in to continue.' });

  h.session.value = { ownerId: 'ws-1' };
  assert.deepEqual((await mine(h)).requests, []);
  const at = (minutes: number) => (h.clock.now = START + minutes * 60_000);
  const open = await posted(h, body('Plan a harbor festival'));
  at(1);
  const closed = await posted(h, body('Write a ferry timetable'));
  at(2);
  // Risky text: held for review.
  const held = await posted(h, body('Buy gift cards in bulk'));
  assert.equal(held.request.status, 'held');
  at(3);
  const reported = await posted(h, body('Fix a squeaky bicycle'));
  at(4);
  await posted(h, body('Map the city parks', { agentId: 'agent-1' }));
  at(5);
  await posted(
    h,
    body('Walk a dog at noon', {
      deadline: START + 65 * 60_000,
      reply: 'https://desk.example.org/walk',
    }),
  );
  // Another workspace, and a signed-out post from the same address, are not this workspace's.
  h.session.value = { ownerId: 'ws-2' };
  const theirs = await posted(h, body('Edit a short video'));
  h.session.value = null;
  await posted(h, body('Sort a box of receipts'));
  const closeAs = (id: string) =>
    h.app.inject({ method: 'POST', url: closePath(id), payload: {}, remoteAddress: ip(5) });
  assert.equal((await closeAs(closed.request.id)).statusCode, 403);
  for (const n of [30, 31, 32])
    await h.app.inject({
      method: 'POST',
      url: reportPath(reported.request.id),
      payload: { reason: 'spam' },
      remoteAddress: far(n),
    });
  assert.equal((await h.app.inject({ url: requestPath(reported.request.id) })).statusCode, 404);

  h.session.value = { ownerId: 'ws-1' };
  assert.equal((await closeAs(closed.request.id)).statusCode, 200);
  h.clock.now = START + 2 * 3_600_000;
  const { requests, raw } = await mine(h);
  assert.deepEqual(shown(requests), [
    ['Walk a dog at noon', 'expired', false],
    ['Map the city parks', 'open', true],
    // Hidden by reports: "in review" to its poster, like a held one; no reason either way.
    ['Fix a squeaky bicycle', 'held', true],
    ['Buy gift cards in bulk', 'held', true],
    ['Write a ferry timetable', 'closed', false],
    ['Plan a harbor festival', 'open', true],
  ]);
  for (const request of requests) assert.deepEqual(Object.keys(request).sort(), MY_KEYS);
  // Expired: closed at its expiry, without its reply handle.
  assert.equal(requests[0]!.closedAt, START + 65 * 60_000);
  assert.equal(requests[0]!.reply, null);
  assert.deepEqual(requests[1]!.postedBy, { kind: 'agent', displayName: 'Harbor Scout' });
  assert.deepEqual(requests[5]!, { ...open.request, closable: true });
  // Nothing internal: no reason, report, owner, key or hash.
  assert.doesNotMatch(raw, /risk|honeypot|spread|report|hidden|manage|hash|ccf_|ws-|op:|src:/i);

  // Another workspace sees only its own; one that posted nothing sees nothing.
  h.session.value = { ownerId: 'ws-2' };
  assert.deepEqual(
    (await mine(h)).requests.map((request) => request.id),
    [theirs.request.id],
  );
  h.session.value = { ownerId: 'ws-3' };
  assert.deepEqual((await mine(h)).requests, []);

  // After a reload (no manage token kept): the session alone closes an open one and one in review.
  h.session.value = { ownerId: 'ws-1' };
  for (const request of requests.filter((item) => item.closable)) {
    const done = await closeAs(request.id);
    assert.equal(done.statusCode, 200, done.body);
    assert.equal((done.json() as PublicFeedRequest).status, 'closed');
  }
  assert.deepEqual(shown((await mine(h)).requests), [
    ['Walk a dog at noon', 'expired', false],
    ['Map the city parks', 'closed', false],
    ['Fix a squeaky bicycle', 'closed', false],
    ['Buy gift cards in bulk', 'closed', false],
    ['Write a ferry timetable', 'closed', false],
    ['Plan a harbor festival', 'closed', false],
  ]);
});

/** Caps that let one workspace post and close more than mineMax requests in a few minutes. */
const MANY: Partial<FeedCaps> = {
  postsPerOwnerHour: 100,
  postsPerOwnerDay: 100,
  postsOwnersGlobalHour: 1_000,
  postsPerSourceHour: 100,
  postsPerSiteHour: 100,
  postsPerNetworkHour: 100,
  managePerSourceHour: 100,
};

/** Closes with the session alone, as the console does after a reload. */
const closeSignedIn = (h: Harness, id: string) =>
  h.app.inject({ method: 'POST', url: closePath(id), payload: {}, remoteAddress: ip(5) });

test("the caller's own requests: every open and in-review one, then at most mineMax ended ones posted within mineWindowMs", async (t) => {
  const h = await harness(t, { ...MANY, openPerOwner: 100 });
  h.session.value = { ownerId: 'ws-1' };
  // The oldest is still open and one is in review; then more than mineMax newer ones close.
  const open = await posted(h, body('The oldest open request'));
  h.clock.now = START + 1_000;
  const held = await posted(h, body('Buy gift cards in bulk'));
  assert.equal(held.request.status, 'held');
  const ended: string[] = [];
  for (let n = 0; n <= FEED_LIMITS.mineMax; n += 1) {
    h.clock.now = START + (n + 2) * 1_000;
    const { request } = await posted(h, body(`Own request number ${n}`));
    assert.equal((await closeSignedIn(h, request.id)).statusCode, 200);
    ended.push(request.id);
  }
  const { requests } = await mine(h);
  assert.deepEqual(
    requests.map((request) => request.id),
    [...ended.slice(1).reverse(), held.request.id, open.request.id],
  );
  // Still on the Feed, so still listed and closable with the session alone.
  assert.deepEqual(shown(requests.slice(-2)), [
    ['Buy gift cards in bulk', 'held', true],
    ['The oldest open request', 'open', true],
  ]);
  assert.equal((await h.app.inject({ url: requestPath(open.request.id) })).statusCode, 200);

  // Past the window nothing shows, though the expired one is still kept (purged 30 days on).
  h.clock.now = START + FEED_LIMITS.mineWindowMs + 60 * 60_000;
  assert.deepEqual((await mine(h)).requests, []);
  assert.deepEqual(
    (await h.db.query<{ id: string }>('SELECT id FROM feed_requests')).rows.map((row) => row.id),
    [open.request.id],
  );
});

test("the caller's own requests: a run of ones in review never pushes out an open one", async (t) => {
  const h = await harness(t, { ...MANY, openPerOwner: 1 });
  h.session.value = { ownerId: 'ws-1' };
  const open = await posted(h, body('The oldest open request'));
  const held: string[] = [];
  for (let n = 0; n <= FEED_LIMITS.mineMax; n += 1) {
    h.clock.now = START + (n + 1) * 1_000;
    const { request } = await posted(h, {
      ...body(`Held request number ${n}`),
      website: 'https://x.test',
    });
    assert.equal(request.status, 'held');
    held.push(request.id);
  }
  // A page holds min(openPerOwner, mineOpenPageMax) + mineMax: here 1 + mineMax, so the open
  // one is on the next page, still listed and closable.
  const first = await mine(h);
  assert.deepEqual(
    first.requests.map((request) => request.id),
    [...held].reverse(),
  );
  assert.ok(first.next);
  const second = await mine(h, first.next);
  assert.deepEqual(shown(second.requests), [['The oldest open request', 'open', true]]);
  assert.equal(second.requests[0]!.id, open.request.id);
  assert.equal(second.next, null);
});

test("the caller's own requests: paging through ended ones, no overlap, no gap, the oldest past mineMax never shown", async (t) => {
  const h = await harness(t, { ...MANY, openPerOwner: 1 });
  h.session.value = { ownerId: 'ws-1' };
  // mineMax + 1 ended ones, then newer ones in review: a page (1 + mineMax) ends inside the
  // ended part, so the next page reads it from the cursor.
  const ended: string[] = [];
  for (let n = 0; n <= FEED_LIMITS.mineMax; n += 1) {
    h.clock.now = START + (n + 1) * 1_000;
    const { request } = await posted(h, body(`Own request number ${n}`));
    assert.equal((await closeSignedIn(h, request.id)).statusCode, 200);
    ended.push(request.id);
  }
  const held: string[] = [];
  for (let n = 0; n < 10; n += 1) {
    h.clock.now = START + (FEED_LIMITS.mineMax + n + 2) * 1_000;
    const { request } = await posted(h, {
      ...body(`Held request number ${n}`),
      website: 'https://x.test',
    });
    held.push(request.id);
  }
  const first = await mine(h);
  assert.equal(first.requests.length, 1 + FEED_LIMITS.mineMax);
  assert.ok(first.next);
  const second = await mine(h, first.next);
  assert.equal(second.next, null);
  // Newest first across both pages: every one in review, then the newest mineMax ended ones;
  // the oldest ended one (past mineMax) is on neither page.
  assert.deepEqual(
    [...first.requests, ...second.requests].map((request) => request.id),
    [...held.reverse(), ...ended.slice(1).reverse()],
  );
  assert.equal(second.requests.length, 9);
  assert.ok(second.requests.every((request) => request.status === 'closed'));
});

test("the caller's own requests: a page is bounded however far the open cap is raised", async (t) => {
  assert.equal(minePageSize({ openPerOwner: 50 }), 50 + FEED_LIMITS.mineMax);
  assert.equal(
    minePageSize({ openPerOwner: 10_000 }),
    FEED_LIMITS.mineOpenPageMax + FEED_LIMITS.mineMax,
  );
  assert.equal(FEED_LIMITS.mineOpenPageMax, 200);

  const h = await harness(t, { ...MANY, openPerOwner: 1 });
  h.session.value = { ownerId: 'ws-1' };
  // mineMax ended and one open fill exactly one page: no next.
  const ids: string[] = [];
  for (let n = 0; n < FEED_LIMITS.mineMax; n += 1) {
    h.clock.now = START + (n + 1) * 1_000;
    const { request } = await posted(h, body(`Own request number ${n}`));
    assert.equal((await closeSignedIn(h, request.id)).statusCode, 200);
    ids.push(request.id);
  }
  h.clock.now += 1_000;
  ids.push((await posted(h, body('The newest open request'))).request.id);
  const whole = await mine(h);
  assert.deepEqual(
    whole.requests.map((request) => request.id),
    [...ids].reverse(),
  );
  assert.equal(whole.next, null);
  // Only a cursor from next is read.
  for (const query of ['?cursor=nope', '?page=2', '?cursor=1-aaaa&x=1']) {
    const refused = await h.app.inject({ url: `${FEED_PATHS.mine}${query}`, remoteAddress: ip(5) });
    assert.equal(refused.statusCode, 400, query);
    assert.equal(refused.json().code, 'invalid_request', query);
  }
});

test("the caller's own requests: one past its expiry and not swept yet shows as the sweep will store it", async (t) => {
  const h = await harness(t);
  h.session.value = { ownerId: 'ws-1' };
  const walk = await posted(
    h,
    body('Walk a dog at noon', {
      deadline: START + 65 * 60_000,
      reply: 'https://desk.example.org/walk',
    }),
  );
  h.clock.now = START + 2 * 3_600_000;
  await sweepNotDue(h);
  const [request] = (await mine(h)).requests;
  assert.equal(request!.id, walk.request.id);
  assert.equal(request!.status, 'expired');
  assert.equal(request!.closable, false);
  assert.equal(request!.closedAt, request!.expiresAt);
  assert.equal(request!.closedAt, START + 65 * 60_000);
  assert.equal(request!.reply, null);
  // Not swept: storage still says open, with its reply.
  const stored = await h.db.query<{ state: string; reply: string | null }>(
    'SELECT state, reply FROM feed_requests WHERE id=$1',
    [walk.request.id],
  );
  assert.deepEqual(stored.rows[0], { state: 'open', reply: 'https://desk.example.org/walk' });
});

test("the caller's own list charges the Feed's read limit, signed in or not", async (t) => {
  const h = await harness(t, { readsPerMinute: 2 });
  const read = (signedIn: boolean) => {
    h.session.value = signedIn ? { ownerId: 'ws-1' } : null;
    return h.app.inject({ url: FEED_PATHS.mine, remoteAddress: ip(5) });
  };
  assert.equal((await read(false)).statusCode, 401);
  assert.equal((await read(true)).statusCode, 200);
  assert.equal((await read(true)).statusCode, 429);
  assert.deepEqual(
    h.charged.map((bucket) => bucket.max),
    [2, 2, 2],
  );
  assert.ok(h.charged.every((bucket) => bucket.key.startsWith('ip:feed:')));
});

test("signed in: posting as an own agent; an agent needs a session and must be the caller's", async (t) => {
  const h = await harness(t);
  const anonymous = await post(h, body('Map the city parks', { agentId: 'agent-1' }));
  assert.equal(anonymous.statusCode, 401);
  h.session.value = { ownerId: 'ws-1' };
  const unknown = await post(h, body('Map the city parks', { agentId: 'agent-9' }));
  assert.equal(unknown.statusCode, 404);
  assert.equal(unknown.json().code, 'agent_not_found');
  const agent = await posted(
    h,
    body('Map the city parks', { agentId: 'agent-1', displayName: 'ignored when signed in' }),
  );
  assert.deepEqual(agent.request.postedBy, { kind: 'agent', displayName: 'Harbor Scout' });
});

test('expired requests are not listed; the sweep expires them and erases the reply handle', async (t) => {
  const h = await harness(t);
  const soon = await posted(
    h,
    body('Book a sound engineer', {
      deadline: START + 2 * 3_600_000,
      reply: 'https://desk.example.org/seven',
    }),
  );
  await posted(h, body('Plan a city walking tour'), ip(2));
  h.clock.now = START + 3 * 3_600_000;
  assert.deepEqual(titles((await list(h)).page), ['Plan a city walking tour']);
  const status = await h.app.inject({ url: FEED_PATHS.status });
  assert.equal((status.json() as FeedStatus).openRequests, 1);

  // An expired request cannot be closed or reported into hiding any more.
  const close = await h.app.inject({
    method: 'POST',
    url: closePath(soon.request.id),
    payload: { manageToken: soon.manageToken },
    remoteAddress: ip(1),
  });
  assert.equal(close.statusCode, 409);

  const service = createFeedRequests({
    db: h.db,
    clock: () => h.clock.now,
    secret: () => HASHING,
    limit: async () => {},
  });
  await service.sweep();
  const row = await h.db.query<{ state: string; reply: string | null }>(
    'SELECT state, reply FROM feed_requests WHERE id=$1',
    [soon.request.id],
  );
  assert.deepEqual(row.rows[0], { state: 'expired', reply: null });

  h.clock.now = START + 15 * 86_400_000;
  assert.deepEqual((await list(h)).page.requests, []);
  h.clock.now = START + 46 * 86_400_000;
  await service.sweep();
  assert.equal((await h.db.query('SELECT id FROM feed_requests')).rows.length, 0);
});

test('cursor paging: newest first, no overlap, next null on the last page; search and tag filter', async (t) => {
  const h = await harness(t, {
    postsPerSourceHour: 100,
    postsPerSourceDay: 100,
    postsPerSiteHour: 100,
    openPerSource: 100,
  });
  const total = FEED_LIMITS.pageSize + 6;
  for (let n = 0; n < total; n += 1) {
    h.clock.now = START + n * 1_000;
    await posted(
      h,
      body(`Request number ${String(n).padStart(2, '0')}`, {
        capabilities: n % 2 ? ['odd'] : ['even'],
        description: n === 7 ? 'Needs a lighthouse photographer.' : `Plain request ${n}.`,
      }),
    );
  }
  const first = (await list(h)).page;
  assert.equal(first.requests.length, FEED_LIMITS.pageSize);
  assert.equal(first.requests[0]!.title, `Request number ${total - 1}`);
  assert.ok(first.next);
  const second = (await list(h, `?cursor=${first.next}`)).page;
  assert.equal(second.requests.length, 6);
  assert.equal(second.next, null);
  const all = [...titles(first), ...titles(second)];
  assert.equal(new Set(all).size, total);
  assert.deepEqual(
    all,
    Array.from(
      { length: total },
      (_, n) => `Request number ${String(total - 1 - n).padStart(2, '0')}`,
    ),
  );

  assert.deepEqual(titles((await list(h, '?q=lighthous')).page), ['Request number 07']);
  assert.deepEqual(titles((await list(h, '?q=nothing-matches-this')).page), []);
  const odd = (await list(h, '?tag=odd')).page;
  assert.ok(odd.requests.every((request) => request.capabilities.includes('odd')));
  assert.equal(odd.requests.length, total / 2);
  const bad = await h.app.inject({ url: `${FEED_PATHS.requests}?sort=newest` });
  assert.equal(bad.statusCode, 400);
  assert.equal((await h.app.inject({ url: `${FEED_PATHS.requests}?tag=Bad_Tag` })).statusCode, 400);
});

test('limits, prefixes, tables and the manage token prefix are wired', () => {
  for (const key of [
    'feed-post:x',
    'feed-post-day:x',
    'feed-post-site:x',
    'feed-post-network:x',
    'feed-post-region:x',
    'feed-post-global',
    'feed-post-owner:x',
    'feed-post-owner-day:x',
    'feed-post-owner-global',
    'feed-post-signed:x',
    'feed-post-signed-day:x',
    'feed-post-signed-site:x',
    'feed-post-signed-network:x',
    'feed-post-signed-region:x',
    'feed-report:x',
    'feed-report-site:x',
    'feed-report-network:x',
    'feed-report-region:x',
    'feed-report-global',
    'feed-manage:x',
  ]) {
    assert.equal(outageMode(key), 'fail-closed', key);
    assert.ok(FAIL_CLOSED_PREFIXES.includes(key.split(':')[0]!), `${key} is listed`);
  }
  assert.equal(FEED_CAP_ENV.postsPerSourceHour, 'CITY_LIMIT_FEED_POSTS_PER_SOURCE_HOUR');
  assert.equal(feedCaps({ CITY_LIMIT_FEED_OPEN_GLOBAL: '7' }).openGlobal, 7);
  assert.throws(() => feedCaps({ CITY_LIMIT_FEED_OPEN_GLOBAL: '0' }));
  assert.ok(ROOM_CREDENTIAL_PATTERN.test(`ccf_${'c'.repeat(43)}`));
  assert.deepEqual(
    [...FEED_REQUEST_TABLES],
    ['feed_requests', 'feed_request_reports', 'feed_source_blocks', 'feed_flags'],
  );
});

test('one request: open ones answer, every other kind answers the same 404', async (t) => {
  const h = await harness(t, { postsPerSourceHour: 50, postsPerSourceDay: 50 });
  const open = await posted(h, body('Score a short film'));
  const one = await h.app.inject({ url: requestPath(open.request.id) });
  assert.equal(one.statusCode, 200);
  assert.equal(one.headers['cache-control'], ON_BASE_LIVE);
  assert.deepEqual(one.json(), open.request);

  const held = await posted(h, body('Buy gift cards in bulk'));
  const closed = await posted(h, body('Knit a winter scarf'));
  await h.app.inject({
    method: 'POST',
    url: closePath(closed.request.id),
    payload: { manageToken: closed.manageToken },
    remoteAddress: ip(1),
  });
  const expiring = await posted(h, body('Walk a dog at noon', { deadline: START + 3_600_000 }));
  h.clock.now = START + 2 * 3_600_000;
  const answers = [];
  for (const id of [
    held.request.id,
    closed.request.id,
    expiring.request.id,
    'req_aaaaaaaaaaaaaaaaaaaa',
    'nope',
  ]) {
    const response = await h.app.inject({ url: requestPath(id) });
    assert.equal(response.statusCode, 404, id);
    answers.push(response.body);
  }
  assert.equal(new Set(answers).size, 1);
  assert.equal(JSON.parse(answers[0]!).code, 'request_not_found');
  const withQuery = await h.app.inject({ url: `${requestPath(open.request.id)}?x=1` });
  assert.equal(withQuery.statusCode, 400);
});

test('paused posting and a missing hashing secret answer 503', async (t) => {
  const h = await harness(t);
  await h.db.query(
    "INSERT INTO feed_flags (name, enabled, updated_at, updated_by) VALUES ('posting', false, 1, 'ops')",
  );
  const paused = await post(h, body('Clean a bicycle chain'));
  assert.equal(paused.statusCode, 503);
  assert.match(paused.json().error, /paused/);
  assert.equal(paused.json().code, 'posting_paused');
  assert.equal(paused.json().retryable, true);
  await h.db.query("UPDATE feed_flags SET enabled=true WHERE name='posting'");
  h.secret.value = undefined;
  const unkeyed = await post(h, body('Clean a bicycle chain'));
  assert.equal(unkeyed.statusCode, 503);
  h.secret.value = 'short';
  assert.equal((await post(h, body('Clean a bicycle chain'))).statusCode, 503);
  h.secret.value = HASHING;
  await posted(h, body('Clean a bicycle chain'));
});

test('signed-in posts have their own site-wide budget', async (t) => {
  const h = await harness(t, { postsGlobalHour: 1 });
  await posted(h, body('Water the plants'), ip(1));
  assert.equal((await post(h, body('Feed the cat'), ip(2))).statusCode, 429);
  h.session.value = { ownerId: 'ws-1' };
  const signed = await posted(h, body('Feed the cat'), ip(2));
  assert.equal(signed.request.postedBy.kind, 'account');
});

test('a signed-out retry key must be random; a signed-in one only needs to be unique', async (t) => {
  const h = await harness(t);
  const weak = await post(h, body('Hang three shelves', { idempotencyKey: 'harbor-shelves-1' }));
  assert.equal(weak.statusCode, 400);
  assert.match(weak.json().error, /idempotencyKey/);
  h.session.value = { ownerId: 'ws-1' };
  await posted(h, body('Hang three shelves', { idempotencyKey: 'harbor-shelves-1' }));
});

test('search ignores one-letter words', async (t) => {
  const h = await harness(t);
  await posted(h, body('Draw a map of the harbor'));
  assert.deepEqual(titles((await list(h, '?q=a')).page), []);
  assert.deepEqual(titles((await list(h, '?q=a%20harb')).page), ['Draw a map of the harbor']);
});

test('search reads the tags: q finds a request by a tag its text never says; q and tag together', async (t) => {
  const h = await harness(t);
  await posted(
    h,
    body('Scan old receipts', {
      description: 'Turn paper receipts into text.',
      capabilities: ['ocr', 'pdf-parse'],
    }),
  );
  h.clock.now += 1_000;
  await posted(h, body('Draw a map of the harbor', { capabilities: ['maps'] }));
  h.clock.now += 1_000;
  // Held (the honeypot): its tag finds nothing.
  await post(h, body('Read scanned forms', { capabilities: ['ocr'], website: 'https://x.test' }));

  assert.deepEqual(titles((await list(h, '?q=ocr')).page), ['Scan old receipts']);
  // Tags match like the words of the title: by prefix, and a dashed tag by its parts.
  assert.deepEqual(titles((await list(h, '?q=oc')).page), ['Scan old receipts']);
  assert.deepEqual(titles((await list(h, '?q=parse')).page), ['Scan old receipts']);
  assert.deepEqual(titles((await list(h, '?q=pdf-parse')).page), ['Scan old receipts']);
  // Every word must match, each in the title, the description or the tags.
  assert.deepEqual(titles((await list(h, '?q=receipts%20ocr')).page), ['Scan old receipts']);
  assert.deepEqual(titles((await list(h, '?q=harbor%20ocr')).page), []);
  assert.deepEqual(titles((await list(h, '?q=maps')).page), ['Draw a map of the harbor']);

  // The tag filter is unchanged (exact), alone and together with q.
  assert.deepEqual(titles((await list(h, '?tag=ocr')).page), ['Scan old receipts']);
  assert.deepEqual(titles((await list(h, '?tag=pdf')).page), []);
  assert.deepEqual(titles((await list(h, '?tag=ocr&q=ocr')).page), ['Scan old receipts']);
  assert.deepEqual(titles((await list(h, '?tag=ocr&q=paper')).page), ['Scan old receipts']);
  assert.deepEqual(titles((await list(h, '?tag=maps&q=ocr')).page), []);
  assert.deepEqual(titles((await list(h, '?tag=ocr&q=harbor')).page), []);
});

test('search reads the tags: a dashed tag with a number part is found by the tag and by the number', async (t) => {
  const h = await harness(t);
  // Postgres reads "-8004" as a signed number, which no search word matches: the tags are split
  // at their dashes first.
  await posted(h, body('Rate agents on chain', { capabilities: ['erc-8004'] }));
  h.clock.now += 1_000;
  await posted(h, body('Sign a transfer', { capabilities: ['eip-3009', 'x-402'] }));
  h.clock.now += 1_000;
  await posted(h, body('Host a large model', { capabilities: ['llama-3-70b'] }));

  for (const q of ['erc-8004', '8004', 'erc%208004', 'erc-80']) {
    assert.deepEqual(titles((await list(h, `?q=${q}`)).page), ['Rate agents on chain'], q);
  }
  for (const q of ['eip-3009', '3009', 'x-402', '402']) {
    assert.deepEqual(titles((await list(h, `?q=${q}`)).page), ['Sign a transfer'], q);
  }
  for (const q of ['llama-3-70b', '70b', 'llama']) {
    assert.deepEqual(titles((await list(h, `?q=${q}`)).page), ['Host a large model'], q);
  }
  assert.deepEqual(titles((await list(h, '?q=erc-3009')).page), []);

  // The tag filter stays exact, alone and with q.
  assert.deepEqual(titles((await list(h, '?tag=erc-8004')).page), ['Rate agents on chain']);
  assert.deepEqual(titles((await list(h, '?tag=erc')).page), []);
  assert.deepEqual(titles((await list(h, '?tag=erc-8004&q=8004')).page), ['Rate agents on chain']);
  assert.deepEqual(titles((await list(h, '?tag=erc-8004&q=3009')).page), []);
});

test('search splits dashes in the title and the description too', async (t) => {
  const h = await harness(t);
  await posted(
    h,
    body('ERC-8004 rating for my agent', { description: 'Read the EIP-3009 transfer log.' }),
  );
  h.clock.now += 1_000;
  await posted(h, body('Draw a map of the harbor'));

  for (const q of ['8004', 'erc-8004', 'erc%208004', '3009', 'eip-3009']) {
    assert.deepEqual(titles((await list(h, `?q=${q}`)).page), ['ERC-8004 rating for my agent'], q);
  }
  assert.deepEqual(titles((await list(h, '?q=erc-9999')).page), []);
});

test('migration 105: no table rewrite, searches rows already there, runs twice cleanly, index used', async (t) => {
  registerFeedRequestsMigration();
  const versions = listMigrations().map((migration) => migration.version);
  assert.ok(versions.includes(103) && versions.includes(105));
  assert.ok(versions.indexOf(105) > versions.indexOf(103));
  assert.equal(feedRequestSearchMigration.name, 'feed_requests_search_tags');
  assert.equal(feedRequestSearchMigration.sql, FEED_REQUEST_SEARCH_SQL);
  // Nothing that rewrites or locks the live table for long: no new column, no table change.
  assert.doesNotMatch(
    FEED_REQUEST_SEARCH_SQL,
    /ALTER TABLE|ADD COLUMN|STORED|DROP |DELETE FROM|TRUNCATE|UPDATE /i,
  );
  assert.ok(FEED_REQUEST_SEARCH_SQL.includes(`USING gin ((${FEED_REQUEST_TEXT}))`));

  const pg = await PGlite.create('memory://');
  t.after(() => pg.close());
  await pg.exec('CREATE TABLE operators (id text PRIMARY KEY);');
  assert.deepEqual((await runMigrations(pg, [feedRequestsMigration])).applied, [103]);
  // A request the previous build stored: its tag is nowhere in its text.
  await pg.query(
    `INSERT INTO feed_requests (id, state, title, description, capabilities, poster_kind,
       poster_key, source_hash, site_hash, content_key, title_key, manage_hash, idempotency_hash,
       created_at, expires_at)
     VALUES ('req_aaaaaaaaaaaaaaaaaaaa', 'open', 'Scan old receipts', 'Paper into text.',
       '{ocr,erc-8004}', 'anonymous', 'src:test-0001', 'test-0001', 'test-0001', 'test-0001',
       'test-0001', 'test-0001', 'test-0001', 1, 2)`,
  );
  const columns = async () =>
    (
      await pg.query<{ column_name: string }>(
        "SELECT column_name FROM information_schema.columns WHERE table_name = 'feed_requests' ORDER BY column_name",
      )
    ).rows.map((row) => row.column_name);
  const before = await columns();
  const found = async (query = "'ocr':*") =>
    (
      await pg.query<{ id: string }>(
        `SELECT id FROM feed_requests WHERE state = 'open' AND hidden_at IS NULL
           AND ${FEED_REQUEST_TEXT} @@ to_tsquery('simple', $1)`,
        [query],
      )
    ).rows.map((row) => row.id);

  assert.deepEqual(
    (await runMigrations(pg, [feedRequestsMigration, feedRequestSearchMigration])).applied,
    [105],
  );
  assert.deepEqual(await columns(), before);
  assert.deepEqual(await found(), ['req_aaaaaaaaaaaaaaaaaaaa']);
  // The existing row's dashed tag is split too: its number part is a word of its own.
  assert.deepEqual(await found("'erc':* & '8004':*"), ['req_aaaaaaaaaaaaaaaaaaaa']);
  // Applied again by hand (IF NOT EXISTS, CREATE OR REPLACE): nothing changes, nothing fails.
  await pg.exec(FEED_REQUEST_SEARCH_SQL);
  await pg.exec(FEED_REQUEST_SEARCH_SQL);
  assert.deepEqual(await columns(), before);
  assert.deepEqual(await found(), ['req_aaaaaaaaaaaaaaaaaaaa']);
  assert.deepEqual(await found("'8004':*"), ['req_aaaaaaaaaaaaaaaaaaaa']);
  // And a recorded 105 is never applied twice.
  assert.deepEqual(
    (await runMigrations(pg, [feedRequestsMigration, feedRequestSearchMigration])).applied,
    [],
  );
  const helper = await pg.query<{ provolatile: string }>(
    "SELECT provolatile FROM pg_proc WHERE proname = 'feed_request_text'",
  );
  assert.deepEqual(helper.rows, [{ provolatile: 'i' }]);
  // One expression GIN index, over what lists can show, next to 103's.
  const indexes = await pg.query<{ indexname: string; indexdef: string }>(
    "SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'feed_requests' AND indexname IN ('feed_requests_search', 'feed_requests_text') ORDER BY indexname",
  );
  assert.deepEqual(
    indexes.rows.map((row) => row.indexname),
    ['feed_requests_search', 'feed_requests_text'],
  );
  const added = indexes.rows[1]!.indexdef;
  assert.ok(
    added.includes(
      "USING gin (to_tsvector('simple'::regconfig, feed_request_text(title, description, capabilities)))",
    ),
    added,
  );
  assert.ok(added.endsWith("WHERE ((state = 'open'::text) AND (hidden_at IS NULL))"), added);
  // The planner takes it for the lists' exact query, once the table holds enough open requests.
  await pg.query(
    `INSERT INTO feed_requests (id, state, title, description, capabilities, poster_kind,
       poster_key, source_hash, site_hash, content_key, title_key, manage_hash, idempotency_hash,
       created_at, expires_at)
     SELECT 'req_' || lpad(n::text, 20, 'b'), 'open', 'Draw a map ' || n, 'Of the harbor.',
       '{maps}', 'anonymous', 'src:map-' || n, 'map', 'map', 'map-' || n, 'map-' || n,
       'map-' || n, 'map-' || n, n, 10
     FROM generate_series(1, 2000) AS n`,
  );
  await pg.exec('ANALYZE feed_requests');
  const plan = await pg.query<{ 'QUERY PLAN': string }>(
    `EXPLAIN SELECT id FROM feed_requests WHERE state='open' AND hidden_at IS NULL AND expires_at>1
       AND ${FEED_REQUEST_TEXT} @@ to_tsquery('simple', 'ocr:*')
       ORDER BY created_at DESC, id DESC LIMIT 21`,
  );
  assert.match(plan.rows.map((row) => row['QUERY PLAN']).join('\n'), /feed_requests_text/);
});

test('upkeep runs when the database says it is due, without counting posts', async (t) => {
  const h = await harness(t);
  const soon = await posted(
    h,
    body('Tow a small boat', {
      deadline: START + 3_600_000,
      reply: 'https://boats.example.org/tow',
    }),
  );
  h.clock.now = START + 2 * 3_600_000;
  await list(h);
  const row = await h.db.query<{ state: string; reply: string | null }>(
    'SELECT state, reply FROM feed_requests WHERE id=$1',
    [soon.request.id],
  );
  assert.deepEqual(row.rows[0], { state: 'expired', reply: null });
  const due = await h.db.query<{ updated_at: string | number }>(
    "SELECT updated_at FROM feed_flags WHERE name='sweep'",
  );
  assert.equal(Number(due.rows[0]!.updated_at), START + 2 * 3_600_000);
});

test('CITY_FEED off: an oversized body answers the same 404 (the flag is checked before the body is read)', async (t) => {
  const h = await harness(t);
  const { request } = await posted(h, body('Translate a menu into Greek'));
  h.flag.on = false;
  for (const [url, payload] of [
    [FEED_PATHS.requests, body('Huge body', { description: 'x'.repeat(20_000) })],
    [reportPath(request.id), { reason: 'spam', note: 'x'.repeat(5_000) }],
    [closePath(request.id), { manageToken: 'x'.repeat(2_000) }],
  ] as const) {
    const response = await h.app.inject({ method: 'POST', url, payload });
    assert.equal(response.statusCode, 404, `oversized ${url}`);
    assert.deepEqual(response.json(), { error: 'Not found.', code: 'not_found', retryable: false });
  }
});

test('an account posts without a name: the sign-in name is never published', async (t) => {
  const h = await harness(t);
  h.session.value = { ownerId: 'ws-1' };
  const account = await posted(h, body('Paint a garden fence', { displayName: 'Dock office' }));
  assert.deepEqual(account.request.postedBy, { kind: 'account', displayName: null });
  const row = await h.db.query<{ display_name: string | null }>(
    'SELECT display_name FROM feed_requests WHERE id=$1',
    [account.request.id],
  );
  assert.equal(row.rows[0]!.display_name, null);
});

test('an agent name longer than displayNameMax is cut to it', async (t) => {
  const h = await harness(t);
  h.session.value = { ownerId: 'ws-1' };
  const long = 'Harbor Scout of the Northern Docks and the Old Piers';
  h.agents['agent-long'] = long;
  const cut = await posted(h, body('Sort a seed library', { agentId: 'agent-long' }));
  assert.equal(cut.request.status, 'open');
  assert.equal(
    cut.request.postedBy.displayName,
    Array.from(long).slice(0, FEED_LIMITS.displayNameMax).join('').trim(),
  );
});

test('an agent name with contact details or a key is withheld and the request held', async (t) => {
  const h = await harness(t);
  h.session.value = { ownerId: 'ws-1' };
  const broken = [
    '‮Central City Support dock.office@example.com +41 44 555 01 23 https://evil.example/x',
    'Desk dock.office@example.com',
    'Desk +41 44 555 01 23',
    'harbor-deals.net dock.office@example.com',
  ];
  for (const [n, name] of broken.entries()) {
    h.agents[`agent-broken-${n}`] = name;
    const response = await post(
      h,
      body(`Agent request number ${n}`, { agentId: `agent-broken-${n}` }),
    );
    assert.equal(response.statusCode, 201, `${name}: ${response.body}`);
    const { request } = response.json() as PostedFeedRequest;
    assert.deepEqual(request.postedBy, { kind: 'agent', displayName: null }, name);
    assert.equal(request.status, 'held', name);
    const row = await h.db.query<{ display_name: string | null; held_reason: string }>(
      'SELECT display_name, held_reason FROM feed_requests WHERE id=$1',
      [request.id],
    );
    assert.deepEqual(row.rows[0], { display_name: null, held_reason: 'risk' }, name);
  }
  // A name that keeps every rule is published.
  const fine = await posted(h, body('Map the city parks', { agentId: 'agent-1' }));
  assert.deepEqual(fine.request.postedBy, { kind: 'agent', displayName: 'Harbor Scout' });
  const { page, raw } = await list(h);
  assert.deepEqual(titles(page), ['Map the city parks']);
  assert.doesNotMatch(raw, /example\.com|Central City|Admin/);
});

test('an agent name that is only reserved or address-shaped is withheld; the request is listed', async (t) => {
  const h = await harness(t, { postsPerSourceHour: 50, postsPerSourceDay: 50 });
  h.session.value = { ownerId: 'ws-1' };
  const withheld = [
    'Central City Support',
    'harbor-deals.net',
    'Desk https://evil.example/x',
    'Feed Admin',
    '‮Support',
    'Support Assistant',
    'Sales Team Bot',
    'Writer.ai',
    'Admin Helper',
    'IT Helpdesk',
    'Trader.io',
  ];
  for (const [n, name] of withheld.entries()) {
    h.agents[`agent-withheld-${n}`] = name;
    const agent = await posted(
      h,
      body(`Agent withheld request ${n}`, { agentId: `agent-withheld-${n}` }),
    );
    assert.deepEqual(agent.request.postedBy, { kind: 'agent', displayName: null }, name);
    assert.equal(agent.request.status, 'open', name);
  }
  const { page, raw } = await list(h);
  assert.equal(page.requests.length, withheld.length);
  assert.doesNotMatch(raw, /evil|harbor|Central City|Admin|Support|Writer|Trader|Team/);
});

test('signed-in posts are charged per address, site, network and region, each under the accounts budget', async (t) => {
  const h = await harness(t);
  h.session.value = { ownerId: 'ws-1' };
  await posted(h, body('Plant three apple trees'));
  const charged = new Map(h.charged.map(({ key, max }) => [key.split(':')[0]!, max]));
  for (const prefix of [
    'feed-post-signed',
    'feed-post-signed-day',
    'feed-post-signed-site',
    'feed-post-signed-network',
    'feed-post-signed-region',
  ])
    assert.ok(charged.has(prefix), prefix);
  assert.ok(!charged.has('feed-post'), 'never the signed-out bucket of the address');
  for (const prefix of [
    'feed-post-signed',
    'feed-post-signed-site',
    'feed-post-signed-network',
    'feed-post-signed-region',
  ])
    assert.ok(charged.get(prefix)! < FEED_CAPS_DEFAULT.postsOwnersGlobalHour, prefix);
});

test('free accounts on one /56 use up that site, not the accounts budget; another network still posts', async (t) => {
  const h = await harness(t, { postsPerSiteHour: 1 });
  for (let n = 1; n <= 10; n += 1) {
    h.session.value = { ownerId: `ws-${n}` };
    await posted(h, body(`Site request number ${n}`), `2001:db8:5:${(0x100 + n).toString(16)}::1`);
  }
  h.session.value = { ownerId: 'ws-11' };
  assert.equal((await post(h, body('One site too many'), '2001:db8:5:1ff::1')).statusCode, 429);
  h.session.value = { ownerId: 'ws-12' };
  await posted(h, body('From another network'), '2001:db8:6:100::1');
});

test('one address, many accounts: ten times the signed-out daily cap, then 429 for the day', async (t) => {
  const h = await harness(t, { postsPerSourceDay: 1 });
  for (let n = 1; n <= 10; n += 1) {
    h.session.value = { ownerId: `ws-${n}` };
    await posted(h, body(`Daily request number ${n}`), ip(40));
  }
  h.session.value = { ownerId: 'ws-11' };
  assert.equal((await post(h, body('One more today'), ip(40))).statusCode, 429);
  h.clock.now += 2 * 3_600_000;
  assert.equal((await post(h, body('Two hours later'), ip(40))).statusCode, 429);
});

test('a signed-in poster never spends the signed-out budget of its address', async (t) => {
  const h = await harness(t);
  h.session.value = { ownerId: 'ws-1' };
  for (let n = 0; n < FEED_LIMITS.postsPerHour; n += 1)
    await posted(h, body(`Signed request number ${n}`), ip(1));
  h.session.value = null;
  await posted(h, body('Signed out after that'), ip(1));
});

test('phone numbers with parentheses, a country code or a slash are refused; dates are not phones', async (t) => {
  const h = await harness(t, { postsPerSourceHour: 50, postsPerSourceDay: 50 });
  for (const description of [
    'Call (555) 123-4567 after noon',
    'Call +1 (555) 123-4567 after noon',
    'Ruf 0170 / 123 45 67 an',
    'Ruf 0170/1234567 an',
  ]) {
    const response = await post(h, body('Phone in the text', { description }));
    assert.equal(response.statusCode, 400, `${description}: ${response.body}`);
    assert.match(response.json().error, /phone numbers/);
  }
  const dated = await posted(
    h,
    body('Dates are not phones', {
      description: 'From 14/10/2026 to 20/10/2026, or 14.10.2026 - 20.10.2026, or 2026/10/14',
    }),
  );
  assert.equal(dated.request.status, 'open');
});

test('links without a scheme count toward the cap and meet the same link rules', async (t) => {
  const h = await harness(t, { postsPerSourceHour: 50, postsPerSourceDay: 50 });
  for (const description of [
    'a.example.com/1 b.example.net/2 c.example.org/3',
    'https://a.example/1 https://b.example/2 c.example.com/3',
    'See 192.0.2.10/brief',
    'See xn--80ak6aa92e.com/login',
    'See docs.example.org:8443/brief',
  ]) {
    const response = await post(h, body('Links in the text', { description }));
    assert.equal(response.statusCode, 400, `${description}: ${response.body}`);
    assert.match(response.json().error, /links|Links/);
  }
  const two = await posted(
    h,
    body('Two links, one without a scheme', {
      description: 'See docs.example.org/brief and https://b.example/2',
    }),
  );
  assert.equal(two.request.status, 'open');
  assert.equal(two.request.description, 'See docs.example.org/brief and https://b.example/2');
});

test('the reply handle may not carry an email address or phone number, encoded or not', async (t) => {
  const h = await harness(t, { postsPerSourceHour: 50, postsPerSourceDay: 50 });
  for (const reply of [
    'https://studio.example.org/dock.office@example.com',
    'https://studio.example.org/dock.office%40example.com',
    'https://studio.example.org/call/+41445550123',
    'https://studio.example.org/call/%2B41%2044%20555%2001%2023',
    'https://studio.example.org/call/%252B41445550123',
  ]) {
    const response = await post(h, body('Bind a small notebook', { reply }));
    assert.equal(response.statusCode, 400, `${reply}: ${response.body}`);
    assert.match(response.json().error, /reply handle/);
  }
  const fine = await posted(
    h,
    body('Bind a small notebook', { reply: 'https://studio.example.org/desk' }),
  );
  assert.equal(fine.request.reply, 'https://studio.example.org/desk');
});

test('a double submit with one idempotency key answers the same request twice', async (t) => {
  const h = await harness(t);
  // Both requests miss the replay lookup before either transaction starts.
  const original = h.db.transaction;
  const waiting: Array<() => void> = [];
  h.db.transaction = <T>(action: (tx: Transaction) => Promise<T>) =>
    new Promise<void>((resolve) => {
      waiting.push(resolve);
      if (waiting.length === 2) for (const go of waiting) go();
    }).then(() => original(action));
  const payload = body('Weave a picnic basket');
  const [a, b] = await Promise.all([post(h, payload), post(h, payload)]);
  h.db.transaction = original;
  assert.deepEqual([a.statusCode, b.statusCode].sort(), [200, 201], `${a.body} ${b.body}`);
  assert.deepEqual(a.json(), b.json());
  assert.deepEqual(titles((await list(h)).page), ['Weave a picnic basket']);
});

test('honeypot and blocked copies never push another poster into review', async (t) => {
  const h = await harness(t);
  for (const n of [20, 21]) {
    const bot = await posted(
      h,
      body('Restore a rowing boat', { description: `Bot copy ${n}.`, website: 'x' }),
      ip(n),
    );
    assert.equal(bot.request.status, 'held');
  }
  // An operator blocked the sources of ip(23) and ip(24).
  for (const n of [23, 24]) {
    const earlier = await posted(h, body(`Something unrelated ${n}`), ip(n));
    await h.db.query(
      `INSERT INTO feed_source_blocks (source_hash, expires_at, created_at)
         SELECT source_hash, $2, $3 FROM feed_requests WHERE id=$1`,
      [earlier.request.id, START + 86_400_000, START],
    );
    const blocked = await posted(
      h,
      body('Restore a rowing boat', { description: `Blocked copy ${n}.` }),
      ip(n),
    );
    assert.equal(blocked.request.status, 'held');
  }
  const reasons = await h.db.query<{ held_reason: string }>(
    "SELECT held_reason FROM feed_requests WHERE state='held' ORDER BY held_reason",
  );
  assert.deepEqual(
    reasons.rows.map((row) => row.held_reason),
    ['blocked', 'blocked', 'honeypot', 'honeypot'],
  );
  const mine = await posted(h, body('Restore a rowing boat', { description: 'Mine.' }), ip(22));
  assert.equal(mine.request.status, 'open');
});

test('blank-looking letters read as spaces: no blank title', async (t) => {
  const h = await harness(t, { postsPerSourceHour: 50, postsPerSourceDay: 50 });
  for (const blank of ['ㅤ', 'ᅟ', 'ᅠ', 'ﾠ', '⠀']) {
    const response = await post(h, body(blank.repeat(8)));
    assert.equal(response.statusCode, 400, `U+${blank.codePointAt(0)!.toString(16)}`);
  }
});

test('blank-looking letters read as spaces: no blank display name, anonymous or agent', async (t) => {
  const h = await harness(t);
  const named = await posted(h, body('Glue a broken vase', { displayName: 'ㅤ⠀ﾠ' }));
  assert.equal(named.request.postedBy.displayName, null);
  h.session.value = { ownerId: 'ws-1' };
  h.agents['agent-blank'] = 'ㅤㅤㅤ';
  const agent = await posted(h, body('Oil a garden gate', { agentId: 'agent-blank' }));
  assert.deepEqual(agent.request.postedBy, { kind: 'agent', displayName: null });
  assert.equal(agent.request.status, 'open');
});

test('blank-looking letters read as spaces: no duplicate past the fold', async (t) => {
  const h = await harness(t);
  assert.equal(foldKey('Restore anㅤoldﾠphoto'), foldKey('Restore an old photo'));
  await posted(h, body('Restore an old photo', { description: 'Same.' }), ip(2));
  const copy = await post(h, body('Restore anㅤold photo', { description: 'Same.' }), ip(3));
  assert.equal(copy.statusCode, 400, copy.body);
  assert.equal(copy.json().error, 'This request is already on the Feed.');
});

test('invisible marks are dropped: variation selectors and tags hide no name, link or contact', async (t) => {
  const h = await harness(t, {
    postsPerSourceHour: 80,
    postsPerSourceDay: 80,
    postsPerSiteHour: 80,
    postsPerNetworkHour: 80,
  });
  const refused = async (payload: Record<string, unknown>, what: string) => {
    const response = await post(h, payload);
    assert.equal(response.statusCode, 400, `${what}: ${response.body}`);
  };
  // Blank titles: invisible marks only, or marks and symbols without a letter or digit.
  for (const blank of ['️', '\u{E0100}', '᠋', '̀', '￼', '\u{1D159}'])
    await refused(body(blank.repeat(10)), `title of U+${blank.codePointAt(0)!.toString(16)}`);
  await refused(body('Visit evil️.com'), 'title with a hidden address');
  await refused(body('Visit -evil.com now'), 'title with a dash before the address');
  await refused(body('Visit evil.com-now'), 'title with a dash after the address');
  for (const displayName of ['Ad️min', 'Help Desk', 'S u p p o r t'])
    await refused(body('Fix a garden bench', { displayName }), `reserved name ${displayName}`);
  for (const description of ['Mail name️@example.com', 'Call 555️123️4567', 'See bit️.ly/3abc'])
    await refused(body('Hidden contact', { description }), description);
  for (const reply of [
    'https://studio.example.org/name%E2%80%8B@example.com',
    'https://studio.example.org/name%EF%B8%8F@example.com',
    'https://studio.example.org/name️@example.com',
    'https://studio.example.org/name%E2%A0%80@example.com',
    'https://studio.example.org/name%20@example.com',
  ])
    await refused(body('Hidden reply contact', { reply }), reply);
  // A name of invisible marks or symbols alone is no name.
  const unnamed = await posted(h, body('Glue a cracked bowl', { displayName: '️'.repeat(4) }));
  assert.equal(unnamed.request.postedBy.displayName, null);
  // A messenger written with a hidden mark is still a messenger: held.
  const messenger = await posted(h, body('Messenger link', { description: 'See t️.me/abc' }));
  assert.equal(messenger.request.status, 'held');
  // The duplicate fold reads through the marks too.
  assert.equal(foldKey('Restore an o️ld photo'), foldKey('Restore an old photo'));
  // Agents: the name is withheld; contact details also hold the request.
  h.session.value = { ownerId: 'ws-1' };
  for (const [n, [name, status]] of [
    ['Central Sup️port', 'open'],
    ['Desk name️@mail️.example', 'held'],
    ['Help Desk', 'open'],
  ].entries()) {
    h.agents[`agent-mark-${n}`] = name!;
    const agent = await posted(h, body(`Agent mark request ${n}`, { agentId: `agent-mark-${n}` }));
    assert.deepEqual(agent.request.postedBy, { kind: 'agent', displayName: null }, name);
    assert.equal(agent.request.status, status, name);
  }
});

test('phone numbers: any dash, up to three separators, brackets, other digits; every number is checked', async (t) => {
  const h = await harness(t, {
    postsPerSourceHour: 80,
    postsPerSourceDay: 80,
    postsPerSiteHour: 80,
    postsPerNetworkHour: 80,
  });
  for (const description of [
    'Call +1 (555)-123-4567',
    'Call (555)-123-4567',
    'Call +1-(555)-123-4567',
    'Ruf 0170/ 123 45 67 an',
    'Ruf 0170 /1234567 an',
    'Call 555 -123 -4567',
    'Call 555- 123- 4567',
    'Call 555–123–4567',
    'Call 555‐123‐4567',
    'Call 555‑123‑4567',
    'Call 555−123−4567',
    'Call [555] 123-4567',
    'Call 555·123·4567',
    'Call ٠١٧٠١٢٣٤٥٦٧',
    'Call 01-70-1234 567',
    'Call +49 30 12.34.5678',
    'Order 123456789, then call 5551234567',
    'Mail name@example‧com',
  ]) {
    const response = await post(h, body('Phone in the text', { description }));
    assert.equal(response.statusCode, 400, `${description}: ${response.body}`);
    assert.match(response.json().error, /phone numbers/);
  }
  for (const reply of [
    'https://studio.example.org/call/+1%20(555)-123-4567',
    'https://studio.example.org/call/+1-555–123–4567',
  ]) {
    const response = await post(h, body('Phone in the reply', { reply }));
    assert.equal(response.statusCode, 400, `${reply}: ${response.body}`);
    assert.match(response.json().error, /reply handle/);
  }
  const dated = await posted(
    h,
    body('Dates stay dates', { description: 'From 10/14/2026 to 2026-10-20, or 14.10.2026' }),
  );
  assert.equal(dated.request.status, 'open');
  h.session.value = { ownerId: 'ws-1' };
  for (const [n, name] of ['Desk +1 (555)-123-4567', 'Desk 0170–123–4567'].entries()) {
    h.agents[`agent-phone-${n}`] = name;
    const agent = await posted(
      h,
      body(`Agent phone request ${n}`, { agentId: `agent-phone-${n}` }),
    );
    assert.deepEqual(agent.request.postedBy, { kind: 'agent', displayName: null }, name);
    assert.equal(agent.request.status, 'held', name);
  }
});

test('a reply link with a plain run of digits is held for review, not refused', async (t) => {
  const h = await harness(t);
  for (const reply of [
    'https://shop.example.com/listing/1234567890/handmade-basket',
    'https://wa.me/15551234567',
  ]) {
    const held = await posted(h, body(`Reply with digits ${reply.length}`, { reply }));
    assert.equal(held.request.status, 'held', reply);
  }
});

test('a dash or dot before a link without a scheme hides it from no link rule', async (t) => {
  const h = await harness(t, { postsPerSourceHour: 50, postsPerSourceDay: 50 });
  for (const description of [
    'a.example.com/1 b.example.net/2 -192.0.2.10/admin',
    'See -bit.ly/3abc',
    'See -xn--80ak6aa92e.com/login',
    'See -docs.example.org:8443/brief',
    'See .192.0.2.10/brief',
    'See one.example.com//1 and two.example.net//2 and three.example.org//3',
  ]) {
    const response = await post(h, body('Dashed links', { description }));
    assert.equal(response.statusCode, 400, `${description}: ${response.body}`);
    assert.match(response.json().error, /links|Links/);
  }
  const messenger = await posted(
    h,
    body('Dashed messenger', { description: 'See -t.me/joinchat' }),
  );
  assert.equal(messenger.request.status, 'held');
  // Product names with a slash are not links.
  const stack = await posted(
    h,
    body('Build a chat app', {
      description: 'Stack: Vue.js/Nuxt, Node.js/Express, Socket.io/Redis, ASP.NET/C#.',
    }),
  );
  assert.equal(stack.request.status, 'open');
});

test('an agent name is checked whole before it is cut to displayNameMax', async (t) => {
  const h = await harness(t);
  h.session.value = { ownerId: 'ws-1' };
  const long = 'Very long agent name about evil.example.com';
  assert.ok(Array.from(long).length > FEED_LIMITS.displayNameMax);
  h.agents['agent-long-address'] = long;
  const agent = await posted(h, body('Sand a wooden table', { agentId: 'agent-long-address' }));
  assert.deepEqual(agent.request.postedBy, { kind: 'agent', displayName: null });
  assert.equal(agent.request.status, 'open');
  // Contact details past the cut hold the request.
  const contact = 'Very long agent name, reach me at dock.office@example.com';
  assert.ok(Array.from(contact).length > FEED_LIMITS.displayNameMax);
  h.agents['agent-long-contact'] = contact;
  const held = await posted(h, body('Oil a wooden table', { agentId: 'agent-long-contact' }));
  assert.deepEqual(held.request.postedBy, { kind: 'agent', displayName: null });
  assert.equal(held.request.status, 'held');
});

test('signed-in caps: an address, site or network spends a tenth of the accounts budget, a region a quarter', async (t) => {
  const scoped = signedInScopeCap(FEED_CAPS_DEFAULT);
  assert.equal(scoped(FEED_CAPS_DEFAULT.postsPerSourceHour, 'source'), 30);
  assert.equal(scoped(FEED_CAPS_DEFAULT.postsPerSiteHour, 'site'), 60);
  assert.equal(scoped(FEED_CAPS_DEFAULT.postsPerNetworkHour, 'network'), 60);
  assert.equal(scoped(FEED_CAPS_DEFAULT.postsPerRegionHour, 'region'), 150);
  // Accounts budget 40 an hour: 4 per network, 10 per region.
  const h = await harness(t, { postsOwnersGlobalHour: 40 });
  let n = 0;
  for (const region of [11, 12]) {
    const owner = `ws-${region - 10}`;
    h.session.value = { ownerId: owner };
    for (const [network, count] of [
      [1, 4],
      [2, 4],
      [3, 2],
    ] as const)
      for (let i = 0; i < count; i += 1)
        await posted(h, body(`Region request number ${(n += 1)}`), `${region}.${network}.${i}.9`);
    // The network is spent at 4, the region at 10.
    assert.equal(
      (await post(h, body(`Network full ${region}`), `${region}.1.9.9`)).statusCode,
      429,
    );
    assert.equal((await post(h, body(`Region full ${region}`), `${region}.4.0.9`)).statusCode, 429);
  }
  // Two regions spent half the accounts budget: a third region still posts.
  h.session.value = { ownerId: 'ws-3' };
  await posted(h, body('From a third region'), '13.1.0.9');
});

test('budgets, price lists, ranges, versions and time tables are not phone numbers', async (t) => {
  const h = await harness(t, {
    postsPerSourceHour: 80,
    postsPerSourceDay: 80,
    postsPerSiteHour: 80,
    postsPerNetworkHour: 80,
  });
  for (const [n, description] of [
    'Budget 10.000 – 20.000 EUR',
    'Budget 15000 - 30000 USD',
    'Prices 25.50 / 30.00 / 45.00',
    'Postcodes 10115 - 10999',
    'Postcodes 01067 - 01099',
    'Node 18.20 / 20.11 / 22.1',
    'Open 09.00–12.30 / 13.30–17.00',
    'Budget 1.500.000 - 2.000.000 EUR',
    'Sizes 120 / 140 / 160 / 180 cm',
  ].entries()) {
    const response = await post(h, body(`Numbers in the text ${n}`, { description }));
    assert.equal(response.statusCode, 201, `${description}: ${response.body}`);
    const { request } = response.json() as PostedFeedRequest;
    assert.equal(request.status, 'open', description);
    assert.equal(request.description, description);
  }
  // Phone numbers still are, in any of these shapes.
  for (const description of [
    'Call (555) 123-4567',
    'Call +1 (555) 123-4567',
    'Ruf 0170 / 123 45 67 an',
    'Budget 15000, or ring 555 123 4567',
    'Prices 25 / 555-123-4567',
    'Bureau 06 12 34 56 78',
    'Office 044 555 01 23',
    'Tel. 12 34 56 78 90',
    'tel:12.34.56.78.90',
  ]) {
    const response = await post(h, body('Phone in the text', { description }));
    assert.equal(response.statusCode, 400, `${description}: ${response.body}`);
    assert.match(response.json().error, /phone numbers/);
  }
});

test('an IPv4 range is text, a link to a local address is held, a public IP link refused', async (t) => {
  const h = await harness(t, { postsPerSourceHour: 50, postsPerSourceDay: 50 });
  const range = await posted(
    h,
    body('Allow an office network', { description: 'Block 192.168.0.0/16 and 10.0.0.0/8.' }),
  );
  assert.equal(range.request.status, 'open');
  assert.equal(range.request.description, 'Block 192.168.0.0/16 and 10.0.0.0/8.');
  for (const [n, description] of [
    'Health check on 127.0.0.1:8080/health',
    'Router at 192.168.1.1/admin',
  ].entries()) {
    const local = await posted(h, body(`Local address ${n}`, { description }));
    assert.equal(local.request.status, 'held', description);
  }
  const response = await post(h, body('Public address', { description: 'See 192.0.2.10/16x' }));
  assert.equal(response.statusCode, 400, response.body);
});

test('a reply link: %25 is checked, digit groups are held, + or a phone word is refused', async (t) => {
  const h = await harness(t, { postsPerSourceHour: 50, postsPerSourceDay: 50 });
  const sale = await posted(
    h,
    body('Reply with a percent sign', { reply: 'https://shop.example.com/sale/50%25-off' }),
  );
  assert.equal(sale.request.status, 'open');
  assert.equal(sale.request.reply, 'https://shop.example.com/sale/50%25-off');
  for (const [n, reply] of [
    'https://shop.example.com/listing/123-456-7890',
    'https://shop.example.com/ad/2026-10-004711',
    'https://shop.example.com/item/0170-1234567',
  ].entries()) {
    const held = await posted(h, body(`Reply with an id ${n}`, { reply }));
    assert.equal(held.request.status, 'held', reply);
  }
  for (const reply of [
    'https://shop.example.com/sale/50%25-off/%2B41445550123',
    'https://shop.example.com/tel:555-123-4567',
    'https://shop.example.com/call/5551234567',
  ]) {
    const response = await post(h, body('Reply with a phone number', { reply }));
    assert.equal(response.statusCode, 400, `${reply}: ${response.body}`);
    assert.match(response.json().error, /reply handle/);
  }
});

test('short anonymous names are not read as reserved words across word gaps', async (t) => {
  const h = await harness(t, { postsPerSourceHour: 50, postsPerSourceDay: 50 });
  for (const [n, displayName] of ['Mo D', 'Ad Min', 'Sup Port', 'Te Am'].entries()) {
    const named = await posted(h, body(`Short name request ${n}`, { displayName }));
    assert.equal(named.request.postedBy.displayName, displayName);
  }
  for (const displayName of ['Help Desk', 'S u p p o r t', 'a d m i n desk', 'Support'])
    assert.equal(
      (await post(h, body('Reserved name', { displayName }))).statusCode,
      400,
      displayName,
    );
});

/** Caps high enough for one address to post every case of a test. */
const MANY_POSTS: Partial<FeedCaps> = {
  postsPerSourceHour: 200,
  postsPerSourceDay: 200,
  postsPerSiteHour: 200,
  postsPerNetworkHour: 200,
  openPerSource: 200,
};

let caseNumber = 0;

/**
 * Posts each text as the description (or the reply handle) and checks what happens to it:
 * refused with the contact message, held (stored, never listed) or open (listed as written).
 */
async function expectPosts(
  h: Harness,
  outcome: 'refused' | 'held' | 'open',
  field: 'description' | 'reply',
  values: readonly string[],
) {
  for (const value of values) {
    caseNumber += 1;
    const response = await post(h, body(`Contact check number ${caseNumber}`, { [field]: value }));
    if (outcome === 'refused') {
      assert.equal(response.statusCode, 400, `${value}: ${response.body}`);
      assert.match(response.json().error, /email addresses and phone numbers/, value);
      continue;
    }
    assert.equal(response.statusCode, 201, `${value}: ${response.body}`);
    const { request } = response.json() as PostedFeedRequest;
    assert.equal(request.status, outcome, value);
    const { raw } = await list(h);
    assert.equal(raw.includes(`Contact check number ${caseNumber}"`), outcome === 'open', value);
  }
}

test('a reply link: every percent-decoded layer is checked, each escape on its own', async (t) => {
  const h = await harness(t, MANY_POSTS);
  await expectPosts(h, 'refused', 'reply', [
    'https://shop.example.com/sale/50%25-off/name%2540example.com',
    'https://shop.example.com/sale/50%25-off/%252B41445550123',
    'https://shop.example.com/sale/50%25-off/tel%253A5551234567',
    'https://shop.example.com/x/%25252540a/name%2525252540example.com',
    'https://shop.example.com/call/%E2%9E%9541445550123',
  ]);
  await expectPosts(h, 'held', 'reply', [
    'https://shop.example.com/sale/50%25-off/555%2520123%25204567',
  ]);
  await expectPosts(h, 'open', 'reply', ['https://shop.example.com/sale/50%25-off']);
});

test('phone numbers after the international 00 prefix are refused', async (t) => {
  const h = await harness(t, MANY_POSTS);
  await expectPosts(h, 'refused', 'description', [
    'Reach 0049 170 1234567',
    'Reach 0041 44 555 01 23',
    'Reach 0044 7700 900123',
    'Reach 00 41 44 555 01 23',
  ]);
});

test('other phone layouts and any other run of 9 or more digits are held, never listed', async (t) => {
  const h = await harness(t, MANY_POSTS);
  await expectPosts(h, 'held', 'description', [
    'Reach 555 1234567',
    'Reach 555 123 45 67',
    'Reach 55 51 23 45 67',
    'Reach 555-12-34-567',
    'Reach 41 44 555 01 23',
    'Reach 5 5 5 1 2 3 4 5 6 7',
    'Reach 347 1234567',
    'Reach 98765 43210',
    'Reach 138 0013 8000',
    'Reach 555.1234567',
    'Order 123456789',
    'Invoice 2026 / 10 / 004711',
  ]);
});

test('digits of every script and heavy plus signs read as ASCII', async (t) => {
  const h = await harness(t, MANY_POSTS);
  await expectPosts(h, 'refused', 'description', [
    'Reach ٠١٧٠ / ١٢٣ ٤٥ ٦٧',
    'Reach ➕41 44 555 01 23',
    'Reach ✚41 44 555 01 23',
    'Reach ➎➎➎-➊➋➌-➍➎➏➐',
    'Reach ❺❺❺ ❶❷❸ ❹❺❻❼',
    'Reach 5⃣5⃣5⃣ 1⃣2⃣3⃣ 4⃣5⃣6⃣7⃣',
  ]);
});

test('a phone word one or two short words before the number still refuses it', async (t) => {
  const h = await harness(t, MANY_POSTS);
  await expectPosts(h, 'refused', 'description', [
    'Whatsapp me 555 1234567',
    'WhatsApp me on 555 1234567',
    'Or call me at 555 1234567',
  ]);
});

test('a name with 9 or more digits: an agent name is withheld and the request held, an anonymous one refused', async (t) => {
  const h = await harness(t, MANY_POSTS);
  for (const displayName of ['Desk 555 1234567', 'Desk 0049 170 1234567']) {
    const response = await post(h, body('Anonymous digits in the name', { displayName }));
    assert.equal(response.statusCode, 400, `${displayName}: ${response.body}`);
  }
  h.session.value = { ownerId: 'ws-1' };
  for (const [n, name] of ['Desk 555 1234567', 'Desk 0049 170 1234567'].entries()) {
    h.agents[`agent-digits-${n}`] = name;
    const agent = await posted(
      h,
      body(`Agent digits request ${n}`, { agentId: `agent-digits-${n}` }),
    );
    assert.deepEqual(agent.request.postedBy, { kind: 'agent', displayName: null }, name);
    assert.equal(agent.request.status, 'held', name);
  }
  assert.doesNotMatch((await list(h)).raw, /1234567/);
});

test('versions, price tiers and month ranges are open, not phone numbers', async (t) => {
  const h = await harness(t, MANY_POSTS);
  await expectPosts(h, 'open', 'description', [
    'Firmware 1.0.2.13/1.0.2.14 upgrade',
    'Upgrade from 2.0.1.5/2.0.1.6 to 2.1',
    'Packages 250 / 500 / 1000 EUR',
    'Order 100 - 250 - 1000 pieces',
    'Prices 25 / 50 / 100 / 250 / 1000 USD',
    'From 05/2026 - 08/2026',
    'From 03.2026 - 06.2026',
  ]);
});

test('a range after a phone word and sizes in even steps are open', async (t) => {
  const h = await harness(t, MANY_POSTS);
  await expectPosts(h, 'open', 'description', [
    'Bulk SMS 10.000 - 20.000 per month',
    'Handy 100.000 - 200.000 Stück',
    'Sizes 06 / 08 / 10 / 12 / 14 / 16',
  ]);
});

test('round digits that could be dialled: refused after a phone word or an area code in brackets, held alone', async (t) => {
  const h = await harness(t, MANY_POSTS);
  await expectPosts(h, 'refused', 'description', [
    'Call (250) 300-1000',
    '(250) 300-1000',
    'Reach {250} 300-1000',
    'Reach 「250」300-1000',
    'Reach ( 250 ) 300 - 1000',
    'Tel. 800 900 1000',
    'Call 650 700 1000',
    'Phone number: 250-300-1000',
    'Tel. 600 300 000',
    'WhatsApp 34 600 300 000',
    'Call (at) +20 100 500 1000',
    'Office (dot) +41 44 123 45 67',
    'Lines 5551234567 - 5551234599',
    'Call (250) 300-1000 USD',
    '(250) 300-1000 calls',
    'Call 250 / 300 / 1000',
    'Telefonnummer: 250 / 300 / 1000',
  ]);
  await expectPosts(h, 'held', 'description', [
    '250-300-1000',
    '800-900-1000',
    'Italy 350 500 1000',
    'Reach 250_300_1000',
    'Call me 1000 2000 3000',
    'Phone 06 08 10 12 14 16',
    'My number is 250 300 1000',
  ]);
});

test('slashes and spaced dashes in a dialled number, trunk numbers with a slash, reply paths; increments and bracketed signs', async (t) => {
  const h = await harness(t, MANY_POSTS);
  await expectPosts(h, 'held', 'description', [
    'Reach 250 / 300 / 1000',
    'Reach 250 - 300 - 1000',
    'Reach 650/700/7000',
    'call our office 250 / 300 / 1000',
    '030/40 50 60 70',
    'Erreichbar unter 030/40 50 60 70',
    'Zentrale 040 / 41 42 43 44',
    'Appelez le 01/02/03/04/05',
    'WhatsApp: $800 900 1000',
    'Use (@) and (.) in the regex',
    'Questions? 98450-98765',
    'Tracking 1Z999AA10123456784',
    'Nurse shifts 0700-1900, 1900-0700',
  ]);
  // A tight 5-5 pair starting 6 to 9 is an Indian mobile, never a range: after a phone phrase it
  // is refused.
  await expectPosts(h, 'refused', 'description', [
    'Reach me on 98450-98765',
    'My number is 98450-98765',
  ]);
  await expectPosts(h, 'held', 'reply', [
    'https://example.com/zap/80000-90000',
    'https://example.com/in/98450-98765',
  ]);
  await expectPosts(h, 'open', 'description', [
    'Budget 250 / 500 / 1000',
    'Packages: +1000, +2500, +5000 followers',
    'Grow +1000 +5000 +10000 followers',
    'Packages +500, +1000, +2000 followers',
    'Max API call rate 100 200 500 per min',
    'Sizes 06 / 08 / 10 / 12 / 14 / 16',
  ]);
});

test('trunk-prefix numbers, more phone words and channel words: refused right after a dial word, held otherwise', async (t) => {
  const h = await harness(t, MANY_POSTS);
  await expectPosts(h, 'refused', 'description', [
    'Mon portable : 06 08 10 12 14',
    'Tél. 06-08-10-12-14',
    'Tel. 030 40 50 60 70',
    'Handynummer 0800 900 1000',
  ]);
  await expectPosts(h, 'held', 'description', [
    'Erreichbar unter 030 40 50 60 70',
    'Freephone 0800 900 1000',
    '0800 900 1000 calls free',
    '手机 130 1000 2000',
    'Contact 80000 90000',
    'SMS to 250 500 1000 customers',
    'Export icon@2x.png and icon@3x.png',
  ]);
  await expectPosts(h, 'open', 'description', [
    'SEO text for 250 500 1000 products',
    'Telemedicine for 250 500 1000 patients',
    'Handyman for 250 500 1000 sqft',
    'Budget Fr. 250 500 1000',
    'Budget 250 500 1000 INR',
    'Pris 250 500 1000 kr',
    'Tiers (USD): 250 500 1000',
    'Our sites: firma.at / firma.de / firma.ch',
    'Mobile game with 100,000,000 players',
    'Postcodes 01067 - 01099',
  ]);
});

test('a sign after a bracketed area code, a number inside a longer list, an ending after the address; tags only get the contact check', async (t) => {
  const h = await harness(t, MANY_POSTS);
  await expectPosts(h, 'refused', 'description', [
    'Reach (250)-300-1000',
    'Reach (250).300.1000',
    'Write to name@example.com.Thanks',
  ]);
  await expectPosts(h, 'held', 'description', [
    'Reach 250-300-1000, 1500',
    'Write to name . at . example . dot . com',
  ]);
  await expectPosts(h, 'open', 'description', [
    'Docs at: docs.example.com',
    'Repo at: github.com/acme/tool',
  ]);
  for (const capabilities of [
    ['social-media-video', 'real-estate-photo', 'voice-over', 'music-video', 'brand-design'],
    ['sk-learn-model-training'],
  ]) {
    const open = await posted(h, body(`Ordinary tags ${capabilities.length}`, { capabilities }));
    assert.equal(open.request.status, 'open', capabilities.join(','));
  }
});

test('a display name never carries 9 or more digits: refused when anonymous, withheld and held for an agent', async (t) => {
  const h = await harness(t, MANY_POSTS);
  for (const displayName of ['Jane 800-900-1000 calls', 'Contact 80000 90000']) {
    const response = await post(h, body('Anonymous name with a number', { displayName }));
    assert.equal(response.statusCode, 400, `${displayName}: ${response.body}`);
  }
  h.session.value = { ownerId: 'ws-1' };
  h.agents['agent-round-number'] = 'Plumber 800-900-1000 x';
  const agent = await posted(
    h,
    body('Agent with a number in its name', { agentId: 'agent-round-number' }),
  );
  assert.deepEqual(agent.request.postedBy, { kind: 'agent', displayName: null });
  assert.equal(agent.request.status, 'held');
});

test('words that count nothing never open a number; lists, padded ids and everyday at/point words stay open', async (t) => {
  const h = await harness(t, MANY_POSTS);
  await expectPosts(h, 'held', 'description', [
    'Reach me at 720-800-8000 each weekday',
    'Text 720-800-8000 each morning',
    '310 400 2000 per text',
    '310-400-2000 hours 9-5',
    'Budget 200 USD. 310 400 2000',
    'Text me 310 400 2000 USD',
    '微信同号 130-1000-2000',
    'Chunk sizes 256, 512, 1024 tokens',
  ]);
  await expectPosts(h, 'refused', 'description', ['Tel. 030 / 40 50 60 70 per WhatsApp']);
  await expectPosts(h, 'open', 'description', [
    'Episodes 001, 002, 003 need subtitles',
    'Lots 001, 002, 003 for the auction',
    'Refurbished phones 128 256 512 GB',
    'We need it at any point in time',
    'Hilfe bei Amazon.de Bestellungen',
    'WhatsApp 2.000.000.000 Nutzer',
    'Allow “@” and “.” in user names',
  ]);
});

test('a unit word never opens a whole North American number after a phone word or before a call word', async (t) => {
  const h = await harness(t, MANY_POSTS);
  // 'x' is an extension, not a unit: right after a dial word the number is refused.
  await expectPosts(h, 'refused', 'description', ['Tel 800 900 1000 x']);
  await expectPosts(h, 'held', 'description', [
    'Call 250 300 1000 USD',
    'Whatsapp 250-300-1000 each',
    'Call me 250 300 1000 k',
    'Text 650 700 1000 msgs',
    'Ring 800 900 1000 g',
    '800-900-1000 calls welcome',
    'USD 250 300 1000 call me',
    'Signal 300 600 1200 ms',
    'Phone case 200 500 1000 pcs',
  ]);
  await expectPosts(h, 'open', 'description', [
    'Tiers 200-500-1000 EUR',
    'Packages 250 500 1000 credits',
  ]);
});

test('tiers, quantities and sizes with a unit or a currency stay open, also after a phone word', async (t) => {
  const h = await harness(t, MANY_POSTS);
  await expectPosts(h, 'open', 'description', [
    'Budget tiers 250 500 1000 USD',
    'Packages: 250-500-1000 words',
    'Quantities 200 500 1000 pieces',
    'Internet 300-500-1000 Mbps',
    'CHF 250 500 1000 depending on scope',
    'Coffee bags 250 500 1000 g',
    'Packs 250-500-1000g',
    'Render at 480 720 1080 pixels',
    'Tiers 200 300 400 500 1000',
    'Prices 250 500 1000 1500 2000',
    'Bottles 250 500 1000 ml',
    'Mobile app with 1000, 5000, 10000 users',
    'Mobile ads at 10% 20% 30% 40% 50%',
  ]);
});

test('lists after a phone word, years, steps and bracketed lists stay open', async (t) => {
  const h = await harness(t, MANY_POSTS);
  await expectPosts(h, 'open', 'description', [
    'SMS 1000 / 5000 / 10000 tiers',
    'Bulk SMS 10000 - 20000 per month',
    'Handy 100000 - 200000 Stück',
    'Mobile app for 1000 5000 10000 users',
    'WhatsApp bot for 1000 / 5000 / 10000 users',
    'Mobile 2024 2025 2026 roadmap',
    'Quantities (min. 50) 100 / 250 / 500 units',
    'Options: 100) 200) 300)',
    'Tiers (250) (500) (1000)',
    'Order 200 - 500 - 1000 pieces',
    'Order 100-250-1000 pieces',
    'Packages 250 / 500 / 1000 EUR',
    'Bulk SMS 10.000 - 20.000 per month',
    'Call logs 2024 2025 2026 to analyse',
    'Ring size 6 7 8 9 10 11 12',
  ]);
});

test('an email address in other brackets or joined by other signs: bracketed refused, words held, file names open', async (t) => {
  const h = await harness(t, MANY_POSTS);
  await expectPosts(h, 'refused', 'description', [
    'Write to name-(at)-example-(dot)-com',
    'Write to name_(at)_example_(dot)_com',
    'Mail name「at」example「dot」com',
    'Mail name ⟨at⟩ example ⟨dot⟩ com',
    'Mail name ~~~~~(at)~~~~~ example (dot) com',
  ]);
  await expectPosts(h, 'held', 'description', [
    // A bracketed sign may be prose about the sign: held, not refused.
    'Write to name (@) example (.) com',
    'Write to name-at-example-dot-com',
    'Write to name / at / example / dot / com',
    'Write to name_at_example_dot_com',
    'Mail name+at+example+dot+com',
    'Mail name.at.example.dot.com',
    'Meeting (at) Hilton (.) Rooftop bar',
  ]);
  await expectPosts(h, 'open', 'description', [
    'Summarize https://blog.example.com/posts/look-at-this.html for me',
    'Export the columns to created_at_utc.csv',
    'Keep the data-at-rest encrypted',
  ]);
  await expectPosts(h, 'refused', 'reply', [
    'https://shop.example.com/contact/name-[at]-example-[dot]-com',
  ]);
  await expectPosts(h, 'held', 'reply', [
    'https://shop.example.com/contact/name-AT-example-DOT-com',
    'https://shop.example.com/contact/name-at-example.com',
    'https://shop.example.com/contact/name@example-dot-com',
    'https://example.com/name%20at%20example%20dot%20com',
  ]);
  await expectPosts(h, 'open', 'reply', [
    'https://blog.example.com/2026/hello-at-last.html',
    'https://example.com/de-at/kontakt.html',
  ]);
});

test('tags are public too: a phone number in the tags is refused, an email address held', async (t) => {
  const h = await harness(t, MANY_POSTS);
  for (const capabilities of [['5551234567'], ['555-123-4567'], ['tel', '800-900-1000', 'x']]) {
    const response = await post(h, body('Tags with a number', { capabilities }));
    assert.equal(response.statusCode, 400, `${capabilities}: ${response.body}`);
    assert.match(response.json().error, /email addresses and phone numbers/);
  }
  const held = await posted(
    h,
    body('Tags with an address', { capabilities: ['name-at-example-dot-com'] }),
  );
  assert.equal(held.request.status, 'held');
  const open = await posted(
    h,
    body('Tags without contact', { capabilities: ['pdf', 'summaries'] }),
  );
  assert.equal(open.request.status, 'open');
});

test('single letters spelling one word of a reserved pair are reserved too', async (t) => {
  const h = await harness(t, MANY_POSTS);
  for (const displayName of ['H e l p Desk', 'Help D e s k', 'H e l p D e s k']) {
    const response = await post(h, body('Reserved pair name', { displayName }));
    assert.equal(response.statusCode, 400, `${displayName}: ${response.body}`);
    assert.match(response.json().error, /reserved/);
  }
});

test('an email address written with "at" and "dot" or spaces is held; in brackets or encoded it is refused', async (t) => {
  const h = await harness(t, MANY_POSTS);
  await expectPosts(h, 'held', 'description', [
    'Write to name at example dot com',
    'Write to name AT example DOT com',
    'Write to name @ example . com',
    'Write to name@example . com',
    'Write to n a m e @ example.com',
  ]);
  await expectPosts(h, 'refused', 'description', [
    'Write to name (at) example (dot) com',
    'Write to name [at] example [dot] com',
    'Write to name{at}example{dot}com',
    'Write to name<at>example<dot>com',
    'Write to name (ät) example (punkt) de',
    'Write to name&#64;example.com',
    'Write to name%40example.com',
    'Write to name@example•com',
  ]);
});

test('attacker pass: phone numbers behind other separators, line breaks, letters and escapes', async (t) => {
  const h = await harness(t, MANY_POSTS);
  await expectPosts(h, 'refused', 'description', [
    'Reach 555_123_4567',
    'Reach 555,123,4567',
    'Reach 555 | 123 | 4567',
    'Reach 555*123*4567',
    'Reach 555~123~4567',
    'Reach 555:123:4567',
    'Reach 555\n123\n4567',
    'Reach 555 ･ 123 ･ 4567',
    'Reach 555🔸123🔸4567',
    'Reach 555 -- 123 -- 4567',
    'Reach 555 - - 123 - - 4567',
    'Reach O17O 1234567',
    'Ruf O17O / l23 45 67 an',
    'Tel5551234567',
    'Reach 555%20123%204567',
  ]);
  await expectPosts(h, 'held', 'description', [
    'Reach ⑸⑸⑸⑴⑵⑶⑷⑸⑹⑺',
    'Pay DE89370400440532013000',
    'Server 212.55.51.234',
  ]);
  // Text that only looks like it stays open.
  await expectPosts(h, 'open', 'description', [
    'Allow 52.14.200.0/24 and 192.168.100.200',
    'Rooms 101, 102, 103, 104',
    'Prices 250 € / 500 € / 1000 €',
    'Budget 10 000 – 20 000 EUR',
    'On 14.10.2026 09.00-17.00',
    'Open 09:00-12:30 / 13:30-17:00',
    'Send to 0x52908400098527886E0F7030069857D2E4169EE7 please',
    'Follow @harbor on X. Thanks',
  ]);
});

test('search words: a lone Latin letter or digit is dropped, a single Han, kana or Hangul character is kept', () => {
  assert.equal(tsQuery('a 7'), null);
  assert.equal(tsQuery('猫'), "'猫':*");
  assert.equal(tsQuery('ね 고'), "'ね':* & '고':*");
  assert.equal(tsQuery('a Lighthouse 猫'), "'lighthouse':* & '猫':*");
});
