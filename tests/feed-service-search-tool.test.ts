import test from 'node:test';
import assert from 'node:assert/strict';
import { ASSISTANT_TOOL_SCOPES } from '../server/assistant-access.js';
import type { Database } from '../server/database.js';
import { FeedQueryError } from '../server/feed/query.js';
import { FEED_SERVICES_SQL } from '../server/feed/services-schema.js';
import { FEED_OFFERS_SQL } from '../server/feed/offers/schema.js';
import {
  FEED_TOOLS,
  FeedToolError,
  feedEnabled,
  feedToolAnnotations,
  feedToolDescriptions,
  runFeedTool,
  serviceSearchToolInput,
  serviceSearchToolOutput,
  toServiceSearchToolOutput,
} from '../server/feed/tools.js';
import { BAZAAR_SOURCE } from '../server/feed/types.js';
import {
  FEED_BUSY_MESSAGE,
  FEED_LIMITS,
  FEED_NETWORK,
  FEED_SOURCE,
  FEED_TOOL_NOT_LISTED,
  FEED_TOOL_NOTICE,
  FEED_USDC,
  type FeedSchemaSummary,
  type FeedService,
  type FeedServiceDetail,
  type FeedServicePage,
  type FeedServiceQuery,
} from '../shared/feed.js';
import { ASSISTANT_SCOPES } from '../shared/assistant.js';
import { describeValidation } from '../server/validation-errors.js';
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
 * The Feed's MCP tool city_service_search (server/feed/tools.ts): signed-in /mcp only, scope
 * workspace:read, listed unless CITY_FEED=0, read-only. The mapping to ServiceSearchToolOutput
 * (snake_case, ISO 8601 times, the notice, detail_url) and the retryable errors, then end to end
 * through the app on PGlite with listings seeded straight into migration 104's tables. Nothing
 * reaches a network; synthetic data only. The app tests switch Feed pay off (CITY_FEED_PAY=0): they
 * read the search's own texts, which Feed pay (live by default) replaces
 * (tests/feed-pay-app.test.ts).
 */

const NOW = Date.UTC(2026, 9, 13, 9, 0, 0);
const HOUR = 3_600_000;
const PAY_TO = `0x${'11'.repeat(20)}` as const;

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

const INPUT_SUMMARY: FeedSchemaSummary = {
  format: 'json',
  fields: [
    { name: 'url', in: 'query', type: 'string', required: true, description: 'The PDF to read.' },
  ],
  more: 0,
  example: '{"url":"https://files.example.com/a.pdf"}',
  exampleState: 'shortened',
};

/** INPUT_SUMMARY in the tool's snake_case. */
const TOOL_INPUT_SUMMARY = {
  format: 'json',
  fields: INPUT_SUMMARY.fields,
  more: 0,
  example: INPUT_SUMMARY.example,
  example_state: 'shortened',
};

/** A summary saved before exampleState existed. */
const OLDER_SUMMARY = { format: 'json', fields: [], more: 0, example: '{"a":1}' };

function service(overrides: Partial<FeedService> = {}): FeedService {
  return {
    id: 'svc_aaaaaaaaaaaaaaaaaaaa',
    kind: 'external_service',
    title: 'PDF text extract',
    capabilities: ['pdf', 'extract'],
    description: 'Extract the text of a PDF.',
    provider: { host: 'pdf.example.com', name: 'PDF text extract' },
    url: 'https://pdf.example.com/api/extract',
    method: 'GET',
    protocol: 'x402',
    x402Version: 2,
    network: FEED_NETWORK,
    asset: FEED_USDC,
    scheme: 'exact',
    price: { raw: '10000', decimals: 6, display: '0.01', unit: 'per_call' },
    payTo: PAY_TO,
    input: INPUT_SUMMARY,
    output: null,
    source: {
      name: FEED_SOURCE.name,
      credit: FEED_SOURCE.credit,
      url: FEED_SOURCE.url,
      recordId: 'https://pdf.example.com/api/extract',
      fetchedAt: NOW - HOUR,
      updatedAt: null,
    },
    usage: {
      paidCalls30d: 120,
      payers30d: 14,
      lastCalledAt: NOW - 2 * HOUR,
      reportedBy: FEED_SOURCE.name,
    },
    lastSeenAt: NOW - HOUR,
    status: 'active',
    moreFromHost: 3,
    ...overrides,
  };
}

function page(overrides: Partial<FeedServicePage> = {}): FeedServicePage {
  return {
    snapshotAt: NOW - HOUR,
    degraded: false,
    sources: [
      {
        name: FEED_SOURCE.name,
        state: 'ok',
        lastSuccessAt: NOW - HOUR,
        lastAttemptAt: NOW - HOUR,
        total: 31_600,
        listed: 1_300,
      },
    ],
    services: [service()],
    next: null,
    total: 1,
    ...overrides,
  };
}

const unusedDb = {} as Database;

// ---------------------------------------------------------------------------------------------
// The module

test('city_service_search: one tool, workspace:read, read-only hints, off only with CITY_FEED=0', () => {
  assert.deepEqual([...FEED_TOOLS], ['city_service_search']);
  assert.equal(ASSISTANT_TOOL_SCOPES.city_service_search, 'workspace:read');
  assert.deepEqual(feedToolAnnotations.city_service_search, {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  });
  // Live unless CITY_FEED is exactly '0' (its emergency off, docs/protocol/LIVE.md).
  assert.equal(feedEnabled({}), true);
  assert.equal(feedEnabled({ CITY_FEED: '0' }), false);
  assert.equal(feedEnabled({ CITY_FEED: 'true' }), true);
  assert.equal(feedEnabled({ CITY_FEED: '1' }), true);
});

test('the input schema mirrors ServiceSearchToolInput and refuses what it cannot read', () => {
  const parsed = serviceSearchToolInput.parse({
    query: '  extract pdf ',
    max_price_usdc: '0.05',
    host: 'PDF.Example.com',
    limit: 10,
    cursor: 'eyJzIjoxLCJvIjo1fQ',
  });
  assert.deepEqual(parsed, {
    query: 'extract pdf',
    max_price_usdc: '0.05',
    host: 'pdf.example.com',
    limit: 10,
    cursor: 'eyJzIjoxLCJvIjo1fQ',
  });
  assert.deepEqual(serviceSearchToolInput.parse({ query: 'ocr' }), { query: 'ocr' });
  // id: a service id or a Feed link to one (any origin), alone; query is then optional.
  const ID = 'svc_aaaaaaaaaaaaaaaaaaaa';
  for (const id of [
    ID,
    ` ${ID} `,
    `https://centralcity.ai/feed/services/${ID}`,
    `https://centralcity.ai/feed/services/${ID}/`,
    `https://centralcity.ai/feed/services/${ID}?ref=chat#top`,
    `http://127.0.0.1:5173/feed/services/${ID}`,
  ])
    assert.equal(serviceSearchToolInput.safeParse({ id }).success, true, id);
  assert.deepEqual(serviceSearchToolInput.parse({ id: ` ${ID} ` }), { id: ID });
  for (const bad of [
    {},
    { limit: 3 },
    { query: 'x' },
    { id: '' },
    { id: 'svc_short' },
    { id: ID.toUpperCase() },
    { id: `${ID}a` },
    { id: `https://centralcity.ai/feed/requests/${ID}` },
    { id: `https://centralcity.ai/feed/services/${ID}/manage` },
    { id: `https://centralcity.ai/api/public/feed/services/${ID}` },
    { id: `ftp://centralcity.ai/feed/services/${ID}` },
    { id: `https://centralcity.ai/feed/services/${ID}`.padEnd(501, '#') },
    // With id the search arguments are refused, never dropped silently.
    { id: ID, query: 'extract pdf' },
    { id: ID, max_price_usdc: '0.05' },
    { id: ID, host: 'pdf.example.com' },
    { id: ID, limit: 1 },
    { id: ID, cursor: 'eyJzIjoxLCJvIjo1fQ' },
    { query: '  x  ' },
    { query: 'x'.repeat(FEED_LIMITS.queryMax + 1) },
    { query: 'ocr', limit: 0 },
    { query: 'ocr', limit: FEED_LIMITS.toolLimitMax + 1 },
    { query: 'ocr', limit: 2.5 },
    { query: 'ocr', max_price_usdc: 'cheap' },
    { query: 'ocr', max_price_usdc: '-1' },
    { query: 'ocr', max_price_usdc: '0.0000001' },
    { query: 'ocr', max_price_usdc: '1e30' },
    { query: 'ocr', max_price_usdc: '99999999999999999' },
    { query: 'ocr', host: 'localhost' },
    { query: 'ocr', host: 'https://pdf.example.com/' },
    { query: 'ocr', cursor: 'not a cursor' },
    { query: 'ocr', sort: 'cheapest' },
  ])
    assert.equal(serviceSearchToolInput.safeParse(bad).success, false, JSON.stringify(bad));

  // The caller reads why (the message both transports answer with), never just "is not valid":
  // id with search arguments is one issue on id that names both ways out.
  const why = (args: unknown) => {
    const parsed = serviceSearchToolInput.safeParse(args);
    assert.equal(parsed.success, false, JSON.stringify(args));
    return describeValidation(parsed.error!).message;
  };
  const alone = 'leave out id to search instead';
  assert.equal(
    why({ id: ID, query: 'extract pdf' }),
    `Check these fields: id (must be sent without query; ${alone}).`,
  );
  assert.equal(
    why({ id: ID, host: 'pdf.example.com', limit: 1, cursor: 'eyJzIjoxLCJvIjo1fQ' }),
    `Check these fields: id (must be sent without host, limit, cursor; ${alone}).`,
  );
  assert.equal(
    why({ id: ID, query: 'x' }),
    `Check these fields: query (too short, at least 2 characters), id (must be sent without query; ${alone}).`,
  );
  assert.equal(
    why({ id: 'svc_short' }),
    'Check these fields: id (must be a service id, svc_ and 20 characters, or a Feed link to one).',
  );
  assert.equal(
    why({ query: 'ocr', max_price_usdc: 'cheap' }),
    'Check these fields: max_price_usdc (must be USDC as a decimal string from 0 to 999999999.999999 with at most 6 decimals, such as "0.05").',
  );
  // Too large says what the largest accepted amount is.
  assert.equal(
    why({ query: 'ocr', max_price_usdc: '1e30' }),
    'Check these fields: max_price_usdc (must be USDC as a decimal string from 0 to 999999999.999999 with at most 6 decimals, such as "0.05").',
  );
  assert.equal(
    why({ query: 'ocr', host: 'localhost' }),
    'Check these fields: host (must be a host name such as "api.example.com").',
  );
  assert.equal(why({ limit: 3 }), 'Check these fields: query (required).');
  // One-letter words pass the schema (two characters in all); the search drops them beside
  // other words.
  assert.deepEqual(serviceSearchToolInput.parse({ query: 'a b' }), { query: 'a b' });
});

test('a page maps to snake_case with ISO times, the notice and a detail URL on the caller origin', () => {
  const output = toServiceSearchToolOutput(
    page({
      next: 'eyJzIjoxLCJvIjo1fQ',
      services: [
        service(),
        service({
          id: 'svc_bbbbbbbbbbbbbbbbbbbb',
          provider: { host: 'docs.example.net', name: null },
          url: 'https://docs.example.net/v1/tables',
          x402Version: 1,
          method: null,
          scheme: 'upto',
          price: null,
          input: null,
          usage: {
            paidCalls30d: null,
            payers30d: null,
            lastCalledAt: null,
            reportedBy: FEED_SOURCE.name,
          },
          status: 'stale',
          moreFromHost: 0,
        }),
        // A list never carries a withdrawn listing; if one slipped in, the tool leaves it out.
        service({ id: 'svc_cccccccccccccccccccc', status: 'withdrawn' }),
      ],
    }),
    'https://centralcity.ai',
  );
  // The output schema keeps example_state and refuses a state it does not know.
  assert.deepEqual(serviceSearchToolOutput.parse(output), output);
  const unknownState = structuredClone(output);
  (unknownState.services[0].input as unknown as Record<string, unknown>).example_state = 'cut';
  assert.equal(serviceSearchToolOutput.safeParse(unknownState).success, false);
  assert.equal(output.notice, FEED_TOOL_NOTICE);
  assert.equal(output.next_cursor, 'eyJzIjoxLCJvIjo1fQ');
  assert.equal(output.snapshot_at, new Date(NOW - HOUR).toISOString());
  assert.equal(output.degraded, false);
  assert.deepEqual(output.sources, [
    { name: 'x402 Bazaar', state: 'ok', last_success_at: new Date(NOW - HOUR).toISOString() },
  ]);
  assert.deepEqual(
    output.services.map((item) => item.id),
    ['svc_aaaaaaaaaaaaaaaaaaaa', 'svc_bbbbbbbbbbbbbbbbbbbb'],
  );
  assert.deepEqual(output.services[0], {
    id: 'svc_aaaaaaaaaaaaaaaaaaaa',
    kind: 'external_service',
    title: 'PDF text extract',
    capabilities: ['pdf', 'extract'],
    description: 'Extract the text of a PDF.',
    provider_host: 'pdf.example.com',
    provider_name: 'PDF text extract',
    url: 'https://pdf.example.com/api/extract',
    api_url: 'https://pdf.example.com/api/extract',
    method: 'GET',
    x402_version: 2,
    network: 'eip155:8453',
    asset: { address: FEED_USDC.address, symbol: 'USDC', decimals: 6 },
    scheme: 'exact',
    price: { raw: '10000', decimals: 6, usdc: '0.01', unit: 'per_call' },
    pay_to: PAY_TO,
    // The summary in the tool's snake_case: example_state says the example was shortened.
    input: TOOL_INPUT_SUMMARY,
    output: null,
    usage: {
      paid_calls_30d: 120,
      payers_30d: 14,
      last_called_at: new Date(NOW - 2 * HOUR).toISOString(),
      reported_by: 'x402 Bazaar',
    },
    source: {
      name: 'x402 Bazaar',
      credit: 'Listed by x402 Bazaar',
      url: FEED_SOURCE.url,
      record_id: 'https://pdf.example.com/api/extract',
      fetched_at: new Date(NOW - HOUR).toISOString(),
    },
    status: 'active',
    last_seen_at: new Date(NOW - HOUR).toISOString(),
    more_from_host: 3,
    detail_url: 'https://centralcity.ai/feed/services/svc_aaaaaaaaaaaaaaaaaaaa',
  });
  // Every result names the endpoint to call (the listed URL, never the Feed page), its x402
  // version and the source credit in words.
  const other = output.services[1]!;
  assert.equal(other.api_url, 'https://docs.example.net/v1/tables');
  assert.equal(other.api_url, other.url);
  assert.notEqual(other.api_url, other.detail_url);
  assert.equal(other.x402_version, 1);
  for (const item of output.services) {
    assert.equal(item.source.credit, 'Listed by x402 Bazaar');
    assert.equal(item.source.credit, FEED_SOURCE.credit);
  }
  // Unknown stays unknown: null, never a guessed value.
  const unknown = output.services[1]!;
  assert.equal(unknown.price, null);
  assert.equal(unknown.method, null);
  assert.equal(unknown.provider_name, null);
  assert.deepEqual(unknown.usage, {
    paid_calls_30d: null,
    payers_30d: null,
    last_called_at: null,
    reported_by: 'x402 Bazaar',
  });
  assert.equal(unknown.status, 'stale');
  // The last page has no next_cursor at all; before the first sweep snapshot_at is null.
  const last = toServiceSearchToolOutput(
    page({ next: null, snapshotAt: null, degraded: true, services: [] }),
    'http://localhost',
  );
  serviceSearchToolOutput.parse(last);
  assert.equal(Object.hasOwn(last, 'next_cursor'), false);
  assert.equal(last.snapshot_at, null);
  assert.equal(last.degraded, true);
});

test('runFeedTool hands the search a relevance query, the tool limit and the clock', async () => {
  const calls: Array<{ query: FeedServiceQuery; options: { limit: number; now: number } }> = [];
  const search = async (
    _db: unknown,
    query: FeedServiceQuery,
    options: { limit: number; now: number },
  ) => {
    calls.push({ query, options });
    return page();
  };
  const deps = { db: unusedDb, now: () => NOW, search };
  const caller = { origin: 'https://centralcity.ai' };
  const output = await runFeedTool(deps, 'city_service_search', { query: 'extract pdf' }, caller);
  serviceSearchToolOutput.parse(output);
  await runFeedTool(
    deps,
    'city_service_search',
    {
      query: ' ocr   scan ',
      max_price_usdc: '0.05',
      host: 'OCR.Example.org',
      limit: 2,
      cursor: 'eyJzIjoxLCJvIjo1fQ',
    },
    caller,
  );
  assert.deepEqual(calls, [
    {
      query: { q: 'extract pdf', maxPrice: null, sort: 'relevance', host: null, cursor: null },
      options: { limit: FEED_LIMITS.toolLimitDefault, now: NOW },
    },
    {
      query: {
        q: 'ocr scan',
        maxPrice: '50000',
        sort: 'relevance',
        host: 'ocr.example.org',
        cursor: 'eyJzIjoxLCJvIjo1fQ',
      },
      options: { limit: 2, now: NOW },
    },
  ]);
  // Arguments are checked before anything is searched (the REST transport gets the same).
  await assert.rejects(
    runFeedTool(deps, 'city_service_search', { query: 'x' }, caller),
    (error: unknown) => error instanceof Error && error.name === 'ZodError',
  );
  assert.equal(calls.length, 2);
});

test('runFeedTool with id reads that one service; unknown, hidden and withdrawn answer the same empty result', async () => {
  const freshness = (({ snapshotAt, degraded, sources }) => ({ snapshotAt, degraded, sources }))(
    page(),
  );
  const looked: string[] = [];
  const detail = async (_db: unknown, id: string, now: number) => {
    assert.equal(now, NOW);
    looked.push(id);
    if (id === 'svc_aaaaaaaaaaaaaaaaaaaa') return { ...freshness, service: service() };
    // Its detail route still answers a withdrawn one within the tombstone; the tool does not.
    if (id === 'svc_wwwwwwwwwwwwwwwwwwww')
      return { ...freshness, service: service({ id, status: 'withdrawn' }) };
    return null;
  };
  const deps = {
    db: unusedDb,
    now: () => NOW,
    search: async () => assert.fail('an id is never searched'),
    detail,
    freshness: async () => freshness,
  };
  const caller = { origin: 'https://centralcity.ai' };
  const expected = toServiceSearchToolOutput(
    page({ next: 'ignored', services: [service()] }),
    caller.origin,
  );
  delete expected.next_cursor;
  for (const id of [
    'svc_aaaaaaaaaaaaaaaaaaaa',
    'https://centralcity.ai/feed/services/svc_aaaaaaaaaaaaaaaaaaaa',
    'http://localhost:5173/feed/services/svc_aaaaaaaaaaaaaaaaaaaa/',
  ]) {
    const output = await runFeedTool(deps, 'city_service_search', { id }, caller);
    serviceSearchToolOutput.parse(output);
    assert.deepEqual(output, expected, id);
    assert.equal(Object.hasOwn(output, 'message'), false);
    assert.equal(output.services[0]!.source.credit, FEED_SOURCE.credit);
  }
  // One answer for every id that is not listed: no service, the freshness and the same message.
  for (const id of ['svc_wwwwwwwwwwwwwwwwwwww', 'svc_zzzzzzzzzzzzzzzzzzzz']) {
    const output = await runFeedTool(deps, 'city_service_search', { id }, caller);
    serviceSearchToolOutput.parse(output);
    assert.deepEqual(output, {
      services: [],
      snapshot_at: new Date(NOW - HOUR).toISOString(),
      degraded: false,
      sources: [
        { name: 'x402 Bazaar', state: 'ok', last_success_at: new Date(NOW - HOUR).toISOString() },
      ],
      notice: FEED_TOOL_NOTICE,
      message: FEED_TOOL_NOT_LISTED,
    });
  }
  assert.deepEqual(looked, [
    'svc_aaaaaaaaaaaaaaaaaaaa',
    'svc_aaaaaaaaaaaaaaaaaaaa',
    'svc_aaaaaaaaaaaaaaaaaaaa',
    'svc_wwwwwwwwwwwwwwwwwwww',
    'svc_zzzzzzzzzzzzzzzzzzzz',
  ]);
  // Before the first complete sweep: the retryable source_unavailable, as for a search.
  await assert.rejects(
    runFeedTool(
      {
        ...deps,
        detail: async () => {
          throw new FeedQueryError('source_unavailable', 'internal wording');
        },
      },
      'city_service_search',
      { id: 'svc_aaaaaaaaaaaaaaaaaaaa' },
      caller,
    ),
    (error: unknown) => error instanceof FeedToolError && error.errorCode === 'source_unavailable',
  );
});

test('the description says what the Feed is and that calling or paying a service is the caller’s own', () => {
  const { description } = feedToolDescriptions.city_service_search;
  assert.ok(description.startsWith('Search the Central City Feed'), description);
  assert.match(description, /not Central City agents/);
  assert.match(description, /Nothing is paid through the Feed/);
  assert.match(description, /your own x402 client and wallet, outside Central City/);
  assert.match(description, /\bapi_url\b/);
  assert.match(description, /\bx402_version\b/);
  assert.match(description, /\bid\b/);
});

test('cursor_stale and source_unavailable become retryable tool errors with their contract status', async () => {
  for (const [code, status] of [
    ['cursor_stale', 409],
    ['source_unavailable', 503],
  ] as const) {
    const search = async () => {
      throw new FeedQueryError(code, 'internal wording');
    };
    await assert.rejects(
      runFeedTool(
        { db: unusedDb, search },
        'city_service_search',
        { query: 'extract pdf' },
        { origin: 'https://centralcity.ai' },
      ),
      (error: unknown) => {
        assert.ok(error instanceof FeedToolError);
        assert.equal(error.errorCode, code);
        assert.equal(error.statusCode, status);
        assert.doesNotMatch(error.message, /internal wording/);
        return true;
      },
    );
  }
  // Anything else is not the tool's to translate.
  const broken = new Error('connection lost');
  await assert.rejects(
    runFeedTool(
      {
        db: unusedDb,
        search: async () => {
          throw broken;
        },
      },
      'city_service_search',
      { query: 'extract pdf' },
      { origin: 'https://centralcity.ai' },
    ),
    (error: unknown) => error === broken,
  );
});

const pgError = (code: string, message: string) => Object.assign(new Error(message), { code });

test('a transient database failure becomes the retryable busy tool error, with its wait', async () => {
  for (const failure of [
    pgError('57014', 'canceling statement due to statement timeout'),
    pgError('53300', 'sorry, too many clients already'),
    pgError('40P01', 'deadlock detected'),
    new Error('timeout exceeded when trying to connect'),
  ]) {
    const search = async (): Promise<never> => {
      throw failure;
    };
    await assert.rejects(
      runFeedTool(
        { db: unusedDb, search },
        'city_service_search',
        { query: 'extract pdf' },
        { origin: 'https://centralcity.ai' },
      ),
      (error: unknown) => {
        assert.ok(error instanceof FeedToolError, String(error));
        assert.equal(error.errorCode, 'busy');
        assert.equal(error.statusCode, 503);
        assert.equal(error.retryAfterMs, 5_000);
        assert.equal(error.message, FEED_BUSY_MESSAGE);
        return true;
      },
    );
  }
  // Only busy asks for a wait: the other two are retried as they say.
  assert.equal(new FeedToolError('cursor_stale').retryAfterMs, undefined);
  assert.equal(new FeedToolError('source_unavailable').retryAfterMs, undefined);
});

// ---------------------------------------------------------------------------------------------
// End to end: /mcp, /mcp/open and the REST tool transport

type Row = {
  id: string;
  host: string;
  title: string;
  description?: string;
  capabilities?: string[];
  providerName?: string | null;
  priceRaw: string | null;
  paidCalls?: number | null;
  hidden?: boolean;
  risky?: string | null;
  withdrawnAt?: number | null;
};

const ROWS: Row[] = [
  {
    id: 'svc_aaaaaaaaaaaaaaaaaaaa',
    host: 'pdf.example.com',
    title: 'PDF text extract',
    description: 'Extract the text of a PDF.',
    capabilities: ['pdf', 'extract'],
    providerName: 'PDF text extract',
    priceRaw: '10000',
    paidCalls: 120,
  },
  {
    id: 'svc_bbbbbbbbbbbbbbbbbbbb',
    host: 'docs.example.net',
    title: 'Tables from PDF',
    description: 'Extract tables from a PDF as JSON.',
    priceRaw: null,
    paidCalls: null,
  },
  {
    id: 'svc_cccccccccccccccccccc',
    host: 'ocr.example.org',
    title: 'Scan to text',
    description: 'Extract PDF pages with OCR.',
    priceRaw: '2000',
    paidCalls: 5,
  },
  // Risky (as ingestion stores it: `hidden` is the operator's) and withdrawn listings are never
  // listed.
  {
    id: 'svc_dddddddddddddddddddd',
    host: 'pay.example.com',
    title: 'Send money for a PDF extract',
    priceRaw: '1000',
    risky: 'money_transfer',
  },
  {
    id: 'svc_eeeeeeeeeeeeeeeeeeee',
    host: 'old.example.com',
    title: 'Old PDF extract',
    priceRaw: '1000',
    withdrawnAt: NOW - HOUR,
  },
  { id: 'svc_ffffffffffffffffffff', host: 'weather.example.com', title: 'Weather', priceRaw: '1' },
];

async function seedServices(db: Database, now: number) {
  await db.exec(FEED_SERVICES_SQL);
  await db.exec(FEED_OFFERS_SQL); // 122: seller_key and the second source's data version
  for (const row of ROWS) {
    const capabilities = row.capabilities ?? [];
    const description = row.description ?? '';
    const providerName = row.providerName ?? null;
    const url = `https://${row.host}/api/${row.id.slice(4, 8)}`;
    await db.query(
      `INSERT INTO feed_services (id, record_id, host, url, title, description, capabilities,
         provider_name, method, x402_version, scheme, price_raw, pay_to, input, output,
         paid_calls_30d, payers_30d, last_called_at, source_updated_at, fetched_at, first_seen_at,
         last_seen_at, last_seen_sweep, missed_sweeps, withdrawn_at, risky, hidden, search_text)
       VALUES ($1,$2,$3,$4,$5,$6,$7::text[],$8,'GET',2,'exact',$9,$10,$11::jsonb,NULL,$12,NULL,NULL,
         NULL,$13,$13,$13,1,0,$14,$15,$16,$17)`,
      [
        row.id,
        url,
        row.host,
        url,
        row.title,
        description,
        capabilities,
        providerName,
        row.priceRaw,
        PAY_TO,
        row.id === 'svc_aaaaaaaaaaaaaaaaaaaa'
          ? JSON.stringify(INPUT_SUMMARY)
          : row.id === 'svc_bbbbbbbbbbbbbbbbbbbb'
            ? JSON.stringify(OLDER_SUMMARY)
            : null,
        row.paidCalls ?? null,
        now - HOUR,
        row.withdrawnAt ?? null,
        row.risky ?? null,
        row.hidden ?? false,
        [row.title, description, capabilities.join(' '), row.host, providerName ?? '']
          .join(' ')
          .toLowerCase(),
      ],
    );
  }
}

/** The source's last complete sweep at `at` (a new snapshot when it moves). */
async function completeSweep(db: Database, at: number) {
  await db.query(
    `INSERT INTO feed_sources (name, sweep_id, sweep_offset, last_attempt_at, last_success_at,
       last_total, listed)
     VALUES ($1, 1, 0, $2, $2, 6, 3)
     ON CONFLICT (name) DO UPDATE SET last_attempt_at = $2, last_success_at = $2`,
    [BAZAAR_SOURCE, at],
  );
}

type ToolResult = {
  isError?: boolean;
  structuredContent?: any;
  content: { type: string; text: string }[];
};
async function callTool(app: App, token: string, args: unknown, url = '/mcp') {
  const res =
    url === '/mcp'
      ? await mcpCall(app, token, 'tools/call', { name: 'city_service_search', arguments: args })
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
            params: { name: 'city_service_search', arguments: args },
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
    description: string;
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
    label: 'Feed search grant',
    scopes: ['workspace:read'],
    expiresInDays: 1,
  });
  assert.equal(grant.statusCode, 201, grant.body);
  return grant.json().token as string;
}

test('listed on signed-in /mcp only while the Feed is on; never on /mcp/open; off (0), a call is not found', async (t) => {
  withEnv(t, { CITY_FEED: '0', CITY_FEED_PAY: '0', CITY_INVITE_FLOW: '1' });
  const { app, cookie } = await fixture(t);
  const { tokens } = await fullFlow(app, {
    scope: ASSISTANT_SCOPES.join(' '),
    scopes: [...ASSISTANT_SCOPES],
  });
  const every = tokens.access_token;
  // Off: not listed, the MCP call does not run, the REST transport answers 404.
  assert.ok(!(await listed(app, every)).some((tool) => tool.name === 'city_service_search'));
  // The contract's not_found: the tool does not exist (never a tool answer such as
  // source_unavailable, which a registered but unlisted tool would give).
  const off = await callTool(app, every, { query: 'extract pdf' });
  assert.equal(off.result, undefined, JSON.stringify(off));
  assert.equal(off.error?.code, -32602, JSON.stringify(off));
  assert.match(off.error?.message, /city_service_search not found/);
  const restToken = await restGrant(app, cookie);
  const rest = () =>
    app.inject({
      method: 'POST',
      url: '/api/assistant/tools/city_service_search',
      headers: {
        'content-type': 'application/json',
        'x-city-request': '1',
        authorization: `Bearer ${restToken}`,
      },
      payload: JSON.stringify({ query: 'extract pdf' }),
    });
  assert.equal((await rest()).statusCode, 404);

  process.env.CITY_FEED = '1';
  const tools = await listed(app, every);
  const tool = tools.find((item) => item.name === 'city_service_search');
  assert.ok(tool, 'listed with CITY_FEED=1');
  const { title: _title, ...hints } = tool.annotations;
  assert.deepEqual(hints, feedToolAnnotations.city_service_search);
  assert.deepEqual(tool.securitySchemes, [{ type: 'oauth2', scopes: ['workspace:read'] }]);
  assert.equal(tool.inputSchema.type, 'object');
  // A search by query or one service by id: neither is required alone (a call with neither, or
  // with id and a search argument, is refused by the schema itself).
  assert.equal(tool.inputSchema.required, undefined);
  assert.equal(tool.inputSchema.properties.query.minLength, 2);
  assert.equal(tool.inputSchema.properties.id.type, 'string');
  assert.equal(tool.inputSchema.additionalProperties, false);
  assert.ok(tool.description.startsWith('Search the Central City Feed'), tool.description);
  assert.match(tool.description, /your own x402 client and wallet, outside Central City/);
  assert.equal(tool.inputSchema.properties.limit.maximum, FEED_LIMITS.toolLimitMax);
  assert.equal(tool.outputSchema.type, 'object');
  // The least grant (workspace:read only) sees it too.
  const reader = await readOnlyGrant(app);
  assert.ok((await listed(app, reader)).some((item) => item.name === 'city_service_search'));
  // Never on the anonymous endpoint, with invites on or off.
  const open = await listed(app, undefined, '/mcp/open');
  assert.ok(open.length > 0);
  assert.ok(!open.some((item) => item.name === 'city_service_search'));
  const anonymous = await callTool(app, '', { query: 'extract pdf' }, '/mcp/open');
  assert.equal(anonymous.result, undefined, JSON.stringify(anonymous));
  assert.equal(anonymous.error?.code, -32602, JSON.stringify(anonymous));
  assert.match(anonymous.error?.message, /city_service_search not found/);
  // On, the REST transport runs it too.
  assert.notEqual((await rest()).statusCode, 404);
});

test('a workspace:read grant searches the listed services; hidden and withdrawn ones never show', async (t) => {
  withEnv(t, { CITY_FEED: '1', CITY_FEED_PAY: '0' });
  const { app, cookie } = await fixture(t);
  const now = Date.now();
  await seedServices(app.city.db, now);
  await completeSweep(app.city.db, now - HOUR);
  const token = await readOnlyGrant(app);

  const found = (await callTool(app, token, { query: 'Extract PDF' })).result as ToolResult;
  assert.ok(!found.isError, JSON.stringify(found.content));
  const output = serviceSearchToolOutput.parse(found.structuredContent);
  assert.deepEqual(JSON.parse(found.content[0]!.text), found.structuredContent);
  assert.equal(output.notice, FEED_TOOL_NOTICE);
  assert.equal(output.snapshot_at, new Date(now - HOUR).toISOString());
  assert.deepEqual(output.services.map((item) => item.id).sort(), [
    'svc_aaaaaaaaaaaaaaaaaaaa',
    'svc_bbbbbbbbbbbbbbbbbbbb',
    'svc_cccccccccccccccccccc',
  ]);
  assert.equal(output.next_cursor, undefined);
  const pdf = output.services.find((item) => item.id === 'svc_aaaaaaaaaaaaaaaaaaaa')!;
  assert.equal(pdf.kind, 'external_service');
  assert.equal(pdf.provider_host, 'pdf.example.com');
  assert.deepEqual(pdf.price, { raw: '10000', decimals: 6, usdc: '0.01', unit: 'per_call' });
  assert.deepEqual(pdf.input, TOOL_INPUT_SUMMARY);
  // A row saved before example states existed reads null there (unknown), never undefined.
  const older = output.services.find((item) => item.id === 'svc_bbbbbbbbbbbbbbbbbbbb')!;
  assert.deepEqual(older.input, { ...OLDER_SUMMARY, example_state: null });
  assert.equal(pdf.status, 'active');
  assert.equal(pdf.source.record_id, 'https://pdf.example.com/api/aaaa');
  assert.equal(pdf.usage.paid_calls_30d, 120);
  // detail_url is on the origin the call arrived on.
  assert.equal(pdf.detail_url, `${ORIGIN}/feed/services/svc_aaaaaaaaaaaaaaaaaaaa`);
  const unknownPrice = output.services.find((item) => item.id === 'svc_bbbbbbbbbbbbbbbbbbbb')!;
  assert.equal(unknownPrice.price, null);
  assert.equal(unknownPrice.usage.paid_calls_30d, null);
  // Every result: the endpoint to call, its x402 version and the source credit in words.
  for (const item of output.services) {
    assert.equal(item.api_url, `https://${item.provider_host}/api/${item.id.slice(4, 8)}`);
    assert.equal(item.x402_version, 2);
    assert.equal(item.source.credit, 'Listed by x402 Bazaar');
  }

  // max_price_usdc: at most that per call; an unknown price never passes.
  const cheap = (await callTool(app, token, { query: 'extract pdf', max_price_usdc: '0.005' }))
    .result as ToolResult;
  assert.deepEqual(
    cheap.structuredContent.services.map((item: { id: string }) => item.id),
    ['svc_cccccccccccccccccccc'],
  );
  // host: one provider, as provider_host shows it (case does not matter).
  const host = (await callTool(app, token, { query: 'extract pdf', host: 'PDF.example.com' }))
    .result as ToolResult;
  assert.deepEqual(
    host.structuredContent.services.map((item: { id: string }) => item.id),
    ['svc_aaaaaaaaaaaaaaaaaaaa'],
  );
  // Nothing matches: an empty page, still with the notice and the freshness.
  const none = (await callTool(app, token, { query: 'translate audio' })).result as ToolResult;
  assert.ok(!none.isError, JSON.stringify(none.content));
  assert.deepEqual(none.structuredContent.services, []);
  assert.equal(none.structuredContent.notice, FEED_TOOL_NOTICE);

  // Arguments the tool cannot read are refused before anything is searched. Without id, query is
  // still required.
  for (const args of [
    {},
    { limit: 3 },
    { query: 'x' },
    { query: 'extract pdf', limit: FEED_LIMITS.toolLimitMax + 1 },
    { query: 'extract pdf', max_price_usdc: 'cheap' },
    { id: 'svc_aaaaaaaaaaaaaaaaaaaa', query: 'extract pdf' },
    { id: 'svc_short' },
  ]) {
    const refused = (await callTool(app, token, args)).result as ToolResult;
    assert.equal(refused.isError, true, JSON.stringify(args));
    assert.equal(toolError(refused).code, 'invalid_arguments');
    assert.equal(toolError(refused).retryable, false);
  }
  // id with a search argument: the caller is told which to leave out, not that query is invalid.
  const combined = (
    await callTool(app, token, { id: 'svc_aaaaaaaaaaaaaaaaaaaa', query: 'extract pdf' })
  ).result as ToolResult;
  assert.deepEqual(toolError(combined).issues, [
    { path: 'id', message: 'Must be sent without query; leave out id to search instead' },
  ]);
  assert.equal(
    toolError(combined).message,
    'Check these fields: id (must be sent without query; leave out id to search instead).',
  );

  // The REST transport answers the same shape, and the same reason for a refusal.
  const restToken = await restGrant(app, cookie);
  const restCall = (args: unknown) =>
    app.inject({
      method: 'POST',
      url: '/api/assistant/tools/city_service_search',
      headers: {
        'content-type': 'application/json',
        'x-city-request': '1',
        authorization: `Bearer ${restToken}`,
      },
      payload: JSON.stringify(args),
    });
  const res = await restCall({ query: 'extract pdf', host: 'ocr.example.org' });
  assert.equal(res.statusCode, 200, res.body);
  const rest = serviceSearchToolOutput.parse(res.json());
  assert.deepEqual(
    rest.services.map((item) => item.id),
    ['svc_cccccccccccccccccccc'],
  );
  const restRefused = await restCall({ id: 'svc_aaaaaaaaaaaaaaaaaaaa', host: 'ocr.example.org' });
  assert.equal(restRefused.statusCode, 400, restRefused.body);
  assert.deepEqual(restRefused.json().issues, [
    { path: 'id', message: 'Must be sent without host; leave out id to search instead' },
  ]);
});

test('id reads one listed service as its detail route does; hidden, withdrawn and unknown ids answer the same empty result', async (t) => {
  withEnv(t, { CITY_FEED: '1', CITY_FEED_PAY: '0' });
  const { app, cookie } = await fixture(t);
  const now = Date.now();
  await seedServices(app.city.db, now);
  await completeSweep(app.city.db, now - HOUR);
  const token = await readOnlyGrant(app);
  const ID = 'svc_aaaaaaaaaaaaaaaaaaaa';

  // The same data as GET /api/public/feed/services/:id, as the tool maps it.
  const http = await app.inject({ url: `/api/public/feed/services/${ID}` });
  assert.equal(http.statusCode, 200, http.body);
  const detail = http.json() as FeedServiceDetail;
  assert.equal(detail.service.source.credit, FEED_SOURCE.credit);
  const { service: detailService, ...detailFreshness } = detail;
  const expected = toServiceSearchToolOutput(
    { ...detailFreshness, services: [detailService], next: null, total: null },
    ORIGIN,
  );
  for (const id of [
    ID,
    `https://centralcity.ai/feed/services/${ID}`,
    `${ORIGIN}/feed/services/${ID}`,
  ]) {
    const result = (await callTool(app, token, { id })).result as ToolResult;
    assert.ok(!result.isError, JSON.stringify(result.content));
    const output = serviceSearchToolOutput.parse(result.structuredContent);
    assert.deepEqual(output, expected, id);
    assert.equal(output.services[0]!.api_url, 'https://pdf.example.com/api/aaaa');
    assert.equal(output.services[0]!.x402_version, 2);
    assert.equal(output.services[0]!.source.credit, 'Listed by x402 Bazaar');
    assert.equal(output.message, undefined);
  }

  // Risky (stored hidden), withdrawn (its detail route still answers it within the tombstone) and
  // unknown ids: one answer, no service, so hidden ones cannot be probed.
  const withdrawn = await app.inject({ url: '/api/public/feed/services/svc_eeeeeeeeeeeeeeeeeeee' });
  assert.equal(withdrawn.statusCode, 200, withdrawn.body);
  const misses: unknown[] = [];
  for (const id of [
    'svc_dddddddddddddddddddd',
    'svc_eeeeeeeeeeeeeeeeeeee',
    'svc_zzzzzzzzzzzzzzzzzzzz',
    'https://centralcity.ai/feed/services/svc_dddddddddddddddddddd',
  ]) {
    const result = (await callTool(app, token, { id })).result as ToolResult;
    assert.ok(!result.isError, JSON.stringify(result.content));
    const output = serviceSearchToolOutput.parse(result.structuredContent);
    assert.deepEqual(output.services, [], id);
    assert.equal(output.message, FEED_TOOL_NOT_LISTED);
    assert.equal(output.notice, FEED_TOOL_NOTICE);
    assert.equal(output.snapshot_at, new Date(now - HOUR).toISOString());
    misses.push(output);
  }
  for (const miss of misses) assert.deepEqual(miss, misses[0]);

  // The REST transport answers the same.
  const res = await app.inject({
    method: 'POST',
    url: '/api/assistant/tools/city_service_search',
    headers: {
      'content-type': 'application/json',
      'x-city-request': '1',
      authorization: `Bearer ${await restGrant(app, cookie)}`,
    },
    payload: JSON.stringify({ id: `https://centralcity.ai/feed/services/${ID}` }),
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(serviceSearchToolOutput.parse(res.json()), expected);
});

test('before the first complete sweep the tool answers the retryable source_unavailable', async (t) => {
  withEnv(t, { CITY_FEED: '1', CITY_FEED_PAY: '0' });
  const { app } = await fixture(t);
  await seedServices(app.city.db, Date.now());
  const token = await readOnlyGrant(app);
  // A search and an id alike: nothing is confirmed yet, so no id answers "not listed" either.
  for (const args of [{ query: 'extract pdf' }, { id: 'svc_aaaaaaaaaaaaaaaaaaaa' }]) {
    const result = (await callTool(app, token, args)).result as ToolResult;
    assert.equal(result.isError, true, JSON.stringify(result));
    const error = toolError(result);
    assert.equal(error.code, 'source_unavailable');
    assert.equal(error.retryable, true);
    assert.match(error.message, /not available yet/);
    assert.equal(result.structuredContent, undefined, 'never an empty success');
  }
});

test('a cursor from an earlier snapshot answers the retryable cursor_stale', async (t) => {
  withEnv(t, { CITY_FEED: '1', CITY_FEED_PAY: '0' });
  const { app } = await fixture(t);
  const now = Date.now();
  await seedServices(app.city.db, now);
  await completeSweep(app.city.db, now - 2 * HOUR);
  const token = await readOnlyGrant(app);
  const first = (await callTool(app, token, { query: 'extract pdf', limit: 1 }))
    .result as ToolResult;
  assert.ok(!first.isError, JSON.stringify(first.content));
  assert.equal(first.structuredContent.services.length, 1);
  const cursor = first.structuredContent.next_cursor as string;
  assert.match(cursor, /^[A-Za-z0-9_-]+$/);
  // The next page under the same snapshot works.
  const second = (await callTool(app, token, { query: 'extract pdf', limit: 1, cursor }))
    .result as ToolResult;
  assert.ok(!second.isError, JSON.stringify(second.content));
  assert.notEqual(second.structuredContent.services[0].id, first.structuredContent.services[0].id);
  // A newer sweep finished: the old cursor is stale; the first page loads again without it.
  await completeSweep(app.city.db, now - HOUR);
  const stale = (await callTool(app, token, { query: 'extract pdf', limit: 1, cursor }))
    .result as ToolResult;
  assert.equal(stale.isError, true, JSON.stringify(stale));
  const error = toolError(stale);
  assert.equal(error.code, 'cursor_stale');
  assert.equal(error.kind, 'conflict');
  assert.equal(error.retryable, true);
  assert.match(error.message, /without cursor/);
  const again = (await callTool(app, token, { query: 'extract pdf', limit: 1 }))
    .result as ToolResult;
  assert.ok(!again.isError, JSON.stringify(again.content));
  assert.equal(again.structuredContent.snapshot_at, new Date(now - HOUR).toISOString());
});

test('under database load the tool answers the retryable busy over MCP and REST; a real error stays internal', async (t) => {
  withEnv(t, { CITY_FEED: '1', CITY_FEED_PAY: '0' });
  const { app, cookie } = await fixture(t);
  const now = Date.now();
  await seedServices(app.city.db, now);
  await completeSweep(app.city.db, now - HOUR);
  const token = await readOnlyGrant(app);
  const restToken = await restGrant(app, cookie);
  const rest = () =>
    app.inject({
      method: 'POST',
      url: '/api/assistant/tools/city_service_search',
      headers: {
        'content-type': 'application/json',
        'x-city-request': '1',
        authorization: `Bearer ${restToken}`,
      },
      payload: JSON.stringify({ query: 'extract pdf' }),
    });
  // The listings' statements fail as they do under load; the grant checks still answer.
  const db = app.city.db;
  const query = db.query.bind(db);
  let failure: (() => Error) | null = () =>
    pgError('57014', 'canceling statement due to statement timeout');
  Object.assign(db, {
    query: (sql: string, params?: unknown[]) =>
      failure && /\bfeed_/.test(sql) ? Promise.reject(failure()) : query(sql, params),
  });

  const busy = (await callTool(app, token, { query: 'extract pdf' })).result as ToolResult;
  assert.equal(busy.isError, true, JSON.stringify(busy));
  assert.equal(busy.structuredContent, undefined, 'never an empty success');
  const error = toolError(busy);
  assert.equal(error.code, 'busy');
  assert.equal(error.retryable, true);
  assert.equal(error.retry_after_ms, 5_000);
  assert.equal(error.message, FEED_BUSY_MESSAGE);
  const restBusy = await rest();
  assert.equal(restBusy.statusCode, 503, restBusy.body);
  assert.equal(restBusy.headers['retry-after'], '5');
  assert.deepEqual(restBusy.json(), { error: FEED_BUSY_MESSAGE, code: 'busy' });

  // Anything else is still the generic internal error: not retryable, no wait, no detail.
  failure = () => new TypeError('rows is undefined');
  const broken = (await callTool(app, token, { query: 'extract pdf' })).result as ToolResult;
  assert.equal(broken.isError, true, JSON.stringify(broken));
  assert.equal(toolError(broken).code, 'internal_error');
  assert.equal(toolError(broken).retryable, false);
  assert.equal(toolError(broken).retry_after_ms, undefined);
  assert.equal(toolError(broken).message, 'The operation could not be completed.');
  assert.equal((await rest()).statusCode, 500);

  // The database answers again: so does the tool.
  failure = null;
  const found = (await callTool(app, token, { query: 'extract pdf' })).result as ToolResult;
  assert.ok(!found.isError, JSON.stringify(found.content));
  assert.equal(found.structuredContent.services.length, 3);
});
