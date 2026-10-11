import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { withoutRewriteParameter } from '../server/vercel-handler.js';
import { createApp } from '../server/app.js';
import { negotiate } from '../server/links/service.js';

/**
 * Universal join link (docs/JOIN_LINKS.md): POST /api/links and the content-negotiated
 * GET /j/<code> for people (HTML) and AIs (JSON, Markdown). Synthetic data only.
 */
type App = Awaited<ReturnType<typeof createApp>>;
const jsonHeaders = { 'content-type': 'application/json', 'x-city-request': '1' };
const PASSWORD = 'Synthetic join link password';

async function setup(t: { after: (fn: () => Promise<unknown>) => void }, now = () => Date.now()) {
  const app = await createApp({ dataDir: ':memory:', startWorkers: false, now });
  t.after(() => app.close());
  const api = (cookie: string, method: 'GET' | 'POST', url: string, body?: unknown) =>
    app.inject({
      method,
      url,
      headers: { ...jsonHeaders, cookie },
      ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
    });
  const account = async (name: string) => {
    const res = await api('', 'POST', '/api/auth/register', { name, password: PASSWORD });
    assert.equal(res.statusCode, 201, res.body);
    const cookie = `cc_session=${res.cookies.find((item) => item.name === 'cc_session')!.value}`;
    const agentId = (
      await api(cookie, 'POST', '/api/agents', {
        name: `${name} desk`,
        capability: 'research',
        mode: 'hosted',
      })
    ).json().agent.id as string;
    return { cookie, agentId };
  };
  const host = await account('Link host');
  const created = (
    await api(host.cookie, 'POST', '/api/rooms', {
      agent_id: host.agentId,
      name: 'Launch room',
      topic: 'Secret topic',
      idempotency_key: randomUUID(),
    })
  ).json();
  await api(host.cookie, 'POST', `/api/rooms/${created.room.id}/messages`, {
    text: 'Confidential message',
    idempotency_key: randomUUID(),
  });
  const get = (path: string, accept?: string) =>
    app.inject({ method: 'GET', url: path, headers: accept ? { accept } : {} });
  return { app, api, account, host, created, get };
}
const pathOf = (url: string) => new URL(url).pathname;

test('POST /api/links returns a short-lived /j/<code> URL for a room the caller hosts', async (t) => {
  const { api, host, created, account, app } = await setup(t);
  const res = await api(host.cookie, 'POST', '/api/links', {
    target: 'room',
    room_id: created.room.slug,
  });
  assert.equal(res.statusCode, 201, res.body);
  const body = res.json();
  assert.match(body.url, /^http:\/\/localhost\/j\/[A-Za-z0-9_-]{43}$/);
  const ttl = Date.parse(body.expires_at) - Date.now();
  assert.ok(ttl > 23 * 3_600_000 && ttl <= 24 * 3_600_000, 'default 24 hours');
  assert.equal(body.single_use, false);
  // Never longer than the room invite it wraps (7 days by default), whatever is asked.
  const long = (
    await api(host.cookie, 'POST', '/api/links', {
      target: 'room',
      room_id: created.room.id,
      ttl_hours: 168,
    })
  ).json();
  assert.ok(Date.parse(long.expires_at) <= Date.parse(created.link.expires_at));
  // Only the host may wrap a room invite; others get the uniform answers.
  const member = await account('Not the host');
  const denied = await api(member.cookie, 'POST', '/api/links', {
    target: 'room',
    room_id: created.room.id,
  });
  assert.equal(denied.statusCode, 404);
  assert.equal(denied.json().code, 'room_not_found');
  assert.equal((await api('', 'POST', '/api/links', { target: 'connect' })).statusCode, 401);
  const invalid = await api(host.cookie, 'POST', '/api/links', { target: 'room' });
  assert.equal(invalid.statusCode, 400);
  // The code is stored only as a hash.
  const code = pathOf(body.url).slice(3);
  const rows = await app.city.db.query('SELECT * FROM join_links');
  assert.equal(rows.rows.length, 2);
  assert.ok(!JSON.stringify(rows.rows).includes(code));
});

test('GET /j/<code> negotiates HTML for browsers and JSON or Markdown for AIs', async (t) => {
  const { api, host, created, get, app } = await setup(t);
  const url = (
    await api(host.cookie, 'POST', '/api/links', { target: 'room', room_id: created.room.id })
  ).json().url as string;
  const path = pathOf(url);
  const code = path.slice(3);

  const html = await get(path, 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8');
  assert.equal(html.statusCode, 200);
  assert.match(String(html.headers['content-type']), /^text\/html/);
  assert.equal(html.headers.vary, 'Accept');
  assert.equal(html.headers['x-robots-tag'], 'noindex, nofollow');
  // One primary action into the app, the code in the fragment only.
  assert.equal((html.body.match(/class="primary"/g) ?? []).length, 1);
  assert.ok(html.body.includes(`href="/r/${created.room.slug}#${code}"`));
  assert.ok(html.body.includes('Join Launch room'));

  const json = await get(path, 'application/json');
  assert.equal(json.statusCode, 200);
  assert.match(String(json.headers['content-type']), /^application\/json/);
  const doc = json.json();
  assert.equal(doc.kind, 'centralcity.join/v1');
  assert.equal(doc.target, 'room');
  assert.deepEqual(doc.room, { name: 'Launch room', slug: created.room.slug });
  assert.equal(doc.mcp.url, 'http://localhost/mcp');
  assert.equal(doc.mcp.open_url, 'http://localhost/mcp/open');
  assert.equal(doc.call.tool, 'city_join_room');
  assert.equal(doc.call.arguments.link, url);
  assert.equal(doc.human_url, `http://localhost/r/${created.room.slug}#${code}`);
  assert.equal(doc.steps.length, 3);
  assert.match(doc.steps[0], /^Chat apps: connect to the MCP server/);
  assert.match(
    doc.chat_apps,
    /^Chat apps \(ChatGPT, Claude, \.\.\.\): connect http:\/\/localhost\/mcp once, allow rooms:join \(and agents:create if your app has no Central City agent yet\), then join with city_join_room/,
  );
  assert.doesNotMatch(doc.chat_apps, /wait=25|keep calling|stay responsive/);
  assert.match(doc.chat_apps, /Do not poll the room in a loop within one turn/);
  assert.match(doc.chat_apps, /stop after 3 checks in a row with nothing new/);
  assert.match(doc.chat_apps, /each check uses their AI usage/);
  assert.match(doc.chat_apps, /@mentions/);
  assert.match(doc.safety, /untrusted/);

  const markdown = await get(path, 'text/markdown');
  assert.match(String(markdown.headers['content-type']), /^text\/markdown/);
  assert.match(markdown.body, /^# Join the room "Launch room" on Central City/);
  assert.ok(markdown.body.includes('city_join_room'));
  // No Accept or */* (curl, most AI fetchers): Markdown. ?format= overrides Accept.
  assert.match(String((await get(path)).headers['content-type']), /^text\/markdown/);
  assert.match(String((await get(path, '*/*')).headers['content-type']), /^text\/markdown/);
  assert.match(
    String((await get(`${path}?format=json`, 'text/html')).headers['content-type']),
    /^application\/json/,
  );
  // Vercel's rewrite appends ?code=; it is ignored.
  assert.equal((await get(`${path}?code=${code}&format=json`)).json().kind, 'centralcity.join/v1');
  assert.equal(negotiate(undefined, 'application/json;q=0.5, text/markdown'), 'markdown');
  assert.equal(negotiate(undefined, 'text/html;q=0.1, application/json'), 'json');
  assert.equal(negotiate('html', 'application/json'), 'html');

  // No room contents before joining: no messages, topic, members, ids or tokens.
  for (const res of [html, json, markdown])
    for (const secret of [
      'Confidential message',
      'Secret topic',
      'Link host desk',
      created.room.id,
      created.link.link.split('#')[1],
    ])
      assert.ok(!res.body.includes(secret), secret);
  // An AI follows the document: city_join_room with the join URL.
  const ai = await app.inject({
    method: 'POST',
    url: '/api/public/workspaces',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ name: 'Following AI', idempotency_key: randomUUID() }),
    remoteAddress: '198.18.0.44',
  });
  const key = ai.json().workspace_key as string;
  const joined = await app.inject({
    method: 'POST',
    url: '/api/assistant/tools/city_join_room',
    headers: { ...jsonHeaders, authorization: `Bearer ${key}` },
    payload: JSON.stringify({
      ...doc.call.or_create_agent,
      create: { name: 'Link follower' },
      idempotency_key: randomUUID(),
    }),
  });
  assert.equal(joined.statusCode, 200, joined.body);
  assert.equal(joined.json().room.name, 'Launch room');
});

test('a browser joins with the code in the fragment via the rooms REST API', async (t) => {
  const { api, host, created, account } = await setup(t);
  const url = (
    await api(host.cookie, 'POST', '/api/links', { target: 'room', room_id: created.room.id })
  ).json().url as string;
  const code = pathOf(url).slice(3);
  const person = await account('Browser person');
  const joined = await api(person.cookie, 'POST', `/api/rooms/${created.room.slug}/join`, {
    token: code,
    agent_id: person.agentId,
    idempotency_key: randomUUID(),
  });
  assert.equal(joined.statusCode, 200, joined.body);
  assert.equal(joined.json().room.role, 'member');
  // A code for one room cannot be presented for another.
  const other = (
    await api(host.cookie, 'POST', '/api/rooms', {
      agent_id: host.agentId,
      name: 'Other room',
      idempotency_key: randomUUID(),
    })
  ).json();
  const second = await account('Second person');
  const wrong = await api(second.cookie, 'POST', `/api/rooms/${other.room.slug}/join`, {
    token: code,
    agent_id: second.agentId,
    idempotency_key: randomUUID(),
  });
  assert.equal(wrong.statusCode, 404);
  assert.equal(wrong.json().code, 'invite_invalid');
});

test('single-use codes admit once; expiry, rotation and closing kill codes uniformly', async (t) => {
  let now = Date.now();
  const { api, host, created, get, account } = await setup(t, () => now);
  const make = async (extra: object = {}) =>
    (
      await api(host.cookie, 'POST', '/api/links', {
        target: 'room',
        room_id: created.room.id,
        ...extra,
      })
    ).json().url as string;
  const single = await make({ single_use: true });
  const first = await account('First');
  const second = await account('Second');
  const joinWith = (who: { cookie: string; agentId: string }, url: string) =>
    api(who.cookie, 'POST', `/api/rooms/${created.room.id}/join`, {
      token: pathOf(url).slice(3),
      agent_id: who.agentId,
      idempotency_key: randomUUID(),
    });
  assert.equal((await joinWith(first, single)).statusCode, 200);
  const reused = await joinWith(second, single);
  assert.equal(reused.statusCode, 404);
  assert.equal(reused.json().code, 'invite_invalid');

  const invalidBodies = new Set<string>();
  const expectDead = async (url: string) => {
    const json = await get(pathOf(url), 'application/json');
    assert.equal(json.statusCode, 404);
    invalidBodies.add(json.body);
    const html = await get(pathOf(url), 'text/html');
    assert.equal(html.statusCode, 404);
    assert.ok(!html.body.includes('Launch room'));
    assert.equal((await get(pathOf(url), 'text/markdown')).statusCode, 404);
  };
  await expectDead(single); // used up
  await expectDead(`http://localhost/j/${'Z'.repeat(43)}`); // unknown
  await expectDead('http://localhost/j/short'); // malformed
  const expiring = await make({ ttl_hours: 1 });
  now += 2 * 3_600_000;
  await expectDead(expiring); // expired
  const rotatedAway = await make();
  await api(host.cookie, 'POST', `/api/rooms/${created.room.id}/link/rotate`, {
    idempotency_key: randomUUID(),
  });
  await expectDead(rotatedAway); // the invite it wrapped was rotated
  const closedAway = await make();
  assert.equal((await get(pathOf(closedAway), 'application/json')).statusCode, 200);
  await api(host.cookie, 'POST', `/api/rooms/${created.room.id}/close`, {});
  await expectDead(closedAway); // the room closed
  assert.equal(invalidBodies.size, 1, 'one identical answer for every dead code');
  assert.deepEqual(JSON.parse([...invalidBodies][0]!), {
    error: 'link_invalid',
    // Same wording as the join APIs' invite_invalid.
    message: 'This invite link is invalid or has expired. Ask the host for a new link.',
  });
});

test('connect links carry setup instructions only, and reads are rate limited', async (t) => {
  const { api, host, get } = await setup(t);
  const url = (await api(host.cookie, 'POST', '/api/links', { target: 'connect' })).json()
    .url as string;
  const doc = (await get(pathOf(url), 'application/json')).json();
  assert.equal(doc.target, 'connect');
  assert.equal(doc.mcp.url, 'http://localhost/mcp');
  assert.ok(doc.steps.some((step: string) => step.includes('city_create_workspace')));
  assert.ok(!JSON.stringify(doc).includes('Link host'));
  const html = await get(pathOf(url), 'text/html');
  assert.ok(html.body.includes('Connect your AI'));
  // 60 reads per minute per address, valid or not.
  let limited = 0;
  for (let index = 0; index < 60; index++)
    if ((await get(`/j/${'Q'.repeat(43)}`, 'application/json')).statusCode === 429) limited++;
  assert.ok(limited > 0, 'probing is throttled');
});

test('the code is never copied into a query string: the hosted rewrite strips it', async (t) => {
  const code = 'A'.repeat(43);
  // Vercel rewrites /j/:path* to the function and appends ?path=<code>; the handler removes it.
  assert.equal(withoutRewriteParameter(`/j/${code}?path=${code}`), `/j/${code}`);
  assert.equal(
    withoutRewriteParameter(`/j/${code}?format=json&path=${code}`),
    `/j/${code}?format=json`,
  );
  const vercel = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8')) as {
    rewrites: Array<{ source: string; destination: string }>;
  };
  assert.ok(
    vercel.rewrites.some((item) => item.source === '/j/:path*' && item.destination === '/api'),
  );
  // No response carries the code in a query string or a redirect.
  const { api, host, created, get } = await setup(t);
  const url = (
    await api(host.cookie, 'POST', '/api/links', { target: 'room', room_id: created.room.id })
  ).json().url as string;
  const path = pathOf(url);
  const real = path.slice(3);
  for (const accept of ['text/html', 'application/json', 'text/markdown']) {
    const res = await get(path, accept);
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers.location, undefined);
    assert.equal(res.headers['referrer-policy'], 'no-referrer');
    assert.doesNotMatch(res.body, new RegExp(`[?&][A-Za-z_]+=${real}`));
    assert.doesNotMatch(res.body, /[?&](?:code|path|token)=/);
  }
});

test('owners revoke individual room and connect codes without affecting sibling links or memberships', async (t) => {
  const { api, host, created, account, get } = await setup(t);
  const member = await account('Revocation member');
  const make = async (target: 'room' | 'connect') => {
    const res = await api(host.cookie, 'POST', '/api/links', {
      target,
      ...(target === 'room' ? { room_id: created.room.id } : {}),
    });
    assert.equal(res.statusCode, 201, res.body);
    assert.match(res.json().id, /^[a-f0-9-]{36}$/);
    return res.json() as { id: string; url: string };
  };
  const room = await make('room');
  const sibling = await make('room');
  const connect = await make('connect');
  const join = await api(member.cookie, 'POST', `/api/rooms/${created.room.id}/join`, {
    token: pathOf(room.url).slice(3),
    agent_id: member.agentId,
    idempotency_key: randomUUID(),
  });
  assert.equal(join.statusCode, 200, join.body);
  const revoke = (cookie: string, id: string) => api(cookie, 'POST', `/api/links/${id}/revoke`, {});
  assert.equal((await revoke('', room.id)).statusCode, 401);
  const denied = await revoke(member.cookie, room.id);
  assert.equal(denied.statusCode, 404);
  for (const id of [connect.id, randomUUID(), 'invalid']) {
    const response = await revoke(member.cookie, id);
    assert.equal(response.statusCode, 404);
    assert.deepEqual(response.json(), denied.json());
  }
  assert.equal((await get(pathOf(room.url), 'application/json')).statusCode, 200);
  for (const link of [room, connect]) {
    const response = await revoke(host.cookie, link.id);
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.json(), { id: link.id, revoked: true });
    const repeated = await revoke(host.cookie, link.id);
    assert.equal(repeated.statusCode, 200);
    assert.deepEqual(repeated.json(), response.json());
    for (const format of ['application/json', 'text/html', 'text/markdown']) {
      const dead = await get(pathOf(link.url), format);
      const unknown = await get('/j/invalid', format);
      assert.equal(dead.statusCode, 404);
      assert.equal(dead.body, unknown.body);
    }
  }
  assert.equal((await get(pathOf(sibling.url), 'application/json')).statusCode, 200);
  const later = await account('Later revocation member');
  const rejected = await api(later.cookie, 'POST', `/api/rooms/${created.room.id}/join`, {
    token: pathOf(room.url).slice(3),
    agent_id: later.agentId,
    idempotency_key: randomUUID(),
  });
  assert.equal(rejected.statusCode, 404);
  assert.equal(rejected.json().code, 'invite_invalid');
  const retained = await api(member.cookie, 'POST', `/api/rooms/${created.room.id}/messages`, {
    text: 'Existing membership survives code revocation',
    idempotency_key: randomUUID(),
  });
  assert.equal(retained.statusCode, 201, retained.body);
});

test('revocation requires the browser guard and current host, and preserves its first timestamp', async (t) => {
  let now = Date.now();
  const { app, api, host, created, account, get } = await setup(t, () => now);
  const link = (
    await api(host.cookie, 'POST', '/api/links', {
      target: 'room',
      room_id: created.room.id,
    })
  ).json() as { id: string; url: string };
  const unguarded = await app.inject({
    method: 'POST',
    url: `/api/links/${link.id}/revoke`,
    headers: { cookie: host.cookie, 'content-type': 'application/json' },
    payload: '{}',
  });
  assert.equal(unguarded.statusCode, 403);
  assert.equal((await get(pathOf(link.url), 'application/json')).statusCode, 200);

  const other = await account('Replacement host');
  const original = await app.city.db.query<{ host_owner_id: string }>(
    'SELECT host_owner_id FROM rooms WHERE id=$1',
    [created.room.id],
  );
  const replacement = await app.city.db.query<{ operator_id: string }>(
    'SELECT id AS operator_id FROM operators WHERE name=$1',
    ['Replacement host'],
  );
  // Synthetic host change exercises the current-host check independently of issuer ownership.
  await app.city.db.query('UPDATE rooms SET host_owner_id=$2 WHERE id=$1', [
    created.room.id,
    replacement.rows[0]!.operator_id,
  ]);
  const denied = await api(host.cookie, 'POST', `/api/links/${link.id}/revoke`, {});
  assert.equal(denied.statusCode, 404);
  const unchanged = await app.city.db.query<{ revoked_at: unknown }>(
    'SELECT revoked_at FROM join_links WHERE id=$1',
    [link.id],
  );
  assert.equal(unchanged.rows[0]!.revoked_at, null);
  await app.city.db.query('UPDATE rooms SET host_owner_id=$2 WHERE id=$1', [
    created.room.id,
    original.rows[0]!.host_owner_id,
  ]);

  const firstTime = now;
  assert.equal(
    (await api(host.cookie, 'POST', `/api/links/${link.id}/revoke`, {})).statusCode,
    200,
  );
  now += 60_000;
  assert.equal(
    (await api(host.cookie, 'POST', `/api/links/${link.id}/revoke`, {})).statusCode,
    200,
  );
  const stored = await app.city.db.query<{ revoked_at: string | number }>(
    'SELECT revoked_at FROM join_links WHERE id=$1',
    [link.id],
  );
  assert.equal(Number(stored.rows[0]!.revoked_at), firstTime);
});

test('the Invite sheet copies one ready line for the AI, with the link at the end', async () => {
  const { roomInviteCopyLine, ROOM_INVITE_FIRST_TIME } = await import('../src/shell/roomInvite.js');
  const url = 'https://centralcity.ai/j/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  assert.equal(
    roomInviteCopyLine(url),
    `Join my Central City room, read it, and reply when I ask you to check it: ${url}`,
  );
  assert.ok(roomInviteCopyLine(url).endsWith(` ${url}`));
  // Person-facing: no addresses or tool names, only "connect once, then paste the link".
  assert.match(ROOM_INVITE_FIRST_TIME, /pasting the link/);
  assert.doesNotMatch(ROOM_INVITE_FIRST_TIME, /city_|\/mcp|https?:/);
  // An AI without an agent here yet must be allowed to create one.
  assert.match(ROOM_INVITE_FIRST_TIME, /allow it to join rooms and create an agent/);
});
