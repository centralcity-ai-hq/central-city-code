import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { getAddress, type Hex } from 'viem';
import type { Database } from '../server/database.js';
import {
  PUBLIC_OFFER_DAILY,
  PUBLIC_OFFER_PER_CLIENT_DAY,
  PUBLIC_OFFER_PER_PAYEE_DAY,
  PUBLIC_OFFER_PER_PAYER_HOUR,
  PUBLIC_OFFER_SIMULATIONS_PER_CLIENT_MINUTE,
  PUBLIC_OFFER_SIMULATIONS_PER_MINUTE,
  PUBLIC_OFFER_SIMULATIONS_PER_SELLER_MINUTE,
  publicOfferBudget,
  publicOfferClientSimulations,
  publicOfferPaidBudget,
  publicOfferSellerSimulations,
  publicOfferSimulations,
} from '../server/feed/offers/public-pay.js';
import { runMigrations } from '../server/migrations.js';
import { MemoryRateLimiter, PostgresRateLimiter } from '../server/rate-limit.js';

/*
 * The public offers' limiter buckets on what production runs: PostgresRateLimiter over the real
 * migrated rate_limits table (PGlite), with its per-instance pre-check on. Synthetic keys and clock.
 */

process.env.CITY_RATE_LIMIT_KEY ??= 'synthetic-test-only-rate-limit-secret-0000';

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
/** A UTC midnight, so a minute, an hour and a day all start here. */
const START = 19_000 * DAY;

const address = (byte: string) => getAddress(`0x${byte.repeat(20)}`) as Hex;
const payeeKey = (payee: Hex) => `x402-offer-pay:payee:${payee.toLowerCase()}`;
const DAY_KEY = 'x402-offer-pay:day';

const database = PGlite.create('memory://').then(async (db) => {
  await runMigrations(db);
  return db;
});
after(async () => (await database).close());

/** A limiter at its own clock, over a table no other test has written. */
async function fresh(now = START) {
  const db = await database;
  await db.query('DELETE FROM rate_limits');
  const clock = { now };
  const limiter = new PostgresRateLimiter(db, () => clock.now);
  const hit = (key: string, limit: number, windowMs: number) => limiter.hit(key, limit, windowMs);
  return { db, clock, limiter, hit };
}

const spend = async (take: () => Promise<boolean>, times: number) => {
  for (let i = 0; i < times; i++) assert.equal(await take(), true, `unit ${i + 1} of ${times}`);
};

test('the simulation buckets: each refuses just past its limit, per key, and opens next minute', async () => {
  const { clock, hit } = await fresh();
  const client = publicOfferClientSimulations(hit);
  const seller = publicOfferSellerSimulations(hit);
  const shared = publicOfferSimulations(hit);
  const a = address('aa');
  const b = address('bb');

  await spend(() => client('203.0.113.1'), PUBLIC_OFFER_SIMULATIONS_PER_CLIENT_MINUTE);
  assert.equal(await client('203.0.113.1'), false);
  assert.equal(await client('203.0.113.2'), true, 'another address has its own');

  await spend(() => seller(a), PUBLIC_OFFER_SIMULATIONS_PER_SELLER_MINUTE);
  assert.equal(await seller(a), false);
  assert.equal(await seller(a.toLowerCase() as Hex), false, 'the same seller in any case');
  assert.equal(await seller(b), true, 'another seller has its own');

  await spend(shared, PUBLIC_OFFER_SIMULATIONS_PER_MINUTE);
  assert.equal(await shared(), false);

  clock.now += MINUTE;
  assert.equal(await client('203.0.113.1'), true);
  assert.equal(await seller(a), true);
  assert.equal(await shared(), true);
});

test('the shared cap is shared across instances, and a seller full on one is refused on the other', async () => {
  const { db, clock, hit } = await fresh();
  const other = new PostgresRateLimiter(db as unknown as Database, () => clock.now);
  const otherHit = (key: string, limit: number, windowMs: number) =>
    other.hit(key, limit, windowMs);
  const here = publicOfferSimulations(hit);
  const there = publicOfferSimulations(otherHit);
  await spend(here, PUBLIC_OFFER_SIMULATIONS_PER_MINUTE - 1);
  assert.equal(await there(), true);
  assert.equal(await there(), false);
  assert.equal(await here(), false);
  const seller = address('cc');
  await spend(
    () => publicOfferSellerSimulations(hit)(seller),
    PUBLIC_OFFER_SIMULATIONS_PER_SELLER_MINUTE,
  );
  assert.equal(await publicOfferSellerSimulations(otherHit)(seller), false);
});

test('the budget: a refused payer spends no client unit, and attempts never spend the seller or the day', async () => {
  const { clock, limiter } = await fresh();
  const budget = publicOfferBudget(limiter);
  const payer = address('01');
  const payee = address('02');
  const scope = { payee, client: 'c1' };
  await spend(() => budget(payer, scope), PUBLIC_OFFER_PER_PAYER_HOUR);
  assert.equal(await limiter.count('x402-offer-pay:client:c1', DAY), PUBLIC_OFFER_PER_PAYER_HOUR);
  assert.equal(await budget(payer, scope), false);
  assert.equal(
    await limiter.count('x402-offer-pay:client:c1', DAY),
    PUBLIC_OFFER_PER_PAYER_HOUR,
    'the payer refused first: no client unit',
  );
  assert.equal(await limiter.count(payeeKey(payee), DAY), 0);
  assert.equal(await limiter.count(DAY_KEY, DAY), 0);
  // The next hour opens the payer's, the day's client units stay.
  clock.now += HOUR;
  assert.equal(await budget(payer, scope), true);
  assert.equal(
    await limiter.count('x402-offer-pay:client:c1', DAY),
    PUBLIC_OFFER_PER_PAYER_HOUR + 1,
  );
});

test('the budget: the client refuses at its day limit, and the next UTC day opens it', async () => {
  const { clock, limiter } = await fresh();
  const budget = publicOfferBudget(limiter);
  const payee = address('02');
  const scope = { payee, client: 'c2' };
  // Fresh payers, so only the client's bucket can refuse.
  for (let i = 0; i < PUBLIC_OFFER_PER_CLIENT_DAY; i++)
    assert.equal(
      await budget(getAddress(`0x${(i + 1).toString(16).padStart(40, '0')}`) as Hex, scope),
      true,
    );
  assert.equal(await budget(address('f1'), scope), false);
  assert.equal(await limiter.count(payeeKey(payee), DAY), 0);
  clock.now += DAY;
  assert.equal(await budget(address('f1'), scope), true);
});

test('the paid caps: paid units shut the seller, then the day, only those; both open next UTC day', async () => {
  const { clock, limiter } = await fresh();
  const budget = publicOfferBudget(limiter);
  const paid = publicOfferPaidBudget(limiter);
  const seller = address('03');
  const buyer = address('04');
  await spend(async () => {
    await paid(seller);
    return true;
  }, PUBLIC_OFFER_PER_PAYEE_DAY);
  assert.equal(await limiter.count(DAY_KEY, DAY), PUBLIC_OFFER_PER_PAYEE_DAY);
  assert.equal(await budget(buyer, { payee: seller, client: 'c3' }), false);
  assert.equal(await budget(buyer, { payee: address('05'), client: 'c3' }), true, 'another seller');
  // The day's cap, paid across other sellers.
  for (let i = PUBLIC_OFFER_PER_PAYEE_DAY; i < PUBLIC_OFFER_DAILY; i++)
    await paid(getAddress(`0x${(i + 1).toString(16).padStart(40, '0')}`) as Hex);
  assert.equal(await limiter.count(DAY_KEY, DAY), PUBLIC_OFFER_DAILY);
  assert.equal(await budget(address('06'), { payee: address('05'), client: 'c4' }), false);
  clock.now += DAY;
  assert.equal(await budget(address('06'), { payee: seller, client: 'c4' }), true);
  assert.equal(await limiter.count(DAY_KEY, DAY), 0);
});

test('a difference from memory: windows follow the clock, so a burst can span a boundary', async () => {
  const limit = PUBLIC_OFFER_SIMULATIONS_PER_SELLER_MINUTE;
  const seller = address('07');
  const { clock, hit } = await fresh(START + MINUTE - 1_500);
  const pg = publicOfferSellerSimulations(hit);
  await spend(() => pg(seller), limit);
  assert.equal(await pg(seller), false);
  clock.now = START + MINUTE;
  await spend(() => pg(seller), limit);
  assert.equal(await pg(seller), false);
  // In-memory, the window starts at the first hit: 1.5 s later it is still the same one.
  let now = START + MINUTE - 1_500;
  const memory = new MemoryRateLimiter(() => now);
  const mem = publicOfferSellerSimulations((k, l, w) => memory.hit(k, l, w));
  await spend(() => mem(seller), limit);
  now = START + MINUTE;
  assert.equal(await mem(seller), false);
});

test('an outage fails closed: every check refuses; a lost paid unit is reported', async () => {
  const { db } = await fresh();
  const down: Database = {
    query: async () => {
      throw new Error('Synthetic outage');
    },
    exec: (sql) => db.exec(sql),
    transaction: (action) => db.transaction(action),
    close: async () => {},
  };
  const limiter = new PostgresRateLimiter(
    down,
    () => START,
    undefined,
    undefined,
    () => {},
  );
  const hit = (key: string, limit: number, windowMs: number) => limiter.hit(key, limit, windowMs);
  const seller = address('0a');
  assert.equal(await publicOfferSimulations(hit)(), false);
  assert.equal(await publicOfferSellerSimulations(hit)(seller), false);
  assert.equal(await publicOfferClientSimulations(hit)('c5'), false);
  assert.equal(
    await publicOfferBudget(limiter)(address('0b'), { payee: seller, client: 'c5' }),
    false,
  );
  // A throw: markPaid's own log of a failed paid budget says the unit was lost.
  await assert.rejects(publicOfferPaidBudget(limiter)(seller), /paid unit not taken/);
  assert.equal(limiter.outages['fail-closed'] > 0, true);
});

test('a paid unit the limiter could not take is reported, and both caps are still asked', async () => {
  const asked: string[] = [];
  const paid = publicOfferPaidBudget({
    hit: async (key: string) => {
      asked.push(key);
      return { allowed: false, retryAfterMs: 1 };
    },
    count: async () => 0,
  });
  await assert.rejects(paid(`0x${'11'.repeat(20)}` as Hex), /paid unit not taken/);
  assert.equal(asked.length, 2);
});
