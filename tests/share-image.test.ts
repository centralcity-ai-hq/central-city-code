import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { shellFor } from '../shared/routes.js';
import { SHARE_CARDS, withShareCard } from '../shared/share-cards.js';

const root = join(import.meta.dirname, '..');
const vercel = JSON.parse(readFileSync(join(root, 'vercel.json'), 'utf8')) as {
  rewrites: Array<{ source: string; destination: string }>;
};

test('links to centralcity.ai unfurl with the share image (1200×630) on every network', () => {
  const html = readFileSync(join(root, 'index.html'), 'utf8');
  const image = 'https://centralcity.ai/brand/og/og-default.png';
  assert.ok(html.includes(`<meta property="og:image" content="${image}" />`));
  assert.ok(html.includes('<meta property="og:image:width" content="1200" />'));
  assert.ok(html.includes('<meta property="og:image:height" content="630" />'));
  assert.ok(html.includes('<meta name="twitter:card" content="summary_large_image" />'));
  assert.ok(html.includes(`<meta name="twitter:image" content="${image}" />`));
  const png = readFileSync(join(root, 'public/brand/og/og-default.png'));
  // PNG header: width and height are big-endian at bytes 16 and 20.
  assert.equal(png.readUInt32BE(16), 1200);
  assert.equal(png.readUInt32BE(20), 630);
  for (const file of ['og-default-square.png', 'og-elric.png', 'og-explorer.png'])
    assert.ok(existsSync(join(root, 'public/brand/og', file)), file);
});

const meta = (html: string, key: string) =>
  new RegExp(`<meta\\s+${key}\\s+content="([^"]*)"`).exec(html)?.[1];
const titleOf = (html: string) => /<title>([^<]*)<\/title>/.exec(html)?.[1];
const canonicalOf = (html: string) => /<link rel="canonical" href="([^"]*)"/.exec(html)?.[1];
const unescape = (value: string | undefined) =>
  value
    ?.replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&');

const DEFAULT = {
  title: 'Central City · Every AI. One room.',
  image: 'og-default.png',
  alt: 'Central City: Every AI. One room.',
};

/** Every public page's own head; app routes and "/" keep index.html. */
function assertHead(html: string, card: (typeof SHARE_CARDS)[number]) {
  const { path } = card;
  assert.equal(unescape(titleOf(html)), card.title, `${path} <title>`);
  assert.equal(unescape(meta(html, 'name="description"')), card.description, `${path} desc`);
  assert.equal(canonicalOf(html), card.canonical, `${path} canonical`);
  assert.equal(meta(html, 'property="og:url"'), card.canonical, `${path} og:url`);
  assert.equal(unescape(meta(html, 'property="og:title"')), card.title, `${path} og:title`);
  assert.equal(
    unescape(meta(html, 'property="og:description"')),
    card.description,
    `${path} og:description`,
  );
  assert.equal(meta(html, 'property="og:image"'), card.image, `${path} og:image`);
  assert.equal(unescape(meta(html, 'name="twitter:title"')), card.title, `${path} tw title`);
  assert.equal(meta(html, 'name="twitter:image"'), card.image, `${path} twitter:image`);
}

test('every public page has its own title, description, canonical and link preview', () => {
  const html = readFileSync(join(root, 'index.html'), 'utf8');
  // The home page itself.
  assert.equal(titleOf(html), DEFAULT.title);
  assert.equal(canonicalOf(html), 'https://centralcity.ai/');
  assert.equal(meta(html, 'property="og:url"'), 'https://centralcity.ai/');
  assert.equal(meta(html, 'property="og:image:alt"'), DEFAULT.alt);
  // Organization and WebSite structured data, as a data block (CSP-safe, never executed).
  const jsonLd = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html)?.[1];
  assert.ok(jsonLd, 'JSON-LD block');
  const graph = (JSON.parse(jsonLd) as { '@graph': Array<{ '@type': string }> })['@graph'];
  assert.deepEqual(
    graph.map((node) => node['@type']),
    ['Organization', 'WebSite'],
  );

  const titles = new Set<string>();
  for (const card of SHARE_CARDS) {
    assertHead(withShareCard(html, card), card);
    assert.ok(card.description.length >= 40 && card.description.length <= 170, card.path);
    // Crawlers get the copy: vercel.json and the local server serve it for the route.
    const rewrite = vercel.rewrites.find((item) => item.source === card.path);
    assert.equal(rewrite?.destination, `/${card.shell}`, `${card.path} rewrite`);
    assert.equal(shellFor(card.path), card.shell, `${card.path} local shell`);
    if (card.canonical === `https://centralcity.ai${card.path}`) titles.add(card.title);
  }
  // Pages that are their own canonical never share a title.
  assert.equal(
    titles.size,
    SHARE_CARDS.filter((card) => card.canonical === `https://centralcity.ai${card.path}`).length,
  );
  // Elric and the Explorer keep their own share images; duplicates point at one address.
  const byPath = (path: string) => SHARE_CARDS.find((card) => card.path === path)!;
  assert.match(byPath('/elric').image, /og-elric\.png$/);
  assert.match(byPath('/explorer').image, /og-explorer\.png$/);
  assert.equal(byPath('/downtown/log').canonical, 'https://centralcity.ai/explorer');
  assert.equal(byPath('/docs/start').canonical, 'https://centralcity.ai/docs');
  assert.equal(byPath('/workflows').shell, 'share/workflows.html');
  // "/" is index.html itself (with the prerendered landing). App routes are not public pages:
  // they keep the shared plain shell, app.html (and are noindex).
  assert.equal(shellFor('/'), 'index.html');
  for (const path of ['/rooms', '/agents', '/settings', '/signin']) {
    assert.equal(shellFor(path), 'app.html', path);
    const rewrite = vercel.rewrites.find((item) => item.source === path);
    if (rewrite) assert.equal(rewrite.destination, '/app.html', path);
  }
});

test('the built output carries each route’s head (after pnpm build)', (t) => {
  const dist = join(root, 'dist');
  if (!existsSync(join(dist, 'index.html'))) return t.skip('no dist/: run pnpm build');
  const home = readFileSync(join(dist, 'index.html'), 'utf8');
  // The plain shell every page copy is made from; index.html is it plus the landing.
  const index = readFileSync(join(dist, 'app.html'), 'utf8');
  assert.match(home, /<h1 id="landing-title">/);
  assert.match(index, /<div id="root"><\/div>/);
  for (const asset of index.match(/\/assets\/[^"]+/g) ?? [])
    assert.ok(home.includes(asset), `index.html loads the same bundle: ${asset}`);
  assert.equal(
    meta(index, 'property="og:image"'),
    `https://centralcity.ai/brand/og/${DEFAULT.image}`,
  );
  for (const card of SHARE_CARDS) {
    const built = readFileSync(join(dist, card.shell), 'utf8');
    assertHead(built, card);
    // Same app: every hashed script and style of index.html. A prerendered copy may also link its
    // page stylesheet, so its first paint does not shift.
    const assets = (text: string): string[] => text.match(/\/assets\/[^"]+/g)?.sort() ?? [];
    for (const asset of assets(index))
      assert.ok(assets(built).includes(asset), `${card.path} loads the same bundle: ${asset}`);
    for (const asset of assets(built).filter((item) => !assets(index).includes(item)))
      assert.match(asset, /\.css$/, `${card.path}: only page styles are added`);
  }
});
