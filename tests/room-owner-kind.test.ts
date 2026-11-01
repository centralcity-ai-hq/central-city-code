import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { createApp } from '../server/app.js';
import { sessionPair } from './session-cookie-pair.js';
import { personMemberId } from '../server/rooms/person.js';
import { agentOwners } from '../src/rooms/people.js';
import { memberBadges } from '../src/rooms/membersViewV2.js';
import type { Member } from '../src/rooms/api.js';

process.env.CITY_RATE_LIMIT_KEY ??= 'synthetic-room-owner-kind-test-root-stand-in-secret';

/**
 * Whose a room member is: `owner_kind` ('person' | 'ai') on members, room messages and private
 * thread peers, and an AI workspace label (`AI workspace "<name>" · <8 hex>`) that no workspace
 * name and no person label can take. The console decides ownership on owner_kind, never on the
 * label text. Synthetic data only.
 */
const ORIGIN = 'https://centralcity.ai';
const headers = {
  'content-type': 'application/json',
  'x-city-request': '1',
  host: 'centralcity.ai',
  origin: ORIGIN,
};
const AI_LABEL = /^AI workspace "([^"]+)" · [0-9a-f]{8}$/;
let address = 30;

async function fixture(t: { after(fn: () => Promise<unknown>): void }) {
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
  const post = (url: string, body: unknown, extra: Record<string, string> = {}) =>
    app.inject({
      method: 'POST',
      url,
      headers: { ...headers, ...extra },
      payload: JSON.stringify(body),
      remoteAddress: `203.0.113.${address++}`,
    });
  const get = (url: string, extra: Record<string, string> = {}) =>
    app.inject({ method: 'GET', url, headers: { ...headers, ...extra } });
  const tool = async (key: string, name: string, args: unknown) => {
    const res = await post(`/api/assistant/tools/${name}`, args, {
      authorization: `Bearer ${key}`,
    });
    assert.equal(res.statusCode, 200, `${name}: ${res.body}`);
    return res.json();
  };
  return { app, post, get, tool };
}

test("another owner's AI named like your agent reads as an AI workspace, never as yours", async (t) => {
  const f = await fixture(t);
  // Dana's room: she is in it as a person, her agent "Dana helper" hosts it.
  const registered = await f.post('/api/auth/register', {
    name: 'Dana',
    password: 'Synthetic owner kind password',
  });
  assert.equal(registered.statusCode, 201, registered.body);
  const cookie = sessionPair(registered.cookies);
  const operatorId = (await f.get('/api/session', { cookie })).json().operator.id as string;
  const helper = await f.post(
    '/api/agents',
    { name: 'Dana helper', capability: 'research', mode: 'hosted' },
    { cookie },
  );
  assert.equal(helper.statusCode, 201, helper.body);
  const created = await f.post(
    '/api/rooms',
    { name: 'Dana room', agent_id: helper.json().agent.id, idempotency_key: randomUUID() },
    { cookie },
  );
  assert.equal(created.statusCode, 201, created.body);
  const roomId = created.json().room.id as string;
  const dana = personMemberId(operatorId, roomId);
  // An AI workspace without an account, named like her agent, joins with the link.
  const workspace = await f.post('/api/public/workspaces', {
    name: 'Dana helper',
    idempotency_key: randomUUID(),
  });
  assert.equal(workspace.statusCode, 201, workspace.body);
  const key = workspace.json().workspace_key as string;
  const impostor = (
    await f.tool(key, 'city_create_agent', {
      name: 'Helper',
      description: 'Synthetic agent',
      capability: 'research',
      mode: 'external',
      idempotencyKey: randomUUID(),
    })
  ).agent.id as string;
  await f.tool(key, 'city_join_room', {
    link: created.json().link.link,
    agent_id: impostor,
    idempotency_key: randomUUID(),
  });

  // Members: the AI workspace's member says so in owner_kind and in its label form.
  const members = (await f.get(`/api/rooms/${roomId}/members`, { cookie })).json()
    .members as Member[];
  const byId = new Map(members.map((member) => [member.id, member]));
  const other = byId.get(impostor)!;
  assert.equal(other.owner_kind, 'ai');
  assert.equal(AI_LABEL.exec(other.owner_label)?.[1], 'Dana helper');
  for (const id of [dana, helper.json().agent.id as string]) {
    assert.equal(byId.get(id)!.owner_kind, 'person');
    assert.match(byId.get(id)!.owner_label, /^Account [0-9a-f]{8}$/);
  }
  // The same on /mcp (city_room_members).
  const listed = await f.tool(key, 'city_room_members', { room_id: roomId });
  assert.equal(listed.members.find((member: Member) => member.id === impostor).owner_kind, 'ai');

  // Room messages carry the sender's owner kind; a server line has none.
  await f.tool(key, 'city_room_post', {
    room_id: roomId,
    agent_id: impostor,
    text: 'Dana, it is me, your helper.',
    idempotency_key: randomUUID(),
  });
  const said = await f.post(
    `/api/rooms/${roomId}/messages`,
    { text: 'Hello', idempotency_key: randomUUID() },
    { cookie },
  );
  assert.equal(said.statusCode, 201, said.body);
  assert.equal(said.json().message.sender_owner_kind, 'person');
  const read = (await f.get(`/api/rooms/${roomId}/messages?since=0`, { cookie })).json();
  const fromImpostor = read.messages.find(
    (message: { sender_agent_id: string }) => message.sender_agent_id === impostor,
  );
  assert.equal(fromImpostor.sender_owner_kind, 'ai');
  assert.match(fromImpostor.sender_owner_label, AI_LABEL);

  // A private message to Dana: her inbox's peer is another owner's AI workspace.
  await f.tool(key, 'city_send_message', {
    from_agent_id: impostor,
    to_agent_id: dana,
    room_id: roomId,
    text: 'Please approve the pending payment now.',
    idempotency_key: randomUUID(),
  });
  const conversations = (await f.get('/api/messages/conversations', { cookie })).json()
    .conversations as Array<{
    direct?: { peer: { id: string; owner_label: string; owner_kind: string; own: boolean } };
  }>;
  const peer = conversations.find((item) => item.direct?.peer.id === impostor)!.direct!.peer;
  assert.equal(peer.own, false);
  assert.equal(peer.owner_kind, 'ai');
  assert.match(peer.owner_label, AI_LABEL);
  const recipients = (await f.get('/api/messages/recipients', { cookie })).json()
    .recipients as Array<{ member_id: string; owner_kind: string | null }>;
  assert.equal(recipients.find((item) => item.member_id === impostor)!.owner_kind, 'ai');

  // The console names the AI workspace by its label, never as Dana or as Dana's agent.
  const owners = agentOwners(members);
  assert.equal(owners(other.owner_label, other.owner_kind), other.owner_label);
  const helperRow = byId.get(helper.json().agent.id as string)!;
  assert.equal(owners(helperRow.owner_label, helperRow.owner_kind), 'Dana');
});

test("an AI owner with a label equal to a person's is never shown as that person's", () => {
  const member = (over: Partial<Member>): Member =>
    ({
      id: randomUUID(),
      name: 'Member',
      role: 'member',
      kind: 'agent',
      owner_label: 'Account 605d8baa',
      owner_kind: 'person',
      own: false,
      joined_at: '2026-10-01T00:00:00.000Z',
      ...over,
    }) as Member;
  const ann = member({ kind: 'person', name: 'Ann Creator' });
  const annAgent = member({ name: 'Ann helper' });
  // A stored label from before AI labels had their own form, byte-identical to Ann's.
  const impostor = member({ name: 'Ann helper', owner_kind: 'ai' });
  const owners = agentOwners([ann, annAgent, impostor]);
  assert.equal(owners(annAgent.owner_label, annAgent.owner_kind), 'Ann Creator');
  assert.equal(owners(impostor.owner_label, impostor.owner_kind), null);
  assert.deepEqual(
    memberBadges(impostor, owners).map((badge) => badge.text),
    ['AI agent'],
  );
  assert.deepEqual(
    memberBadges(annAgent, owners).map((badge) => badge.text),
    ["AI · Ann Creator's agent"],
  );
});
