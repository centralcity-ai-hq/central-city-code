import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { isClientRoute } from '../shared/routes.js';

// Public domain-ownership proof issued by OpenAI; not an authentication credential.
const expected = 'kFuVo3pVvJj5grNciN7FiXc33toPxTrH_Zb-Ml9Y_5A';
const path = '/.well-known/openai-apps-challenge';

test('OpenAI domain challenge contains the exact public proof without extra bytes', () => {
  const contents = readFileSync(new URL(`../public${path}`, import.meta.url));
  assert.deepEqual(contents, Buffer.from(expected, 'utf8'));
});

test('OpenAI challenge is plain text, revalidated, and outside SPA routing', () => {
  const config = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));
  const rule = config.headers.find((entry: { source: string }) => entry.source === path);
  assert.ok(rule, 'explicit challenge headers must exist');
  const headers = Object.fromEntries(
    rule.headers.map(({ key, value }: { key: string; value: string }) => [
      key.toLowerCase(),
      value,
    ]),
  );
  assert.equal(headers['content-type'], 'text/plain; charset=utf-8');
  assert.equal(headers['cache-control'], 'no-cache');
  assert.equal(isClientRoute(path), false);
  assert.ok(
    !config.rewrites.some((entry: { source: string }) => entry.source === path),
    'the challenge is a static asset, not an API or SPA rewrite',
  );
});
