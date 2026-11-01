import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/app.js';
import { hitAddressScopes, MemoryRateLimiter, WIDER_SCOPE_FACTORS } from '../server/rate-limit.js';
import { createSignUpAdmission } from '../server/signup-admission.js';
import { GOOGLE_SALT_PENDING_NAME } from '../server/google/routes.js';
import { TERMS_VERSION } from '../shared/terms.js';

const local = { 'content-type': 'application/json', 'x-city-request': '1' };
let names = 0;
async function signUpApp(t: { after: (fn: () => Promise<unknown>) => void }, limits = {}) {
  const app = await createApp({
    dataDir: 'memory://',
    startWorkers: false,
    limits: { apiRequestsPerMinute: 100_000, ...limits },
  });
  t.after(() => app.close());
  const register = async (remoteAddress: string) =>
    (
      await app.inject({
        method: 'POST',
        url: '/api/auth/register',
        remoteAddress,
        headers: local,
        payload: JSON.stringify({
          name: `Scoped owner ${++names}`,
          password: 'Synthetic signup password',
        }),
      })
    ).statusCode;
  return register;
}

test('address scopes: one IPv6 /48 shares 4 source budgets, a /56 shares 2; IPv4 stays per address', async () => {
  const limiter = new MemoryRateLimiter();
  const hit = (ip: string) => hitAddressScopes(limiter, 'register', ip, 10, 60_000);
  assert.deepEqual(WIDER_SCOPE_FACTORS, { site: 2, network: 4, region: 16 });
  // One /64 alone still gets its whole budget.
  for (let i = 0; i < 10; i++) assert.ok((await hit(`2001:db8:5:100::${i + 1}`)).allowed);
  assert.equal((await hit('2001:db8:5:100::99')).allowed, false);
  // A source refused at its own budget spent nothing of the /56: the next /64 in it gets 10.
  for (let i = 0; i < 10; i++) assert.ok((await hit(`2001:db8:5:101::${i + 1}`)).allowed);
  // The /56 (2001:db8:5:100::/56) is now full, whichever /64 inside it asks.
  assert.equal((await hit('2001:db8:5:1ff::1')).allowed, false);
  // Another /56 of the same /48 gets the /48's other half, then the /48 is full.
  for (let i = 0; i < 20; i++)
    assert.ok((await hit(`2001:db8:5:2${i < 10 ? '0' : '1'}0::${i + 1}`)).allowed);
  assert.equal((await hit('2001:db8:5:300::1')).allowed, false);
  // A different /48 is untouched.
  assert.ok((await hit('2001:db8:6:100::1')).allowed);
  // IPv4: neighbours in one /24 do not share a budget.
  for (let host = 1; host <= 30; host++) assert.ok((await hit(`198.51.100.${host}`)).allowed);
});

test('password sign-up counts the IPv6 /56 and /48, not only the /64', async (t) => {
  const register = await signUpApp(t);
  const statuses: number[] = [];
  // 6 sign-ups from each of 16 /64s in one /48 (10 per /64 would allow all 96).
  for (let prefix = 0; prefix < 16; prefix++)
    for (let i = 0; i < 6; i++)
      statuses.push(await register(`2001:db8:9:${(prefix * 0x40).toString(16)}::${i + 1}`));
  assert.equal(statuses.filter((status) => status === 201).length, 40);
  assert.ok(statuses.every((status) => status === 201 || status === 429));
  // An address outside that /48 and an IPv4 address still sign up.
  assert.equal(await register('2001:db8:a:1::1'), 201);
  assert.equal(await register('198.51.100.20'), 201);
});

test('sign-up counts the IPv6 /32 too: many /48s of one provider share 16 source budgets', async () => {
  const time = 1_800_000_000_000;
  const admit = createSignUpAdmission({
    limiter: new MemoryRateLimiter(() => time),
    clock: () => time,
    caps: {
      registrationsPerWindow: 10,
      registrationsPerHourGlobal: 0,
      registrationsAlertPerHour: 1000,
    },
    log: () => {},
  });
  let allowed = 0;
  // 8 /48s inside 2001:db8::/32, 40 attempts from 4 /56s of each (each /48 alone allows 40).
  for (let network = 0; network < 8; network++)
    for (let i = 0; i < 40; i++) {
      const site = ((i % 4) * 0x100).toString(16);
      if ((await admit(`2001:db8:${network + 1}:${site}::${i + 1}`)).allowed) allowed++;
    }
  assert.equal(allowed, 160);
  // Another /32 and IPv4 are untouched; sign-in and the OAuth server never count the /32.
  assert.ok((await admit('2001:db9:1:100::1')).allowed);
  assert.ok((await admit('198.51.100.77')).allowed);
  const limiter = new MemoryRateLimiter(() => time);
  for (let network = 0; network < 8; network++)
    for (let i = 0; i < 40; i++)
      assert.ok(
        (
          await hitAddressScopes(
            limiter,
            'login',
            `2001:db8:${network + 1}:${((i % 4) * 0x100).toString(16)}::${i + 1}`,
            10,
            60_000,
          )
        ).allowed,
      );
});

test('a single address keeps its whole sign-up budget, also when it was raised', async (t) => {
  const register = await signUpApp(t, { registrationsPerWindow: 30 });
  for (let i = 0; i < 30; i++) assert.equal(await register('2001:db8:b:1::1'), 201, `sign-up ${i}`);
  assert.equal(await register('2001:db8:b:1::1'), 429);
  for (let i = 0; i < 30; i++) assert.equal(await register('203.0.113.9'), 201, `IPv4 ${i}`);
  assert.equal(await register('203.0.113.9'), 429);
});

test('a deployment-wide sign-up ceiling, when set, refuses with 429 across addresses', async (t) => {
  const register = await signUpApp(t, { registrationsPerHourGlobal: 3 });
  assert.equal(await register('198.51.100.31'), 201);
  assert.equal(await register('198.51.100.32'), 201);
  assert.equal(await register('2001:db8:c:1::1'), 201);
  assert.equal(await register('2001:db8:d:1::1'), 429);
});

test('sign-up volume at the alert threshold is logged once a minute, counts only', async () => {
  let time = 1_800_000_000_000;
  const lines: string[] = [];
  const admit = createSignUpAdmission({
    limiter: new MemoryRateLimiter(() => time),
    clock: () => time,
    caps: {
      registrationsPerWindow: 10,
      registrationsPerHourGlobal: 0,
      registrationsAlertPerHour: 3,
    },
    log: (line) => lines.push(line),
  });
  for (let host = 1; host <= 5; host++) {
    assert.ok((await admit(`198.51.100.${host}`)).allowed);
    time += 20_000;
  }
  // Checked at the 1st and 4th sign-up (a minute apart); only the 4th is at the threshold.
  assert.equal(lines.length, 1);
  const line = JSON.parse(lines[0]!);
  assert.equal(line.event, 'signup.volume');
  assert.equal(line.registrations_this_hour, 4);
  assert.equal(line.ceiling, null);
  assert.doesNotMatch(lines[0]!, /198\.51/);
});

test('account-name checks in onboarding spend a per-address budget, not only a per-account one', async (t) => {
  const app = await createApp({
    dataDir: 'memory://',
    startWorkers: false,
    limits: { apiRequestsPerMinute: 100_000 },
  });
  t.after(() => app.close());
  // Four accounts still choosing their name (as a Google-created account does), and one taken name.
  const cookies: string[] = [];
  for (let n = 0; n < 5; n++) {
    const created = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      remoteAddress: `198.51.100.${120 + n}`,
      headers: local,
      payload: JSON.stringify({
        name: `Name check owner ${n}`,
        password: 'Synthetic signup password',
      }),
    });
    assert.equal(created.statusCode, 201, created.body);
    if (n === 0) continue;
    await app.city.db.query('UPDATE operators SET salt=$2 WHERE name=$1', [
      `Name check owner ${n}`,
      GOOGLE_SALT_PENDING_NAME,
    ]);
    cookies.push(`cc_session=${created.cookies.find((item) => item.name === 'cc_session')!.value}`);
  }
  let attempt = 0;
  const check = async (remoteAddress: string) =>
    (
      await app.inject({
        method: 'POST',
        url: '/api/auth/onboarding',
        remoteAddress,
        headers: { ...local, cookie: cookies[attempt++ % cookies.length]! },
        payload: JSON.stringify({
          terms_version: TERMS_VERSION,
          accept_terms: true,
          name: 'Name check owner 0',
        }),
      })
    ).statusCode;
  // 60 checks of a taken name from six /64s (each in its own /56) of one /48, spread over four
  // accounts (15 each, within each account's own 20): the /48 answers 40 of them.
  const statuses: number[] = [];
  for (let i = 0; i < 60; i++)
    statuses.push(
      await check(`2001:db8:77:${(Math.floor(i / 10) * 0x100).toString(16)}::${i + 1}`),
    );
  assert.deepEqual(statuses.slice(0, 40), Array(40).fill(409));
  assert.deepEqual(statuses.slice(40), Array(20).fill(429));
  // Another /48 still gets an answer.
  attempt = 0;
  assert.equal(await check('2001:db8:78:100::1'), 409);
});

test('sign-in attempts count the IPv6 /56 and /48 as well as the /64', async (t) => {
  const app = await createApp({
    dataDir: 'memory://',
    startWorkers: false,
    limits: { apiRequestsPerMinute: 100_000 },
  });
  t.after(() => app.close());
  // Three accounts, so the per-account-and-address attempt budget is never what refuses.
  const accounts = [1, 2, 3].map((n) => ({
    name: `Scoped sign-in owner ${n}`,
    password: 'Synthetic signup password',
  }));
  for (const account of accounts) {
    const created = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      remoteAddress: '198.51.100.90',
      headers: local,
      payload: JSON.stringify(account),
    });
    assert.equal(created.statusCode, 201, created.body);
  }
  let attempts = 0;
  const login = async (remoteAddress: string) =>
    (
      await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        remoteAddress,
        headers: local,
        payload: JSON.stringify(accounts[attempts++ % accounts.length]),
      })
    ).statusCode;
  // Each /64 keeps its own 20; two /64s of one /56 together use up the /56 (twice that)...
  for (const prefix of ['2001:db8:9:100', '2001:db8:9:101'])
    for (let i = 0; i < 20; i++) assert.equal(await login(`${prefix}::${i + 1}`), 200);
  assert.equal(await login('2001:db8:9:101::99'), 429);
  // ...so a third /64 of it is refused, while another /56 of the same /48 is not.
  assert.equal(await login('2001:db8:9:1ff::1'), 429);
  assert.equal(await login('2001:db8:9:200::1'), 200);
  // IPv4 keeps the single address.
  for (let host = 1; host <= 3; host++) assert.equal(await login(`198.51.100.${host}`), 200);
});
