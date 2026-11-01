import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import type { Database } from '../server/database.js';
import {
  createKeystore,
  parseKeks,
  parseKeyRef,
  rewrapStoredSpenderKey,
  type SpenderKeyStore,
  type StoredSpenderKey,
} from '../server/base/chain/keystore.js';
import { KEY_REF_SETTINGS } from '../server/base/chain/key-roles.js';
import { pgSpenderKeyStore } from '../server/base/chain/stores.js';
import {
  classifySpenderKey,
  missingServiceKeyRefSettings,
  rewrapSpenderKeys,
  ALL_SERVICE_KEY_REF_SETTINGS,
  OPTIONAL_SERVICE_KEY_REF_SETTINGS,
  SERVICE_KEY_REF_SETTINGS,
  serviceKeyIdsFromEnv,
} from '../scripts/rewrap-spender-keys.js';

// scripts/rewrap-spender-keys.ts: re-wraps agent spender keys under the current KEK version.
// Throwaway in-memory keys and databases only.

const kekEntry = (version: number) => `v${version}:${randomBytes(32).toString('base64')}`;

function memoryStore(): SpenderKeyStore & { rows: Map<string, StoredSpenderKey> } {
  const rows = new Map<string, StoredSpenderKey>();
  return {
    rows,
    async insert(row) {
      rows.set(row.keyId, structuredClone(row));
    },
    async get(keyId) {
      const row = rows.get(keyId);
      return row ? structuredClone(row) : null;
    },
  };
}

test('rewrapStoredSpenderKey: same key and address under the current version; old ref retired', async () => {
  const v1 = kekEntry(1);
  const both = parseKeks(`${v1},${kekEntry(2)}`);
  const store = memoryStore();
  const { signer, keyRef } = await createKeystore({
    store,
    keks: parseKeks(v1),
  }).createSpenderKey();
  const row = [...store.rows.values()][0]!;
  const next = rewrapStoredSpenderKey(row, both);
  assert.equal(next.kekVersion, 2);
  assert.equal(next.keyRef, `v2:${row.keyId}`);
  assert.notDeepEqual(Buffer.from(next.wrappedDek), Buffer.from(row.wrappedDek));
  assert.notDeepEqual(Buffer.from(next.ciphertext), Buffer.from(row.ciphertext));
  store.rows.set(row.keyId, { ...row, ...next });
  const keystore = createKeystore({ store, keks: both });
  assert.equal(await keystore.withSigner(next.keyRef, async (a) => a.address), signer);
  await assert.rejects(
    keystore.withSigner(keyRef, async (a) => a.address),
    /not found/,
  );
  // Already current, unknown version, or a wrong address: refused.
  assert.throws(() => rewrapStoredSpenderKey({ ...row, ...next }, both), /already/);
  assert.throws(() => rewrapStoredSpenderKey(row, parseKeks(kekEntry(2))), /not available/);
  assert.throws(
    () =>
      rewrapStoredSpenderKey(
        { ...row, signerAddress: '0x0000000000000000000000000000000000000001' },
        both,
      ),
    /does not match/,
  );
});

test('serviceKeyIdsFromEnv and classifySpenderKey', () => {
  const a = randomUUID();
  const b = randomUUID();
  const ids = serviceKeyIdsFromEnv({
    CITY_BASE_SUBMITTER_KEY_REFS: `v1:${a}, v1:${b}`,
    CITY_SFP_SPONSOR_KEY_REF: 'not-a-ref',
    UNRELATED: `v1:${randomUUID()}`,
  });
  assert.deepEqual([...ids].sort(), [a, b].sort());
  const keks = parseKeks(`${kekEntry(1)},${kekEntry(2)}`);
  const id = randomUUID();
  const ctx = (walletRefs: string[], service: string[] = []) => ({
    keks,
    walletRefs,
    serviceKeyIds: new Set(service),
  });
  assert.equal(classifySpenderKey({ keyId: id, kekVersion: 2 }, ctx([`v2:${id}`])), 'current');
  assert.equal(classifySpenderKey({ keyId: id, kekVersion: 1 }, ctx([`v1:${id}`])), 'wallet');
  assert.equal(
    classifySpenderKey({ keyId: id, kekVersion: 1 }, ctx([`v1:${id}`], [id])),
    'service',
  );
  assert.equal(classifySpenderKey({ keyId: id, kekVersion: 1 }, ctx([])), 'unreferenced');
  assert.equal(classifySpenderKey({ keyId: id, kekVersion: 1 }, ctx([`v2:${id}`])), 'unreferenced');
  assert.equal(classifySpenderKey({ keyId: id, kekVersion: 3 }, ctx([`v3:${id}`])), 'unknownKek');
});

test('missingServiceKeyRefSettings: unset, empty or malformed settings are named; the list matches key-roles', () => {
  // Drift guard: every app-held key role's setting is protected here.
  assert.deepEqual(
    [...ALL_SERVICE_KEY_REF_SETTINGS].sort(),
    Object.values(KEY_REF_SETTINGS).sort(),
  );
  assert.deepEqual(missingServiceKeyRefSettings({}), [...SERVICE_KEY_REF_SETTINGS]);
  const full = Object.fromEntries(
    SERVICE_KEY_REF_SETTINGS.map((name) => [name, `v1:${randomUUID()}`]),
  );
  assert.deepEqual(missingServiceKeyRefSettings(full), []);
  assert.deepEqual(
    missingServiceKeyRefSettings({
      ...full,
      CITY_X402_PUBLIC_SETTLE_KEY_REF: ' ',
      CITY_BASE_SUBMITTER_KEY_REFS: `v1:${randomUUID()},not-a-ref`,
    }),
    ['CITY_BASE_SUBMITTER_KEY_REFS', 'CITY_X402_PUBLIC_SETTLE_KEY_REF'],
  );
  // Arc's facilitator: optional when unset, fails closed when malformed, protected when set.
  assert.ok(
    (OPTIONAL_SERVICE_KEY_REF_SETTINGS as readonly string[]).includes(
      'CITY_ARC_FACILITATOR_KEY_REF',
    ),
  );
  assert.deepEqual(
    missingServiceKeyRefSettings({ ...full, CITY_ARC_FACILITATOR_KEY_REF: ' ' }),
    [],
  );
  assert.deepEqual(
    missingServiceKeyRefSettings({ ...full, CITY_ARC_FACILITATOR_KEY_REF: 'not-a-ref' }),
    ['CITY_ARC_FACILITATOR_KEY_REF'],
  );
  const id = randomUUID();
  assert.ok(serviceKeyIdsFromEnv({ CITY_ARC_FACILITATOR_KEY_REF: `v1:${id}` }).has(id));
});

/** A throwaway PGlite database with the tables the script reads, and an old (v1) keystore. */
async function fixture(t: { after(fn: () => unknown): void }) {
  const pg = await PGlite.create('memory://');
  t.after(() => pg.close());
  await pg.exec(`
    CREATE TABLE base_spender_keys (
      key_id text PRIMARY KEY, kek_version integer NOT NULL, wrapped_dek bytea NOT NULL,
      ciphertext bytea NOT NULL, signer_address text NOT NULL, committed_at bigint,
      created_at bigint NOT NULL);
    CREATE TABLE base_wallets (wallet_id text PRIMARY KEY, spender_key_ref text NOT NULL);
    CREATE TABLE own_paymaster_keys (purpose text PRIMARY KEY, key_ref text NOT NULL);`);
  const db = {
    query: (sql: string, params?: unknown[]) => pg.query(sql, params) as never,
    transaction: (action: (tx: never) => Promise<unknown>) =>
      pg.transaction((tx) => action(tx as never)),
  } as unknown as Database;
  const v1 = kekEntry(1);
  const both = parseKeks(`${v1},${kekEntry(2)}`);
  const store = pgSpenderKeyStore(db);
  const old = createKeystore({ store, keks: parseKeks(v1) });
  const wallet = await old.createSpenderKey();
  const service = await old.createSpenderKey();
  const envOnly = await old.createSpenderKey();
  const loose = await old.createSpenderKey();
  for (const ref of [wallet.keyRef, service.keyRef, envOnly.keyRef, loose.keyRef])
    await store.commit(ref);
  await pg.query('INSERT INTO base_wallets VALUES ($1,$2)', ['w1', wallet.keyRef]);
  await pg.query('INSERT INTO base_wallets VALUES ($1,$2)', ['w2', envOnly.keyRef]);
  await pg.query('INSERT INTO own_paymaster_keys VALUES ($1,$2)', [
    'paymaster_signer',
    service.keyRef,
  ]);
  const snapshot = async () =>
    (
      await pg.query(
        `SELECT k.key_id, k.kek_version, encode(k.wrapped_dek, 'hex') AS dek,
                encode(k.ciphertext, 'hex') AS ct, k.signer_address,
                (SELECT string_agg(spender_key_ref, ',') FROM base_wallets) AS refs
           FROM base_spender_keys k ORDER BY k.key_id`,
      )
    ).rows;
  return { pg, db, both, store, wallet, service, envOnly, loose, snapshot };
}

test('rewrapSpenderKeys: dry run by default; confirm moves wallet keys with their wallet refs only', async (t) => {
  const { pg, db, both, store, wallet, service, envOnly, loose } = await fixture(t);
  // The other service settings name keys this database does not hold.
  const env = {
    ...Object.fromEntries(SERVICE_KEY_REF_SETTINGS.map((name) => [name, `v1:${randomUUID()}`])),
    CITY_X402_PUBLIC_SETTLE_KEY_REF: envOnly.keyRef,
  };

  const dry = await rewrapSpenderKeys(db, both, { env });
  assert.deepEqual(dry, {
    pending: 4,
    walletKeys: 1,
    serviceKeys: 2,
    unreferenced: 1,
    unknownKek: 0,
    rewrapped: 0,
    failed: 0,
    dryRun: true,
    missingServiceRefs: [],
    refused: false,
  });
  const before = await pg.query('SELECT key_id, kek_version FROM base_spender_keys ORDER BY 1');
  assert.ok(before.rows.every((row) => (row as { kek_version: number }).kek_version === 1));

  const done = await rewrapSpenderKeys(db, both, { env, confirm: true });
  assert.equal(done.rewrapped, 1);
  assert.equal(done.dryRun, false);
  const w1 = await pg.query<{ spender_key_ref: string }>(
    "SELECT spender_key_ref FROM base_wallets WHERE wallet_id = 'w1'",
  );
  const moved = w1.rows[0]!.spender_key_ref;
  assert.match(moved, /^v2:/);
  const current = createKeystore({ store, keks: both });
  assert.equal(await current.withSigner(moved, async (a) => a.address), wallet.signer);
  // Service, env-held and unreferenced keys are untouched and still open under their old refs.
  for (const key of [service, envOnly, loose])
    assert.equal(await current.withSigner(key.keyRef, async (a) => a.address), key.signer);
  const again = await rewrapSpenderKeys(db, both, { env });
  assert.equal(again.walletKeys, 0);
  assert.equal(again.pending, 3);
});

test('rewrapSpenderKeys (CCA-707): no service settings loaded refuses dry run and confirm; nothing written', async (t) => {
  const { db, both, envOnly, snapshot } = await fixture(t);
  const before = await snapshot();
  // No env at all, and an env without any service setting: the public settle key (also referenced
  // by wallet w2) is indistinguishable from a wallet key, so neither run may select it.
  for (const options of [{}, { env: { UNRELATED: '1' } }]) {
    const dry = await rewrapSpenderKeys(db, both, options);
    assert.equal(dry.refused, true);
    assert.equal(dry.dryRun, true);
    assert.deepEqual(dry.missingServiceRefs, [...SERVICE_KEY_REF_SETTINGS]);
    const done = await rewrapSpenderKeys(db, both, { ...options, confirm: true });
    assert.equal(done.refused, true);
    assert.equal(done.dryRun, false);
    assert.equal(done.rewrapped, 0);
  }
  // One setting loaded is not enough either.
  const partial = await rewrapSpenderKeys(db, both, {
    env: { CITY_X402_PUBLIC_SETTLE_KEY_REF: envOnly.keyRef },
    confirm: true,
  });
  assert.equal(partial.refused, true);
  assert.equal(partial.rewrapped, 0);
  assert.equal(partial.missingServiceRefs.length, SERVICE_KEY_REF_SETTINGS.length - 1);
  // Byte for byte: no key row and no wallet ref changed.
  assert.deepEqual(await snapshot(), before);
});

test('rewrapSpenderKeys (CCA-707): with all settings loaded the settle key is skipped; wallet keys keep their address', async (t) => {
  const { pg, db, both, store, wallet, service, envOnly, loose, snapshot } = await fixture(t);
  const before = await snapshot();
  const env = {
    ...Object.fromEntries(SERVICE_KEY_REF_SETTINGS.map((name) => [name, `v1:${randomUUID()}`])),
    CITY_X402_PUBLIC_SETTLE_KEY_REF: envOnly.keyRef,
  };
  const done = await rewrapSpenderKeys(db, both, { env, confirm: true });
  assert.equal(done.refused, false);
  assert.equal(done.rewrapped, 1);
  assert.equal(done.serviceKeys, 2);
  const after = await snapshot();
  // Same keys, same signer addresses; only the wallet key's row changed version.
  assert.deepEqual(
    after.map((row) => [
      (row as { key_id: string }).key_id,
      (row as { signer_address: string }).signer_address,
    ]),
    before.map((row) => [
      (row as { key_id: string }).key_id,
      (row as { signer_address: string }).signer_address,
    ]),
  );
  const version = async (keyRef: string) =>
    (
      await pg.query<{ kek_version: number }>(
        'SELECT kek_version FROM base_spender_keys WHERE key_id = $1',
        [parseKeyRef(keyRef).keyId],
      )
    ).rows[0]!.kek_version;
  assert.equal(await version(wallet.keyRef), 2);
  for (const key of [service, envOnly, loose]) assert.equal(await version(key.keyRef), 1);
  const w2 = await pg.query<{ spender_key_ref: string }>(
    "SELECT spender_key_ref FROM base_wallets WHERE wallet_id = 'w2'",
  );
  assert.equal(w2.rows[0]!.spender_key_ref, envOnly.keyRef);
  const current = createKeystore({ store, keks: both });
  assert.equal(await current.withSigner(envOnly.keyRef, async (a) => a.address), envOnly.signer);
  assert.equal(
    await current.withSigner(`v2:${parseKeyRef(wallet.keyRef).keyId}`, async (a) => a.address),
    wallet.signer,
  );
});

test('rewrapSpenderKeys (CCA-707): --allow-missing-service-refs proceeds; table-recorded service keys stay protected', async (t) => {
  const { db, both, store, wallet, service } = await fixture(t);
  // The operator states no role holds a key here: the paymaster key recorded in own_paymaster_keys
  // is still a service key without its setting; wallet keys move with their address unchanged.
  const done = await rewrapSpenderKeys(db, both, { confirm: true, allowMissingServiceRefs: true });
  assert.equal(done.refused, false);
  assert.deepEqual(done.missingServiceRefs, [...SERVICE_KEY_REF_SETTINGS]);
  assert.equal(done.serviceKeys, 1);
  const current = createKeystore({ store, keks: both });
  assert.equal(
    await current.withSigner(`v2:${parseKeyRef(wallet.keyRef).keyId}`, async (a) => a.address),
    wallet.signer,
  );
  assert.equal(await current.withSigner(service.keyRef, async (a) => a.address), service.signer);
});
