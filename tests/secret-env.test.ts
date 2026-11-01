import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { piiKeys } from '../server/google/pii-keys.js';
import { responderKeys } from '../server/responder/keys.js';
import { DEPLOYMENT_SECRET_NAMES, NOT_SECRET_NAMES } from '../server/secret-env.js';

// Throwaway values generated per run; none is a deployed secret.
const kek = () => randomBytes(32).toString('base64');

test('CCA-639: neither KEK may equal any other deployment secret, in any form', () => {
  const shared = kek();
  const others = [
    'CRON_SECRET',
    'CITY_OPS_SECRET',
    'CITY_OPS_KEYS_SECRET',
    'CITY_EMAIL_LINK_KEY',
    'CITY_EMAIL_LINK_KEY_PREVIOUS',
    'CITY_EMAIL_API_KEY',
    'GOOGLE_OAUTH_CLIENT_SECRET',
    'CITY_CODE_COUNT_GITHUB_TOKEN',
    'CITY_GITHUB_APP_PRIVATE_KEY',
    'CITY_ELRIC_MODEL_KEY',
  ];
  for (const name of others) {
    assert.deepEqual(
      responderKeys({ CITY_RESPONDER_KEK: shared, [name]: shared }, { hosted: true }),
      { available: false, reason: 'not_distinct' },
      `responder KEK equal to ${name}`,
    );
    assert.deepEqual(
      piiKeys({ CITY_PII_KEK: shared, [name]: shared }, { hosted: true }),
      { available: false, reason: 'not_distinct' },
      `PII KEK equal to ${name}`,
    );
  }
  // Each other: the responder KEK reused as the PII KEK, and the reverse.
  assert.equal(
    responderKeys({ CITY_RESPONDER_KEK: shared, CITY_PII_KEK: shared }, { hosted: true }).available,
    false,
  );
  // A CITY_BASE_SPENDER_KEK entry ("v<n>:<base64>") is compared entry by entry.
  const spender = `v1:${kek()},v2:${shared}`;
  assert.equal(
    responderKeys({ CITY_RESPONDER_KEK: shared, CITY_BASE_SPENDER_KEK: spender }, { hosted: true })
      .available,
    false,
  );
  assert.equal(
    piiKeys({ CITY_PII_KEK: shared, CITY_BASE_SPENDER_KEK: spender }, { hosted: true }).available,
    false,
  );
  // Distinct values everywhere still load.
  assert.equal(
    responderKeys(
      { CITY_RESPONDER_KEK: shared, CITY_BASE_SPENDER_KEK: `v1:${kek()}`, CRON_SECRET: kek() },
      { hosted: true },
    ).available,
    true,
  );
  assert.equal(
    piiKeys(
      { CITY_PII_KEK: shared, CITY_BASE_SPENDER_KEK: `v1:${kek()}`, CITY_OPS_SECRET: kek() },
      { hosted: true },
    ).available,
    true,
  );
});

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'node_modules' ? [] : files(path);
    return /\.(ts|mts|js|mjs)$/.test(name) ? [path] : [];
  });
}

test("CCA-639: the ops secrets' rotation overlap (<SETTING>_PREVIOUS) is in the list too", async () => {
  const { OPS_PREVIOUS_SUFFIX, OPS_SECRET_SETTING, OPS_CAPABILITY_SETTINGS } =
    await import('../server/elric/ops.js');
  const names = new Set<string>(DEPLOYMENT_SECRET_NAMES);
  for (const setting of [OPS_SECRET_SETTING, ...Object.values(OPS_CAPABILITY_SETTINGS)])
    assert.ok(names.has(`${setting}${OPS_PREVIOUS_SUFFIX}`), `${setting}${OPS_PREVIOUS_SUFFIX}`);
});

test("Arc's facilitator key ref is classified: a pointer into the keystore, not a secret", () => {
  assert.ok((NOT_SECRET_NAMES as readonly string[]).includes('CITY_ARC_FACILITATOR_KEY_REF'));
});

test('CCA-639: every secret-looking variable the server reads is classified', () => {
  const known = new Set<string>([...DEPLOYMENT_SECRET_NAMES, ...NOT_SECRET_NAMES]);
  const names = new Set<string>();
  for (const file of ['server', 'api', 'shared'].flatMap(files))
    for (const match of readFileSync(file, 'utf8').matchAll(
      /\b(?:CITY_[A-Z0-9_]+|CRON_[A-Z0-9_]+|GOOGLE_[A-Z0-9_]+)\b/g,
    ))
      if (/SECRET|KEY|KEK|TOKEN|PASSWORD|PRIVATE/.test(match[0])) names.add(match[0]);
  const unclassified = [...names].filter((name) => !known.has(name)).sort();
  assert.deepEqual(
    unclassified,
    [],
    'Add each new secret to DEPLOYMENT_SECRET_NAMES (or NOT_SECRET_NAMES) in server/secret-env.ts.',
  );
});
