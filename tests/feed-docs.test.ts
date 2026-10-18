import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PUBLIC_DOCS, renderPublicDocs } from '../scripts/public-docs/build.js';
import { GUIDE_SLUGS } from '../scripts/public-docs/guides.js';
import { searchHelp } from '../server/elric/help.js';
import { HELP_INDEX } from '../server/elric/help-index.js';
import { guideHtml, guideMarkdown } from '../server/remote-mcp/guide.js';
import { ASSISTANT_TOOL_SCOPES } from '../server/assistant-access.js';
import { feedToolDescriptions } from '../server/feed/tools.js';
import { feedRequestToolDescriptions } from '../server/feed/request-tools.js';
import { feedPayToolDescriptions, serviceCallToolInput } from '../server/feed/pay/tool.js';
import { feedOfferToolDescriptions } from '../server/feed/offers/tools.js';
import { FEED_INSTRUCTIONS } from '../server/remote-mcp/tools.js';
import { FEED_TOOL_NOTICE } from '../shared/feed.js';
import { PAGE_TITLES } from '../shared/page-titles.js';
import { CLIENT_ROUTES, isClientRoute } from '../shared/routes.js';
import { PAGE_SOURCES } from '../shared/seo.js';
import { SHARE_CARDS } from '../shared/share-cards.js';
import { FeedHead } from '../src/feed/FeedParts.js';
import { fixture, fullFlow, mcpCall, ORIGIN, rpcResult } from './oauth-helpers.js';

/*
 * The Feed is documented where people and AIs look: /docs/feed (and /docs/feed.md, from
 * docs/FEED_GUIDE.md), llms.txt and llms-full.txt, the API reference, the /mcp guide page, the
 * signed-in MCP instructions, Elric's help and a link under the Feed's lede. Every place says the
 * same three things: Offered services are external, not Central City agents; Central City pays
 * none of them; the read API is public.
 */

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (path: string) => readFileSync(join(root, path), 'utf8');
/** Arrow characters and arrow-like quotes: none in the Feed or its docs. */
const ARROWS = /[\u2190-\u21ff\u2794-\u27bf\u2900-\u297f\u2b00-\u2bff\u00ab\u00bb\u2039\u203a]/;
const pages = renderPublicDocs(root);
const feedPage = pages.get('docs/feed.md') ?? '';

/** The line of `text` that names `needle` (one line per tool in the llms files). */
function lineWith(text: string, needle: string): string {
  const line = text.split('\n').find((each) => each.includes(needle));
  assert.ok(line, `no line with ${needle}`);
  return line;
}

/** CITY_FEED for one test (undefined: unset), put back after it. */
function withFeedFlag(t: { after: (fn: () => void) => void }, value: '1' | '0' | undefined) {
  const before = process.env.CITY_FEED;
  if (value === undefined) delete process.env.CITY_FEED;
  else process.env.CITY_FEED = value;
  t.after(() => {
    if (before === undefined) delete process.env.CITY_FEED;
    else process.env.CITY_FEED = before;
  });
}

test('/docs/feed: a public guide page (HTML and Markdown) with its route, title, card and sitemap source', () => {
  const doc = PUBLIC_DOCS.find((entry) => entry.slug === 'feed');
  assert.ok(doc, 'feed is a public doc');
  assert.equal(doc.source, 'FEED_GUIDE.md');
  assert.equal(doc.title, 'How the Feed works');
  assert.ok((GUIDE_SLUGS as readonly string[]).includes('feed'), 'and has an HTML page');
  assert.ok(CLIENT_ROUTES.some((route) => route.path === '/docs/feed'));
  assert.ok(isClientRoute('/docs/feed'));
  assert.equal(PAGE_TITLES['/docs/feed'], 'How the Feed works · Central City Docs');
  assert.deepEqual(PAGE_SOURCES['/docs/feed'], ['docs/FEED_GUIDE.md']);
  const card = SHARE_CARDS.find((each) => each.path === '/docs/feed');
  assert.equal(card?.description, doc.summary);
  const vercel = JSON.parse(read('vercel.json')) as {
    rewrites: Array<{ source: string; destination: string }>;
    headers: Array<{ source: string; headers: Array<{ key: string; value: string }> }>;
  };
  assert.ok(
    vercel.rewrites.some(
      (rule) => rule.source === '/docs/feed' && rule.destination === '/share/docs/feed.html',
    ),
  );
  assert.equal(
    vercel.headers
      .find((rule) => rule.source === '/docs/feed')
      ?.headers.find((header) => header.key === 'Link')?.value,
    '</docs/feed.md>; rel="alternate"; type="text/markdown"',
  );
});

test('/docs/feed says what the Feed is, how a service is used today, how to post, and the read API', () => {
  assert.match(feedPage, /^# How the Feed works\n/);
  for (const heading of [
    'Offered',
    'Use a service',
    'Searched for',
    'Post a request',
    'Reply handles',
    'Your private link',
    'For AIs and developers',
  ])
    assert.ok(feedPage.includes(`\n## ${heading}\n`), heading);
  const flat = feedPage.replace(/\s+/g, ' ');
  for (const fact of [
    // Offered: both sources are identified; spending requires confirmation.
    'after you confirm what it pays. Central City never pays from its own money. Without it, nothing is paid through the Feed.',
    'Request budgets are information only.',
    'listed by **x402 Bazaar**',
    '**External listings are not Central City agents.**',
    '**Central City agents sell built-in services.**',
    'agent-to-agent Pay cannot pay them.',
    // Use with my agent where it is on: price first, one confirm, the agent's own wallet.
    'You see the amount, the agent and the service, then confirm once.',
    'The agent pays from its own wallet, within its spending limit and its per-call maximum',
    // Central City's fee, where it applies: shown before the confirm, the limits count the total.
    'Before you confirm you see three lines, the price, the Central City fee and the total',
    'An included payment splits seller proceeds and fee in one transaction; external payments can have separate service and fee transactions.',
    // Without Use with my agent (named, so it never reads as "without the fee"): the caller's own
    // x402 client and Base USDC wallet, outside Central City.
    'Without **Use with my agent**, a service is used outside Central City:',
    'its own x402 client and its own Base USDC wallet',
    "confirm with the wallet's owner before paying",
    // Searched for: posting, reply handles and the private link.
    'Posting on the web needs a Central City account today.',
    // A request posted without an account is shown as unverified, never as an account's.
    'Requests posted without an account are marked unverified.',
    // Held requests: nothing releases them yet, so the page says what happens (the sweep deletes
    // them after 7 days), and a hidden request is not promised a check.
    "Some requests are held for review and aren't listed.",
    'A request still in review after 7 days is deleted.',
    'Enough reports hide it from the lists.',
    // Signed out the Feed is read-only: browsing needs no account, the actions do.
    'Signed out, you can browse both lists',
    'Signing in is needed to respond to a request, report one or post your own.',
    'a Base address or an https link',
    'Without one, nobody can reach you.',
    'private link',
    'Anyone with the link can close it',
    // The public read API and the MCP tool.
    '`GET https://centralcity.ai/api/public/feed/services`',
    '`GET https://centralcity.ai/api/public/feed/services/<id>`',
    '`GET https://centralcity.ai/api/public/feed/requests`',
    '`GET https://centralcity.ai/api/public/feed/requests/<id>`',
    '`city_service_search`',
    'scope `workspace:read`, read-only',
    // The live Feed tools: the request search and the paid call (never a default scope).
    '`city_request_search` reads the open requests of Searched for',
    '`city_service_call` (scope `services:pay`, never a default)',
    // Anyone can post a request over HTTP, AIs included: the page says only what is missing.
    "Posting through the API isn't documented yet.",
  ])
    assert.ok(flat.includes(fact), fact);
  // Never that AIs can't post (the public route takes anonymous posts), and never that a held
  // request shows later (nothing moves it to open; the sweep deletes it).
  assert.doesNotMatch(flat, /can't post/i);
  assert.doesNotMatch(flat, /held for review before they show|don't show yet|until it is checked/);
  // Feed pay is live for every account: no "where it is on for you" wording.
  assert.doesNotMatch(flat, /is on for (?:you|the owner)|Feed pay is on|has Feed pay on/);
  // Posting is never documented as an API (it may change), and no arrows anywhere.
  assert.doesNotMatch(feedPage, /POST [^\n]*\/api\/public\/feed/);
  assert.equal(ARROWS.exec(feedPage)?.[0] ?? null, null);
  // Listed in the docs index.
  assert.ok(pages.get('docs-index.md')?.includes('(https://centralcity.ai/docs/feed.md)'));
});

test('llms.txt and llms-full.txt: one city_service_search line each, and the Feed page', () => {
  for (const file of ['public/llms.txt', 'public/llms-full.txt']) {
    const text = read(file);
    const line = lineWith(text, '`city_service_search`');
    assert.match(line, /`workspace:read`/, file);
    assert.match(line, /read-only/, file);
    assert.match(line, /not Central City agents/, file);
    assert.match(line, /Pay refuses them/, file);
    assert.match(line, /own x402 client and Base USDC wallet, outside Central City/, file);
    assert.match(line, /`GET \/api\/public\/feed\/services`/, file);
    assert.match(line, /`GET \/api\/public\/feed\/requests`/, file);
    assert.ok(text.includes('https://centralcity.ai/docs/feed.md'), file);
    assert.equal(ARROWS.exec(line)?.[0] ?? null, null, file);
  }
});

test('the API reference lists city_service_search with its scope and the external-service rule', () => {
  const row = lineWith(read('docs/REMOTE_MCP.md'), '| `city_service_search` |');
  assert.match(row, /^\| `city_service_search` \| `workspace:read` \|/);
  // Pay, the name people read (as in the guide and llms.txt): never the flagged tool's name.
  assert.match(row, /not Central City agents: Pay refuses them/);
  assert.doesNotMatch(row, /city_pay/);
  assert.match(row, /`readOnlyHint`/);
  // And on the public page, with the link to the Feed guide.
  const api = pages.get('docs/api.md') ?? '';
  assert.match(lineWith(api, '| `city_service_search` |'), /\(\/docs\/feed\.md\)/);
  assert.doesNotMatch(lineWith(api, '| `city_service_search` |'), /city_pay/);
  // Elric's copy of the reference too.
  const help = HELP_INDEX.map((section) => section.text).join('\n');
  assert.match(
    lineWith(help, '| `city_service_search` |'),
    /not Central City agents: Pay refuses them/,
  );
  assert.doesNotMatch(lineWith(help, '| `city_service_search` |'), /city_pay/);
  // The tool's own description and its notice say Pay too.
  for (const text of [feedToolDescriptions.city_service_search.description, FEED_TOOL_NOTICE]) {
    assert.match(text, /not Central City agents: Pay refuses them/);
    assert.doesNotMatch(text, /city_pay/);
  }
  // The /docs/api tool list for people.
  const docsPage = read('src/docs/DocsPages.tsx');
  assert.match(docsPage, /<dt>Feed<\/dt>\s*<dd>\s*<Tool>city_service_search<\/Tool>/);
  assert.match(docsPage, /<a href="\/docs\/feed">How the Feed works<\/a>/);
});

test('the /docs/api tool list names every Feed tool with the title and scope the server registers', () => {
  const block = /<dt>Feed<\/dt>\s*<dd>([\s\S]*?)<\/dd>/.exec(read('src/docs/DocsPages.tsx'))?.[1];
  assert.ok(block, 'the Feed entry of the /docs/api tool list');
  const flat = block.replace(/\{' '\}/g, ' ').replace(/\s+/g, ' ');
  const remote = read('docs/REMOTE_MCP.md');
  const registered = {
    ...feedToolDescriptions,
    ...feedRequestToolDescriptions,
    ...feedPayToolDescriptions,
    ...feedOfferToolDescriptions,
  };
  assert.deepEqual(Object.keys(registered).sort(), [
    'city_request_search',
    'city_service_call',
    'city_service_mine',
    'city_service_pause',
    'city_service_plan',
    'city_service_publish',
    'city_service_search',
    'city_service_update',
  ]);
  for (const [name, { title }] of Object.entries(registered)) {
    const scope = ASSISTANT_TOOL_SCOPES[name as keyof typeof ASSISTANT_TOOL_SCOPES];
    assert.ok(flat.includes(`<Tool>${name}</Tool> (${title})`), `${name}: "${title}"`);
    assert.ok(flat.includes(`<code>${scope}</code>`), `${name}: ${scope}`);
    // The same scope as its row in the reference for AIs.
    assert.ok(lineWith(remote, `| \`${name}\` |`).includes(`| \`${scope}\` |`), name);
  }
  // The one Feed tool that pays says how: never a default, the owner's consent with services in
  // the Feed included, the owner's limits, the fee on top of the price, and that the limits count
  // the total (as its row in docs/REMOTE_MCP.md).
  assert.match(flat, /<code>services:pay<\/code>, never a default: it pays a listed service/);
  assert.match(
    flat,
    /only for an agent whose owner allowed it to pay on its own with services in the Feed included \(a consent to pay Central City agents only is not enough: the owner confirms again to include them\)/,
  );
  assert.match(flat, /within the owner’s spending limit and the agent’s per-call maximum\./);
  assert.match(
    flat,
    /For external services where Central City’s fee applies, the agent also pays 10% of the service’s price on top; the spending limit and the per-call maximum count the total, fee included\. Payments can’t be undone\./,
  );
  assert.doesNotMatch(flat, /plus Central City’s 10% fee/);
});

test('every public description of city_service_call names the fee on top and what max_price_usdc bounds', () => {
  const api = pages.get('docs/api.md') ?? '';
  const help = HELP_INDEX.map((section) => section.text).join('\n');
  const rows = [
    lineWith(read('docs/REMOTE_MCP.md'), '| `city_service_call` |'),
    lineWith(api, '| `city_service_call` |'),
    lineWith(help, '| `city_service_call` |'),
  ];
  for (const row of rows) {
    // An earlier consent to pay Central City agents only never pays a Feed service.
    assert.match(
      row,
      /only for an agent whose owner allowed it to pay on its own with services in the Feed included \(a consent to pay Central City agents only is not enough: it is refused with `no_consent` until the owner confirms again to include them\)/,
    );
    assert.match(row, /For external services, the agent also pays 10% of the price on top\./);
    assert.match(
      row,
      /`max_price_usdc` bounds the price; the spending limit and the per-call maximum count the total, fee included\./,
    );
  }
  // The tool's own description and its max_price_usdc field, which an AI reads before paying.
  const description = feedPayToolDescriptions.city_service_call.description;
  assert.match(description, /max_price_usdc is the most the service's price may be\./);
  assert.match(description, /the agent also pays 10% of the price on top/);
  assert.doesNotMatch(description, /most this call may cost/);
  const field = serviceCallToolInput.shape.max_price_usdc.description ?? '';
  assert.match(field, /The most the service's price may be/);
  assert.match(field, /10% of the price on top/);
  // The Feed guide's line for AIs and llms-full.txt say the same.
  const flat = (pages.get('docs/feed.md') ?? '').replace(/\s+/g, ' ');
  assert.ok(
    flat.includes(
      "Where Central City's fee applies, the agent also pays 10% of the price on top, and these limits count the total.",
    ),
  );
  assert.match(
    lineWith(read('public/llms-full.txt'), '`city_service_search`'),
    /For external services, the agent also pays 10% of the price on top, and these limits count the total\./,
  );
});

test('the /mcp guide page names the Feed search and links its docs while the Feed is on; the /mcp/open guide never does', () => {
  const signedIn = guideMarkdown(ORIGIN, false, true);
  const line = lineWith(signedIn, '**Feed:**');
  assert.ok(line.includes(`<${ORIGIN}/docs/feed.md>`));
  assert.match(line, /city_service_search \(scope workspace:read, read-only\)/);
  assert.match(line, /They are not Central City agents, and Pay refuses them\./);
  assert.ok(guideHtml(ORIGIN, false, true).includes(`href="${ORIGIN}/docs/feed.md"`));
  // CITY_FEED off: the tool is not listed, so the guide leaves it out.
  for (const page of [guideMarkdown(ORIGIN, false, false), guideHtml(ORIGIN, false, false)]) {
    assert.ok(!page.includes('city_service_search'));
    assert.ok(!page.includes('/docs/feed.md'));
  }
  // The tool is never on the no-account endpoint, so its guide leaves it out, flag or not.
  for (const feed of [true, false]) {
    assert.ok(!guideMarkdown(ORIGIN, true, feed).includes('city_service_search'));
    assert.ok(!guideHtml(ORIGIN, true, feed).includes('/docs/feed.md'));
  }
});

test('GET /mcp: the guide follows CITY_FEED per request', async (t) => {
  const { app } = await fixture(t);
  const guide = async (url: string) => {
    const res = await app.inject({ method: 'GET', url, headers: { accept: 'text/markdown' } });
    assert.equal(res.statusCode, 200, res.body);
    return res.body;
  };
  withFeedFlag(t, '1');
  assert.ok((await guide('/mcp')).includes('/docs/feed.md'));
  assert.ok(!(await guide('/mcp/open')).includes('city_service_search'));
  process.env.CITY_FEED = '0';
  assert.ok(!(await guide('/mcp')).includes('city_service_search'));
  assert.ok(!(await guide('/mcp')).includes('/docs/feed.md'));
  // Unset: live by default.
  delete process.env.CITY_FEED;
  assert.ok((await guide('/mcp')).includes('/docs/feed.md'));
});

test('the signed-in MCP instructions name the Feed search only while CITY_FEED is on, and never city_pay', async (t) => {
  const { app } = await fixture(t);
  const { tokens } = await fullFlow(app, { scope: 'workspace:read', scopes: [] });
  const session = async () => {
    const res = await mcpCall(app, tokens.access_token, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'feed-docs-test', version: '1.0.0' },
    });
    assert.equal(res.statusCode, 200, res.body);
    const list = await mcpCall(app, tokens.access_token, 'tools/list');
    assert.equal(list.statusCode, 200, list.body);
    return {
      instructions: String(rpcResult(res.body).result.instructions),
      tools: (rpcResult(list.body).result.tools as Array<{ name: string }>).map(
        (tool) => tool.name,
      ),
    };
  };
  assert.equal(
    FEED_INSTRUCTIONS,
    " city_service_search searches the Feed for external x402 services on Base: they are not Central City agents and Pay refuses them; calling one needs the caller's own x402 client and Base USDC wallet, outside Central City, so confirm with your owner before paying. Services that Central City agents sell are listed there too (source Central City), fee included: the seller receives 90% and 10% goes to the protocol; with the services:sell scope, city_service_plan and city_service_publish list your own agents' services.",
  );
  // Feed pay switched off for this test: its own sentence is FEED_INSTRUCTIONS_WITH_PAY
  // (tests/feed-pay-app.test.ts).
  const payBefore = process.env.CITY_FEED_PAY;
  process.env.CITY_FEED_PAY = '0';
  t.after(() => {
    if (payBefore === undefined) delete process.env.CITY_FEED_PAY;
    else process.env.CITY_FEED_PAY = payBefore;
  });
  for (const value of ['1', undefined]) {
    withFeedFlag(t, value as '1' | undefined);
    const on = await session();
    assert.match(on.instructions, /^Central City tools act on one workspace/);
    assert.ok(on.instructions.endsWith(FEED_INSTRUCTIONS), on.instructions);
    assert.ok(on.tools.includes('city_service_search'));
    assert.doesNotMatch(on.instructions, /city_pay/);
  }
  process.env.CITY_FEED = '0';
  const off = await session();
  assert.match(off.instructions, /^Central City tools act on one workspace/);
  assert.ok(!off.instructions.includes('city_service_search'), off.instructions);
  assert.ok(!off.tools.includes('city_service_search'));
  assert.doesNotMatch(off.instructions, /city_pay/);
});

test("Elric's help finds the Feed guide", () => {
  assert.ok(HELP_INDEX.some((section) => section.slug === 'feed'));
  // Elric repeats the page as published: no "AIs can't post", no held request that shows later.
  const feedHelp = HELP_INDEX.filter((section) => section.slug === 'feed')
    .map((section) => section.text.replace(/\s+/g, ' '))
    .join(' ');
  assert.ok(feedHelp.includes('Requests posted without an account are marked unverified.'));
  assert.ok(feedHelp.includes("Some requests are held for review and aren't listed."));
  assert.ok(feedHelp.includes('A request still in review after 7 days is deleted.'));
  assert.ok(feedHelp.includes("Posting through the API isn't documented yet."));
  assert.doesNotMatch(feedHelp, /no MCP tool for Feed requests|Feed pay is on for/);
  assert.doesNotMatch(feedHelp, /can't post|before they show|don't show yet|until it is checked/);
  const found = searchHelp('How do I use a service from the Feed?');
  assert.equal(found.results[0]?.url, 'https://centralcity.ai/docs/feed.md');
  const post = searchHelp('How do I post a request on the Feed?');
  assert.ok(post.results.some((result) => result.url === 'https://centralcity.ai/docs/feed.md'));
});

test('the Feed head links "How the Feed works" under the lede, with no arrow', () => {
  const html = renderToStaticMarkup(createElement(FeedHead));
  assert.match(
    html,
    /<p class="fd-lede">[^<]*<\/p><p class="fd-howto"><a class="fd-link" href="\/docs\/feed">How the Feed works<\/a><\/p>/,
  );
  assert.equal(ARROWS.exec(html)?.[0] ?? null, null);
});
