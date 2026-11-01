import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Fastify from 'fastify';
import type { Database } from '../server/database.js';
import {
  OPS_CAPABILITY_SETTINGS,
  opsAuthorizedFor,
  type OpsCapability,
} from '../server/elric/ops.js';
import { registerSponsorStatsRoute, SFP_STATS_PATH } from '../server/feed/pay/sponsor-routes.js';
import {
  PAYMASTER_KEYS_PATH,
  registerOwnPaymasterKeysRoute,
} from '../server/base/chain/own-paymaster-keys.js';

// CCA-717: one operations secret per capability, the legacy CITY_OPS_SECRET as fallback, and a
// current + previous value accepted during a rotation. Fake values only.

const fake = (label: string) => `fake-${label}-`.padEnd(40, 'x');
const LEGACY = fake('legacy');
const KEYS = fake('keys');
const KEYS_OLD = fake('keys-old');
const METRICS = fake('metrics');
const bearer = (value: string) => `Bearer ${value}`;
const CAPABILITIES = Object.keys(OPS_CAPABILITY_SETTINGS) as OpsCapability[];

test('capability settings: distinct names, one per power', () => {
  assert.deepEqual(OPS_CAPABILITY_SETTINGS, {
    keys: 'CITY_OPS_KEYS_SECRET',
    elric: 'CITY_OPS_ELRIC_SECRET',
    review: 'CITY_OPS_REVIEW_SECRET',
    metrics: 'CITY_OPS_METRICS_SECRET',
    email: 'CITY_OPS_EMAIL_SECRET',
  });
});

test('legacy CITY_OPS_SECRET opens a capability only while its own setting is unset', () => {
  const legacyOnly = { CITY_OPS_SECRET: LEGACY };
  for (const capability of CAPABILITIES)
    assert.equal(opsAuthorizedFor(bearer(LEGACY), legacyOnly, capability), true, capability);
  const split = { CITY_OPS_SECRET: LEGACY, CITY_OPS_KEYS_SECRET: KEYS };
  assert.equal(
    opsAuthorizedFor(bearer(LEGACY), split, 'keys'),
    false,
    'legacy no longer opens keys',
  );
  assert.equal(opsAuthorizedFor(bearer(KEYS), split, 'keys'), true);
  assert.equal(opsAuthorizedFor(bearer(LEGACY), split, 'metrics'), true, 'unsplit keeps legacy');
  for (const capability of CAPABILITIES.filter((c) => c !== 'keys'))
    assert.equal(
      opsAuthorizedFor(bearer(KEYS), split, capability),
      false,
      `keys opens ${capability}`,
    );
});

test('rotation: the current and previous values both work; previous only next to a current', () => {
  const rotating = { CITY_OPS_KEYS_SECRET: KEYS, CITY_OPS_KEYS_SECRET_PREVIOUS: KEYS_OLD };
  assert.equal(opsAuthorizedFor(bearer(KEYS), rotating, 'keys'), true);
  assert.equal(opsAuthorizedFor(bearer(KEYS_OLD), rotating, 'keys'), true);
  assert.equal(opsAuthorizedFor(bearer(KEYS_OLD), rotating, 'metrics'), false);
  // The overlap ends by removing the previous value.
  assert.equal(opsAuthorizedFor(bearer(KEYS_OLD), { CITY_OPS_KEYS_SECRET: KEYS }, 'keys'), false);
  // A previous value alone opens nothing.
  assert.equal(
    opsAuthorizedFor(bearer(KEYS_OLD), { CITY_OPS_KEYS_SECRET_PREVIOUS: KEYS_OLD }, 'keys'),
    false,
  );
  // The legacy secret rotates the same way.
  const legacyRotating = { CITY_OPS_SECRET: LEGACY, CITY_OPS_SECRET_PREVIOUS: fake('legacy-old') };
  assert.equal(opsAuthorizedFor(bearer(fake('legacy-old')), legacyRotating, 'elric'), true);
  // Short values and wrong headers still fail closed.
  assert.equal(opsAuthorizedFor(bearer('short'), { CITY_OPS_KEYS_SECRET: 'short' }, 'keys'), false);
  assert.equal(opsAuthorizedFor(KEYS, { CITY_OPS_KEYS_SECRET: KEYS }, 'keys'), false);
  assert.equal(opsAuthorizedFor(undefined, { CITY_OPS_KEYS_SECRET: KEYS }, 'keys'), false);
  assert.equal(opsAuthorizedFor(bearer(KEYS), {}, 'keys'), false);
});

test('routes: the keys secret cannot read metrics and the metrics secret cannot make keys', async (t) => {
  const env = { CITY_OPS_KEYS_SECRET: KEYS, CITY_OPS_METRICS_SECRET: METRICS };
  const db = {
    query: async () => ({ rows: [] }),
    transaction: async () => undefined,
  } as unknown as Database;
  const app = Fastify();
  t.after(() => app.close());
  registerSponsorStatsRoute(app, { db, env });
  registerOwnPaymasterKeysRoute(app, { db, env });
  const stats = (secret: string) =>
    app.inject({ method: 'GET', url: SFP_STATS_PATH, headers: { authorization: bearer(secret) } });
  const keys = (secret: string) =>
    app.inject({
      method: 'POST',
      url: PAYMASTER_KEYS_PATH,
      headers: { authorization: bearer(secret) },
    });
  assert.equal((await stats(KEYS)).statusCode, 404);
  assert.equal((await keys(METRICS)).statusCode, 404);
  // The right secret passes the guard (the keys route then answers 503: no keystore here).
  assert.equal((await keys(KEYS)).statusCode, 503);
});

test('the operations doc names every capability setting (names only)', () => {
  const doc = readFileSync(new URL('../docs/OPERATIONS.md', import.meta.url), 'utf8');
  const section = doc.slice(doc.indexOf('## Operations secrets'));
  assert.ok(doc.includes('## Operations secrets'));
  for (const setting of [...Object.values(OPS_CAPABILITY_SETTINGS), 'CITY_OPS_SECRET'])
    assert.match(section, new RegExp(`\`${setting}\``), setting);
  assert.match(section, /_PREVIOUS/);
  // The split revokes no legacy access until the owner sets the settings in the deployment.
  assert.match(section, /revokes nothing by itself/);
  assert.match(section, /until the owner sets/);
});
