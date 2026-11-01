import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/app.js';
import { bareInviteCode, inviteCodeFrom, pastedLink, PASTE_HINT } from '../server/links/paste.js';
import { parseInvite } from '../server/rooms/service.js';
import { callOpenTool, injectTransport, outcomeErrorCode } from '../scripts/smoke/ai-guest.js';
import { sessionPair } from './session-cookie-pair.js';

process.env.CITY_INVITE_FLOW = '1';
process.env.CITY_RATE_LIMIT_KEY ??= 'synthetic-paste-test-root-not-a-real-secret';

// Relay live test of production (2026-09-29): pasted invitations were refused for a trailing
// slash, surrounding spaces, a missing https://, a www. host or a link inside a sentence, and the
// REST bootstrap refused the full /j/ link ("code (must be text)").
const ORIGIN = 'https://centralcity.ai';
const SHORT = '7K4M-Q9XP';
const CANON = '7K4MQ9XP';
const JOIN = 'a'.repeat(21) + '_-' + 'B'.repeat(20);

test('forgiving paste: every harmless form resolves to the same code', () => {
  for (const input of [
    SHORT,
    ` ${SHORT} `,
    '7k4m q9xp',
    `${ORIGIN}/j/${SHORT}`,
    `${ORIGIN}/j/${SHORT}/`,
    `  ${ORIGIN}/j/${SHORT}  `,
    `\n${ORIGIN}/j/${SHORT}\n`,
    `centralcity.ai/j/${SHORT}`,
    `www.centralcity.ai/j/${SHORT}`,
    `https://www.centralcity.ai/j/${SHORT}`,
    `http://centralcity.ai/j/${SHORT}`,
    `HTTPS://CentralCity.AI/j/${SHORT}`,
    `${ORIGIN}/j/${SHORT.toLowerCase()}`,
    `Join my room: ${ORIGIN}/j/${SHORT}`,
    `Join my room: ${ORIGIN}/j/${SHORT}.`,
    `Join my room (${ORIGIN}/j/${SHORT}), see you there!`,
    `Can you join ${ORIGIN}/j/${SHORT}?`,
    `Here: ${ORIGIN}/j/${SHORT}/.`,
    `“${ORIGIN}/j/${SHORT}”`,
    `<${ORIGIN}/j/${SHORT}>`,
    `first ${ORIGIN}/j/${SHORT} then ${ORIGIN}/j/ZZZZ-ZZZZ`,
  ])
    assert.equal(inviteCodeFrom(input, ORIGIN), CANON, JSON.stringify(input));
  assert.equal(inviteCodeFrom(`${ORIGIN}/j/${JOIN}/`, ORIGIN), JOIN);
  assert.equal(inviteCodeFrom(` ${JOIN} `, ORIGIN), JOIN);
  const rejoin = `rejoin.${'A'.repeat(22)}.k2f1a0.${'C'.repeat(43)}`;
  assert.equal(inviteCodeFrom(`Your rejoin link: ${ORIGIN}/j/${rejoin}.`, ORIGIN), rejoin);
  assert.equal(bareInviteCode(rejoin), rejoin);
  // Local development origins with a port.
  assert.equal(inviteCodeFrom(`localhost:4311/j/${SHORT}/`, 'http://localhost:4311'), CANON);
});

test('forgiving paste still refuses other hosts, user info, queries, fragments and junk', () => {
  for (const input of [
    `https://evil.example/j/${SHORT}`,
    `https://centralcity.ai.evil.example/j/${SHORT}`,
    `https://evilcentralcity.ai/j/${SHORT}`,
    `https://user@centralcity.ai/j/${SHORT}`,
    `https://evil.example@centralcity.ai/j/${SHORT}`,
    `me@centralcity.ai/j/${SHORT}`,
    `${ORIGIN}/j/${SHORT}?utm_source=x`,
    `${ORIGIN}/j/${SHORT}#frag`,
    `${ORIGIN}/j/${SHORT}/extra`,
    `${ORIGIN}/j/`,
    `${ORIGIN}/r/some-room#crr_${'A'.repeat(43)}`,
    `${ORIGIN}/j/ABC`,
    'hello there',
    '',
    '   ',
    `${' '.repeat(2048)}${SHORT}x`,
  ])
    assert.equal(inviteCodeFrom(input, ORIGIN), null, JSON.stringify(input));
  assert.equal(inviteCodeFrom(`${ORIGIN}/j/${SHORT}`, 'not an origin'), null);
});

test('pastedLink finds room and join links for the signed-in join (parseInvite)', () => {
  assert.equal(
    pastedLink(`Join: centralcity.ai/r/team-room#crr_${'A'.repeat(43)} thanks`),
    `https://centralcity.ai/r/team-room#crr_${'A'.repeat(43)}`,
  );
  assert.equal(pastedLink(`  ${ORIGIN}/j/${SHORT}/ `), `${ORIGIN}/j/${SHORT}`);
  assert.equal(pastedLink('no link here'), null);
  const room = parseInvite({ link: `Please join ${ORIGIN}/r/team-room#crr_${'A'.repeat(43)}.` });
  assert.deepEqual(room, {
    kind: 'token',
    secret: `crr_${'A'.repeat(43)}`,
    roomRef: 'team-room',
  });
  assert.deepEqual(parseInvite({ link: ` centralcity.ai/j/${SHORT}/ ` }, ORIGIN), {
    kind: 'short',
    secret: CANON,
    roomRef: null,
  });
  assert.deepEqual(parseInvite({ link: `${ORIGIN}/j/${JOIN}` }, ORIGIN), {
    kind: 'code',
    secret: JOIN,
    roomRef: null,
  });
});

async function fixture(t: { after(fn: () => Promise<unknown>): void }) {
  let time = Date.now();
  const app = await createApp({
    database: await PGlite.create('memory://'),
    hosted: {
      databaseUrl: 'postgres://unused.invalid/test',
      publicOrigin: ORIGIN,
      allowedOrigins: [ORIGIN],
    },
    startWorkers: false,
    now: () => time,
  });
  t.after(() => app.close());
  const headers = {
    'content-type': 'application/json',
    'x-city-request': '1',
    host: 'centralcity.ai',
    origin: ORIGIN,
  };
  const post = (url: string, body: unknown, extra = {}) =>
    app.inject({
      method: 'POST',
      url,
      headers: { ...headers, ...extra },
      payload: JSON.stringify(body),
      remoteAddress: '203.0.113.12',
    });
  const registered = await post('/api/auth/register', {
    name: 'Paste host',
    password: 'Synthetic paste test password',
  });
  assert.equal(registered.statusCode, 201, registered.body);
  const host = {
    cookie: sessionPair(registered.cookies),
  };
  const agent = await post(
    '/api/agents',
    { name: 'Host', capability: 'research', mode: 'hosted' },
    host,
  );
  assert.equal(agent.statusCode, 201, agent.body);
  const room = async (name: string) => {
    const created = await post(
      '/api/rooms',
      { name, agent_id: agent.json().agent.id, idempotency_key: randomUUID() },
      host,
    );
    assert.equal(created.statusCode, 201, created.body);
    const link = await post(
      '/api/links',
      { target: 'room', room_id: created.json().room.id },
      host,
    );
    assert.equal(link.statusCode, 201, link.body);
    // The join link's own id must not shadow the room id.
    const { url, code } = link.json() as { url: string; code: string };
    return { id: created.json().room.id as string, url, code };
  };
  const invoke = (credential: string | null, tool: string, args: unknown = {}) =>
    post(
      `/api/public/invites/tools/${tool}`,
      args,
      credential === null ? {} : { authorization: `Bearer ${credential}` },
    );
  const transport = injectTransport(async (req) => {
    const res = await app.inject({
      method: req.method,
      url: req.path,
      headers: {
        host: 'centralcity.ai',
        'x-forwarded-proto': 'https',
        ...(req.accept ? { accept: req.accept } : {}),
        ...(req.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...req.headers,
      },
      ...(req.body === undefined ? {} : { payload: JSON.stringify(req.body) }),
      remoteAddress: '203.0.113.12',
    });
    return { statusCode: res.statusCode, body: res.body };
  }, ORIGIN);
  return {
    post,
    room,
    invoke,
    transport,
    now: () => time,
    advance: (ms: number) => {
      time += ms;
    },
  };
}

test('REST bootstrap and redeem accept the full link, in a sentence, and say what to paste', async (t) => {
  const f = await fixture(t);
  const room = await f.room('Paste room');
  const pasted = ` Join my room: ${room.url}/ `;
  const start = await f.post('/api/public/invites/bootstrap', { code: pasted });
  assert.equal(start.statusCode, 200, start.body);
  // The redeem may paste the same link in another harmless form.
  const joined = await f.post('/api/public/invites/redeem', {
    code: room.url.replace('https://', 'www.'),
    handle: start.json().handle,
    name: 'Paste guest',
  });
  assert.equal(joined.statusCode, 200, joined.body);
  // One lifetime for every guest credential: 24 hours.
  assert.equal(Date.parse(joined.json().expires_at) - f.now(), 24 * 3_600_000);
  for (const code of ['hello there', `https://evil.example/j/${room.code}`, `${room.url}?x=1`]) {
    const refused = await f.post('/api/public/invites/bootstrap', { code });
    assert.equal(refused.statusCode, 400, refused.body);
    assert.equal(refused.json().code, 'invalid_request');
    assert.equal(refused.json().error, PASTE_HINT);
  }
  const wrong = await f.post('/api/public/invites/bootstrap', { code: 'ZZZZ-ZZZZ' });
  assert.equal(wrong.statusCode, 404, wrong.body);
  assert.equal(wrong.json().code, 'invite_invalid');
  assert.equal(
    wrong.json().error,
    'This invite link is invalid, expired, used up or revoked: ask the host for a new link.',
  );
});

test('guest REST tools: 401 without a usable credential, 404 for unknown tools, 403 for another room', async (t) => {
  const f = await fixture(t);
  const room = await f.room('Guest room');
  const other = await f.room('Other room');
  const start = await f.post('/api/public/invites/bootstrap', { code: room.url });
  const guest = (
    await f.post('/api/public/invites/redeem', {
      code: room.url,
      handle: start.json().handle,
      name: 'Guest',
    })
  ).json() as { credential: string; agent_id: string };
  const unusable = [null, 'crc_short', `crc_${'A'.repeat(43)}`, 'not-even-a-crc'];
  for (const credential of unusable) {
    const read = await f.invoke(credential, 'city_room_read');
    assert.equal(read.statusCode, 401, read.body);
    // The REST answer also carries the shared recovery hint (error-guidance.ts), never the value.
    assert.deepEqual(read.json(), {
      error: 'Missing or invalid room credential: join with an invite link first.',
      code: 'room_credential_invalid',
      hint: 'Renew with POST /api/public/invites/renew (or city_room_renew on /mcp/open), or ask the host for a rejoin link and use your recovery code.',
    });
    if (credential) assert.ok(!read.body.includes(credential), 'the credential is never echoed');
  }
  const renew = await f.post('/api/public/invites/renew', {});
  assert.equal(renew.statusCode, 401, renew.body);
  assert.equal(renew.json().code, 'room_credential_invalid');
  // Unknown tools are 404 whatever the credential, and name the guest tools.
  for (const credential of [null, guest.credential]) {
    const unknown = await f.invoke(credential, 'city_create_room');
    assert.equal(unknown.statusCode, 404, unknown.body);
    assert.equal(unknown.json().code, 'unknown_tool');
    assert.match(unknown.json().error, /city_room_read, city_room_post/);
  }
  // A valid credential used for another room or member is the only 403.
  const foreign = await f.invoke(guest.credential, 'city_room_read', { room_id: other.id });
  assert.equal(foreign.statusCode, 403, foreign.body);
  assert.equal(foreign.json().code, 'room_credential_denied');
  const impostor = await f.invoke(guest.credential, 'city_room_members', {
    agent_id: randomUUID(),
  });
  assert.equal(impostor.statusCode, 403, impostor.body);
  assert.equal((await f.invoke(guest.credential, 'city_room_read')).statusCode, 200);
  // Renewing gives 24 hours on REST too; the old credential then reads only, for 10 minutes.
  const renewed = await f.post(
    '/api/public/invites/renew',
    {},
    { authorization: `Bearer ${guest.credential}` },
  );
  assert.equal(renewed.statusCode, 200, renewed.body);
  assert.equal(Date.parse(renewed.json().expires_at) - f.now(), 24 * 3_600_000);
  assert.equal((await f.invoke(guest.credential, 'city_room_read')).statusCode, 200);
  const write = await f.invoke(guest.credential, 'city_room_post', {
    text: 'With the old credential.',
    idempotency_key: randomUUID(),
  });
  assert.equal(write.statusCode, 401, write.body);
  assert.match(write.json().hint, /You already renewed/);
  f.advance(10 * 60_000 + 1);
  assert.equal((await f.invoke(guest.credential, 'city_room_read')).statusCode, 401);
});

test('/mcp/open city_join_invite accepts a pasted sentence and explains a bad paste', async (t) => {
  const f = await fixture(t);
  const room = await f.room('Open paste room');
  const joined = await callOpenTool(f.transport, 'city_join_invite', {
    invite_link: `Please join www.centralcity.ai/j/${room.code}/.`,
    name: 'Open paste guest',
  });
  assert.equal(joined.result?.isError, undefined, joined.raw);
  assert.equal(typeof joined.result?.structuredContent?.['room_credential'], 'string');
  const bad = await callOpenTool(f.transport, 'city_join_invite', {
    invite_link: `https://evil.example/j/${room.code}`,
    name: 'Open paste guest',
  });
  assert.equal(outcomeErrorCode(bad), 'invalid_request');
  assert.match(
    bad.raw,
    /This is not a valid invite code: paste the invite link or its 8-character short code/,
  );
});
