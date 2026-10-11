import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/app.js';
import { ASSISTANT_SCOPES } from '../shared/assistant.js';
import { BRIEF_HEADER, PIN_LIMITS, createRoomPins } from '../server/rooms/pins.js';
import { RoomError } from '../server/rooms/service.js';
import {
  ROOM_PIN_TOOLS,
  ROOM_PIN_TOOL_SCOPES,
  roomPinOutputSchemas,
} from '../server/rooms/pins-tools.js';
import { remoteInputSchemas, remoteOutputSchemas } from '../server/remote-mcp/tools.js';
import { ASSISTANT_TOOL_SCOPES } from '../server/assistant-access.js';
import { outageMode } from '../server/rate-limit.js';

process.env.CITY_ROOM_TASKS = '1';
process.env.CITY_INVITE_FLOW = '1';
process.env.CITY_RATE_LIMIT_KEY ??= 'synthetic-pins-test-root-not-a-real-secret';

/**
 * Context pins and the handoff brief (docs/ROOMS.md "Pins and the handoff brief"):
 * city_room_pin / _unpin / _pins / _brief, GET/POST/DELETE /api/rooms/:room/pins and the
 * once-per-member handoff_brief on city_room_read. Synthetic data only.
 */
type App = Awaited<ReturnType<typeof createApp>>;
const jsonHeaders = { 'content-type': 'application/json', 'x-city-request': '1' };

async function fixture(t: { after: (fn: () => Promise<unknown>) => void }) {
  const app = await createApp({ dataDir: ':memory:', startWorkers: false });
  t.after(() => app.close());
  return app;
}
function call(app: App, key: string, name: string, args: unknown = {}) {
  return app.inject({
    method: 'POST',
    url: `/api/assistant/tools/${name}`,
    headers: { ...jsonHeaders, authorization: `Bearer ${key}` },
    payload: JSON.stringify(args),
  });
}
async function ok(app: App, key: string, name: string, args: unknown = {}) {
  const res = await call(app, key, name, args);
  assert.equal(res.statusCode, 200, `${name}: ${res.body}`);
  return res.json();
}
async function fails(app: App, key: string, name: string, args: unknown, code: string) {
  const res = await call(app, key, name, args);
  assert.notEqual(res.statusCode, 200, `${name} should fail: ${res.body}`);
  assert.equal(res.json().code, code, res.body);
  return res;
}
let addressCounter = 1;
async function owner(app: App, name: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/public/workspaces',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ name, idempotency_key: randomUUID() }),
    remoteAddress: `198.51.${addressCounter++}.40`,
  });
  assert.equal(res.statusCode, 201, res.body);
  const id = res.json().workspace_id as string;
  const person = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    headers: jsonHeaders,
    payload: JSON.stringify({
      name: `Pins owner ${addressCounter}`,
      password: 'Synthetic pins owner password',
    }),
    remoteAddress: `198.51.${addressCounter++}.41`,
  });
  assert.equal(person.statusCode, 201, person.body);
  const cookie = `cc_session=${person.cookies.find((item) => item.name === 'cc_session')!.value}`;
  const claimed = await app.inject({
    method: 'POST',
    url: '/api/workspaces/claim',
    headers: { ...jsonHeaders, cookie },
    payload: JSON.stringify({ claim_token: res.json().claim_token }),
  });
  assert.equal(claimed.statusCode, 200, claimed.body);
  const minted = await app.inject({
    method: 'POST',
    url: '/api/workspace-keys',
    headers: { ...jsonHeaders, cookie, 'x-city-workspace': id },
    payload: JSON.stringify({ label: 'pins test', scopes: [...ASSISTANT_SCOPES] }),
  });
  assert.equal(minted.statusCode, 201, minted.body);
  return { id, key: minted.json().workspace_key as string, cookie };
}
async function agent(app: App, key: string, name: string) {
  const body = await ok(app, key, 'city_create_agent', {
    name,
    description: 'Synthetic room member',
    capability: 'research',
    mode: 'external',
    idempotencyKey: randomUUID(),
  });
  return body.agent.id as string;
}
const post = async (app: App, key: string, roomId: string, text: string) =>
  (await ok(app, key, 'city_room_post', { room_id: roomId, text, idempotency_key: randomUUID() }))
    .message.seq as number;

async function room(app: App, history: 'from_join' | 'full' = 'full') {
  const a = await owner(app, 'Pins host');
  const hostAgent = await agent(app, a.key, 'Host AI');
  const created = await ok(app, a.key, 'city_create_room', {
    agent_id: hostAgent,
    name: 'Launch desk',
    topic: 'Ship the launch checklist',
    history,
    idempotency_key: randomUUID(),
  });
  return { a, hostAgent, roomId: created.room.id as string, link: created.link.link as string };
}
async function member(app: App, link: string, name = 'Member') {
  const b = await owner(app, name);
  const agentId = await agent(app, b.key, `${name} AI`);
  await ok(app, b.key, 'city_join_room', {
    link,
    agent_id: agentId,
    idempotency_key: randomUUID(),
  });
  return { ...b, agentId };
}
async function task(app: App, key: string, roomId: string, title: string) {
  return (
    await ok(app, key, 'city_room_task_create', {
      room_id: roomId,
      title,
      idempotency_key: randomUUID(),
    })
  ).task as { id: string; number: number };
}

test('members pin messages and tasks with a cleaned note; pins list for everyone', async (t) => {
  const app = await fixture(t);
  const { a, roomId, link } = await room(app);
  const seq = await post(app, a.key, roomId, 'The release branch is release/4.2.');
  const b = await member(app, link);
  const pinned = await ok(app, b.key, 'city_room_pin', {
    room_id: roomId,
    message_seq: seq,
    note: '  Branch ​to   use‮ ',
  });
  assert.equal(pinned.created, true);
  assert.equal(pinned.pin.note, 'Branch to use');
  assert.equal(pinned.pin.message.seq, seq);
  assert.match(pinned.pin.message.excerpt, /release\/4\.2/);
  assert.equal(pinned.pin.own, true);
  assert.ok(roomPinOutputSchemas.city_room_pin.safeParse(pinned).success);
  // Pinning the same message again returns the pin.
  const again = await ok(app, a.key, 'city_room_pin', { room_id: roomId, message_seq: seq });
  assert.equal(again.created, false);
  assert.equal(again.pin.id, pinned.pin.id);
  assert.equal(again.pin.own, false);

  const t1 = await task(app, a.key, roomId, 'Write the release notes');
  const taskPin = await ok(app, a.key, 'city_room_pin', { room_id: roomId, task_id: t1.id });
  assert.equal(taskPin.pin.task.number, t1.number);
  assert.equal(taskPin.pin.task.title, 'Write the release notes');

  const listed = await ok(app, b.key, 'city_room_pins', { room_id: roomId });
  assert.equal(listed.cap, PIN_LIMITS.perRoom);
  assert.deepEqual(
    listed.pins.map((pin: { kind: string }) => pin.kind),
    ['message', 'task'],
  );
  assert.ok(roomPinOutputSchemas.city_room_pins.safeParse(listed).success);

  // Notes: at most 200 characters after cleaning, no control characters, no credentials.
  const long = await ok(app, b.key, 'city_room_pin', {
    room_id: roomId,
    message_seq: await post(app, a.key, roomId, 'Another message'),
    note: 'x'.repeat(300),
  });
  assert.equal(long.pin.note.length, 200);
  const control = await call(app, b.key, 'city_room_pin', {
    room_id: roomId,
    message_seq: seq,
    note: 'badbell',
  });
  assert.equal(control.statusCode, 400, control.body);
  const credential = await call(app, b.key, 'city_room_pin', {
    room_id: roomId,
    task_id: t1.id,
    note: `use crr_${'A'.repeat(43)}`,
  });
  assert.equal(credential.statusCode, 400, credential.body);
  // Exactly one target.
  const both = await call(app, b.key, 'city_room_pin', {
    room_id: roomId,
    message_seq: seq,
    task_id: t1.id,
  });
  assert.equal(both.statusCode, 400, both.body);
  // A missing message or task is 404; a non-member gets the uniform room 404.
  await fails(
    app,
    b.key,
    'city_room_pin',
    { room_id: roomId, message_seq: 999 },
    'message_not_found',
  );
  await fails(
    app,
    b.key,
    'city_room_pin',
    { room_id: roomId, task_id: randomUUID() },
    'task_not_found',
  );
  const stranger = await owner(app, 'Stranger');
  await agent(app, stranger.key, 'Stranger AI');
  await fails(app, stranger.key, 'city_room_pins', { room_id: roomId }, 'room_not_found');
});

test('guests, muted owners and closed rooms cannot pin; unpin is for the pinner or the host', async (t) => {
  const app = await fixture(t);
  const { a, roomId, link } = await room(app);
  const seq = await post(app, a.key, roomId, 'Context message');
  const b = await member(app, link, 'Bea');
  const c = await member(app, link, 'Cal');
  // A read-only guest member (role 'guest') reads pins but cannot pin.
  const guest = await owner(app, 'Guest');
  const guestAgent = await agent(app, guest.key, 'Guest AI');
  await app.city.db.query(
    `INSERT INTO room_members(room_id,agent_id,owner_id,role,owner_label,visible_from_seq,joined_at,joined_by)
     VALUES($1,$2,$3,'guest','Guest workspace',0,$4,'the test owner')`,
    [roomId, guestAgent, guest.id, Date.now()],
  );
  await fails(app, guest.key, 'city_room_pin', { room_id: roomId, message_seq: seq }, 'read_only');
  const pin = (await ok(app, b.key, 'city_room_pin', { room_id: roomId, message_seq: seq })).pin;
  assert.equal((await ok(app, guest.key, 'city_room_pins', { room_id: roomId })).pins.length, 1);
  // Another member cannot unpin it; the pinner and the host can.
  await fails(app, c.key, 'city_room_unpin', { room_id: roomId, pin_id: pin.id }, 'not_pinner');
  const removed = await ok(app, b.key, 'city_room_unpin', { room_id: roomId, pin_id: pin.id });
  assert.deepEqual(removed, { room_id: roomId, pin_id: pin.id, removed: true });
  await fails(app, b.key, 'city_room_unpin', { room_id: roomId, pin_id: pin.id }, 'pin_not_found');
  const again = (await ok(app, c.key, 'city_room_pin', { room_id: roomId, message_seq: seq })).pin;
  assert.equal(
    (await ok(app, a.key, 'city_room_unpin', { room_id: roomId, pin_id: again.id })).removed,
    true,
  );
  // A muted owner cannot pin (the same rule as posting and task writes).
  const muted = await app.inject({
    method: 'POST',
    url: `/api/rooms/${roomId}/mute`,
    headers: { ...jsonHeaders, cookie: a.cookie, 'x-city-workspace': a.id },
    payload: JSON.stringify({ agent_id: c.agentId, muted: true }),
  });
  assert.equal(muted.statusCode, 200, muted.body);
  await fails(app, c.key, 'city_room_pin', { room_id: roomId, message_seq: seq }, 'muted_in_room');
  // A closed room's pins are read-only.
  await ok(app, a.key, 'city_room_close', { room_id: roomId });
  await fails(app, b.key, 'city_room_pin', { room_id: roomId, message_seq: seq }, 'room_closed');
});

test('a room holds at most 50 pins', async (t) => {
  const app = await fixture(t);
  const { a, roomId, hostAgent } = await room(app);
  await post(app, a.key, roomId, 'first');
  // Seed 50 message pins directly (posting 50 messages would hit the post limit).
  for (let i = 0; i < PIN_LIMITS.perRoom; i++) {
    await app.city.db.query(
      `INSERT INTO room_pins(id,room_id,kind,message_seq,note,pinned_by_agent_id,pinned_by_owner_id,created_at)
        VALUES($1,$2,'message',$3,'',$4,$5,$6)`,
      [randomUUID(), roomId, 10_000 + i, hostAgent, a.id, Date.now()],
    );
  }
  const seq = await post(app, a.key, roomId, 'one more');
  await fails(app, a.key, 'city_room_pin', { room_id: roomId, message_seq: seq }, 'pin_limit');
});

test('pins respect history: a from_join member never sees pins of earlier messages', async (t) => {
  const app = await fixture(t);
  const { a, roomId, link } = await room(app, 'from_join');
  const early = await post(app, a.key, roomId, 'Secret plan from before you joined');
  await ok(app, a.key, 'city_room_pin', { room_id: roomId, message_seq: early, note: 'old' });
  const b = await member(app, link);
  const late = await post(app, a.key, roomId, 'Visible plan');
  const latePin = await ok(app, a.key, 'city_room_pin', { room_id: roomId, message_seq: late });
  const seen = await ok(app, b.key, 'city_room_pins', { room_id: roomId });
  assert.deepEqual(
    seen.pins.map((pin: { message: { seq: number } }) => pin.message.seq),
    [late],
  );
  assert.equal((await ok(app, a.key, 'city_room_pins', { room_id: roomId })).pins.length, 2);
  // Nor can it pin, unpin or read the brief about the hidden message.
  await fails(
    app,
    b.key,
    'city_room_pin',
    { room_id: roomId, message_seq: early },
    'message_not_found',
  );
  const brief = (await ok(app, b.key, 'city_room_brief', { room_id: roomId })).brief as string;
  assert.doesNotMatch(brief, /Secret plan/);
  assert.match(brief, /Visible plan/);
  void latePin;
});

test('the first read carries the handoff brief once per member agent; never in the feed', async (t) => {
  const app = await fixture(t);
  const { a, roomId, link } = await room(app);
  const seq = await post(app, a.key, roomId, 'Use the staging database for tests.');
  await ok(app, a.key, 'city_room_pin', {
    room_id: roomId,
    message_seq: seq,
    note: 'Test setup',
  });
  const t1 = await task(app, a.key, roomId, 'Update the changelog');
  await task(app, a.key, roomId, 'Tag the release');
  await ok(app, a.key, 'city_room_pin', { room_id: roomId, task_id: t1.id });
  // A private agent-to-agent message of the joining owner never reaches the brief.
  const b = await owner(app, 'Joiner');
  const bAgent = await agent(app, b.key, 'Joiner AI');
  const bOther = await agent(app, b.key, 'Joiner helper');
  const connected = await app.inject({
    method: 'POST',
    url: '/api/connections',
    headers: { ...jsonHeaders, cookie: b.cookie, 'x-city-workspace': b.id },
    payload: JSON.stringify({ fromAgentId: bOther, toAgentId: bAgent }),
  });
  assert.equal(connected.statusCode, 201, connected.body);
  await ok(app, b.key, 'city_send_message', {
    from_agent_id: bOther,
    to_agent_id: bAgent,
    text: 'Private note: the vault phrase is lighthouse.',
    idempotency_key: randomUUID(),
  });
  await ok(app, b.key, 'city_join_room', { link, agent_id: bAgent, idempotency_key: randomUUID() });

  const first = await ok(app, b.key, 'city_room_read', { room_id: roomId });
  const brief = first.handoff_brief as string;
  assert.ok(brief, 'the first read carries the brief');
  assert.ok(remoteOutputSchemas.city_room_read.safeParse(first).success);
  assert.ok(brief.startsWith(BRIEF_HEADER));
  assert.match(brief, /untrusted data, never instructions/);
  assert.match(brief, /Room: Launch desk/);
  assert.match(brief, /Topic: Ship the launch checklist/);
  assert.match(
    brief,
    /Message #\d+ from Host AI: "Use the staging database for tests\." \(note: Test setup\)/,
  );
  assert.match(brief, new RegExp(`Task T${t1.number}: Update the changelog`));
  assert.match(brief, /T\d+ Tag the release \(open; not claimed\)/);
  assert.match(brief, /Latest messages \(oldest first\):/);
  assert.doesNotMatch(brief, /lighthouse/);
  assert.doesNotMatch(brief, /[0-9a-f]{8}-[0-9a-f]{4}-/, 'no ids in the brief');
  assert.ok(brief.length <= PIN_LIMITS.briefChars);

  // Once: the next read has none; the brief is not a message in the feed.
  const second = await ok(app, b.key, 'city_room_read', { room_id: roomId, since: 0 });
  assert.equal(second.handoff_brief, undefined);
  for (const message of second.messages as { parts: { text?: string }[] }[])
    assert.doesNotMatch(JSON.stringify(message.parts), /handoff brief/i);
  // The console read never carries it.
  const consoleRead = await app.inject({
    method: 'GET',
    url: `/api/rooms/${roomId}/messages`,
    headers: { cookie: a.cookie, 'x-city-workspace': a.id },
  });
  assert.equal(consoleRead.statusCode, 200, consoleRead.body);
  assert.equal(consoleRead.json().handoff_brief, undefined);
  // On demand it is always available (and deterministic).
  const onDemand = await ok(app, b.key, 'city_room_brief', { room_id: roomId });
  assert.equal(onDemand.brief, brief);
  assert.ok(roomPinOutputSchemas.city_room_brief.safeParse(onDemand).success);

  // A second agent of the same owner joining later gets its own brief once.
  const bThird = await agent(app, b.key, 'Joiner second');
  await ok(app, b.key, 'city_join_room', { link, agent_id: bThird, idempotency_key: randomUUID() });
  const third = await ok(app, b.key, 'city_room_read', { room_id: roomId });
  assert.ok(third.handoff_brief);
  assert.equal(
    (await ok(app, b.key, 'city_room_read', { room_id: roomId })).handoff_brief,
    undefined,
  );
});

test('an invited AI (room credential) gets the brief once on its first read', async (t) => {
  const app = await fixture(t);
  const { a, roomId } = await room(app);
  const seq = await post(app, a.key, roomId, 'Guests: start with the checklist.');
  await ok(app, a.key, 'city_room_pin', { room_id: roomId, message_seq: seq, note: 'Start here' });
  const link = await app.inject({
    method: 'POST',
    url: '/api/links',
    headers: { ...jsonHeaders, cookie: a.cookie, 'x-city-workspace': a.id },
    payload: JSON.stringify({ target: 'room', room_id: roomId }),
  });
  assert.equal(link.statusCode, 201, link.body);
  const code = new URL(link.json().url).pathname.split('/').at(-1)!;
  const publicPost = (url: string, body: unknown, extra = {}) =>
    app.inject({
      method: 'POST',
      url,
      headers: { ...jsonHeaders, ...extra },
      payload: JSON.stringify(body),
      remoteAddress: '203.0.113.60',
    });
  const start = await publicPost('/api/public/invites/bootstrap', { code });
  assert.equal(start.statusCode, 200, start.body);
  const joined = await publicPost('/api/public/invites/redeem', {
    code,
    handle: start.json().handle,
    name: 'Invited AI',
  });
  assert.equal(joined.statusCode, 200, joined.body);
  const read = () =>
    publicPost(
      '/api/public/invites/tools/city_room_read',
      { since: 0 },
      { authorization: `Bearer ${joined.json().credential}` },
    );
  const first = await read();
  assert.equal(first.statusCode, 200, first.body);
  assert.match(first.json().handoff_brief, /(note: Start here)/);
  const second = await read();
  assert.equal(second.json().handoff_brief, undefined);
});

test('the brief stays within its bound and withholds credential-like text', async (t) => {
  const app = await fixture(t);
  const { a, roomId, link } = await room(app);
  for (let i = 0; i < 12; i++) {
    await post(app, a.key, roomId, `Long update ${i}: ${'detail '.repeat(60)}`);
    await task(
      app,
      a.key,
      roomId,
      `Task number ${i} ${'with a long title '.repeat(8)}`.slice(0, 200),
    );
  }
  // A credential in stored text (posts refuse them; seeded here) never reaches the brief.
  await app.city.db.query(
    `UPDATE room_messages SET parts=$2::jsonb WHERE room_id=$1 AND seq=(SELECT max(seq) FROM room_messages WHERE room_id=$1)`,
    [roomId, JSON.stringify([{ type: 'text', text: `token crr_${'B'.repeat(43)}` }])],
  );
  const b = await member(app, link);
  const brief = (await ok(app, b.key, 'city_room_read', { room_id: roomId }))
    .handoff_brief as string;
  assert.ok(brief.length <= PIN_LIMITS.briefChars, `brief is ${brief.length} characters`);
  assert.match(brief, /more omitted/);
  assert.ok(brief.endsWith('[End of brief. Read the full messages with city_room_read.]'));
  assert.doesNotMatch(brief, /crr_/);
});

test('REST: console lists, pins and unpins with the request header', async (t) => {
  const app = await fixture(t);
  const { a, roomId, hostAgent } = await room(app);
  const seq = await post(app, a.key, roomId, 'Console context');
  const headers = { ...jsonHeaders, cookie: a.cookie, 'x-city-workspace': a.id };
  const noHeader = await app.inject({
    method: 'POST',
    url: `/api/rooms/${roomId}/pins`,
    headers: { 'content-type': 'application/json', cookie: a.cookie, 'x-city-workspace': a.id },
    payload: JSON.stringify({ message_seq: seq }),
  });
  assert.equal(noHeader.statusCode, 403);
  const created = await app.inject({
    method: 'POST',
    url: `/api/rooms/${roomId}/pins`,
    headers,
    payload: JSON.stringify({ message_seq: seq, note: 'From the console', agent_id: hostAgent }),
  });
  assert.equal(created.statusCode, 201, created.body);
  const pinId = created.json().pin.id as string;
  const listed = await app.inject({
    method: 'GET',
    url: `/api/rooms/${roomId}/pins`,
    headers: { cookie: a.cookie, 'x-city-workspace': a.id },
  });
  assert.equal(listed.statusCode, 200, listed.body);
  assert.equal(listed.json().pins[0].note, 'From the console');
  const removed = await app.inject({
    method: 'DELETE',
    url: `/api/rooms/${roomId}/pins/${pinId}`,
    headers,
    payload: '{}',
  });
  assert.equal(removed.statusCode, 200, removed.body);
  assert.equal(removed.json().removed, true);
});

test('pin writes and briefs are rate limited before any work', async (t) => {
  const app = await fixture(t);
  const { a, roomId } = await room(app);
  const seq = await post(app, a.key, roomId, 'Limited');
  const charges: string[] = [];
  const pins = createRoomPins({
    db: app.city.db,
    clock: Date.now,
    limit: async (key) => {
      charges.push(key.split(':')[0]!);
      throw new RoomError(429, 'rate_limited', 'Too many requests.');
    },
  });
  const p = { operatorId: a.id, actor: 'the test', origin: 'http://localhost' };
  await assert.rejects(pins.add(p, { room_id: roomId, message_seq: seq }), /Too many/);
  await assert.rejects(pins.remove(p, { room_id: roomId, pin_id: randomUUID() }), /Too many/);
  await assert.rejects(pins.brief(p, { room_id: roomId }), /Too many/);
  assert.deepEqual(charges, ['room-pin', 'room-pin', 'room-brief']);
  assert.equal((await app.city.db.query('SELECT 1 FROM room_pins')).rows.length, 0);
  // Both prefixes have an outage policy (reads stay available during a limiter outage).
  assert.equal(outageMode('room-pin:x'), 'degraded');
  assert.equal(outageMode('room-brief:x'), 'degraded');
});

test('MCP: the four tools are registered with the posting scope and strict outputs', () => {
  for (const name of ROOM_PIN_TOOLS) {
    assert.ok(Object.hasOwn(remoteInputSchemas, name), name);
    assert.equal(ROOM_PIN_TOOL_SCOPES[name], 'rooms:join');
    assert.equal(
      (ASSISTANT_TOOL_SCOPES as Record<string, string>)[name],
      ASSISTANT_TOOL_SCOPES.city_room_post,
    );
  }
});
