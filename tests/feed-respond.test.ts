import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import { INVITE_PATHS, type OwnerInboxItem } from '../shared/directory.js';
import {
  FEED_PATHS,
  FEED_RESPOND_LIMITS,
  FEED_RESPOND_PATHS,
  type FeedRequestInvitation,
  type FeedResponseSent,
} from '../shared/feed.js';
import { createFeedRequests } from '../server/feed/requests.js';
import { FEED_OPS_PATHS } from '../server/feed/review.js';
import { fixture, type Account } from './room-invitations-fixture.js';

/*
 * Feed Respond (server/feed/respond.ts, migration 108): a response to a signed-in request is a
 * room invitation to its poster, answered in the owner invitations inbox. The whole app on PGlite
 * with CITY_FEED on (unless a test turns it off). Synthetic data only.
 */

function withFeed(t: { after: (fn: () => unknown) => void }, value: string | undefined) {
  const before = process.env.CITY_FEED;
  if (value === undefined) delete process.env.CITY_FEED;
  else process.env.CITY_FEED = value;
  t.after(() => {
    if (before === undefined) delete process.env.CITY_FEED;
    else process.env.CITY_FEED = before;
  });
}

async function setup(
  t: { after: (fn: () => Promise<unknown>) => void },
  options: Parameters<typeof fixture>[1] = {},
) {
  const f = await fixture(t, options);
  const poster = await f.account('Request poster');
  const responder = await f.account('Request responder');
  const roomOf = async (who: Account, name = 'Responder room') => {
    const res = await f.send('POST', '/api/rooms', who.cookie, {
      name,
      agent_id: who.agentId,
      idempotency_key: randomUUID(),
    });
    assert.equal(res.statusCode, 201, res.body);
    return res.json().room.id as string;
  };
  const room = await roomOf(responder);
  let n = 0;
  /** A signed-in request by `who`, posted as its agent unless `agentId` is null. */
  const post = async (who: Account = poster, agentId: string | null = who.agentId) => {
    const res = await f.send('POST', FEED_PATHS.requests, who.cookie, {
      title: `Translate a short manual ${++n}`,
      description: 'Synthetic request for a test.',
      idempotencyKey: randomUUID(),
      ...(agentId ? { agentId } : {}),
    });
    assert.equal(res.statusCode, 201, res.body);
    return res.json().request.id as string;
  };
  const respond = (
    requestId: string,
    extra: Record<string, unknown> = {},
    who: Account = responder,
  ) =>
    f.send('POST', FEED_RESPOND_PATHS.respond.replace(':id', requestId), who.cookie, {
      roomId: room,
      fromAgentId: who.agentId,
      note: 'We can do this in two days.',
      idempotencyKey: randomUUID(),
      ...extra,
    });
  const inbox = async (who: Account = poster) => {
    const res = await f.send('GET', INVITE_PATHS.inbox, who.cookie);
    assert.equal(res.statusCode, 200, res.body);
    return res.json().invitations as OwnerInboxItem[];
  };
  const feedItems = async (who: Account = poster) =>
    (await inbox(who)).filter(
      (item): item is FeedRequestInvitation => item.kind === 'feed_request',
    );
  const decide = (id: string, body: Record<string, unknown>, who: Account = poster) =>
    f.send('POST', INVITE_PATHS.inboxDecide.replace(':id', id), who.cookie, body);
  const mine = async (requestId: string, who: Account = responder) => {
    const res = await f.send('GET', FEED_RESPOND_PATHS.mine.replace(':id', requestId), who.cookie);
    assert.equal(res.statusCode, 200, res.body);
    return res.json().responses as FeedResponseSent[];
  };
  const count = (requestId: string, who: Account = poster) =>
    f.send('GET', FEED_RESPOND_PATHS.count.replace(':id', requestId), who.cookie);
  const withdraw = (id: string, who: Account = responder) =>
    f.send('POST', FEED_RESPOND_PATHS.withdraw.replace(':id', id), who.cookie, {});
  const members = async (roomId = room) =>
    (
      await f.db.query<{ agent_id: string }>(
        `SELECT agent_id FROM room_members WHERE room_id=$1 AND removed_at IS NULL
          AND kind='agent' ORDER BY joined_at`,
        [roomId],
      )
    ).rows.map((row) => row.agent_id);
  const stateOf = async (id: string) =>
    (
      await f.db.query<{ state: string }>(
        'SELECT state FROM feed_request_invitations WHERE id=$1',
        [id],
      )
    ).rows[0]?.state;
  return {
    ...f,
    poster,
    responder,
    room,
    roomOf,
    post,
    respond,
    inbox,
    feedItems,
    decide,
    mine,
    count,
    withdraw,
    members,
    stateOf,
  };
}

test('flag off: every Respond route answers 404 and the inbox leaves responses out', async (t) => {
  withFeed(t, '1');
  const s = await setup(t);
  const requestId = await s.post();
  const sent = await s.respond(requestId);
  assert.equal(sent.statusCode, 201, sent.body);
  const id = sent.json().id as string;

  process.env.CITY_FEED = '0';
  for (const res of [
    await s.respond(requestId),
    await s.count(requestId),
    await s.send('GET', FEED_RESPOND_PATHS.mine.replace(':id', requestId), s.responder.cookie),
    await s.withdraw(id),
  ]) {
    assert.equal(res.statusCode, 404, res.body);
    assert.equal(res.json().code, 'not_found');
  }
  assert.deepEqual(await s.inbox(), []);
  const decided = await s.decide(id, { decision: 'accept' });
  assert.equal(decided.statusCode, 404);
  assert.equal(decided.json().code, 'invitation_not_found');
  // Nor can the poster block by it (nothing is declined).
  const block = await s.send(
    'POST',
    INVITE_PATHS.block.replace(':agentId', s.poster.agentId),
    s.poster.cookie,
    { invitationId: id },
  );
  assert.equal(block.statusCode, 404, block.body);
  assert.equal(block.json().code, 'invitation_not_found');
  assert.equal(await s.stateOf(id), 'open');

  process.env.CITY_FEED = '1';
  assert.deepEqual(
    (await s.feedItems()).map((item) => item.id),
    [id],
  );
});

test('send, inbox and accept: the request agent joins; neither side sees the other account', async (t) => {
  withFeed(t, '1');
  const s = await setup(t);
  const requestId = await s.post();
  const key = randomUUID();
  const sent = await s.respond(requestId, { idempotencyKey: key });
  assert.equal(sent.statusCode, 201, sent.body);
  const response = sent.json() as FeedResponseSent;
  assert.equal(response.state, 'open');
  assert.equal(response.roomId, s.room);
  assert.match(response.id, /^fri_[a-z2-7]{20}$/);
  // The same key answers the same response (200), nothing new.
  const again = await s.respond(requestId, { idempotencyKey: key });
  assert.equal(again.statusCode, 200, again.body);
  assert.equal(again.json().id, response.id);
  // The same key with other content: 409.
  const other = await s.respond(requestId, { idempotencyKey: key, note: 'Different note.' });
  assert.equal(other.statusCode, 409);
  assert.equal(other.json().code, 'idempotency_conflict');

  const items = await s.feedItems();
  assert.equal(items.length, 1);
  const item = items[0]!;
  assert.deepEqual(item, {
    kind: 'feed_request',
    id: response.id,
    request: { id: requestId, title: 'Translate a short manual 1' },
    room: { name: 'Responder room', members: 2 },
    from: { name: s.responder.name },
    note: 'We can do this in two days.',
    state: 'open',
    createdAt: item.createdAt,
    expiresAt: item.expiresAt,
    roomId: null,
    agent: { id: s.poster.agentId, name: s.poster.name },
  });
  // Privacy: the poster's inbox carries none of the responder's ids or account name.
  const inboxText = JSON.stringify(await s.inbox());
  for (const secret of [s.responder.operatorId, s.responder.agentId, s.room])
    assert.equal(inboxText.includes(secret), false, secret);
  // The account's sign-in name never (its agent's name, "<account> agent", is the inviter).
  assert.doesNotMatch(inboxText, /Request responder(?! agent)/);
  // ...and the responder's view none of the poster's.
  const mineText = JSON.stringify(await s.mine(requestId));
  for (const secret of [s.poster.operatorId, s.poster.agentId, 'Request poster'])
    assert.equal(mineText.includes(secret), false, secret);

  // The count: the poster only.
  assert.deepEqual((await s.count(requestId)).json(), { open: 1, accepted: 0 });
  const foreign = await s.count(requestId, s.responder);
  assert.equal(foreign.statusCode, 404);
  assert.equal(foreign.json().code, 'request_not_found');
  // It is never in the public answers.
  const page = await s.app.inject({
    url: FEED_PATHS.request.replace(':id', requestId),
    headers: { host: 'centralcity.ai', origin: 'https://centralcity.ai' },
  });
  assert.equal(page.statusCode, 200);
  assert.doesNotMatch(page.body, /respons/i);

  // Only the poster can answer it.
  assert.equal((await s.decide(response.id, { decision: 'accept' }, s.responder)).statusCode, 404);
  const accepted = await s.decide(response.id, { decision: 'accept' });
  assert.equal(accepted.statusCode, 200, accepted.body);
  assert.equal(accepted.json().state, 'accepted');
  assert.equal(accepted.json().roomId, s.room);
  assert.deepEqual(accepted.json().agent, { id: s.poster.agentId, name: s.poster.name });
  assert.deepEqual(await s.members(), [s.responder.agentId, s.poster.agentId]);
  const lines = await s.send('GET', `/api/rooms/${s.room}/messages`, s.responder.cookie);
  assert.match(lines.body, new RegExp(`${s.poster.name} joined\\.`));
  // Accepting again answers the same.
  assert.equal((await s.decide(response.id, { decision: 'accept' })).json().state, 'accepted');
  assert.deepEqual(await s.feedItems(), []);
  assert.equal((await s.mine(requestId))[0]!.state, 'joined');
  assert.deepEqual((await s.count(requestId)).json(), { open: 0, accepted: 1 });
});

test('accept joins the chosen agent; no default and no choice answers agent_required', async (t) => {
  withFeed(t, '1');
  const s = await setup(t);
  const created = await s.send('POST', '/api/agents', s.poster.cookie, {
    name: 'Poster second',
    capability: 'research',
    mode: 'hosted',
  });
  assert.equal(created.statusCode, 201, created.body);
  const second = created.json().agent.id as string;

  const withAgent = await s.post();
  const a = (await s.respond(withAgent)).json().id as string;
  // Someone else's agent: 404.
  const foreign = await s.decide(a, { decision: 'accept', agentId: s.responder.agentId });
  assert.equal(foreign.statusCode, 404);
  assert.equal(foreign.json().code, 'agent_not_found');
  const chosen = await s.decide(a, { decision: 'accept', agentId: second });
  assert.equal(chosen.statusCode, 200, chosen.body);
  assert.deepEqual(chosen.json().agent, { id: second, name: 'Poster second' });
  assert.deepEqual(await s.members(), [s.responder.agentId, second]);

  // Posted as the account (no agent): the item names no agent and Accept needs one.
  const asAccount = await s.post(s.poster, null);
  const room2 = await s.roomOf(s.responder, 'Second room');
  const b = (await s.respond(asAccount, { roomId: room2 })).json().id as string;
  assert.equal((await s.feedItems()).find((item) => item.id === b)!.agent, null);
  const missing = await s.decide(b, { decision: 'accept' });
  assert.equal(missing.statusCode, 400);
  assert.equal(missing.json().code, 'agent_required');
  assert.equal(
    (await s.decide(b, { decision: 'accept', agentId: s.poster.agentId })).statusCode,
    200,
  );
  assert.deepEqual(await s.members(room2), [s.responder.agentId, s.poster.agentId]);
});

test('who may respond and to what: 401, 403, own 409, anonymous/held/hidden/closed/unknown 404', async (t) => {
  withFeed(t, '1');
  const s = await setup(t);
  const requestId = await s.post();
  const path = FEED_RESPOND_PATHS.respond.replace(':id', requestId);
  const body = JSON.stringify({
    roomId: s.room,
    fromAgentId: s.responder.agentId,
    note: '',
    idempotencyKey: randomUUID(),
  });
  // Signed out: 401. The session without the console's header: 403 (a cross-site form).
  const signedOut = await s.app.inject({
    method: 'POST',
    url: path,
    headers: {
      'content-type': 'application/json',
      'x-city-request': '1',
      host: 'centralcity.ai',
      origin: 'https://centralcity.ai',
    },
    payload: body,
  });
  assert.equal(signedOut.statusCode, 401, signedOut.body);
  const noHeader = await s.app.inject({
    method: 'POST',
    url: path,
    headers: {
      'content-type': 'application/json',
      host: 'centralcity.ai',
      origin: 'https://centralcity.ai',
      cookie: s.responder.cookie,
    },
    payload: body,
  });
  assert.equal(noHeader.statusCode, 403, noHeader.body);

  // Own request: 409 (from the poster's own room).
  const posterRoom = await s.roomOf(s.poster, 'Poster room');
  const own = await s.respond(requestId, { roomId: posterRoom }, s.poster);
  assert.equal(own.statusCode, 409);
  assert.equal(own.json().code, 'own_request');

  // Another host's room: 404; a member that is not the host: 403.
  const stranger = await s.account('Stranger');
  const strangerRoom = await s.roomOf(stranger, 'Stranger room');
  const notMine = await s.respond(requestId, { roomId: strangerRoom });
  assert.equal(notMine.statusCode, 404, notMine.body);
  // An agent not in the room: 400.
  const created = await s.send('POST', '/api/agents', s.responder.cookie, {
    name: 'Outside agent',
    capability: 'research',
    mode: 'hosted',
  });
  const outside = await s.respond(requestId, { fromAgentId: created.json().agent.id });
  assert.equal(outside.statusCode, 400);

  const notFound = async (id: string) => {
    const res = await s.respond(id);
    assert.equal(res.statusCode, 404, `${id}: ${res.body}`);
    assert.equal(res.json().code, 'request_not_found');
  };
  // Anonymous (no owner).
  const anonymous = await s.app.inject({
    method: 'POST',
    url: FEED_PATHS.requests,
    headers: {
      'content-type': 'application/json',
      host: 'centralcity.ai',
      origin: 'https://centralcity.ai',
    },
    payload: JSON.stringify({
      title: 'An anonymous request here',
      description: 'Synthetic.',
      idempotencyKey: randomUUID(),
    }),
  });
  assert.equal(anonymous.statusCode, 201, anonymous.body);
  await notFound(anonymous.json().request.id);
  // Unknown and malformed ids.
  await notFound('req_aaaaaaaaaaaaaaaaaaaa');
  await notFound('nope');
  // Held, hidden, closed, expired.
  for (const change of [
    "state='held'",
    'hidden_at=1',
    "state='closed', closed_at=1",
    'expires_at=1',
  ]) {
    const id = await s.post();
    await s.db.query(`UPDATE feed_requests SET ${change} WHERE id=$1`, [id]);
    await notFound(id);
  }
});

test('the note follows the request text rules: contact details, links and length refused', async (t) => {
  withFeed(t, '1');
  const s = await setup(t);
  const requestId = await s.post();
  const email = await s.respond(requestId, { note: 'Write to me at someone@example.com please.' });
  assert.equal(email.statusCode, 400);
  assert.equal(email.json().code, 'invalid_request');
  assert.match(email.json().error, /email addresses and phone numbers/);
  const short = await s.respond(requestId, { note: 'See https://bit.ly/abc for details.' });
  assert.equal(short.statusCode, 400);
  const long = await s.respond(requestId, { note: 'a '.repeat(FEED_RESPOND_LIMITS.noteMax) });
  assert.equal(long.statusCode, 400);
  assert.match(long.json().error, /at most 1000 characters/);
  // A refused note created nothing.
  assert.deepEqual(await s.feedItems(), []);
  // Neither roomId nor newRoom, or both: 400.
  assert.equal((await s.respond(requestId, { roomId: undefined })).statusCode, 400);
  assert.equal((await s.respond(requestId, { newRoom: true })).statusCode, 400);
});

test('newRoom: one room named after the request, the same room on a retry with the same key', async (t) => {
  withFeed(t, '1');
  const s = await setup(t);
  const requestId = await s.post();
  const key = randomUUID();
  const first = await s.respond(requestId, {
    roomId: undefined,
    newRoom: true,
    idempotencyKey: key,
  });
  assert.equal(first.statusCode, 201, first.body);
  const roomId = first.json().roomId as string;
  assert.notEqual(roomId, s.room);
  const again = await s.respond(requestId, {
    roomId: undefined,
    newRoom: true,
    idempotencyKey: key,
  });
  assert.equal(again.statusCode, 200, again.body);
  assert.equal(again.json().roomId, roomId);
  assert.equal(again.json().id, first.json().id);
  const rooms = await s.db.query<{ id: string; name: string; host_agent_id: string }>(
    'SELECT id, name, host_agent_id FROM rooms WHERE host_owner_id=$1 AND name=$2',
    [s.responder.operatorId, 'Translate a short manual 1'],
  );
  assert.deepEqual(rooms.rows, [
    { id: roomId, name: 'Translate a short manual 1', host_agent_id: s.responder.agentId },
  ]);
  assert.equal((await s.feedItems())[0]!.room.name, 'Translate a short manual 1');

  // A first attempt that made the room but was refused after it: the retry reuses the room.
  const second = await s.post();
  const key2 = randomUUID();
  await s.db.exec(
    // A sequence is not rolled back with the failed transaction: only the first insert fails.
    `CREATE SEQUENCE refuse_once_seq;
     CREATE OR REPLACE FUNCTION refuse_once() RETURNS trigger AS $$
     BEGIN IF nextval('refuse_once_seq') = 1 THEN RAISE EXCEPTION 'synthetic failure'; END IF;
       RETURN NEW; END $$ LANGUAGE plpgsql`,
  );
  await s.db.query(
    `CREATE TRIGGER refuse_once BEFORE INSERT ON feed_request_invitations
       FOR EACH ROW EXECUTE FUNCTION refuse_once()`,
  );
  const failed = await s.respond(second, {
    roomId: undefined,
    newRoom: true,
    idempotencyKey: key2,
  });
  assert.equal(failed.statusCode, 500, failed.body);
  const retried = await s.respond(second, {
    roomId: undefined,
    newRoom: true,
    idempotencyKey: key2,
  });
  assert.equal(retried.statusCode, 201, retried.body);
  const named = await s.db.query('SELECT id FROM rooms WHERE host_owner_id=$1 AND name=$2', [
    s.responder.operatorId,
    'Translate a short manual 2',
  ]);
  assert.deepEqual(
    named.rows.map((row) => row.id),
    [retried.json().roomId],
  );
});

test('one open response per request and room: "Already sent"; concurrent sends keep one', async (t) => {
  withFeed(t, '1');
  const s = await setup(t);
  const requestId = await s.post();
  const results = await Promise.all([
    s.respond(requestId),
    s.respond(requestId),
    s.respond(requestId),
  ]);
  assert.deepEqual(results.map((res) => res.statusCode).sort(), [201, 409, 409]);
  for (const res of results.filter((r) => r.statusCode === 409))
    assert.equal(res.json().code, 'response_open');
  assert.equal((await s.feedItems()).length, 1);
  // Another room of the same responder may respond too.
  const room2 = await s.roomOf(s.responder, 'Another room');
  assert.equal((await s.respond(requestId, { roomId: room2 })).statusCode, 201);
  assert.equal((await s.feedItems()).length, 2);
});

test('decline is invisible to the responder; withdraw removes the card from the inbox', async (t) => {
  withFeed(t, '1');
  const s = await setup(t);
  const requestId = await s.post();
  const a = (await s.respond(requestId)).json().id as string;
  const declined = await s.decide(a, { decision: 'decline' });
  assert.equal(declined.statusCode, 200, declined.body);
  assert.equal(declined.json().state, 'declined');
  assert.deepEqual(await s.feedItems(), []);
  // The responder still reads it open (as for silence), and cannot send again from that room.
  const view = (await s.mine(requestId))[0]!;
  assert.equal(view.state, 'open');
  assert.equal(view.answeredAt, null);
  assert.equal((await s.respond(requestId)).json().code, 'response_open');
  assert.deepEqual((await s.count(requestId)).json(), { open: 0, accepted: 0 });
  // Once it would have expired it reads not_joined, dated at its expiry.
  await s.db.query('UPDATE feed_request_invitations SET expires_at=$2 WHERE id=$1', [a, 1000]);
  const later = (await s.mine(requestId))[0]!;
  assert.deepEqual([later.state, later.answeredAt], ['not_joined', 1000]);

  const room2 = await s.roomOf(s.responder, 'Room two');
  const b = (await s.respond(requestId, { roomId: room2 })).json().id as string;
  assert.equal((await s.feedItems()).length, 1);
  // Only the responder may withdraw.
  assert.equal((await s.withdraw(b, s.poster)).statusCode, 404);
  const withdrawn = await s.withdraw(b);
  assert.equal(withdrawn.statusCode, 200, withdrawn.body);
  assert.equal(withdrawn.json().state, 'withdrawn');
  assert.equal((await s.withdraw(b)).json().state, 'withdrawn');
  assert.deepEqual(await s.feedItems(), []);
  const late = await s.decide(b, { decision: 'accept' });
  assert.equal(late.statusCode, 409);
  assert.equal(late.json().code, 'invitation_closed');
});

test('blocks reuse the invitation blocks: a blocked responder reads "sent", nothing arrives', async (t) => {
  withFeed(t, '1');
  const s = await setup(t);
  const requestId = await s.post();
  const a = (await s.respond(requestId)).json().id as string;
  const blockPath = INVITE_PATHS.block.replace(':agentId', s.poster.agentId);
  // Only the poster can name the responder by this response.
  const foreign = await s.send(
    'POST',
    INVITE_PATHS.block.replace(':agentId', s.responder.agentId),
    s.responder.cookie,
    { invitationId: a },
  );
  assert.equal(foreign.statusCode, 404);
  const blocked = await s.send('POST', blockPath, s.poster.cookie, { invitationId: a });
  assert.equal(blocked.statusCode, 200, blocked.body);
  assert.deepEqual(blocked.json(), { blocked: true, declined: 1 });
  assert.equal(await s.stateOf(a), 'declined');
  assert.deepEqual(await s.feedItems(), []);
  // Listed by its response, never by the responder's account.
  const list = await s.send('GET', blockPath, s.poster.cookie);
  assert.deepEqual(
    list
      .json()
      .blocks.map((b: { invitationId: string; from: { name: string } }) => [
        b.invitationId,
        b.from.name,
      ]),
    [[a, s.responder.name]],
  );
  assert.equal(list.body.includes(s.responder.operatorId), false);

  // A new response reads as sent and never reaches the poster.
  const room2 = await s.roomOf(s.responder, 'Room two');
  const again = await s.respond(requestId, { roomId: room2 });
  assert.equal(again.statusCode, 201, again.body);
  assert.equal(again.json().state, 'open');
  assert.deepEqual(await s.feedItems(), []);
  assert.deepEqual((await s.count(requestId)).json(), { open: 0, accepted: 0 });

  // Unblocked: responses arrive again.
  const lifted = await s.send('DELETE', blockPath, s.poster.cookie, { invitationId: a });
  assert.equal(lifted.statusCode, 200, lifted.body);
  const room3 = await s.roomOf(s.responder, 'Room three');
  assert.equal((await s.respond(requestId, { roomId: room3 })).statusCode, 201);
  assert.equal((await s.feedItems()).length, 1);
});

test('limits: 20 per responder hour and 50 open per request answer 429 with Retry-After', async (t) => {
  withFeed(t, '1');
  const s = await setup(t);
  const requestId = await s.post();
  // 60 synthetic rooms of the responder (copies of its room).
  await s.db.query(
    `INSERT INTO rooms SELECT (jsonb_populate_record(r, jsonb_build_object('id', 'syn-' || g,
        'slug', 'syn-' || g, 'idempotency_key', 'syn-' || g))).*
      FROM rooms r, generate_series(1, 60) g WHERE r.id = $1`,
    [s.room],
  );
  const insert = (opts: {
    room: string;
    request: string;
    by: Account;
    state: string;
    at: number;
  }) =>
    s.db.query(
      `INSERT INTO feed_request_invitations (id, request_id, room_id, inviting_agent_id,
         inviting_operator_id, from_name, room_name, note, poster_owner_id, state, idempotency_key,
         request_hash, created_at, expires_at)
       VALUES ($1,$2,$3,$4,$5,'Synthetic','Synthetic','',$6,$7,$8,'h',$9,$10)`,
      [
        // Like the server's ids (server/feed/respond.ts): 20 random base32 characters. A UUID with
        // its digits turned into 'a' was mostly 'a' and collided now and then in CI.
        `fri_${Array.from(randomBytes(20), (byte) => 'abcdefghijklmnopqrstuvwxyz234567'[byte & 31]).join('')}`,
        opts.request,
        opts.room,
        opts.by.agentId,
        opts.by.operatorId,
        s.poster.operatorId,
        opts.state,
        randomUUID(),
        opts.at,
        opts.at + FEED_RESPOND_LIMITS.ttlMs,
      ],
    );
  const now = Date.now();
  for (let i = 1; i <= FEED_RESPOND_LIMITS.perAccountHour; i++)
    await insert({
      room: `syn-${i}`,
      request: requestId,
      by: s.responder,
      state: 'withdrawn',
      at: now - 60_000,
    });
  const hourly = await s.respond(requestId);
  assert.equal(hourly.statusCode, 429, hourly.body);
  assert.deepEqual(Object.keys(hourly.json()), ['error']);
  const retry = Number(hourly.headers['retry-after']);
  assert.ok(retry > 3000 && retry <= 3600, String(retry));

  // Another responder: the request's 50 open responses fill it.
  const other = await s.account('Other responder');
  const otherRoom = await s.roomOf(other, 'Other room');
  await s.db.query("UPDATE feed_request_invitations SET created_at=1 WHERE state='withdrawn'");
  for (let i = 1; i <= FEED_RESPOND_LIMITS.openPerRequest; i++)
    await insert({
      room: `syn-${i + 10}`,
      request: requestId,
      by: s.responder,
      state: 'open',
      at: 1_000,
    });
  await s.db.query('UPDATE feed_request_invitations SET expires_at=$1 WHERE state=$2', [
    now + 3_600_000,
    'open',
  ]);
  const full = await s.respond(requestId, { roomId: otherRoom }, other);
  assert.equal(full.statusCode, 429, full.body);
  assert.deepEqual(Object.keys(full.json()), ['error']);
  assert.ok(Number(full.headers['retry-after']) > 0);
});

test('closing or expiring the request expires its open responses', async (t) => {
  withFeed(t, '1');
  const s = await setup(t);
  const closing = await s.post();
  const a = (await s.respond(closing)).json().id as string;
  const closed = await s.send(
    'POST',
    FEED_PATHS.close.replace(':id', closing),
    s.poster.cookie,
    {},
  );
  assert.equal(closed.statusCode, 200, closed.body);
  // In the close's own transaction, before any read.
  assert.equal(await s.stateOf(a), 'expired');
  assert.deepEqual(await s.feedItems(), []);
  assert.equal((await s.mine(closing))[0]!.state, 'not_joined');
  assert.equal((await s.decide(a, { decision: 'accept' })).json().code, 'invitation_closed');

  // The upkeep's expiry, in the same statement.
  const expiring = await s.post();
  const b = (await s.respond(expiring)).json().id as string;
  // Ended a minute ago (the upkeep deletes requests 30 days after they end).
  const ended = Date.now() - 60_000;
  await s.db.query('UPDATE feed_requests SET expires_at=$2 WHERE id=$1', [expiring, ended]);
  await createFeedRequests({
    db: s.db,
    secret: () => 'synthetic-secret-for-the-feed-respond-test',
    limit: async () => {},
  }).sweep();
  const row = await s.db.query<{ state: string; answered_at: string }>(
    'SELECT state, answered_at FROM feed_request_invitations WHERE id=$1',
    [b],
  );
  assert.deepEqual([row.rows[0]!.state, Number(row.rows[0]!.answered_at)], ['expired', ended]);

  // Lazily, before the upkeep ran: an expired request's response leaves the inbox.
  const lazy = await s.post();
  const room2 = await s.roomOf(s.responder, 'Room two');
  const c = (await s.respond(lazy, { roomId: room2 })).json().id as string;
  await s.db.query('UPDATE feed_requests SET expires_at=$2 WHERE id=$1', [lazy, 6_000]);
  assert.deepEqual(await s.feedItems(), []);
  assert.equal(await s.stateOf(c), 'expired');
  // A response expires with its request at the latest.
  const capped = await s.post();
  const d = (await s.respond(capped)).json() as FeedResponseSent;
  const request = await s.db.query<{ expires_at: string }>(
    'SELECT expires_at FROM feed_requests WHERE id=$1',
    [capped],
  );
  assert.ok(d.expiresAt <= Number(request.rows[0]!.expires_at));
  assert.ok(d.expiresAt <= d.createdAt + FEED_RESPOND_LIMITS.ttlMs);
});

test('accept rechecks: a closed room refuses it and expires the response', async (t) => {
  withFeed(t, '1');
  const s = await setup(t);
  const requestId = await s.post();
  const a = (await s.respond(requestId)).json().id as string;
  await s.db.query('UPDATE rooms SET closed_at=1 WHERE id=$1', [s.room]);
  const refused = await s.decide(a, { decision: 'accept' });
  assert.equal(refused.statusCode, 409, refused.body);
  assert.equal(await s.stateOf(a), 'expired');
  assert.deepEqual(await s.members(), [s.responder.agentId]);
});

test('race: accept against close ends consistently (joined and accepted, or neither)', async (t) => {
  withFeed(t, '1');
  const s = await setup(t);
  for (let round = 0; round < 3; round++) {
    const requestId = await s.post();
    const room = await s.roomOf(s.responder, `Race room ${round}`);
    const id = (await s.respond(requestId, { roomId: room })).json().id as string;
    const [accepted, closed] = await Promise.all([
      s.decide(id, { decision: 'accept' }),
      s.send('POST', FEED_PATHS.close.replace(':id', requestId), s.poster.cookie, {}),
    ]);
    assert.equal(closed.statusCode, 200, closed.body);
    const state = await s.stateOf(id);
    const joined = (await s.members(room)).includes(s.poster.agentId);
    if (accepted.statusCode === 200) assert.deepEqual([state, joined], ['accepted', true]);
    else assert.deepEqual([accepted.statusCode, state, joined], [409, 'expired', false]);
  }
});

test('the Messages summary counts open responses for the badge, only with the Feed on', async (t) => {
  withFeed(t, '1');
  const s = await setup(t);
  const requestId = await s.post();
  await s.respond(requestId);
  const summary = await s.send('GET', '/api/messages/summary', s.poster.cookie);
  assert.equal(summary.statusCode, 200, summary.body);
  assert.equal(summary.json().requestResponses, 1);
  assert.equal(
    (await s.send('GET', '/api/messages/summary', s.responder.cookie)).json().requestResponses,
    0,
  );
  process.env.CITY_FEED = '0';
  assert.equal(
    (await s.send('GET', '/api/messages/summary', s.poster.cookie)).json().requestResponses,
    undefined,
  );
});

test('a declined response reads as an ignored one once its request or room ends', async (t) => {
  withFeed(t, '1');
  const s = await setup(t);
  const roomB = await s.roomOf(s.responder, 'Room B');
  const views = async (requestId: string) =>
    (await s.mine(requestId)).map((view) => [view.state, view.answeredAt, view.expiresAt]);

  // Closed by its poster: the declined one and the ignored one read not_joined, from the close.
  const closing = await s.post();
  const a = (await s.respond(closing)).json().id as string;
  assert.equal((await s.respond(closing, { roomId: roomB })).statusCode, 201);
  assert.equal((await s.decide(a, { decision: 'decline' })).statusCode, 200);
  const closed = await s.send(
    'POST',
    FEED_PATHS.close.replace(':id', closing),
    s.poster.cookie,
    {},
  );
  assert.equal(closed.statusCode, 200, closed.body);
  const [first, second] = await views(closing);
  assert.equal(first![0], 'not_joined');
  assert.deepEqual(first, second);
  assert.equal(first![1], first![2]);

  // Its room closed: a declined response and an ignored one from that room read the same.
  const roomC = await s.roomOf(s.responder, 'Room C');
  const r1 = await s.post();
  const r2 = await s.post();
  const c1 = (await s.respond(r1, { roomId: roomC })).json().id as string;
  assert.equal((await s.respond(r2, { roomId: roomC })).statusCode, 201);
  assert.equal((await s.decide(c1, { decision: 'decline' })).statusCode, 200);
  const closedAt = Date.now() - 1_000;
  await s.db.query('UPDATE rooms SET closed_at=$2 WHERE id=$1', [roomC, closedAt]);
  assert.deepEqual(await views(r1), [['not_joined', closedAt, closedAt]]);
  assert.deepEqual(await views(r2), [['not_joined', closedAt, closedAt]]);

  // Removed in review: both end in the removal's own transaction, before any read.
  const removing = await s.post();
  const d1 = (await s.respond(removing)).json().id as string;
  const d2 = (await s.respond(removing, { roomId: roomB })).json().id as string;
  assert.equal((await s.decide(d1, { decision: 'decline' })).statusCode, 200);
  const secret = 'synthetic-ops-secret-for-the-feed-respond-test-0123456789';
  const before = process.env.CITY_OPS_SECRET;
  process.env.CITY_OPS_SECRET = secret;
  t.after(async () => {
    if (before === undefined) delete process.env.CITY_OPS_SECRET;
    else process.env.CITY_OPS_SECRET = before;
  });
  const removed = await s.app.inject({
    method: 'POST',
    url: FEED_OPS_PATHS.remove.replace(':id', removing),
    headers: {
      'content-type': 'application/json',
      'x-city-request': '1',
      host: 'centralcity.ai',
      origin: 'https://centralcity.ai',
      authorization: `Bearer ${secret}`,
    },
    payload: '{}',
  });
  assert.equal(removed.statusCode, 200, removed.body);
  const rows = await s.db.query<{ id: string; state: string; expires_at: string }>(
    'SELECT id, state, expires_at FROM feed_request_invitations WHERE request_id=$1',
    [removing],
  );
  const byId = new Map(rows.rows.map((row) => [row.id, row]));
  assert.equal(byId.get(d1)!.state, 'declined');
  assert.equal(byId.get(d2)!.state, 'expired');
  assert.equal(byId.get(d1)!.expires_at, byId.get(d2)!.expires_at);
  const [x, y] = await views(removing);
  assert.equal(x![0], 'not_joined');
  assert.deepEqual(x, y);
});

test('a refused newRoom send makes no room; a long emoji title still names the room', async (t) => {
  withFeed(t, '1');
  const s = await setup(t);
  const requestId = await s.post();
  // The responder's hour is used up (withdrawn ones count too).
  const now = Date.now();
  for (let i = 0; i < FEED_RESPOND_LIMITS.perAccountHour; i++)
    await s.db.query(
      `INSERT INTO feed_request_invitations (id, request_id, room_id, inviting_agent_id,
         inviting_operator_id, from_name, room_name, note, poster_owner_id, state, idempotency_key,
         request_hash, created_at, expires_at)
       VALUES ($1,$2,$3,$4,$5,'Synthetic','Synthetic','',$6,'withdrawn',$7,'h',$8,$9)`,
      [
        `fri_${'abcdefghijklmnopqrst'.slice(i)}${'a'.repeat(i)}`,
        requestId,
        s.room,
        s.responder.agentId,
        s.responder.operatorId,
        s.poster.operatorId,
        randomUUID(),
        now - 60_000,
        now + 60_000,
      ],
    );
  // A new key per attempt: still no room for any of them.
  for (let attempt = 0; attempt < 3; attempt++) {
    const refused = await s.respond(requestId, { roomId: undefined, newRoom: true });
    assert.equal(refused.statusCode, 429, refused.body);
  }
  const rooms = await s.db.query('SELECT id FROM rooms WHERE host_owner_id=$1 AND name=$2', [
    s.responder.operatorId,
    'Translate a short manual 1',
  ]);
  assert.deepEqual(rooms.rows, []);
  await s.db.query('DELETE FROM feed_request_invitations WHERE request_id=$1', [requestId]);

  // 50 characters, 95 UTF-16 units: the room name is cut by units, never inside a pair.
  const emojis = Array.from({ length: 45 }, (_, i) => String.fromCodePoint(0x1f9ed + (i % 5)));
  const posted = await s.send('POST', FEED_PATHS.requests, s.poster.cookie, {
    title: `${emojis.join('')} maps`,
    description: 'Synthetic request for a test.',
    idempotencyKey: randomUUID(),
    agentId: s.poster.agentId,
  });
  assert.equal(posted.statusCode, 201, posted.body);
  const emoji = posted.json().request.id as string;
  const sent = await s.respond(emoji, { roomId: undefined, newRoom: true });
  assert.equal(sent.statusCode, 201, sent.body);
  const named = await s.db.query<{ name: string }>('SELECT name FROM rooms WHERE id=$1', [
    sent.json().roomId,
  ]);
  assert.equal(named.rows[0]!.name, emojis.slice(0, 40).join(''));
});

test('accept rechecks the request in its own transaction: ended meanwhile, or in review', async (t) => {
  withFeed(t, '1');
  let offset = 0;
  let onRecheck: (() => void) | null = null;
  const s = await setup(t, {
    now: () => Date.now() + offset,
    feedPause: async (point) => {
      if (point === 'accept:recheck') onRecheck?.();
    },
  });
  // The request ends between the decision's first look and the join's recheck.
  const ending = await s.post();
  const a = (await s.respond(ending)).json().id as string;
  await s.db.query('UPDATE feed_requests SET expires_at=$2 WHERE id=$1', [
    ending,
    Date.now() + 60_000,
  ]);
  onRecheck = () => {
    offset = 120_000;
  };
  const refused = await s.decide(a, { decision: 'accept' });
  onRecheck = null;
  assert.equal(refused.statusCode, 409, refused.body);
  assert.equal(refused.json().error, 'This request is closed.');
  assert.equal(await s.stateOf(a), 'expired');
  assert.deepEqual(await s.members(), [s.responder.agentId]);

  // Hidden by reports: no join while in review, and still open; listed again, it is accepted.
  offset = 0;
  const hidden = await s.post();
  const room2 = await s.roomOf(s.responder, 'Room two');
  const b = (await s.respond(hidden, { roomId: room2 })).json().id as string;
  await s.db.query('UPDATE feed_requests SET hidden_at=$2 WHERE id=$1', [hidden, Date.now()]);
  const waiting = await s.decide(b, { decision: 'accept' });
  assert.equal(waiting.statusCode, 409, waiting.body);
  assert.equal(waiting.json().code, 'request_in_review');
  assert.equal(await s.stateOf(b), 'open');
  assert.deepEqual(await s.members(room2), [s.responder.agentId]);
  await s.db.query('UPDATE feed_requests SET hidden_at=NULL WHERE id=$1', [hidden]);
  assert.equal((await s.decide(b, { decision: 'accept' })).statusCode, 200);
  assert.equal(await s.stateOf(b), 'accepted');
});

test('migration 108 indexes responses by room (rooms are purged by room_id)', async (t) => {
  withFeed(t, '1');
  const s = await setup(t);
  const index = await s.db.query<{ indexdef: string }>(
    "SELECT indexdef FROM pg_indexes WHERE indexname='feed_request_invitations_room'",
  );
  assert.match(index.rows[0]?.indexdef ?? '', /\(room_id\)$/);
});
