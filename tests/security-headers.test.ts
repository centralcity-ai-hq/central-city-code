import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { CONTENT_SECURITY_POLICY } from '../server/security-headers.js';
import { PUBLIC_BASE_RPC } from '../shared/base/on-base.js';

const vercel = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8')) as {
  headers: Array<{ source: string; headers: Array<{ key: string; value: string }> }>;
};

test('the edge sends the same Content-Security-Policy as the server', () => {
  const values = vercel.headers.flatMap((rule) =>
    rule.headers.filter((header) => header.key === 'Content-Security-Policy'),
  );
  assert.ok(values.length > 0);
  for (const header of values) assert.equal(header.value, CONTENT_SECURITY_POLICY);
});

test("Verify's public Base endpoint is the one extra place a page may connect to", () => {
  const connect = CONTENT_SECURITY_POLICY.split('; ').find((part) =>
    part.startsWith('connect-src '),
  );
  assert.equal(connect, `connect-src 'self' ${new URL(PUBLIC_BASE_RPC).origin}`);
  // Scripts still come only from the app itself.
  assert.ok(CONTENT_SECURITY_POLICY.includes("script-src 'self';"));
});
