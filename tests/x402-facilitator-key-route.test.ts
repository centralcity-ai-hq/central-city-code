import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import Fastify from 'fastify';
import { PGlite } from '@electric-sql/pglite';
import type { Database } from '../server/database.js';
import { createKeystore, parseKeks } from '../server/base/chain/keystore.js';
import { pgSpenderKeyStore } from '../server/base/chain/stores.js';
import {
  FACILITATOR_KEY_PATH,
  registerFacilitatorKeyRoute,
} from '../server/protocol/x402/facilitator-key-route.js';
import {
  X402_FACILITATOR_BATCH_SQL,
  X402_FACILITATOR_SQL,
} from '../server/protocol/x402/facilitator-schema.js';

// POST /api/ops/x402/facilitator-key (server/protocol/x402/facilitator-key-route.ts): creates the
// facilitator key inside the app, behind the ops secret, idempotently (one recorded key, retries
// and concurrent calls answer it); answers address + keyRef only.

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
  await pg.exec(X402_FACILITATOR_BATCH_SQL);
  const db = {
    query: (sql: string, params?: unknown[]) => pg.query(sql, params) as never,
    exec: (sql: string) => pg.exec(sql),
    transaction: (action: (tx: never) => Promise<unknown>) =>
      pg.transaction((tx) => action(tx as never)),
    close: () => pg.close(),
  } as unknown as Database;
  const app = Fastify();
  registerFacilitatorKeyRoute(app, { db, env });
  t.after(() => app.close());
  return { app, db, pg };
}

test('without the ops secret: 404, nothing created', async (t) => {
  const { app, pg } = await setup(t, { CITY_OPS_SECRET: SECRET, CITY_BASE_SPENDER_KEK: KEK });
  for (const authorization of [undefined, 'Bearer wrong', `Bearer ${SECRET}x`]) {
    const res = await app.inject({
      method: 'POST',
      url: FACILITATOR_KEY_PATH,
      headers: authorization ? { authorization } : {},
    });
    assert.equal(res.statusCode, 404);
  }
  const rows = await pg.query('SELECT count(*)::int AS n FROM base_spender_keys');
  assert.equal((rows.rows[0] as { n: number }).n, 0);
});

test('with the ops secret: one committed key, answers address and keyRef only, no-store', async (t) => {
  const { app, db, pg } = await setup(t, { CITY_OPS_SECRET: SECRET, CITY_BASE_SPENDER_KEK: KEK });
  const res = await app.inject({
    method: 'POST',
    url: FACILITATOR_KEY_PATH,
    headers: { authorization: `Bearer ${SECRET}` },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['cache-control'], 'no-store');
  const body = res.json() as { address: string; keyRef: string };
  assert.deepEqual(Object.keys(body).sort(), ['address', 'keyRef']);
  assert.match(body.address, /^0x[0-9a-fA-F]{40}$/);
  const row = (
    await pg.query<{ signer_address: string; committed_at: string | null }>(
      'SELECT signer_address, committed_at FROM base_spender_keys',
    )
  ).rows;
  assert.equal(row.length, 1);
  assert.equal(row[0]!.signer_address.toLowerCase(), body.address.toLowerCase());
  assert.notEqual(row[0]!.committed_at, null, 'committed at once (never cleaned up as an orphan)');
  // The key signs as that address through the keystore.
  const keystore = createKeystore({ store: pgSpenderKeyStore(db), keks: parseKeks(KEK) });
  const signer = await keystore.withSigner(body.keyRef, async (account) => account.address);
  assert.equal(signer.toLowerCase(), body.address.toLowerCase());
});

const post = (app: Awaited<ReturnType<typeof setup>>['app']) =>
  app.inject({
    method: 'POST',
    url: FACILITATOR_KEY_PATH,
    headers: { authorization: `Bearer ${SECRET}` },
  });
const committed = async (pg: PGlite) =>
  (
    await pg.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM base_spender_keys WHERE committed_at IS NOT NULL',
    )
  ).rows[0]!.n;

test('a retry (lost response) answers the same address and keyRef; still one committed key', async (t) => {
  const { app, pg } = await setup(t, { CITY_OPS_SECRET: SECRET, CITY_BASE_SPENDER_KEK: KEK });
  const first = (await post(app)).json();
  const again = (await post(app)).json();
  const third = (await post(app)).json();
  assert.deepEqual(again, first);
  assert.deepEqual(third, first);
  assert.equal(await committed(pg), 1);
  const keys = await pg.query<{ n: number }>('SELECT count(*)::int AS n FROM base_spender_keys');
  assert.equal(keys.rows[0]!.n, 1, 'a retry creates no new key at all');
});

test('concurrent calls before the env is set all answer the one winning key; losers stay uncommitted', async (t) => {
  const { app, pg } = await setup(t, { CITY_OPS_SECRET: SECRET, CITY_BASE_SPENDER_KEK: KEK });
  const answers = (await Promise.all(Array.from({ length: 6 }, () => post(app)))).map((res) => {
    assert.equal(res.statusCode, 200);
    return res.json() as { address: string; keyRef: string };
  });
  assert.equal(new Set(answers.map((a) => a.keyRef)).size, 1);
  assert.equal(new Set(answers.map((a) => a.address)).size, 1);
  assert.equal(await committed(pg), 1);
  const winner = await pg.query<{ signer_address: string }>(
    'SELECT signer_address FROM base_spender_keys WHERE committed_at IS NOT NULL',
  );
  assert.equal(winner.rows[0]!.signer_address.toLowerCase(), answers[0]!.address.toLowerCase());
});

test('refused (409) once a facilitator key is configured', async (t) => {
  const { app } = await setup(t, {
    CITY_OPS_SECRET: SECRET,
    CITY_BASE_SPENDER_KEK: KEK,
    CITY_X402_FACILITATOR_KEY_REF: 'v1:already-set',
  });
  const res = await app.inject({
    method: 'POST',
    url: FACILITATOR_KEY_PATH,
    headers: { authorization: `Bearer ${SECRET}` },
  });
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().code, 'facilitator_key_configured');
});
