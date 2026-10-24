import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import Fastify from 'fastify';
import { PGlite } from '@electric-sql/pglite';
import type { Database } from '../server/database.js';
import {
  FEED_PAY_SPONSOR_KEY_SQL,
  registerSponsorKeyRoute,
  SFP_SPONSOR_KEY_PATH,
} from '../server/feed/pay/sponsor-key.js';
import { X402_FACILITATOR_SQL } from '../server/protocol/x402/facilitator-schema.js';

// POST /api/ops/sfp/sponsor-key (server/feed/pay/sponsor-key.ts): the sponsor account's key,
// created inside the app behind the ops secret, idempotently, in its own table.

const SECRET = 'o'.repeat(40);
const KEK = `v1:${randomBytes(32).toString('base64')}`;

async function setup(
  t: { after: (fn: () => Promise<unknown>) => void },
  env: Record<string, string>,
) {
  const pg = await PGlite.create('memory://');
  t.after(() => pg.close());
  await pg.exec(`CREATE TABLE base_spender_keys (
    key_id text PRIMARY KEY, kek_version integer NOT NULL, wrapped_dek bytea NOT NULL,
    ciphertext bytea NOT NULL, signer_address text NOT NULL, committed_at bigint,
    created_at bigint NOT NULL)`);
  await pg.exec(X402_FACILITATOR_SQL);
  await pg.exec(FEED_PAY_SPONSOR_KEY_SQL);
  const db = {
    query: (sql: string, params?: unknown[]) => pg.query(sql, params) as never,
    exec: (sql: string) => pg.exec(sql),
    transaction: (action: (tx: never) => Promise<unknown>) =>
      pg.transaction((tx) => action(tx as never)),
    close: () => pg.close(),
  } as unknown as Database;
  const app = Fastify();
  registerSponsorKeyRoute(app, { db, env });
  t.after(() => app.close());
  return { app, pg };
}

const post = (app: Awaited<ReturnType<typeof setup>>['app'], authorization?: string) =>
  app.inject({
    method: 'POST',
    url: SFP_SPONSOR_KEY_PATH,
    headers: authorization ? { authorization } : {},
  });

test('sponsor key: 404 without the ops secret, nothing created', async (t) => {
  const { app, pg } = await setup(t, { CITY_OPS_SECRET: SECRET, CITY_BASE_SPENDER_KEK: KEK });
  for (const authorization of [undefined, 'Bearer wrong'])
    assert.equal((await post(app, authorization)).statusCode, 404);
  const n = await pg.query<{ n: number }>('SELECT count(*)::int AS n FROM base_spender_keys');
  assert.equal(n.rows[0]!.n, 0);
});

test('sponsor key: one committed key in its own table, retries answer it, facilitator key untouched', async (t) => {
  const { app, pg } = await setup(t, { CITY_OPS_SECRET: SECRET, CITY_BASE_SPENDER_KEK: KEK });
  const first = await post(app, `Bearer ${SECRET}`);
  assert.equal(first.statusCode, 200);
  assert.equal(first.headers['cache-control'], 'no-store');
  const body = first.json() as { address: string; keyRef: string };
  assert.deepEqual(Object.keys(body).sort(), ['address', 'keyRef']);
  const again = await post(app, `Bearer ${SECRET}`);
  assert.deepEqual(again.json(), body);
  const keys = await pg.query<{ signer_address: string; committed_at: string | null }>(
    'SELECT signer_address, committed_at FROM base_spender_keys',
  );
  assert.equal(keys.rows.length, 1);
  assert.equal(keys.rows[0]!.signer_address.toLowerCase(), body.address.toLowerCase());
  assert.notEqual(keys.rows[0]!.committed_at, null);
  const facilitator = await pg.query('SELECT 1 FROM x402_facilitator_key');
  assert.equal(facilitator.rows.length, 0, 'the router-3 facilitator key is never touched');
});

test('sponsor key: 409 once configured, 503 without a keystore', async (t) => {
  const configured = await setup(t, {
    CITY_OPS_SECRET: SECRET,
    CITY_BASE_SPENDER_KEK: KEK,
    CITY_SFP_SPONSOR_KEY_REF: 'v1:x',
  });
  assert.equal((await post(configured.app, `Bearer ${SECRET}`)).statusCode, 409);
  const nokek = await setup(t, { CITY_OPS_SECRET: SECRET });
  assert.equal((await post(nokek.app, `Bearer ${SECRET}`)).statusCode, 503);
});
