import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  CLIENT_REDIRECTS,
  CLIENT_ROUTES,
  isClientRoute,
  movedPath,
  TRAILING_SLASH_REDIRECT,
  withoutTrailingSlash,
} from '../shared/routes.js';
import { SHARE_CARDS } from '../shared/share-cards.js';
import { ACCEPTS_PAGE } from '../server/base/identity/short-links.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const vercel = JSON.parse(readFileSync(join(root, 'vercel.json'), 'utf8')) as {
  redirects: Array<{
    source: string;
    destination: string;
    permanent?: boolean;
    statusCode?: number;
  }>;
  rewrites: Array<{
    source: string;
    destination: string;
    has?: Array<{ type: string; key: string; value: string }>;
  }>;
};

/** Server-owned rewrites that must stay exactly as they are (API, MCP, OAuth, A2A, /j). */
const SERVER_REWRITES = [
  { source: '/api/:path*', destination: '/api' },
  { source: '/mcp', destination: '/api' },
  { source: '/mcp/open', destination: '/api' },
  { source: '/mcp/server-card', destination: '/.well-known/mcp/server-card.json' },
  { source: '/mcp/open/server-card', destination: '/.well-known/mcp/server-card.json' },
  { source: '/oauth/:path*', destination: '/api' },
  { source: '/.well-known/oauth-protected-resource', destination: '/api' },
  { source: '/.well-known/oauth-protected-resource/:path*', destination: '/api' },
  { source: '/.well-known/oauth-authorization-server', destination: '/api' },
  { source: '/.well-known/jwks.json', destination: '/api' },
  { source: '/.well-known/agent-registration.json', destination: '/api' },
  { source: '/a2a/:path*', destination: '/api' },
  { source: '/a/:path*', destination: '/api' },
  { source: '/j/:path*', destination: '/api' },
  // Only a build file that doesn't exist: an uncacheable 404 instead of /assets' immutable one.
  { source: '/assets/:path*', destination: '/api' },
  // The Markdown docs index (scripts/public-docs/build.ts) lives outside dist/docs/, so /docs
  // stays the docs app for browsers.
  { source: '/docs/index.md', destination: '/docs-index.md' },
  { source: '/docs.md', destination: '/docs-index.md' },
];

/** The vercel.json source syntax used here: literal segments and unnamed regex groups. */
const sourceRegExp = (source: string) => new RegExp(`^${source}$`);

const KNOWN = [
  '/',
  '/about',
  '/signin',
  '/invite',
  '/connect',
  '/workflows',
  '/use-cases',
  '/use-cases/claude-and-chatgpt',
  '/use-cases/bring-your-own-agent',
  '/downtown',
  '/privacy',
  '/terms',
  '/security',
  '/support',
  '/status',
  '/privacy-choices',
  '/acceptable-use',
  '/dpa',
  '/imprint',
  '/contact',
  '/r/launch-plan',
  '/r/A_b-9',
  '/rooms',
  '/rooms/room_123',
  '/agents',
  '/agents/7d9e2c1a-0b3f-4c5d-8e6f-1a2b3c4d5e6f',
  '/messages',
  '/elric',
  '/settings',
  '/settings/requests',
];
const UNKNOWN = [
  // Retired paths: redirects (CLIENT_REDIRECTS), never the SPA.
  '/how',
  '/answers',
  '/no-such-page',
  '/some/deep/link',
  '/rooms/a/b',
  '/r/',
  '/r/a.b',
  `/r/${'x'.repeat(65)}`,
  '/rooms/',
  '/settings/a/b',
  '/api/session',
  '/j/abc',
  '/mcp',
  '/index.htm',
  '/AGENTS.md',
];

test('vercel.json rewrites match the shared route table exactly', () => {
  const shells = new Set(CLIENT_ROUTES.map((entry) => entry.shell));
  // The one conditional rewrite: a browser at /a/<short> gets the passport page (the app shell),
  // ahead of the function that answers resolvers with the registration file (short-links.ts).
  const negotiated = vercel.rewrites.filter((item) => item.has);
  assert.deepEqual(negotiated, [
    {
      source: '/a/([0-9A-Za-z]{6})',
      has: [{ type: 'header', key: 'accept', value: ACCEPTS_PAGE }],
      destination: '/app.html',
    },
  ]);
  assert.ok(
    vercel.rewrites.indexOf(negotiated[0]) <
      vercel.rewrites.findIndex((item) => item.source === '/a/:path*'),
    'the passport page is matched before the registration file',
  );
  const client = vercel.rewrites.filter((item) => !item.has && shells.has(item.destination));
  assert.deepEqual(
    client.map((item) => ({ source: item.source, destination: item.destination })),
    CLIENT_ROUTES.map((entry) => ({ source: entry.vercelSource, destination: entry.shell })),
    'one explicit rewrite per client route to its shell, in table order',
  );
  // Nothing else may reach the SPA: no catch-all, so unmatched paths get 404.html with 404.
  assert.deepEqual(
    vercel.rewrites.filter((item) => !shells.has(item.destination)),
    SERVER_REWRITES,
    'API, MCP, OAuth, .well-known, A2A, /j and docs-index rewrites are unchanged',
  );
  assert.ok(!vercel.rewrites.some((item) => item.source.includes('.*')), 'no catch-all rewrite');
});

test('client-route matching agrees between the table and the vercel.json sources', () => {
  const sources = CLIENT_ROUTES.map((entry) => sourceRegExp(entry.vercelSource));
  for (const path of [...KNOWN, ...UNKNOWN]) {
    const vercelMatch = path === '/' || sources.some((source) => source.test(path));
    assert.equal(isClientRoute(path), vercelMatch, path);
  }
  for (const path of KNOWN) assert.ok(isClientRoute(path), path);
  for (const path of UNKNOWN) assert.ok(!isClientRoute(path), path);
});

/** Paths that end in a slash and move to the path without it. */
const SLASHED: Array<[string, string]> = [
  ['/connect/', '/connect'],
  ['/docs/', '/docs'],
  ['/docs/rooms/', '/docs/rooms'],
  ['/docs/room-management/', '/docs/room-management'],
  ['/docs/coding/', '/docs/coding'],
  ['/about/', '/about'],
  ['/rooms/', '/rooms'],
  ['/rooms/room_123/', '/rooms/room_123'],
  ['/r/launch-plan/', '/r/launch-plan'],
  ['/no-such-page/', '/no-such-page'],
  ['/jobs/', '/jobs'],
];
/** Paths that keep their exact form: root, server-owned paths, files, and unsafe shapes. */
const KEPT = [
  '/',
  '/connect',
  '/api/',
  '/api/session/',
  '/mcp/',
  '/mcp/open/',
  '/oauth/authorize/',
  '/.well-known/jwks.json/',
  '/.well-known/oauth-protected-resource/mcp/',
  '/a2a/x/',
  '/j/abc/',
  '/docs/room-tasks.md',
  '/docs/room-tasks.md/',
  '/docs/room-management.md',
  '/docs/coding.md/',
  '/llms.txt/',
  '//evil.example/',
  '/\\evil.example/',
  '/%2F%2Fevil.example/',
  '/about//',
];

test('a trailing slash redirects to the path without it; vercel.json has the same rule', () => {
  assert.deepEqual(vercel.redirects[0], TRAILING_SLASH_REDIRECT, 'first redirect: the shared rule');
  assert.equal(TRAILING_SLASH_REDIRECT.permanent, true, '308');
  // The vercel.json source (path-to-regexp; `:path(...)` is one group) agrees with the server.
  const source = new RegExp(
    `^${TRAILING_SLASH_REDIRECT.source.replace(/^\/:path\((.*)\)\/$/, '/($1)/')}$`,
  );
  for (const [from, to] of SLASHED) {
    assert.equal(withoutTrailingSlash(from), to, from);
    assert.equal(`/${source.exec(from)?.[1]}`, to, `vercel.json: ${from}`);
  }
  for (const path of KEPT) {
    assert.equal(withoutTrailingSlash(path), null, path);
    assert.equal(source.exec(path), null, `vercel.json: ${path}`);
  }
});

test('retired paths redirect (301); vercel.json has the same redirects', () => {
  assert.deepEqual(
    vercel.redirects,
    [TRAILING_SLASH_REDIRECT, ...CLIENT_REDIRECTS],
    'the trailing-slash rule, then one redirect per retired path',
  );
  assert.deepEqual(
    CLIENT_REDIRECTS.map((item) => [item.source, item.destination, item.statusCode]),
    [
      ['/how', '/#how', 301],
      ['/answers', '/docs', 301],
    ],
  );
  for (const { source } of CLIENT_REDIRECTS) {
    assert.ok(!isClientRoute(source), `${source} is not a client route`);
    assert.ok(!vercel.rewrites.some((item) => item.source === source), `${source}: no rewrite`);
  }
  assert.equal(movedPath('/how'), '/#how');
  assert.equal(movedPath('/answers'), '/docs');
  assert.equal(movedPath('/how?ref=x'), '/?ref=x#how');
  assert.equal(movedPath('/answers?a=1&b=2'), '/docs?a=1&b=2');
  for (const path of ['/', '/docs', '/how/x', '/answers/', '/howto', '/messages'])
    assert.equal(movedPath(path), null, path);
});

test('the 404 page is static, script-free and keeps the SPA copy', () => {
  const page = readFileSync(join(root, 'public', '404.html'), 'utf8');
  assert.doesNotMatch(page, /<script/i);
  assert.match(page, /<title>Page not found · Central City<\/title>/);
  assert.match(page, /This page doesn’t exist\./);
  assert.match(page, /<a href="\/">Go home<\/a>/);
});

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() =>
        typeof address === 'object' && address ? resolve(address.port) : reject(new Error('port')),
      );
    });
  });
}

async function startLocalServer(t: test.TestContext) {
  const temp = mkdtempSync(join(tmpdir(), 'cc-routes-'));
  const dist = join(temp, 'dist');
  mkdirSync(dist);
  writeFileSync(join(dist, 'index.html'), '<!doctype html><title>spa-shell-marker</title>');
  // The plain shell every client route without its own copy gets (shared/routes.ts APP_SHELL).
  writeFileSync(join(dist, 'app.html'), '<!doctype html><title>spa-shell-marker</title>');
  // The per-route copies the build writes (shared/share-cards.ts), with the same marker.
  mkdirSync(join(dist, 'share', 'docs'), { recursive: true });
  mkdirSync(join(dist, 'share', 'downtown'), { recursive: true });
  mkdirSync(join(dist, 'share', 'explorer'), { recursive: true });
  mkdirSync(join(dist, 'share', 'use-cases'), { recursive: true });
  for (const card of SHARE_CARDS)
    writeFileSync(join(dist, card.shell), '<!doctype html><title>spa-shell-marker</title>');
  writeFileSync(join(dist, '404.html'), readFileSync(join(root, 'public', '404.html')));
  const port = await freePort();
  const child: ChildProcess = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      CITY_DIST_DIR: dist,
      CITY_DATA_DIR: join(temp, 'data'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout!.on('data', (chunk) => (output += chunk));
  child.stderr!.on('data', (chunk) => (output += chunk));
  t.after(async () => {
    if (child.exitCode === null) {
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill('SIGTERM');
      await exited;
    }
    rmSync(temp, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`server exited early:\n${output}`);
    try {
      if ((await fetch(`${base}/api/session`)).ok) return base;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) throw new Error(`server did not start:\n${output}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

test('the local server serves client routes with 200 and everything else with a real 404', async (t) => {
  const base = await startLocalServer(t);
  for (const path of [
    '/',
    '/rooms',
    '/r/launch-plan',
    '/downtown',
    '/settings/requests',
    '/messages',
  ]) {
    const response = await fetch(`${base}${path}`);
    assert.equal(response.status, 200, path);
    assert.match(await response.text(), /spa-shell-marker/, path);
  }
  for (const path of ['/no-such-page', '/some/deep/link', '/r/a.b']) {
    const response = await fetch(`${base}${path}`);
    assert.equal(response.status, 404, path);
    assert.match(response.headers.get('content-type') ?? '', /text\/html/, path);
    assert.match(await response.text(), /This page doesn’t exist\./, path);
  }
  const head = await fetch(`${base}/rooms`, { method: 'HEAD' });
  assert.equal(head.status, 200);
  // Only GET and HEAD reach the SPA or the 404 page; API 404s stay JSON.
  assert.equal((await fetch(`${base}/rooms`, { method: 'POST' })).status, 404);
  const api = await fetch(`${base}/api/no-such-route`);
  assert.equal(api.status, 404);
  assert.deepEqual(await api.json(), { error: 'Unknown API route' });
  const session = await fetch(`${base}/api/session`);
  assert.equal(session.status, 200);
  assert.equal(typeof (await session.json()), 'object');
});

test('the local server redirects /path/ to /path with 308 and keeps the query', async (t) => {
  const base = await startLocalServer(t);
  for (const [from, to] of SLASHED) {
    const response = await fetch(`${base}${from}?x=1&y=2`, { redirect: 'manual' });
    assert.equal(response.status, 308, from);
    assert.equal(response.headers.get('location'), `${to}?x=1&y=2`, from);
  }
  const plain = await fetch(`${base}/connect/`, { redirect: 'manual' });
  assert.equal(plain.headers.get('location'), '/connect');
  // Followed, a slashed client route ends on the SPA.
  const followed = await fetch(`${base}/docs/`);
  assert.equal(followed.status, 200);
  assert.equal(new URL(followed.url).pathname, '/docs');
  assert.match(await followed.text(), /spa-shell-marker/);
  // Server-owned paths and root are never redirected.
  for (const path of [
    '/',
    '/api/session/',
    '/api/',
    '/mcp/',
    '/.well-known/jwks.json/',
    '/j/abc/',
  ]) {
    const response = await fetch(`${base}${path}`, { redirect: 'manual' });
    assert.notEqual(response.status, 308, path);
    assert.equal(response.headers.get('location'), null, path);
  }
  // Only GET and HEAD move; a POST keeps its path.
  const post = await fetch(`${base}/connect/`, { method: 'POST', redirect: 'manual' });
  assert.notEqual(post.status, 308);
  const head = await fetch(`${base}/about/`, { method: 'HEAD', redirect: 'manual' });
  assert.equal(head.status, 308);
  assert.equal(head.headers.get('location'), '/about');
});

test('the local server redirects /how and /answers with 301, query kept', async (t) => {
  const base = await startLocalServer(t);
  for (const [from, to] of [
    ['/how', '/#how'],
    ['/answers', '/docs'],
    ['/how?ref=x', '/?ref=x#how'],
    ['/answers?q=1', '/docs?q=1'],
    // The trailing slash goes first (308), then the retired path moves.
    ['/how/', '/how'],
  ]) {
    const response = await fetch(`${base}${from}`, { redirect: 'manual' });
    assert.equal(response.status, from.endsWith('/') ? 308 : 301, from);
    assert.equal(response.headers.get('location'), to, from);
  }
  const head = await fetch(`${base}/answers`, { method: 'HEAD', redirect: 'manual' });
  assert.equal(head.status, 301);
  // Followed, both end on a real page.
  for (const [from, path] of [
    ['/how', '/'],
    ['/answers', '/docs'],
  ]) {
    const followed = await fetch(`${base}${from}`);
    assert.equal(followed.status, 200, from);
    assert.equal(new URL(followed.url).pathname, path, from);
    assert.match(await followed.text(), /spa-shell-marker/, from);
  }
  // Only GET and HEAD move.
  const post = await fetch(`${base}/how`, { method: 'POST', redirect: 'manual' });
  assert.notEqual(post.status, 301);
});

test('unknown routes never echo the path or query string', async (t) => {
  const { createApp } = await import('../server/app.js');
  const app = await createApp({ dataDir: ':memory:', startWorkers: false });
  t.after(() => app.close());
  for (const url of [
    '/api/does-not-exist?probe=ccw_SECRETVALUE0123456789',
    '/oauth/not-a-route?token=ccw_SECRETVALUE0123456789',
  ]) {
    const res = await app.inject({ method: 'GET', url });
    assert.equal(res.statusCode, 404, res.body);
    assert.ok(!res.body.includes('SECRETVALUE') && !res.body.includes('does-not-exist'), res.body);
  }
  const api = await app.inject({ method: 'GET', url: '/api/nope?x=1' });
  assert.deepEqual(api.json(), { error: 'Unknown API route' });
});

test('a missing build file is a 404 nobody may cache (never the year-long /assets header)', async (t) => {
  const { createApp } = await import('../server/app.js');
  const app = await createApp({ dataDir: ':memory:', startWorkers: false });
  t.after(() => app.close());
  for (const url of ['/assets/App-AbCd1234.css', '/assets/chunk-x.js?v=1']) {
    const res = await app.inject({ method: 'GET', url });
    assert.equal(res.statusCode, 404, url);
    assert.equal(res.headers['cache-control'], 'no-store', url);
    assert.deepEqual(res.json(), { error: 'Not found' });
  }
  // On Vercel only a miss reaches the app: existing files are served before any rewrite.
  const vercel = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8')) as {
    rewrites: Array<{ source: string; destination: string }>;
  };
  assert.ok(vercel.rewrites.some((r) => r.source === '/assets/:path*' && r.destination === '/api'));
});
