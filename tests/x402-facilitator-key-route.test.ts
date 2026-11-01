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
  X402_FACILITATOR_KEY_ARC_PURPOSE_SQL,
  X402_FACILITATOR_KEY_PURPOSES_SQL,
  X402_FACILITATOR_SQL,
  x402FacilitatorKeyArcPurposeMigration,
} from '../server/protocol/x402/facilitator-schema.js';
import { X402_FACILITATOR_KEY_PUBLIC_OFFER_SQL } from '../server/feed/pay/public-calls-schema.js';

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
  await pg.exec(X402_FACILITATOR_KEY_PURPOSES_SQL);
  await pg.exec(`BEGIN;${X402_FACILITATOR_KEY_ARC_PURPOSE_SQL}COMMIT;`);
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

const postFor = (app: Awaited<ReturnType<typeof setup>>['app'], purpose: string) =>
  app.inject({
    method: 'POST',
    url: `${FACILITATOR_KEY_PATH}?purpose=${purpose}`,
    headers: { authorization: `Bearer ${SECRET}` },
  });

test('public-settle: its own key and address, never the router 3 one; idempotent per purpose', async (t) => {
  const { app, pg } = await setup(t, { CITY_OPS_SECRET: SECRET, CITY_BASE_SPENDER_KEK: KEK });
  const router3 = (await post(app)).json() as { address: string; keyRef: string };
  const pub = await postFor(app, 'public-settle');
  assert.equal(pub.statusCode, 200);
  const body = pub.json() as { address: string; keyRef: string };
  assert.notEqual(body.address.toLowerCase(), router3.address.toLowerCase());
  assert.notEqual(body.keyRef, router3.keyRef);
  assert.deepEqual((await postFor(app, 'public-settle')).json(), body, 'a retry answers the same');
  assert.deepEqual((await post(app)).json(), router3, 'router 3 unchanged');
  assert.equal(await committed(pg), 2);
});

test('public-offer: its own key and address, apart from the other two', async (t) => {
  const { app, pg } = await setup(t, { CITY_OPS_SECRET: SECRET, CITY_BASE_SPENDER_KEK: KEK });
  await pg.exec(X402_FACILITATOR_KEY_PUBLIC_OFFER_SQL);
  const router3 = (await post(app)).json() as { address: string };
  const settle = (await postFor(app, 'public-settle')).json() as { address: string };
  const offer = await postFor(app, 'public-offer');
  assert.equal(offer.statusCode, 200);
  const body = offer.json() as { address: string };
  assert.notEqual(body.address.toLowerCase(), router3.address.toLowerCase());
  assert.notEqual(body.address.toLowerCase(), settle.address.toLowerCase());
  assert.deepEqual((await postFor(app, 'public-offer')).json(), body, 'a retry answers the same');
});

test('public-settle is refused (409) once its own key ref is set; router 3 setting does not block it', async (t) => {
  const blocked = await setup(t, {
    CITY_OPS_SECRET: SECRET,
    CITY_BASE_SPENDER_KEK: KEK,
    CITY_X402_PUBLIC_SETTLE_KEY_REF: 'v1:x',
  });
  assert.equal((await postFor(blocked.app, 'public-settle')).statusCode, 409);
  const other = await setup(t, {
    CITY_OPS_SECRET: SECRET,
    CITY_BASE_SPENDER_KEK: KEK,
    CITY_X402_FACILITATOR_KEY_REF: 'v1:y',
  });
  assert.equal((await postFor(other.app, 'public-settle')).statusCode, 200);
  assert.equal((await post(other.app)).statusCode, 409);
});

test("arc-router3: its own key and address, never Base's; idempotent; concurrent calls answer one key", async (t) => {
  const { app, pg } = await setup(t, { CITY_OPS_SECRET: SECRET, CITY_BASE_SPENDER_KEK: KEK });
  const router3 = (await post(app)).json() as { address: string; keyRef: string };
  const settle = (await postFor(app, 'public-settle')).json() as { address: string };
  const [one, two] = await Promise.all([postFor(app, 'arc-router3'), postFor(app, 'arc-router3')]);
  assert.equal(one.statusCode, 200);
  assert.equal(two.statusCode, 200);
  const body = one.json() as { address: string; keyRef: string };
  assert.deepEqual(Object.keys(body).sort(), ['address', 'keyRef']);
  assert.deepEqual(two.json(), body);
  assert.equal(one.headers['cache-control'], 'no-store');
  for (const other of [router3.address, settle.address])
    assert.notEqual(body.address.toLowerCase(), other.toLowerCase());
  assert.deepEqual((await postFor(app, 'arc-router3')).json(), body, 'a retry answers the same');
  assert.deepEqual((await post(app)).json(), router3, 'router 3 unchanged');
  assert.equal(await committed(pg), 3);
});

test('arc-router3: only its own setting blocks it (409), and it blocks only itself; 404 without the secret', async (t) => {
  const blocked = await setup(t, {
    CITY_OPS_SECRET: SECRET,
    CITY_BASE_SPENDER_KEK: KEK,
    CITY_ARC_FACILITATOR_KEY_REF: 'v1:x',
  });
  assert.equal((await postFor(blocked.app, 'arc-router3')).statusCode, 409);
  assert.equal((await post(blocked.app)).statusCode, 200, 'router 3 not blocked');
  assert.equal((await postFor(blocked.app, 'public-settle')).statusCode, 200);
  const base = await setup(t, {
    CITY_OPS_SECRET: SECRET,
    CITY_BASE_SPENDER_KEK: KEK,
    CITY_X402_FACILITATOR_KEY_REF: 'v1:y',
    CITY_X402_PUBLIC_SETTLE_KEY_REF: 'v1:z',
  });
  assert.equal((await postFor(base.app, 'arc-router3')).statusCode, 200);
  const denied = await base.app.inject({
    method: 'POST',
    url: `${FACILITATOR_KEY_PATH}?purpose=arc-router3`,
    headers: { authorization: 'Bearer wrong' },
  });
  assert.equal(denied.statusCode, 404);
});

test('migration 352: exact statements, keeps what is there, allows only the new purpose', async (t) => {
  assert.equal(x402FacilitatorKeyArcPurposeMigration.version, 352);
  assert.equal(
    X402_FACILITATOR_KEY_ARC_PURPOSE_SQL.trim(),
    [
      "SET LOCAL lock_timeout = '2s';",
      'ALTER TABLE x402_facilitator_key DROP CONSTRAINT IF EXISTS x402_facilitator_key_purpose_check;',
      "ALTER TABLE x402_facilitator_key ADD CONSTRAINT x402_facilitator_key_purpose_check CHECK (purpose IN ('router3', 'public-settle', 'arc-router3')) NOT VALID;",
    ].join('\n'),
  );
  const pg = await PGlite.create('memory://');
  t.after(() => pg.close());
  await pg.exec(X402_FACILITATOR_SQL);
  await pg.exec(X402_FACILITATOR_KEY_PURPOSES_SQL);
  const insert = (purpose: string) =>
    pg.query(
      `INSERT INTO x402_facilitator_key (purpose, key_ref, address, created_at) VALUES ($1, $2, '0x${'a'.repeat(40)}', 1)`,
      [purpose, `ref-${purpose}`],
    );
  await insert('router3');
  await assert.rejects(insert('arc-router3'), /purpose_check/, 'not before the migration');
  await pg.exec(`BEGIN;${X402_FACILITATOR_KEY_ARC_PURPOSE_SQL}COMMIT;`);
  await pg.exec(`BEGIN;${X402_FACILITATOR_KEY_ARC_PURPOSE_SQL}COMMIT;`); // Runs again harmlessly.
  await insert('public-settle');
  await insert('arc-router3');
  await assert.rejects(insert('sponsor'), /purpose_check/);
  const rows = await pg.query<{ purpose: string }>(
    'SELECT purpose FROM x402_facilitator_key ORDER BY purpose',
  );
  assert.deepEqual(
    rows.rows.map((row) => row.purpose),
    ['arc-router3', 'public-settle', 'router3'],
  );
});

test('an unknown purpose is refused (400) and creates nothing', async (t) => {
  const { app, pg } = await setup(t, { CITY_OPS_SECRET: SECRET, CITY_BASE_SPENDER_KEK: KEK });
  assert.equal((await postFor(app, 'sponsor')).statusCode, 400);
  const rows = await pg.query<{ n: number }>('SELECT count(*)::int AS n FROM base_spender_keys');
  assert.equal(rows.rows[0]!.n, 0);
});
