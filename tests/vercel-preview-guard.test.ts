import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { previewIsolated } from '../server/migrations.js';

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

test('automated dependency-update branches get no preview build', () => {
  const config = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8')) as {
    git?: { deploymentEnabled?: Record<string, boolean> };
  };
  assert.equal(config.git?.deploymentEnabled?.['dependabot/**'], false);
});
