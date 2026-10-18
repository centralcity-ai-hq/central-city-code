import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  CONVERSATIONS_MAX,
  CONVERSATIONS_PER_DAY,
  NEW_CONVERSATION_TITLE,
  titleFrom,
} from '../server/elric/conversations.js';
import { eraseElricOwner } from '../server/elric/erase.js';
import { elricFixture } from './elric-fixture.js';

/**
 * Several private Elric conversations per owner: list, create, rename, delete, a title from the
 * first message, owner only, erased with the account, and the caps (the revoke + re-add churn
 * limit does not apply to new conversations). Synthetic data only.
 */
type F = Awaited<ReturnType<typeof elricFixture>>;

async function owner(f: F, name: string) {
  const who = await f.account(name);
  await f.verify(who);
  const added = await f.call(who.cookie, 'POST', '/api/elric', {});
  assert.ok(added.statusCode < 300, added.body);
  return who;
}
const create = (f: F, cookie: string, body: unknown = {}) =>
  f.call(cookie, 'POST', '/api/elric/conversations', body);
const list = async (f: F, cookie: string) =>
  (await f.call(cookie, 'GET', '/api/elric/conversations')).json().conversations as Array<{
    id: string;
    title: string;
    person_member_id: string;
    read_only: boolean;
  }>;

test('titles from the first message: mentions dropped, one line, cut at a word', () => {
  assert.equal(titleFrom('@Elric what is a join link?'), 'what is a join link?');
  assert.equal(titleFrom('@Elric   \n  '), null);
  const long = titleFrom(`@Elric ${'word '.repeat(30)}`)!;
  assert.ok(long.length <= 61 && long.endsWith('…'), long);
  assert.ok(!long.includes('\n'));
});

test('create, list, post, auto-title, rename, delete; the first chat is one of them', async (t) => {
  const f = await elricFixture(t);
  const a = await owner(f, 'Conv owner');
  const first = (await f.call(a.cookie, 'GET', '/api/elric/chat')).json();
  // An empty chat is not listed; its first message lists it.
  assert.deepEqual(await list(f, a.cookie), []);
  const hello = await f.call(a.cookie, 'POST', `/api/rooms/${first.room_id}/messages`, {
    agent_id: first.person_member_id,
    text: '@Elric hello',
    idempotency_key: randomUUID(),
  });
  assert.ok(hello.statusCode < 300, hello.body);
  const made = await create(f, a.cookie);
  assert.equal(made.statusCode, 201, made.body);
  const conv = made.json();
  assert.equal(conv.title, NEW_CONVERSATION_TITLE);
  assert.equal(conv.read_only, false);
  assert.ok(conv.person_member_id);
  assert.equal((await list(f, a.cookie)).length, 1, 'the new chat lists with its first message');
  // Both are listed; posting in the new one titles it.
  f.tick(1_000);
  const post = await f.call(a.cookie, 'POST', `/api/rooms/${conv.id}/messages`, {
    agent_id: conv.person_member_id,
    text: '@Elric plan a trip to Lisbon in spring',
    idempotency_key: randomUUID(),
  });
  assert.ok(post.statusCode < 300, post.body);
  const listed = await list(f, a.cookie);
  assert.deepEqual(listed.map((c) => c.id).sort(), [first.room_id, conv.id].sort());
  assert.equal(listed[0]!.id, conv.id, 'newest activity first');
  assert.equal(listed[0]!.title, 'plan a trip to Lisbon in spring');
  // A title set by the owner is kept.
  const renamed = await f.call(a.cookie, 'PATCH', `/api/elric/conversations/${conv.id}`, {
    title: 'Lisbon',
  });
  assert.equal(renamed.json().title, 'Lisbon');
  assert.equal((await list(f, a.cookie)).find((c) => c.id === conv.id)!.title, 'Lisbon');
  for (const bad of [{ title: '' }, { title: 'x'.repeat(81) }, { title: 'a\u0000b' }, {}])
    assert.equal(
      (await f.call(a.cookie, 'PATCH', `/api/elric/conversations/${conv.id}`, bad)).statusCode,
      400,
    );
  // Elric answered there: a turn exists for this conversation.
  await f.elric.drain();
  const turns = async () =>
    Number(
      (
        await f.db.query<{ n: number }>(
          'SELECT count(*)::int AS n FROM elric_turns WHERE room_id=$1',
          [conv.id],
        )
      ).rows[0]!.n,
    );
  assert.ok((await turns()) > 0);
  // Delete: the room and its content are gone for good; the cost stays in the anonymous totals.
  await f.db.query(
    `INSERT INTO elric_drafts(agent_id,room_id,source_seq,text,updated_at)
     SELECT agent_id,$1,1,'forming',$2 FROM elric_agents WHERE owner_id=$3`,
    [conv.id, f.now(), a.operatorId],
  );
  // Delete: gone from the list, no more posts, the id is not found.
  const gone = await f.call(a.cookie, 'DELETE', `/api/elric/conversations/${conv.id}`);
  assert.equal(gone.statusCode, 200, gone.body);
  assert.deepEqual(
    (await list(f, a.cookie)).map((c) => c.id),
    [first.room_id],
  );
  assert.equal(
    (await f.call(a.cookie, 'GET', `/api/elric/conversations/${conv.id}`)).statusCode,
    404,
  );
  for (const table of ['rooms', 'room_messages', 'room_members', 'elric_drafts']) {
    const column = table === 'rooms' ? 'id' : 'room_id';
    const left = (
      await f.db.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM ${table} WHERE ${column}=$1`,
        [conv.id],
      )
    ).rows[0]!.n;
    assert.equal(Number(left), 0, table);
  }
  assert.equal(await turns(), 0);
  const kept = (
    await f.db.query<{ n: number }>(
      'SELECT COALESCE(sum(turns),0)::int AS n FROM elric_cost_erased',
    )
  ).rows[0]!.n;
  assert.ok(Number(kept) > 0, 'the cost stays in the anonymous totals');
  // The other conversation is untouched.
  assert.ok(
    Number(
      (
        await f.db.query<{ n: number }>('SELECT count(*)::int AS n FROM rooms WHERE id=$1', [
          first.room_id,
        ])
      ).rows[0]!.n,
    ) === 1,
  );
  const after = await f.call(a.cookie, 'POST', `/api/rooms/${conv.id}/messages`, {
    agent_id: conv.person_member_id,
    text: 'still here?',
    idempotency_key: randomUUID(),
  });
  assert.ok(after.statusCode >= 400, after.body);
});

test('owner only: another owner gets the uniform 404 and sees nothing', async (t) => {
  const f = await elricFixture(t);
  const a = await owner(f, 'Owner A');
  const b = await owner(f, 'Owner B');
  const conv = (await create(f, a.cookie, { title: 'Private plans' })).json();
  assert.deepEqual(await list(f, b.cookie), []);
  for (const [method, body] of [
    ['GET', undefined],
    ['PATCH', { title: 'mine now' }],
    ['DELETE', undefined],
  ] as const)
    assert.equal(
      (await f.call(b.cookie, method, `/api/elric/conversations/${conv.id}`, body)).statusCode,
      404,
    );
  // Shared rooms are not conversations.
  const s = await f.scene('Shared room');
  assert.equal(
    (await f.call(s.owner.cookie, 'GET', `/api/elric/conversations/${s.room.id}`)).statusCode,
    404,
  );
  // Without an Elric there is nothing to create.
  const none = await f.account('No Elric');
  await f.verify(none);
  assert.equal((await create(f, none.cookie)).statusCode, 404);
});

test('new conversations are not held to the revoke + re-add churn limit; the cap is 200', async (t) => {
  const f = await elricFixture(t);
  const a = await owner(f, 'Many chats');
  // Far more than the churn limit (5) in one day.
  for (let i = 0; i < 12; i++) assert.equal((await create(f, a.cookie)).statusCode, 201, `#${i}`);
  // The first chat still opens.
  assert.equal((await f.call(a.cookie, 'GET', '/api/elric/chat')).statusCode, 200);
  // At the cap: a typed refusal.
  const open = Number(
    (
      await f.db.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM rooms WHERE elric_private AND host_owner_id=$1',
        [a.operatorId],
      )
    ).rows[0]!.n,
  );
  await f.db.query(
    `UPDATE rooms SET created_at=created_at-86400001 WHERE elric_private AND host_owner_id=$1`,
    [a.operatorId],
  );
  // As if those were made on an earlier day: the per-day counter starts over.
  await f.db.query('UPDATE elric_usage SET conversations=0 WHERE owner_id=$1', [a.operatorId]);
  for (let i = open; i < CONVERSATIONS_MAX; i++) await create(f, a.cookie);
  const over = await create(f, a.cookie);
  assert.equal(over.statusCode, 409, over.body);
  assert.equal(over.json().code, 'too_many_conversations');
  // Deleting one frees a place.
  // (Empty chats are not listed; delete one by id.)
  const one = (
    await f.db.query<{ id: string }>(
      'SELECT id FROM rooms WHERE elric_private AND host_owner_id=$1 LIMIT 1',
      [a.operatorId],
    )
  ).rows[0]!;
  await f.call(a.cookie, 'DELETE', `/api/elric/conversations/${one.id}`);
  assert.equal((await create(f, a.cookie)).statusCode, 201);
});

test('create then delete churn hits the daily cap: deleted conversations still count', async (t) => {
  const f = await elricFixture(t);
  const a = await owner(f, 'Churn owner');
  // Every conversation is deleted right away, so the open cap never applies.
  for (let i = 0; i < CONVERSATIONS_PER_DAY; i++) {
    const made = await create(f, a.cookie);
    assert.equal(made.statusCode, 201, `#${i} ${made.body}`);
    const gone = await f.call(a.cookie, 'DELETE', `/api/elric/conversations/${made.json().id}`);
    assert.equal(gone.statusCode, 200, gone.body);
  }
  const over = await create(f, a.cookie);
  assert.equal(over.statusCode, 429, over.body);
  assert.equal(over.json().code, 'too_many_new_conversations');
  // The first chat is a new conversation too.
  assert.equal((await f.call(a.cookie, 'GET', '/api/elric/chat')).statusCode, 429);
});

test('revoke closes every conversation (read-only); erasing the account removes them all', async (t) => {
  const f = await elricFixture(t);
  const a = await owner(f, 'Erase owner');
  await f.call(a.cookie, 'GET', '/api/elric/chat');
  await create(f, a.cookie, { title: 'Two' });
  await f.call(a.cookie, 'POST', '/api/elric/revoke', {});
  await f.call(a.cookie, 'GET', '/api/elric/chat').catch(() => undefined);
  const open = Number(
    (
      await f.db.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM rooms WHERE elric_private AND host_owner_id=$1',
        [a.operatorId],
      )
    ).rows[0]!.n,
  );
  assert.ok(open >= 1);
  await eraseElricOwner(f.db, a.operatorId);
  const left = Number(
    (
      await f.db.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM rooms WHERE elric_private AND host_owner_id=$1',
        [a.operatorId],
      )
    ).rows[0]!.n,
  );
  assert.equal(left, 0);
});

test('a chat deleted from the room settings (DELETE /api/rooms/:room) is deleted like /elric does', async (t) => {
  // Regression: a private chat lists among the console's rooms under its title ("hi"), and the
  // room settings' Delete answered 409 room_private ("This changed while you were working").
  const f = await elricFixture(t);
  const a = await owner(f, 'Rooms delete owner');
  const conv = (await create(f, a.cookie)).json();
  const post = await f.call(a.cookie, 'POST', `/api/rooms/${conv.id}/messages`, {
    agent_id: conv.person_member_id,
    text: '@Elric hi',
    idempotency_key: randomUUID(),
  });
  assert.ok(post.statusCode < 300, post.body);
  await f.elric.drain();
  const title = (await list(f, a.cookie)).find((c) => c.id === conv.id)!.title;
  // Titled by now (the fallback from "hi", or the auto title).
  assert.ok(title && title !== NEW_CONVERSATION_TITLE, title);
  const rooms = (await f.call(a.cookie, 'GET', '/api/rooms')).json().rooms as Array<{
    id: string;
    name: string;
  }>;
  assert.equal(rooms.find((r) => r.id === conv.id)?.name, title, 'listed among the rooms');
  const wrong = await f.call(a.cookie, 'DELETE', `/api/rooms/${conv.id}`, {
    confirm_name: `${title}x`,
  });
  assert.equal(wrong.statusCode, 400, wrong.body);
  assert.equal(wrong.json().code, 'confirm_name_mismatch');
  const gone = await f.call(a.cookie, 'DELETE', `/api/rooms/${conv.id}`, { confirm_name: title });
  assert.equal(gone.statusCode, 200, gone.body);
  assert.deepEqual(gone.json(), { room_id: conv.id, deleted: true });
  assert.ok(!(await list(f, a.cookie)).some((c) => c.id === conv.id));
  for (const table of ['rooms', 'room_messages', 'room_members', 'elric_turns']) {
    const column = table === 'rooms' ? 'id' : 'room_id';
    const left = await f.db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM ${table} WHERE ${column}=$1`,
      [conv.id],
    );
    assert.equal(Number(left.rows[0]!.n), 0, table);
  }
  // Every other host path stays locked.
  const renamed = await f.call(
    a.cookie,
    'PATCH',
    `/api/rooms/${(await list(f, a.cookie))[0]?.id ?? conv.id}`,
    {
      name: 'Shared now',
    },
  );
  assert.ok(renamed.statusCode >= 400, renamed.body);
});
