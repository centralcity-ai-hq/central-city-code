import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/app.js';

/**
 * CCA-508: the root request guard (host and origin check, general rate limit, request
 * protection header, JSON content type) decided on the raw URL only, so a percent-encoded
 * "/api" prefix that the router still matched skipped it. Synthetic requests only.
 */
async function app(t: { after(fn: () => Promise<unknown>): void }, apiRequestsPerMinute = 600) {
  const instance = await createApp({
    dataDir: ':memory:',
    startWorkers: false,
    limits: { apiRequestsPerMinute },
  });
  t.after(() => instance.close());
  return instance;
}

test('CCA-508: an encoded /api prefix meets the host, origin, header and content-type checks', async (t) => {
  const a = await app(t);
  for (const url of ['/%61pi/auth/logout', '/%61%70%69/auth/logout', '/a%70i/auth/logout']) {
    const res = await a.inject({
      method: 'POST',
      url,
      headers: {
        host: 'evil.example',
        origin: 'https://evil.example',
        'content-type': 'text/plain',
      },
      payload: 'x',
    });
    assert.equal(res.statusCode, 403, `${url}: ${res.body}`);
  }
  // From localhost, a POST without the request protection header is still refused.
  const noHeader = await a.inject({
    method: 'POST',
    url: '/%61pi/auth/logout',
    headers: { host: 'localhost', 'content-type': 'application/json' },
    payload: '{}',
  });
  assert.equal(noHeader.statusCode, 403, noHeader.body);
  // The plain path answers the same.
  const plain = await a.inject({
    method: 'POST',
    url: '/api/auth/logout',
    headers: { host: 'localhost', 'content-type': 'application/json' },
    payload: '{}',
  });
  assert.equal(plain.statusCode, 403, plain.body);
});

test('CCA-508: an encoded /api prefix spends the general API rate limit', async (t) => {
  const a = await app(t, 5);
  const codes: number[] = [];
  for (let i = 0; i < 8; i++)
    codes.push(
      (await a.inject({ method: 'GET', url: '/%61pi/session', headers: { host: 'localhost' } }))
        .statusCode,
    );
  assert.ok(codes.includes(429), `no 429 among ${codes.join(',')}`);
});
