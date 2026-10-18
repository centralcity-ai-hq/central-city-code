import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import type { Database } from '../server/database.js';
import {
  ON_BASE_LIST_LIVE,
  ON_BASE_LIST_LIVE_EDGE,
  RATED_KEYS,
  RATED_TTL_MS,
  registerOnBaseRoutes,
} from '../server/base/explorer/routes.js';
import { RATED_AGENTS_SQL } from '../server/base/explorer/store.js';
import { BASE_MAINNET, BASE_NETWORKS, type BaseChainId } from '../shared/base/chains.js';
import type { OnBaseList } from '../shared/base/on-base.js';
import { NOW, add, addRating, setup } from './on-base-fixture.js';

/*
 * The Agent Explorer's "Rated agents" number (totals.ratedAgents): distinct Base IDs with at least
 * one rating sent through Central City whose operation is FINAL on Base, every rater counted. One
 * count shared by every instance through a public_stats row, about once per RATED_TTL_MS, never
 * one per request; a failed count never fails the list.
 */

type T = { after: (fn: () => Promise<unknown>) => void };

function routes(t: T, db: Database, now: () => number) {
  const app = Fastify();
  t.after(() => app.close());
  registerOnBaseRoutes(app, { db, now });
  return app;
}

/** The database, counting each run of the rated-agents count; `fail` makes that count throw. */
function counted(db: Database) {
  const state = { counts: 0, fail: false };
  const wrapped: Database = {
    ...db,
    query: ((sql: string, params?: unknown[]) => {
      if (sql === RATED_AGENTS_SQL) {
        state.counts++;
        if (state.fail) return Promise.reject(new Error('statement timeout'));
      }
      return db.query(sql, params as never);
    }) as Database['query'],
  };
  return { state, db: wrapped };
}

async function list(app: ReturnType<typeof routes>) {
  const response = await app.inject({ url: '/api/public/base/agents' });
  assert.equal(response.statusCode, 200, response.body);
  return { response, body: response.json() as OnBaseList };
}

test('rated agents: distinct Base IDs with a FINAL rating on this network, every rater', async (t) => {
  const db = await setup(t);
  for (let n = 1; n <= 7; n++) await add(db, { n, kind: 'final', id: 119 + n });
  await add(db, { n: 8, kind: 'finalizing', id: 130 });
  const rate = (id: string, rater: number, baseId: number, more: Record<string, unknown> = {}) =>
    addRating(db, { id, rater, baseId, rated: baseId - 119, stars: 4, ...more });
  // 120: two final ratings, counted once.
  await rate('a', 2, 120);
  await rate('b', 3, 120, { block: 2001 });
  // 121: only included so far; 122 reverted on Base; 123 failed, or signed with no operation yet.
  await rate('c', 1, 121, { status: 'included' });
  await rate('d', 1, 122, { reverted: true });
  await rate('e', 1, 123, { status: 'failed', block: null });
  await rate('f', 2, 123, { status: null });
  // 124: final, but on another network.
  await rate('g', 1, 124, { chainId: 84532 });
  // 125: final, from an agent whose own Base ID is still finalizing: every rater counts.
  await rate('h', 8, 125);
  const app = routes(t, db, () => NOW);
  const { response, body } = await list(app);
  assert.equal(body.totals.ratedAgents, 2);
  // Same caching as every other number on the list.
  assert.equal(response.headers['cache-control'], ON_BASE_LIST_LIVE);
  assert.equal(response.headers['vercel-cdn-cache-control'], ON_BASE_LIST_LIVE_EDGE);
  // The key sits beside the other counts.
  assert.deepEqual(Object.keys(body.totals), [
    'onBase',
    'new24h',
    'finalizingNow',
    'ratedAgents',
    'readAtBlock',
    'readAt',
    'servedAt',
  ]);
  // Only the number: nothing about who rated whom.
  assert.equal(typeof body.totals.ratedAgents, 'number');
});

/** Lets a refresh that runs without the request (stale-while-revalidate) finish. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

test('rated agents: one shared count per RATED_TTL_MS across instances; it rises as ratings turn final', async (t) => {
  const base = await setup(t);
  for (let n = 1; n <= 4; n++) await add(base, { n, kind: 'final', id: 119 + n });
  await addRating(base, { id: 'a', rater: 2, baseId: 120, rated: 1, stars: 5 });
  await addRating(base, { id: 'b', rater: 1, baseId: 121, rated: 2, stars: 3, status: 'included' });
  const { state, db } = counted(base);
  let now = NOW;
  const one = routes(t, db, () => now);
  const two = routes(t, db, () => now);

  assert.equal((await list(one)).body.totals.ratedAgents, 1);
  assert.equal(state.counts, 1);
  // The other instance reads the shared row: no count of its own.
  assert.equal((await list(two)).body.totals.ratedAgents, 1);
  assert.equal(state.counts, 1);
  const row = await base.query<{ value: string }>('SELECT value FROM public_stats WHERE key=$1', [
    RATED_KEYS[BASE_MAINNET],
  ]);
  assert.equal(Number(row.rows[0]?.value), 1);

  // 121's rating turns final on Base. Within the interval both answer the shared count.
  await base.query(`UPDATE base_chain_ops SET status = 'final' WHERE op_id = $1`, [
    'base-wallet:rate:b',
  ]);
  now += RATED_TTL_MS - 1;
  for (const app of [one, two, one]) assert.equal((await list(app)).body.totals.ratedAgents, 1);
  assert.equal(state.counts, 1);

  // Once the interval is over the list answers at once with the last count, while exactly one
  // count across both instances runs on its own; then both rise.
  now += 1;
  assert.equal((await list(one)).body.totals.ratedAgents, 1);
  assert.equal((await list(two)).body.totals.ratedAgents, 1);
  await settle();
  assert.equal(state.counts, 2);
  now += 1_000;
  assert.equal((await list(one)).body.totals.ratedAgents, 2);
  assert.equal((await list(two)).body.totals.ratedAgents, 2);
  assert.equal(state.counts, 2);
});

test('rated agents: the list never waits for the count', async (t) => {
  const base = await setup(t);
  await add(base, { n: 1, kind: 'final', id: 120 });
  await add(base, { n: 2, kind: 'final', id: 121 });
  await addRating(base, { id: 'a', rater: 2, baseId: 120, rated: 1, stars: 5 });
  let release = () => undefined as void;
  let hang = false;
  let counts = 0;
  const db: Database = {
    ...base,
    query: ((sql: string, params?: unknown[]) => {
      if (sql === RATED_AGENTS_SQL) {
        counts++;
        if (hang)
          return new Promise(
            (resolve) => (release = () => resolve(base.query(sql, params as never))),
          );
      }
      return base.query(sql, params as never);
    }) as Database['query'],
  };
  let now = NOW;
  assert.equal((await list(routes(t, db, () => now))).body.totals.ratedAgents, 1);

  // The count stalls (a slow database): this instance and a new one both answer the stored count.
  hang = true;
  now += RATED_TTL_MS;
  const app = routes(t, db, () => now);
  const fresh = routes(t, db, () => now);
  const started = Date.now();
  for (const one of [app, app, fresh]) assert.equal((await list(one)).body.totals.ratedAgents, 1);
  assert.ok(Date.now() - started < 2_000);
  assert.equal(counts, 2);
  release();
  await settle();
});

test('rated agents: a failed count never fails the list, and is not retried on every request', async (t) => {
  const base = await setup(t);
  await add(base, { n: 1, kind: 'final', id: 120 });
  await add(base, { n: 2, kind: 'final', id: 121 });
  await addRating(base, { id: 'a', rater: 2, baseId: 120, rated: 1, stars: 5 });
  const { state, db } = counted(base);
  let now = NOW;
  const app = routes(t, db, () => now);

  // Never counted: the list answers, rated agents null; the next request does not ask again.
  state.fail = true;
  const first = await list(app);
  assert.equal(first.body.totals.ratedAgents, null);
  assert.equal(first.body.totals.onBase, 2);
  assert.equal((await list(app)).body.totals.ratedAgents, null);
  assert.equal(state.counts, 1);

  // After the back-off it counts again.
  state.fail = false;
  await base.query('UPDATE public_stats SET refreshing_until = 0');
  now += RATED_TTL_MS;
  assert.equal((await list(app)).body.totals.ratedAgents, 1);
  assert.equal(state.counts, 2);

  // A later failure keeps the last count, without a retry per request.
  await base.query('UPDATE public_stats SET refreshing_until = 0');
  state.fail = true;
  now += RATED_TTL_MS;
  assert.equal((await list(app)).body.totals.ratedAgents, 1);
  await settle();
  assert.equal((await list(app)).body.totals.ratedAgents, 1);
  assert.equal(state.counts, 3);
});

test('rated agents: a failed count holds the shared lease for the back-off; a new instance answers the stored count', async (t) => {
  const base = await setup(t);
  await add(base, { n: 1, kind: 'final', id: 120 });
  await add(base, { n: 2, kind: 'final', id: 121 });
  await addRating(base, { id: 'a', rater: 2, baseId: 120, rated: 1, stars: 5 });
  const { state, db } = counted(base);
  let now = NOW;
  assert.equal((await list(routes(t, db, () => now))).body.totals.ratedAgents, 1);

  // The stored count is stale and every count fails. A cold instance wins the lease and fails:
  // it still answers the stored count, never null.
  state.fail = true;
  now += RATED_TTL_MS;
  const a = routes(t, db, () => now);
  assert.equal((await list(a)).body.totals.ratedAgents, 1);
  await settle();
  assert.equal(state.counts, 2);
  assert.equal((await list(a)).body.totals.ratedAgents, 1);
  // The lease now runs for the whole back-off on the database clock, not just the 10 s lease.
  const held = await base.query<{ left: string }>(
    `SELECT refreshing_until - (extract(epoch from clock_timestamp()) * 1000)::bigint AS left
     FROM public_stats WHERE key = $1`,
    [RATED_KEYS[BASE_MAINNET]],
  );
  assert.ok(Number(held.rows[0]!.left) > RATED_TTL_MS - 5_000, held.rows[0]!.left);
  // Other instances, at any time inside it, serve the stored count and run no count of their own.
  for (const later of [11_000, 21_000]) {
    const other = routes(t, db, () => now + later);
    assert.equal((await list(other)).body.totals.ratedAgents, 1);
    await settle();
  }
  assert.equal(state.counts, 2);
});

test('rated agents: with no stored count yet, only the lease holder counts', async (t) => {
  const base = await setup(t);
  await add(base, { n: 1, kind: 'final', id: 120 });
  await add(base, { n: 2, kind: 'final', id: 121 });
  await addRating(base, { id: 'a', rater: 2, baseId: 120, rated: 1, stars: 5 });
  const { state, db } = counted(base);
  // Another instance holds the lease and has not stored a count yet.
  await base.query(
    `INSERT INTO public_stats (key, refreshing_until)
     VALUES ($1, (extract(epoch from clock_timestamp()) * 1000)::bigint + 60000)`,
    [RATED_KEYS[BASE_MAINNET]],
  );
  const app = routes(t, db, () => NOW);
  assert.equal((await list(app)).body.totals.ratedAgents, null);
  assert.equal(state.counts, 0);
});

test('rated agents: the count is one index-only count of base_rated_agents', async (t) => {
  const db = await setup(t);
  for (let n = 1; n <= 20; n++) await add(db, { n, kind: 'final', id: 200 + n });
  for (let n = 1; n <= 120; n++)
    await addRating(db, {
      id: `r${n}`,
      rater: (n % 20) + 1,
      baseId: 200 + (n % 23) + 1,
      rated: 1,
      stars: 4,
      status: n % 23 === 4 ? 'included' : 'final',
    });
  for (let n = 1; n <= 500; n++)
    await db.query(`INSERT INTO base_rated_agents (chain_id, rated_base_id) VALUES (84532, $1)`, [
      n,
    ]);
  await db.query('VACUUM ANALYZE base_rated_agents');
  // 23 rated Base IDs; the one whose ratings are all included is not counted.
  assert.equal(
    (await db.query<{ rated: string }>(RATED_AGENTS_SQL, [BASE_MAINNET])).rows[0]!.rated,
    '22',
  );
  await db.query('SET enable_seqscan = off');
  const plan = (
    await db.query<{ 'QUERY PLAN': string }>(
      `EXPLAIN ${RATED_AGENTS_SQL.replaceAll('$1', String(BASE_MAINNET))}`,
    )
  ).rows
    .map((row) => row['QUERY PLAN'])
    .join('\n');
  assert.match(plan, /Index Only Scan using base_rated_agents_pkey/);
  // Never the ratings, their operations, the listed agents or a workspace document.
  assert.doesNotMatch(
    RATED_AGENTS_SQL,
    /base_wallet_withdrawals|base_chain_ops|base_identities|workspaces|agent_manifests/,
  );
});

test('rated agents: every network has its own public_stats key', () => {
  const keys = Object.keys(BASE_NETWORKS).map((id) => RATED_KEYS[Number(id) as BaseChainId]);
  assert.equal(new Set(keys).size, keys.length);
  for (const key of keys) assert.match(key, /^[a-z_]{1,64}$/);
});
