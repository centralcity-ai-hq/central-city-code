import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import type { Database } from '../server/database.js';
import {
  OWN_PAYMASTER_KEYS_SQL,
  provisionedPaymasterKeys,
  provisionPaymasterKeysAtStart,
} from '../server/base/chain/own-paymaster-keys.js';

// CCA-716 security gate: the key-settings mismatch at start must reach production logs. Production
// builds Fastify with logger:false (server/app.ts), so app.log drops it; the line goes to the
// app's logLine or, by default, the console: exactly one sanitized line, the setting NAME only.

const KEK = `v1:${randomBytes(32).toString('base64')}`;

async function database(t: { after: (fn: () => Promise<unknown>) => void }): Promise<Database> {
  const pg = await PGlite.create('memory://');
  t.after(() => pg.close());
  await pg.exec(`CREATE TABLE base_spender_keys (
    key_id text PRIMARY KEY, kek_version integer NOT NULL, wrapped_dek bytea NOT NULL,
    ciphertext bytea NOT NULL, signer_address text NOT NULL, committed_at bigint,
    created_at bigint NOT NULL)`);
  await pg.exec(OWN_PAYMASTER_KEYS_SQL);
  return {
    query: (sql: string, params?: unknown[]) => pg.query(sql, params) as never,
    transaction: (action: (tx: never) => Promise<unknown>) =>
      pg.transaction((tx) => action(tx as never)),
  } as unknown as Database;
}

/** Every console line written while `run` executes (the production default sink). */
async function consoleLines<T>(run: () => Promise<T>): Promise<{ value: T; lines: string[] }> {
  const lines: string[] = [];
  const methods = ['log', 'info', 'warn', 'error', 'debug'] as const;
  const originals = methods.map((name) => console[name]);
  for (const name of methods)
    console[name] = (...args: unknown[]) => void lines.push(args.map(String).join(' '));
  try {
    return { value: await run(), lines };
  } finally {
    methods.forEach((name, i) => (console[name] = originals[i]!));
  }
}

test('mismatch at start with the production default (no logLine, no Fastify logger): exactly one sanitized console line', async (t) => {
  const db = await database(t);
  const base = { CITY_BASE_OWN_PAYMASTER: 'prepare', CITY_BASE_SPENDER_KEK: KEK };
  assert.equal(await provisionPaymasterKeysAtStart({ db, env: base }), 'ready');
  const keys = await provisionedPaymasterKeys(db);
  const refs = [...keys.values()].map((key) => key.keyRef);
  const wrongRef = keys.get('paymaster_submitter_1')!.keyRef;
  const env = { ...base, CITY_BASE_PAYMASTER_SIGNER_KEY_REF: wrongRef };

  const { value, lines } = await consoleLines(() => provisionPaymasterKeysAtStart({ db, env }));
  assert.equal(value, 'settings_mismatch');
  assert.equal(lines.length, 1, 'exactly one line');
  assert.deepEqual(JSON.parse(lines[0]!), {
    event: 'own_paymaster_keys',
    state: 'settings_mismatch',
    setting: 'CITY_BASE_PAYMASTER_SIGNER_KEY_REF',
  });
  for (const ref of refs) assert.ok(!lines[0]!.includes(ref), 'no key reference');
  assert.ok(!lines[0]!.includes(KEK), 'no setting value');
  assert.doesNotMatch(lines[0]!, /v1:/);

  // With the app's logLine, the same single line goes there instead of the console.
  const sink: string[] = [];
  const routed = await consoleLines(() =>
    provisionPaymasterKeysAtStart({ db, env, log: (line) => sink.push(line) }),
  );
  assert.deepEqual(routed.lines, []);
  assert.deepEqual(sink, lines);

  // A matching configuration writes nothing.
  const quiet = await consoleLines(() =>
    provisionPaymasterKeysAtStart({
      db,
      env: { ...base, CITY_BASE_PAYMASTER_SIGNER_KEY_REF: keys.get('paymaster_signer')!.keyRef },
    }),
  );
  assert.equal(quiet.value, 'ready');
  assert.deepEqual(quiet.lines, []);
});

test('the app sends the mismatch through logLine/console, never the (disabled) Fastify logger', () => {
  const app = readFileSync(new URL('../server/app.ts', import.meta.url), 'utf8');
  assert.match(app, /logger: false/);
  const start = app.slice(app.indexOf('provisionPaymasterKeysAtStart({'));
  assert.match(start.slice(0, 400), /log: options\.logLine/);
  assert.doesNotMatch(
    app,
    /app\.log\.\w+\(\{ event: 'own_paymaster_keys', state: 'settings_mismatch'/,
  );
  assert.doesNotMatch(app, /paymasterKeys === 'settings_mismatch'\)\s*app\.log/);
});
