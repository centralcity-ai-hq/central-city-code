import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import type { Database } from '../server/database.js';
import { createApp } from '../server/app.js';
import {
  createKeystore,
  parseKeks,
  parseKeyRef,
  rewrapStoredSpenderKey,
} from '../server/base/chain/keystore.js';
import { pgSpenderKeyStore } from '../server/base/chain/stores.js';
import {
  checkKekRetirement,
  parseRetireVersion,
  verdictLine,
  type KekRetirementReport,
} from '../scripts/kek-retirement-check.js';
import { rewrapSpenderKeys, SERVICE_KEY_REF_SETTINGS } from '../scripts/rewrap-spender-keys.js';

// scripts/kek-retirement-check.ts (CCA-707): the read-only gate before an old
// CITY_BASE_SPENDER_KEK version is removed. Throwaway in-memory keys and databases only.

process.env.CITY_RATE_LIMIT_KEY ??= 'synthetic-kek-retirement-test-only-stand-in';

const kekEntry = (version: number) => `v${version}:${randomBytes(32).toString('base64')}`;

const asDb = (pg: PGlite) =>
  ({
    query: (sql: string, params?: unknown[]) => pg.query(sql, params) as never,
    exec: (sql: string) => pg.exec(sql),
    transaction: (action: (tx: never) => Promise<unknown>) =>
      pg.transaction((tx) => action(tx as never)),
  }) as unknown as Database;

/**
 * Keys under v1: a wallet key, a paymaster signer recorded in own_paymaster_keys, a sponsor key
 * recorded in feed_pay_sponsor_key, a router-3 facilitator key recorded in x402_facilitator_key,
 * a public settle key named only by its setting, and one key nothing references.
 */
async function fixture(t: { after(fn: () => unknown): void }) {
  const pg = await PGlite.create('memory://');
  t.after(() => pg.close());
  await pg.exec(`
    CREATE TABLE base_spender_keys (
      key_id text PRIMARY KEY, kek_version integer NOT NULL, wrapped_dek bytea NOT NULL,
      ciphertext bytea NOT NULL, signer_address text NOT NULL, committed_at bigint,
      created_at bigint NOT NULL);
    CREATE TABLE base_wallets (wallet_id text PRIMARY KEY, spender_key_ref text NOT NULL);
    CREATE TABLE own_paymaster_keys (purpose text PRIMARY KEY, key_ref text NOT NULL);
    CREATE TABLE feed_pay_sponsor_key (purpose text PRIMARY KEY, key_ref text NOT NULL);
    CREATE TABLE x402_facilitator_key (purpose text PRIMARY KEY, key_ref text NOT NULL);
    CREATE TABLE responder_credentials (id text PRIMARY KEY, kek_id text, wrapped_dek bytea);`);
  const db = asDb(pg);
  const v1 = kekEntry(1);
  const v2 = kekEntry(2);
  const both = parseKeks(`${v1},${v2}`);
  const store = pgSpenderKeyStore(db);
  const old = createKeystore({ store, keks: parseKeks(v1) });
  const keys = {
    wallet: await old.createSpenderKey(),
    paymaster: await old.createSpenderKey(),
    sponsor: await old.createSpenderKey(),
    router3: await old.createSpenderKey(),
    publicSettle: await old.createSpenderKey(),
    loose: await old.createSpenderKey(),
  };
  for (const key of Object.values(keys)) await store.commit(key.keyRef);
  await pg.query('INSERT INTO base_wallets VALUES ($1,$2)', ['w1', keys.wallet.keyRef]);
  await pg.query('INSERT INTO own_paymaster_keys VALUES ($1,$2)', [
    'paymaster_signer',
    keys.paymaster.keyRef,
  ]);
  await pg.query('INSERT INTO feed_pay_sponsor_key VALUES ($1,$2)', [
    'sfp_sponsor',
    keys.sponsor.keyRef,
  ]);
  await pg.query('INSERT INTO x402_facilitator_key VALUES ($1,$2)', [
    'router3',
    keys.router3.keyRef,
  ]);
  const env: Record<string, string> = {
    CITY_BASE_PAYMASTER_SIGNER_KEY_REF: keys.paymaster.keyRef,
    // A submitter key this database does not hold, under v2: not bound to v1.
    CITY_BASE_SUBMITTER_KEY_REFS: `v2:${randomUUID()}`,
    CITY_SFP_SPONSOR_KEY_REF: keys.sponsor.keyRef,
    CITY_X402_FACILITATOR_KEY_REF: keys.router3.keyRef,
    CITY_X402_PUBLIC_SETTLE_KEY_REF: keys.publicSettle.keyRef,
    // A key this database does not hold, under v2: not bound to v1.
    CITY_X402_PUBLIC_OFFER_KEY_REF: `v2:${randomUUID()}`,
  };
  const snapshot = async () =>
    (
      await pg.query(
        `SELECT k.key_id, k.kek_version, encode(k.wrapped_dek, 'hex') AS dek,
                encode(k.ciphertext, 'hex') AS ct,
                (SELECT string_agg(spender_key_ref, ',') FROM base_wallets) AS w,
                (SELECT string_agg(key_ref, ',') FROM own_paymaster_keys) AS p,
                (SELECT string_agg(key_ref, ',') FROM feed_pay_sponsor_key) AS s,
                (SELECT string_agg(key_ref, ',') FROM x402_facilitator_key) AS f
           FROM base_spender_keys k ORDER BY k.key_id`,
      )
    ).rows;
  /** The owner's coordinated service step, simulated: re-wrap one key and move its table row. */
  const moveServiceKey = async (keyRef: string, table?: string) => {
    const { keyId } = parseKeyRef(keyRef);
    const row = (await store.get(keyId))!;
    const next = rewrapStoredSpenderKey(row, both);
    await pg.query(
      'UPDATE base_spender_keys SET kek_version = $2, wrapped_dek = $3, ciphertext = $4 WHERE key_id = $1',
      [keyId, next.kekVersion, Buffer.from(next.wrappedDek), Buffer.from(next.ciphertext)],
    );
    if (table)
      await pg.query(`UPDATE ${table} SET key_ref = $2 WHERE key_ref = $1`, [keyRef, next.keyRef]);
    return next.keyRef;
  };
  /** Every secret-ish value of the fixture: none may appear in the gate's output. */
  const secrets = async () => {
    const values = [v1, v2, v1.slice(3), v2.slice(3), ...Object.values(env)];
    for (const key of Object.values(keys))
      values.push(key.keyRef, parseKeyRef(key.keyRef).keyId, key.signer, key.signer.toLowerCase());
    for (const row of await snapshot())
      values.push((row as { dek: string }).dek, (row as { ct: string }).ct);
    return values;
  };
  return { pg, db, both, store, keys, env, snapshot, moveServiceKey, secrets };
}

const printed = (report: KekRetirementReport) =>
  `${JSON.stringify(report)}\n${verdictLine(report)}`;

function assertNoSecrets(output: string, values: string[]) {
  for (const value of values)
    assert.ok(!output.includes(value), 'gate output carries key material');
}

test('parseRetireVersion: v1 or 1; anything else refused', () => {
  assert.equal(parseRetireVersion('v1'), 1);
  assert.equal(parseRetireVersion('12'), 12);
  for (const bad of [undefined, '', 'v0', 'v', 'v1:abc', '-1', 'v1,v2', 'latest'])
    assert.throws(() => parseRetireVersion(bad), /v1/);
});

test('gate refuses while service, unreferenced and wallet records are sealed under v1; reads only', async (t) => {
  const { db, env, snapshot, secrets } = await fixture(t);
  const before = await snapshot();
  const report = await checkKekRetirement(db, 1, { env });
  assert.equal(report.safeToRetire, false);
  assert.deepEqual(report.sealedKeys, {
    total: 6,
    wallet: 1,
    service: 4,
    uncommitted: 0,
    unreferenced: 1,
  });
  assert.equal(report.walletRefs, 1);
  assert.deepEqual(report.serviceTables, {
    own_paymaster_keys: { present: true, rows: 1, purposes: ['paymaster_signer'] },
    feed_pay_sponsor_key: { present: true, rows: 1, purposes: ['sfp_sponsor'] },
    x402_facilitator_key: { present: true, rows: 1, purposes: ['router3'] },
  });
  assert.deepEqual(report.settings, [
    'CITY_BASE_PAYMASTER_SIGNER_KEY_REF',
    'CITY_SFP_SPONSOR_KEY_REF',
    'CITY_X402_FACILITATOR_KEY_REF',
    'CITY_X402_PUBLIC_SETTLE_KEY_REF',
  ]);
  assert.deepEqual(report.reasons, ['sealed_keys', 'wallet_refs', 'service_rows', 'settings']);
  assert.deepEqual(report.versions, { v1: 6 });
  assert.deepEqual(report.otherKeyRings, ['responder_credentials']);
  assert.deepEqual(report.unknownTables, []);
  assert.match(verdictLine(report), /^NOT SAFE TO RETIRE v1: /);
  // v2 holds no record yet, but the submitter setting already names a v2 ref: that alone blocks.
  const v2 = await checkKekRetirement(db, 2, { env });
  assert.deepEqual(v2.reasons, ['settings']);
  assert.deepEqual(v2.settings, ['CITY_BASE_SUBMITTER_KEY_REFS', 'CITY_X402_PUBLIC_OFFER_KEY_REF']);
  assert.equal(v2.sealedKeys.total, 0);
  assertNoSecrets(printed(report), await secrets());
  // Nothing was written.
  assert.deepEqual(await snapshot(), before);
});

test('gate: wallet keys re-wrapped is not enough; each service record and the unreferenced key still block', async (t) => {
  const { pg, db, both, keys, env, moveServiceKey, secrets } = await fixture(t);
  const moved = await rewrapSpenderKeys(db, both, { env, confirm: true });
  assert.equal(moved.rewrapped, 1);
  let report = await checkKekRetirement(db, 1, { env });
  assert.equal(report.safeToRetire, false);
  assert.equal(report.walletRefs, 0);
  assert.deepEqual(report.sealedKeys, {
    total: 5,
    wallet: 0,
    service: 4,
    uncommitted: 0,
    unreferenced: 1,
  });

  // The paymaster record moved, its setting not yet: the setting alone still blocks.
  const paymaster = await moveServiceKey(keys.paymaster.keyRef, 'own_paymaster_keys');
  report = await checkKekRetirement(db, 1, { env });
  assert.equal(report.serviceTables.own_paymaster_keys!.rows, 0);
  assert.ok(report.settings.includes('CITY_BASE_PAYMASTER_SIGNER_KEY_REF'));
  env.CITY_BASE_PAYMASTER_SIGNER_KEY_REF = paymaster;
  env.CITY_SFP_SPONSOR_KEY_REF = await moveServiceKey(keys.sponsor.keyRef, 'feed_pay_sponsor_key');
  env.CITY_X402_FACILITATOR_KEY_REF = await moveServiceKey(
    keys.router3.keyRef,
    'x402_facilitator_key',
  );
  env.CITY_X402_PUBLIC_SETTLE_KEY_REF = await moveServiceKey(keys.publicSettle.keyRef);

  // Only the key nothing references is left on v1: still refused.
  report = await checkKekRetirement(db, 1, { env });
  assert.equal(report.safeToRetire, false);
  assert.deepEqual(report.reasons, ['sealed_keys']);
  assert.equal(report.sealedKeys.unreferenced, 1);
  assert.equal(report.sealedKeys.total, 1);

  // An uncommitted key on v1 blocks too.
  await pg.query('UPDATE base_spender_keys SET committed_at = NULL WHERE key_id = $1', [
    parseKeyRef(keys.loose.keyRef).keyId,
  ]);
  report = await checkKekRetirement(db, 1, { env });
  assert.equal(report.sealedKeys.uncommitted, 1);
  assert.equal(report.safeToRetire, false);
  assertNoSecrets(printed(report), await secrets());

  // Once it is moved too, v1 holds nothing: safe, exit-0 verdict.
  await moveServiceKey(keys.loose.keyRef);
  report = await checkKekRetirement(db, 1, { env });
  assert.equal(report.safeToRetire, true);
  assert.deepEqual(report.reasons, []);
  assert.deepEqual(report.versions, { v2: 6 });
  assert.match(verdictLine(report), /^SAFE TO RETIRE v1:/);
  assertNoSecrets(printed(report), await secrets());

  // A setting left on an old v1 ref (its key already on v2) still blocks: that service would break.
  report = await checkKekRetirement(db, 1, {
    env: { ...env, CITY_SFP_SPONSOR_KEY_REF: keys.sponsor.keyRef },
  });
  assert.deepEqual(report.reasons, ['settings']);
  assert.deepEqual(report.settings, ['CITY_SFP_SPONSOR_KEY_REF']);
  // So does a service table row left on its old ref.
  await pg.query("UPDATE x402_facilitator_key SET key_ref = $1 WHERE purpose = 'router3'", [
    keys.router3.keyRef,
  ]);
  report = await checkKekRetirement(db, 1, { env });
  assert.deepEqual(report.reasons, ['service_rows']);
  assert.deepEqual(report.serviceTables.x402_facilitator_key!.purposes, ['router3']);
});

test('gate validates every wallet ref: a malformed one refuses (count only); well-formed v2 refs pass', async (t) => {
  const { pg, db, both, keys, env, moveServiceKey, secrets } = await fixture(t);
  await rewrapSpenderKeys(db, both, { env, confirm: true });
  env.CITY_BASE_PAYMASTER_SIGNER_KEY_REF = await moveServiceKey(
    keys.paymaster.keyRef,
    'own_paymaster_keys',
  );
  env.CITY_SFP_SPONSOR_KEY_REF = await moveServiceKey(keys.sponsor.keyRef, 'feed_pay_sponsor_key');
  env.CITY_X402_FACILITATOR_KEY_REF = await moveServiceKey(
    keys.router3.keyRef,
    'x402_facilitator_key',
  );
  env.CITY_X402_PUBLIC_SETTLE_KEY_REF = await moveServiceKey(keys.publicSettle.keyRef);
  await moveServiceKey(keys.loose.keyRef);
  // A second wallet on a well-formed v2 ref of a key that is not in this database.
  await pg.query('INSERT INTO base_wallets VALUES ($1,$2)', ['w2', `v2:${randomUUID()}`]);
  let report = await checkKekRetirement(db, 1, { env });
  assert.equal(report.safeToRetire, true, report.reasons.join(','));
  assert.deepEqual(report.malformedRefs, []);
  assert.equal((await checkKekRetirement(db, 2, { env })).walletRefs, 2);

  // Refs that LIKE / split_part would not catch: none of them may pass the gate.
  const id = randomUUID();
  const bad = [
    `v1:${id.slice(0, 35)}`,
    `v01:${id}`,
    `v1:${id}:x`,
    `V1:${id}`,
    ` v1:${id}`,
    `v1:${id.toUpperCase()}`,
    'v1:',
    `vx:${id}`,
    'garbage-wallet-ref-value',
  ];
  for (const [i, ref] of bad.entries())
    await pg.query('INSERT INTO base_wallets VALUES ($1,$2)', [`bad${i}`, ref]);
  for (const version of [1, 2, 3]) {
    report = await checkKekRetirement(db, version, { env });
    assert.equal(report.safeToRetire, false);
    assert.ok(report.reasons.includes('malformed_refs'));
    assert.deepEqual(report.malformedRefs, ['base_wallets']);
    assert.deepEqual(report.malformedRefCounts, { base_wallets: bad.length });
    assert.match(verdictLine(report), /^NOT SAFE TO RETIRE v\d: .*malformed_refs/);
    const output = printed(report);
    // ('v1:' alone is also the verdict's own wording, so only the longer values are searched.)
    for (const ref of bad.filter((value) => value.length > 8))
      assert.ok(!output.includes(ref.trim()), 'malformed ref value printed');
    assert.ok(!output.includes(id) && !output.includes(id.slice(0, 35)));
    assertNoSecrets(output, await secrets());
  }
  report = await checkKekRetirement(db, 1, { env });
  assert.deepEqual(report.reasons, ['malformed_refs']);
  // A malformed service row counts under its own table, next to the wallets.
  await pg.query("INSERT INTO x402_facilitator_key VALUES ('public-settle', 'garbage')");
  report = await checkKekRetirement(db, 1, { env });
  assert.deepEqual(report.malformedRefs, ['base_wallets', 'x402_facilitator_key']);
  assert.deepEqual(report.malformedRefCounts, {
    base_wallets: bad.length,
    x402_facilitator_key: 1,
  });
  await pg.exec(
    "DELETE FROM base_wallets WHERE wallet_id LIKE 'bad%'; DELETE FROM x402_facilitator_key WHERE purpose = 'public-settle'",
  );
  assert.equal((await checkKekRetirement(db, 1, { env })).safeToRetire, true);
});

test('gate fails closed: read error, missing base table, unknown table, malformed ref, settings not loaded', async (t) => {
  const { pg, db, env, secrets } = await fixture(t);

  // Read errors: the transaction itself, or any one query inside it. The error is not reported.
  const failing = {
    transaction: async () => {
      throw new Error(`connection to postgres://user:${randomUUID()}@db failed`);
    },
  } as unknown as Database;
  let report = await checkKekRetirement(failing, 1, { env });
  assert.deepEqual(report.reasons, ['read_error']);
  assert.equal(report.safeToRetire, false);
  assert.doesNotMatch(printed(report), /postgres:|failed/);
  const brokenQuery = {
    transaction: (action: (tx: unknown) => Promise<unknown>) =>
      pg.transaction((tx) =>
        action({
          query: (sql: string, params?: unknown[]) =>
            /feed_pay_sponsor_key/.test(sql)
              ? Promise.reject(new Error('permission denied'))
              : tx.query(sql, params),
        }),
      ),
  } as unknown as Database;
  report = await checkKekRetirement(brokenQuery, 1, { env });
  assert.deepEqual(report.reasons, ['read_error']);
  assert.equal(report.sealedKeys.total, 0);

  // Settings not loaded: refused unless stated; the stated run still counts the v1 records.
  report = await checkKekRetirement(db, 3, {});
  assert.deepEqual(report.reasons, ['missing_service_refs']);
  assert.deepEqual(report.missingServiceRefs, [...SERVICE_KEY_REF_SETTINGS]);
  report = await checkKekRetirement(db, 3, { env: {}, allowMissingServiceRefs: true });
  assert.equal(report.safeToRetire, true);
  report = await checkKekRetirement(db, 3, {
    env: { ...env, CITY_BASE_SUBMITTER_KEY_REFS: 'not-a-ref' },
  });
  assert.deepEqual(report.missingServiceRefs, ['CITY_BASE_SUBMITTER_KEY_REFS']);
  assert.equal(report.safeToRetire, false);

  // A table holding key refs or sealed columns that the gate does not know.
  await pg.exec('CREATE TABLE new_service_key (purpose text PRIMARY KEY, key_ref text NOT NULL)');
  report = await checkKekRetirement(db, 3, { env });
  assert.deepEqual(report.reasons, ['unknown_tables']);
  assert.deepEqual(report.unknownTables, ['new_service_key']);
  await pg.exec('DROP TABLE new_service_key; CREATE TABLE vault2 (sealed_blob bytea)');
  assert.deepEqual((await checkKekRetirement(db, 3, { env })).unknownTables, ['vault2']);
  await pg.exec('DROP TABLE vault2');

  // A recorded service ref that is not a key ref.
  await pg.query("INSERT INTO x402_facilitator_key VALUES ('public-settle', 'garbage')");
  report = await checkKekRetirement(db, 3, { env });
  assert.deepEqual(report.reasons, ['malformed_refs']);
  assert.deepEqual(report.malformedRefs, ['x402_facilitator_key']);
  await pg.exec("DELETE FROM x402_facilitator_key WHERE purpose = 'public-settle'");

  // A database without the keystore tables (wrong database): refused.
  await pg.exec('ALTER TABLE base_spender_keys RENAME TO old_keys');
  report = await checkKekRetirement(db, 1, { env });
  assert.ok(report.reasons.includes('missing_tables'));
  assert.deepEqual(report.missingTables, ['base_spender_keys']);
  assert.equal(report.safeToRetire, false);
  assertNoSecrets(printed(report), await secrets().catch(() => []));
});

test("gate and Arc's facilitator: unset passes, bound or recorded blocks, malformed refuses", async (t) => {
  const { pg, db, env } = await fixture(t);
  // Unset is never "not loaded".
  let report = await checkKekRetirement(db, 3, { env });
  assert.deepEqual(report.missingServiceRefs, []);
  assert.equal(report.safeToRetire, true);
  // Malformed fails closed.
  report = await checkKekRetirement(db, 3, {
    env: { ...env, CITY_ARC_FACILITATOR_KEY_REF: 'not-a-ref' },
  });
  assert.deepEqual(report.reasons, ['missing_service_refs']);
  assert.deepEqual(report.missingServiceRefs, ['CITY_ARC_FACILITATOR_KEY_REF']);
  // A setting bound to the version holds it back, by name.
  const ref = `v3:${randomUUID()}`;
  report = await checkKekRetirement(db, 3, { env: { ...env, CITY_ARC_FACILITATOR_KEY_REF: ref } });
  assert.deepEqual(report.settings, ['CITY_ARC_FACILITATOR_KEY_REF']);
  assert.equal(report.safeToRetire, false);
  // So does its recorded row, with no setting at all.
  await pg.query("INSERT INTO x402_facilitator_key VALUES ('arc-router3', $1)", [ref]);
  report = await checkKekRetirement(db, 3, { env });
  assert.deepEqual(report.serviceTables.x402_facilitator_key!.purposes, ['arc-router3']);
  assert.equal(report.safeToRetire, false);
});

test('gate on the full app schema: every sealed or key ref column belongs to a known table', async (t) => {
  const database = await PGlite.create('memory://');
  const app = await createApp({
    database,
    hosted: {
      databaseUrl: 'postgres://unused.invalid/test',
      publicOrigin: 'https://centralcity.ai',
      allowedOrigins: ['https://centralcity.ai'],
    },
    startWorkers: false,
  });
  t.after(() => app.close());
  const env = Object.fromEntries(
    SERVICE_KEY_REF_SETTINGS.map((name) => [name, `v2:${randomUUID()}`]),
  );
  const report = await checkKekRetirement(asDb(database), 1, { env });
  assert.deepEqual(report.unknownTables, [], 'a new table holds keys: teach the gate about it');
  assert.deepEqual(report.missingTables, []);
  assert.deepEqual(
    Object.values(report.serviceTables).map((entry) => entry.present),
    [true, true, true],
  );
  assert.deepEqual(report.otherKeyRings.sort(), [
    'base_owner_vaults',
    'elric_age_checks',
    'responder_credentials',
  ]);
  assert.equal(report.safeToRetire, true);
});

test('CLI: a missing or malformed version is a usage error (exit 1) before any database is opened', () => {
  for (const args of [[], ['latest'], ['v1', '--confirm']]) {
    const run = spawnSync(
      process.execPath,
      ['node_modules/tsx/dist/cli.mjs', 'scripts/kek-retirement-check.ts', ...args],
      {
        encoding: 'utf8',
        env: { PATH: process.env.PATH ?? '', SYSTEMROOT: process.env.SYSTEMROOT ?? '' },
      },
    );
    assert.equal(run.status, 1, run.stderr);
    assert.match(run.stderr, /Usage: kek-retirement-check\.ts v<version>/);
    assert.equal(run.stdout, '');
  }
  // DATABASE_URL without CITY_HOSTED=1 (or the reverse): refused before anything is opened, so a
  // gate can never answer SAFE from the local directory by mistake.
  for (const extra of [
    { DATABASE_URL: 'postgres://u:synthetic@db.invalid/app' },
    { CITY_HOSTED: '1' },
  ]) {
    const run = spawnSync(
      process.execPath,
      ['node_modules/tsx/dist/cli.mjs', 'scripts/kek-retirement-check.ts', 'v1'],
      {
        encoding: 'utf8',
        env: { PATH: process.env.PATH ?? '', SYSTEMROOT: process.env.SYSTEMROOT ?? '', ...extra },
      },
    );
    assert.equal(run.status, 1, run.stderr);
    assert.match(run.stderr, /^NOT SAFE TO RETIRE v1: /);
    assert.doesNotMatch(run.stderr, /synthetic/);
    assert.equal(run.stdout, '');
  }
});
