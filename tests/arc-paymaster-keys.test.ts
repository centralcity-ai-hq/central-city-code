import test from 'node:test';
import { protocolArcChainIdFromEnv } from '../server/protocol/fees/cron.js';
import { registrationChainOn } from '../server/base/identity/routes.js';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import Fastify from 'fastify';
import { PGlite } from '@electric-sql/pglite';
import type { Database } from '../server/database.js';
import { BASE_MAINNET, BASE_SEPOLIA } from '../shared/base/chains.js';
import { ARC_MAINNET, ARC_TESTNET, chainNetwork } from '../shared/chains.js';
import {
  arcPaymasterSide,
  arcRuntimeEnv,
  paymasterSide,
  paymasterSides,
} from '../server/base/chain/arc-env.js';
import { createDirectBundler, lazyBundler } from '../server/base/chain/direct-bundler.js';
import {
  arcPaymasterKeySharedWithBase,
  arcPaymasterKeysUsable,
  checkKeyRolesAtStart,
  keyRefSharedWithOtherRole,
} from '../server/base/chain/key-roles.js';
import {
  ARC_PAYMASTER_KEY_PURPOSES,
  OWN_PAYMASTER_KEYS_ARC_PURPOSES_SQL,
  OWN_PAYMASTER_KEYS_SQL,
  ownPaymasterKeysArcPurposesMigration,
  PAYMASTER_ARC_PUBLIC_PATH,
  PAYMASTER_KEY_PURPOSES,
  PAYMASTER_KEYS_PATH,
  PAYMASTER_PUBLIC_PATH,
  paymasterKeyPurposes,
  paymasterKeysMismatchLogLine,
  provisionedPaymasterKeys,
  provisionPaymasterKeys,
  provisionPaymasterKeysAtStart,
  registerOwnPaymasterKeysRoute,
  registerPaymasterPublicRoute,
} from '../server/base/chain/own-paymaster-keys.js';
import { parseKeks } from '../server/base/chain/keystore.js';
import { createChainRuntime } from '../server/base/chain/runtime.js';
import { createApp } from '../server/app.js';
import { checkKekRetirement } from '../scripts/kek-retirement-check.js';
import { rewrapServiceKey, reportOrphanKeys } from '../scripts/rewrap-service-key.js';
import {
  missingServiceKeyRefSettings,
  SERVICE_KEY_REF_SETTINGS,
  serviceKeyIdsFromEnv,
} from '../scripts/rewrap-spender-keys.js';

const kekEntry = (version: number) => `v${version}:${randomBytes(32).toString('base64')}`;
const KEK = kekEntry(1);
const ENTRY_POINT = '0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789';
const ref = (n: number) => `v1:00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const addr = (n: number) => `0x${String(n).padStart(40, '0')}`;
const ARC_ON = { CITY_ARC: '1', CITY_ARC_CHAIN_ID: String(ARC_TESTNET) };

async function database(
  t: { after: (fn: () => Promise<unknown>) => void },
  options: { migrated?: boolean } = {},
): Promise<{ pg: PGlite; db: Database }> {
  const pg = await PGlite.create('memory://');
  t.after(() => pg.close());
  await pg.exec(`CREATE TABLE base_spender_keys (
    key_id text PRIMARY KEY, kek_version integer NOT NULL, wrapped_dek bytea NOT NULL,
    ciphertext bytea NOT NULL, signer_address text NOT NULL, committed_at bigint,
    created_at bigint NOT NULL);
    CREATE TABLE base_wallets (wallet_id text PRIMARY KEY, spender_key_ref text NOT NULL);`);
  await pg.exec(OWN_PAYMASTER_KEYS_SQL);
  if (options.migrated !== false) await migrate(pg);
  const db = {
    query: (sql: string, params?: unknown[]) => pg.query(sql, params) as never,
    transaction: (action: (tx: never) => Promise<unknown>) =>
      pg.transaction((tx) => action(tx as never)),
  } as unknown as Database;
  return { pg, db };
}

/** As the runner applies it: inside a transaction, where SET LOCAL holds. */
const migrate = (pg: PGlite) => pg.exec(`BEGIN;${OWN_PAYMASTER_KEYS_ARC_PURPOSES_SQL}COMMIT;`);

const purposesIn = async (pg: PGlite) =>
  (
    await pg.query<{ purpose: string }>('SELECT purpose FROM own_paymaster_keys ORDER BY purpose')
  ).rows.map((row) => row.purpose);

/** Every CHECK on own_paymaster_keys that mentions purpose, whatever its name. */
const purposeChecks = async (pg: PGlite) =>
  (
    await pg.query<{ conname: string; def: string; convalidated: boolean }>(
      `SELECT conname, pg_get_constraintdef(oid) AS def, convalidated FROM pg_constraint
       WHERE conrelid = 'own_paymaster_keys'::regclass AND contype = 'c'
         AND pg_get_constraintdef(oid) LIKE '%purpose%'`,
    )
  ).rows;

test('migration 351: the agreed SQL, next free version, lock timeout', () => {
  assert.equal(ownPaymasterKeysArcPurposesMigration.version, 351);
  assert.match(OWN_PAYMASTER_KEYS_ARC_PURPOSES_SQL, /SET LOCAL lock_timeout = '2s';/);
  assert.ok(
    OWN_PAYMASTER_KEYS_ARC_PURPOSES_SQL.includes(
      'ALTER TABLE own_paymaster_keys DROP CONSTRAINT IF EXISTS own_paymaster_keys_purpose_check;',
    ),
  );
  assert.ok(
    OWN_PAYMASTER_KEYS_ARC_PURPOSES_SQL.includes(
      "ALTER TABLE own_paymaster_keys ADD CONSTRAINT own_paymaster_keys_purpose_check CHECK (purpose IN ('paymaster_signer','paymaster_submitter_1','paymaster_submitter_2','arc_paymaster_signer','arc_paymaster_submitter_1','arc_paymaster_submitter_2')) NOT VALID;",
    ),
  );
});

test('migration 351: keeps live rows, leaves one check on purpose, whatever its name', async (t) => {
  const { pg } = await database(t, { migrated: false });
  // Before: Arc's purposes are refused, and migration 256's inline check has the expected name.
  const before = await purposeChecks(pg);
  assert.deepEqual(
    before.map((check) => check.conname),
    ['own_paymaster_keys_purpose_check'],
  );
  await assert.rejects(
    pg.query(`INSERT INTO own_paymaster_keys VALUES ('arc_paymaster_signer','r0','${addr(9)}',1)`),
  );
  const live = PAYMASTER_KEY_PURPOSES.map((purpose, i) => [purpose, ref(i), addr(i + 1), i + 100]);
  for (const row of live)
    await pg.query('INSERT INTO own_paymaster_keys VALUES ($1,$2,$3,$4)', row);
  const read = () => pg.query('SELECT * FROM own_paymaster_keys ORDER BY purpose');
  const rows = (await read()).rows;

  await migrate(pg);

  assert.deepEqual((await read()).rows, rows, 'live rows byte for byte');
  const after = await purposeChecks(pg);
  assert.equal(after.length, 1);
  assert.equal(after[0]!.conname, 'own_paymaster_keys_purpose_check');
  assert.equal(after[0]!.convalidated, false);
  for (const purpose of [...PAYMASTER_KEY_PURPOSES, ...ARC_PAYMASTER_KEY_PURPOSES])
    assert.ok(after[0]!.def.includes(purpose), purpose);
  // New rows: Arc's accepted, anything else refused.
  await pg.query(
    `INSERT INTO own_paymaster_keys VALUES ('arc_paymaster_signer','r1','${addr(9)}',1)`,
  );
  await assert.rejects(
    pg.query(`INSERT INTO own_paymaster_keys VALUES ('arc_other','r2','${addr(8)}',1)`),
  );
  // Safe to run again (the runner never does, a restore might).
  await migrate(pg);
  assert.equal((await purposeChecks(pg)).length, 1);
});

test('one key can never be recorded for both chains: the table refuses it', async (t) => {
  const { pg } = await database(t);
  await pg.query(
    `INSERT INTO own_paymaster_keys VALUES ('paymaster_signer','${ref(1)}','${addr(1)}',1)`,
  );
  await assert.rejects(
    pg.query(
      `INSERT INTO own_paymaster_keys VALUES ('arc_paymaster_signer','${ref(1)}','${addr(2)}',1)`,
    ),
  );
  await assert.rejects(
    pg.query(
      `INSERT INTO own_paymaster_keys VALUES ('arc_paymaster_signer','${ref(2)}','${addr(1)}',1)`,
    ),
  );
});

test('paymasterKeyPurposes: selected by chain, in the same order', () => {
  for (const chainId of [BASE_MAINNET, BASE_SEPOLIA])
    assert.equal(paymasterKeyPurposes(chainId), PAYMASTER_KEY_PURPOSES);
  for (const chainId of [ARC_MAINNET, ARC_TESTNET])
    assert.equal(paymasterKeyPurposes(chainId), ARC_PAYMASTER_KEY_PURPOSES);
  PAYMASTER_KEY_PURPOSES.forEach((purpose, i) =>
    assert.equal(ARC_PAYMASTER_KEY_PURPOSES[i], `arc_${purpose}`),
  );
});

test('provisioning: each chain makes and reads only its own rows, in either order', async (t) => {
  const { pg, db } = await database(t);
  const env = { CITY_BASE_SPENDER_KEK: KEK };
  const base = await provisionPaymasterKeys({ db, env });
  assert.deepEqual(await purposesIn(pg), [...PAYMASTER_KEY_PURPOSES].sort());
  // Base's early return and its readers, with Arc's rows beside them.
  const arc = await provisionPaymasterKeys({ db, env, chainId: ARC_TESTNET });
  assert.deepEqual(
    await purposesIn(pg),
    [...ARC_PAYMASTER_KEY_PURPOSES, ...PAYMASTER_KEY_PURPOSES].sort(),
  );
  assert.deepEqual([...arc.keys()], [...PAYMASTER_KEY_PURPOSES]);
  const again = await provisionPaymasterKeys({ db, env: {} });
  assert.deepEqual(again, base, 'no KEK needed: every purpose of Base exists, nothing new');
  assert.deepEqual(await provisionedPaymasterKeys(db), base);
  assert.deepEqual(await provisionPaymasterKeys({ db, env: {}, chainId: ARC_TESTNET }), arc);
  assert.deepEqual(await provisionedPaymasterKeys(db, ARC_TESTNET), arc);
  const addresses = [...base.values(), ...arc.values()].map((key) => key.address.toLowerCase());
  assert.equal(new Set(addresses).size, 6, 'no address on both chains');

  // The other order: Arc first never makes Base's.
  const other = await database(t);
  await provisionPaymasterKeys({ db: other.db, env, chainId: ARC_TESTNET });
  assert.deepEqual(await purposesIn(other.pg), [...ARC_PAYMASTER_KEY_PURPOSES].sort());
  assert.equal((await provisionedPaymasterKeys(other.db)).size, 0);
});

test('Base keeps its one query and its answer: no filter, no extra read', async (t) => {
  const { db } = await database(t);
  await provisionPaymasterKeys({ db, env: { CITY_BASE_SPENDER_KEK: KEK } });
  const seen: string[] = [];
  const spying = {
    ...db,
    query: (sql: string, params?: unknown[]) => {
      seen.push(sql);
      return db.query(sql, params as never);
    },
  } as unknown as Database;
  await provisionPaymasterKeys({ db: spying, env: {} });
  assert.deepEqual(seen, ['SELECT purpose, key_ref, address FROM own_paymaster_keys']);
});

test('at start: Arc off is one Base side, as before; each side obeys its own mode', async (t) => {
  // Arc off: exactly Base's side with the very same env, and Arc's route does not exist.
  const off = { CITY_BASE_OWN_PAYMASTER: 'on' };
  assert.deepEqual(paymasterSides(off), [{ env: off, chainId: BASE_MAINNET }]);
  assert.equal(paymasterSides(off)[0]!.env, off);
  assert.equal(arcPaymasterSide(off), null);
  // CITY_ARC_OWN_PAYMASTER alone makes Arc's keys, before the deploy, and turns nothing of Arc on.
  const keysOnly = { CITY_ARC_OWN_PAYMASTER: 'prepare' };
  assert.deepEqual(
    paymasterSides(keysOnly).map((side) => side.chainId),
    [BASE_MAINNET, ARC_MAINNET],
  );
  assert.equal(protocolArcChainIdFromEnv(keysOnly), null);
  assert.equal(chainNetwork(ARC_MAINNET, keysOnly), null);
  assert.equal(registrationChainOn(ARC_MAINNET, keysOnly), false);

  const start = async (env: Record<string, string>) => {
    const { pg, db } = await database(t);
    const states = await Promise.all(
      paymasterSides({ CITY_BASE_SPENDER_KEK: KEK, ...env }).map((side) =>
        provisionPaymasterKeysAtStart({ db, env: side.env, chainId: side.chainId }),
      ),
    );
    return { states, purposes: await purposesIn(pg) };
  };
  const BASE = [...PAYMASTER_KEY_PURPOSES].sort();
  const ARC = [...ARC_PAYMASTER_KEY_PURPOSES].sort();
  assert.deepEqual(await start({ CITY_BASE_OWN_PAYMASTER: 'on' }), {
    states: ['ready'],
    purposes: BASE,
  });
  assert.deepEqual(await start({}), { states: ['off'], purposes: [] });
  // Both on: both sets.
  assert.deepEqual(
    await start({ ...ARC_ON, CITY_BASE_OWN_PAYMASTER: 'on', CITY_ARC_OWN_PAYMASTER: 'prepare' }),
    { states: ['ready', 'ready'], purposes: [...ARC, ...BASE].sort() },
  );
  // Arc on, Arc's mode off: no Arc keys, whatever Base's mode says.
  assert.deepEqual(await start({ ...ARC_ON, CITY_BASE_OWN_PAYMASTER: 'on' }), {
    states: ['ready', 'off'],
    purposes: BASE,
  });
  // Arc alone: no Base keys.
  assert.deepEqual(await start({ ...ARC_ON, CITY_ARC_OWN_PAYMASTER: 'prepare' }), {
    states: ['off', 'ready'],
    purposes: ARC,
  });
});

test('settings: Base refs never reach Arc; Arc refs map; a mismatch names the setting set', async (t) => {
  const scoped = arcRuntimeEnv({
    CITY_BASE_PAYMASTER_SIGNER_KEY_REF: 'base-signer',
    CITY_BASE_SUBMITTER_KEY_REFS: 'base-submitter',
  });
  assert.equal(scoped.CITY_BASE_PAYMASTER_SIGNER_KEY_REF, undefined);
  assert.equal(scoped.CITY_BASE_SUBMITTER_KEY_REFS, undefined);
  const mapped = arcRuntimeEnv({
    CITY_BASE_PAYMASTER_SIGNER_KEY_REF: 'base-signer',
    CITY_BASE_SUBMITTER_KEY_REFS: 'base-submitter',
    CITY_ARC_PAYMASTER_SIGNER_KEY_REF: 'arc-signer',
    CITY_ARC_SUBMITTER_KEY_REFS: 'arc-submitter',
  });
  assert.equal(mapped.CITY_BASE_PAYMASTER_SIGNER_KEY_REF, 'arc-signer');
  assert.equal(mapped.CITY_BASE_SUBMITTER_KEY_REFS, 'arc-submitter');

  const { db } = await database(t);
  const env = { CITY_BASE_SPENDER_KEK: KEK, CITY_BASE_OWN_PAYMASTER: 'prepare' };
  const base = await provisionPaymasterKeys({ db, env });
  const arc = await provisionPaymasterKeys({ db, env, chainId: ARC_TESTNET });
  const baseSigner = base.get('paymaster_signer')!.keyRef;
  const arcSigner = arc.get('paymaster_signer')!.keyRef;
  const atStart = async (signer: string) => {
    const lines: string[] = [];
    const state = await provisionPaymasterKeysAtStart({
      db,
      env: arcRuntimeEnv({
        ...env,
        ...ARC_ON,
        CITY_ARC_OWN_PAYMASTER: 'prepare',
        CITY_ARC_PAYMASTER_SIGNER_KEY_REF: signer,
      }),
      chainId: ARC_TESTNET,
      log: (line) => lines.push(line),
    });
    return { state, lines };
  };
  assert.deepEqual(await atStart(arcSigner), { state: 'ready', lines: [] });
  // Naming Base's signer on Arc is a mismatch, and the line carries Arc's setting name, no value.
  const wrong = await atStart(baseSigner);
  assert.equal(wrong.state, 'settings_mismatch');
  assert.deepEqual(wrong.lines, [
    JSON.stringify({
      event: 'own_paymaster_keys',
      state: 'settings_mismatch',
      setting: 'CITY_ARC_PAYMASTER_SIGNER_KEY_REF',
    }),
  ]);
  // Base's line stays as it was.
  assert.equal(
    paymasterKeysMismatchLogLine('CITY_BASE_SUBMITTER_KEY_REFS'),
    '{"event":"own_paymaster_keys","state":"settings_mismatch","setting":"CITY_BASE_SUBMITTER_KEY_REFS"}',
  );
});

test('createDirectBundler on Arc: only Arc keys count', async (t) => {
  const { pg, db } = await database(t);
  const build = (env: Record<string, string | undefined> = {}, chainId: number = ARC_TESTNET) =>
    createDirectBundler({
      db,
      env,
      client: {} as never,
      chainId,
      network: {} as never,
      keystore: {} as never,
    });
  await provisionPaymasterKeys({ db, env: { CITY_BASE_SPENDER_KEK: KEK } });
  // Base's keys exist, Arc's don't: Arc refuses rather than borrowing them.
  await assert.rejects(build(), /keys are not provisioned/);
  const arc = await provisionPaymasterKeys({
    db,
    env: { CITY_BASE_SPENDER_KEK: KEK },
    chainId: ARC_TESTNET,
  });
  assert.ok(arc.size === 3 && (await purposesIn(pg)).length === 6);
  await assert.rejects(
    build(
      arcRuntimeEnv({
        CITY_ARC_SUBMITTER_KEY_REFS: (await provisionedPaymasterKeys(db)).get(
          'paymaster_submitter_1',
        )!.keyRef,
      }),
    ),
    /own bundler: CITY_ARC_SUBMITTER_KEY_REFS does not match the recorded keys\./,
  );
  // Base's message is unchanged.
  await assert.rejects(
    build({ CITY_BASE_SUBMITTER_KEY_REFS: ref(99) }, BASE_MAINNET),
    /own bundler: CITY_BASE_SUBMITTER_KEY_REFS does not match the recorded keys\./,
  );
});

test("the drain count: each chain's open sends, from each chain's own submitters", async (t) => {
  const { pg, db } = await database(t);
  await pg.exec(`CREATE TABLE own_paymaster_sends (
    chain_id integer NOT NULL, final boolean NOT NULL, submitter text NOT NULL)`);
  const env = { CITY_BASE_SPENDER_KEK: KEK };
  const base = await provisionPaymasterKeys({ db, env });
  const arc = await provisionPaymasterKeys({ db, env, chainId: ARC_TESTNET });
  const send = (chainId: number, submitter: string) =>
    pg.query('INSERT INTO own_paymaster_sends VALUES ($1, false, $2)', [
      chainId,
      submitter.toLowerCase(),
    ]);
  const baseFirst = base.get('paymaster_submitter_1')!.address;
  const arcFirst = arc.get('paymaster_submitter_1')!.address;
  const arcSecond = arc.get('paymaster_submitter_2')!.address;
  await send(BASE_MAINNET, baseFirst);
  await send(ARC_TESTNET, arcFirst);
  await send(ARC_TESTNET, arcSecond);
  // A stray: on Arc from Base's submitter, on Base from Arc's. Neither holds either chain's cron.
  await send(ARC_TESTNET, baseFirst);
  await send(BASE_MAINNET, arcFirst);
  const open = (chainId: number) =>
    lazyBundler({
      make: async () => {
        throw new Error('not built');
      },
      route: { db, chainId, entryPoint: ENTRY_POINT as never, paymaster: null },
    }).open();
  assert.equal(await open(BASE_MAINNET), 1);
  assert.equal(await open(ARC_TESTNET), 2);
});

test('the public view: Base route shows Base, Arc route shows Arc, Arc off has none', async (t) => {
  const { db } = await database(t);
  const kek = { CITY_BASE_SPENDER_KEK: KEK };
  const base = await provisionPaymasterKeys({ db, env: kek });
  const arc = await provisionPaymasterKeys({ db, env: kek, chainId: ARC_TESTNET });
  const raw = {
    ...ARC_ON,
    CITY_BASE_OWN_PAYMASTER: 'on',
    CITY_BASE_PAYMASTER_ADDRESS: addr(0xb1),
    CITY_ARC_OWN_PAYMASTER: 'prepare',
    CITY_ARC_PAYMASTER: addr(0xa1),
  };
  const app = Fastify();
  t.after(() => app.close());
  const side = paymasterSide(raw);
  registerPaymasterPublicRoute(app, {
    db,
    env: side.env,
    chainId: side.chainId,
    entryPoint: ENTRY_POINT,
  });
  const arcSide = arcPaymasterSide(raw)!;
  registerPaymasterPublicRoute(app, {
    db,
    env: arcSide.env,
    chainId: arcSide.chainId,
    entryPoint: ENTRY_POINT,
    path: PAYMASTER_ARC_PUBLIC_PATH,
  });
  const get = async (url: string) => (await app.inject({ method: 'GET', url })).json();
  const shownBase = await get(PAYMASTER_PUBLIC_PATH);
  assert.equal(shownBase.chainId, BASE_MAINNET);
  assert.equal(shownBase.mode, 'on');
  assert.equal(shownBase.paymaster, addr(0xb1));
  assert.equal(shownBase.verifyingSigner, base.get('paymaster_signer')!.address);
  assert.equal(shownBase.submitter, base.get('paymaster_submitter_1')!.address);
  const shownArc = await get(PAYMASTER_ARC_PUBLIC_PATH);
  assert.equal(shownArc.chainId, ARC_TESTNET);
  assert.equal(shownArc.mode, 'prepare');
  assert.equal(shownArc.paymaster, addr(0xa1));
  assert.equal(shownArc.verifyingSigner, arc.get('paymaster_signer')!.address);
  assert.equal(shownArc.submitter, arc.get('paymaster_submitter_1')!.address);
  assert.deepEqual(shownArc.submitters, [
    arc.get('paymaster_submitter_1')!.address,
    arc.get('paymaster_submitter_2')!.address,
  ]);
  assert.equal(shownBase.submitters, undefined);
  assert.doesNotMatch(JSON.stringify(shownArc), /v1:/);

  // A server running Arc's alone answers the old path with Arc's keys.
  const aloneApp = Fastify();
  t.after(() => aloneApp.close());
  const alone = paymasterSide({ ...ARC_ON, CITY_ARC_OWN_PAYMASTER: 'prepare' });
  registerPaymasterPublicRoute(aloneApp, {
    db,
    env: alone.env,
    chainId: alone.chainId,
    entryPoint: ENTRY_POINT,
  });
  const shownAlone = (await aloneApp.inject({ method: 'GET', url: PAYMASTER_PUBLIC_PATH })).json();
  assert.equal(shownAlone.verifyingSigner, arc.get('paymaster_signer')!.address);
});

test('POST keys route: Base rows only, its answer unchanged, with Arc rows present', async (t) => {
  const { pg, db } = await database(t);
  const env = { CITY_BASE_SPENDER_KEK: KEK, CITY_OPS_SECRET: 'x'.repeat(40) };
  const arc = await provisionPaymasterKeys({ db, env, chainId: ARC_TESTNET });
  const app = Fastify();
  t.after(() => app.close());
  registerOwnPaymasterKeysRoute(app, { db, env });
  const answer = await app.inject({
    method: 'POST',
    url: PAYMASTER_KEYS_PATH,
    headers: { authorization: `Bearer ${env.CITY_OPS_SECRET}` },
  });
  assert.equal(answer.statusCode, 200);
  const body = answer.json();
  assert.deepEqual(Object.keys(body).sort(), ['signer', 'submitters']);
  const base = await provisionedPaymasterKeys(db);
  assert.equal(body.signer.address, base.get('paymaster_signer')!.address);
  assert.notEqual(body.signer.address, arc.get('paymaster_signer')!.address);
  assert.equal((await purposesIn(pg)).length, 6);
  assert.deepEqual(await provisionedPaymasterKeys(db, ARC_TESTNET), arc, 'Arc untouched');
});

test('key roles: arc_ rows are their own roles; a shared account ALERTs', async (t) => {
  const { pg, db } = await database(t);
  const env = { CITY_BASE_SPENDER_KEK: KEK };
  await provisionPaymasterKeys({ db, env });
  const arc = await provisionPaymasterKeys({ db, env, chainId: ARC_TESTNET });
  const lines: string[] = [];
  const { holders, conflicts } = await checkKeyRolesAtStart({
    db,
    env: {},
    chainId: BASE_MAINNET,
    log: (line) => lines.push(line),
  });
  assert.deepEqual(conflicts, []);
  assert.equal(lines.length, 0);
  assert.deepEqual(
    holders
      .map((holder) => holder.role)
      .filter((role) => role !== 'treasury')
      .sort(),
    [
      'arc_paymaster_signer',
      'arc_paymaster_submitter',
      'arc_paymaster_submitter',
      'paymaster_signer',
      'paymaster_submitter',
      'paymaster_submitter',
    ],
  );
  assert.equal(
    holders.find((holder) => holder.role === 'arc_paymaster_signer')!.address,
    arc.get('paymaster_signer')!.address,
  );
  // The funding wallet on Arc's signer account is named as Arc's role.
  await checkKeyRolesAtStart({
    db,
    env: { CITY_FUNDING_WALLET_ADDRESS: arc.get('paymaster_signer')!.address },
    chainId: BASE_MAINNET,
    log: (line) => lines.push(line),
  });
  assert.deepEqual(lines, [
    `key roles: ALERT arc_paymaster_signer and funding use the same account ${arc.get('paymaster_signer')!.address.toLowerCase()}`,
  ]);
  // Without rows or Arc settings nothing new is logged or asked.
  await pg.exec('DELETE FROM own_paymaster_keys');
  lines.length = 0;
  await checkKeyRolesAtStart({ db, env: {}, chainId: 8453, log: (line) => lines.push(line) });
  assert.deepEqual(lines, []);
});

test('key roles: one key on both chains is refused on Arc, enforced or not', () => {
  const log = () => undefined;
  const fresh = () => ({ reported: new Set<string>(), log });
  const clean = {
    CITY_BASE_PAYMASTER_SIGNER_KEY_REF: ref(1),
    CITY_BASE_SUBMITTER_KEY_REFS: `${ref(2)},${ref(3)}`,
    CITY_ARC_PAYMASTER_SIGNER_KEY_REF: ref(4),
    CITY_ARC_SUBMITTER_KEY_REFS: ref(5),
  };
  assert.equal(arcPaymasterKeySharedWithBase(clean), null);
  assert.equal(arcPaymasterKeysUsable(clean, fresh()), true);
  assert.equal(arcPaymasterKeySharedWithBase({}), null, 'Arc settings are optional');
  assert.equal(arcPaymasterKeysUsable({}, fresh()), true);

  for (const shared of [
    { ...clean, CITY_ARC_PAYMASTER_SIGNER_KEY_REF: ref(1) },
    { ...clean, CITY_ARC_SUBMITTER_KEY_REFS: ref(3) },
    // The same key under another KEK version is the same key.
    { ...clean, CITY_ARC_SUBMITTER_KEY_REFS: ref(2).replace('v1:', 'v2:') },
    // Any role of Base, not only its paymaster.
    { ...clean, CITY_ARC_SUBMITTER_KEY_REFS: ref(7), CITY_SFP_SPONSOR_KEY_REF: ref(7) },
  ]) {
    assert.ok(arcPaymasterKeySharedWithBase(shared));
    assert.equal(arcPaymasterKeysUsable(shared, fresh()), false, 'without enforcement');
    assert.equal(
      arcPaymasterKeysUsable({ ...shared, CITY_KEY_ROLES_ENFORCE: '1' }, fresh()),
      false,
    );
  }
  // Sharing inside Arc follows the ordinary rule: ALERT, refused only when enforced.
  const inside = { ...clean, CITY_ARC_SUBMITTER_KEY_REFS: ref(4) };
  assert.equal(keyRefSharedWithOtherRole(inside, 'arc_paymaster_signer'), true);
  assert.equal(arcPaymasterKeysUsable(inside, fresh()), true);
  assert.equal(arcPaymasterKeysUsable({ ...inside, CITY_KEY_ROLES_ENFORCE: '1' }, fresh()), false);
  // Base's roles see Arc's as other roles, and nothing without Arc's settings.
  assert.equal(
    keyRefSharedWithOtherRole(
      { CITY_BASE_PAYMASTER_SIGNER_KEY_REF: ref(1), CITY_ARC_SUBMITTER_KEY_REFS: ref(1) },
      'paymaster_signer',
    ),
    true,
  );
  assert.equal(
    keyRefSharedWithOtherRole({ CITY_BASE_PAYMASTER_SIGNER_KEY_REF: ref(1) }, 'paymaster_signer'),
    false,
  );
});

test('key roles at start: a ref on both chains ALERTs by setting name, never by value', async () => {
  const lines: string[] = [];
  await checkKeyRolesAtStart({
    db: { query: async () => ({ rows: [] }) } as never,
    env: { CITY_BASE_SUBMITTER_KEY_REFS: ref(1), CITY_ARC_SUBMITTER_KEY_REFS: ref(1) },
    chainId: BASE_MAINNET,
    log: (line) => lines.push(line),
  });
  assert.deepEqual(lines, [
    'key roles: ALERT CITY_ARC_SUBMITTER_KEY_REFS names a key also configured for a role on Base',
  ]);
});

test("the Arc runtime refuses to build its bundler on a key of Base's", async () => {
  const env = {
    ...ARC_ON,
    CITY_ARC_RPC_URL: 'https://arc.invalid/rpc',
    CITY_BASE_SPENDER_KEK: KEK,
    CITY_ARC_MAX_FEE_PER_GAS_WEI: '100000000000',
    CITY_ARC_IDENTITY_FEE_CAP_WEI: '1000000000000000',
    CITY_ARC_WALLET_FEE_CAP_WEI: '1000000000000000',
    CITY_ARC_PAYMASTER: addr(0xa1),
    CITY_ARC_OWN_PAYMASTER: 'on',
    CITY_BASE_PAYMASTER_SIGNER_KEY_REF: ref(1),
  };
  const run = async (signer: string) => {
    const lines: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => void lines.push(args.map(String).join(' '));
    try {
      const runtime = createChainRuntime({
        db: { query: async () => ({ rows: [] }) } as unknown as Database,
        env: { ...env, CITY_ARC_PAYMASTER_SIGNER_KEY_REF: signer },
        chainId: ARC_TESTNET,
      });
      await runtime.ownBundlerUpkeep?.maintain(1).catch(() => undefined);
    } finally {
      console.error = original;
    }
    return lines.filter((line) => line.includes('key roles'));
  };
  assert.deepEqual(await run(ref(1)), [
    "key roles: ALERT CITY_ARC_PAYMASTER_SIGNER_KEY_REF names a key also configured for a role on Base; Arc's paymaster is not built",
  ]);
  assert.deepEqual(await run(ref(2)), []);
});

test('KEK scripts: arc_ rows and settings count; unset Arc settings are never missing', async (t) => {
  // Base's required list is unchanged, and Arc's is optional.
  assert.deepEqual(
    [...SERVICE_KEY_REF_SETTINGS],
    [
      'CITY_BASE_PAYMASTER_SIGNER_KEY_REF',
      'CITY_BASE_SUBMITTER_KEY_REFS',
      'CITY_SFP_SPONSOR_KEY_REF',
      'CITY_X402_FACILITATOR_KEY_REF',
      'CITY_X402_PUBLIC_SETTLE_KEY_REF',
    ],
  );
  const refs = Object.fromEntries(SERVICE_KEY_REF_SETTINGS.map((name, i) => [name, ref(i + 10)]));
  assert.deepEqual(missingServiceKeyRefSettings(refs), []);
  assert.deepEqual(
    missingServiceKeyRefSettings({ ...refs, CITY_ARC_SUBMITTER_KEY_REFS: 'not-a-ref' }),
    ['CITY_ARC_SUBMITTER_KEY_REFS'],
    'set but broken still fails closed',
  );
  assert.ok(
    serviceKeyIdsFromEnv({ CITY_ARC_PAYMASTER_SIGNER_KEY_REF: ref(1) }).has(
      ref(1).replace('v1:', ''),
    ),
  );

  const { pg, db } = await database(t);
  await pg.exec(`
    CREATE TABLE feed_pay_sponsor_key (purpose text PRIMARY KEY, key_ref text NOT NULL UNIQUE,
      address text NOT NULL, created_at bigint NOT NULL DEFAULT 0);
    CREATE TABLE x402_facilitator_key (purpose text PRIMARY KEY, key_ref text NOT NULL UNIQUE,
      address text NOT NULL, created_at bigint NOT NULL DEFAULT 0);`);
  const v1 = kekEntry(1);
  const v2 = kekEntry(2);
  await provisionPaymasterKeys({ db, env: { CITY_BASE_SPENDER_KEK: v1 } });
  const arc = await provisionPaymasterKeys({
    db,
    env: { CITY_BASE_SPENDER_KEK: v1 },
    chainId: ARC_TESTNET,
  });
  const base = await provisionedPaymasterKeys(db);
  const dbAny = db as never;
  const env: Record<string, string> = {
    ...refs,
    CITY_BASE_PAYMASTER_SIGNER_KEY_REF: base.get('paymaster_signer')!.keyRef,
    CITY_BASE_SUBMITTER_KEY_REFS: `${base.get('paymaster_submitter_1')!.keyRef},${base.get('paymaster_submitter_2')!.keyRef}`,
  };

  // The gate counts Arc's rows, without any Arc setting.
  const report = await checkKekRetirement(dbAny, 1, { env });
  assert.deepEqual(report.serviceTables.own_paymaster_keys!.purposes, [
    ...[...ARC_PAYMASTER_KEY_PURPOSES].sort(),
    ...[...PAYMASTER_KEY_PURPOSES].sort(),
  ]);
  assert.equal(report.serviceTables.own_paymaster_keys!.rows, 6);
  assert.deepEqual(report.missingServiceRefs, []);
  assert.equal(report.sealedKeys.service, 6, 'none of them passes for an unreferenced key');
  assert.ok(report.reasons.length > 0, 'not safe');

  // A set Arc setting bound to the version shows by name.
  const withArc = {
    ...env,
    CITY_ARC_PAYMASTER_SIGNER_KEY_REF: arc.get('paymaster_signer')!.keyRef,
  };
  assert.ok(
    (await checkKekRetirement(dbAny, 1, { env: withArc })).settings.includes(
      'CITY_ARC_PAYMASTER_SIGNER_KEY_REF',
    ),
  );

  // Orphan report: Arc's rows are service keys, with or without the setting.
  const orphans = await reportOrphanKeys(dbAny, {
    env,
  });
  assert.equal(orphans.refused, false);
  assert.deepEqual(orphans.byVersion, {}, 'no key of either chain is an orphan');

  // Rewrap: Arc's signer moves through Arc's setting, Base's row stays as it was.
  const keks = parseKeks(`${v1},${v2}`);
  const dry = await rewrapServiceKey(dbAny, keks, {
    setting: 'CITY_ARC_PAYMASTER_SIGNER_KEY_REF',
    env: withArc,
  });
  assert.equal(dry.refused, false);
  assert.equal(dry.purpose, 'arc_paymaster_signer');
  const moved = await rewrapServiceKey(dbAny, keks, {
    setting: 'CITY_ARC_PAYMASTER_SIGNER_KEY_REF',
    env: withArc,
    confirm: true,
  });
  assert.equal(moved.moved, true);
  assert.equal(
    (await provisionedPaymasterKeys(db, ARC_TESTNET)).get('paymaster_signer')!.keyRef.slice(0, 3),
    'v2:',
  );
  assert.deepEqual(await provisionedPaymasterKeys(db), base);
  // Arc's setting naming Base's signer: refused as another role's row, nothing moved.
  const crossed = await rewrapServiceKey(dbAny, keks, {
    setting: 'CITY_ARC_SUBMITTER_KEY_REFS',
    env: { ...env, CITY_ARC_SUBMITTER_KEY_REFS: base.get('paymaster_signer')!.keyRef },
  });
  assert.equal(crossed.refused, true);
  assert.equal(crossed.reason, 'shared_with_other_role');
  // Base's own move with Arc's rows present still works.
  const baseMove = await rewrapServiceKey(dbAny, keks, {
    setting: 'CITY_BASE_PAYMASTER_SIGNER_KEY_REF',
    env,
  });
  assert.equal(baseMove.refused, false);
  assert.equal(baseMove.purpose, 'paymaster_signer');
});

test('the app: real migrations, and at start each chain gets only its own keys', async (t) => {
  const set = (values: Record<string, string>) => {
    const saved = Object.fromEntries(Object.keys(values).map((name) => [name, process.env[name]]));
    Object.assign(process.env, values);
    t.after(() => {
      for (const [name, value] of Object.entries(saved))
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
    });
  };
  set({ CITY_BASE_SPENDER_KEK: KEK, CITY_BASE_OWN_PAYMASTER: 'prepare' });
  const purposes = async (app: Awaited<ReturnType<typeof createApp>>) =>
    (
      await app.city.db.query<{ purpose: string }>(
        'SELECT purpose FROM own_paymaster_keys ORDER BY purpose',
      )
    ).rows.map((row) => row.purpose);

  // Arc off: Base's three keys, and no Arc route.
  const off = await createApp({ dataDir: ':memory:', startWorkers: false });
  t.after(() => off.close());
  assert.deepEqual(await purposes(off), [...PAYMASTER_KEY_PURPOSES].sort());
  const absent = await off.inject({ method: 'GET', url: PAYMASTER_ARC_PUBLIC_PATH });
  assert.equal(absent.statusCode, 404);
  assert.equal(
    (await off.inject({ method: 'GET', url: PAYMASTER_PUBLIC_PATH })).json().chainId,
    BASE_MAINNET,
  );

  // Base and Arc on: both sets, each route its own.
  set({ ...ARC_ON, CITY_ARC_OWN_PAYMASTER: 'prepare' });
  const both = await createApp({ dataDir: ':memory:', startWorkers: false });
  t.after(() => both.close());
  assert.deepEqual(
    await purposes(both),
    [...ARC_PAYMASTER_KEY_PURPOSES, ...PAYMASTER_KEY_PURPOSES].sort(),
  );
  const arc = await both.inject({ method: 'GET', url: PAYMASTER_ARC_PUBLIC_PATH });
  assert.equal(arc.json().chainId, ARC_TESTNET);
  assert.equal(
    arc.json().verifyingSigner,
    (await provisionedPaymasterKeys(both.city.db, ARC_TESTNET)).get('paymaster_signer')!.address,
  );
  assert.equal(
    (await both.inject({ method: 'GET', url: PAYMASTER_PUBLIC_PATH })).json().chainId,
    BASE_MAINNET,
  );
});
