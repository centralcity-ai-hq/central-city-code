import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import type { Database } from '../server/database.js';
import { BASE_MAINNET, BASE_SEPOLIA, type BaseChainId } from '../shared/base/chains.js';
import { WALLET_CHAIN_ID } from '../shared/base/wallet-network.js';
import {
  ChainRuntimeError,
  chainRuntimes,
  createChainRuntime,
  walletFeeCap,
} from '../server/base/chain/runtime.js';
import { ownerRevokePortFromEnv } from '../server/base/chain/owner-revoke.js';
import { OTHER_CHAIN_ID } from './wallet-network-fixture.js';

const db = { query: async () => ({ rows: [] }) } as unknown as Database;
// A secret-looking endpoint: it must never appear in any error.
const SECRET_URL = `https://api.example.test/rpc/v1/base/${randomBytes(12).toString('hex')}`;
const kek = `v1:${randomBytes(32).toString('base64')}`;
const mainnetEnv = {
  CITY_BASE_MAINNET: '1',
  CITY_BASE_CDP_RPC_URL: SECRET_URL,
  CITY_BASE_SPENDER_KEK: kek,
  CITY_BASE_MAX_FEE_PER_GAS_WEI: '1000000000',
  CITY_BASE_IDENTITY_FEE_CAP_WEI: '50000000000000',
  CITY_BASE_WALLET_FEE_CAP_WEI: '20000000000000',
};
const sepoliaEnv = {
  CITY_BASE_CDP_SEPOLIA_RPC_URL: SECRET_URL,
  CITY_BASE_SPENDER_KEK: kek,
  CITY_BASE_MAX_FEE_PER_GAS_WEI: '1000000000',
};
/** A complete configuration of a network's runtime. */
const envFor = (chainId: BaseChainId): Record<string, string | undefined> =>
  chainId === BASE_MAINNET ? { ...mainnetEnv } : { ...sepoliaEnv };

const refusedFor = (setting: string) => (e: unknown) =>
  e instanceof ChainRuntimeError &&
  e.setting === setting &&
  !e.message.includes(SECRET_URL) &&
  !e.message.includes(kek);

test('a complete mainnet configuration builds the wallet and identity ports', () => {
  const runtime = createChainRuntime({ db, env: mainnetEnv, chainId: BASE_MAINNET });
  assert.equal(typeof runtime.walletPort.deriveSmartAccount, 'function');
  assert.equal(typeof runtime.identityPort.register, 'function');
});

test('owner operations exist on the wallet network only, never on the other one', () => {
  const wallet = createChainRuntime({
    db,
    env: envFor(WALLET_CHAIN_ID),
    chainId: WALLET_CHAIN_ID,
  });
  assert.equal(wallet.ownerOperations?.chainId, WALLET_CHAIN_ID);
  const other = createChainRuntime({ db, env: envFor(OTHER_CHAIN_ID), chainId: OTHER_CHAIN_ID });
  assert.equal(typeof other.identityPort.register, 'function');
  assert.equal(other.ownerOperations, undefined);
});

test('every missing or malformed setting refuses with its name only, never a value', () => {
  for (const name of [
    'CITY_BASE_CDP_RPC_URL',
    'CITY_BASE_SPENDER_KEK',
    'CITY_BASE_MAX_FEE_PER_GAS_WEI',
    'CITY_BASE_IDENTITY_FEE_CAP_WEI',
  ]) {
    const env = { ...mainnetEnv, [name]: '' };
    assert.throws(
      () => createChainRuntime({ db, env, chainId: BASE_MAINNET }),
      refusedFor(name),
      name,
    );
  }
  assert.throws(
    () =>
      createChainRuntime({
        db,
        env: { ...mainnetEnv, CITY_BASE_SPENDER_KEK: 'not-a-key' },
        chainId: BASE_MAINNET,
      }),
    refusedFor('CITY_BASE_SPENDER_KEK'),
  );
  for (const bad of ['0', '-1', '1.5', 'abc'])
    assert.throws(
      () =>
        createChainRuntime({
          db,
          env: { ...mainnetEnv, CITY_BASE_MAX_FEE_PER_GAS_WEI: bad },
          chainId: BASE_MAINNET,
        }),
      refusedFor('CITY_BASE_MAX_FEE_PER_GAS_WEI'),
    );
});

test('a chain endpoint setting that is not https is refused or never used (CCA-140)', async () => {
  const { baseReadUrls, secureEndpoint } = await import('../server/base/chain/read-transport.js');
  const { explorerReadUrls } = await import('../server/base/explorer/head.js');
  const plain = 'http://rpc.example.test/key';
  for (const url of [plain, 'ftp://rpc.example.test', 'rpc.example.test', 'https://']) {
    const env = { ...mainnetEnv, CITY_BASE_CDP_RPC_URL: url };
    assert.throws(
      () => createChainRuntime({ db, env, chainId: BASE_MAINNET }),
      refusedFor('CITY_BASE_CDP_RPC_URL'),
      url,
    );
    assert.throws(
      () => ownerRevokePortFromEnv(db, env, BASE_MAINNET),
      refusedFor('CITY_BASE_CDP_RPC_URL'),
      url,
    );
    assert.deepEqual(explorerReadUrls(env, true), [], url);
  }
  // The second endpoint: an http one is left out, never read.
  assert.deepEqual(
    baseReadUrls(SECRET_URL, { CITY_BASE_READ_FALLBACK_RPC_URL: plain }, BASE_MAINNET),
    [SECRET_URL],
  );
  assert.deepEqual(baseReadUrls(plain, {}, BASE_MAINNET), []);
  assert.deepEqual(
    explorerReadUrls({ ...mainnetEnv, CITY_BASE_READ_FALLBACK_RPC_URL: plain }, false),
    [SECRET_URL],
  );
  // https, and plain http only to this machine or on Anvil.
  assert.equal(secureEndpoint(SECRET_URL, BASE_MAINNET), true);
  assert.equal(secureEndpoint('http://127.0.0.1:8545', BASE_MAINNET), true);
  assert.equal(secureEndpoint('http://localhost:8545', BASE_SEPOLIA), true);
  assert.equal(secureEndpoint('http://anvil:8545', 31337), true);
  assert.equal(secureEndpoint(plain, BASE_SEPOLIA), false);
});

test('mainnet is refused while its gate is closed, and needs a fee budget when open', () => {
  assert.throws(
    () =>
      createChainRuntime({
        db,
        env: { ...mainnetEnv, CITY_BASE_MAINNET: '' },
        chainId: BASE_MAINNET,
      }),
    refusedFor('network'),
  );
  // Sepolia may run without a per-operation budget; mainnet never does.
  const sepolia = createChainRuntime({ db, env: sepoliaEnv, chainId: BASE_SEPOLIA });
  assert.equal(typeof sepolia.identityPort.transfer, 'function');
});

test('owner operations on mainnet need their own fee budget; without it only they are off', () => {
  // Built for each network as if it were the wallet network.
  const on = (chainId: BaseChainId, env: Record<string, string | undefined>) =>
    createChainRuntime({ db, env, chainId, walletChainId: chainId });
  // Base: CITY_BASE_WALLET_FEE_CAP_WEI is required. Missing or malformed, no owner operation
  // exists, and the runtime registrations share (identity, wallet derivation) still starts.
  for (const value of [undefined, '', ' ', '0', '-1', '1.5', 'abc', '1e18']) {
    const runtime = on(BASE_MAINNET, { ...mainnetEnv, CITY_BASE_WALLET_FEE_CAP_WEI: value });
    assert.equal(runtime.ownerOperations, undefined, String(value));
    assert.equal(typeof runtime.identityPort.register, 'function', String(value));
    assert.equal(typeof runtime.walletPort.deriveSmartAccount, 'function', String(value));
  }
  assert.equal(on(BASE_MAINNET, mainnetEnv).ownerOperations?.chainId, BASE_MAINNET);
  // Base Sepolia may run without one; a malformed one is refused there too.
  assert.equal(on(BASE_SEPOLIA, sepoliaEnv).ownerOperations?.chainId, BASE_SEPOLIA);
  for (const value of ['0', '-1', '1.5', 'abc'])
    assert.equal(
      on(BASE_SEPOLIA, { ...sepoliaEnv, CITY_BASE_WALLET_FEE_CAP_WEI: value }).ownerOperations,
      undefined,
      value,
    );
  assert.deepEqual(walletFeeCap({ CITY_BASE_WALLET_FEE_CAP_WEI: ' 7 ' }, BASE_MAINNET), {
    cap: 7n,
  });
  assert.equal(walletFeeCap({}, BASE_MAINNET), null);
  assert.deepEqual(walletFeeCap({}, BASE_SEPOLIA), { cap: undefined });
  // The wallet network of this build follows the same rule.
  const { CITY_BASE_WALLET_FEE_CAP_WEI: _cap, ...uncapped } = envFor(WALLET_CHAIN_ID);
  assert.equal(
    createChainRuntime({ db, env: uncapped, chainId: WALLET_CHAIN_ID }).ownerOperations?.chainId,
    WALLET_CHAIN_ID === BASE_MAINNET ? undefined : WALLET_CHAIN_ID,
  );
});

test("W3's revoke port follows the same fee-cap rule as the wallet's other owner operations", () => {
  // Base: CITY_BASE_WALLET_FEE_CAP_WEI is required; missing or malformed refuses with its name.
  for (const value of [undefined, '', ' ', '0', '-1', '1.5', 'abc'])
    assert.throws(
      () =>
        ownerRevokePortFromEnv(
          db,
          { ...mainnetEnv, CITY_BASE_WALLET_FEE_CAP_WEI: value },
          BASE_MAINNET,
        ),
      refusedFor('CITY_BASE_WALLET_FEE_CAP_WEI'),
      String(value),
    );
  assert.equal(ownerRevokePortFromEnv(db, mainnetEnv, BASE_MAINNET).chainId, BASE_MAINNET);
  assert.throws(
    () => ownerRevokePortFromEnv(db, { ...mainnetEnv, CITY_BASE_MAINNET: '' }, BASE_MAINNET),
    refusedFor('network'),
  );
  // Base Sepolia may run without one; a malformed one refuses there too.
  assert.equal(ownerRevokePortFromEnv(db, sepoliaEnv, BASE_SEPOLIA).chainId, BASE_SEPOLIA);
  assert.throws(
    () =>
      ownerRevokePortFromEnv(
        db,
        { ...sepoliaEnv, CITY_BASE_WALLET_FEE_CAP_WEI: '1.5' },
        BASE_SEPOLIA,
      ),
    refusedFor('CITY_BASE_WALLET_FEE_CAP_WEI'),
  );
});

test('CCA-704: the protocol key addresses: none configured, none; a configured key that cannot be read refuses', async () => {
  const none = createChainRuntime({ db, env: mainnetEnv, chainId: BASE_MAINNET });
  assert.deepEqual(await none.protocolKeyAddresses?.(), []);
  // The db stub has no keys: a configured ref that is not found never answers a partial list.
  for (const setting of [
    'CITY_X402_FACILITATOR_KEY_REF',
    'CITY_X402_PUBLIC_SETTLE_KEY_REF',
    'CITY_SFP_SPONSOR_KEY_REF',
    'CITY_BASE_PAYMASTER_SIGNER_KEY_REF',
    'CITY_BASE_SUBMITTER_KEY_REFS',
  ]) {
    const runtime = createChainRuntime({
      db,
      env: { ...mainnetEnv, [setting]: `v1:${'0'.repeat(8)}-0000-4000-8000-${'0'.repeat(12)}` },
      chainId: BASE_MAINNET,
    });
    await assert.rejects(runtime.protocolKeyAddresses!(), setting);
  }
});

test('CCA-704: both facilitators log through the runtime log (ALERT lines are not discarded)', async () => {
  const ref = (n: number) => `v1:${String(n).repeat(8)}-0000-4000-8000-${'0'.repeat(12)}`;
  const lines: string[] = [];
  const id = (n: number) => ref(n).slice(3);
  const runtime = createChainRuntime({
    // Two keys with distinct stored addresses and nothing that decrypts: the public sender is not
    // an alias (so it follows Base), and each lane check fails at the signer and says so.
    db: keyRows({
      [id(1)]: '0x5555555555555555555555555555555555555555',
      [id(2)]: '0x6666666666666666666666666666666666666666',
    }),
    env: {
      ...mainnetEnv,
      CITY_X402_FACILITATOR_KEY_REF: ref(1),
      CITY_X402_PUBLIC_SETTLE_KEY_REF: ref(2),
    },
    chainId: BASE_MAINNET,
    log: (line) => lines.push(line),
  });
  const router3 = runtime.router3Facilitator?.();
  const publicSettle = runtime.publicSettleFacilitator?.();
  assert.ok(router3 && publicSettle);
  await router3.status('k');
  assert.equal(lines.filter((l) => l.startsWith('x402 facilitator:')).length, 1);
  await publicSettle.status('k');
  assert.equal(lines.filter((l) => l.startsWith('x402 facilitator:')).length, 2);
});

test("CCA-704: the public sender is refused on the router-3 facilitator's or the sponsor's key", async () => {
  const ref = (n: number) => `v1:${String(n).repeat(8)}-0000-4000-8000-${'0'.repeat(12)}`;
  const build = (env: Record<string, string>, keys = db) =>
    createChainRuntime({ db: keys, env: { ...mainnetEnv, ...env }, chainId: BASE_MAINNET });
  for (const other of ['CITY_X402_FACILITATOR_KEY_REF', 'CITY_SFP_SPONSOR_KEY_REF'])
    assert.equal(
      build({
        CITY_X402_PUBLIC_SETTLE_KEY_REF: ref(1),
        [other]: ref(1),
      }).publicSettleFacilitator?.(),
      null,
      other,
    );
  assert.ok(
    build({
      CITY_X402_PUBLIC_SETTLE_KEY_REF: ref(1),
      CITY_X402_FACILITATOR_KEY_REF: ref(2),
      CITY_SFP_SPONSOR_KEY_REF: ref(3),
    }).publicSettleFacilitator?.(),
  );
  // Another ref holding the same address (the same key stored twice): never sends either.
  const sameAddress = {
    query: async (sql: string, params: unknown[] = []) =>
      sql.includes('FROM base_spender_keys')
        ? {
            rows: [
              {
                key_id: params[0],
                kek_version: 1,
                wrapped_dek: Buffer.alloc(1),
                ciphertext: Buffer.alloc(1),
                signer_address: '0x5555555555555555555555555555555555555555',
                committed_at: 1,
                created_at: 1,
              },
            ],
          }
        : { rows: [] },
  } as unknown as Database;
  const twin = build(
    { CITY_X402_PUBLIC_SETTLE_KEY_REF: ref(1), CITY_X402_FACILITATOR_KEY_REF: ref(2) },
    sameAddress,
  ).publicSettleFacilitator?.();
  assert.ok(twin);
  assert.equal(await twin.canPay(), false);
});

/*
 * Review finding 374: the public sender never aliases the paymaster's verifying signer or one of
 * our bundler's submitters, by the same ref or by another ref with the same stored address.
 */
const aliasRef = (n: number) => `v1:${String(n).repeat(8)}-0000-4000-8000-${'0'.repeat(12)}`;
const SIGNER_SETTING = 'CITY_BASE_PAYMASTER_SIGNER_KEY_REF';
const SUBMITTERS_SETTING = 'CITY_BASE_SUBMITTER_KEY_REFS';
/** Key rows by key id with their stored address only (nothing here can be decrypted). */
const keyRows = (addresses: Record<string, string>) =>
  ({
    query: async (sql: string, params: unknown[] = []) =>
      sql.includes('FROM base_spender_keys') && addresses[String(params[0])]
        ? {
            rows: [
              {
                key_id: params[0],
                kek_version: 1,
                wrapped_dek: Buffer.alloc(1),
                ciphertext: Buffer.alloc(1),
                signer_address: addresses[String(params[0])],
                committed_at: 1,
                created_at: 1,
              },
            ],
          }
        : { rows: [] },
  }) as unknown as Database;
const aliasBuild = (env: Record<string, string>, keys = db) =>
  createChainRuntime({ db: keys, env: { ...mainnetEnv, ...env }, chainId: BASE_MAINNET });
/** A public sender whose ref 1 has the same stored address as ref 3 (ref 2 another one). */
const aliased = (setting: string, value: string) => {
  const id = (n: number) => aliasRef(n).slice(3);
  const sender = aliasBuild(
    { CITY_X402_PUBLIC_SETTLE_KEY_REF: aliasRef(1), [setting]: value },
    keyRows({
      [id(1)]: '0x5555555555555555555555555555555555555555',
      [id(2)]: '0x6666666666666666666666666666666666666666',
      [id(3)]: '0x5555555555555555555555555555555555555555',
    }),
  ).publicSettleFacilitator?.();
  assert.ok(sender, setting);
  return sender;
};

test("review finding 374: no public sender on the paymaster signer's own ref", () => {
  assert.equal(
    aliasBuild({
      CITY_X402_PUBLIC_SETTLE_KEY_REF: aliasRef(1),
      [SIGNER_SETTING]: aliasRef(1),
    }).publicSettleFacilitator?.(),
    null,
  );
});

test("review finding 374: no public sender on a submitter's own ref in the comma list", () => {
  assert.equal(
    aliasBuild({
      CITY_X402_PUBLIC_SETTLE_KEY_REF: aliasRef(1),
      [SUBMITTERS_SETTING]: ` ${aliasRef(2)}, ${aliasRef(1)} `,
    }).publicSettleFacilitator?.(),
    null,
  );
});

test("review finding 374: another ref with the paymaster signer's stored address never pays", async () => {
  assert.equal(await aliased(SIGNER_SETTING, aliasRef(3)).canPay(), false);
});

test("review finding 374: another ref with a submitter's stored address never pays", async () => {
  assert.equal(await aliased(SUBMITTERS_SETTING, `${aliasRef(2)},${aliasRef(3)}`).canPay(), false);
});

/**
 * Review finding 385: a public sender whose key aliases another server key (the paymaster signer
 * here, or `aliasSetting`) follows its stored settlements read-only: no lane heal, no refresh, no
 * replacement signed, nothing broadcast. Without the alias the same stuck settlement is healed.
 * PGlite with the real key and facilitator tables, Base faked at fetch.
 */
async function followStuckSettlement(
  t: { after: (fn: () => unknown) => void },
  aliasSetting: string | null,
) {
  const { PGlite } = await import('@electric-sql/pglite');
  const { X402_FACILITATOR_SQL, X402_FACILITATOR_BATCH_SQL } =
    await import('../server/protocol/x402/facilitator-schema.js');
  const { createKeystore, parseKeks } = await import('../server/base/chain/keystore.js');
  const { pgSpenderKeyStore } = await import('../server/base/chain/stores.js');
  const pg = await PGlite.create('memory://');
  // The key rows in a second instance: PGlite has one connection, so the keystore's read while
  // the lane transaction is open (signing) would wait on it forever; a pool serves both.
  const keys = await PGlite.create('memory://');
  t.after(() => pg.close());
  t.after(() => keys.close());
  await keys.exec(`CREATE TABLE base_spender_keys (
    key_id text PRIMARY KEY, kek_version integer NOT NULL, wrapped_dek bytea NOT NULL,
    ciphertext bytea NOT NULL, signer_address text NOT NULL, committed_at bigint,
    created_at bigint NOT NULL)`);
  await pg.exec(X402_FACILITATOR_SQL);
  await pg.exec(X402_FACILITATOR_BATCH_SQL);
  const pgDb = {
    query: (sql: string, params?: unknown[]) =>
      (sql.includes('base_spender_keys') ? keys : pg).query(sql, params),
    exec: (sql: string) => pg.exec(sql),
    transaction: (action: (tx: unknown) => Promise<unknown>) => pg.transaction((tx) => action(tx)),
  } as unknown as Database;
  // The public sender's real key, and (for the alias) a second row with only its stored address.
  const { signer, keyRef } = await createKeystore({
    store: pgSpenderKeyStore(pgDb),
    keks: parseKeks(kek),
  }).createSpenderKey();
  const twinId = `${'9'.repeat(8)}-0000-4000-8000-${'0'.repeat(12)}`;
  await keys.query(
    `INSERT INTO base_spender_keys (key_id, kek_version, wrapped_dek, ciphertext, signer_address,
       created_at) VALUES ($1, 1, '\\x00', '\\x00', $2, 1)`,
    [twinId, signer],
  );
  // One sent, unmined settlement of the public sender, long past STUCK_MS (it would be replaced).
  const key = 'x402:exact:8453:0xaa:0x01';
  const hash = `0x${'ab'.repeat(32)}`;
  await pg.query(
    `INSERT INTO x402_facilitator_ops (op_key, intent_hash, chain_id, facilitator, router, calldata,
       status, nonce, gas_limit, max_fee_per_gas, max_priority_fee_per_gas, l1_fee_wei, raw_tx,
       tx_hash, tx_hashes, sent_at, created_at, updated_at)
     VALUES ($1, $2, 8453, $3, $4, '0xa9059cbb', 'submitted', 0, 200000, 1000, 100, 0, '0x02',
       $5, ARRAY[$5]::text[], 0, 0, 0)`,
    [
      key,
      `0x${'11'.repeat(32)}`,
      signer.toLowerCase(),
      '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
      hash,
    ],
  );
  const asked: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
    const body = JSON.parse(init?.body ?? '{}') as
      { id: number; method: string } | { id: number; method: string }[];
    const one = (call: { id: number; method: string }) => {
      asked.push(call.method);
      const result: unknown =
        call.method === 'eth_chainId'
          ? '0x2105'
          : call.method === 'eth_getTransactionCount'
            ? '0x0'
            : call.method === 'eth_getBalance'
              ? '0xde0b6b3a7640000'
              : call.method === 'eth_call'
                ? `0x${'0'.repeat(64)}`
                : call.method === 'eth_maxPriorityFeePerGas'
                  ? '0x64'
                  : call.method === 'eth_getBlockByNumber'
                    ? {
                        number: '0x64',
                        hash: `0x${'1'.repeat(64)}`,
                        baseFeePerGas: '0x3e8',
                        timestamp: '0x1',
                        transactions: [],
                      }
                    : call.method === 'eth_sendRawTransaction'
                      ? `0x${'cd'.repeat(32)}`
                      : null;
      return { jsonrpc: '2.0', id: call.id, result };
    };
    const answer = Array.isArray(body) ? body.map(one) : one(body);
    return new Response(JSON.stringify(answer), {
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = realFetch;
  });
  const sender = createChainRuntime({
    db: pgDb,
    env: {
      ...mainnetEnv,
      CITY_X402_PUBLIC_SETTLE_KEY_REF: keyRef,
      ...(aliasSetting ? { [aliasSetting]: `v1:${twinId}` } : {}),
    },
    chainId: BASE_MAINNET,
  }).publicSettleFacilitator?.();
  assert.ok(sender);
  const op = await sender.status(key);
  const row = (
    await pg.query<{ tx_hashes: string[]; status: string }>(
      'SELECT tx_hashes, status FROM x402_facilitator_ops WHERE op_key = $1',
      [key],
    )
  ).rows[0]!;
  return { op, asked, row, hash };
}

for (const setting of [SIGNER_SETTING, SUBMITTERS_SETTING])
  test(
    `review finding 385: aliasing ${setting}, status() reads the stored settlement only: nothing signed or sent`,
    { timeout: 60_000 },
    async (t) => {
      const { op, asked, row, hash } = await followStuckSettlement(t, setting);
      assert.equal(op?.status, 'submitted');
      assert.equal(op?.txHash, hash);
      assert.deepEqual(asked, [], 'no chain read, no broadcast');
      assert.deepEqual(row.tx_hashes, [hash], 'no replacement signed');
    },
  );

test(
  'review finding 385 (control): without an alias the stuck settlement is healed as before',
  { timeout: 60_000 },
  async (t) => {
    const { asked, row } = await followStuckSettlement(t, null);
    assert.ok(asked.includes('eth_sendRawTransaction'), asked.join(','));
    assert.ok(row.tx_hashes.length > 1, 'a replacement was signed');
  },
);

test('runtimes are built once per network; a configuration error is not cached', async () => {
  const env: Record<string, string | undefined> = { ...mainnetEnv, CITY_BASE_SPENDER_KEK: '' };
  const runtime = chainRuntimes(db, env);
  await assert.rejects(runtime(BASE_MAINNET), refusedFor('CITY_BASE_SPENDER_KEK'));
  env.CITY_BASE_SPENDER_KEK = kek;
  const first = await runtime(BASE_MAINNET);
  assert.equal(await runtime(BASE_MAINNET), first);
});

test('our bundler wiring per configuration (today: drain, new work on CDP)', async () => {
  const PAYMASTER = '0x8Bf5b18b733a864c17Cd92615cD45D833Fcfe105';
  // Nothing of ours configured: no upkeep at all.
  assert.equal(
    createChainRuntime({ db, env: mainnetEnv, chainId: BASE_MAINNET }).ownBundlerUpkeep,
    undefined,
  );
  // Production today: prepare + address, CITY_BASE_BUNDLER unset -> a DRAIN with nothing open.
  // Building it touches no keys and no keystore (the db stub answers every query with no rows).
  const today = createChainRuntime({
    db,
    env: {
      ...mainnetEnv,
      CITY_BASE_OWN_PAYMASTER: 'prepare',
      CITY_BASE_PAYMASTER_ADDRESS: PAYMASTER,
    },
    chainId: BASE_MAINNET,
  });
  assert.equal(today.ownBundlerUpkeep?.mode, 'drain');
  assert.equal(await today.ownBundlerUpkeep?.open(), 0);
  assert.equal(await today.ownBundlerUpkeep?.maintain(), 0);
  assert.equal(typeof today.identityPort.register, 'function');
  // Switched on: direct.
  const on = createChainRuntime({
    db,
    env: {
      ...mainnetEnv,
      CITY_BASE_OWN_PAYMASTER: 'on',
      CITY_BASE_PAYMASTER_ADDRESS: PAYMASTER,
      CITY_BASE_BUNDLER: 'direct',
    },
    chainId: BASE_MAINNET,
  });
  assert.equal(on.ownBundlerUpkeep?.mode, 'direct');
  // Direct asked without 'on': CDP for new work, ours drains (never an outage).
  const invalid = createChainRuntime({
    db,
    env: {
      ...mainnetEnv,
      CITY_BASE_OWN_PAYMASTER: 'prepare',
      CITY_BASE_PAYMASTER_ADDRESS: PAYMASTER,
      CITY_BASE_BUNDLER: 'direct',
    },
    chainId: BASE_MAINNET,
  });
  assert.equal(invalid.ownBundlerUpkeep?.mode, 'drain');
});

test('production config today - a real owner operation is prepared through CDP end to end', async (t) => {
  const { BASE_NETWORKS } = await import('../shared/base/chains.js');
  const { deriveAddressLocal, spenderAccountRecipe } =
    await import('../server/base/chain/derive.js');
  const network = BASE_NETWORKS[BASE_MAINNET];
  const sponsor = `0x2FAEB0760D4230Ef2aC21496Bb4F0b47D634FD4c${'0'.repeat(174 * 2)}`;
  const asked: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
    const body = JSON.parse(init?.body ?? '{}') as
      { id: number; method: string } | { id: number; method: string }[];
    const one = (call: { id: number; method: string }) => {
      asked.push(call.method);
      const result =
        call.method === 'eth_chainId'
          ? '0x2105'
          : call.method === 'eth_getCode'
            ? '0x'
            : call.method === 'eth_call'
              ? `0x${'0'.repeat(64)}`
              : call.method === 'eth_getBlockByNumber'
                ? {
                    number: '0x64',
                    hash: `0x${'1'.repeat(64)}`,
                    baseFeePerGas: '0x1',
                    timestamp: '0x1',
                    transactions: [],
                  }
                : call.method === 'eth_maxPriorityFeePerGas'
                  ? '0x1'
                  : call.method === 'pm_getPaymasterStubData' ||
                      call.method === 'pm_getPaymasterData'
                    ? { paymasterAndData: sponsor }
                    : call.method === 'eth_estimateUserOperationGas'
                      ? {
                          callGasLimit: '0x1',
                          verificationGasLimit: '0x1',
                          preVerificationGas: '0x1',
                        }
                      : null;
      return { jsonrpc: '2.0', id: call.id, result };
    };
    const answer = Array.isArray(body) ? body.map(one) : one(body);
    return new Response(JSON.stringify(answer), {
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = realFetch;
  });
  const queries: string[] = [];
  const watchedDb = {
    query: async (sql: string) => (queries.push(sql), { rows: [] }),
  } as unknown as Database;
  const runtime = createChainRuntime({
    db: watchedDb,
    env: {
      ...mainnetEnv,
      CITY_BASE_OWN_PAYMASTER: 'prepare',
      CITY_BASE_PAYMASTER_ADDRESS: '0x8Bf5b18b733a864c17Cd92615cD45D833Fcfe105',
    },
    chainId: BASE_MAINNET,
  });
  assert.equal(runtime.ownBundlerUpkeep?.mode, 'drain');
  const recipe = spenderAccountRecipe(network, '0x1111111111111111111111111111111111111111');
  const prepared = await runtime.ownerOperations!.prepare({
    wallet: deriveAddressLocal(recipe),
    recipe,
    calls: [{ target: '0x2222222222222222222222222222222222222222', value: 1n, data: '0x' }],
    sponsorFlow: 'exit',
  });
  // CDP's paymaster and gas estimate were asked; the prepared op carries CDP's sponsorship.
  for (const method of [
    'pm_getPaymasterStubData',
    'eth_estimateUserOperationGas',
    'pm_getPaymasterData',
  ])
    assert.ok(asked.includes(method), `${method} asked of CDP`);
  assert.ok(
    prepared.operation.paymasterAndData?.startsWith('0x2FAEB0760D4230Ef2aC21496Bb4F0b47D634FD4c'),
  );
  // Ours was never built for it: no keys, no own tables, nothing of ours prepared or signed.
  assert.ok(
    queries.every((sql) => !/own_paymaster/.test(sql)),
    'no own_paymaster query while preparing with CDP',
  );
});
