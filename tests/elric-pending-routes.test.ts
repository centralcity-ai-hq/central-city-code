import test from 'node:test';
import assert from 'node:assert/strict';
import { createPendingAction } from '../server/elric/pending.js';
import {
  pendingDetail,
  pendingSummary,
  PENDING_DETAIL_CHARS,
  PENDING_SUMMARY_CHARS,
} from '../server/elric/activity.js';
import { elricFixture } from './elric-fixture.js';

/**
 * The owner's approval gate routes (docs/ELRIC.md "Pending actions"): GET /api/elric/pending lists
 * open, unexpired actions with the cleaned task title and description only; POST /api/elric/pending/:id/reject is owner
 * session only and idempotent; a rejected action can never be approved.
 */

test('the pending list: owner only, open and unexpired, the task title and body, no other argument', async (t) => {
  const f = await elricFixture(t);
  const s = await f.scene('Approval room');
  const create = (args: Record<string, unknown>, ttl: number, tool = 'room_task_create') =>
    createPendingAction(
      f.db,
      { ownerId: s.owner.operatorId, agentId: s.elricId, roomId: s.room.id, tool, args },
      f.now(),
      ttl,
    );
  const open = await create(
    { room_id: s.room.id, title: 'Draft the launch note', body: 'Ask everyone to\u202e review it' },
    60_000,
  );
  const expired = await create({ room_id: s.room.id, title: 'Too late' }, 1_000);
  const other = await create({ room_id: s.room.id, secret: 'stored-arg-secret-8812' }, 60_000, 'x');
  f.tick(5_000); // `expired` is past its expiry, the others are not

  const res = await f.call(s.owner.cookie, 'GET', '/api/elric/pending');
  assert.equal(res.statusCode, 200, res.body);
  const pending = res.json().pending as Array<Record<string, unknown>>;
  assert.deepEqual(pending.map((item) => item.id).sort(), [open.id, other.id].sort());
  assert.ok(!pending.some((item) => item.id === expired.id), 'expired actions are not listed');
  const shown = pending.find((item) => item.id === open.id)!;
  assert.deepEqual(Object.keys(shown).sort(), [
    'args_hash',
    'created_at',
    'detail',
    'expires_at',
    'id',
    'room',
    'summary',
    'tool',
  ]);
  assert.equal(shown.summary, 'Draft the launch note');
  // The owner sees the description the task would carry before approving, cleaned.
  assert.equal(shown.detail, 'Ask everyone to review it');
  assert.equal(shown.args_hash, open.args_hash);
  assert.deepEqual(shown.room, { id: s.room.id, name: 'Approval room' });
  assert.equal(pending.find((item) => item.id === other.id)!.summary, null);
  assert.equal(pending.find((item) => item.id === other.id)!.detail, null);
  assert.ok(!res.body.includes('stored-arg-secret-8812'));

  // Another owner, the room host, no session and tokens: nothing.
  const stranger = await f.account('Approval stranger');
  assert.deepEqual((await f.call(stranger.cookie, 'GET', '/api/elric/pending')).json(), {
    pending: [],
  });
  assert.deepEqual((await f.call(s.host.cookie, 'GET', '/api/elric/pending')).json(), {
    pending: [],
  });
  const granted = await f.call(s.owner.cookie, 'POST', '/api/assistant-access', {
    label: 'Synthetic approver',
    scopes: ['workspace:read', 'agents:control'],
    expiresInDays: 1,
  });
  assert.equal(granted.statusCode, 201, granted.body);
  for (const authorization of [undefined, `Bearer ${granted.json().token as string}`]) {
    const list = await f.app.inject({
      method: 'GET',
      url: '/api/elric/pending',
      headers: { 'x-city-request': '1', ...(authorization ? { authorization } : {}) },
    });
    assert.equal(list.statusCode, 401);
    assert.ok(!list.body.includes(open.id));
    const reject = await f.app.inject({
      method: 'POST',
      url: `/api/elric/pending/${open.id}/reject`,
      headers: {
        'content-type': 'application/json',
        'x-city-request': '1',
        ...(authorization ? { authorization } : {}),
      },
      payload: '{}',
    });
    assert.equal(reject.statusCode, 401);
  }
  // A stranger cannot reject it either: the uniform not_found.
  const foreign = await f.call(stranger.cookie, 'POST', `/api/elric/pending/${open.id}/reject`, {});
  assert.equal(foreign.statusCode, 404, foreign.body);
  const row = await f.db.query<{ status: string }>(
    'SELECT status FROM elric_pending_actions WHERE id=$1',
    [open.id],
  );
  assert.equal(row.rows[0]!.status, 'pending');
});

test('reject: idempotent, leaves the list, and a rejected action can never be approved', async (t) => {
  const f = await elricFixture(t);
  const s = await f.scene('Reject room');
  const action = await createPendingAction(
    f.db,
    {
      ownerId: s.owner.operatorId,
      agentId: s.elricId,
      roomId: s.room.id,
      tool: 'room_task_create',
      args: { room_id: s.room.id, title: 'Rejected task' },
    },
    f.now(),
    60_000,
  );
  for (let i = 0; i < 2; i++) {
    const res = await f.call(s.owner.cookie, 'POST', `/api/elric/pending/${action.id}/reject`, {});
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(res.json(), { id: action.id, status: 'rejected' });
  }
  assert.deepEqual((await f.call(s.owner.cookie, 'GET', '/api/elric/pending')).json(), {
    pending: [],
  });
  const approve = await f.call(s.owner.cookie, 'POST', `/api/elric/pending/${action.id}/approve`, {
    args_hash: action.args_hash,
  });
  assert.equal(approve.statusCode, 409, approve.body);
  assert.equal(approve.json().code, 'not_pending');
  const row = await f.db.query<{ status: string; decided_by: string }>(
    'SELECT status,decided_by FROM elric_pending_actions WHERE id=$1',
    [action.id],
  );
  assert.deepEqual(row.rows[0], { status: 'rejected', decided_by: 'the owner' });
  // An unknown id is a 404, and a malformed one a 400.
  const unknown = await f.call(
    s.owner.cookie,
    'POST',
    '/api/elric/pending/7d9e2c1a-0b3f-4c5d-8e6f-1a2b3c4d5e6f/reject',
    {},
  );
  assert.equal(unknown.statusCode, 404);
  const malformed = await f.call(s.owner.cookie, 'POST', '/api/elric/pending/nope/reject', {});
  assert.equal(malformed.statusCode, 400);
});

test('the summary is the task title only, cleaned and capped', () => {
  assert.equal(
    pendingSummary('room_task_create', { title: '  Plan\u0000 the‮  week ' }),
    'Plan the week',
  );
  assert.equal(pendingSummary('room_task_create', { body: 'no title' }), null);
  assert.equal(pendingSummary('room_close', { title: 'not a task' }), null);
  const long = pendingSummary('room_task_create', { title: 'x'.repeat(500) })!;
  assert.equal(Array.from(long).length, PENDING_SUMMARY_CHARS);
  assert.ok(long.endsWith('…'));
});

test('the detail is the task body only, cleaned (line breaks kept) and capped', () => {
  assert.equal(
    pendingDetail('room_task_create', {
      title: 't',
      body: '  Step one\u0000 now\r\n\n\n\nStep‮ two​  ',
    }),
    'Step one now\n\nStep two',
  );
  assert.equal(pendingDetail('room_task_create', { title: 'no body' }), null);
  assert.equal(pendingDetail('room_task_create', { title: 't', body: ' \n​ ' }), null);
  assert.equal(pendingDetail('room_close', { body: 'not a task' }), null);
  const long = pendingDetail('room_task_create', { title: 't', body: 'y'.repeat(5_000) })!;
  assert.equal(Array.from(long).length, PENDING_DETAIL_CHARS);
  assert.ok(long.endsWith('…'));
});
