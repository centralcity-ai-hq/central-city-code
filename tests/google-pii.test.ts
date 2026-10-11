import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createApp } from '../server/app.js';
import { elricEligibility } from '../server/elric/access.js';
import * as pii from '../server/google/pii.js';
import { piiKeys, type PiiKeyring } from '../server/google/pii-keys.js';
import {
  FAKE_CLIENT_ID,
  FAKE_CLIENT_SECRET,
  claimsFor,
  fakeGoogle,
  signIdToken,
} from './fake-google.js';

/**
 * The date of birth for Elric's age confirmation (server/google/pii.ts, docs/GOOGLE_SIGNIN.md
 * "Date of birth"): envelope encryption with CITY_PII_KEK, the readers, the lock, deletion,
 * rotation and aggregate bands. Keys are generated at runtime; dates are synthetic.
 */
type App = Awaited<ReturnType<typeof createApp>>;
const jsonHeaders = { 'content-type': 'application/json', 'x-city-request': '1' };
const key32 = () => randomBytes(32).toString('base64');
const NOW = Date.UTC(2026, 9, 1, 12);
const ring = (env: Record<string, string> = { CITY_PII_KEK: key32() }) =>
  piiKeys(env, { hosted: true }) as Extract<PiiKeyring, { available: true }>;

async function fixture(t: { after: (fn: () => Promise<unknown>) => void }) {
  const google = fakeGoogle();
  const clock = { now: Date.now() };
  const app = await createApp({
    dataDir: ':memory:',
    startWorkers: false,
    now: () => clock.now,
    google: {
      env: {
        CITY_GOOGLE_SIGNIN: '1',
        GOOGLE_OAUTH_CLIENT_ID: FAKE_CLIENT_ID,
        GOOGLE_OAUTH_CLIENT_SECRET: FAKE_CLIENT_SECRET,
      },
      transport: google.transport,
    },
  });
  t.after(() => app.close());
  return { app, google, db: app.city.db, clock };
}
let counter = 0;
async function person(app: App) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    headers: jsonHeaders,
    payload: JSON.stringify({
      name: `Age person ${++counter}`,
      password: 'Synthetic age password',
    }),
    remoteAddress: `198.51.100.${counter % 250}`,
  });
  assert.equal(res.statusCode, 201, res.body);
  return {
    id: res.json().operator.id as string,
    cookie: `cc_session=${res.cookies.find((item) => item.name === 'cc_session')!.value}`,
  };
}
/** A verified Google link through the real flow (fake Google). */
async function link(f: Awaited<ReturnType<typeof fixture>>, who: { cookie: string }, sub: string) {
  const start = await f.app.inject({
    method: 'POST',
    url: '/api/auth/google/start',
    headers: { ...jsonHeaders, cookie: who.cookie },
    payload: JSON.stringify({ intent: 'link' }),
  });
  const binder = start.cookies.find((item) => item.name === 'cc_google_flow')!.value;
  const params = new URL(start.json().url).searchParams;
  const token = signIdToken(
    f.google.keys[0]!,
    claimsFor(params.get('nonce')!, f.clock.now, { sub }),
  );
  const code = f.google.issueCode(token, params.get('code_challenge')!);
  const back = await f.app.inject({
    method: 'GET',
    url: `/api/auth/google/callback?${new URLSearchParams({ state: params.get('state')!, code })}`,
    headers: { cookie: `cc_google_flow=${binder}` },
  });
  return back.headers.location as string;
}
const age = (app: App, cookie: string, date: unknown) =>
  app.inject({
    method: 'POST',
    url: '/api/elric/age',
    headers: { ...jsonHeaders, cookie },
    payload: JSON.stringify({ date_of_birth: date }),
  });
const view = (app: App, cookie: string) =>
  app.inject({ method: 'GET', url: '/api/elric/age', headers: { cookie } });

test('date of birth: adult passes; under 18 locks; a correction never lifts the lock', async (t) => {
  const f = await fixture(t);
  const a = await person(f.app);
  // A verified Google link first.
  assert.equal((await age(f.app, a.cookie, '1990-05-17')).statusCode, 409);
  assert.equal(await link(f, a, '100000000000000000101'), '/settings/account?google=linked');
  const adult = await age(f.app, a.cookie, '1990-05-17');
  assert.equal(adult.statusCode, 200, adult.body);
  assert.deepEqual(adult.json(), { age_check: 'over_18' });
  assert.equal((await elricEligibility(f.db, a.id)).eligible, true);
  // An adult corrects the date: allowed.
  assert.equal((await age(f.app, a.cookie, '1991-06-18')).statusCode, 200);
  assert.deepEqual((await view(f.app, a.cookie)).json(), {
    date_of_birth: '1991-06-18',
    age_check: 'over_18',
    locked: false,
  });
  assert.equal((await view(f.app, a.cookie)).headers['cache-control'], 'no-store');

  const m = await person(f.app);
  assert.equal(await link(f, m, '100000000000000000102'), '/settings/account?google=linked');
  const today = new Date();
  const minorDate = `${today.getUTCFullYear() - 16}-01-01`;
  const minor = await age(f.app, m.cookie, minorDate);
  assert.equal(minor.statusCode, 403);
  assert.equal(minor.json().code, 'elric_age_under_18');
  assert.ok(!minor.body.includes(minorDate), 'the date is never echoed');
  assert.deepEqual(await elricEligibility(f.db, m.id), {
    eligible: false,
    reason: 'age_under_18',
  });
  // Correcting to an adult date is refused and counted; the lock stays.
  const retry = await age(f.app, m.cookie, '1980-01-01');
  assert.equal(retry.statusCode, 403);
  assert.equal(retry.json().code, 'elric_age_under_18');
  assert.equal((await elricEligibility(f.db, m.id)).eligible, false);
  const row = (
    await f.db.query<{ refused_corrections: number; locked_at: unknown }>(
      'SELECT refused_corrections,locked_at FROM elric_age_checks WHERE operator_id=$1',
      [m.id],
    )
  ).rows[0]!;
  assert.equal(Number(row.refused_corrections), 1);
  assert.ok(row.locked_at);
  // A minor's date is not kept: only the lock.
  assert.deepEqual((await view(f.app, m.cookie)).json(), {
    date_of_birth: null,
    age_check: 'under_18',
    locked: true,
  });
  // Unlink and relink do not lift it either.
  await f.app.inject({
    method: 'POST',
    url: '/api/auth/google/unlink',
    headers: { ...jsonHeaders, cookie: m.cookie },
    payload: '{}',
  });
  assert.equal(
    await link(f, m, '100000000000000000102'),
    '/settings/account?google=elric_age_under_18',
  );
  assert.equal((await age(f.app, m.cookie, '1980-01-01')).statusCode, 403);
  assert.equal((await elricEligibility(f.db, m.id)).eligible, false);
});

test('date of birth: only full, real dates, not in the future and at most 120 years', async (t) => {
  const f = await fixture(t);
  const a = await person(f.app);
  assert.equal(await link(f, a, '100000000000000000103'), '/settings/account?google=linked');
  const year = new Date().getUTCFullYear();
  for (const bad of [
    '1990-02-30',
    '1990-13-01',
    '1990-5-17',
    '17.05.1990',
    '05/17/1990',
    '1990-05',
    `${year + 1}-01-01`,
    `${year - 121}-01-01`,
    '',
    19900517,
  ]) {
    const res = await age(f.app, a.cookie, bad);
    assert.equal(res.statusCode, 400, String(bad));
    assert.ok(!res.body.includes(String(bad)) || bad === '', 'no echo');
  }
  assert.equal((await elricEligibility(f.db, a.id)).eligible, false);
});

test('nothing in plaintext: not at rest, not in logs or responses, in any date format', async (t) => {
  const f = await fixture(t);
  const a = await person(f.app);
  assert.equal(await link(f, a, '100000000000000000104'), '/settings/account?google=linked');
  const lines: string[] = [];
  const original = {
    log: console.log,
    warn: console.warn,
    error: console.error,
    info: console.info,
  };
  for (const method of ['log', 'warn', 'error', 'info'] as const)
    console[method] = (...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    };
  let responses = '';
  try {
    responses += (await age(f.app, a.cookie, '1987-11-23')).body;
    responses += (
      await f.app.inject({ method: 'GET', url: '/api/auth/google', headers: { cookie: a.cookie } })
    ).body;
    responses += (
      await f.app.inject({ method: 'GET', url: '/api/snapshot', headers: { cookie: a.cookie } })
    ).body;
  } finally {
    Object.assign(console, original);
  }
  const tables = (
    await f.db.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema='public'",
    )
  ).rows.map((row) => row.table_name);
  let dump = '';
  for (const table of tables)
    dump += JSON.stringify((await f.db.query(`SELECT * FROM "${table}"`)).rows, (_k, v) =>
      v instanceof Uint8Array ? Buffer.from(v).toString('latin1') : v,
    );
  const formats = /1987-11-23|23\.11\.1987|11\/23\/1987|19871123|1987-11|"1987"/;
  for (const [name, text] of [
    ['database', dump],
    ['logs', lines.join('\n')],
    ['responses', responses],
  ])
    assert.ok(!formats.test(text), `no plaintext date in ${name}`);
});

test('wrong account, a flipped byte, the wrong key or another purpose does not open (null)', async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  const db = await PGlite.create();
  await db.exec(`CREATE TABLE operators (id text PRIMARY KEY);
    INSERT INTO operators VALUES ('op-a'), ('op-b');
    CREATE TABLE elric_age_checks (operator_id text PRIMARY KEY REFERENCES operators(id) ON DELETE CASCADE,
      dob_ciphertext bytea, dob_wrapped_dek bytea, dob_kek_id text, source text, over_18 boolean,
      checked_at bigint, locked_at bigint, refused_corrections integer NOT NULL DEFAULT 0);`);
  const keys = ring();
  assert.equal(await pii.storeDob(db, keys, 'op-a', '1990-01-01', 'owner', NOW), 'over_18');
  assert.equal(await pii.isAdult(db, keys, 'op-a', NOW), true);
  // Copied to another account (AAD binds the account).
  await db.query(
    `INSERT INTO elric_age_checks(operator_id,dob_ciphertext,dob_wrapped_dek,dob_kek_id)
     SELECT 'op-b',dob_ciphertext,dob_wrapped_dek,dob_kek_id FROM elric_age_checks WHERE operator_id='op-a'`,
  );
  assert.equal(await pii.isAdult(db, keys, 'op-b', NOW), null);
  // Another key ring.
  assert.equal(await pii.isAdult(db, ring(), 'op-a', NOW), null);
  // A flipped byte in the ciphertext.
  await db.query(
    "UPDATE elric_age_checks SET dob_ciphertext=set_byte(dob_ciphertext, 14, get_byte(dob_ciphertext, 14) # 1) WHERE operator_id='op-a'",
  );
  assert.equal(await pii.isAdult(db, keys, 'op-a', NOW), null);
  await db.close();
  // Another purpose (the AAD includes it).
  const { openPii, piiAad, sealPii } = await import('../server/google/pii-crypto.js');
  const sealed = sealPii(keys.current.key, piiAad('date_of_birth', 'op-a'), Buffer.from('x'));
  assert.throws(() =>
    openPii(keys.current.key, Buffer.from('central-city/pii/v1|other|op-a'), sealed),
  );
});

test('the key: missing, invalid or not distinct is unavailable when hosted; local is ephemeral', () => {
  assert.deepEqual(piiKeys({}, { hosted: true }), { available: false, reason: 'missing' });
  assert.deepEqual(piiKeys({ CITY_PII_KEK: 'short' }, { hosted: true }), {
    available: false,
    reason: 'invalid',
  });
  assert.deepEqual(
    piiKeys({ CITY_PII_KEK: key32(), CITY_PII_KEK_PREVIOUS: 'bad' }, { hosted: true }),
    { available: false, reason: 'invalid' },
  );
  const shared = key32();
  for (const name of [
    'CITY_RATE_LIMIT_KEY',
    'CITY_RESPONDER_KEK',
    'CITY_WAKE_SECRET',
    'CITY_SIGNING_KEY',
    'CRON_SECRET',
    'GOOGLE_OAUTH_CLIENT_SECRET',
  ])
    assert.deepEqual(
      piiKeys({ CITY_PII_KEK: shared, [name]: shared }, { hosted: true }),
      { available: false, reason: 'not_distinct' },
      name,
    );
  // The same 32 bytes as hex in another secret is still the same key.
  const bytes = randomBytes(32);
  assert.equal(
    piiKeys(
      { CITY_PII_KEK: bytes.toString('base64'), CITY_RATE_LIMIT_KEY: bytes.toString('hex') },
      { hosted: true },
    ).available,
    false,
  );
  const local = piiKeys({}, { hosted: false });
  assert.equal(local.available && local.ephemeral, true);
  const ok = ring();
  assert.match(ok.current.kid, /^p_[0-9a-f]{12}$/);
});

test('hosted without the key: storing is unavailable and the age stays unknown (fail closed)', async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  const db = await PGlite.create();
  await db.exec(`CREATE TABLE elric_age_checks (operator_id text PRIMARY KEY, dob_ciphertext bytea,
    dob_wrapped_dek bytea, dob_kek_id text, source text, over_18 boolean, checked_at bigint,
    locked_at bigint, refused_corrections integer NOT NULL DEFAULT 0);`);
  const missing = piiKeys({}, { hosted: true });
  assert.equal(await pii.storeDob(db, missing, 'op-a', '1990-01-01', 'owner', NOW), 'unavailable');
  assert.equal(await pii.isAdult(db, missing, 'op-a', NOW), null);
  await db.close();
});

test('rotation: re-wrap under the new key by stored key id; dry run, confirm, idempotent', async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  const db = await PGlite.create();
  await db.exec(`CREATE TABLE elric_age_checks (operator_id text PRIMARY KEY, dob_ciphertext bytea,
    dob_wrapped_dek bytea, dob_kek_id text, source text, over_18 boolean, checked_at bigint,
    locked_at bigint, refused_corrections integer NOT NULL DEFAULT 0);`);
  const oldRoot = key32();
  const newRoot = key32();
  const old = ring({ CITY_PII_KEK: oldRoot });
  for (const id of ['op-1', 'op-2', 'op-3'])
    await pii.storeDob(db, old, id, '1990-01-01', 'owner', NOW);
  const rotating = ring({ CITY_PII_KEK: newRoot, CITY_PII_KEK_PREVIOUS: oldRoot });
  // Both keys open during the rotation (by stored id).
  assert.equal(await pii.isAdult(db, rotating, 'op-1', NOW), true);
  const dry = await pii.rewrapPiiKeys(db as never, rotating);
  assert.deepEqual(dry, { pending: 3, rewrapped: 0, unknownRoot: 0, dryRun: true });
  const done = await pii.rewrapPiiKeys(db as never, rotating, { confirm: true });
  assert.deepEqual(done, { pending: 3, rewrapped: 3, unknownRoot: 0, dryRun: false });
  assert.deepEqual(await pii.rewrapPiiKeys(db as never, rotating, { confirm: true }), {
    pending: 0,
    rewrapped: 0,
    unknownRoot: 0,
    dryRun: false,
  });
  // The previous key can go: the new one alone opens everything.
  const after = ring({ CITY_PII_KEK: newRoot });
  for (const id of ['op-1', 'op-2', 'op-3'])
    assert.equal(await pii.isAdult(db, after, id, NOW), true);
  assert.equal(await pii.isAdult(db, old, 'op-1', NOW), null);
  await db.close();
});

test('age over time in UTC, 29 February included; deletion crypto-shreds and keeps a lock', async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  const db = await PGlite.create();
  await db.exec(`CREATE TABLE operators (id text PRIMARY KEY);
    INSERT INTO operators VALUES ('op-leap'), ('op-minor');
    CREATE TABLE elric_age_checks (operator_id text PRIMARY KEY REFERENCES operators(id) ON DELETE CASCADE,
      dob_ciphertext bytea, dob_wrapped_dek bytea, dob_kek_id text, source text, over_18 boolean,
      checked_at bigint, locked_at bigint, refused_corrections integer NOT NULL DEFAULT 0);`);
  const keys = ring();
  // Born 29 Feb 2008: stored when already 18 (at 1 March 2026), checked over time.
  const at = (iso: string) => Date.parse(iso);
  assert.equal(
    await pii.storeDob(db, keys, 'op-leap', '2008-02-29', 'owner', at('2026-03-01T00:00:00Z')),
    'over_18',
  );
  assert.equal(await pii.isAdult(db, keys, 'op-leap', at('2026-03-01T00:00:00Z')), true);
  assert.equal(await pii.isAdult(db, keys, 'op-leap', at('2026-02-28T23:59:59Z')), false);
  assert.equal(await pii.storeDob(db, keys, 'op-minor', '2010-06-01', 'owner', NOW), 'under_18');
  // Deletion crypto-shreds the date; the lock stays.
  await pii.deleteDob(db, 'op-minor');
  await pii.deleteDob(db, 'op-leap');
  const rows = (
    await db.query<Record<string, unknown>>(
      'SELECT operator_id,dob_ciphertext,dob_wrapped_dek,dob_kek_id,locked_at FROM elric_age_checks ORDER BY operator_id',
    )
  ).rows;
  for (const row of rows) assert.equal(row.dob_ciphertext, null);
  assert.ok(rows.find((row) => row.operator_id === 'op-minor')!.locked_at);
  assert.equal(await pii.isAdult(db, keys, 'op-minor', NOW), false);
  assert.equal(await pii.isAdult(db, keys, 'op-leap', NOW), null);
  // Deleting the account deletes the row.
  await db.query("DELETE FROM operators WHERE id='op-minor'");
  assert.equal(
    (await db.query("SELECT 1 FROM elric_age_checks WHERE operator_id='op-minor'")).rows.length,
    0,
  );
  await db.close();
});

test('the app schema deletes the age row with the account (ON DELETE CASCADE)', async (t) => {
  const f = await fixture(t);
  const rule = (
    await f.db.query<{ confdeltype: string }>(
      `SELECT c.confdeltype FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid
        WHERE t.relname='elric_age_checks' AND c.contype='f'`,
    )
  ).rows;
  assert.deepEqual(
    rule.map((row) => row.confdeltype),
    ['c'],
  );
});

test('age bands: groups under 10 are suppressed; no per-person output', async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  const db = await PGlite.create();
  await db.exec(`CREATE TABLE elric_age_checks (operator_id text PRIMARY KEY, dob_ciphertext bytea,
    dob_wrapped_dek bytea, dob_kek_id text, source text, over_18 boolean, checked_at bigint,
    locked_at bigint, refused_corrections integer NOT NULL DEFAULT 0);`);
  const keys = ring();
  let n = 0;
  const add = async (count: number, date: string) => {
    for (let i = 0; i < count; i += 1)
      await pii.storeDob(db, keys, `op-${n++}`, date, 'owner', NOW);
  };
  await add(12, '2000-01-01'); // 26: 25_34
  await add(9, '1960-01-01'); // 66: 65_plus, suppressed
  await add(10, '2006-01-01'); // 20: 18_24
  await add(3, '2012-01-01'); // under 18, suppressed
  const bands = await pii.ageBandCounts(db, keys, NOW);
  assert.deepEqual(bands, { '18_24': 10, '25_34': 12 });
  await db.close();
});

test('only server/google/pii.ts reads dob_*; pii.ts exports only the allowed functions', () => {
  assert.deepEqual(Object.keys(pii).sort(), [
    'AGE_BANDS',
    'AGE_BAND_MIN_GROUP',
    'ageBandCounts',
    'ageLocked',
    'defaultPiiKeyring',
    'deleteDob',
    'isAdult',
    'lockAge',
    'ownDateOfBirth',
    'parseDob',
    'rewrapPiiKeys',
    'storeDob',
  ]);
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      // The generated server bundle (scripts/build-api.mjs) inlines server/google/pii.ts.
      if (path === join('api', '_bundle')) continue;
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(ts|tsx|mjs|js)$/.test(name)) files.push(path);
    }
  };
  for (const dir of ['server', 'src', 'shared', 'scripts', 'api', 'mcp', 'connector']) {
    try {
      walk(dir);
    } catch {
      // Missing directories are fine.
    }
  }
  const readers = files.filter((path) =>
    /\bdob_(ciphertext|wrapped_dek|kek_id)\b/.test(readFileSync(path, 'utf8')),
  );
  // pii.ts reads and writes; schema.ts only defines the columns (migration 41).
  assert.deepEqual(readers.sort(), [
    join('server', 'google', 'pii.ts'),
    join('server', 'google', 'schema.ts'),
  ]);
});

test("only the owner's own console session reads the date of birth", async (t) => {
  const f = await fixture(t);
  const a = await person(f.app);
  assert.equal(await link(f, a, '100000000000000000105'), '/settings/account?google=linked');
  assert.equal((await age(f.app, a.cookie, '1990-05-17')).statusCode, 200);
  // Another signed-in person sees nothing of A's (and has no link): 409, no date.
  const b = await person(f.app);
  const other = await view(f.app, b.cookie);
  assert.equal(other.statusCode, 409);
  assert.ok(!other.body.includes('1990'));
  // No session, or a bearer credential instead of the session: refused.
  const anonymous = await f.app.inject({ method: 'GET', url: '/api/elric/age' });
  assert.equal(anonymous.statusCode, 401);
  const bearer = await f.app.inject({
    method: 'GET',
    url: '/api/elric/age',
    headers: { authorization: 'Bearer test-token-0001' },
  });
  assert.equal(bearer.statusCode, 401);
  assert.ok(!bearer.body.includes('1990'));
});

test('a locked row present at upsert time: the save is refused and counted, nothing stored', async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  const db = await PGlite.create();
  await db.exec(`CREATE TABLE elric_age_checks (operator_id text PRIMARY KEY, dob_ciphertext bytea,
    dob_wrapped_dek bytea, dob_kek_id text, source text, over_18 boolean, checked_at bigint,
    locked_at bigint, refused_corrections integer NOT NULL DEFAULT 0);
    INSERT INTO elric_age_checks(operator_id,over_18,locked_at) VALUES ('op-l', false, 1);`);
  const keys = ring();
  assert.equal(await pii.storeDob(db, keys, 'op-l', '1980-01-01', 'owner', NOW), 'locked');
  const row = (
    await db.query<Record<string, unknown>>(
      "SELECT * FROM elric_age_checks WHERE operator_id='op-l'",
    )
  ).rows[0]!;
  assert.equal(row.dob_ciphertext, null);
  assert.equal(Number(row.refused_corrections), 1);
  assert.equal(Number(row.locked_at), 1);
  // A minor's save keeps no date either.
  assert.equal(await pii.storeDob(db, keys, 'op-m', '2015-01-01', 'owner', NOW), 'under_18');
  const minor = (
    await db.query<Record<string, unknown>>(
      "SELECT * FROM elric_age_checks WHERE operator_id='op-m'",
    )
  ).rows[0]!;
  assert.equal(minor.dob_ciphertext, null);
  assert.ok(minor.locked_at);
  await db.close();
});

test('the under-18 lock follows the Google account to another account, and back', async (t) => {
  const f = await fixture(t);
  const minorDate = `${new Date(f.clock.now).getUTCFullYear() - 16}-01-01`;
  const unlink = (cookie: string) =>
    f.app.inject({
      method: 'POST',
      url: '/api/auth/google/unlink',
      headers: { ...jsonHeaders, cookie },
      payload: '{}',
    });
  const m = await person(f.app);
  assert.equal(await link(f, m, '100000000000000000201'), '/settings/account?google=linked');
  assert.equal((await age(f.app, m.cookie, minorDate)).statusCode, 403);
  // Only a keyed hash and the time are kept for the Google account.
  const [lock] = (await f.db.query<Record<string, unknown>>('SELECT * FROM google_age_locks')).rows;
  assert.deepEqual(Object.keys(lock!).sort(), ['locked_at', 'subject_hash']);
  assert.ok(!JSON.stringify(lock).includes('100000000000000000201'));
  // After the 30-day relink cooldown the Google account links to a new account: locked there.
  await unlink(m.cookie);
  f.clock.now += 31 * 24 * 3_600_000;
  const n = await person(f.app);
  assert.equal(
    await link(f, n, '100000000000000000201'),
    '/settings/account?google=elric_age_under_18',
  );
  assert.equal((await age(f.app, n.cookie, '1980-01-01')).statusCode, 403);
  assert.deepEqual(await elricEligibility(f.db, n.id, f.clock.now), {
    eligible: false,
    reason: 'age_under_18',
  });
  // A locked account linking another Google account locks that one too.
  const m2 = await person(f.app);
  assert.equal(await link(f, m2, '100000000000000000202'), '/settings/account?google=linked');
  assert.equal((await age(f.app, m2.cookie, minorDate)).statusCode, 403);
  await unlink(m2.cookie);
  assert.equal(
    await link(f, m2, '100000000000000000203'),
    '/settings/account?google=elric_age_under_18',
  );
  assert.equal((await f.db.query('SELECT 1 FROM google_age_locks')).rows.length, 3);
});

test('without the PII key an under-18 date still locks; the age-lock hash does not use CITY_RATE_LIMIT_KEY', async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  const db = await PGlite.create();
  await db.exec(`CREATE TABLE elric_age_checks (operator_id text PRIMARY KEY, dob_ciphertext bytea,
    dob_wrapped_dek bytea, dob_kek_id text, source text, over_18 boolean, checked_at bigint,
    locked_at bigint, refused_corrections integer NOT NULL DEFAULT 0);
    CREATE TABLE google_age_locks (subject_hash text PRIMARY KEY, locked_at bigint NOT NULL);`);
  const missing = piiKeys({}, { hosted: true });
  assert.equal(await pii.storeDob(db, missing, 'op-x', '2015-01-01', 'owner', NOW), 'under_18');
  assert.equal(await pii.isAdult(db, missing, 'op-x', NOW), false);
  assert.equal(await pii.storeDob(db, missing, 'op-y', '1980-01-01', 'owner', NOW), 'unavailable');
  // The lock hash is stable across a CITY_RATE_LIMIT_KEY rotation.
  const { lockSubject, subjectLocked } = await import('../server/google/cooldown.js');
  const before = process.env.CITY_RATE_LIMIT_KEY;
  process.env.CITY_RATE_LIMIT_KEY = randomBytes(32).toString('hex');
  await lockSubject(db, 'subject-1', NOW);
  process.env.CITY_RATE_LIMIT_KEY = randomBytes(32).toString('hex');
  assert.equal(await subjectLocked(db, 'subject-1'), true);
  if (before === undefined) delete process.env.CITY_RATE_LIMIT_KEY;
  else process.env.CITY_RATE_LIMIT_KEY = before;
  await db.close();
});
