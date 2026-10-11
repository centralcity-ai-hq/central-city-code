import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { createApp } from '../server/app.js';
import type { ProviderPostRequest } from '../server/responder/providers.js';
import { findMentions } from '../server/wake/mentions.js';

process.env.CITY_INVITE_FLOW = '1';
process.env.CITY_RATE_LIMIT_KEY ??= 'synthetic-own-host-mention-test-root-secret';

/**
 * Mentions of your own agents (server/wake/hooks.ts roomPosted).
 *
 * - A PERSON member writing "@<their own agent>" mentions it, also when that agent hosts the
 *   room: a mention is recorded, the agent is woken and its auto-reply can answer.
 * - An AGENT never mentions itself (its own posts and auto-replies wake nothing), and an agent of
 *   the owner, or the owner posting in an agent's name, writing "@<their host>" is not a mention
 *   (no record, no wake-up, no auto-reply).
 * - Anyone else (another owner's person or agent) mentions that host normally.
 *
 * Fake provider and placeholder keys; synthetic data only.
 */
const headers = {
  'content-type': 'application/json',
  'x-city-request': '1',
  host: 'centralcity.ai',
  origin: 'https://centralcity.ai',
};
const PLACEHOLDER_KEY = 'sk-ant-api03-test-own-host-placeholder-0000';
let address = 60;

async function fixture(
  t: { after(fn: () => Promise<unknown>): void },
  options: { delivery?: boolean; replyText?: string } = {},
) {
  const requests: ProviderPostRequest[] = [];
  const app = await createApp({
    database: await PGlite.create('memory://'),
    hosted: {
      databaseUrl: 'postgres://unused.invalid/test',
      publicOrigin: 'https://centralcity.ai',
      allowedOrigins: ['https://centralcity.ai'],
    },
    startWorkers: false,
    responder: {
      enabled: true,
      env: { CITY_RESPONDER_KEK: randomBytes(32).toString('base64') },
      transport: async () => ({ status: 200 }),
      delivery: options.delivery ?? true,
      // The auto-reply names the agent itself: its own reply must never wake it again.
      postTransport: async (request) => {
        requests.push(request);
        return {
          status: 200,
          retryAfterMs: null,
          json: {
            content: [
              { type: 'text', text: options.replyText ?? 'Alex here: @Alex will summarize now.' },
            ],
            stop_reason: 'end_turn',
            usage: { input_tokens: 500, output_tokens: 20 },
          },
        };
      },
    },
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
  const createAgent = async (cookie: string, agentName: string) => {
    const agent = await post(
      '/api/agents',
      { name: agentName, capability: 'research', mode: 'hosted' },
      { cookie },
    );
    assert.equal(agent.statusCode, 201, agent.body);
    return agent.json().agent.id as string;
  };
  const account = async (name: string, agentName: string) => {
    const registered = await post(
      '/api/auth/register',
      { name, password: 'Synthetic own host mention password' },
      {},
      `203.0.113.${address++}`,
    );
    assert.equal(registered.statusCode, 201, registered.body);
    const cookie = `cc_session=${registered.cookies.find((c) => c.name === 'cc_session')!.value}`;
    return { cookie, agentId: await createAgent(cookie, agentName) };
  };
  const host = await account('Tea host', 'Alex');
  const created = await post(
    '/api/rooms',
    { name: 'Tea room', agent_id: host.agentId, idempotency_key: randomUUID() },
    { cookie: host.cookie },
  );
  assert.equal(created.statusCode, 201, created.body);
  const roomId = created.json().room.id as string;
  const roomSlug = created.json().room.slug as string;
  const token = (created.json().link.link as string).split('#')[1];
  const link = await post('/api/links', { target: 'room', room_id: roomId }, host);
  assert.equal(link.statusCode, 201, link.body);
  const code = link.json().code as string;
  const joinAsPerson = async (cookie: string, name: string) => {
    const joined = await post(
      '/api/rooms/join',
      { idempotency_key: randomUUID(), code, name },
      { cookie },
    );
    assert.equal(joined.statusCode, 200, joined.body);
  };
  const joinAgent = async (cookie: string, agentId: string) => {
    const joined = await post(
      `/api/rooms/${roomSlug}/join`,
      { token, agent_id: agentId, idempotency_key: randomUUID() },
      { cookie },
    );
    assert.equal(joined.statusCode, 200, joined.body);
  };
  /** The caller's own person member in the room (its post id when it has several members). */
  const personOf = async (cookie: string) => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/rooms/${roomId}/members`,
      headers: { ...headers, cookie },
    });
    return (res.json().members as Array<{ id: string; own: boolean; kind?: string }>).find(
      (m) => m.own && m.kind === 'person',
    )!.id;
  };
  const say = async (cookie: string, text: string, agentId?: string) => {
    const posted = await post(
      `/api/rooms/${roomId}/messages`,
      { text, idempotency_key: randomUUID(), ...(agentId ? { agent_id: agentId } : {}) },
      { cookie },
    );
    assert.equal(posted.statusCode, 201, posted.body);
    return posted.json().message.seq as number;
  };
  const mentionedAt = async (seq: number) =>
    (
      await app.city.db.query<{ agent_id: string }>(
        'SELECT agent_id FROM mentions WHERE room_id=$1 AND source_seq=$2 ORDER BY agent_id',
        [roomId, seq],
      )
    ).rows.map((row) => row.agent_id);
  /** Pending wake-ups of the agent's auto-reply (the responder target), with their kinds. */
  const responderWakes = async (agentId: string) =>
    (
      await app.city.db.query<{ kinds: string[] }>(
        "SELECT kinds FROM wake_outbox WHERE agent_id=$1 AND kind='responder'",
        [agentId],
      )
    ).rows.map((row) => row.kinds);
  /** Turns the agent's auto-reply on with a placeholder key (owner console). */
  const autoReply = async (cookie: string, agentId: string) => {
    const key = await post(
      `/api/agents/${agentId}/responder/key`,
      { provider: 'anthropic', key: PLACEHOLDER_KEY },
      { cookie },
    );
    assert.ok(key.statusCode < 300, key.body);
    const on = await app.inject({
      method: 'PUT',
      url: `/api/agents/${agentId}/responder`,
      headers: { ...headers, cookie },
      payload: JSON.stringify({ enabled: true }),
    });
    assert.equal(on.statusCode, 200, on.body);
  };
  const autoReplies = async () =>
    (
      await app.city.db.query<{ seq: number; sender_agent_id: string }>(
        'SELECT seq, sender_agent_id FROM room_messages WHERE room_id=$1 AND auto_reply IS NOT NULL ORDER BY seq',
        [roomId],
      )
    ).rows.map((row) => ({ seq: Number(row.seq), sender: row.sender_agent_id }));
  const until = async (check: () => Promise<boolean>) => {
    for (let index = 0; index < 100; index++) {
      if (await check()) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.fail('timed out');
  };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 300));
  return {
    app,
    host,
    roomId,
    roomSlug,
    requests,
    account,
    createAgent,
    joinAsPerson,
    joinAgent,
    personOf,
    say,
    mentionedAt,
    responderWakes,
    autoReply,
    autoReplies,
    until,
    settle,
    post,
  };
}

test('findMentions: excluded ids still resolve their names but are never mentioned', () => {
  const pool = [
    { id: 'a', name: 'Alex' },
    { id: 'b', name: 'Alex Two' },
    { id: 'c', name: 'Bea' },
  ];
  const found = findMentions('hi @Alex Two and @Alex and @Bea', pool, { exclude: ['a', 'b'] });
  assert.deepEqual(found.ids, ['c']);
  // A single id still works as before.
  assert.deepEqual(findMentions('@Bea @Alex', pool, { exclude: 'c' }).ids, ['a']);
});

test("the host's owner as a person writing @<their host> records a mention and wakes its auto-reply", async (t) => {
  // No delivery: the wake-up stays in the outbox, so it can be read as written.
  const f = await fixture(t, { delivery: false });
  await f.autoReply(f.host.cookie, f.host.agentId);
  // The host's owner in the room as a person.
  await f.joinAsPerson(f.host.cookie, 'Tea host');
  const me = await f.personOf(f.host.cookie);
  const own = await f.say(f.host.cookie, 'Note to self: @Alex please summarize', me);
  assert.deepEqual(await f.mentionedAt(own), [f.host.agentId], 'own host: mention recorded');
  assert.deepEqual(await f.responderWakes(f.host.agentId), [['mention']], 'own host: woken');
  const mention = (
    await f.app.city.db.query<{ from_agent_id: string; from_name: string }>(
      'SELECT from_agent_id, from_name FROM mentions WHERE room_id=$1 AND source_seq=$2',
      [f.roomId, own],
    )
  ).rows[0]!;
  assert.deepEqual(mention, { from_agent_id: me, from_name: 'Tea host' });

  // Someone else mentions the same host normally (unchanged).
  const ann = await f.account('Ann', 'Ann helper');
  await f.joinAsPerson(ann.cookie, 'Ann');
  const theirs = await f.say(ann.cookie, '@Alex can you summarize?');
  assert.deepEqual(await f.mentionedAt(theirs), [f.host.agentId]);

  // The host's owner mentions their host and everyone else in one post.
  const annId = await f.personOf(ann.cookie);
  const both = await f.say(f.host.cookie, 'Thanks @Ann, and @Alex too', me);
  assert.deepEqual(await f.mentionedAt(both), [f.host.agentId, annId].sort());
});

test("the owner's own @<host> is answered once by its auto-reply; the reply never wakes it again", async (t) => {
  const f = await fixture(t);
  await f.autoReply(f.host.cookie, f.host.agentId);
  await f.joinAsPerson(f.host.cookie, 'Tea host');
  const me = await f.personOf(f.host.cookie);
  await f.say(f.host.cookie, '@Alex please summarize the room', me);
  await f.until(async () => (await f.autoReplies()).length === 1);
  const [reply] = await f.autoReplies();
  assert.equal(reply!.sender, f.host.agentId, 'answered as the host agent');
  // The reply names the agent itself ("@Alex"): no mention of itself, no second answer.
  assert.deepEqual(await f.mentionedAt(reply!.seq), []);
  await f.settle();
  assert.equal((await f.autoReplies()).length, 1, 'no reply to its own reply');
  assert.equal(f.requests.length, 1, 'one provider call');
});

test('an agent never mentions itself: the host posting @<itself> records nothing', async (t) => {
  const f = await fixture(t);
  await f.autoReply(f.host.cookie, f.host.agentId);
  // The owner without a person member posts in the host agent's name.
  const self = await f.say(f.host.cookie, '@Alex note to self', f.host.agentId);
  assert.deepEqual(await f.mentionedAt(self), [], 'its own post: no mention');
  assert.deepEqual(await f.responderWakes(f.host.agentId), [], 'its own post: no wake-up');
  await f.settle();
  assert.equal(f.requests.length, 0, 'its own post: no auto-reply');
});

test('a non-host own agent never mentions itself: its post and its auto-reply naming it record nothing', async (t) => {
  // The auto-reply names the answering member agent itself.
  const f = await fixture(t, { replyText: 'Bram here: @Bram will summarize now.' });
  const bram = await f.createAgent(f.host.cookie, 'Bram');
  await f.joinAgent(f.host.cookie, bram);
  await f.autoReply(f.host.cookie, bram);
  // Posted in Bram's own name: no mention of itself, no wake-up, no auto-reply.
  const self = await f.say(f.host.cookie, '@Bram note to self', bram);
  assert.deepEqual(await f.mentionedAt(self), [], 'its own post: no mention');
  assert.deepEqual(await f.responderWakes(bram), [], 'its own post: no wake-up');
  await f.settle();
  assert.equal(f.requests.length, 0, 'its own post: no auto-reply');
  // The owner as a person asks Bram; Bram's reply names itself and wakes nothing again.
  await f.joinAsPerson(f.host.cookie, 'Tea host');
  const me = await f.personOf(f.host.cookie);
  const asked = await f.say(f.host.cookie, '@Bram please summarize', me);
  assert.deepEqual(await f.mentionedAt(asked), [bram]);
  await f.until(async () => (await f.autoReplies()).length === 1);
  const [reply] = await f.autoReplies();
  assert.equal(reply!.sender, bram, 'answered as Bram');
  assert.deepEqual(await f.mentionedAt(reply!.seq), [], 'its own reply: no mention');
  await f.settle();
  assert.equal((await f.autoReplies()).length, 1, 'no reply to its own reply');
  assert.equal(f.requests.length, 1, 'one provider call');
});

test("another agent of the host's owner writing @<their host> is still not a mention", async (t) => {
  const f = await fixture(t);
  await f.autoReply(f.host.cookie, f.host.agentId);
  const second = await f.createAgent(f.host.cookie, 'Bram');
  await f.joinAgent(f.host.cookie, second);
  // Posted as the owner's other agent: the agent-to-agent rule is unchanged.
  const asAgent = await f.say(f.host.cookie, '@Alex can you summarize?', second);
  assert.deepEqual(await f.mentionedAt(asAgent), [], 'own agent -> own host: no mention');
  assert.deepEqual(await f.responderWakes(f.host.agentId), [], 'own agent -> own host: no wake');
  // Posted as the host agent, the owner's other (non-host) agent is mentioned as before.
  const fromHost = await f.say(f.host.cookie, '@Bram please help', f.host.agentId);
  assert.deepEqual(await f.mentionedAt(fromHost), [second]);
  // The owner as a person mentions both of their agents.
  await f.joinAsPerson(f.host.cookie, 'Tea host');
  const me = await f.personOf(f.host.cookie);
  const asPerson = await f.say(f.host.cookie, '@Alex and @Bram, a question', me);
  assert.deepEqual(await f.mentionedAt(asPerson), [f.host.agentId, second].sort());
  await f.until(async () => (await f.autoReplies()).length === 1);
  await f.settle();
  assert.equal(f.requests.length, 1, 'only the person post was answered');
});

test("another owner's person and agent mention your host as before", async (t) => {
  const f = await fixture(t, { delivery: false });
  await f.autoReply(f.host.cookie, f.host.agentId);
  const ann = await f.account('Ann', 'Ann helper');
  await f.joinAsPerson(ann.cookie, 'Ann');
  const annPerson = await f.say(ann.cookie, '@Alex can you summarize?');
  assert.deepEqual(await f.mentionedAt(annPerson), [f.host.agentId]);
  assert.deepEqual(await f.responderWakes(f.host.agentId), [['mention']]);
  await f.joinAgent(ann.cookie, ann.agentId);
  const annAgent = await f.say(ann.cookie, '@Alex one more thing', ann.agentId);
  assert.deepEqual(await f.mentionedAt(annAgent), [f.host.agentId]);
});

test('with responders not allowed, the own-host mention is recorded but no auto-reply runs', async (t) => {
  const f = await fixture(t);
  await f.autoReply(f.host.cookie, f.host.agentId);
  const off = await f.post(
    `/api/rooms/${f.roomSlug}/settings`,
    { responders_allowed: false },
    { cookie: f.host.cookie },
  );
  assert.equal(off.statusCode, 200, off.body);
  await f.joinAsPerson(f.host.cookie, 'Tea host');
  const me = await f.personOf(f.host.cookie);
  const own = await f.say(f.host.cookie, '@Alex please summarize', me);
  assert.deepEqual(await f.mentionedAt(own), [f.host.agentId], 'still a mention');
  assert.deepEqual(await f.responderWakes(f.host.agentId), [], 'no auto-reply wake-up');
  await f.settle();
  assert.equal(f.requests.length, 0, 'no provider call');
  assert.deepEqual(await f.autoReplies(), []);
});

test('with auto-reply off, the own-host mention is recorded but nothing runs', async (t) => {
  const f = await fixture(t);
  await f.joinAsPerson(f.host.cookie, 'Tea host');
  const me = await f.personOf(f.host.cookie);
  const own = await f.say(f.host.cookie, '@Alex please summarize', me);
  assert.deepEqual(await f.mentionedAt(own), [f.host.agentId], 'a mention notification');
  assert.deepEqual(await f.responderWakes(f.host.agentId), [], 'no auto-reply target to wake');
  await f.settle();
  assert.equal(f.requests.length, 0, 'no provider call');
  assert.deepEqual(await f.autoReplies(), []);
});

test("muted, removed and revoked: the owner's own @mention follows the usual rules", async (t) => {
  const f = await fixture(t);
  await f.autoReply(f.host.cookie, f.host.agentId);
  // At most 3 agents and people of one account per room: host, person, and one more.
  const bram = await f.createAgent(f.host.cookie, 'Bram');
  const cleo = await f.createAgent(f.host.cookie, 'Cleo');
  await f.joinAgent(f.host.cookie, bram);
  await f.joinAsPerson(f.host.cookie, 'Tea host');
  const me = await f.personOf(f.host.cookie);
  const before = await f.say(f.host.cookie, '@Bram are you there?', me);
  assert.deepEqual(await f.mentionedAt(before), [bram], 'a member: mentioned');
  // Removed from the room: no longer a member, so never mentioned.
  const removed = await f.post(
    `/api/rooms/${f.roomId}/members/${bram}/remove`,
    { block_rejoin: false },
    { cookie: f.host.cookie },
  );
  assert.equal(removed.statusCode, 200, removed.body);
  await f.joinAgent(f.host.cookie, cleo);
  const live = await f.say(f.host.cookie, '@Cleo are you there?', me);
  assert.deepEqual(await f.mentionedAt(live), [cleo], 'a member: mentioned');
  // Revoked in the workspace: never mentioned.
  const revoked = await f.post(`/api/agents/${cleo}/revoke`, {}, { cookie: f.host.cookie });
  assert.equal(revoked.statusCode, 200, revoked.body);
  const gone = await f.say(f.host.cookie, '@Bram and @Cleo, are you there?', me);
  assert.deepEqual(await f.mentionedAt(gone), [], 'removed and revoked: no mention');
  // The owner muted the room's notifications: no mention, no wake-up, no auto-reply.
  const quiet = await f.post(
    `/api/rooms/${f.roomId}/notifications`,
    { muted: true },
    { cookie: f.host.cookie },
  );
  assert.equal(quiet.statusCode, 200, quiet.body);
  const muted = await f.say(f.host.cookie, '@Alex please summarize', me);
  assert.deepEqual(await f.mentionedAt(muted), [], 'muted: no mention');
  assert.deepEqual(await f.responderWakes(f.host.agentId), [], 'muted: no wake-up');
  await f.settle();
  assert.equal(f.requests.length, 0, 'muted: no auto-reply');
});

test('a replayed own-host post records one mention and is answered once', async (t) => {
  const f = await fixture(t);
  await f.autoReply(f.host.cookie, f.host.agentId);
  await f.joinAsPerson(f.host.cookie, 'Tea host');
  const me = await f.personOf(f.host.cookie);
  const body = { text: '@Alex please summarize', idempotency_key: randomUUID(), agent_id: me };
  const first = await f.post(`/api/rooms/${f.roomId}/messages`, body, { cookie: f.host.cookie });
  assert.equal(first.statusCode, 201, first.body);
  await f.until(async () => (await f.autoReplies()).length === 1);
  const again = await f.post(`/api/rooms/${f.roomId}/messages`, body, { cookie: f.host.cookie });
  assert.ok(again.statusCode < 300, again.body);
  assert.equal(again.json().replayed, true);
  assert.equal(again.json().message.seq, first.json().message.seq);
  assert.deepEqual(await f.mentionedAt(first.json().message.seq), [f.host.agentId]);
  await f.settle();
  assert.equal((await f.autoReplies()).length, 1, 'answered once');
  assert.equal(f.requests.length, 1);
});

test('concurrent own-host posts: one mention each, one answer each, no reply to a reply', async (t) => {
  const f = await fixture(t);
  await f.autoReply(f.host.cookie, f.host.agentId);
  await f.joinAsPerson(f.host.cookie, 'Tea host');
  const me = await f.personOf(f.host.cookie);
  const seqs = await Promise.all([
    f.say(f.host.cookie, '@Alex first question', me),
    f.say(f.host.cookie, '@Alex second question', me),
  ]);
  assert.notEqual(seqs[0], seqs[1]);
  for (const seq of seqs) assert.deepEqual(await f.mentionedAt(seq), [f.host.agentId]);
  const mentionSeqs = (
    await f.app.city.db.query<{ seq: string }>(
      'SELECT seq FROM mentions WHERE agent_id=$1 ORDER BY seq',
      [f.host.agentId],
    )
  ).rows.map((row) => Number(row.seq));
  assert.equal(new Set(mentionSeqs).size, 2, 'two distinct mention records');
  await f.until(async () => (await f.autoReplies()).length === 2);
  await f.settle();
  const replies = await f.autoReplies();
  assert.equal(replies.length, 2, 'no reply to a reply');
  for (const reply of replies) assert.deepEqual(await f.mentionedAt(reply.seq), []);
  assert.equal(f.requests.length, 2);
});
