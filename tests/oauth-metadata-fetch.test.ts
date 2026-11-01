import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { scrypt } from 'node:crypto';
import { createSocket } from 'node:dgram';
import dns from 'node:dns';
import { Resolver } from 'node:dns/promises';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { createServer, type Server } from 'node:https';
import type { AddressInfo, Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CLIENT_METADATA_LIMITS,
  createClientMetadataFetcher,
  createPublicLookup,
  createResolveAddresses,
  localOnlyHostName,
  publicLookup,
  type PublicLookup,
  type ResolveAddresses,
} from '../server/oauth/clients.js';
import {
  createHttpsWebhookTransport,
  validateWebhookUrl,
  WebhookUrlError,
} from '../server/wake/webhooks.js';
import { authorizeUrl, fixture, openAuthorize, pkce } from './oauth-helpers.js';
import { feedPayUrlProblem } from '../server/feed/pay/transport.js';
import { publicUrlProblem } from '../server/feed/offers/safe-fetch.js';

const HOST = 'metadata.example.com';
const NOT_RETRIEVED = 'Client metadata document could not be retrieved.';

/** A throwaway certificate for HOST (openssl), or null where openssl is missing. */
function certificate(): { key: Buffer; cert: Buffer } | null {
  const dir = mkdtempSync(join(tmpdir(), 'cc-cimd-'));
  try {
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'ec',
        '-pkeyopt',
        'ec_paramgen_curve:prime256v1',
        '-nodes',
        '-keyout',
        join(dir, 'key.pem'),
        '-out',
        join(dir, 'cert.pem'),
        '-days',
        '1',
        '-subj',
        `/CN=${HOST}`,
        '-addext',
        `subjectAltName=DNS:${HOST}`,
      ],
      { stdio: 'ignore' },
    );
    return { key: readFileSync(join(dir, 'key.pem')), cert: readFileSync(join(dir, 'cert.pem')) };
  } catch {
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const loopback: PublicLookup = (_hostname, options, callback) => {
  if (typeof options === 'object' && options?.all)
    return callback(null, [{ address: '127.0.0.1', family: 4 }]);
  callback(null, '127.0.0.1', 4);
};

/** A host that answers `status` with `type`, then streams body bytes until the client leaves. */
async function streamingHost(status: number, type: string) {
  const tls = certificate();
  if (!tls) return null;
  const sockets = new Set<Socket>();
  let sent = 0;
  const server: Server = createServer(tls, (_req, res) => {
    res.writeHead(status, { 'content-type': type });
    const chunk = Buffer.alloc(64 * 1024, 0x61);
    const pump = setInterval(() => {
      if (res.destroyed) return clearInterval(pump);
      res.write(chunk);
      sent += chunk.length;
    }, 5);
    res.on('close', () => clearInterval(pump));
  });
  server.on('secureConnection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as AddressInfo).port,
    ca: tls.cert,
    open: () => sockets.size,
    sent: () => sent,
    close: () => {
      for (const socket of sockets) socket.destroy();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

for (const [status, type, message] of [
  [404, 'application/json', NOT_RETRIEVED],
  [200, 'text/html', 'Client metadata document must be JSON.'],
] as const)
  test(`a refused ${status} ${type} answer closes the connection at once`, async (t) => {
    const host = await streamingHost(status, type);
    if (!host) return t.skip('openssl is not available');
    t.after(() => host.close());
    const fetch = createClientMetadataFetcher({
      connect: { port: host.port, ca: host.ca, lookup: loopback },
    });
    await assert.rejects(fetch(new URL(`https://${HOST}/c.json`)), { message });
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(host.open(), 0, 'connection still open after the refusal');
    assert.ok(host.sent() < 4 * 1024 * 1024, `${host.sent()} bytes delivered`);
  });

test('a host name whose servers never answer settles at the deadline and the lookup is cancelled', async () => {
  let cancelled = false;
  const never: ResolveAddresses = (_hostname, signal) =>
    new Promise((_resolve, reject) =>
      signal.addEventListener('abort', () => {
        cancelled = true;
        reject(Object.assign(new Error('cancelled'), { code: 'ECANCELLED' }));
      }),
    );
  const started = Date.now();
  await assert.rejects(
    createClientMetadataFetcher({ resolve: never })(new URL(`https://${HOST}/c.json`)),
    { message: 'Client metadata request timed out.' },
  );
  assert.ok(Date.now() - started < CLIENT_METADATA_LIMITS.timeoutMs + 1_000);
  assert.equal(cancelled, true);
});

test('lookups wait on the name servers without holding the shared threadpool', async (t) => {
  // A name server that never answers.
  const silent = createSocket('udp4');
  await new Promise<void>((resolve) => silent.bind(0, '127.0.0.1', resolve));
  t.after(() => silent.close());
  const resolve = createResolveAddresses({
    servers: [`127.0.0.1:${(silent.address() as AddressInfo).port}`],
    tryTimeoutMs: 30_000,
  });
  const controller = new AbortController();
  // More pending lookups than the threadpool has threads (4 by default).
  const pending = Array.from({ length: 8 }, (_, i) =>
    resolve(`r${i}.slow.example.com`, controller.signal).then(
      () => 'resolved',
      () => 'failed',
    ),
  );
  const hashed = Date.now();
  await new Promise<void>((done, fail) =>
    scrypt('password', 'salt', 64, { N: 16384, r: 8, p: 1 }, (error) =>
      error ? fail(error) : done(),
    ),
  );
  assert.ok(Date.now() - hashed < 5_000, 'password hashing waited behind DNS lookups');
  const aborted = Date.now();
  controller.abort();
  assert.deepEqual(await Promise.all(pending), Array(8).fill('failed'));
  assert.ok(Date.now() - aborted < 2_000);
});

test('a lookup whose signal is already aborted starts no query', async (t) => {
  // Each started query is counted and then fails as a cancelled one would (no network).
  let starts = 0;
  const query = () => {
    starts++;
    return Promise.reject(Object.assign(new Error('cancelled'), { code: 'ECANCELLED' }));
  };
  t.mock.method(Resolver.prototype, 'resolve4', query);
  t.mock.method(Resolver.prototype, 'resolve6', query);
  t.after(() => t.mock.restoreAll());
  const controller = new AbortController();
  controller.abort();
  const outcome = await createResolveAddresses()('aborted.example.com', controller.signal).then(
    () => 'resolved',
    (error: NodeJS.ErrnoException) => error.code,
  );
  assert.equal(starts, 0, `${starts} DNS queries started after the abort`);
  assert.equal(outcome, 'ECANCELLED');
});

test('the production lookups ask the name servers and never call dns.lookup', async (t) => {
  // dns.lookup (getaddrinfo on the shared threadpool) is recorded, for named imports too.
  const systemLookups: string[] = [];
  t.mock.method(dns, 'lookup', (hostname: string) => {
    systemLookups.push(hostname);
    throw new Error('dns.lookup is not used for outbound fetches');
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  // Name server queries never answer until the lookup is cancelled.
  const queried: string[] = [];
  let cancels = 0;
  const waiting: Array<(error: Error) => void> = [];
  const query = (hostname: string) => {
    queried.push(hostname);
    return new Promise<string[]>((_resolve, reject) => waiting.push(reject));
  };
  t.mock.method(Resolver.prototype, 'resolve4', query);
  t.mock.method(Resolver.prototype, 'resolve6', query);
  t.mock.method(Resolver.prototype, 'cancel', () => {
    cancels++;
    for (const reject of waiting.splice(0))
      reject(Object.assign(new Error('cancelled'), { code: 'ECANCELLED' }));
  });

  publicLookup('lookup.example.com', { all: true }, () => {});
  assert.deepEqual(systemLookups, []);
  assert.deepEqual(queried, ['lookup.example.com', 'lookup.example.com']);

  // The default metadata fetcher: its deadline cancels the lookup still waiting.
  await assert.rejects(createClientMetadataFetcher()(new URL('https://cimd.example.com/c.json')), {
    message: 'Client metadata request timed out.',
  });
  assert.deepEqual(systemLookups, []);
  assert.ok(queried.includes('cimd.example.com'), queried.join(' '));
  assert.equal(cancels, 1);

  // The default webhook transport (wake-ups, Feed and Elric deliveries) uses the same lookup.
  await assert.rejects(
    createHttpsWebhookTransport()('https://hooks.example.com/w', '{}', {}, 300),
    {
      message: 'timeout',
    },
  );
  assert.deepEqual(systemLookups, []);
  assert.ok(queried.includes('hooks.example.com'), queried.join(' '));
  // Its deadline cancels the lookup still waiting, as the metadata fetcher's does.
  assert.equal(cancels, 2);
});

test('a name with only private addresses and a missing name get the same answer', async (t) => {
  const privateName: ResolveAddresses = async () => [{ address: '10.20.30.40', family: 4 }];
  const missing: ResolveAddresses = async () => {
    throw Object.assign(new Error('not found'), { code: 'ENOTFOUND' });
  };
  for (const resolve of [privateName, missing])
    await assert.rejects(
      createClientMetadataFetcher({ resolve })(new URL(`https://${HOST}/c.json`)),
      { message: NOT_RETRIEVED },
    );
  for (const url of ['https://10.0.0.8/c.json', 'https://metadata.internal/c.json'])
    await assert.rejects(createClientMetadataFetcher()(new URL(url)), { message: NOT_RETRIEVED });
  // The authorization page shows the same text for both.
  const pages: string[] = [];
  for (const resolve of [privateName, missing]) {
    const { app } = await fixture(t, {
      fetchClientMetadata: createClientMetadataFetcher({ resolve }),
    });
    const page = await openAuthorize(
      app,
      authorizeUrl({ client_id: `https://${HOST}/c.json`, code_challenge: pkce().challenge }),
    );
    assert.equal(page.status, 400);
    pages.push(page.body);
  }
  assert.equal(pages[0], pages[1]);
  assert.match(pages[0]!, /could not be retrieved/);
});

test('webhook deliveries to a private-only name and a missing name store the same status', async () => {
  const outcomes: string[] = [];
  for (const resolve of [
    (async () => [{ address: '192.168.4.5', family: 4 }]) as ResolveAddresses,
    (async () => {
      throw Object.assign(new Error('not found'), { code: 'ENOTFOUND' });
    }) as ResolveAddresses,
  ]) {
    const transport = createHttpsWebhookTransport({ lookup: createPublicLookup({ resolve }) });
    await transport('https://hooks.example.com/wake', '{}', {}, 2_000).then(
      () => outcomes.push('delivered'),
      (error: Error) => outcomes.push(error.message),
    );
  }
  assert.deepEqual(outcomes, ['network', 'network']);
});

const LOCAL_ONLY = [
  'https://localhost./x',
  'https://foo.localhost./x',
  'https://a.b.internal../x',
  'https://x.test/x',
  'https://x.corp/x',
  'https://x.intranet/x',
  'https://box.localdomain/x',
  'https://x.invalid/x',
  'https://router.home.arpa./x',
  'https://intranet/x',
];

test('webhook urls and metadata hosts share one static rule: trailing dots and every local suffix', async () => {
  for (const url of LOCAL_ONLY)
    assert.throws(() => validateWebhookUrl(url), WebhookUrlError, `webhook accepted ${url}`);
  assert.equal(
    validateWebhookUrl('https://hooks.example.com./wake').hostname,
    'hooks.example.com.',
  );
  // The metadata fetcher refuses them without asking any name server.
  const asked: string[] = [];
  const resolve: ResolveAddresses = async (hostname) => {
    asked.push(hostname);
    return [{ address: '93.184.215.14', family: 4 }];
  };
  for (const url of LOCAL_ONLY)
    await assert.rejects(createClientMetadataFetcher({ resolve })(new URL(url)), {
      message: NOT_RETRIEVED,
    });
  assert.deepEqual(asked, []);
  assert.equal(localOnlyHostName('metadata.example.com.'), false);
});

test('CCA-632: the Feed web fetcher and Feed pay transport use the same static host rule', () => {
  for (const url of LOCAL_ONLY) {
    assert.equal(publicUrlProblem(url)?.kind, 'not_public', `feed web fetch accepted ${url}`);
    assert.equal(feedPayUrlProblem(url), 'not a public host', `feed pay accepted ${url}`);
  }
  assert.equal(publicUrlProblem('https://metadata.example.com./x'), null);
  assert.equal(feedPayUrlProblem('https://pay.example.com./x'), null);
});
