import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/app.js';
import { ASSISTANT_SCOPES } from '../shared/assistant.js';
import type { RoomLimits } from '../server/rooms/contract.js';
import { highlighted, roomSearchSql } from '../server/rooms/search-schema.js';
import type { Database } from '../server/database.js';

process.env.CITY_INVITE_FLOW = '1';
process.env.CITY_RATE_LIMIT_KEY ??= 'synthetic-search-test-root-not-a-real-secret';

/**
 * Search inside a room (city_room_search, GET /api/rooms/:room/search): members only, and only
 * the history they may read (the same rule as city_room_read). Synthetic data only.
 */
type App = Awaited<ReturnType<typeof createApp>>;
const jsonHeaders = { 'content-type': 'application/json', 'x-city-request': '1' };

async function fixture(
  t: { after: (fn: () => Promise<unknown>) => void },
  extra: { rooms?: Partial<RoomLimits>; now?: () => number } = {},
) {
  const app = await createApp({ dataDir: ':memory:', startWorkers: false, ...extra });
  t.after(() => app.close());
  return app;
}
function call(app: App, key: string, name: string, args: unknown = {}) {
  return app.inject({
    method: 'POST',
    url: `/api/assistant/tools/${name}`,
    headers: { ...jsonHeaders, authorization: `Bearer ${key}` },
    payload: JSON.stringify(args),
  });
}
async function ok(app: App, key: string, name: string, args: unknown = {}) {
  const res = await call(app, key, name, args);
  assert.equal(res.statusCode, 200, `${name}: ${res.body}`);
  return res.json();
}
let addressCounter = 1;
/** An AI-owned workspace claimed by a person, with a key holding every scope. */
async function owner(app: App, name: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/public/workspaces',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ name, idempotency_key: randomUUID() }),
    remoteAddress: `198.51.${addressCounter++}.30`,
  });
  assert.equal(res.statusCode, 201, res.body);
  const id = res.json().workspace_id as string;
  const person = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    headers: jsonHeaders,
    payload: JSON.stringify({
      name: `Search owner ${addressCounter}`,
      password: 'Synthetic search owner password',
    }),
    remoteAddress: `198.51.${addressCounter++}.31`,
  });
  assert.equal(person.statusCode, 201, person.body);
  const cookie = `cc_session=${person.cookies.find((item) => item.name === 'cc_session')!.value}`;
  const claimed = await app.inject({
    method: 'POST',
    url: '/api/workspaces/claim',
    headers: { ...jsonHeaders, cookie },
    payload: JSON.stringify({ claim_token: res.json().claim_token }),
  });
  assert.equal(claimed.statusCode, 200, claimed.body);
  const minted = await app.inject({
    method: 'POST',
    url: '/api/workspace-keys',
    headers: { ...jsonHeaders, cookie, 'x-city-workspace': id },
    payload: JSON.stringify({ label: 'search test', scopes: [...ASSISTANT_SCOPES] }),
  });
  assert.equal(minted.statusCode, 201, minted.body);
  return { id, key: minted.json().workspace_key as string, cookie };
}
async function agent(app: App, key: string, name: string) {
  const body = await ok(app, key, 'city_create_agent', {
    name,
    description: 'Synthetic room member',
    capability: 'research',
    mode: 'external',
    idempotencyKey: randomUUID(),
  });
  return body.agent.id as string;
}
const post = (app: App, key: string, roomId: string, text: string) =>
  ok(app, key, 'city_room_post', { room_id: roomId, text, idempotency_key: randomUUID() });
const search = (app: App, key: string, args: Record<string, unknown>) =>
  call(app, key, 'city_room_search', args);

/** A host with a room ('from_join' unless said otherwise) and three earlier messages. */
async function room(app: App, history: 'from_join' | 'full' = 'from_join') {
  const a = await owner(app, 'Search host');
  const hostAgent = await agent(app, a.key, 'Host AI');
  const created = await ok(app, a.key, 'city_create_room', {
    agent_id: hostAgent,
    name: 'Search desk',
    history,
    idempotency_key: randomUUID(),
  });
  const roomId = created.room.id as string;
  const link = created.link.link as string;
  await post(app, a.key, roomId, 'The secret launch date is Tuesday.');
  await post(app, a.key, roomId, 'Budget numbers for the launch are ready.');
  await post(app, a.key, roomId, 'Lunch at noon?');
  return { a, hostAgent, roomId, link };
}
async function member(app: App, link: string, name = 'Member') {
  const b = await owner(app, name);
  const agentId = await agent(app, b.key, `${name} AI`);
  await ok(app, b.key, 'city_join_room', {
    link,
    agent_id: agentId,
    idempotency_key: randomUUID(),
  });
  return { ...b, agentId };
}

test('a member finds words newest first with snippets, highlights and pages', async (t) => {
  const app = await fixture(t);
  const { a, hostAgent, roomId } = await room(app, 'full');
  for (let i = 1; i <= 5; i++)
    await post(app, a.key, roomId, `Launch note ${i} with ünïcode Größe`);
  const first = await ok(app, a.key, 'city_room_search', {
    room_id: roomId,
    q: 'launch',
    limit: 4,
  });
  assert.equal(first.room_id, roomId);
  assert.equal(first.results.length, 4);
  const seqs = first.results.map((r: { seq: number }) => r.seq);
  assert.deepEqual(
    seqs,
    [...seqs].sort((x, y) => y - x),
    'newest first',
  );
  const hit = first.results[0];
  assert.equal(hit.sender_agent_id, hostAgent);
  assert.equal(hit.sender, 'Host AI');
  assert.equal(hit.own, true);
  assert.match(hit.created_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(hit.snippet, /Launch note 5/);
  assert.deepEqual(
    hit.highlights.map(([s, e]: [number, number]) => hit.snippet.slice(s, e).toLowerCase()),
    ['launch'],
  );
  assert.ok(first.next_cursor);
  const second = await ok(app, a.key, 'city_room_search', {
    room_id: roomId,
    q: 'launch',
    limit: 4,
    cursor: first.next_cursor,
  });
  // Seven matches in all: 5 notes plus the two earlier launch messages.
  assert.equal(second.results.length, 3);
  assert.equal(second.next_cursor, undefined);
  assert.ok(second.results[0].seq < seqs.at(-1));
  // Multilingual words match whole and case-insensitively ('simple': no stemming).
  const umlaut = await ok(app, a.key, 'city_room_search', { room_id: roomId, q: 'GRÖSSE größe' });
  assert.equal(umlaut.results.length, 0, 'every word must appear');
  const words = await ok(app, a.key, 'city_room_search', { room_id: roomId, q: 'größe' });
  assert.equal(words.results.length, 5);
  // Phrases, exclusion, no results and punctuation-only queries.
  const phrase = await ok(app, a.key, 'city_room_search', {
    room_id: roomId,
    q: '"secret launch"',
  });
  assert.equal(phrase.results.length, 1);
  const excluded = await ok(app, a.key, 'city_room_search', { room_id: roomId, q: 'launch -note' });
  assert.equal(excluded.results.length, 2);
  const none = await ok(app, a.key, 'city_room_search', { room_id: roomId, q: 'zebra' });
  assert.deepEqual(none.results, []);
  const marks = await ok(app, a.key, 'city_room_search', { room_id: roomId, q: '!!! & | :*' });
  assert.deepEqual(marks.results, []);
  // Hostile input is only ever a bind parameter: SQL and tsquery syntax are plain words.
  for (const q of ["'; DROP TABLE room_messages; --", 'launch:* | (', 'a & | ! <-> b', '\\\\x01'])
    assert.equal((await search(app, a.key, { room_id: roomId, q })).statusCode, 200, q);
  assert.equal(
    (await ok(app, a.key, 'city_room_search', { room_id: roomId, q: 'lunch' })).results.length,
    1,
  );
});

test('filters: sender and date range', async (t) => {
  let time = Date.parse('2026-09-01T10:00:00Z');
  const app = await fixture(t, { now: () => time });
  const { a, hostAgent, roomId, link } = await room(app, 'full');
  const b = await member(app, link);
  time = Date.parse('2026-09-05T10:00:00Z');
  await post(app, b.key, roomId, 'Member says launch is fine');
  const all = await ok(app, a.key, 'city_room_search', { room_id: roomId, q: 'launch' });
  assert.equal(all.results.length, 3);
  const bySender = await ok(app, a.key, 'city_room_search', {
    room_id: roomId,
    q: 'launch',
    sender: b.agentId,
  });
  assert.deepEqual(
    bySender.results.map((r: { sender_agent_id: string; own: boolean }) => [
      r.sender_agent_id,
      r.own,
    ]),
    [[b.agentId, false]],
  );
  const host = await ok(app, a.key, 'city_room_search', {
    room_id: roomId,
    q: 'launch',
    sender: hostAgent,
  });
  assert.equal(host.results.length, 2);
  const early = await ok(app, a.key, 'city_room_search', {
    room_id: roomId,
    q: 'launch',
    to: '2026-09-02T00:00:00Z',
  });
  assert.equal(early.results.length, 2);
  const late = await ok(app, a.key, 'city_room_search', {
    room_id: roomId,
    q: 'launch',
    from: '2026-09-05T10:00:00+00:00',
  });
  assert.equal(late.results.length, 1);
  assert.equal(
    (await search(app, a.key, { room_id: roomId, q: 'x', from: 'yesterday' })).statusCode,
    400,
  );
});

test('a late joiner cannot find messages from before it joined (history from_join)', async (t) => {
  const app = await fixture(t);
  const { a, roomId, link } = await room(app, 'from_join');
  const b = await member(app, link, 'Late joiner');
  await post(app, a.key, roomId, 'After the join: launch moved to Friday.');
  const found = await ok(app, b.key, 'city_room_search', { room_id: roomId, q: 'launch' });
  assert.deepEqual(
    found.results.map((r: { snippet: string }) => r.snippet),
    ['After the join: launch moved to Friday.'],
  );
  assert.ok(found.visible_from_seq >= 3);
  // Same rule as city_room_read: the hidden messages are not readable either.
  const read = await ok(app, b.key, 'city_room_read', { room_id: roomId, since: 0 });
  assert.ok(read.messages.every((m: { text: string }) => !/secret/.test(m.text)));
  const hidden = await ok(app, b.key, 'city_room_search', { room_id: roomId, q: 'secret' });
  assert.deepEqual(hidden.results, []);
  // The host sees everything.
  assert.equal(
    (await ok(app, a.key, 'city_room_search', { room_id: roomId, q: 'launch' })).results.length,
    3,
  );
  // Opening the history to everyone (history full) opens search too.
  await ok(app, a.key, 'city_room_update', { room_id: roomId, history: 'full' });
  assert.equal(
    (await ok(app, b.key, 'city_room_search', { room_id: roomId, q: 'secret' })).results.length,
    1,
  );
});

test('a removed member and a non-member are refused', async (t) => {
  const app = await fixture(t);
  const { a, roomId, link } = await room(app, 'full');
  const b = await member(app, link, 'Removed');
  assert.equal(
    (await ok(app, b.key, 'city_room_search', { room_id: roomId, q: 'launch' })).results.length,
    2,
  );
  await ok(app, a.key, 'city_room_remove', { room_id: roomId, agent_id: b.agentId });
  const removed = await search(app, b.key, { room_id: roomId, q: 'launch' });
  assert.equal(removed.statusCode, 403, removed.body);
  assert.match(removed.body, /removed_from_room/);
  const c = await owner(app, 'Stranger');
  const stranger = await search(app, c.key, { room_id: roomId, q: 'launch' });
  assert.equal(stranger.statusCode, 404, stranger.body);
  assert.doesNotMatch(stranger.body, /launch|secret/i);
  // A member that left on its own cannot search either.
  const d = await member(app, link, 'Leaver');
  await ok(app, d.key, 'city_room_leave', { room_id: roomId });
  assert.equal((await search(app, d.key, { room_id: roomId, q: 'launch' })).statusCode, 404);
});

test('the console route: signed-in members, query caps and empty filters', async (t) => {
  const app = await fixture(t);
  const { a, roomId, link } = await room(app, 'full');
  const get = (cookie: string, workspace: string, query: string) =>
    app.inject({
      method: 'GET',
      url: `/api/rooms/${roomId}/search?${query}`,
      headers: { ...jsonHeaders, cookie, 'x-city-workspace': workspace },
    });
  const res = await get(a.cookie, a.id, 'q=launch&sender=&from=&to=&limit=1');
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().results.length, 1);
  assert.ok(res.json().next_cursor);
  const next = await get(a.cookie, a.id, `q=launch&cursor=${res.json().next_cursor}`);
  assert.equal(next.json().results.length, 1);
  assert.equal((await get(a.cookie, a.id, `q=${'x'.repeat(201)}`)).statusCode, 400);
  assert.equal((await get(a.cookie, a.id, 'q=')).statusCode, 400);
  assert.equal((await get(a.cookie, a.id, 'q=launch&cursor=abc')).statusCode, 400);
  const unauthenticated = await app.inject({
    method: 'GET',
    url: `/api/rooms/${roomId}/search?q=launch`,
    headers: jsonHeaders,
  });
  assert.equal(unauthenticated.statusCode, 401);
  const b = await member(app, link, 'Console member');
  assert.equal((await get(b.cookie, b.id, 'q=launch')).json().results.length, 2);
  const c = await owner(app, 'Console stranger');
  assert.equal((await get(c.cookie, c.id, 'q=launch')).statusCode, 404);
});

test('searches are rate limited per credential', async (t) => {
  const app = await fixture(t, { rooms: { searchesPerMinute: 2 } });
  const { a, roomId } = await room(app, 'full');
  for (let i = 0; i < 2; i++)
    assert.equal((await search(app, a.key, { room_id: roomId, q: 'launch' })).statusCode, 200);
  const limited = await search(app, a.key, { room_id: roomId, q: 'launch' });
  assert.equal(limited.statusCode, 429, limited.body);
  // Another credential of the same workspace has its own budget.
  const other = await app.inject({
    method: 'POST',
    url: '/api/workspace-keys',
    headers: { ...jsonHeaders, cookie: a.cookie, 'x-city-workspace': a.id },
    payload: JSON.stringify({ label: 'second key', scopes: [...ASSISTANT_SCOPES] }),
  });
  assert.equal(other.statusCode, 201, other.body);
  const key = other.json().workspace_key as string;
  assert.equal((await search(app, key, { room_id: roomId, q: 'launch' })).statusCode, 200);
});

test('invited guests search their own room with the room credential (REST and /mcp/open)', async (t) => {
  const app = await fixture(t);
  const { a, roomId } = await room(app, 'from_join');
  const link = await app.inject({
    method: 'POST',
    url: '/api/links',
    headers: { ...jsonHeaders, cookie: a.cookie, 'x-city-workspace': a.id },
    payload: JSON.stringify({ target: 'room', room_id: roomId }),
  });
  assert.equal(link.statusCode, 201, link.body);
  const code = new URL(link.json().url).pathname.split('/').at(-1)!;
  const publicPost = (url: string, body: unknown, extra = {}) =>
    app.inject({
      method: 'POST',
      url,
      headers: { ...jsonHeaders, ...extra },
      payload: JSON.stringify(body),
      remoteAddress: '203.0.113.40',
    });
  const start = await publicPost('/api/public/invites/bootstrap', { code });
  assert.equal(start.statusCode, 200, start.body);
  const joined = await publicPost('/api/public/invites/redeem', {
    code,
    handle: start.json().handle,
    name: 'Invited AI',
  });
  assert.equal(joined.statusCode, 200, joined.body);
  const credential = joined.json().credential as string;
  await post(app, a.key, roomId, 'Guest era: launch checklist posted.');
  const tool = (args: unknown) =>
    publicPost('/api/public/invites/tools/city_room_search', args, {
      authorization: `Bearer ${credential}`,
    });
  const found = await tool({ q: 'launch' });
  assert.equal(found.statusCode, 200, found.body);
  // from_join: the guest finds only what was posted after it joined.
  assert.deepEqual(
    found.json().results.map((r: { snippet: string }) => r.snippet),
    ['Guest era: launch checklist posted.'],
  );
  assert.equal((await tool({ q: 'launch', room_id: randomUUID() })).statusCode, 403);
  // Over /mcp/open with the room credential.
  const rpc = await app.inject({
    method: 'POST',
    url: '/mcp/open',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2025-06-18',
    },
    payload: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'city_room_search',
        arguments: { room_credential: credential, q: 'checklist' },
      },
    }),
    remoteAddress: '203.0.113.41',
  });
  assert.equal(rpc.statusCode, 200, rpc.body);
  assert.match(rpc.body, /launch checklist/);
  assert.doesNotMatch(rpc.body, /"isError":true/);
  // Removed: the credential no longer works for search.
  await ok(app, a.key, 'city_room_remove', { room_id: roomId, agent_id: joined.json().agent_id });
  assert.notEqual((await tool({ q: 'launch' })).statusCode, 200);
});

test('snippet highlights are offsets into plain text', () => {
  assert.deepEqual(highlighted('a \u0001word\u0002 and\n\u0001more\u0002 '), {
    snippet: 'a word and more',
    highlights: [
      [2, 6],
      [11, 15],
    ],
  });
  const long = highlighted(`${'x'.repeat(398)} \u0001hit\u0002 tail`);
  assert.equal(long.snippet.length, 400);
  assert.ok(long.snippet.endsWith('…'));
  assert.deepEqual(
    long.highlights,
    [[399, 399]].filter(([s, e]) => e > s),
  );
});

/**
 * Performance: 50,000 messages in the searched room (and 50,000 in another room) inserted with
 * bulk SQL. Searches go through the GIN index (never a sequential scan of room_messages) and stay
 * within SEARCH_SCALE_BUDGET_MS (default 1,000 ms) on PGlite. SEARCH_SCALE_MESSAGES sets the size.
 */
const SCALE = Number(process.env.SEARCH_SCALE_MESSAGES ?? 50_000);
const BUDGET_MS = Number(process.env.SEARCH_SCALE_BUDGET_MS ?? 1000);
test(`search over ${SCALE} messages uses the index and stays fast`, async (t) => {
  const app = await fixture(t);
  const db = (app as unknown as { city: { db: Database } }).city.db;
  const { a, roomId, hostAgent } = await room(app, 'full');
  const other = await room(app, 'full');
  const words = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel'];
  const fill = async (id: string, sender: string, from: number) => {
    await db.query(
      `INSERT INTO room_messages(room_id,seq,id,sender_agent_id,sender_owner_id,sender_name,sender_owner_label,parts,created_at)
       SELECT $1, $2 + g, gen_random_uuid(), $3, 'synthetic-owner', 'Bulk AI', 'another person',
              jsonb_build_array(jsonb_build_object('type','text','text',
                'message ' || g || ' about ' || ($4::text[])[1 + g % 8] || ' and ' || ($4::text[])[1 + (g / 8) % 8] ||
                CASE WHEN g % 5000 = 0 THEN ' rareword' ELSE '' END)),
              1767225600000 + g * 1000
         FROM generate_series(1, $5::int) AS g`,
      [id, from, sender, words, SCALE],
    );
    await db.query('UPDATE rooms SET next_seq=$2 WHERE id=$1', [id, from + SCALE + 1]);
  };
  await fill(roomId, hostAgent, 3);
  await fill(other.roomId, other.hostAgent, 3);
  await db.query('ANALYZE room_messages');
  const timed = async (args: Record<string, unknown>) => {
    const started = performance.now();
    const body = await ok(app, a.key, 'city_room_search', { room_id: roomId, ...args });
    return { body, ms: performance.now() - started };
  };
  const cases: Array<[string, Record<string, unknown>]> = [
    ['rare word', { q: 'rareword' }],
    ['common word', { q: 'alpha' }],
    ['word in every message', { q: 'message' }],
    ['two words', { q: 'alpha bravo' }],
    ['phrase', { q: '"about charlie"' }],
    ['no match', { q: 'zulu' }],
    [
      'sender and dates',
      { q: 'delta', sender: hostAgent, from: '2026-01-01T03:00:00Z', to: '2026-01-01T06:00:00Z' },
    ],
  ];
  const report: string[] = [];
  for (const [label, args] of cases) {
    await timed(args); // warm
    const { body, ms } = await timed(args);
    report.push(`${label}: ${ms.toFixed(1)} ms, ${body.results.length} results`);
    assert.ok(ms < BUDGET_MS, `${label} took ${ms.toFixed(0)} ms (budget ${BUDGET_MS} ms)`);
    for (const r of body.results) assert.ok(r.seq > 3 || /launch|lunch/i.test(r.snippet));
  }
  const rare = (await timed({ q: 'rareword' })).body;
  assert.equal(rare.results.length, Math.floor(SCALE / 5000));
  // The plans: the GIN index (or the primary key in seq order), never a full scan.
  for (const q of ['rareword', 'alpha', 'alpha bravo', 'message']) {
    const sql = roomSearchSql({
      roomId,
      visibleFrom: 0,
      q,
      before: null,
      sender: null,
      from: null,
      to: null,
      limit: 21,
    });
    const plan = (
      await db.transaction(async (tx) => {
        return tx.query<{ 'QUERY PLAN': string }>(`EXPLAIN ANALYZE ${sql.text}`, sql.params);
      })
    ).rows
      .map((row) => row['QUERY PLAN'])
      .join('\n');
    // With only two rooms, a word in every message of one of them (half the table) is cheaper
    // to read sequentially; every selective search uses an index.
    if (q !== 'message') assert.doesNotMatch(plan, /Seq Scan on room_messages/, plan);
    if (q === 'rareword') assert.match(plan, /room_messages_search/, plan);
    if (/room_messages_search/.test(plan)) assert.match(plan, /Index Cond: \(\(room_id = /, plan);
    report.push(
      `plan for ${q}: ${/room_messages_search/.test(plan) ? 'GIN room_messages_search' : /Seq Scan/.test(plan) ? 'sequential' : 'primary key'}, ${/Execution Time: [\d.]+ ms/.exec(plan)?.[0] ?? ''}`,
    );
  }
  console.info(`[search scale ${SCALE} messages per room]\n${report.join('\n')}`);
});

/**
 * Many rooms: 200 rooms × 500 messages, all with the word "alpha", plus one small room. A search
 * for that common word in the small room reads only the small room's matches through the
 * composite (room_id, search_tsv) index, never the 100,000 matches of the other rooms.
 * The small room has 2,000 messages, 20 with that word.
 */
const ROOMS = Number(process.env.SEARCH_SCALE_ROOMS ?? 200);
const PER_ROOM = Number(process.env.SEARCH_SCALE_PER_ROOM ?? 500);
test(`a common word in a small room among ${ROOMS} busy rooms uses the composite index`, async (t) => {
  const app = await fixture(t);
  const db = (app as unknown as { city: { db: Database } }).city.db;
  const { a, roomId } = await room(app, 'full');
  const owner = (
    await db.query<{ host_owner_id: string }>('SELECT host_owner_id FROM rooms WHERE id=$1', [
      roomId,
    ])
  ).rows[0]!.host_owner_id;
  await db.query(
    `INSERT INTO rooms(id,slug,name,host_owner_id,host_agent_id,member_cap,history,link_ttl_ms,next_seq,created_at,idempotency_key,request_hash)
     SELECT 'busy-' || r, 'busy-room-' || r, 'Busy ' || r, $1, 'bulk-agent', 100, 'full', 60000, $2::int + 1, 1, 'busy-key-' || r, 'h'
       FROM generate_series(1, $3::int) AS r`,
    [owner, PER_ROOM, ROOMS],
  );
  await db.query(
    `INSERT INTO room_messages(room_id,seq,id,sender_agent_id,sender_owner_id,sender_name,sender_owner_label,parts,created_at)
     SELECT 'busy-' || r, g, gen_random_uuid(), 'bulk-agent', 'synthetic-owner', 'Bulk AI', 'another person',
            jsonb_build_array(jsonb_build_object('type','text','text','alpha message ' || g)), 1767225600000 + g
       FROM generate_series(1, $1::int) AS r, generate_series(1, $2::int) AS g`,
    [ROOMS, PER_ROOM],
  );
  // The small room: 2,000 messages, 20 of them with the common word.
  await db.query(
    `INSERT INTO room_messages(room_id,seq,id,sender_agent_id,sender_owner_id,sender_name,sender_owner_label,parts,created_at)
     SELECT $1, 3 + g, gen_random_uuid(), 'bulk-agent', 'synthetic-owner', 'Bulk AI', 'another person',
            jsonb_build_array(jsonb_build_object('type','text','text',
              CASE WHEN g % 100 = 0 THEN 'alpha note ' WHEN g % 100 = 50 THEN 'gamma note ' ELSE 'beta note ' END || g)), 1767225600000 + g
       FROM generate_series(1, 2000) AS g`,
    [roomId],
  );
  await db.query('UPDATE rooms SET next_seq=2004 WHERE id=$1', [roomId]);
  await db.query('ANALYZE room_messages');
  await ok(app, a.key, 'city_room_search', { room_id: roomId, q: 'alpha' }); // warm
  const started = performance.now();
  const found = await ok(app, a.key, 'city_room_search', { room_id: roomId, q: 'alpha' });
  const ms = performance.now() - started;
  assert.equal(found.results.length, 20);
  assert.ok(ms < BUDGET_MS, `took ${ms.toFixed(0)} ms`);
  const index = (
    await db.query<{ def: string }>(
      "SELECT indexdef AS def FROM pg_indexes WHERE indexname='room_messages_search'",
    )
  ).rows[0]!.def;
  assert.match(index, /USING gin \(room_id, search_tsv\)/, index);
  const explain = async (q: string) => {
    const sql = roomSearchSql({
      roomId,
      visibleFrom: 0,
      q,
      before: null,
      sender: null,
      from: null,
      to: null,
      limit: 21,
    });
    return (
      await db.query<{ 'QUERY PLAN': string }>(`EXPLAIN ANALYZE ${sql.text}`, sql.params)
    ).rows
      .map((row) => row['QUERY PLAN'])
      .join('\n');
  };
  // The common word: the planner takes the composite GIN or the room's primary key range, but
  // every scan is bounded to this room (room_id in the index condition), never a full scan.
  const plan = await explain('alpha');
  assert.doesNotMatch(plan, /Seq Scan on room_messages/, plan);
  for (const cond of plan.match(/Index Cond: [^\n]*/g) ?? [])
    assert.match(cond, /room_id = /, cond);
  // A word rare in the city: the composite index, with room_id and the word in one condition.
  const composite = await explain('gamma');
  assert.match(composite, /Bitmap Index Scan on room_messages_search/, composite);
  assert.match(
    composite,
    /Index Cond: \(\(room_id = '[^']+'::text\) AND \(search_tsv @@ '''gamma'''::tsquery\)\)/,
    composite,
  );
  console.info(
    `[search ${ROOMS} rooms × ${PER_ROOM} messages, small room] ${ms.toFixed(1)} ms per call\n--- alpha\n${plan}\n--- gamma\n${composite}`,
  );
});

test('migration 55 makes messages stored before it searchable', async (t) => {
  // The earlier tests created apps, so every migration is registered by now.
  const { PGlite } = await import('@electric-sql/pglite');
  const { listMigrations, runMigrations } = await import('../server/migrations.js');
  const { roomMessageSearchMigration } = await import('../server/rooms/search-schema.js');
  const db = await PGlite.create('memory://');
  t.after(() => db.close());
  await runMigrations(
    db,
    listMigrations().filter((migration) => migration.version < roomMessageSearchMigration.version),
  );
  await db.query(
    `INSERT INTO operators(id,name,name_key,password_hash,salt) VALUES('owner-1','Owner','owner','x','x')`,
  );
  await db.query(
    `INSERT INTO rooms(id,slug,name,host_owner_id,host_agent_id,member_cap,history,link_ttl_ms,created_at,idempotency_key,request_hash)
     VALUES('room-1','search-room','Search room','owner-1','agent-1',8,'full',60000,1,'key-1','hash-1')`,
  );
  await db.query(
    `INSERT INTO room_messages(room_id,seq,id,sender_agent_id,sender_owner_id,sender_name,sender_owner_label,parts,created_at)
     VALUES('room-1',1,gen_random_uuid(),'agent-1','owner-1','Agent','Owner',
       '[{"type":"text","text":"Älteres Protokoll"},{"type":"data","data":{"hidden":"word"}},{"type":"text","text":"second part"}]',1)`,
  );
  const result = await runMigrations(db, listMigrations());
  // Later migrations (other features) may apply in the same run; 55 must be among them.
  assert.ok(result.applied.includes(roomMessageSearchMigration.version), String(result.applied));
  const sql = roomSearchSql({
    roomId: 'room-1',
    visibleFrom: 0,
    q: 'älteres part',
    before: null,
    sender: null,
    from: null,
    to: null,
    limit: 5,
  });
  const rows = (await db.query<{ seq: number; snippet: string }>(sql.text, sql.params)).rows;
  assert.equal(rows.length, 1);
  assert.deepEqual(highlighted(rows[0]!.snippet), {
    snippet: 'Älteres Protokoll second part',
    highlights: [
      [0, 7],
      [25, 29],
    ],
  });
  // Data parts are not searchable.
  const data = roomSearchSql({
    roomId: 'room-1',
    visibleFrom: 0,
    q: 'hidden',
    before: null,
    sender: null,
    from: null,
    to: null,
    limit: 5,
  });
  assert.equal((await db.query(data.text, data.params)).rows.length, 0);
});
