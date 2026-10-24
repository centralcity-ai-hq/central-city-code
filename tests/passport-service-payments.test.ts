import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { listMigrations } from '../server/migrations.js';
import type { Database } from '../server/database.js';
import { ON_BASE_LIVE, registerOnBaseRoutes } from '../server/base/explorer/routes.js';
import { FEED_PAY_SQL } from '../server/feed/pay/schema.js';
import { FEED_PAY_FEE_SQL } from '../server/feed/pay/fee-schema.js';
import { FEED_PAY_INCLUDED_SQL } from '../server/feed/pay/included-schema.js';
import {
  FEED_PAY_PAID_INDEX_SQL,
  feedPayPaidIndexMigration,
  registerFeedPayPaidIndexMigration,
} from '../server/feed/pay/paid-index-schema.js';
import { PROTOCOL_SCREENING_SQL } from '../server/protocol/screening/schema.js';
import {
  EARNINGS_PATHS,
  SERVICE_PAYMENTS_PATHS,
  type PassportServicePayments,
} from '../shared/directory.js';
import { BASE_NETWORKS } from '../shared/base/chains.js';
import { PROTOCOL_BASE_MAINNET } from '../shared/protocol.js';
import { AGENT_URI_ORIGIN } from '../shared/base/on-base.js';
import { MIN, NOW, add, agentId, setup as baseSetup, shortOf } from './on-base-fixture.js';
import { setup as appSetup } from './helpers/feed-pay-app.js';
import { FEED_PAY_SPONSORED_SQL } from '../server/feed/pay/sponsored.js';

/*
 * The passport's "Paid for services": the totals of the agent's paid service calls (Feed pay), by
 * passport, under the earnings' listing rule. A call counts once its payment is confirmed on Base
 * (settled, with its transaction), with or without a result; its Central City fee only once the
 * fee's own transaction is final. Totals only: nothing of a call reaches the answer. Synthetic,
 * low-entropy data; the last test drives real calls through the engine against the fake service
 * and fake Base (tests/helpers/feed-pay-app.ts). Nothing real is paid.
 */

const PATH = (short: string) => SERVICE_PAYMENTS_PATHS.passport.replace(':short', short);
const EARNINGS = (short: string) => EARNINGS_PATHS.passport.replace(':short', short);
const ZERO: PassportServicePayments = {
  paidCalls: 0,
  totalUsdc: '0',
  totalFeeUsdc: '0',
  lastPaidAt: null,
};
const HOST = 'paid-host-0001.example';
const ROUTER = `0x${'8'.repeat(40)}`;

/** The On Base fixture plus the Feed pay tables (112, 114, 115, 123) and the index (120). */
async function setup(t: test.TestContext) {
  const db = await baseSetup(t);
  for (const sql of [
    FEED_PAY_SQL,
    FEED_PAY_FEE_SQL,
    PROTOCOL_SCREENING_SQL,
    FEED_PAY_INCLUDED_SQL,
    FEED_PAY_PAID_INDEX_SQL,
  ])
    await db.exec(sql);
  return db;
}

function routes(t: test.TestContext, db: Database) {
  const app = Fastify();
  t.after(() => app.close());
  registerOnBaseRoutes(app, { db, now: () => NOW });
  return app;
}

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';
/** 'fc_' + 20 base32 characters, from a counter (the table's own id format). */
function callIdOf(n: number): string {
  let out = '';
  for (let i = 0, rest = n; i < 20; i++, rest = Math.floor(rest / 32))
    out = BASE32[rest % 32] + out;
  return `fc_${out}`;
}
const hex64 = (digit: string, n: number) =>
  `0x${digit.repeat(60)}${n.toString(16).padStart(4, '0')}`;

interface Call {
  /** The paying fixture: its wallet w-<n> and its agent. */
  from: number;
  /** Another of its wallets (another chain), when set. */
  walletId?: string;
  chainId?: number;
  amount: number;
  state?: string;
  payment?: string | null;
  /** The payment's transaction; true by default once settled. */
  tx?: boolean;
  settledAt?: number | null;
  fee?: { raw: number; state: string; tx?: boolean };
}

let seq = 0;
/** One feed_pay_calls row as the engine leaves it (server/feed/pay/engine.ts). */
async function call(db: Database, c: Call) {
  seq += 1;
  const id = callIdOf(seq);
  const payment = c.payment === undefined ? 'settled' : c.payment;
  const tx = payment === 'settled' && c.tx !== false ? hex64('9', seq) : null;
  const settledAt =
    c.settledAt === undefined ? (payment === 'settled' ? NOW - 20 * MIN : null) : c.settledAt;
  await db.query(
    `INSERT INTO feed_pay_calls (call_id, origin, scope, idempotency_key, request_hash, caller_id,
       actor, owner_account_id, operator_id, agent_id, agent_name, wallet_id, chain_id, service_id,
       service_title, host, method, request_url, request_body, max_amount_raw, permission_id,
       payment_id, amount_raw, pay_to, x402_version, requirements, validity_s, state,
       payment_state, failure_code, tx_hash, settled_block, settled_at, result_text,
       result_received_at, created_at, updated_at, fee_raw, fee_state, fee_tx_hash, fee_router)
     VALUES ($1, 'feed', 'scope-0001', $2, $2, 'caller-0001', 'owner acct-0001', 'acct-0001', 'ws',
       $3, 'Agent', $4, $5, 'svc_aaaaaaaaaaaaaaaaaaaa', 'Service title 0001', $6, 'POST',
       $7, 'input-0001', 100000, 'perm-0001', $8, $9, $10, 2, '{}'::jsonb, 60, $11, $12, $13,
       $14, $15, $16, 'result-0001', $16, $17, $17, $18, $19, $20, $21)`,
    [
      id,
      `${seq.toString(16).padStart(4, '0')}${'a'.repeat(60)}`,
      agentId(c.from),
      c.walletId ?? `w-${c.from}`,
      c.chainId ?? 8453,
      HOST,
      `https://${HOST}/api/q?input=0001`,
      `pay-call-${seq}`,
      c.amount,
      `0x${'7a'.repeat(20)}`,
      c.state ?? (payment === 'settled' ? 'result_saved' : 'calling'),
      payment,
      c.state === 'paid_no_result' ? 'no_result' : null,
      tx,
      tx ? 3000 + seq : null,
      settledAt,
      NOW - 30 * MIN,
      c.fee?.raw ?? 0,
      c.fee?.state ?? null,
      c.fee && c.fee.tx !== false && c.fee.state !== 'pending' ? hex64('b', seq) : null,
      c.fee ? ROUTER : null,
    ],
  );
  return { id, tx };
}

async function read(app: ReturnType<typeof routes>, short: string) {
  const response = await app.inject({ url: PATH(short) });
  assert.equal(response.statusCode, 200, response.body);
  return response.json() as PassportServicePayments;
}

test('only payments confirmed on Base count, also without a result; a fee only once its own transaction is final', async (t) => {
  const db = await setup(t);
  await add(db, { n: 1, kind: 'final', id: 120, name: 'Harbor' });
  await add(db, { n: 2, kind: 'final', id: 121, name: 'Other' });
  // The same agent's wallet on Base Sepolia: never this passport's.
  await db.query(
    `INSERT INTO base_wallets (wallet_id, agent_id, operator_id, chain_id, address, owner_address,
       spender_address, spender_key_ref, derivation, state, created_at, updated_at)
     VALUES ('w-1s', $1, 'ws', 84532, $2, $3, $4, 'v1:key-0001', '{}', 'derived', 1, 1)`,
    [agentId(1), `0x${'c'.repeat(40)}`, `0x${'d'.repeat(40)}`, `0x${'e'.repeat(40)}`],
  );
  // Counted: settled on Base with its transaction.
  await call(db, { from: 1, amount: 20_000, fee: { raw: 2_000, state: 'charged' } });
  await call(db, {
    from: 1,
    amount: 5_000,
    state: 'paid_no_result',
    settledAt: NOW - 2 * MIN,
    fee: { raw: 500, state: 'charged' },
  });
  // Counted, but not their fee: on its way, owed, failed, or charged without its transaction.
  await call(db, { from: 1, amount: 3_000, fee: { raw: 300, state: 'sent' } });
  await call(db, { from: 1, amount: 1_000, fee: { raw: 100, state: 'pending' } });
  await call(db, { from: 1, amount: 7_000, fee: { raw: 700, state: 'failed' } });
  await call(db, { from: 1, amount: 4_000, fee: { raw: 400, state: 'charged', tx: false } });
  // Counted, made while fees were off: no fee.
  await call(db, { from: 1, amount: 2_000 });
  // Never counted: not settled (on its way, signed, cancelled, expired, never signed), settled
  // with no transaction known, another agent's call, the same agent's wallet on another chain.
  await call(db, { from: 1, amount: 50_000, payment: 'sent' });
  await call(db, { from: 1, amount: 50_000, payment: 'signed' });
  await call(db, { from: 1, amount: 50_000, payment: 'cancelled', state: 'cancelled' });
  await call(db, { from: 1, amount: 50_000, payment: 'expired', state: 'expired' });
  await call(db, { from: 1, amount: 50_000, payment: null, state: 'refused' });
  await call(db, { from: 1, amount: 50_000, tx: false, settledAt: NOW - MIN });
  await call(db, {
    from: 2,
    amount: 50_000,
    settledAt: NOW - MIN,
    fee: { raw: 5_000, state: 'charged' },
  });
  await call(db, {
    from: 1,
    walletId: 'w-1s',
    chainId: 84532,
    amount: 50_000,
    settledAt: NOW - MIN,
    fee: { raw: 5_000, state: 'charged' },
  });

  const app = routes(t, db);
  assert.deepEqual(await read(app, shortOf(1)), {
    paidCalls: 7,
    totalUsdc: '0.042',
    totalFeeUsdc: '0.0025',
    lastPaidAt: NOW - 2 * MIN,
  });
  // The other agent's passport shows only its own.
  assert.deepEqual(await read(app, shortOf(2)), {
    paidCalls: 1,
    totalUsdc: '0.05',
    totalFeeUsdc: '0.005',
    lastPaidAt: NOW - MIN,
  });
});

test('a call shows only once Base confirms its payment, and its fee only once the fee is final', async (t) => {
  const db = await setup(t);
  await add(db, { n: 1, kind: 'final', id: 120, name: 'Harbor' });
  const app = routes(t, db);
  const { id } = await call(db, {
    from: 1,
    amount: 20_000,
    payment: 'signed',
    fee: { raw: 2_000, state: 'pending' },
  });
  assert.deepEqual(await read(app, shortOf(1)), ZERO);
  await db.query(`UPDATE feed_pay_calls SET payment_state = 'sent' WHERE call_id = $1`, [id]);
  assert.deepEqual(await read(app, shortOf(1)), ZERO);
  // Settled on Base with its transaction (as stepReconcile writes it); the fee is still owed.
  await db.query(
    `UPDATE feed_pay_calls SET payment_state = 'settled', state = 'result_saved', tx_hash = $2,
       settled_block = 3001, settled_at = $3 WHERE call_id = $1`,
    [id, hex64('9', 9001), NOW - 3 * MIN],
  );
  const owed = { paidCalls: 1, totalUsdc: '0.02', totalFeeUsdc: '0', lastPaidAt: NOW - 3 * MIN };
  assert.deepEqual(await read(app, shortOf(1)), owed);
  // The fee's operation on its way: still not counted.
  await db.query(`UPDATE feed_pay_calls SET fee_state = 'sent' WHERE call_id = $1`, [id]);
  assert.deepEqual(await read(app, shortOf(1)), owed);
  // Final on Base without a revert, with its transaction (stepFee): counted.
  await db.query(
    `UPDATE feed_pay_calls SET fee_state = 'charged', fee_tx_hash = $2, fee_block = 3002
     WHERE call_id = $1`,
    [id, hex64('b', 9001)],
  );
  assert.deepEqual(await read(app, shortOf(1)), { ...owed, totalFeeUsdc: '0.002' });
});

test('a fee-included call: its total is the whole price; its fee counts once the payment is final', async (t) => {
  const db = await setup(t);
  await add(db, { n: 1, kind: 'final', id: 120, name: 'Harbor' });
  const app = routes(t, db);
  // A 0.05 offer: the seller's 90% (amount_raw) and the 10% fee (fee_raw), charged in the payment's
  // own transaction, so fee_state is 'charged' at inclusion (server/feed/pay/engine.ts).
  const { id, tx } = await call(db, {
    from: 1,
    amount: 45_000,
    fee: { raw: 5_000, state: 'charged' },
  });
  await db.query(
    `UPDATE feed_pay_calls SET pay_kind = 'included', fee_tx_hash = $2 WHERE call_id = $1`,
    [id, tx],
  );
  // A fee-on-top call beside it: unchanged.
  await call(db, { from: 1, amount: 20_000, fee: { raw: 2_000, state: 'charged' } });
  const included = {
    paidCalls: 2,
    totalUsdc: '0.07',
    totalFeeUsdc: '0.002',
    lastPaidAt: NOW - 20 * MIN,
  };
  assert.deepEqual(await read(app, shortOf(1)), included, 'in a block, not final yet');
  await db.query('UPDATE feed_pay_calls SET pay_final_at = $2 WHERE call_id = $1', [id, NOW - MIN]);
  assert.deepEqual(await read(app, shortOf(1)), { ...included, totalFeeUsdc: '0.007' });
});

test('an agent that never paid for a service answers zeros, not 404', async (t) => {
  const db = await setup(t);
  await add(db, { n: 1, kind: 'final', id: 120, name: 'Quiet' });
  await add(db, { n: 2, kind: 'final', id: 121, name: 'Waiting' });
  await call(db, { from: 2, amount: 20_000, payment: 'sent' });
  await call(db, { from: 2, amount: 20_000, payment: null, state: 'refused' });
  const app = routes(t, db);
  assert.deepEqual(await read(app, shortOf(1)), ZERO);
  assert.deepEqual(await read(app, shortOf(2)), ZERO);
});

test('the listing rule is the earnings rule: every passport answers both routes the same way', async (t) => {
  const db = await setup(t);
  await add(db, { n: 1, kind: 'final', id: 120, name: 'Public' });
  await add(db, { n: 2, kind: 'final', id: 121, name: 'Private card', visibility: 'private' });
  await add(db, { n: 3, kind: 'final', id: 122, name: 'Revoked', revoked: true });
  await add(db, { n: 4, kind: 'finalizing', id: 123 });
  await add(db, { n: 5, kind: 'pending' });
  await add(db, { n: 6, kind: 'failed' });
  await add(db, { n: 7, kind: 'included', id: 124 });
  await add(db, { n: 8, kind: 'lost', id: 125 });
  await add(db, { n: 9, kind: 'final', id: 126, registry: `0x${'f'.repeat(40)}` });
  await add(db, { n: 10, kind: 'final', id: 127, uri: `${AGENT_URI_ORIGIN}/a/ZZZZZZ` });
  await add(db, { n: 11, kind: 'final', id: 128, chainId: 84532 });
  for (let n = 1; n <= 11; n++) await call(db, { from: n, amount: 10_000 });
  const app = routes(t, db);
  const shorts = [
    ...Array.from({ length: 11 }, (_, i) => shortOf(i + 1)),
    'ZZZZZZ',
    'abc',
    'abc1234',
  ];
  const answered: Record<string, number> = {};
  for (const short of shorts) {
    const earnings = await app.inject({ url: EARNINGS(short) });
    const paid = await app.inject({ url: PATH(short) });
    assert.equal(paid.statusCode, earnings.statusCode, short);
    assert.equal(paid.headers['cache-control'], earnings.headers['cache-control'], short);
    if (earnings.statusCode !== 200) assert.equal(paid.body, earnings.body, short);
    answered[short] = paid.statusCode;
  }
  // Listed (final, or finalizing at a safe block), public card or not: totals. Anything else: 404.
  assert.deepEqual(answered, {
    [shortOf(1)]: 200,
    [shortOf(2)]: 200,
    [shortOf(3)]: 200,
    [shortOf(4)]: 200,
    [shortOf(5)]: 404,
    [shortOf(6)]: 404,
    [shortOf(7)]: 404,
    [shortOf(8)]: 404,
    [shortOf(9)]: 404,
    [shortOf(10)]: 404,
    [shortOf(11)]: 404,
    ZZZZZZ: 404,
    abc: 404,
    abc1234: 404,
  });
  // A private card's passport: the same totals any passport shows, never more.
  assert.deepEqual(await read(app, shortOf(2)), {
    paidCalls: 1,
    totalUsdc: '0.01',
    totalFeeUsdc: '0',
    lastPaidAt: NOW - 20 * MIN,
  });
  const notFound = await app.inject({ url: PATH(shortOf(5)) });
  assert.equal(notFound.json().code, 'not_found');
  // Like earnings, the address takes no query (each would be its own cache entry).
  for (const url of [`${PATH(shortOf(1))}?x=1`, `${EARNINGS(shortOf(1))}?x=1`])
    assert.equal((await app.inject({ url })).statusCode, 400, url);
});

test('totals only: no call id, host, transaction, input, result, error or caller; cached at most 15 s', async (t) => {
  const db = await setup(t);
  await add(db, { n: 1, kind: 'final', id: 120, name: 'Harbor' });
  const paid = await call(db, { from: 1, amount: 20_000, fee: { raw: 2_000, state: 'charged' } });
  const empty = await call(db, { from: 1, amount: 5_000, state: 'paid_no_result' });
  const app = routes(t, db);
  const response = await app.inject({ url: PATH(shortOf(1)) });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(Object.keys(response.json()).sort(), [
    'lastPaidAt',
    'paidCalls',
    'totalFeeUsdc',
    'totalUsdc',
  ]);
  for (const secret of [
    paid.id,
    empty.id,
    paid.tx!,
    empty.tx!,
    HOST,
    'input-0001',
    'result-0001',
    'no_result',
    'svc_',
    'Service title',
    'caller-0001',
    'owner acct-0001',
    'acct-0001',
    'pay-call-',
    '7a7a7a',
    agentId(1),
    'w-1',
  ])
    assert.ok(!response.body.includes(secret), `the answer names ${secret}`);
  // The neighbouring public routes' cache: browsers revalidate; the edge 10 s fresh + 5 s stale.
  assert.equal(response.headers['cache-control'], ON_BASE_LIVE);
  const cache = String(response.headers['cache-control']);
  const seconds = (name: string) => Number(new RegExp(`${name}=(\\d+)`).exec(cache)?.[1] ?? 0);
  assert.equal(seconds('max-age'), 0);
  assert.ok(seconds('s-maxage') + seconds('stale-while-revalidate') <= 15, cache);
  assert.equal(
    response.headers['vercel-cdn-cache-control'],
    'public, max-age=10, stale-while-revalidate=5',
  );
});

test('migration 120: only the partial index, idempotent, and the totals read through it', async (t) => {
  registerFeedPayPaidIndexMigration();
  const registered = listMigrations().find((m) => m.version === 120);
  assert.equal(registered?.name, 'feed_pay_calls_paid');
  assert.equal(registered?.sql, FEED_PAY_PAID_INDEX_SQL);
  assert.equal(feedPayPaidIndexMigration.sql, FEED_PAY_PAID_INDEX_SQL);
  // One statement, an index only: no data change, no table rewrite, no CONCURRENTLY (it runs in
  // the migration transaction, server/migrations.ts).
  assert.match(
    FEED_PAY_PAID_INDEX_SQL,
    /^\s*CREATE INDEX IF NOT EXISTS feed_pay_calls_paid ON feed_pay_calls/,
  );
  assert.equal(
    FEED_PAY_PAID_INDEX_SQL.trim()
      .split(';')
      .filter((s) => s.trim()).length,
    1,
  );
  assert.doesNotMatch(
    FEED_PAY_PAID_INDEX_SQL,
    /DROP|DELETE|TRUNCATE|UPDATE|INSERT|ALTER|CONCURRENTLY/i,
  );

  const db = await setup(t);
  await db.exec(FEED_PAY_PAID_INDEX_SQL);
  await add(db, { n: 1, kind: 'final', id: 120, name: 'Harbor' });
  for (let i = 0; i < 4; i++) await call(db, { from: 1, amount: 1_000 });
  // The route's own query, captured, then explained with its own parameters.
  const seen: { sql: string; params: unknown[] }[] = [];
  const spy: Database = {
    ...db,
    query: ((sql: string, params?: unknown[]) => {
      seen.push({ sql, params: params ?? [] });
      return db.query(sql, params);
    }) as Database['query'],
  };
  const app = Fastify();
  t.after(() => app.close());
  registerOnBaseRoutes(app, { db: spy, now: () => NOW });
  assert.equal((await app.inject({ url: PATH(shortOf(1)) })).statusCode, 200);
  const totals = seen.find((q) => q.sql.includes('feed_pay_calls'));
  assert.ok(totals, 'the route reads feed_pay_calls');
  assert.equal(seen.filter((q) => q.sql.includes('feed_pay_calls')).length, 1, 'one query');
  await db.exec('SET enable_seqscan = off');
  const plan = (
    await db.query<{ 'QUERY PLAN': string }>(`EXPLAIN ${totals.sql}`, totals.params)
  ).rows
    .map((row) => row['QUERY PLAN'])
    .join('\n');
  await db.exec('RESET enable_seqscan');
  assert.match(plan, /feed_pay_calls_paid/, plan);
});

test('a real paid call through the engine shows on the passport, fee included once charged', async (t) => {
  const f = await appSetup(t, { env: { CITY_PROTOCOL_FEES: undefined } });
  f.base.state.feeRouter = {
    router: PROTOCOL_BASE_MAINNET.feeRouter,
    treasury: PROTOCOL_BASE_MAINNET.treasury,
  };
  await f.list();
  await f.limit();
  // The agent is a listed Base agent (final Base ID, its passport naming it).
  const short = 'SvcPd1';
  const baseId = 4242;
  await f.sql('INSERT INTO base_short_ids (short_id, agent_id, created_at) VALUES ($1, $2, 1)', [
    short,
    f.agentId,
  ]);
  await f.sql(
    `INSERT INTO base_identities (agent_id, chain_id, operator_id, registry_address,
       erc8004_agent_id, agent_card_uri, owner_of_identity, state, updated_at,
       provisional_agent_id, mint_seen_at, mint_finality, transfer_op_id, handover_id)
     VALUES ($1, 8453, $2, $3, $4, $5, $6, 'confirmed', 1, $4, 1, 'final', $7, $4)`,
    [
      f.agentId,
      f.owner.id,
      BASE_NETWORKS[8453].contracts.identityRegistry,
      baseId,
      `${AGENT_URI_ORIGIN}/a/${short}`,
      f.wallet,
      `identity:transfer:8453:${f.agentId}~${baseId}`,
    ],
  );
  const passport = async () => {
    const response = await f.app.inject({ url: PATH(short) });
    assert.equal(response.statusCode, 200, response.body);
    return response.json() as PassportServicePayments;
  };
  assert.deepEqual(await passport(), ZERO);

  // One call with a result, one paid without (the service failed after it was paid).
  const first = await f.settled((await f.pay()).json().callId);
  assert.equal(first.state, 'result_saved');
  await f.list({ paid: 'settle_then_fail' });
  const second = await f.settled((await f.pay()).json().callId);
  assert.equal(second.state, 'paid_no_result');
  // The cron finishes the fee legs (each after its seller's payment).
  for (let i = 0; i < 6; i++) {
    f.advance(60_000);
    assert.equal((await f.cron()).statusCode, 200);
  }
  const rows = await f.sql<{ settled_at: string; fee_state: string; fee_tx_hash: string | null }>(
    `SELECT settled_at::text AS settled_at, fee_state, fee_tx_hash FROM feed_pay_calls
     WHERE payment_state = 'settled' AND tx_hash IS NOT NULL ORDER BY settled_at`,
  );
  assert.equal(rows.length, 2);
  assert.ok(
    rows.every((row) => row.fee_state === 'charged' && row.fee_tx_hash),
    JSON.stringify(rows),
  );
  assert.deepEqual(await passport(), {
    paidCalls: 2,
    totalUsdc: '0.04',
    totalFeeUsdc: '0.004',
    lastPaidAt: Number(rows.at(-1)!.settled_at),
  });
});

test('a first purchase paid by Central City shows apart from the totals, only once paid', async (t) => {
  const db = await setup(t);
  await db.exec(FEED_PAY_SPONSORED_SQL);
  await add(db, { n: 1, kind: 'final', id: 121, name: 'Harbor' });
  const app = routes(t, db);
  const sponsored = (state: string, at: number) =>
    db.query(
      `INSERT INTO feed_pay_sponsored_calls (call_id, owner_account_id, idempotency_key,
         request_hash, operator_id, agent_id, service_id, offer_id, offer_kind, offer_version,
         pay_to, gross_raw, fee_raw, input, state, op_key, created_at, updated_at)
       VALUES ('sp_aaaaaaaaaaaaaaaaaaaa', 'o', 'k', 'h', 'ws', $1, 's', 'of_1', 'echo', 1,
         $2, 1500000, 150000, '{}', $3, 'sfp:x', $4, $4)
       ON CONFLICT (call_id) DO UPDATE SET state = $3, updated_at = $4`,
      [agentId(1), `0x${'5'.repeat(40)}`, state, at],
    );
  await sponsored('sent', NOW - 2 * MIN);
  assert.deepEqual(await read(app, shortOf(1)), ZERO, 'not paid yet: nothing shows');
  await sponsored('delivered', NOW - MIN);
  assert.deepEqual(await read(app, shortOf(1)), {
    ...ZERO,
    sponsoredFirstPurchase: { priceUsdc: '1.5', paidAt: NOW - MIN },
  });
});
