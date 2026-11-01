import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import * as pii from '../server/google/pii.js';
import { piiKeys, type PiiKeyring } from '../server/google/pii-keys.js';

// Throwaway keys generated per run; no database but a temporary local one is ever opened.
const key32 = () => randomBytes(32).toString('base64');
const NOW = Date.UTC(2026, 9, 1, 12);
const ring = (env: Record<string, string>) =>
  piiKeys(env, { hosted: true }) as Extract<PiiKeyring, { available: true }>;

function runScript(script: string, env: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'cc-rewrap-target-'));
  try {
    return spawnSync(process.execPath, ['--import', 'tsx', resolve('scripts', script)], {
      encoding: 'utf8',
      timeout: 60_000,
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        CITY_DATA_DIR: join(dir, 'data'),
        ...env,
      },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('CCA-641 (a): a re-wrap script refuses DATABASE_URL without CITY_HOSTED=1 instead of using the local database', () => {
  // A syntactically valid URL to a reserved, unresolvable host: nothing may connect to it.
  const databaseUrl = 'postgres://user:synthetic-password@db.example.invalid/citydb';
  for (const [script, env] of [
    [
      'rewrap-responder-keys.ts',
      { CITY_RESPONDER_KEK: key32(), CITY_RESPONDER_KEK_PREVIOUS: key32() },
    ],
    ['rewrap-pii-keys.ts', { CITY_PII_KEK: key32(), CITY_PII_KEK_PREVIOUS: key32() }],
  ] as const) {
    const result = runScript(script, { ...env, DATABASE_URL: databaseUrl });
    assert.equal(result.status, 1, `${script}: ${result.stdout}`);
    assert.match(result.stderr, /DATABASE_URL is set without CITY_HOSTED=1/, script);
    assert.equal(result.stdout, '', `${script} printed counts from the wrong database`);
    assert.doesNotMatch(result.stderr + result.stdout, /synthetic-password/);
  }
});

test('CCA-641 (a): the script names its local target and key ids before it runs', () => {
  const result = runScript('rewrap-pii-keys.ts', {
    CITY_PII_KEK: key32(),
    CITY_PII_KEK_PREVIOUS: key32(),
  });
  assert.match(
    result.stderr,
    /target: local pglite dir=.*; current key p_[0-9a-f]{12}; also opens p_[0-9a-f]{12}/,
  );
});

test('CCA-641 (b): one corrupt row is counted as failed and the re-wrap goes on', async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  const db = await PGlite.create();
  await db.exec(`CREATE TABLE elric_age_checks (operator_id text PRIMARY KEY, dob_ciphertext bytea,
    dob_wrapped_dek bytea, dob_kek_id text, source text, over_18 boolean, checked_at bigint,
    locked_at bigint, refused_corrections integer NOT NULL DEFAULT 0);`);
  const oldRoot = key32();
  const old = ring({ CITY_PII_KEK: oldRoot });
  for (const id of ['op-1', 'op-2', 'op-3'])
    await pii.storeDob(db, old, id, '1990-01-01', 'owner', NOW);
  // op-1's wrapped data key no longer authenticates (a flipped byte).
  const row = (
    await db.query<{ dob_wrapped_dek: Uint8Array }>(
      "SELECT dob_wrapped_dek FROM elric_age_checks WHERE operator_id='op-1'",
    )
  ).rows[0]!;
  const corrupt = Buffer.from(row.dob_wrapped_dek);
  corrupt[corrupt.length - 1] ^= 1;
  await db.query("UPDATE elric_age_checks SET dob_wrapped_dek=$1 WHERE operator_id='op-1'", [
    corrupt,
  ]);
  const rotating = ring({ CITY_PII_KEK: key32(), CITY_PII_KEK_PREVIOUS: oldRoot });
  const counts = await pii.rewrapPiiKeys(db as never, rotating, { confirm: true });
  assert.deepEqual(counts, {
    pending: 3,
    rewrapped: 2,
    unknownRoot: 0,
    failed: 1,
    dryRun: false,
  });
  await db.close();
});
