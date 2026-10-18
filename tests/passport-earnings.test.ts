import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import type { Database } from '../server/database.js';
import { registerOnBaseRoutes } from '../server/base/explorer/routes.js';
import { registerDirectoryRoutes } from '../server/directory/routes.js';
import { AGENT_DIRECTORY_SQL } from '../server/directory/schema.js';
import { DIRECTORY_PATHS, type DirectoryPage, type PassportEarnings } from '../shared/directory.js';
import { MIN, NOW, add, agentId, agentWallet, setup, shortOf } from './on-base-fixture.js';

/*
 * Operation Directory D4: a passport's earnings are the FINAL Central City USDC payments to that
 * agent's own wallet, totals only, read from the records; an unknown or unlisted passport is 404.
 */

function routes(t: { after: (fn: () => Promise<unknown>) => void }, db: Database) {
  const app = Fastify();
  t.after(() => app.close());
  registerOnBaseRoutes(app, { db, now: () => NOW });
  return app;
}

let seq = 0;
/** A Central City payment from fixture `from` to fixture `to`, `raw` USDC units. */
async function pay(
  db: Database,
  p: { from: number; to: number; raw: number; final?: boolean; destination?: string; at?: number },
) {
  seq += 1;
  const id = `pay-${seq}`;
  const at = p.at ?? NOW - 10 * MIN;
  const hash = `0x${String(seq).padStart(64, '0')}`;
  await db.query(
    `INSERT INTO base_wallet_withdrawals (withdrawal_id, wallet_id, owner_account_id, chain_id,
       kind, token, amount_raw, destination, idempotency_key, request_hash, state, nonce,
       user_operation, user_op_hash, expires_at, owner_signature, chain_op_key, signed_at,
       created_at, updated_at)
     VALUES ($1, $2, 'ws', 8453, 'withdraw', 'USDC', $3, $4, $1, $5, $6, $7, '{}', $5, $8, $9,
       $10, $8, $8, $8)`,
    [
      `wd-${id}`,
      `w-${p.from}`,
      p.raw,
      p.destination ?? agentWallet(p.to),
      hash,
      p.final === false ? 'submitted' : 'final',
      seq,
      at,
      Buffer.alloc(65, 1),
      `base-wallet:withdraw:${id}`,
    ],
  );
  await db.query(
    `INSERT INTO base_wallet_payments (payment_id, withdrawal_id, chain_id, owner_account_id,
       sender_wallet_id, sender_agent_id, idempotency_key, request_hash, token, amount_raw,
       recipient_kind, recipient_address, recipient_agent_id, recipient_wallet_id,
       recipient_base_id, recipient_short_id, registry_address, lookup_id, issued_block,
       issued_block_hash, issued_expires_at, verified_block, verified_block_hash, verified_at,
       created_at, final_at)
     VALUES ($1, $2, 8453, 'ws', $3, $4, $1, $5, 'USDC', $6, 'central_city_agent', $7, $8, $9,
       1, $10, $11, $12, 1, $5, $13, 1, $5, $13, $13, $14)`,
    [
      id,
      `wd-${id}`,
      `w-${p.from}`,
      agentId(p.from),
      hash,
      p.raw,
      agentWallet(p.to),
      agentId(p.to),
      `w-${p.to}`,
      shortOf(p.to),
      `0x${'a'.repeat(40)}`,
      `pl_${String(seq).padStart(32, '0')}`,
      at,
      p.final === false ? null : at,
    ],
  );
}

test('a passport shows its final Central City payments as totals; nothing else counts', async (t) => {
  const db = await setup(t);
  await add(db, { n: 1, kind: 'final', id: 120, name: 'Harbor' });
  await add(db, { n: 2, kind: 'final', id: 121, name: 'Payer' });
  await add(db, { n: 3, kind: 'final', id: 122, name: 'Other' });
  await pay(db, { from: 2, to: 1, raw: 2_500_000, at: NOW - 20 * MIN });
  await pay(db, { from: 2, to: 1, raw: 10_000, at: NOW - 5 * MIN });
  // Not counted: on its way (not final), sent elsewhere, to another agent.
  await pay(db, { from: 2, to: 1, raw: 7_000_000, final: false });
  await pay(db, { from: 2, to: 1, raw: 9_000_000, destination: `0x${'9'.repeat(40)}` });
  await pay(db, { from: 2, to: 3, raw: 1_000_000 });

  const app = routes(t, db);
  const response = await app.inject({ url: `/api/public/passports/${shortOf(1)}/earnings` });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json() as PassportEarnings, {
    paidTimes: 2,
    totalUsdc: '2.51',
    lastPaidAt: NOW - 5 * MIN,
  });
  assert.match(String(response.headers['cache-control']), /s-maxage=10/);

  // Never paid: zeros, not 404.
  const none = await app.inject({ url: `/api/public/passports/${shortOf(2)}/earnings` });
  assert.deepEqual(none.json(), { paidTimes: 0, totalUsdc: '0', lastPaidAt: null });
});

test('an unknown, unlisted or malformed passport answers 404 or 400, never totals', async (t) => {
  const db = await setup(t);
  await add(db, { n: 4, kind: 'final', id: 100, name: 'Hidden', revoked: true });
  await add(db, { n: 5, kind: 'pending' });
  const app = routes(t, db);
  for (const short of [shortOf(5), 'ZZZZZZ']) {
    const response = await app.inject({ url: `/api/public/passports/${short}/earnings` });
    assert.equal(response.statusCode, 404, short);
    assert.equal(response.json().code, 'not_found');
  }
  const bad = await app.inject({ url: '/api/public/passports/abc/earnings' });
  assert.equal(bad.statusCode, 404);
  const query = await app.inject({ url: `/api/public/passports/${shortOf(4)}/earnings?x=1` });
  assert.equal(query.statusCode, 400);
});

test('public counts never depend on who owns the payer: passport and directory agree', async (t) => {
  // An owner filter here would let anyone compare the counts with Base transfers and learn which
  // agents share an owner. Each payment counts the same, whoever owns the paying agent.
  const db = await setup(t);
  await db.exec(AGENT_DIRECTORY_SQL);
  await add(db, { n: 1, kind: 'final', id: 120, name: 'Harbor' });
  await add(db, { n: 2, kind: 'final', id: 121, name: 'Payer' });
  await db.query('INSERT INTO agent_directory (agent_id, listed) VALUES ($1, true)', [agentId(1)]);
  await pay(db, { from: 2, to: 1, raw: 1_000_000 });
  const app = routes(t, db);
  const directory = Fastify();
  t.after(() => directory.close());
  registerDirectoryRoutes(directory, { db, owns: async () => 'ok' });
  const read = async () => {
    const passport = (
      await app.inject({ url: `/api/public/passports/${shortOf(1)}/earnings` })
    ).json() as PassportEarnings;
    const page = (
      await directory.inject({ url: `${DIRECTORY_PATHS.search}?sort=most_paid` })
    ).json() as DirectoryPage;
    return [passport.paidTimes, page.agents.find((card) => card.name === 'Harbor')?.paidTimes];
  };
  assert.deepEqual(await read(), [1, 1], 'the receiving wallet has no owner here');
  // The paying account now owns the receiving wallet too: the public numbers do not change.
  await db.query("UPDATE base_wallets SET owner_account_id = 'ws' WHERE wallet_id = 'w-1'");
  assert.deepEqual(await read(), [1, 1]);
});

test("the directory shows each card's Paid count and sorts most paid first", async (t) => {
  const db = await setup(t);
  await db.exec(AGENT_DIRECTORY_SQL);
  await add(db, { n: 1, kind: 'final', id: 120, name: 'Once' });
  await add(db, { n: 2, kind: 'final', id: 121, name: 'Payer' });
  await add(db, { n: 3, kind: 'final', id: 122, name: 'Twice' });
  await add(db, { n: 4, kind: 'final', id: 123, name: 'Never' });
  for (const n of [1, 3, 4])
    await db.query('INSERT INTO agent_directory (agent_id, listed) VALUES ($1, true)', [
      agentId(n),
    ]);
  await pay(db, { from: 2, to: 1, raw: 50_000 });
  await pay(db, { from: 2, to: 3, raw: 50_000 });
  await pay(db, { from: 2, to: 3, raw: 50_000 });
  await pay(db, { from: 2, to: 4, raw: 50_000, final: false });
  const app = Fastify();
  t.after(() => app.close());
  registerDirectoryRoutes(app, { db, owns: async () => 'ok' });
  const page = async (sort: string) =>
    (await app.inject({ url: `${DIRECTORY_PATHS.search}?sort=${sort}` })).json() as DirectoryPage;
  const most = await page('most_paid');
  assert.deepEqual(
    most.agents.map((card) => [card.name, card.paidTimes]),
    [
      ['Twice', 2],
      ['Once', 1],
      ['Never', 0],
    ],
  );
  // Newest keeps Base ID order; the counts ride along.
  assert.deepEqual(
    (await page('newest')).agents.map((card) => card.name),
    ['Never', 'Twice', 'Once'],
  );
});
