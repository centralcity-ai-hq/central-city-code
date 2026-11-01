import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { createApp } from '../server/app.js';
import { loadHostedConfig } from '../server/hosted.js';
import { PAGE_HEADERS } from '../server/oauth/pages.js';
import {
  CONTENT_SECURITY_POLICY,
  edgeReferrerPolicy,
  FUNCTION_REFERRER_POLICY,
  functionSecurityHeaders,
  PERMISSIONS_POLICY,
  SECURITY_HEADER_NAMES,
  securityHeaders,
  SHARED_SECURITY_HEADERS,
  STRICT_TRANSPORT_SECURITY,
} from '../server/security-headers.js';
import { PUBLIC_BASE_RPC } from '../shared/base/on-base.js';

process.env.CITY_RATE_LIMIT_KEY ??= 'synthetic-test-only-rate-limit-secret-0000';

const vercel = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8')) as {
  headers: Array<{ source: string; headers: Array<{ key: string; value: string }> }>;
};

/** The headers the edge sets on `path`: every matching rule in order, a later value replacing. */
function edgeHeaders(path: string): Map<string, string> {
  const headers = new Map<string, string>();
  for (const rule of vercel.headers)
    if (new RegExp(`^${rule.source}$`).test(path))
      for (const header of rule.headers) headers.set(header.key.toLowerCase(), header.value);
  return headers;
}

// Static files, client routes, the OAuth pages, the function's own paths and discovery files.
const PATHS = [
  '/',
  '/rooms',
  '/explorer',
  '/assets/index-abc123.js',
  '/papers/whitepaper.pdf',
  '/docs/api.md',
  '/llms.txt',
  '/mcp',
  '/mcp/server-card',
  '/.well-known/ai-catalog.json',
  '/oauth/authorize',
  '/oauth/consent',
  '/oauth/token',
  '/api/public/stats',
  '/api/session',
  '/api/snapshot',
  '/api/auth/login',
  '/a2a/agent',
  '/a/x',
  '/j/abc',
];
const SECURITY = [...Object.keys(SHARED_SECURITY_HEADERS), 'Referrer-Policy'];

test('the edge sends the same Content-Security-Policy as the server', () => {
  const values = vercel.headers.flatMap((rule) =>
    rule.headers.filter((header) => header.key === 'Content-Security-Policy'),
  );
  assert.ok(values.length > 0);
  for (const header of values) assert.equal(header.value, CONTENT_SECURITY_POLICY);
});

test('the edge sends every header of the security policy, path by path (CCA-406)', () => {
  for (const path of PATHS) {
    const edge = edgeHeaders(path);
    const policy = securityHeaders(path);
    for (const name of SECURITY_HEADER_NAMES)
      assert.equal(edge.get(name.toLowerCase()), policy[name], `${path}: ${name}`);
    for (const [key, value] of Object.entries(SHARED_SECURITY_HEADERS))
      assert.equal(edge.get(key.toLowerCase()), value, `${key} on ${path}`);
    assert.equal(edge.get('referrer-policy'), edgeReferrerPolicy(path), path);
  }
  assert.equal(securityHeaders('/oauth/authorize')['Referrer-Policy'], 'same-origin');
  assert.equal(securityHeaders('/api/x')['Referrer-Policy'], 'no-referrer');
});

test('no edge rule sets a security header to anything but the policy (CCA-406)', () => {
  const names = new Set(SECURITY_HEADER_NAMES.map((name) => name.toLowerCase()));
  for (const rule of vercel.headers)
    for (const header of rule.headers)
      if (names.has(header.key.toLowerCase())) {
        const allowed = new Set(
          PATHS.map((path) =>
            Object.entries(securityHeaders(path)).find(
              ([name]) => name.toLowerCase() === header.key.toLowerCase(),
            ),
          ).flatMap((entry) => (entry ? [entry[1]] : [])),
        );
        assert.ok(allowed.has(header.value), `${rule.source}: ${header.key}=${header.value}`);
      }
});

test('HSTS covers this host only until the DNS zone is checked (CCA-403)', () => {
  // includeSubDomains waits for an owner check of the authoritative DNS zone (room18 #1051).
  assert.equal(STRICT_TRANSPORT_SECURITY, 'max-age=63072000');
  for (const path of ['/', '/api/snapshot', '/oauth/authorize']) {
    assert.equal(edgeHeaders(path).get('strict-transport-security'), STRICT_TRANSPORT_SECURITY);
    assert.equal(
      functionSecurityHeaders(true, path)['Strict-Transport-Security'],
      STRICT_TRANSPORT_SECURITY,
    );
  }
});

const hosted = loadHostedConfig({
  CITY_HOSTED: '1',
  DATABASE_URL: 'postgresql://db.example.com/staging',
  CITY_PUBLIC_ORIGIN: 'https://city.example.com',
});

for (const mode of ['hosted', 'local'] as const)
  test(`function answers carry the whole policy (${mode})`, async (t) => {
    const app = await createApp(
      mode === 'hosted'
        ? { hosted, database: await PGlite.create('memory://') }
        : { dataDir: 'memory://', startWorkers: false },
    );
    t.after(() => app.close());
    const host = mode === 'hosted' ? 'city.example.com' : '127.0.0.1';
    for (const url of ['/api/session', '/api/not-a-route?x=1', '/oauth/authorize']) {
      const path = url.split('?')[0]!;
      const expected = functionSecurityHeaders(mode === 'hosted', path);
      const res = await app.inject({ url, headers: { host } });
      for (const key of [
        ...SECURITY,
        'Cross-Origin-Opener-Policy',
        'Cross-Origin-Resource-Policy',
      ]) {
        const sent = res.headers[key.toLowerCase()];
        if (key === 'Content-Security-Policy' && url.startsWith('/oauth/')) {
          // A server-rendered page replaces the CSP with a stricter one: never framed.
          assert.equal(sent, PAGE_HEADERS['content-security-policy']);
          assert.match(String(sent), /frame-ancestors 'none'/);
          assert.match(String(sent), /default-src 'none'/);
        } else if (key === 'Strict-Transport-Security' && mode === 'local') {
          assert.equal(sent, undefined, `${key} on plain-HTTP loopback`);
        } else assert.equal(sent, expected[key], `${key} on ${url} (${mode})`);
      }
    }
  });

test('a function answer differs from the edge only where the policy says so', () => {
  // On Vercel the function's header wins. Equal values except the documented Referrer-Policy.
  for (const path of ['/api/session', '/api/public/stats', '/oauth/authorize']) {
    const fn = functionSecurityHeaders(true, path);
    const edge = edgeHeaders(path);
    for (const key of SECURITY_HEADER_NAMES)
      if (key === 'Referrer-Policy') assert.equal(fn[key], FUNCTION_REFERRER_POLICY);
      else assert.equal(fn[key], edge.get(key.toLowerCase()), `${key} on ${path}`);
  }
});

test('browser hardening: opener isolation, private API resources, features off, Trusted Types report-only (CCA-407)', () => {
  const site = securityHeaders('/');
  assert.equal(site['Cross-Origin-Opener-Policy'], 'same-origin-allow-popups');
  assert.equal(site['Content-Security-Policy-Report-Only'], "require-trusted-types-for 'script'");
  // An AI client may open the consent page in its own popup: no opener policy there.
  assert.equal(securityHeaders('/oauth/authorize')['Cross-Origin-Opener-Policy'], undefined);
  // Signed-in API answers cannot be embedded by another site; public reads and files can (the
  // agent icon is shown on Base explorers).
  assert.equal(securityHeaders('/api/snapshot')['Cross-Origin-Resource-Policy'], 'same-origin');
  assert.equal(securityHeaders('/api/public/stats')['Cross-Origin-Resource-Policy'], undefined);
  assert.equal(
    securityHeaders('/brand/directory-icon-1024.png')['Cross-Origin-Resource-Policy'],
    undefined,
  );
  const features = new Map(
    PERMISSIONS_POLICY.split(', ').map((entry) => entry.split('=') as [string, string]),
  );
  for (const off of [
    'camera',
    'microphone',
    'geolocation',
    'payment',
    'usb',
    'serial',
    'hid',
    'bluetooth',
    'display-capture',
    'publickey-credentials-get',
    'browsing-topics',
  ])
    assert.equal(features.get(off), '()', off);
  assert.equal(features.get('autoplay'), '(self)', 'the muted landing video plays');
  assert.equal(features.get('fullscreen'), '(self)');
  assert.ok(!features.has('clipboard-write'), 'the copy buttons keep the browser default');
});

test('the public Base and Arc endpoints are the extra places a page may read a chain from', () => {
  const connect = CONTENT_SECURITY_POLICY.split('; ').find((part) =>
    part.startsWith('connect-src '),
  );
  assert.equal(
    connect,
    `connect-src 'self' ${new URL(PUBLIC_BASE_RPC).origin} https://rpc.mainnet.arc.io https://rpc.testnet.arc.io https://vercel.com/api/blob/`,
  );
  // Scripts still come only from the app itself.
  assert.ok(CONTENT_SECURITY_POLICY.includes("script-src 'self';"));
});
