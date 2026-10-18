import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/app.js';
import { elricEligibility, elricEligibilityRefusal } from '../server/elric/access.js';
import { BIRTHDAY_SCOPE, PEOPLE_BIRTHDAYS_URL } from '../server/google/age.js';
import {
  FAKE_CLIENT_ID,
  FAKE_CLIENT_SECRET,
  claimsFor,
  fakeGoogle,
  signIdToken,
  type FakePeople,
  type FakeGoogle,
} from './fake-google.js';

/**
 * Sign in with Google and the verified identity link, end to end through the HTTP routes with a
 * fake Google (tests/fake-google.ts; docs/GOOGLE_SIGNIN.md): link, Elric eligibility, sign-in,
 * one subject per account, unlink, single-use flows bound to the browser, and fixed redirects.
 */
type App = Awaited<ReturnType<typeof createApp>>;
const jsonHeaders = { 'content-type': 'application/json', 'x-city-request': '1' };
const ENV = {
  CITY_GOOGLE_SIGNIN: '1',
  GOOGLE_OAUTH_CLIENT_ID: FAKE_CLIENT_ID,
  GOOGLE_OAUTH_CLIENT_SECRET: FAKE_CLIENT_SECRET,
};

async function fixture(
  t: { after: (fn: () => Promise<unknown>) => void },
  env: Record<string, string> = ENV,
) {
  const google = fakeGoogle();
  const clock = { now: Date.now() };
  const app = await createApp({
    dataDir: ':memory:',
    startWorkers: false,
    now: () => clock.now,
    google: { env, transport: google.transport },
  });
  t.after(() => app.close());
  return { app, google, clock };
}
let counter = 0;
async function person(app: App, name = `Google person ${++counter}`) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    headers: jsonHeaders,
    payload: JSON.stringify({ name, password: 'Synthetic google password' }),
    remoteAddress: `198.51.100.${counter % 250}`,
  });
  assert.equal(res.statusCode, 201, res.body);
  const cookie = `cc_session=${res.cookies.find((item) => item.name === 'cc_session')!.value}`;
  return { id: res.json().operator.id as string, cookie, name };
}
/** Signs in again (sessions idle out after 24 hours). */
async function signIn(app: App, who: { name: string; cookie: string }) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: jsonHeaders,
    payload: JSON.stringify({ name: who.name, password: 'Synthetic google password' }),
  });
  assert.equal(res.statusCode, 200, res.body);
  who.cookie = `cc_session=${res.cookies.find((item) => item.name === 'cc_session')!.value}`;
}
async function start(app: App, intent: 'signin' | 'link', cookie?: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/google/start',
    headers: { ...jsonHeaders, ...(cookie ? { cookie } : {}) },
    payload: JSON.stringify({ intent }),
  });
  if (res.statusCode !== 200) return { res, binder: '', params: new URLSearchParams() };
  const binder = res.cookies.find((item) => item.name === 'cc_google_flow')!;
  const params = new URL(res.json().url).searchParams;
  return { res, binder: binder.value, cookieAttributes: binder, params };
}
/** Google's side: the person approves, Google redirects back with a code for this token. */
async function callback(
  f: { app: App; google: FakeGoogle; clock: { now: number } },
  flow: { binder: string; params: URLSearchParams },
  claims: Record<string, unknown> = {},
  options: { binder?: string | null; query?: Record<string, string>; people?: FakePeople } = {},
) {
  const token = signIdToken(
    f.google.keys[0]!,
    claimsFor(flow.params.get('nonce')!, f.clock.now, claims),
  );
  const code = f.google.issueCode(token, flow.params.get('code_challenge')!, options.people);
  const query = new URLSearchParams(
    options.query ?? { state: flow.params.get('state')!, code },
  ).toString();
  const binder = options.binder === undefined ? flow.binder : options.binder;
  const res = await f.app.inject({
    method: 'GET',
    url: `/api/auth/google/callback?${query}`,
    headers: binder === null ? {} : { cookie: `cc_google_flow=${binder}` },
  });
  return { res, location: res.headers.location as string | undefined, code, token };
}
async function linkInfo(app: App, cookie?: string) {
  const res = await app.inject({
    method: 'GET',
    url: '/api/auth/google',
    headers: cookie ? { cookie } : {},
  });
  assert.equal(res.statusCode, 200, res.body);
  return res.json() as { enabled: boolean; linked: null | { email: string; hd: string | null } };
}
/** POST /api/elric/age (the owner's date of birth). */
function enterAge(app: App, cookie: string, date: string) {
  return app.inject({
    method: 'POST',
    url: '/api/elric/age',
    headers: { ...jsonHeaders, cookie },
    payload: JSON.stringify({ date_of_birth: date }),
  });
}

test('off by default: no routes, and the UI is told it is off', async (t) => {
  const f = await fixture(t, {});
  assert.deepEqual(await linkInfo(f.app), { enabled: false, handle_needed: false, linked: null });
  assert.equal((await start(f.app, 'signin')).res.statusCode, 404);
  const back = await f.app.inject({ method: 'GET', url: '/api/auth/google/callback?state=x' });
  assert.equal(back.statusCode, 404);
  // Flag on but the client is not configured: the same as off.
  const g = await fixture(t, { CITY_GOOGLE_SIGNIN: '1' });
  assert.deepEqual(await linkInfo(g.app), { enabled: false, handle_needed: false, linked: null });
  assert.equal((await start(g.app, 'signin')).res.statusCode, 404);
  const unlinked = await g.app.inject({
    method: 'POST',
    url: '/api/auth/google/unlink',
    headers: jsonHeaders,
    payload: '{}',
  });
  assert.equal(unlinked.statusCode, 404, 'unlink follows the same rule');
});

test('link: PKCE, state and nonce; the link makes the owner Elric-eligible; no token is stored', async (t) => {
  const f = await fixture(t);
  const a = await person(f.app);
  assert.deepEqual(await linkInfo(f.app, a.cookie), {
    enabled: true,
    handle_needed: false,
    linked: null,
  });
  assert.deepEqual(await elricEligibility(f.app.city.db, a.id), {
    eligible: false,
    reason: 'unverified',
  });
  // Linking needs a signed-in person.
  assert.equal((await start(f.app, 'link')).res.statusCode, 401);
  const flow = await start(f.app, 'link', a.cookie);
  assert.equal(flow.res.statusCode, 200, flow.res.body);
  const url = new URL(flow.res.json().url);
  assert.equal(`${url.origin}${url.pathname}`, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(flow.params.get('client_id'), FAKE_CLIENT_ID);
  assert.equal(flow.params.get('response_type'), 'code');
  assert.equal(flow.params.get('scope'), 'openid email profile');
  assert.equal(flow.params.get('include_granted_scopes'), null);
  assert.equal(flow.params.get('code_challenge_method'), 'S256');
  assert.match(flow.params.get('code_challenge')!, /^[A-Za-z0-9_-]{43}$/);
  assert.match(flow.params.get('state')!, /^[A-Za-z0-9_-]{43}$/);
  assert.match(flow.params.get('nonce')!, /^[A-Za-z0-9_-]{43}$/);
  assert.match(
    flow.params.get('redirect_uri')!,
    /^http:\/\/localhost(:\d+)?\/api\/auth\/google\/callback$/,
  );
  assert.equal(flow.cookieAttributes!.httpOnly, true);
  assert.equal(flow.cookieAttributes!.sameSite, 'Lax');
  assert.equal(flow.cookieAttributes!.path, '/api/auth/google/callback');
  // Nothing secret leaves in the URL: no client secret, no verifier.
  assert.ok(!flow.res.json().url.includes(FAKE_CLIENT_SECRET));

  const back = await callback(f, flow);
  assert.equal(back.res.statusCode, 303);
  assert.equal(back.location, '/settings/account?google=linked');
  // The token exchange carried the verifier and the same redirect URI.
  const exchange = new URLSearchParams(f.google.requests.find((r) => r.method === 'POST')!.body);
  assert.equal(exchange.get('redirect_uri'), flow.params.get('redirect_uri'));
  assert.equal(exchange.get('grant_type'), 'authorization_code');

  assert.deepEqual((await linkInfo(f.app, a.cookie)).linked?.email, 'synthetic.person@example.com');
  // Linked, but Elric also needs the 18+ age confirmation (the date of birth).
  assert.deepEqual(await elricEligibility(f.app.city.db, a.id), {
    eligible: false,
    reason: 'age_unknown',
  });
  assert.equal((await enterAge(f.app, a.cookie, '1990-05-17')).statusCode, 200);
  assert.deepEqual(await elricEligibility(f.app.city.db, a.id), {
    eligible: true,
    email: 'synthetic.person@example.com',
  });
  const stored = (
    await f.app.city.db.query<Record<string, unknown>>(
      'SELECT * FROM elric_verified_identities WHERE operator_id=$1',
      [a.id],
    )
  ).rows[0]!;
  assert.deepEqual(Object.keys(stored).sort(), [
    'created_at',
    'email',
    'email_verified',
    'hd',
    'operator_id',
    'provider',
    'subject',
    'verified_at',
  ]);
  assert.equal(stored.subject, '100000000000000000001');
  assert.equal(stored.hd, 'example.com');
  assert.ok(!JSON.stringify(stored).includes('test-access'), 'no Google token stored');
  assert.equal(
    (await f.app.city.db.query('SELECT 1 FROM google_signin_flows')).rows.length,
    0,
    'the flow was consumed',
  );

  // Replaying the same callback (state, code and cookie) does nothing: the flow is single use.
  const replay = await f.app.inject({
    method: 'GET',
    url: `/api/auth/google/callback?${new URLSearchParams({ state: flow.params.get('state')!, code: back.code })}`,
    headers: { cookie: `cc_google_flow=${flow.binder}` },
  });
  assert.equal(replay.headers.location, '/signin?google=expired');
});

test('one Google account per Central City account, and the other way round', async (t) => {
  const f = await fixture(t);
  const a = await person(f.app);
  const b = await person(f.app);
  assert.equal(
    (await callback(f, await start(f.app, 'link', a.cookie))).location,
    '/settings/account?google=linked',
  );
  // The same Google subject for another account: refused, B stays ineligible.
  const taken = await callback(f, await start(f.app, 'link', b.cookie));
  assert.equal(taken.location, '/settings/account?google=linked_elsewhere');
  assert.equal((await elricEligibility(f.app.city.db, b.id)).eligible, false);
  assert.equal((await linkInfo(f.app, b.cookie)).linked, null);
  // A second Google account for A: unlink first.
  const second = await callback(f, await start(f.app, 'link', a.cookie), {
    sub: '100000000000000000002',
    email: 'other.person@example.com',
  });
  assert.equal(second.location, '/settings/account?google=already_linked');
  assert.equal((await linkInfo(f.app, a.cookie)).linked?.email, 'synthetic.person@example.com');
  // Linking the same subject again refreshes it (a Workspace account with its hd).
  const again = await callback(f, await start(f.app, 'link', a.cookie), {
    email: 'synthetic.person@example.com',
  });
  assert.equal(again.location, '/settings/account?google=linked');
});

test('sign-in signs in the linked account (no new account)', async (t) => {
  const f = await fixture(t);
  const a = await person(f.app);
  await callback(f, await start(f.app, 'link', a.cookie));
  const owners = async () =>
    Number(
      (
        await f.app.city.db.query<{ count: string }>(
          "SELECT count(*) FROM operators WHERE kind='owner'",
        )
      ).rows[0]!.count,
    );
  const before = await owners();
  const signedIn = await callback(f, await start(f.app, 'signin'));
  assert.equal(signedIn.location, '/rooms');
  const session = signedIn.res.cookies.find((item) => item.name === 'cc_session')!;
  assert.ok(session.value);
  const who = await f.app.inject({
    method: 'GET',
    url: '/api/session',
    headers: { cookie: `cc_session=${session.value}` },
  });
  assert.equal(who.json().operator.id, a.id);
  assert.equal(await owners(), before);
});

test('unlinking removes the link and Elric eligibility at once', async (t) => {
  const f = await fixture(t);
  const a = await person(f.app);
  await callback(f, await start(f.app, 'link', a.cookie));
  await enterAge(f.app, a.cookie, '1990-05-17');
  assert.equal((await elricEligibility(f.app.city.db, a.id)).eligible, true);
  const signedOut = await f.app.inject({
    method: 'POST',
    url: '/api/auth/google/unlink',
    headers: jsonHeaders,
    payload: '{}',
  });
  assert.equal(signedOut.statusCode, 401);
  const unlinked = await f.app.inject({
    method: 'POST',
    url: '/api/auth/google/unlink',
    headers: { ...jsonHeaders, cookie: a.cookie },
    payload: '{}',
  });
  assert.equal(unlinked.statusCode, 200, unlinked.body);
  assert.deepEqual(await elricEligibility(f.app.city.db, a.id), {
    eligible: false,
    reason: 'unverified',
  });
  assert.equal((await linkInfo(f.app, a.cookie)).linked, null);
  // No longer signs in to A; within 30 days it cannot start a new account either.
  assert.equal(
    (await callback(f, await start(f.app, 'signin'))).location,
    '/signin?google=relink_cooldown',
  );
  // The request protection header is required, like every cookie-authorized POST.
  const unprotected = await f.app.inject({
    method: 'POST',
    url: '/api/auth/google/unlink',
    headers: { 'content-type': 'application/json', cookie: a.cookie },
    payload: '{}',
  });
  assert.equal(unprotected.statusCode, 403);
});

test('a callback completes only in the browser that started it, once and within 10 minutes', async (t) => {
  const f = await fixture(t);
  const a = await person(f.app);
  // Login CSRF: an attacker's flow, delivered to a browser without its binding cookie.
  const stolen = await callback(f, await start(f.app, 'link', a.cookie), {}, { binder: null });
  assert.equal(stolen.location, '/settings/account?google=expired');
  const wrong = await callback(
    f,
    await start(f.app, 'link', a.cookie),
    {},
    {
      binder: 'A'.repeat(43),
    },
  );
  assert.equal(wrong.location, '/settings/account?google=expired');
  assert.equal((await elricEligibility(f.app.city.db, a.id)).eligible, false);
  // Expired flows are refused.
  const late = await start(f.app, 'link', a.cookie);
  f.clock.now += 10 * 60_000 + 1;
  assert.equal((await callback(f, late)).location, '/settings/account?google=expired');
  // A missing or unknown state, too.
  const unknown = await callback(
    f,
    await start(f.app, 'signin'),
    {},
    {
      query: { state: 'B'.repeat(43), code: 'test-code-x' },
    },
  );
  assert.equal(unknown.location, '/signin?google=expired');
});

test('refused tokens: replayed or wrong nonce, unverified email, other domains; Google errors', async (t) => {
  const f = await fixture(t);
  const a = await person(f.app);
  const first = await start(f.app, 'link', a.cookie);
  const second = await start(f.app, 'link', a.cookie);
  // A token minted for the first flow's nonce, replayed into the second flow.
  const replayed = signIdToken(
    f.google.keys[0]!,
    claimsFor(first.params.get('nonce')!, f.clock.now),
  );
  const code = f.google.issueCode(replayed, second.params.get('code_challenge')!);
  const res = await f.app.inject({
    method: 'GET',
    url: `/api/auth/google/callback?${new URLSearchParams({ state: second.params.get('state')!, code })}`,
    headers: { cookie: `cc_google_flow=${second.binder}` },
  });
  assert.equal(res.headers.location, '/settings/account?google=failed');
  const cases: [Record<string, unknown>, string][] = [
    [{ email_verified: false }, 'unverified'],
    [{ email: 'person@example.org', hd: undefined }, 'ineligible'],
    [{ aud: 'another-client.apps.googleusercontent.com' }, 'failed'],
    [{ iss: 'https://accounts.example.com' }, 'failed'],
    [{ exp: Math.floor(f.clock.now / 1000) - 3600 }, 'failed'],
  ];
  for (const [claims, outcome] of cases)
    assert.equal(
      (await callback(f, await start(f.app, 'link', a.cookie), claims)).location,
      `/settings/account?google=${outcome}`,
      JSON.stringify(claims),
    );
  // The person cancelled at Google.
  const cancelled = await start(f.app, 'link', a.cookie);
  const back = await callback(
    f,
    cancelled,
    {},
    {
      query: { state: cancelled.params.get('state')!, error: 'access_denied' },
    },
  );
  assert.equal(back.location, '/settings/account?google=cancelled');
  assert.equal((await elricEligibility(f.app.city.db, a.id)).eligible, false);
  // A Google Workspace account links, with its domain.
  const workspace = await callback(f, await start(f.app, 'link', a.cookie), {
    email: 'person@example.org',
    hd: 'example.org',
  });
  assert.equal(workspace.location, '/settings/account?google=linked');
  assert.deepEqual((await linkInfo(f.app, a.cookie)).linked?.hd, 'example.org');
});

test('redirects are fixed by the server; extra parameters cannot steer them', async (t) => {
  const f = await fixture(t);
  const flow = await start(f.app, 'signin');
  const back = await callback(
    f,
    flow,
    {},
    {
      query: {
        state: flow.params.get('state')!,
        code: 'test-code-unknown',
        next: 'https://attacker.example/',
        redirect_uri: 'https://attacker.example/',
      },
    },
  );
  assert.equal(back.location, '/signin?google=failed');
});

test('starting is rate limited per client address', async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 20; i += 1) assert.equal((await start(f.app, 'signin')).res.statusCode, 200);
  const limited = (await start(f.app, 'signin')).res;
  assert.equal(limited.statusCode, 429);
  assert.equal(limited.json().code, 'rate_limited');
  // Retry-After says when to try again (seconds, at most the window).
  const retry = Number(limited.headers['retry-after']);
  assert.ok(retry >= 1 && retry <= 3600, String(limited.headers['retry-after']));
});

test('a test server can set its own per-address budgets (createApp options only)', async (t) => {
  const google = fakeGoogle();
  const app = await createApp({
    dataDir: ':memory:',
    startWorkers: false,
    google: {
      env: ENV,
      transport: google.transport,
      addressLimits: { startsPerAddress: 2, callbacksPerAddress: 2 },
    },
  });
  t.after(() => app.close());
  for (let i = 0; i < 2; i += 1) assert.equal((await start(app, 'signin')).res.statusCode, 200);
  const limited = (await start(app, 'signin')).res;
  assert.equal(limited.statusCode, 429);
  assert.equal(limited.json().code, 'rate_limited');
});

test('the date of birth routes say when to retry once rate limited', async (t) => {
  const f = await fixture(t);
  const a = await person(f.app);
  await callback(f, await start(f.app, 'link', a.cookie));
  let res = await enterAge(f.app, a.cookie, '1990-05-17');
  for (let i = 0; i < 20 && res.statusCode !== 429; i += 1)
    res = await enterAge(f.app, a.cookie, '1990-05-17');
  assert.equal(res.statusCode, 429);
  assert.ok(Number(res.headers['retry-after']) >= 1);
});

/** A full birthday `years` years before the UTC date of `now`, shifted by `days`. */
function birthday(now: number, years: number, days = 0) {
  const today = new Date(now);
  const date = new Date(
    Date.UTC(today.getUTCFullYear() - years, today.getUTCMonth(), today.getUTCDate() + days),
  );
  return {
    birthdays: [
      {
        date: {
          year: date.getUTCFullYear(),
          month: date.getUTCMonth() + 1,
          day: date.getUTCDate(),
        },
      },
    ],
  };
}

const BIRTHDAY_ENV = { ...ENV, CITY_GOOGLE_BIRTHDAY_SCOPE: '1' };

test('age confirmation: the birthday scope is off by default; with its flag only the link asks', async (t) => {
  const off = await fixture(t);
  const a = await person(off.app);
  for (const flow of [await start(off.app, 'link', a.cookie), await start(off.app, 'signin')]) {
    assert.equal(flow.params.get('scope'), 'openid email profile');
    assert.equal(flow.params.get('include_granted_scopes'), null);
  }
  // Off: the link never calls the People API.
  await callback(off, await start(off.app, 'link', a.cookie));
  assert.ok(!off.google.requests.some((request) => request.url === PEOPLE_BIRTHDAYS_URL));
  const on = await fixture(t, BIRTHDAY_ENV);
  const b = await person(on.app);
  const link = await start(on.app, 'link', b.cookie);
  assert.equal(link.params.get('scope'), `openid email profile ${BIRTHDAY_SCOPE}`);
  assert.equal(link.params.get('include_granted_scopes'), 'true');
  assert.equal((await start(on.app, 'signin')).params.get('scope'), 'openid email profile');
});

test('age confirmation (birthday flag on): adult, 17 (locked), the exact 18th birthday', async (t) => {
  const f = await fixture(t, BIRTHDAY_ENV);
  const link = async (who: { cookie: string }, people: FakePeople, sub: string) =>
    callback(f, await start(f.app, 'link', who.cookie), { sub }, { people });
  const adult = await person(f.app);
  assert.equal(
    (await link(adult, { body: birthday(f.clock.now, 40) }, '100000000000000000011')).location,
    '/settings/account?google=linked',
  );
  assert.equal((await elricEligibility(f.app.city.db, adult.id)).eligible, true);
  // 17 (the 18th birthday is tomorrow): linked, locked for Elric.
  const minor = await person(f.app);
  assert.equal(
    (await link(minor, { body: birthday(f.clock.now, 18, 1) }, '100000000000000000012')).location,
    '/settings/account?google=elric_age_under_18',
  );
  assert.deepEqual(await elricEligibility(f.app.city.db, minor.id), {
    eligible: false,
    reason: 'age_under_18',
  });
  assert.equal(elricEligibilityRefusal('age_under_18').code, 'elric_age_under_18');
  // The lock holds: a re-link with an adult birthday does not lift it.
  assert.equal(
    (await link(minor, { body: birthday(f.clock.now, 30) }, '100000000000000000012')).location,
    '/settings/account?google=elric_age_under_18',
  );
  assert.equal((await elricEligibility(f.app.city.db, minor.id)).eligible, false);
  // The exact 18th birthday (UTC) counts.
  const today = await person(f.app);
  assert.equal(
    (await link(today, { body: birthday(f.clock.now, 18) }, '100000000000000000013')).location,
    '/settings/account?google=linked',
  );
  assert.equal((await elricEligibility(f.app.city.db, today.id)).eligible, true);
});

test('age confirmation (birthday flag on): missing year, hidden birthday or an API error is unknown', async (t) => {
  const f = await fixture(t, BIRTHDAY_ENV);
  const a = await person(f.app);
  const cases: [string, FakePeople][] = [
    ['missing year', { body: { birthdays: [{ date: { month: 5, day: 17 } }] } }],
    ['missing day', { body: { birthdays: [{ date: { year: 1990, month: 5 } }] } }],
    ['hidden', { body: {} }],
    ['empty', { body: { birthdays: [] } }],
    [
      'disagreeing dates',
      {
        body: {
          birthdays: [
            { date: { year: 1990, month: 5, day: 17 } },
            { date: { year: 2015, month: 5, day: 17 } },
          ],
        },
      },
    ],
    ['People API 403', { status: 403, body: { error: { code: 403 } } }],
    ['People API 500', { status: 500 }],
  ];
  for (const [name, people] of cases) {
    const back = await callback(f, await start(f.app, 'link', a.cookie), {}, { people });
    assert.equal(back.location, '/settings/account?google=elric_age_unknown', name);
    assert.deepEqual(
      await elricEligibility(f.app.city.db, a.id),
      { eligible: false, reason: 'age_unknown' },
      name,
    );
  }
  assert.equal(elricEligibilityRefusal('age_unknown').code, 'elric_age_unknown');
});

test('age confirmation (birthday flag on): the token is never stored; the date only encrypted', async (t) => {
  const f = await fixture(t, BIRTHDAY_ENV);
  const a = await person(f.app);
  const lines: string[] = [];
  const original = {
    log: console.log,
    warn: console.warn,
    error: console.error,
    info: console.info,
  };
  for (const method of ['log', 'warn', 'error', 'info'] as const)
    console[method] = (...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    };
  let back;
  try {
    back = await callback(
      f,
      await start(f.app, 'link', a.cookie),
      {},
      {
        people: { body: { birthdays: [{ date: { year: 1987, month: 11, day: 23 } }] } },
      },
    );
  } finally {
    Object.assign(console, original);
  }
  assert.equal(back.location, '/settings/account?google=linked');
  const token = f.google.requests
    .find((request) => request.url === PEOPLE_BIRTHDAYS_URL)!
    .headers.authorization!.replace(/^Bearer /, '');
  const tables = ['elric_verified_identities', 'elric_age_checks', 'google_signin_flows'];
  const dump = (
    await Promise.all(
      tables.map(async (table) =>
        JSON.stringify((await f.app.city.db.query(`SELECT * FROM ${table}`)).rows, (_k, v) =>
          v instanceof Uint8Array ? Buffer.from(v).toString('latin1') : v,
        ),
      ),
    )
  ).join('\n');
  const info = JSON.stringify(await linkInfo(f.app, a.cookie));
  for (const text of [dump, info, back.location ?? '', lines.join('\n')]) {
    assert.ok(!text.includes(token), 'no access token');
    assert.ok(!BIRTH_DATE.test(text), 'no plaintext birth date');
  }
});

/**
 * 23 Nov 1987 written as a date, in any common form, but not the same digits inside an id, a hash,
 * a millisecond timestamp or today's ISO date (on 23 November, created_at holds "-11-23").
 */
const BIRTH_DATE =
  /(?<![0-9a-z])(?:1987|19871123)(?![0-9a-z])|(?<![0-9a-z-])11-23(?![0-9a-z])|(?<![0-9a-z.])23\.11(?![0-9a-z])|(?<![0-9a-z/])11\/23(?![0-9a-z])/i;

test('the birth-date scan finds the date, not the same digits elsewhere', () => {
  for (const text of ['1987-11-23', '23.11.1987', '11/23/1987', '19871123', '{"year":1987}'])
    assert.ok(BIRTH_DATE.test(text), text);
  for (const text of [
    'b7e1987c-0f2a-4c1e-9d11-23ab45cd67ef',
    '"at":1791987123456',
    '2026-11-23T10:00:00.000Z',
    '9f1987aa11-23ee',
  ])
    assert.ok(!BIRTH_DATE.test(text), text);
});

test('relink cooldown: an unlinked Google account cannot move to another account for 30 days', async (t) => {
  const f = await fixture(t);
  const a = await person(f.app);
  const b = await person(f.app);
  const unlink = (cookie: string) =>
    f.app.inject({
      method: 'POST',
      url: '/api/auth/google/unlink',
      headers: { ...jsonHeaders, cookie },
      payload: '{}',
    });
  const link = async (cookie: string) =>
    (await callback(f, await start(f.app, 'link', cookie))).location;
  assert.equal(await link(a.cookie), '/settings/account?google=linked');
  assert.equal((await unlink(a.cookie)).statusCode, 200);
  // Only a keyed hash of the subject is kept, with the account and the time.
  const [row] = (
    await f.app.city.db.query<Record<string, unknown>>('SELECT * FROM google_link_cooldowns')
  ).rows;
  assert.deepEqual(Object.keys(row!).sort(), ['operator_id', 'released_at', 'subject_hash']);
  assert.match(String(row!.subject_hash), /^[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(row).includes('100000000000000000001'));
  assert.ok(!JSON.stringify(row).includes('example.com'));
  // A → B within 30 days: refused, B stays without a link, and B's birthday is never read.
  f.clock.now += 29 * 24 * 3_600_000;
  await signIn(f.app, a);
  await signIn(f.app, b);
  const peopleCalls = () =>
    f.google.requests.filter((request) => request.url === PEOPLE_BIRTHDAYS_URL).length;
  const before = peopleCalls();
  assert.equal(await link(b.cookie), '/settings/account?google=relink_cooldown');
  assert.equal(peopleCalls(), before, 'no birthday read for a refused link');
  assert.equal((await linkInfo(f.app, b.cookie)).linked, null);
  // A → A is fine (and clears the cooldown).
  assert.equal(await link(a.cookie), '/settings/account?google=linked');
  assert.equal((await f.app.city.db.query('SELECT 1 FROM google_link_cooldowns')).rows.length, 0);
  // After 30 days the Google account may move.
  await unlink(a.cookie);
  f.clock.now += 30 * 24 * 3_600_000 + 1;
  await signIn(f.app, b);
  assert.equal(await link(b.cookie), '/settings/account?google=linked');
  await enterAge(f.app, b.cookie, '1990-05-17');
  assert.equal((await elricEligibility(f.app.city.db, b.id)).eligible, true);
  assert.equal((await f.app.city.db.query('SELECT 1 FROM google_link_cooldowns')).rows.length, 0);
});

/** The session cookie a redirect set, or undefined. */
const sessionOf = (res: { cookies: { name: string; value: string }[] }) => {
  const value = res.cookies.find((item) => item.name === 'cc_session' && item.value)?.value;
  return value ? `cc_session=${value}` : undefined;
};
const ownerCount = async (app: App) =>
  Number(
    (
      await app.city.db.query<{ count: string }>(
        "SELECT count(*) FROM operators WHERE kind='owner'",
      )
    ).rows[0]!.count,
  );

test('sign-up with Google: an unknown verified Google account gets a new account, link and session', async (t) => {
  const f = await fixture(t);
  const before = await ownerCount(f.app);
  const created = await callback(f, await start(f.app, 'signin'), {
    sub: '100000000000000000031',
    email: 'new.person@example.com',
  });
  assert.equal(created.location, '/settings/account?google=welcome');
  const cookie = sessionOf(created.res);
  assert.ok(cookie, 'signed in');
  assert.equal(await ownerCount(f.app), before + 1);
  const info = (
    await f.app.inject({ method: 'GET', url: '/api/auth/google', headers: { cookie } })
  ).json();
  assert.equal(info.handle_needed, true);
  assert.equal(info.linked.email, 'new.person@example.com');
  // No password: the account cannot sign in with one, and Google stays its only way in.
  const [row] = (
    await f.app.city.db.query<{ id: string; password_hash: string; salt: string; name: string }>(
      "SELECT o.id,o.password_hash,o.salt,o.name FROM operators o JOIN elric_verified_identities v ON v.operator_id=o.id WHERE v.subject='100000000000000000031'",
    )
  ).rows;
  // A random hash no password produces, and the reserved salt (the backup format stays valid).
  assert.match(row!.password_hash, /^[a-f0-9]{128}$/);
  const login = await f.app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: jsonHeaders,
    payload: JSON.stringify({ name: row!.name, password: 'Synthetic google password' }),
  });
  assert.equal(login.statusCode, 401);
  const unlink = await f.app.inject({
    method: 'POST',
    url: '/api/auth/google/unlink',
    headers: { ...jsonHeaders, cookie },
    payload: '{}',
  });
  // In onboarding, unlinking is refused like every other route.
  assert.equal(unlink.statusCode, 403);
  assert.equal(unlink.json().code, 'onboarding_required');
  // The account name: rules as for sign-up; a taken name is refused; chosen once.
  const handle = (name: string) =>
    f.app.inject({
      method: 'POST',
      url: '/api/auth/google/handle',
      headers: { ...jsonHeaders, cookie },
      payload: JSON.stringify({ name }),
    });
  const other = await person(f.app, 'Taken Name');
  assert.ok(other.id);
  assert.equal((await handle('x')).statusCode, 400);
  assert.equal((await handle('taken name')).statusCode, 409);
  const saved = await handle('Ada Google');
  assert.equal(saved.statusCode, 200, saved.body);
  assert.equal(saved.json().operator.name, 'Ada Google');
  assert.equal((await handle('Another Name')).statusCode, 409);
  const after = (
    await f.app.inject({ method: 'GET', url: '/api/auth/google', headers: { cookie } })
  ).json();
  assert.equal(after.handle_needed, false);
  // After accepting the Terms: unlinking stays refused (Google is its only way in).
  const { TERMS_VERSION } = await import('../shared/terms.js');
  const accepted = await f.app.inject({
    method: 'POST',
    url: '/api/auth/onboarding',
    headers: { ...jsonHeaders, cookie },
    payload: JSON.stringify({ terms_version: TERMS_VERSION, accept_terms: true }),
  });
  assert.equal(accepted.statusCode, 200, accepted.body);
  const unlinkAfter = await f.app.inject({
    method: 'POST',
    url: '/api/auth/google/unlink',
    headers: { ...jsonHeaders, cookie },
    payload: '{}',
  });
  assert.equal(unlinkAfter.statusCode, 409);
  // The next Continue with Google signs in to the same account (no second account).
  const again = await callback(f, await start(f.app, 'signin'), {
    sub: '100000000000000000031',
    email: 'new.person@example.com',
  });
  assert.equal(again.location, '/rooms');
  assert.equal(await ownerCount(f.app), before + 2);
  // Unverified emails never create an account.
  const unverified = await callback(f, await start(f.app, 'signin'), {
    sub: '100000000000000000032',
    email: 'unverified.person@example.com',
    email_verified: false,
  });
  assert.equal(unverified.location, '/signin?google=unverified');
  assert.equal(await ownerCount(f.app), before + 2);
});

test('sign-up with Google: an email already on another account is not merged', async (t) => {
  const f = await fixture(t);
  const a = await person(f.app);
  await callback(f, await start(f.app, 'link', a.cookie));
  const before = await ownerCount(f.app);
  // Another Google subject with the same address (any case): refused, nothing created.
  const clash = await callback(f, await start(f.app, 'signin'), {
    sub: '100000000000000000041',
    email: 'Synthetic.Person@example.com',
  });
  assert.equal(clash.location, '/signin?google=email_exists');
  assert.equal(sessionOf(clash.res), undefined);
  assert.equal(await ownerCount(f.app), before);
});

test('sign-up with Google: the 30-day cooldown and the under-18 lock carry over', async (t) => {
  const f = await fixture(t);
  const a = await person(f.app);
  await callback(f, await start(f.app, 'link', a.cookie));
  // Under 18: the Google account itself is locked for Elric.
  assert.equal((await enterAge(f.app, a.cookie, '2015-01-01')).statusCode, 403);
  const unlinked = await f.app.inject({
    method: 'POST',
    url: '/api/auth/google/unlink',
    headers: { ...jsonHeaders, cookie: a.cookie },
    payload: '{}',
  });
  assert.equal(unlinked.statusCode, 200);
  const before = await ownerCount(f.app);
  // Within 30 days: no new account.
  f.clock.now += 29 * 24 * 3_600_000;
  const cooling = await callback(f, await start(f.app, 'signin'));
  assert.equal(cooling.location, '/signin?google=relink_cooldown');
  assert.equal(await ownerCount(f.app), before);
  // After 30 days: a new account, still locked for Elric.
  f.clock.now += 24 * 3_600_000 + 1;
  const created = await callback(f, await start(f.app, 'signin'));
  assert.equal(created.location, '/settings/account?google=welcome');
  const cookie = sessionOf(created.res)!;
  const { TERMS_VERSION } = await import('../shared/terms.js');
  const onboarded = await f.app.inject({
    method: 'POST',
    url: '/api/auth/onboarding',
    headers: { ...jsonHeaders, cookie },
    payload: JSON.stringify({
      name: 'Locked Google',
      terms_version: TERMS_VERSION,
      accept_terms: true,
    }),
  });
  assert.equal(onboarded.statusCode, 200, onboarded.body);
  const refused = await enterAge(f.app, cookie, '1990-05-17');
  assert.equal(refused.statusCode, 403);
  assert.equal(refused.json().code, 'elric_age_under_18');
  const info = (
    await f.app.inject({ method: 'GET', url: '/api/auth/google', headers: { cookie } })
  ).json();
  assert.equal(info.linked.age_check, 'under_18');
});

test('sign-up with Google uses the password sign-up budget per address', async (t) => {
  const f = await fixture(t);
  const before = await ownerCount(f.app);
  const outcomes: string[] = [];
  for (let i = 0; i < 12; i++) {
    const sub = String(100000000000000000050n + BigInt(i));
    const res = await callback(f, await start(f.app, 'signin'), {
      sub,
      email: `cap.${sub}@example.com`,
    });
    outcomes.push(res.location!);
  }
  const created = outcomes.filter((item) => item.endsWith('google=welcome')).length;
  assert.ok(created >= 1 && created < 12, outcomes.join(' '));
  assert.ok(outcomes.includes('/signin?google=signup_limited'), outcomes.join(' '));
  assert.equal(await ownerCount(f.app), before + created);
});

test('return path: only allowlisted same-origin paths, never an open redirect', async (t) => {
  const { safeReturnPath } = await import('../shared/return-path.js');
  for (const ok of [
    '/elric',
    '/elric/',
    '/rooms',
    '/settings/account',
    '/rooms/abc-123',
    '/feed',
    '/feed/requests',
    '/feed/requests/req_abcdefghijklmnopqrst',
    '/feed/services/svc_abcdefghijklmnopqrst',
  ])
    assert.ok(safeReturnPath(ok), ok);
  for (const bad of [
    'https://evil.example/elric',
    '//evil.example/elric',
    '/\\evil.example',
    'javascript:alert(1)',
    '/elric?x=1',
    '/elric#x',
    '/elric/../admin',
    '/api/auth/logout',
    '/rooms/a/b',
    '/feed/requests/req_abcdefghijklmnopqrst/manage',
    '/feed/services',
    '/feed/offered',
    'elric',
    '',
    undefined,
  ])
    assert.equal(safeReturnPath(bad), null, String(bad));

  const f = await fixture(t);
  const a = await person(f.app);
  await callback(f, await start(f.app, 'link', a.cookie));
  /** Starts sign-in with `next`, completes it, and returns where it redirected. */
  const via = async (next: string, cookieNext?: string) => {
    const res = await f.app.inject({
      method: 'POST',
      url: '/api/auth/google/start',
      headers: jsonHeaders,
      payload: JSON.stringify({ intent: 'signin', next }),
    });
    assert.equal(res.statusCode, 200, res.body);
    const binder = res.cookies.find((item) => item.name === 'cc_google_flow')!.value;
    const stored = res.cookies.find((item) => item.name === 'cc_google_next');
    const params = new URL(res.json().url).searchParams;
    const token = signIdToken(f.google.keys[0]!, claimsFor(params.get('nonce')!, f.clock.now));
    const code = f.google.issueCode(token, params.get('code_challenge')!);
    const value = cookieNext ?? (stored?.value || '');
    const back = await f.app.inject({
      method: 'GET',
      url: `/api/auth/google/callback?${new URLSearchParams({ state: params.get('state')!, code })}`,
      headers: {
        cookie: `cc_google_flow=${binder}${value ? `; cc_google_next=${encodeURIComponent(value)}` : ''}`,
      },
    });
    return { location: back.headers.location, stored: stored?.value };
  };
  assert.equal((await via('/elric')).location, '/elric');
  const external = await via('https://evil.example/');
  assert.equal(external.stored ?? '', '', 'an external URL is never stored');
  assert.equal(external.location, '/rooms');
  assert.equal((await via('//evil.example')).location, '/rooms');
  // A tampered cookie is checked again at the callback.
  assert.equal((await via('/elric', 'https://evil.example/')).location, '/rooms');
  assert.equal((await via('/elric', '/rooms/room-1')).location, '/rooms/room-1');
  // A new account keeps the return path for after it chooses its name.
  const res = await f.app.inject({
    method: 'POST',
    url: '/api/auth/google/start',
    headers: jsonHeaders,
    payload: JSON.stringify({ intent: 'signin', next: '/elric' }),
  });
  const params = new URL(res.json().url).searchParams;
  const token = signIdToken(
    f.google.keys[0]!,
    claimsFor(params.get('nonce')!, f.clock.now, {
      sub: '100000000000000000099',
      email: 'return.path@example.com',
    }),
  );
  const code = f.google.issueCode(token, params.get('code_challenge')!);
  const created = await f.app.inject({
    method: 'GET',
    url: `/api/auth/google/callback?${new URLSearchParams({ state: params.get('state')!, code })}`,
    headers: {
      cookie: `cc_google_flow=${res.cookies.find((item) => item.name === 'cc_google_flow')!.value}; cc_google_next=${res.cookies.find((item) => item.name === 'cc_google_next')!.value}`,
    },
  });
  assert.equal(created.headers.location, '/settings/account?google=welcome&next=%2Felric');
});

test('onboarding gate: a new Google account can only finish onboarding until it accepts', async (t) => {
  const { TERMS_VERSION } = await import('../shared/terms.js');
  const f = await fixture(t);
  const created = await callback(f, await start(f.app, 'signin'), {
    sub: '100000000000000000111',
    email: 'gate.person@example.com',
  });
  assert.equal(created.location, '/settings/account?google=welcome');
  const session = created.res.cookies.find((item) => item.name === 'cc_session')!.value;
  const cookie = `cc_session=${session}`;
  const get = (url: string) => f.app.inject({ method: 'GET', url, headers: { cookie } });
  const post = (url: string, body: unknown) =>
    f.app.inject({
      method: 'POST',
      url,
      headers: { ...jsonHeaders, cookie },
      payload: JSON.stringify(body),
    });
  const me = (await get('/api/session')).json();
  assert.equal(me.operator !== null, true);
  assert.deepEqual(me.onboarding, {
    required: true,
    name_needed: true,
    terms_needed: true,
    terms_version: TERMS_VERSION,
    newsletter_available: true,
  });
  // "Back" to the app: every other API refuses (rooms, workspace, Elric, agents).
  for (const url of ['/api/snapshot', '/api/rooms', '/api/elric/age']) {
    const res = await get(url);
    assert.equal(res.statusCode, 403, url);
    assert.equal(res.json().code, 'onboarding_required', url);
  }
  const agent = await post('/api/agents', {
    name: 'Gated agent',
    description: '',
    mode: 'external',
    capability: 'extract',
  });
  assert.equal(agent.statusCode, 403);
  // A name alone does not lift the gate; nor does a wrong version or a missing name.
  assert.equal(
    (await post('/api/auth/onboarding', { terms_version: TERMS_VERSION, accept_terms: true }))
      .statusCode,
    400,
  );
  const outdated = await post('/api/auth/onboarding', {
    name: 'Gate Person',
    terms_version: '2000-01-01',
    accept_terms: true,
  });
  assert.equal(outdated.statusCode, 409);
  assert.equal(outdated.json().code, 'terms_version_outdated');
  assert.equal(
    (
      await post('/api/auth/onboarding', {
        name: 'Gate Person',
        terms_version: TERMS_VERSION,
        accept_terms: false,
      })
    ).statusCode,
    400,
  );
  assert.equal((await post('/api/auth/google/handle', { name: 'Gate Person' })).statusCode, 200);
  assert.equal((await get('/api/snapshot')).statusCode, 403);
  // Accept: full access, and the version and time are recorded.
  const done = await post('/api/auth/onboarding', {
    terms_version: TERMS_VERSION,
    accept_terms: true,
  });
  assert.equal(done.statusCode, 200, done.body);
  assert.equal(done.json().onboarding.required, false);
  assert.equal((await get('/api/snapshot')).statusCode, 200);
  const [row] = (
    await f.app.city.db.query<{ version: string; accepted_at: string }>(
      'SELECT version,accepted_at FROM account_terms_acceptances',
    )
  ).rows;
  assert.equal(row!.version, TERMS_VERSION);
  assert.ok(Number(row!.accepted_at) > 0);
  // A newer Terms version (or an older acceptance) asks again.
  await f.app.city.db.query("UPDATE account_terms_acceptances SET version='2000-01-01'");
  assert.equal((await get('/api/snapshot')).json().code, 'onboarding_required');
  assert.deepEqual(
    { ...(await get('/api/session')).json().onboarding, terms_version: undefined },
    {
      required: true,
      name_needed: false,
      terms_needed: true,
      terms_version: undefined,
      newsletter_available: true,
    },
  );
  // An existing Google account without any recorded acceptance is gated too.
  await f.app.city.db.query('DELETE FROM account_terms_acceptances');
  assert.equal((await get('/api/snapshot')).statusCode, 403);
  // Password accounts accept at sign-up and are never gated.
  const a = await person(f.app);
  assert.equal(
    (await f.app.inject({ method: 'GET', url: '/api/snapshot', headers: { cookie: a.cookie } }))
      .statusCode,
    200,
  );
});

test('onboarding gate: an existing account signed in with Google needs a recorded acceptance too', async (t) => {
  const { TERMS_VERSION } = await import('../shared/terms.js');
  const f = await fixture(t);
  // A new password account records its acceptance at sign-up (the form states it).
  const a = await person(f.app);
  const recorded = (
    await f.app.city.db.query<{ version: string }>(
      'SELECT version FROM account_terms_acceptances WHERE operator_id=$1',
      [a.id],
    )
  ).rows[0];
  assert.equal(recorded?.version, TERMS_VERSION);
  // An account from before acceptances were recorded, with Google linked (the reported case:
  // "Continue with Google" signs in to it, no name step, and it went straight in).
  await callback(f, await start(f.app, 'link', a.cookie));
  await f.app.city.db.query('DELETE FROM account_terms_acceptances WHERE operator_id=$1', [a.id]);
  const signedIn = await callback(f, await start(f.app, 'signin'));
  assert.equal(signedIn.location, '/rooms');
  const cookie = `cc_session=${signedIn.res.cookies.find((item) => item.name === 'cc_session')!.value}`;
  const session = (
    await f.app.inject({ method: 'GET', url: '/api/session', headers: { cookie } })
  ).json();
  assert.deepEqual(session.onboarding, {
    required: true,
    name_needed: false,
    terms_needed: true,
    terms_version: TERMS_VERSION,
    newsletter_available: true,
  });
  const room = await f.app.inject({
    method: 'POST',
    url: '/api/rooms',
    headers: { ...jsonHeaders, cookie },
    payload: JSON.stringify({ name: 'Should not exist yet' }),
  });
  assert.equal(room.statusCode, 403, room.body);
  assert.equal(room.json().code, 'onboarding_required');
  // Accepting (no name step: it has one) opens the account.
  const accepted = await f.app.inject({
    method: 'POST',
    url: '/api/auth/onboarding',
    headers: { ...jsonHeaders, cookie },
    payload: JSON.stringify({ terms_version: TERMS_VERSION, accept_terms: true }),
  });
  assert.equal(accepted.statusCode, 200, accepted.body);
  assert.equal(
    (await f.app.inject({ method: 'GET', url: '/api/rooms', headers: { cookie } })).statusCode,
    200,
  );
  // A password account without Google is not gated (it accepted at sign-up).
  const b = await person(f.app);
  await f.app.city.db.query('DELETE FROM account_terms_acceptances WHERE operator_id=$1', [b.id]);
  assert.equal(
    (await f.app.inject({ method: 'GET', url: '/api/rooms', headers: { cookie: b.cookie } }))
      .statusCode,
    200,
  );
});

test('a name claimed concurrently during Google onboarding is a 409, not a server error', async (t) => {
  const f = await fixture(t);
  const created = await callback(f, await start(f.app, 'signin'), {
    sub: '100000000000000000041',
    email: 'raced.person@example.com',
  });
  const cookie = sessionOf(created.res);
  assert.ok(cookie, 'signed in');
  await person(f.app, 'Raced Name');
  // The race: the other claim commits after the availability check, so the check sees nothing
  // and the UPDATE hits the unique name_key.
  const db = f.app.city.db;
  const transaction = db.transaction;
  db.transaction = <T>(
    action: (tx: Parameters<Parameters<typeof transaction>[0]>[0]) => Promise<T>,
  ) =>
    transaction.call<typeof db, [typeof action], Promise<T>>(db, (tx) =>
      action({
        ...tx,
        query: (async (sql: string, params?: unknown[]) =>
          sql.startsWith('SELECT 1 FROM operators WHERE name_key=')
            ? { rows: [] }
            : tx.query(sql, params)) as typeof tx.query,
      }),
    );
  const post = (url: string, body: unknown) =>
    f.app.inject({
      method: 'POST',
      url,
      headers: { ...jsonHeaders, cookie },
      payload: JSON.stringify(body),
    });
  const handle = await post('/api/auth/google/handle', { name: 'raced name' });
  assert.equal(handle.statusCode, 409, handle.body);
  assert.equal(handle.json().code, 'name_unavailable');
  const { TERMS_VERSION } = await import('../shared/terms.js');
  const onboarding = await post('/api/auth/onboarding', {
    name: 'Raced Name',
    terms_version: TERMS_VERSION,
    accept_terms: true,
  });
  assert.equal(onboarding.statusCode, 409, onboarding.body);
  assert.match(onboarding.json().error, /unavailable/);
  db.transaction = transaction;
  // Nothing was half-written: the account can still choose a free name.
  const saved = await post('/api/auth/google/handle', { name: 'Free Name' });
  assert.equal(saved.statusCode, 200, saved.body);
});
