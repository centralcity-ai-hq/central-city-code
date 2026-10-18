import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { FEED_OPS_PATHS } from '../server/feed/review.js';
import {
  FEED_PATHS,
  type FeedMyRequests,
  type PostedFeedRequest,
  type PublicFeedRequest,
} from '../shared/feed.js';
import { fixture, OWNER } from './oauth-helpers.js';

/*
 * The Feed requests routes inside the whole app (server/app.ts): the CITY_FEED switch, the
 * migration, the public POST guard (JSON, no request header needed), the rule that a session
 * counts only together with the console's request header, and the operators' review routes
 * behind CITY_OPS_SECRET. Synthetic data only.
 */

type Ctx = { after: (fn: () => unknown) => void };

function withEnv(t: Ctx, name: string, value: string | undefined) {
  const before = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  t.after(() => {
    if (before === undefined) delete process.env[name];
    else process.env[name] = before;
  });
}

const withFeed = (t: Ctx, value: string | undefined) => withEnv(t, 'CITY_FEED', value);

const payload = (title: string) =>
  JSON.stringify({ title, description: 'Synthetic.', idempotencyKey: randomUUID() });

test('in the app: off answers 404; on, a public POST is anonymous unless the console header comes with the session', async (t) => {
  withFeed(t, '0');
  const { app, cookie } = await fixture(t);
  assert.equal((await app.inject({ url: FEED_PATHS.status })).statusCode, 404);
  assert.equal((await app.inject({ url: FEED_PATHS.requests })).statusCode, 404);

  process.env.CITY_FEED = '1';
  const status = await app.inject({ url: FEED_PATHS.status });
  assert.equal(status.statusCode, 200, status.body);
  assert.equal(status.json().openRequests, 0);

  // No JSON content type: refused by the root guard.
  const text = await app.inject({
    method: 'POST',
    url: FEED_PATHS.requests,
    headers: { 'content-type': 'text/plain' },
    payload: payload('Plain text body'),
  });
  assert.equal(text.statusCode, 415);

  // The cookie alone (as a cross-site form would send it) does not sign the post.
  const anonymous = await app.inject({
    method: 'POST',
    url: FEED_PATHS.requests,
    headers: { 'content-type': 'application/json', cookie },
    payload: payload('Sort a box of receipts'),
  });
  assert.equal(anonymous.statusCode, 201, anonymous.body);
  assert.deepEqual((anonymous.json() as PostedFeedRequest).request.postedBy, {
    kind: 'anonymous',
    displayName: null,
  });

  const signed = await app.inject({
    method: 'POST',
    url: FEED_PATHS.requests,
    headers: { 'content-type': 'application/json', 'x-city-request': '1', cookie },
    payload: payload('Check a lease for typos'),
  });
  assert.equal(signed.statusCode, 201, signed.body);
  const { request } = signed.json() as PostedFeedRequest;
  // The person's sign-in name is never published: an account posts without a name.
  assert.deepEqual(request.postedBy, { kind: 'account', displayName: null });
  assert.doesNotMatch(signed.body, new RegExp(OWNER));

  const closed = await app.inject({
    method: 'POST',
    url: FEED_PATHS.close.replace(':id', request.id),
    headers: { 'content-type': 'application/json', 'x-city-request': '1', cookie },
    payload: '{}',
  });
  assert.equal(closed.statusCode, 200, closed.body);
  assert.equal((closed.json() as PublicFeedRequest).status, 'closed');

  const page = await app.inject({ url: FEED_PATHS.requests });
  assert.deepEqual(
    page.json().requests.map((item: PublicFeedRequest) => item.title),
    ['Sort a box of receipts'],
  );
});

test("in the app: the caller's own requests need the session and the console header; another account sees none", async (t) => {
  withFeed(t, '1');
  const { app, cookie } = await fixture(t);
  /** What the console sends: its request header with the session (a write adds JSON). */
  const signedIn = (session: string) => ({ 'x-city-request': '1', cookie: session });
  const write = { 'content-type': 'application/json', ...signedIn(cookie) };
  const mine = async (session: string) => {
    const response = await app.inject({ url: FEED_PATHS.mine, headers: signedIn(session) });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.headers['cache-control'], 'no-store');
    // The person's sign-in name is never in it.
    assert.doesNotMatch(response.body, new RegExp(OWNER));
    return (response.json() as FeedMyRequests).requests.map((request) => [
      request.id,
      request.status,
      request.closable,
    ]);
  };
  const posted = await app.inject({
    method: 'POST',
    url: FEED_PATHS.requests,
    headers: write,
    payload: payload('Check a lease for typos'),
  });
  assert.equal(posted.statusCode, 201, posted.body);
  const { request } = posted.json() as PostedFeedRequest;

  // Signed out, or the cookie without the console header (as another site would send it): 401.
  for (const headers of [{}, { cookie }]) {
    const response = await app.inject({ url: FEED_PATHS.mine, headers });
    assert.equal(response.statusCode, 401, response.body);
    assert.equal(response.headers['cache-control'], 'no-store');
  }
  assert.deepEqual(await mine(cookie), [[request.id, 'open', true]]);

  // After a reload no manage token is left: the session closes it, and the list says so.
  const closed = await app.inject({
    method: 'POST',
    url: FEED_PATHS.close.replace(':id', request.id),
    headers: write,
    payload: '{}',
  });
  assert.equal(closed.statusCode, 200, closed.body);
  assert.deepEqual(await mine(cookie), [[request.id, 'closed', false]]);

  // Another account sees none of them.
  const other = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    headers: { 'content-type': 'application/json', 'x-city-request': '1' },
    payload: JSON.stringify({ name: 'Second owner', password: 'Synthetic second owner password' }),
  });
  assert.equal(other.statusCode, 201, other.body);
  const otherCookie = `cc_session=${other.cookies.find((entry) => entry.name === 'cc_session')!.value}`;
  assert.deepEqual(await mine(otherCookie), []);

  process.env.CITY_FEED = '0';
  const off = await app.inject({ url: FEED_PATHS.mine, headers: signedIn(cookie) });
  assert.equal(off.statusCode, 404);
  assert.equal(off.json().code, 'not_found');
});

test('in the app: the review queue and the pause answer only with CITY_OPS_SECRET and CITY_FEED', async (t) => {
  const secret = 'feed-requests-app-ops-secret-0000000001';
  withFeed(t, '1');
  withEnv(t, 'CITY_OPS_SECRET', secret);
  const { app, cookie } = await fixture(t);
  // Ops POSTs pass the root guard like every console POST: the request header and JSON.
  const ops = (
    method: 'GET' | 'POST',
    url: string,
    headers: Record<string, string>,
    body?: unknown,
  ) =>
    app.inject({
      method,
      url,
      headers: {
        'x-city-request': '1',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers,
      },
      ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
    });
  const bearer = { authorization: `Bearer ${secret}` };
  const heldQueue = `${FEED_OPS_PATHS.queue}?state=held`;

  // The honeypot field: answered like a post, held for review.
  const held = await app.inject({
    method: 'POST',
    url: FEED_PATHS.requests,
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({
      title: 'Fold a stack of letters',
      description: 'Synthetic.',
      idempotencyKey: randomUUID(),
      website: 'https://bot.example',
    }),
  });
  assert.equal(held.statusCode, 201, held.body);
  const { request } = held.json() as PostedFeedRequest;
  assert.equal(request.status, 'held');

  // An owner session is not an operator, on a read or a POST, and the answer is the app's own
  // for an unknown API path; nor is a wrong secret.
  const unknown = await app.inject({ url: '/api/ops/feed/unknown' });
  assert.equal(unknown.statusCode, 404);
  for (const [method, url, body] of [
    ['GET', heldQueue, undefined],
    ['POST', FEED_OPS_PATHS.release.replace(':id', request.id), {}],
    ['POST', FEED_OPS_PATHS.remove.replace(':id', request.id), {}],
    ['POST', FEED_OPS_PATHS.pause, { paused: true }],
  ] as const) {
    const refused = await ops(method, url, { cookie }, body);
    assert.equal(refused.statusCode, 404, `${method} ${url}`);
    assert.deepEqual(refused.json(), unknown.json(), `${method} ${url}`);
  }
  const wrong = { authorization: `Bearer ${'x'.repeat(secret.length)}` };
  assert.equal((await ops('GET', heldQueue, wrong)).statusCode, 404);
  const queue = await ops('GET', heldQueue, bearer);
  assert.equal(queue.statusCode, 200, queue.body);
  assert.equal(queue.headers['cache-control'], 'no-store');
  assert.deepEqual(
    queue
      .json()
      .requests.map((item: { id: string; heldReason: string }) => [item.id, item.heldReason]),
    [[request.id, 'honeypot']],
  );

  const paused = await ops('POST', FEED_OPS_PATHS.pause, bearer, { paused: true });
  assert.equal(paused.statusCode, 200, paused.body);
  const refused = await app.inject({
    method: 'POST',
    url: FEED_PATHS.requests,
    headers: { 'content-type': 'application/json' },
    payload: payload('Sort a box of receipts'),
  });
  assert.equal(refused.statusCode, 503);
  assert.equal(refused.json().code, 'posting_paused');
  assert.equal(refused.json().retryable, true);
  const resumed = await ops('POST', FEED_OPS_PATHS.pause, bearer, { paused: false });
  assert.equal(resumed.statusCode, 200, resumed.body);

  const release = FEED_OPS_PATHS.release.replace(':id', request.id);
  const released = await ops('POST', release, bearer, {});
  assert.equal(released.statusCode, 200, released.body);
  const page = await app.inject({ url: FEED_PATHS.requests });
  assert.deepEqual(
    page.json().requests.map((item: PublicFeedRequest) => item.id),
    [request.id],
  );

  // CITY_FEED off: the ops routes answer 404 like every Feed route.
  process.env.CITY_FEED = '0';
  assert.equal((await ops('GET', heldQueue, bearer)).statusCode, 404);
});
