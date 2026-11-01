import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import type { Database } from '../server/database.js';
import { createKeystore, parseKeks, parseKeyRef } from '../server/base/chain/keystore.js';
import { pgSpenderKeyStore } from '../server/base/chain/stores.js';
import { checkKekRetirement, verdictLine } from '../scripts/kek-retirement-check.js';
import {
  reportOrphanKeys,
  rewrapServiceKey,
  SERVICE_ROLES,
  type ServiceRewrapResult,
} from '../scripts/rewrap-service-key.js';
import {
  rewrapSpenderKeys,
  ALL_SERVICE_KEY_REF_SETTINGS,
  SERVICE_KEY_REF_SETTINGS,
  SERVICE_KEY_TABLES,
} from '../scripts/rewrap-spender-keys.js';

// scripts/rewrap-service-key.ts (CCA-707): moves one service key to the current KEK version in
// place, and reports keys nobody references. Throwaway in-memory keys and databases only.

const kekEntry = (version: number) => `v${version}:${randomBytes(32).toString('base64')}`;

async function fixture(t: { after(fn: () => unknown): void }, options: { orphans?: boolean } = {}) {
  const pg = await PGlite.create('memory://');
  t.after(() => pg.close());
  await pg.exec(`
    CREATE TABLE base_spender_keys (
      key_id text PRIMARY KEY, kek_version integer NOT NULL, wrapped_dek bytea NOT NULL,
      ciphertext bytea NOT NULL, signer_address text NOT NULL, committed_at bigint,
      created_at bigint NOT NULL);
    CREATE TABLE base_wallets (wallet_id text PRIMARY KEY, spender_key_ref text NOT NULL);
    CREATE TABLE own_paymaster_keys (purpose text PRIMARY KEY, key_ref text NOT NULL UNIQUE,
      address text NOT NULL, created_at bigint NOT NULL DEFAULT 0);
    CREATE TABLE feed_pay_sponsor_key (purpose text PRIMARY KEY, key_ref text NOT NULL UNIQUE,
      address text NOT NULL, created_at bigint NOT NULL DEFAULT 0);
    CREATE TABLE x402_facilitator_key (purpose text PRIMARY KEY, key_ref text NOT NULL UNIQUE,
      address text NOT NULL, created_at bigint NOT NULL DEFAULT 0);`);
  const db = {
    query: (sql: string, params?: unknown[]) => pg.query(sql, params) as never,
    exec: (sql: string) => pg.exec(sql),
    transaction: (action: (tx: never) => Promise<unknown>) =>
      pg.transaction((tx) => action(tx as never)),
  } as unknown as Database;
  const v1 = kekEntry(1);
  const v2 = kekEntry(2);
  const both = parseKeks(`${v1},${v2}`);
  const onlyV2 = parseKeks(v2);
  const store = pgSpenderKeyStore(db);
  const old = createKeystore({ store, keks: parseKeks(v1) });
  const make = async () => {
    const key = await old.createSpenderKey();
    await store.commit(key.keyRef);
    return key;
  };
  const keys = {
    wallet: await make(),
    signer: await make(),
    sub1: await make(),
    sub2: await make(),
    sponsor: await make(),
    router3: await make(),
    settle: await make(),
    arcRouter3: await make(),
  };
  const orphans = options.orphans
    ? { loose: await make(), pending: await old.createSpenderKey() }
    : undefined;
  await pg.query('INSERT INTO base_wallets VALUES ($1,$2)', ['w1', keys.wallet.keyRef]);
  const rows: [string, string, typeof keys.signer][] = [
    ['own_paymaster_keys', 'paymaster_signer', keys.signer],
    ['own_paymaster_keys', 'paymaster_submitter_1', keys.sub1],
    ['own_paymaster_keys', 'paymaster_submitter_2', keys.sub2],
    ['feed_pay_sponsor_key', 'sfp_sponsor', keys.sponsor],
    ['x402_facilitator_key', 'router3', keys.router3],
    ['x402_facilitator_key', 'public-settle', keys.settle],
    ['x402_facilitator_key', 'arc-router3', keys.arcRouter3],
  ];
  for (const [table, purpose, key] of rows)
    await pg.query(`INSERT INTO ${table} (purpose, key_ref, address) VALUES ($1,$2,$3)`, [
      purpose,
      key.keyRef,
      key.signer,
    ]);
  const env: Record<string, string> = {
    CITY_BASE_PAYMASTER_SIGNER_KEY_REF: keys.signer.keyRef,
    CITY_BASE_SUBMITTER_KEY_REFS: `${keys.sub1.keyRef},${keys.sub2.keyRef}`,
    CITY_SFP_SPONSOR_KEY_REF: keys.sponsor.keyRef,
    CITY_X402_FACILITATOR_KEY_REF: keys.router3.keyRef,
    CITY_X402_PUBLIC_SETTLE_KEY_REF: keys.settle.keyRef,
    CITY_ARC_FACILITATOR_KEY_REF: keys.arcRouter3.keyRef,
    // A key this database does not hold, under v2: not bound to v1.
    CITY_X402_PUBLIC_OFFER_KEY_REF: `v2:${randomUUID()}`,
  };
  const snapshot = async () => ({
    keys: (
      await pg.query(
        `SELECT key_id, kek_version, encode(wrapped_dek, 'hex') AS dek,
                encode(ciphertext, 'hex') AS ct, signer_address
           FROM base_spender_keys ORDER BY key_id`,
      )
    ).rows,
    refs: (
      await pg.query(
        `SELECT purpose, key_ref, address FROM own_paymaster_keys
         UNION ALL SELECT purpose, key_ref, address FROM feed_pay_sponsor_key
         UNION ALL SELECT purpose, key_ref, address FROM x402_facilitator_key ORDER BY 1`,
      )
    ).rows,
    wallets: (await pg.query('SELECT * FROM base_wallets ORDER BY 1')).rows,
  });
  const secrets = async () => {
    const values = [v1, v2, v1.slice(3), v2.slice(3), ...Object.values(env)];
    for (const key of [...Object.values(keys), ...Object.values(orphans ?? {})])
      values.push(key.keyRef, parseKeyRef(key.keyRef).keyId, key.signer, key.signer.toLowerCase());
    for (const row of (await snapshot()).keys)
      values.push((row as { dek: string }).dek, (row as { ct: string }).ct);
    return values;
  };
  /** The owner's setting change: the chosen entry's version prefix only. */
  const bump = (setting: string, index = 1) => {
    const parts = env[setting]!.split(',');
    parts[index - 1] = parts[index - 1]!.replace(/^v1:/, 'v2:');
    env[setting] = parts.join(',');
  };
  const version = async (keyRef: string) =>
    (
      await pg.query<{ kek_version: number }>(
        'SELECT kek_version FROM base_spender_keys WHERE key_id = $1',
        [parseKeyRef(keyRef).keyId],
      )
    ).rows[0]?.kek_version;
  return { pg, db, both, onlyV2, store, keys, orphans, env, snapshot, secrets, bump, version };
}

function assertNoSecrets(outputs: unknown[], values: string[]) {
  const text = outputs
    .map((out) =>
      typeof out === 'string'
        ? out
        : `${JSON.stringify(out)}\n${(out as ServiceRewrapResult).settingAction ?? ''}`,
    )
    .join('\n');
  for (const value of values) assert.ok(!text.includes(value), 'output carries key material');
}

/** One role per setting; the submitter list is two entries. */
const MOVES: { setting: string; index?: number; key: string; table: string; purpose: string }[] = [
  {
    setting: 'CITY_ARC_FACILITATOR_KEY_REF',
    key: 'arcRouter3',
    table: 'x402_facilitator_key',
    purpose: 'arc-router3',
  },
  {
    setting: 'CITY_X402_PUBLIC_SETTLE_KEY_REF',
    key: 'settle',
    table: 'x402_facilitator_key',
    purpose: 'public-settle',
  },
  {
    setting: 'CITY_X402_FACILITATOR_KEY_REF',
    key: 'router3',
    table: 'x402_facilitator_key',
    purpose: 'router3',
  },
  {
    setting: 'CITY_SFP_SPONSOR_KEY_REF',
    key: 'sponsor',
    table: 'feed_pay_sponsor_key',
    purpose: 'sfp_sponsor',
  },
  {
    setting: 'CITY_BASE_SUBMITTER_KEY_REFS',
    index: 1,
    key: 'sub1',
    table: 'own_paymaster_keys',
    purpose: 'paymaster_submitter_1',
  },
  {
    setting: 'CITY_BASE_SUBMITTER_KEY_REFS',
    index: 2,
    key: 'sub2',
    table: 'own_paymaster_keys',
    purpose: 'paymaster_submitter_2',
  },
  {
    setting: 'CITY_BASE_PAYMASTER_SIGNER_KEY_REF',
    key: 'signer',
    table: 'own_paymaster_keys',
    purpose: 'paymaster_signer',
  },
];

test('SERVICE_ROLES covers every service setting and only known service tables', () => {
  assert.deepEqual(Object.keys(SERVICE_ROLES).sort(), [...ALL_SERVICE_KEY_REF_SETTINGS].sort());
  for (const { table } of Object.values(SERVICE_ROLES))
    assert.ok((SERVICE_KEY_TABLES as readonly string[]).includes(table));
});

test('each service setting: dry run writes nothing; confirm moves exactly its key and row, same address', async (t) => {
  const { pg, db, both, store, keys, env, snapshot, secrets, bump, version } = await fixture(t);
  const outputs: unknown[] = [];
  for (const move of MOVES) {
    const key = keys[move.key as keyof typeof keys];
    const before = await snapshot();
    const dry = await rewrapServiceKey(db, both, { setting: move.setting, index: move.index, env });
    outputs.push(dry);
    assert.equal(dry.refused, false, `${move.setting}: ${dry.reason}`);
    assert.equal(dry.dryRun, true);
    assert.equal(dry.verified, true);
    assert.equal(dry.moved, false);
    assert.deepEqual([dry.fromVersion, dry.toVersion], [1, 2]);
    assert.deepEqual([dry.table, dry.purpose], [move.table, move.purpose]);
    assert.match(dry.settingAction!, /^Dry run, nothing written\. After --confirm: /);
    assert.deepEqual(await snapshot(), before, `${move.setting}: dry run wrote`);

    const done = await rewrapServiceKey(db, both, {
      setting: move.setting,
      index: move.index,
      env,
      confirm: true,
    });
    outputs.push(done);
    assert.equal(done.moved, true, `${move.setting}: ${done.reason}`);
    assert.match(
      done.settingAction!,
      new RegExp(`^Set ${move.setting} .*prefix v1: changed to v2:`),
    );
    const after = await snapshot();
    // Exactly one key row changed, and only its version and seal; its address is the same.
    const changed = after.keys.filter(
      (row, i) => JSON.stringify(row) !== JSON.stringify(before.keys[i]),
    );
    assert.equal(changed.length, 1);
    assert.equal((changed[0] as { key_id: string }).key_id, parseKeyRef(key.keyRef).keyId);
    assert.equal((changed[0] as { signer_address: string }).signer_address, key.signer);
    assert.equal(await version(key.keyRef), 2);
    const newRef = `v2:${parseKeyRef(key.keyRef).keyId}`;
    const row = await pg.query<{ key_ref: string; address: string }>(
      `SELECT key_ref, address FROM ${move.table} WHERE purpose = $1`,
      [move.purpose],
    );
    assert.equal(row.rows[0]!.key_ref, newRef);
    assert.equal(row.rows[0]!.address, key.signer);
    assert.deepEqual(after.wallets, before.wallets);
    // The key opens under the new ref to the same address; the old ref no longer does.
    const keystore = createKeystore({ store, keks: both });
    assert.equal(await keystore.withSigner(newRef, async (a) => a.address), key.signer);
    await assert.rejects(
      keystore.withSigner(key.keyRef, async (a) => a.address),
      /not found/,
    );

    // Until the setting changes, the gate still names it for v1; after, it counts it on v2.
    let gate = await checkKekRetirement(db, 1, { env });
    assert.ok(gate.settings.includes(move.setting));
    assert.equal(gate.serviceTables[move.table]!.purposes.includes(move.purpose), false);
    // A rerun before the setting changed: nothing to move, the action is repeated.
    const again = await rewrapServiceKey(db, both, {
      setting: move.setting,
      index: move.index,
      env,
      confirm: true,
    });
    assert.equal(again.alreadyCurrent, true);
    assert.equal(again.moved, false);
    assert.match(again.settingAction!, /^Set /);
    bump(move.setting, move.index);
    gate = await checkKekRetirement(db, 2, { env });
    assert.ok(gate.serviceTables[move.table]!.purposes.includes(move.purpose));
    assert.ok(gate.settings.includes(move.setting));
  }
  assertNoSecrets(outputs, await secrets());
});

test('refused, nothing written: unknown, unloaded, list without index, wallet key, shared, mismatch, versions', async (t) => {
  const { pg, db, both, onlyV2, keys, env, snapshot, secrets } = await fixture(t, {
    orphans: true,
  });
  const before = await snapshot();
  const outputs: ServiceRewrapResult[] = [];
  const expect = async (
    reason: string,
    setting: string,
    extra: Partial<Parameters<typeof rewrapServiceKey>[2]> = {},
    keks = both,
  ) => {
    for (const confirm of [false, true]) {
      const out = await rewrapServiceKey(db, keks, {
        setting,
        env,
        confirm,
        ...extra,
      });
      outputs.push(out);
      assert.equal(out.refused, true, `${reason}: not refused`);
      assert.equal(out.reason, reason);
      assert.equal(out.moved, false);
    }
  };
  await expect('unknown_setting', 'CITY_BASE_SPENDER_KEK');
  await expect('unknown_setting', 'CITY_SOMETHING_KEY_REF');
  await expect('setting_not_loaded', 'CITY_SFP_SPONSOR_KEY_REF', {
    env: { ...env, CITY_SFP_SPONSOR_KEY_REF: '' },
  });
  await expect('setting_not_loaded', 'CITY_SFP_SPONSOR_KEY_REF', {
    env: { ...env, CITY_SFP_SPONSOR_KEY_REF: 'not-a-ref' },
  });
  await expect('service_settings_not_loaded', 'CITY_SFP_SPONSOR_KEY_REF', {
    env: { CITY_SFP_SPONSOR_KEY_REF: env.CITY_SFP_SPONSOR_KEY_REF },
  });
  await expect('index_required', 'CITY_BASE_SUBMITTER_KEY_REFS');
  await expect('index_out_of_range', 'CITY_BASE_SUBMITTER_KEY_REFS', { index: 3 });
  // A wallet-referenced key belongs to rewrap-spender-keys.ts.
  await expect('wallet_referenced', 'CITY_X402_PUBLIC_SETTLE_KEY_REF', {
    env: { ...env, CITY_X402_PUBLIC_SETTLE_KEY_REF: keys.wallet.keyRef },
  });
  // Another role's setting or table row names the same key.
  await expect('shared_with_other_role', 'CITY_SFP_SPONSOR_KEY_REF', {
    env: { ...env, CITY_SFP_SPONSOR_KEY_REF: keys.router3.keyRef },
  });
  // The setting names a key the role's table row does not.
  await expect('setting_table_mismatch', 'CITY_SFP_SPONSOR_KEY_REF', {
    env: { ...env, CITY_SFP_SPONSOR_KEY_REF: (await fixtureLoose(pg)).ref },
  });
  // Target version not the configured current one, or not configured at all.
  await expect('target_not_current', 'CITY_SFP_SPONSOR_KEY_REF', { to: 1 });
  await expect('target_kek_unavailable', 'CITY_SFP_SPONSOR_KEY_REF', { to: 3 });
  // The old version is not configured: the key cannot be opened.
  await expect('old_kek_unavailable', 'CITY_SFP_SPONSOR_KEY_REF', {}, onlyV2);
  assert.deepEqual(await snapshot(), before);
  assertNoSecrets(outputs, await secrets());
});

/** The loose committed key of the orphan fixture, as a v1 ref (test helper only). */
async function fixtureLoose(pg: PGlite) {
  const { rows } = await pg.query<{ key_id: string }>(
    `SELECT key_id FROM base_spender_keys k WHERE committed_at IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM base_wallets w WHERE split_part(w.spender_key_ref, ':', 2) = k.key_id)
        AND NOT EXISTS (SELECT 1 FROM own_paymaster_keys p WHERE split_part(p.key_ref, ':', 2) = k.key_id)
        AND NOT EXISTS (SELECT 1 FROM feed_pay_sponsor_key s WHERE split_part(s.key_ref, ':', 2) = k.key_id)
        AND NOT EXISTS (SELECT 1 FROM x402_facilitator_key f WHERE split_part(f.key_ref, ':', 2) = k.key_id)`,
  );
  assert.equal(rows.length, 1);
  return { ref: `v1:${rows[0]!.key_id}` };
}

test('a mismatch aborts and rolls back: stored address, table address, swapped seal, failed row update', async (t) => {
  const { pg, db, both, keys, env, snapshot, secrets, version } = await fixture(t, {
    orphans: true,
  });
  const outputs: ServiceRewrapResult[] = [];
  const sponsorId = parseKeyRef(keys.sponsor.keyRef).keyId;

  // Uncommitted key named by a setting.
  const pending = (
    await pg.query<{ key_id: string }>(
      'SELECT key_id FROM base_spender_keys WHERE committed_at IS NULL',
    )
  ).rows[0]!.key_id;
  await pg.query("UPDATE x402_facilitator_key SET key_ref = $1 WHERE purpose = 'public-settle'", [
    `v1:${pending}`,
  ]);
  let out = await rewrapServiceKey(db, both, {
    setting: 'CITY_X402_PUBLIC_SETTLE_KEY_REF',
    env: { ...env, CITY_X402_PUBLIC_SETTLE_KEY_REF: `v1:${pending}` },
    confirm: true,
  });
  outputs.push(out);
  assert.equal(out.reason, 'uncommitted');
  await pg.query("UPDATE x402_facilitator_key SET key_ref = $1 WHERE purpose = 'public-settle'", [
    keys.settle.keyRef,
  ]);

  // The stored address no longer matches what the key derives (and the table's).
  const before = await snapshot();
  await pg.query(
    "UPDATE base_spender_keys SET signer_address = '0x0000000000000000000000000000000000000001' WHERE key_id = $1",
    [sponsorId],
  );
  await pg.query(
    "UPDATE feed_pay_sponsor_key SET address = '0x0000000000000000000000000000000000000001'",
  );
  const tampered = await snapshot();
  out = await rewrapServiceKey(db, both, {
    setting: 'CITY_SFP_SPONSOR_KEY_REF',
    env,
    confirm: true,
  });
  outputs.push(out);
  assert.equal(out.reason, 'address_mismatch');
  assert.deepEqual(await snapshot(), tampered);
  await pg.query('UPDATE base_spender_keys SET signer_address = $2 WHERE key_id = $1', [
    sponsorId,
    keys.sponsor.signer,
  ]);
  // Only the table's address differs.
  out = await rewrapServiceKey(db, both, {
    setting: 'CITY_SFP_SPONSOR_KEY_REF',
    env,
    confirm: true,
  });
  outputs.push(out);
  assert.equal(out.reason, 'address_mismatch');
  await pg.query('UPDATE feed_pay_sponsor_key SET address = $1', [keys.sponsor.signer]);
  assert.deepEqual(await snapshot(), before);

  // A seal swapped in from another row does not open under this key's binding.
  await pg.query(
    `UPDATE base_spender_keys SET ciphertext = (SELECT ciphertext FROM base_spender_keys WHERE key_id = $2)
      WHERE key_id = $1`,
    [sponsorId, parseKeyRef(keys.router3.keyRef).keyId],
  );
  const swapped = await snapshot();
  out = await rewrapServiceKey(db, both, {
    setting: 'CITY_SFP_SPONSOR_KEY_REF',
    env,
    confirm: true,
  });
  outputs.push(out);
  assert.equal(out.reason, 'open_failed');
  assert.deepEqual(await snapshot(), swapped);

  // The table row update fails after the key row was written: the whole transaction rolls back.
  await pg.exec(`
    CREATE FUNCTION refuse_update() RETURNS trigger LANGUAGE plpgsql AS
      $$ BEGIN RAISE EXCEPTION 'refused by test'; END $$;
    CREATE TRIGGER refuse BEFORE UPDATE ON x402_facilitator_key
      FOR EACH ROW EXECUTE FUNCTION refuse_update();`);
  const beforeFail = await snapshot();
  out = await rewrapServiceKey(db, both, {
    setting: 'CITY_X402_FACILITATOR_KEY_REF',
    env,
    confirm: true,
  });
  outputs.push(out);
  assert.equal(out.reason, 'failed');
  assert.equal(out.moved, false);
  assert.equal(await version(keys.router3.keyRef), 1);
  assert.deepEqual(await snapshot(), beforeFail);
  assert.doesNotMatch(JSON.stringify(out), /refused by test/);
  assertNoSecrets(outputs, await secrets());
});

test('--orphans: report only, counts per version; addresses only on request; nothing written', async (t) => {
  const { db, orphans, env, snapshot, secrets } = await fixture(t, { orphans: true });
  const before = await snapshot();
  const refused = await reportOrphanKeys(db, {});
  assert.equal(refused.refused, true);
  assert.equal(refused.reason, 'service_settings_not_loaded');
  const report = await reportOrphanKeys(db, { env });
  assert.equal(report.refused, false);
  assert.deepEqual(report.byVersion, { v1: { committed: 1, uncommitted: 1 } });
  assert.equal(report.addresses, undefined);
  const values = await secrets();
  assertNoSecrets([report], values);
  const listed = await reportOrphanKeys(db, { env, version: 1, showAddresses: true });
  assert.deepEqual(listed.addresses, [orphans!.loose.signer]);
  // Public addresses are the only addition: never key ids, refs or seals.
  assertNoSecrets(
    [listed],
    values.filter((v) => v !== orphans!.loose.signer && v !== orphans!.loose.signer.toLowerCase()),
  );
  assert.deepEqual(await snapshot(), before);
});

test('end to end: wallet re-wrap, every service key moved, settings changed, gate passes; v2 alone signs', async (t) => {
  const { db, both, onlyV2, store, keys, env, bump, secrets } = await fixture(t);
  let gate = await checkKekRetirement(db, 1, { env });
  assert.equal(gate.safeToRetire, false);
  assert.equal(gate.sealedKeys.service, 7);
  const wallets = await rewrapSpenderKeys(db, both, { env, confirm: true });
  assert.equal(wallets.rewrapped, 1);
  const outputs: unknown[] = [wallets];
  for (const move of MOVES) {
    const done = await rewrapServiceKey(db, both, {
      setting: move.setting,
      index: move.index,
      env,
      confirm: true,
    });
    outputs.push(done);
    assert.equal(done.moved, true, `${move.setting}: ${done.reason}`);
    bump(move.setting, move.index);
  }
  gate = await checkKekRetirement(db, 1, { env });
  outputs.push(gate, verdictLine(gate));
  assert.equal(gate.safeToRetire, true, gate.reasons.join(','));
  assert.match(verdictLine(gate), /^SAFE TO RETIRE v1:/);
  assert.deepEqual(gate.versions, { v2: 8 });
  // v1 removed: every key still signs as the same address through the configured refs.
  const retired = createKeystore({ store, keks: onlyV2 });
  for (const [name, key] of Object.entries(keys))
    assert.equal(
      await retired.withSigner(`v2:${parseKeyRef(key.keyRef).keyId}`, async (a) => a.address),
      key.signer,
      name,
    );
  for (const setting of SERVICE_KEY_REF_SETTINGS)
    for (const ref of env[setting]!.split(',')) assert.match(ref, /^v2:/);
  assertNoSecrets(outputs, await secrets());
});

test('CLI: no mode, both modes, unknown flags or mixed options are usage errors (exit 1)', () => {
  for (const args of [
    [],
    ['--service'],
    ['--orphans', '--service', 'CITY_SFP_SPONSOR_KEY_REF'],
    ['--orphans', '--confirm'],
    ['--service', 'CITY_SFP_SPONSOR_KEY_REF', '--show-addresses'],
    ['--service', 'CITY_SFP_SPONSOR_KEY_REF', '--delete'],
    ['--service', 'CITY_SFP_SPONSOR_KEY_REF', '--index', 'x'],
  ]) {
    const run = spawnSync(
      process.execPath,
      ['node_modules/tsx/dist/cli.mjs', 'scripts/rewrap-service-key.ts', ...args],
      {
        encoding: 'utf8',
        env: { PATH: process.env.PATH ?? '', SYSTEMROOT: process.env.SYSTEMROOT ?? '' },
      },
    );
    assert.equal(run.status, 1, args.join(' '));
    assert.match(run.stderr, /Usage: rewrap-service-key\.ts --service/);
    assert.equal(run.stdout, '');
  }
});
