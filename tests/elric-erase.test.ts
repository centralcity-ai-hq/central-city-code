import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { eraseElricOwner, purgeElricConversation } from '../server/elric/erase.js';
import { elricFixture } from './elric-fixture.js';

/**
 * Account deletion erases the owner's Elric rows (turns, posts, pending actions, invocations,
 * usage, agent, identity) and keeps only anonymous cost totals for the operator's cost report.
 * elric_turns stays append-only for every other path.
 */
const PER_OWNER = [
  ['elric_turns', 'owner_id'],
  ['elric_posts', 'owner_id'],
  ['elric_pending_actions', 'owner_id'],
  ['elric_invocations', 'owner_id'],
  ['elric_usage', 'owner_id'],
  ['elric_agents', 'owner_id'],
  ['elric_verified_identities', 'operator_id'],
] as const;

test('eraseElricOwner: removes one owner, keeps the other, keeps anonymous cost totals', async (t) => {
  const f = await elricFixture(t);
  const a = await f.scene('Room A');
  const b = await f.scene('Room B');
  for (const s of [a, b]) {
    f.small.push({ text: 'An answer.' });
    await f.say(s.owner, s.room, '@Elric what is next?', s.person);
    await f.elric.drain();
    await f.db.query(
      `INSERT INTO elric_pending_actions(id,owner_id,agent_id,room_id,tool,args,args_hash,status,
         expires_at,created_at) VALUES ($1,$2,$3,$4,'t','{}','h','pending',$5,$5)`,
      [randomUUID(), s.owner.operatorId, s.elricId, s.room.id, f.now()],
    );
  }
  const count = async (table: string, column: string, id: string) =>
    Number(
      (
        await f.db.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM ${table} WHERE ${column}=$1`,
          [id],
        )
      ).rows[0].n,
    );
  for (const [table, column] of PER_OWNER)
    assert.ok((await count(table, column, a.owner.operatorId)) > 0, `${table} seeded`);

  const good = randomBytes(32).toString('base64url');
  const before = process.env.CITY_OPS_SECRET;
  process.env.CITY_OPS_SECRET = good;
  t.after(() => {
    if (before === undefined) delete process.env.CITY_OPS_SECRET;
    else process.env.CITY_OPS_SECRET = before;
  });
  const report = async () =>
    (
      await f.app.inject({
        method: 'GET',
        url: '/api/ops/elric/cost?days=2',
        headers: { 'x-city-request': '1', authorization: `Bearer ${good}` },
      })
    ).json();
  const reportBefore = await report();
  const globalBefore = (await f.db.query('SELECT * FROM elric_global_usage ORDER BY day')).rows;
  assert.equal(reportBefore.cumulative.total.turns, 2);

  const result = await eraseElricOwner(f.db, a.owner.operatorId);
  assert.equal(result.turns, 1);
  assert.equal(result.identities, 1);
  for (const [table, column] of PER_OWNER) {
    assert.equal(await count(table, column, a.owner.operatorId), 0, `${table} erased`);
    assert.ok((await count(table, column, b.owner.operatorId)) > 0, `${table} of B kept`);
  }
  // The anonymous table has no owner column; the report and the global totals are unchanged.
  const columns = (
    await f.db.query<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_name='elric_cost_erased'",
    )
  ).rows.map((r) => r.column_name);
  assert.deepEqual(columns.sort(), ['cost_units', 'day_index', 'tier', 'turns']);
  assert.deepEqual(await report(), reportBefore);
  assert.deepEqual(
    (await f.db.query('SELECT * FROM elric_global_usage ORDER BY day')).rows,
    globalBefore,
  );
  // Idempotent.
  assert.equal((await eraseElricOwner(f.db, a.owner.operatorId)).turns, 0);
  assert.deepEqual(await report(), reportBefore);
});

test('elric_turns stays append-only outside the erase function', async (t) => {
  const f = await elricFixture(t);
  const s = await f.scene('Room C');
  f.small.push({ text: 'An answer.' });
  await f.say(s.owner, s.room, '@Elric hi', s.person);
  await f.elric.drain();
  await assert.rejects(f.db.query('DELETE FROM elric_turns'), /append-only/);
  await assert.rejects(f.db.query("UPDATE elric_turns SET reason='x'"), /append-only/);
  await assert.rejects(f.db.query('TRUNCATE elric_turns'), /append-only/);
  // The setting for one owner never unlocks another owner's rows.
  await assert.rejects(
    f.db.transaction(async (tx) => {
      await tx.query("SELECT set_config('elric.erase_owner', 'someone-else', true)");
      await tx.query('DELETE FROM elric_turns');
    }),
    /append-only/,
  );
  // After a transaction, the setting is gone.
  await f.db.transaction(async (tx) => {
    await tx.query("SELECT set_config('elric.erase_owner', $1, true)", [s.owner.operatorId]);
  });
  await assert.rejects(f.db.query('DELETE FROM elric_turns'), /append-only/);
});

test('eraseElricOwner: hard-deletes the private Elric chat room and its messages', async (t) => {
  const f = await elricFixture(t);
  const chatFor = async (name: string) => {
    const owner = await f.account(name);
    await f.verify(owner);
    const added = await f.call(owner.cookie, 'POST', '/api/elric', {});
    assert.ok(added.statusCode < 300, added.body);
    const chat = await f.call(owner.cookie, 'GET', '/api/elric/chat');
    assert.equal(chat.statusCode, 200, chat.body);
    const roomId = chat.json().room_id as string;
    const list = (await f.call(owner.cookie, 'GET', `/api/rooms/${roomId}/members`)).json()
      .members as Array<{ id: string; kind: string; own: boolean }>;
    const person = list.find((m) => m.own && m.kind === 'person')!;
    const posted = await f.call(owner.cookie, 'POST', `/api/rooms/${roomId}/messages`, {
      text: 'a private note to Elric',
      agent_id: person.id,
      idempotency_key: randomUUID(),
    });
    assert.equal(posted.statusCode, 201, posted.body);
    return { owner, roomId };
  };
  const a = await chatFor('Erase A');
  // A normal room the same owner hosts survives the erase, with its messages.
  const desk = await f.agent(a.owner, 'Owner desk');
  const hosted = await f.room(a.owner, desk, 'Owner public room');
  const hostedPost = await f.call(a.owner.cookie, 'POST', `/api/rooms/${hosted.id}/messages`, {
    text: 'a normal room message',
    agent_id: desk,
    idempotency_key: randomUUID(),
  });
  assert.equal(hostedPost.statusCode, 201, hostedPost.body);
  const b = await chatFor('Erase B');
  const rows = async (table: string, roomId: string) =>
    Number(
      (
        await f.db.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM ${table} WHERE ${table === 'rooms' ? 'id' : 'room_id'}=$1`,
          [roomId],
        )
      ).rows[0].n,
    );
  assert.ok((await rows('room_messages', a.roomId)) > 0);

  const result = await eraseElricOwner(f.db, a.owner.operatorId);
  assert.equal(result.private_rooms, 1);
  const withRoomId = (
    await f.db.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.columns
        WHERE table_schema = current_schema() AND column_name='room_id'`,
    )
  ).rows.map((r) => r.table_name);
  for (const table of [...withRoomId, 'rooms'])
    assert.equal(await rows(table, a.roomId), 0, `${table} of the erased private room`);
  const leftover = await f.db.query(
    "SELECT 1 FROM room_messages WHERE parts::text LIKE '%a private note%' AND room_id=$1",
    [a.roomId],
  );
  assert.equal(leftover.rows.length, 0);
  assert.equal(await rows('rooms', hosted.id), 1, 'the hosted normal room survives');
  assert.ok((await rows('room_messages', hosted.id)) > 0, 'its messages survive');
  assert.ok((await rows('room_members', hosted.id)) > 0, 'its members survive');
  // The other owner's private room is untouched.
  assert.equal(await rows('rooms', b.roomId), 1);
  assert.ok((await rows('room_messages', b.roomId)) > 0);
  // Idempotent.
  assert.equal((await eraseElricOwner(f.db, a.owner.operatorId)).private_rooms, 0);
});

/**
 * An invocation still holding a reservation (deferred, or running with a model call in flight)
 * when its rows are erased: the reservation leaves the global ceiling, what it spent counts.
 */
async function holdReservation(
  f: Awaited<ReturnType<typeof elricFixture>>,
  roomId: string,
  units: { spent: number; inflight: number } = { spent: 10, inflight: 5 },
) {
  const inv = (
    await f.db.query<{ owner_id: string; source_seq: string; kind: string; usage_day: string }>(
      'SELECT * FROM elric_invocations WHERE room_id=$1 AND kind IS NOT NULL AND usage_day IS NOT NULL',
      [roomId],
    )
  ).rows[0]!;
  assert.ok(inv, 'an invocation with a usage day');
  await f.db.query(
    `UPDATE elric_invocations SET status='queued', reserved_units=40, spent_units=$3,
       inflight_units=$4 WHERE room_id=$1 AND source_seq=$2`,
    [roomId, inv.source_seq, units.spent, units.inflight],
  );
  await f.db.query(
    'UPDATE elric_usage SET reserved_units=reserved_units+40 WHERE owner_id=$1 AND day=$2',
    [inv.owner_id, inv.usage_day],
  );
  await f.db.query('UPDATE elric_global_usage SET reserved_units=reserved_units+40 WHERE day=$1', [
    inv.usage_day,
  ]);
  const global = async () =>
    (
      await f.db.query<{ reserved_units: string; spent_units: string }>(
        'SELECT reserved_units, spent_units FROM elric_global_usage WHERE day=$1',
        [inv.usage_day],
      )
    ).rows[0]!;
  return { inv, global, before: await global() };
}

test('eraseElricOwner: a held reservation is released from the global ceiling', async (t) => {
  const f = await elricFixture(t);
  const s = await f.scene('Room R');
  f.small.push({ text: 'An answer.' });
  await f.say(s.owner, s.room, '@Elric what is next?', s.person);
  await f.elric.drain();
  const held = await holdReservation(f, s.room.id);
  await eraseElricOwner(f.db, s.owner.operatorId);
  const after = await held.global();
  assert.equal(Number(after.reserved_units), Number(held.before.reserved_units) - 40);
  assert.equal(Number(after.spent_units), Number(held.before.spent_units) + 15);
});

async function purgeWithHeld(
  t: Parameters<typeof elricFixture>[0],
  units: { spent: number; inflight: number },
) {
  const f = await elricFixture(t);
  const owner = await f.account('Purge owner');
  await f.verify(owner);
  assert.ok((await f.call(owner.cookie, 'POST', '/api/elric', {})).statusCode < 300);
  const conv = (await f.call(owner.cookie, 'POST', '/api/elric/conversations', {})).json();
  f.small.push({ text: 'An answer.' });
  const post = await f.call(owner.cookie, 'POST', `/api/rooms/${conv.id}/messages`, {
    agent_id: conv.person_member_id,
    text: '@Elric hello there',
    idempotency_key: randomUUID(),
  });
  assert.ok(post.statusCode < 300, post.body);
  await f.elric.drain();
  const held = await holdReservation(f, conv.id, units);
  const usage = async () =>
    (
      await f.db.query<{ reserved_units: string; used: number }>(
        `SELECT reserved_units, ${held.inv.kind} AS used FROM elric_usage
          WHERE owner_id=$1 AND day=$2`,
        [held.inv.owner_id, held.inv.usage_day],
      )
    ).rows[0]!;
  const usageBefore = await usage();
  assert.ok(Number(usageBefore.used) > 0, 'the run counted against the allowance');
  assert.equal(await purgeElricConversation(f.db, owner.operatorId, conv.id), true);
  const after = await held.global();
  assert.equal(Number(after.reserved_units), Number(held.before.reserved_units) - 40);
  assert.equal(
    Number(after.spent_units),
    Number(held.before.spent_units) + units.spent + units.inflight,
  );
  const usageAfter = await usage();
  assert.equal(Number(usageAfter.reserved_units), Number(usageBefore.reserved_units) - 40);
  return { before: Number(usageBefore.used), after: Number(usageAfter.used) };
}

test('purgeElricConversation: a run that spent or has a call in flight keeps the allowance count', async (t) => {
  const used = await purgeWithHeld(t, { spent: 10, inflight: 5 });
  assert.equal(used.after, used.before);
});

test('purgeElricConversation: a model call in flight alone keeps the allowance count', async (t) => {
  const used = await purgeWithHeld(t, { spent: 0, inflight: 5 });
  assert.equal(used.after, used.before);
});

test('purgeElricConversation: a run that spent nothing gets the allowance back', async (t) => {
  const used = await purgeWithHeld(t, { spent: 0, inflight: 0 });
  assert.equal(used.after, used.before - 1);
});

test('purgeElricConversation: a pending owner post leaves no unread mention counted', async (t) => {
  const f = await elricFixture(t);
  const owner = await f.account('Purge unread owner');
  await f.verify(owner);
  assert.ok((await f.call(owner.cookie, 'POST', '/api/elric', {})).statusCode < 300);
  const conv = (await f.call(owner.cookie, 'POST', '/api/elric/conversations', {})).json();
  const post = await f.call(owner.cookie, 'POST', `/api/rooms/${conv.id}/messages`, {
    agent_id: conv.person_member_id,
    text: '@Elric are you there?',
    idempotency_key: randomUUID(),
  });
  assert.ok(post.statusCode < 300, post.body);
  // No drain: the run is still queued and the mention unread.
  const unread = (
    await f.db.query<{ agent_id: string }>(
      'SELECT agent_id FROM mentions WHERE room_id=$1 AND read_at IS NULL',
      [conv.id],
    )
  ).rows;
  assert.ok(unread.length > 0, 'an unread mention of the pending post');
  const agentId = unread[0]!.agent_id;
  const count = async () =>
    Number(
      (
        await f.db.query<{ unread_count: number }>(
          'SELECT unread_count FROM wake_cursors WHERE agent_id=$1',
          [agentId],
        )
      ).rows[0]!.unread_count,
    );
  const before = await count();
  const mine = unread.filter((r) => r.agent_id === agentId).length;
  assert.ok(before >= mine);
  assert.equal(await purgeElricConversation(f.db, owner.operatorId, conv.id), true);
  assert.equal(await count(), before - mine);
  const left = await f.db.query('SELECT 1 FROM mentions WHERE room_id=$1', [conv.id]);
  assert.equal(left.rows.length, 0);
});
