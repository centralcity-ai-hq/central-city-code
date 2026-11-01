import test from 'node:test';
import assert from 'node:assert/strict';
import {
  authorizeUrl,
  consentPost,
  fixture,
  openAuthorize,
  OWNER,
  PASSWORD,
  pkce,
  REDIRECT,
  registerClient,
  RESOURCE,
  type App,
} from './oauth-helpers.js';
import { OAUTH_CAPS } from '../server/oauth/server.js';

/**
 * Pending rows created at `createdAt + i`, open for an hour: unauthenticated, or signed into by
 * `operatorId`.
 */
async function fillPending(
  app: App,
  clientId: string,
  count: number,
  createdAt: number,
  operatorId: string | null = null,
) {
  await app.city.db.query(
    `INSERT INTO oauth_pending(id,form_hash,browser_hash,client_id,client_name,client_verified,
     redirect_uri,code_challenge,resource,scopes,state,operator_id,created_at,expires_at)
     SELECT 'filler-' || coalesce($7,'') || i,'x','x',$1,'n',false,$2,'c',$3,'["workspace:read"]',
       null,$7,$4::bigint + i,$5::bigint
     FROM generate_series(0,$6::int - 1) AS i`,
    [clientId, REDIRECT, RESOURCE, createdAt, Date.now() + 3_600_000, count, operatorId],
  );
}
const operatorIdOf = async (app: App, name: string) =>
  (await app.city.db.query<{ id: string }>('SELECT id FROM operators WHERE name=$1', [name]))
    .rows[0]!.id;
async function registerOwner(app: App, name: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    headers: { 'content-type': 'application/json', 'x-city-request': '1' },
    payload: JSON.stringify({ name, password: PASSWORD }),
  });
  assert.equal(res.statusCode, 201, res.body);
  return operatorIdOf(app, name);
}
const ownerPending = async (app: App, operatorId: string) =>
  (
    await app.city.db.query<{ id: string }>(
      'SELECT id FROM oauth_pending WHERE operator_id=$1 ORDER BY created_at, id',
      [operatorId],
    )
  ).rows.map((row) => row.id);
const pendingCount = async (app: App) =>
  Number(
    (await app.city.db.query<{ n: string }>('SELECT count(*) AS n FROM oauth_pending')).rows[0]!.n,
  );

test('page loads by others never push out a young signed-out request; a full table refuses new ones', async (t) => {
  const { app } = await fixture(t);
  const client = await registerClient(app);
  const start = () =>
    openAuthorize(
      app,
      authorizeUrl({ client_id: client.client_id, code_challenge: pkce().challenge }),
    );
  // The person opens the page signed out (a cross-site arrival never carries the session).
  const victim = await start();
  assert.equal(victim.status, 200, victim.body);
  // Everyone else's loads fill the table with requests younger than the dwell time.
  await fillPending(app, client.client_id, OAUTH_CAPS.pending - 1, Date.now() + 1_000);
  const refused = await start();
  assert.equal(refused.status, 429, refused.body);
  assert.match(refused.body, /Too many authorization requests are open right now/);
  assert.equal(await pendingCount(app), OAUTH_CAPS.pending);
  // The person's own request is still there: signing in on it works.
  const login = await consentPost(app, victim, {
    action: 'login',
    name: OWNER,
    password: PASSWORD,
  });
  assert.equal(login.statusCode, 200, login.body);
  assert.match(login.body, /Allow .* to access Central City/);
});

test('a page load that carries a session is never refused at the bound', async (t) => {
  const { app, cookie } = await fixture(t);
  const client = await registerClient(app);
  const start = (session?: string) =>
    openAuthorize(
      app,
      authorizeUrl({ client_id: client.client_id, code_challenge: pkce().challenge }),
      session,
    );
  // Young signed-out requests fill the bound: a signed-out load is refused, a signed-in one is not.
  await fillPending(app, client.client_id, OAUTH_CAPS.pending, Date.now() + 1_000);
  assert.equal((await start()).status, 429);
  const consent = await start(cookie);
  assert.equal(consent.status, 200, consent.body);
  assert.match(consent.body, /Allow .* to access Central City/);
  // Requests other owners have signed into, however many, refuse neither kind of load.
  await app.city.db.query('DELETE FROM oauth_pending');
  const other = await registerOwner(app, 'Other OAuth owner');
  await fillPending(app, client.client_id, 5000, Date.now() + 1_000, other);
  assert.equal((await start(cookie)).status, 200);
  assert.equal((await start()).status, 200);
});

test('requests an owner has signed into are bounded per owner, oldest first', async (t) => {
  const { app, cookie } = await fixture(t);
  const client = await registerClient(app);
  const owner = await operatorIdOf(app, OWNER);
  const other = await registerOwner(app, 'Other OAuth owner');
  await fillPending(app, client.client_id, OAUTH_CAPS.pendingPerOwner, Date.now() - 60_000, owner);
  await fillPending(app, client.client_id, 3, Date.now() - 60_000, other);
  const url = () => authorizeUrl({ client_id: client.client_id, code_challenge: pkce().challenge });
  // A signed-in load makes room by dropping the owner's own oldest request only.
  const page = await openAuthorize(app, url(), cookie);
  assert.equal(page.status, 200, page.body);
  let rows = await ownerPending(app, owner);
  assert.equal(rows.length, OAUTH_CAPS.pendingPerOwner);
  assert.ok(rows.includes(page.requestId));
  assert.ok(!rows.includes(`filler-${owner}0`));
  assert.equal((await ownerPending(app, other)).length, 3);
  // Signing in on an older signed-out request keeps that one and drops the next oldest.
  const form = await openAuthorize(app, url());
  await app.city.db.query('UPDATE oauth_pending SET created_at=0 WHERE id=$1', [form.requestId]);
  const login = await consentPost(app, form, { action: 'login', name: OWNER, password: PASSWORD });
  assert.equal(login.statusCode, 200, login.body);
  rows = await ownerPending(app, owner);
  assert.equal(rows.length, OAUTH_CAPS.pendingPerOwner);
  assert.equal(rows[0], form.requestId);
  assert.ok(!rows.includes(`filler-${owner}1`));
});

test('concurrent page loads at the bound never overrun it', async (t) => {
  const { app } = await fixture(t);
  const client = await registerClient(app);
  await fillPending(
    app,
    client.client_id,
    OAUTH_CAPS.pending - 1,
    Date.now() - OAUTH_CAPS.pendingMinDwellMs - 60_000,
  );
  const pages = await Promise.all(
    Array.from({ length: 20 }, () =>
      openAuthorize(
        app,
        authorizeUrl({ client_id: client.client_id, code_challenge: pkce().challenge }),
      ),
    ),
  );
  assert.deepEqual(
    pages.map((page) => page.status),
    Array(20).fill(200),
  );
  assert.equal(await pendingCount(app), OAUTH_CAPS.pending);
});

test('authorization-page loads count the IPv6 /56, not only the /64', async (t) => {
  const { app } = await fixture(t);
  const client = await registerClient(app);
  const load = async (remoteAddress: string) =>
    (
      await app.inject({
        method: 'GET',
        url: authorizeUrl({ client_id: client.client_id, code_challenge: pkce().challenge }),
        remoteAddress,
      })
    ).statusCode;
  // Two /64s of one /56 together reach its budget (twice the per-/64 budget)...
  for (const prefix of ['2001:db8:42:100', '2001:db8:42:101'])
    for (let i = 0; i < OAUTH_CAPS.authorizePerAddress; i++)
      assert.equal(await load(`${prefix}::${i + 1}`), 200);
  // ...so a third /64 in it is refused, while another /56 of the same /48 is not.
  assert.equal(await load('2001:db8:42:1ff::1'), 429);
  assert.equal(await load('2001:db8:42:200::1'), 200);
});

const registerFrom = (app: App) => async (remoteAddress: string) =>
  (
    await app.inject({
      method: 'POST',
      url: '/oauth/register',
      remoteAddress,
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ redirect_uris: [REDIRECT] }),
    })
  ).statusCode;
/** `count` never-used clients `ccc_filler_<i>`, created at `createdAt + i`. */
async function fillClients(app: App, count: number, createdAt: number) {
  await app.city.db.query(
    `INSERT INTO oauth_clients(client_id,client_name,redirect_uris,created_at)
     SELECT 'ccc_filler_' || i,'n',$1::jsonb,$2::bigint + i FROM generate_series(0,$3::int - 1) AS i`,
    [JSON.stringify([REDIRECT]), createdAt, count],
  );
}
const clientIds = async (app: App) =>
  new Set(
    (
      await app.city.db.query<{ client_id: string }>('SELECT client_id FROM oauth_clients')
    ).rows.map((row) => row.client_id),
  );
/** One open request on each filler client, signed out or signed into by `operatorId`. */
async function pendingOnEveryFiller(app: App, operatorId: string | null) {
  await app.city.db.query(
    `INSERT INTO oauth_pending(id,form_hash,browser_hash,client_id,client_name,client_verified,
     redirect_uri,code_challenge,resource,scopes,state,operator_id,created_at,expires_at)
     SELECT 'held-' || client_id,'x','x',client_id,'n',false,$1,'c',$2,'["workspace:read"]',
       null,$3,$4::bigint,$5::bigint
     FROM oauth_clients WHERE client_id LIKE 'ccc_filler_%'`,
    [REDIRECT, RESOURCE, operatorId, Date.now(), Date.now() + 3_600_000],
  );
}

test('dynamic registration counts the IPv6 /56, not only the /64', async (t) => {
  const { app } = await fixture(t);
  const register = registerFrom(app);
  for (const prefix of ['2001:db8:43:100', '2001:db8:43:101'])
    for (let i = 0; i < 20; i++) assert.equal(await register(`${prefix}::${i + 1}`), 201);
  assert.equal(await register('2001:db8:43:1ff::1'), 429);
  assert.equal(await register('2001:db8:43:200::1'), 201);
});

test('signed-out page loads cannot keep clients registered: the bound still makes room', async (t) => {
  const { app } = await fixture(t);
  const register = registerFrom(app);
  // Every unused client at the bound has an open signed-out request (anyone can keep one open by
  // reloading the page). They are past the dwell time, so the oldest still makes room.
  await fillClients(app, OAUTH_CAPS.clients, Date.now() - OAUTH_CAPS.clientMinDwellMs - 60_000);
  await pendingOnEveryFiller(app, null);
  assert.equal(await register('198.51.100.40'), 201);
  const ids = await clientIds(app);
  assert.equal(ids.size, OAUTH_CAPS.clients);
  assert.ok(!ids.has('ccc_filler_0'));
  assert.ok(ids.has('ccc_filler_1'));
});

test('clients owners are authorizing or using never fill the bound for everyone', async (t) => {
  const { app } = await fixture(t);
  const register = registerFrom(app);
  const owner = await operatorIdOf(app, OWNER);
  // A bound's worth of clients each held by a request an owner signed into: in use, so kept, and
  // not counted toward the bound for unused registrations.
  await fillClients(app, OAUTH_CAPS.clients, Date.now() - OAUTH_CAPS.clientMinDwellMs - 60_000);
  await pendingOnEveryFiller(app, owner);
  assert.equal(await register('198.51.100.41'), 201);
  const ids = await clientIds(app);
  assert.equal(ids.size, OAUTH_CAPS.clients + 1);
  assert.ok(ids.has('ccc_filler_0'));
});

test('the day-old sweep keeps clients in use, as the bound does', async (t) => {
  const { app } = await fixture(t);
  const register = registerFrom(app);
  const owner = await operatorIdOf(app, OWNER);
  // Older than the day after which unused registrations are swept, each held by a request an
  // owner signed into: in use, so neither the sweep nor the bound removes them.
  await fillClients(app, OAUTH_CAPS.clients, Date.now() - 86_400_000 - 60_000);
  await pendingOnEveryFiller(app, owner);
  // One unused client of the same age is swept.
  await app.city.db.query(
    `INSERT INTO oauth_clients(client_id,client_name,redirect_uris,created_at)
     VALUES('ccc_old_unused','n',$1::jsonb,$2)`,
    [JSON.stringify([REDIRECT]), Date.now() - 86_400_000 - 60_000],
  );
  assert.equal(await register('198.51.100.44'), 201);
  const ids = await clientIds(app);
  assert.equal(ids.size, OAUTH_CAPS.clients + 1);
  assert.ok(ids.has('ccc_filler_0'));
  assert.ok(!ids.has('ccc_old_unused'));
});

test('a registration younger than the dwell time is never evicted; a full table of them refuses', async (t) => {
  const { app } = await fixture(t);
  const register = registerFrom(app);
  // The person's own client, registered a moment ago, and a bound's worth of other young ones.
  const mine = await registerClient(app);
  await fillClients(app, OAUTH_CAPS.clients - 1, Date.now() - 60_000);
  const refused = await app.inject({
    method: 'POST',
    url: '/oauth/register',
    remoteAddress: '198.51.100.42',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ redirect_uris: [REDIRECT] }),
  });
  assert.equal(refused.statusCode, 503, refused.body);
  assert.equal(refused.json().error, 'temporarily_unavailable');
  assert.ok((await clientIds(app)).has(mine.client_id));
  // Once they are past the dwell time the oldest of them make room again.
  await app.city.db.query('UPDATE oauth_clients SET created_at=created_at-$1', [
    OAUTH_CAPS.clientMinDwellMs,
  ]);
  assert.equal(await register('198.51.100.43'), 201);
});
