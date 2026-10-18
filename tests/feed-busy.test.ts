import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import Fastify, { type InjectOptions, type LightMyRequestResponse } from 'fastify';
import { createApp } from '../server/app.js';
import { DATABASE_BUSY_MESSAGE, DATABASE_BUSY_RETRY_AFTER_S } from '../server/busy.js';
import { transientDatabaseError, type Database } from '../server/database.js';
import {
  FEED_BUSY_LOG_EVERY_MS,
  FEED_BUSY_RETRY_AFTER_S,
  FEED_SEARCH_BUSY_RETRY_AFTER_S,
  FeedBusyError,
  forgetFeedBusyLog,
  isFeedPath,
} from '../server/feed/busy.js';
import { feedServicesStatus } from '../server/feed/query.js';
import { createFeedRequests } from '../server/feed/requests.js';
import type { FeedRespond } from '../server/feed/respond.js';
import { registerFeedRespondRoutes } from '../server/feed/respond-routes.js';
import { registerFeedRoutes, type FeedRouteDeps } from '../server/feed/routes.js';
import { registerFeedServiceRoutes } from '../server/feed/services-routes.js';
import {
  FEED_BUSY_MESSAGE,
  FEED_ERRORS,
  FEED_PATHS,
  FEED_RESPOND_PATHS,
  type FeedError,
  type FeedRequestPage,
} from '../shared/feed.js';
import type { Operator } from '../shared/types.js';

/*
 * The Feed under database load: a transient database failure (no free pool connection in time, a
 * statement timeout, too many connections, a serialization conflict or deadlock, a lost
 * connection: transientDatabaseError in server/database.ts) answers 503 busy with Retry-After on
 * every Feed route, never cached, instead of the app's plain 500. Any other failure keeps the 500.
 * The routes run on a fake database that fails every call, then inside the whole app on PGlite
 * with its Feed statements failing. Synthetic data only.
 */

type Ctx = { after: (fn: () => Promise<unknown> | unknown) => void };

const NOW = Date.UTC(2026, 9, 13, 12);
const HASHING = 'feed-busy-test-hashing-secret-0123456789abcdef';
const REQUEST_ID = 'req_aaaaaaaaaaaaaaaaaaaa';
const SERVICE_ID = 'svc_aaaaaaaaaaaaaaaaaaaa';

const pgError = (code: string, message: string) => Object.assign(new Error(message), { code });

/** What the pool and PostgreSQL answer under load: each one transient. */
const TRANSIENT: ReadonlyArray<readonly [string, () => Error]> = [
  ['no free pool connection in time', () => new Error('timeout exceeded when trying to connect')],
  ['too many connections', () => pgError('53300', 'sorry, too many clients already')],
  ['statement timeout', () => pgError('57014', 'canceling statement due to statement timeout')],
  ['connection failure', () => pgError('08006', 'connection failure during query')],
  ['serialization failure', () => pgError('40001', 'could not serialize access')],
  ['deadlock', () => pgError('40P01', 'deadlock detected')],
  ['connection reset', () => pgError('ECONNRESET', 'read ECONNRESET')],
  ['connection lost', () => new Error('Connection terminated unexpectedly')],
];

/** Real errors: still the app's 500. */
const NOT_TRANSIENT: ReadonlyArray<readonly [string, () => Error]> = [
  ['a missing table', () => pgError('42P01', 'relation "feed_requests" does not exist')],
  ['a programming error', () => new TypeError('rows is undefined')],
];

/** A database whose every call fails the way `failure` says. */
function failingDb(failure: () => Error): Database {
  const fail = async (): Promise<never> => {
    throw failure();
  };
  return { query: fail, exec: fail, transaction: fail, close: async () => {} };
}

/** One call per route of the requests slice and the status route. */
const requestCalls = (): Array<readonly [string, InjectOptions]> => [
  ['status', { url: FEED_PATHS.status }],
  ['requests list', { url: FEED_PATHS.requests }],
  ['requests search', { url: `${FEED_PATHS.requests}?q=receipts&tag=pdf` }],
  ['request detail', { url: FEED_PATHS.request.replace(':id', REQUEST_ID) }],
  [
    'request post',
    {
      method: 'POST',
      url: FEED_PATHS.requests,
      payload: {
        title: 'Sort a box of receipts',
        description: 'Synthetic.',
        idempotencyKey: randomUUID(),
      },
    },
  ],
  [
    'report',
    {
      method: 'POST',
      url: FEED_PATHS.report.replace(':id', REQUEST_ID),
      payload: { reason: 'spam' },
    },
  ],
  ['close', { method: 'POST', url: FEED_PATHS.close.replace(':id', REQUEST_ID), payload: {} }],
];

/** The services list (unfiltered and searched) and a service's detail. */
const serviceCalls = (): Array<readonly [string, InjectOptions]> => [
  ['services list', { url: FEED_PATHS.services }],
  ['services search', { url: `${FEED_PATHS.services}?q=pdf&sort=cheapest` }],
  ['service detail', { url: FEED_PATHS.service.replace(':id', SERVICE_ID) }],
];

function assertBusy(
  response: LightMyRequestResponse,
  what: string,
  retryAfterS = FEED_BUSY_RETRY_AFTER_S,
) {
  assert.equal(response.statusCode, 503, `${what}: ${response.body}`);
  assert.deepEqual(
    response.json(),
    { error: FEED_BUSY_MESSAGE, code: 'busy', retryable: true } satisfies FeedError,
    what,
  );
  assert.equal(response.headers['retry-after'], String(retryAfterS), what);
  // Never kept by the browser or the edge: a stored 503 would outlive the load.
  assert.equal(response.headers['cache-control'], 'no-store', what);
  assert.equal(response.headers['vercel-cdn-cache-control'], undefined, what);
}

/**
 * A text search past its own 1.5 s limit (57014) may be slow every time: busy, never a 400 (under
 * load ordinary words hit the limit too), but with a longer Retry-After so callers do not repeat
 * it every few seconds.
 */
const searchTimedOut = (kind: string, what: string) =>
  kind === 'statement timeout' && what === 'requests search';

function assertSearchTooSlow(response: LightMyRequestResponse, what: string) {
  assertBusy(response, what, FEED_SEARCH_BUSY_RETRY_AFTER_S);
}

function requestRoutes(t: Ctx, db: Database, extra: Partial<FeedRouteDeps> = {}) {
  const app = Fastify();
  t.after(() => app.close());
  registerFeedRoutes(app, {
    requests: createFeedRequests({
      db,
      clock: () => NOW,
      secret: () => HASHING,
      limit: async () => {},
    }),
    enabled: () => true,
    services: () => feedServicesStatus(db, NOW),
    ...extra,
  });
  return app;
}

function serviceRoutes(t: Ctx, db: Database) {
  const app = Fastify();
  t.after(() => app.close());
  registerFeedServiceRoutes(app, { db, env: { CITY_FEED: '1' }, now: () => NOW });
  return app;
}

test('busy is its own contract code: 503, retryable, not source_unavailable', () => {
  assert.equal(FEED_ERRORS.busy, 503);
  assert.equal(FEED_BUSY_RETRY_AFTER_S, 5);
  assert.doesNotMatch(FEED_BUSY_MESSAGE, /[{}_]|\b\d{3}\b/);
  for (const [what, failure] of TRANSIENT)
    assert.equal(transientDatabaseError(failure()), true, what);
  for (const [what, failure] of NOT_TRANSIENT)
    assert.equal(transientDatabaseError(failure()), false, what);
});

test('a transient database failure answers 503 busy on the status route and every requests route', async (t) => {
  for (const [kind, failure] of TRANSIENT) {
    const app = requestRoutes(t, failingDb(failure));
    for (const [what, call] of requestCalls()) {
      const response = await app.inject({ ...call, remoteAddress: '198.51.100.7' });
      if (searchTimedOut(kind, what)) assertSearchTooSlow(response, `${kind}, ${what}`);
      else assertBusy(response, `${kind}, ${what}`);
    }
  }
});

test('a transient failure in the session or agent lookup of a post answers busy too', async (t) => {
  const lookups: Array<Partial<FeedRouteDeps>> = [
    {
      signedIn: async () => {
        throw pgError('57014', 'canceling statement due to statement timeout');
      },
    },
    {
      signedIn: async () => ({ ownerId: 'ws-1' }),
      agentOf: async () => {
        throw new Error('timeout exceeded when trying to connect');
      },
    },
  ];
  for (const extra of lookups) {
    const app = requestRoutes(
      t,
      failingDb(() => new TypeError('not reached')),
      extra,
    );
    const response = await app.inject({
      method: 'POST',
      url: FEED_PATHS.requests,
      headers: { 'x-city-request': '1' },
      payload: {
        title: 'Sort a box of receipts',
        description: 'Synthetic.',
        agentId: 'agent-1',
        idempotencyKey: randomUUID(),
      },
    });
    assertBusy(response, Object.keys(extra).join(' and '));
  }
});

test('a transient database failure answers 503 busy on the services list and detail', async (t) => {
  for (const [kind, failure] of TRANSIENT) {
    const app = serviceRoutes(t, failingDb(failure));
    for (const [what, call] of serviceCalls())
      assertBusy(await app.inject(call), `${kind}, ${what}`);
  }
});

test('in the app: busy under load, the plain 500 for real errors, and answers again once the database does', async (t) => {
  const before = process.env.CITY_FEED;
  t.after(() => {
    if (before === undefined) delete process.env.CITY_FEED;
    else process.env.CITY_FEED = before;
  });
  process.env.CITY_FEED = '1';
  const app = await createApp({ dataDir: ':memory:', startWorkers: false });
  t.after(() => app.close());
  // The app's own database, failing every Feed statement (and every transaction) while `failure`
  // is set: the routes as the app wires them, with the app's error handler behind them.
  const db = app.city.db;
  const query = db.query.bind(db);
  const transaction = db.transaction.bind(db);
  let failure: (() => Error) | null = null;
  Object.assign(db, {
    query: (sql: string, params?: unknown[]) =>
      failure && /\bfeed_/.test(sql) ? Promise.reject(failure()) : query(sql, params),
    transaction: (action: Parameters<Database['transaction']>[0]) =>
      failure ? Promise.reject(failure()) : transaction(action),
  });
  const calls = () => [...requestCalls(), ...serviceCalls()];

  for (const [kind, transient] of TRANSIENT.slice(0, 3)) {
    failure = transient;
    for (const [what, call] of calls()) {
      const response = await app.inject(call);
      if (searchTimedOut(kind, what)) assertSearchTooSlow(response, `${kind}, ${what}`);
      else assertBusy(response, `${kind}, ${what}`);
    }
  }
  for (const [kind, real] of NOT_TRANSIENT) {
    failure = real;
    for (const [what, call] of calls()) {
      const response = await app.inject(call);
      assert.equal(response.statusCode, 500, `${kind}, ${what}: ${response.body}`);
      assert.deepEqual(
        response.json(),
        { error: 'The operation could not be completed.' },
        `${kind}, ${what}`,
      );
      assert.equal(response.headers['retry-after'], undefined, `${kind}, ${what}`);
    }
  }

  // Nothing was kept from the failures: the same routes answer as usual.
  failure = null;
  const status = await app.inject({ url: FEED_PATHS.status });
  assert.equal(status.statusCode, 200, status.body);
  assert.equal(status.json().openRequests, 0);
  const list = await app.inject({ url: FEED_PATHS.requests });
  assert.equal(list.statusCode, 200, list.body);
  assert.deepEqual(list.json(), { requests: [], next: null } satisfies FeedRequestPage);
  // No sweep yet: that is source_unavailable, never busy.
  const services = await app.inject({ url: FEED_PATHS.services });
  assert.equal(services.statusCode, 503);
  assert.equal((services.json() as FeedError).code, 'source_unavailable');
  assert.equal(services.headers['retry-after'], undefined);
});

test('a text search past its own time limit is busy with a longer wait; the plain list keeps the usual one', async (t) => {
  // Only the search statement times out; every other statement answers.
  const app = await createApp({ dataDir: ':memory:', startWorkers: false });
  t.after(() => app.close());
  const db = app.city.db;
  const transaction = db.transaction.bind(db);
  let slow: RegExp | null = null;
  Object.assign(db, {
    transaction: (action: Parameters<Database['transaction']>[0]) =>
      transaction((tx) =>
        action({
          ...tx,
          query: (sql: string, params?: unknown[]) =>
            slow && slow.test(sql)
              ? Promise.reject(pgError('57014', 'canceling statement due to statement timeout'))
              : tx.query(sql, params),
        } as typeof tx),
      ),
  });
  const requests = createFeedRequests({
    db,
    clock: () => NOW,
    secret: () => HASHING,
    limit: async () => {},
  });

  slow = /to_tsquery/;
  await assert.rejects(
    requests.list({ q: 'receipts', tag: null, cursor: null }),
    (error: unknown) => {
      assert.ok(error instanceof FeedBusyError);
      assert.equal(error.retryAfterS, FEED_SEARCH_BUSY_RETRY_AFTER_S);
      return true;
    },
  );
  // Searching never reached the plain list: it still answers.
  assert.deepEqual(await requests.list({ q: '', tag: null, cursor: null }), {
    requests: [],
    next: null,
  });

  // The plain list past the same limit is load, not the words: busy.
  slow = /FROM feed_requests WHERE/;
  await assert.rejects(requests.list({ q: '', tag: null, cursor: null }), (error: unknown) =>
    transientDatabaseError(error),
  );
  await assert.rejects(requests.list({ q: '', tag: 'pdf', cursor: null }), (error: unknown) =>
    transientDatabaseError(error),
  );
});

test('in the app: a signed-in caller gets busy when the session lookup itself fails', async (t) => {
  const before = process.env.CITY_FEED;
  t.after(() => {
    if (before === undefined) delete process.env.CITY_FEED;
    else process.env.CITY_FEED = before;
  });
  process.env.CITY_FEED = '1';
  t.mock.method(console, 'warn', () => {});
  const app = await createApp({ dataDir: ':memory:', startWorkers: false });
  t.after(() => app.close());
  // Only the session lookup fails (the app's request hook, before any Feed handler runs); the web
  // client sends its session cookie with every Feed call.
  const db = app.city.db;
  const query = db.query.bind(db);
  let failure: (() => Error) | null = null;
  Object.assign(db, {
    query: (sql: string, params?: unknown[]) =>
      failure && /\bFROM sessions\b/.test(sql) ? Promise.reject(failure()) : query(sql, params),
  });
  const cookie = { cookie: 'cc_session=feed-busy-test-session-token' };

  for (const [kind, transient] of TRANSIENT.slice(0, 3)) {
    failure = transient;
    for (const [what, call] of [...requestCalls(), ...serviceCalls()]) {
      const response = await app.inject({
        ...call,
        headers: { ...call.headers, ...cookie, 'x-city-request': '1' },
      });
      assertBusy(response, `${kind}, signed in, ${what}`);
    }
    // Outside the Feed the same failure is the app's own busy answer (server/busy.ts).
    const other = await app.inject({ url: '/api/session', headers: cookie });
    assert.equal(other.statusCode, 503, `${kind}, outside the Feed: ${other.body}`);
    assert.equal((other.json() as { error: string }).error, DATABASE_BUSY_MESSAGE);
  }
  // A real error in the lookup is still the plain 500, on the Feed too.
  failure = NOT_TRANSIENT[0][1];
  const real = await app.inject({ url: FEED_PATHS.status, headers: cookie });
  assert.equal(real.statusCode, 500, real.body);
  assert.equal(real.headers['retry-after'], undefined);
});

test('a busy answer leaves one log line per route and code a minute: no address, no query', async (t) => {
  forgetFeedBusyLog();
  t.after(forgetFeedBusyLog);
  const lines: string[] = [];
  t.mock.method(console, 'warn', (line: string) => lines.push(line));
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const app = requestRoutes(
    t,
    failingDb(() => pgError('57014', 'canceling statement due to statement timeout')),
  );
  const status = { url: FEED_PATHS.status, remoteAddress: '198.51.100.7' };
  const search = { url: `${FEED_PATHS.requests}?q=secret-words`, remoteAddress: '198.51.100.7' };

  for (let i = 0; i < 3; i += 1) assertBusy(await app.inject(status), 'status');
  assertSearchTooSlow(await app.inject(search), 'search');
  assert.deepEqual(
    lines.map((line) => JSON.parse(line)),
    [
      { event: 'feed.busy', code: '57014', route: FEED_PATHS.status, suppressed: 0 },
      { event: 'feed.busy', code: '57014', route: FEED_PATHS.requests, suppressed: 0 },
    ],
  );
  for (const line of lines) assert.doesNotMatch(line, /198\.51|secret|canceling/);

  // A minute later the route logs again, with how many busy answers it left out.
  t.mock.timers.tick(FEED_BUSY_LOG_EVERY_MS);
  assertBusy(await app.inject(status), 'status');
  assert.deepEqual(JSON.parse(lines[2]), {
    event: 'feed.busy',
    code: '57014',
    route: FEED_PATHS.status,
    suppressed: 2,
  });

  // A pool timeout has no code of its own.
  const pool = requestRoutes(
    t,
    failingDb(() => new Error('timeout exceeded when trying to connect')),
  );
  assertBusy(await pool.inject(status), 'pool');
  assert.equal(JSON.parse(lines[3]).code, 'pool');
});

test('Respond routes answer busy too: the service or the session lookup failing for a moment', async (t) => {
  const RESPONSE_ID = 'fri_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const calls: Array<readonly [string, InjectOptions]> = [
    [
      'respond',
      {
        method: 'POST',
        url: FEED_RESPOND_PATHS.respond.replace(':id', REQUEST_ID),
        payload: {
          newRoom: true,
          fromAgentId: randomUUID(),
          note: '',
          idempotencyKey: randomUUID(),
        },
      },
    ],
    ['count', { url: FEED_RESPOND_PATHS.count.replace(':id', REQUEST_ID) }],
    ['mine', { url: FEED_RESPOND_PATHS.mine.replace(':id', REQUEST_ID) }],
    [
      'withdraw',
      { method: 'POST', url: FEED_RESPOND_PATHS.withdraw.replace(':id', RESPONSE_ID), payload: {} },
    ],
  ];
  const routes = (failure: () => Error, where: 'service' | 'session') => {
    const app = Fastify();
    t.after(() => app.close());
    const fail = async (): Promise<never> => {
      throw failure();
    };
    registerFeedRespondRoutes(app, {
      respond: { send: fail, count: fail, mine: fail, withdraw: fail } as unknown as FeedRespond,
      owner: where === 'session' ? fail : async () => ({ id: 'ws-1' }) as Operator,
      originOf: () => 'https://centralcity.ai',
      enabled: () => true,
    });
    return app;
  };
  for (const [kind, failure] of TRANSIENT)
    for (const where of ['service', 'session'] as const) {
      const app = routes(failure, where);
      for (const [what, call] of calls)
        assertBusy(await app.inject(call), `${kind}, ${where}, ${what}`);
    }
  // A real error is not busy.
  const app = routes(() => new TypeError('rows is undefined'), 'service');
  assert.equal((await app.inject(calls[1]![1])).statusCode, 500);
  // In the app, failures in its own hooks on these paths answer busy as well.
  assert.equal(isFeedPath(FEED_RESPOND_PATHS.mine.replace(':id', REQUEST_ID)), true);
  assert.equal(isFeedPath(FEED_RESPOND_PATHS.withdraw), true);
  assert.equal(isFeedPath(FEED_PATHS.mine), true);
  assert.equal(isFeedPath('/api/feedback'), false);
  assert.equal(isFeedPath('/api/public/feedback'), false);
});

test('in the app: the ops Feed routes answer busy under load too; real errors keep the 500', async (t) => {
  const saved = { feed: process.env.CITY_FEED, ops: process.env.CITY_OPS_SECRET };
  t.after(() => {
    if (saved.feed === undefined) delete process.env.CITY_FEED;
    else process.env.CITY_FEED = saved.feed;
    if (saved.ops === undefined) delete process.env.CITY_OPS_SECRET;
    else process.env.CITY_OPS_SECRET = saved.ops;
  });
  process.env.CITY_FEED = '1';
  process.env.CITY_OPS_SECRET = 'feed-busy-test-ops-secret-0000000000001';
  t.mock.method(console, 'warn', () => {});
  const app = await createApp({ dataDir: ':memory:', startWorkers: false });
  t.after(() => app.close());
  // Every Feed statement and every transaction fails while `failure` is set, and so does the
  // session lookup (a route outside the Feed).
  const db = app.city.db;
  const query = db.query.bind(db);
  const transaction = db.transaction.bind(db);
  let failure: (() => Error) | null = null;
  Object.assign(db, {
    query: (sql: string, params?: unknown[]) =>
      failure && /\bfeed_|\bFROM sessions\b/.test(sql)
        ? Promise.reject(failure())
        : query(sql, params),
    transaction: (action: Parameters<Database['transaction']>[0]) =>
      failure ? Promise.reject(failure()) : transaction(action),
  });
  const ops = {
    authorization: `Bearer ${process.env.CITY_OPS_SECRET}`,
    'x-city-request': '1',
  };
  const opsCalls: Array<readonly [string, InjectOptions]> = [
    ['ops list', { url: '/api/ops/feed/requests?state=held', headers: ops }],
    [
      'ops release',
      {
        method: 'POST',
        url: `/api/ops/feed/requests/${REQUEST_ID}/release`,
        headers: ops,
        payload: {},
      },
    ],
    [
      'ops remove',
      {
        method: 'POST',
        url: `/api/ops/feed/requests/${REQUEST_ID}/remove`,
        headers: ops,
        payload: {},
      },
    ],
    [
      'ops pause',
      { method: 'POST', url: '/api/ops/feed/pause', headers: ops, payload: { paused: true } },
    ],
  ];
  const cookie = { cookie: 'cc_session=feed-busy-test-session-token' };

  for (const [kind, transient] of TRANSIENT.slice(0, 3)) {
    failure = transient;
    for (const [what, call] of opsCalls) assertBusy(await app.inject(call), `${kind}, ${what}`);
    // Outside the Feed the same failure is the app's own busy answer (server/busy.ts).
    const other = await app.inject({ url: '/api/session', headers: cookie });
    assert.equal(other.statusCode, 503, `${kind}, outside the Feed: ${other.body}`);
    assert.equal((other.json() as { error: string }).error, DATABASE_BUSY_MESSAGE);
    assert.equal(
      other.headers['retry-after'],
      String(DATABASE_BUSY_RETRY_AFTER_S),
      `${kind}, outside the Feed`,
    );
  }
  for (const [kind, real] of NOT_TRANSIENT) {
    failure = real;
    for (const [what, call] of opsCalls) {
      const response = await app.inject(call);
      assert.equal(response.statusCode, 500, `${kind}, ${what}: ${response.body}`);
      assert.deepEqual(
        response.json(),
        { error: 'The operation could not be completed.' },
        `${kind}, ${what}`,
      );
      assert.equal(response.headers['retry-after'], undefined, `${kind}, ${what}`);
    }
  }

  // The database answers again: so do the ops routes.
  failure = null;
  const list = await app.inject(opsCalls[0][1]);
  assert.equal(list.statusCode, 200, list.body);
  // Without the secret it is still the ops routes' 404, never busy.
  failure = TRANSIENT[0][1];
  const refused = await app.inject({ url: '/api/ops/feed/requests?state=held' });
  assert.equal(refused.statusCode, 404, refused.body);
});
