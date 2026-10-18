import assert from 'node:assert/strict';
import { createSocket } from 'node:dgram';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { connect as netConnect, type AddressInfo } from 'node:net';
import { performance } from 'node:perf_hooks';
import test, { beforeEach } from 'node:test';
import { createPublicClient, http } from 'viem';
import { base } from 'viem/chains';
import { isPublicAddress } from '../server/oauth/clients.js';
import {
  checkOffer,
  OFFER_KIND_REGISTRY,
  OFFER_ANSWER_MAX_BYTES,
  OfferKindFailure,
  OfferKindInputError,
  offerKind,
  resetOfferKindDeps,
  setOfferKindDeps,
  type OfferKindAnswer,
  type OfferKindContext,
} from '../server/feed/offers/kinds.js';
import {
  BASE_READ_TIMEOUT_MS,
  BASE_USDC,
  offerBaseReaderFromEnv,
  type OfferBaseReader,
} from '../server/feed/offers/kinds-base.js';
import {
  checkJson,
  compareCodePoints,
  findJsonError,
  indentJson,
  JSON_CHECK_KEYS_MAX_BYTES,
  textStats,
} from '../server/feed/offers/kinds-text.js';
import { convertUnit } from '../server/feed/offers/kinds-units.js';
import { capText, WEB_READ_LIMITS } from '../server/feed/offers/kinds-web.js';
import { decodeEntities, htmlToText } from '../server/feed/offers/html-text.js';
import {
  createSafeFetch,
  createSystemResolve,
  maxBodyPieces,
  openPinnedSocket,
  pinnedLookup,
  publicUrlProblem,
  SAFE_FETCH_USER_AGENT,
  SafeFetchError,
  type ConnectTarget,
  type FetchPublic,
  type PublicFetchResponse,
  type ResolvedAddress,
  type SafeFetchOptions,
} from '../server/feed/offers/safe-fetch.js';
import { OFFER_KIND_SPECS, OFFER_KINDS, type OfferKindName } from '../shared/feed-offers.js';
import { agreeingRun, agreementLog, checkAgreementSeen } from './feed-offer-kinds-agree.js';
import { chainExtras } from './feed-offer-kinds-chain.js';

const USDC_LOWER = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';

const NOW = Date.UTC(2026, 9, 15, 12, 0, 0);
const BLOCK_TIME = NOW / 1000 - 4;
const HASH = `0x${'ab'.repeat(32)}`;
const HEAD = 36_000_000n;

const noFetch: FetchPublic = async () => {
  throw new Error('no web read in this case');
};

/** A chain whose head is HEAD; any block up to it exists. */
const chain = (overrides: Partial<OfferBaseReader> = {}): OfferBaseReader => ({
  getBlock: async (args) => ({
    number: 'blockNumber' in args ? args.blockNumber : HEAD,
    hash: HASH,
    timestamp: BigInt(BLOCK_TIME),
  }),
  readContract: async () => 0n,
  ...chainExtras(HEAD, HASH),
  ...overrides,
});

beforeEach(() => {
  resetOfferKindDeps();
  setOfferKindDeps({ fetchPublic: noFetch, readBase: chain() });
});

const context = (overrides: Partial<OfferKindContext> = {}): OfferKindContext => ({
  signal: new AbortController().signal,
  now: NOW,
  ...overrides,
});

/** Every run is also checked against the pre-payment check (feed-offer-kinds-agree.ts). */
const agreement = agreementLog();
const run = (kind: OfferKindName, input: unknown, ctx: OfferKindContext = context()) =>
  agreeingRun(OFFER_KIND_REGISTRY.get(kind)!, input, ctx, agreement);

/** The JSON body of an answer. */
async function json(answer: Promise<OfferKindAnswer>): Promise<Record<string, unknown>> {
  const { body, mime } = await answer;
  assert.equal(mime, 'application/json');
  assert.equal(typeof body, 'object');
  assert.ok(Buffer.byteLength(JSON.stringify(body)) <= OFFER_ANSWER_MAX_BYTES);
  return body as Record<string, unknown>;
}

/** The text body of a web-read answer. */
async function text(answer: Promise<OfferKindAnswer>): Promise<string> {
  const { body, mime } = await answer;
  assert.equal(mime, 'text/plain');
  assert.equal(typeof body, 'string');
  assert.ok(Buffer.byteLength(body as string) <= OFFER_ANSWER_MAX_BYTES);
  return body as string;
}

async function inputError(
  answer: Promise<unknown>,
  message?: RegExp,
): Promise<OfferKindInputError> {
  let caught: unknown;
  await assert.rejects(answer, (error: unknown) => {
    caught = error;
    return error instanceof OfferKindInputError;
  });
  const error = caught as OfferKindInputError;
  if (message) assert.match(error.message, message);
  return error;
}

async function failure(
  answer: Promise<unknown>,
  status: number,
  code: string,
): Promise<OfferKindFailure> {
  let caught: unknown;
  await assert.rejects(answer, (error: unknown) => {
    caught = error;
    return error instanceof OfferKindFailure;
  });
  const error = caught as OfferKindFailure;
  assert.equal(error.status, status, error.message);
  assert.equal(error.code, code, error.message);
  assert.equal(typeof error.message, 'string');
  return error;
}

// ---------------------------------------------------------------- the local web for web-read

/** Public-looking answers of the fake resolver; every connection still goes to the local server. */
const DNS: Record<string, ResolvedAddress[]> = {
  'news.example.com': [{ address: '93.184.216.34', family: 4 }],
  'other.example.com': [
    { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 },
    { address: '93.184.216.35', family: 4 },
  ],
  'private.example.com': [{ address: '192.168.1.10', family: 4 }],
  'mixed.example.com': [
    { address: '93.184.216.36', family: 4 },
    { address: '10.0.0.5', family: 4 },
  ],
  'v6private.example.com': [{ address: 'fd00::1', family: 6 }],
  'mapped.example.com': [{ address: '::ffff:127.0.0.1', family: 6 }],
  // Two names on one address (subdomains): they share the per-address budget.
  'a.shared.example.com': [{ address: '93.184.216.40', family: 4 }],
  'b.shared.example.com': [{ address: '93.184.216.40', family: 4 }],
};

type Route = (req: IncomingMessage, res: ServerResponse) => void;

interface Site {
  fetchPublic: FetchPublic;
  /** host + path of every request the local server received, in order. */
  hits: string[];
  resolved: string[];
  opened: ConnectTarget[];
  requests: IncomingMessage[];
}

/**
 * A local plain-HTTP server behind the safe fetch: the fake resolver answers DNS, and every
 * connection (https ones included: `tls` is ignored) goes to 127.0.0.1. The site's fetcher is set
 * as the kinds' fetchPublic.
 */
async function withSite(
  routes: Record<string, Route>,
  body: (site: Site) => Promise<void>,
  options: Pick<SafeFetchOptions, 'limits' | 'now'> = {},
) {
  const site: Site = {
    fetchPublic: undefined as unknown as FetchPublic,
    hits: [],
    resolved: [],
    opened: [],
    requests: [],
  };
  const server = createServer((req, res) => {
    const key = `${req.headers.host}${req.url}`;
    site.hits.push(key);
    site.requests.push(req);
    const route = routes[key];
    if (route) return route(req, res);
    res.writeHead(404, { 'content-type': 'text/html' });
    res.end('<title>Missing</title><p>No such page</p>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  site.fetchPublic = createSafeFetch({
    ...options,
    resolve: async (host) => {
      site.resolved.push(host);
      const answers = DNS[host];
      if (!answers) throw Object.assign(new Error('not found'), { code: 'ENOTFOUND' });
      return answers;
    },
    openSocket: (target) => {
      site.opened.push(target);
      return netConnect({ host: '127.0.0.1', port });
    },
  });
  setOfferKindDeps({ fetchPublic: site.fetchPublic });
  try {
    await body(site);
    // Whatever happened, a connection only ever got checked public addresses.
    for (const target of site.opened)
      for (const entry of target.addresses)
        assert.ok(isPublicAddress(entry.address), entry.address);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

const page =
  (
    type: string,
    content: string | Buffer,
    status = 200,
    headers: Record<string, string> = {},
  ): Route =>
  (_req, res) => {
    res.writeHead(status, { 'content-type': type, ...headers });
    res.end(content);
  };
const redirect =
  (location: string, status = 302): Route =>
  (_req, res) => {
    res.writeHead(status, { location });
    res.end();
  };

const ARTICLE = `<!doctype html>
<html><head><meta charset="utf-8"><title> Fresh &amp; Local
  News </title>
<style>body { color: red }</style><script>var secret = "do not show";</script></head>
<body><!-- hidden comment --><h1>Top story</h1><p>Rain <b>tomorrow</b>,&nbsp;sun on Friday &mdash; maybe.</p>
<noscript>enable scripts</noscript><ul><li>One</li><li>Two</li></ul><SCRIPT type="x">ALSO HIDDEN</SCRIPT >
<p>a &lt; b &#38; c &#x263A; &bogus; &constructor;</p></body></html>`;

const read = (url: string, ctx?: OfferKindContext, maxChars?: number) =>
  run('web-read', maxChars === undefined ? { url } : { url, max_chars: maxChars }, ctx);

const fixed =
  (response: Partial<PublicFetchResponse> & { body: Buffer }): FetchPublic =>
  async () => ({
    url: 'https://news.example.com/',
    status: 200,
    contentType: 'text/plain',
    charset: null,
    redirects: 0,
    ...response,
  });

// ---------------------------------------------------------------- registry

test('the registry holds every kind of OFFER_KINDS, each with its spec input and output', () => {
  assert.deepEqual([...OFFER_KIND_REGISTRY.keys()].sort(), [...OFFER_KINDS].sort());
  for (const name of OFFER_KINDS) {
    const kind = offerKind(name);
    assert.ok(kind, name);
    assert.equal(kind.name, name);
    assert.equal(kind.inputSchema, OFFER_KIND_SPECS[name].input);
    assert.equal(kind.outputMime, OFFER_KIND_SPECS[name].outputMime);
  }
});

test("every kind answers its spec's example, offline", async () => {
  setOfferKindDeps({
    fetchPublic: fixed({ url: 'https://example.com/', body: Buffer.from('Example Domain') }),
  });
  for (const name of OFFER_KINDS) {
    const answer = await run(name, OFFER_KIND_SPECS[name].example);
    assert.equal(answer.mime, OFFER_KIND_SPECS[name].outputMime, name);
    const size = Buffer.byteLength(
      typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body),
    );
    assert.ok(size > 0 && size <= OFFER_ANSWER_MAX_BYTES, name);
  }
});

test('a viem public client for Base fits the reader interface; the reader is built from settings', () => {
  // Compile-time check: no request is made (the transport is never used).
  const client = createPublicClient({ chain: base, transport: http('http://127.0.0.1:9') });
  const reader: OfferBaseReader = client;
  assert.equal(typeof reader.getBlock, 'function');
  assert.equal(typeof reader.readContract, 'function');
  // Without the mainnet gate or an endpoint there is no reader; building one reads nothing.
  assert.equal(offerBaseReaderFromEnv({}), null);
  assert.equal(offerBaseReaderFromEnv({ CITY_BASE_MAINNET: '1' }), null);
  assert.equal(offerBaseReaderFromEnv({ CITY_BASE_RPC_URL: 'http://127.0.0.1:9' }), null);
});

// ---------------------------------------------------------------- input handling

test('input: not an object, unknown fields, missing fields and wrong types are input errors', async () => {
  for (const name of OFFER_KINDS) {
    await inputError(run(name, null), /must be a JSON object/);
    await inputError(run(name, []), /must be a JSON object/);
    await inputError(run(name, '{}'), /must be a JSON object/);
    await inputError(run(name, { surprise: 1 }), /takes (only|no fields)/);
  }
  await inputError(run('text-stats', {}), /text is required/);
  await inputError(run('text-stats', { text: 5 }), /text must be text/);
  await inputError(run('unit-convert', { value: '1', from: 'm', to: 'km' }), /value must be/);
  await inputError(run('base-block', { number: 1.5 }), /whole number/);
  await inputError(run('base-block', { number: -1 }), /out of range/);
  await inputError(run('web-read', { url: 'https://news.example.com/', max_chars: 0 }), /range/);
  await inputError(
    run('web-read', { url: 'https://news.example.com/', max_chars: 20_001 }),
    /range/,
  );
  // The same input gives the same answer.
  assert.deepEqual(
    await run('text-stats', { text: 'one two' }),
    await run('text-stats', { text: 'one two' }),
  );
});

test('input: a text field is capped at 64 KiB of UTF-8, however many characters that is', async () => {
  const accented = '\u00e9'.repeat(32_768);
  assert.equal((await json(run('text-stats', { text: accented }))).chars, 32_768);
  await inputError(run('text-stats', { text: `${accented}a` }), /longer than 65536 bytes/);
  await inputError(run('json-check', { text: 'a'.repeat(65_537) }), /longer than 65536 bytes/);
  // 64 KiB of newlines: one text, 65536 lines.
  assert.equal((await json(run('text-stats', { text: '\n'.repeat(65_536) }))).lines, 65_536);
});

test('the call ends when its signal aborts: no kind answers after that', async () => {
  const controller = new AbortController();
  controller.abort(new Error('time is up'));
  const ctx = context({ signal: controller.signal });
  for (const name of OFFER_KINDS)
    await assert.rejects(run(name, OFFER_KIND_SPECS[name].example, ctx), /time is up/, name);
});

// ---------------------------------------------------------------- web-read

test('web-read: reads a page and answers its visible text only, as text/plain', async () => {
  await withSite(
    { 'news.example.com/article': page('text/html; charset=utf-8', ARTICLE) },
    async (site) => {
      assert.equal(
        await text(read('https://news.example.com/article#top')),
        'Top story Rain tomorrow, sun on Friday \u2014 maybe. One Two a < b & c \u263a &bogus; &constructor;',
      );
      // One lookup, one connection, pinned to exactly the checked answers.
      assert.deepEqual(site.resolved, ['news.example.com']);
      assert.equal(site.opened.length, 1);
      assert.deepEqual(site.opened[0], {
        hostname: 'news.example.com',
        port: 443,
        tls: true,
        addresses: DNS['news.example.com'],
      });
      assert.deepEqual(site.hits, ['news.example.com/article']);
      const headers = site.requests[0]!.headers;
      assert.equal(headers['accept-encoding'], 'identity');
      assert.equal(headers.cookie, undefined);
      assert.equal(headers.authorization, undefined);
      assert.equal(site.requests[0]!.method, 'GET');
    },
  );
});

test('web-read: plain text, JSON, XML, charsets, and a page that is not 2xx', async () => {
  const latin1 = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x20, 0x20, 0x0a, 0x6f, 0x6b]);
  const sniffed = Buffer.concat([
    Buffer.from('<html><head><meta charset="windows-1252"><title>Price</title></head><p>5 '),
    Buffer.from([0x80]),
    Buffer.from('</p>'),
  ]);
  await withSite(
    {
      'news.example.com/plain': page('text/plain; charset=iso-8859-1', latin1),
      'news.example.com/data': page('application/json; charset=utf-8', '{"a": 1,\n   "b": [true]}'),
      'news.example.com/feed': page(
        'application/xml',
        '<?xml version="1.0"?><rss><channel><title>Feed &amp; more</title><item><![CDATA[x < y &amp; z]]></item></channel></rss>',
      ),
      'news.example.com/sniff': page('text/html', sniffed),
      'news.example.com/odd': page('text/plain; charset=no-such-charset', 'still read'),
      'news.example.com/down': page('text/plain', 'maintenance', 503),
    },
    async () => {
      assert.equal(await text(read('https://news.example.com/plain')), 'caf\u00e9 ok');
      assert.equal(await text(read('https://news.example.com/data')), '{"a": 1, "b": [true]}');
      assert.equal(await text(read('https://news.example.com/feed')), 'x < y &amp; z');
      assert.equal(await text(read('https://news.example.com/sniff')), '5 \u20ac');
      assert.equal(await text(read('https://news.example.com/odd')), 'still read');
      // An error page is not an answer: the request went out, so the call settles.
      const missing = await failure(read('https://news.example.com/gone'), 422, 'page_status');
      assert.match(missing.message, /404/);
      assert.equal(missing.outboundSent, true);
      assert.equal(missing.retryable, false);
      const down = await failure(read('https://news.example.com/down'), 422, 'page_status');
      assert.equal(down.retryable, true);
    },
  );
});

const LITERAL_REFUSALS = [
  'http://127.0.0.1/',
  'http://127.0.0.1:80/admin',
  'http://10.0.0.1/',
  'http://172.16.0.1/',
  'http://192.168.1.1/',
  'http://169.254.169.254/latest/meta-data/',
  'http://100.64.0.1/',
  'http://0.0.0.0/',
  'http://0/',
  'http://127.1/',
  'http://[::1]/',
  'http://[::]/',
  'http://[fc00::1]/',
  'http://[fd00:ec2::254]/',
  'http://[fe80::1]/',
  'http://[ff02::1]/',
  'http://[::ffff:127.0.0.1]/',
  'http://[::ffff:169.254.169.254]/',
  'http://224.0.0.1/',
  'http://2130706433/',
  'http://0x7f000001/',
  'http://017700000001/',
  'http://0x7f.1/',
  'https://localhost/',
  'http://localhost./',
  'http://intranet/',
  'http://metadata.google.internal/computeMetadata/v1/',
  'http://printer.local/',
];
const STATIC_REFUSALS = [
  'http://user:pass@news.example.com/',
  'http://user@news.example.com/',
  'http://news.example.com:8080/',
  'https://news.example.com:8443/',
  'ftp://news.example.com/file.txt',
  'file:///etc/passwd',
  'gopher://news.example.com/',
  'javascript:alert(1)',
  'data:text/html,hello',
  'news.example.com/no-scheme',
  `https://news.example.com/${'a'.repeat(2100)}`,
];
const asHttps = (url: string) => url.replace(/^http:/, 'https:');

test('web-read SSRF: private, loopback, link-local, CGNAT, metadata and odd IPv4 forms are input errors', async () => {
  await withSite({}, async (site) => {
    for (const url of [...LITERAL_REFUSALS, ...STATIC_REFUSALS]) {
      // As written (http is refused by the spec's pattern) and as https (by the URL rules).
      await inputError(read(url));
      await inputError(read(asHttps(url)));
      assert.equal(publicUrlProblem(url) !== null, true, url);
      assert.equal(publicUrlProblem(asHttps(url)) !== null, true, url);
    }
    assert.deepEqual(site.resolved, []);
    assert.deepEqual(site.opened, []);
    await inputError(read('https://127.0.0.1/'), /^url must name a public host\.$/);
    // Plain http, even for a public name, is refused before any lookup.
    await inputError(read('http://news.example.com/'), /url is not in the expected form/);
    assert.deepEqual(publicUrlProblem('http://news.example.com/', { httpsOnly: true }), {
      kind: 'bad_url',
      reason: 'must use https',
    });
  });
});

test('safe fetch: refuses the same URLs by itself, before any lookup or connection', async () => {
  await withSite({}, async (site) => {
    const request = {
      timeoutMs: 1000,
      maxBytes: 1024,
      maxRedirects: 3,
      contentTypes: ['text/html'],
    };
    for (const url of LITERAL_REFUSALS)
      await assert.rejects(site.fetchPublic({ ...request, url }), (error: unknown) => {
        assert.ok(error instanceof SafeFetchError);
        assert.equal(error.kind, 'not_public', url);
        return true;
      });
    for (const url of STATIC_REFUSALS)
      await assert.rejects(site.fetchPublic({ ...request, url }), (error: unknown) => {
        assert.ok(error instanceof SafeFetchError);
        assert.equal(error.kind, 'bad_url', url);
        return true;
      });
    await assert.rejects(
      site.fetchPublic({ ...request, url: 'http://news.example.com/', httpsOnly: true }),
      (error: unknown) => error instanceof SafeFetchError && error.kind === 'bad_url',
    );
    assert.deepEqual(site.resolved, []);
    assert.deepEqual(site.opened, []);
  });
});

test('web-read SSRF: a name resolving to any non-public address is refused, never connected', async () => {
  await withSite({}, async (site) => {
    for (const host of [
      'private.example.com',
      'mixed.example.com',
      'v6private.example.com',
      'mapped.example.com',
    ]) {
      const refused = await failure(read(`https://${host}/`), 422, 'host_refused');
      assert.equal(refused.outboundSent, false);
    }
    assert.deepEqual(site.opened, []);
    // A missing name answers exactly like one with only private addresses: no way to list names
    // that exist inside a private zone.
    const missing = await failure(read('https://nowhere.example.com/'), 422, 'host_refused');
    const privateName = await failure(read('https://private.example.com/'), 422, 'host_refused');
    assert.equal(missing.message, privateName.message);
  });
  setOfferKindDeps({
    fetchPublic: createSafeFetch({
      resolve: async () => {
        throw Object.assign(new Error('server failure'), { code: 'ESERVFAIL' });
      },
      openSocket: () => assert.fail('never connects'),
    }),
  });
  const failed = await failure(read('https://news.example.com/'), 502, 'unreachable');
  assert.equal(failed.retryable, true);
});

test('web-read SSRF: a redirect to a private or plain-http target is refused before it is followed', async () => {
  await withSite(
    {
      'news.example.com/to-loopback': redirect('https://127.0.0.1/admin'),
      'news.example.com/to-metadata': redirect('https://169.254.169.254/latest/meta-data/', 301),
      'news.example.com/to-v6': redirect('https://[::1]:443/'),
      'news.example.com/to-private-name': redirect('https://private.example.com/', 307),
      'news.example.com/to-port': redirect('https://news.example.com:8080/'),
      'news.example.com/to-file': redirect('file:///etc/passwd', 308),
      'news.example.com/to-userinfo': redirect('https://user:pass@news.example.com/'),
      'news.example.com/to-http': redirect('http://news.example.com/plain'),
      'news.example.com/to-http-loopback': redirect('http://127.0.0.1/'),
    },
    async (site) => {
      for (const path of ['to-loopback', 'to-metadata', 'to-v6', 'to-private-name']) {
        const refused = await failure(
          read(`https://news.example.com/${path}`),
          422,
          'host_refused',
        );
        assert.equal(refused.outboundSent, true);
      }
      for (const path of ['to-port', 'to-file', 'to-userinfo', 'to-http', 'to-http-loopback'])
        await failure(read(`https://news.example.com/${path}`), 422, 'url_refused');
      // Only the first hop of each was ever connected; private.example.com was resolved, not opened.
      assert.equal(site.opened.length, 9);
      assert.ok(site.opened.every((target) => target.hostname === 'news.example.com'));
      assert.ok(site.resolved.includes('private.example.com'));
      assert.ok(!site.hits.includes('news.example.com/plain'));
    },
  );
});

test('web-read: up to 3 redirects are followed, each target checked and pinned again', async () => {
  await withSite(
    {
      'news.example.com/hop3': redirect('/hop2', 301),
      'news.example.com/hop2': redirect('https://other.example.com/hop1', 302),
      'other.example.com/hop1': redirect('/final?x=1', 303),
      'other.example.com/final?x=1': page('text/plain', 'arrived'),
      'news.example.com/loop': redirect('/loop'),
    },
    async (site) => {
      assert.equal(await text(read('https://news.example.com/hop3')), 'arrived');
      assert.deepEqual(site.resolved, [
        'news.example.com',
        'news.example.com',
        'other.example.com',
        'other.example.com',
      ]);
      assert.deepEqual(
        site.opened.map((target) => [target.hostname, target.addresses]),
        [
          ['news.example.com', DNS['news.example.com']],
          ['news.example.com', DNS['news.example.com']],
          ['other.example.com', DNS['other.example.com']],
          ['other.example.com', DNS['other.example.com']],
        ],
      );

      site.hits.length = 0;
      await failure(read('https://news.example.com/loop'), 422, 'too_many_redirects');
      // The first request and 3 followed redirects; the 4th redirect is not followed.
      assert.equal(site.hits.length, 4);
    },
  );
});

test('web-read: a body over 1 MiB aborts; a full one is read and its text capped by max_chars', async () => {
  const MiB = 1024 * 1024;
  await withSite(
    {
      'news.example.com/big': (_req, res) => {
        res.writeHead(200, { 'content-type': 'text/plain' });
        // Chunked, no declared length: the cap is enforced while reading.
        res.write(Buffer.alloc(MiB, 0x61));
        res.end(Buffer.from('b'));
      },
      'news.example.com/declared': (_req, res) => {
        res.writeHead(200, { 'content-type': 'text/plain', 'content-length': String(MiB + 1) });
        res.write('a');
      },
      'news.example.com/full': page('text/plain', Buffer.alloc(MiB, 'word ')),
      'news.example.com/wide': page('text/plain; charset=utf-8', Buffer.alloc(MiB, '\u{1F600}')),
    },
    async () => {
      const big = await failure(read('https://news.example.com/big'), 422, 'too_large');
      assert.equal(big.outboundSent, true);
      await failure(read('https://news.example.com/declared'), 422, 'too_large');
      const full = await text(read('https://news.example.com/full'));
      assert.equal(full.length, WEB_READ_LIMITS.maxChars);
      assert.ok(full.startsWith('word word '));
      assert.equal(await text(read('https://news.example.com/full', undefined, 9)), 'word word');
      // 20000 four-byte characters are more than 64 KiB: cut at a whole character.
      const wide = await text(read('https://news.example.com/wide'));
      assert.equal(Buffer.byteLength(wide), OFFER_ANSWER_MAX_BYTES);
      assert.equal(Array.from(wide).length, OFFER_ANSWER_MAX_BYTES / 4);
      assert.ok(Array.from(wide).every((char) => char === '\u{1F600}'));
    },
  );
  // Characters are code points: a cut never splits a surrogate pair.
  assert.equal(capText('a\u{1F600}b', 2, 100), 'a\u{1F600}');
  assert.equal(capText('\u{1F600}\u{1F600}', 5, 6), '\u{1F600}');
});

test('web-read: other content types and compressed bodies are refused before the body', async () => {
  await withSite(
    {
      'news.example.com/logo.png': page('image/png', Buffer.from([0x89, 0x50, 0x4e, 0x47])),
      'news.example.com/app.js': page('application/javascript', 'alert(1)'),
      'news.example.com/untyped': (_req, res) => {
        res.writeHead(200);
        res.end('no type');
      },
      'news.example.com/zipped': page('text/html', 'not really gzip', 200, {
        'content-encoding': 'gzip',
      }),
    },
    async () => {
      for (const path of ['logo.png', 'app.js', 'untyped'])
        await failure(read(`https://news.example.com/${path}`), 422, 'unsupported_content_type');
      await failure(read('https://news.example.com/zipped'), 422, 'unsupported_encoding');
    },
  );
});

test('safe fetch: one deadline covers a silent server, a slow body and a slow lookup', async () => {
  await withSite(
    {
      'news.example.com/silent': () => {},
      'news.example.com/trickle': (_req, res) => {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.write('first part');
      },
    },
    async (site) => {
      for (const path of ['silent', 'trickle']) {
        const started = Date.now();
        await assert.rejects(
          site.fetchPublic({
            url: `https://news.example.com/${path}`,
            timeoutMs: 200,
            maxBytes: 1024,
            maxRedirects: 3,
            contentTypes: ['text/plain'],
          }),
          (error: unknown) => error instanceof SafeFetchError && error.kind === 'timeout',
        );
        assert.ok(Date.now() - started < 2000);
      }
    },
  );
  const slowDns = createSafeFetch({
    resolve: () => new Promise(() => {}),
    openSocket: () => assert.fail('never connects'),
  });
  await assert.rejects(
    slowDns({
      url: 'https://news.example.com/',
      timeoutMs: 100,
      maxBytes: 1024,
      maxRedirects: 3,
      contentTypes: ['text/html'],
    }),
    (error: unknown) => error instanceof SafeFetchError && error.kind === 'timeout',
  );
  // web-read answers a timeout like a refused connection (502 unreachable, one fixed message), and
  // asks for a 5 s deadline, 1 MiB, 3 redirects, https only, with the call's signal and time.
  let asked: Record<string, unknown> = {};
  setOfferKindDeps({
    fetchPublic: async (request) => {
      asked = { ...request };
      throw new SafeFetchError('timeout', 'The page did not answer in time.');
    },
  });
  const ctx = context();
  await failure(read('https://news.example.com/', ctx), 502, 'unreachable');
  assert.deepEqual(asked, {
    url: 'https://news.example.com/',
    timeoutMs: 5000,
    maxBytes: 1024 * 1024,
    maxRedirects: 3,
    contentTypes: ['text/html', 'text/plain', 'application/json', 'application/xml'],
    httpsOnly: true,
    signal: ctx.signal,
    now: NOW,
  });
});

test("web-read: the call's signal ends a read in flight at once, with the call's own reason", async () => {
  await withSite({ 'news.example.com/silent': () => {} }, async (site) => {
    const controller = new AbortController();
    const started = performance.now();
    setTimeout(() => controller.abort(new Error('call ended')), 50);
    await assert.rejects(
      read('https://news.example.com/silent', context({ signal: controller.signal })),
      /call ended/,
    );
    assert.ok(performance.now() - started < 2000);
    assert.equal(site.opened.length, 1);
    // The fetcher's slot is free again.
    await assert.rejects(
      site.fetchPublic({
        url: 'https://news.example.com/silent',
        timeoutMs: 100,
        maxBytes: 1024,
        maxRedirects: 0,
        contentTypes: ['text/plain'],
      }),
      (error: unknown) => error instanceof SafeFetchError && error.kind === 'timeout',
    );
  });
});

test('safe fetch: a refused connection is unreachable (502)', async () => {
  const closed = createServer();
  await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
  const port = (closed.address() as AddressInfo).port;
  await new Promise((resolve) => closed.close(resolve));
  setOfferKindDeps({
    fetchPublic: createSafeFetch({
      resolve: async () => DNS['news.example.com']!,
      openSocket: () => netConnect({ host: '127.0.0.1', port }),
    }),
  });
  const refused = await failure(read('https://news.example.com/'), 502, 'unreachable');
  assert.equal(refused.outboundSent, true);
});

test('pinning: the lookup answers only with the checked addresses, whatever name it is asked', async () => {
  const checkedAddresses: ResolvedAddress[] = [
    { address: '93.184.216.34', family: 4 },
    { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 },
  ];
  const lookup = pinnedLookup(checkedAddresses);
  const ask = (options: unknown) =>
    new Promise<unknown[]>((resolve) =>
      lookup('rebound.example.com', options, (error, address, family) =>
        resolve([error?.code ?? null, address, family]),
      ),
    );
  assert.deepEqual(await ask({ all: true }), [null, checkedAddresses, undefined]);
  assert.deepEqual(await ask({ family: 6 }), [null, checkedAddresses[1]!.address, 6]);
  assert.deepEqual(await ask(4), [null, '93.184.216.34', 4]);
  assert.deepEqual(await ask({ all: true, family: 'IPv4' }), [
    null,
    [checkedAddresses[0]],
    undefined,
  ]);
  const v4only = pinnedLookup([checkedAddresses[0]!]);
  const missing = await new Promise<unknown>((resolve) =>
    v4only('x.example.com', { family: 6 }, (error) => resolve(error?.code)),
  );
  assert.equal(missing, 'ENOTFOUND');
});

test('pinning: the production socket connects to the checked address without any DNS lookup', async () => {
  const server = createServer((_req, res) => res.end('ok'));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    // .invalid never resolves: connecting proves the name was not looked up again.
    const socket = openPinnedSocket({
      hostname: 'pinned.invalid',
      port,
      tls: false,
      addresses: [{ address: '127.0.0.1', family: 4 }],
    });
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
    assert.equal(socket.remoteAddress, '127.0.0.1');
    assert.equal(socket.remotePort, port);
    socket.destroy();
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('html to text: linear on hostile markup, entities safe', () => {
  assert.deepEqual(htmlToText('<p>a</p><p>b</p>x<b>y</b>z'), { title: null, text: 'a b xyz' });
  assert.deepEqual(htmlToText('1 < 2 and 3 > 2'), { title: null, text: '1 < 2 and 3 > 2' });
  assert.deepEqual(htmlToText('<p>before<script>never closed'), { title: null, text: 'before' });
  assert.deepEqual(htmlToText('<title>Only</title><title>Second</title>body'), {
    title: 'Only',
    text: 'body',
  });
  assert.equal(
    decodeEntities('&#0;&#xD800;&#x110000;&#65;&AMP;&toString;'),
    '\ufffd\ufffd\ufffdA&&toString;',
  );
  const started = Date.now();
  htmlToText('<script>'.repeat(100_000));
  htmlToText('<a '.repeat(100_000));
  htmlToText('<x>'.repeat(300_000));
  htmlToText('<!--'.repeat(100_000));
  htmlToText('&amp'.repeat(200_000));
  assert.ok(Date.now() - started < 3000, 'linear time');
});

// ---------------------------------------------------------------- text-stats

test('text-stats: counts and top words', async () => {
  assert.deepEqual(
    await json(run('text-stats', { text: 'The cat sat. The cat ran!\nA dog barked?\n' })),
    {
      chars: 40,
      words: 9,
      lines: 2,
      sentences: 3,
      avgWordLength: 3.11,
      topWords: [
        { word: 'cat', count: 2 },
        { word: 'the', count: 2 },
        { word: 'a', count: 1 },
        { word: 'barked', count: 1 },
        { word: 'dog', count: 1 },
      ],
    },
  );
  assert.deepEqual(textStats(''), {
    chars: 0,
    words: 0,
    lines: 0,
    sentences: 0,
    avgWordLength: 0,
    topWords: [],
  });
  const unicode = textStats("Na\u00efve caf\u00e9 \ud83d\udc4d. Pi is 3.14 and isn't 22/7");
  // Code points: the emoji is one character, not two UTF-16 units.
  assert.equal(unicode.chars, 39);
  // Naive, cafe, Pi, is, 3.14, and, isn't, 22, 7 (the emoji is not a word).
  assert.equal(unicode.words, 9);
  assert.equal(unicode.sentences, 2);
  assert.equal(unicode.lines, 1);
  // Letter words only (a contraction stays whole), case-folded: digits never count as top words.
  assert.deepEqual(
    unicode.topWords.map((entry) => entry.word),
    ['and', 'caf\u00e9', 'is', "isn't", 'na\u00efve'],
  );
});

test('text-stats: five huge words do not make the answer larger than the text', async () => {
  const words = ['a', 'b', 'c', 'd', 'e'].map((letter) => letter.repeat(13_000)).join(' ');
  const stats = await json(run('text-stats', { text: words }));
  assert.equal(stats.words, 5);
  // Longer than 64 characters: counted as words, never listed as top words.
  assert.deepEqual(stats.topWords, []);
  assert.deepEqual(textStats(`${'x'.repeat(64)} ${'y'.repeat(65)}`).topWords, [
    { word: 'x'.repeat(64), count: 1 },
  ]);
});

test('text-stats: a long run of sentence marks costs linear time', async () => {
  const OLD_SENTENCE_END = /[.!?]+(?=\s|$)|[\u3002\uff01\uff1f]+/u;
  const NEW_SENTENCE_END = /(?<![.!?])[.!?]+(?=\s|$)|[\u3002\uff01\uff1f]+/u;
  // Same split as the old pattern on short random texts.
  const alphabet = ['.', '!', '?', '\u3002', ' ', '\n', 'a', 'b', '1'];
  let seed = 7;
  const random = () => (seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648) / 2_147_483_648;
  for (let round = 0; round < 3000; round++) {
    const sample = Array.from(
      { length: Math.floor(random() * 24) },
      () => alphabet[Math.floor(random() * alphabet.length)]!,
    ).join('');
    assert.deepEqual(sample.split(NEW_SENTENCE_END), sample.split(OLD_SENTENCE_END), sample);
  }
  // 64 KiB now (8 times the old cap): still linear.
  for (const value of ['.'.repeat(65_535) + 'x', '!?'.repeat(32_767) + 'a']) {
    const started = performance.now();
    const result = await json(run('text-stats', { text: value }));
    const elapsed = performance.now() - started;
    assert.equal(result.sentences, 1);
    assert.ok(elapsed < 100, `${elapsed} ms`);
  }
  assert.equal(textStats('Wait... what?! Yes. No').sentences, 4);
});

test('text-stats: contractions stay whole in top words, decimals are one word, Unicode line breaks count', () => {
  assert.deepEqual(textStats("don't don't don\u2019t it's it's").topWords, [
    { word: "don't", count: 3 },
    { word: "it's", count: 2 },
  ]);
  const costs = textStats('It costs 3.50 or 1,000 dollars.');
  assert.equal(costs.words, 6);
  assert.equal(costs.sentences, 1);
  assert.equal(textStats('a\u2028b\u2029c\u0085d').lines, 4);
  assert.deepEqual(textStats('a\r\nb\r\n'), {
    chars: 6,
    words: 2,
    lines: 2,
    sentences: 1,
    avgWordLength: 1,
    topWords: [
      { word: 'a', count: 1 },
      { word: 'b', count: 1 },
    ],
  });
  // Ties in code point order: U+FF46 before U+1D41A (UTF-16 units would say the opposite).
  assert.deepEqual(
    textStats('\uff46 \u{1d41a}').topWords.map((entry) => entry.word),
    ['\uff46', '\u{1d41a}'],
  );
  assert.ok(compareCodePoints('\uff46', '\u{1d41a}') < 0);
  assert.ok(compareCodePoints('ab', 'a') > 0);
  assert.equal(compareCodePoints('\u{1d41a}x', '\u{1d41a}x'), 0);
});

// ---------------------------------------------------------------- json-check

test('json-check: valid JSON with type, keys and an indented copy', async () => {
  const value = '{"b": [1, 2, {"c": null}], "a": "x", "n": {}, "e": []}';
  assert.deepEqual(await json(run('json-check', { text: value })), {
    valid: true,
    type: 'object',
    keys: ['b', 'a', 'n', 'e'],
    keyCount: 4,
    pretty: JSON.stringify(JSON.parse(value), null, 2),
  });
  for (const [input, type, pretty] of [
    ['[1]', 'array', '[\n  1\n]'],
    ['"s"', 'string', '"s"'],
    // The number as written, not as a double prints it.
    [' -1.5e3 ', 'number', '-1.5e3'],
    ['true', 'boolean', 'true'],
    ['null', 'null', 'null'],
  ] as const) {
    const check = checkJson(input);
    assert.equal(check.valid, true);
    assert.equal(check.type, type);
    assert.equal(check.pretty, pretty);
    assert.equal(check.keys, undefined);
  }
});

test('json-check: the first error with its line and column', async () => {
  const cases: Array<[string, { message: string; line: number; column: number }]> = [
    [
      '{"a": 1,}',
      { message: 'Expected a double-quoted property name but found "}"', line: 1, column: 9 },
    ],
    ['{\n  "a": tru\n}', { message: 'Expected a value but found "t"', line: 2, column: 8 }],
    ['', { message: 'Unexpected end of input, expected a value', line: 1, column: 1 }],
    ['[1, 2', { message: "Unexpected end of input, expected ',' or ']'", line: 1, column: 6 }],
    [
      '{"a" 1}',
      { message: 'Expected \':\' after the property name but found "1"', line: 1, column: 6 },
    ],
    ['{} x', { message: 'Expected the end of the input but found "x"', line: 1, column: 4 }],
    ['"open', { message: 'Unterminated string', line: 1, column: 1 }],
    ['["a\\x"]', { message: 'Invalid escape sequence in a string', line: 1, column: 4 }],
    ['[01]', { message: 'Invalid number', line: 1, column: 3 }],
    [
      "{'a': 1}",
      { message: 'Expected a double-quoted property name but found "\'"', line: 1, column: 2 },
    ],
    [
      '["\t"]',
      { message: 'Control character in a string (it must be escaped)', line: 1, column: 3 },
    ],
    ['\r\n\r\n  ]', { message: 'Expected a value but found "]"', line: 3, column: 3 }],
  ];
  for (const [value, error] of cases)
    assert.deepEqual(
      await json(run('json-check', { text: value })),
      { valid: false, error },
      value,
    );
});

test('json-check: validity always agrees with JSON.parse; deep nesting is safe', () => {
  const samples = [
    '{}',
    '[]',
    '[1,]',
    '[,1]',
    '{"a":1 "b":2}',
    '1 2',
    '-',
    '-0',
    '0.5',
    '.5',
    '1e5',
    '1e',
    '1.e3',
    '"\\u00e9"',
    '"\\u00g9"',
    '"\\/"',
    'nul',
    'null ',
    ' [ { } , [ ] ] ',
    '{"a":{"b":[1,{"c":"d"}]}}',
    '\ufeff{}',
    '{"a":1}}',
    '[[[]]',
    '["\\""]',
    '"\\',
    'true false',
    '{"__proto__": 1}',
    '1.5E+3',
  ];
  for (const sample of samples) {
    let parses = true;
    try {
      JSON.parse(sample);
    } catch {
      parses = false;
    }
    assert.equal(findJsonError(sample) === null, parses, sample);
    assert.equal(checkJson(sample).valid, parses, sample);
  }
  const deep = '['.repeat(30_000) + ']'.repeat(30_000);
  const check = checkJson(deep);
  assert.equal(check.valid, true);
  assert.equal(check.prettyTooLarge, true);
  assert.equal(check.pretty, undefined);
  assert.ok(findJsonError('['.repeat(60_000)));
  assert.equal(
    indentJson('{"a":[1,{"b":"x"}]}', 1024),
    JSON.stringify({ a: [1, { b: 'x' }] }, null, 2),
  );
  assert.equal(indentJson(JSON.stringify({ a: 'x'.repeat(100) }), 50), null);
});

test('json-check: the indented copy keeps every number, string and key as written', () => {
  const cases: Array<[string, string]> = [
    [
      '{"amount": 115792089237316195423570985008687907853269984665640564039457584007913129639935}',
      '{\n  "amount": 115792089237316195423570985008687907853269984665640564039457584007913129639935\n}',
    ],
    ['{"id": 12345678901234567890}', '{\n  "id": 12345678901234567890\n}'],
    ['[1e400, -0, 1.0, 1.10]', '[\n  1e400,\n  -0,\n  1.0,\n  1.10\n]'],
    ['{"a":1,"a":2}', '{\n  "a": 1,\n  "a": 2\n}'],
    ['"caf\\u00e9 \\"q\\" \\\\"', '"caf\\u00e9 \\"q\\" \\\\"'],
    ['1e400', '1e400'],
  ];
  for (const [value, pretty] of cases) {
    const check = checkJson(value);
    assert.equal(check.valid, true, value);
    assert.equal(check.pretty, pretty, value);
  }
  assert.deepEqual(checkJson('{"a":1,"a":2}').keys, ['a']);
  // On plain JSON the layout is JSON.stringify's.
  for (const value of [
    ' [ { } , [ ] ] ',
    '{"a":{"b":[1,{"c":"d"}]},"e":[],"f":{},"g":[true,false,null]}',
    '[[["x"]],{"k":[{}]}]',
  ])
    assert.equal(indentJson(value, 1024), JSON.stringify(JSON.parse(value), null, 2), value);
  // The whole character at an error, not half a surrogate pair.
  assert.deepEqual(checkJson('[\u{1F600}]').error, {
    message: 'Expected a value but found "\u{1F600}"',
    line: 1,
    column: 2,
  });
});

test('json-check: long keys and escapes keep the answer within 64 KiB', async () => {
  // One 60 KiB key: listed keys stop at their budget, keyCount still counts it.
  const long = await json(
    run('json-check', { text: JSON.stringify({ [`k${'v'.repeat(60_000)}`]: 1 }) }),
  );
  assert.equal(long.valid, true);
  assert.deepEqual(long.keys, []);
  assert.equal(long.keyCount, 1);
  assert.equal(long.prettyTooLarge, true);
  // Many keys of escapes: what is listed fits its budget as JSON.
  const escaped: Record<string, number> = {};
  for (let index = 0; index < 400; index++)
    escaped[`${String(index).padStart(3, '0')}${'\u0001'.repeat(20)}`] = index;
  const many = await json(run('json-check', { text: JSON.stringify(escaped) }));
  assert.equal(many.keyCount, 400);
  const keys = many.keys as string[];
  assert.ok(keys.length > 0 && keys.length < 256);
  assert.ok(Buffer.byteLength(JSON.stringify(keys)) <= JSON_CHECK_KEYS_MAX_BYTES + 2);
  // A text of quotes and backslashes: the indented copy is dropped or fits, the answer fits.
  const heavy = JSON.stringify(Array.from({ length: 1500 }, () => '"\\"\\'));
  assert.ok(Buffer.byteLength(heavy) <= 65_536);
  await json(run('json-check', { text: heavy }));
});

// ---------------------------------------------------------------- Base

test('base-usdc-balance: checksummed address, raw and display balance, read at one block', async () => {
  const calls: unknown[] = [];
  setOfferKindDeps({
    readBase: chain({
      getBlock: async (args) => {
        calls.push(['getBlock', args]);
        return { number: 36_000_123n, hash: HASH, timestamp: BigInt(BLOCK_TIME) };
      },
      readContract: async (args) => {
        calls.push(['readContract', args]);
        return 1_500_000n;
      },
    }),
  });
  const holder = '0xaaaa0000aaaa0000aaaa0000aaaa0000aaaa0000';
  assert.deepEqual(await json(run('base-usdc-balance', { address: holder })), {
    address: '0xaaaa0000AAAa0000aaaa0000AaAa0000aaAa0000',
    chainId: 8453,
    token: 'USDC',
    assetAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    balance: { raw: '1500000', display: '1.500000', decimals: 6 },
    blockNumber: 36_000_123,
    blockHash: HASH,
  });
  assert.equal(BASE_USDC, '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], ['getBlock', { blockTag: 'latest' }]);
  const call = (calls[1] as [string, Record<string, unknown>])[1];
  assert.equal(call.address, BASE_USDC);
  assert.equal(call.functionName, 'balanceOf');
  assert.deepEqual(call.args, ['0xaaaa0000AAAa0000aaaa0000AaAa0000aaAa0000']);
  assert.equal(call.blockNumber, 36_000_123n);

  setOfferKindDeps({ readBase: chain({ readContract: async () => 7n }) });
  assert.deepEqual((await json(run('base-usdc-balance', { address: holder }))).balance, {
    raw: '7',
    display: '0.000007',
    decimals: 6,
  });
});

test('base-usdc-balance: bad addresses are input errors, chain failures 502, a silent chain 504', async (t) => {
  for (const address of [
    '0x123',
    'aaaa0000aaaa0000aaaa0000aaaa0000aaaa0000',
    '0xaaaa0000aaaa0000aaaa0000aaaa0000aaaa000g',
    // Mixed case with a wrong checksum: a typo, never guessed.
    '0xAaaa0000aaaa0000aaaa0000aaaa0000aaaa0000',
  ])
    await inputError(run('base-usdc-balance', { address }));

  const holder = '0xaaaa0000aaaa0000aaaa0000aaaa0000aaaa0000';
  setOfferKindDeps({
    readBase: chain({
      readContract: async () => {
        throw new Error('execution reverted');
      },
    }),
  });
  await failure(run('base-usdc-balance', { address: holder }), 502, 'chain_unavailable');
  for (const block of [
    { number: null, hash: HASH, timestamp: BigInt(BLOCK_TIME) },
    { number: 1n, hash: null, timestamp: BigInt(BLOCK_TIME) },
    { number: 1n, hash: '0x12', timestamp: BigInt(BLOCK_TIME) },
    { number: 1n, hash: HASH, timestamp: 0n },
  ]) {
    setOfferKindDeps({ readBase: chain({ getBlock: async () => block }) });
    await failure(run('base-usdc-balance', { address: holder }), 502, 'chain_unavailable');
  }

  t.mock.timers.enable({ apis: ['setTimeout'] });
  setOfferKindDeps({ readBase: chain({ readContract: () => new Promise(() => {}) }) });
  const answer = run('base-usdc-balance', { address: holder });
  for (let tick = 0; tick < 5; tick++) await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(BASE_READ_TIMEOUT_MS);
  const silent = await failure(answer, 504, 'timeout');
  assert.equal(silent.retryable, true);
});

test('base-usdc-balance: an all-upper-case address has no checksum to check and is accepted', async () => {
  const upper = '0x833589FCD6EDB6E08F4C7C32D4F71B54BDA02913';
  const result = await json(run('base-usdc-balance', { address: upper }));
  assert.equal(result.address, '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
  // Mixed case with a wrong checksum is still a typo.
  await inputError(
    run('base-usdc-balance', { address: '0x833589fcD6eDb6E08f4c7C32D4f71b54bdA02913' }),
    /all upper case, or mixed case with a valid checksum/,
  );
});

test('base-block: the latest block, or the one asked for, with its hash and time', async () => {
  assert.deepEqual(await json(run('base-block', {})), {
    chainId: 8453,
    number: 36_000_000,
    hash: HASH,
    timestamp: 1_792_065_596,
    time: '2026-10-15T11:59:56.000Z',
  });
  const asked: unknown[] = [];
  setOfferKindDeps({
    readBase: chain({
      getBlock: async (args) => {
        asked.push(args);
        return {
          number: 'blockNumber' in args ? args.blockNumber : HEAD,
          hash: HASH.toUpperCase().replace('0X', '0x'),
          timestamp: 1_700_000_000n,
        };
      },
    }),
  });
  assert.deepEqual(await json(run('base-block', { number: 12_345 })), {
    chainId: 8453,
    number: 12_345,
    hash: HASH,
    timestamp: 1_700_000_000,
    time: '2023-11-14T22:13:20.000Z',
  });
  assert.deepEqual(asked, [{ blockNumber: 12_345n }]);
  // The same block, the same answer, whenever it is asked.
  assert.deepEqual(
    await run('base-block', { number: 12_345 }, context({ now: NOW + 86_400_000 })),
    await run('base-block', { number: 12_345 }),
  );
});

test('base-block: past the head is a retryable 422; failures 502, a silent chain 504', async (t) => {
  const missing = () => Promise.reject(new Error('Block at number could not be found.'));
  setOfferKindDeps({
    readBase: chain({
      getBlock: async (args) => {
        if ('blockNumber' in args) return missing();
        return { number: HEAD, hash: HASH, timestamp: BigInt(BLOCK_TIME) };
      },
    }),
  });
  // Past the head is the chain's answer, not the input's: the paid call's outcome, retryable.
  const notYet = await failure(
    run('base-block', { number: Number(HEAD) + 1 }),
    422,
    'block_not_found',
  );
  assert.equal(notYet.retryable, true);
  // A block at or below the head that cannot be read is a failure, not the buyer's fault.
  await failure(run('base-block', { number: 5 }), 502, 'chain_unavailable');
  // An answer for another block is never passed on.
  setOfferKindDeps({
    readBase: chain({
      getBlock: async () => ({ number: 6n, hash: HASH, timestamp: BigInt(BLOCK_TIME) }),
    }),
  });
  await failure(run('base-block', { number: 5 }), 502, 'chain_unavailable');
  setOfferKindDeps({
    readBase: chain({ getBlock: async () => ({ number: 1n, hash: HASH, timestamp: 0n }) }),
  });
  await failure(run('base-block', {}), 502, 'chain_unavailable');
  setOfferKindDeps({
    readBase: chain({
      getBlock: () => {
        throw new Error('sync failure');
      },
    }),
  });
  await failure(run('base-block', {}), 502, 'chain_unavailable');

  t.mock.timers.enable({ apis: ['setTimeout'] });
  setOfferKindDeps({ readBase: chain({ getBlock: () => new Promise(() => {}) }) });
  const answer = run('base-block', {});
  await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(BASE_READ_TIMEOUT_MS);
  await failure(answer, 504, 'timeout');
});

test('base kinds: unavailable (503) until a reader is set; the signal ends a silent read', async () => {
  resetOfferKindDeps();
  const unavailable = await failure(run('base-block', {}), 503, 'unavailable');
  assert.equal(unavailable.retryable, true);
  await failure(
    run('base-usdc-balance', { address: '0xaaaa0000aaaa0000aaaa0000aaaa0000aaaa0000' }),
    503,
    'unavailable',
  );
  setOfferKindDeps({ readBase: chain({ getBlock: () => new Promise(() => {}) }) });
  const controller = new AbortController();
  const answer = run('base-block', {}, context({ signal: controller.signal }));
  controller.abort(new Error('call ended'));
  await assert.rejects(answer, /call ended/);
});

// ---------------------------------------------------------------- unit-convert

test('unit-convert: length, mass, volume and temperature, 15 significant digits', async () => {
  const cases: Array<[number, string, string, number]> = [
    [1, 'mi', 'km', 1.609344],
    [1, 'mi', 'ft', 5280],
    [3, 'ft', 'in', 36],
    [1, 'yd', 'm', 0.9144],
    [10, 'cm', 'in', 3.93700787401575],
    [1, 'in', 'cm', 2.54],
    [2500, 'mm', 'km', 0.0025],
    [1, 'lb', 'kg', 0.45359237],
    [16, 'oz', 'lb', 1],
    [1, 'kg', 'oz', 35.2739619495804],
    // The defined factor, all 11 digits.
    [1, 'oz', 'g', 28.349523125],
    [1, 'oz', 'kg', 0.028349523125],
    [1500, 'mg', 'g', 1.5],
    [1, 'gal', 'l', 3.785411784],
    [1, 'gal', 'floz', 128],
    [1, 'floz', 'ml', 29.5735295625],
    [1, 'l', 'ml', 1000],
    [250, 'ml', 'l', 0.25],
    [1, 'l', 'gal', 0.264172052358148],
    [100, 'c', 'f', 212],
    [32, 'f', 'c', 0],
    [-40, 'c', 'f', -40],
    [98.6, 'f', 'c', 37],
    [0, 'k', 'c', -273.15],
    [-459.67, 'f', 'k', 0],
    [300, 'k', 'f', 80.33],
    [20, 'c', 'k', 293.15],
    [5, 'm', 'm', 5],
    // The same unit is the value itself; a real conversion rounds float noise away.
    [0.1 + 0.2, 'm', 'm', 0.30000000000000004],
    [0.1 + 0.2, 'm', 'cm', 30],
    // Small temperatures keep their digits (no detour through kelvin).
    [1e-7, 'c', 'c', 1e-7],
    [1e-12, 'c', 'c', 1e-12],
    [1e-12, 'f', 'f', 1e-12],
    [32.000001, 'f', 'c', 5.55555555555556e-7],
    [1e-7, 'c', 'f', 32.00000018],
    [-17.7777777, 'c', 'f', 1.4e-7],
    [273.150001, 'k', 'c', 0.000001],
    [1e-7, 'c', 'k', 273.1500001],
    [-273.15, 'c', 'f', -459.67],
    [0, 'k', 'f', -459.67],
    // The largest value the spec takes, in the largest factor.
    [1e15, 'mi', 'mm', 1.609344e21],
  ];
  for (const [value, from, to, expected] of cases) {
    const result = await json(run('unit-convert', { value, from, to }));
    assert.equal(result.result, expected, `${value} ${from} to ${to}`);
  }
  assert.deepEqual(await json(run('unit-convert', { value: 1, from: 'km', to: 'm' })), {
    value: 1,
    from: 'km',
    to: 'm',
    dimension: 'length',
    result: 1000,
  });
});

test('unit-convert: incompatible units, unknown units and impossible values are input errors', async () => {
  await inputError(
    run('unit-convert', { value: 1, from: 'm', to: 'kg' }),
    /m is a unit of length and kg a unit of mass/,
  );
  await inputError(run('unit-convert', { value: 1, from: 'c', to: 'l' }), /temperature/);
  await inputError(run('unit-convert', { value: -300, from: 'c', to: 'k' }), /absolute zero/);
  await inputError(run('unit-convert', { value: -1, from: 'k', to: 'c' }), /absolute zero/);
  await inputError(run('unit-convert', { value: 1e308, from: 'mi', to: 'mm' }), /out of range/);
  await inputError(run('unit-convert', { value: 1, from: 'parsec', to: 'm' }), /from must be/);
  // Units are lower case, as the spec lists them.
  await inputError(run('unit-convert', { value: 1, from: 'C', to: 'F' }), /from must be/);
  await inputError(run('unit-convert', { value: 1, from: 'KB', to: 'B' }), /from must be/);
  assert.deepEqual(convertUnit(-0, 'c', 'c'), { ok: true, dimension: 'temperature', result: 0 });
});

// ---------------------------------------------------------------- answer size

test('every answer stays within 64 KiB', async () => {
  setOfferKindDeps({
    fetchPublic: fixed({ body: Buffer.alloc(1024 * 1024, '\u00e9"') }),
  });
  const plain = await text(read('https://news.example.com/'));
  assert.equal(Array.from(plain).length, WEB_READ_LIMITS.maxChars);
  // Plain text is sent as it is: quotes and backslashes cost no escape.
  setOfferKindDeps({
    fetchPublic: fixed({
      contentType: 'text/html',
      charset: 'utf-8',
      body: Buffer.from(`<title>${'\\'.repeat(2000)}</title><pre>${'"\\'.repeat(60_000)}</pre>`),
    }),
  });
  assert.equal((await text(read('https://news.example.com/'))).length, WEB_READ_LIMITS.maxChars);
  await json(run('json-check', { text: JSON.stringify({ k: 'v'.repeat(65_000) }) }));
  await json(run('text-stats', { text: '\u{1F600}'.repeat(16_384) }));
});

// ---------------------------------------------------------------- web-read limits

test('safe fetch: a body in many tiny pieces is refused once past the piece budget', async () => {
  assert.equal(maxBodyPieces(1024 * 1024), 4096);
  assert.equal(maxBodyPieces(1024), 1024);
  const crumbs =
    (count: number, piece: (index: number) => string): Route =>
    (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      // Chunked: every write is its own chunk, so the parser hands over one piece per write.
      for (let index = 0; index < count; index++) res.write(piece(index));
      res.end();
    };
  await withSite(
    {
      'news.example.com/crumbs': crumbs(6000, () => 'x'),
      'news.example.com/pieces': crumbs(1000, (index) => String(index % 10)),
    },
    async () => {
      const started = performance.now();
      const fragmented = await failure(
        read('https://news.example.com/crumbs'),
        422,
        'too_fragmented',
      );
      assert.equal(fragmented.outboundSent, true);
      assert.ok(performance.now() - started < 2000);
      // Under the budget, the pieces are copied into one body, in order.
      assert.equal(await text(read('https://news.example.com/pieces')), '0123456789'.repeat(100));
    },
  );
});

test('safe fetch: a cap on reads in flight per fetcher (503 busy, nothing sent)', async () => {
  await withSite(
    {
      'news.example.com/silent': () => {},
      'other.example.com/ok': page('text/plain', 'fine'),
    },
    async (site) => {
      const hanging = site.fetchPublic({
        url: 'https://news.example.com/silent',
        timeoutMs: 300,
        maxBytes: 1024,
        maxRedirects: 0,
        contentTypes: ['text/plain'],
      });
      const busy = await failure(read('https://other.example.com/ok'), 503, 'busy');
      assert.equal(busy.outboundSent, false);
      await assert.rejects(hanging, (error: unknown) => {
        assert.ok(error instanceof SafeFetchError);
        assert.equal(error.kind, 'timeout');
        assert.equal(error.outboundSent, true);
        return true;
      });
      // The slot is free again.
      assert.equal(await text(read('https://other.example.com/ok')), 'fine');
    },
    { limits: { maxInFlight: 1 } },
  );
});

test("safe fetch: per host, a cap on reads in flight and a budget per minute of the call's time (429)", async () => {
  await withSite(
    {
      'news.example.com/silent': () => {},
      'news.example.com/a': page('text/plain', 'a'),
      'other.example.com/b': page('text/plain', 'b'),
    },
    async (site) => {
      const hanging = site.fetchPublic({
        url: 'https://news.example.com/silent',
        timeoutMs: 300,
        maxBytes: 1024,
        maxRedirects: 0,
        contentTypes: ['text/plain'],
      });
      const sameHost = await failure(read('https://news.example.com/a'), 429, 'host_busy');
      assert.equal(sameHost.outboundSent, false);
      assert.equal(sameHost.retryable, true);
      assert.equal(await text(read('https://other.example.com/b')), 'b');
      await assert.rejects(hanging);
      assert.equal(await text(read('https://news.example.com/a')), 'a');
    },
    { limits: { maxInFlightPerHost: 1 } },
  );

  // The minute is measured with each call's ctx.now, not the fetcher's clock.
  let clock = 1_000_000;
  await withSite(
    {
      'news.example.com/a': page('text/plain', 'a'),
      'news.example.com/hop': redirect('/a'),
      'other.example.com/b': page('text/plain', 'b'),
    },
    async (site) => {
      const at = (url: string) => read(url, context({ now: clock }));
      assert.equal(await text(at('https://news.example.com/a')), 'a');
      assert.equal(await text(at('https://news.example.com/a')), 'a');
      await failure(at('https://news.example.com/a'), 429, 'host_busy');
      assert.equal(site.hits.length, 2);
      // Another host has its own budget.
      assert.equal(await text(at('https://other.example.com/b')), 'b');
      // A new minute, a new budget; a redirect hop to the same host counts as a request.
      clock += 60_000;
      assert.equal(await text(at('https://news.example.com/hop')), 'a');
      await failure(at('https://news.example.com/a'), 429, 'host_busy');
    },
    { limits: { maxPerHostPerMinute: 2 }, now: () => assert.fail('the call gives the time') },
  );
});

test("safe fetch: a call stamped before a host's current minute counts in it, never resets it", async () => {
  await withSite(
    {
      'news.example.com/a': page('text/plain', 'a'),
      'other.example.com/hop': redirect('https://news.example.com/a'),
    },
    async (site) => {
      // Another call opens the host's minute at t=60_000 and uses its budget.
      const later = context({ now: 60_000 });
      assert.equal(await text(read('https://news.example.com/a', later)), 'a');
      assert.equal(await text(read('https://news.example.com/a', later)), 'a');
      // A call that started earlier (t=59_900) reaches it through a redirect: over budget.
      await failure(
        read('https://other.example.com/hop', context({ now: 59_900 })),
        429,
        'host_busy',
      );
      // And the budget was not reset by it either.
      await failure(read('https://news.example.com/a', later), 429, 'host_busy');
      assert.equal(site.hits.filter((hit) => hit.startsWith('news.')).length, 2);
    },
    { limits: { maxPerHostPerMinute: 2 }, now: () => assert.fail('the call gives the time') },
  );
});

test('web-read: says whether a request reached a third party, so a failed read can be settled', async () => {
  await withSite(
    {
      'news.example.com/ok': page('text/plain', 'ok'),
      'news.example.com/logo.png': page('image/png', Buffer.from([0x89, 0x50])),
      'news.example.com/to-private': redirect('https://private.example.com/'),
    },
    async (site) => {
      assert.equal(await text(read('https://news.example.com/ok')), 'ok');
      // Refused after the page was asked for: the request went out.
      const typed = await failure(
        read('https://news.example.com/logo.png'),
        422,
        'unsupported_content_type',
      );
      assert.equal(typed.outboundSent, true);
      const redirected = await failure(
        read('https://news.example.com/to-private'),
        422,
        'host_refused',
      );
      assert.equal(redirected.outboundSent, true);
      // Refused before any connection: nothing went out.
      const unknown = await failure(read('https://nowhere.example.com/'), 422, 'host_refused');
      assert.equal(unknown.outboundSent, false);
      await inputError(read('https://127.0.0.1/'));
      // Every request names a page with a contact for reports.
      assert.equal(site.requests[0]!.headers['user-agent'], SAFE_FETCH_USER_AGENT);
      assert.match(SAFE_FETCH_USER_AGENT, /\(\+https:\/\/[^\s)]+\)$/);
    },
  );
});

test('web-read: an IP literal is refused, public or not; a host name is required', async () => {
  const literals = [
    'https://93.184.216.34/',
    'https://93.184.216.34/index.html',
    'https://[2606:2800:220:1:248:1893:25c8:1946]/',
  ];
  await withSite({ 'news.example.com/to-ip': redirect('https://93.184.216.34/') }, async (site) => {
    for (const url of literals) {
      assert.equal(publicUrlProblem(url)?.kind, 'bad_url', url);
      await inputError(read(url), /DNS name, not an IP address/);
      await assert.rejects(
        site.fetchPublic({
          url,
          timeoutMs: 1000,
          maxBytes: 1024,
          maxRedirects: 0,
          contentTypes: ['text/html'],
        }),
        (error: unknown) => error instanceof SafeFetchError && error.kind === 'bad_url',
      );
    }
    assert.deepEqual(site.opened, []);
    await failure(read('https://news.example.com/to-ip'), 422, 'url_refused');
    assert.equal(site.opened.length, 1);
  });
});

/** A UDP name server on 127.0.0.1: answers A queries from `a`, NXDOMAIN, or drops the query. */
async function withNameServer(
  answer: (name: string, type: number) => 'drop' | 'nxdomain' | string[],
  body: (server: string, queries: string[]) => Promise<void>,
) {
  const socket = createSocket('udp4');
  const queries: string[] = [];
  socket.on('message', (message, from) => {
    let at = 12;
    const labels: string[] = [];
    while (message[at]) {
      labels.push(message.subarray(at + 1, at + 1 + message[at]!).toString('latin1'));
      at += message[at]! + 1;
    }
    const type = message.readUInt16BE(at + 1);
    const questionEnd = at + 5;
    const name = labels.join('.').toLowerCase();
    queries.push(`${name} ${type}`);
    const result = answer(name, type);
    if (result === 'drop') return;
    const records = result === 'nxdomain' || type !== 1 ? [] : result;
    const header = Buffer.alloc(12);
    message.copy(header, 0, 0, 2);
    header.writeUInt16BE(result === 'nxdomain' ? 0x8183 : 0x8180, 2);
    header.writeUInt16BE(1, 4);
    header.writeUInt16BE(records.length, 6);
    const answers = records.map((address) => {
      const record = Buffer.alloc(16);
      record.writeUInt16BE(0xc00c, 0);
      record.writeUInt16BE(1, 2);
      record.writeUInt16BE(1, 4);
      record.writeUInt32BE(60, 6);
      record.writeUInt16BE(4, 10);
      address.split('.').forEach((part, index) => record.writeUInt8(Number(part), 12 + index));
      return record;
    });
    socket.send(
      Buffer.concat([header, message.subarray(12, questionEnd), ...answers]),
      from.port,
      from.address,
    );
  });
  await new Promise<void>((resolve) => socket.bind(0, '127.0.0.1', resolve));
  try {
    await body(`127.0.0.1:${socket.address().port}`, queries);
  } finally {
    socket.close();
  }
}

test('dns: the production resolver asks the name servers directly and is cancelled at the deadline', async () => {
  await withNameServer(
    (name) =>
      name === 'news.example.com'
        ? ['93.184.216.34']
        : name === 'silent.example.com'
          ? 'drop'
          : 'nxdomain',
    async (server, queries) => {
      // Long tries: only the deadline's cancel can end the silent lookup quickly.
      const resolve = createSystemResolve({ servers: [server], tryTimeoutMs: 10_000 });
      assert.deepEqual(await resolve('news.example.com'), [
        { address: '93.184.216.34', family: 4 },
      ]);
      // A and AAAA were both asked of this server (c-ares, not getaddrinfo on the threadpool).
      assert.ok(queries.includes('news.example.com 1'));
      assert.ok(queries.includes('news.example.com 28'));
      await assert.rejects(resolve('nowhere.example.com'), (error: unknown) => {
        assert.equal((error as { code?: unknown }).code, 'ENOTFOUND');
        return true;
      });

      const controller = new AbortController();
      const started = performance.now();
      setTimeout(() => controller.abort(), 100);
      await assert.rejects(resolve('silent.example.com', controller.signal));
      assert.ok(performance.now() - started < 2000, 'cancelled, not waiting for the try timeout');

      // Through the safe fetch: the read's deadline cancels the lookup.
      const fetchPublic = createSafeFetch({
        resolve,
        openSocket: () => assert.fail('never connects'),
      });
      const before = performance.now();
      await assert.rejects(
        fetchPublic({
          url: 'https://silent.example.com/',
          timeoutMs: 150,
          maxBytes: 1024,
          maxRedirects: 0,
          contentTypes: ['text/html'],
        }),
        (error: unknown) => error instanceof SafeFetchError && error.kind === 'timeout',
      );
      assert.ok(performance.now() - before < 2000);
    },
  );
});

test('web-read: a URL is capped once percent-encoded, before any read', async () => {
  let fetched = 0;
  setOfferKindDeps({
    fetchPublic: async () => {
      fetched++;
      throw new SafeFetchError('timeout', 'The page did not answer in time.');
    },
  });
  // A URL whose encoded form is past the cap is refused as an input error.
  const longWide = `https://news.example.com/${'\u00e9'.repeat(1000)}`;
  assert.ok(Buffer.byteLength(longWide) <= 2048);
  assert.ok(new URL(longWide).href.length > 2048);
  await inputError(read(longWide), /once percent-encoded/);
  assert.equal(publicUrlProblem(longWide)?.kind, 'bad_url');
  assert.equal(fetched, 0);
});

test('web-read: a crafted <meta> head costs no backtracking, and UTF-16 or x-user-defined labels decode sanely', async () => {
  const crafted = Buffer.from(`${'<meta'.repeat(68)}charset=${' '.repeat(700)}`);
  setOfferKindDeps({ fetchPublic: fixed({ contentType: 'text/html', body: crafted }) });
  const started = performance.now();
  for (let round = 0; round < 40; round++) await text(read('https://news.example.com/'));
  // About 22 ms a call before; now well under a millisecond.
  assert.ok(performance.now() - started < 300, `${performance.now() - started} ms`);

  await withSite(
    {
      'news.example.com/u16': page(
        'text/html',
        '<meta charset="utf-16"><title>Hi</title><p>Hello</p>',
      ),
      'news.example.com/xud': page(
        'text/html',
        Buffer.concat([
          Buffer.from('<meta charset="x-user-defined"><p>5 '),
          Buffer.from([0x80]),
          Buffer.from('</p>'),
        ]),
      ),
      'news.example.com/spaced': page(
        'text/html',
        Buffer.concat([
          Buffer.from('<meta charset = "windows-1252"><p>caf'),
          Buffer.from([0xe9]),
          Buffer.from('</p>'),
        ]),
      ),
    },
    async () => {
      assert.equal(await text(read('https://news.example.com/u16')), 'Hello');
      assert.equal(await text(read('https://news.example.com/xud')), '5 \u20ac');
      assert.equal(await text(read('https://news.example.com/spaced')), 'caf\u00e9');
    },
  );
});

test('html to text: the walk stops once it has more text than is sent', async () => {
  const big = '<p>&amp;'.repeat(131_072);
  const full = htmlToText(big);
  const capped = htmlToText(big, { maxTextBytes: 32 * 1024 });
  assert.ok(Buffer.byteLength(capped.text) > 32 * 1024);
  assert.ok(capped.text.length < 4 * 32 * 1024, String(capped.text.length));
  assert.ok(full.text.length > 200_000);
  assert.ok(full.text.startsWith(capped.text));
  // Whitespace that collapses away does not stop the walk early.
  const spaced = htmlToText(`${' '.repeat(100_000)}<p>end`, { maxTextBytes: 10 });
  assert.equal(spaced.text, 'end');
  // Through web-read: cut to max_chars.
  setOfferKindDeps({
    fetchPublic: fixed({ contentType: 'text/html', charset: 'utf-8', body: Buffer.from(big) }),
  });
  const result = await text(read('https://news.example.com/', undefined, 5));
  assert.equal(result, '& & &');
  assert.equal((await text(read('https://news.example.com/'))).length, WEB_READ_LIMITS.maxChars);
});

test('html to text: a ">" inside an attribute value does not end the tag', () => {
  assert.equal(
    htmlToText('<p>Price <img alt="5 > 3" src="x.png"> tag</p><a onclick="if(a>b)go()">link</a>')
      .text,
    'Price tag link',
  );
  assert.equal(htmlToText('<img alt=\'a>b\'>c <a title = ">">ok</a>').text, 'c ok');
  // An unquoted value ends at whitespace or ">", quotes inside it are plain characters.
  assert.equal(htmlToText('<p title=a"b>text</p><a href=x>y</a>').text, 'text y');
  // An attribute quote that never closes ends the page, as in a browser.
  assert.equal(htmlToText('<p>before<img alt="never closed>after').text, 'before');
});

test('html to text: an XML feed keeps every headline after its own title', async () => {
  const rss =
    '<rss><channel><title>Feed</title><item><title>First story</title><description>Body one</description></item><item><title>Second story</title></item></channel></rss>';
  assert.deepEqual(htmlToText(rss, { xml: true }), {
    title: 'Feed',
    text: 'First story Body one Second story',
  });
  assert.deepEqual(
    htmlToText(
      '<feed><title>Blog</title><entry><title>Post</title><summary>Sum</summary></entry></feed>',
      { xml: true },
    ),
    { title: 'Blog', text: 'Post Sum' },
  );
  await withSite({ 'news.example.com/rss': page('application/xml', rss) }, async () => {
    assert.equal(
      await text(read('https://news.example.com/rss')),
      'First story Body one Second story',
    );
  });
});

test('html to text: Latin-1 named references and windows-1252 numeric references', () => {
  assert.equal(
    decodeEntities('M&uuml;nchen caf&eacute; &ouml; &#150; &#x92; &AElig;&szlig;&frac12;&yuml;'),
    'M\u00fcnchen caf\u00e9 \u00f6 \u2013 \u2019 \u00c6\u00df\u00bd\u00ff',
  );
  // Soft hyphens still vanish; an unassigned C1 reference stays a control and is dropped.
  assert.equal(decodeEntities('co&shy;op'), 'coop');
  assert.equal(htmlToText('<p>a&#129;b &#128;</p>').text, 'ab \u20ac');
});

// ---------------------------------------------------------------- check() before payment

/**
 * Every deterministic refusal of every kind, as the purchase path meets it BEFORE the buyer pays.
 * Each one must be thrown by check() itself (synchronously, as OfferKindInputError), and run()
 * must refuse it the same way, without ever reaching the network or the chain.
 */
/** A mixed-case address whose case is not its checksum. */
const FROM_CHECKSUM_WRONG = '0x833589fcD6eDb6E08f4c7C32D4f71b54bdA02913';

const REFUSALS: Array<[OfferKindName, unknown, RegExp?]> = [
  // web-read: the URL's static rules.
  ['web-read', { url: 'http://news.example.com/' }],
  ['web-read', { url: 'ftp://news.example.com/' }],
  ['web-read', { url: 'https://127.0.0.1/' }, /public host/],
  ['web-read', { url: 'https://93.184.216.34/' }, /not an IP address/],
  ['web-read', { url: 'https://[::1]/' }, /public host/],
  ['web-read', { url: 'https://[2606:2800:220:1::1]/' }, /not an IP address/],
  ['web-read', { url: 'https://2130706433/' }, /public host/],
  ['web-read', { url: 'https://localhost/' }, /public host/],
  ['web-read', { url: 'https://localhost./' }, /public host/],
  ['web-read', { url: 'https://metadata.internal/' }, /public host/],
  ['web-read', { url: 'https://printer.local/' }, /public host/],
  ['web-read', { url: 'https://intranet/' }, /public host/],
  ['web-read', { url: 'https://news.example.com:8443/' }, /port/],
  ['web-read', { url: 'https://user:secret@news.example.com/' }, /user name or password/],
  ['web-read', { url: `https://news.example.com/${'a'.repeat(2048)}` }, /longer than 2048 bytes/],
  ['web-read', { url: `https://news.example.com/${'é'.repeat(600)}` }, /percent-encoded/],
  // roman-numerals: value or text, the standard form, the longest form is 15 characters.
  ['roman-numerals', {}, /one of value or text/],
  ['roman-numerals', { value: 4, text: 'IV' }, /one of value or text/],
  ['roman-numerals', { text: 'IIII' }, /standard form/],
  ['roman-numerals', { text: 'MMMM' }, /standard form/],
  ['roman-numerals', { text: 'MMMDCCCLXXXVIIII' }, /longer than 15 bytes/],
  // base64: the encode cap, and decode validity.
  ['base64', { text: 'a'.repeat(49_153), mode: 'encode' }, /longer than 49152 bytes/],
  ['base64', { text: 'abc', mode: 'decode' }, /not valid Base64/],
  ['base64', { text: 'aGVsbG9=', mode: 'decode' }, /stray bits/],
  ['base64', { text: '/w==', mode: 'decode' }, /not UTF-8/],
  // An address with a wrong checksum (base-usdc-balance reads the chain only after this).
  ['base-usdc-balance', { address: '0x833589fcD6eDb6E08f4c7C32D4f71b54bdA02913' }, /checksum/],
  ['base-usdc-balance', { address: '0x123' }, /expected form/],
  // Dates the pattern accepts that do not exist.
  ['date-diff', { from: '2026-02-30', to: '2026-03-01' }, /not a date/],
  ['date-diff', { from: '2026-01-01', to: '2025-02-29' }, /not a date/],
  ['date-diff', { from: '0000-01-01', to: '2026-01-01' }, /not a date/],
  // Units of two dimensions; below absolute zero.
  ['unit-convert', { value: 1, from: 'kg', to: 'm' }, /unit of mass/],
  ['unit-convert', { value: -300, from: 'c', to: 'k' }, /absolute zero/],
  // Colors.
  ['color-convert', { color: 'red' }, /must be #rrggbb/],
  ['color-convert', { color: '#12345' }, /must be #rrggbb/],
  ['color-convert', { color: 'rgb(256, 0, 0)' }, /above 255/],
  ['color-convert', { color: 'hsl(361, 50%, 50%)' }, /hue above 360/],
  // json-to-csv: not JSON, not an array, a nested value.
  ['json-to-csv', { text: '[{"a":1}' }, /not valid JSON/],
  ['json-to-csv', { text: '{"a":1}' }, /JSON array/],
  ['json-to-csv', { text: '[]' }, /JSON array/],
  ['json-to-csv', { text: '[1]' }, /not an object/],
  ['json-to-csv', { text: '[{"a":{"b":1}}]' }, /not text, a number/],
  ['json-to-csv', { text: `[${'{},'.repeat(10_000)}{}]` }, /more than 10000 objects/],
  // csv-to-json: quotes, the row cap, the header.
  ['csv-to-json', { text: 'a"b,c' }, /quote inside a field/],
  ['csv-to-json', { text: '"never closed' }, /never closes/],
  ['csv-to-json', { text: '"a"b' }, /after a closing quote/],
  ['csv-to-json', { text: 'a\n'.repeat(10_001), header: false }, /more than 10000 rows/],
  ['csv-to-json', { text: 'a,a\n1,2' }, /more than once/],
  ['csv-to-json', { text: 'a,b\n1' }, /has 1 fields/],
  // slugify: nothing to make a slug of.
  ['slugify', { text: '!!! ??? ---' }, /no letters or digits/],
  // Answers over 64 KiB, computed in check() and discarded.
  ['url-encode', { text: 'é'.repeat(20_000), mode: 'encode' }, /larger than 65536 bytes/],
  ['csv-to-json', { text: `${'k'.repeat(1000)}\n${'1\n'.repeat(70)}` }, /larger than 65536 bytes/],
  // 100 columns, then 1000 empty objects: each a row of 99 delimiters.
  [
    'json-to-csv',
    {
      text: JSON.stringify([
        Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`k${i}`, 1])),
        ...Array.from({ length: 1000 }, () => ({})),
      ]),
    },
    /larger than 65536 bytes/,
  ],
  ['url-encode', { text: '%E0%A4%A', mode: 'decode' }, /percent-encoding/],
  ['url-encode', { text: '\ud800', mode: 'encode' }, /lone surrogate/],
  // The schema itself (every kind, the reference hash included).
  ['hash', { text: 'a'.repeat(8_193) }, /longer than 8192 bytes/],
  ['hash', {}, /required/],
  ['number-to-words', { value: 1.5 }, /whole number/],
  ['case-convert', { text: 'a', to: 'shout' }, /must be one of/],
  ['reading-time', { text: 'a', words_per_minute: 0 }, /out of range/],
  ['text-stats', { text: 1 }, /must be text/],
  ['json-check', { text: 'x', extra: 1 }, /takes only/],
  ['markdown-to-text', [], /JSON object/],
  ['address-checksum', { address: `0x${'g'.repeat(40)}` }, /expected form/],
  ['base-block', { number: -1 }, /out of range/],
  // The kinds added after these (tests/feed-offer-kinds-more.test.ts has their own cases).
  ['web-meta', { url: 'https://localhost/' }, /public host/],
  ['web-links', { url: 'http://news.example.com/' }],
  ['web-links', { url: 'https://news.example.com/', max_links: 501 }, /out of range/],
  ['keyword-density', { text: 'a', top: 0 }, /out of range/],
  ['text-diff', { a: 'x' }, /b is required/],
  ['json-query', { json: '{', path: 'a' }, /not valid JSON/],
  ['json-schema-check', { json: '1', schema: '{"oneOf":[]}' }, /does not check/],
  ['csv-stats', { text: '"never closed' }, /never closes/],
  ['base-tx', { hash: '0x12' }, /expected form/],
  ['base-erc20-balance', { address: FROM_CHECKSUM_WRONG, token: USDC_LOWER }, /checksum/],
  ['base-gas', { block: 1 }, /takes no fields/],
];

test('check(): every deterministic refusal is thrown before payment, with no network or chain read', async () => {
  const touched: string[] = [];
  setOfferKindDeps({
    fetchPublic: async (request) => {
      touched.push(`fetch ${request.url}`);
      assert.fail('a refused input reached the network');
    },
    readBase: {
      getBlock: async () => {
        touched.push('getBlock');
        assert.fail('a refused input reached the chain');
      },
      readContract: async () => {
        touched.push('readContract');
        assert.fail('a refused input reached the chain');
      },
      ...(Object.fromEntries(
        (
          [
            'call',
            'getTransaction',
            'getTransactionReceipt',
            'getFeeHistory',
            'getGasPrice',
          ] as const
        ).map((name) => [
          name,
          async () => {
            touched.push(name);
            assert.fail('a refused input reached the chain');
          },
        ]),
      ) as unknown as Pick<
        OfferBaseReader,
        'call' | 'getTransaction' | 'getTransactionReceipt' | 'getFeeHistory' | 'getGasPrice'
      >),
    },
  });
  const kinds = new Set<OfferKindName>();
  for (const [name, input, message] of REFUSALS) {
    const kind = OFFER_KIND_REGISTRY.get(name)!;
    const label = `${name} ${JSON.stringify(input).slice(0, 60)}`;
    // Synchronously, by check() alone and by the purchase path's checkOffer.
    for (const call of [() => kind.check(input), () => checkOffer(kind, input)])
      assert.throws(
        call,
        (error: unknown) => {
          assert.ok(error instanceof OfferKindInputError, `${label}: ${String(error)}`);
          if (message) assert.match(error.message, message, label);
          return true;
        },
        label,
      );
    // run() refuses it the same way (it calls check first).
    await inputError(run(name, input), message);
    kinds.add(name);
  }
  assert.deepEqual(touched, []);
  // Every kind has at least one refusal here.
  assert.deepEqual([...kinds].sort(), [...OFFER_KINDS].sort());
});

test('check(): the inputs of the examples and the edges pass it, offline', () => {
  for (const name of OFFER_KINDS)
    checkOffer(OFFER_KIND_REGISTRY.get(name)!, OFFER_KIND_SPECS[name].example);
  const accepted: Array<[OfferKindName, unknown]> = [
    ['roman-numerals', { text: 'MMMDCCCLXXXVIII' }],
    ['base64', { text: 'a'.repeat(49_152), mode: 'encode' }],
    ['date-diff', { from: '2024-02-29', to: '9999-12-31' }],
    ['web-read', { url: 'https://news.example.com:443/a?b=c' }],
    // Past the head is the chain's answer, after payment: check accepts any block number.
    ['base-block', { number: Number.MAX_SAFE_INTEGER }],
    ['base-usdc-balance', { address: `0x${'A'.repeat(40)}` }],
  ];
  for (const [name, input] of accepted) checkOffer(OFFER_KIND_REGISTRY.get(name)!, input);
});

test('setOfferKindDeps: a null Base reader is "not configured", answered 503 unavailable', async () => {
  const fetchPublic: FetchPublic = async () => assert.fail('no web read');
  setOfferKindDeps({ fetchPublic, readBase: chain() });
  assert.equal((await json(run('base-block', {}))).number, Number(HEAD));
  // The documented startup call: offerBaseReaderFromEnv gives null without settings.
  const fromEnv: OfferBaseReader | null = offerBaseReaderFromEnv({});
  assert.equal(fromEnv, null);
  setOfferKindDeps({ readBase: fromEnv });
  const unavailable = await failure(run('base-block', {}), 503, 'unavailable');
  assert.equal(unavailable.retryable, true);
  await failure(
    run('base-usdc-balance', { address: '0xaaaa0000aaaa0000aaaa0000aaaa0000aaaa0000' }),
    503,
    'unavailable',
  );
  // The other reader keeps its value; an absent readBase keeps the current one.
  setOfferKindDeps({ readBase: chain() });
  setOfferKindDeps({ fetchPublic });
  assert.equal((await json(run('base-block', {}))).number, Number(HEAD));
});

test('safe fetch: names on one address share a per-address budget (429, nothing sent)', async () => {
  const clock = 2_000_000;
  await withSite(
    {
      'a.shared.example.com/a': page('text/plain', 'a'),
      'b.shared.example.com/b': page('text/plain', 'b'),
      'news.example.com/n': page('text/plain', 'n'),
    },
    async (site) => {
      const at = (url: string) => read(url, context({ now: clock }));
      assert.equal(await text(at('https://a.shared.example.com/a')), 'a');
      assert.equal(await text(at('https://b.shared.example.com/b')), 'b');
      const shared = await failure(at('https://a.shared.example.com/a'), 429, 'host_busy');
      assert.equal(shared.outboundSent, false);
      // Another subdomain on the same address is in the same budget.
      await failure(at('https://b.shared.example.com/b'), 429, 'host_busy');
      assert.equal(site.hits.length, 2);
      // Another address has its own.
      assert.equal(await text(at('https://news.example.com/n')), 'n');
    },
    { limits: { maxPerAddressPerMinute: 2 }, now: () => assert.fail('the call gives the time') },
  );
});

test('every run of this file agreed with check() (refused there, or never refused after payment)', () => {
  checkAgreementSeen(agreement, 10);
});
