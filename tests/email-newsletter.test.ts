import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/app.js';
import { RESEND_URL } from '../server/email/provider.js';
import { COMPANY_LINE, newsletterFooter } from '../server/email/templates.js';
import { NEWSLETTER_TEXT_VERSION } from '../shared/newsletter.js';
import { TERMS_VERSION } from '../shared/terms.js';
import {
  FAKE_CLIENT_ID,
  FAKE_CLIENT_SECRET,
  claimsFor,
  fakeGoogle,
  signIdToken,
} from './fake-google.js';

/**
 * Welcome email and newsletter double opt-in (docs/EMAIL.md), through the HTTP routes with a fake
 * email provider and a fake Google. Synthetic data only.
 */
type App = Awaited<ReturnType<typeof createApp>>;
const jsonHeaders = { 'content-type': 'application/json', 'x-city-request': '1' };
const CRON = 'synthetic-cron-secret-for-email';
const OPS = 'synthetic-ops-secret-for-the-email-tests';
const EMAIL_ENV = {
  CITY_EMAIL_API_KEY: 'synthetic-provider-credential',
  CITY_EMAIL_FROM: 'Central City <hello@example.com>',
  CITY_OPS_SECRET: OPS,
  CITY_EMAIL_LINK_KEY: 'synthetic-link-signing-secret-for-tests-a',
};

interface Sent {
  url: string;
  headers: Record<string, string>;
  body: { from: string; to: string[]; subject: string; text: string; html?: string };
}

async function fixture(
  t: { after: (fn: () => Promise<unknown>) => void },
  options: { env?: Record<string, string>; status?: () => number } = {},
) {
  process.env.CRON_SECRET = CRON;
  const google = fakeGoogle();
  const clock = { now: Date.now() };
  const sent: Sent[] = [];
  const app = await createApp({
    dataDir: ':memory:',
    startWorkers: false,
    now: () => clock.now,
    google: {
      env: {
        CITY_GOOGLE_SIGNIN: '1',
        GOOGLE_OAUTH_CLIENT_ID: FAKE_CLIENT_ID,
        GOOGLE_OAUTH_CLIENT_SECRET: FAKE_CLIENT_SECRET,
      },
      transport: google.transport,
    },
    email: {
      env: options.env ?? EMAIL_ENV,
      autoDrain: false,
      transport: async (request) => {
        sent.push({ url: request.url, headers: request.headers, body: JSON.parse(request.body) });
        const status = options.status?.() ?? 200;
        return { status, body: status === 200 ? '{"id":"synthetic"}' : '{}' };
      },
    },
  });
  t.after(async () => {
    await app.close();
    delete process.env.CRON_SECRET;
  });
  return { app, google, clock, sent };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

/** "Continue with Google" for a new synthetic Workspace account; returns its session cookie. */
async function signUp(f: Fixture, sub: string) {
  const started = await f.app.inject({
    method: 'POST',
    url: '/api/auth/google/start',
    headers: jsonHeaders,
    payload: JSON.stringify({ intent: 'signin' }),
  });
  const params = new URL(started.json().url).searchParams;
  const binder = started.cookies.find((item) => item.name === 'cc_google_flow')!.value;
  const token = signIdToken(
    f.google.keys[0]!,
    claimsFor(params.get('nonce')!, f.clock.now, {
      sub,
      email: `person.${sub}@example.com`,
      hd: 'example.com',
    }),
  );
  const code = f.google.issueCode(token, params.get('code_challenge')!);
  const res = await f.app.inject({
    method: 'GET',
    url: `/api/auth/google/callback?${new URLSearchParams({ state: params.get('state')!, code })}`,
    headers: { cookie: `cc_google_flow=${binder}` },
  });
  assert.equal(res.headers.location, '/settings/account?google=welcome');
  return `cc_session=${res.cookies.find((item) => item.name === 'cc_session')!.value}`;
}
function onboard(app: App, cookie: string, body: Record<string, unknown>) {
  return app.inject({
    method: 'POST',
    url: '/api/auth/onboarding',
    headers: { ...jsonHeaders, cookie },
    payload: JSON.stringify({ terms_version: TERMS_VERSION, accept_terms: true, ...body }),
  });
}
const drain = (app: App) =>
  app.inject({
    method: 'GET',
    url: '/api/cron/email-drain',
    headers: { authorization: `Bearer ${CRON}` },
  });
const newsletter = async (app: App, cookie: string) =>
  (await app.inject({ method: 'GET', url: '/api/account/newsletter', headers: { cookie } })).json();
const linkIn = (text: string, path: string) => {
  const match = new RegExp(`https?://\\S+${path}\\?t=\\S+`).exec(text);
  assert.ok(match, `a ${path} link`);
  return new URL(match[0]);
};
/** The POST a link's page button (or a mail client's one-click unsubscribe) makes. */
const postLink = (app: App, link: URL, payload = '') =>
  app.inject({
    method: 'POST',
    url: `/api${link.pathname}${link.search}`,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload,
  });
const register = (app: App, body: Record<string, unknown>) =>
  app.inject({
    method: 'POST',
    url: '/api/auth/register',
    headers: jsonHeaders,
    payload: JSON.stringify({ password: 'synthetic-password-0001', ...body }),
  });
const cookieOf = (res: { cookies: { name: string; value: string }[] }) =>
  `cc_session=${res.cookies.find((item) => item.name === 'cc_session')!.value}`;

test('welcome email once, newsletter double opt-in, unsubscribe and the ops export', async (t) => {
  const f = await fixture(t);
  const cookie = await signUp(f, '100000000000000000201');
  const session = (
    await f.app.inject({ method: 'GET', url: '/api/session', headers: { cookie } })
  ).json();
  assert.equal(session.onboarding.newsletter_available, true);
  const done = await onboard(f.app, cookie, { name: 'Mail Person', newsletter: true });
  assert.equal(done.statusCode, 200, done.body);
  // Queued in the request, sent by the drain (the request never waits for the provider).
  const drained = await drain(f.app);
  assert.equal(drained.statusCode, 200, drained.body);
  const welcome = f.sent.find((item) => item.body.subject === 'Welcome to Central City')!;
  const confirm = f.sent.find((item) => item.body.subject.startsWith('Confirm'))!;
  assert.ok(welcome && confirm, JSON.stringify(f.sent.map((item) => item.body.subject)));
  assert.equal(welcome.url, RESEND_URL);
  assert.equal(welcome.headers.authorization, 'Bearer synthetic-provider-credential');
  assert.deepEqual(welcome.body.to, ['person.100000000000000000201@example.com']);
  assert.deepEqual(confirm.body.to, ['person.100000000000000000201@example.com']);
  assert.equal(welcome.body.from, 'Central City <hello@example.com>');
  assert.match(welcome.body.text, /^Hi Mail Person,/);
  assert.ok(welcome.body.text.includes(`--\n${COMPANY_LINE}\n`), 'the verbatim company line');
  assert.ok(!/unsubscribe/i.test(welcome.body.text), 'the welcome email is transactional');
  assert.ok(!confirm.body.text.includes('{confirm_token}'), 'the link is signed when sent');
  // Multipart: the HTML part carries the same signed link (button and fallback).
  assert.ok(welcome.body.html?.includes('Hi Mail Person,'), 'the welcome email has an HTML part');
  const signed = linkIn(confirm.body.text, '/newsletter/confirm').href.replace(/&/g, '&amp;');
  assert.ok(!confirm.body.html!.includes('{confirm_token}'));
  assert.equal(confirm.body.html!.split(`href="${signed}"`).length - 1, 2);
  // Once per account: a repeated onboarding and drain send nothing new.
  assert.equal((await onboard(f.app, cookie, {})).statusCode, 200);
  await drain(f.app);
  assert.equal(f.sent.filter((item) => item.body.subject === 'Welcome to Central City').length, 1);

  // Pending until confirmed; the consent records the exact text version and the source.
  assert.equal((await newsletter(f.app, cookie)).status, 'pending');
  const [consent] = (
    await f.app.city.db.query<{ text_version: string; source: string; opted_in_at: string }>(
      'SELECT text_version,source,opted_in_at FROM newsletter_consents',
    )
  ).rows;
  assert.equal(consent!.text_version, NEWSLETTER_TEXT_VERSION);
  assert.equal(consent!.source, 'onboarding');
  const exportList = async () =>
    (
      await f.app.inject({
        method: 'GET',
        url: '/api/ops/newsletter/subscribers',
        headers: { authorization: `Bearer ${OPS}` },
      })
    ).json().subscribers as { email: string; unsubscribe_url: string }[];
  assert.deepEqual(await exportList(), [], 'unconfirmed addresses do not count');
  // The link opens the app's page (which only shows a button); a forged link is refused.
  const link = linkIn(confirm.body.text, '/newsletter/confirm');
  assert.ok(!link.pathname.startsWith('/api/'));
  const forged = new URL(link);
  forged.searchParams.set('t', `${link.searchParams.get('t')!.slice(0, -2)}xx`);
  {
    const r = await postLink(f.app, forged);
    assert.equal(r.statusCode, 400, r.body);
  }
  assert.equal((await newsletter(f.app, cookie)).status, 'pending');
  // The button: a POST of the same signed link (no request-protection header needed).
  const confirmed = await postLink(f.app, link);
  assert.equal(confirmed.statusCode, 200, confirmed.body);
  assert.equal(confirmed.json().status, 'subscribed');
  assert.equal((await postLink(f.app, link)).statusCode, 200, 'confirming twice is fine');
  assert.equal((await newsletter(f.app, cookie)).status, 'subscribed');
  const list = await exportList();
  assert.equal(list.length, 1);
  assert.equal(list[0]!.email, 'person.100000000000000000201@example.com');
  // Ops export: 404 without the ops secret.
  assert.equal(
    (await f.app.inject({ method: 'GET', url: '/api/ops/newsletter/subscribers' })).statusCode,
    404,
  );

  // The one-click POST (List-Unsubscribe-Post, RFC 8058) unsubscribes, with no login.
  const unsubscribe = new URL(list[0]!.unsubscribe_url);
  assert.equal(unsubscribe.pathname, '/newsletter/unsubscribe');
  const oneClick = await postLink(f.app, unsubscribe, 'List-Unsubscribe=One-Click');
  assert.equal(oneClick.statusCode, 200, oneClick.body);
  assert.equal(oneClick.json().status, 'unsubscribed');
  assert.equal((await newsletter(f.app, cookie)).status, 'unsubscribed');
  assert.deepEqual(await exportList(), []);
  // The consent history is append-only.
  const events = (
    await f.app.city.db.query<{ event: string }>(
      'SELECT event FROM newsletter_consent_events ORDER BY id',
    )
  ).rows.map((row) => row.event);
  assert.deepEqual(events, ['opt_in', 'confirm', 'unsubscribe']);
  await assert.rejects(
    f.app.city.db.query("UPDATE newsletter_consent_events SET event='confirm'"),
    /append-only/,
  );
});

test('the newsletter footer gives one-click List-Unsubscribe headers', () => {
  const { footer, headers } = newsletterFooter({
    unsubscribeUrl: 'https://city.example/newsletter/unsubscribe?t=abc',
    settingsUrl: 'https://city.example/settings/account',
  });
  assert.ok(footer.includes('Unsubscribe: https://city.example/newsletter/unsubscribe?t=abc'));
  assert.deepEqual(headers, {
    'List-Unsubscribe': '<https://city.example/api/newsletter/unsubscribe?t=abc>',
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  });
});

test('the newsletter is optional, the confirmation link expires, and settings can re-subscribe', async (t) => {
  const f = await fixture(t);
  const cookie = await signUp(f, '100000000000000000202');
  assert.equal((await onboard(f.app, cookie, { name: 'No Letter' })).statusCode, 200);
  await drain(f.app);
  assert.equal((await newsletter(f.app, cookie)).status, 'none');
  assert.equal(f.sent.length, 1, 'only the welcome email');
  // Subscribing from settings sends a new confirmation; it expires 7 days after sending.
  const on = await f.app.inject({
    method: 'POST',
    url: '/api/account/newsletter',
    headers: { ...jsonHeaders, cookie },
    payload: JSON.stringify({ subscribe: true }),
  });
  assert.equal(on.json().status, 'pending');
  await drain(f.app);
  const link = linkIn(f.sent.at(-1)!.body.text, '/newsletter/confirm');
  f.clock.now += 7 * 24 * 3_600_000 + 1;
  assert.equal((await postLink(f.app, link)).statusCode, 400);
  // Unconfirmed sign-ups are deleted after 30 days (the drain's purge).
  f.clock.now += 23 * 24 * 3_600_000;
  await drain(f.app);
  assert.equal((await f.app.city.db.query('SELECT 1 FROM newsletter_consents')).rows.length, 0);
  const events = (
    await f.app.city.db.query<{ event: string }>(
      'SELECT event FROM newsletter_consent_events ORDER BY id',
    )
  ).rows.map((row) => row.event);
  assert.deepEqual(events, ['opt_in', 'expired']);
});

test('password sign-up: the opt-in needs an address, none is stored without it', async (t) => {
  const f = await fixture(t);
  // Ticked without an address, or an invalid one: refused, no account.
  assert.equal((await register(f.app, { name: 'Letter A', newsletter: true })).statusCode, 400);
  assert.equal(
    (await register(f.app, { name: 'Letter A', newsletter: true, email: 'not-an-address' }))
      .statusCode,
    400,
  );
  // An address without the tick is refused too (nothing is collected without consent).
  assert.equal(
    (await register(f.app, { name: 'Letter A', email: 'a@example.com' })).statusCode,
    400,
  );
  const plain = await register(f.app, { name: 'Letter B' });
  assert.equal(plain.statusCode, 201, plain.body);
  assert.equal((await newsletter(f.app, cookieOf(plain))).status, 'none');
  assert.equal((await f.app.city.db.query('SELECT 1 FROM newsletter_consents')).rows.length, 0);

  const ticked = await register(f.app, {
    name: 'Letter C',
    newsletter: true,
    email: 'Letter.C@Example.com',
  });
  assert.equal(ticked.statusCode, 201, ticked.body);
  const cookie = cookieOf(ticked);
  const view = await newsletter(f.app, cookie);
  assert.deepEqual(view, {
    status: 'pending',
    email: 'letter.c@example.com',
    has_account_email: false,
  });
  // No welcome email for a password account (no address of its own); one confirmation.
  await drain(f.app);
  assert.equal(f.sent.length, 1);
  assert.deepEqual(f.sent[0]!.body.to, ['letter.c@example.com']);
  const [row] = (
    await f.app.city.db.query<{ source: string }>('SELECT source FROM newsletter_consents')
  ).rows;
  assert.equal(row!.source, 'signup');
  // The data export includes the record.
  const exported = (
    await f.app.inject({ method: 'GET', url: '/api/workspace/export', headers: { cookie } })
  ).json();
  assert.equal(exported.newsletter.email, 'letter.c@example.com');
  assert.equal(exported.newsletter.status, 'pending');
  // Settings: unsubscribe, then subscribe again needs an address for a password account.
  const post = (body: Record<string, unknown>) =>
    f.app.inject({
      method: 'POST',
      url: '/api/account/newsletter',
      headers: { ...jsonHeaders, cookie },
      payload: JSON.stringify(body),
    });
  assert.equal((await post({ subscribe: false })).json().status, 'unsubscribed');
  const none = await post({ subscribe: true });
  assert.equal(none.statusCode, 400);
  assert.equal(none.json().code, 'newsletter_email_required');
  assert.equal((await post({ subscribe: true, email: 'c2@example.com' })).json().status, 'pending');
  // Subscribe attempts are rate limited per account.
  let limited = 0;
  for (let index = 0; index < 6; index += 1)
    if ((await post({ subscribe: true, email: 'c2@example.com' })).statusCode === 429) limited += 1;
  assert.ok(limited > 0, 'the subscribe budget runs out');
  // Deleting the account removes the subscription and the queue, and keeps the consent record.
  const id = (
    await f.app.city.db.query<{ id: string }>("SELECT id FROM operators WHERE name='Letter C'")
  ).rows[0]!.id;
  // (No account-deletion route exists yet; this is what one will delete.)
  const references = (
    await f.app.city.db.query<{ tbl: string; col: string }>(
      `SELECT c.conrelid::regclass::text AS tbl, a.attname AS col FROM pg_constraint c
         JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=c.conkey[1]
        WHERE c.contype='f' AND c.confrelid='operators'::regclass AND c.confdeltype<>'c'`,
    )
  ).rows;
  for (const ref of references)
    await f.app.city.db.query(`DELETE FROM ${ref.tbl} WHERE ${ref.col}=$1`, [id]);
  await f.app.city.db.query('DELETE FROM operators WHERE id=$1', [id]);
  assert.equal((await f.app.city.db.query('SELECT 1 FROM newsletter_consents')).rows.length, 0);
  assert.equal((await f.app.city.db.query('SELECT 1 FROM email_outbox')).rows.length, 0);
  assert.ok(
    (
      await f.app.city.db.query('SELECT 1 FROM newsletter_consent_events WHERE operator_id=$1', [
        id,
      ])
    ).rows.length > 0,
  );
  // ... until 2 years after its last change (the purge).
  f.clock.now += 731 * 24 * 3_600_000;
  await drain(f.app);
  assert.equal(
    (
      await f.app.city.db.query('SELECT 1 FROM newsletter_consent_events WHERE operator_id=$1', [
        id,
      ])
    ).rows.length,
    0,
  );
});

test('delivery retries with backoff and stops on a permanent error', async (t) => {
  const statuses = [500, 200];
  const f = await fixture(t, { status: () => statuses.shift() ?? 422 });
  const cookie = await signUp(f, '100000000000000000203');
  await onboard(f.app, cookie, { name: 'Retry Person' });
  assert.deepEqual((await drain(f.app)).json(), { sent: 0, failed: 0, retried: 1 });
  // Not due yet; then due.
  assert.deepEqual((await drain(f.app)).json(), { sent: 0, failed: 0, retried: 0 });
  f.clock.now += 3 * 60_000;
  assert.deepEqual((await drain(f.app)).json(), { sent: 1, failed: 0, retried: 0 });
  // Both attempts carried the same idempotency key (the provider never sends twice).
  assert.equal(new Set(f.sent.map((item) => item.headers['idempotency-key'])).size, 1);
  // A permanent provider error (422) is not retried.
  const other = await signUp(f, '100000000000000000204');
  await onboard(f.app, other, { name: 'Bad Person' });
  assert.deepEqual((await drain(f.app)).json(), { sent: 0, failed: 1, retried: 0 });
  const [row] = (
    await f.app.city.db.query<{ last_error: string }>(
      'SELECT last_error FROM email_outbox WHERE failed_at IS NOT NULL',
    )
  ).rows;
  assert.equal(row!.last_error, 'provider status 422', 'no provider body or address is kept');
});

test('while sending is off, opt-ins are recorded and stay queued; no welcome email', async (t) => {
  const env: Record<string, string> = {};
  const f = await fixture(t, { env });
  const cookie = await signUp(f, '100000000000000000205');
  const session = (
    await f.app.inject({ method: 'GET', url: '/api/session', headers: { cookie } })
  ).json();
  assert.equal(session.onboarding.newsletter_available, true);
  assert.equal(
    (await onboard(f.app, cookie, { name: 'Quiet Person', newsletter: true })).statusCode,
    200,
  );
  assert.deepEqual((await drain(f.app)).json(), { sent: 0, failed: 0, retried: 0 });
  assert.equal(f.sent.length, 0);
  const kinds = (
    await f.app.city.db.query<{ kind: string }>(
      'SELECT kind FROM email_outbox WHERE sent_at IS NULL',
    )
  ).rows.map((row) => row.kind);
  assert.deepEqual(kinds, ['newsletter_confirm']);
  assert.equal((await newsletter(f.app, cookie)).status, 'pending');
  // The cron route answers 404 without its secret.
  assert.equal(
    (await f.app.inject({ method: 'GET', url: '/api/cron/email-drain' })).statusCode,
    404,
  );
  // Once configured, the queued confirmation goes out with a fresh link.
  Object.assign(env, EMAIL_ENV);
  await drain(f.app);
  assert.equal(f.sent.length, 1);
  const link = linkIn(f.sent[0]!.body.text, '/newsletter/confirm');
  assert.equal((await postLink(f.app, link)).statusCode, 200);
});

test('a short link key keeps sending off; a rotation keeps old links via the previous key', async (t) => {
  const short = await fixture(t, {
    env: { ...EMAIL_ENV, CITY_EMAIL_LINK_KEY: 'too-short-link-key' },
  });
  const shortCookie = await signUp(short, '100000000000000000301');
  await onboard(short.app, shortCookie, { name: 'Keyless Person', newsletter: true });
  await drain(short.app);
  assert.equal(short.sent.length, 0);
  // Rotation: links signed under the old key still work while it is the previous key.
  const env: Record<string, string> = { ...EMAIL_ENV };
  const f = await fixture(t, { env });
  const cookie = await signUp(f, '100000000000000000310');
  await onboard(f.app, cookie, { name: 'Rotating Person', newsletter: true });
  await drain(f.app);
  const link = linkIn(f.sent.at(-1)!.body.text, '/newsletter/confirm');
  env.CITY_EMAIL_LINK_KEY = 'synthetic-link-signing-secret-for-tests-b';
  env.CITY_EMAIL_LINK_KEY_PREVIOUS = EMAIL_ENV.CITY_EMAIL_LINK_KEY;
  assert.equal((await postLink(f.app, link)).statusCode, 200);
  // Once the previous key is dropped, links signed under it no longer work.
  delete env.CITY_EMAIL_LINK_KEY_PREVIOUS;
  assert.equal((await postLink(f.app, link)).statusCode, 400);
});

test('sent and failed queue rows (address and body) are deleted after 30 days', async (t) => {
  const f = await fixture(t);
  const cookie = await signUp(f, '100000000000000000320');
  await onboard(f.app, cookie, { name: 'Purged Person' });
  await drain(f.app);
  assert.equal((await f.app.city.db.query('SELECT 1 FROM email_outbox')).rows.length, 1);
  f.clock.now += 30 * 24 * 3_600_000 + 1;
  await drain(f.app);
  assert.equal((await f.app.city.db.query('SELECT 1 FROM email_outbox')).rows.length, 0);
});
