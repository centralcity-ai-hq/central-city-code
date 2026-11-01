import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import type { Database } from '../server/database.js';
import { registerServiceCallsRoutes, type ListedChainView } from '../server/base/explorer/calls.js';
import { FEED_PAY_SQL } from '../server/feed/pay/schema.js';
import { FEED_PAY_FEE_SQL } from '../server/feed/pay/fee-schema.js';
import { FEED_PAY_INCLUDED_SQL } from '../server/feed/pay/included-schema.js';
import { FEED_PAY_PAID_INDEX_SQL } from '../server/feed/pay/paid-index-schema.js';
import { PAID_CALL_COUNT_SQL } from '../server/feed/pay/count-schema.js';
import { PAID_CALL_VALUE_SQL } from '../server/feed/pay/value-schema.js';
import { PROTOCOL_SCREENING_SQL } from '../server/protocol/screening/schema.js';
import { ARC_MAINNET, chainView, liveChainIds } from '../shared/chains.js';
import { SERVICE_CALLS_PATH, type ServiceCallsPage } from '../shared/explorer-calls.js';
import { chainLinks, chainNames, darkMark } from '../src/verify/serviceCallsData.js';
import { NOW, add, setup as baseSetup, spender } from './on-base-fixture.js';

/*
 * /explorer/calls over every live chain (server/base/explorer/calls.ts, deps.chains): Base and
 * Arc (5042) together, newest first, each other chain's rows marked with its chain_id and named by
 * the registry; Base's answer unchanged while no other chain has a paid call; a third chain shows
 * up from the registry alone. Synthetic, low-entropy data; nothing real is paid.
 */

const PROVIDER = `0x${'7a'.repeat(20)}`;
/** A chain no registry has: proves a new chain needs no change to the route or the page. */
const FAKE = 777_001;
const FAKE_VIEW: ListedChainView = {
  name: 'Fakechain',
  explorerUrl: 'https://scan.fakechain.example',
  mark: '#22aa66',
};
const viewOf = (id: number) => (id === FAKE ? FAKE_VIEW : chainView(id));
const hex64 = (digit: string, n: number) =>
  `0x${digit.repeat(60)}${n.toString(16).padStart(4, '0')}`;

async function setup(t: test.TestContext) {
  const db = await baseSetup(t);
  for (const sql of [
    FEED_PAY_SQL,
    FEED_PAY_FEE_SQL,
    PROTOCOL_SCREENING_SQL,
    FEED_PAY_INCLUDED_SQL,
    FEED_PAY_PAID_INDEX_SQL,
    PAID_CALL_COUNT_SQL,
    PAID_CALL_VALUE_SQL,
  ])
    await db.exec(sql);
  // Arc's (and the fake chain's) wallets: the chain list of base_wallets is not under test here.
  await db.exec('ALTER TABLE base_wallets DROP CONSTRAINT IF EXISTS base_wallets_chain_id_check');
  await add(db, { n: 1, kind: 'final', id: 101 });
  await add(db, { n: 2, kind: 'final', id: 102, chainId: ARC_MAINNET });
  await add(db, { n: 3, kind: 'final', id: 103, chainId: FAKE });
  return db;
}

let seq = 0;
/** One settled feed_pay_calls row on a chain, paid from wallet w-<from>. */
async function call(db: Database, c: { from: number; chainId: number; at: number }) {
  seq += 1;
  const tx = hex64(c.chainId === 8453 ? '9' : c.chainId === ARC_MAINNET ? 'a' : 'f', seq);
  await db.query(
    `INSERT INTO feed_pay_calls (call_id, origin, scope, idempotency_key, request_hash, caller_id,
       actor, owner_account_id, operator_id, agent_id, agent_name, wallet_id, chain_id, service_id,
       service_title, host, method, request_url, request_body, max_amount_raw, permission_id,
       payment_id, amount_raw, pay_to, x402_version, requirements, validity_s, state,
       payment_state, tx_hash, settled_block, settled_at, created_at, updated_at, fee_raw,
       fee_state, fee_tx_hash, fee_router, pay_kind)
     VALUES ($1, 'feed', 's', $2, $2, 'c', 'a', 'acct', 'ws', $3, 'n', $4, $5, 'svc_chains',
       'Page reader', 'h.example', 'POST', 'https://h.example/', NULL, 100000, 'p', $6, 45000,
       $7, 2, '{}'::jsonb, 60, 'result_saved', 'settled', $8, $9, $10, $10, $10, 5000,
       'charged', $8, '0x8888888888888888888888888888888888888888', 'included')`,
    [
      `fc_${String(seq)
        .padStart(20, '0')
        .replace(/\d/g, (d) => 'abcdefghij'[Number(d)]!)}`,
      `${seq.toString(16).padStart(4, '0')}${'b'.repeat(60)}`,
      `agent-${c.from}`,
      `w-${c.from}`,
      c.chainId,
      `pay-${seq}`,
      PROVIDER,
      tx,
      1_000_000 + seq,
      c.at,
    ],
  );
  return tx;
}

function routes(
  t: test.TestContext,
  db: Database,
  chains?: number[],
  query?: Database['transaction'],
) {
  const app = Fastify();
  t.after(() => app.close());
  registerServiceCallsRoutes(app, {
    db: query ? { ...db, transaction: query } : db,
    now: () => NOW,
    chains,
    chainViewOf: viewOf,
  });
  return app;
}
const get = async (app: ReturnType<typeof Fastify>, query = '') =>
  (
    await app.inject({ method: 'GET', url: `${SERVICE_CALLS_PATH}${query}` })
  ).json() as ServiceCallsPage;
/** The answer without its clock fields. */
const stable = (page: ServiceCallsPage) => ({ ...page, as_of: '', day_as_of: '' });

test('Base and Arc together, newest first; Arc rows carry chain_id and Arc is named', async (t) => {
  const db = await setup(t);
  const b1 = await call(db, { from: 1, chainId: 8453, at: NOW - 1000 });
  const a1 = await call(db, { from: 2, chainId: ARC_MAINNET, at: NOW - 1500 });
  const b2 = await call(db, { from: 1, chainId: 8453, at: NOW - 2000 });
  const a2 = await call(db, { from: 2, chainId: ARC_MAINNET, at: NOW - 500 });
  const body = await get(routes(t, db, [8453, ARC_MAINNET]));
  assert.deepEqual(
    body.items.map((i) => i.tx_hash),
    [a2, b1, a1, b2],
  );
  assert.deepEqual(
    body.items.map((i) => i.chain_id),
    [ARC_MAINNET, undefined, ARC_MAINNET, undefined],
  );
  // A Base row has no chain field at all.
  assert.ok(!('chain_id' in body.items[1]!));
  assert.equal(body.items[0]!.payer, spender(2));
  assert.deepEqual(body.chains, [
    {
      chain_id: 8453,
      name: 'Base',
      explorer_url: 'https://basescan.org',
      mark: '#0052ff',
      total: 2,
    },
    {
      chain_id: ARC_MAINNET,
      name: 'Arc',
      explorer_url: 'https://explorer.arc.io',
      mark: '#0b0b0f',
      total: 2,
    },
  ]);
  // Counters cover both chains.
  assert.equal(body.total, 4);
  assert.equal(body.last24h, 4);
  // Search covers both: an Arc transaction, and the shared provider address on both chains.
  const byTx = await get(routes(t, db, [8453, ARC_MAINNET]), `?q=${a1}`);
  assert.deepEqual(
    byTx.items.map((i) => [i.tx_hash, i.chain_id]),
    [[a1, ARC_MAINNET]],
  );
  assert.equal(byTx.matches, 1);
  const byProvider = await get(routes(t, db, [8453, ARC_MAINNET]), `?q=${PROVIDER}`);
  assert.equal(byProvider.items.length, 4);
  assert.equal(byProvider.matches, 4);
  const byPayer = await get(routes(t, db, [8453, ARC_MAINNET]), `?q=${spender(2)}`);
  assert.deepEqual(
    byPayer.items.map((i) => i.tx_hash),
    [a2, a1],
  );
  // The page links each row to its own chain's explorer.
  const arcLinks = chainLinks(body.items[0]!, body.chains);
  assert.equal(arcLinks.tx(a2), `https://explorer.arc.io/tx/${a2}`);
  assert.equal(arcLinks.network, 'Arc mainnet');
  const baseLinks = chainLinks(body.items[1]!, body.chains);
  assert.equal(baseLinks.tx(b1), `https://basescan.org/tx/${b1}`);
  assert.equal(baseLinks.network, 'Base mainnet');
  assert.equal(chainNames(body.chains!), 'Base and Arc');
  assert.equal(darkMark('#0b0b0f'), true);
  assert.equal(darkMark('#0052ff'), false);
});

test('pages page through both chains in one order, none twice, none skipped', async (t) => {
  const db = await setup(t);
  const all: string[] = [];
  for (let i = 0; i < 40; i++)
    all.push(
      await call(db, {
        from: i % 3 === 0 ? 2 : 1,
        chainId: i % 3 === 0 ? ARC_MAINNET : 8453,
        at: NOW - (i + 1) * 1000,
      }),
    );
  const app = routes(t, db, [8453, ARC_MAINNET]);
  const seen: string[] = [];
  let cursor: string | null = null;
  do {
    const page: ServiceCallsPage = await get(app, cursor ? `?cursor=${cursor}` : '');
    seen.push(...page.items.map((i) => i.tx_hash));
    cursor = page.next_cursor;
  } while (cursor);
  assert.deepEqual(seen, all);
});

test('no paid call on another chain yet: the answer is exactly as with Base alone', async (t) => {
  const db = await setup(t);
  await call(db, { from: 1, chainId: 8453, at: NOW - 1000 });
  await call(db, { from: 1, chainId: 8453, at: NOW - 2000 });
  const statements: string[] = [];
  const watched: Database['transaction'] = (action) =>
    db.transaction((tx) =>
      action({
        ...tx,
        query: (sql, params) => {
          statements.push(sql);
          return tx.query(sql, params);
        },
      }),
    );
  const alone = await get(routes(t, db));
  const live = await get(routes(t, db, [8453, ARC_MAINNET], watched));
  assert.deepEqual(stable(live), stable(alone));
  assert.equal(live.chains, undefined);
  // No statement reads Arc's wallets or calls while Arc's counter row shows none.
  assert.ok(!statements.some((sql) => /wallet_id = ANY|DISTINCT c.wallet_id/.test(sql)));
});

test('a third chain in the registry shows up with its name, mark and explorer, no page change', async (t) => {
  const db = await setup(t);
  const b = await call(db, { from: 1, chainId: 8453, at: NOW - 3000 });
  const a = await call(db, { from: 2, chainId: ARC_MAINNET, at: NOW - 2000 });
  const f = await call(db, { from: 3, chainId: FAKE, at: NOW - 1000 });
  const body = await get(routes(t, db, [8453, ARC_MAINNET, FAKE]));
  assert.deepEqual(
    body.items.map((i) => [i.tx_hash, i.chain_id]),
    [
      [f, FAKE],
      [a, ARC_MAINNET],
      [b, undefined],
    ],
  );
  assert.deepEqual(
    body.chains?.map((c) => [c.chain_id, c.name, c.mark]),
    [
      [8453, 'Base', '#0052ff'],
      [ARC_MAINNET, 'Arc', '#0b0b0f'],
      [FAKE, 'Fakechain', '#22aa66'],
    ],
  );
  assert.equal(body.total, 3);
  const links = chainLinks(body.items[0]!, body.chains);
  assert.equal(links.tx(f), `https://scan.fakechain.example/tx/${f}`);
  assert.equal(links.scanName, 'scan.fakechain.example');
  assert.equal(links.chain?.name, 'Fakechain');
  assert.equal(chainNames(body.chains!), 'Base, Arc and Fakechain');
  // A chain only listed live, not configured, is never read.
  const twoOnly = await get(routes(t, db, [8453, ARC_MAINNET]));
  assert.ok(!twoOnly.items.some((i) => i.chain_id === FAKE));
});

test('live chains: Base alone unless CITY_ARC=1', () => {
  assert.deepEqual(liveChainIds({}), [8453]);
  assert.deepEqual(liveChainIds({ CITY_ARC: '1' }), [8453, ARC_MAINNET]);
});

test('each chain reads feed_pay_calls_paid by its own wallets, never a seq scan of the table', async (t) => {
  const db = await setup(t);
  // Many Base calls over two days, a few Arc ones: Arc's branch must not read through Base's.
  await db.exec(`ALTER TABLE feed_pay_calls DISABLE TRIGGER USER;
    INSERT INTO feed_pay_calls (call_id, origin, scope, idempotency_key, request_hash, caller_id,
       actor, owner_account_id, operator_id, agent_id, agent_name, wallet_id, chain_id, service_id,
       service_title, host, method, request_url, max_amount_raw, permission_id, payment_id,
       amount_raw, pay_to, x402_version, requirements, validity_s, state, payment_state, tx_hash,
       settled_block, settled_at, created_at, updated_at, fee_raw, pay_kind)
    SELECT 'fc_' || translate(lpad((100000 + g)::text, 20, '0'), '0123456789', 'klmnopqrst'), 'feed', 's', lpad(to_hex(g), 64, '0'), lpad(to_hex(g), 64, '0'), 'c',
       'a', 'acct', 'ws', 'agent-1', 'n', 'w-1', 8453, 'svc', 'Page reader', 'h', 'POST', 'u',
       100000, 'p', 'pay-bulk' || g, 45000, '${PROVIDER}', 2, '{}'::jsonb, 60, 'result_saved',
       'settled', '0x' || lpad(to_hex(g), 64, '0'), 2000000 + g, ${NOW} - g * 5000::bigint,
       ${NOW}, ${NOW}, 0, 'x402'
    FROM generate_series(1, 30000) g;
    ALTER TABLE feed_pay_calls ENABLE TRIGGER USER;
    ANALYZE feed_pay_calls; ANALYZE base_wallets;`);
  for (let i = 0; i < 3; i++) await call(db, { from: 2, chainId: ARC_MAINNET, at: NOW - i * 700 });
  const plans: string[] = [];
  const explained: Database['transaction'] = (action) =>
    db.transaction((tx) =>
      action({
        ...tx,
        query: async (sql, params) => {
          if (/wallet_id = ANY/.test(sql)) {
            const plan = await tx.query<{ 'QUERY PLAN': string }>(`EXPLAIN ${sql}`, params);
            plans.push(plan.rows.map((r) => r['QUERY PLAN']).join('\n'));
          }
          return tx.query(sql, params);
        },
      }),
    );
  const app = routes(t, db, [8453, ARC_MAINNET], explained);
  const first = await get(app);
  assert.equal(first.items.filter((i) => i.chain_id === ARC_MAINNET).length, 3);
  await get(app, `?cursor=${first.next_cursor}`);
  await get(app, `?q=${PROVIDER}`);
  // page x2 (+ re-reads), day, search with its count, per minute.
  assert.ok(plans.length >= 4, String(plans.length));
  // The other chain's branch is an index range of feed_pay_calls_paid on its wallets: the
  // wallets are an index condition, never a filter over Base's rows. (Base's own branch reads as
  // it always has: here its counter row is empty, so it is unbounded, as before this change.)
  for (const plan of plans) {
    assert.match(
      plan,
      /Index (Only )?Scan( Backward)? using feed_pay_calls_(paid|wallet) on feed_pay_calls c\w*[^\n]*\n\s+Index Cond: \(\(?wallet_id = ANY/,
      plan,
    );
    assert.doesNotMatch(plan, /Filter: [^\n]*wallet_id = ANY/, plan);
  }
  // The page's branch reads the paid index itself, in the page order's range.
  assert.match(
    plans[0]!,
    /using feed_pay_calls_paid on feed_pay_calls c\w*[^\n]*\n\s+Index Cond: \(\(wallet_id = ANY/,
    plans[0],
  );
});
