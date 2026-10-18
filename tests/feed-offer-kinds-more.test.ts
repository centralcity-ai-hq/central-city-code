/*
 * The offer kinds added after the first twenty: web-meta, web-links, keyword-density, text-diff,
 * json-query, json-schema-check, csv-stats, base-tx, base-erc20-balance and base-gas. Pages and the
 * chain are fakes (no network): the safe fetcher itself is tested in feed-offer-kinds.test.ts, and
 * these kinds use it exactly as web-read does. Every run goes through agreeingRun, so each input is
 * also a case of "check() refuses before payment, run() never refuses after it".
 */
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import test, { beforeEach } from 'node:test';
import { checkOfferInput, OFFER_KIND_SPECS, type OfferKindName } from '../shared/feed-offers.js';
import {
  OFFER_ANSWER_MAX_BYTES,
  OFFER_KIND_REGISTRY,
  OfferKindFailure,
  OfferKindInputError,
  resetOfferKindDeps,
  setOfferKindDeps,
  type OfferKindAnswer,
} from '../server/feed/offers/kinds.js';
import type { OfferBaseReader } from '../server/feed/offers/kinds-base.js';
import { BASE_TX_MAX_TRANSFERS, readSymbol } from '../server/feed/offers/kinds-base-tx.js';
import { CSV_STATS_MAX_COLUMNS, CSV_STATS_MAX_DISTINCT } from '../server/feed/offers/kinds-csv.js';
import {
  JSON_MAX_DEPTH,
  JSON_QUERY_MAX_MATCHES,
  JSON_SCHEMA_MAX_ERRORS,
  parseJsonPath,
  patternProblem,
} from '../server/feed/offers/kinds-json.js';
import { WEB_LINKS_LIMITS } from '../server/feed/offers/kinds-web-meta.js';
import {
  TEXT_DIFF_MAX_EDITS,
  TEXT_DIFF_MAX_LINES,
  textDiff,
} from '../server/feed/offers/kinds-words.js';
import {
  SafeFetchError,
  type FetchPublic,
  type PublicFetchRequest,
  type PublicFetchResponse,
} from '../server/feed/offers/safe-fetch.js';
import { agreeingRun, agreementLog, checkAgreementSeen } from './feed-offer-kinds-agree.js';
import {
  chainExtras,
  fakeReceipt,
  FROM,
  TO,
  TOKEN,
  transferLog,
  TX_BLOCK,
  TX_HASH,
} from './feed-offer-kinds-chain.js';

const USDC_CHECKSUMMED = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const USDC_MIXED = '0x833589fcD6eDb6E08f4c7C32D4f71b54bdA02913';

const NOW = Date.UTC(2026, 9, 17, 12, 0, 0);
const HEAD = 36_000_000n;
const BLOCK_HASH = `0x${'cd'.repeat(32)}`;
const BLOCK_TIME = NOW / 1000 - 2;

const chain = (overrides: Partial<OfferBaseReader> = {}): OfferBaseReader => ({
  getBlock: async (args) => ({
    number: 'blockNumber' in args ? args.blockNumber : HEAD,
    hash: BLOCK_HASH,
    timestamp: BigInt(BLOCK_TIME),
  }),
  readContract: async () => 0n,
  ...chainExtras(HEAD, BLOCK_HASH),
  ...overrides,
});

const noFetch: FetchPublic = async () => assert.fail('no web read in this case');

beforeEach(() => {
  resetOfferKindDeps();
  setOfferKindDeps({ fetchPublic: noFetch, readBase: chain() });
});

const ctx = () => ({ signal: new AbortController().signal, now: NOW });
const agreement = agreementLog();
const run = (kind: OfferKindName, input: unknown) =>
  agreeingRun(OFFER_KIND_REGISTRY.get(kind)!, input, ctx(), agreement);

async function json(kind: OfferKindName, input: unknown): Promise<Record<string, any>> {
  const { body, mime }: OfferKindAnswer = await run(kind, input);
  assert.equal(mime, 'application/json');
  assert.equal(mime, OFFER_KIND_SPECS[kind].outputMime);
  assert.ok(Buffer.byteLength(JSON.stringify(body)) <= OFFER_ANSWER_MAX_BYTES);
  return body as Record<string, any>;
}

async function refused(kind: OfferKindName, input: unknown, message: RegExp) {
  await assert.rejects(run(kind, input), (error: unknown) => {
    assert.ok(error instanceof OfferKindInputError, String(error));
    assert.match(error.message, message);
    return true;
  });
}

async function failure(kind: OfferKindName, input: unknown, status: number, code: string) {
  let caught: OfferKindFailure | null = null;
  await assert.rejects(run(kind, input), (error: unknown) => {
    assert.ok(error instanceof OfferKindFailure, String(error));
    caught = error;
    return true;
  });
  const error = caught as unknown as OfferKindFailure;
  assert.equal(error.status, status, error.message);
  assert.equal(error.code, code, error.message);
  return error;
}

/** A fetcher that answers one page and records each request. */
function site(
  html: string,
  response: Partial<PublicFetchResponse> = {},
): { fetchPublic: FetchPublic; requests: PublicFetchRequest[] } {
  const requests: PublicFetchRequest[] = [];
  return {
    requests,
    fetchPublic: async (request) => {
      requests.push(request);
      return {
        url: request.url,
        status: 200,
        contentType: 'text/html',
        charset: 'utf-8',
        body: Buffer.from(html),
        redirects: 0,
        ...response,
      };
    },
  };
}

// ---------------------------------------------------------------- the specs

test('specs: every new kind is in the registry, its example passes its schema, prices unchanged', () => {
  const added: OfferKindName[] = [
    'web-meta',
    'web-links',
    'keyword-density',
    'text-diff',
    'json-query',
    'json-schema-check',
    'csv-stats',
    'base-tx',
    'base-erc20-balance',
    'base-gas',
  ];
  for (const name of added) {
    assert.ok(OFFER_KIND_REGISTRY.get(name), name);
    assert.equal(checkOfferInput(name, OFFER_KIND_SPECS[name].example).ok, true, name);
  }
  assert.deepEqual(OFFER_KIND_SPECS['base-gas'].input, []);
  assert.deepEqual(checkOfferInput('base-gas', {}), { ok: true, value: {} });
});

// ---------------------------------------------------------------- web-meta

const META_PAGE = `<!doctype html><html lang="en-GB"><head>
<meta charset="utf-8"><title> Fresh &amp; Local </title>
<meta name="description" content="All the  news, &quot;fresh&quot;.">
<meta property="og:title" content="OG title"><meta property="og:description" content="OG text">
<meta property="og:image" content="https://cdn.example.com/a.png"><meta property="og:type" content="article">
<meta property="og:site_name" content="Example News">
<meta name="twitter:card" content="summary_large_image"><meta name="twitter:site" content="@example">
<link rel="stylesheet" href="/a.css"><link rel="canonical" href="/story">
<script>var x = "<h1>not a heading</h1>";</script></head>
<body><h1>First <em>story</em></h1><p>Three more words.</p><h1>Second</h1><h1>3</h1><h1>4</h1><h1>5</h1><h1>6</h1>
</body></html>`;

test('web-meta: title, description, canonical, lang, Open Graph and Twitter tags, headings, words', async () => {
  const fake = site(META_PAGE, { url: 'https://news.example.com/final' });
  setOfferKindDeps({ fetchPublic: fake.fetchPublic });
  const answer = await json('web-meta', { url: 'https://news.example.com/start' });
  assert.deepEqual(answer, {
    url: 'https://news.example.com/start',
    final_url: 'https://news.example.com/final',
    status: 200,
    title: 'Fresh & Local',
    description: 'All the news, "fresh".',
    canonical: 'https://news.example.com/story',
    lang: 'en-GB',
    og: {
      title: 'OG title',
      description: 'OG text',
      image: 'https://cdn.example.com/a.png',
      type: 'article',
      site_name: 'Example News',
    },
    twitter: {
      card: 'summary_large_image',
      title: null,
      description: null,
      image: null,
      site: '@example',
      creator: null,
    },
    h1: ['First story', 'Second', '3', '4', '5'],
    // The visible text (the title is not): First story Three more words. Second 3 4 5 6
    word_count: 10,
  });
  // The same fetch rules as web-read, HTML only.
  assert.equal(fake.requests.length, 1);
  assert.deepEqual(fake.requests[0]!.contentTypes, ['text/html']);
  assert.equal(fake.requests[0]!.httpsOnly, true);
  assert.equal(fake.requests[0]!.maxBytes, 1024 * 1024);
});

test('web-meta: a page without tags answers nulls; long values are cut', async () => {
  setOfferKindDeps({
    fetchPublic: site(`<title>${'t'.repeat(3000)}</title><p>x</p>`).fetchPublic,
  });
  const answer = await json('web-meta', { url: 'https://news.example.com/' });
  assert.equal(answer.title.length, 500);
  assert.equal(answer.description, null);
  assert.equal(answer.canonical, null);
  assert.equal(answer.lang, null);
  assert.deepEqual(answer.h1, []);
  assert.equal(answer.word_count, 1);
});

test('web-meta and web-links: URL refusals before payment, fetch failures after it', async () => {
  for (const kind of ['web-meta', 'web-links'] as const) {
    await refused(kind, { url: 'https://localhost/' }, /public host/);
    await refused(kind, { url: 'https://10.0.0.1/' }, /public host|IP address/);
    await refused(kind, { url: 'http://news.example.com/' }, /expected form|https/);
    setOfferKindDeps({
      fetchPublic: async () => {
        throw new SafeFetchError('content_type', 'The page is not HTML.', true);
      },
    });
    const notHtml = await failure(
      kind,
      { url: 'https://news.example.com/' },
      422,
      'unsupported_content_type',
    );
    assert.equal(notHtml.outboundSent, true);
    setOfferKindDeps({
      fetchPublic: async () => {
        throw new SafeFetchError('not_public', 'private');
      },
    });
    await failure(kind, { url: 'https://news.example.com/' }, 422, 'host_refused');
    setOfferKindDeps({ fetchPublic: site('<p>gone</p>', { status: 404 }).fetchPublic });
    const missing = await failure(kind, { url: 'https://news.example.com/' }, 422, 'page_status');
    assert.equal(missing.retryable, false);
  }
});

// ---------------------------------------------------------------- web-links

test('web-links: absolute, deduplicated http(s) links with text, rel and internal', async () => {
  const html = `<a href="/a">Home &amp; <b>more</b></a>
    <a href="https://other.example.org/x" rel="nofollow noopener">Out</a>
    <a href="/a#top">Again</a><a href="mailto:a@example.com">Mail</a><a href="#section">Jump</a>
    <a href="javascript:void(0)">JS</a><a name="anchor-only">no href</a>
    <A HREF='b/c?d=1'>${'x'.repeat(300)}</A><script>"<a href='/hidden'>x</a>"</script>
    <a href="//news.example.com/protocol-relative">PR</a>`;
  setOfferKindDeps({
    fetchPublic: site(html, { url: 'https://news.example.com/dir/page' }).fetchPublic,
  });
  const answer = await json('web-links', { url: 'https://news.example.com/dir/page' });
  assert.deepEqual(
    answer.links.map((link: { href: string; internal: boolean }) => [link.href, link.internal]),
    [
      ['https://news.example.com/a', true],
      ['https://other.example.org/x', false],
      ['https://news.example.com/dir/b/c?d=1', true],
      ['https://news.example.com/protocol-relative', true],
    ],
  );
  assert.equal(answer.links[0].text, 'Home & more');
  assert.equal(answer.links[0].rel, null);
  assert.equal(answer.links[1].rel, 'nofollow noopener');
  assert.equal(answer.links[2].text.length, WEB_LINKS_LIMITS.maxTextChars);
  assert.equal(answer.total, 4);
  assert.equal(answer.internal, 3);
  assert.equal(answer.external, 1);
  // mailto:, javascript: and the same page's #section.
  assert.equal(answer.skipped, 3);
  assert.equal(answer.truncated, false);
});

test('web-links: <base href> is honoured; max_links and the 64 KiB answer cap', async () => {
  setOfferKindDeps({
    fetchPublic: site('<base href="https://cdn.example.net/root/"><a href="x">x</a>').fetchPublic,
  });
  const based = await json('web-links', { url: 'https://news.example.com/' });
  assert.equal(based.links[0].href, 'https://cdn.example.net/root/x');
  assert.equal(based.links[0].internal, false);
  const many = Array.from(
    { length: 900 },
    (_, i) => `<a href="/p${i}">${'w'.repeat(150)}</a>`,
  ).join('');
  setOfferKindDeps({ fetchPublic: site(many).fetchPublic });
  const three = await json('web-links', { url: 'https://news.example.com/', max_links: 3 });
  assert.equal(three.links.length, 3);
  assert.equal(three.total, 900);
  assert.equal(three.truncated, true);
  const all = await json('web-links', { url: 'https://news.example.com/' });
  // 500 links of ~200 bytes would pass 64 KiB: the list stops before it does.
  assert.ok(all.links.length < 500 && all.links.length > 200, String(all.links.length));
  assert.equal(all.truncated, true);
});

test('web-links: a hostile page is one linear scan', async () => {
  const hostile = `<a href="${'"'.repeat(1)}${'x '.repeat(200_000)}`.slice(0, 1024 * 1024);
  setOfferKindDeps({ fetchPublic: site(hostile + '<a'.repeat(100_000)).fetchPublic });
  const started = performance.now();
  await json('web-links', { url: 'https://news.example.com/' });
  assert.ok(performance.now() - started < 2_000);
});

// ---------------------------------------------------------------- keyword-density

test('keyword-density: words and phrases with counts and percentages, stopwords left out', async () => {
  const answer = await json('keyword-density', OFFER_KIND_SPECS['keyword-density'].example);
  assert.equal(answer.total_words, 12);
  assert.equal(answer.stopwords_removed, true);
  assert.deepEqual(answer.words.slice(0, 3), [
    { word: 'coffee', count: 3, percent: 30 },
    { word: 'beans', count: 2, percent: 20 },
    { word: 'fresh', count: 2, percent: 20 },
  ]);
  assert.deepEqual(answer.phrases.slice(0, 2), [
    { phrase: 'coffee beans', count: 2, percent: 33.33 },
    { phrase: 'fresh coffee', count: 2, percent: 33.33 },
  ]);
  const kept = await json('keyword-density', {
    text: 'The cat and the hat',
    stopwords: false,
    top: 1,
  });
  assert.deepEqual(kept.words, [{ word: 'the', count: 2, percent: 40 }]);
  assert.equal(kept.phrases.length, 1);
  // Empty text: zeros.
  const empty = await json('keyword-density', { text: '' });
  assert.equal(empty.total_words, 0);
  assert.deepEqual(empty.words, []);
  await refused('keyword-density', { text: 'a', top: 101 }, /out of range/);
  await refused('keyword-density', { text: 'a', stopwords: 'yes' }, /true or false/);
  // 64 KiB of distinct long words stays a small answer.
  const big = await json('keyword-density', {
    text: Array.from({ length: 1000 }, (_, i) => `${'w'.repeat(60)}${i}`).join(' '),
    top: 100,
  });
  assert.equal(big.words.length, 100);
});

// ---------------------------------------------------------------- text-diff

test('text-diff: a unified diff and its counts', async () => {
  const answer = await json('text-diff', OFFER_KIND_SPECS['text-diff'].example);
  assert.deepEqual(answer, {
    identical: false,
    added: 2,
    removed: 1,
    unchanged: 2,
    unified: '--- a\n+++ b\n@@ -1,3 +1,4 @@\n one\n-two\n+2\n three\n+four\n',
  });
  const same = await json('text-diff', { a: 'x\r\ny\n', b: 'x\ny' });
  assert.deepEqual(same, { identical: true, added: 0, removed: 0, unchanged: 2, unified: '' });
  // Two far-apart changes: two hunks with one line of context.
  const lines = Array.from({ length: 20 }, (_, i) => `line ${i}`);
  const changed = [...lines];
  changed[2] = 'CHANGED 2';
  changed[15] = 'CHANGED 15';
  const two = textDiff(lines.join('\n'), changed.join('\n'), 1);
  assert.equal(two.unified.match(/^@@/gm)!.length, 2);
  assert.match(two.unified, /@@ -2,3 \+2,3 @@\n line 1\n-line 2\n\+CHANGED 2\n line 3\n/);
  // From and to nothing.
  assert.equal(textDiff('', 'a\nb', 3).unified, '--- a\n+++ b\n@@ -0,0 +1,2 @@\n+a\n+b\n');
  assert.equal(textDiff('a', '', 3).unified, '--- a\n+++ b\n@@ -1 +0,0 @@\n-a\n');
  assert.equal(textDiff('a\nb\nc', 'a\nc', 0).unified, '--- a\n+++ b\n@@ -2 +1,0 @@\n-b\n');
});

test('text-diff: the edit is minimal (Myers), checked against a brute LCS on small cases', () => {
  const lcs = (a: string[], b: string[]) => {
    const table = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
    for (let i = a.length - 1; i >= 0; i--)
      for (let j = b.length - 1; j >= 0; j--)
        table[i][j] =
          a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    return table[0][0];
  };
  let seed = 7;
  const random = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  for (let round = 0; round < 300; round++) {
    const a = Array.from(
      { length: Math.floor(random() * 12) },
      () => 'abc'[Math.floor(random() * 3)]!,
    );
    const b = Array.from(
      { length: Math.floor(random() * 12) },
      () => 'abc'[Math.floor(random() * 3)]!,
    );
    const diff = textDiff(a.join('\n'), b.join('\n'), 3);
    assert.equal(diff.unchanged, lcs(a, b), `${a} / ${b}`);
    assert.equal(diff.unchanged + diff.removed, a.length);
    assert.equal(diff.unchanged + diff.added, b.length);
  }
});

test('text-diff: the line and edit caps are input errors, quickly', async () => {
  await refused(
    'text-diff',
    { a: '\n'.repeat(TEXT_DIFF_MAX_LINES + 1), b: '' },
    /at most 20000 lines/,
  );
  // 32k lines of different text in each: far past the edit cap, refused in bounded time.
  const started = performance.now();
  await refused(
    'text-diff',
    {
      a: Array.from({ length: 6_000 }, (_, i) => `a${i}`).join('\n'),
      b: Array.from({ length: 6_000 }, (_, i) => `b${i}`).join('\n'),
    },
    new RegExp(`more than ${TEXT_DIFF_MAX_EDITS} lines`),
  );
  assert.ok(performance.now() - started < 5_000);
  await refused('text-diff', { a: 'x', b: 'y', context: 11 }, /out of range/);
  // A diff larger than 64 KiB is refused before payment.
  await refused(
    'text-diff',
    {
      a: Array.from({ length: 800 }, (_, i) => `${'a'.repeat(70)}${i}`).join('\n'),
      b: Array.from({ length: 800 }, (_, i) => `${'b'.repeat(70)}${i}`).join('\n'),
    },
    /larger than 65536 bytes/,
  );
});

// ---------------------------------------------------------------- json-query

test('json-query: names, indexes, wildcards and quoted keys', async () => {
  // "__proto__" is an own key of the parsed document (written as text: a literal would not be).
  const doc =
    '{"items":[{"price":3,"tags":["a"]},{"price":5},{"name":"no price"}],' +
    '"a":{"b":[{"c":"deep"}],"key with space":1,"__proto__":"own"}}';
  const values = async (path: string) =>
    (await json('json-query', { json: doc, path })).matches.map(
      (match: { value: unknown }) => match.value,
    );
  assert.deepEqual(await values('items[*].price'), [3, 5]);
  assert.deepEqual(await values('$.items[1].price'), [5]);
  assert.deepEqual(await values('a.b[0].c'), ['deep']);
  assert.deepEqual(await values('a["key with space"]'), [1]);
  assert.deepEqual(await values("a['__proto__']"), ['own']);
  assert.deepEqual(await values('a.constructor'), []);
  assert.deepEqual(await values('items[9]'), []);
  assert.deepEqual(await values('items.price'), []);
  assert.deepEqual(await values('$'), [JSON.parse(doc)]);
  const answer = await json('json-query', { json: doc, path: 'items.*.price' });
  assert.deepEqual(answer, {
    count: 2,
    truncated: false,
    matches: [
      { path: '$.items[0].price', value: 3 },
      { path: '$.items[1].price', value: 5 },
    ],
  });
  assert.deepEqual(parseJsonPath('a[0]["b\\"c"].*'), [
    { key: 'a' },
    { index: 0 },
    { key: 'b"c' },
    { wildcard: true },
  ]);
});

test('json-query: bad paths, bad JSON, depth and match caps', async () => {
  await refused('json-query', { json: '{}', path: 'a..b' }, /without a name/);
  await refused('json-query', { json: '{}', path: 'a[x]' }, /bracket/);
  await refused('json-query', { json: '{}', path: 'a["open' }, /never closes/);
  await refused('json-query', { json: '{}', path: 'a b' }, /unexpected character/);
  await refused('json-query', { json: '{}', path: '' }, /empty/);
  await refused('json-query', { json: '{}', path: 'a'.repeat(257) }, /longer than 256 bytes/);
  await refused(
    'json-query',
    { json: '{}', path: Array(66).fill('a').join('.') },
    /more than 64 steps/,
  );
  await refused('json-query', { json: '{"a":', path: 'a' }, /json is not valid JSON/);
  const deep = `${'['.repeat(JSON_MAX_DEPTH + 1)}${']'.repeat(JSON_MAX_DEPTH + 1)}`;
  await refused('json-query', { json: deep, path: '$' }, /nested more than 256/);
  const many = JSON.stringify(Array.from({ length: 3000 }, (_, i) => i));
  const capped = await json('json-query', { json: many, path: '[*]' });
  assert.equal(capped.count, JSON_QUERY_MAX_MATCHES);
  assert.equal(capped.truncated, true);
  // A large match is refused before payment.
  await refused(
    'json-query',
    { json: JSON.stringify(Array.from({ length: 1500 }, () => 'x'.repeat(40))), path: '[*]' },
    /larger than 65536 bytes/,
  );
});

// ---------------------------------------------------------------- json-schema-check

const SCHEMA = JSON.stringify({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'A person',
  type: 'object',
  required: ['name', 'age'],
  additionalProperties: false,
  properties: {
    name: { type: 'string', minLength: 2, maxLength: 5, pattern: '^[A-Z][a-z]+$' },
    age: { type: 'integer', minimum: 0, maximum: 150 },
    role: { enum: ['admin', 'user'] },
    kind: { const: 'person' },
    tags: { type: 'array', items: { type: 'string' } },
    score: { type: ['number', 'null'], exclusiveMinimum: 0, exclusiveMaximum: 1 },
  },
});

test('json-schema-check: valid documents, and every keyword reports its error with its path', async () => {
  assert.deepEqual(
    await json('json-schema-check', {
      json: '{"name":"Ada","age":36,"tags":["x"],"score":null,"kind":"person"}',
      schema: SCHEMA,
    }),
    { valid: true, error_count: 0, errors: [], truncated: false },
  );
  const answer = await json('json-schema-check', {
    json: JSON.stringify({
      name: 'a',
      age: 1.5,
      role: 'boss',
      kind: 'cat',
      tags: ['x', 2],
      score: 1,
      extra: true,
    }),
    schema: SCHEMA,
  });
  assert.equal(answer.valid, false);
  assert.deepEqual(answer.errors, [
    { path: '/name', message: 'Must be at least 2 characters long.' },
    { path: '/name', message: 'Must match the pattern.' },
    { path: '/age', message: 'Must be integer, not number.' },
    { path: '/role', message: 'Must be one of the enum values.' },
    { path: '/kind', message: 'Must equal the const value.' },
    { path: '/tags/1', message: 'Must be string, not number.' },
    { path: '/score', message: 'Must be less than 1.' },
    { path: '/extra', message: 'This property is not allowed.' },
  ]);
  const missing = await json('json-schema-check', { json: '{}', schema: SCHEMA });
  assert.equal(missing.error_count, 2);
  assert.match(missing.errors[0].message, /property "name"/);
  // Boolean schemas, and a const object regardless of key order.
  assert.equal((await json('json-schema-check', { json: '1', schema: 'true' })).valid, true);
  assert.equal((await json('json-schema-check', { json: '1', schema: 'false' })).valid, false);
  assert.equal(
    (
      await json('json-schema-check', {
        json: '{"b":1,"a":[1]}',
        schema: '{"const":{"a":[1],"b":1}}',
      })
    ).valid,
    true,
  );
});

test('json-schema-check: the error list is capped at 100', async () => {
  const answer = await json('json-schema-check', {
    json: JSON.stringify(Array.from({ length: 500 }, () => 'x')),
    schema: '{"items":{"type":"integer"}}',
  });
  assert.equal(answer.errors.length, JSON_SCHEMA_MAX_ERRORS);
  assert.equal(answer.error_count, JSON_SCHEMA_MAX_ERRORS + 1);
  assert.equal(answer.truncated, true);
});

test('json-schema-check: unknown keywords, bad schemas and unsafe patterns are refused', async () => {
  const check = (schema: unknown, doc = '"a"') =>
    run('json-schema-check', { json: doc, schema: JSON.stringify(schema) });
  const refuse = async (schema: unknown, message: RegExp, doc?: string) =>
    assert.rejects(check(schema, doc), (error: unknown) => {
      assert.ok(error instanceof OfferKindInputError, String(error));
      assert.match(error.message, message);
      return true;
    });
  await refuse({ $ref: '#/x' }, /"\$ref", which this service does not check/);
  await refuse({ properties: { a: { format: 'email' } } }, /schema \/properties\/a uses "format"/);
  await refuse({ type: 'text' }, /type that is not one of/);
  await refuse({ minLength: -1 }, /whole number/);
  await refuse({ required: [1] }, /list of names/);
  await refuse(5, /is not a schema/);
  await refuse({ pattern: '(a+)+$' }, /repeats a group/);
  await refuse({ pattern: '(a|aa)*' }, /repeats a group/);
  await refuse({ pattern: '((a+))+' }, /repeats a group/);
  await refuse({ pattern: '(a+){16}' }, /repeats a group/);
  await refuse({ pattern: 'a*b*c*' }, /more than 2 unbounded/);
  await refuse({ pattern: '(a)\\1' }, /backreference/);
  await refuse({ pattern: '(?=a)a' }, /lookaround/);
  await refuse({ pattern: 'a'.repeat(129) }, /longer than 128/);
  await refuse({ pattern: '[' }, /never closes/);
  await refuse({ pattern: '\\' }, /not a valid regular expression/);
  await refuse({ pattern: 'a' }, /longer than 1000 characters/, JSON.stringify('a'.repeat(1001)));
  await refuse(
    { items: { pattern: 'a' } },
    /more than 100 pattern checks/,
    JSON.stringify(Array(101).fill('a')),
  );
  let nested: unknown = {};
  for (let i = 0; i < 40; i++) nested = { items: nested };
  await refuse(nested, /nested more than 32/);
  await refuse({}, /schema is not valid JSON|json is not valid JSON/, '{');
  // Safe patterns pass, and run.
  assert.equal(patternProblem('^(?:[a-z]{2,8})?-[0-9]+$'), null);
  assert.equal(patternProblem('^(?<year>\\d{4})-(\\d{2})$'), null);
  assert.equal(patternProblem('^(ab|cd)?x$'), null);
  const ok = await json('json-schema-check', {
    json: '"2026-10"',
    schema: JSON.stringify({ pattern: '^(?<year>\\d{4})-(\\d{2})$' }),
  });
  assert.equal(ok.valid, true);
});

// ---------------------------------------------------------------- csv-stats

test('csv-stats: types, counts, distinct values and numeric statistics per column', async () => {
  const answer = await json('csv-stats', {
    text: 'name,age,score,ok,blank\nAda,36,1.5,true,\nAlan,41,2,FALSE, \nAda,,2.5,true,\n',
  });
  assert.equal(answer.rows, 3);
  assert.deepEqual(answer.columns, [
    { name: 'name', type: 'string', count: 3, empty: 0, distinct: 2, distinct_capped: false },
    {
      name: 'age',
      type: 'integer',
      count: 3,
      empty: 1,
      distinct: 2,
      distinct_capped: false,
      min: 36,
      max: 41,
      mean: 38.5,
      median: 38.5,
      sum: 77,
    },
    {
      name: 'score',
      type: 'number',
      count: 3,
      empty: 0,
      distinct: 3,
      distinct_capped: false,
      min: 1.5,
      max: 2.5,
      mean: 2,
      median: 2,
      sum: 6,
    },
    { name: 'ok', type: 'boolean', count: 3, empty: 0, distinct: 2, distinct_capped: false },
    { name: 'blank', type: 'empty', count: 3, empty: 3, distinct: 0, distinct_capped: false },
  ]);
  const noHeader = await json('csv-stats', { text: '1;x\n2', delimiter: ';', header: false });
  assert.deepEqual(
    noHeader.columns.map((column: { name: string; type: string }) => [column.name, column.type]),
    [
      ['column_1', 'integer'],
      ['column_2', 'string'],
    ],
  );
  assert.equal(
    (await json('csv-stats', { text: '0.1\n0.2\n0.4', header: false })).columns[0].sum,
    0.7,
  );
});

test('csv-stats: caps and refusals', async () => {
  const distinct = await json('csv-stats', {
    text: `v\n${Array.from({ length: 1500 }, (_, i) => i).join('\n')}`,
  });
  assert.equal(distinct.columns[0].distinct, CSV_STATS_MAX_DISTINCT);
  assert.equal(distinct.columns[0].distinct_capped, true);
  assert.equal(distinct.columns[0].median, 749.5);
  await refused(
    'csv-stats',
    { text: 'a'.repeat(1) + ','.repeat(CSV_STATS_MAX_COLUMNS) },
    /more than 200 columns/,
  );
  await refused('csv-stats', { text: 'a"b' }, /quote inside a field/);
  await refused('csv-stats', { text: 'a\n'.repeat(10_001), header: false }, /more than 10000 rows/);
  await refused('csv-stats', { text: 'a', delimiter: ':' }, /must be one of/);
});

// ---------------------------------------------------------------- base-tx

test('base-tx: a mined transaction with its receipt, block time and ERC-20 transfers', async () => {
  const answer = await json('base-tx', { hash: TX_HASH.toUpperCase().replace('0X', '0x') });
  assert.deepEqual(answer, {
    chainId: 8453,
    hash: TX_HASH,
    from: '0x1111111111111111111111111111111111111111',
    to: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    value_wei: '1000000000000000',
    value_eth: '0.001',
    status: 'success',
    block: Number(TX_BLOCK),
    block_hash: BLOCK_HASH,
    timestamp: BLOCK_TIME,
    time: new Date(BLOCK_TIME * 1000).toISOString(),
    gas_used: '51234',
    effective_gas_price: '6000000',
    effective_gas_price_gwei: '0.006',
    fee_eth: '0.000000307404',
    erc20_transfers: [
      {
        token: USDC_CHECKSUMMED,
        from: FROM,
        to: TO,
        amount_raw: '1500000',
      },
    ],
    erc20_transfer_count: 1,
  });
});

test('base-tx: pending, not found, malformed, capped transfers and a reorg', async () => {
  setOfferKindDeps({ readBase: chain({ getTransactionReceipt: async () => null }) });
  const pending = await json('base-tx', { hash: TX_HASH });
  assert.equal(pending.status, 'pending');
  assert.equal(pending.block, null);
  assert.deepEqual(pending.erc20_transfers, []);
  setOfferKindDeps({ readBase: chain({ getTransaction: async () => null }) });
  const missing = await failure('base-tx', { hash: TX_HASH }, 422, 'tx_not_found');
  assert.equal(missing.retryable, true);
  setOfferKindDeps({
    readBase: chain({ getTransaction: async () => ({ hash: `0x${'00'.repeat(32)}` }) as never }),
  });
  await failure('base-tx', { hash: TX_HASH }, 502, 'chain_unavailable');
  setOfferKindDeps({ readBase: chain({ getTransaction: async () => assert.fail('down') }) });
  await failure('base-tx', { hash: TX_HASH }, 502, 'chain_unavailable');
  // Another block hash than the receipt's: refused, never mixed.
  setOfferKindDeps({
    readBase: chain({ getTransactionReceipt: async () => fakeReceipt(`0x${'ee'.repeat(32)}`) }),
  });
  await failure('base-tx', { hash: TX_HASH }, 502, 'chain_unavailable');
  // 80 transfers, an ERC-721 Transfer (4 topics) and another event: 50 listed, 80 counted.
  const nft = { ...transferLog(1n), topics: [...transferLog(1n).topics, `0x${'0'.repeat(63)}7`] };
  const other = {
    ...transferLog(1n),
    topics: [`0x${'11'.repeat(32)}`, ...transferLog(1n).topics.slice(1)],
  };
  setOfferKindDeps({
    readBase: chain({
      getTransactionReceipt: async () =>
        fakeReceipt(BLOCK_HASH, [
          ...Array.from({ length: 80 }, (_, i) => transferLog(BigInt(i))),
          nft,
          other,
        ]),
    }),
  });
  const many = await json('base-tx', { hash: TX_HASH });
  assert.equal(many.erc20_transfers.length, BASE_TX_MAX_TRANSFERS);
  assert.equal(many.erc20_transfer_count, 80);
  await refused('base-tx', { hash: `0x${'g'.repeat(64)}` }, /expected form/);
  await refused('base-tx', {}, /hash is required/);
});

// ---------------------------------------------------------------- base-erc20-balance

test('base-erc20-balance: balance, decimals and symbol, all at the latest block', async () => {
  const pinned: bigint[] = [];
  setOfferKindDeps({
    readBase: chain({
      call: async (args) => {
        pinned.push(args.blockNumber);
        return chainExtras(HEAD, BLOCK_HASH).call(args);
      },
    }),
  });
  const answer = await json('base-erc20-balance', {
    address: '0x0000000000000000000000000000000000000001',
    token: TOKEN,
  });
  assert.deepEqual(answer, {
    chainId: 8453,
    address: '0x0000000000000000000000000000000000000001',
    token: USDC_CHECKSUMMED,
    balance_raw: '1234500000',
    decimals: 6,
    symbol: 'USDC',
    balance: '1234.5',
    block: Number(HEAD),
    block_hash: BLOCK_HASH,
  });
  assert.deepEqual(pinned, [HEAD, HEAD, HEAD]);
});

test('base-erc20-balance: not a token, optional decimals and symbol, failures, refusals', async () => {
  const revert = () => Promise.reject(Object.assign(new Error('execution reverted'), { code: 3 }));
  const input = { address: '0x0000000000000000000000000000000000000001', token: TOKEN };
  setOfferKindDeps({ readBase: chain({ call: revert }) });
  const notToken = await failure('base-erc20-balance', input, 422, 'not_a_token');
  assert.equal(notToken.retryable, false);
  setOfferKindDeps({ readBase: chain({ call: async () => ({ data: '0x' }) }) });
  await failure('base-erc20-balance', input, 422, 'not_a_token');
  setOfferKindDeps({
    readBase: chain({
      call: async (args) =>
        args.data.startsWith('0x70a08231') ? chainExtras(HEAD, BLOCK_HASH).call(args) : revert(),
    }),
  });
  const bare = await json('base-erc20-balance', input);
  assert.equal(bare.balance_raw, '1234500000');
  assert.equal(bare.decimals, null);
  assert.equal(bare.symbol, null);
  assert.equal(bare.balance, null);
  setOfferKindDeps({
    readBase: chain({ call: () => Promise.reject(new Error('socket hang up')) }),
  });
  await failure('base-erc20-balance', input, 502, 'chain_unavailable');
  setOfferKindDeps({ readBase: null });
  await failure('base-erc20-balance', input, 503, 'unavailable');
  await refused(
    'base-erc20-balance',
    { address: input.address, token: USDC_MIXED },
    /token must be all lower case/,
  );
  await refused('base-erc20-balance', { address: input.address }, /token is required/);
  // A bytes32 symbol (older tokens) and control characters.
  assert.equal(
    readSymbol(`0x4d4b520000000000000000000000000000000000000000000000000000000000`),
    'MKR',
  );
  assert.equal(readSymbol('0x1234'), null);
});

// ---------------------------------------------------------------- base-gas

test('base-gas: base fees, priority fee and gas price in gwei and wei', async () => {
  const answer = await json('base-gas', {});
  assert.deepEqual(answer, {
    chainId: 8453,
    block: Number(HEAD),
    base_fee_gwei: '0.0054',
    next_base_fee_gwei: '0.0055',
    suggested_priority_gwei: '0.000003',
    gas_price_gwei: '0.0056',
    base_fee_wei: '5400000',
    next_base_fee_wei: '5500000',
    suggested_priority_wei: '3000',
    gas_price_wei: '5600000',
    blocks: 5,
  });
  setOfferKindDeps({
    readBase: chain({
      getFeeHistory: async () => ({ oldestBlock: HEAD, baseFeePerGas: [1n, 2n] }),
    }),
  });
  const noRewards = await json('base-gas', {});
  assert.equal(noRewards.suggested_priority_gwei, null);
  assert.equal(noRewards.block, Number(HEAD));
  setOfferKindDeps({
    readBase: chain({ getFeeHistory: async () => ({ oldestBlock: HEAD, baseFeePerGas: [] }) }),
  });
  await failure('base-gas', {}, 502, 'chain_unavailable');
  setOfferKindDeps({ readBase: chain({ getGasPrice: async () => -1n }) });
  await failure('base-gas', {}, 502, 'chain_unavailable');
  await refused('base-gas', { fast: true }, /takes no fields/);
});

test('every run of this file agreed with check() (refused there, or never refused after payment)', () => {
  checkAgreementSeen(agreement, 10);
});
