import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { readTimeoutError, type Database } from '../server/database.js';
import {
  ON_BASE_SEARCH_SITE_RATE,
  SEARCH_CACHE_MS,
  SEARCH_TIMEOUT_MS,
  registerOnBaseRoutes,
} from '../server/base/explorer/routes.js';
import type { OnBaseList } from '../shared/base/on-base.js';
import { NOW, add, setup } from './on-base-fixture.js';

/*
 * The Explorer's search (GET /api/public/base/agents?q=): bounded in the database, shared by the
 * spellings that mean the same search, and limited per IPv6 /56 for name searches.
 */

/** What the search statement does: answers, runs out of its time, or fails on its own. */
type Outcome = 'answer' | 'timeout' | 'broken';
/** The error Postgres answers a statement past its statement_timeout with. */
const statementTimeout = () =>
  Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });

/** The database, counting the searches it runs and the statements of each transaction. */
function watched(db: Database, outcome: () => Outcome = () => 'answer') {
  const seen = { searches: 0, statements: [] as string[] };
  const wrapped: Database = {
    ...db,
    transaction: (action) =>
      db.transaction((tx) =>
        action({
          ...tx,
          query: ((sql: string, params?: unknown[]) => {
            seen.statements.push(sql);
            if (/agent_card_uri/.test(sql)) {
              seen.searches += 1;
              if (outcome() === 'timeout') return Promise.reject(statementTimeout());
              if (outcome() === 'broken')
                return tx.query('SELECT 1 FROM no_such_table_for_the_search', []);
            }
            return tx.query(sql, params as never);
          }) as Database['query'],
        }),
      ),
  };
  return { seen, db: wrapped };
}

function routes(
  t: { after: (fn: () => Promise<unknown>) => void },
  db: Database,
  now: () => number,
  limits: Array<[string, number, number]> = [],
) {
  const app = Fastify();
  t.after(() => app.close());
  registerOnBaseRoutes(app, {
    db,
    now,
    limit: async (key, max, windowMs) => {
      limits.push([key, max, windowMs]);
    },
  });
  return app;
}

test('a search runs read only with its own statement timeout, and the same search is read once', async (t) => {
  const base = await setup(t);
  await add(base, { n: 1, kind: 'final', id: 120, name: 'Harbor' });
  await add(base, { n: 2, kind: 'final', id: 121, name: 'Meridian' });
  const { seen, db } = watched(base);
  let clock = NOW;
  const app = routes(t, db, () => clock);
  const names = async (q: string) =>
    (
      (
        await app.inject({ url: `/api/public/base/agents?q=${encodeURIComponent(q)}` })
      ).json() as OnBaseList
    ).rows.map((row) => row.name);

  assert.deepEqual(await names('Harb'), ['Harbor']);
  assert.equal(seen.searches, 1);
  assert.ok(seen.statements.includes('SET TRANSACTION READ ONLY'));
  assert.ok(seen.statements.includes(`SET LOCAL statement_timeout = ${SEARCH_TIMEOUT_MS}`));
  // Another spelling of the same search (a control character reads as a space, then trimmed).
  assert.deepEqual(await names('Harb\u0007'), ['Harbor']);
  assert.equal(seen.searches, 1);
  // Another search, and the same one after SEARCH_CACHE_MS, are read again.
  assert.deepEqual(await names('Meri'), ['Meridian']);
  assert.equal(seen.searches, 2);
  clock += SEARCH_CACHE_MS;
  assert.deepEqual(await names('Harb'), ['Harbor']);
  assert.equal(seen.searches, 3);
});

test('a search that cannot finish in time is busy (503), never kept, and the list still answers', async (t) => {
  const base = await setup(t);
  await add(base, { n: 1, kind: 'final', id: 120, name: 'Harbor' });
  let outcome: Outcome = 'timeout';
  const { seen, db } = watched(base, () => outcome);
  const app = routes(t, db, () => NOW);
  const busy = await app.inject({ url: '/api/public/base/agents?q=Harb' });
  assert.equal(busy.statusCode, 503);
  assert.equal(busy.headers['cache-control'], 'no-store');
  assert.equal(busy.headers['retry-after'], '10');
  assert.equal((busy.json() as { code: string }).code, 'busy');
  // The unfiltered list does not run through the search.
  assert.equal((await app.inject({ url: '/api/public/base/agents' })).statusCode, 200);
  outcome = 'answer';
  const again = await app.inject({ url: '/api/public/base/agents?q=Harb' });
  assert.equal(again.statusCode, 200);
  assert.equal(seen.searches, 2);
});

test('a search that fails for any other reason is an error (500), never busy', async (t) => {
  const base = await setup(t);
  await add(base, { n: 1, kind: 'final', id: 120, name: 'Harbor' });
  const { db } = watched(base, () => 'broken');
  const app = routes(t, db, () => NOW);
  const failed = await app.inject({ url: '/api/public/base/agents?q=Harb' });
  assert.equal(failed.statusCode, 500);
  assert.notEqual((failed.json() as { code?: string }).code, 'busy');
});

test('name searches are also limited per IPv6 /56; address searches and IPv4 only per address', async (t) => {
  const db = await setup(t);
  await add(db, { n: 1, kind: 'final', id: 120, name: 'Harbor' });
  const limits: Array<[string, number, number]> = [];
  const app = routes(t, db, () => NOW, limits);
  const site = (remoteAddress: string, q: string) =>
    app
      .inject({ url: `/api/public/base/agents?q=${q}`, remoteAddress })
      .then(() => limits.splice(0).filter(([key]) => key.startsWith('ip:onbase-search:')));

  assert.deepEqual(await site('2001:db8:1:2a::5', 'Harb'), [
    ['ip:onbase-search:2001:db8:1:0::/56', ON_BASE_SEARCH_SITE_RATE.max, 60_000],
  ]);
  // Another /64 of the same /56 shares the budget.
  assert.deepEqual(await site('2001:db8:1:7f::9', 'Mer'), [
    ['ip:onbase-search:2001:db8:1:0::/56', ON_BASE_SEARCH_SITE_RATE.max, 60_000],
  ]);
  // An address or a transaction is never a name search.
  assert.deepEqual(await site('2001:db8:1:2a::5', `0x${'1'.repeat(40)}`), []);
  assert.deepEqual(await site('192.0.2.7', 'Harb'), []);
});

test('busy means out of time only: a statement or read timeout, or no connection in time', () => {
  assert.equal(readTimeoutError(statementTimeout()), true);
  assert.equal(readTimeoutError(new Error('Query read timeout')), true);
  assert.equal(readTimeoutError(new Error('timeout exceeded when trying to connect')), true);
  assert.equal(
    readTimeoutError(Object.assign(new Error('no such table'), { code: '42P01' })),
    false,
  );
  assert.equal(readTimeoutError(new TypeError('x is undefined')), false);
});
