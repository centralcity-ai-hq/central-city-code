import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/app.js';
import {
  MEMBER_STATUS,
  bucketOffset,
  coarseTime,
  snap,
  touchMembers,
  deriveMemberStatus,
  memberActivityMigration,
  presentMemberStatus,
  activeNowSince,
  isActiveNow,
} from '../server/rooms/member-status.js';

process.env.CITY_INVITE_FLOW = '1';
process.env.CITY_RATE_LIMIT_KEY ??= 'synthetic-member-status-root-not-a-real-secret';

/**
 * Room member status (P2a, Codex C4; docs/MEMBER_STATUS.md): the pure derivation, then the members
 * response over REST (owner console) and the invite credential tools. Synthetic data only.
 */
const MIN = 60_000;
const T0 = Date.parse('2026-09-28T12:00:30.000Z');

test('derivation: active, idle and offline by server-recorded activity, falling back to join', () => {
  const at = (ago: number | null, joinedAgo = 10 * 24 * 60 * MIN) =>
    deriveMemberStatus({
      lastActiveAt: ago === null ? null : T0 - ago,
      joinedAt: T0 - joinedAgo,
      now: T0,
    });
  assert.equal(at(0), 'active');
  assert.equal(at(MEMBER_STATUS.activeMs - 1), 'active');
  assert.equal(at(MEMBER_STATUS.activeMs), 'idle');
  assert.equal(at(MEMBER_STATUS.idleMs - 1), 'idle');
  assert.equal(at(MEMBER_STATUS.idleMs), 'offline');
  assert.equal(at(null), 'offline');
  // Joining is activity: a member that joined a minute ago and never called again is active.
  assert.equal(at(null, MIN), 'active');
  // Recorded activity older than the join (backfilled) never makes a fresh member look older.
  assert.equal(at(3 * 60 * MIN, 2 * MIN), 'active');
});

test('derivation: an expired or revoked invite credential is access_expired, whatever the activity', () => {
  const base = { lastActiveAt: T0, joinedAt: T0 - MIN, now: T0 };
  assert.equal(
    deriveMemberStatus({ ...base, credential: { expiresAt: T0 + MIN, revokedAt: null } }),
    'active',
  );
  assert.equal(
    deriveMemberStatus({ ...base, credential: { expiresAt: T0, revokedAt: null } }),
    'access_expired',
  );
  assert.equal(
    deriveMemberStatus({ ...base, credential: { expiresAt: T0 + MIN, revokedAt: T0 - 1 } }),
    'access_expired',
  );
  assert.equal(deriveMemberStatus({ ...base, credential: null }), 'active');
});

test('presentation: exact time (minute precision) for host/own viewers only', () => {
  const input = { lastActiveAt: T0 - 5_000, joinedAt: T0 - 9 * MIN, now: T0 };
  assert.deepEqual(presentMemberStatus(input, true), {
    status: 'active',
    last_active_at: '2026-09-28T12:00:00.000Z',
    active_now: true,
  });
  assert.deepEqual(presentMemberStatus(input, false), {
    status: 'active',
    last_active_at: null,
    active_now: true,
  });
  assert.equal(coarseTime(T0 + 29_000), '2026-09-28T12:00:00.000Z');
});

test("coarse clock: for non-host viewers, status changes only on the member's bucket boundaries", () => {
  const offset = bucketOffset('synthetic-secret', 'room-1', 'agent-1');
  assert.ok(offset >= 0 && offset < MEMBER_STATUS.coarseBucketMs);
  assert.notEqual(offset, bucketOffset('synthetic-secret', 'room-1', 'agent-2'));
  assert.notEqual(offset, bucketOffset('other-secret', 'room-1', 'agent-1'));
  const last = T0 + 17_345;
  const input = (now: number) => ({ lastActiveAt: last, joinedAt: T0 - 99 * MIN, now });
  let previous = '';
  let edges = 0;
  for (let now = last; now < last + 70 * MIN; now += 1_000) {
    const status = presentMemberStatus(input(now), false, offset).status;
    if (status !== previous) {
      edges++;
      // active -> idle is the shared "active now" edge (a whole minute, as the overview count);
      // idle -> offline lies on a boundary of this member's shifted grid.
      const edge = `edge at ${now - last} ms`;
      if (previous === 'active')
        assert.notEqual(activeNowSince(now), activeNowSince(now - 1_000), edge);
      else if (previous) assert.notEqual(snap(now, offset), snap(now - 1_000, offset), edge);
      previous = status;
    }
    // Every viewer: an AI is "active" exactly when it is active now; idle and offline as derived.
    const exact = presentMemberStatus(input(now), true);
    assert.equal(exact.active_now, isActiveNow(input(now)));
    assert.equal(exact.status === 'active', exact.active_now);
    if (!exact.active_now)
      assert.equal(exact.status, deriveMemberStatus(input(now)) === 'offline' ? 'offline' : 'idle');
  }
  assert.equal(edges, 3); // active, idle, offline
  // Credential expiry is not activity: it applies on the real clock.
  const expiring = {
    lastActiveAt: T0,
    joinedAt: T0 - MIN,
    now: T0,
    credential: { expiresAt: T0, revokedAt: null },
  };
  assert.equal(presentMemberStatus(expiring, false, offset).status, 'access_expired');
  assert.equal(presentMemberStatus({ ...expiring, now: T0 - 1 }, false, offset).status, 'active');
});

const headers = { 'content-type': 'application/json', 'x-city-request': '1' };
async function fixture(
  t: { after(fn: () => Promise<unknown>): void },
  options: { history?: 'full' | 'from_join' } = {},
) {
  let time = T0;
  const app = await createApp({ dataDir: ':memory:', startWorkers: false, now: () => time });
  t.after(() => app.close());
  const post = (url: string, body: unknown, extra = {}, remoteAddress = '203.0.113.40') =>
    app.inject({
      method: 'POST',
      url,
      headers: { ...headers, ...extra },
      payload: JSON.stringify(body),
      remoteAddress,
    });
  const registered = await post('/api/auth/register', {
    name: 'Status host',
    password: 'Synthetic member status password',
  });
  assert.equal(registered.statusCode, 201, registered.body);
  const cookie = `cc_session=${registered.cookies.find((c) => c.name === 'cc_session')!.value}`;
  const agent = await post(
    '/api/agents',
    { name: 'Host desk', capability: 'research', mode: 'hosted' },
    { cookie },
  );
  assert.equal(agent.statusCode, 201, agent.body);
  const room = await post(
    '/api/rooms',
    {
      name: 'Status room',
      agent_id: agent.json().agent.id,
      idempotency_key: randomUUID(),
      ...options,
    },
    { cookie },
  );
  assert.equal(room.statusCode, 201, room.body);
  const roomId = room.json().room.id as string;
  const link = await post('/api/links', { target: 'room', room_id: roomId }, { cookie });
  assert.equal(link.statusCode, 201, link.body);
  const code = new URL(link.json().url).pathname.split('/').at(-1)!;
  const admit = async (name: string) => {
    const start = await post('/api/public/invites/bootstrap', { code });
    assert.equal(start.statusCode, 200, start.body);
    const joined = await post('/api/public/invites/redeem', {
      code,
      handle: start.json().handle,
      name,
    });
    assert.equal(joined.statusCode, 200, joined.body);
    return joined.json() as { credential: string; agent_id: string };
  };
  const invoke = (credential: string, tool: string, args: unknown = {}) =>
    post(`/api/public/invites/tools/${tool}`, args, { authorization: `Bearer ${credential}` });
  const hostMembers = async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/rooms/${roomId}/members`,
      headers: { ...headers, cookie },
    });
    assert.equal(res.statusCode, 200, res.body);
    return res.json().members as Array<{
      id: string;
      name: string;
      role: string;
      status: string;
      last_active_at: string | null;
    }>;
  };
  return {
    app,
    roomId,
    cookie,
    admit,
    invoke,
    hostMembers,
    // The owner writing in the host AI's name (agent_id): without it, a console post is the
    // owner's own as a person (in its room from creation).
    hostPost: (text: string) =>
      post(
        `/api/rooms/${roomId}/messages`,
        { text, agent_id: agent.json().agent.id, idempotency_key: randomUUID() },
        { cookie },
      ),
    advance: (ms: number) => {
      time += ms;
    },
    now: () => time,
  };
}

test('members response: status from reads and posts; host sees times, other members only status', async (t) => {
  const f = await fixture(t);
  const guest = await f.admit('Status guest');
  f.advance(2 * 60 * MIN);

  // Two hours after joining, with no calls since: offline for everyone.
  let members = await f.hostMembers();
  const byName = (list: typeof members, name: string) => list.find((m) => m.name === name)!;
  assert.equal(byName(members, 'Status guest').status, 'offline');
  assert.equal(byName(members, 'Status guest').last_active_at, coarseTime(T0));
  // The console read above is a person looking, not the host AI: it stays offline too.
  assert.equal(byName(members, 'Host desk').status, 'offline');

  // A guest read (invite credential, like /mcp/open) is recorded server-side.
  assert.equal((await f.invoke(guest.credential, 'city_room_read')).statusCode, 200);
  members = await f.hostMembers();
  assert.equal(byName(members, 'Status guest').status, 'active');
  assert.equal(byName(members, 'Status guest').last_active_at, coarseTime(f.now()));

  // Idle once the read is more than 5 minutes back (the shared active-now window starts on a
  // whole minute, so up to a minute later), offline after an hour.
  f.advance(MEMBER_STATUS.activeMs + MIN);
  assert.equal(byName(await f.hostMembers(), 'Status guest').status, 'idle');
  f.advance(MEMBER_STATUS.idleMs);
  assert.equal(byName(await f.hostMembers(), 'Status guest').status, 'offline');

  // A console post counts for the host agent (the post is visible activity).
  assert.equal((await f.hostPost('Hello room')).statusCode, 201);
  assert.equal(byName(await f.hostMembers(), 'Host desk').status, 'active');

  // The guest (not host) sees coarse status for others, exact time only for itself.
  const seen = await f.invoke(guest.credential, 'city_room_members');
  assert.equal(seen.statusCode, 200, seen.body);
  const list = seen.json().members as typeof members;
  assert.equal(byName(list, 'Host desk').status, 'active');
  assert.equal(byName(list, 'Host desk').last_active_at, null);
  assert.equal(byName(list, 'Status guest').status, 'active');
  assert.equal(byName(list, 'Status guest').last_active_at, coarseTime(f.now()));
});

test('members response: throttled activity writes; revoked or expired invite credential is access_expired', async (t) => {
  const f = await fixture(t);
  const guest = await f.admit('Status guest');
  const activity = async () =>
    Number(
      (
        await f.app.city.db.query<{ last_active_at: string | number | null }>(
          'SELECT last_active_at FROM room_members WHERE room_id=$1 AND agent_id=$2',
          [f.roomId, guest.agent_id],
        )
      ).rows[0]!.last_active_at,
    );
  {
    const r = await f.invoke(guest.credential, 'city_room_read');
    assert.equal(r.statusCode, 200, r.body);
  }
  const first = await activity();
  assert.equal(first, f.now());
  f.advance(MEMBER_STATUS.touchThrottleMs - 1);
  assert.equal((await f.invoke(guest.credential, 'city_room_read')).statusCode, 200);
  assert.equal(await activity(), first, 'no write inside the throttle window');
  f.advance(1);
  assert.equal((await f.invoke(guest.credential, 'city_room_read')).statusCode, 200);
  assert.equal(await activity(), f.now());

  await f.app.city.db.query('UPDATE room_invite_credentials SET revoked_at=$2 WHERE agent_id=$1', [
    guest.agent_id,
    f.now(),
  ]);
  const members = await f.hostMembers();
  assert.equal(members.find((m) => m.id === guest.agent_id)!.status, 'access_expired');

  // Expiry (before the sweep retires the membership) reads the same.
  const other = await f.admit('Second guest');
  await f.app.city.db.query('UPDATE room_invite_credentials SET expires_at=$2 WHERE agent_id=$1', [
    other.agent_id,
    f.now(),
  ]);
  const after = await f.hostMembers();
  assert.equal(after.find((m) => m.id === other.agent_id)!.status, 'access_expired');
  assert.equal(after.find((m) => m.name === 'Host desk')!.status, 'active');
});

test('read cursor: no since returns unread and advances; since is a lookup; console reads from the start', async (t) => {
  const f = await fixture(t);
  const guest = await f.admit('Status guest');
  const read = async (args: object = {}) => {
    const res = await f.invoke(guest.credential, 'city_room_read', args);
    assert.equal(res.statusCode, 200, res.body);
    return res.json() as {
      messages: Array<{ seq: number; text: string; mentions_you: boolean }>;
      next_since: number;
    };
  };
  const texts = (page: Awaited<ReturnType<typeof read>>) => page.messages.map((m) => m.text);
  assert.equal((await f.hostPost('First')).statusCode, 201);
  assert.equal((await f.hostPost('Second')).statusCode, 201);
  // History is full by default: everything is unread for the new guest.
  assert.deepEqual(texts(await read()), ['First', 'Second']);
  assert.deepEqual(texts(await read()), []);
  assert.equal((await f.hostPost('Hello @"Status guest", your turn')).statusCode, 201);
  assert.equal((await f.hostPost('Unrelated')).statusCode, 201);
  // An explicit since is a lookup: it returns history and marks nothing read.
  const lookup = await read({ since: 0 });
  assert.deepEqual(texts(lookup), [
    'First',
    'Second',
    'Hello @"Status guest", your turn',
    'Unrelated',
  ]);
  const unread = await read({ limit: 1 });
  assert.deepEqual(texts(unread), ['Hello @"Status guest", your turn']);
  assert.equal(unread.messages[0]!.mentions_you, true);
  const rest = await read();
  assert.deepEqual(texts(rest), ['Unrelated']);
  assert.equal(rest.messages[0]!.mentions_you, false);
  assert.equal(rest.next_since, 4);
  assert.deepEqual(texts(await read()), []);
  // format (migration 22): new posts are stored as markdown; rows from before stay plain.
  const formats = async () =>
    ((await read({ since: 0 })) as unknown as { messages: Array<{ format: string }> }).messages.map(
      (m) => m.format,
    );
  assert.deepEqual(await formats(), ['markdown', 'markdown', 'markdown', 'markdown']);
  await f.app.city.db.query("UPDATE room_messages SET format='plain' WHERE seq=1");
  assert.deepEqual(await formats(), ['plain', 'markdown', 'markdown', 'markdown']);
  // The console (a person) always reads from the start and has no cursor.
  const console = await f.app.inject({
    method: 'GET',
    url: `/api/rooms/${f.roomId}/messages`,
    headers: { ...headers, cookie: f.cookie },
  });
  assert.equal(console.statusCode, 200, console.body);
  assert.equal(console.json().messages.length, 4);
});

test('read cursor: opening history to full makes earlier messages unread (cursor only lowered)', async (t) => {
  const f = await fixture(t, { history: 'from_join' });
  assert.equal((await f.hostPost('Before join')).statusCode, 201);
  const guest = await f.admit('Late guest');
  assert.equal((await f.hostPost('After join')).statusCode, 201);
  const read = async () =>
    (
      (await f.invoke(guest.credential, 'city_room_read')).json() as {
        messages: Array<{ text: string }>;
      }
    ).messages.map((m) => m.text);
  assert.deepEqual(await read(), ['After join']);
  const cursor = async () =>
    Number(
      (
        await f.app.city.db.query<{ last_read_seq: string | number }>(
          'SELECT last_read_seq FROM room_members WHERE room_id=$1 AND agent_id=$2',
          [f.roomId, guest.agent_id],
        )
      ).rows[0]!.last_read_seq,
    );
  assert.equal(await cursor(), 2);
  const opened = await f.app.inject({
    method: 'POST',
    url: `/api/rooms/${f.roomId}/settings`,
    headers: { ...headers, cookie: f.cookie },
    payload: JSON.stringify({ history: 'full' }),
  });
  assert.equal(opened.statusCode, 200, opened.body);
  assert.equal(await cursor(), 0);
  assert.deepEqual(await read(), ['Before join', 'After join']);
  assert.equal(await cursor(), 2);
});

test('read cursor: a read that raced a history switch does not re-raise the reset cursor', async (t) => {
  const f = await fixture(t, { history: 'from_join' });
  assert.equal((await f.hostPost('Before join')).statusCode, 201);
  const guest = await f.admit('Late guest');
  assert.equal((await f.hostPost('After join')).statusCode, 201);
  const row = async () =>
    (
      await f.app.city.db.query<{
        last_read_seq: string | number;
        visible_from_seq: string | number;
      }>(
        'SELECT last_read_seq,visible_from_seq FROM room_members WHERE room_id=$1 AND agent_id=$2',
        [f.roomId, guest.agent_id],
      )
    ).rows[0]!;
  const seenBefore = Number((await row()).visible_from_seq);
  assert.equal(seenBefore, 1);
  // The switch commits first (visible_from_seq and the cursor go to 0)...
  await f.app.city.db.query(
    'UPDATE room_members SET visible_from_seq=0, last_read_seq=0 WHERE room_id=$1 AND agent_id=$2',
    [f.roomId, guest.agent_id],
  );
  // ...then the earlier read (which saw visible_from_seq 1 and returned seq 2) records itself.
  await touchMembers(
    f.app.city.db,
    f.roomId,
    [guest.agent_id],
    f.now(),
    2,
    new Map([[guest.agent_id, seenBefore]]),
  );
  assert.equal(Number((await row()).last_read_seq), 0, 'cursor stays reset');
  // A read with the current visible_from_seq still advances it.
  await touchMembers(
    f.app.city.db,
    f.roomId,
    [guest.agent_id],
    f.now(),
    2,
    new Map([[guest.agent_id, 0]]),
  );
  assert.equal(Number((await row()).last_read_seq), 2);
});

test('console long-poll (?wait) never moves the AI cursor and always reads from the start', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.hostPost('First')).statusCode, 201);
  assert.equal((await f.hostPost('Second')).statusCode, 201);
  const cursor = async () =>
    (
      await f.app.city.db.query<{ last_read_seq: string | number }>(
        "SELECT last_read_seq FROM room_members WHERE room_id=$1 AND role='host'",
        [f.roomId],
      )
    ).rows.map((row) => Number(row.last_read_seq));
  for (let i = 0; i < 2; i++) {
    const res = await f.app.inject({
      method: 'GET',
      url: `/api/rooms/${f.roomId}/messages?wait=1`,
      headers: { ...headers, cookie: f.cookie },
    });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().messages.length, 2, 'the full history, every time');
  }
  assert.deepEqual(await cursor(), [0]);
});

test("migration 21 backfills each cursor to the member's own last post (not 0, not everything)", async (t) => {
  const f = await fixture(t);
  const guest = await f.admit('Poster guest');
  assert.equal((await f.hostPost('One')).statusCode, 201);
  const posted = await f.invoke(guest.credential, 'city_room_post', {
    text: 'Guest says hi',
    idempotency_key: randomUUID(),
  });
  assert.equal(posted.statusCode, 200, posted.body);
  assert.equal((await f.hostPost('Three')).statusCode, 201);
  const quiet = await f.admit('Quiet guest');
  // As before migration 21: no cursor and no activity recorded.
  await f.app.city.db.query('UPDATE room_members SET last_read_seq=0, last_active_at=NULL');
  await f.app.city.db.exec(memberActivityMigration.sql);
  const rows = new Map(
    (
      await f.app.city.db.query<{ agent_id: string; last_read_seq: string | number }>(
        'SELECT agent_id, last_read_seq FROM room_members WHERE room_id=$1',
        [f.roomId],
      )
    ).rows.map((row) => [row.agent_id, Number(row.last_read_seq)]),
  );
  assert.equal(rows.get(guest.agent_id), 2, 'up to its own post');
  assert.equal(rows.get(quiet.agent_id), 0, 'never posted: its history start (full room)');
  const unread = await f.invoke(guest.credential, 'city_room_read');
  assert.deepEqual(
    unread.json().messages.map((m: { text: string }) => m.text),
    ['Three'],
  );
});

test('read cursor: a refused read and a removed member leave the cursor where it was', async (t) => {
  const f = await fixture(t);
  const guest = await f.admit('Cursor guest');
  assert.equal((await f.hostPost('One')).statusCode, 201);
  assert.equal((await f.invoke(guest.credential, 'city_room_read')).statusCode, 200);
  const cursor = async () =>
    Number(
      (
        await f.app.city.db.query<{ last_read_seq: string | number }>(
          'SELECT last_read_seq FROM room_members WHERE room_id=$1 AND agent_id=$2',
          [f.roomId, guest.agent_id],
        )
      ).rows[0]!.last_read_seq,
    );
  assert.equal(await cursor(), 1);
  assert.equal((await f.hostPost('Two')).statusCode, 201);
  // The credential check (guard) refuses the read: nothing moves.
  await f.app.city.db.query('UPDATE room_invite_credentials SET revoked_at=$2 WHERE agent_id=$1', [
    guest.agent_id,
    f.now(),
  ]);
  assert.equal((await f.invoke(guest.credential, 'city_room_read')).statusCode, 401);
  assert.equal(await cursor(), 1);
  // A removed member's row is never touched again, even with a direct touch.
  await f.app.city.db.query(
    'UPDATE room_members SET removed_at=$3, removed_by=$4 WHERE room_id=$1 AND agent_id=$2',
    [f.roomId, guest.agent_id, f.now(), 'the owner'],
  );
  await touchMembers(
    f.app.city.db,
    f.roomId,
    [guest.agent_id],
    f.now() + MEMBER_STATUS.touchThrottleMs,
    2,
    new Map([[guest.agent_id, 0]]),
  );
  assert.equal(await cursor(), 1);
});
