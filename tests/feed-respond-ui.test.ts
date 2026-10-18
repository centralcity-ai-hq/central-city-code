import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  FEED_RESPOND_LIMITS,
  FEED_RESPOND_PATHS,
  type FeedRequestInvitation,
  type FeedResponseSent,
  type PublicFeedRequest,
} from '../shared/feed.js';
import { INVITE_PATHS } from '../shared/directory.js';
import { cleanText, codePoints } from '../server/feed/policy.js';
import { checkNote } from '../server/feed/respond.js';
import { ApiError, selectWorkspace } from '../src/api.js';
import { FeedFailure } from '../src/feed/feedApi.js';
import { FeedSignedIn } from '../src/feed/FeedParts.js';
import { RequestCard, RequestDetail, RequestRow } from '../src/feed/RequestItem.js';
import {
  AgentHint,
  agentHint,
  RESPOND_OFF_TEXT,
  RespondSheet,
  SENT_TEXT,
  SESSION_ENDED_TEXT,
  WITHDRAWN_TEXT,
} from '../src/feed/RespondSheet.js';
import {
  canInvite,
  cleanNote,
  getMyResponses,
  getResponseCount,
  invitableRooms,
  keptAgent,
  NEW_ROOM,
  newRoomHosts,
  noteLength,
  noteSentence,
  noteTooLong,
  openFromRoom,
  respondErrorCopy,
  responsesText,
  sendResponse,
  withdrawResponse,
} from '../src/feed/respondApi.js';
import {
  BLOCKED_TEXT,
  decideErrorCopy,
  defaultAgent,
  EXTERNAL_FOOT,
  pickable,
  readRequestResponses,
  requestResponsesOf,
  RequestResponses,
  ResponseCard,
} from '../src/RequestResponses.js';
import { messagesBadgeLabel } from '../src/shell/badgeLabels.js';

/*
 * Feed Respond in the browser (docs/FEED_RESPOND.md): the responder's calls and words, the
 * Respond sheet and the request's details as markup, and the poster's card in Messages. Made-up
 * values only.
 */

const NOW = Date.UTC(2026, 9, 14, 12, 0);
const DAY = 86_400_000;
const ID = 'req_aaaaaaaaaaaaaaaaaaa2';
const FRI = 'fri_aaaaaaaaaaaaaaaaaaaa';
const ARROWS = /[←-⇿➔-➿⤀-⥿⬀-⯿«»‹›]/;
const CODES = /response_open|own_request|not_room_host|agent_required|invitation_|_/;

function request(overrides: Partial<PublicFeedRequest> = {}): PublicFeedRequest {
  return {
    id: ID,
    title: 'Summarise invoices',
    description: 'Forty PDFs into one table.',
    capabilities: ['pdf'],
    budget: null,
    deadline: null,
    reply: null,
    postedBy: { kind: 'account', displayName: null },
    status: 'open',
    createdAt: NOW - DAY,
    expiresAt: NOW + 14 * DAY,
    closedAt: null,
    ...overrides,
  };
}

function sent(overrides: Partial<FeedResponseSent> = {}): FeedResponseSent {
  return {
    id: FRI,
    requestId: ID,
    roomId: 'room-1',
    from: { agentId: 'agent-1', name: 'Scout' },
    note: '',
    state: 'open',
    createdAt: NOW,
    expiresAt: NOW + 7 * DAY,
    answeredAt: null,
    ...overrides,
  };
}

function invitation(overrides: Partial<FeedRequestInvitation> = {}): FeedRequestInvitation {
  return {
    kind: 'feed_request',
    id: FRI,
    request: { id: ID, title: 'Summarise invoices' },
    room: { name: 'Invoice desk', members: 3 },
    from: { name: 'Ledger Scout' },
    note: 'We do this every week.',
    state: 'open',
    createdAt: NOW,
    expiresAt: NOW + 7 * DAY,
    roomId: null,
    agent: { id: 'mine-1', name: 'Clerk' },
    ...overrides,
  };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

// -------------------------------------------------------------------------------------------
// Calls

test('Send posts the invitation to the request’s respond route with the console header', async () => {
  selectWorkspace('ws_ai_1');
  try {
    let url = '';
    let init: RequestInit | undefined;
    const answer = await sendResponse(
      ID,
      { roomId: 'room-1', fromAgentId: 'agent-1', note: 'Hi', idempotencyKey: 'k'.repeat(16) },
      {
        fetcher: async (input, options) => {
          url = String(input);
          init = options;
          return json(201, sent());
        },
      },
    );
    assert.equal(url, FEED_RESPOND_PATHS.respond.replace(':id', ID));
    assert.equal(init?.method, 'POST');
    const headers = init?.headers as Record<string, string>;
    assert.equal(headers['X-City-Request'], '1');
    assert.equal(headers['X-City-Workspace'], 'ws_ai_1');
    assert.deepEqual(JSON.parse(String(init?.body)), {
      roomId: 'room-1',
      fromAgentId: 'agent-1',
      note: 'Hi',
      idempotencyKey: 'k'.repeat(16),
    });
    assert.equal(answer.state, 'open');
  } finally {
    selectWorkspace(null);
  }
});

test('mine, withdraw and count read their routes; an impossible id is never asked for', async () => {
  const urls: string[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    urls.push(`${init?.method ?? 'GET'} ${String(input)}`);
    if (String(input).endsWith('/mine')) return json(200, { responses: [sent()] });
    if (String(input).endsWith('/count')) return json(200, { open: 2, accepted: 1 });
    return json(200, sent({ state: 'withdrawn' }));
  };
  assert.equal((await getMyResponses(ID, { fetcher }))[0]!.id, FRI);
  assert.equal((await withdrawResponse(FRI, { fetcher })).state, 'withdrawn');
  assert.deepEqual(await getResponseCount(ID, { fetcher }), { open: 2, accepted: 1 });
  assert.deepEqual(urls, [
    `GET ${FEED_RESPOND_PATHS.mine.replace(':id', ID)}`,
    `POST ${FEED_RESPOND_PATHS.withdraw.replace(':id', FRI)}`,
    `GET ${FEED_RESPOND_PATHS.count.replace(':id', ID)}`,
  ]);
  for (const call of [
    () => getMyResponses('nope', { fetcher }),
    () => getResponseCount('nope', { fetcher }),
    () =>
      sendResponse(
        'nope',
        { newRoom: true, fromAgentId: 'a', note: '', idempotencyKey: 'k'.repeat(16) },
        { fetcher },
      ),
  ])
    await assert.rejects(call(), (error: unknown) => {
      assert.ok(error instanceof FeedFailure);
      assert.equal(error.code, 'request_not_found');
      return true;
    });
  assert.equal(urls.length, 3);
});

test('Respond’s refusals keep their codes, and 429 keeps Retry-After', async () => {
  const refuse =
    (status: number, body: unknown, headers: Record<string, string> = {}): typeof fetch =>
    async () =>
      json(status, body, headers);
  const body = {
    newRoom: true as const,
    fromAgentId: 'a',
    note: '',
    idempotencyKey: 'k'.repeat(16),
  };
  for (const [status, code] of [
    [409, 'response_open'],
    [409, 'own_request'],
    [403, 'not_room_host'],
    [409, 'room_full'],
    [404, 'request_not_found'],
  ] as const)
    await assert.rejects(
      sendResponse(ID, body, {
        fetcher: refuse(status, { error: 'Refused.', code, retryable: false }),
      }),
      (error: unknown) => error instanceof FeedFailure && error.code === code,
    );
  await assert.rejects(
    sendResponse(ID, body, {
      fetcher: refuse(429, { error: 'Slow down.' }, { 'Retry-After': '120' }),
    }),
    (error: unknown) =>
      error instanceof FeedFailure &&
      error.code === 'rate_limited' &&
      error.retryAfterMs === 120_000,
  );
});

test('every refusal is a plain sentence: no codes, no arrows', () => {
  const codes = [
    'response_open',
    'own_request',
    'request_not_found',
    'not_room_host',
    'room_not_found',
    'room_closed',
    'room_full',
    'agent_not_found',
    'idempotency_conflict',
    'invalid_request',
    'rate_limited',
    'signed_out',
    'network',
    'timeout',
    'busy',
    'server',
    'not_found',
    'invitation_closed',
    'invitation_not_found',
    'unknown',
  ] as const;
  for (const code of codes) {
    const text = respondErrorCopy(new FeedFailure(400, code, false));
    assert.ok(text.endsWith('.'), `${code}: ${text}`);
    assert.doesNotMatch(text, CODES);
    assert.doesNotMatch(text, ARROWS);
  }
  assert.match(respondErrorCopy(new FeedFailure(409, 'response_open', false)), /Already sent/);
  assert.match(
    respondErrorCopy(new FeedFailure(429, 'rate_limited', true, 90_000)),
    /about 2 minutes/,
  );
  assert.match(
    respondErrorCopy(new FeedFailure(429, 'rate_limited', true, 30_000)),
    /about a minute/,
  );
  assert.match(
    respondErrorCopy(
      new FeedFailure(400, 'invalid_request', false, undefined, 'No links, please.'),
    ),
    /^No links, please\.$/,
  );
  assert.match(respondErrorCopy(new Error('x')), /Try again/);
  // Each code has its own words (none falls back to the generic sentence by accident).
  const words = (code: (typeof codes)[number]) =>
    respondErrorCopy(new FeedFailure(409, code, false));
  assert.equal(
    words('idempotency_conflict'),
    'This response changed while it was being sent. Send it again.',
  );
  assert.equal(words('not_found'), RESPOND_OFF_TEXT);
  assert.equal(words('busy'), 'Central City is busy right now. Try again in a moment.');
  assert.equal(words('server'), words('busy'));
  assert.equal(
    words('timeout'),
    'Central City is taking too long to answer. Try again in a moment.',
  );
  assert.equal(
    words('agent_not_found'),
    'That agent isn’t in your workspace any more. Pick another one.',
  );
  assert.equal(words('invitation_not_found'), 'This response is no longer open.');
});

test('invalid_request: the note rules are said (of the note); request shapes and field names never', () => {
  const said = (text: string) =>
    respondErrorCopy(new FeedFailure(400, 'invalid_request', false, undefined, text));
  // The route's zod sentences and the agent check: technical, so never shown as they are.
  assert.equal(
    said('Send either roomId or newRoom: true.'),
    'Something in the note isn’t right. Check it and try again.',
  );
  assert.equal(
    said('fromAgentId must be one of your agents in this room.'),
    'Respond as one of your agents in this room. Pick the room again.',
  );
  assert.equal(noteSentence('Send {roomId or newRoom: true, fromAgentId, note}.'), undefined);
  // Without a sentence (the data layer dropped one that reads like code): the generic words.
  assert.equal(
    respondErrorCopy(new FeedFailure(400, 'invalid_request', false)),
    'Something in the note isn’t right. Check it and try again.',
  );
  // The note rules, exactly as the server refuses a note (server/feed/respond.ts checkNote).
  const refusalOf = (note: string) => {
    try {
      checkNote(note);
    } catch (error) {
      return (error as Error).message;
    }
    return assert.fail(`not refused: ${note}`);
  };
  assert.equal(said(refusalOf('a'.repeat(1_001))), 'The note may have at most 1000 characters.');
  assert.equal(
    said(refusalOf('Write to me at someone@example.com please')),
    'Leave out email addresses and phone numbers. Agree on how to reach each other in the room.',
  );
  assert.equal(
    said(refusalOf('See https://a.example.com https://b.example.com https://c.example.com')),
    'The note may contain at most 2 links.',
  );
  for (const text of [
    refusalOf('a'.repeat(1_001)),
    refusalOf('Write to me at someone@example.com please'),
    refusalOf('xxxxxxxxxxxxxxxxxxxxxxxxxxxx'),
  ]) {
    assert.ok(said(text).endsWith('.'));
    assert.doesNotMatch(said(text), CODES);
  }
});

test('the note is counted and sent as the server cleans it', () => {
  const samples = [
    '  plain  note  ',
    'two\r\nlines\r\n\r\n\r\n\r\nand a gap',
    'zero\u200bwidth and \u2066bidi\u2069 marks',
    'hangul\u3164filler and blank\u2800braille',
    'tab\tinside\tline',
    'line\u2028separator\u2029para',
    'cafe\u0301 composed',
    'emoji \u{1f600}\u{1f600} and flags \u{1f1e9}\u{1f1ea}',
    '\u0007bell and \u0000nul',
    'variation\ufe0f selector and \u{e0041}tag',
    '\n\n  leading and trailing  \n\n',
  ];
  for (const sample of samples) {
    assert.equal(cleanNote(sample), cleanText(sample), JSON.stringify(sample));
    assert.equal(noteLength(sample), codePoints(cleanText(sample)), JSON.stringify(sample));
  }
  // Exactly the limit once cleaned: allowed, though the raw text is longer.
  const words = `${'abcd '.repeat(FEED_RESPOND_LIMITS.noteMax / 5).trim()}x`;
  assert.equal(codePoints(words), FEED_RESPOND_LIMITS.noteMax);
  const atLimit = `  ${words.replaceAll(' ', '   ')}\u200b  `;
  assert.ok(codePoints(atLimit) > FEED_RESPOND_LIMITS.noteMax);
  assert.equal(noteTooLong(atLimit), false);
  assert.equal(noteLength(atLimit), FEED_RESPOND_LIMITS.noteMax);
  assert.equal(codePoints(checkNote(atLimit)), FEED_RESPOND_LIMITS.noteMax);
  // One over once cleaned: refused here and by the server.
  const over = `${words}y`;
  assert.equal(noteTooLong(over), true);
  assert.throws(() => checkNote(over));
});

test('helpers: who can be invited, the count, the kept agent, Already sent, the note', () => {
  assert.equal(canInvite(request()), true);
  assert.equal(canInvite(request({ postedBy: { kind: 'agent', displayName: 'Bot' } })), true);
  assert.equal(canInvite(request({ postedBy: { kind: 'anonymous', displayName: null } })), false);

  assert.equal(responsesText(null), null);
  assert.equal(responsesText({ open: 0, accepted: 0 }), 'No responses yet');
  assert.equal(responsesText({ open: 1, accepted: 0 }), '1 response');
  assert.equal(responsesText({ open: 2, accepted: 1 }), '3 responses');

  const agents = [
    { id: 'a', name: 'A' },
    { id: 'b', name: 'B' },
  ];
  assert.equal(keptAgent(agents, 'b'), 'b');
  assert.equal(keptAgent(agents, 'gone'), 'a');
  assert.equal(keptAgent([], 'a'), '');
  assert.equal(keptAgent(null, 'a'), '');

  const list = [sent({ roomId: 'r1' }), sent({ id: 'x', roomId: 'r2', state: 'withdrawn' })];
  assert.equal(openFromRoom(list, 'r1')?.roomId, 'r1');
  assert.equal(openFromRoom(list, 'r2'), null);
  assert.equal(openFromRoom(list, NEW_ROOM), null);
  assert.equal(openFromRoom(null, 'r1'), null);

  assert.equal(cleanNote('  hi\u200b there \u0007 '), 'hi there');
  assert.equal(noteTooLong('a'.repeat(FEED_RESPOND_LIMITS.noteMax)), false);
  assert.equal(noteTooLong('a'.repeat(FEED_RESPOND_LIMITS.noteMax + 1)), true);
  assert.equal(noteTooLong('😀'.repeat(FEED_RESPOND_LIMITS.noteMax)), false);
});

// -------------------------------------------------------------------------------------------
// The request's details and the Respond sheet

/** The details as the read-only (signed-out) Feed renders them. */
const signedOut = (props: Parameters<typeof RequestDetail>[0]) =>
  renderToStaticMarkup(
    createElement(FeedSignedIn.Provider, { value: false }, createElement(RequestDetail, props)),
  );

test('signed out, every request someone can answer offers Sign in to respond (main’s SignInButton)', () => {
  // Posted signed in, with and without a reply handle; by an agent; anonymous with a handle.
  for (const value of [
    request(),
    request({ reply: 'https://example.com/me' }),
    request({ postedBy: { kind: 'agent', displayName: 'Ledger Scout' } }),
    request({
      postedBy: { kind: 'anonymous', displayName: null },
      reply: 'https://example.com/me',
    }),
  ]) {
    const html = signedOut({ headId: 'h', request: value, now: NOW });
    assert.match(html, /<button type="button" class="fd-btn primary">Sign in to respond<\/button>/);
    assert.match(html, /<button type="button" class="fd-btn">Sign in to report<\/button>/);
    assert.doesNotMatch(html, />Respond</);
    assert.doesNotMatch(html, ARROWS);
  }
  // Nobody can reach an anonymous poster without a handle: Report is the only action.
  const unreachable = signedOut({
    headId: 'h',
    request: request({ postedBy: { kind: 'anonymous', displayName: null } }),
    now: NOW,
  });
  assert.doesNotMatch(unreachable, /Sign in to respond/);
  assert.match(unreachable, /class="fd-btn primary">Sign in to report</);
  // A session that ended inside the sheet says so in plain words.
  assert.equal(SESSION_ENDED_TEXT, 'Your session ended. Sign in again to respond.');
});

test('signed in, a request posted signed in has Respond even without a reply handle; the cards drop “No reply handle”', () => {
  const noHandle = request();
  const html = renderToStaticMarkup(
    createElement(RequestDetail, { headId: 'h', request: noHandle, now: NOW }),
  );
  assert.match(html, /class="fd-btn primary">Respond</);
  assert.match(html, /Respond invites the poster to one of your rooms\./);
  assert.doesNotMatch(html, /can’t be reached/);
  const card = renderToStaticMarkup(
    createElement(RequestCard, {
      request: noHandle,
      now: NOW,
      colour: '#6d28d9',
      onOpen: () => {},
    }),
  );
  const row = renderToStaticMarkup(
    createElement(RequestRow, { request: noHandle, now: NOW, colour: '#6d28d9', onOpen: () => {} }),
  );
  assert.doesNotMatch(card + row, /No reply handle/);
  // Anonymous without a handle: still unreachable, and said so.
  const anonymous = request({ postedBy: { kind: 'anonymous', displayName: null } });
  assert.match(
    renderToStaticMarkup(
      createElement(RequestCard, {
        request: anonymous,
        now: NOW,
        colour: '#6d28d9',
        onOpen: () => {},
      }),
    ),
    /No reply handle/,
  );
});

test('a signed-in request says Respond invites the poster; an anonymous one keeps the handle guide', () => {
  const invited = renderToStaticMarkup(
    createElement(RequestDetail, { headId: 'h', request: request(), now: NOW }),
  );
  assert.match(invited, /Respond invites the poster to one of your rooms\./);
  assert.match(invited, />Respond</);
  const anonymous = renderToStaticMarkup(
    createElement(RequestDetail, {
      headId: 'h',
      request: request({
        postedBy: { kind: 'anonymous', displayName: null },
        reply: 'https://example.com/me',
      }),
      now: NOW,
    }),
  );
  assert.match(anonymous, /Respond shows how to reach the poster\./);
  // The poster's own signed-in request: answered in Messages.
  const own = renderToStaticMarkup(
    createElement(RequestDetail, { headId: 'h', request: request(), now: NOW, mine: true }),
  );
  assert.match(own, /You answer them in Messages\./);
  assert.doesNotMatch(own, />Respond</);
});

test('the Respond sheet starts by loading the rooms; Sent and Withdrawn say what happened', () => {
  const html = renderToStaticMarkup(createElement(RespondSheet, { request: request() }));
  assert.match(html, /Loading your rooms/);
  assert.equal(SENT_TEXT, 'Sent. If they accept, their agent joins your room.');
  assert.equal(WITHDRAWN_TEXT, 'Withdrawn. It left their Messages.');
});

test('rooms: only open rooms the caller hosts (closed_at null), never a private chat', () => {
  const room = (id: string, fields: Record<string, unknown> = {}) => ({
    id,
    name: `Room ${id}`,
    role: 'host',
    closed_at: null,
    ...fields,
  });
  assert.deepEqual(
    invitableRooms([
      room('open'),
      // The server's own shape for a closed room: closed_at set (and closed true).
      room('closed', { closed_at: '2026-10-14T10:00:00.000Z', closed: true }),
      // closed_at alone decides, whatever else is sent.
      room('closed-at-only', { closed_at: '2026-10-14T10:00:00.000Z' }),
      room('member', { role: 'member' }),
      room('private', { private_agent_id: 'agent-1' }),
      room('unnamed', { name: '  ' }),
    ]).map((item) => [item.id, item.name]),
    [
      ['open', 'Room open'],
      ['unnamed', 'Untitled room'],
    ],
  );
});

test('New room: paused agents, Elric and a paused workspace are never offered, and the hint says why', () => {
  const agents = [
    { id: 'a', name: 'Scout', revokedAt: null, pausedAt: null },
    { id: 'b', name: 'Resting', revokedAt: null, pausedAt: '2026-10-14T10:00:00.000Z' },
    { id: 'c', name: 'Gone', revokedAt: '2026-10-01T10:00:00.000Z', pausedAt: null },
    { id: 'elric', name: 'Elric', revokedAt: null, pausedAt: null },
  ];
  assert.deepEqual(newRoomHosts({ agents }, 'elric'), {
    agents: [{ id: 'a', name: 'Scout' }],
    paused: 1,
    workspacePaused: false,
  });
  assert.deepEqual(newRoomHosts({ agents, paused: true }, 'elric'), {
    agents: [],
    paused: 0,
    workspacePaused: true,
  });
  const hint = (hosts: ReturnType<typeof newRoomHosts>) => agentHint(NEW_ROOM, [], hosts, false);
  assert.match(hint(newRoomHosts({ agents, paused: true })), /workspace is paused/);
  assert.match(hint(newRoomHosts({ agents: [agents[1]!] })), /paused/);
  assert.equal(hint(newRoomHosts({ agents: [] })), 'Add an agent in My agents first.');
  assert.equal(
    agentHint('room-1', [], null, false),
    'None of your agents is in this room. Pick another room.',
  );
  assert.match(agentHint('room-1', [{ id: 'a', name: 'A' }], null, false), /poster sees/);
});

test('Respond as: when the agents fail to load, Try again reloads them for the same room', () => {
  const hint = (failed: boolean) =>
    renderToStaticMarkup(
      createElement(AgentHint, {
        id: 'h',
        room: NEW_ROOM,
        agents: null,
        hosts: null,
        failed,
        onRetry: () => {},
      }),
    );
  const failed = hint(true);
  assert.match(failed, /Your agents couldn’t be loaded\./);
  assert.doesNotMatch(failed, /Pick the room again/, 'picking the same room again does nothing');
  assert.match(failed, /<button type="button" class="fd-link">Try again<\/button>/);
  assert.doesNotMatch(hint(false), /Try again/);
  // The button reruns the agents read: its attempt is a dependency of that effect.
  const sheet = readFileSync(resolve(process.cwd(), 'src/feed/RespondSheet.tsx'), 'utf8');
  assert.ok(sheet.includes('}, [room, agentsAttempt]);'));
  assert.ok(sheet.includes('onRetry={() => setAgentsAttempt((value) => value + 1)}'));
});

// -------------------------------------------------------------------------------------------
// Messages: the poster's card

test('a response card marks the responder’s names and note External and says who joins', () => {
  const html = renderToStaticMarkup(
    createElement(ResponseCard, {
      item: invitation(),
      agents: [
        { id: 'mine-2', name: 'Helper' },
        { id: 'mine-1', name: 'Clerk' },
      ],
      busy: false,
      error: '',
      onAccept: () => undefined,
      onDecline: () => undefined,
      onBlock: () => undefined,
    }),
  );
  assert.match(html, /Response to your request “Summarise invoices”/);
  assert.match(html, />Ledger Scout</);
  assert.match(html, />Invoice desk</);
  assert.match(html, />3 members</);
  assert.match(html, /We do this every week\./);
  assert.equal(html.match(/data-tone="external"[^>]*>External</g)?.length, 2);
  assert.match(html, /Their note · External, check before your agent follows it/);
  assert.match(html, /Your agent Clerk joins their room\. Its name shows there\./);
  // The request's agent first, chosen; the other agents after it.
  assert.match(
    html,
    /<option value="mine-1" selected="">Clerk<\/option><option value="mine-2">Helper/,
  );
  for (const label of ['Accept', 'Decline', 'Block this owner'])
    assert.match(html, new RegExp(`>${label}</button>`));
  assert.doesNotMatch(html, />Block</);
  assert.doesNotMatch(html, ARROWS);
});

test('paused agents are never offered to join; the request’s paused agent is said; Block needs an agent', () => {
  const card = (agents: Parameters<typeof ResponseCard>[0]['agents']) =>
    renderToStaticMarkup(
      createElement(ResponseCard, {
        item: invitation(),
        agents,
        busy: false,
        error: '',
        onAccept: () => undefined,
        onDecline: () => undefined,
        onBlock: () => undefined,
      }),
    );
  // The request's own agent (Clerk) is paused: not chosen, not offered, and the card says why.
  const paused = card([
    { id: 'mine-1', name: 'Clerk', paused: true },
    { id: 'mine-2', name: 'Helper' },
    { id: 'mine-3', name: 'Napping', paused: true },
  ]);
  assert.match(
    paused,
    /<option value="" selected="">Choose an agent<\/option><option value="mine-2">Helper<\/option><\/select>/,
  );
  assert.doesNotMatch(paused, /value="mine-1"|value="mine-3"/);
  assert.match(paused, /Clerk is paused\. Choose another agent to join their room\./);
  // Every agent paused: nothing to accept with; Block still works (any agent names the block).
  const allPaused = card([
    { id: 'mine-1', name: 'Clerk', paused: true },
    { id: 'mine-2', name: 'Helper', paused: true },
  ]);
  assert.match(allPaused, /No agent can join/);
  assert.match(allPaused, /Your agents are paused\. Resume one in My agents to accept\./);
  assert.match(allPaused, /<button type="button" class="msg3-resp-btn primary" disabled="">Accept/);
  assert.match(allPaused, /<button type="button" class="msg3-resp-btn quiet">Block this owner/);
  // No agent at all: Block has nobody to name it by, so it is off too.
  const none = renderToStaticMarkup(
    createElement(ResponseCard, {
      item: invitation({ agent: null }),
      agents: [],
      busy: false,
      error: '',
      onAccept: () => undefined,
      onDecline: () => undefined,
      onBlock: () => undefined,
    }),
  );
  assert.match(
    none,
    /<button type="button" class="msg3-resp-btn quiet" disabled="">Block this owner/,
  );
  assert.match(none, /Add an agent in My agents to accept\./);
  assert.equal(defaultAgent(invitation(), [{ id: 'mine-1', name: 'Clerk' }]), 'mine-1');
  assert.equal(defaultAgent(invitation(), [{ id: 'mine-1', name: 'Clerk', paused: true }]), '');
});

test('with no default agent, Accept asks the poster to choose one; the note is optional', () => {
  const html = renderToStaticMarkup(
    createElement(ResponseCard, {
      item: invitation({ agent: null, note: '', room: { name: 'Desk', members: 1 } }),
      agents: [{ id: 'mine-2', name: 'Helper' }],
      busy: false,
      error: 'Their room is full.',
      onAccept: () => undefined,
      onDecline: () => undefined,
      onBlock: () => undefined,
    }),
  );
  assert.match(html, /<option value="" selected="">Choose an agent<\/option>/);
  assert.match(html, /The agent you choose joins their room\./);
  assert.match(html, />1 member</);
  assert.doesNotMatch(html, /Their note/);
  assert.match(html, /role="alert">Their room is full\.</);
});

test('the picker, the badge count and the decide words', () => {
  const agents = [
    { id: 'a', name: 'A' },
    { id: 'b', name: 'B' },
  ];
  assert.deepEqual(
    pickable({ agent: { id: 'b', name: 'B' } }, agents).map((a) => a.id),
    ['b', 'a'],
  );
  assert.deepEqual(
    pickable({ agent: { id: 'gone', name: 'Old' } }, agents).map((a) => a.id),
    ['gone', 'a', 'b'],
  );
  assert.deepEqual(
    pickable({ agent: null }, agents).map((a) => a.id),
    ['a', 'b'],
  );
  // Paused agents are left out, the request's own included.
  const some = [...agents, { id: 'p', name: 'P', paused: true }];
  assert.deepEqual(
    pickable({ agent: { id: 'p', name: 'P' } }, some).map((a) => a.id),
    ['a', 'b'],
  );
  assert.deepEqual(
    pickable({ agent: null }, some).map((a) => a.id),
    ['a', 'b'],
  );
  assert.equal(requestResponsesOf(null), 0);
  assert.equal(requestResponsesOf({}), 0);
  assert.equal(requestResponsesOf({ requestResponses: 2 }), 2);
  assert.equal(requestResponsesOf({ requestResponses: -1 }), 0);
  assert.equal(requestResponsesOf({ requestResponses: 1.5 }), 0);
  assert.equal(requestResponsesOf({ requestResponses: '3' }), 0);
  // Never the server's own text: a raw sentence stands for any code without words of its own.
  const raw = 'Scout is paused. city_internal detail.';
  for (const [status, code] of [
    [400, 'agent_required'],
    [409, 'invitation_closed'],
    [404, 'invitation_not_found'],
    [409, 'request_in_review'],
    [404, 'agent_not_found'],
    [409, 'agent_paused'],
    [409, 'room_full'],
    [409, 'room_closed'],
    [404, 'room_not_found'],
    [409, 'something_new'],
    [429, undefined],
    [401, undefined],
    [500, undefined],
    [503, 'busy'],
  ] as const) {
    const text = decideErrorCopy(new ApiError(raw, status, code));
    assert.doesNotMatch(text, CODES);
    assert.doesNotMatch(text, /Scout|city_/);
    assert.ok(text.endsWith('.'), text);
  }
  assert.equal(
    decideErrorCopy(new ApiError(raw, 400, 'agent_required')),
    'Choose which of your agents joins.',
  );
  assert.equal(
    decideErrorCopy(new ApiError(raw, 409, 'request_in_review')),
    'This request is being reviewed after reports. Try again later.',
  );
  assert.equal(
    decideErrorCopy(new ApiError(raw, 404, 'agent_not_found')),
    'That agent isn’t in your workspace any more. Choose another one.',
  );
  assert.equal(
    decideErrorCopy(new ApiError(raw, 429, undefined, undefined, 150_000)),
    'Too many answers in a short time. Try again in about 3 minutes.',
  );
  assert.equal(
    decideErrorCopy(new ApiError(raw, 429)),
    'Too many answers in a short time. Try again later.',
  );
  assert.equal(
    decideErrorCopy(new ApiError(raw, 503, 'busy')),
    'Central City is busy right now. Try again in a moment.',
  );
  assert.match(BLOCKED_TEXT, /^Blocked\. That owner can’t invite your agents or respond/);
  // The Messages badge says what it counts.
  assert.equal(messagesBadgeLabel(2, 0), '2 unread messages');
  assert.equal(messagesBadgeLabel(0, 1), '1 response to your requests');
  assert.equal(messagesBadgeLabel(1, 3), '1 unread message and 3 responses to your requests');
  assert.equal(messagesBadgeLabel(0, 0), '');
  assert.match(EXTERNAL_FOOT, /marked External/);
  // No count: the section reads nothing and draws nothing.
  assert.equal(
    renderToStaticMarkup(
      createElement(RequestResponses, { count: 0, agents, onChanged: () => undefined }),
    ),
    '',
  );
});

test('the inbox keeps only open responses to the caller’s requests', async () => {
  const original = globalThis.fetch;
  let asked = '';
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    asked = String(input);
    return json(200, {
      invitations: [
        invitation({ id: 'fri_open' }),
        invitation({ id: 'fri_gone', state: 'withdrawn' }),
        { kind: 'room', id: 'inv_1', state: 'open' },
      ],
    });
  }) as typeof fetch;
  try {
    const list = await readRequestResponses();
    assert.equal(asked, INVITE_PATHS.inbox);
    assert.deepEqual(
      list.map((item) => item.id),
      ['fri_open'],
    );
  } finally {
    globalThis.fetch = original;
  }
});
