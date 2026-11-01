import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import type { Database } from '../server/database.js';
import { BASE_IDENTITIES_BASE_ID_SQL } from '../server/base/explorer/base-id-index-schema.js';
import { BASE_WALLETS_ADDRESS_LOWER_SQL } from '../server/base/pay/address-index-schema.js';
import { registerOnBaseRoutes } from '../server/base/explorer/routes.js';
import { createOnBaseStore } from '../server/base/explorer/store.js';
import type { OnBaseList } from '../shared/base/on-base.js';
import { NOW, add, fanOut, handoverTx, mintTx, setup } from './on-base-fixture.js';

/*
 * The plans of the Explorer's exact searches (store.ts list). A 6-digit text is read as a Base ID
 * and as a short id; with both in one OR across base_identities and base_short_ids no single index
 * serves the statement, and at production size (about 1M registrations) the plan walked every
 * registration (5.4 s). Each exact reading is its own branch, served by its own index: the Base ID
 * by base_identities_base_id (migration 255), the short id by base_short_ids' primary key, the
 * agent wallet by base_wallets_address_lower (247). A transaction is read as before, one branch
 * whose columns are not indexed yet (4-5 s at 1M; their indexes come with migration 291). A name needs a run of 3 letters or digits (the
 * trigram index serves nothing shorter: 13 s at 1M); a shorter text with no other reading is
 * refused by type. A few thousand rows here, analyzed, so the planner prefers an index wherever
 * one serves.
 */

const ROWS = 3000;

async function seeded(t: { after: (fn: () => Promise<unknown>) => void }, ready: boolean) {
  const db = await setup(t);
  await add(db, { n: 1, kind: 'final', id: 121, name: 'Harbor North' });
  await fanOut(db, ROWS);
  await db.query(BASE_IDENTITIES_BASE_ID_SQL);
  await db.query(BASE_WALLETS_ADDRESS_LOWER_SQL);
  await db.query(
    `SELECT agent_public_cards_refresh(ARRAY(SELECT a->>'id' FROM workspaces,
       jsonb_array_elements(data->'agents') a))`,
  );
  await db.query('UPDATE agent_public_cards_backfill SET ready = $1 WHERE id = 1', [ready]);
  await db.exec('ANALYZE');
  return db;
}

/** The search statement store.list runs for `q`, its rows, and its plan as text. */
async function planOf(db: Database, q: string) {
  const statements: Array<{ sql: string; params: unknown[] }> = [];
  const traced: Database = {
    ...db,
    query: ((sql: string, params?: unknown[]) => {
      statements.push({ sql, params: params ?? [] });
      return db.query(sql, params as never);
    }) as Database['query'],
  };
  const page = await createOnBaseStore(traced, { chainId: 8453 }).list({ q });
  const search = statements.find((s) => /agent_card_uri/.test(s.sql));
  if (!search) return { page, plan: null };
  const { rows } = await db.query<{ 'QUERY PLAN': string }>(
    `EXPLAIN ${search.sql}`,
    search.params as never,
  );
  return { page, plan: rows.map((row) => row['QUERY PLAN']).join('\n') };
}

for (const ready of [true, false])
  test(`a Base ID, a short id and a wallet are each read through their own index (${ready ? 'ready' : 'building'})`, async (t) => {
    const db = await seeded(t, ready);
    // 6 digits: a Base ID, a short id and a name all at once (fanOut's short ids are F + 5 digits,
    // so 6 digits is a short id nobody has).
    const byId = await planOf(db, '10500');
    assert.deepEqual(
      byId.page.items.map((item) => item.row.baseId),
      ['10500'],
    );
    const sixDigits = await planOf(db, '102500');
    assert.deepEqual(sixDigits.page.items, []);
    const byShort = await planOf(db, 'F00500');
    assert.deepEqual(
      byShort.page.items.map((item) => item.row.baseId),
      ['10500'],
    );
    const byWallet = await planOf(db, `0x9${'0'.repeat(36)}1f4`);
    assert.deepEqual(
      byWallet.page.items.map((item) => item.row.baseId),
      ['10500'],
    );
    for (const [label, plan] of [
      ['base id', byId.plan],
      ['six digits', sixDigits.plan],
      ['short id', byShort.plan],
      ['wallet', byWallet.plan],
    ] as const) {
      assert.ok(plan, label);
      assert.doesNotMatch(plan, /Seq Scan on base_identities/, `${label}\n${plan}`);
      assert.doesNotMatch(plan, /Seq Scan on base_short_ids/, `${label}\n${plan}`);
      assert.doesNotMatch(plan, /Seq Scan on base_wallets/, `${label}\n${plan}`);
    }
    assert.match(byId.plan!, /Index Scan using base_identities_base_id/, byId.plan!);
    assert.match(sixDigits.plan!, /Index Scan using base_identities_base_id/, sixDigits.plan!);
    assert.match(sixDigits.plan!, /base_short_ids_pkey/, sixDigits.plan!);
    assert.match(byShort.plan!, /base_short_ids_pkey/, byShort.plan!);
    assert.match(byWallet.plan!, /base_wallets_address_lower/, byWallet.plan!);
  });

function routes(t: { after: (fn: () => Promise<unknown>) => void }, db: Database) {
  const app = Fastify();
  t.after(() => app.close());
  registerOnBaseRoutes(app, { db, now: () => NOW, limit: async () => {} });
  return app;
}

const get = (app: ReturnType<typeof routes>, q: string) =>
  app.inject({ url: `/api/public/base/agents?q=${encodeURIComponent(q)}` });

test('a 1-2 character name is refused by type (400) and reads nothing; exact readings of any length answer', async (t) => {
  const db = await seeded(t, true);
  await add(db, { n: 4, kind: 'final', id: 12, name: 'Twelve' });
  const app = routes(t, db);
  for (const q of ['Fl', 'e', '%%', 'a b', ' Fl ']) {
    const res = await get(app, q);
    assert.equal(res.statusCode, 400, q);
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.deepEqual(res.json(), {
      error: 'Type at least 3 characters to search names',
      code: 'unsupported_reading',
      reading: 'name-min',
    });
    // The store itself runs no search statement for it either.
    const { page, plan } = await planOf(db, q);
    assert.deepEqual(page.items, [], q);
    assert.equal(page.notice, 'name-min', q);
    assert.equal(plan, null, `${q}: no search statement`);
  }
  // A 1-2 digit text is an exact Base ID, answered (its name part is not read, and it says so).
  const twelve = await get(app, '12');
  assert.equal(twelve.statusCode, 200);
  const body = twelve.json() as OnBaseList;
  assert.deepEqual(
    body.rows.map((row) => row.baseId),
    ['12'],
  );
  assert.equal(body.notice, 'name-min');
  const plan12 = (await planOf(db, '12')).plan!;
  assert.doesNotMatch(plan12, /Seq Scan on base_identities/, plan12);
  // So are a short id, a passport number, a wallet and a 1-digit Base ID.
  assert.deepEqual(
    ((await get(app, 'F00500')).json() as OnBaseList).rows.map((row) => row.baseId),
    ['10500'],
  );
  assert.deepEqual(
    ((await get(app, 'CC-F00500')).json() as OnBaseList).rows.map((row) => row.baseId),
    ['10500'],
  );
  assert.equal((await get(app, `0x9${'0'.repeat(36)}1f4`)).statusCode, 200);
  assert.equal((await get(app, '7')).statusCode, 200);
  // Part of a wallet or a transaction is no reading either: refused by type, never "no match"
  // (0x and 4 hex is still a 6-character short id, and searched as one).
  for (const q of ['0x33', '0x', `0x${'a'.repeat(41)}`]) {
    const res = await get(app, q);
    assert.equal(res.statusCode, 400, q);
    assert.equal((res.json() as { reading: string }).reading, 'hex-partial', q);
    assert.equal((await planOf(db, q)).plan, null, q);
  }
  // Three letters search names, without a notice.
  const fle = (await get(app, 'Fle')).json() as OnBaseList;
  assert.equal(fle.rows.length, 50);
  assert.equal(fle.notice, undefined);
});

test('a transaction hash is unavailable until its indexes are built: 503, never a scan', async (t) => {
  const db = await seeded(t, true);
  const app = routes(t, db);
  for (const q of [mintTx(1), handoverTx(1), mintTx(1).toUpperCase().replace('0X', '0x')]) {
    const res = await get(app, q);
    assert.equal(res.statusCode, 503, q);
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.equal((res.json() as { code: string }).code, 'tx_search_unavailable');
    assert.match((res.json() as { error: string }).error, /temporarily unavailable/);
    const { page, plan } = await planOf(db, q);
    assert.deepEqual(page.items, []);
    assert.equal(plan, null, `${q}: no search statement`);
  }
});
