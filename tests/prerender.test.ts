import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { loadPrerender, type RenderPublicPage } from '../scripts/prerender/load.js';
import { LISTINGS } from '../src/landing/ListedOn.js';
import {
  homeHtml,
  SESSION_GATED_PATHS,
  SHARE_CARDS,
  shareCardHtml,
  withPrerenderedRoot,
} from '../shared/share-cards.js';

const root = join(import.meta.dirname, '..');
const index = readFileSync(join(root, 'index.html'), 'utf8');
const cardFor = (path: string) => {
  const card = SHARE_CARDS.find((each) => each.path === path);
  assert.ok(card, path);
  return card;
};
/** The markup inside #root (the copies have nothing after it but the entry script). */
const rootOf = (html: string) =>
  /<div id="root"[^>]*>([\s\S]*)<\/div>\s*<script/.exec(html)?.[1] ?? '';
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, '')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, '&');

let loaded: Awaited<ReturnType<typeof loadPrerender>>;
let render: RenderPublicPage;
before(async () => {
  loaded = await loadPrerender(root);
  render = loaded.render;
});
after(() => loaded.close());

test('the public content pages carry their text inside #root in their first HTML', () => {
  const about = shareCardHtml(index, cardFor('/about'), render);
  assert.equal(about.prerendered, true);
  const aboutRoot = rootOf(about.html);
  assert.match(aboutRoot, /<h1 id="trust-title">About Central City<\/h1>/);
  assert.ok(text(aboutRoot).includes('Central City is where the world’s AI agents meet.'));
  // The public shell is the one the app renders.
  assert.match(aboutRoot, /class="public-shell"/);
  // Marked busy and disabled until the app has mounted (src/shell/prerendered.ts).
  assert.match(about.html, /<div id="root" aria-busy="true" aria-disabled="true">/);
  assert.match(aboutRoot, /<footer class="cc-footer/);
  // The head is still the route's own, and the "needs JavaScript" notice is gone.
  assert.match(about.html, /<title>About Central City<\/title>/);
  assert.doesNotMatch(about.html, /<noscript>/);

  const privacy = shareCardHtml(index, cardFor('/privacy'), render);
  assert.equal(privacy.prerendered, true);
  const privacyRoot = rootOf(privacy.html);
  assert.match(privacyRoot, /<h1 id="trust-title">Privacy Policy<\/h1>/);
  assert.match(privacyRoot, /<h2 id="controller">1\. Who we are<\/h2>/);
  assert.ok(text(privacyRoot).includes('This Privacy Policy explains how'));
});

test('every public page prerenders; app pages keep the plain shell', () => {
  const prerendered = SHARE_CARDS.filter(
    (card) => shareCardHtml(index, card, render, assert.fail).prerendered,
  ).map((card) => card.path);
  for (const path of [
    '/about',
    '/terms',
    '/imprint',
    '/downtown',
    '/workflows',
    '/docs',
    '/docs/rooms',
    '/docs/room-management',
    '/docs/coding',
    '/docs/feed',
    '/docs/api',
    '/use-cases',
    '/use-cases/claude-and-chatgpt',
    '/use-cases/gemini-cli-and-claude-code',
    '/use-cases/multi-ai-research-team',
    '/use-cases/multi-ai-code-review',
    '/use-cases/bring-your-own-agent',
    '/use-cases/cursor-and-claude-code',
    '/use-cases/team-ai-workspace',
    '/elric',
    '/explorer',
    '/downtown/log',
    '/connect',
    '/invite',
    '/downtown/verify',
  ])
    assert.ok(prerendered.includes(path), path);
  // Routes without a card (rooms, settings, sign-in) are not prerendered at all.
  for (const path of ['/rooms', '/settings', '/signin']) assert.equal(render(path), null, path);
});

/** The page's visible text inside #root, tags removed and whitespace collapsed. */
const words = (html: string) => text(rootOf(html)).replace(/\s+/g, ' ');

test('the home, Elric, Connect, Invite, Verify and Explorer pages carry their copy and links', () => {
  const home = homeHtml(index, render, assert.fail);
  assert.equal(home.prerendered, true);
  const homeRoot = rootOf(home.html);
  const h1 = /<h1 id="landing-title">([\s\S]*?)<\/h1>/.exec(homeRoot)?.[1] ?? '';
  assert.equal(text(h1), 'Every AI. One room.');
  assert.match(h1, /<span class="cc-room">One room\.<\/span>/);
  for (const line of [
    'Open protocol for AI agents',
    'Claude, ChatGPT, Gemini and your own agents work together in shared rooms, carry a passport on Base and pay each other for services in USDC.',
    'Central City',
    'Every AI at the same table.',
    'Every agent deserves a passport.',
    'Your room never sleeps.',
    'Connect your AI in 30 seconds.',
  ])
    assert.ok(words(home.html).includes(line), line);
  for (const href of [
    '/#create',
    '/downtown',
    '/downtown/verify',
    '/docs',
    '/explorer/calls',
    '/explorer/base',
    '/elric',
    '/connect',
  ])
    assert.ok(homeRoot.includes(`href="${href}"`), href);
  // "Listed on": each listing twice (the endless strip's copy is aria-hidden).
  for (const listing of LISTINGS)
    assert.equal(
      homeRoot.split(`href="${listing.href.replace(/&/g, '&amp;')}"`).length - 1,
      2,
      listing.name,
    );
  assert.match(homeRoot, /<div class="cc-lo-set" aria-hidden="true">/);
  assert.match(homeRoot, /<div class="cc-field" aria-hidden="true">/);
  // The head is the home page's own; the "needs JavaScript" notice is gone.
  assert.match(home.html, /<title>Central City · Every AI\. One room\.<\/title>/);
  assert.match(home.html, /<link rel="canonical" href="https:\/\/centralcity\.ai\/"/);
  assert.match(home.html, /application\/ld\+json/);
  assert.doesNotMatch(home.html, /<noscript>/);

  const pages: Array<[string, RegExp, string[], string[]]> = [
    ['/elric', /<h1[^>]*>Elric<\/h1>/, ['What can I help with?'], []],
    [
      '/connect',
      /<h1[^>]*>Connect your AI<\/h1>/,
      [
        'Bring the AI you already use.',
        'Add Central City to ChatGPT, Claude, Cursor, VS Code, Gemini CLI or Codex once.',
        'https://centralcity.ai/mcp',
        'Which AI do you use?',
        'Paste a room link in ChatGPT. Your AI joins the room.',
        'Open protocol (MCP)',
      ],
      ['/docs'],
    ],
    [
      '/invite',
      /<h1[^>]*>Invite your AI<\/h1>/,
      ['Sign in, copy one link, and paste it into your AI.'],
      ['/connect', '/docs'],
    ],
    [
      '/downtown/verify',
      /<h1[^>]*>Verify the agent count<\/h1>/,
      ['The number on the homepage comes from a public log that can only grow.'],
      ['/explorer'],
    ],
    [
      '/explorer',
      /<h1[^>]*>Agent Explorer<\/h1>/,
      ['Every AI agent on Central City, live'],
      ['/downtown/verify'],
    ],
    [
      '/workflows',
      /<h1[^>]*>One source. Two agents. Your decision.<\/h1>/,
      ['Check against source', 'Code review crew', 'How it stays safe'],
      ['/rooms', '/docs'],
    ],
  ];
  for (const [path, h1, copy, links] of pages) {
    const page = shareCardHtml(index, cardFor(path), render, assert.fail);
    assert.equal(page.prerendered, true, path);
    const markup = rootOf(page.html);
    assert.match(markup, h1, path);
    for (const line of copy) assert.ok(words(page.html).includes(line), `${path}: ${line}`);
    for (const href of links) assert.ok(markup.includes(`href="${href}"`), `${path}: ${href}`);
    assert.match(page.html, new RegExp(`<title>${cardFor(path).title}</title>`), path);
    assert.doesNotMatch(page.html, /<noscript>/, path);
  }
});

/** The live numbers' four cells in the home page's markup, by data-stat. */
const cells = (home: string) =>
  Object.fromEntries(
    [...home.matchAll(/<div class="cc-kc" data-stat="(\w+)"([^>]*)>([\s\S]*?)<\/div>/g)].map(
      (match) => [match[1]!, { attributes: match[2]!, text: text(match[3]!) }],
    ),
  );

test('live numbers are not baked into the HTML: they render in their loading state', () => {
  // The agent count, when the build has none: a dash like the others, never a 0.
  loaded.setAgentCount(null);
  const home = rootOf(homeHtml(index, render, assert.fail).html);
  assert.deepEqual(cells(home), {
    value: { attributes: '', text: 'Total value settled (x402)$–USDC' },
    paid: { attributes: '', text: 'Paid service calls–' },
    base: { attributes: '', text: 'Central City base agents–' },
    agents: { attributes: ' data-agent-ticker="true"', text: 'AI agents joined–' },
  });
  assert.match(home, /<dl class="cc-kgrid" aria-hidden="true">/);
  assert.match(home, /<p class="visually-hidden">Numbers of Central City\.<\/p>/);
  assert.doesNotMatch(home, /data-build-count/);
  assert.match(
    text(rootOf(shareCardHtml(index, cardFor('/explorer'), render).html)),
    /Loading the log/,
  );
  assert.match(
    text(rootOf(shareCardHtml(index, cardFor('/downtown/verify'), render).html)),
    /Checking the log/,
  );
});

test("the build's agent count is in the landing HTML, marked as of the build", () => {
  const at = Date.parse('2026-10-05T12:00:00.000Z');
  loaded.setAgentCount({ total: 114_251, at });
  try {
    const home = rootOf(homeHtml(index, render, assert.fail).html);
    const { agents, value, paid, base } = cells(home);
    assert.equal(
      agents?.attributes,
      ' data-agent-ticker="true" data-build-count="114251" data-build-at="2026-10-05T12:00:00.000Z"',
    );
    // The settled number (no count in the HTML).
    assert.equal(agents?.text, 'AI agents joined114,251');
    assert.match(
      home,
      /<p class="visually-hidden">Central City, last known: 114,251 AI agents joined\.<\/p>/,
    );
    // The other numbers stay dashes: only the agent count is read at build time.
    assert.equal(value?.text, 'Total value settled (x402)$–USDC');
    assert.equal(paid?.text, 'Paid service calls–');
    assert.equal(base?.text, 'Central City base agents–');
    assert.equal(home.match(/data-agent-ticker/g)?.length, 1);
    loaded.setAgentCount({ total: 1, at });
    assert.equal(
      cells(rootOf(homeHtml(index, render, assert.fail).html)).agents?.text,
      'AI agents joined1',
    );
    // Never a baked 0: a build count of 0 is none.
    loaded.setAgentCount({ total: 0, at });
    assert.equal(
      cells(rootOf(homeHtml(index, render, assert.fail).html)).agents?.text,
      'AI agents joined–',
    );
    // Only the landing carries it.
    loaded.setAgentCount({ total: 114_251, at });
    assert.doesNotMatch(
      shareCardHtml(index, cardFor('/downtown/verify'), render).html,
      /data-build-count/,
    );
  } finally {
    loaded.setAgentCount(null);
  }
});

test("the build's Base agents number is in its cell, marked as of the build; never a 0", () => {
  const at = Date.parse('2026-10-05T12:00:00.000Z');
  loaded.setAgentCount({ total: 114_251, at });
  loaded.setBaseAgents({ total: 31_452, asOf: at });
  try {
    const home = rootOf(homeHtml(index, render, assert.fail).html);
    const { base, paid, value } = cells(home);
    assert.equal(
      base?.attributes,
      ' data-build-base="31452" data-build-base-at="2026-10-05T12:00:00.000Z"',
    );
    assert.equal(base?.text, 'Central City base agents31,452');
    assert.match(
      home,
      /<p class="visually-hidden">Central City, last known: 31,452 Central City base agents, 114,251 AI agents joined\.<\/p>/,
    );
    // The money numbers stay dashes.
    assert.equal(paid?.text, 'Paid service calls–');
    assert.equal(value?.text, 'Total value settled (x402)$–USDC');
    loaded.setBaseAgents({ total: 0, asOf: at });
    const zero = cells(rootOf(homeHtml(index, render, assert.fail).html)).base;
    assert.equal(zero?.text, 'Central City base agents–');
    assert.equal(zero?.attributes, '');
  } finally {
    loaded.setBaseAgents(null);
    loaded.setAgentCount(null);
  }
});

test('the paid service calls are never baked, whatever the build saw (no reserved line on the landing)', () => {
  loaded.setAgentCount(null);
  try {
    for (const reserved of [true, false]) {
      loaded.setPaidCallsLine(reserved);
      const home = rootOf(homeHtml(index, render, assert.fail).html);
      assert.doesNotMatch(home, /data-paid-calls/);
      assert.equal(cells(home).paid?.text, 'Paid service calls–');
    }
  } finally {
    loaded.setPaidCallsLine(false);
  }
});

test('the session-gated pages are marked, so a signed-in browser hides their signed-out copy', () => {
  assert.deepEqual([...SESSION_GATED_PATHS], ['/', '/elric', '/connect', '/invite']);
  assert.match(homeHtml(index, render).html, /<div id="root" [^>]*data-session-gated="">/);
  for (const path of ['/elric', '/connect', '/invite'])
    assert.match(
      shareCardHtml(index, cardFor(path), render).html,
      /<div id="root" [^>]*data-session-gated="">/,
      path,
    );
  for (const path of ['/about', '/docs', '/explorer', '/downtown/verify'])
    assert.doesNotMatch(shareCardHtml(index, cardFor(path), render).html, /data-session-gated/);
});

test('the guides render their Markdown as docs HTML, with no raw HTML and a link to the .md', () => {
  for (const [path, title, section] of [
    ['/docs/room-management', 'Room management', 'id="errors">Errors</h2>'],
    ['/docs/coding', 'Coding in rooms', 'id="who-can-do-what">Who can do what</h2>'],
  ] as const) {
    const page = shareCardHtml(index, cardFor(path), render, assert.fail);
    assert.equal(page.prerendered, true, path);
    const markup = rootOf(page.html);
    assert.match(markup, new RegExp(`<h1>${title}</h1>`), path);
    assert.ok(markup.includes(section), path);
    // Headings and the closing AI index link of the .md are not repeated.
    assert.doesNotMatch(markup, /<h1>[^<]*<\/h1>[\s\S]*<h1>/, path);
    assert.doesNotMatch(markup, /More docs:/, path);
    assert.ok(markup.includes(`<a href="${path}.md" type="text/markdown">View as Markdown</a>`));
    // Tables scroll inside their own box; code is code.
    assert.match(markup, /<div class="docs-table" tabindex="0" role="region" aria-label="Table: /);
    assert.match(markup, /<code>403 muted_in_room<\/code>|<code>muted_in_room<\/code>/);
    // The sidebar marks this page and links the HTML pages, not the .md files.
    assert.match(markup, new RegExp(`<a href="${path}" class="[^"]*" aria-current="page">`));
    assert.doesNotMatch(markup, /<a href="\/docs\/(?:room-management|coding)\.md" class=/);
    assert.doesNotMatch(markup, /<script|javascript:/i, path);
    assert.match(page.html, new RegExp(`<title>${title} · Central City Docs</title>`));
  }
});

test('the Feed guide renders as a docs page, and the API tool list names the Feed tools', () => {
  const page = shareCardHtml(index, cardFor('/docs/feed'), render, assert.fail);
  assert.equal(page.prerendered, true);
  const markup = rootOf(page.html);
  assert.match(markup, /<h1>How the Feed works<\/h1>/);
  for (const section of [
    'id="offered">Offered</h2>',
    'id="use-a-service">Use a service</h2>',
    'id="post-a-request">Post a request</h2>',
    'id="for-ais-and-developers">For AIs and developers</h2>',
  ])
    assert.ok(markup.includes(section), section);
  assert.ok(markup.includes('<a href="/docs/feed.md" type="text/markdown">View as Markdown</a>'));
  assert.match(markup, /<a href="\/docs\/feed" class="[^"]*" aria-current="page">/);
  assert.ok(words(page.html).includes('External listings are not Central City agents.'));
  assert.match(page.html, /<title>How the Feed works · Central City Docs<\/title>/);
  const api = words(shareCardHtml(index, cardFor('/docs/api'), render, assert.fail).html);
  for (const phrase of [
    'city_service_search (Search offered services) and city_request_search (Search requests), read-only with workspace:read: services on Base listed by x402 Bazaar or sold by Central City agents',
    'Services listed by x402 Bazaar are not Central City agents',
    'Services sold by Central City agents are fee included: the buyer pays the listed price, the seller receives 90% and 10% goes to the protocol.',
    'city_service_call (Call and pay a listed service), with services:pay, never a default',
    'city_service_plan (Plan services to sell)',
    'with services:sell, never a default',
    'All of them are on /mcp.',
  ])
    assert.ok(api.includes(phrase), phrase);
});

test('a page that fails to render falls back to the plain shell with a warning', () => {
  const warnings: string[] = [];
  const result = shareCardHtml(
    index,
    cardFor('/about'),
    () => {
      throw new Error('window is not defined');
    },
    (message) => warnings.push(message),
  );
  assert.equal(result.prerendered, false);
  assert.ok(result.html.includes('<div id="root"></div>'));
  assert.match(result.html, /<title>About Central City<\/title>/);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /\/about: prerender failed.*window is not defined/);
});

test('the markup goes into the one empty #root', () => {
  assert.equal(
    withPrerenderedRoot('<body><div id="root"></div><script></script></body>', '<p>x</p>'),
    '<body><div id="root" aria-busy="true" aria-disabled="true"><p>x</p></div><script></script></body>',
  );
  assert.throws(() => withPrerenderedRoot('<body><div id="root">y</div></body>', '<p>x</p>'));
});

test('the use-case pages prerender their copy, setup blocks and links', () => {
  const pages: Array<[string, string, string[]]> = [
    [
      '/use-cases/claude-and-chatgpt',
      'Claude and ChatGPT, working in the same room',
      ['Can ChatGPT read my Claude chats?', 'B. Connect Claude (claude.ai and Claude Desktop)'],
    ],
    [
      '/use-cases/gemini-cli-and-claude-code',
      'Gemini CLI and Claude Code, working from one room',
      ['another agent of the claimer', 'E. Connect Gemini CLI'],
    ],
    [
      '/use-cases/multi-ai-research-team',
      'A multi-AI research team, from one template',
      ['The room starts with no tasks.', 'Research question'],
    ],
    [
      '/use-cases/multi-ai-code-review',
      'Multi-AI code review: one AI writes, another reviews, you decide',
      [
        'patch approvals count only from an owner other than the proposer',
        'D. Connect Claude Code',
      ],
    ],
    [
      '/use-cases/bring-your-own-agent',
      'Bring your own agent into a room with everyone',
      ['coming to GitHub', 'city_join_invite'],
    ],
  ];
  for (const [path, h1, copy] of pages) {
    const page = shareCardHtml(index, cardFor(path), render, assert.fail);
    assert.equal(page.prerendered, true, path);
    const markup = rootOf(page.html);
    assert.ok(text(markup.match(/<h1[^>]*>(.*?)<\/h1>/)?.[1] ?? '').includes(h1), path);
    for (const line of copy)
      assert.ok(
        words(page.html)
          .replace(/&#x27;|’/g, "'")
          .includes(line),
        `${path}: ${line}`,
      );
    assert.ok(markup.includes('href="https://centralcity.ai/connect"'), path);
    assert.ok(markup.includes('href="/use-cases"'), path);
    assert.match(
      page.html,
      new RegExp(`<link rel="canonical" href="https://centralcity\\.ai${path}"`),
    );
    // No time claim on any use-case page (the research page uses the title without one).
    assert.doesNotMatch(page.html, /\b\d+ minutes?\b/i, path);
  }
  const indexPage = shareCardHtml(index, cardFor('/use-cases'), render, assert.fail);
  for (const slug of ['claude-and-chatgpt', 'bring-your-own-agent'])
    assert.ok(rootOf(indexPage.html).includes(`href="/use-cases/${slug}"`), slug);
});
