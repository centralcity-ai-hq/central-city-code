import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { createApp } from '../server/app.js';
import { rpcResult } from './oauth-helpers.js';
import {
  normalizeShortCode,
  shortCodeHash,
  SHORT_CODE_LIMITS,
} from '../server/links/short-code.js';
import { cleanDisplayName, personMemberId, uuidV5 } from '../server/rooms/person.js';
import { taskReviewNotice } from '../server/wake/hooks.js';

process.env.CITY_INVITE_FLOW = '1';
process.env.CITY_RATE_LIMIT_KEY ??= 'synthetic-join-person-test-root-secret';

/**
 * Join a room as a person: short
 * codes, the person member (kind, room-unique name, per-room id), posting and @mentions without
 * any webhook delivery, host toggles, "Invite my AI" by room id, and the uniform invalid error.
 * Synthetic data only.
 */
const headers = {
  'content-type': 'application/json',
  'x-city-request': '1',
  host: 'centralcity.ai',
  origin: 'https://centralcity.ai',
};
let address = 40;

async function fixture(t: { after(fn: () => Promise<unknown>): void }) {
  const app = await createApp({
    database: await PGlite.create('memory://'),
    hosted: {
      databaseUrl: 'postgres://unused.invalid/test',
      publicOrigin: 'https://centralcity.ai',
      allowedOrigins: ['https://centralcity.ai'],
    },
    startWorkers: false,
  });
  t.after(() => app.close());
  const post = (url: string, body: unknown, extra = {}, remoteAddress = '203.0.113.12') =>
    app.inject({
      method: 'POST',
      url,
      headers: { ...headers, ...extra },
      payload: JSON.stringify(body),
      remoteAddress,
    });
  const get = (url: string, extra = {}) =>
    app.inject({ method: 'GET', url, headers: { ...headers, ...extra } });
  const account = async (name: string, agentName = `${name} agent`) => {
    const registered = await post(
      '/api/auth/register',
      { name, password: 'Synthetic join person password' },
      {},
      `203.0.113.${address++}`,
    );
    assert.equal(registered.statusCode, 201, registered.body);
    const cookie = `cc_session=${registered.cookies.find((c) => c.name === 'cc_session')!.value}`;
    const agent = await post(
      '/api/agents',
      { name: agentName, capability: 'research', mode: 'hosted' },
      { cookie },
    );
    assert.equal(agent.statusCode, 201, agent.body);
    return { cookie, agentId: agent.json().agent.id as string };
  };
  const host = await account('Tea host', 'Alex');
  const created = await post(
    '/api/rooms',
    { name: 'Tea room', agent_id: host.agentId, idempotency_key: randomUUID() },
    { cookie: host.cookie },
  );
  assert.equal(created.statusCode, 201, created.body);
  const roomId = created.json().room.id as string;
  const link = await post('/api/links', { target: 'room', room_id: roomId }, host);
  assert.equal(link.statusCode, 201, link.body);
  const joinPerson = (cookie: string, body: object, remoteAddress?: string) =>
    post(
      '/api/rooms/join',
      { idempotency_key: randomUUID(), ...body },
      { cookie },
      remoteAddress ?? '203.0.113.12',
    );
  const members = async (cookie = host.cookie) => {
    const res = await get(`/api/rooms/${roomId}/members`, { cookie });
    assert.equal(res.statusCode, 200, res.body);
    return res.json().members as Array<{ id: string; name: string; kind: string; own: boolean }>;
  };
  return {
    app,
    post,
    get,
    account,
    host,
    roomId,
    joinUrl: link.json().url as string,
    code: link.json().code as string,
    shortUrl: link.json().short_url as string,
    joinPerson,
    members,
  };
}

test('a co-owned AI workspace cannot join by invite as a person', async (t) => {
  const f = await fixture(t);
  const owner = await f.account('Workspace owner');
  const ai = await f.post('/api/public/workspaces', {
    name: 'Synthetic invited workspace',
    idempotency_key: randomUUID(),
  });
  assert.equal(ai.statusCode, 201, ai.body);
  const claimed = await f.post(
    '/api/workspaces/claim',
    {
      claim_token: ai.json().claim_token,
    },
    { cookie: owner.cookie },
  );
  assert.equal(claimed.statusCode, 200, claimed.body);
  const before = await f.members();
  for (const invite of [{ code: f.code }, { link: f.joinUrl }, { code: 'BBBB-BBBB' }]) {
    const response = await f.post(
      '/api/rooms/join',
      {
        ...invite,
        name: 'Not a person',
        idempotency_key: randomUUID(),
      },
      { cookie: owner.cookie, 'x-city-workspace': ai.json().workspace_id },
    );
    assert.equal(response.statusCode, 404, response.body);
    assert.equal(response.json().code, 'room_not_found');
  }
  assert.deepEqual(await f.members(), before);
  const human = await f.joinPerson(owner.cookie, { code: f.code });
  assert.equal(human.statusCode, 200, human.body);
});

test('short codes: 8 unambiguous characters, tolerant input; person ids are UUIDv5 per room', () => {
  assert.equal(normalizeShortCode(' 7k4m-q9xp '), '7K4MQ9XP');
  assert.equal(normalizeShortCode('7K4M Q9XP'), '7K4MQ9XP');
  assert.equal(normalizeShortCode('OIL1-2345'), '0111' + '2345');
  assert.equal(normalizeShortCode('7K4M-Q9X'), null);
  assert.equal(normalizeShortCode('7K4M-Q9XU'), null); // U is not in the alphabet
  // RFC 9562 test vector: UUIDv5 of "www.example.com" in the DNS namespace.
  assert.equal(
    uuidV5('www.example.com', '6ba7b810-9dad-11d1-80b4-00c04fd430c8'),
    '2ed6657d-e927-568b-95e1-2665a8aea6a2',
  );
  const operator = randomUUID();
  assert.equal(personMemberId(operator, 'room-a'), personMemberId(operator, 'room-a'));
  assert.notEqual(personMemberId(operator, 'room-a'), personMemberId(operator, 'room-b'));
  assert.equal(cleanDisplayName('  Ann‮​  Lee\n'), 'Ann Lee');
});

test('a person joins with the short code, posts as "person", and is mentioned without webhooks', async (t) => {
  const f = await fixture(t);
  assert.match(f.code, /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
  assert.equal(f.shortUrl, `https://centralcity.ai/j/${f.code}`);
  const ann = await f.account('Ann');
  // Tolerant input: lowercase, spaces instead of a dash. The name clashes with the host's AI.
  const joined = await f.joinPerson(ann.cookie, {
    code: f.code.toLowerCase().replace('-', ' '),
    name: ' alex ',
  });
  assert.equal(joined.statusCode, 200, joined.body);
  assert.equal(joined.json().room.id, f.roomId);
  const list = await f.members(ann.cookie);
  const me = list.find((m) => m.own)!;
  assert.equal(me.kind, 'person');
  assert.equal(me.name, 'alex-2', 'a person never takes an AI member name');
  assert.equal(list.find((m) => m.name === 'Alex')!.kind, 'agent');

  // The person posts as themselves.
  const posted = await f.post(
    `/api/rooms/${f.roomId}/messages`,
    { text: 'Hello, I am here in person', idempotency_key: randomUUID() },
    { cookie: ann.cookie },
  );
  assert.equal(posted.statusCode, 201, posted.body);
  assert.equal(posted.json().message.sender_kind, 'person');
  assert.equal(posted.json().message.sender, 'alex-2');
  // A person's post is not an AI's "messages sent" (migration 75 counts sender_kind 'agent').
  const counted = await f.app.city.db.query(
    'SELECT 1 FROM agent_message_counts WHERE agent_id=$1',
    [me.id],
  );
  assert.equal(counted.rows.length, 0, 'no counter row for a person');

  // The host's AI mentions the person: a mention row, no webhook delivery. (Its own name is no
  // mention; the host writes in its AI's name, as without agent_id the post is its person's.)
  const mention = await f.post(
    `/api/rooms/${f.roomId}/messages`,
    {
      text: 'Welcome @alex-2, and hi @Alex',
      agent_id: f.host.agentId,
      idempotency_key: randomUUID(),
    },
    { cookie: f.host.cookie },
  );
  assert.equal(mention.statusCode, 201, mention.body);
  const mentions = await f.app.city.db.query<{ agent_id: string }>(
    'SELECT agent_id FROM mentions WHERE room_id=$1',
    [f.roomId],
  );
  assert.deepEqual(
    mentions.rows.map((row) => row.agent_id),
    [me.id],
  );
  const outbox = await f.app.city.db.query('SELECT 1 FROM wake_outbox WHERE agent_id=$1', [me.id]);
  assert.equal(outbox.rows.length, 0, 'a person mention never enqueues a webhook delivery');
  const read = await f.get(`/api/rooms/${f.roomId}/messages?since=0`, { cookie: ann.cookie });
  const flagged = (read.json().messages as Array<{ text: string; mentions_you: boolean }>).find(
    (m) => m.text.startsWith('Welcome'),
  )!;
  assert.equal(flagged.mentions_you, true);

  // The host log names the person.
  const snapshot = await f.get('/api/snapshot', { cookie: f.host.cookie });
  assert.ok(
    (snapshot.json().events as Array<{ message: string }>).some((e) =>
      e.message.includes('alex-2 (a person) joined your room Tea room'),
    ),
  );
});

test('bad codes answer one uniform error and are rate-limited; /j/<CODE> offers "Join as yourself"', async (t) => {
  const f = await fixture(t);
  const bob = await f.account('Bob');
  for (const code of ['AAAA-AAAA', 'not a code', 'https://centralcity.ai/j/ZZZZ-ZZZZ']) {
    const res = await f.joinPerson(bob.cookie, code.startsWith('http') ? { link: code } : { code });
    assert.equal(res.statusCode, code === 'not a code' ? 404 : 404, `${code}: ${res.body}`);
    assert.equal(res.json().code, 'invite_invalid');
  }
  // The same code through the join-link page: people get "Join as yourself", AIs the steps.
  const page = await f.app.inject({
    method: 'GET',
    url: `/j/${f.code.toLowerCase()}`,
    headers: { accept: 'text/html', host: 'centralcity.ai' },
  });
  assert.equal(page.statusCode, 200, page.body);
  assert.match(page.body, /Join as yourself/);
  assert.match(page.body, /city_join_invite/);
  const bad = await f.app.inject({
    method: 'GET',
    url: '/j/AAAA-AAAA',
    headers: { accept: 'application/json', host: 'centralcity.ai' },
  });
  assert.equal(bad.statusCode, 404);
  // Every short-code attempt counts per account: the 31st in an hour is refused.
  let limited = 0;
  for (let i = 0; i < 30; i++) {
    const res = await f.joinPerson(bob.cookie, { code: 'BBBB-BBBB' });
    if (res.statusCode === 429) limited++;
  }
  assert.ok(limited > 0, 'short-code attempts are rate-limited per account');
});

test('host toggles, Invite my AI by room id, removal, and one person per account per room', async (t) => {
  const f = await fixture(t);
  const cy = await f.account('Cy');
  // People may join: off -> refused; on again -> joins.
  const off = await f.post(
    `/api/rooms/${f.roomId}/people`,
    { people_may_join: false },
    { cookie: f.host.cookie },
  );
  assert.equal(off.statusCode, 200, off.body);
  assert.equal(off.json().room.people_may_join, false);
  const refused = await f.joinPerson(cy.cookie, { link: f.joinUrl, name: 'Cy' });
  assert.equal(refused.statusCode, 403, refused.body);
  assert.equal(refused.json().code, 'people_join_off');
  await f.post(
    `/api/rooms/${f.roomId}/people`,
    { people_may_join: true },
    { cookie: f.host.cookie },
  );
  const joined = await f.joinPerson(cy.cookie, { link: f.joinUrl, name: 'Cy' });
  assert.equal(joined.statusCode, 200, joined.body);
  // Joining again (another key) is the same single person member.
  const again = await f.joinPerson(cy.cookie, { link: f.joinUrl, name: 'Cy again' });
  assert.equal(again.statusCode, 200, again.body);
  assert.equal((await f.members()).filter((m) => m.kind === 'person' && !m.own).length, 1);

  // Invite my AI: the person's own agent joins by room id, no link.
  const bring = () =>
    f.post(
      `/api/rooms/${f.roomId}/join`,
      { agent_id: cy.agentId, idempotency_key: randomUUID() },
      { cookie: cy.cookie },
    );
  const brought = await bring();
  assert.equal(brought.statusCode, 200, brought.body);
  assert.equal(brought.json().joined, true);
  const snapshot = await f.get('/api/snapshot', { cookie: f.host.cookie });
  assert.ok(
    (snapshot.json().events as Array<{ message: string }>).some((e) =>
      e.message.includes('Cy added their AI Cy agent'),
    ),
  );
  // Someone who is not in the room as a person cannot use room id alone.
  const dee = await f.account('Dee');
  const outsider = await f.post(
    `/api/rooms/${f.roomId}/join`,
    { agent_id: dee.agentId, idempotency_key: randomUUID() },
    { cookie: dee.cookie },
  );
  assert.equal(outsider.statusCode, 404, outsider.body);
  // The host can switch "members may bring their AI" off.
  await f.post(
    `/api/rooms/${f.roomId}/people`,
    { members_may_bring_ai: false },
    { cookie: f.host.cookie },
  );
  const second = await f.post(
    '/api/agents',
    { name: 'Cy second', capability: 'research', mode: 'hosted' },
    { cookie: cy.cookie },
  );
  const blocked = await f.post(
    `/api/rooms/${f.roomId}/join`,
    { agent_id: second.json().agent.id, idempotency_key: randomUUID() },
    { cookie: cy.cookie },
  );
  assert.equal(blocked.statusCode, 403, blocked.body);
  assert.equal(blocked.json().code, 'bring_ai_off');
  // The member's own room view says so ("Add my AI" hides), without the host-only settings.
  const memberRoom = (await f.get('/api/rooms', { cookie: cy.cookie }))
    .json()
    .rooms.find((r: { id: string }) => r.id === f.roomId);
  assert.equal(memberRoom.members_may_bring_ai, false);
  assert.equal(memberRoom.people_may_join, undefined);
  assert.equal(memberRoom.guest_blocks, undefined);

  // Removing the person does not remove their AI (documented); the person cannot rejoin.
  // (Cy, not the host's own person: the host is in its room as itself from creation.)
  const person = (await f.members()).find((m) => m.kind === 'person' && !m.own)!;
  const removed = await f.post(
    `/api/rooms/${f.roomId}/members/${person.id}/remove`,
    {},
    { cookie: f.host.cookie },
  );
  assert.equal(removed.statusCode, 200, removed.body);
  assert.ok(
    (await f.members()).some((m) => m.id === cy.agentId),
    'the AI stays until removed',
  );
  const back = await f.joinPerson(cy.cookie, { link: f.joinUrl, name: 'Cy' });
  assert.equal(back.statusCode, 403, back.body);
});

test('an AI joins with the bare short code on /mcp/open (city_join_invite)', async (t) => {
  const f = await fixture(t);
  const response = await f.app.inject({
    method: 'POST',
    url: '/mcp/open',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      host: 'centralcity.ai',
      'x-forwarded-proto': 'https',
    },
    payload: {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'city_join_invite',
        arguments: { invite_link: f.code.toLowerCase(), name: 'Code AI' },
      },
    },
    remoteAddress: '203.0.113.99',
  });
  assert.equal(response.statusCode, 200, response.body);
  const result = rpcResult(response.body).result;
  assert.ok(!result.isError, JSON.stringify(result));
  assert.equal(result.structuredContent.room_id, f.roomId);
});

test('an AI of the same account can never post as the person or make them leave', async (t) => {
  const f = await fixture(t);
  const eve = await f.account('Eve');
  assert.equal((await f.joinPerson(eve.cookie, { link: f.joinUrl, name: 'Eve' })).statusCode, 200);
  const person = (await f.members(eve.cookie)).find((m) => m.own)!;
  // An assistant grant for the same account (the dispatch every AI tool call uses).
  const minted = await f.post(
    '/api/assistant-access',
    { label: 'Eve AI', scopes: ['workspace:read', 'rooms:join'], expiresInDays: 1 },
    { cookie: eve.cookie },
  );
  assert.equal(minted.statusCode, 201, minted.body);
  const key = minted.json().token as string;
  const tool = (name: string, args: object) =>
    f.post(`/api/assistant/tools/${name}`, args, { authorization: `Bearer ${key}` });
  const asPerson = await tool('city_room_post', {
    room_id: f.roomId,
    agent_id: person.id,
    text: 'I am Eve',
    idempotency_key: randomUUID(),
  });
  assert.equal(asPerson.statusCode, 403, asPerson.body);
  const implicit = await tool('city_room_post', {
    room_id: f.roomId,
    text: 'I am Eve',
    idempotency_key: randomUUID(),
  });
  assert.equal(implicit.statusCode, 403, implicit.body);
  const leave = await tool('city_room_leave', { room_id: f.roomId, agent_id: person.id });
  assert.equal(leave.statusCode, 404, leave.body);
  assert.ok(
    (await f.members()).some((m) => m.id === person.id),
    'the person is still there',
  );
});

test('GET /j/<short code> spends the per-address short-code budget before any lookup', async (t) => {
  const f = await fixture(t);
  const probe = (code: string, remoteAddress = '198.51.100.7') =>
    f.app.inject({
      method: 'GET',
      url: `/j/${code}`,
      headers: { accept: 'application/json', host: 'centralcity.ai' },
      remoteAddress,
    });
  let limited = 0;
  for (let i = 0; i < 101; i++) {
    const res = await probe('CCCC-CCCC');
    if (res.statusCode === 429) limited++;
  }
  assert.ok(limited > 0, 'the 101st short-code probe in an hour is refused');
  // Even a valid code is refused once the address budget is spent: nothing to learn.
  assert.equal((await probe(f.code)).statusCode, 429);
  // Another address still resolves the valid code; long codes keep their own limit.
  // (Budgets are per network source, so use another /24.)
  assert.equal((await probe(f.code, '192.0.2.8')).statusCode, 200);
  const long = f.joinUrl.split('/j/')[1]!;
  assert.equal((await probe(long, '192.0.2.9')).statusCode, 200);
});

test('P3: short codes are stored under a keyed HMAC; an unkeyed hash no longer resolves', async (t) => {
  const f = await fixture(t);
  const short = normalizeShortCode(f.code)!;
  const unkeyed = createHash('sha256').update(`join-short:${short}`).digest('hex');
  const stored = await f.app.city.db.query<{ short_hash: string }>(
    'SELECT short_hash FROM join_links WHERE short_hash IS NOT NULL',
  );
  assert.equal(stored.rows.length, 1);
  assert.equal(stored.rows[0]!.short_hash, shortCodeHash(short));
  assert.notEqual(stored.rows[0]!.short_hash, unkeyed, 'not the unkeyed hash');
  // The unkeyed fallback is gone: a row stored under the old hash no longer matches the code.
  await f.app.city.db.query('UPDATE join_links SET short_hash=$1', [unkeyed]);
  const ann = await f.account('Ann');
  const joined = await f.joinPerson(ann.cookie, { code: f.code, name: 'Ann' });
  assert.notEqual(joined.statusCode, 200, joined.body);
});

test('P3: an AI cannot join under the name of a person in the room', async (t) => {
  const f = await fixture(t);
  const ann = await f.account('Ann', 'Ann AI');
  assert.equal(
    (await f.joinPerson(ann.cookie, { link: f.joinUrl, name: 'Robin' })).statusCode,
    200,
  );
  const other = await f.account('Other', 'robin');
  const clash = await f.post(
    `/api/rooms/${f.roomId}/join`,
    { link: f.joinUrl, agent_id: other.agentId, idempotency_key: randomUUID() },
    { cookie: other.cookie },
  );
  assert.equal(clash.statusCode, 409, clash.body);
  assert.equal(clash.json().code, 'name_taken');
  // A different name joins.
  const fine = await f.post(
    `/api/rooms/${f.roomId}/join`,
    { link: f.joinUrl, create: { name: 'Robin the AI' }, idempotency_key: randomUUID() },
    { cookie: other.cookie },
  );
  assert.equal(fine.statusCode, 200, fine.body);
});

test('P3: a global short-code budget bounds guesses across every caller', async (t) => {
  const f = await fixture(t);
  // A tiny global budget for the test: three different accounts spend it, the fourth is refused
  // before any lookup, and the full invite link keeps working.
  const limits = SHORT_CODE_LIMITS as { attemptsGlobalPerHour: number };
  const original = limits.attemptsGlobalPerHour;
  limits.attemptsGlobalPerHour = 3;
  t.after(() => {
    limits.attemptsGlobalPerHour = original;
  });
  for (const name of ['G1', 'G2', 'G3']) {
    const guesser = await f.account(name);
    const miss = await f.joinPerson(guesser.cookie, { code: 'DDDD-DDDD' }, '192.0.2.50');
    assert.equal(miss.statusCode, 404, miss.body);
  }
  const bea = await f.account('Bea');
  const refused = await f.joinPerson(bea.cookie, { code: f.code, name: 'Bea' }, '198.18.0.9');
  assert.equal(refused.statusCode, 429, refused.body);
  const viaLink = await f.joinPerson(bea.cookie, { link: f.joinUrl, name: 'Bea' }, '198.18.0.9');
  assert.equal(viaLink.statusCode, 200, viaLink.body);
});

test('names are compared and stored without invisible characters (no "Rob"+ZWSP+"in" posing as Robin)', async (t) => {
  const f = await fixture(t);
  const ann = await f.account('Ann', 'Ann AI');
  assert.equal(
    (await f.joinPerson(ann.cookie, { link: f.joinUrl, name: 'Robin' })).statusCode,
    200,
  );
  // An existing agent whose name hides a zero-width space and a bidi mark.
  const sneaky = await f.account('Sneaky', 'Rob​in‬');
  const clash = await f.post(
    `/api/rooms/${f.roomId}/join`,
    { link: f.joinUrl, agent_id: sneaky.agentId, idempotency_key: randomUUID() },
    { cookie: sneaky.cookie },
  );
  assert.equal(clash.statusCode, 409, clash.body);
  assert.equal(clash.json().code, 'name_taken');
  // A new agent created on the join path is stored cleaned, and is refused the same way.
  const created = await f.post(
    `/api/rooms/${f.roomId}/join`,
    { link: f.joinUrl, create: { name: 'ROB⁠IN' }, idempotency_key: randomUUID() },
    { cookie: sneaky.cookie },
  );
  assert.equal(created.statusCode, 409, created.body);
  const other = await f.post(
    `/api/rooms/${f.roomId}/join`,
    { link: f.joinUrl, create: { name: 'Hel​lo' }, idempotency_key: randomUUID() },
    { cookie: sneaky.cookie },
  );
  assert.equal(other.statusCode, 200, other.body);
  const names = (await f.members()).map((m) => m.name);
  assert.ok(names.includes('Hello'), JSON.stringify(names));
  // An invited AI (no account) cannot take the person's name either.
  const start = await f.post('/api/public/invites/bootstrap', {
    code: f.joinUrl.split('/j/')[1],
  });
  assert.equal(start.statusCode, 200, start.body);
  const guest = await f.post('/api/public/invites/redeem', {
    code: f.joinUrl.split('/j/')[1],
    handle: start.json().handle,
    name: 'Rob​in',
  });
  assert.equal(guest.statusCode, 409, guest.body);
  assert.equal(guest.json().code, 'name_taken');
});

test('a person who joined by invite adds and takes room tasks as themselves', async (t) => {
  const previous = process.env.CITY_ROOM_TASKS;
  process.env.CITY_ROOM_TASKS = '1';
  t.after(() => {
    if (previous === undefined) delete process.env.CITY_ROOM_TASKS;
    else process.env.CITY_ROOM_TASKS = previous;
  });
  const f = await fixture(t);
  // An account with no agent of its own joins as a person.
  const registered = await f.post(
    '/api/auth/register',
    { name: 'Tasker', password: 'Synthetic join person password' },
    {},
    `203.0.113.${address++}`,
  );
  assert.equal(registered.statusCode, 201, registered.body);
  const cookie = `cc_session=${registered.cookies.find((c) => c.name === 'cc_session')!.value}`;
  const joined = await f.joinPerson(cookie, { code: f.code, name: 'Tasker' });
  assert.equal(joined.statusCode, 200, joined.body);
  const me = (await f.members(cookie)).find((m) => m.own)!;
  assert.equal(me.kind, 'person');
  const created = await f.post(
    `/api/rooms/${f.roomId}/tasks`,
    { title: 'Bring the slides', idempotency_key: randomUUID() },
    { cookie },
  );
  assert.equal(created.statusCode, 201, created.body);
  assert.equal(created.json().task.created_by_agent_id, me.id);
  const claimed = await f.post(
    `/api/rooms/${f.roomId}/tasks/${created.json().task.id}/claim`,
    { idempotency_key: randomUUID() },
    { cookie },
  );
  assert.equal(claimed.statusCode, 200, claimed.body);
  // Review stays with the host.
  const review = await f.post(
    `/api/rooms/${f.roomId}/tasks/${created.json().task.id}/update`,
    { decision: 'cancel' },
    { cookie },
  );
  assert.equal(review.statusCode, 403, review.body);
});

test('"Mute all AIs" with the person spared: the view still says mute_scope "ai" so the composer drops the AI', async (t) => {
  const f = await fixture(t);
  const cy = await f.account('Cy');
  assert.equal((await f.joinPerson(cy.cookie, { link: f.joinUrl, name: 'Cy' })).statusCode, 200);
  const brought = await f.post(
    `/api/rooms/${f.roomId}/join`,
    { agent_id: cy.agentId, idempotency_key: randomUUID() },
    { cookie: cy.cookie },
  );
  assert.equal(brought.statusCode, 200, brought.body);
  const view = async () =>
    (await f.get('/api/rooms', { cookie: cy.cookie }))
      .json()
      .rooms.find((r: { id: string }) => r.id === f.roomId);
  assert.equal((await view()).mute_scope, null);
  const muted = await f.post(
    `/api/rooms/${f.roomId}/mute-ais`,
    { muted: true },
    { cookie: f.host.cookie },
  );
  assert.equal(muted.statusCode, 200, muted.body);
  // Cy still posts as the person, so it is not muted; but its AI is, and the view says so.
  const room = await view();
  assert.equal(room.muted, false);
  assert.equal(room.mute_scope, 'ai');
  const post = (agentId: string) =>
    f.post(
      `/api/rooms/${f.roomId}/messages`,
      { agent_id: agentId, text: 'Hello', idempotency_key: randomUUID() },
      { cookie: cy.cookie },
    );
  const asAi = await post(cy.agentId);
  assert.equal(asAi.json().code, 'muted_in_room', asAi.body);
  const person = (await f.members(cy.cookie)).find((m) => m.own && m.kind === 'person')!;
  assert.equal((await post(person.id)).statusCode, 201);
  // Unmuted again, nothing is reported.
  await f.post(`/api/rooms/${f.roomId}/mute-ais`, { muted: false }, { cookie: f.host.cookie });
  assert.equal((await view()).mute_scope, null);
});

test('"Mute all AIs" keeps the person member mentionable (posts and peer-review notices), not its AI', async (t) => {
  const f = await fixture(t);
  const cy = await f.account('Cy', 'Cy helper');
  assert.equal((await f.joinPerson(cy.cookie, { link: f.joinUrl, name: 'Cy' })).statusCode, 200);
  const brought = await f.post(
    `/api/rooms/${f.roomId}/join`,
    { agent_id: cy.agentId, idempotency_key: randomUUID() },
    { cookie: cy.cookie },
  );
  assert.equal(brought.statusCode, 200, brought.body);
  const person = (await f.members(cy.cookie)).find((m) => m.own && m.kind === 'person')!;
  const muted = await f.post(
    `/api/rooms/${f.roomId}/mute-ais`,
    { muted: true },
    { cookie: f.host.cookie },
  );
  assert.equal(muted.statusCode, 200, muted.body);
  const mentioned = async (seq: number) =>
    (
      await f.app.city.db.query<{ agent_id: string }>(
        'SELECT agent_id FROM mentions WHERE room_id=$1 AND source_seq=$2 ORDER BY agent_id',
        [f.roomId, seq],
      )
    ).rows.map((row) => row.agent_id);
  // An @mention of both: the person gets a mention row, the bulk-muted AI none.
  const posted = await f.post(
    `/api/rooms/${f.roomId}/messages`,
    {
      text: 'Hi @Cy and @Cy-helper',
      agent_id: f.host.agentId,
      idempotency_key: randomUUID(),
    },
    { cookie: f.host.cookie },
  );
  assert.equal(posted.statusCode, 201, posted.body);
  assert.deepEqual(await mentioned(posted.json().message.seq), [person.id]);
  // A peer-review notice naming both: the same.
  const line = await f.post(
    `/api/rooms/${f.roomId}/messages`,
    { text: 'Review requested', agent_id: f.host.agentId, idempotency_key: randomUUID() },
    { cookie: f.host.cookie },
  );
  assert.equal(line.statusCode, 201, line.body);
  const seq = line.json().message.seq as number;
  await f.app.city.db.transaction((tx) =>
    taskReviewNotice(tx, {
      roomId: f.roomId,
      seq,
      agentIds: [person.id, cy.agentId],
      fromAgentId: f.host.agentId,
      fromName: 'Alex',
      text: 'Review requested',
      time: Date.now(),
    }),
  );
  assert.deepEqual(await mentioned(seq), [person.id]);
});
