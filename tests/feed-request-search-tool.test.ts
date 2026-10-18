import test from 'node:test';
import assert from 'node:assert/strict';
import { ASSISTANT_TOOL_SCOPES } from '../server/assistant-access.js';
import type { Database } from '../server/database.js';
import {
  FEED_REQUEST_TOOLS,
  feedEnabled,
  feedRequestToolAnnotations,
  feedRequestToolDescriptions,
  requestSearchToolInput,
  requestSearchToolOutput,
  runFeedRequestTool,
  toRequestSearchToolOutput,
} from '../server/feed/request-tools.js';
import {
  FEED_BUSY_RETRY_AFTER_S,
  FEED_SEARCH_BUSY_RETRY_AFTER_S,
  FeedBusyError,
} from '../server/feed/busy.js';
import { readFeedRequestQuery } from '../server/feed/requests.js';
import { outageMode } from '../server/rate-limit.js';
import { FeedToolError, feedToolAnnotations } from '../server/feed/tools.js';
import {
  FEED_BUSY_MESSAGE,
  FEED_LIMITS,
  FEED_NETWORK,
  FEED_PATHS,
  FEED_REQUEST_TOOL_NOTICE,
  type FeedRequestPage,
  type FeedRequestQuery,
  type PublicFeedRequest,
  type RequestSearchToolOutput,
} from '../shared/feed.js';
import { ASSISTANT_SCOPES } from '../shared/assistant.js';
import {
  fixture,
  fullFlow,
  mcpCall,
  ORIGIN,
  ownerApi,
  rpcResult,
  type App,
} from './oauth-helpers.js';

/*
 * The Feed's request search tool city_request_search (server/feed/request-tools.ts): signed-in
 * /mcp only, scope workspace:read, listed unless CITY_FEED=0, read-only, and answering exactly
 * what GET /api/public/feed/requests lists (the same list), in snake_case with ISO 8601 times and
 * the untrusted-text notice. End to end through the app on PGlite with requests seeded straight
 * into migration 103's table. Nothing reaches a network; synthetic data only.
 */

const NOW = Date.UTC(2026, 9, 13, 9, 0, 0);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';
const ADDRESS = `0x${'22'.repeat(20)}`;

/** Sets settings for one test only and puts them back afterwards. */
function withEnv(
  t: { after: (fn: () => unknown) => void },
  values: Record<string, string | undefined>,
) {
  const saved = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  const apply = (entries: Record<string, string | undefined>) => {
    for (const [key, value] of Object.entries(entries))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  };
  apply(values);
  t.after(() => apply(saved));
}

/** A valid request id for a small number (FEED_REQUEST_ID). */
const idOf = (n: number) => `req_${'a'.repeat(18)}${BASE32[Math.floor(n / 32)]}${BASE32[n % 32]}`;

/** The fields of PublicFeedRequest, as the public route answers them. */
const PUBLIC_KEYS = [
  'budget',
  'capabilities',
  'closedAt',
  'createdAt',
  'deadline',
  'description',
  'expiresAt',
  'id',
  'postedBy',
  'reply',
  'status',
  'title',
];

function publicRequest(overrides: Partial<PublicFeedRequest> = {}): PublicFeedRequest {
  return {
    id: idOf(1),
    title: 'Translate a menu into Greek',
    description: 'Two pages, plain text.',
    capabilities: ['translate', 'greek'],
    budget: { raw: '25500000', decimals: 6, display: '25.5', asset: 'USDC', network: FEED_NETWORK },
    deadline: NOW + 3 * DAY,
    reply: ADDRESS,
    postedBy: { kind: 'anonymous', displayName: 'Dock office' },
    status: 'open',
    createdAt: NOW - HOUR,
    expiresAt: NOW + 3 * DAY,
    closedAt: null,
    ...overrides,
  };
}

/**
 * What the tool should answer for one request of the public page, written out field by field
 * (not through the module's own mapping), so a mapping that drops or renames a field fails here.
 */
function expected(request: PublicFeedRequest, origin = ORIGIN) {
  assert.deepEqual(Object.keys(request).sort(), PUBLIC_KEYS, 'the public projection changed');
  return {
    origin: 'external',
    id: request.id,
    title: request.title,
    description: request.description,
    capabilities: request.capabilities,
    budget:
      request.budget === null
        ? null
        : {
            raw: request.budget.raw,
            decimals: 6,
            usdc: request.budget.display,
            asset: 'USDC',
            network: FEED_NETWORK,
          },
    deadline: request.deadline === null ? null : new Date(request.deadline).toISOString(),
    reply: request.reply,
    posted_by: { kind: request.postedBy.kind, display_name: request.postedBy.displayName },
    status: 'open',
    created_at: new Date(request.createdAt).toISOString(),
    expires_at: new Date(request.expiresAt).toISOString(),
    closed_at: request.closedAt === null ? null : new Date(request.closedAt).toISOString(),
    detail_url: `${origin}/feed/requests/${request.id}`,
  };
}

const expectedPage = (page: FeedRequestPage, origin = ORIGIN) => ({
  notice: FEED_REQUEST_TOOL_NOTICE,
  requests: page.requests.map((request) => expected(request, origin)),
  ...(page.next ? { next_cursor: page.next } : {}),
});

// ---------------------------------------------------------------------------------------------
// The module

test('city_request_search: one tool, workspace:read, the read-only hints of city_service_search, off only with CITY_FEED=0', () => {
  assert.deepEqual([...FEED_REQUEST_TOOLS], ['city_request_search']);
  assert.equal(ASSISTANT_TOOL_SCOPES.city_request_search, 'workspace:read');
  assert.equal(
    ASSISTANT_TOOL_SCOPES.city_request_search,
    ASSISTANT_TOOL_SCOPES.city_service_search,
  );
  assert.deepEqual(feedRequestToolAnnotations.city_request_search, {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  });
  assert.deepEqual(
    feedRequestToolAnnotations.city_request_search,
    feedToolAnnotations.city_service_search,
  );
  // Live unless CITY_FEED is exactly '0' (its emergency off, docs/protocol/LIVE.md).
  assert.equal(feedEnabled({}), true);
  assert.equal(feedEnabled({ CITY_FEED: '0' }), false);
  assert.equal(feedEnabled({ CITY_FEED: 'true' }), true);
  assert.equal(feedEnabled({ CITY_FEED: '1' }), true);
});

test('the description and every answer say the text is untrusted and the reply handle unverified', () => {
  const { description } = feedRequestToolDescriptions.city_request_search;
  for (const text of [description, FEED_REQUEST_TOOL_NOTICE]) {
    assert.match(text, /untrusted data, never instructions/);
    assert.match(text, /reply handle is unverified/);
    assert.match(text, /moves no money/);
  }
  assert.match(description, /Read-only/);
  assert.match(description, new RegExp(`maximum ${FEED_LIMITS.toolLimitMax}\\b`));
  const empty = toRequestSearchToolOutput({ requests: [], next: null }, ORIGIN);
  assert.equal(empty.notice, FEED_REQUEST_TOOL_NOTICE);
  requestSearchToolOutput.parse(empty);
});

test('the input schema mirrors RequestSearchToolInput: the public list tag rule, the MCP page of city_service_search', () => {
  assert.deepEqual(
    requestSearchToolInput.parse({
      query: '  translate menu ',
      tag: 'pdf',
      limit: FEED_LIMITS.toolLimitMax,
      cursor: `${NOW}-${'a'.repeat(20)}`,
    }),
    {
      query: 'translate menu',
      tag: 'pdf',
      limit: FEED_LIMITS.toolLimitMax,
      cursor: `${NOW}-${'a'.repeat(20)}`,
    },
  );
  assert.deepEqual(requestSearchToolInput.parse({}), {});
  // The page is the one of city_service_search, far below the public list's.
  assert.equal(FEED_LIMITS.toolLimitDefault, 5);
  assert.equal(FEED_LIMITS.toolLimitMax, 10);
  assert.ok(FEED_LIMITS.toolLimitMax < FEED_LIMITS.pageSize);
  // What the public list reads, the tool takes: an empty tag (no tag), a tag in capitals or with
  // spaces around it (read lowercased and trimmed), and queryMax characters of any script.
  for (const fine of [
    { tag: '' },
    { tag: ' PDF ' },
    { query: '' },
    { query: '\u{1F4C4}'.repeat(FEED_LIMITS.queryMax) },
  ])
    assert.equal(requestSearchToolInput.safeParse(fine).success, true, JSON.stringify(fine));
  // A tag the public list refuses (400 invalid_request) is refused here too.
  for (const tag of ['pdf_files', 'pdf!', '-pdf', 'pdf-', 'p'.repeat(33), '  '])
    assert.equal(readFeedRequestQuery({ tag }), null, tag);
  for (const bad of [
    { tag: 'pdf_files' },
    { tag: 'pdf!' },
    { tag: '-pdf' },
    { tag: 'pdf-' },
    { tag: 'p'.repeat(33) },
    { tag: '  ' },
    { tag: 5 },
    { query: 'x'.repeat(FEED_LIMITS.queryMax + 1) },
    { query: '\u{1F4C4}'.repeat(FEED_LIMITS.queryMax + 1) },
    { query: 3 },
    // The old name: unknown, like any other key.
    { q: 'translate' },
    { limit: 0 },
    { limit: FEED_LIMITS.toolLimitMax + 1 },
    { limit: 2.5 },
    // Only a cursor the list wrote; never silently the first page.
    { cursor: 'not a cursor' },
    { cursor: `${NOW}-${'a'.repeat(19)}` },
    { cursor: 'c'.repeat(201) },
    { sort: 'newest' },
  ])
    assert.equal(requestSearchToolInput.safeParse(bad).success, false, JSON.stringify(bad));
});

test('a page maps field for field to snake_case with ISO times, the notice and a detail URL', () => {
  const anonymous = publicRequest();
  const account = publicRequest({
    id: idOf(2),
    title: 'Check a lease for typos',
    capabilities: [],
    budget: null,
    deadline: null,
    reply: null,
    postedBy: { kind: 'account', displayName: null },
    createdAt: NOW - 2 * HOUR,
  });
  const output = toRequestSearchToolOutput(
    {
      requests: [
        anonymous,
        account,
        // A list never carries anything but open requests; if one slipped in, it is left out.
        publicRequest({ id: idOf(3), status: 'held' }),
        publicRequest({ id: idOf(4), status: 'hidden' }),
        publicRequest({ id: idOf(5), status: 'closed', closedAt: NOW }),
      ],
      next: `${NOW - 9 * HOUR}-${'b'.repeat(20)}`,
    },
    'https://centralcity.ai',
  );
  requestSearchToolOutput.parse(output);
  assert.deepEqual(output, {
    requests: [
      expected(anonymous, 'https://centralcity.ai'),
      expected(account, 'https://centralcity.ai'),
    ],
    next_cursor: `${NOW - 9 * HOUR}-${'b'.repeat(20)}`,
    notice: FEED_REQUEST_TOOL_NOTICE,
  });
  assert.deepEqual(output.requests[0], {
    origin: 'external',
    id: idOf(1),
    title: 'Translate a menu into Greek',
    description: 'Two pages, plain text.',
    capabilities: ['translate', 'greek'],
    budget: { raw: '25500000', decimals: 6, usdc: '25.5', asset: 'USDC', network: 'eip155:8453' },
    deadline: new Date(NOW + 3 * DAY).toISOString(),
    reply: ADDRESS,
    posted_by: { kind: 'anonymous', display_name: 'Dock office' },
    status: 'open',
    created_at: new Date(NOW - HOUR).toISOString(),
    expires_at: new Date(NOW + 3 * DAY).toISOString(),
    closed_at: null,
    detail_url: `https://centralcity.ai/feed/requests/${idOf(1)}`,
  });
  // The last page has no next_cursor at all.
  const last = toRequestSearchToolOutput({ requests: [anonymous], next: null }, ORIGIN);
  assert.equal(Object.hasOwn(last, 'next_cursor'), false);
  // The notice comes first, before any poster text; each request is marked as outside text.
  assert.equal(Object.keys(output)[0], 'notice');
  assert.equal(Object.keys(output.requests[0]!)[0], 'origin');
});

test('runFeedRequestTool hands the list the query the public route reads and its own page size', async () => {
  const calls: Array<[FeedRequestQuery, number | undefined]> = [];
  const requests = {
    list: async (query: FeedRequestQuery, pageSize?: number): Promise<FeedRequestPage> => {
      calls.push([query, pageSize]);
      return { requests: [publicRequest()], next: null };
    },
  };
  const caller = { origin: ORIGIN };
  const output = await runFeedRequestTool({ requests }, 'city_request_search', undefined, caller);
  assert.deepEqual(output, expectedPage({ requests: [publicRequest()], next: null }));
  const cursor = `${NOW}-${'a'.repeat(20)}`;
  const args = { query: '  Translate   the menu ', tag: ' PDF ', cursor };
  await runFeedRequestTool({ requests }, 'city_request_search', { ...args, limit: 3 }, caller);
  assert.deepEqual(calls, [
    // The default page is city_service_search's, never the public list's.
    [{ q: '', tag: null, cursor: null }, FEED_LIMITS.toolLimitDefault],
    // Exactly what the public route reads from the same q, tag and cursor.
    [readFeedRequestQuery({ q: args.query, tag: args.tag, cursor }), 3],
  ]);
  assert.deepEqual(calls[1]![0], { q: 'Translate the menu', tag: 'pdf', cursor });
  // Arguments it cannot read never reach the list.
  for (const bad of [{ tag: 'pdf!' }, { cursor: 'not a cursor' }])
    await assert.rejects(runFeedRequestTool({ requests }, 'city_request_search', bad, caller), {
      name: 'ZodError',
    });
  assert.equal(calls.length, 2);
});

// ---------------------------------------------------------------------------------------------
// Through the app

interface Seed {
  n: number;
  state?: 'open' | 'held' | 'closed' | 'expired' | 'removed';
  title: string;
  description?: string;
  capabilities?: string[];
  budgetRaw?: string;
  deadline?: number;
  reply?: string;
  posterKind?: 'anonymous' | 'account' | 'agent';
  displayName?: string;
  heldReason?: 'honeypot' | 'blocked' | 'risk' | 'spread';
  hiddenAt?: number;
  createdAt: number;
  expiresAt: number;
  closedAt?: number;
}

async function seed(db: Database, rows: Seed[]) {
  for (const row of rows) {
    const id = idOf(row.n);
    await db.query(
      `INSERT INTO feed_requests (id, state, title, description, capabilities, budget_raw,
         deadline_at, reply, poster_kind, display_name, poster_key, source_hash, site_hash,
         content_key, title_key, manage_hash, idempotency_hash, held_reason, hidden_at,
         report_count, created_at, expires_at, closed_at)
       VALUES ($1,$2,$3,$4,$5::text[],$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,
         $22,$23)`,
      [
        id,
        row.state ?? 'open',
        row.title,
        row.description ?? `Details for ${row.title}.`,
        row.capabilities ?? [],
        row.budgetRaw ?? null,
        row.deadline ?? null,
        row.reply ?? null,
        row.posterKind ?? 'anonymous',
        row.displayName ?? null,
        `src:source-${row.n}`,
        `source-${row.n}`,
        `site-${row.n}`,
        `content-${row.n}`,
        `title-${row.n}`,
        `manage-${row.n}`,
        `idempotency-${row.n}`,
        row.heldReason ?? null,
        row.hiddenAt ?? null,
        row.hiddenAt ? 3 : 0,
        row.createdAt,
        row.expiresAt,
        row.closedAt ?? null,
      ],
    );
  }
}

/** Ids of every request the public list must never show. */
const UNLISTED = [101, 102, 103, 104, 105, 106].map(idOf);

/**
 * 30 open requests a minute apart (every third tagged pdf, every fifth about translation), and
 * newer than all of them, one of each state the list hides, all matching the same q and tag.
 */
function seeds(now: number): Seed[] {
  const open: Seed[] = Array.from({ length: 30 }, (_, i) => ({
    n: i + 1,
    title: i % 5 === 0 ? `Translate document number ${i + 1}` : `Summarize invoice number ${i + 1}`,
    capabilities: i % 3 === 0 ? ['pdf', 'summaries'] : ['summaries'],
    ...(i % 4 === 0 ? { budgetRaw: String((i + 1) * 1_000_000) } : {}),
    ...(i % 6 === 0 ? { deadline: now + 2 * DAY } : {}),
    ...(i % 7 === 0 ? { reply: ADDRESS } : {}),
    ...(i % 2 === 0
      ? { posterKind: 'anonymous' as const, displayName: `Poster ${i + 1}` }
      : { posterKind: i % 3 === 1 ? ('account' as const) : ('agent' as const) }),
    createdAt: now - (i + 10) * MINUTE,
    expiresAt: now + 14 * DAY,
  }));
  const hiddenOnes: Seed = {
    n: 0,
    title: 'Translate a pdf that is held',
    capabilities: ['pdf'],
    reply: ADDRESS,
    createdAt: now - MINUTE,
    expiresAt: now + 14 * DAY,
  };
  return [
    ...open,
    { ...hiddenOnes, n: 101, state: 'held', heldReason: 'risk' },
    { ...hiddenOnes, n: 102, title: 'Translate a pdf that is hidden', hiddenAt: now - MINUTE },
    {
      ...hiddenOnes,
      n: 103,
      title: 'Translate a pdf that is closed',
      state: 'closed',
      closedAt: now - MINUTE,
    },
    {
      ...hiddenOnes,
      n: 104,
      title: 'Translate a pdf that expired',
      state: 'expired',
      closedAt: now - MINUTE,
    },
    // Still 'open' in the table, but past its expiry: the list leaves it out.
    { ...hiddenOnes, n: 105, title: 'Translate a pdf past expiry', expiresAt: now - MINUTE },
    { ...hiddenOnes, n: 106, title: 'Translate a pdf that was removed', state: 'removed' },
  ];
}

type ToolResult = {
  isError?: boolean;
  structuredContent?: any;
  content: { type: string; text: string }[];
};
async function callTool(app: App, token: string, args: unknown, url = '/mcp') {
  const res =
    url === '/mcp'
      ? await mcpCall(app, token, 'tools/call', { name: 'city_request_search', arguments: args })
      : await app.inject({
          method: 'POST',
          url,
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
          },
          payload: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: { name: 'city_request_search', arguments: args },
          }),
        });
  assert.equal(res.statusCode, 200, res.body);
  return rpcResult(res.body);
}
const toolError = (result: ToolResult) => JSON.parse(result.content[0]!.text).error;
async function listed(app: App, token: string | undefined, url = '/mcp') {
  const res =
    url === '/mcp'
      ? await mcpCall(app, token, 'tools/list')
      : await app.inject({
          method: 'POST',
          url,
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
          },
          payload: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
        });
  assert.equal(res.statusCode, 200, res.body);
  return rpcResult(res.body).result.tools as Array<{
    name: string;
    annotations: Record<string, unknown>;
    securitySchemes?: unknown;
    inputSchema: any;
    outputSchema: any;
  }>;
}

/** A grant holding workspace:read only: the least any grant or key has. */
const readOnlyGrant = async (app: App) =>
  (await fullFlow(app, { scope: 'workspace:read', scopes: [] })).tokens.access_token;

/** A workspace:read bearer grant for the REST tool transport (/api/assistant/tools/:tool). */
async function restGrant(app: App, cookie: string) {
  const grant = await ownerApi(app, cookie, '/api/assistant-access', {
    label: 'Feed request search grant',
    scopes: ['workspace:read'],
    expiresInDays: 1,
  });
  assert.equal(grant.statusCode, 201, grant.body);
  return grant.json().token as string;
}

function rest(app: App, token: string, args: unknown) {
  return app.inject({
    method: 'POST',
    url: '/api/assistant/tools/city_request_search',
    headers: {
      'content-type': 'application/json',
      'x-city-request': '1',
      authorization: `Bearer ${token}`,
    },
    payload: JSON.stringify(args),
  });
}

/** The public list exactly as GET /api/public/feed/requests answers it. */
async function publicList(app: App, params: Record<string, string> = {}) {
  const res = await app.inject({
    url: `${FEED_PATHS.requests}${Object.keys(params).length ? `?${new URLSearchParams(params)}` : ''}`,
  });
  assert.equal(res.statusCode, 200, res.body);
  return res.json() as FeedRequestPage;
}

test('the same not_found as city_service_search with CITY_FEED off; on, listed for every signed-in grant, never on /mcp/open', async (t) => {
  withEnv(t, { CITY_FEED: '0', CITY_INVITE_FLOW: '1' });
  const { app, cookie } = await fixture(t);
  const { tokens } = await fullFlow(app, {
    scope: ASSISTANT_SCOPES.join(' '),
    scopes: [...ASSISTANT_SCOPES],
  });
  const every = tokens.access_token;
  const restToken = await restGrant(app, cookie);
  // Off: neither Feed tool is listed, and a call to either answers the same "not found".
  const tools = await listed(app, every);
  for (const name of ['city_request_search', 'city_service_search'])
    assert.ok(!tools.some((tool) => tool.name === name), name);
  const off = await callTool(app, every, {});
  assert.equal(off.result, undefined, JSON.stringify(off));
  assert.equal(off.error?.code, -32602, JSON.stringify(off));
  assert.match(off.error?.message, /city_request_search not found/);
  const service = rpcResult(
    (
      await mcpCall(app, every, 'tools/call', {
        name: 'city_service_search',
        arguments: { query: 'extract pdf' },
      })
    ).body,
  );
  assert.equal(service.error?.code, off.error?.code);
  assert.equal(
    service.error?.message.replace('city_service_search', 'city_request_search'),
    off.error?.message,
  );
  // The REST transport: the same 404 as city_service_search.
  const restOff = await rest(app, restToken, {});
  assert.equal(restOff.statusCode, 404);
  const serviceOff = await app.inject({
    method: 'POST',
    url: '/api/assistant/tools/city_service_search',
    headers: {
      'content-type': 'application/json',
      'x-city-request': '1',
      authorization: `Bearer ${restToken}`,
    },
    payload: JSON.stringify({ query: 'extract pdf' }),
  });
  assert.equal(serviceOff.statusCode, 404);
  assert.deepEqual(restOff.json(), serviceOff.json());

  process.env.CITY_FEED = '1';
  const on = await listed(app, every);
  const tool = on.find((item) => item.name === 'city_request_search');
  assert.ok(tool, 'listed with CITY_FEED=1');
  const { title, ...hints } = tool.annotations;
  assert.equal(title, 'Search requests');
  assert.deepEqual(hints, feedRequestToolAnnotations.city_request_search);
  assert.deepEqual(tool.securitySchemes, [{ type: 'oauth2', scopes: ['workspace:read'] }]);
  assert.equal(tool.inputSchema.type, 'object');
  assert.equal(tool.inputSchema.required, undefined, 'every input is optional');
  assert.deepEqual(Object.keys(tool.inputSchema.properties).sort(), [
    'cursor',
    'limit',
    'query',
    'tag',
  ]);
  assert.equal(tool.inputSchema.properties.limit.maximum, FEED_LIMITS.toolLimitMax);
  assert.equal(tool.outputSchema.type, 'object');
  // The least grant (workspace:read only) sees it too.
  const reader = await readOnlyGrant(app);
  assert.ok((await listed(app, reader)).some((item) => item.name === 'city_request_search'));
  // Never on the anonymous endpoint.
  const open = await listed(app, undefined, '/mcp/open');
  assert.ok(open.length > 0);
  assert.ok(!open.some((item) => item.name === 'city_request_search'));
  const anonymous = await callTool(app, '', {}, '/mcp/open');
  assert.equal(anonymous.result, undefined, JSON.stringify(anonymous));
  assert.equal(anonymous.error?.code, -32602, JSON.stringify(anonymous));
  assert.match(anonymous.error?.message, /city_request_search not found/);
  // On, both transports run it.
  const found = (await callTool(app, reader, {})).result as ToolResult;
  assert.ok(!found.isError, JSON.stringify(found.content));
  assert.equal((await rest(app, restToken, {})).statusCode, 200);
});

/**
 * The first `limit` requests of a public page as the tool answers them: next_cursor continues right
 * after the last one shown (the list's own keyset cursor).
 */
function expectedFirst(page: FeedRequestPage, limit: number) {
  const shown = page.requests.slice(0, limit);
  const last = shown[shown.length - 1];
  const more = shown.length < page.requests.length || page.next !== null;
  return expectedPage({
    requests: shown,
    next: more && last ? `${last.createdAt}-${last.id.slice(4)}` : null,
  });
}

test('a workspace:read grant reads exactly the public list: the same requests, order, fields and cursors', async (t) => {
  withEnv(t, { CITY_FEED: '1' });
  const { app, cookie } = await fixture(t);
  const db = app.city.db;
  await seed(db, seeds(Date.now()));
  // Marker owner and agent ids on every row: neither may ever reach an answer.
  const owner = (await db.query<{ id: string }>('SELECT id FROM operators LIMIT 1')).rows[0]!.id;
  const AGENT = 'agent-marker-q7v2';
  await db.query('UPDATE feed_requests SET owner_id=$1, agent_id=$2', [owner, AGENT]);
  const token = await readOnlyGrant(app);
  const restToken = await restGrant(app, cookie);

  const first = await publicList(app);
  assert.equal(first.requests.length, FEED_LIMITS.pageSize);
  assert.ok(first.next);
  const second = await publicList(app, { cursor: first.next });
  assert.equal(second.requests.length, 30 - FEED_LIMITS.pageSize);
  assert.equal(second.next, null);
  const max = FEED_LIMITS.toolLimitMax;
  const cases: Array<[Record<string, string | number>, ReturnType<typeof expectedPage>]> = [
    // No limit: the default page of city_service_search.
    [{}, expectedFirst(first, FEED_LIMITS.toolLimitDefault)],
    [{ limit: max }, expectedFirst(first, max)],
    [{ cursor: first.next, limit: max }, expectedFirst(second, max)],
    [
      { query: 'translate', limit: max },
      expectedFirst(await publicList(app, { q: 'translate' }), max),
    ],
    [{ tag: 'pdf', limit: max }, expectedFirst(await publicList(app, { tag: 'pdf' }), max)],
    [
      { query: 'Translate', tag: 'PDF', limit: max },
      expectedFirst(await publicList(app, { q: 'Translate', tag: 'PDF' }), max),
    ],
    [{ query: 'nothing like this' }, expectedPage({ requests: [], next: null })],
  ];
  assert.ok(cases[3]![1].requests.length > 0 && cases[4]![1].requests.length > 0);
  for (const [args, page] of cases) {
    const result = (await callTool(app, token, args)).result as ToolResult;
    assert.ok(!result.isError, JSON.stringify(result.content));
    // The answer itself, not a schema-parsed copy: a leaked key fails here.
    assert.deepEqual(result.structuredContent, page, JSON.stringify(args));
    assert.deepEqual(JSON.parse(result.content[0]!.text), result.structuredContent);
    // The warning comes first, and every request is marked as outside text.
    assert.equal(Object.keys(result.structuredContent)[0], 'notice');
    assert.ok(result.content[0]!.text.startsWith('{"notice":'), result.content[0]!.text);
    for (const request of result.structuredContent.requests)
      assert.equal(Object.keys(request)[0], 'origin');
    // Held, hidden, closed, expired and removed requests never show, and nothing internal does.
    for (const id of UNLISTED) assert.ok(!result.content[0]!.text.includes(id), id);
    assert.ok(!result.content[0]!.text.includes(owner));
    assert.ok(!result.content[0]!.text.includes(AGENT));
    assert.doesNotMatch(
      result.content[0]!.text,
      /source|site|manage|poster_key|content_key|title_key|idempotency|held|hidden|report|owner|agent_id/,
    );
  }
  // The REST transport answers the same.
  const viaRest = await rest(app, restToken, { query: 'translate', tag: 'pdf', limit: max });
  assert.equal(viaRest.statusCode, 200, viaRest.body);
  assert.deepEqual(
    viaRest.json(),
    expectedFirst(await publicList(app, { q: 'translate', tag: 'pdf' }), max),
  );
  assert.ok(!viaRest.body.includes(owner) && !viaRest.body.includes(AGENT));

  // Smaller pages walk the same list: every open request once, newest first.
  const walked: string[] = [];
  let cursor: string | undefined;
  do {
    const result = (await callTool(app, token, { limit: 7, ...(cursor ? { cursor } : {}) }))
      .result as ToolResult;
    const output = result.structuredContent as RequestSearchToolOutput;
    assert.ok(output.requests.length <= 7);
    walked.push(...output.requests.map((item) => item.id));
    cursor = output.next_cursor;
  } while (cursor);
  assert.deepEqual(
    walked,
    [...first.requests, ...second.requests].map((item) => item.id),
  );
});

test('a tag the public list refuses is refused by the tool too; nothing is listed', async (t) => {
  withEnv(t, { CITY_FEED: '1' });
  const { app, cookie } = await fixture(t);
  await seed(app.city.db, seeds(Date.now()));
  const token = await readOnlyGrant(app);
  const restToken = await restGrant(app, cookie);
  for (const tag of ['pdf_files', 'pdf!', '-pdf']) {
    const publicAnswer = await app.inject({
      url: `${FEED_PATHS.requests}?${new URLSearchParams({ tag })}`,
    });
    assert.equal(publicAnswer.statusCode, 400, tag);
    assert.equal(publicAnswer.json().code, 'invalid_request');
    assert.equal(publicAnswer.json().retryable, false);

    const refused = (await callTool(app, token, { tag })).result as ToolResult;
    assert.equal(refused.isError, true, tag);
    assert.equal(refused.structuredContent, undefined);
    const error = toolError(refused);
    assert.equal(error.code, 'invalid_arguments');
    assert.equal(error.retryable, false);
    assert.match(error.message, /tag/);
    assert.equal((await rest(app, restToken, { tag })).statusCode, 400);
  }
  for (const args of [
    { limit: FEED_LIMITS.toolLimitMax + 1 },
    { query: 3 },
    { q: 'translate' },
    { sort: 'newest' },
    // A cursor the list never wrote: refused, never read as the first page.
    { cursor: 'not a cursor' },
  ]) {
    const refused = (await callTool(app, token, args)).result as ToolResult;
    assert.equal(refused.isError, true, JSON.stringify(args));
    assert.equal(toolError(refused).code, 'invalid_arguments');
  }
});

test('each workspace reads at most the public list read cap a minute, across its grants and keys; the public list goes on', async (t) => {
  withEnv(t, { CITY_FEED: '1', CITY_LIMIT_FEED_READS_PER_MINUTE: '3' });
  const { app, cookie } = await fixture(t);
  await seed(app.city.db, seeds(Date.now()));
  const token = await readOnlyGrant(app);
  for (let i = 0; i < 3; i++) {
    const result = (await callTool(app, token, {})).result as ToolResult;
    assert.ok(!result.isError, JSON.stringify(result.content));
  }
  const refused = (await callTool(app, token, { query: 'translate' })).result as ToolResult;
  assert.equal(refused.isError, true);
  assert.equal(refused.structuredContent, undefined);
  assert.equal(toolError(refused).code, 'rate_limited');
  assert.equal(toolError(refused).retryable, true);
  // The bucket is the workspace's: a second grant and a REST key of the same workspace buy no
  // more reads.
  const second = (await callTool(app, await readOnlyGrant(app), {})).result as ToolResult;
  assert.equal(second.isError, true);
  assert.equal(toolError(second).code, 'rate_limited');
  const restToken = await restGrant(app, cookie);
  assert.equal((await rest(app, restToken, {})).statusCode, 429);
  // The public list has a bucket of its own.
  assert.equal((await publicList(app)).requests.length, FEED_LIMITS.pageSize);
  // A limiter outage degrades this bucket (reads go on at a fraction), never fails it closed.
  assert.equal(outageMode('feed-read-owner:ws'), 'degraded');
});

const pgError = (code: string, message: string) => Object.assign(new Error(message), { code });

test('a transient database failure or a slow search becomes the busy tool error of city_service_search, with its wait', async () => {
  const caller = { origin: ORIGIN };
  const failing = (failure: unknown) => ({
    list: async (): Promise<FeedRequestPage> => {
      throw failure;
    },
  });
  for (const failure of [
    pgError('57014', 'canceling statement due to statement timeout'),
    pgError('53300', 'sorry, too many clients already'),
    pgError('40P01', 'deadlock detected'),
    new Error('timeout exceeded when trying to connect'),
  ])
    await assert.rejects(
      runFeedRequestTool({ requests: failing(failure) }, 'city_request_search', {}, caller),
      (error: unknown) => {
        assert.ok(error instanceof FeedToolError, String(error));
        assert.equal(error.errorCode, 'busy');
        assert.equal(error.statusCode, 503);
        assert.equal(error.retryAfterMs, FEED_BUSY_RETRY_AFTER_S * 1000);
        assert.equal(error.message, FEED_BUSY_MESSAGE);
        return true;
      },
    );
  // A text search past its own time limit keeps its longer wait.
  const slow = new FeedBusyError(FEED_SEARCH_BUSY_RETRY_AFTER_S, pgError('57014', 'canceled'));
  await assert.rejects(
    runFeedRequestTool(
      { requests: failing(slow) },
      'city_request_search',
      { query: 'translate' },
      caller,
    ),
    (error: unknown) => {
      assert.ok(error instanceof FeedToolError, String(error));
      assert.equal(error.errorCode, 'busy');
      assert.equal(error.retryAfterMs, FEED_SEARCH_BUSY_RETRY_AFTER_S * 1000);
      return true;
    },
  );
  // Anything else goes on unchanged.
  const broken = new TypeError('rows is undefined');
  await assert.rejects(
    runFeedRequestTool({ requests: failing(broken) }, 'city_request_search', {}, caller),
    (error: unknown) => error === broken,
  );
});

test('under database load the tool answers the retryable busy over MCP and REST; a real error stays internal', async (t) => {
  withEnv(t, { CITY_FEED: '1' });
  const { app, cookie } = await fixture(t);
  await seed(app.city.db, seeds(Date.now()));
  const token = await readOnlyGrant(app);
  const restToken = await restGrant(app, cookie);
  // The list's statements fail as they do under load; the grant checks still answer.
  const db = app.city.db;
  const query = db.query.bind(db);
  const transaction = db.transaction.bind(db);
  let failing: RegExp | null = null;
  let failure: () => Error = () => pgError('57014', 'canceling statement due to statement timeout');
  const fails = (sql: string) => failing !== null && failing.test(sql);
  Object.assign(db, {
    query: (sql: string, params?: unknown[]) =>
      fails(sql) ? Promise.reject(failure()) : query(sql, params),
    transaction: (action: Parameters<Database['transaction']>[0]) =>
      transaction((tx) =>
        action({
          ...tx,
          query: (sql: string, params?: unknown[]) =>
            fails(sql) ? Promise.reject(failure()) : tx.query(sql, params),
        } as typeof tx),
      ),
  });
  const assertBusy = async (args: Record<string, unknown>, retryAfterS: number, what: string) => {
    const busy = (await callTool(app, token, args)).result as ToolResult;
    assert.equal(busy.isError, true, `${what}: ${JSON.stringify(busy)}`);
    assert.equal(busy.structuredContent, undefined, 'never an empty success');
    const error = toolError(busy);
    assert.equal(error.code, 'busy', what);
    assert.equal(error.retryable, true, what);
    assert.equal(error.retry_after_ms, retryAfterS * 1000, what);
    assert.equal(error.message, FEED_BUSY_MESSAGE, what);
    const restBusy = await rest(app, restToken, args);
    assert.equal(restBusy.statusCode, 503, `${what}: ${restBusy.body}`);
    assert.equal(restBusy.headers['retry-after'], String(retryAfterS), what);
    assert.deepEqual(restBusy.json(), { error: FEED_BUSY_MESSAGE, code: 'busy' }, what);
  };

  // Load: every Feed statement fails, transiently.
  failing = /\bfeed_/;
  for (const transient of [
    () => pgError('57014', 'canceling statement due to statement timeout'),
    () => pgError('53300', 'sorry, too many clients already'),
    () => new Error('timeout exceeded when trying to connect'),
  ]) {
    failure = transient;
    await assertBusy({}, FEED_BUSY_RETRY_AFTER_S, transient().message);
  }
  // A text search past its own time limit: busy with the longer wait.
  failing = /to_tsquery/;
  failure = () => pgError('57014', 'canceling statement due to statement timeout');
  await assertBusy({ query: 'translate' }, FEED_SEARCH_BUSY_RETRY_AFTER_S, 'slow search');

  // Anything else is still the generic internal error: not retryable, no wait, no detail.
  failing = /\bfeed_/;
  failure = () => new TypeError('rows is undefined');
  const broken = (await callTool(app, token, {})).result as ToolResult;
  assert.equal(broken.isError, true, JSON.stringify(broken));
  assert.equal(toolError(broken).code, 'internal_error');
  assert.equal(toolError(broken).retryable, false);
  assert.equal(toolError(broken).retry_after_ms, undefined);
  assert.equal(toolError(broken).message, 'The operation could not be completed.');
  const restBroken = await rest(app, restToken, {});
  assert.equal(restBroken.statusCode, 500, restBroken.body);
  assert.equal(restBroken.headers['retry-after'], undefined);

  // The database answers again: so does the tool.
  failing = null;
  const found = (await callTool(app, token, {})).result as ToolResult;
  assert.ok(!found.isError, JSON.stringify(found.content));
  assert.ok(found.structuredContent.requests.length > 0);
});
