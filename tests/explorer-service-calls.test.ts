import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import type { Database } from '../server/database.js';
import {
  COUNTER_READ_BUDGET_MS,
  DAY_TTL_MS,
  SERVICE_CALLS_SEARCH_GLOBAL,
  SERVICE_CALLS_CACHE_MS,
  SERVICE_CALLS_LIVE,
  SERVICE_CALLS_LIVE_EDGE,
  publicCall,
  registerServiceCallsRoutes,
} from '../server/base/explorer/calls.js';
import { FEED_PAY_SQL } from '../server/feed/pay/schema.js';
import { FEED_PAY_FEE_SQL } from '../server/feed/pay/fee-schema.js';
import { FEED_PAY_INCLUDED_SQL } from '../server/feed/pay/included-schema.js';
import { FEED_PAY_PAID_INDEX_SQL } from '../server/feed/pay/paid-index-schema.js';
import { PAID_CALL_COUNT_SQL } from '../server/feed/pay/count-schema.js';
import { PROTOCOL_SCREENING_SQL } from '../server/protocol/screening/schema.js';
import {
  SERVICE_CALLS_PAGE_SIZE,
  SERVICE_CALLS_PATH,
  parseServiceCallsSearch,
  type ServiceCallsPage,
} from '../shared/explorer-calls.js';
import { MIN, NOW, add, setup as baseSetup, spender } from './on-base-fixture.js';

/*
 * The Agent Explorer's Service calls route (server/base/explorer/calls.ts): settled Base mainnet
 * calls only, newest first, 15 per page by (time, transaction); searches by transaction, block or
 * address, anything else refused; only onchain-public facts in the answer; cached per server.
 * Synthetic, low-entropy data; nothing real is paid.
 */

const PROVIDER = `0x${'7a'.repeat(20)}`;
const ROUTER = `0x${'8'.repeat(40)}`;
const hex64 = (digit: string, n: number) =>
  `0x${digit.repeat(60)}${n.toString(16).padStart(4, '0')}`;
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';
function callIdOf(n: number): string {
  let out = '';
  for (let i = 0, rest = n; i < 20; i++, rest = Math.floor(rest / 32))
    out = BASE32[rest % 32] + out;
  return `fc_${out}`;
}

/** The On Base fixture (base_wallets) plus Feed pay (112, 114, 115, 123), 120 and the counter (125). */
async function setup(t: test.TestContext) {
  const db = await baseSetup(t);
  for (const sql of [
    FEED_PAY_SQL,
    FEED_PAY_FEE_SQL,
    PROTOCOL_SCREENING_SQL,
    FEED_PAY_INCLUDED_SQL,
    FEED_PAY_PAID_INDEX_SQL,
    PAID_CALL_COUNT_SQL,
  ])
    await db.exec(sql);
  await add(db, { n: 1, kind: 'final', id: 101 });
  await add(db, { n: 2, kind: 'final', id: 102 });
  await add(db, { n: 3, kind: 'final', id: 103, chainId: 84532 });
  return db;
}

interface Call {
  from?: number;
  chainId?: number;
  payment?: string | null;
  tx?: string | null;
  at?: number;
  block?: number;
  amount?: number;
  kind?: 'x402' | 'included';
  fee?: { raw: number; state: string; tx?: string | null };
  title?: string;
  service?: string;
  payTo?: string;
}

let seq = 0;
/** One feed_pay_calls row as the engine leaves it; private columns hold recognisable markers. */
async function call(db: Database, c: Call = {}) {
  seq += 1;
  const payment = c.payment === undefined ? 'settled' : c.payment;
  const tx = c.tx === undefined ? (payment === 'settled' ? hex64('9', seq) : null) : c.tx;
  const settled = payment === 'settled';
  await db.query(
    `INSERT INTO feed_pay_calls (call_id, origin, scope, idempotency_key, request_hash, caller_id,
       actor, owner_account_id, operator_id, agent_id, agent_name, wallet_id, chain_id, service_id,
       service_title, host, method, request_url, request_body, max_amount_raw, permission_id,
       payment_id, amount_raw, pay_to, x402_version, requirements, validity_s, state,
       payment_state, tx_hash, settled_block, settled_at, created_at, updated_at, fee_raw,
       fee_state, fee_tx_hash, fee_router, pay_kind)
     VALUES ($1, 'feed', 'scope-secret', $2, $2, 'caller-secret', 'actor-secret', 'acct-secret',
       'ws', $3, 'Agent Secret Name', $4, $5, $6, $7, 'host-secret.example', 'POST',
       'https://host-secret.example/q?secret=1', 'body-secret', 100000, 'perm-secret', $8, $9,
       $10, 2, '{}'::jsonb, 60, $11, $12, $13, $14, $15, $16, $16, $17, $18, $19, $20, $21)`,
    [
      callIdOf(seq),
      `${seq.toString(16).padStart(4, '0')}${'a'.repeat(60)}`,
      `agent-${c.from ?? 1}`,
      `w-${c.from ?? 1}`,
      c.chainId ?? 8453,
      c.service ?? `svc_${'a'.repeat(19)}${seq % 10}`,
      c.title ?? 'Page reader, fast',
      `pay-call-${seq}`,
      c.amount ?? 45000,
      c.payTo ?? PROVIDER,
      settled ? 'result_saved' : 'calling',
      payment,
      tx,
      settled ? (c.block ?? 52_000_000 + seq) : null,
      settled ? (c.at ?? NOW - seq * 1000) : null,
      NOW - 30 * MIN,
      c.fee?.raw ?? 0,
      c.fee?.state ?? null,
      c.fee ? (c.fee.tx === undefined ? tx : c.fee.tx) : null,
      c.fee ? ROUTER : null,
      c.kind ?? 'x402',
    ],
  );
  return { tx };
}

function routes(
  t: test.TestContext,
  db: Database,
  options: { now?: () => number; query?: Database['query'] } = {},
) {
  const app = Fastify();
  t.after(() => app.close());
  const wrapped: Database = options.query ? { ...db, query: options.query } : db;
  registerServiceCallsRoutes(app, { db: wrapped, now: options.now ?? (() => NOW) });
  return app;
}

const get = (app: ReturnType<typeof Fastify>, query = '') =>
  app.inject({ method: 'GET', url: `${SERVICE_CALLS_PATH}${query}` });

/** Every key anywhere in a JSON value. */
function keysOf(value: unknown, into = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const item of value) keysOf(item, into);
  else if (value && typeof value === 'object')
    for (const [key, inner] of Object.entries(value)) {
      into.add(key);
      keysOf(inner, into);
    }
  return into;
}

test('settled Base mainnet calls only, newest first, one row per call, with the public facts', async (t) => {
  const db = await setup(t);
  const latest = await call(db, {
    at: NOW - 1000,
    kind: 'included',
    amount: 45000,
    fee: { raw: 5000, state: 'charged' },
  });
  const onTop = await call(db, {
    at: NOW - 2000,
    from: 2,
    amount: 10000,
    fee: { raw: 1000, state: 'charged', tx: hex64('b', 1) },
  });
  const noFee = await call(db, { at: NOW - 3000, fee: { raw: 1000, state: 'pending', tx: null } });
  // Not listed: other chains, payments not settled, no transaction.
  await call(db, { at: NOW - 500, from: 3, chainId: 84532 });
  await call(db, { payment: 'sent' });
  await call(db, { payment: 'cancelled', tx: null });
  await call(db, { at: NOW - 400, tx: null });

  const response = await get(routes(t, db));
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['cache-control'], SERVICE_CALLS_LIVE);
  assert.equal(response.headers['vercel-cdn-cache-control'], SERVICE_CALLS_LIVE_EDGE);
  const body = response.json() as ServiceCallsPage;
  assert.deepEqual(
    body.items.map((item) => item.tx_hash),
    [latest.tx, onTop.tx, noFee.tx],
  );
  const [included, top, plain] = body.items;
  // Included: the price is both legs, moved in one transaction.
  assert.equal(included!.amount, '0.05');
  assert.equal(included!.provider_amount, '0.045');
  assert.deepEqual(included!.fee, {
    model: 'included',
    amount: '0.005',
    tx_hash: latest.tx,
    block: included!.block,
  });
  assert.equal(included!.payer, spender(1));
  assert.equal(included!.provider.toLowerCase(), PROVIDER);
  assert.equal(included!.service, 'Page reader, fast');
  assert.equal(included!.status, 'settled');
  assert.equal(included!.time, NOW - 1000);
  // On top: this transaction moved the price; the fee moved in its own one.
  assert.equal(top!.amount, '0.01');
  assert.deepEqual(top!.fee, {
    model: 'on_top',
    amount: '0.001',
    tx_hash: hex64('b', 1),
    block: null,
  });
  assert.equal(top!.payer, spender(2));
  // A fee not on Base (pending) is not shown.
  assert.equal(plain!.fee, null);
  assert.equal(body.next_cursor, null);
  assert.equal(body.matches, null);
  // The counter row (its trigger counts every settled call of the chain) and the day's numbers
  // (only calls with their transaction, as listed).
  assert.equal(body.total, 4);
  assert.equal(body.last24h, 3);
  // Value settled (24h): the price buyers paid for those calls (amount + fee), in raw USDC units.
  assert.match(body.value24hRaw ?? '', /^[1-9]\d*$/);
  assert.equal(typeof body.perMinute, 'number');
  assert.equal(typeof body.services24h, 'number');
  assert.ok(!Number.isNaN(Date.parse(body.as_of)));
});

test('privacy: no agent, account, caller, request or internal id ever reaches the answer', async (t) => {
  const db = await setup(t);
  await call(db, { kind: 'included', fee: { raw: 5000, state: 'charged' } });
  await call(db, { fee: { raw: 1000, state: 'charged', tx: hex64('b', 2) } });
  const response = await get(routes(t, db));
  const body = response.json() as ServiceCallsPage;
  assert.equal(body.items.length, 2);
  const keys = keysOf(body);
  for (const key of [
    'agent_name',
    'agent_id',
    'owner_account_id',
    'caller_id',
    'operator_id',
    'request_url',
    'request_body',
    'call_id',
    'permission_id',
    'payment_id',
    'wallet_id',
    'host',
    'scope',
    'actor',
    'service_id',
    'idempotency_key',
    'result_text',
  ])
    assert.ok(!keys.has(key), key);
  assert.deepEqual(
    [...keysOf(body.items[0])].sort(),
    [
      'amount',
      'block',
      'fee',
      'model',
      'payer',
      'provider',
      'provider_amount',
      'service',
      'status',
      'time',
      'tx_hash',
    ].sort(),
  );
  // None of the private markers, anywhere in the text.
  assert.doesNotMatch(response.body, /secret|Agent Secret|fc_|w-1|agent-1|perm-|pay-call/i);
});

test('pages of 15 by (time, transaction), newest first, with no row twice or skipped', async (t) => {
  const db = await setup(t);
  const all: string[] = [];
  // 40 calls; some share a time (ordered by transaction then).
  for (let i = 0; i < 40; i++) {
    const { tx } = await call(db, { at: NOW - Math.floor(i / 3) * 1000 });
    all.push(tx!);
  }
  const app = routes(t, db);
  const seen: string[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const response = await get(app, cursor ? `?cursor=${cursor}` : '');
    assert.equal(response.statusCode, 200);
    const body = response.json() as ServiceCallsPage;
    assert.ok(body.items.length <= SERVICE_CALLS_PAGE_SIZE);
    seen.push(...body.items.map((item) => item.tx_hash));
    cursor = body.next_cursor;
    pages++;
  } while (cursor && pages < 10);
  assert.equal(pages, 3);
  assert.equal(seen.length, 40);
  assert.equal(new Set(seen).size, 40);
  const expected = [...all]
    .map((tx, i) => ({ tx, at: NOW - Math.floor(i / 3) * 1000 }))
    .sort((a, b) => b.at - a.at || (a.tx < b.tx ? 1 : -1))
    .map((row) => row.tx);
  assert.deepEqual(seen, expected);
});

test('the newest page is bounded by the counter, and read again without it when that misses', async (t) => {
  const db = await setup(t);
  for (let i = 0; i < 20; i++) await call(db, { at: NOW - i * 1000 });
  // A payment the counter never saw (its trigger skipped): it must still be listed.
  await db.query('ALTER TABLE feed_pay_calls DISABLE TRIGGER USER');
  const hidden = await call(db, { at: NOW - 500 });
  await db.query('ALTER TABLE feed_pay_calls ENABLE TRIGGER USER');
  const statements: string[] = [];
  const app = routes(t, db, {
    query: async (sql, params) => {
      statements.push(sql);
      return db.query(sql, params);
    },
  });
  const body = (await get(app)).json() as ServiceCallsPage;
  assert.equal(body.items.length, SERVICE_CALLS_PAGE_SIZE);
  assert.equal(body.items[1]!.tx_hash, hidden.tx);
  assert.ok(body.next_cursor);

  // Rows that left 'settled' after the counter kept their time: the bound finds too few rows, and
  // the page is read again without it.
  await db.query(
    `UPDATE feed_pay_calls SET payment_state = 'cancelled'
     WHERE tx_hash IN (SELECT tx_hash FROM feed_pay_calls ORDER BY settled_at DESC LIMIT 10)`,
  );
  const later = routes(t, db, { now: () => NOW + SERVICE_CALLS_CACHE_MS });
  const again = (await get(later)).json() as ServiceCallsPage;
  assert.equal(again.items.length, 11);
  assert.equal(again.next_cursor, null);
});

test('search: a transaction, a block, or an address as payer or provider', async (t) => {
  const db = await setup(t);
  const target = await call(db, { block: 52_123_456, from: 2 });
  await call(db, { block: 52_123_456 });
  const provider = `0x${'c3'.repeat(20)}`;
  await call(db, { payTo: provider.toUpperCase().replace('0X', '0x') });
  for (let i = 0; i < 5; i++) await call(db);
  const app = routes(t, db);

  const byTx = (await get(app, `?q=${target.tx!.toUpperCase().replace('0X', '0x')}`)).json();
  assert.deepEqual(
    (byTx as ServiceCallsPage).items.map((item) => item.tx_hash),
    [target.tx],
  );
  assert.equal((byTx as ServiceCallsPage).matches, 1);

  const byBlock = (await get(app, '?q=52123456')).json() as ServiceCallsPage;
  assert.equal(byBlock.items.length, 2);
  assert.equal(byBlock.matches, 2);

  const byPayer = (await get(app, `?q=${spender(2)}`)).json() as ServiceCallsPage;
  assert.deepEqual(
    byPayer.items.map((item) => item.tx_hash),
    [target.tx],
  );
  const byProvider = (await get(app, `?q=${provider}`)).json() as ServiceCallsPage;
  assert.equal(byProvider.items.length, 1);
  assert.equal(byProvider.items[0]!.provider.toLowerCase(), provider);

  const none = (await get(app, `?q=0x${'0'.repeat(64)}`)).json() as ServiceCallsPage;
  assert.deepEqual(none.items, []);
  assert.equal(none.matches, 0);
  assert.equal(none.next_cursor, null);
});

test('anything else is refused with 400 and never cached', async (t) => {
  const db = await setup(t);
  const app = routes(t, db);
  for (const query of [
    '?q=Page%20reader',
    '?q=agent',
    '?q=0x1234',
    `?q=0x${'g'.repeat(64)}`,
    `?q=0x${'a'.repeat(65)}`,
    '?q=-5',
    '?q=1.5',
    '?q=01',
    "?q=1'%20OR%201=1",
    `?q=${'1'.repeat(17)}`,
    '?cursor=abc',
    `?cursor=1_0x${'a'.repeat(63)}`,
    `?cursor=-1_0x${'a'.repeat(64)}`,
    '?page=2',
    '?limit=100',
  ]) {
    const response = await get(app, query);
    assert.equal(response.statusCode, 400, query);
    assert.equal(response.headers['cache-control'], 'no-store', query);
  }
  assert.deepEqual(parseServiceCallsSearch(' 52123456 '), { kind: 'block', block: 52123456 });
  assert.deepEqual(parseServiceCallsSearch(`0x${'A'.repeat(40)}`), {
    kind: 'address',
    address: `0x${'a'.repeat(40)}`,
  });
  assert.equal(parseServiceCallsSearch(''), null);
});

test('answers are kept per server: one read per page per few seconds, the day less often', async (t) => {
  const db = await setup(t);
  await call(db);
  let clock = NOW;
  const statements: string[] = [];
  const traced: Database = {
    ...db,
    transaction: (action) =>
      db.transaction((tx) =>
        action({
          ...tx,
          query: (sql, params) => {
            statements.push(sql);
            return tx.query(sql, params);
          },
        }),
      ),
  };
  const app = Fastify();
  t.after(() => app.close());
  registerServiceCallsRoutes(app, { db: traced, now: () => clock });
  const pageReads = () => statements.filter((sql) => /ORDER BY c\.settled_at DESC/.test(sql));
  const dayReads = () => statements.filter((sql) => /count\(DISTINCT/.test(sql));
  // Three at once share one read.
  await Promise.all([get(app), get(app), get(app)]);
  assert.equal(pageReads().length, 1);
  assert.equal(dayReads().length, 1);
  clock += SERVICE_CALLS_CACHE_MS - 1;
  await call(db, { at: NOW + 1 });
  // A new call shows only after the cache time.
  assert.equal(((await get(app)).json() as ServiceCallsPage).items.length, 1);
  assert.equal(pageReads().length, 1);
  clock = NOW + SERVICE_CALLS_CACHE_MS;
  const later = (await get(app)).json() as ServiceCallsPage;
  assert.equal(later.items.length, 2);
  assert.equal(pageReads().length, 2);
  // The day's numbers are kept longer.
  assert.equal(later.last24h, 1);
  assert.equal(dayReads().length, 1);
  clock = NOW + DAY_TTL_MS;
  assert.equal(((await get(app)).json() as ServiceCallsPage).last24h, 2);
  assert.equal(dayReads().length, 2);
});

test('every read is read-only and time-limited; a failing table answers 503, not stored', async (t) => {
  const db = await setup(t);
  await call(db);
  const seen: string[] = [];
  const traced: Database = {
    ...db,
    transaction: (action) =>
      db.transaction((tx) =>
        action({
          ...tx,
          query: (sql, params) => {
            seen.push(sql);
            return tx.query(sql, params);
          },
        }),
      ),
  };
  const app = Fastify();
  t.after(() => app.close());
  registerServiceCallsRoutes(app, { db: traced, now: () => NOW });
  assert.equal((await get(app)).statusCode, 200);
  const starts = seen.filter((sql) => sql === 'SET TRANSACTION READ ONLY').length;
  assert.ok(starts >= 2, 'the page and the day each run read-only');
  assert.equal(
    seen.filter((sql) => /^SET LOCAL statement_timeout = \d+$/.test(sql)).length,
    starts,
  );
  assert.ok(seen.every((sql) => !/\b(INSERT|UPDATE|DELETE)\b/i.test(sql)));

  const broken = await setup(t);
  await broken.exec('DROP TABLE feed_pay_calls CASCADE');
  const down = Fastify();
  t.after(() => down.close());
  registerServiceCallsRoutes(down, { db: broken, now: () => NOW });
  const failed = await get(down);
  assert.equal(failed.statusCode, 503);
  assert.equal(failed.headers['cache-control'], 'no-store');
});

test('publicCall builds only the public fields', () => {
  const row = publicCall({
    tx_hash: hex64('9', 7),
    settled_block: '52000007',
    settled_at: String(NOW),
    payer: `0x${'ab'.repeat(20)}`,
    pay_to: PROVIDER,
    service_title: 'Translate text',
    amount_raw: '9000',
    fee_raw: '1000',
    fee_state: 'failed',
    fee_tx_hash: hex64('9', 7),
    fee_block: '52000007',
    pay_kind: 'included',
  });
  assert.equal(row.amount, '0.01');
  assert.equal(row.provider_amount, '0.009');
  assert.equal(row.fee, null, 'a fee that did not move as charged is not shown');
  assert.equal(row.block, 52000007);
});

test('an older page more than an hour behind its cursor is still found', async (t) => {
  const db = await setup(t);
  // 16 recent calls, then 5 from two days ago: page 2 lies outside the cursor's first window.
  for (let i = 0; i < 16; i++) await call(db, { at: NOW - i * 1000 });
  for (let i = 0; i < 5; i++) await call(db, { at: NOW - 2 * 24 * 60 * MIN - i * 1000 });
  const app = routes(t, db);
  const first = (await get(app)).json() as ServiceCallsPage;
  assert.equal(first.items.length, SERVICE_CALLS_PAGE_SIZE);
  const second = (await get(app, `?cursor=${first.next_cursor}`)).json() as ServiceCallsPage;
  assert.equal(second.items.length, 6);
  assert.equal(second.next_cursor, null);
});

test('one uncached read at a time per server: another page waits on its last answer or gets 503', async (t) => {
  const db = await setup(t);
  await call(db);
  let clock = NOW;
  // Each page read waits for a release, so two reads can be held side by side.
  const gates: Array<() => void> = [];
  const held: Database = {
    ...db,
    transaction: (action) =>
      db.transaction((tx) =>
        action({
          ...tx,
          query: async (sql, params) => {
            if (/ORDER BY c\.settled_at DESC/.test(sql))
              await new Promise<void>((resolve) => gates.push(resolve));
            return tx.query(sql, params);
          },
        }),
      ),
  };
  const app = Fastify();
  t.after(() => app.close());
  registerServiceCallsRoutes(app, { db: held, now: () => clock });
  const tx = `0x${'9'.repeat(64)}`;
  // A search holds the slot; the newest page has no earlier answer, so it is busy.
  const first = get(app, `?q=${tx}`);
  while (gates.length === 0) await new Promise((resolve) => setImmediate(resolve));
  const busy = await get(app);
  assert.equal(busy.statusCode, 503);
  assert.equal(busy.headers['cache-control'], 'no-store');
  assert.equal(busy.headers['retry-after'], '5');
  assert.equal((busy.json() as { code: string }).code, 'busy');
  gates.splice(0).forEach((open) => open());
  assert.equal((await first).statusCode, 200);
  // Now the newest page reads and is kept; later, with the slot taken, its last answer is served.
  const page = get(app);
  while (gates.length === 0) await new Promise((resolve) => setImmediate(resolve));
  gates.splice(0).forEach((open) => open());
  assert.equal((await page).statusCode, 200);
  clock += SERVICE_CALLS_CACHE_MS;
  const again = get(app, `?q=${tx}`);
  while (gates.length === 0) await new Promise((resolve) => setImmediate(resolve));
  const served = await get(app);
  assert.equal(served.statusCode, 200);
  assert.equal((served.json() as ServiceCallsPage).items.length, 1);
  gates.splice(0).forEach((open) => open());
  await again;
});

test('a stalled counter row never holds the answer', async (t) => {
  const db = await setup(t);
  await call(db);
  const app = Fastify();
  t.after(() => app.close());
  registerServiceCallsRoutes(app, {
    db,
    now: () => NOW,
    counter: { read: () => new Promise(() => undefined), lastGood: () => null },
  });
  const started = Date.now();
  const res = await get(app);
  assert.equal(res.statusCode, 200);
  const body = res.json() as ServiceCallsPage;
  assert.equal(body.total, null);
  assert.equal(body.perMinute, null);
  assert.equal(body.items.length, 1);
  assert.ok(Date.now() - started < COUNTER_READ_BUDGET_MS * 4 + 2000);
});

test('searches share one budget across every client', async (t) => {
  const db = await setup(t);
  await call(db);
  const hits: Array<[string, number, number]> = [];
  const app = Fastify();
  t.after(() => app.close());
  registerServiceCallsRoutes(app, {
    db,
    now: () => NOW,
    limit: async (key, max, windowMs) => {
      hits.push([key, max, windowMs]);
    },
  });
  await get(app);
  assert.ok(!hits.some(([key]) => key.startsWith('explorer-calls-search')));
  await get(app, `?q=${`0x${'9'.repeat(64)}`}`);
  assert.deepEqual(
    hits.find(([key]) => key.startsWith('explorer-calls-search')),
    [
      'explorer-calls-search:all',
      SERVICE_CALLS_SEARCH_GLOBAL.max,
      SERVICE_CALLS_SEARCH_GLOBAL.windowMs,
    ],
  );
});
