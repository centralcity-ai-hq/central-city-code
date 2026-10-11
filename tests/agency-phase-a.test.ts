import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createApp } from '../server/app.js';
import { personMemberId } from '../server/rooms/person.js';
import type { ProviderPostRequest } from '../server/responder/providers.js';

process.env.CITY_RATE_LIMIT_KEY ??= 'synthetic-test-only-rate-limit-secret-0000';

/*
 * Operation Agency, Phase A: acceptance tests for the owner's done criterion.
 *
 *   Lustig creates a room with his agent Winry as host -> he is a member as himself -> he posts
 *   as himself -> his "@Winry" records a mention for Winry and wakes her -> with auto-reply set up
 *   she is a responder target and answers.
 *
 * Each test names the Phase A piece it waits for. Tests tagged [A1] or [A3] are EXPECTED TO FAIL
 * on main until that piece lands; they are the signal that Phase A really works, so they are not
 * weakened, skipped or marked todo:
 * - [A1] the room creator becomes a person member on create; a console post without agent_id is
 *   then the person's (today the only sender is the host agent, so the post is Winry's);
 * - [A3] a person's @mention of their own agent records a mention and wakes it, also when that
 *   agent hosts the room (today "@<your own host>" is not a mention: tests/own-host-mention.test.ts).
 * Tests tagged [today] pin behaviour Phase A must keep; they pass on main.
 *
 * The [A3] tests put Lustig in the room as a person through the existing join-by-code path (a
 * no-op once A1 made him a member), so they turn green with A3 alone. The [A1+A3] test is the
 * criterion end to end, exactly as the owner does it. Fake provider and wake transport; synthetic
 * accounts and placeholder keys only.
 */

type App = Awaited<ReturnType<typeof createApp>>;
const jsonHeaders = { 'content-type': 'application/json', 'x-city-request': '1' };
/** A placeholder provider key (never a real one), as in tests/responder-e2e.test.ts. */
const PLACEHOLDER_KEY = 'sk-ant-api03-test-anthropic-placeholder-0000';
/** What the fake model answers: it names Winry herself, so a self-wake would show up. */
const REPLY_TEXT = 'Summary coming up. Signed, @Winry';
/** Acceptance budget for a wake-up (as tests/wake.test.ts). */
const WAKE_BUDGET_MS = 5000;

interface Message {
  id: string;
  seq: number;
  sender: string;
  sender_agent_id: string;
  sender_kind: 'agent' | 'person' | 'system';
  own: boolean;
  text: string;
  auto_reply: { provider: string } | null;
}
interface Member {
  id: string;
  name: string;
  kind: 'agent' | 'person';
  role: string;
  own: boolean;
  auto_reply: { provider: string } | null;
}
interface Mention {
  seq: number;
  source: string;
  room_id: string | null;
  message_id: string;
  source_seq: number;
  from_agent_id: string;
  from_agent_name: string;
  read: boolean;
}
interface WakeCall {
  url: string;
  body: { type: string; agent_id: string; kinds: string[]; latest: { message_id?: string } };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(label: string, check: () => Promise<boolean>, budgetMs = WAKE_BUDGET_MS) {
  const deadline = performance.now() + budgetMs;
  while (performance.now() < deadline) {
    if (await check()) return;
    await sleep(50);
  }
  assert.fail(`timed out after ${budgetMs} ms: ${label}`);
}

/**
 * Lustig (an account) with his agent Winry, and a room he created with Winry as host. `delivery`
 * false keeps hosted-responder wake-ups in the outbox (nothing drains them), so a test can read
 * the responder target directly; otherwise the fake provider answers and the reply is posted.
 */
async function scene(t: { after: (fn: () => Promise<unknown>) => void }, delivery = true) {
  const requests: ProviderPostRequest[] = [];
  const wakeCalls: WakeCall[] = [];
  const app: App = await createApp({
    dataDir: ':memory:',
    startWorkers: false,
    wake: {
      pollMs: 100,
      settleMs: 200,
      transport: async (url, body) => {
        wakeCalls.push({ url, body: JSON.parse(body) });
        return { status: 204 };
      },
    },
    responder: {
      enabled: true,
      env: { CITY_RESPONDER_KEK: randomBytes(32).toString('base64') },
      transport: async () => ({ status: 200 }),
      ...(delivery ? {} : { delivery: false }),
      postTransport: async (request) => {
        requests.push(request);
        return {
          status: 200,
          retryAfterMs: null,
          json: {
            content: [{ type: 'text', text: REPLY_TEXT }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 500, output_tokens: 20 },
          },
        };
      },
    },
  });
  t.after(() => app.close());
  const db = app.city.db;
  const call = (cookie: string, method: 'GET' | 'POST' | 'PUT', url: string, body?: unknown) =>
    app.inject({
      method,
      url,
      headers: { ...jsonHeaders, cookie },
      ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
    });
  const account = async (name: string) => {
    const res = await call('', 'POST', '/api/auth/register', {
      name,
      password: `Synthetic phase A password ${name}`,
    });
    assert.equal(res.statusCode, 201, res.body);
    const cookie = `cc_session=${res.cookies.find((item) => item.name === 'cc_session')!.value}`;
    const operatorId = (
      await db.query<{ id: string }>('SELECT id FROM operators WHERE name=$1', [name])
    ).rows[0]!.id;
    return { name, cookie, operatorId };
  };
  const agent = async (cookie: string, name: string) => {
    const res = await call(cookie, 'POST', '/api/agents', {
      name,
      capability: 'research',
      mode: 'hosted',
    });
    assert.equal(res.statusCode, 201, res.body);
    return res.json().agent.id as string;
  };

  const lustig = await account('Lustig');
  const winry = await agent(lustig.cookie, 'Winry');
  const createKey = randomUUID();
  const createBody = { agent_id: winry, name: 'Winry room', idempotency_key: createKey };
  const created = await call(lustig.cookie, 'POST', '/api/rooms', createBody);
  assert.equal(created.statusCode, 201, created.body);
  const roomId = created.json().room.id as string;

  const members = async (cookie: string) => {
    const res = await call(cookie, 'GET', `/api/rooms/${roomId}/members`);
    assert.equal(res.statusCode, 200, res.body);
    return res.json().members as Member[];
  };
  let code: string | undefined;
  /**
   * The caller's own person member, joining as a person by the room's short code first (today's
   * "Join a room"; for someone already in the room as a person it changes nothing).
   */
  const personOf = async (who: { cookie: string; name: string }) => {
    if (!code) {
      const link = await call(lustig.cookie, 'POST', '/api/links', {
        target: 'room',
        room_id: roomId,
      });
      assert.equal(link.statusCode, 201, link.body);
      code = link.json().code as string;
    }
    const joined = await call(who.cookie, 'POST', '/api/rooms/join', {
      code,
      name: who.name,
      idempotency_key: randomUUID(),
    });
    assert.equal(joined.statusCode, 200, joined.body);
    const me = (await members(who.cookie)).find((m) => m.own && m.kind === 'person');
    assert.ok(me, `${who.name} is in the room as a person`);
    return me.id;
  };
  const post = (cookie: string, text: string, agentId?: string) =>
    call(cookie, 'POST', `/api/rooms/${roomId}/messages`, {
      text,
      idempotency_key: randomUUID(),
      ...(agentId ? { agent_id: agentId } : {}),
    });
  const say = async (cookie: string, text: string, agentId?: string) => {
    const res = await post(cookie, text, agentId);
    assert.equal(res.statusCode, 201, res.body);
    return res.json().message as Message;
  };
  const read = async () => {
    const res = await call(lustig.cookie, 'GET', `/api/rooms/${roomId}/messages?since=0`);
    assert.equal(res.statusCode, 200, res.body);
    return res.json().messages as Message[];
  };
  const mentionsOf = async (agentId: string) => {
    const res = await call(lustig.cookie, 'GET', `/api/agents/${agentId}/mentions?since=0`);
    assert.equal(res.statusCode, 200, res.body);
    return res.json() as { mentions: Mention[]; unread: number };
  };
  /** Auto-reply for one of Lustig's agents: a (placeholder) key, then on. */
  const autoReply = async (agentId: string) => {
    const url = `/api/agents/${agentId}/responder`;
    const key = await call(lustig.cookie, 'POST', `${url}/key`, {
      provider: 'anthropic',
      key: PLACEHOLDER_KEY,
    });
    assert.equal(key.statusCode, 200, key.body);
    const on = await call(lustig.cookie, 'PUT', url, { enabled: true });
    assert.equal(on.statusCode, 200, on.body);
  };
  /** An HTTPS wake webhook for one of Lustig's agents, woken by mentions only. */
  const webhook = async (agentId: string) => {
    const res = await call(lustig.cookie, 'PUT', `/api/agents/${agentId}/wake-webhook`, {
      url: `https://hooks.example.com/${agentId}`,
      events: ['mention'],
    });
    assert.equal(res.statusCode, 200, res.body);
  };
  const grant = async (cookie: string, scopes: string[]) => {
    const res = await call(cookie, 'POST', '/api/assistant-access', {
      label: 'Synthetic phase A client',
      scopes,
      expiresInDays: 1,
    });
    assert.equal(res.statusCode, 201, res.body);
    return res.json().token as string;
  };
  const tool = (token: string, name: string, args: unknown) =>
    app.inject({
      method: 'POST',
      url: `/api/assistant/tools/${name}`,
      headers: { ...jsonHeaders, authorization: `Bearer ${token}` },
      payload: JSON.stringify(args),
    });
  const outbox = async (agentId: string) =>
    (
      await db.query<{ kind: string; kinds: string[]; event: { message_id?: string } }>(
        'SELECT kind, kinds, event FROM wake_outbox WHERE agent_id=$1 ORDER BY kind',
        [agentId],
      )
    ).rows;
  return {
    app,
    call,
    account,
    lustig,
    winry,
    roomId,
    created: created.json() as { room: { member_count: number } },
    createBody,
    members,
    personOf,
    post,
    say,
    read,
    mentionsOf,
    autoReply,
    webhook,
    grant,
    tool,
    outbox,
    requests,
    wakeCalls,
  };
}

test('[A1] Lustig creates a room with Winry as host: he is a member of it as himself', async (t) => {
  const s = await scene(t);
  const list = await s.members(s.lustig.cookie);
  const host = list.find((m) => m.id === s.winry);
  assert.ok(host, 'Winry is a member');
  assert.equal(host.kind, 'agent');
  assert.equal(host.role, 'host');
  assert.equal(host.own, true);
  const people = list.filter((m) => m.kind === 'person');
  assert.equal(people.length, 1, 'the creator is in his new room as a person (A1)');
  const me = people[0]!;
  assert.equal(me.own, true);
  assert.equal(me.name, 'Lustig', 'as himself: under his account name');
  assert.equal(
    me.id,
    personMemberId(s.lustig.operatorId, s.roomId),
    'the same person member a join as himself makes (one per account per room)',
  );
  assert.equal(list.length, 2, 'Winry and Lustig, nobody else');
  assert.equal(s.created.room.member_count, 2, 'the create answer counts him');

  // A replayed create adds nobody.
  const replay = await s.call(s.lustig.cookie, 'POST', '/api/rooms', s.createBody);
  assert.equal(replay.statusCode, 201, replay.body);
  assert.equal(replay.json().replayed, true);
  assert.equal((await s.members(s.lustig.cookie)).length, 2);
});

test("[A1] Lustig posts as himself: a post without agent_id is his, not Winry's", async (t) => {
  const s = await scene(t);
  const posted = await s.post(s.lustig.cookie, 'Hello, Lustig here');
  assert.equal(posted.statusCode, 201, posted.body);
  const message = posted.json().message as Message;
  assert.equal(message.sender_kind, 'person', 'the owner in the web app speaks as himself');
  assert.notEqual(message.sender_agent_id, s.winry, 'never as his host agent by default');
  assert.equal(message.sender_agent_id, personMemberId(s.lustig.operatorId, s.roomId));
  assert.equal(message.sender, 'Lustig');
  assert.equal(message.own, true);

  // He can still speak as Winry on purpose ("Post as").
  const asWinry = await s.say(s.lustig.cookie, 'Winry speaking', s.winry);
  assert.equal(asWinry.sender_kind, 'agent');
  assert.equal(asWinry.sender_agent_id, s.winry);
});

test('[today] his AI never posts as him: an assistant grant posts as Winry, never as the person', async (t) => {
  const s = await scene(t);
  const me = await s.personOf(s.lustig);
  const token = await s.grant(s.lustig.cookie, ['workspace:read', 'rooms:join']);
  const byAi = await s.tool(token, 'city_room_post', {
    room_id: s.roomId,
    text: 'Posted by the connected AI',
    idempotency_key: randomUUID(),
  });
  assert.equal(byAi.statusCode, 200, byAi.body);
  assert.equal(byAi.json().message.sender_agent_id, s.winry);
  assert.equal(byAi.json().message.sender_kind, 'agent');
  const asPerson = await s.tool(token, 'city_room_post', {
    room_id: s.roomId,
    agent_id: me,
    text: 'Pretending to be Lustig',
    idempotency_key: randomUUID(),
  });
  assert.equal(asPerson.statusCode, 403, asPerson.body);
});

test('[A3] Lustig as himself writes @Winry: a mention is recorded for Winry and wakes her', async (t) => {
  const s = await scene(t);
  const me = await s.personOf(s.lustig);
  await s.webhook(s.winry);
  // Winry's connector waits for her mentions (city_mentions with wait), as a polling AI does.
  const token = await s.grant(s.lustig.cookie, ['workspace:read', 'rooms:join']);
  const waiting = s.tool(token, 'city_mentions', { agent_id: s.winry, wait: 8 });
  await sleep(400);
  const postedAt = performance.now();
  const posted = await s.say(s.lustig.cookie, '@Winry please summarize the plan', me);
  assert.equal(posted.sender_kind, 'person');

  // Recorded: one unread room mention for Winry, from Lustig as a person.
  const page = await s.mentionsOf(s.winry);
  assert.equal(page.mentions.length, 1, 'his @Winry is a mention for his own host (A3)');
  const mention = page.mentions[0]!;
  assert.equal(mention.source, 'room');
  assert.equal(mention.room_id, s.roomId);
  assert.equal(mention.message_id, posted.id);
  assert.equal(mention.source_seq, posted.seq);
  assert.equal(mention.from_agent_id, me);
  assert.equal(mention.from_agent_name, 'Lustig');
  assert.equal(mention.read, false);
  assert.equal(page.unread, 1);

  // Woken: her waiting read answers with the mention, and her wake webhook is called with it.
  const woken = await waiting;
  assert.equal(woken.statusCode, 200, woken.body);
  assert.deepEqual(
    (woken.json().mentions as Mention[]).map((m) => m.message_id),
    [posted.id],
    'the waiting read wakes with the mention',
  );
  assert.ok(performance.now() - postedAt < WAKE_BUDGET_MS, 'woken within the wake budget');
  await until('a wake webhook call for Winry', async () =>
    s.wakeCalls.some((c) => c.body.agent_id === s.winry),
  );
  const wake = s.wakeCalls.find((c) => c.body.agent_id === s.winry)!;
  assert.equal(wake.body.type, 'city.wake');
  assert.ok(wake.body.kinds.includes('mention'), `woken for the mention: ${wake.body.kinds}`);
  assert.equal(wake.body.latest.message_id, posted.id);
});

test('[A3] with auto-reply set up, Winry is the responder target for his mention', async (t) => {
  const s = await scene(t, false);
  const me = await s.personOf(s.lustig);
  await s.autoReply(s.winry);
  const host = (await s.members(s.lustig.cookie)).find((m) => m.id === s.winry)!;
  assert.deepEqual(host.auto_reply, { provider: 'anthropic' }, 'precondition: auto-reply is on');
  assert.deepEqual(await s.outbox(s.winry), [], 'nothing pending before the mention');

  const plain = await s.say(s.lustig.cookie, 'Just thinking out loud', me);
  assert.equal(plain.sender_kind, 'person');
  assert.deepEqual(await s.outbox(s.winry), [], 'a post without a mention wakes no responder');

  const posted = await s.say(s.lustig.cookie, '@Winry please summarize the plan', me);
  const pending = await s.outbox(s.winry);
  assert.equal(pending.length, 1, "his mention queues Winry's hosted responder (A3)");
  assert.equal(pending[0]!.kind, 'responder');
  assert.deepEqual(pending[0]!.kinds, ['mention']);
  assert.equal(pending[0]!.event.message_id, posted.id);
});

test('[A3] Winry answers his mention once, as herself; her own reply wakes nobody (no loop)', async (t) => {
  const s = await scene(t);
  const me = await s.personOf(s.lustig);
  await s.autoReply(s.winry);
  const posted = await s.say(s.lustig.cookie, '@Winry please summarize the plan', me);

  await until('an auto-reply in the room', async () =>
    (await s.read()).some((m) => m.auto_reply !== null),
  );
  const replies = (await s.read()).filter((m) => m.auto_reply !== null);
  assert.equal(replies.length, 1);
  const reply = replies[0]!;
  assert.equal(reply.sender, 'Winry');
  assert.equal(reply.sender_agent_id, s.winry);
  assert.equal(reply.sender_kind, 'agent');
  assert.equal(reply.auto_reply!.provider, 'anthropic');
  assert.equal(reply.text, REPLY_TEXT);
  assert.ok(reply.seq > posted.seq);
  assert.equal(s.requests.length, 1, 'one model call');

  // No loop: her reply names herself, yet nothing wakes her again.
  await sleep(600);
  assert.equal(s.requests.length, 1, 'no second model call');
  assert.equal((await s.read()).filter((m) => m.auto_reply !== null).length, 1, 'one reply');
  const page = await s.mentionsOf(s.winry);
  assert.deepEqual(
    page.mentions.map((m) => m.message_id),
    [posted.id],
    'her own reply is not a mention of herself',
  );
  assert.deepEqual(await s.outbox(s.winry), [], 'no wake-up left pending for her');
});

test('[A1+A3] done criterion: create, be in it as himself, post @Winry as himself, Winry answers', async (t) => {
  const s = await scene(t);
  await s.autoReply(s.winry);
  // He is in the room as himself, right after creating it.
  const me = (await s.members(s.lustig.cookie)).find((m) => m.own && m.kind === 'person');
  assert.ok(me, 'the creator is in his new room as a person (A1)');
  // He writes as himself, without choosing an identity.
  const posted = await s.post(s.lustig.cookie, '@Winry please summarize the plan');
  assert.equal(posted.statusCode, 201, posted.body);
  const message = posted.json().message as Message;
  assert.equal(message.sender_kind, 'person');
  assert.equal(message.sender_agent_id, me.id);
  // A mention for Winry, from him.
  const page = await s.mentionsOf(s.winry);
  assert.deepEqual(
    page.mentions.map((m) => [m.message_id, m.from_agent_id]),
    [[message.id, me.id]],
    'his @Winry is a mention for her (A3)',
  );
  // She answers, as herself, once.
  await until('an auto-reply in the room', async () =>
    (await s.read()).some((m) => m.auto_reply !== null),
  );
  const replies = (await s.read()).filter((m) => m.auto_reply !== null);
  assert.deepEqual(
    replies.map((m) => [m.sender_agent_id, m.sender_kind]),
    [[s.winry, 'agent']],
  );
  assert.equal(s.requests.length, 1);
});

test('[today] Ann, a person of another account, writes @Winry: mention, wake-up and one auto-reply', async (t) => {
  const s = await scene(t);
  await s.autoReply(s.winry);
  await s.webhook(s.winry);
  const ann = await s.account('Ann');
  const annId = await s.personOf(ann);
  const posted = await s.say(ann.cookie, '@Winry can you summarize?');
  assert.equal(posted.sender_kind, 'person');
  assert.equal(posted.sender_agent_id, annId);

  const page = await s.mentionsOf(s.winry);
  assert.deepEqual(
    page.mentions.map((m) => [m.message_id, m.from_agent_id, m.from_agent_name]),
    [[posted.id, annId, 'Ann']],
  );
  await until('a wake webhook call for Winry', async () =>
    s.wakeCalls.some((c) => c.body.agent_id === s.winry),
  );
  const wake = s.wakeCalls.find((c) => c.body.agent_id === s.winry)!;
  assert.ok(wake.body.kinds.includes('mention'), `woken for the mention: ${wake.body.kinds}`);
  assert.equal(wake.body.latest.message_id, posted.id);
  await until('an auto-reply in the room', async () =>
    (await s.read()).some((m) => m.auto_reply !== null),
  );
  await sleep(300);
  const replies = (await s.read()).filter((m) => m.auto_reply !== null);
  assert.deepEqual(
    replies.map((m) => [m.sender_agent_id, m.sender]),
    [[s.winry, 'Winry']],
  );
  assert.equal(s.requests.length, 1);
});
