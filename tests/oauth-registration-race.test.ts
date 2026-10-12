import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test, type TestContext } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import { createApp } from '../server/app.js';
import { postgresDatabase, type Database } from '../server/database.js';
import { CLIENT_REGISTRATION_LOCK_KEY, OAUTH_CAPS } from '../server/oauth/server.js';

/*
 * The dynamic client registration bound under concurrency (server.ts /oauth/register): every
 * registration takes CLIENT_REGISTRATION_LOCK_KEY first, so the count, eviction and insert of one
 * registration never interleave with another's. On PGlite (one connection, statements serialize)
 * and, with CITY_TEST_POSTGRES_URL set (CI: postgres-races), on a real PostgreSQL pool where every
 * registration has its own session. Synthetic values only.
 */
process.env.CITY_RATE_LIMIT_KEY ??= 'synthetic-registration-race-root-stand-in-secret';

const POSTGRES = process.env.CITY_TEST_POSTGRES_URL;
const ORIGIN = 'https://centralcity.ai';
const REDIRECT = 'http://127.0.0.1:43123/callback';
/** Simulated round trip per statement, so unserialized registrations would interleave. */
const DELAY_MS = 3;
const CONCURRENT = 8;

interface Backend {
  db: Database | PGlite;
  pool?: pg.Pool;
}

async function backend(t: TestContext): Promise<Backend> {
  if (!POSTGRES) return { db: await PGlite.create('memory://') };
  const name = `city_test_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Pool({ connectionString: POSTGRES, max: 1 });
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(POSTGRES);
  url.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: url.toString(), max: CONCURRENT + 4 });
  pool.on('error', () => {});
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.end();
  });
  return { db: withLatency({ ...postgresDatabase(pool), close: async () => {} }), pool };
}

function withLatency(db: Database): Database {
  const wait = () => new Promise((resolve) => setTimeout(resolve, DELAY_MS));
  const slow =
    (query: Database['query']): Database['query'] =>
    async (sql, params) => {
      await wait();
      return query(sql, params);
    };
  return {
    ...db,
    query: slow(db.query),
    transaction: (action) => db.transaction((tx) => action({ ...tx, query: slow(tx.query) })),
  };
}

async function setup(t: TestContext, wrap: (db: Database) => Database = (db) => db) {
  const { db, pool } = await backend(t);
  const app = await createApp({
    database: wrap(db as Database),
    hosted: {
      databaseUrl: 'postgres://unused.invalid/test',
      publicOrigin: ORIGIN,
      allowedOrigins: [ORIGIN],
    },
    startWorkers: false,
  });
  t.after(() => app.close());
  let address = 0;
  const register = () =>
    app.inject({
      method: 'POST',
      url: '/oauth/register',
      headers: { 'content-type': 'application/json', host: 'centralcity.ai' },
      payload: JSON.stringify({ client_name: 'Synthetic MCP client', redirect_uris: [REDIRECT] }),
      remoteAddress: `198.51.100.${++address}`,
    });
  /** Fills the table to `rows` never-used (so evictable) clients, oldest first. */
  const fill = async (rows: number) => {
    const now = Date.now();
    await app.city.db.query(
      `INSERT INTO oauth_clients(client_id,client_name,redirect_uris,created_at)
       SELECT 'ccc_filler_' || lpad(i::text, 5, '0'), 'n', $1::jsonb, $2::bigint - 100000 + i
       FROM generate_series(0, $3::int - 1) AS i`,
      [JSON.stringify([REDIRECT]), now, rows],
    );
  };
  const clients = async () =>
    (
      await app.city.db.query<{ client_id: string }>(
        'SELECT client_id FROM oauth_clients ORDER BY client_id',
      )
    ).rows.map((row) => row.client_id);
  return { app, pool, register, fill, clients };
}

test('registration takes the capacity lock before it counts or writes', async (t) => {
  const statements: string[][] = [];
  const { register } = await setup(t, (db) => ({
    // Bound explicitly: PGlite's methods live on its prototype, which a spread drops.
    query: (sql, params) => db.query(sql, params),
    exec: (sql) => db.exec(sql),
    close: () => db.close(),
    transaction: (action) =>
      db.transaction((tx) => {
        const seen: string[] = [];
        statements.push(seen);
        return action({
          ...tx,
          query: (sql, params) => {
            seen.push(`${sql} ${JSON.stringify(params ?? [])}`);
            return tx.query(sql, params);
          },
        });
      }),
  }));
  const res = await register();
  assert.equal(res.statusCode, 201, res.body);
  const registration = statements.find((seen) =>
    seen.some((sql) => sql.includes('INSERT INTO oauth_clients')),
  );
  assert.ok(registration, 'registration transaction not seen');
  assert.equal(
    registration[0],
    `SELECT pg_advisory_xact_lock($1::bigint) ${JSON.stringify([CLIENT_REGISTRATION_LOCK_KEY])}`,
  );
});

test('concurrent registrations at capacity - 1 never overrun the client bound', async (t) => {
  const { register, fill, clients } = await setup(t);
  await fill(OAUTH_CAPS.clients - 1);
  const results = await Promise.all(Array.from({ length: CONCURRENT }, () => register()));
  for (const res of results) assert.equal(res.statusCode, 201, res.body);
  const ids = await clients();
  // One fills the last slot; each later one evicts exactly the oldest unused filler.
  assert.equal(ids.length, OAUTH_CAPS.clients);
  for (const res of results)
    assert.ok(ids.includes((res.json() as { client_id: string }).client_id));
  for (let i = 0; i < CONCURRENT - 1; i++)
    assert.ok(!ids.includes(`ccc_filler_${String(i).padStart(5, '0')}`), `filler ${i} kept`);
  assert.ok(ids.includes(`ccc_filler_${String(CONCURRENT - 1).padStart(5, '0')}`));
});

test(
  'a held capacity lock holds registration back on PostgreSQL',
  { skip: POSTGRES ? false : 'CITY_TEST_POSTGRES_URL not set' },
  async (t) => {
    const { register, pool, clients } = await setup(t);
    const holder = await pool!.connect();
    holder.on('error', () => {});
    let released = false;
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT pg_advisory_xact_lock($1::bigint)', [
        CLIENT_REGISTRATION_LOCK_KEY,
      ]);
      let done = false;
      const pending = register().then((res) => {
        done = true;
        return res;
      });
      await new Promise((resolve) => setTimeout(resolve, 500));
      assert.equal(done, false, 'registration ran while the capacity lock was held');
      assert.deepEqual(await clients(), []);
      await holder.query('COMMIT');
      holder.release();
      released = true;
      const res = await pending;
      assert.equal(res.statusCode, 201, res.body);
      assert.equal((await clients()).length, 1);
    } finally {
      if (!released) {
        await holder.query('ROLLBACK').catch(() => {});
        holder.release(true);
      }
    }
  },
);
