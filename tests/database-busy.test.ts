import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { btree_gin } from '@electric-sql/pglite/contrib/btree_gin';
import Fastify from 'fastify';
import { createApp } from '../server/app.js';
import type { Database, Transaction } from '../server/database.js';
import {
  DATABASE_BUSY_MESSAGE,
  DATABASE_BUSY_RETRY_AFTER_S,
  DATABASE_BUSY_UNSURE_MESSAGE,
  forgetDatabaseBusyLog,
  sendDatabaseBusy,
} from '../server/busy.js';

// 14 Oct 2026: under load the pool gave no connection within 5 s and every route answered a plain
// 500 with nothing in the log. A transient database failure is "not now": 503 busy with
// Retry-After, never cached, and one log line per route and code.

const ORIGIN = 'https://centralcity.ai';
const HOST = 'centralcity.ai';
const CARD = '/a2a/00000000-0000-4000-8000-000000000001/.well-known/agent-card.json';

/**
 * A database that fails with `failure` while it is set: every statement, or (with `failFrom`) only
 * the statements from that count on, so the earlier ones of the same request have run.
 */
function failing(inner: Database) {
  const state: { failure: Error | null; failFrom: number | null; count: number } = {
    failure: null,
    failFrom: null,
    count: 0,
  };
  const fails = () => {
    state.count += 1;
    return state.failure !== null && (state.failFrom === null || state.count >= state.failFrom);
  };
  const wrap = (q: Transaction): Transaction => ({
    query: (sql, params) => (fails() ? Promise.reject(state.failure) : q.query(sql, params)),
    exec: (sql) => (fails() ? Promise.reject(state.failure) : q.exec(sql)),
  });
  const db: Database = {
    ...wrap(inner),
    transaction: (action) =>
      state.failure !== null && state.failFrom === null
        ? Promise.reject(state.failure)
        : inner.transaction((tx) => action(wrap(tx))),
    close: () => inner.close(),
  };
  return { db, state };
}

async function hostedApp(t: test.TestContext) {
  process.env.CITY_RATE_LIMIT_KEY ??= 'synthetic-database-busy-root-secret';
  const pglite = (await PGlite.create('memory://', {
    extensions: { btree_gin },
  })) as unknown as Database;
  const { db, state } = failing(pglite);
  const app = await createApp({
    hosted: {
      databaseUrl: 'postgres://unused.invalid/test',
      publicOrigin: ORIGIN,
      allowedOrigins: [ORIGIN],
    },
    startWorkers: false,
    database: db,
  });
  t.after(() => app.close());
  await app.ready();
  return { app, state, db: pglite };
}

function captureWarnings(t: test.TestContext) {
  const lines: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    const line = args.map(String).join(' ');
    // Only this answer's lines (the shared rate limiter logs its own degraded mode).
    if (line.includes('"event":"db.busy"')) lines.push(line);
  };
  t.after(() => {
    console.warn = original;
  });
  return lines;
}

test('a pool that gives no connection in time: 503 busy with Retry-After, never cached', async (t) => {
  forgetDatabaseBusyLog();
  const { app, state } = await hostedApp(t);
  const warnings = captureWarnings(t);
  const before = await app.inject({ url: CARD, headers: { host: HOST } });
  assert.equal(before.statusCode, 404, before.body);

  state.failure = new Error('timeout exceeded when trying to connect');
  const busy = await app.inject({ url: CARD, headers: { host: HOST } });
  assert.equal(busy.statusCode, 503, busy.body);
  assert.equal(busy.headers['retry-after'], String(DATABASE_BUSY_RETRY_AFTER_S));
  assert.equal(busy.headers['cache-control'], 'no-store');
  assert.equal(busy.headers['vercel-cdn-cache-control'], undefined);
  assert.deepEqual(busy.json(), { error: DATABASE_BUSY_MESSAGE, code: 'busy', retryable: true });
  // One line with the route pattern and the code, never the message or the address.
  const logged = warnings.map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.deepEqual(logged, [
    {
      event: 'db.busy',
      code: 'pool',
      route: '/a2a/:agentId/.well-known/agent-card.json',
      retryable: true,
      suppressed: 0,
    },
  ]);

  // Recovered: the same request is answered normally again.
  state.failure = null;
  const after = await app.inject({ url: CARD, headers: { host: HOST } });
  assert.equal(after.statusCode, 404, after.body);
});

test('a statement timeout (57014) and a lost connection are busy too; the log is throttled', async (t) => {
  forgetDatabaseBusyLog();
  const { app, state } = await hostedApp(t);
  const warnings = captureWarnings(t);
  state.failure = Object.assign(new Error('canceling statement due to statement timeout'), {
    code: '57014',
  });
  for (let i = 0; i < 3; i++) {
    const response = await app.inject({ url: CARD, headers: { host: HOST } });
    assert.equal(response.statusCode, 503, response.body);
  }
  state.failure = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
  const reset = await app.inject({ url: CARD, headers: { host: HOST } });
  assert.equal(reset.statusCode, 503, reset.body);
  const codes = warnings.map((line) => (JSON.parse(line) as { code: string }).code);
  // One line per route and code per minute: 57014 once (two suppressed), ECONNRESET once.
  assert.deepEqual(codes, ['57014', 'ECONNRESET']);
});

test('any other database failure keeps the plain 500', async (t) => {
  forgetDatabaseBusyLog();
  const { app, state } = await hostedApp(t);
  const warnings = captureWarnings(t);
  state.failure = Object.assign(new Error('duplicate key value violates unique constraint'), {
    code: '23505',
  });
  const response = await app.inject({ url: CARD, headers: { host: HOST } });
  assert.equal(response.statusCode, 500, response.body);
  assert.deepEqual(response.json(), { error: 'The operation could not be completed.' });
  assert.equal(response.headers['retry-after'], undefined);
  assert.deepEqual(warnings, []);
});

// Retryable only for a read. A write may have committed part of its work (a withdrawal, a room
// action) even when the failing statement itself never reached the database: busy but not
// retryable, without Retry-After.
const lost = () => Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
// A signed-in write outside the Feed: its session lookup is its first statement.
const write = {
  method: 'POST' as const,
  url: '/api/agents',
  headers: {
    'content-type': 'application/json',
    'x-city-request': '1',
    host: HOST,
    origin: ORIGIN,
    cookie: 'cc_session=database-busy-test-session-token',
  },
  payload: JSON.stringify({ name: 'Busy', capability: 'research', mode: 'hosted' }),
};

test('a read that lost its connection is busy and retryable', async (t) => {
  forgetDatabaseBusyLog();
  const { app, state } = await hostedApp(t);
  captureWarnings(t);
  state.failure = lost();
  const response = await app.inject({ url: CARD, headers: { host: HOST } });
  assert.equal(response.statusCode, 503, response.body);
  assert.equal(response.headers['retry-after'], String(DATABASE_BUSY_RETRY_AFTER_S));
  assert.deepEqual(response.json(), {
    error: DATABASE_BUSY_MESSAGE,
    code: 'busy',
    retryable: true,
  });
});

test('a write is busy but never retryable, whatever failed, without Retry-After', async (t) => {
  forgetDatabaseBusyLog();
  const { app, state } = await hostedApp(t);
  const warnings = captureWarnings(t);
  for (const failure of [
    lost(),
    Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' }),
    new Error('Connection terminated unexpectedly'),
    // Never sent, yet the request as a whole is not known to have done nothing.
    new Error('timeout exceeded when trying to connect'),
    Object.assign(new Error('sorry, too many clients already'), { code: '53300' }),
  ]) {
    state.failure = failure;
    const response = await app.inject(write);
    assert.equal(response.statusCode, 503, response.body);
    assert.equal(response.headers['retry-after'], undefined);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.deepEqual(response.json(), {
      error: DATABASE_BUSY_UNSURE_MESSAGE,
      code: 'busy',
      retryable: false,
    });
  }
  assert.ok(warnings.length > 0);
  for (const line of warnings)
    assert.equal((JSON.parse(line) as { retryable: boolean }).retryable, false);
});

test('a write that committed a statement and then got no connection is not retryable', async (t) => {
  forgetDatabaseBusyLog();
  const { app, state, db } = await hostedApp(t);
  captureWarnings(t);
  const headers = {
    'content-type': 'application/json',
    'x-city-request': '1',
    host: HOST,
    origin: ORIGIN,
  };
  const registered = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    headers,
    payload: JSON.stringify({ name: 'Busy owner', password: 'busy-owner-password-000001' }),
  });
  assert.equal(registered.statusCode, 201, registered.body);
  const cookie = `cc_session=${registered.cookies.find((c) => c.name === 'cc_session')!.value}`;
  const create = (name: string) =>
    app.inject({
      method: 'POST',
      url: '/api/agents',
      headers: { ...headers, cookie },
      payload: JSON.stringify({ name, capability: 'research', mode: 'hosted' }),
    });
  // How many statements one create runs once caches are warm, all of them answered.
  assert.equal((await create('First')).statusCode, 201);
  state.count = 0;
  assert.equal((await create('Probe')).statusCode, 201);
  const statements = state.count;
  assert.ok(statements > 1, `one create runs ${statements} statements`);
  // Committed writes so far: the per-IP and per-account request counters.
  const counted = async () =>
    Number(
      (await db.query<{ n: string }>('SELECT COALESCE(SUM(count), 0)::text AS n FROM rate_limits'))
        .rows[0]!.n,
    );
  const before = await counted();
  // The same create again: every statement but the last runs, the last gets no connection.
  state.count = 0;
  state.failFrom = statements;
  state.failure = new Error('timeout exceeded when trying to connect');
  const response = await create('Second');
  assert.equal(state.count >= statements, true, 'the failing statement was reached');
  assert.equal(response.statusCode, 503, response.body);
  assert.equal(response.headers['retry-after'], undefined);
  assert.deepEqual(response.json(), {
    error: DATABASE_BUSY_UNSURE_MESSAGE,
    code: 'busy',
    retryable: false,
  });
  // Before the failure the request had already committed a write (its request counters).
  state.failure = null;
  assert.ok((await counted()) > before, 'an earlier statement of the same request committed');
});

test('a non-retryable answer drops a Retry-After the handler set before it failed', async (t) => {
  forgetDatabaseBusyLog();
  captureWarnings(t);
  const app = Fastify();
  t.after(() => app.close());
  app.setErrorHandler((error, _request, reply) => sendDatabaseBusy(reply, error));
  for (const method of ['POST', 'GET'] as const)
    app.route({
      method,
      url: '/x',
      handler: async (_request, reply) => {
        reply.header('Retry-After', '30');
        throw new Error('timeout exceeded when trying to connect');
      },
    });
  const write = await app.inject({ method: 'POST', url: '/x' });
  assert.equal(write.statusCode, 503);
  assert.equal(write.headers['retry-after'], undefined);
  assert.equal((write.json() as { retryable: boolean }).retryable, false);
  // A read keeps the busy answer's own Retry-After.
  const read = await app.inject({ method: 'GET', url: '/x' });
  assert.equal(read.statusCode, 503);
  assert.equal(read.headers['retry-after'], String(DATABASE_BUSY_RETRY_AFTER_S));
});
