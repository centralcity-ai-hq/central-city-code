import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { createApp } from '../server/app.js';
import { ROOM_RELABEL_PATH, runRoomRelabelOnce } from '../server/rooms/relabel-job.js';

process.env.CITY_RATE_LIMIT_KEY ??= 'synthetic-room-relabel-job-test-root-secret-000';
process.env.CRON_SECRET ??= 'synthetic-room-relabel-job-cron-secret';

/**
 * The one-time owner relabel run by the server on production (server/rooms/relabel-job.ts): it
 * applies once, records its counts, and is skipped from then on. The cron route is closed without
 * the cron bearer. Synthetic data only (the relabel itself: relabel-room-owners.test.ts).
 */
const ORIGIN = 'https://centralcity.ai';

async function fixture(t: { after(fn: () => unknown): void }) {
  const app = await createApp({
    database: await PGlite.create('memory://'),
    hosted: {
      databaseUrl: 'postgres://unused.invalid/test',
      publicOrigin: ORIGIN,
      allowedOrigins: [ORIGIN],
    },
    startWorkers: false,
  });
  t.after(() => app.close());
  return app;
}

test('the relabel job applies once, records its counts, then is skipped', async (t) => {
  const app = await fixture(t);
  const db = app.city.db as Parameters<typeof runRoomRelabelOnce>[0];
  const secret = process.env.CITY_RATE_LIMIT_KEY!;
  const first = await runRoomRelabelOnce(db, secret, () => 1_000);
  assert.equal(first.skipped, false);
  assert.equal(first.skipped === false && first.counts.mode, 'applied');
  const stored = (
    await db.query<{ finished_at: string | number; counts: { mode: string } }>(
      'SELECT finished_at, counts FROM room_relabel_runs',
    )
  ).rows;
  assert.equal(stored.length, 1);
  assert.equal(Number(stored[0]!.finished_at), 1_000);
  assert.equal(stored[0]!.counts.mode, 'applied');
  const second = await runRoomRelabelOnce(db, secret, () => 2_000);
  assert.deepEqual(second, { skipped: true, finished_at: 1_000 });
});

test('the relabel cron route needs the cron bearer, runs once, and is scheduled', async (t) => {
  const app = await fixture(t);
  const call = (authorization?: string) =>
    app.inject({
      method: 'GET',
      url: ROOM_RELABEL_PATH,
      headers: { host: 'centralcity.ai', ...(authorization ? { authorization } : {}) },
    });
  for (const authorization of [undefined, 'Bearer wrong'])
    assert.equal((await call(authorization)).statusCode, 404);
  const first = await call(`Bearer ${process.env.CRON_SECRET}`);
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(first.json().skipped, false);
  assert.equal(first.json().counts.mode, 'applied');
  assert.equal((await call(`Bearer ${process.env.CRON_SECRET}`)).json().skipped, true);
  const vercel = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8')) as {
    crons: Array<{ path: string; schedule: string }>;
  };
  assert.ok(vercel.crons.some((cron) => cron.path === ROOM_RELABEL_PATH));
});
