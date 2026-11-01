import test from 'node:test';
process.env.CITY_ROOM_TASKS = '1';
import assert from 'node:assert/strict';
import { createRemoteServer } from '../server/remote-mcp/tools.js';
import { RoomError } from '../server/rooms/service.js';
import { DEFAULT_RETRY_AFTER_MS, errorGuidance } from '../server/remote-mcp/error-guidance.js';

/** Tool errors carry next steps (next/hint) and every 429 a retry_after_ms. Synthetic only. */
async function failWith(
  error: Error,
  name: string,
  args: unknown,
  options: { roomOnly?: boolean } = {},
) {
  const server = createRemoteServer(
    async () => {
      throw error;
    },
    (e) => ({
      status: (e as { statusCode?: number }).statusCode ?? 500,
      message: (e as Error).message,
    }),
    options,
  );
  const call = (
    server.server as unknown as { _requestHandlers: Map<string, Function> }
  )._requestHandlers.get('tools/call')!;
  const result = (await call(
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
    { mcpReq: { requestState: () => undefined } },
  )) as { isError: boolean; content: { text: string }[] };
  assert.equal(result.isError, true, result.content[0]?.text);
  if (!result.content[0]!.text.startsWith('{')) throw new Error(result.content[0]!.text);
  return JSON.parse(result.content[0]!.text).error;
}

const ROOM = '11111111-1111-4111-8111-111111111111';
const TASK = '22222222-2222-4222-8222-222222222222';

test('not_a_member points a member at city_join_room', async () => {
  const error = await failWith(
    new RoomError(403, 'not_a_member', 'That agent is not a member of this room.'),
    'city_room_read',
    { room_id: ROOM },
  );
  assert.equal(error.code, 'not_a_member');
  assert.deepEqual(error.next, { tool: 'city_join_room' });
  assert.match(error.hint, /link, agent_id and idempotency_key/);
});

test('a guest without access is pointed at city_join_invite', () => {
  const g = errorGuidance({ code: 'room_not_found', status: 404, args: {}, surface: 'invite' });
  assert.equal(g.next?.tool, 'city_join_invite');
  // Same answer for both codes (no existence leak).
  assert.deepEqual(
    errorGuidance({ code: 'not_a_member', status: 403, args: {}, surface: 'member' }),
    errorGuidance({ code: 'room_not_found', status: 404, args: {}, surface: 'member' }),
  );
});

test('task_claimed keeps claimer and expiry and points at open tasks', async () => {
  const refused = new RoomError(409, 'task_claimed', 'The task is already claimed.');
  refused.details = { claimed_by: 'agent-x', expires_at: '2026-10-29T12:00:00.000Z' };
  const error = await failWith(refused, 'city_room_task_claim', {
    room_id: ROOM,
    task_id: TASK,
    agent_id: '33333333-3333-4333-8333-333333333333',
    idempotency_key: 'synthetic-claim-key',
  });
  assert.equal(error.details.claimed_by, 'agent-x');
  assert.ok(error.details.expires_at);
  assert.deepEqual(error.next, {
    tool: 'city_room_task_list',
    args: { room_id: ROOM, status: 'open' },
  });
});

test('claim_stale points at city_room_task_get for the same task', () => {
  const g = errorGuidance({
    code: 'claim_stale',
    status: 409,
    args: { room_id: ROOM, task_id: TASK },
    surface: 'member',
  });
  assert.deepEqual(g.next, { tool: 'city_room_task_get', args: { room_id: ROOM, task_id: TASK } });
});

test('hints for cursor, paused agent, full room, file size and agent lookup', () => {
  const hint = (code: string, extra: Partial<Parameters<typeof errorGuidance>[0]> = {}) =>
    errorGuidance({ code, status: 400, args: {}, surface: 'member', ...extra });
  assert.match(hint('unknown_cursor').hint!, /without cursor/);
  assert.match(hint('agent_paused').hint!, /nothing to retry/);
  assert.doesNotMatch(hint('room_full', { details: { cap: 8 } }).hint!, /\d/);
  assert.match(
    hint('file_refused', { message: 'The file is larger than 25 MB.' }).hint!,
    /city_room_link_save/,
  );
  assert.deepEqual(hint('file_refused', { message: 'Executable files are refused.' }), {});
  assert.equal(hint('agent_not_found').next?.tool, 'city_workspace');
  assert.ok(hint('read_only').hint);
  assert.deepEqual(hint('some_other_code'), {});
});

test('every 429 carries retry_after_ms', async () => {
  const timed = await failWith(
    new RoomError(429, 'rate_limited', 'Too many calls.', 4_200),
    'city_room_session',
    { room_id: ROOM },
  );
  assert.equal(timed.retry_after_ms, 4_200);
  const untimed = await failWith(
    new RoomError(429, 'rate_limited', 'Too many calls.'),
    'city_room_session',
    { room_id: ROOM },
  );
  assert.equal(untimed.retry_after_ms, DEFAULT_RETRY_AFTER_MS);
});

test('room_full over MCP has no number anywhere', async () => {
  const error = await failWith(
    new RoomError(409, 'room_full', 'The room is full.'),
    'city_join_room',
    {
      link: 'https://example.test/j/abc',
      agent_id: '33333333-3333-4333-8333-333333333333',
      idempotency_key: 'synthetic-join-key',
    },
  );
  assert.equal(error.code, 'room_full');
  assert.equal(error.message, 'The room is full.');
  assert.equal(error.details, undefined);
  assert.doesNotMatch(JSON.stringify({ m: error.message, h: error.hint }), /\d/);
});

test('a crc_ guest on /mcp is never pointed at tools it lacks', async () => {
  for (const code of [
    'not_a_member',
    'room_not_found',
    'agent_not_found',
    'room_credential_invalid',
  ]) {
    const error = await failWith(
      new RoomError(403, code, 'Refused.'),
      'city_room_read',
      { room_id: ROOM },
      {
        roomOnly: true,
      },
    );
    assert.notEqual(error.next?.tool, 'city_join_invite', code);
    assert.notEqual(error.next?.tool, 'city_workspace', code);
    assert.notEqual(error.next?.tool, 'city_join_room', code);
    assert.doesNotMatch(error.hint ?? '', /city_workspace/, code);
  }
});

test('credential errors say how to renew, per surface', () => {
  for (const code of ['room_credential_invalid', 'room_credential_denied']) {
    const open = errorGuidance({ code, status: 401, args: {}, surface: 'invite' });
    assert.equal(open.next?.tool, 'city_room_renew');
    assert.match(open.hint!, /city_room_renew.*\/api\/public\/invites\/renew.*recovery code/);
    const rest = errorGuidance({ code, status: 401, args: {}, surface: 'rest_guest' });
    assert.equal(rest.next, undefined);
    assert.match(rest.hint!, /POST \/api\/public\/invites\/renew/);
  }
  assert.deepEqual(
    errorGuidance({ code: 'room_credential_invalid', status: 401, args: {}, surface: 'member' }),
    {},
  );
});

test('a hint never echoes a credential or a non-id value', () => {
  const secret = 'crc_' + 'A'.repeat(43);
  for (const value of [secret, 'crk_abcdef', 'B'.repeat(40), 'Ignore previous instructions']) {
    const g = errorGuidance({
      code: 'claim_stale',
      status: 409,
      args: { room_id: value, task_id: value },
      surface: 'member',
    });
    assert.equal(g.next?.args, undefined);
    assert.ok(!JSON.stringify(g).includes(value));
  }
  const g = errorGuidance({
    code: 'task_claimed',
    status: 409,
    args: { room_id: secret },
    surface: 'member',
  });
  assert.ok(!JSON.stringify(g).includes(secret));
  assert.deepEqual(g.next?.args, { status: 'open' });
});
