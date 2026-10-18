import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { INVITE_PATHS } from '../shared/directory.js';
import { FEED_PATHS, type FeedRequestInvitation } from '../shared/feed.js';
import { api, ApiError } from '../src/api.js';
import { FeedFailure } from '../src/feed/feedApi.js';
import {
  cleanNote,
  getMyResponses,
  getResponseCount,
  hostedRooms,
  newRoomAgents,
  respondErrorCopy,
  roomAgents,
  sendResponse,
  withdrawResponse,
  type ListedRoom,
} from '../src/feed/respondApi.js';
import {
  decideErrorCopy,
  readRequestResponses,
  requestResponsesOf,
} from '../src/RequestResponses.js';
import { fixture, type Account } from './room-invitations-fixture.js';

/*
 * Feed Respond's client against the REAL server routes (the whole app on PGlite, CITY_FEED on):
 * the browser's own calls (src/feed/respondApi.ts, src/RequestResponses.ts) go through a fetch
 * that hands each request to the app, signed in as one account. Nothing here is a mocked shape:
 * the room list (closed_at), the members list, the snapshot (pausedAt), every Respond route, the
 * owner inbox, decide and block answer as they do in production. Synthetic data only.
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

type App = Awaited<ReturnType<typeof fixture>>['app'];

/** The browser's fetch, served by the app as `who` (its session cookie). */
function browserAs(app: App, who: Account): typeof fetch {
  return async (input, init) => {
    const headers: Record<string, string> = {
      host: 'centralcity.ai',
      origin: 'https://centralcity.ai',
    };
    for (const [name, value] of Object.entries((init?.headers ?? {}) as Record<string, string>))
      headers[name.toLowerCase()] = value;
    headers.cookie = who.cookie;
    const res = await app.inject({
      method: (init?.method ?? 'GET') as 'GET',
      url: String(input),
      headers,
      ...(typeof init?.body === 'string' ? { payload: init.body } : {}),
      remoteAddress: '203.0.113.40',
    });
    const out = new Headers();
    for (const [name, value] of Object.entries(res.headers))
      if (value !== undefined)
        out.set(name, Array.isArray(value) ? value.join(', ') : String(value));
    return new Response(res.statusCode === 204 ? null : res.body, {
      status: res.statusCode,
      headers: out,
    });
  };
}

async function setup(t: { after: (fn: () => Promise<unknown>) => void }) {
  const f = await fixture(t);
  const poster = await f.account('Request poster');
  const responder = await f.account('Request responder');
  const original = globalThis.fetch;
  t.after(async () => {
    globalThis.fetch = original;
  });
  /** Runs the client's calls signed in as `who`. */
  const as = <T>(who: Account, run: () => Promise<T>): Promise<T> => {
    globalThis.fetch = browserAs(f.app, who);
    return run().finally(() => {
      globalThis.fetch = original;
    });
  };
  const ok = async (method: string, url: string, who: Account, body?: unknown) => {
    const res = await f.send(method, url, who.cookie, body);
    assert.ok(res.statusCode < 300, `${method} ${url}: ${res.statusCode} ${res.body}`);
    return res.json();
  };
  const roomOf = async (who: Account, name: string) =>
    (
      await ok('POST', '/api/rooms', who, {
        name,
        agent_id: who.agentId,
        idempotency_key: randomUUID(),
      })
    ).room.id as string;
  let n = 0;
  /** A request posted signed in by `who`, as its agent. */
  const post = async (who: Account = poster) =>
    (
      await ok('POST', FEED_PATHS.requests, who, {
        title: `Proofread a short manual ${++n}`,
        description: 'Synthetic request for a test.',
        idempotencyKey: randomUUID(),
        agentId: who.agentId,
      })
    ).request.id as string;
  const addAgent = async (who: Account, name: string) =>
    (await ok('POST', '/api/agents', who, { name, capability: 'research', mode: 'hosted' })).agent
      .id as string;
  const decidePath = (id: string) => INVITE_PATHS.inboxDecide.replace(':id', id);
  const blockPath = (agentId: string) => INVITE_PATHS.block.replace(':agentId', agentId);
  return { ...f, poster, responder, as, ok, roomOf, post, addAgent, decidePath, blockPath };
}

const refusal = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail('expected a refusal');
};

test('the room list as the server sends it: Respond offers open rooms the caller hosts, never a closed one', async (t) => {
  withFeed(t, '1');
  const s = await setup(t);
  const open = await s.roomOf(s.responder, 'Open desk');
  const closed = await s.roomOf(s.responder, 'Closed desk');
  await s.ok('POST', `/api/rooms/${closed}/close`, s.responder, {});
  // The responder's private chat with its own agent is a room it hosts too.
  await s.ok('POST', '/api/rooms/private-agent', s.responder, { agent_id: s.responder.agentId });
  // Another owner's room is never in the list (the responder is not in it).
  await s.roomOf(s.poster, 'Poster room');

  // The shape the client reads: closed_at (null while open), set on the closed room.
  const listed = (await s.ok('GET', '/api/rooms', s.responder)).rooms as ListedRoom[];
  const byId = new Map(listed.map((room) => [room.id, room]));
  assert.equal(byId.get(open)?.closed_at, null);
  assert.equal(typeof byId.get(closed)?.closed_at, 'string');
  assert.ok(listed.some((room) => room.private_agent_id === s.responder.agentId));

  const rooms = await s.as(s.responder, () => hostedRooms());
  assert.deepEqual(
    rooms.map((room) => room.name),
    ['Open desk'],
  );
  assert.deepEqual(
    rooms.map((room) => room.id),
    [open],
  );
  // Respond as: the responder's own agents in that room, never its person member.
  assert.deepEqual(
    (await s.as(s.responder, () => roomAgents(open))).map((agent) => agent.id),
    [s.responder.agentId],
  );

  // Had the closed room been offered, the server would refuse it: this is what the filter spares.
  const requestId = await s.post();
  const error = await refusal(
    s.as(s.responder, () =>
      sendResponse(requestId, {
        roomId: closed,
        fromAgentId: s.responder.agentId,
        note: '',
        idempotencyKey: randomUUID(),
      }),
    ),
  );
  assert.ok(error instanceof FeedFailure);
  assert.equal(error.code, 'room_closed');
  assert.equal(respondErrorCopy(error), 'This room isn’t open any more. Pick another room.');
});

test('Respond end to end: send, Already sent, Withdraw (and its failure), the poster’s count, card and Accept', async (t) => {
  withFeed(t, '1');
  const s = await setup(t);
  const room = await s.roomOf(s.responder, 'Manual desk');
  const requestId = await s.post();
  const note = cleanNote('  We proofread\u200b manuals   every week.\r\n\r\n\r\nTwo days. ');
  assert.equal(note, 'We proofread manuals every week.\n\nTwo days.');

  const sent = await s.as(s.responder, () =>
    sendResponse(requestId, {
      roomId: room,
      fromAgentId: s.responder.agentId,
      note,
      idempotencyKey: randomUUID(),
    }),
  );
  assert.equal(sent.state, 'open');
  assert.equal(sent.roomId, room);
  assert.equal(sent.note, note);
  // Already sent: the same room again is refused; the sheet reads it from mine.
  const again = await refusal(
    s.as(s.responder, () =>
      sendResponse(requestId, {
        roomId: room,
        fromAgentId: s.responder.agentId,
        note: '',
        idempotencyKey: randomUUID(),
      }),
    ),
  );
  assert.ok(again instanceof FeedFailure && again.code === 'response_open');
  const mine = await s.as(s.responder, () => getMyResponses(requestId));
  assert.deepEqual(
    mine.map((item) => [item.id, item.roomId, item.state]),
    [[sent.id, room, 'open']],
  );

  // The poster alone has a count; the responder's ask answers 404 like an unknown request.
  assert.deepEqual(await s.as(s.poster, () => getResponseCount(requestId)), {
    open: 1,
    accepted: 0,
  });
  const notPoster = await refusal(s.as(s.responder, () => getResponseCount(requestId)));
  assert.ok(notPoster instanceof FeedFailure && notPoster.code === 'request_not_found');
  // The summary the Messages badge reads counts it.
  const summary = await s.ok('GET', '/api/messages/summary', s.poster);
  assert.equal(requestResponsesOf(summary), 1);

  // Withdraw: it leaves the poster's inbox; withdrawing again answers the same.
  const withdrawn = await s.as(s.responder, () => withdrawResponse(sent.id));
  assert.equal(withdrawn.state, 'withdrawn');
  assert.deepEqual(await s.as(s.poster, () => readRequestResponses()), []);
  assert.equal((await s.as(s.responder, () => withdrawResponse(sent.id))).state, 'withdrawn');

  // Sent again, then accepted by the poster with the request's agent.
  const second = await s.as(s.responder, () =>
    sendResponse(requestId, {
      roomId: room,
      fromAgentId: s.responder.agentId,
      note: '',
      idempotencyKey: randomUUID(),
    }),
  );
  const cards = await s.as(s.poster, () => readRequestResponses());
  assert.equal(cards.length, 1);
  assert.equal(cards[0]!.id, second.id);
  assert.deepEqual(cards[0]!.agent, { id: s.poster.agentId, name: s.poster.name });
  assert.deepEqual(cards[0]!.room, { name: 'Manual desk', members: 2 });
  const accepted = await s.as(s.poster, () =>
    api<FeedRequestInvitation>(s.decidePath(second.id), {
      decision: 'accept',
      agentId: s.poster.agentId,
    }),
  );
  assert.equal(accepted.state, 'accepted');
  assert.equal(accepted.roomId, room);

  // Withdraw failure: an accepted response can't be withdrawn any more.
  const late = await refusal(s.as(s.responder, () => withdrawResponse(second.id)));
  assert.ok(late instanceof FeedFailure);
  assert.equal(late.code, 'invitation_closed');
  assert.equal(respondErrorCopy(late), 'This response is no longer open.');
  assert.equal((await s.as(s.responder, () => getMyResponses(requestId)))[0]!.state, 'joined');
});

test('New room: a retry with the same key finds the same room; a paused agent can’t host one', async (t) => {
  withFeed(t, '1');
  const s = await setup(t);
  const requestId = await s.post();
  const paused = await s.addAgent(s.responder, 'Resting scout');
  await s.ok('POST', `/api/agents/${paused}/pause`, s.responder, {});

  // The New room picker: the live agents that may host, the paused one left out and counted.
  const hosts = await s.as(s.responder, () => newRoomAgents());
  assert.deepEqual(
    hosts.agents.map((agent) => agent.id),
    [s.responder.agentId],
  );
  assert.equal(hosts.paused, 1);
  assert.equal(hosts.workspacePaused, false);
  // Why: the server refuses a paused host (nothing is created).
  const refused = await refusal(
    s.as(s.responder, () =>
      sendResponse(requestId, {
        newRoom: true,
        fromAgentId: paused,
        note: '',
        idempotencyKey: randomUUID(),
      }),
    ),
  );
  assert.ok(refused instanceof FeedFailure);
  assert.equal(refused.status, 409);
  assert.doesNotMatch(respondErrorCopy(refused), /paused|Resting/);

  const before = await s.as(s.responder, () => hostedRooms());
  const key = randomUUID();
  const body = {
    newRoom: true as const,
    fromAgentId: s.responder.agentId,
    note: '',
    idempotencyKey: key,
  };
  const first = await s.as(s.responder, () => sendResponse(requestId, body));
  // The answer was lost: the sheet sends the same response with the same key.
  const retry = await s.as(s.responder, () => sendResponse(requestId, body));
  assert.equal(retry.id, first.id);
  assert.equal(retry.roomId, first.roomId);
  const after = await s.as(s.responder, () => hostedRooms());
  assert.equal(after.length, before.length + 1);
  assert.deepEqual(
    after.filter((room) => room.id === first.roomId).map((room) => room.name),
    ['Proofread a short manual 1'],
  );
  // The same key with another note is another response: refused, with words for people.
  const conflict = await refusal(
    s.as(s.responder, () => sendResponse(requestId, { ...body, note: 'Another note.' })),
  );
  assert.ok(conflict instanceof FeedFailure && conflict.code === 'idempotency_conflict');
  assert.equal(
    respondErrorCopy(conflict),
    'This response changed while it was being sent. Send it again.',
  );
});

test('the poster’s side: a paused agent, a request in review, Block this owner and Unblock', async (t) => {
  withFeed(t, '1');
  const s = await setup(t);
  const room = await s.roomOf(s.responder, 'Review desk');
  const requestId = await s.post();
  const respond = () =>
    s.as(s.responder, () =>
      sendResponse(requestId, {
        roomId: room,
        fromAgentId: s.responder.agentId,
        note: '',
        idempotencyKey: randomUUID(),
      }),
    );
  const sent = await respond();
  const accept = (agentId: string) =>
    refusal(
      s.as(s.poster, () =>
        api<FeedRequestInvitation>(s.decidePath(sent.id), { decision: 'accept', agentId }),
      ),
    );

  // A paused agent is refused (the card never offers one).
  await s.ok('POST', `/api/agents/${s.poster.agentId}/pause`, s.poster, {});
  const paused = await accept(s.poster.agentId);
  assert.ok(paused instanceof ApiError && paused.code === 'agent_paused');
  assert.equal(
    decideErrorCopy(paused),
    'That agent is paused. Choose another one, or resume it in My agents.',
  );
  await s.ok('POST', `/api/agents/${s.poster.agentId}/resume`, s.poster, {});

  // Hidden by reports, the request waits for its review: the response stays open.
  await s.db.query('UPDATE feed_requests SET hidden_at=$2 WHERE id=$1', [requestId, Date.now()]);
  const review = await accept(s.poster.agentId);
  assert.ok(review instanceof ApiError && review.code === 'request_in_review');
  assert.equal(
    decideErrorCopy(review),
    'This request is being reviewed after reports. Try again later.',
  );
  await s.db.query('UPDATE feed_requests SET hidden_at=NULL WHERE id=$1', [requestId]);
  assert.deepEqual(
    (await s.as(s.poster, () => readRequestResponses())).map((item) => item.id),
    [sent.id],
  );

  // Block this owner, by the response (with any of the poster's agents): the card leaves.
  await s.as(s.poster, () => api(s.blockPath(s.poster.agentId), { invitationId: sent.id }));
  assert.deepEqual(await s.as(s.poster, () => readRequestResponses()), []);
  // A blocked responder is answered as if sent; it never reaches the poster.
  await s.as(s.responder, () => withdrawResponse(sent.id)).catch(() => undefined);
  const hidden = await respond();
  assert.equal(hidden.state, 'open');
  assert.deepEqual(await s.as(s.poster, () => readRequestResponses()), []);
  // Unblock: DELETE with the same response id.
  await s.as(s.poster, () =>
    api(s.blockPath(s.poster.agentId), { invitationId: sent.id }, 'DELETE'),
  );
  const blocks = await s.ok('GET', s.blockPath(s.poster.agentId), s.poster);
  assert.deepEqual(blocks.blocks, []);
});

test('flag off: the respond routes answer 404 and the client says Responding isn’t available', async (t) => {
  withFeed(t, '0');
  const s = await setup(t);
  const error = await refusal(s.as(s.responder, () => getMyResponses('req_aaaaaaaaaaaaaaaaaaa2')));
  assert.ok(error instanceof FeedFailure);
  assert.equal(error.code, 'not_found');
  assert.equal(respondErrorCopy(error), 'Responding isn’t available right now. Try again later.');
  // The summary has no requestResponses: no cards, nothing added to the badge.
  const summary = await s.ok('GET', '/api/messages/summary', s.poster);
  assert.equal('requestResponses' in summary, false);
  assert.equal(requestResponsesOf(summary), 0);
  // The room list still reads (it is not the Feed's).
  assert.deepEqual(await s.as(s.responder, () => hostedRooms()), []);
});
