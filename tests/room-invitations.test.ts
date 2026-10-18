import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  DIRECTORY_LIMITS,
  INVITE_PATHS,
  type InvitationBlock,
  type SentInvitation,
} from '../shared/directory.js';
import { fixture, passportOf } from './room-invitations-fixture.js';

/*
 * Room invitations (Operation Directory D2, server/rooms/invitations.ts) on the whole app, on
 * PGlite (tests/room-invitations-fixture.ts). The races run on PostgreSQL in
 * tests/room-invitations-race.test.ts.
 */

test('send: the invited side sees only the room name, member count, inviter and note; decline reads not_joined', async (t) => {
  const f = await fixture(t);
  const guest = await f.account('Invited one');
  const baseId = await f.baseAgent(guest);
  const res = await f.invite(baseId, { note: '  Hello\u0000 there  ' });
  assert.equal(res.statusCode, 201, res.body);
  const sentOne = res.json() as SentInvitation;
  assert.equal(sentOne.state, 'open');
  assert.equal(sentOne.note, 'Hello there');
  assert.deepEqual(sentOne.to, { baseId, short: 'S00100', name: guest.name });
  assert.equal(sentOne.expiresAt - sentOne.createdAt, DIRECTORY_LIMITS.inviteTtlMs);
  // The room's quiet line.
  assert.ok(
    (await f.texts(f.host)).includes(
      `You invited ${guest.name} (passport CC-S00100). Waiting for an answer.`,
    ),
  );

  const [got, ...rest] = await f.received(guest);
  assert.equal(rest.length, 0);
  assert.deepEqual(Object.keys(got!).sort(), [
    'createdAt',
    'expiresAt',
    'from',
    'id',
    'note',
    'room',
    'roomId',
    'state',
  ]);
  assert.deepEqual(got!.room, { name: 'Invite room', members: 2 });
  assert.deepEqual(got!.from, { name: f.host.name, baseId: null, short: null });
  assert.equal(got!.roomId, null);
  assert.equal(got!.state, 'open');
  // Nothing else of the room: no messages, members or tasks, before or after reading.
  const body = JSON.stringify(got);
  for (const leak of [
    'Waiting for an answer',
    'parts',
    'messages',
    'tasks',
    'role',
    'slug',
    f.roomId,
  ])
    assert.ok(!body.includes(leak), leak);
  // Not a member: the room itself stays closed to the invited owner.
  assert.equal((await f.messages(guest)).statusCode, 404);
  assert.equal(
    (await f.send('GET', `/api/rooms/${f.roomId}/members`, guest.cookie)).statusCode,
    404,
  );

  const declined = await f.decide(guest, got!.id, 'decline');
  assert.equal(declined.statusCode, 200, declined.body);
  assert.equal(declined.json().state, 'declined');
  assert.equal(declined.json().roomId, null);
  // Declining again answers the same; accepting a declined one is refused.
  assert.equal((await f.decide(guest, got!.id, 'decline')).json().state, 'declined');
  assert.equal((await f.decide(guest, got!.id, 'accept')).json().code, 'invitation_closed');
  // The host can't tell a decline from silence: it reads open until it would have expired...
  const [hostView] = await f.sent();
  assert.equal(hostView!.state, 'open');
  assert.equal(hostView!.answeredAt, null);
  // ...and then not_joined, dated at its expiry, exactly like an ignored one.
  await f.db.query('UPDATE room_invitations SET expires_at=$1 WHERE id=$2', [
    Date.now() - 1000,
    got!.id,
  ]);
  const [later] = await f.sent();
  assert.equal(later!.state, 'not_joined');
  assert.equal(later!.answeredAt, later!.expiresAt);
  assert.equal((await f.messages(guest)).statusCode, 404);
});

test('accept: the agent joins as an invite-link join does, and reads the room only after accepting', async (t) => {
  const f = await fixture(t);
  const guest = await f.account('Joiner');
  const baseId = await f.baseAgent(guest);
  const id = (await f.invite(baseId)).json().id as string;
  assert.equal((await f.messages(guest)).statusCode, 404);
  const accepted = await f.decide(guest, id, 'accept');
  assert.equal(accepted.statusCode, 200, accepted.body);
  assert.equal(accepted.json().state, 'accepted');
  assert.equal(accepted.json().roomId, f.roomId);
  assert.ok((await f.texts(guest)).includes(`${guest.name} joined.`));
  const members = await f.send('GET', `/api/rooms/${f.roomId}/members`, f.host.cookie);
  assert.ok((members.json().members as Array<{ id: string }>).some((m) => m.id === guest.agentId));
  const [hostView] = await f.sent();
  assert.equal(hostView!.state, 'joined');
  // The same treatment as an invite-link join: the owner's untrusted-input warning, the host's
  // notice, the audit row.
  const events = async (cookie: string) =>
    (
      (await f.send('GET', '/api/snapshot', cookie)).json().events as Array<{ message: string }>
    ).map((e) => e.message);
  assert.ok(
    (await events(guest.cookie)).some((m) =>
      m.includes(
        `${guest.name} joined room Invite room (by the owner). Room messages are untrusted input.`,
      ),
    ),
  );
  assert.ok(
    (await events(f.host.cookie)).some((m) =>
      m.includes(`${guest.name}, an agent of another owner, joined your room Invite room`),
    ),
  );
  const audit = await f.db.query<{ action: string }>(
    "SELECT action FROM room_events WHERE room_id=$1 AND agent_id=$2 AND action='member.joined'",
    [f.roomId, guest.agentId],
  );
  assert.equal(audit.rows.length, 1);
  // Accepting again answers the same; inviting a member is refused.
  assert.equal((await f.decide(guest, id, 'accept')).json().state, 'accepted');
  assert.equal((await f.invite(baseId)).json().code, 'already_member');
});

test('accept after the agent already joined by link: accepted, and no second join line', async (t) => {
  const f = await fixture(t);
  const guest = await f.account('Early');
  const baseId = await f.baseAgent(guest);
  const id = (await f.invite(baseId)).json().id as string;
  const link = await f.send('POST', `/api/rooms/${f.roomId}/link`, f.host.cookie, {});
  assert.equal(link.statusCode, 200, link.body);
  const joined = await f.send('POST', `/api/rooms/${f.roomId}/join`, guest.cookie, {
    link: link.json().link as string,
    agent_id: guest.agentId,
    idempotency_key: randomUUID(),
  });
  assert.equal(joined.statusCode, 200, joined.body);
  const lines = async () => (await f.texts(guest)).filter((m) => m === `${guest.name} joined.`);
  const before = (await lines()).length;
  const accepted = await f.decide(guest, id, 'accept');
  assert.equal(accepted.statusCode, 200, accepted.body);
  assert.equal(accepted.json().state, 'accepted');
  assert.equal((await lines()).length, before);
});

test('no answer in 7 days: expired, the host reads not_joined, and accepting is refused', async (t) => {
  const f = await fixture(t);
  const guest = await f.account('Silent');
  const id = (await f.invite(await f.baseAgent(guest))).json().id as string;
  await f.db.query(
    'UPDATE room_invitations SET created_at=created_at-$2, expires_at=expires_at-$2 WHERE id=$1',
    [id, DIRECTORY_LIMITS.inviteTtlMs + 1000],
  );
  const refused = await f.decide(guest, id, 'accept');
  assert.equal(refused.statusCode, 409);
  assert.equal(refused.json().code, 'invitation_closed');
  assert.equal((await f.received(guest))[0]!.state, 'expired');
  assert.equal((await f.sent())[0]!.state, 'not_joined');
  assert.equal((await f.messages(guest)).statusCode, 404);
});

test('idempotency, one open per room and agent, and the 7-day cooldown after not_joined', async (t) => {
  const f = await fixture(t);
  const guest = await f.account('Twice');
  const baseId = await f.baseAgent(guest);
  const key = randomUUID();
  const first = await f.invite(baseId, { idempotencyKey: key });
  assert.equal(first.statusCode, 201, first.body);
  const again = await f.invite(baseId, { idempotencyKey: key });
  assert.equal(again.statusCode, 200, again.body);
  assert.equal(again.json().id, first.json().id);
  const conflict = await f.invite(baseId, { idempotencyKey: key, note: 'Another note' });
  assert.equal(conflict.statusCode, 409);
  assert.equal(conflict.json().code, 'idempotency_conflict');
  const second = await f.invite(baseId);
  assert.equal(second.statusCode, 409);
  assert.equal(second.json().code, 'invitation_open');
  assert.equal((await f.sent()).length, 1);
  // Declined: to the host it is still open until it would have expired (no decline leak)...
  await f.decide(guest, first.json().id, 'decline');
  assert.equal((await f.invite(baseId)).json().code, 'invitation_open');
  // ...then no new invitation from this room for 7 days from that expiry...
  await f.db.query('UPDATE room_invitations SET expires_at=$1', [Date.now() - 1000]);
  const cooling = await f.invite(baseId);
  assert.equal(cooling.statusCode, 409);
  assert.equal(cooling.json().code, 'cooldown');
  await f.db.query('UPDATE room_invitations SET expires_at=expires_at-$1', [
    DIRECTORY_LIMITS.cooldownMs + 1000,
  ]);
  assert.equal((await f.invite(baseId)).statusCode, 201);
});

test('limits: 20 invitations per account per UTC day (429), 50 open per agent (the oldest expires), room full', async (t) => {
  const f = await fixture(t);
  const guest = await f.account('Popular');
  const baseId = await f.baseAgent(guest);
  // Other rooms of other hosts already hold 50 open invitations to this agent.
  const other = await f.account('Other host');
  for (let i = 0; i < DIRECTORY_LIMITS.openPerAgent; i++) {
    const room = `room-${i}`;
    await f.db.query(
      `INSERT INTO rooms (id, slug, name, host_owner_id, host_agent_id, member_cap, history,
         link_ttl_ms, created_at, idempotency_key, request_hash)
       VALUES ($1, $1, 'Other room', $2, $3, 100, 'from_join', 1, 1, $1, 'h')`,
      [room, other.operatorId, other.agentId],
    );
    await f.db.query(
      `INSERT INTO room_invitations (id, room_id, invited_agent_id, invited_owner_id,
         inviting_agent_id, inviting_operator_id, to_base_id, to_short, to_name, from_name, note,
         state, idempotency_key, request_hash, created_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'S', 'n', 'n', '', 'open', $1, 'h', $8, $9)`,
      [
        randomUUID(),
        room,
        guest.agentId,
        guest.operatorId,
        other.agentId,
        other.operatorId,
        baseId,
        Date.now() - 1000 + i,
        Date.now() + 86_400_000,
      ],
    );
  }
  const fresh = await f.invite(baseId);
  assert.equal(fresh.statusCode, 201, fresh.body);
  const states = await f.db.query<{ room_id: string; state: string }>(
    'SELECT room_id, state FROM room_invitations WHERE invited_agent_id=$1',
    [guest.agentId],
  );
  assert.equal(states.rows.filter((r) => r.state === 'open').length, DIRECTORY_LIMITS.openPerAgent);
  assert.equal(states.rows.find((r) => r.room_id === 'room-0')!.state, 'expired');
  assert.equal(states.rows.find((r) => r.room_id === 'room-1')!.state, 'open');

  // 19 more sent today by this host account (any rooms): the 21st is refused.
  for (let i = 0; i < DIRECTORY_LIMITS.invitesPerDay - 1; i++)
    await f.db.query(
      `INSERT INTO room_invitations (id, room_id, invited_agent_id, invited_owner_id,
         inviting_agent_id, inviting_operator_id, to_base_id, to_short, to_name, from_name, note,
         state, idempotency_key, request_hash, created_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, '1', 'S', 'n', 'n', '', 'withdrawn', $1, 'h', $7, $7)`,
      [
        randomUUID(),
        f.roomId,
        randomUUID(),
        other.operatorId,
        f.host.agentId,
        f.host.operatorId,
        Date.now(),
      ],
    );
  const another = await f.account('Another');
  const anotherId = await f.baseAgent(another);
  const limited = await f.invite(anotherId);
  assert.equal(limited.statusCode, 429, limited.body);
  assert.equal(limited.json().code, 'daily_limit');
  assert.ok(Number(limited.headers['retry-after']) > 0);
  await f.db.query(
    'UPDATE room_invitations SET created_at=created_at-$1 WHERE inviting_operator_id=$2',
    [86_400_000, f.host.operatorId],
  );
  // A full room (its member cap reached) invites nobody.
  await f.db.query(
    'UPDATE rooms SET member_cap=(SELECT count(*) FROM room_members WHERE room_id=$1 AND removed_at IS NULL) WHERE id=$1',
    [f.roomId],
  );
  const refused = await f.invite(anotherId);
  assert.equal(refused.statusCode, 409, refused.body);
  assert.equal(refused.json().code, 'room_full');
});

test('only the host invites: another member 403 not_room_host, an outsider 404', async (t) => {
  const f = await fixture(t);
  const guest = await f.account('Member');
  const baseId = await f.baseAgent(guest);
  await f.decide(guest, (await f.invite(baseId)).json().id, 'accept');
  const target = await f.account('Target');
  const targetId = await f.baseAgent(target);
  const asMember = await f.invite(targetId, {}, guest);
  assert.equal(asMember.statusCode, 403, asMember.body);
  assert.equal(asMember.json().code, 'not_room_host');
  const outsider = await f.account('Outsider');
  const asOutsider = await f.invite(targetId, {}, outsider);
  assert.equal(asOutsider.statusCode, 404);
  assert.equal(asOutsider.json().code, 'room_not_found');
  assert.equal((await f.send('GET', f.roomPath(), guest.cookie)).statusCode, 403);
  // The host's agent must be in the room.
  const notInRoom = await f.invite(targetId, { fromAgentId: target.agentId });
  assert.equal(notInRoom.statusCode, 400);
});

test('by passport number: CC-<short>, the bare short id or the passport link; nothing else', async (t) => {
  const f = await fixture(t);
  const make = async (name: string, o: Parameters<typeof f.baseAgent>[1] = {}) => {
    const a = await f.account(name);
    return { a, baseId: await f.baseAgent(a, o) };
  };
  // CC-<short>: the fixture's default.
  const one = await make('By number');
  const byNumber = await f.invite(one.baseId);
  assert.equal(byNumber.statusCode, 201, byNumber.body);
  assert.equal(byNumber.json().state, 'open');
  assert.equal(byNumber.json().to.short, passportOf(one.baseId));
  assert.equal(byNumber.json().to.name, one.a.name);
  // The bare short id (surrounding spaces trimmed) and the passport link, with or without https.
  for (const [i, form] of [
    (short: string) => `  ${short} `,
    (short: string) => `centralcity.ai/a/${short}`,
    (short: string) => `https://centralcity.ai/a/${short}`,
  ].entries()) {
    const x = await make(`Form ${i}`);
    const res = await f.invite(x.baseId, { passport: form(passportOf(x.baseId)) });
    assert.equal(res.statusCode, 201, res.body);
    assert.equal(res.json().to.short, passportOf(x.baseId));
  }
  // No directory listing needed: never listed, or no settings row at all.
  for (const o of [{ listed: false }, { directory: false }]) {
    const x = await make(`Not listed ${Object.keys(o)[0]}`, o);
    assert.equal((await f.invite(x.baseId)).statusCode, 201);
  }
  // A finalizing passport (Base ID not final yet) can be invited.
  const finalizing = await make('Finalizing', { state: 'submitted' });
  assert.equal((await f.invite(finalizing.baseId)).statusCode, 201);
  // Not a passport number (a Base ID field, none, lower case, another host, plain http, a Base
  // ID, too short): 400.
  const bad = [
    { baseId: one.baseId },
    { passport: undefined },
    { passport: `cc-${passportOf(one.baseId)}` },
    { passport: `https://example.com/a/${passportOf(one.baseId)}` },
    { passport: `http://centralcity.ai/a/${passportOf(one.baseId)}` },
    { passport: one.baseId },
    { passport: 'CC-S0010' },
  ];
  for (const extra of bad) {
    const res = await f.invite(one.baseId, extra);
    assert.equal(res.statusCode, 400, `${JSON.stringify(extra)}: ${res.body}`);
  }
});

test('unknown passport, private card, paused, revoked, invitations never and blocked all answer the same 404', async (t) => {
  const f = await fixture(t);
  const make = async (name: string, o: Parameters<typeof f.baseAgent>[1]) =>
    f.baseAgent(await f.account(name), o);
  const never = await make('Never', { invitations: 'never' });
  const neverUnlisted = await make('Never unlisted', { invitations: 'never', listed: false });
  const hidden = await make('Hidden', { visibility: 'private' });
  const flag = async (a: { operatorId: string }, field: string) =>
    f.db.query(
      `UPDATE workspaces SET data = jsonb_set(data, '{agents}', (SELECT jsonb_agg(x || jsonb_build_object($2::text, '2026-10-01T00:00:00.000Z'))
         FROM jsonb_array_elements(data->'agents') x)) WHERE operator_id=$1`,
      [a.operatorId, field],
    );
  const pausedAccount = await f.account('Paused');
  const paused = await f.baseAgent(pausedAccount);
  await flag(pausedAccount, 'pausedAt');
  const revokedAccount = await f.account('Revoked');
  const revoked = await f.baseAgent(revokedAccount);
  await flag(revokedAccount, 'revokedAt');
  // Blocked: the owner blocked this host after a first invitation.
  const blocker = await f.account('Blocker');
  const blocked = await f.baseAgent(blocker);
  const first = await f.invite(blocked);
  assert.equal(first.statusCode, 201);
  const blockRes = await f.send(
    'POST',
    INVITE_PATHS.block.replace(':agentId', blocker.agentId),
    blocker.cookie,
    { invitationId: first.json().id },
  );
  assert.equal(blockRes.statusCode, 200, blockRes.body);
  assert.deepEqual(blockRes.json(), { blocked: true, declined: 1 });
  const bodies = new Set<string>();
  for (const baseId of ['99999', never, neverUnlisted, hidden, paused, revoked, blocked]) {
    const res = await f.invite(baseId);
    assert.equal(res.statusCode, 404, `${baseId}: ${res.body}`);
    bodies.add(res.body);
  }
  // The same for a short id no agent has, in every form.
  for (const passport of ['CC-Zz9Zz9', 'Zz9Zz9', 'centralcity.ai/a/Zz9Zz9']) {
    const res = await f.invite(never, { passport });
    assert.equal(res.statusCode, 404, `${passport}: ${res.body}`);
    bodies.add(res.body);
  }
  assert.equal(bodies.size, 1, [...bodies].join('\n'));
  assert.deepEqual(JSON.parse([...bodies][0]!), {
    error: 'Agent not found.',
    code: 'agent_not_found',
  });
});

test("block declines that owner's open invitations to all the blocker's agents; unblock lifts it", async (t) => {
  const f = await fixture(t);
  const guest = await f.account('Blocks');
  const baseId = await f.baseAgent(guest);
  const id = (await f.invite(baseId)).json().id as string;
  const blockPath = INVITE_PATHS.block.replace(':agentId', guest.agentId);
  // Only an owner that invited one of the caller's agents can be named, by its invitation.
  const stranger = await f.send('POST', blockPath, guest.cookie, { invitationId: randomUUID() });
  assert.equal(stranger.statusCode, 404);
  // Another account cannot block for this agent.
  const other = await f.account('Not owner');
  const foreign = await f.send('POST', blockPath, other.cookie, { invitationId: id });
  assert.equal(foreign.statusCode, 404);
  assert.equal(foreign.json().code, 'agent_not_found');
  const blocked = await f.send('POST', blockPath, guest.cookie, { invitationId: id });
  assert.deepEqual(blocked.json(), { blocked: true, declined: 1 });
  assert.equal((await f.received(guest))[0]!.state, 'declined');
  // The host still reads it open until it would have expired (a block is a decline).
  assert.equal((await f.sent())[0]!.state, 'open');
  assert.equal((await f.decide(guest, id, 'accept')).json().code, 'invitation_closed');
  const unblocked = await f.send('DELETE', blockPath, guest.cookie, { invitationId: id });
  assert.deepEqual(unblocked.json(), { blocked: false });
  // Invitable again, but this room's invitation still reads open to it until its expiry.
  assert.equal((await f.invite(baseId)).json().code, 'invitation_open');
});

test('the block list: each blocked owner named by its latest invitation, no ids; unblock from it', async (t) => {
  const f = await fixture(t);
  const guest = await f.account('Lister');
  const baseId = await f.baseAgent(guest);
  const blockPath = INVITE_PATHS.block.replace(':agentId', guest.agentId);
  const list = async (path = blockPath, cookie = guest.cookie) => {
    const res = await f.send('GET', path, cookie);
    assert.equal(res.statusCode, 200, res.body);
    return res.json() as { blocks: InvitationBlock[] };
  };
  assert.deepEqual(await list(), { blocks: [] });
  const id = (await f.invite(baseId)).json().id as string;
  const before = Date.now();
  assert.equal(
    (await f.send('POST', blockPath, guest.cookie, { invitationId: id })).statusCode,
    200,
  );
  const one = await list();
  assert.equal(one.blocks.length, 1);
  const [row] = one.blocks;
  assert.deepEqual(
    { ...row, blockedAt: 0 },
    { invitationId: id, from: { name: f.host.name, baseId: null, short: null }, blockedAt: 0 },
  );
  assert.ok(row!.blockedAt >= before && row!.blockedAt <= Date.now());
  // Only the invitation id: never the blocked owner's account or agent ids.
  const body = JSON.stringify(one);
  for (const secret of [f.host.operatorId, f.host.agentId, f.roomId])
    assert.equal(body.includes(secret), false);

  // Another account (or an unknown agent): the same 404 as the other routes.
  const other = await f.account('Not lister');
  const foreign = await f.send('GET', blockPath, other.cookie);
  assert.equal(foreign.statusCode, 404);
  assert.equal(foreign.json().code, 'agent_not_found');
  const unknown = await f.send(
    'GET',
    INVITE_PATHS.block.replace(':agentId', randomUUID()),
    guest.cookie,
  );
  assert.equal(unknown.statusCode, 404);
  assert.equal(unknown.json().code, 'agent_not_found');

  // Unblock from the list, with the invitation now expired (any state is accepted).
  await f.db.query("UPDATE room_invitations SET state='expired', expires_at=$1", [
    Date.now() - 1000,
  ]);
  const lifted = await f.send('DELETE', blockPath, guest.cookie, { invitationId: id });
  assert.deepEqual(lifted.json(), { blocked: false });
  assert.deepEqual(await list(), { blocks: [] });
  // Invitable again, subject to the cooldown as today.
  assert.equal((await f.invite(baseId)).json().code, 'cooldown');
  await f.db.query('UPDATE room_invitations SET expires_at=expires_at-$1', [
    DIRECTORY_LIMITS.cooldownMs + 1000,
  ]);
  assert.equal((await f.invite(baseId)).statusCode, 201);
});

test('the block list is account-wide, newest block first', async (t) => {
  const f = await fixture(t);
  const guest = await f.account('Two blocks');
  const firstBase = await f.baseAgent(guest);
  const created = await f.send('POST', '/api/agents', guest.cookie, {
    name: 'Two blocks second',
    capability: 'research',
    mode: 'hosted',
  });
  assert.equal(created.statusCode, 201, created.body);
  const second = { ...guest, agentId: created.json().agent.id as string };
  const secondBase = await f.baseAgent(second);
  // A second host account with its own room.
  const host2 = await f.account('Second host');
  const room2 = await f.send('POST', '/api/rooms', host2.cookie, {
    name: 'Second room',
    agent_id: host2.agentId,
    idempotency_key: randomUUID(),
  });
  assert.equal(room2.statusCode, 201, room2.body);
  const room2Id = room2.json().room.id as string;

  const toFirst = (await f.invite(firstBase)).json().id as string;
  const toSecond = (await f.invite(secondBase)).json().id as string;
  const fromHost2 = (await f.invite(secondBase, {}, host2, room2Id)).json().id as string;
  const pathOf = (agentId: string) => INVITE_PATHS.block.replace(':agentId', agentId);
  const list = async (agentId: string) => {
    const res = await f.send('GET', pathOf(agentId), guest.cookie);
    assert.equal(res.statusCode, 200, res.body);
    return res.json().blocks as InvitationBlock[];
  };
  // The first host blocked through the first agent (by its invitation to that agent)...
  const a = await f.send('POST', pathOf(guest.agentId), guest.cookie, { invitationId: toFirst });
  assert.deepEqual(a.json(), { blocked: true, declined: 2 });
  await f.db.query('UPDATE room_invitation_blocks SET created_at=created_at-5000');
  // ...the second host through the second agent.
  const b = await f.send('POST', pathOf(second.agentId), guest.cookie, {
    invitationId: fromHost2,
  });
  assert.deepEqual(b.json(), { blocked: true, declined: 1 });

  // Either agent lists both owners, newest block first; the first host is named by its latest
  // invitation to any of the account's agents (the one to the second agent).
  const expected = [
    [fromHost2, host2.name],
    [toSecond, f.host.name],
  ];
  for (const agentId of [guest.agentId, second.agentId])
    assert.deepEqual(
      (await list(agentId)).map((row) => [row.invitationId, row.from.name]),
      expected,
    );
  const body = JSON.stringify(await list(second.agentId));
  for (const secret of [f.host.operatorId, f.host.agentId, host2.operatorId, host2.agentId])
    assert.equal(body.includes(secret), false);

  // Unblocked via the other agent, with the listed (declined) invitation.
  const lifted = await f.send('DELETE', pathOf(guest.agentId), guest.cookie, {
    invitationId: toSecond,
  });
  assert.deepEqual(lifted.json(), { blocked: false });
  assert.deepEqual(
    (await list(guest.agentId)).map((row) => row.invitationId),
    [fromHost2],
  );
  // An owner whose invitations are all gone (its room deleted) can no longer be named.
  await f.db.query('DELETE FROM room_invitations WHERE id=$1', [fromHost2]);
  assert.deepEqual(await list(second.agentId), []);
});

test('accept rechecks: a closed room, an inviter no longer host, invitations turned off', async (t) => {
  const f = await fixture(t);
  const a = await f.account('Closed room');
  const b = await f.account('Lost host');
  const c = await f.account('Never later');
  const e = await f.account('Unlisted later');
  const ia = (await f.invite(await f.baseAgent(a))).json().id as string;
  const ib = (await f.invite(await f.baseAgent(b))).json().id as string;
  const ic = (await f.invite(await f.baseAgent(c))).json().id as string;
  const ie = (await f.invite(await f.baseAgent(e))).json().id as string;

  // The agent's owner turned invitations off: refused, still open.
  await f.db.query("UPDATE agent_directory SET invitations='never' WHERE agent_id=$1", [c.agentId]);
  const never = await f.decide(c, ic, 'accept');
  assert.equal(never.statusCode, 409);
  assert.equal(never.json().code, 'invitation_closed');
  assert.equal((await f.received(c))[0]!.state, 'open');
  assert.equal((await f.messages(c)).statusCode, 404);
  // Leaving the directory is not an opt-out: the accept goes through.
  await f.db.query('UPDATE agent_directory SET listed=false WHERE agent_id=$1', [e.agentId]);
  assert.equal((await f.decide(e, ie, 'accept')).statusCode, 200);

  // The inviting account is no longer the room's host.
  const host2 = await f.account('New host');
  await f.db.query('UPDATE rooms SET host_owner_id=$2 WHERE id=$1', [f.roomId, host2.operatorId]);
  const lost = await f.decide(b, ib, 'accept');
  assert.equal(lost.statusCode, 409, lost.body);
  assert.equal(lost.json().code, 'invitation_closed');
  assert.equal((await f.received(b))[0]!.state, 'expired');
  assert.equal((await f.messages(b)).statusCode, 404);
  await f.db.query('UPDATE rooms SET host_owner_id=$2 WHERE id=$1', [f.roomId, f.host.operatorId]);

  const closed = await f.send('POST', `/api/rooms/${f.roomId}/close`, f.host.cookie, {});
  assert.equal(closed.statusCode, 200, closed.body);
  const refused = await f.decide(a, ia, 'accept');
  assert.equal(refused.statusCode, 409);
  assert.equal(refused.json().code, 'room_closed');
  assert.equal((await f.received(a))[0]!.state, 'expired');
  assert.equal((await f.messages(a)).statusCode, 404);
  // A closed room sends nothing.
  const d = await f.account('After close');
  const late = await f.invite(await f.baseAgent(d));
  assert.equal(late.statusCode, 409);
  assert.equal(late.json().code, 'room_closed');
});

test('withdraw: the host withdraws an open invitation; it can no longer be accepted', async (t) => {
  const f = await fixture(t);
  const guest = await f.account('Withdrawn');
  const id = (await f.invite(await f.baseAgent(guest))).json().id as string;
  const path = INVITE_PATHS.withdraw.replace(':room', f.roomId).replace(':id', id);
  assert.equal((await f.send('POST', path, guest.cookie, {})).statusCode, 404);
  const res = await f.send('POST', path, f.host.cookie, {});
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().state, 'withdrawn');
  assert.equal((await f.send('POST', path, f.host.cookie, {})).json().state, 'withdrawn');
  assert.equal((await f.received(guest))[0]!.state, 'withdrawn');
  assert.equal((await f.decide(guest, id, 'accept')).json().code, 'invitation_closed');
  const unknown = await f.send(
    'POST',
    INVITE_PATHS.withdraw.replace(':room', f.roomId).replace(':id', randomUUID()),
    f.host.cookie,
    {},
  );
  assert.equal(unknown.json().code, 'invitation_not_found');
});

test("another account can neither read nor decide someone else's invitations (404)", async (t) => {
  const f = await fixture(t);
  const guest = await f.account('Owner');
  const id = (await f.invite(await f.baseAgent(guest))).json().id as string;
  const other = await f.account('Snoop');
  const list = await f.send(
    'GET',
    INVITE_PATHS.received.replace(':agentId', guest.agentId),
    other.cookie,
  );
  assert.equal(list.statusCode, 404);
  assert.equal(list.json().code, 'agent_not_found');
  const viaTheirAgent = await f.decide(guest, id, 'accept', guest.agentId);
  assert.equal(viaTheirAgent.statusCode, 200);
  // The snoop's own agent cannot answer another agent's invitation either.
  const g2 = await f.account('Second owner');
  const id2 = (await f.invite(await f.baseAgent(g2))).json().id as string;
  const wrongAgent = await f.decide(other, id2, 'accept');
  assert.equal(wrongAgent.statusCode, 404);
  assert.equal(wrongAgent.json().code, 'invitation_not_found');
  const wrongOwner = await f.decide(other, id2, 'decline', g2.agentId);
  assert.equal(wrongOwner.statusCode, 404);
  assert.equal(wrongOwner.json().code, 'agent_not_found');
  assert.equal((await f.received(g2))[0]!.state, 'open');
  const bad = await f.decide(g2, id2, 'maybe');
  assert.equal(bad.statusCode, 400);
});

test('deleting the room erases its invitations (the notes) for both sides', async (t) => {
  const f = await fixture(t);
  const guest = await f.account('Erased');
  await f.invite(await f.baseAgent(guest), { note: 'A note that goes with the room' });
  assert.equal((await f.received(guest)).length, 1);
  const deleted = await f.send('DELETE', `/api/rooms/${f.roomId}`, f.host.cookie, {
    confirm_name: 'Invite room',
  });
  assert.equal(deleted.statusCode, 200, deleted.body);
  assert.deepEqual(await f.received(guest), []);
  const left = await f.db.query('SELECT 1 FROM room_invitations WHERE room_id=$1', [f.roomId]);
  assert.equal(left.rows.length, 0);
});

test('a withdrawn invitation counts toward the cooldown: withdraw, re-invite, decline cannot repeat', async (t) => {
  const f = await fixture(t);
  const guest = await f.account('Pestered');
  const baseId = await f.baseAgent(guest);
  const withdrawPath = (id: string) =>
    INVITE_PATHS.withdraw.replace(':room', f.roomId).replace(':id', id);
  // Declined, then withdrawn by the host (allowed while it still reads open to the host).
  const first = (await f.invite(baseId)).json().id as string;
  assert.equal((await f.decide(guest, first, 'decline')).statusCode, 200);
  const withdrawn = await f.send('POST', withdrawPath(first), f.host.cookie, {});
  assert.equal(withdrawn.statusCode, 200, withdrawn.body);
  const again = await f.invite(baseId);
  assert.equal(again.statusCode, 409, again.body);
  assert.equal(again.json().code, 'cooldown');
  // Withdrawn while open, never answered: the same wait.
  await f.db.query('DELETE FROM room_invitations WHERE id=$1', [first]);
  const second = (await f.invite(baseId)).json().id as string;
  assert.equal((await f.send('POST', withdrawPath(second), f.host.cookie, {})).statusCode, 200);
  assert.equal((await f.invite(baseId)).json().code, 'cooldown');
  // 7 days after its expiry, invitable again.
  await f.db.query('UPDATE room_invitations SET expires_at=expires_at-$1 WHERE id=$2', [
    DIRECTORY_LIMITS.inviteTtlMs + DIRECTORY_LIMITS.cooldownMs + 1000,
    second,
  ]);
  assert.equal((await f.invite(baseId)).statusCode, 201);
});

test("the messages summary counts each agent's open invitations, for its owner only", async (t) => {
  const f = await fixture(t);
  const guest = await f.account('Summary');
  const baseId = await f.baseAgent(guest);
  const summary = async (cookie: string) => {
    const res = await f.send('GET', '/api/messages/summary', cookie);
    assert.equal(res.statusCode, 200, res.body);
    return res.json() as { invitations: Record<string, number> };
  };
  assert.deepEqual((await summary(guest.cookie)).invitations, {});
  const id = (await f.invite(baseId)).json().id as string;
  assert.deepEqual((await summary(guest.cookie)).invitations, { [guest.agentId]: 1 });
  // Never the host's or anyone else's business.
  assert.deepEqual((await summary(f.host.cookie)).invitations, {});
  await f.decide(guest, id, 'decline');
  assert.deepEqual((await summary(guest.cookie)).invitations, {});
});

test('accept: an invitation that expires while the accept waits for its locks is refused', async (t) => {
  // The clock moves on at the accept's pause point, before it takes the owner and invitation
  // locks: the expiry is compared with the time read after them, not the transaction's start.
  let offset = 0;
  let armed = false;
  const f = await fixture(t, {
    now: () => Date.now() + offset,
    pause: async (point) => {
      if (!armed || point !== 'accept:recheck') return;
      armed = false;
      offset = 120_000;
    },
  });
  const guest = await f.account('Late');
  const id = (await f.invite(await f.baseAgent(guest))).json().id as string;
  await f.db.query('UPDATE room_invitations SET expires_at=$2 WHERE id=$1', [
    id,
    Date.now() + 60_000,
  ]);
  armed = true;
  const late = await f.decide(guest, id, 'accept');
  assert.equal(late.statusCode, 409, late.body);
  assert.equal(late.json().code, 'invitation_closed');
  const member = await f.db.query(
    'SELECT 1 FROM room_members WHERE room_id=$1 AND agent_id=$2 AND removed_at IS NULL',
    [f.roomId, guest.agentId],
  );
  assert.equal(member.rows.length, 0);
  assert.equal((await f.received(guest))[0]!.state, 'expired');
  // In time, the answer is stamped with the accept's own time.
  const other = await f.account('On time');
  const onTime = (await f.invite(await f.baseAgent(other))).json().id as string;
  const before = Date.now() + offset;
  const accepted = await f.decide(other, onTime, 'accept');
  assert.equal(accepted.statusCode, 200, accepted.body);
  const answered = await f.db.query<{ answered_at: string }>(
    'SELECT answered_at FROM room_invitations WHERE id=$1',
    [onTime],
  );
  assert.ok(Number(answered.rows[0]!.answered_at) >= before);
});

test("the owner's inbox: open invitations to all its agents, newest first, answered by id", async (t) => {
  const f = await fixture(t);
  const owner = await f.account('Inbox owner');
  const firstBase = await f.baseAgent(owner);
  // A second agent of the same owner, also with a passport.
  const created = await f.send('POST', '/api/agents', owner.cookie, {
    name: 'Inbox second',
    capability: 'research',
    mode: 'hosted',
  });
  assert.equal(created.statusCode, 201, created.body);
  const second = { ...owner, agentId: created.json().agent.id as string, name: 'Inbox second' };
  const secondBase = await f.baseAgent(second);
  const a = (await f.invite(firstBase, { note: 'First' })).json().id as string;
  const b = (await f.invite(secondBase, { note: 'Second' })).json().id as string;
  // Someone else's invitation never shows.
  const stranger = await f.account('Stranger');
  const c = (await f.invite(await f.baseAgent(stranger))).json().id as string;

  const inbox = async (cookie: string) => {
    const res = await f.send('GET', INVITE_PATHS.inbox, cookie);
    assert.equal(res.statusCode, 200, res.body);
    return res.json().invitations as Array<{
      id: string;
      note: string;
      state: string;
      roomId: string | null;
      agent: { id: string; name: string };
    }>;
  };
  const items = await inbox(owner.cookie);
  assert.deepEqual(
    items.map((item) => [item.id, item.agent.id, item.agent.name, item.note, item.state]),
    [
      [b, second.agentId, 'Inbox second', 'Second', 'open'],
      [a, owner.agentId, owner.name, 'First', 'open'],
    ],
  );
  assert.equal(JSON.stringify(items).includes(c), false);
  assert.deepEqual(await inbox(f.host.cookie), []);

  const decideById = (cookie: string, id: string, decision: string) =>
    f.send('POST', INVITE_PATHS.inboxDecide.replace(':id', id), cookie, { decision });
  // Another account: the same 404 as an unknown id.
  const foreign = await decideById(stranger.cookie, a, 'accept');
  assert.equal(foreign.statusCode, 404);
  assert.equal(foreign.json().code, 'invitation_not_found');
  assert.equal(
    (await decideById(owner.cookie, randomUUID(), 'accept')).json().code,
    'invitation_not_found',
  );
  // Accept one, decline the other: the inbox empties; the accepted agent is in the room.
  const accepted = await decideById(owner.cookie, a, 'accept');
  assert.equal(accepted.statusCode, 200, accepted.body);
  assert.equal(accepted.json().roomId, f.roomId);
  assert.equal((await decideById(owner.cookie, b, 'decline')).json().state, 'declined');
  assert.deepEqual(await inbox(owner.cookie), []);
  const member = await f.db.query(
    'SELECT agent_id FROM room_members WHERE room_id=$1 AND owner_id=$2 AND removed_at IS NULL',
    [f.roomId, owner.operatorId],
  );
  assert.deepEqual(
    member.rows.map((row) => row.agent_id),
    [owner.agentId],
  );
  assert.equal((await decideById(owner.cookie, b, 'maybe')).statusCode, 400);
});
