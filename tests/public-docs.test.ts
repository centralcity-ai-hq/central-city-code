import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  DOCS_INDEX_FILE,
  ORIGIN,
  PUBLIC_DOCS,
  assertPublicSafe,
  writePublicDocs,
} from '../scripts/public-docs/build.js';
import { GUIDE_SLUGS, renderGuides } from '../scripts/public-docs/guides.js';
import { SHARE_CARDS } from '../shared/share-cards.js';

/**
 * The docs AIs are pointed at must be reachable by everyone: pages on centralcity.ai that the
 * build really produces, or files in a public GitHub repository. The application repository is
 * private, so links into it 404 for every reader.
 */
const root = fileURLToPath(new URL('..', import.meta.url));
const read = (path: string) => readFileSync(join(root, path), 'utf8');
const vercel = JSON.parse(read('vercel.json')) as {
  rewrites: Array<{ source: string; destination: string }>;
  headers: Array<{ source: string; headers: Array<{ key: string; value: string }> }>;
};
const PUBLIC_REPOS = new Set([
  ...(
    JSON.parse(read('public/downtown.json')) as { public_repositories: Array<{ name: string }> }
  ).public_repositories.map((repo) => repo.name.toLowerCase()),
  // Public install sources that are not code repositories on Downtown: the published Gemini CLI
  // extension (gemini extensions install needs its own repository root).
  'centralcity-ai-hq/gemini-cli-extension',
]);

const out = mkdtempSync(join(tmpdir(), 'cc-public-docs-'));
const generated = new Set(writePublicDocs(root, out).map((path) => `/${path}`));
test.after(() => rmSync(out, { recursive: true, force: true }));

/** The vercel.json source syntax used here: literals, `:name`, `:name*` and regex groups. */
function sourcePattern(source: string): RegExp {
  let pattern = '';
  for (let index = 0; index < source.length;) {
    const char = source[index]!;
    if (char === '(') {
      let depth = 0;
      let end = index;
      for (; end < source.length; end++) {
        if (source[end] === '\\') end++;
        else if (source[end] === '(') depth++;
        else if (source[end] === ')' && --depth === 0) break;
      }
      pattern += source.slice(index, end + 1);
      index = end + 1;
    } else if (char === '\\') {
      pattern += source.slice(index, index + 2);
      index += 2;
    } else if (char === ':') {
      const name = /^:\w+(\*)?/.exec(source.slice(index))!;
      pattern += name[1] ? '.*' : '[^/]+';
      index += name[0].length;
    } else {
      pattern += char.replace(/[.+?^${}|[\]]/g, '\\$&');
      index++;
    }
  }
  return new RegExp(`^${pattern}$`);
}

/** A file the deployment serves as is: from public/, or generated into dist/ by the build. */
function builtFile(path: string): boolean {
  if (path === '/' || path === '/index.html') return true;
  if (generated.has(path)) return true;
  // A rewrite to a generated or public file (the docs index) serves that file.
  const rewrite = vercel.rewrites.find((item) => sourcePattern(item.source).test(path));
  if (rewrite && !['/api', '/index.html'].includes(rewrite.destination))
    return rewrite.destination !== path && builtFile(rewrite.destination);
  const file = join(root, 'public', ...path.split('/').filter(Boolean));
  return existsSync(file) && statSync(file).isFile();
}

/** A path answered by the deployment: a built file, or a rewrite to the API or the app. */
function served(path: string): boolean {
  if (builtFile(path)) return true;
  return vercel.rewrites.some((rewrite) => sourcePattern(rewrite.source).test(path));
}

function responseHeaders(path: string): Map<string, string> {
  const headers = new Map<string, string>();
  for (const rule of vercel.headers)
    if (sourcePattern(rule.source).test(path))
      for (const header of rule.headers) headers.set(header.key.toLowerCase(), header.value);
  return headers;
}

function urls(text: string): string[] {
  return [...text.matchAll(/https?:\/\/[^\s)`'"<>\]]+(?:<[^>\s]+>[^\s)`'"<>\]]*)*/g)].map(([url]) =>
    url.replace(/[.,:;]+$/, ''),
  );
}

/**
 * Why a URL is not publicly reachable, or null when it is. `strict` (llms.txt, llms-full.txt)
 * allows only centralcity.ai and public GitHub repositories; otherwise other hosts (standards,
 * provider APIs) pass and only centralcity.ai and GitHub links are checked.
 */
function problem(url: string, strict: boolean): string | null {
  // Placeholders such as <code> or <agent-id> stand for one path segment.
  let parsed: URL;
  try {
    parsed = new URL(url.replace(/<[^>]+>/g, 'x'));
  } catch {
    return strict ? 'not a URL' : null;
  }
  if (parsed.hostname === 'centralcity.ai') {
    if (parsed.protocol !== 'https:') return 'not https';
    const path = decodeURIComponent(parsed.pathname);
    // Documents must be real files in the build; other paths may be API or app routes.
    if (/\.(?:md|txt)$/.test(path))
      return builtFile(path) ? null : `${path} is not in the build output`;
    return served(path) ? null : `${path} is not served`;
  }
  if (parsed.hostname === 'github.com' || parsed.hostname.endsWith('githubusercontent.com')) {
    const [owner, repo] = parsed.pathname.split('/').filter(Boolean);
    if (parsed.hostname !== 'github.com')
      return 'raw GitHub links are not allowed; link the repository page';
    if (!owner || !repo) return 'not a repository URL';
    return PUBLIC_REPOS.has(`${owner}/${repo}`.toLowerCase())
      ? null
      : `${owner}/${repo} is not a public repository`;
  }
  return strict
    ? `${parsed.hostname} is neither centralcity.ai nor a public GitHub repository`
    : null;
}

function assertReachable(name: string, text: string, strict = false) {
  const found = urls(text);
  assert.ok(found.length > 0, `${name} has URLs`);
  const problems = found.flatMap((url) => {
    const reason = problem(url, strict);
    return reason ? [`${name}: ${url}: ${reason}`] : [];
  });
  assert.deepEqual(problems, []);
}

test('the public repository list is known', () => {
  assert.ok(PUBLIC_REPOS.has('centralcity-ai-hq/protocol'));
  assert.ok(PUBLIC_REPOS.has('centralcity-ai-hq/toolkit'));
  assert.ok(PUBLIC_REPOS.has('centralcity-ai-hq/central-city-code'));
});

test('every URL in llms.txt and llms-full.txt is built on centralcity.ai or in a public repo', () => {
  for (const file of ['public/llms.txt', 'public/llms-full.txt']) {
    const text = read(file);
    assert.doesNotMatch(text, /raw\.githubusercontent\.com/, file);
    assertReachable(file, text, true);
  }
  // Every Markdown page is linked from llms.txt, and the index from both files.
  const llms = read('public/llms.txt');
  for (const doc of PUBLIC_DOCS)
    assert.ok(llms.includes(`${ORIGIN}/docs/${doc.slug}.md`), doc.slug);
  assert.ok(read('public/llms-full.txt').includes(`${ORIGIN}/docs/index.md`));
});

test('the server card and server.json point only at reachable docs', () => {
  for (const file of ['public/.well-known/mcp/server-card.json', 'server.json'])
    assertReachable(file, read(file));
});

test('the build writes every public page, the index and /docs.md', () => {
  for (const doc of PUBLIC_DOCS) assert.ok(generated.has(`/docs/${doc.slug}.md`), doc.slug);
  for (const required of ['rooms', 'join-links', 'responder', 'room-tasks', 'api'])
    assert.ok(generated.has(`/docs/${required}.md`), required);
  assert.ok(generated.has(`/${DOCS_INDEX_FILE}`));
  for (const alias of ['/docs/index.md', '/docs.md']) assert.ok(builtFile(alias), alias);
  // Vercel answers /docs with a directory index or docs.* file, which would hand browsers raw
  // Markdown instead of the docs app: nothing may be written at those places.
  for (const path of generated) assert.doesNotMatch(path, /^\/docs(?:\/index)?\.[a-z]+$/, path);
  // The app shell: index.html or the copy of it with the /docs page head (shared/share-cards.ts).
  assert.match(
    vercel.rewrites.find((item) => item.source === '/docs')?.destination ?? '',
    /^\/(?:index|share\/docs)\.html$/,
    '/docs is the docs app',
  );
  for (const path of generated) {
    const text = readFileSync(join(out, path), 'utf8');
    assert.match(text, /^# \S/, `${path} starts with a title`);
    assert.ok(text.length > 400, `${path} has content`);
    assertPublicSafe(path, text);
    assertReachable(path, text);
    // Relative links between pages resolve to generated pages.
    for (const [, target] of text.matchAll(/\]\((\/[^)\s#]+)(?:#[^)\s]*)?\)/g))
      assert.ok(builtFile(target!), `${path}: ${target} is not in the build output`);
  }
  // Static files in public/ must not shadow a generated page.
  for (const path of generated) assert.ok(!existsSync(join(root, 'public', path)), path);
});

test('llms.txt and llms-full.txt pass the public-safety check', () => {
  // Static public files skip the docs build, so they are checked here with the same patterns.
  for (const file of ['public/llms.txt', 'public/llms-full.txt'])
    assertPublicSafe(file, read(file));
});

test('the public-safety check rejects internal notes, source paths and raw links', () => {
  const unsafe = [
    'https://raw.githubusercontent.com/example/project/main/docs/ROOMS.md',
    'Wiring pending: the tools file is next.',
    'TODO: describe the retry policy.',
    'Fixed in PR #12.',
    'Code: `server/rooms/service.ts`.',
    'Each code is an HMAC of its `join_links` row id.',
    'Every row in room_members keeps a read cursor.',
  ];
  for (const line of unsafe)
    assert.throws(() => assertPublicSafe('sample', line), /check failed/, line);
  assert.doesNotThrow(() =>
    assertPublicSafe('sample', 'Rooms are shared threads; use `city_room_read`.'),
  );
});

test('the public-safety check rejects secret values and deployment configuration', () => {
  // Built at run time so the repository's own secret scanner never sees a secret-shaped literal.
  const fake = (length: number) => 'aB3dE5fG7hJ9kL2mN4pQ6rS8tU0vW1xY'.repeat(4).slice(0, length);
  const unsafe = [
    ['-----BEGIN ', 'PRIVATE KEY-----'].join(''),
    ['-----BEGIN ', 'EC PRIVATE KEY-----'].join(''),
    `DATABASE: ${['postgres', '://city:'].join('')}${fake(20)}@db.example.net/city`,
    `key ${['sk-', 'ant-api03-'].join('')}${fake(40)}`,
    `key ${'sk-'}${fake(48)}`,
    `${['AK', 'IA'].join('')}${fake(16).toUpperCase()}`,
    `${['gh', 'p_'].join('')}${fake(36)}`,
    `${['cc', 'w_'].join('')}${fake(32)}`,
    `${['whs', 'ec_'].join('')}${fake(43)}`,
    `${['ey', 'J'].join('')}${fake(20)}.${['ey', 'J'].join('')}${fake(20)}.${fake(20)}`,
    `api_key = "${fake(32)}"`,
    'Set `CITY_RATE_LIMIT_KEY` to 32 characters.',
    'Configure `CITY_SIGNING_KEY` as a JWK.',
    'Without `DATABASE_URL` the app uses PGlite.',
    'the hosted pool holds three clients',
    'Fastify with `trustProxy` limited to the configured hops',
  ];
  for (const line of unsafe)
    assert.throws(() => assertPublicSafe('sample', line), /check failed/, line.slice(0, 24));
  // Documented formats (never values) stay allowed.
  for (const line of [
    'The key is `ccw_…`, shown once.',
    '`whsec_<base64 of 32 bytes>`, shown **once**.',
    'Anthropic keys start with `sk-ant-api`.',
  ])
    assert.doesNotThrow(() => assertPublicSafe('sample', line), line);
});

/**
 * The rendered pages are committed under scripts/public-docs/snapshot/, so every change to what
 * centralcity.ai publishes (a new subsection, a new paragraph) shows up as a diff in review.
 * After changing a source doc or the builder, regenerate them with
 *   UPDATE_PUBLIC_DOCS=1 pnpm test:files tests/public-docs.test.ts
 * and read the diff before committing.
 */
test('the rendered pages match the reviewed snapshot', () => {
  const dir = join(root, 'scripts', 'public-docs', 'snapshot');
  const name = (path: string) => `${path.slice(1).replace(/\//g, '__')}.snap`;
  const expected = new Map(
    [...generated].map((path) => [name(path), readFileSync(join(out, path), 'utf8')]),
  );
  if (process.env.UPDATE_PUBLIC_DOCS === '1') {
    mkdirSync(dir, { recursive: true });
    for (const file of readdirSync(dir)) if (!expected.has(file)) unlinkSync(join(dir, file));
    for (const [file, text] of expected) writeFileSync(join(dir, file), text);
  }
  const hint =
    'run UPDATE_PUBLIC_DOCS=1 pnpm test:files tests/public-docs.test.ts and review the diff';
  const committed = existsSync(dir)
    ? readdirSync(dir).filter((file) => file.endsWith('.snap'))
    : [];
  assert.deepEqual(committed.sort(), [...expected.keys()].sort(), `snapshot files differ: ${hint}`);
  for (const [file, text] of expected)
    assert.equal(readFileSync(join(dir, file), 'utf8'), text, `${file} changed: ${hint}`);
});

test('Markdown pages are served as text/markdown; /docs links to them and works without JavaScript', () => {
  for (const path of [
    '/docs/rooms.md',
    '/docs/room-management.md',
    '/docs/coding.md',
    '/docs/feed.md',
    '/docs/index.md',
    '/docs.md',
    `/${DOCS_INDEX_FILE}`,
  ]) {
    const headers = responseHeaders(path);
    assert.equal(headers.get('content-type'), 'text/markdown; charset=utf-8', path);
    assert.equal(headers.get('access-control-allow-origin'), '*', path);
    assert.equal(headers.get('x-content-type-options'), 'nosniff', path);
  }
  for (const [page, markdown] of [
    ['/docs', '/docs/index.md'],
    ['/docs/start', '/docs/index.md'],
    ['/docs/rooms', '/docs/rooms.md'],
    ['/docs/room-management', '/docs/room-management.md'],
    ['/docs/coding', '/docs/coding.md'],
    ['/docs/feed', '/docs/feed.md'],
    ['/docs/api', '/docs/api.md'],
  ] as const) {
    assert.ok(served(page), page);
    assert.equal(
      responseHeaders(page).get('link'),
      `<${markdown}>; rel="alternate"; type="text/markdown"`,
      page,
    );
    assert.ok(builtFile(markdown), markdown);
  }
  const html = read('index.html');
  assert.match(html, /<link rel="alternate" type="text\/markdown" href="\/docs\/index\.md"/);
  const noscript = /<noscript>([\s\S]*?)<\/noscript>/.exec(html)?.[1] ?? '';
  for (const href of ['/docs/index.md', '/llms.txt', '/llms-full.txt'])
    assert.ok(noscript.includes(`href="${href}"`), href);
  // The build hook is wired in.
  assert.match(read('vite.config.ts'), /plugins: \[[^\]]*publicDocs\(\)/);
});

test('the HTML guides render the same text as their Markdown pages', () => {
  const out = mkdtempSync(join(tmpdir(), 'cc-guides-'));
  try {
    writePublicDocs(root, out);
    const guides = renderGuides(root);
    assert.deepEqual(
      guides.map((guide) => guide.slug),
      [...GUIDE_SLUGS],
    );
    const text = (node: object): string =>
      'value' in node
        ? String(node.value)
        : 'children' in node
          ? (node.children as object[]).map(text).join('')
          : '';
    for (const guide of guides) {
      const doc = PUBLIC_DOCS.find((entry) => entry.slug === guide.slug)!;
      assert.equal(guide.title, doc.title);
      assert.equal(guide.summary, doc.summary);
      const markdown = readFileSync(join(out, 'docs', `${guide.slug}.md`), 'utf8');
      // Every H2 of the .md is a section of the page, in order.
      assert.deepEqual(
        guide.tree.children.filter((node) => node.type === 'heading' && node.depth === 2).map(text),
        [...markdown.matchAll(/^## (.+)$/gm)].map((match) => match[1]!.replace(/`/g, '')),
        guide.slug,
      );
      assert.equal(guide.tree.children.filter((node) => node.type === 'table').length > 0, true);
      assert.ok(!JSON.stringify(guide.tree).includes('"position"'), 'no source positions');
      // The page's meta description is the summary.
      const card = SHARE_CARDS.find((each) => each.path === `/docs/${guide.slug}`);
      assert.equal(card?.description, doc.summary, guide.slug);
    }
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
