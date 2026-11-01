import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { PRODUCTION_ONLY_SECRETS, previewIsolated } from '../server/migrations.js';
import { DEPLOYMENT_SECRET_NAMES } from '../server/secret-env.js';

test('a Vercel preview without its own database branch refuses to start', () => {
  assert.throws(
    () => previewIsolated({ VERCEL: '1', VERCEL_ENV: 'preview' }),
    /own database branch/,
  );
  assert.throws(
    () => previewIsolated({ VERCEL: '1', VERCEL_ENV: 'preview', CITY_PREVIEW_DB_ISOLATED: '0' }),
    /own database branch/,
  );
  // An isolated preview, production and local runs start as before.
  previewIsolated({ VERCEL: '1', VERCEL_ENV: 'preview', CITY_PREVIEW_DB_ISOLATED: '1' });
  previewIsolated({ VERCEL: '1', VERCEL_ENV: 'production' });
  previewIsolated({});
});

test('a Vercel preview holding a production-only secret refuses to start, naming only the variable (CCA-401)', () => {
  const preview = { VERCEL: '1', VERCEL_ENV: 'preview', CITY_PREVIEW_DB_ISOLATED: '1' };
  for (const name of ['CITY_BASE_SPENDER_KEK', 'CITY_PII_KEK', 'CITY_RESPONDER_KEK', 'CRON_SECRET'])
    assert.ok(
      PRODUCTION_ONLY_SECRETS.includes(name as (typeof PRODUCTION_ONLY_SECRETS)[number]),
      name,
    );
  for (const name of PRODUCTION_ONLY_SECRETS) {
    const value = `synthetic-${name.toLowerCase()}-value`;
    assert.throws(
      () => previewIsolated({ ...preview, [name]: value }),
      (error: Error) =>
        error.message.includes(name) &&
        error.message.includes('production-only secrets') &&
        !error.message.includes(value),
    );
  }
  // An empty value is no secret; production and local runs may hold every one of them.
  previewIsolated({ ...preview, CRON_SECRET: '' });
  const all = Object.fromEntries(PRODUCTION_ONLY_SECRETS.map((name) => [name, 'x']));
  previewIsolated({ VERCEL: '1', VERCEL_ENV: 'production', ...all });
  previewIsolated(all);
  // Only a Vercel preview refuses: production (also with the isolation flag set by mistake),
  // development, a missing VERCEL_ENV and self-hosted CITY_HOSTED=1 all start with every secret.
  previewIsolated({ VERCEL: '1', VERCEL_ENV: 'production', CITY_PREVIEW_DB_ISOLATED: '1', ...all });
  previewIsolated({ VERCEL: '1', VERCEL_ENV: 'development', ...all });
  previewIsolated({ VERCEL: '1', ...all });
  previewIsolated({ CITY_HOSTED: '1', VERCEL_ENV: 'preview', ...all });
});

test('every deployment secret is production-only, except the two a preview needs of its own (CCA-401)', () => {
  // A preview needs its own rate-limit key (hosted mode refuses to start without one) and its own
  // database branch; every other deployment secret belongs to production alone.
  const previewOwn = new Set(['CITY_RATE_LIMIT_KEY', 'DATABASE_URL']);
  const productionOnly = new Set<string>(PRODUCTION_ONLY_SECRETS);
  for (const name of DEPLOYMENT_SECRET_NAMES)
    assert.ok(previewOwn.has(name) || productionOnly.has(name), `${name} is production-only`);
  for (const name of productionOnly)
    assert.ok((DEPLOYMENT_SECRET_NAMES as readonly string[]).includes(name), `${name} is a secret`);
});

test('automated dependency-update branches get no preview build', () => {
  const config = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8')) as {
    git?: { deploymentEnabled?: Record<string, boolean> };
  };
  assert.equal(config.git?.deploymentEnabled?.['dependabot/**'], false);
});
