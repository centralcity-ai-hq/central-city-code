import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { getAddress, type Hex } from 'viem';
import { createApp } from '../server/app.js';
import { publicOfferCooldown } from '../server/feed/offers/public-pay.js';
import { registerMigration, runMigrations } from '../server/migrations.js';
import {
  PAYER_COOLDOWN_SWEEP_MAX,
  sweepPayerCooldowns,
  x402PayerCooldownsMigration,
} from '../server/protocol/x402/payer-cooldown.js';
import { publicSettleCooldown } from '../server/protocol/x402/public-settle.js';

/* The revert cool-down of both lanes on the migrated table (PGlite). Synthetic addresses and clock. */

const HOUR = 3_600_000;
const MINUTE = 60_000;
/** A UTC midnight, so an hour starts here. */
const START = 19_000 * 86_400_000;
const address = (byte: string) => getAddress(`0x${byte.repeat(20)}`) as Hex;

registerMigration(x402PayerCooldownsMigration);
const database = PGlite.create('memory://').then(async (db) => {
  await runMigrations(db);
  return db;
});
after(async () => (await database).close());

async function fresh(now: number) {
  const db = await database;
  await db.query('DELETE FROM x402_payer_cooldowns');
  return { db, clock: { now } };
}

const rowsOf = async (db: PGlite) =>
  (
    await db.query<{ lane: string; payer: string; until_ms: string }>(
      'SELECT lane, payer, until_ms::text AS until_ms FROM x402_payer_cooldowns ORDER BY lane, payer',
    )
  ).rows;

const LANES = [
  ['the public settle lane', publicSettleCooldown],
  ['the public offer lane', publicOfferCooldown],
] as const;

for (const [name, build] of LANES) {
  test(`${name}: a revert at xx:59 still cools 59 minutes later and is over after an hour`, async () => {
    const reverted = START + HOUR - MINUTE;
    const { db, clock } = await fresh(reverted);
    const cooldown = build(db, () => clock.now);
    assert.equal(await cooldown.cooling(address('08')), false);
    await cooldown.record(address('08'));
    assert.equal(await cooldown.cooling(address('08')), true);
    assert.equal(await cooldown.cooling(address('09')), false, 'another payer');
    clock.now = reverted + 59 * MINUTE;
    assert.equal(await cooldown.cooling(address('08')), true, 'past the full hour, still cooling');
    clock.now = reverted + HOUR - 1;
    assert.equal(await cooldown.cooling(address('08')), true);
    clock.now = reverted + HOUR;
    assert.equal(await cooldown.cooling(address('08')), false);
  });

  test(`${name}: two instances share it, in any case of the address`, async () => {
    const { db, clock } = await fresh(START);
    const here = build(db, () => clock.now);
    const there = build(db, () => clock.now);
    await here.record(address('ab'));
    assert.equal(await there.cooling(address('ab')), true);
    assert.equal(await there.cooling(address('ab').toLowerCase() as Hex), true);
    const [row] = await rowsOf(db);
    assert.equal(row!.payer, address('ab').toLowerCase());
  });

  test(`${name}: a later revert restarts the hour, and an earlier clock never shortens it`, async () => {
    const { db, clock } = await fresh(START);
    const cooldown = build(db, () => clock.now);
    await cooldown.record(address('0c'));
    clock.now = START + 30 * MINUTE;
    await cooldown.record(address('0c'));
    clock.now = START + HOUR;
    assert.equal(await cooldown.cooling(address('0c')), true, 'an hour from the second revert');
    // Another instance's clock, behind this one.
    await build(db, () => START).record(address('0c'));
    clock.now = START + 90 * MINUTE - 1;
    assert.equal(await cooldown.cooling(address('0c')), true);
    clock.now = START + 90 * MINUTE;
    assert.equal(await cooldown.cooling(address('0c')), false);
    assert.equal((await rowsOf(db)).length, 1);
  });

  test(`${name}: an outage reads as cooling, and a failed record does not throw and names no address`, async () => {
    const down = {
      query: async () => {
        throw new Error('Synthetic outage');
      },
    };
    const lines: string[] = [];
    const cooldown = build(
      down as unknown as PGlite,
      () => START,
      (line) => lines.push(line),
    );
    assert.equal(await cooldown.cooling(address('0b')), true);
    await cooldown.record(address('0b'));
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /x402_cooldown\.record_failed/);
    assert.doesNotMatch(lines[0]!.toLowerCase(), new RegExp(address('0b').toLowerCase()));
  });
}

test('the lanes are separate: a revert on one does not cool the other', async () => {
  const { db, clock } = await fresh(START);
  const settle = publicSettleCooldown(db, () => clock.now);
  const offer = publicOfferCooldown(db, () => clock.now);
  await settle.record(address('0d'));
  assert.equal(await offer.cooling(address('0d')), false);
  await offer.record(address('0e'));
  assert.equal(await settle.cooling(address('0e')), false);
});

test('the sweep deletes only what has ended, at most its batch, and a swept payer is not cooling', async () => {
  const { db, clock } = await fresh(START);
  const cooldown = publicOfferCooldown(db, () => clock.now);
  await db.query(
    `INSERT INTO x402_payer_cooldowns (lane, payer, until_ms)
     SELECT 'x402-settle', 'p' || n, $1::bigint FROM generate_series(1, $2::int) AS n`,
    [START, PAYER_COOLDOWN_SWEEP_MAX + 3],
  );
  await cooldown.record(address('0f'));
  assert.equal(await sweepPayerCooldowns(db, clock.now), PAYER_COOLDOWN_SWEEP_MAX);
  assert.equal(await sweepPayerCooldowns(db, clock.now), 3);
  assert.equal(await sweepPayerCooldowns(db, clock.now), 0);
  assert.equal(await cooldown.cooling(address('0f')), true, 'still running, kept');
  clock.now = START + HOUR;
  assert.equal(await sweepPayerCooldowns(db, clock.now), 1);
  assert.deepEqual(await rowsOf(db), []);
});

test('the app migrates the table as version 357, with its index', async (t) => {
  const app = await createApp({ dataDir: 'memory://', startWorkers: false });
  t.after(() => app.close());
  const applied = await app.city.db.query<{ name: string }>(
    'SELECT name FROM schema_migrations WHERE version = 357',
  );
  assert.equal(applied.rows[0]?.name, 'x402_payer_cooldowns');
  const indexes = await app.city.db.query<{ indexname: string }>(
    `SELECT indexname FROM pg_indexes WHERE tablename = 'x402_payer_cooldowns' ORDER BY indexname`,
  );
  assert.deepEqual(
    indexes.rows.map((row) => row.indexname),
    ['x402_payer_cooldowns_pkey', 'x402_payer_cooldowns_until'],
  );
});
