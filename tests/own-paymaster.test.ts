import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import Fastify from 'fastify';
import { PGlite } from '@electric-sql/pglite';
import { hashMessage, recoverAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { Database } from '../server/database.js';
import {
  paymasterHash,
  paymasterPrefix,
  paymasterStub,
  signPaymasterData,
} from '../server/base/chain/own-paymaster.js';
import {
  OWN_PAYMASTER_KEYS_SQL,
  PAYMASTER_KEYS_PATH,
  PAYMASTER_PUBLIC_PATH,
  provisionPaymasterKeys,
  provisionPaymasterKeysAtStart,
  registerOwnPaymasterKeysRoute,
  registerPaymasterPublicRoute,
} from '../server/base/chain/own-paymaster-keys.js';
import {
  SPONSOR_DATA_BYTES,
  sponsoredValidUntil,
  sponsoredWithoutCharge,
} from '../shared/base/paymasters.js';

// Operation Paymaster: our VerifyingPaymaster's off-chain half (server/base/chain/own-paymaster.ts)
// and its key provisioning route (own-paymaster-keys.ts).

const COINBASE_PM = '0x2FAEB0760D4230Ef2aC21496Bb4F0b47D634FD4c' as const;
const OP = {
  sender: '0x904B9CC316BbD202c5Bb6580D6171f9D69435787',
  nonce: 123456789n,
  initCode: '0x',
  callData: `0xb61d27f6${'00'.repeat(96)}`,
  callGasLimit: 210_000n,
  verificationGasLimit: 410_000n,
  preVerificationGas: 61_000n,
  maxFeePerGas: 9_000_000n,
  maxPriorityFeePerGas: 1_000_000n,
  paymasterAndData: '0x',
  signature: '0x',
} as const;
const FIELDS = { validUntil: 1792800000, validAfter: 1792799000, sponsorUUID: 0xdeadbeefn };

test('paymasterHash equals the contract getHash (vectors read from Coinbase 0x2FAEB076 on Base, 23 Oct 2026)', () => {
  // Provenance: eth_call getHash(userOp, paymasterData) on Base mainnet (chain 8453), block 'latest'
  // on 23 Oct 2026 ~19:00 UTC, against 0x2FAEB0760D4230Ef2aC21496Bb4F0b47D634FD4c, Coinbase's
  // VerifyingPaymaster v1.0.0 (Sourcify exact match, the creation code we deploy). getHash is a pure
  // function of its inputs, chainid and address(this), so the vectors do not depend on the block.
  assert.equal(
    paymasterHash(OP as never, { chainId: 8453, paymaster: COINBASE_PM, fields: FIELDS }),
    '0x51c47206109f41c6514c3b583c747eba076414fd3b0104411d8ae2107b755a03',
  );
  // With initCode (a wallet deployment), batch callData and a 2-D nonce key.
  const withInit = {
    ...OP,
    nonce: 123456789n + (1n << 64n),
    initCode: '0x0ba5ed0c6aa8c49038f819e587e2633c4a9f428aabcdef',
    callData: `0x34fcd5be${'11'.repeat(200)}`,
  };
  assert.equal(
    paymasterHash(withInit as never, {
      chainId: 8453,
      paymaster: COINBASE_PM,
      fields: { validUntil: 1792800001, validAfter: 1792799000, sponsorUUID: 0xdeadbef0n },
    }),
    '0x446431c8fd94d0dc6f61e5ef6c35ea09bfb20302ef00a6983dcdc592cc6c36b4',
  );
});

test('paymasterHash binds every field getHash reads (mutation test)', () => {
  const base = paymasterHash(OP as never, {
    chainId: 8453,
    paymaster: COINBASE_PM,
    fields: FIELDS,
  });
  const mutations: Array<[string, () => string]> = [
    [
      'sender',
      () =>
        paymasterHash({ ...OP, sender: '0x0000000000000000000000000000000000000001' } as never, {
          chainId: 8453,
          paymaster: COINBASE_PM,
          fields: FIELDS,
        }),
    ],
    [
      'nonce',
      () =>
        paymasterHash({ ...OP, nonce: OP.nonce + 1n } as never, {
          chainId: 8453,
          paymaster: COINBASE_PM,
          fields: FIELDS,
        }),
    ],
    [
      'initCode',
      () =>
        paymasterHash({ ...OP, initCode: '0x01' } as never, {
          chainId: 8453,
          paymaster: COINBASE_PM,
          fields: FIELDS,
        }),
    ],
    [
      'callData',
      () =>
        paymasterHash({ ...OP, callData: '0x01' } as never, {
          chainId: 8453,
          paymaster: COINBASE_PM,
          fields: FIELDS,
        }),
    ],
    [
      'callGasLimit',
      () =>
        paymasterHash({ ...OP, callGasLimit: 1n } as never, {
          chainId: 8453,
          paymaster: COINBASE_PM,
          fields: FIELDS,
        }),
    ],
    [
      'verificationGasLimit',
      () =>
        paymasterHash({ ...OP, verificationGasLimit: 1n } as never, {
          chainId: 8453,
          paymaster: COINBASE_PM,
          fields: FIELDS,
        }),
    ],
    [
      'preVerificationGas',
      () =>
        paymasterHash({ ...OP, preVerificationGas: 1n } as never, {
          chainId: 8453,
          paymaster: COINBASE_PM,
          fields: FIELDS,
        }),
    ],
    [
      'maxFeePerGas',
      () =>
        paymasterHash({ ...OP, maxFeePerGas: 1n } as never, {
          chainId: 8453,
          paymaster: COINBASE_PM,
          fields: FIELDS,
        }),
    ],
    [
      'maxPriorityFeePerGas',
      () =>
        paymasterHash({ ...OP, maxPriorityFeePerGas: 1n } as never, {
          chainId: 8453,
          paymaster: COINBASE_PM,
          fields: FIELDS,
        }),
    ],
    [
      'chainId',
      () => paymasterHash(OP as never, { chainId: 84532, paymaster: COINBASE_PM, fields: FIELDS }),
    ],
    [
      'paymaster',
      () =>
        paymasterHash(OP as never, {
          chainId: 8453,
          paymaster: '0x0000000000000000000000000000000000000002',
          fields: FIELDS,
        }),
    ],
    [
      'validUntil',
      () =>
        paymasterHash(OP as never, {
          chainId: 8453,
          paymaster: COINBASE_PM,
          fields: { ...FIELDS, validUntil: FIELDS.validUntil + 1 },
        }),
    ],
    [
      'validAfter',
      () =>
        paymasterHash(OP as never, {
          chainId: 8453,
          paymaster: COINBASE_PM,
          fields: { ...FIELDS, validAfter: FIELDS.validAfter + 1 },
        }),
    ],
    [
      'sponsorUUID',
      () =>
        paymasterHash(OP as never, {
          chainId: 8453,
          paymaster: COINBASE_PM,
          fields: { ...FIELDS, sponsorUUID: 1n },
        }),
    ],
  ];
  for (const [name, hash] of mutations)
    assert.notEqual(hash(), base, `${name} must change the hash`);
  // The signature itself and paymasterAndData are NOT part of getHash.
  assert.equal(
    paymasterHash({ ...OP, signature: '0x1234', paymasterAndData: '0xabcd' } as never, {
      chainId: 8453,
      paymaster: COINBASE_PM,
      fields: FIELDS,
    }),
    base,
  );
});

test('signed paymasterAndData: 194 bytes in the pinned layout, no token, recoverable signer', async () => {
  const account = privateKeyToAccount(`0x${'11'.repeat(32)}`);
  const data = await signPaymasterData(OP as never, {
    chainId: 8453,
    paymaster: COINBASE_PM,
    fields: FIELDS,
    sign: (hash) => account.signMessage({ message: { raw: hash } }),
  });
  assert.equal((data.length - 2) / 2, SPONSOR_DATA_BYTES);
  assert.equal(data.slice(0, 42).toLowerCase(), COINBASE_PM.toLowerCase());
  // The existing server/browser checks accept it as it is (here with the Coinbase address pinned).
  assert.equal(sponsoredWithoutCharge(8453, data), true);
  assert.equal(sponsoredValidUntil(data), FIELDS.validUntil * 1000);
  assert.equal(data.slice(2 + 48 * 2, 2 + 49 * 2), '00', 'allowAnyBundler is 0');
  const signature = `0x${data.slice(2 + 129 * 2)}` as const;
  const hash = paymasterHash(OP as never, {
    chainId: 8453,
    paymaster: COINBASE_PM,
    fields: FIELDS,
  });
  assert.equal(
    await recoverAddress({ hash: hashMessage({ raw: hash }), signature }),
    account.address,
  );
});

test('stub has the final length; bad fields and signatures are refused', async () => {
  assert.equal((paymasterStub(COINBASE_PM, FIELDS).length - 2) / 2, SPONSOR_DATA_BYTES);
  assert.equal((paymasterPrefix(COINBASE_PM, FIELDS).length - 2) / 2, 129);
  assert.throws(() => paymasterPrefix(COINBASE_PM, { ...FIELDS, validUntil: 0 }));
  assert.throws(() => paymasterPrefix(COINBASE_PM, { ...FIELDS, validAfter: FIELDS.validUntil }));
  assert.throws(() => paymasterPrefix(COINBASE_PM, { ...FIELDS, validUntil: 2 ** 48 }));
  assert.throws(() => paymasterPrefix(COINBASE_PM, { ...FIELDS, sponsorUUID: 1n << 128n }));
  await assert.rejects(
    signPaymasterData(OP as never, {
      chainId: 8453,
      paymaster: COINBASE_PM,
      fields: FIELDS,
      sign: async () => '0x1234',
    }),
  );
});

// --- POST /api/ops/paymaster/keys ---------------------------------------------------------------

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
  await pg.exec(OWN_PAYMASTER_KEYS_SQL);
  const db = {
    query: (sql: string, params?: unknown[]) => pg.query(sql, params) as never,
    exec: (sql: string) => pg.exec(sql),
    transaction: (action: (tx: never) => Promise<unknown>) =>
      pg.transaction((tx) => action(tx as never)),
    close: () => pg.close(),
  } as unknown as Database;
  const app = Fastify();
  registerOwnPaymasterKeysRoute(app, { db, env });
  t.after(() => app.close());
  return { app, pg };
}
const post = (app: Awaited<ReturnType<typeof setup>>['app'], authorization?: string) =>
  app.inject({
    method: 'POST',
    url: PAYMASTER_KEYS_PATH,
    headers: authorization ? { authorization } : {},
  });

test('paymaster keys: 404 without the ops secret, nothing created', async (t) => {
  const { app, pg } = await setup(t, { CITY_OPS_SECRET: SECRET, CITY_BASE_SPENDER_KEK: KEK });
  for (const authorization of [undefined, 'Bearer wrong'])
    assert.equal((await post(app, authorization)).statusCode, 404);
  assert.equal(
    (await pg.query<{ n: number }>('SELECT count(*)::int AS n FROM base_spender_keys')).rows[0]!.n,
    0,
  );
});

test('paymaster keys: signer + 2 submitters, distinct, committed, idempotent; addresses and refs only', async (t) => {
  const { app, pg } = await setup(t, { CITY_OPS_SECRET: SECRET, CITY_BASE_SPENDER_KEK: KEK });
  const first = await post(app, `Bearer ${SECRET}`);
  assert.equal(first.statusCode, 200);
  assert.equal(first.headers['cache-control'], 'no-store');
  const body = first.json() as {
    signer: { address: string; keyRef: string };
    submitters: Array<{ address: string; keyRef: string }>;
    env: Record<string, string>;
  };
  const addresses = [body.signer.address, ...body.submitters.map((s) => s.address)];
  assert.equal(new Set(addresses.map((a) => a.toLowerCase())).size, 3, 'three different keys');
  for (const key of [body.signer, ...body.submitters]) {
    assert.deepEqual(Object.keys(key).sort(), ['address', 'keyRef']);
    assert.match(key.keyRef, /^v1:[0-9a-f-]{36}$/);
  }
  assert.equal(body.env.CITY_BASE_PAYMASTER_SIGNER_KEY_REF, body.signer.keyRef);
  // The canary config activates ONE lane (submitter 1); submitter 2 is listed, never activated.
  assert.equal(body.env.CITY_BASE_SUBMITTER_KEY_REFS, body.submitters[0]!.keyRef);
  assert.equal(
    (body as unknown as { laterLaneKeyRef: string }).laterLaneKeyRef,
    body.submitters[1]!.keyRef,
  );
  assert.deepEqual(
    (await post(app, `Bearer ${SECRET}`)).json(),
    body,
    'a retry answers the same keys',
  );
  const rows = await pg.query<{ signer_address: string; committed_at: string | null }>(
    'SELECT signer_address, committed_at FROM base_spender_keys',
  );
  assert.equal(rows.rows.length, 3, 'a retry creates nothing new');
  for (const row of rows.rows) assert.notEqual(row.committed_at, null);
  assert.doesNotMatch(first.body, /ciphertext|wrapped|private|secret/i);
});

test('paymaster keys: concurrent calls agree on one committed key per purpose; losers stay uncommitted', async (t) => {
  const { app, pg } = await setup(t, { CITY_OPS_SECRET: SECRET, CITY_BASE_SPENDER_KEK: KEK });
  const answers = await Promise.all(Array.from({ length: 5 }, () => post(app, `Bearer ${SECRET}`)));
  for (const answer of answers) assert.equal(answer.statusCode, 200);
  const bodies = answers.map((a) => a.json());
  for (const body of bodies) assert.deepEqual(body, bodies[0], 'every caller sees the same keys');
  const recorded = await pg.query<{ key_ref: string }>('SELECT key_ref FROM own_paymaster_keys');
  assert.equal(recorded.rows.length, 3, 'one row per purpose');
  const keys = await pg.query<{ key_id: string; committed_at: string | null }>(
    'SELECT key_id, committed_at FROM base_spender_keys',
  );
  assert.deepEqual(
    keys.rows
      .filter((k) => k.committed_at !== null)
      .map((k) => k.key_id)
      .sort(),
    recorded.rows.map((r) => r.key_ref.split(':')[1]).sort(),
    'exactly the recorded keys are committed; a concurrent loser stays uncommitted (never usable)',
  );
});

test('paymaster keys: 409 once configured, 503 without a keystore', async (t) => {
  const configured = await setup(t, {
    CITY_OPS_SECRET: SECRET,
    CITY_BASE_SPENDER_KEK: KEK,
    CITY_BASE_PAYMASTER_SIGNER_KEY_REF: 'v1:x',
  });
  assert.equal((await post(configured.app, `Bearer ${SECRET}`)).statusCode, 409);
  const noKeystore = await setup(t, { CITY_OPS_SECRET: SECRET });
  assert.equal((await post(noKeystore.app, `Bearer ${SECRET}`)).statusCode, 503);
});

// --- prepare mode: provisioning at start, the read-only public projection -----------------------

test('prepare mode at start: off does nothing; prepare provisions once; no KEK never throws; concurrent starts agree', async (t) => {
  const { pg } = await setup(t, {});
  const db = {
    query: (sql: string, params?: unknown[]) => pg.query(sql, params) as never,
    transaction: (action: (tx: never) => Promise<unknown>) =>
      pg.transaction((tx) => action(tx as never)),
  } as unknown as Database;
  const count = async () =>
    (await pg.query<{ n: number }>('SELECT count(*)::int AS n FROM own_paymaster_keys')).rows[0]!.n;
  assert.equal(
    await provisionPaymasterKeysAtStart({ db, env: { CITY_BASE_SPENDER_KEK: KEK } }),
    'off',
  );
  assert.equal(await count(), 0);
  assert.equal(
    await provisionPaymasterKeysAtStart({ db, env: { CITY_BASE_OWN_PAYMASTER: 'prepare' } }),
    'keystore_unavailable',
  );
  assert.equal(await count(), 0);
  const env = { CITY_BASE_OWN_PAYMASTER: 'prepare', CITY_BASE_SPENDER_KEK: KEK };
  const states = await Promise.all(
    Array.from({ length: 4 }, () => provisionPaymasterKeysAtStart({ db, env })),
  );
  assert.deepEqual(states, ['ready', 'ready', 'ready', 'ready']);
  assert.equal(await count(), 3, 'one key per purpose, whatever the concurrency');
  assert.equal(await provisionPaymasterKeysAtStart({ db, env }), 'ready');
  assert.equal(await count(), 3);
});

test('GET /api/public/paymaster: 404 while off; public addresses only, never keyRefs; it creates nothing', async (t) => {
  const pg = await PGlite.create('memory://');
  t.after(() => pg.close());
  await pg.exec(`CREATE TABLE base_spender_keys (
    key_id text PRIMARY KEY, kek_version integer NOT NULL, wrapped_dek bytea NOT NULL,
    ciphertext bytea NOT NULL, signer_address text NOT NULL, committed_at bigint,
    created_at bigint NOT NULL)`);
  await pg.exec(OWN_PAYMASTER_KEYS_SQL);
  const db = {
    query: (sql: string, params?: unknown[]) => pg.query(sql, params) as never,
    transaction: (action: (tx: never) => Promise<unknown>) =>
      pg.transaction((tx) => action(tx as never)),
  } as unknown as Database;
  const serve = (env: Record<string, string>) => {
    const app = Fastify();
    registerPaymasterPublicRoute(app, {
      db,
      env,
      chainId: 8453,
      entryPoint: '0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789',
    });
    t.after(() => app.close());
    return app.inject({ method: 'GET', url: PAYMASTER_PUBLIC_PATH });
  };
  assert.equal((await serve({})).statusCode, 404);
  // Prepare mode before provisioning: nothing to show, and the GET creates nothing.
  const empty = await serve({ CITY_BASE_OWN_PAYMASTER: 'prepare', CITY_BASE_SPENDER_KEK: KEK });
  assert.equal(empty.statusCode, 200);
  assert.equal(empty.json().verifyingSigner, null);
  assert.equal(
    (await pg.query<{ n: number }>('SELECT count(*)::int AS n FROM base_spender_keys')).rows[0]!.n,
    0,
  );
  const env = { CITY_BASE_OWN_PAYMASTER: 'prepare', CITY_BASE_SPENDER_KEK: KEK };
  const keys = await provisionPaymasterKeys({ db, env });
  const shown = await serve({
    ...env,
    CITY_BASE_PAYMASTER_ADDRESS: '0x8Bf5b18b733a864c17Cd92615cD45D833Fcfe105',
  });
  const body = shown.json();
  assert.deepEqual(Object.keys(body).sort(), [
    'bundler',
    'bundlerConfigured',
    'chainId',
    'entryPoint',
    'mode',
    'paymaster',
    'submitter',
    'verifyingSigner',
  ]);
  assert.equal(body.verifyingSigner, keys.get('paymaster_signer')!.address);
  assert.equal(
    body.submitter,
    keys.get('paymaster_submitter_1')!.address,
    'only submitter 1 (one lane)',
  );
  assert.equal(body.paymaster, '0x8Bf5b18b733a864c17Cd92615cD45D833Fcfe105');
  assert.doesNotMatch(shown.body, /v1:|keyRef|key_ref/);
  assert.equal(
    (await serve({ ...env, CITY_BASE_PAYMASTER_ADDRESS: 'nonsense' })).json().paymaster,
    null,
  );
  // direct asked for in prepare mode is a visible, degraded CDP fallback.
  assert.equal(body.bundler, 'cdp');
  assert.equal(body.bundlerConfigured, 'cdp');
  assert.equal(
    (await serve({ ...env, CITY_BASE_BUNDLER: 'direct' })).json().bundler,
    'cdp_fallback',
  );
  assert.equal(
    (await serve({ ...env, CITY_BASE_BUNDLER: 'direct' })).json().bundlerConfigured,
    'direct_invalid',
  );
  assert.equal(
    (
      await serve({
        ...env,
        CITY_BASE_OWN_PAYMASTER: 'on',
        CITY_BASE_BUNDLER: 'direct',
        CITY_BASE_PAYMASTER_ADDRESS: '0x8Bf5b18b733a864c17Cd92615cD45D833Fcfe105',
      })
    ).json().bundler,
    'direct_starting',
  );
});
