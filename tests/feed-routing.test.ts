import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { CLIENT_ROUTES, shellFor } from '../shared/routes.js';
import { PUBLIC_PATHS, sitemapXml } from '../shared/seo.js';
import { FEED_FLAG } from '../shared/feed.js';
import { SHARE_CARDS, shareCardLive, SITE } from '../shared/share-cards.js';
import { captureManageCode, forgetFeedSession, signedOutManageId } from '../src/feed/feedPaths.js';
import {
  FEED_TITLE,
  feedSignInContext,
  SIGN_IN_LABEL,
  signInActionOf,
} from '../src/feed/feedSignIn.js';
import { loadFeedGate, resetFeedGate } from '../src/feed/feedStatus.js';

/*
 * Signed out on a Feed address, and a Feed that can't be loaded (src/Root.tsx): the sign-in
 * card's line and tab title for a shared link, the /feed link preview, and the gate's 429.
 * Made-up ids only.
 */

const root = fileURLToPath(new URL('..', import.meta.url));

test('signed out the Feed is read-only: each action names itself on the sign-in card', () => {
  const title = 'Feed · Central City';
  const reading = ['/feed', '/feed/', '/feed/requests', '/feed/requests/req_abcdefghijklmnopqrst'];
  for (const path of [...reading, '/feed/services/svc_abcdefghijklmnopqrst']) {
    assert.deepEqual(
      feedSignInContext(path, 'respond'),
      { line: 'Sign in to respond to this request.', title },
      path,
    );
    assert.deepEqual(feedSignInContext(path, 'report'), {
      line: 'Sign in to report this request.',
      title,
    });
    assert.deepEqual(feedSignInContext(path, 'post'), {
      line: 'Sign in or create a free account to post your request.',
      title,
    });
  }
  // A lapsed session on a service's drawer (Feed pay): Sign in to use it.
  assert.deepEqual(feedSignInContext('/feed/services/svc_abcdefghijklmnopqrst', 'use'), {
    line: 'Sign in to use this service with your agent.',
    title,
  });
  // The pages that ask before showing anything: the private page without its code, a paid call.
  assert.deepEqual(feedSignInContext('/feed/requests/req_abcdefghijklmnopqrst/manage'), {
    line: 'Sign in to close your request.',
    title,
  });
  assert.deepEqual(feedSignInContext('/feed/calls/fc_abcdefghijklmnopqrst'), {
    line: 'Sign in to see this call.',
    title,
  });
  assert.deepEqual(SIGN_IN_LABEL, {
    respond: 'Sign in to respond',
    report: 'Sign in to report',
    post: 'Sign in to post',
    use: 'Sign in to use it',
  });
  assert.equal(signInActionOf({ feedSignIn: 'use' }), 'use');
  // The action rides in the history entry: Back (an entry without it) is the read-only page.
  assert.equal(signInActionOf({ feedSignIn: 'post', feedList: '/feed' }), 'post');
  assert.equal(signInActionOf({ feedSignIn: 'pay' }), null);
  assert.equal(signInActionOf(null), null);
  assert.equal(signInActionOf({ feedList: '/feed' }), null);
  // Anywhere else the card keeps its own line.
  for (const path of ['/signin', '/rooms', '/feedx', '/feed/offered', '/feed/services'])
    assert.equal(feedSignInContext(path, 'post'), null, path);
  // Short plain copy: no arrows, no codes.
  for (const line of [
    ...Object.values(SIGN_IN_LABEL),
    feedSignInContext('/feed', 'post')!.line,
    feedSignInContext('/feed', 'respond')!.line,
  ])
    assert.doesNotMatch(line, /[←-⇿›»{}]/);
});

test('signed out, only a close link that still holds its code skips the sign-in', () => {
  const globals = globalThis as { window?: unknown };
  const before = globals.window;
  globals.window = { history: { state: null, replaceState: () => undefined } };
  const id = 'req_abcdefghijklmnopqrst';
  const manage = `/feed/requests/${id}/manage`;
  const open = (hash: string) =>
    captureManageCode({ pathname: manage, hash, search: '' } as Location);
  try {
    forgetFeedSession();
    // Reloaded, or copied from the address bar once the code left it: sign-in comes first.
    assert.equal(signedOutManageId(manage), null);
    open('#not-a-code');
    assert.equal(signedOutManageId(manage), null);
    open('#ccf_made-up-code-0001');
    assert.equal(signedOutManageId(manage), id);
    assert.equal(signedOutManageId(`${manage}/`), id);
    // That request's close page only.
    for (const path of [
      '/feed/requests/req_tsrqponmlkjihgfedcba/manage',
      `/feed/requests/${id}`,
      '/feed/requests',
      '/feed',
      '/rooms',
    ])
      assert.equal(signedOutManageId(path), null, path);
    // Gone with the session's memory (sign-in as another account, sign-out).
    forgetFeedSession();
    assert.equal(signedOutManageId(manage), null);
  } finally {
    globals.window = before;
    forgetFeedSession();
  }
});

test('/feed has its own link preview and tab title, and stays out of search', () => {
  const card = SHARE_CARDS.find((entry) => entry.path === '/feed');
  assert.ok(card, 'a share card for /feed');
  assert.equal(card.title, FEED_TITLE);
  assert.equal(card.shell, 'share/feed.html');
  assert.equal(card.canonical, `${SITE}/feed`);
  assert.equal(card.indexed, false);
  assert.ok(card.description.length >= 40 && card.description.length <= 170);
  assert.doesNotMatch(card.description, /Central City agent/i);
  // Served for /feed by both the local server and Vercel; the other Feed addresses keep app.html.
  assert.equal(shellFor('/feed'), 'share/feed.html');
  assert.equal(CLIENT_ROUTES.find((route) => route.path === '/feed')?.shell, '/share/feed.html');
  assert.equal(shellFor('/feed/requests/:id'), 'app.html');
  const vercel = JSON.parse(readFileSync(join(root, 'vercel.json'), 'utf8')) as {
    rewrites: Array<{ source: string; destination: string }>;
  };
  assert.equal(
    vercel.rewrites.find((rewrite) => rewrite.source === '/feed')?.destination,
    '/share/feed.html',
  );
  // A paid call's page (Feed pay, the MCP detail_url) loads directly too: reload, shared link.
  assert.equal(shellFor('/feed/calls/:id'), 'app.html');
  assert.ok(CLIENT_ROUTES.some((route) => route.path === '/feed/calls/:id'));
  assert.equal(
    vercel.rewrites.find((rewrite) => rewrite.source === '/feed/calls/([A-Za-z0-9_-]{1,64})')
      ?.destination,
    '/app.html',
  );
  // A signed-in page: never in the sitemap (vercel.json sends it noindex).
  assert.ok(!PUBLIC_PATHS.includes('/feed'));
  // (/docs/feed, the Feed guide, is a public page and listed.)
  assert.ok(!sitemapXml(null).includes(`<loc>${SITE}/feed`));
  // Every other card is still a public page.
  for (const entry of SHARE_CARDS.filter((each) => each.path !== '/feed'))
    assert.equal(entry.indexed, true, entry.path);
});

test('the /feed card is built only while the Feed is on; off, /feed gets the plain app shell', () => {
  const card = SHARE_CARDS.find((entry) => entry.path === '/feed')!;
  assert.equal(card.flag, FEED_FLAG);
  // Off only with exactly '0', like the server's switch (server/feed/flag.ts): live by default.
  assert.equal(shareCardLive(card, { [FEED_FLAG]: '0' }), false);
  for (const value of [undefined, '', '1', 'true', '1 ', 'on', ' 0'])
    assert.equal(shareCardLive(card, { [FEED_FLAG]: value }), true, String(value));
  assert.equal(shareCardLive(card, {}), true);
  // Every other card is always built: no other page is behind a switch.
  for (const entry of SHARE_CARDS.filter((each) => each.path !== '/feed')) {
    assert.equal(entry.flag, null, entry.path);
    assert.equal(shareCardLive(entry, {}), true, entry.path);
  }
  // The build reads the switch from its own environment and, off, writes the plain shell (the
  // same source as app.html) at the card's file, so the vercel.json rewrite still has a target.
  const vite = readFileSync(join(root, 'vite.config.ts'), 'utf8');
  assert.match(
    vite,
    /if \(!shareCardLive\(card, process\.env\)\) \{\s*this\.emitFile\(\{ type: 'asset', fileName: card\.shell, source: html \}\);\s*continue;/,
  );
  assert.match(vite, /fileName: APP_SHELL\.slice\(1\), source: html \}/);
  // The plain shell does not name the Feed anywhere a crawler or a link preview reads.
  assert.doesNotMatch(readFileSync(join(root, 'index.html'), 'utf8'), /Feed/);
});

test('a 429 from the Feed’s status is too many tries, not a Feed that is down', async () => {
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  resetFeedGate();
  let asked = 0;
  const limited = async () => {
    asked += 1;
    return json(429, { error: 'Too many requests.' });
  };
  assert.deepEqual(await loadFeedGate({ fetcher: limited, retryMs: [0, 0] }), {
    phase: 'error',
    limited: true,
  });
  // Asked once: this address was just told to wait, so no retry follows.
  assert.equal(asked, 1);
  // Anything else that fails is the plain error, asked again before the page says so.
  resetFeedGate();
  let failed = 0;
  const down = async () => {
    failed += 1;
    return json(503, {});
  };
  assert.deepEqual(await loadFeedGate({ fetcher: down, retryMs: [0, 0] }), { phase: 'error' });
  assert.equal(failed, 3);
  // A failure then a 429: the asking stops there, and the page says to wait.
  resetFeedGate();
  let calls = 0;
  const limitedLater = async () =>
    ++calls === 1 ? json(503, {}) : json(429, { error: 'Too many requests.' });
  assert.deepEqual(await loadFeedGate({ fetcher: limitedLater, retryMs: [0, 0] }), {
    phase: 'error',
    limited: true,
  });
  assert.equal(calls, 2);
  resetFeedGate();
});
