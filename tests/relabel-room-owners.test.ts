import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { createApp } from '../server/app.js';
import { sessionPair } from './session-cookie-pair.js';
import { ownerLabel } from '../server/connections/service.js';
import { personMemberId } from '../server/rooms/person.js';
import { ownerLabelKey, personRoomLabel } from '../server/rooms/owner-labels.js';
import { relabelRoomOwners } from '../scripts/relabel-room-owners.js';

process.env.CITY_RATE_LIMIT_KEY ??= 'synthetic-relabel-room-owners-test-root-secret';

/**
 * The one-off relabel of owner labels stored before labels were keyed per room and before AI
 * workspaces had their own label form (scripts/relabel-room-owners.ts). The rows from before are
 * recreated with SQL (one label per account in every room, a workspace's bare name, no owner
 * kind). Synthetic data only.
 */
const ORIGIN = 'https://centralcity.ai';
const SECRET = process.env.CITY_RATE_LIMIT_KEY!;
const headers = {
  'content-type': 'application/json',
  'x-city-request': '1',
  host: 'centralcity.ai',
  origin: ORIGIN,
};
const AI_LABEL = /^AI workspace "([^"]+)" · [0-9a-f]{8}$/;
let address = 90;

test('the relabel keys person labels per room, gives AI workspaces their form, and runs once', async (t) => {
  const app = await createApp({
    database: await PGlite.create('memory://'),
    hosted: {
      databaseUrl: 'postgres://unused.invalid/test',
      publicOrigin: ORIGIN,
      allowedOrigins: [ORIGIN],
    },
    startWorkers: false,
  });
  t.after(() => app.close());
  const db = app.city.db;
  const post = (url: string, body: unknown, extra: Record<string, string> = {}) =>
    app.inject({
      method: 'POST',
      url,
      headers: { ...headers, ...extra },
      payload: JSON.stringify(body),
      remoteAddress: `203.0.113.${address++}`,
    });
  const tool = async (key: string, name: string, args: unknown) => {
    const res = await post(`/api/assistant/tools/${name}`, args, {
      authorization: `Bearer ${key}`,
    });
    assert.equal(res.statusCode, 200, `${name}: ${res.body}`);
    return res.json();
  };
  const registered = await post('/api/auth/register', {
    name: 'Ann Relabel',
    password: 'Synthetic relabel password',
  });
  assert.equal(registered.statusCode, 201, registered.body);
  const cookie = sessionPair(registered.cookies);
  const ann = (
    await app.inject({ method: 'GET', url: '/api/session', headers: { ...headers, cookie } })
  ).json().operator.id as string;
  const agent = await post(
    '/api/agents',
    { name: 'Ann agent', capability: 'research', mode: 'hosted' },
    { cookie },
  );
  assert.equal(agent.statusCode, 201, agent.body);
  const rooms: Array<{ id: string; link: string }> = [];
  for (const name of ['Relabel one', 'Relabel two']) {
    const created = await post(
      '/api/rooms',
      { name, agent_id: agent.json().agent.id, idempotency_key: randomUUID() },
      { cookie },
    );
    assert.equal(created.statusCode, 201, created.body);
    rooms.push({ id: created.json().room.id, link: created.json().link.link });
  }
  const [one, two] = rooms as [{ id: string; link: string }, { id: string; link: string }];
  // An AI workspace joins room one, posts and writes to Ann privately.
  const workspace = await post('/api/public/workspaces', {
    name: 'Bravo lab',
    idempotency_key: randomUUID(),
  });
  assert.equal(workspace.statusCode, 201, workspace.body);
  const key = workspace.json().workspace_key as string;
  const bravo = workspace.json().workspace_id as string;
  const bravoAgent = (
    await tool(key, 'city_create_agent', {
      name: 'Bravo',
      description: 'Synthetic agent',
      capability: 'research',
      mode: 'external',
      idempotencyKey: randomUUID(),
    })
  ).agent.id as string;
  await tool(key, 'city_join_room', {
    link: one.link,
    agent_id: bravoAgent,
    idempotency_key: randomUUID(),
  });
  for (const room of rooms)
    assert.equal(
      (
        await post(
          `/api/rooms/${room.id}/messages`,
          { text: 'Hello', idempotency_key: randomUUID() },
          { cookie },
        )
      ).statusCode,
      201,
    );
  await tool(key, 'city_room_post', {
    room_id: one.id,
    agent_id: bravoAgent,
    text: 'Hello from Bravo',
    idempotency_key: randomUUID(),
  });
  await tool(key, 'city_send_message', {
    from_agent_id: bravoAgent,
    to_agent_id: personMemberId(ann, one.id),
    room_id: one.id,
    text: 'A private hello',
    idempotency_key: randomUUID(),
  });

  // The rows as they were stored before: Ann one label everywhere, Bravo's label a bare name
  // (here even Ann's own label), no owner kind.
  const legacy = ownerLabel({ id: ann, name: 'Ann Relabel', kind: 'owner' });
  await db.query('UPDATE room_members SET owner_label=$2, owner_kind=NULL WHERE owner_id=$1', [
    ann,
    legacy,
  ]);
  await db.query('UPDATE room_members SET owner_label=$2, owner_kind=NULL WHERE owner_id=$1', [
    bravo,
    legacy,
  ]);
  await db.query(
    "UPDATE room_messages SET sender_owner_label=$1, sender_owner_kind=NULL WHERE sender_kind<>'system'",
    [legacy],
  );
  await db.query('UPDATE messages SET sender_owner_label=$1 WHERE room_id IS NOT NULL', [legacy]);
  const snapshot = async () => ({
    members: (
      await db.query<{
        room_id: string;
        owner_id: string;
        owner_label: string;
        owner_kind: string | null;
      }>(
        'SELECT room_id, owner_id, owner_label, owner_kind FROM room_members ORDER BY room_id, agent_id',
      )
    ).rows,
    messages: (
      await db.query<{
        room_id: string;
        sender_owner_id: string;
        sender_owner_label: string;
        sender_owner_kind: string | null;
        sender_kind: string;
      }>(
        'SELECT room_id, sender_owner_id, sender_owner_label, sender_owner_kind, sender_kind FROM room_messages ORDER BY room_id, seq',
      )
    ).rows,
    direct: (
      await db.query<{ sender_owner_label: string | null }>(
        'SELECT sender_owner_label FROM messages WHERE room_id IS NOT NULL',
      )
    ).rows,
  });
  const before = await snapshot();

  // A dry run (the default) counts and changes nothing.
  const dry = await relabelRoomOwners(db, { secret: SECRET, batch: 2 });
  assert.equal(dry.mode, 'dry-run');
  assert.equal(dry.members.scanned, before.members.length);
  assert.equal(dry.members.changed, before.members.length);
  assert.ok(dry.messages.changed > 0 && dry.direct.changed === 1, JSON.stringify(dry));
  assert.deepEqual(await snapshot(), before);
  // Counts only: no label, id or secret in what it reports.
  for (const value of [legacy, SECRET, ann, bravo, one.id])
    assert.ok(!JSON.stringify(dry).includes(value));

  const applied = await relabelRoomOwners(db, { secret: SECRET, confirm: true, batch: 2 });
  assert.deepEqual(applied, { ...dry, mode: 'applied' });
  const after = await snapshot();
  const keyed = ownerLabelKey(SECRET);
  // Ann: one label per room, shared by her person and her agent, the same a new join gets.
  for (const room of rooms) {
    const labels = new Set(
      after.members
        .filter((row) => row.room_id === room.id && row.owner_id === ann)
        .map((row) => row.owner_label),
    );
    assert.deepEqual([...labels], [personRoomLabel(keyed, ann, room.id)]);
  }
  assert.notEqual(personRoomLabel(keyed, ann, one.id), personRoomLabel(keyed, ann, two.id));
  for (const row of after.members)
    assert.equal(row.owner_kind, row.owner_id === bravo ? 'ai' : 'person');
  const bravoRow = after.members.find((row) => row.owner_id === bravo)!;
  assert.equal(AI_LABEL.exec(bravoRow.owner_label)?.[1], 'Bravo lab');
  // Messages follow their sender's label in the room; server lines stay as they are.
  for (const row of after.messages) {
    if (row.sender_kind === 'system') {
      assert.equal(row.sender_owner_kind, null);
      continue;
    }
    const member = after.members.find(
      (item) => item.room_id === row.room_id && item.owner_id === row.sender_owner_id,
    )!;
    assert.equal(row.sender_owner_label, member.owner_label);
    assert.equal(row.sender_owner_kind, member.owner_kind);
  }
  assert.deepEqual(after.direct, [{ sender_owner_label: bravoRow.owner_label }]);
  // The members list now says whose Bravo is.
  const listed = (
    await app.inject({
      method: 'GET',
      url: `/api/rooms/${one.id}/members`,
      headers: { ...headers, cookie },
    })
  ).json().members as Array<{ id: string; owner_kind: string; owner_label: string }>;
  assert.equal(listed.find((member) => member.id === bravoAgent)!.owner_kind, 'ai');

  // Once is enough: a second run finds nothing to change.
  const again = await relabelRoomOwners(db, { secret: SECRET, confirm: true });
  assert.deepEqual(
    [again.members.changed, again.messages.changed, again.direct.changed],
    [0, 0, 0],
  );
  // Without the server secret it refuses to run.
  await assert.rejects(relabelRoomOwners(db, { secret: 'short' }), /secret/);
});
