import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import type { Database } from '../server/database.js';
import {
  OWN_PAYMASTER_ATTRIBUTION_SQL,
  OWN_PAYMASTER_BUDGET_CHAIN_SQL,
  OWN_PAYMASTER_BUDGET_SQL,
  OWN_PAYMASTER_RESERVATIONS_CHAIN_SQL,
  ownPaymasterBudget,
} from '../server/base/chain/own-paymaster-budget.js';

/*
 * 2 Nov 2026: the Arc budget lock still queued after settles left it, and nobody could say what
 * held it. Every hold is counted per call site (with named steps' longest times); an instance logs
 * one line per 10 s, only when a hold reached 200 ms. Real time is mocked (Date only).
 */

const NOW = 1_700_000_000_000;
const S = Math.floor(NOW / 1000);
let hashes = 0;
const hash = () => `0x${(++hashes).toString(16).padStart(64, '0')}`;

async function setup(t: TestContext, slow?: { match: RegExp; ms: number }) {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const pg = new PGlite();
  for (const sql of [
    OWN_PAYMASTER_BUDGET_SQL,
    OWN_PAYMASTER_ATTRIBUTION_SQL,
    OWN_PAYMASTER_BUDGET_CHAIN_SQL,
    OWN_PAYMASTER_RESERVATIONS_CHAIN_SQL,
  ])
    await pg.exec(sql);
  t.after(() => pg.close());
  const db = {
    query: (sql: string, params?: unknown[]) => pg.query(sql, params) as never,
    exec: (sql: string) => pg.exec(sql),
    // A statement `slow` matches takes `ms` of (mocked) real time.
    transaction: (action: (tx: never) => Promise<unknown>) =>
      pg.transaction((tx) =>
        action({
          query: async (sql: string, params?: unknown[]) => {
            const answer = await tx.query(sql, params);
            if (slow?.match.test(sql)) t.mock.timers.tick(slow.ms);
            return answer;
          },
        } as never),
      ),
    close: () => pg.close(),
  } as unknown as Database;
  const lines: string[] = [];
  const g = ownPaymasterBudget({
    db,
    deposit: async () => ({ wei: 10n ** 21n, block: 100n }),
    now: () => NOW,
    submitterBound: true,
    chainId: 5042,
    log: (line) => void lines.push(line),
  });
  const reserve = (h: string) =>
    g.reserve({
      userOpHash: h,
      flow: 'registration',
      maxCostWei: 10n ** 15n,
      validUntil: S + 300,
      sender: `0x${h.slice(-40)}`, // one sender each: the sender's hourly cap stays out of it
      accountId: null,
    });
  return { db, g, lines, reserve, tick: (ms: number) => t.mock.timers.tick(ms) };
}

const held = (lines: string[]) => lines.filter((l) => l.includes('budget lock held'));

test("a caller's slow hold is logged once the interval passed, with its steps and the other sites", async (t) => {
  const { db, g, lines, reserve, tick } = await setup(t);
  await reserve(hash());
  const h = hash();
  await reserve(h);
  await db.transaction(async (tx) => {
    await g.markSentIn(tx, h);
    tick(250); // the lane lock and the signature, under the budget lock
    g.noteHeldIn(tx, 'send', { 'lane wait': 230, sign: 15 });
  });
  assert.deepEqual(held(lines), [], 'nothing before the interval');
  tick(10_000);
  await reserve(hash());
  const [line, ...more] = held(lines);
  assert.equal(more.length, 0);
  assert.match(line!, /^own paymaster: budget lock held on chain 5042 over 10 s: /);
  assert.match(
    line!,
    /send 1 \(1 >= 200 ms, max 250 ms, total 250 ms; expire max 0 ms; mark max 0 ms; lane wait max 230 ms; sign max 15 ms\)/,
  );
  assert.match(
    line!,
    /reserve 3 \(0 >= 200 ms, max 0 ms, total 0 ms; expire max 0 ms; deposit max 0 ms; sums \(full\) max 0 ms; own max 0 ms\)/,
  );
});

test('fast holds only: counted, never logged, and the next interval starts empty', async (t) => {
  const { g, lines, reserve, tick } = await setup(t);
  for (let i = 0; i < 5; i++) await reserve(hash());
  tick(10_000);
  await reserve(hash());
  assert.deepEqual(held(lines), []);
  // A slow one in the next interval reports only that interval's holds.
  tick(300);
  await g.release(hash()); // takes the lock; no time passes inside
  tick(9_800);
  await reserve(hash());
  assert.deepEqual(held(lines), [], 'still no hold reached 200 ms');
});

test('a transaction that never took the lock counts nothing, and a hold is counted once', async (t) => {
  const { db, g, lines, reserve, tick } = await setup(t);
  await db.transaction(async (tx) => {
    tick(500);
    g.noteHeldIn(tx, 'send');
  });
  const h = hash();
  await reserve(h);
  await db.transaction(async (tx) => {
    await g.markSentIn(tx, h);
    tick(300);
    g.noteHeldIn(tx, 'send');
    g.noteHeldIn(tx, 'send');
  });
  tick(10_000);
  await reserve(hash());
  const [line] = held(lines);
  assert.match(
    line!,
    /send 1 \(1 >= 200 ms, max 300 ms, total 300 ms; expire max 0 ms; mark max 0 ms\)/,
  );
});

test("a hold names its slow step: the admission's sums, the lapse, the account's own sums", async (t) => {
  // The admission's sums (sums or recentSums: the SUM ... FILTER statement) take 250 ms each.
  const { lines, reserve, tick } = await setup(t, { match: /FILTER \(WHERE/, ms: 250 });
  await reserve(hash());
  tick(10_000);
  await reserve(hash());
  const [line] = held(lines);
  assert.match(line!, /reserve 2 \(2 >= 200 ms/);
  assert.match(line!, /; sums \(full\) max (25\d|[3-9]\d\d) ms/);
  assert.match(line!, /; expire max \d+ ms/);
});
