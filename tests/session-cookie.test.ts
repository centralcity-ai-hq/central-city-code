import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { createApp, SESSION_MAX_AGE_MS, SESSION_RENEW_INTERVAL_MS } from '../server/app.js';
import { loadHostedConfig } from '../server/hosted.js';
import { LEGACY_COOKIE_READ_UNTIL, presentedCookie } from '../server/session-cookie.js';

process.env.CITY_RATE_LIMIT_KEY ??= 'synthetic-test-only-rate-limit-secret-0000';

const hosted = loadHostedConfig({
  CITY_HOSTED: '1',
  DATABASE_URL: 'postgresql://db.example.com/staging',
  CITY_PUBLIC_ORIGIN: 'https://city.example.com',
});
const headers = {
  host: 'city.example.com',
  origin: 'https://city.example.com',
  'x-city-request': '1',
  'content-type': 'application/json',
};

async function hostedApp(t: test.TestContext, start = Date.parse('2026-10-25T10:00:00Z')) {
  let now = start;
  const database = await PGlite.create('memory://');
  const app = await createApp({ hosted, database, now: () => now });
  t.after(() => app.close());
  const registration = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    headers,
    payload: { name: 'Cookie owner', password: 'a synthetic long password' },
  });
  assert.equal(registration.statusCode, 201, registration.body);
  return {
    app,
    registration,
    advance: (ms: number) => (now += ms),
    // As a sign-in from before the rename was stored (sessions.host_cookie default).
    markIssuedBeforeRename: () => database.query('UPDATE sessions SET host_cookie=false'),
  };
}

test('a hosted sign-in sets __Host- cookies: Secure, Path=/, no Domain', async (t) => {
  const { app, registration } = await hostedApp(t);
  const session = registration.cookies.find((cookie) => cookie.name === '__Host-cc_session');
  assert.ok(session, 'session cookie carries the __Host- prefix');
  assert.equal(session.secure, true);
  assert.equal(session.path, '/');
  assert.equal(session.domain, undefined);
  assert.equal(registration.cookies.filter((cookie) => cookie.name === 'cc_session').length, 0);
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers,
    payload: { name: 'Cookie owner', password: 'a synthetic long password' },
  });
  assert.equal(login.statusCode, 200);
  const device = login.cookies.find((cookie) => cookie.name === '__Host-cc_device');
  assert.ok(device, 'known-device cookie carries the __Host- prefix');
  assert.equal(device.secure, true);
  assert.equal(device.path, '/');
  const snapshot = await app.inject({
    url: '/api/snapshot',
    headers: { ...headers, cookie: `__Host-cc_session=${session.value}` },
  });
  assert.equal(snapshot.statusCode, 200);
});

test('a browser signed in under the old name stays signed in and moves to the new name', async (t) => {
  const { app, registration, advance, markIssuedBeforeRename } = await hostedApp(t);
  const token = registration.cookies.find((cookie) => cookie.name === '__Host-cc_session')!.value;
  await markIssuedBeforeRename();
  const legacy = { ...headers, cookie: `cc_session=${token}` };
  assert.equal((await app.inject({ url: '/api/snapshot', headers: legacy })).statusCode, 200);
  // The next renewal writes the prefixed cookie (same token) and clears the old one.
  advance(SESSION_RENEW_INTERVAL_MS + 60_000);
  const renewed = await app.inject({ url: '/api/snapshot', headers: legacy });
  assert.equal(renewed.statusCode, 200);
  const prefixed = renewed.cookies.find((cookie) => cookie.name === '__Host-cc_session');
  assert.equal(prefixed?.value, token);
  const cleared = renewed.cookies.find((cookie) => cookie.name === 'cc_session');
  assert.equal(cleared?.value, '');
  assert.equal(cleared?.path, '/');
});

test('a sign-in issued under the new name is not read from the old name', async (t) => {
  const { app, advance } = await hostedApp(t);
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers,
    payload: { name: 'Cookie owner', password: 'a synthetic long password' },
  });
  assert.equal(login.statusCode, 200);
  const token = login.cookies.find((cookie) => cookie.name === '__Host-cc_session')!.value;
  const plain = { ...headers, cookie: `cc_session=${token}` };
  assert.equal((await app.inject({ url: '/api/snapshot', headers: plain })).statusCode, 401);
  // Not even once a renewal is due: the server never moves it to the prefixed name.
  advance(SESSION_RENEW_INTERVAL_MS + 60_000);
  const later = await app.inject({ url: '/api/snapshot', headers: plain });
  assert.equal(later.statusCode, 401);
  assert.equal(
    later.cookies.filter((cookie) => cookie.name === '__Host-cc_session').length,
    0,
    'no prefixed cookie is written for a session read from the plain name',
  );
  const prefixed = { ...headers, cookie: `__Host-cc_session=${token}` };
  assert.equal((await app.inject({ url: '/api/snapshot', headers: prefixed })).statusCode, 200);
});

test('a second session cookie for a parent domain cannot replace the host session', async (t) => {
  const { app, registration } = await hostedApp(t);
  const token = registration.cookies.find((cookie) => cookie.name === '__Host-cc_session')!.value;
  const other = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    headers,
    payload: { name: 'Other owner', password: 'a synthetic long password' },
  });
  const otherToken = other.cookies.find((cookie) => cookie.name === '__Host-cc_session')!.value;
  // A plain-named cookie sent next to the prefixed one is ignored.
  const mixed = await app.inject({
    url: '/api/snapshot',
    headers: { ...headers, cookie: `cc_session=${otherToken}; __Host-cc_session=${token}` },
  });
  assert.equal(mixed.statusCode, 200);
  assert.equal(mixed.json().operator.name, 'Cookie owner');
  // Two plain-named cookies (the old name, before the move) read as signed out.
  const twice = await app.inject({
    url: '/api/snapshot',
    headers: { ...headers, cookie: `cc_session=${otherToken}; cc_session=${token}` },
  });
  assert.equal(twice.statusCode, 401);
  // The prefixed name sent twice reads as signed out too, whichever copy comes first (CCA-403).
  for (const cookie of [
    `__Host-cc_session=${token}; __Host-cc_session=${otherToken}`,
    `__Host-cc_session=${otherToken}; __Host-cc_session=${token}`,
  ])
    assert.equal(
      (await app.inject({ url: '/api/snapshot', headers: { ...headers, cookie } })).statusCode,
      401,
      cookie,
    );
});

test('loopback development signs a request with a duplicated cc_session out (CCA-403)', async (t) => {
  const app = await createApp({ dataDir: 'memory://', startWorkers: false });
  t.after(() => app.close());
  const registration = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    headers: { 'content-type': 'application/json', 'x-city-request': '1' },
    payload: { name: 'Cookie owner', password: 'a synthetic long password' },
  });
  assert.ok(registration.statusCode < 300, registration.body);
  const value = registration.cookies.find((cookie) => cookie.name === 'cc_session')!.value;
  const snapshot = (cookie: string) =>
    app.inject({ url: '/api/snapshot', headers: { 'x-city-request': '1', cookie } });
  assert.equal((await snapshot(`cc_session=${value}`)).statusCode, 200);
  assert.equal((await snapshot(`cc_session=planted; cc_session=${value}`)).statusCode, 401);
  assert.equal((await snapshot(`cc_session=${value}; cc_session=planted`)).statusCode, 401);
});

test('logout clears both the current and the old cookie name', async (t) => {
  const { app, registration } = await hostedApp(t);
  const token = registration.cookies.find((cookie) => cookie.name === '__Host-cc_session')!.value;
  const logout = await app.inject({
    method: 'POST',
    url: '/api/auth/logout',
    headers: { ...headers, cookie: `cc_session=${token}` },
    payload: {},
  });
  assert.equal(logout.statusCode, 200);
  assert.deepEqual(logout.cookies.map((cookie) => [cookie.name, cookie.value]).sort(), [
    ['__Host-cc_session', ''],
    ['cc_session', ''],
  ]);
  const after = await app.inject({
    url: '/api/snapshot',
    headers: { ...headers, cookie: `__Host-cc_session=${token}` },
  });
  assert.equal(after.statusCode, 401);
});

test('the old-name read ends at LEGACY_COOKIE_READ_UNTIL', async (t) => {
  // Signed in shortly before the end, still within the session's 24 h idle timeout after it.
  const { app, registration, advance, markIssuedBeforeRename } = await hostedApp(
    t,
    LEGACY_COOKIE_READ_UNTIL - 2 * 60 * 60_000,
  );
  const token = registration.cookies.find((cookie) => cookie.name === '__Host-cc_session')!.value;
  await markIssuedBeforeRename();
  const legacy = { ...headers, cookie: `cc_session=${token}` };
  assert.equal((await app.inject({ url: '/api/snapshot', headers: legacy })).statusCode, 200);
  advance(2 * 60 * 60_000);
  // From the end on the plain name reads as signed out; the prefixed name still works.
  assert.equal((await app.inject({ url: '/api/snapshot', headers: legacy })).statusCode, 401);
  const prefixed = { ...headers, cookie: `__Host-cc_session=${token}` };
  assert.equal((await app.inject({ url: '/api/snapshot', headers: prefixed })).statusCode, 200);
  // The plain known-device cookie is not read either (no device recognition from it).
  const end = LEGACY_COOKIE_READ_UNTIL;
  assert.equal(
    presentedCookie('cc_device=d', { cc_device: 'd' }, 'cc_device', true, end),
    undefined,
  );
  assert.deepEqual(presentedCookie('cc_device=d', { cc_device: 'd' }, 'cc_device', true, end - 1), {
    value: 'd',
    legacy: true,
  });
  // Loopback development keeps reading its plain names after the end.
  assert.deepEqual(
    presentedCookie('cc_session=a', { cc_session: 'a' }, 'cc_session', false, end + 1),
    { value: 'a', legacy: false },
  );
  // The end leaves every session from before it time to end on its own: at most 30 days.
  assert.ok(LEGACY_COOKIE_READ_UNTIL - Date.parse('2026-10-25T00:00:00Z') > SESSION_MAX_AGE_MS);
});

test('presentedCookie keeps plain names for loopback development', () => {
  assert.deepEqual(presentedCookie('cc_session=a', { cc_session: 'a' }, 'cc_session', false), {
    value: 'a',
    legacy: false,
  });
  assert.equal(
    presentedCookie('cc_session=a; cc_session=b', { cc_session: 'a' }, 'cc_session', false),
    undefined,
  );
  assert.equal(
    presentedCookie('__Host-cc_session=a', { '__Host-cc_session': 'a' }, 'cc_session', false),
    undefined,
  );
});
