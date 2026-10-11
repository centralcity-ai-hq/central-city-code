import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { CLIENT_ROUTES } from '../shared/routes.js';
import { SHARE_CARDS, SITE, withShareCard } from '../shared/share-cards.js';
import {
  PAGE_SOURCES,
  PUBLIC_PATHS,
  sitemapXml,
  structuredData,
  withStructuredData,
} from '../shared/seo.js';
import {
  committedLastmod,
  gitLastmod,
  readLastmodMap,
  refreshLastmodMap,
  sourceHash,
  type Git,
} from '../scripts/seo/lastmod.js';

const root = join(import.meta.dirname, '..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');

test('public pages are indexable, app routes are not, and robots.txt points at the sitemap', () => {
  assert.match(read('index.html'), /<meta name="robots" content="index, follow" \/>/);
  const vercel = JSON.parse(read('vercel.json')) as {
    headers: Array<{ source: string; headers: Array<{ key: string; value: string }> }>;
  };
  const noindexRules = vercel.headers.filter((rule) =>
    rule.headers.some((header) => header.key === 'X-Robots-Tag'),
  );
  assert.ok(noindexRules.length, 'X-Robots-Tag rules exist');
  for (const rule of noindexRules)
    assert.equal(rule.headers.find((h) => h.key === 'X-Robots-Tag')!.value, 'noindex, nofollow');
  const hidden = (path: string) =>
    noindexRules.some((rule) => new RegExp('^' + rule.source + '$').test(path));
  for (const path of [
    '/rooms',
    '/rooms/abc',
    '/settings/account',
    '/agents/x',
    '/r/launch',
    '/signin',
    '/share/elric.html',
    // The static 404 page and the raw shell are never indexed either.
    '/404.html',
    '/index.html',
    '/app.html',
  ])
    assert.ok(hidden(path), path);
  for (const path of ['/', '/elric', '/explorer', '/about', '/privacy', '/docs', '/roomsx'])
    assert.ok(!hidden(path), path);
  const robots = read('public/robots.txt');
  assert.match(robots, /^Sitemap: https:\/\/centralcity\.ai\/sitemap\.xml$/m);
  assert.match(robots, /^Disallow: \/api\/$/m);
  assert.ok(
    !robots.includes('Disallow: /rooms'),
    'app routes are not blocked, so crawlers see noindex',
  );
});

test('crawlers can fetch the three APIs the public pages read while rendering', () => {
  // The prerendered landing and the session check call /api/session and /api/public/* in the
  // browser, and /elric asks /api/elric whether Elric is on; Googlebot must be able to fetch them
  // or it renders the error screen or a 404 (soft 404; /elric was rejected for this).
  // They answer X-Robots-Tag: noindex, so they are fetched but never listed.
  const robots = read('public/robots.txt');
  const disallow = robots.indexOf('Disallow: /api/');
  for (const allow of ['Allow: /api/session', 'Allow: /api/public/', 'Allow: /api/elric$']) {
    const at = robots.indexOf(allow);
    assert.ok(at !== -1, `robots.txt: ${allow}`);
    assert.ok(at < disallow, `${allow} comes before Disallow: /api/`);
  }
  const vercel = JSON.parse(read('vercel.json')) as {
    headers: Array<{ source: string; headers: Array<{ key: string; value: string }> }>;
  };
  const rule = vercel.headers.find((entry) => entry.source === '/api/(session|elric|public/.*)');
  assert.ok(rule, 'vercel.json marks /api/session, /api/elric and /api/public/*');
  assert.deepEqual(rule.headers, [{ key: 'X-Robots-Tag', value: 'noindex, nofollow' }]);
  const pattern = new RegExp('^' + rule.source + '$');
  for (const path of ['/api/session', '/api/public/stats']) assert.ok(pattern.test(path), path);
  assert.ok(!pattern.test('/api/rooms'), 'the rest of the API is untouched');
});

test('the sitemap lists exactly the public pages, dated per page when the date is known', () => {
  const sitemap = sitemapXml((path) => (path === '/terms' ? null : '2026-10-03'));
  const locs = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]!);
  assert.deepEqual(
    locs,
    PUBLIC_PATHS.map((path) => `${SITE}${path}`),
  );
  assert.equal(new Set(locs).size, locs.length, 'no duplicates');
  assert.equal((sitemap.match(/<lastmod>2026-10-03<\/lastmod>/g) ?? []).length, locs.length - 1);
  assert.ok(sitemap.includes(`<url><loc>${SITE}/terms</loc></url>`), 'an unknown date is left out');
  // No dates at all: no lastmod anywhere (never the build date).
  assert.doesNotMatch(sitemapXml(null), /lastmod/);
  // Every public route served by the app is listed, aliases are not, and no app route is.
  for (const path of [
    '/',
    '/elric',
    '/explorer',
    '/docs/rooms',
    '/docs/api',
    '/downtown',
    '/imprint',
  ])
    assert.ok(PUBLIC_PATHS.includes(path), path);
  for (const path of ['/downtown/log', '/docs/start', '/how', '/rooms', '/settings', '/signin'])
    assert.ok(!PUBLIC_PATHS.includes(path), path);
  const routes = new Set(['/', ...CLIENT_ROUTES.map((route) => route.path)]);
  for (const path of PUBLIC_PATHS) assert.ok(routes.has(path), `${path} is a served route`);
  assert.throws(() => sitemapXml(() => 'today'));
});

test('lastmod is the last commit of each page’s own sources, and absent on a shallow clone', () => {
  // Every public page names sources that exist.
  for (const path of PUBLIC_PATHS) {
    const files = PAGE_SOURCES[path];
    assert.ok(files?.length, path);
    for (const file of files) assert.ok(existsSync(join(root, file)), `${path}: ${file}`);
  }
  const calls: string[][] = [];
  const fake =
    (shallow: string): Git =>
    (args) => {
      calls.push(args);
      if (args[0] === 'rev-parse') return `${shallow}\n`;
      return args.includes('src/trust/Terms.tsx') ? '2026-07-01T10:00:00+02:00\n' : '';
    };
  const warnings: string[] = [];
  const dated = gitLastmod(root, (message) => warnings.push(message), fake('false'));
  assert.ok(dated);
  assert.equal(dated('/terms'), '2026-07-01');
  assert.deepEqual(calls.at(-1), ['log', '-1', '--format=%cI', '--', 'src/trust/Terms.tsx']);
  assert.equal(dated('/about'), null, 'no commit: no date');
  assert.equal(dated('/rooms'), null);
  assert.equal(
    gitLastmod(root, (message) => warnings.push(message), fake('true')),
    null,
  );
  const noGit: Git = () => {
    throw new Error('git: not found');
  };
  assert.equal(
    gitLastmod(root, (message) => warnings.push(message), noGit),
    null,
  );
  assert.equal(warnings.length, 2);
});

test('every public page has its own title, description and canonical, plus JSON-LD', () => {
  const index = read('index.html');
  const heads = SHARE_CARDS.filter((card) => PUBLIC_PATHS.includes(card.path)).map((card) =>
    withStructuredData(withShareCard(index, card), card),
  );
  heads.unshift(index);
  const field = (html: string, pattern: RegExp) => pattern.exec(html)?.[1] ?? '';
  const titles = heads.map((html) => field(html, /<title>([^<]+)<\/title>/));
  const descriptions = heads.map((html) =>
    field(html, /<meta\s+name="description"\s+content="([^"]+)"/),
  );
  const canonicals = heads.map((html) => field(html, /<link rel="canonical" href="([^"]+)"/));
  for (const values of [titles, descriptions, canonicals]) {
    assert.ok(values.every(Boolean), 'present on every page');
    assert.equal(new Set(values).size, values.length, `unique: ${values.join(' | ')}`);
  }
  assert.deepEqual(
    canonicals,
    PUBLIC_PATHS.map((path) => `${SITE}${path}`),
  );
  for (const html of heads.slice(1)) {
    const blocks = [
      ...html.matchAll(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g),
    ];
    assert.equal(blocks.length, 2, 'the site graph and the page graph');
    for (const block of blocks) JSON.parse(block[1]!);
  }
  const rooms = SHARE_CARDS.find((card) => card.path === '/docs/rooms')!;
  const graph = structuredData(rooms)['@graph'] as Array<Record<string, unknown>>;
  const crumbs = graph.find((node) => node['@type'] === 'BreadcrumbList')!;
  assert.deepEqual(
    (crumbs.itemListElement as Array<{ name: string }>).map((item) => item.name),
    ['Central City', 'Docs', 'Rooms'],
  );
  const about = SHARE_CARDS.find((card) => card.path === '/about')!;
  assert.ok(
    !(structuredData(about)['@graph'] as unknown[]).some(
      (n) => (n as { '@type': string })['@type'] === 'BreadcrumbList',
    ),
  );
});

test('scripts/seo/lastmod.json is current: every page, its sources unchanged since its date', () => {
  const root = process.cwd();
  const map = readLastmodMap(root);
  assert.deepEqual(Object.keys(map).sort(), Object.keys(PAGE_SOURCES).sort());
  const stale = Object.entries(PAGE_SOURCES)
    .filter(([path, files]) => map[path]!.hash !== sourceHash(root, files))
    .map(([path]) => path);
  assert.deepEqual(stale, [], `A public page changed: run npm run seo:lastmod and commit ${stale}`);
  for (const [path, entry] of Object.entries(map))
    assert.match(entry.date, /^\d{4}-\d{2}-\d{2}$/, path);
  // A shallow-clone build dates every page from it.
  const dated = committedLastmod(root, map);
  for (const path of Object.keys(PAGE_SOURCES)) assert.equal(dated(path), map[path]!.date);
});

test('committed lastmod: a stale hash gives no date; a refresh keeps unchanged pages', () => {
  const root = process.cwd();
  const map = readLastmodMap(root);
  const stale = { ...map, '/': { date: '2020-01-01', hash: 'not-the-sources' } };
  assert.equal(committedLastmod(root, stale)('/'), null, 'never a wrong date');
  assert.equal(committedLastmod(root, stale)('/no-such-page'), null);
  const refreshed = refreshLastmodMap(root, '2030-01-01', stale, null, () => false);
  assert.equal(refreshed['/']!.date, '2030-01-01', 'a changed page gets today without git');
  assert.equal(refreshed['/']!.hash, map['/']!.hash);
  assert.deepEqual(refreshed['/terms'], map['/terms'], 'an unchanged page keeps its date');
  const withGit = refreshLastmodMap(
    root,
    '2030-01-01',
    stale,
    () => '2026-10-01',
    () => false,
  );
  assert.equal(withGit['/']!.date, '2026-10-01', 'git dates a committed change');
  const dirty = refreshLastmodMap(
    root,
    '2030-01-01',
    stale,
    () => '2026-10-01',
    () => true,
  );
  assert.equal(dirty['/']!.date, '2030-01-01', 'uncommitted edits are dated today');
});

test('IndexNow: one key file at the site root holds exactly its own name', () => {
  const files = readdirSync(join(root, 'public')).filter((name) =>
    /^[0-9a-f]{32}\.txt$/.test(name),
  );
  assert.equal(files.length, 1, 'exactly one public/<key>.txt');
  const key = files[0]!.slice(0, 32);
  assert.equal(read(`public/${key}.txt`), key, 'public/<key>.txt holds exactly the key');
  assert.match(read('scripts/seo/indexnow.mjs'), /api\.indexnow\.org\/indexnow/);
});
