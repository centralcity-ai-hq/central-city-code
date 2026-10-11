import test from 'node:test';
import assert from 'node:assert/strict';
import {
  openAgentPrivateRoom,
  PRIVATE_AGENT_ROOM_ROUTE,
  PrivateRoomError,
  RoomsError,
} from '../src/rooms/api.js';
import { ApiError } from '../src/api.js';
import { privateRoomFailure } from '../src/agents/v4/usePrivateRoom.js';

/**
 * "Message <agent>" in the console: the private chat with one of your own agents opens through
 * one route, its answer becomes the room the pane navigates to, and every refusal becomes a code
 * the pane turns into one plain sentence. Synthetic data, fetch stubbed.
 */
type Sent = { url: string; method: string; headers: Record<string, string>; body: unknown };

function stubFetch(
  t: { after(fn: () => void): void },
  answer: (sent: Sent) => [number, unknown, Record<string, string>?] | 'never',
) {
  const original = globalThis.fetch;
  const sent: Sent[] = [];
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const call: Sent = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    sent.push(call);
    const result = answer(call);
    if (result === 'never') return new Promise<Response>(() => {});
    const [status, body, headers = {}] = result;
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', ...headers },
    });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  return sent;
}

const AGENT = 'agent-0001';
const chat = (overrides: Record<string, unknown> = {}) => ({
  room_id: 'room-0001',
  slug: 'chat-0001',
  person_member_id: 'person-0001',
  agent_id: AGENT,
  status: 'active',
  latest_seq: 0,
  created: true,
  ...overrides,
});

test('the private chat opens with one POST of { agent_id } to the one route', async (t) => {
  const sent = stubFetch(t, () => [200, chat()]);
  const room = await openAgentPrivateRoom(AGENT);
  assert.equal(PRIVATE_AGENT_ROOM_ROUTE, '/api/rooms/private-agent');
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.url, PRIVATE_AGENT_ROOM_ROUTE);
  assert.equal(sent[0]!.method, 'POST');
  assert.equal(sent[0]!.headers['X-City-Request'], '1');
  assert.deepEqual(sent[0]!.body, { agent_id: AGENT });
  assert.deepEqual(room, {
    roomId: 'room-0001',
    slug: 'chat-0001',
    personMemberId: 'person-0001',
    agentId: AGENT,
    status: 'active',
    created: true,
  });
});

test('a paused agent that already has its chat opens it, marked paused', async (t) => {
  stubFetch(t, () => [200, chat({ status: 'paused', created: false })]);
  const room = await openAgentPrivateRoom(AGENT);
  assert.equal(room.status, 'paused');
  assert.equal(room.created, false);
});

test('an answer without a room is a failure, never a page for no room', async (t) => {
  stubFetch(t, () => [200, { slug: 'chat-0001' }]);
  await assert.rejects(openAgentPrivateRoom(AGENT), (error: unknown) => {
    assert.ok(!(error instanceof PrivateRoomError));
    assert.equal(privateRoomFailure(error, 'Scout'), "Couldn't open the chat. Try again.");
    return true;
  });
});

const refusals: Array<{
  name: string;
  status: number;
  body: Record<string, unknown>;
  headers?: Record<string, string>;
  code: PrivateRoomError['code'];
  retryAfterMs?: number;
  text: string;
}> = [
  {
    name: '404 agent_not_found: not yours, unknown or removed (never the room copy)',
    status: 404,
    body: { error: 'Agent not found.', code: 'agent_not_found' },
    code: 'agent_gone',
    text: "This agent isn't yours, or it was removed.",
  },
  {
    name: '403 elric_private_chat: Elric has its own chat',
    status: 403,
    body: { error: 'Your private chat with Elric is at /elric.', code: 'elric_private_chat' },
    code: 'elric',
    text: "Couldn't open the chat. Try again.",
  },
  {
    name: '409 agent_paused: a paused agent starts no new chat',
    status: 409,
    body: { error: 'Scout is paused.', code: 'agent_paused' },
    code: 'agent_paused',
    text: 'Scout is paused. Resume it to start a chat.',
  },
  {
    name: '409 workspace_paused',
    status: 409,
    body: { error: 'Workspace is paused.', code: 'workspace_paused' },
    code: 'workspace_paused',
    text: 'This workspace is paused.',
  },
  {
    name: '409 person_required: an AI workspace is selected',
    status: 409,
    body: { error: 'Private chats are for your own account.', code: 'person_required' },
    code: 'person_required',
    text: 'Switch to your own workspace to chat privately.',
  },
  {
    name: '429 with Retry-After: the wait the server asked for',
    status: 429,
    body: { error: 'Too many requests.', code: 'rate_limited' },
    headers: { 'Retry-After': '30' },
    code: 'rate_limited',
    retryAfterMs: 30_000,
    text: 'Too many tries just now. Try again in 30 seconds.',
  },
  {
    name: '429 without Retry-After',
    status: 429,
    body: { error: 'Too many requests.' },
    code: 'rate_limited',
    text: 'Too many tries just now. Try again in a moment.',
  },
];

for (const refusal of refusals)
  test(`a refusal becomes its code and one plain sentence: ${refusal.name}`, async (t) => {
    stubFetch(t, () => [refusal.status, refusal.body, refusal.headers]);
    await assert.rejects(openAgentPrivateRoom(AGENT), (error: unknown) => {
      assert.ok(error instanceof PrivateRoomError, String(error));
      assert.equal(error.code, refusal.code);
      assert.equal(error.retryAfterMs, refusal.retryAfterMs);
      assert.equal(privateRoomFailure(error, 'Scout'), refusal.text);
      return true;
    });
  });

test('a 409 the pane has no words for, a 400 and a 503 say "Couldn\'t open the chat."', async (t) => {
  let status = 409;
  stubFetch(t, () => [status, { error: 'Something else.', code: 'room_private' }]);
  for (const next of [409, 400, 503]) {
    status = next;
    await assert.rejects(openAgentPrivateRoom(AGENT), (error: unknown) => {
      assert.ok(error instanceof ApiError && !(error instanceof PrivateRoomError));
      assert.equal(error.status, next);
      assert.equal(privateRoomFailure(error, 'Scout'), "Couldn't open the chat. Try again.");
      return true;
    });
  }
});

test('an ended session says to sign in again', async (t) => {
  stubFetch(t, () => [401, { error: 'Authentication is required.', code: 'unauthorized' }]);
  await assert.rejects(openAgentPrivateRoom(AGENT), (error: unknown) => {
    assert.equal(
      privateRoomFailure(error, 'Scout'),
      'Your session has ended. Sign in again to continue.',
    );
    return true;
  });
});

test('no answer within the rooms deadline is a timeout', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  stubFetch(t, () => 'never');
  const opening = openAgentPrivateRoom(AGENT);
  t.mock.timers.tick(15_000);
  await assert.rejects(opening, (error: unknown) => {
    assert.ok(error instanceof RoomsError);
    assert.equal(error.code, 'timeout');
    assert.equal(privateRoomFailure(error, 'Scout'), "Couldn't open the chat. Try again.");
    return true;
  });
});
