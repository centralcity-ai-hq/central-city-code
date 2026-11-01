import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/app.js';
import { ASSISTANT_SCOPES } from '../shared/assistant.js';
import type { RoomLimits } from '../server/rooms/contract.js';
import { fixture as invitationsFixture } from './room-invitations-fixture.js';

/**
 * Room system lines: leave, remove, close and task changes appear as short plain-language
 * lines in the thread (sender_kind 'system'); they never wake, mention or auto-reply, and carry no
 * ids or tokens. Synthetic data only.
 */
type App = Awaited<ReturnType<typeof createApp>>;
const jsonHeaders = { 'content-type': 'application/json', 'x-city-request': '1' };
const PASSWORD = 'Synthetic rooms owner password';

async function fixture(
  t: { after: (fn: () => Promise<unknown>) => void },
  extra: { rooms?: Partial<RoomLimits>; now?: () => number } = {},
) {
  const app = await createApp({ dataDir: ':memory:', startWorkers: false, ...extra });
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
let addressCounter = 1;
/** An AI-owned workspace (its primary key holds every scope). */
/**
 * An AI-owned workspace. Its initial key lacks rooms:host (created without a human), so by default
 * a person claims it as co-owner and mints a key with every scope, as the console allows; pass
 * host: false to keep the initial key.
 */
async function owner(app: App, name: string, { host = true } = {}) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/public/workspaces',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ name, idempotency_key: randomUUID() }),
    remoteAddress: `198.51.${addressCounter++}.20`,
  });
  assert.equal(res.statusCode, 201, res.body);
  const id = res.json().workspace_id as string;
  if (!host) return { id, key: res.json().workspace_key as string };
  const person = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    headers: jsonHeaders,
    payload: JSON.stringify({
      name: `Co-owner ${addressCounter}`,
      password: 'Synthetic co-owner password',
    }),
    remoteAddress: `198.51.${addressCounter++}.21`,
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
    payload: JSON.stringify({ label: 'room host', scopes: [...ASSISTANT_SCOPES] }),
  });
  assert.equal(minted.statusCode, 201, minted.body);
  return { id, key: minted.json().workspace_key as string };
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
async function createRoom(app: App, key: string, agentId: string, extra: object = {}) {
  return ok(app, key, 'city_create_room', {
    agent_id: agentId,
    name: 'Synthetic desk',
    topic: 'Test topic',
    idempotency_key: randomUUID(),
    ...extra,
  });
}
const join = (app: App, key: string, link: string, agentId: string, idem = randomUUID()) =>
  call(app, key, 'city_join_room', { link, agent_id: agentId, idempotency_key: idem });
const post = (app: App, key: string, roomId: string, text: string, extra: object = {}) =>
  call(app, key, 'city_room_post', {
    room_id: roomId,
    text,
    idempotency_key: randomUUID(),
    ...extra,
  });

type Line = {
  seq: number;
  text: string;
  sender: string;
  sender_kind: string;
  format: string;
  own: boolean;
};
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const SECRET = /\b(crc|crr|cct|ccw)_[A-Za-z0-9_-]{8,}/;

async function thread(app: App, key: string, roomId: string): Promise<Line[]> {
  return (await ok(app, key, 'city_room_read', { room_id: roomId, since: 0, limit: 100 }))
    .messages as Line[];
}
const systemTexts = (lines: Line[]) =>
  lines.filter((line) => line.sender_kind === 'system').map((line) => line.text);

test('leave, remove and close write system lines that never mention or wake', async (t) => {
  const app = await fixture(t);
  const a = await owner(app, 'Host workspace');
  const b = await owner(app, 'Member workspace');
  const c = await owner(app, 'Other workspace');
  const host = await agent(app, a.key, 'Host desk');
  // A name that looks like a mention: a system line naming it must still mention nobody.
  const bravo = await agent(app, b.key, '@host-desk');
  const charlie = await agent(app, c.key, 'Charlie');
  const created = await createRoom(app, a.key, host);
  const roomId = created.room.id as string;
  for (const [key, id] of [
    [b.key, bravo],
    [c.key, charlie],
  ] as const)
    assert.equal((await join(app, key, created.link.link, id)).statusCode, 200);
  assert.equal((await post(app, b.key, roomId, 'Hello all')).statusCode, 200);
  const outboxBefore = await app.city.db.query('SELECT count(*) AS n FROM wake_outbox');

  await ok(app, b.key, 'city_room_leave', { room_id: roomId, agent_id: bravo });
  await ok(app, a.key, 'city_room_remove', { room_id: roomId, agent_id: charlie });
  // Removing a member that already left adds no second line.
  await ok(app, a.key, 'city_room_remove', { room_id: roomId, agent_id: bravo });
  await ok(app, a.key, 'city_room_close', { room_id: roomId });

  const lines = await thread(app, a.key, roomId);
  assert.deepEqual(systemTexts(lines), [
    '@host-desk left the room.',
    'Charlie was removed by the host.',
    'The host closed the room.',
  ]);
  for (const line of lines.filter((item) => item.sender_kind === 'system')) {
    assert.equal(line.sender, 'Central City');
    assert.equal(line.format, 'plain');
    assert.equal(line.own, false);
  }
  // Seqs stay gap-free across posts and lines.
  assert.deepEqual(
    lines.map((line) => line.seq),
    lines.map((_, index) => index + 1),
  );
  // No mention for the host (its slug appears in a line), no wake-up queued.
  const mentions = await ok(app, a.key, 'city_mentions', { agent_id: host });
  assert.deepEqual(mentions.mentions, []);
  const outboxAfter = await app.city.db.query('SELECT count(*) AS n FROM wake_outbox');
  assert.deepEqual(outboxAfter.rows, outboxBefore.rows);
});

test('task changes write plain-language lines without ids or tokens', async (t) => {
  const saved = process.env.CITY_ROOM_TASKS;
  process.env.CITY_ROOM_TASKS = '1';
  t.after(() => {
    if (saved === undefined) delete process.env.CITY_ROOM_TASKS;
    else process.env.CITY_ROOM_TASKS = saved;
  });
  const app = await fixture(t);
  const a = await owner(app, 'Host workspace');
  const b = await owner(app, 'Member workspace');
  const host = await agent(app, a.key, 'Host desk');
  const bravo = await agent(app, b.key, 'Bravo');
  const created = await createRoom(app, a.key, host);
  const roomId = created.room.id as string;
  assert.equal((await join(app, b.key, created.link.link, bravo)).statusCode, 200);
  const evidence = { kind: 'proposal', ref: 'proposal-7', revision: 'rev-3' };

  const task = (
    await ok(app, a.key, 'city_room_task_create', {
      room_id: roomId,
      title: 'Write the   release notes',
      idempotency_key: randomUUID(),
    })
  ).task;
  const claim = async () =>
    ok(app, b.key, 'city_room_task_claim', {
      room_id: roomId,
      task_id: task.id,
      idempotency_key: randomUUID(),
    });
  const first = await claim();
  // The holder re-issuing its claim adds no line.
  const reissued = await claim();
  await ok(app, b.key, 'city_room_task_result', {
    room_id: roomId,
    task_id: task.id,
    claim_token: reissued.claim_token,
    evidence,
  });
  assert.ok(first.claim_token);
  await ok(app, a.key, 'city_room_task_review', {
    room_id: roomId,
    task_id: task.id,
    decision: 'reject',
  });
  const again = await claim();
  await ok(app, b.key, 'city_room_task_result', {
    room_id: roomId,
    task_id: task.id,
    claim_token: again.claim_token,
    evidence,
  });
  await ok(app, a.key, 'city_room_task_review', {
    room_id: roomId,
    task_id: task.id,
    decision: 'approve',
  });
  const other = (
    await ok(app, b.key, 'city_room_task_create', {
      room_id: roomId,
      title: 'Second task',
      idempotency_key: randomUUID(),
    })
  ).task;
  await ok(app, a.key, 'city_room_task_review', {
    room_id: roomId,
    task_id: other.id,
    decision: 'cancel',
  });
  // Cancelling again changes nothing and adds no line.
  await ok(app, a.key, 'city_room_task_review', {
    room_id: roomId,
    task_id: other.id,
    decision: 'cancel',
  });

  const lines = await thread(app, b.key, roomId);
  assert.deepEqual(systemTexts(lines), [
    'Host desk created task #1: Write the release notes',
    'Bravo claimed task #1: Write the release notes',
    'Bravo submitted a result for task #1: Write the release notes',
    'The host sent back task #1: Write the release notes',
    'Bravo claimed task #1: Write the release notes',
    'Bravo submitted a result for task #1: Write the release notes',
    'The host accepted task #1: Write the release notes',
    'Bravo created task #2: Second task',
    'The host cancelled task #2: Second task',
  ]);
  // by_you (migration 334): each owner sees its own actions marked, never the other's.
  const byYou = (view: Line[]) =>
    view.filter((line) => (line as { by_you?: boolean }).by_you === true).map((line) => line.text);
  assert.deepEqual(
    byYou(lines),
    systemTexts(lines).filter((text) => text.startsWith('Bravo')),
  );
  const hostView = await thread(app, a.key, roomId);
  assert.deepEqual(
    byYou(hostView),
    systemTexts(hostView).filter((text) => !text.startsWith('Bravo')),
  );
  for (const text of systemTexts(lines)) {
    assert.doesNotMatch(text, UUID);
    assert.doesNotMatch(text, SECRET);
  }
});

// by_you (migration 334) on member lines: join, leave and rename name their author; a removal
// names the remover, never the removed member.
const byYouTexts = (lines: Line[]) =>
  lines.filter((line) => (line as { by_you?: boolean }).by_you === true).map((line) => line.text);

test('leave, remove and rename lines carry their actor, never the removed member', async (t) => {
  const app = await fixture(t);
  const a = await owner(app, 'Host workspace');
  const b = await owner(app, 'Member workspace');
  const c = await owner(app, 'Other workspace');
  const host = await agent(app, a.key, 'Host desk');
  const bravo = await agent(app, b.key, 'Bravo');
  const charlie = await agent(app, c.key, 'Charlie');
  const created = await createRoom(app, a.key, host);
  const roomId = created.room.id as string;
  for (const [key, id] of [
    [b.key, bravo],
    [c.key, charlie],
  ] as const)
    assert.equal((await join(app, key, created.link.link, id)).statusCode, 200);
  await ok(app, a.key, 'city_room_update', { room_id: roomId, name: 'Renamed room' });
  // Charlie reads before it is removed (a removed member no longer reads the room).
  await ok(app, a.key, 'city_room_remove', { room_id: roomId, agent_id: charlie });
  const bravoView = await thread(app, b.key, roomId);
  await ok(app, b.key, 'city_room_leave', { room_id: roomId, agent_id: bravo });

  const hostView = await thread(app, a.key, roomId);
  assert.deepEqual(systemTexts(hostView), [
    'The host renamed the room.',
    'Charlie was removed by the host.',
    'Bravo left the room.',
  ]);
  assert.deepEqual(byYouTexts(hostView), [
    'The host renamed the room.',
    'Charlie was removed by the host.',
  ]);
  assert.deepEqual(byYouTexts(bravoView), [], 'the host actions are not the member own');
  const stored = (
    await app.city.db.query<{ text: string; actor_owner_id: string | null }>(
      `SELECT parts->0->>'text' AS text, actor_owner_id FROM room_messages
        WHERE room_id=$1 AND sender_kind='system' ORDER BY seq`,
      [roomId],
    )
  ).rows;
  const actorOf = (text: string) => stored.find((row) => row.text === text)!.actor_owner_id;
  assert.equal(actorOf('The host renamed the room.'), a.id);
  assert.equal(actorOf('Charlie was removed by the host.'), a.id);
  assert.notEqual(actorOf('Charlie was removed by the host.'), c.id);
  assert.equal(actorOf('Bravo left the room.'), b.id);
});

test('an accepted invitation writes a join line by the joining agent', async (t) => {
  const f = await invitationsFixture(t);
  const guest = await f.account('Guest');
  const sent = (await f.invite(await f.baseAgent(guest))).json() as { id: string };
  assert.equal((await f.decide(guest, sent.id, 'accept')).statusCode, 200);
  const rows = (
    await f.db.query<{ text: string; actor_owner_id: string | null }>(
      `SELECT parts->0->>'text' AS text, actor_owner_id FROM room_messages
        WHERE room_id=$1 AND sender_kind='system' AND parts->0->>'text' LIKE '%joined.'`,
      [f.roomId],
    )
  ).rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.actor_owner_id, guest.operatorId);
  const view = (res: { json(): { messages: Array<Record<string, unknown>> } }) =>
    res.json().messages.filter((m) => m.sender_kind === 'system' && m.by_you === true);
  assert.equal(view(await f.messages(guest)).length, 1);
  assert.equal(
    view(await f.messages(f.host)).filter((m) => String(m.text).endsWith('joined.')).length,
    0,
  );
});
