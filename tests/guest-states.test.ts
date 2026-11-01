import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/app.js';
import type { CityLimits } from '../server/limits.js';
import { ASSISTANT_SCOPES } from '../shared/assistant.js';
import { callOpenTool, injectTransport, outcomeErrorCode } from '../scripts/smoke/ai-guest.js';
import { sessionPair } from './session-cookie-pair.js';

process.env.CITY_INVITE_FLOW = '1';
process.env.CITY_RATE_LIMIT_KEY ??= 'synthetic-guest-states-test-root-not-a-real-secret';

/**
 * A cross-owner live test (2026-09-29): a replayed join, a renew and a short code after
 * the member was removed, the link rotated or the room closed now say what happened
 * (removed_from_room, invite_invalid, room_closed). Synthetic data only.
 */
const ORIGIN = 'https://centralcity.ai';
const HOUR = 3_600_000;
const JOIN = /^https:\/\/centralcity\.ai\/j\/[A-Za-z0-9_-]{43}$/;
const SHORT = /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;

async function fixture(
  t: { after(fn: () => Promise<unknown>): void },
  limits: Partial<CityLimits> = {},
) {
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
    limits,
  });
  t.after(() => app.close());
  let address = 10;
  const post = (url: string, body: unknown, extra: Record<string, string> = {}) =>
    app.inject({
      method: 'POST',
      url,
      headers: {
        'content-type': 'application/json',
        'x-city-request': '1',
        host: 'centralcity.ai',
        origin: ORIGIN,
        ...extra,
      },
      payload: JSON.stringify(body),
      remoteAddress: `203.0.113.${address}`,
    });
  /** An AI-owned workspace whose co-owner minted a key with every scope (rooms:host included). */
  const owner = async (name: string) => {
    address++;
    const res = await post('/api/public/workspaces', { name, idempotency_key: randomUUID() });
    assert.equal(res.statusCode, 201, res.body);
    const person = await post('/api/auth/register', {
      name: `Co-owner ${address}`,
      password: 'Synthetic co-owner password',
    });
    assert.equal(person.statusCode, 201, person.body);
    const cookie = sessionPair(person.cookies);
    const claimed = await post(
      '/api/workspaces/claim',
      { claim_token: res.json().claim_token },
      { cookie },
    );
    assert.equal(claimed.statusCode, 200, claimed.body);
    const minted = await post(
      '/api/workspace-keys',
      { label: 'room host', scopes: [...ASSISTANT_SCOPES] },
      { cookie, 'x-city-workspace': res.json().workspace_id },
    );
    assert.equal(minted.statusCode, 201, minted.body);
    return minted.json().workspace_key as string;
  };
  const call = (key: string, name: string, args: unknown = {}) =>
    post(`/api/assistant/tools/${name}`, args, { authorization: `Bearer ${key}` });
  const ok = async (key: string, name: string, args: unknown = {}) => {
    const res = await call(key, name, args);
    assert.equal(res.statusCode, 200, `${name}: ${res.body}`);
    return res.json();
  };
  const agent = async (key: string, name: string) =>
    (
      await ok(key, 'city_create_agent', {
        name,
        description: 'Synthetic room member',
        capability: 'research',
        mode: 'external',
        idempotencyKey: randomUUID(),
      })
    ).agent.id as string;
  /** No-account admission over REST (bootstrap, then redeem with the same pasted text). */
  const guest = async (pasted: string, name = 'Guest AI', redeemWith = pasted) => {
    address++;
    const start = await post('/api/public/invites/bootstrap', { code: pasted });
    if (start.statusCode !== 200) return start;
    return post('/api/public/invites/redeem', {
      code: redeemWith,
      handle: start.json().handle,
      name,
    });
  };
  // One stable address for the no-account MCP client: an idempotent join is bound to its source.
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
      remoteAddress: '198.51.100.7',
    });
    return { statusCode: res.statusCode, body: res.body };
  }, ORIGIN);
  /** A person signed in to the console (cookie session). */
  const consoleUser = async (name: string) => {
    address++;
    const registered = await post('/api/auth/register', {
      name,
      password: 'Synthetic console password',
    });
    assert.equal(registered.statusCode, 201, registered.body);
    const cookie = sessionPair(registered.cookies);
    return { post: (url: string, body: unknown) => post(url, body, { cookie }) };
  };
  return {
    post,
    db: app.city.db,
    console: consoleUser,
    owner,
    call,
    ok,
    agent,
    guest,
    transport,
    advance: (ms: number) => {
      time += ms;
    },
  };
}

async function hostRoom(f: Awaited<ReturnType<typeof fixture>>) {
  const host = await f.owner('Host workspace');
  const created = await f.ok(host, 'city_create_room', {
    agent_id: await f.agent(host, 'Host desk'),
    name: 'Guest states room',
    idempotency_key: randomUUID(),
  });
  return { host, roomId: created.room.id as string, link: created.link };
}
const openJoin = (f: Awaited<ReturnType<typeof fixture>>, link: string, key: string) =>
  callOpenTool(f.transport, 'city_join_invite', {
    invite_link: link,
    name: 'Replay guest',
    idempotency_key: key,
  });

test('a replayed join says removed, rotated or closed instead of returning a dead credential', async (t) => {
  const f = await fixture(t);
  // Removed: the replay with the original key is refused with removed_from_room.
  const one = await hostRoom(f);
  const key = randomUUID();
  const joined = await openJoin(f, one.link.join_link, key);
  const agentId = joined.result?.structuredContent?.['agent_id'] as string;
  assert.ok(agentId, joined.raw);
  const again = await openJoin(f, one.link.join_link, key);
  assert.equal(again.result?.structuredContent?.['replayed'], true, again.raw.slice(0, 600));
  await f.ok(one.host, 'city_room_remove', { room_id: one.roomId, agent_id: agentId });
  assert.equal(outcomeErrorCode(await openJoin(f, one.link.join_link, key)), 'removed_from_room');
  // Rotated: the link it joined with no longer works, so neither does the replay.
  const two = await hostRoom(f);
  const key2 = randomUUID();
  assert.ok((await openJoin(f, two.link.join_link, key2)).result?.structuredContent?.['agent_id']);
  await f.ok(two.host, 'city_room_link', {
    room_id: two.roomId,
    rotate: true,
    idempotency_key: randomUUID(),
  });
  assert.equal(outcomeErrorCode(await openJoin(f, two.link.join_link, key2)), 'invite_invalid');
  // Closed.
  const three = await hostRoom(f);
  const key3 = randomUUID();
  assert.ok(
    (await openJoin(f, three.link.short_code, key3)).result?.structuredContent?.['agent_id'],
  );
  await f.ok(three.host, 'city_room_close', { room_id: three.roomId });
  const closed = await openJoin(f, three.link.short_code, key3);
  assert.equal(outcomeErrorCode(closed), 'room_closed');
  assert.ok(!closed.raw.includes('crc_'), 'no credential in the refusal');
});

test('renew after removal says removed_from_room, after close room_closed', async (t) => {
  const f = await fixture(t);
  for (const ending of ['remove', 'close'] as const) {
    const room = await hostRoom(f);
    const joined = await openJoin(f, room.link.join_link, randomUUID());
    const credential = joined.result?.structuredContent?.['room_credential'] as string;
    const agentId = joined.result?.structuredContent?.['agent_id'] as string;
    if (ending === 'remove')
      await f.ok(room.host, 'city_room_remove', { room_id: room.roomId, agent_id: agentId });
    else await f.ok(room.host, 'city_room_close', { room_id: room.roomId });
    const expected = ending === 'remove' ? 'removed_from_room' : 'room_closed';
    const open = await callOpenTool(f.transport, 'city_room_renew', {
      room_credential: credential,
    });
    assert.equal(outcomeErrorCode(open), expected, open.raw);
    const rest = await f.post(
      '/api/public/invites/renew',
      {},
      { authorization: `Bearer ${credential}` },
    );
    assert.equal(rest.json().code, expected, rest.body);
    assert.equal(rest.statusCode, ending === 'remove' ? 403 : 409);
  }
});

test('a short code live at close says room_closed; one rotated away before stays invite_invalid', async (t) => {
  const f = await fixture(t);
  const member = await f.owner('Member workspace');
  const memberAgent = await f.agent(member, 'Member AI');
  const room = await hostRoom(f);
  const rotatedAway = room.link.short_code as string;
  const fresh = await f.ok(room.host, 'city_room_link', {
    room_id: room.roomId,
    rotate: true,
    idempotency_key: randomUUID(),
  });
  f.advance(60_000);
  await f.ok(room.host, 'city_room_close', { room_id: room.roomId });
  const guest = await f.guest(fresh.short_code);
  assert.equal(guest.statusCode, 409, guest.body);
  assert.equal(guest.json().code, 'room_closed');
  const signedIn = await f.call(member, 'city_join_room', {
    link: fresh.short_code,
    agent_id: memberAgent,
    idempotency_key: randomUUID(),
  });
  assert.equal(signedIn.statusCode, 409, signedIn.body);
  assert.equal(signedIn.json().code, 'room_closed');
  for (const res of [
    await f.guest(rotatedAway),
    await f.call(member, 'city_join_room', {
      link: rotatedAway,
      agent_id: memberAgent,
      idempotency_key: randomUUID(),
    }),
  ]) {
    assert.equal(res.statusCode, 404, res.body);
    assert.equal(res.json().code, 'invite_invalid');
  }
});
