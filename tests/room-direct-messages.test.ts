import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { createApp } from '../server/app.js';
import { ASSISTANT_SCOPES } from '../shared/assistant.js';
import { callOpenTool, injectTransport, outcomeErrorCode } from '../scripts/smoke/ai-guest.js';
import { personMemberId } from '../server/rooms/person.js';
import { HIDES_PER_MINUTE } from '../server/messaging/contract.js';

process.env.CITY_INVITE_FLOW = '1';
process.env.CITY_RATE_LIMIT_KEY ??= 'synthetic-room-direct-messages-test-root-not-a-real-secret';

/**
 * Private messages between room members (docs/MESSAGING.md "Private messages from a room",
 * migration 63): shared-room permission checked server-side, one thread per pair, AIs receive
 * through their inbox (MCP), mutes, closed rooms, the host switch, guests and Elric.
 * Synthetic data only; "Dana" is the example person.
 */
const ORIGIN = 'https://centralcity.ai';
/** An owner: an AI workspace (its co-owner's session selects it), or a person's own account. */
type Owner = { id: string; key: string; cookie: string; person?: true };

async function fixture(
  t: { after(fn: () => Promise<unknown>): void },
  messaging?: { inboxDepth?: number; crossPairPerMinute?: number },
  database?: PGlite,
  now?: () => number,
) {
  const app = await createApp({
    database: database ?? (await PGlite.create('memory://')),
    ...(now ? { now } : {}),
    hosted: {
      databaseUrl: 'postgres://unused.invalid/test',
      publicOrigin: ORIGIN,
      allowedOrigins: [ORIGIN],
    },
    startWorkers: false,
    ...(messaging ? { messaging } : {}),
  });
  t.after(() => app.close());
  let address = 10;
  const send = (method: string, url: string, body: unknown, extra: Record<string, string> = {}) =>
    app.inject({
      method: method as 'POST',
      url,
      headers: {
        'content-type': 'application/json',
        'x-city-request': '1',
        host: 'centralcity.ai',
        origin: ORIGIN,
        ...extra,
      },
      ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
      remoteAddress: `203.0.113.${address}`,
    });
  const owner = async (name: string): Promise<Owner> => {
    address++;
    const res = await send('POST', '/api/public/workspaces', {
      name,
      idempotency_key: randomUUID(),
    });
    assert.equal(res.statusCode, 201, res.body);
    const person = await send('POST', '/api/auth/register', {
      name: `${name} person`,
      password: 'Synthetic direct message password',
    });
    assert.equal(person.statusCode, 201, person.body);
    const cookie = `cc_session=${person.cookies.find((c) => c.name === 'cc_session')!.value}`;
    const id = res.json().workspace_id as string;
    const claimed = await send(
      'POST',
      '/api/workspaces/claim',
      { claim_token: res.json().claim_token },
      { cookie },
    );
    assert.equal(claimed.statusCode, 200, claimed.body);
    const minted = await send(
      'POST',
      '/api/workspace-keys',
      { label: 'room member', scopes: [...ASSISTANT_SCOPES] },
      { cookie, 'x-city-workspace': id },
    );
    assert.equal(minted.statusCode, 201, minted.body);
    return { id, key: minted.json().workspace_key as string, cookie };
  };
  /**
   * A person's own account (no AI workspace): its console acts as the person, since an invite
   * never adds an AI workspace as a person. Its key is an assistant grant, so the AIs it creates
   * are the person's own members.
   */
  const personAccount = async (name: string): Promise<Owner> => {
    address++;
    const registered = await send('POST', '/api/auth/register', {
      name,
      password: 'Synthetic direct message password',
    });
    assert.equal(registered.statusCode, 201, registered.body);
    const cookie = `cc_session=${registered.cookies.find((c) => c.name === 'cc_session')!.value}`;
    const granted = await send(
      'POST',
      '/api/assistant-access',
      { label: 'room member', scopes: [...ASSISTANT_SCOPES], expiresInDays: 1 },
      { cookie },
    );
    assert.equal(granted.statusCode, 201, granted.body);
    return {
      id: registered.json().operator.id as string,
      key: granted.json().token as string,
      cookie,
      person: true,
    };
  };
  const tool = (key: string, name: string, args: unknown = {}) =>
    send('POST', `/api/assistant/tools/${name}`, args, { authorization: `Bearer ${key}` });
  const ok = async (key: string, name: string, args: unknown = {}) => {
    const res = await tool(key, name, args);
    assert.equal(res.statusCode, 200, `${name}: ${res.body}`);
    return res.json();
  };
  /** The console: an AI workspace selected with its header, a person in their own account. */
  const console = (who: Owner, method: string, url: string, body?: unknown) =>
    send(method, url, body, {
      cookie: who.cookie,
      ...(who.person ? {} : { 'x-city-workspace': who.id }),
    });
  const agent = async (who: Owner, name: string) =>
    (
      await ok(who.key, 'city_create_agent', {
        name,
        description: 'Synthetic room member',
        capability: 'research',
        mode: 'external',
        idempotencyKey: randomUUID(),
      })
    ).agent.id as string;
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

  // Host A's AI hosts the room; B joins with its AI Bravo; Dana (owner C, her own account) joins
  // as a person.
  const a = await owner('Host workspace');
  const b = await owner('Member workspace');
  const c = await personAccount('Dana account');
  const hostAgent = await agent(a, 'Host desk');
  const bravo = await agent(b, 'Bravo');
  const created = await ok(a.key, 'city_create_room', {
    agent_id: hostAgent,
    name: 'Planning room',
    idempotency_key: randomUUID(),
  });
  const roomId = created.room.id as string;
  const link = created.link as { link: string; join_link: string };
  await ok(b.key, 'city_join_room', {
    link: link.link,
    agent_id: bravo,
    idempotency_key: randomUUID(),
  });
  const danaJoined = await console(c, 'POST', '/api/rooms/join', {
    link: link.link,
    name: 'Dana',
    idempotency_key: randomUUID(),
  });
  assert.equal(danaJoined.statusCode, 200, danaJoined.body);
  // The same join from an AI workspace's console (B's) adds no person: 404 room_not_found.
  const fromWorkspace = await console(b, 'POST', '/api/rooms/join', {
    link: link.link,
    name: 'Dana',
    idempotency_key: randomUUID(),
  });
  assert.equal(fromWorkspace.statusCode, 404, fromWorkspace.body);
  assert.equal(fromWorkspace.json().code, 'room_not_found');
  const dana = personMemberId(c.id, roomId);
  const open = (who: Owner, to: string, from?: string, room = roomId) =>
    console(who, 'POST', `/api/rooms/${room}/direct`, { to, ...(from ? { from } : {}) });
  const write = (who: Owner, from: string, to: string, text: string, room = roomId) =>
    console(who, 'POST', `/api/rooms/${room}/direct/messages`, {
      from,
      to,
      text,
      idempotency_key: randomUUID(),
    });
  const guestSession = async (name = 'Guest AI') => {
    const joined = await callOpenTool(transport, 'city_join_invite', {
      invite_link: link.join_link,
      name,
      idempotency_key: randomUUID(),
    });
    const structured = joined.result?.structuredContent ?? {};
    assert.ok(structured['agent_id'], joined.raw.slice(0, 600));
    return {
      id: structured['agent_id'] as string,
      credential: structured['room_credential'] as string,
    };
  };
  const guestJoin = async () => (await guestSession()).id;
  /** A guest's /mcp/open tool call with its room credential: the structured result or the code. */
  const guestTool = async (
    credential: string,
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<{ code: string | null; result: Record<string, unknown> }> => {
    const outcome = await callOpenTool(transport, name, { ...args, room_credential: credential });
    return {
      code:
        outcome.status !== 200 || outcome.error
          ? 'rpc_error'
          : outcome.result?.isError
            ? (outcomeErrorCode(outcome) ?? 'tool_error')
            : null,
      result: (outcome.result?.structuredContent ?? {}) as Record<string, unknown>,
    };
  };
  return {
    app,
    a,
    b,
    c,
    owner,
    agent,
    tool,
    ok,
    console,
    hostAgent,
    bravo,
    dana,
    roomId,
    link,
    open,
    write,
    guestJoin,
    guestSession,
    guestTool,
  };
}

test('a person and an AI of another owner message privately; the AI reads it over MCP and replies', async (t) => {
  const f = await fixture(t);
  // Dana opens the thread with Bravo from the room: her person is the default sender.
  const opened = await f.open(f.c, f.bravo);
  assert.equal(opened.statusCode, 200, opened.body);
  const thread = opened.json();
  assert.equal(thread.room_id, f.roomId);
  assert.equal(thread.room_name, 'Planning room');
  const labels = await roomLabels(f, f.c);
  assert.deepEqual(thread.self, {
    id: f.dana,
    name: 'Dana',
    kind: 'person',
    owner_label: labels.get(f.dana),
    is_self: true,
    own: true,
  });
  assert.deepEqual(thread.peer, {
    id: f.bravo,
    name: 'Bravo',
    kind: 'agent',
    owner_label: labels.get(f.bravo),
    is_self: false,
    own: false,
  });

  const sent = await f.write(f.c, f.dana, f.bravo, 'Hi Bravo, can we sync on the plan?');
  assert.equal(sent.statusCode, 201, sent.body);
  const message = sent.json().message;
  assert.equal(message.context_id, thread.context_id);
  assert.equal(message.room_id, f.roomId);
  assert.equal(message.from_agent_name, 'Dana');
  assert.equal(message.origin, 'external');

  // Bravo's owner reads it through MCP, like any direct message.
  const inbox = await f.ok(f.b.key, 'city_read_inbox', { agent_id: f.bravo });
  assert.equal(inbox.messages.length, 1);
  assert.equal(inbox.messages[0].from_agent_id, f.dana);
  assert.equal(inbox.messages[0].from_agent_name, 'Dana');
  assert.equal(inbox.messages[0].room_id, f.roomId);
  assert.equal(inbox.messages[0].context_id, thread.context_id);

  // Bravo answers with reply_to alone: the room is implied, the thread is the same.
  const reply = await f.ok(f.b.key, 'city_send_message', {
    from_agent_id: f.bravo,
    to_agent_id: f.dana,
    text: 'Sure, Dana. 10:00?',
    reply_to: message.id,
    idempotency_key: randomUUID(),
  });
  assert.equal(reply.message.context_id, thread.context_id);
  assert.equal(reply.message.room_id, f.roomId);
  // Bravo may also write first with room_id (no connection needed between the owners).
  const again = await f.ok(f.b.key, 'city_send_message', {
    from_agent_id: f.bravo,
    to_agent_id: f.dana,
    room_id: f.roomId,
    text: 'Also: the agenda is in the room.',
    idempotency_key: randomUUID(),
  });
  assert.equal(again.message.context_id, thread.context_id);

  // Dana's Messages lists one private thread, from her side; Bravo's owner sees it from its side.
  const danaList = (await f.console(f.c, 'GET', '/api/messages/conversations')).json();
  assert.equal(danaList.conversations.length, 1);
  assert.equal(danaList.conversations[0].message_count, 3);
  assert.equal(danaList.conversations[0].direct.self.id, f.dana);
  assert.equal(danaList.conversations[0].direct.peer.name, 'Bravo');
  const bravoList = (await f.console(f.b, 'GET', '/api/messages/conversations')).json();
  assert.equal(bravoList.conversations[0].direct.self.id, f.bravo);
  assert.equal(bravoList.conversations[0].direct.peer.name, 'Dana');
  const read = await f.console(
    f.c,
    'GET',
    `/api/messages/conversations/${thread.context_id}?limit=50`,
  );
  assert.deepEqual(
    read.json().messages.map((m: { from_agent_name: string }) => m.from_agent_name),
    ['Dana', 'Bravo', 'Bravo'],
  );
  // Nobody else sees it: not the host, not in the room feed.
  const hostList = (await f.console(f.a, 'GET', '/api/messages/conversations')).json();
  assert.equal(hostList.conversations.length, 0);
  const feed = (await f.console(f.a, 'GET', `/api/rooms/${f.roomId}/messages?limit=100`)).json();
  assert.ok(!feed.messages.some((m: { text: string }) => m.text.includes('sync on the plan')));
});

test('one thread per pair: opening twice, both directions and concurrent first sends converge', async (t) => {
  const f = await fixture(t);
  const [first, second] = await Promise.all([f.open(f.c, f.bravo), f.open(f.c, f.bravo)]);
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(first.json().context_id, second.json().context_id);
  const fromBravo = await f.open(f.b, f.dana);
  assert.equal(fromBravo.json().context_id, first.json().context_id);
  const sends = await Promise.all([
    f.write(f.c, f.dana, f.bravo, 'one'),
    f.write(f.b, f.bravo, f.dana, 'two'),
    f.write(f.c, f.dana, f.bravo, 'three'),
  ]);
  for (const res of sends) assert.equal(res.statusCode, 201, res.body);
  assert.deepEqual(
    new Set(sends.map((res) => res.json().message.context_id)),
    new Set([first.json().context_id]),
  );
  const [low, high] = [f.dana, f.bravo].sort();
  const rows = await f.app.city.db.query<{ n: number | string }>(
    'SELECT count(*) AS n FROM pair_contexts WHERE low_id=$1 AND high_id=$2',
    [low, high],
  );
  assert.equal(Number(rows.rows[0]!.n), 1);
  // A caller cannot fork the pair into a second thread.
  const forked = await f.tool(f.b.key, 'city_send_message', {
    from_agent_id: f.bravo,
    to_agent_id: f.dana,
    room_id: f.roomId,
    context_id: 'side-thread',
    text: 'fork',
    idempotency_key: randomUUID(),
  });
  assert.equal(forked.statusCode, 400, forked.body);
  // Idempotent: the same key and body is the same message.
  const key = randomUUID();
  const body = { from: f.dana, to: f.bravo, text: 'once', idempotency_key: key };
  const once = await f.console(f.c, 'POST', `/api/rooms/${f.roomId}/direct/messages`, body);
  const twice = await f.console(f.c, 'POST', `/api/rooms/${f.roomId}/direct/messages`, body);
  assert.equal(once.json().message.id, twice.json().message.id);
});

test('permissions: no shared room, outsiders, removed members, own members and a person over MCP', async (t) => {
  const f = await fixture(t);
  // An outsider (no member in the room) learns nothing: the uniform 404.
  const d = await f.owner('Outsider workspace');
  const delta = await f.agent(d, 'Delta');
  const outsider = await f.open(d, f.bravo, delta);
  assert.equal(outsider.statusCode, 404, outsider.body);
  assert.equal(outsider.json().code, 'room_not_found');
  const viaTool = await f.tool(d.key, 'city_send_message', {
    from_agent_id: delta,
    to_agent_id: f.bravo,
    room_id: f.roomId,
    text: 'let me in',
    idempotency_key: randomUUID(),
  });
  assert.equal(viaTool.statusCode, 404, viaTool.body);
  // Without a room there is no shared-room permission: the connection rule applies.
  const noRoom = await f.tool(f.b.key, 'city_send_message', {
    from_agent_id: f.bravo,
    to_agent_id: f.dana,
    text: 'no room',
    idempotency_key: randomUUID(),
  });
  assert.equal(noRoom.statusCode, 403, noRoom.body);
  assert.equal(noRoom.json().code, 'connection_required');
  // A member of a different room only: not a shared room.
  const other = await f.ok(d.key, 'city_create_room', {
    agent_id: delta,
    name: 'Other room',
    idempotency_key: randomUUID(),
  });
  const cross = await f.open(d, f.bravo, delta, other.room.id);
  assert.equal(cross.statusCode, 403, cross.body);
  assert.equal(cross.json().code, 'not_in_room');
  // A person is written as only from the console; a key, even her own account's, acts as AIs.
  const asPerson = await f.tool(f.c.key, 'city_send_message', {
    from_agent_id: f.dana,
    to_agent_id: f.bravo,
    room_id: f.roomId,
    text: 'pretending',
    idempotency_key: randomUUID(),
  });
  assert.ok([403, 404].includes(asPerson.statusCode), asPerson.body);
  // A member cannot message itself.
  const self = await f.open(f.c, f.dana, f.dana);
  assert.equal(self.statusCode, 400, self.body);
  assert.equal(self.json().code, 'invalid_arguments');
  // Once Bravo is removed, the thread stays readable but nobody can write from the room.
  await f.write(f.c, f.dana, f.bravo, 'before removal');
  const removed = await f.console(f.a, 'POST', `/api/rooms/${f.roomId}/members/${f.bravo}/remove`, {
    block_rejoin: true,
  });
  assert.equal(removed.statusCode, 200, removed.body);
  const after = await f.write(f.c, f.dana, f.bravo, 'after removal');
  assert.equal(after.statusCode, 403, after.body);
  assert.equal(after.json().code, 'not_in_room');
  const bravoAfter = await f.tool(f.b.key, 'city_send_message', {
    from_agent_id: f.bravo,
    to_agent_id: f.dana,
    room_id: f.roomId,
    text: 'still here?',
    idempotency_key: randomUUID(),
  });
  assert.equal(bravoAfter.statusCode, 404, bravoAfter.body);
  const list = (await f.console(f.c, 'GET', '/api/messages/conversations')).json();
  assert.equal(list.conversations[0].message_count, 1);
});

test('mutes, the host switch, closed rooms and notification mutes are respected', async (t) => {
  const f = await fixture(t);
  // The host mutes Bravo: Bravo cannot write from the room, and cannot be written to from it.
  const muted = await f.console(f.a, 'POST', `/api/rooms/${f.roomId}/mute`, {
    agent_id: f.bravo,
    muted: true,
  });
  assert.equal(muted.statusCode, 200, muted.body);
  const to = await f.write(f.c, f.dana, f.bravo, 'hello');
  assert.equal(to.statusCode, 403, to.body);
  assert.equal(to.json().code, 'recipient_muted');
  const from = await f.tool(f.b.key, 'city_send_message', {
    from_agent_id: f.bravo,
    to_agent_id: f.dana,
    room_id: f.roomId,
    text: 'hello',
    idempotency_key: randomUUID(),
  });
  assert.equal(from.statusCode, 403, from.body);
  assert.equal(from.json().code, 'muted');
  await f.console(f.a, 'POST', `/api/rooms/${f.roomId}/mute`, { agent_id: f.bravo, muted: false });

  // An @mention in a private message is recorded for the AI recipient, like any direct message.
  const countMentions = async () =>
    Number(
      (
        await f.app.city.db.query<{ n: number | string }>(
          'SELECT count(*) AS n FROM mentions WHERE agent_id=$1',
          [f.bravo],
        )
      ).rows[0]!.n,
    );
  assert.equal((await f.write(f.c, f.dana, f.bravo, '@Bravo first ping')).statusCode, 201);
  assert.equal(await countMentions(), 1);
  // Bravo muted the room's notifications: the message lands, but records no @mention.
  const quiet = await f.console(f.b, 'POST', `/api/rooms/${f.roomId}/notifications`, {
    muted: true,
  });
  assert.equal(quiet.statusCode, 200, quiet.body);
  const delivered = await f.write(f.c, f.dana, f.bravo, '@Bravo are you there?');
  assert.equal(delivered.statusCode, 201, delivered.body);
  assert.equal(await countMentions(), 1);
  assert.equal((await f.ok(f.b.key, 'city_read_inbox', { agent_id: f.bravo })).messages.length, 2);

  // The host turns private messages off: refused for everyone; members' consoles see the switch.
  const off = await f.console(f.a, 'POST', `/api/rooms/${f.roomId}/people`, {
    members_may_dm: false,
  });
  assert.equal(off.statusCode, 200, off.body);
  assert.equal(off.json().room.members_may_dm, false);
  const memberView = (await f.console(f.c, 'GET', '/api/rooms')).json();
  assert.equal(
    memberView.rooms.find((room: { id: string }) => room.id === f.roomId).members_may_dm,
    false,
  );
  const refused = await f.open(f.c, f.bravo);
  assert.equal(refused.statusCode, 403, refused.body);
  assert.equal(refused.json().code, 'direct_messages_off');
  // A member is not the host: it cannot turn the switch back on.
  const notHost = await f.console(f.b, 'POST', `/api/rooms/${f.roomId}/people`, {
    members_may_dm: true,
  });
  assert.equal(notHost.statusCode, 403, notHost.body);
  await f.console(f.a, 'POST', `/api/rooms/${f.roomId}/people`, { members_may_dm: true });

  // A closed room: no new private messages from it; existing threads stay readable.
  await f.ok(f.a.key, 'city_room_close', { room_id: f.roomId });
  const closed = await f.write(f.c, f.dana, f.bravo, 'after close');
  assert.equal(closed.statusCode, 409, closed.body);
  assert.equal(closed.json().code, 'room_closed');
  const list = (await f.console(f.c, 'GET', '/api/messages/conversations')).json();
  assert.equal(list.conversations.length, 1);
});

test('your own AI: a person opens a 1:1 thread with it from the room and it answers', async (t) => {
  const f = await fixture(t);
  const danaAi = await f.agent(f.c, 'Dana assistant');
  await f.ok(f.c.key, 'city_join_room', {
    link: f.link.link,
    agent_id: danaAi,
    idempotency_key: randomUUID(),
  });
  const opened = await f.open(f.c, danaAi);
  assert.equal(opened.statusCode, 200, opened.body);
  assert.equal(opened.json().self.id, f.dana);
  assert.equal(opened.json().peer.id, danaAi);
  const sent = await f.write(f.c, f.dana, danaAi, 'Please draft the agenda.');
  assert.equal(sent.statusCode, 201, sent.body);
  // Between two of your own members the message is internal: no owner label.
  assert.equal(sent.json().message.origin, 'internal');
  assert.equal(sent.json().message.from_owner_label, null);
  const inbox = await f.ok(f.c.key, 'city_read_inbox', { agent_id: danaAi });
  assert.equal(inbox.messages.length, 1);
  const reply = await f.ok(f.c.key, 'city_send_message', {
    from_agent_id: danaAi,
    to_agent_id: f.dana,
    reply_to: inbox.messages[0].id,
    text: 'Draft is ready.',
    idempotency_key: randomUUID(),
  });
  assert.equal(reply.message.context_id, opened.json().context_id);
  // One thread in Messages, seen from Dana's person whoever wrote last. Neither side's message
  // is unread for Dana's owner: both members are its own.
  const list = (await f.console(f.c, 'GET', '/api/messages/conversations')).json();
  assert.equal(list.conversations.length, 1);
  assert.equal(list.conversations[0].direct.self.id, f.dana);
  assert.equal(list.conversations[0].direct.peer.id, danaAi);
  assert.equal(list.conversations[0].unread, 0);
  // Two AIs of the same owner: a shared room is no substitute for the workspace connection.
  const second = await f.agent(f.a, 'Host helper');
  await f.ok(f.a.key, 'city_join_room', {
    link: f.link.link,
    agent_id: second,
    idempotency_key: randomUUID(),
  });
  const viaRoom = (from: string, to: string) =>
    f.tool(f.a.key, 'city_send_message', {
      from_agent_id: from,
      to_agent_id: to,
      room_id: f.roomId,
      text: 'sibling ping',
      idempotency_key: randomUUID(),
    });
  // Without a connection: refused over MCP and from the console (the host has no person here).
  const refused = await viaRoom(f.hostAgent, second);
  assert.equal(refused.statusCode, 403, refused.body);
  assert.equal(refused.json().code, 'connection_required');
  const consoleOpen = await f.open(f.a, second);
  assert.equal(consoleOpen.statusCode, 403, consoleOpen.body);
  assert.equal(consoleOpen.json().code, 'connection_required');
  // With the directional connection: allowed one way, still refused the other.
  const connected = await f.console(f.a, 'POST', '/api/connections', {
    fromAgentId: f.hostAgent,
    toAgentId: second,
  });
  assert.ok([200, 201].includes(connected.statusCode), connected.body);
  const allowed = await viaRoom(f.hostAgent, second);
  assert.equal(allowed.statusCode, 200, allowed.body);
  assert.equal(allowed.json().message.origin, 'internal');
  const back = await viaRoom(second, f.hostAgent);
  assert.equal(back.statusCode, 403, back.body);
  assert.equal(back.json().code, 'connection_required');
  const hostOwn = await f.open(f.a, second);
  assert.equal(hostOwn.statusCode, 200, hostOwn.body);
  assert.equal(hostOwn.json().self.id, f.hostAgent);
});

test('invite guests: messaged privately, they read, acknowledge and answer with their credential', async (t) => {
  const f = await fixture(t);
  const guest = await f.guestSession('Guest AI');
  const other = await f.guestSession('Other guest');
  // Dana (a person) and Bravo (another owner's AI) both reach the guest.
  const opened = await f.open(f.c, guest.id);
  assert.equal(opened.statusCode, 200, opened.body);
  assert.equal((await f.write(f.c, f.dana, guest.id, 'Hello guest')).statusCode, 201);
  await f.ok(f.b.key, 'city_send_message', {
    from_agent_id: f.bravo,
    to_agent_id: guest.id,
    room_id: f.roomId,
    text: 'Hi from Bravo',
    idempotency_key: randomUUID(),
  });
  // The room read tells the guest it has private messages waiting.
  const room = await f.guestTool(guest.credential, 'city_room_read', {});
  assert.equal(room.code, null);
  assert.equal(room.result['private_unread'], 2);
  const read = await f.guestTool(guest.credential, 'city_room_dm_read', {});
  assert.equal(read.code, null, JSON.stringify(read));
  const messages = read.result['messages'] as Array<{
    id: string;
    seq: number;
    from_agent_id: string;
  }>;
  assert.deepEqual(
    messages.map((message) => message.from_agent_id),
    [f.dana, f.bravo],
  );
  assert.equal(read.result['agent_id'], guest.id);
  // The guest answers Dana in the same thread, and Dana sees it.
  const answered = await f.guestTool(guest.credential, 'city_room_dm_send', {
    to_agent_id: f.dana,
    reply_to: messages[0]!.id,
    text: 'Hello Dana',
    idempotency_key: randomUUID(),
  });
  assert.equal(answered.code, null, JSON.stringify(answered));
  const thread = (
    await f.console(f.c, 'GET', `/api/messages/conversations/${opened.json().context_id}`)
  ).json();
  assert.deepEqual(
    thread.messages.map((message: { parts: Array<{ text: string }> }) => message.parts[0]!.text),
    ['Hello guest', 'Hello Dana'],
  );
  // Acknowledged messages are not read again; the room read stops counting them.
  const acked = await f.guestTool(guest.credential, 'city_room_dm_ack', {
    seq: messages[1]!.seq,
  });
  assert.equal(acked.code, null);
  assert.equal(acked.result['unread'], 0);
  const again = await f.guestTool(guest.credential, 'city_room_dm_read', {});
  assert.equal((again.result['messages'] as unknown[]).length, 0);
  const quiet = await f.guestTool(guest.credential, 'city_room_read', {});
  assert.equal(quiet.result['private_unread'], undefined);
  // A credential never reads anyone else's private messages: another guest's inbox is its own
  // (empty), and naming another member's id is refused.
  const otherRead = await f.guestTool(other.credential, 'city_room_dm_read', {});
  assert.equal(otherRead.result['agent_id'], other.id);
  assert.deepEqual(otherRead.result['messages'], []);
  const prying = await f.guestTool(other.credential, 'city_room_dm_read', {
    agent_id: guest.id,
  });
  assert.notEqual(prying.code, null);
  const viaRest = await f.app.inject({
    method: 'POST',
    url: '/api/public/invites/tools/city_room_dm_read',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${other.credential}`,
      host: 'centralcity.ai',
    },
    payload: JSON.stringify({ agent_id: guest.id }),
    remoteAddress: '198.51.100.8',
  });
  assert.ok([400, 403].includes(viaRest.statusCode), viaRest.body);
  assert.doesNotMatch(viaRest.body, /Hello guest/);
  // The guest's own credential cannot be sent in a private message.
  const leak = await f.guestTool(guest.credential, 'city_room_dm_send', {
    to_agent_id: f.dana,
    text: `my key ${guest.credential}`,
    idempotency_key: randomUUID(),
  });
  assert.equal(leak.code, 'credential_in_message');
  // A removed guest's credential stops working for private messages too.
  const removed = await f.console(
    f.a,
    'POST',
    `/api/rooms/${f.roomId}/members/${guest.id}/remove`,
    { block_rejoin: true },
  );
  assert.equal(removed.statusCode, 200, removed.body);
  assert.notEqual((await f.guestTool(guest.credential, 'city_room_dm_read', {})).code, null);
  assert.equal((await f.write(f.c, f.dana, guest.id, 'still there?')).statusCode, 403);
});

test('read-only members can neither send nor receive private messages', async (t) => {
  const f = await fixture(t);
  await f.app.city.db.query(
    "UPDATE room_members SET role='guest' WHERE room_id=$1 AND agent_id=$2",
    [f.roomId, f.bravo],
  );
  const toReadOnly = await f.write(f.c, f.dana, f.bravo, 'hello');
  assert.equal(toReadOnly.statusCode, 403, toReadOnly.body);
  assert.equal(toReadOnly.json().code, 'guest_no_direct');
  const fromReadOnly = await f.tool(f.b.key, 'city_send_message', {
    from_agent_id: f.bravo,
    to_agent_id: f.dana,
    room_id: f.roomId,
    text: 'hello',
    idempotency_key: randomUUID(),
  });
  assert.equal(fromReadOnly.statusCode, 403, fromReadOnly.body);
  assert.equal(fromReadOnly.json().code, 'guest_no_direct');
});

test('Delete conversation hides a thread for one person until a newer message arrives', async (t) => {
  const f = await fixture(t);
  const sent = await f.write(f.c, f.dana, f.bravo, 'First');
  assert.equal(sent.statusCode, 201, sent.body);
  const context = sent.json().message.context_id as string;
  const hide = (who: Owner, id = context) =>
    f.console(who, 'POST', `/api/messages/conversations/${encodeURIComponent(id)}/hide`, {});
  const list = async (who: Owner) =>
    (await f.console(who, 'GET', '/api/messages/conversations')).json().conversations as Array<{
      context_id: string;
    }>;
  // Only participants: another owner gets the same 404 as for an unknown thread.
  const outsider = await hide(f.a);
  assert.equal(outsider.statusCode, 404, outsider.body);
  assert.equal(outsider.json().code, 'conversation_not_found');
  assert.equal((await hide(f.c, 'no-such-thread')).statusCode, 404);
  assert.equal((await hide(f.c, 'bad id!')).statusCode, 400);
  // Signed out: refused.
  const anonymous = await f.app.inject({
    method: 'POST',
    url: `/api/messages/conversations/${context}/hide`,
    headers: {
      'content-type': 'application/json',
      'x-city-request': '1',
      host: 'centralcity.ai',
      origin: ORIGIN,
    },
    payload: '{}',
  });
  assert.equal(anonymous.statusCode, 401, anonymous.body);
  // Dana hides it: gone from her list, still in Bravo's owner's list and Bravo's inbox.
  const hidden = await hide(f.c);
  assert.equal(hidden.statusCode, 200, hidden.body);
  assert.equal(hidden.json().context_id, context);
  assert.deepEqual(await list(f.c), []);
  assert.deepEqual(
    (await list(f.b)).map((item) => item.context_id),
    [context],
  );
  assert.equal((await f.ok(f.b.key, 'city_read_inbox', { agent_id: f.bravo })).messages.length, 1);
  // Hiding again is fine; the thread itself is still readable by its participants.
  assert.equal((await hide(f.c)).statusCode, 200);
  const thread = await f.console(f.c, 'GET', `/api/messages/conversations/${context}`);
  assert.equal(thread.json().messages.length, 1);
  // A newer message brings the whole thread back.
  await new Promise((resolve) => setTimeout(resolve, 5));
  await f.ok(f.b.key, 'city_send_message', {
    from_agent_id: f.bravo,
    to_agent_id: f.dana,
    room_id: f.roomId,
    text: 'Second',
    idempotency_key: randomUUID(),
  });
  assert.deepEqual(
    (await list(f.c)).map((item) => item.context_id),
    [context],
  );
});

test('Delete conversation is rate-limited per person', async (t) => {
  // The limiter counts in fixed one-minute windows aligned to the clock. On the wall clock the
  // calls could straddle a minute boundary and never reach the limit, so the app gets its own
  // clock: 1 s into a minute, moving 1 ms per read, far from the next boundary.
  let time = Date.UTC(2026, 0, 15, 12, 0, 1);
  const f = await fixture(t, undefined, undefined, () => time++);
  const sent = await f.write(f.c, f.dana, f.bravo, 'Hello');
  const context = sent.json().message.context_id as string;
  const hide = () => f.console(f.c, 'POST', `/api/messages/conversations/${context}/hide`, {});
  const codes: number[] = [];
  for (let i = 0; i < HIDES_PER_MINUTE + 2; i++) codes.push((await hide()).statusCode);
  assert.deepEqual(codes, [
    ...Array<number>(HIDES_PER_MINUTE).fill(200),
    ...Array<number>(2).fill(429),
  ]);
  // The limit is per minute: the next window allows hiding again.
  time = (Math.floor(time / 60_000) + 1) * 60_000 + 1_000;
  assert.equal((await hide()).statusCode, 200);
});

test('New message lists the members of your rooms you can message privately', async (t) => {
  const f = await fixture(t);
  const guest = await f.guestJoin();
  const danaAi = await f.agent(f.c, 'Dana assistant');
  await f.ok(f.c.key, 'city_join_room', {
    link: f.link.link,
    agent_id: danaAi,
    idempotency_key: randomUUID(),
  });
  const res = await f.console(f.c, 'GET', '/api/messages/recipients');
  assert.equal(res.statusCode, 200, res.body);
  const recipients = res.json().recipients as Array<{
    member_id: string;
    room_id: string;
    own: boolean;
    owner_label: string | null;
  }>;
  // Everyone else in the room (other owners' AIs, guests, her own AI), never herself.
  assert.deepEqual(
    recipients.map((item) => item.member_id).sort(),
    [f.bravo, f.hostAgent, guest, danaAi].sort(),
  );
  assert.ok(recipients.every((item) => item.room_id === f.roomId));
  const own = recipients.find((item) => item.member_id === danaAi)!;
  assert.equal(own.own, true);
  assert.equal(own.owner_label, null);
  // The host turns private messages off: nobody is offered.
  await f.console(f.a, 'POST', `/api/rooms/${f.roomId}/people`, { members_may_dm: false });
  assert.deepEqual((await f.console(f.c, 'GET', '/api/messages/recipients')).json().recipients, []);
});

test('Elric is not a private-message target from a room', async (t) => {
  const f = await fixture(t);
  // Mark Bravo as an Elric agent (the row Elric's own setup writes); the rule is by agent id.
  const now = Date.now();
  await f.app.city.db.query(
    `INSERT INTO elric_agents(agent_id, owner_id, created_at, updated_at, updated_by)
     VALUES($1, $2, $3, $3, 'synthetic test')`,
    [f.bravo, f.b.id, now],
  );
  const refused = await f.open(f.c, f.bravo);
  assert.equal(refused.statusCode, 403, refused.body);
  assert.equal(refused.json().code, 'elric_private_chat');
});

const bravoSays = (
  f: Awaited<ReturnType<typeof fixture>>,
  text: string,
  extra: Record<string, unknown>,
  from = f.bravo,
) =>
  f.tool(f.b.key, 'city_send_message', {
    from_agent_id: from,
    to_agent_id: f.dana,
    text,
    idempotency_key: randomUUID(),
    ...extra,
  });

test('the per-pair budget also covers replies that name only reply_to', async (t) => {
  const f = await fixture(t, { crossPairPerMinute: 3 });
  const first = await f.write(f.c, f.dana, f.bravo, 'one');
  assert.equal(first.statusCode, 201, first.body);
  const replyTo = first.json().message.id as string;
  for (const text of ['two', 'three']) {
    const res = await bravoSays(f, text, { reply_to: replyTo });
    assert.equal(res.statusCode, 200, res.body);
  }
  const over = await bravoSays(f, 'four', { reply_to: replyTo });
  assert.equal(over.statusCode, 429, over.body);
  const overRoom = await bravoSays(f, 'five', { room_id: f.roomId });
  assert.equal(overRoom.statusCode, 429, overRoom.body);
});

test("nobody can spend another pair's budget with ids they do not own", async (t) => {
  const f = await fixture(t, { crossPairPerMinute: 3 });
  // An outsider names Bravo -> Dana (not its member) and its own agent -> Dana (not in the room).
  const d = await f.owner('Outsider workspace');
  const delta = await f.agent(d, 'Delta');
  for (let i = 0; i < 5; i++) {
    for (const from of [f.bravo, delta]) {
      const res = await f.tool(d.key, 'city_send_message', {
        from_agent_id: from,
        to_agent_id: f.dana,
        room_id: f.roomId,
        text: 'spam',
        idempotency_key: randomUUID(),
      });
      assert.ok([403, 404].includes(res.statusCode), res.body);
    }
    // And through the console route, naming members it does not own.
    const res = await f.console(d, 'POST', `/api/rooms/${f.roomId}/direct/messages`, {
      from: f.dana,
      to: f.bravo,
      text: 'spam',
      idempotency_key: randomUUID(),
    });
    assert.equal(res.statusCode, 404, res.body);
  }
  // The real pair still has its whole budget.
  for (const text of ['a', 'b', 'c']) {
    const res = await f.write(f.c, f.dana, f.bravo, text);
    assert.equal(res.statusCode, 201, res.body);
  }
});

test("a person's inbox drains when the console reads the thread, so quota and depth recover", async (t) => {
  // Depth 8: one sending owner may hold 2 unacknowledged messages in an inbox.
  const f = await fixture(t, { inboxDepth: 8 });
  for (const text of ['a', 'b']) {
    const res = await bravoSays(f, text, { room_id: f.roomId });
    assert.equal(res.statusCode, 200, res.body);
  }
  const quota = await bravoSays(f, 'c', { room_id: f.roomId });
  assert.equal(quota.statusCode, 429, quota.body);
  assert.equal(quota.json().code, 'remote_quota');
  const context = (await f.open(f.c, f.bravo)).json().context_id as string;
  // Only the console marks it read; another owner cannot ack Dana's inbox.
  const foreign = await f.console(f.b, 'POST', `/api/messages/direct/${context}/read`, {});
  assert.equal(foreign.statusCode, 200, foreign.body);
  assert.deepEqual(foreign.json().acked, []);
  const read = await f.console(f.c, 'POST', `/api/messages/direct/${context}/read`, {});
  assert.equal(read.statusCode, 200, read.body);
  assert.deepEqual(read.json().acked, [
    { agent_id: f.dana, acked_seq: 2, latest_seq: 2, unread: 0 },
  ]);
  // Past both limits: 8 more (4 rounds of 2), 10 in all against a depth of 8, each round drained by reading the thread.
  for (let round = 0; round < 4; round++) {
    for (const text of ['x', 'y']) {
      const res = await bravoSays(f, `${text}${round}`, { room_id: f.roomId });
      assert.equal(res.statusCode, 200, res.body);
    }
    await f.console(f.c, 'POST', `/api/messages/direct/${context}/read`, {});
  }
  const cursor = (
    await f.app.city.db.query<{ next_seq: number | string; acked_seq: number | string }>(
      'SELECT next_seq, acked_seq FROM inbox_cursors WHERE agent_id=$1',
      [f.dana],
    )
  ).rows[0]!;
  assert.equal(Number(cursor.next_seq) - 1, 10, 'more than the whole depth was delivered');
  assert.equal(Number(cursor.acked_seq), 10);
  // A key (Dana's account's own assistant grant) cannot mark a person's thread read.
  const key = await f.app.inject({
    method: 'POST',
    url: `/api/messages/direct/${context}/read`,
    headers: {
      'content-type': 'application/json',
      'x-city-request': '1',
      host: 'centralcity.ai',
      origin: ORIGIN,
      authorization: `Bearer ${f.c.key}`,
    },
    payload: '{}',
  });
  assert.notEqual(key.statusCode, 200);
});

test("one unread thread does not hold a person's read messages against quota and depth", async (t) => {
  // Depth 8: one sending owner may hold 2 unacknowledged messages in an inbox.
  const f = await fixture(t, { inboxDepth: 8 });
  // The host's AI writes to Dana first; she leaves it unread, so her cursor stays below it.
  const hostSays = await f.tool(f.a.key, 'city_send_message', {
    from_agent_id: f.hostAgent,
    to_agent_id: f.dana,
    text: 'from the host',
    idempotency_key: randomUUID(),
    room_id: f.roomId,
  });
  assert.equal(hostSays.statusCode, 200, hostSays.body);
  const context = (await f.open(f.c, f.bravo)).json().context_id as string;
  // Bravo and Dana chat on, past both limits (10 messages from Bravo against a depth of 8), and
  // Dana reads each round.
  for (let round = 0; round < 5; round++) {
    for (const text of ['x', 'y']) {
      const res = await bravoSays(f, `${text}${round}`, { room_id: f.roomId });
      assert.equal(res.statusCode, 200, res.body);
    }
    const read = await f.console(f.c, 'POST', `/api/messages/direct/${context}/read`, {});
    assert.equal(read.statusCode, 200, read.body);
    assert.equal(read.json().acked[0].acked_seq, 0, 'the cursor stays below the unread one');
  }
  // Unread messages still count: two unread from Bravo, then remote_quota.
  for (const text of ['p', 'q']) {
    const res = await bravoSays(f, text, { room_id: f.roomId });
    assert.equal(res.statusCode, 200, res.body);
  }
  const quota = await bravoSays(f, 'r', { room_id: f.roomId });
  assert.equal(quota.statusCode, 429, quota.body);
  assert.equal(quota.json().code, 'remote_quota');
});

test("a person's span above one unread thread stays capped, so the inbox scans stay bounded", async (t) => {
  // Depth 4: one sending owner may hold 1 unacknowledged message; the span cap is 4 depths (16).
  const f = await fixture(t, { inboxDepth: 4 });
  const hostSays = await f.tool(f.a.key, 'city_send_message', {
    from_agent_id: f.hostAgent,
    to_agent_id: f.dana,
    text: 'from the host',
    idempotency_key: randomUUID(),
    room_id: f.roomId,
  });
  assert.equal(hostSays.statusCode, 200, hostSays.body);
  const context = (await f.open(f.c, f.bravo)).json().context_id as string;
  // Dana reads every message from Bravo, never the host's: 15 read messages pile up above it.
  for (let n = 0; n < 15; n++) {
    const res = await bravoSays(f, `m${n}`, { room_id: f.roomId });
    assert.equal(res.statusCode, 200, res.body);
    const read = await f.console(f.c, 'POST', `/api/messages/direct/${context}/read`, {});
    assert.equal(read.statusCode, 200, read.body);
    assert.equal(read.json().acked[0].acked_seq, 0, 'the cursor stays below the unread one');
  }
  // The span is full: no more messages until the old thread is read.
  const full = await bravoSays(f, 'over', { room_id: f.roomId });
  assert.equal(full.statusCode, 429, full.body);
  assert.equal(full.json().code, 'inbox_full');
  const hostThread = (await f.open(f.c, f.hostAgent)).json().context_id as string;
  const read = await f.console(f.c, 'POST', `/api/messages/direct/${hostThread}/read`, {});
  assert.equal(read.statusCode, 200, read.body);
  assert.equal(read.json().acked[0].acked_seq, 16, 'reading the old thread frees the span');
  const again = await bravoSays(f, 'again', { room_id: f.roomId });
  assert.equal(again.statusCode, 200, again.body);
});

/** owner_label of each member as the room's own member list shows it to `who`. */
async function roomLabels(f: Awaited<ReturnType<typeof fixture>>, who: Owner) {
  const res = await f.console(who, 'GET', `/api/rooms/${f.roomId}/members`);
  assert.equal(res.statusCode, 200, res.body);
  return new Map(
    (res.json().members as { id: string; owner_label: string }[]).map((m) => [m.id, m.owner_label]),
  );
}
type Summary = {
  context_id: string;
  unread: number;
  unread_capped: boolean;
  direct?: {
    self: { owner_label: string | null; is_self: boolean };
    peer: { owner_label: string | null; is_self: boolean };
  };
};
const listOf = async (f: Awaited<ReturnType<typeof fixture>>, who: Owner) => {
  const res = await f.console(who, 'GET', '/api/messages/conversations?limit=100');
  assert.equal(res.statusCode, 200, res.body);
  return res.json().conversations as Summary[];
};

test('conversation unread: only messages to the viewer, cleared by the thread read and by acks', async (t) => {
  const f = await fixture(t);
  const context = (await f.open(f.c, f.bravo)).json().context_id as string;
  // A thread opened without messages is not listed yet.
  assert.equal((await listOf(f, f.c)).length, 0);
  for (const text of ['one', 'two']) {
    const res = await bravoSays(f, text, { room_id: f.roomId });
    assert.equal(res.statusCode, 200, res.body);
  }
  let dana = (await listOf(f, f.c))[0]!;
  assert.equal(dana.context_id, context);
  assert.deepEqual([dana.unread, dana.unread_capped], [2, false]);
  // Bravo's own messages are not unread for its owner.
  assert.equal((await listOf(f, f.b))[0]!.unread, 0);
  // Dana answers: unread for Bravo's owner; replying marks the thread read for Dana.
  assert.equal((await f.write(f.c, f.dana, f.bravo, 'three')).statusCode, 201);
  assert.equal((await listOf(f, f.c))[0]!.unread, 0);
  const bravoView = (await listOf(f, f.b))[0]!;
  assert.equal(bravoView.unread, 1);
  assert.equal((await bravoSays(f, 'three and a half', { room_id: f.roomId })).statusCode, 200);
  assert.equal((await listOf(f, f.c))[0]!.unread, 1);
  // The room-origin person thread read (console) clears Dana's count.
  const read = await f.console(f.c, 'POST', `/api/messages/direct/${context}/read`, {});
  assert.equal(read.statusCode, 200, read.body);
  dana = (await listOf(f, f.c))[0]!;
  assert.equal(dana.unread, 0);
  // Another message after the read counts again.
  assert.equal((await bravoSays(f, 'four', { room_id: f.roomId })).statusCode, 200);
  assert.equal((await listOf(f, f.c))[0]!.unread, 1);
  // The AI side clears through its inbox ack, like city_ack_inbox always did.
  const inbox = await f.ok(f.b.key, 'city_read_inbox', { agent_id: f.bravo });
  await f.ok(f.b.key, 'city_ack_inbox', { agent_id: f.bravo, seq: inbox.latest_seq });
  assert.equal((await listOf(f, f.b))[0]!.unread, 0);
  // Nobody else sees a count for it.
  assert.equal((await listOf(f, f.a)).length, 0);
});

test('unread counts only messages received from someone else, never your own members', async (t) => {
  const f = await fixture(t);
  // Dana's owner has two AIs in the room; one writes to the other (connection) and to Dana.
  const scout = await f.agent(f.c, 'Scout');
  const relay = await f.agent(f.c, 'Relay');
  for (const id of [scout, relay])
    await f.ok(f.c.key, 'city_join_room', {
      link: f.link.link,
      agent_id: id,
      idempotency_key: randomUUID(),
    });
  const connected = await f.console(f.c, 'POST', '/api/connections', {
    fromAgentId: scout,
    toAgentId: relay,
  });
  assert.ok([200, 201].includes(connected.statusCode), connected.body);
  const sibling = await f.console(f.c, 'POST', `/api/agents/${scout}/messages`, {
    to_agent_id: relay,
    text: 'Sibling note',
    idempotency_key: randomUUID(),
  });
  assert.equal(sibling.statusCode, 201, sibling.body);
  const toPerson = await f.ok(f.c.key, 'city_send_message', {
    from_agent_id: scout,
    to_agent_id: f.dana,
    room_id: f.roomId,
    text: 'Status for you',
    idempotency_key: randomUUID(),
  });
  assert.ok(toPerson.message.id);
  const summary = async () =>
    new Map(
      (
        (await f.console(f.c, 'GET', '/api/messages/summary')).json().inboxes as {
          agent_id: string;
          unread: number;
        }[]
      ).map((item) => [item.agent_id, item.unread]),
    );
  const total = async () => [...(await summary()).values()].reduce((sum, n) => sum + n, 0);
  // Relay and Dana each hold an unacknowledged message, but both came from Dana's own AI.
  assert.equal((await summary()).get(relay), 0);
  assert.equal(await total(), 0);
  assert.ok((await listOf(f, f.c)).every((item) => item.unread === 0));
  // A message from another owner is unread for Dana's owner until the thread is read.
  assert.equal((await bravoSays(f, 'Real question', { room_id: f.roomId })).statusCode, 200);
  assert.equal((await summary()).get(f.dana), 1);
  assert.equal(await total(), 1);
  const context = (await f.open(f.c, f.bravo)).json().context_id as string;
  const unreadOf = async () => (await listOf(f, f.c)).reduce((sum, item) => sum + item.unread, 0);
  assert.equal(await unreadOf(), 1);
  const read = await f.console(f.c, 'POST', `/api/messages/direct/${context}/read`, {});
  assert.equal(read.statusCode, 200, read.body);
  assert.equal(await total(), 0);
  assert.equal(await unreadOf(), 0);
  // Dana answers Bravo, another owner's AI: unread for Bravo's owner until it opens the thread.
  // Reading it in the console clears the owner's count but never acknowledges for the AI.
  assert.equal((await f.write(f.c, f.dana, f.bravo, 'Real answer')).statusCode, 201);
  const bravoSummary = async () =>
    (await f.console(f.b, 'GET', '/api/messages/summary'))
      .json()
      .inboxes.find((item: { agent_id: string }) => item.agent_id === f.bravo).unread as number;
  assert.equal(await bravoSummary(), 1);
  assert.equal((await listOf(f, f.b))[0]!.unread, 1);
  const ownerRead = await f.console(f.b, 'POST', `/api/messages/direct/${context}/read`, {});
  assert.equal(ownerRead.statusCode, 200, ownerRead.body);
  assert.deepEqual(ownerRead.json().acked, []);
  assert.equal(await bravoSummary(), 0);
  assert.equal((await listOf(f, f.b))[0]!.unread, 0);
  const aiInbox = await f.ok(f.b.key, 'city_read_inbox', { agent_id: f.bravo });
  assert.equal(aiInbox.unread, 1, "the AI's own inbox still holds the message");
  // A newer message counts again.
  assert.equal((await f.write(f.c, f.dana, f.bravo, 'One more')).statusCode, 201);
  assert.equal(await bravoSummary(), 1);
  // Deleting the conversation from Messages reads it too.
  const hidden = await f.console(f.b, 'POST', `/api/messages/conversations/${context}/hide`, {});
  assert.equal(hidden.statusCode, 200, hidden.body);
  assert.equal(await bravoSummary(), 0);
});

test('conversation unread is capped at 99 with unread_capped', async (t) => {
  const f = await fixture(t);
  const context = (await f.open(f.c, f.bravo)).json().context_id as string;
  assert.equal((await bravoSays(f, 'start', { room_id: f.roomId })).statusCode, 200);
  // Synthetic backlog straight into Dana's inbox (sending 120 would hit the send rate limit).
  const db = f.app.city.db;
  const template = (
    await db.query<Record<string, unknown>>(
      'SELECT * FROM messages WHERE recipient_id=$1 AND seq=1',
      [f.dana],
    )
  ).rows[0]!;
  for (let seq = 2; seq <= 121; seq++)
    await db.query(
      `INSERT INTO messages(recipient_id,seq,id,sender_id,sender_owner_id,recipient_owner_id,context_id,
        kind,parts,created_at,origin,sender_owner_label,room_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,'message',$8,$9,$10,$11,$12)`,
      [
        f.dana,
        seq,
        randomUUID(),
        template['sender_id'],
        template['sender_owner_id'],
        template['recipient_owner_id'],
        context,
        JSON.stringify([{ type: 'text', text: `m${seq}` }]),
        Number(template['created_at']) + seq,
        template['origin'],
        template['sender_owner_label'],
        template['room_id'],
      ],
    );
  await db.query('UPDATE inbox_cursors SET next_seq=122 WHERE agent_id=$1', [f.dana]);
  const capped = (await listOf(f, f.c))[0]!;
  assert.deepEqual([capped.unread, capped.unread_capped], [99, true]);
  // Exactly at the cap is not "capped".
  await db.query('UPDATE inbox_cursors SET acked_seq=22 WHERE agent_id=$1', [f.dana]);
  const exact = (await listOf(f, f.c))[0]!;
  assert.deepEqual([exact.unread, exact.unread_capped], [99, false]);
});

test('owner_label in private threads is the room member label and leaks no owner details', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.write(f.c, f.dana, f.bravo, 'hello')).statusCode, 201);
  for (const [who, self, peer] of [
    [f.c, f.dana, f.bravo],
    [f.b, f.bravo, f.dana],
  ] as const) {
    const labels = await roomLabels(f, who);
    const direct = (await listOf(f, who))[0]!.direct!;
    assert.equal(direct.self.owner_label, labels.get(self));
    // direct.self is always the viewer's own member: the UI renders it as "You".
    assert.equal(direct.self.is_self, true);
    assert.equal(direct.peer.is_self, false);
    assert.equal(direct.peer.owner_label, labels.get(peer));
  }
  const labels = await roomLabels(f, f.c);
  // Bravo's owner is an AI workspace, so its label is the workspace name; Dana's is a person's
  // account, so hers is the opaque account label, never her sign-in name (ownerLabel).
  assert.equal(labels.get(f.bravo), 'Member workspace');
  assert.match(labels.get(f.dana)!, /^Account [0-9a-f]{8}$/);
  // The whole listing carries no owner id, account name or email of either owner.
  for (const who of [f.b, f.c]) {
    const body = (await f.console(who, 'GET', '/api/messages/conversations')).body;
    const other = who === f.b ? f.c : f.b;
    for (const secret of [other.id, 'Dana account', 'Member workspace person', '@'])
      assert.ok(!body.includes(secret), `listing leaks ${secret}`);
  }
});

test('conversation listing runs a bounded number of statements however many threads there are', async (t) => {
  const base = await PGlite.create('memory://');
  const state = { on: false, statements: 0 };
  const counted = (tx: { query: PGlite['query']; exec: PGlite['exec'] }) => ({
    query: ((sql: string, params?: unknown[]) => {
      if (state.on) state.statements++;
      return tx.query(sql, params);
    }) as PGlite['query'],
    exec: ((sql: string) => tx.exec(sql)) as PGlite['exec'],
  });
  const database = new Proxy(base, {
    get(target, key) {
      if (key === 'query') return counted(target).query;
      if (key === 'transaction')
        return (fn: (tx: unknown) => Promise<unknown>) =>
          target.transaction((tx) => fn(counted(tx)));
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const f = await fixture(t, undefined, database);
  assert.equal((await bravoSays(f, 'real thread', { room_id: f.roomId })).statusCode, 200);
  const measure = async () => {
    state.statements = 0;
    state.on = true;
    const list = await listOf(f, f.c);
    state.on = false;
    return { list, statements: state.statements };
  };
  const few = await measure();
  assert.equal(few.list.length, 1);
  // 80 more threads into Dana's inbox, half of them read.
  const db = f.app.city.db;
  const template = (
    await db.query<Record<string, unknown>>(
      'SELECT * FROM messages WHERE recipient_id=$1 AND seq=1',
      [f.dana],
    )
  ).rows[0]!;
  for (let seq = 2; seq <= 81; seq++)
    await db.query(
      `INSERT INTO messages(recipient_id,seq,id,sender_id,sender_owner_id,recipient_owner_id,context_id,
        kind,parts,created_at,origin,sender_owner_label,room_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,'message',$8,$9,$10,$11,$12)`,
      [
        f.dana,
        seq,
        randomUUID(),
        template['sender_id'],
        template['sender_owner_id'],
        template['recipient_owner_id'],
        `synthetic-thread-${seq}`,
        JSON.stringify([{ type: 'text', text: `m${seq}` }]),
        Number(template['created_at']) + seq,
        template['origin'],
        template['sender_owner_label'],
        template['room_id'],
      ],
    );
  await db.query('UPDATE inbox_cursors SET next_seq=82, acked_seq=41 WHERE agent_id=$1', [f.dana]);
  const many = await measure();
  assert.equal(many.list.length, 81);
  assert.equal(many.list.filter((c) => c.unread === 1).length, 40);
  assert.equal(many.list.filter((c) => c.unread === 0).length, 41);
  assert.ok(many.statements <= few.statements, `${many.statements} vs ${few.statements}`);
  assert.ok(many.statements <= 16, `${many.statements} statements`);
});

test('replying in a private thread marks it read for the replier, through the same inbox cursor', async (t) => {
  const f = await fixture(t);
  for (const text of ['one', 'two', 'three']) {
    const res = await bravoSays(f, text, { room_id: f.roomId });
    assert.equal(res.statusCode, 200, res.body);
  }
  assert.equal((await listOf(f, f.c))[0]!.unread, 3);
  const reply = await f.write(f.c, f.dana, f.bravo, 'got all three');
  assert.equal(reply.statusCode, 201, reply.body);
  assert.equal((await listOf(f, f.c))[0]!.unread, 0);
  const cursor = (
    await f.app.city.db.query<{ next_seq: number | string; acked_seq: number | string }>(
      'SELECT next_seq, acked_seq FROM inbox_cursors WHERE agent_id=$1',
      [f.dana],
    )
  ).rows[0]!;
  assert.equal(Number(cursor.acked_seq), 3);
  assert.equal(Number(cursor.next_seq) - 1, 3);
  // A later message is unread again; the replier's reply does not count for itself.
  assert.equal((await bravoSays(f, 'four', { room_id: f.roomId })).statusCode, 200);
  assert.equal((await listOf(f, f.c))[0]!.unread, 1);
  // An AI replying does not ack its own inbox: it keeps acknowledging explicitly.
  assert.equal((await listOf(f, f.b))[0]!.unread, 1);
  assert.equal((await bravoSays(f, 'five', { room_id: f.roomId })).statusCode, 200);
  assert.equal((await listOf(f, f.b))[0]!.unread, 1);
  // Nor does a console reply sent as the AI: its runtime still reads from its own ack cursor.
  const bravoAcked = async () =>
    Number(
      (
        await f.app.city.db.query<{ acked_seq: number | string }>(
          'SELECT acked_seq FROM inbox_cursors WHERE agent_id=$1',
          [f.bravo],
        )
      ).rows[0]?.acked_seq ?? 0,
    );
  const before = await bravoAcked();
  const asAi = await f.write(f.b, f.bravo, f.dana, 'answered from the console');
  assert.equal(asAi.statusCode, 201, asAi.body);
  assert.equal(await bravoAcked(), before);
  const inbox = await f.ok(f.b.key, 'city_read_inbox', { agent_id: f.bravo });
  assert.ok(
    (inbox.messages as Array<{ seq: number }>).some((m) => m.seq > before),
    'the AI runtime still receives the unread message',
  );
});

test("reading or answering one private thread leaves a person's other threads unread", async (t) => {
  const f = await fixture(t);
  // The host's AI writes to Dana first (her inbox seq 1), then Bravo (seq 2).
  const hostSays = await f.tool(f.a.key, 'city_send_message', {
    from_agent_id: f.hostAgent,
    to_agent_id: f.dana,
    text: 'from the host',
    idempotency_key: randomUUID(),
    room_id: f.roomId,
  });
  assert.equal(hostSays.statusCode, 200, hostSays.body);
  assert.equal((await bravoSays(f, 'from bravo', { room_id: f.roomId })).statusCode, 200);
  const unreadOf = async (peer: string) => {
    const threads = (await f.console(f.c, 'GET', '/api/messages/conversations?limit=100')).json()
      .conversations as Array<Summary & { participants: string[] }>;
    return threads.find((c) => c.participants.includes(peer))!.unread;
  };
  const badge = async () =>
    (
      (await f.console(f.c, 'GET', '/api/messages/summary')).json().inboxes as Array<{
        agent_id: string;
        unread: number;
      }>
    ).find((i) => i.agent_id === f.dana)!.unread;
  assert.deepEqual(
    [await unreadOf(f.hostAgent), await unreadOf(f.bravo), await badge()],
    [1, 1, 2],
  );
  // Opening Bravo's thread clears only Bravo's.
  const bravoThread = (await f.open(f.c, f.bravo)).json().context_id as string;
  const read = await f.console(f.c, 'POST', `/api/messages/direct/${bravoThread}/read`, {});
  assert.equal(read.statusCode, 200, read.body);
  assert.deepEqual(
    [await unreadOf(f.hostAgent), await unreadOf(f.bravo), await badge()],
    [1, 0, 1],
  );
  // Answering Bravo after a new message of his clears it and still not the host's.
  assert.equal((await bravoSays(f, 'again', { room_id: f.roomId })).statusCode, 200);
  assert.equal((await f.write(f.c, f.dana, f.bravo, 'noted')).statusCode, 201);
  assert.deepEqual(
    [await unreadOf(f.hostAgent), await unreadOf(f.bravo), await badge()],
    [1, 0, 1],
  );
  // Opening the host's thread clears it, and the cursor then covers the whole inbox again.
  const hostThread = (await f.open(f.c, f.hostAgent)).json().context_id as string;
  const all = await f.console(f.c, 'POST', `/api/messages/direct/${hostThread}/read`, {});
  assert.deepEqual(all.json().acked, [
    { agent_id: f.dana, acked_seq: 3, latest_seq: 3, unread: 0 },
  ]);
  assert.deepEqual(
    [await unreadOf(f.hostAgent), await unreadOf(f.bravo), await badge()],
    [0, 0, 0],
  );
});

test('conversation unread reads rows bounded by the unread messages, not the thread history', async (t) => {
  const base = await PGlite.create('memory://');
  const captured: { sql: string; params: unknown[] }[] = [];
  const capture = (tx: { query: PGlite['query']; exec: PGlite['exec'] }) => ({
    query: ((sql: string, params?: unknown[]) => {
      if (sql.includes('CROSS JOIN LATERAL')) captured.push({ sql, params: params ?? [] });
      return tx.query(sql, params);
    }) as PGlite['query'],
    exec: ((sql: string) => tx.exec(sql)) as PGlite['exec'],
  });
  const database = new Proxy(base, {
    get(target, key) {
      if (key === 'query') return capture(target).query;
      if (key === 'transaction')
        return (fn: (tx: unknown) => Promise<unknown>) =>
          target.transaction((tx) => fn(capture(tx)));
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const f = await fixture(t, undefined, database);
  const context = (await f.open(f.c, f.bravo)).json().context_id as string;
  assert.equal((await bravoSays(f, 'start', { room_id: f.roomId })).statusCode, 200);
  const db = f.app.city.db;
  const template = (
    await db.query<Record<string, unknown>>(
      'SELECT * FROM messages WHERE recipient_id=$1 AND seq=1',
      [f.dana],
    )
  ).rows[0]!;
  // 3000 old messages of this thread in Dana's inbox, all acknowledged, then 3 unread.
  const history = 3000;
  const unread = 3;
  await db.query(
    `INSERT INTO messages(recipient_id,seq,id,sender_id,sender_owner_id,recipient_owner_id,context_id,
      kind,parts,created_at,origin,sender_owner_label,room_id)
     SELECT $1, s, gen_random_uuid(), $2, $3, $4, $5, 'message', '[{"type":"text","text":"old"}]'::jsonb,
       $6::bigint + s, $7, $8, $9 FROM generate_series(2, $10::int) s`,
    [
      f.dana,
      template['sender_id'],
      template['sender_owner_id'],
      template['recipient_owner_id'],
      context,
      Number(template['created_at']),
      template['origin'],
      template['sender_owner_label'],
      template['room_id'],
      history + unread,
    ],
  );
  await db.query('UPDATE inbox_cursors SET next_seq=$2, acked_seq=$3 WHERE agent_id=$1', [
    f.dana,
    history + unread + 1,
    history,
  ]);
  await db.query('ANALYZE messages');
  captured.length = 0;
  const listed = (await listOf(f, f.c))[0]!;
  assert.equal(listed.unread, unread);
  assert.ok(captured.length >= 1, 'the unread statement ran');
  const plan = (
    await base.query<{ 'QUERY PLAN': unknown }>(
      `EXPLAIN (ANALYZE, FORMAT JSON) ${captured.at(-1)!.sql}`,
      captured.at(-1)!.params,
    )
  ).rows[0]!['QUERY PLAN'] as [{ Plan: PlanNode }];
  type PlanNode = {
    'Relation Name'?: string;
    'Actual Rows'?: number;
    'Actual Loops'?: number;
    'Rows Removed by Filter'?: number;
    Plans?: PlanNode[];
  };
  let read = 0;
  const walk = (node: PlanNode) => {
    if (node['Relation Name'] === 'messages')
      read +=
        ((node['Actual Rows'] ?? 0) + (node['Rows Removed by Filter'] ?? 0)) *
        (node['Actual Loops'] ?? 1);
    node.Plans?.forEach(walk);
  };
  walk(plan[0].Plan);
  assert.ok(
    read <= unread * 2,
    `messages rows read ${read} should track unread, not ${history} of history`,
  );
});

test('a mute silences the whole owner: no private messages through or to its other members', async (t) => {
  const f = await fixture(t);
  // B has a second AI in the room; the host mutes only Bravo.
  const sibling = await f.agent(f.b, 'Bravo sibling');
  await f.ok(f.b.key, 'city_join_room', {
    link: f.link.link,
    agent_id: sibling,
    idempotency_key: randomUUID(),
  });
  const muted = await f.console(f.a, 'POST', `/api/rooms/${f.roomId}/mute`, {
    agent_id: f.bravo,
    muted: true,
  });
  assert.equal(muted.statusCode, 200, muted.body);
  const from = await f.tool(f.b.key, 'city_send_message', {
    from_agent_id: sibling,
    to_agent_id: f.dana,
    room_id: f.roomId,
    text: 'hello through the sibling',
    idempotency_key: randomUUID(),
  });
  assert.equal(from.statusCode, 403, from.body);
  assert.equal(from.json().code, 'muted');
  const to = await f.write(f.c, f.dana, sibling, 'hello sibling');
  assert.equal(to.statusCode, 403, to.body);
  assert.equal(to.json().code, 'recipient_muted');
  // New message offers neither of B's members to Dana, and nobody to B.
  const offered = (await f.console(f.c, 'GET', '/api/messages/recipients')).json()
    .recipients as Array<{ member_id: string }>;
  assert.deepEqual(offered.map((item) => item.member_id).sort(), [f.hostAgent]);
  assert.deepEqual((await f.console(f.b, 'GET', '/api/messages/recipients')).json().recipients, []);
  // Unmuted, the sibling messages again.
  await f.console(f.a, 'POST', `/api/rooms/${f.roomId}/mute`, { agent_id: f.bravo, muted: false });
  assert.equal((await f.write(f.c, f.dana, sibling, 'hello again')).statusCode, 201);
});

test('"Mute all AIs" leaves the owner\'s person able to message privately, never its AIs', async (t) => {
  const f = await fixture(t);
  // Dana brings her own AI; the host mutes all AIs. Her person is spared, her AI is not.
  const danaAi = await f.agent(f.c, 'Dana assistant');
  await f.ok(f.c.key, 'city_join_room', {
    link: f.link.link,
    agent_id: danaAi,
    idempotency_key: randomUUID(),
  });
  const bulk = await f.console(f.a, 'POST', `/api/rooms/${f.roomId}/mute-ais`, { muted: true });
  assert.equal(bulk.statusCode, 200, bulk.body);
  assert.equal((await f.write(f.c, f.dana, f.hostAgent, 'from the person')).statusCode, 201);
  const fromAi = await f.tool(f.c.key, 'city_send_message', {
    from_agent_id: danaAi,
    to_agent_id: f.hostAgent,
    room_id: f.roomId,
    text: 'from the AI',
    idempotency_key: randomUUID(),
  });
  assert.equal(fromAi.statusCode, 403, fromAi.body);
  assert.equal(fromAi.json().code, 'muted');
});
