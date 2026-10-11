/**
 * The single table of client-side (SPA) paths (DESIGN_SYSTEM §3, decisions D3/E7, item O3).
 *
 * - server/index.ts serves the app shell for exactly these paths and a real 404 for anything else.
 * - vercel.json has one explicit rewrite per entry (`vercelSource`) to its `shell` (/app.html,
 *   the plain shell, or a share-card copy of it, shared/share-cards.ts); unmatched
 *   paths get public/404.html with status 404. tests/routes.test.ts keeps the two in parity.
 * - The SPA router should import `isClientRoute` too, so all three agree.
 *
 * Retired client paths are not routes: CLIENT_REDIRECTS (below) moves them for good.
 *
 * Server-owned paths are deliberately absent and keep their own vercel.json rewrites: /api,
 * /mcp, /oauth, /.well-known, /a2a and /j (the join-link page, whose code must never reach a
 * query string or the SPA). "/" is served as the static index.html, which carries the prerendered
 * landing (shared/share-cards.ts homeHtml), and needs no rewrite.
 */

import { SHARE_CARDS } from './share-cards.js';
import { USE_CASES, USE_CASES_INDEX, useCasePath } from './use-cases.js';

/** The plain app shell (the built index.html before the landing is prerendered into it). */
export const APP_SHELL = '/app.html';

/** One path segment: letters, digits, `_` and `-`, up to 64 characters (no dots, so no files). */
const SEGMENT = '[A-Za-z0-9_-]{1,64}';

export interface ClientRoute {
  /** Documentation form, e.g. `/rooms/:id`. */
  readonly path: string;
  /** The vercel.json rewrite source (path-to-regexp, unnamed groups for parameters). */
  readonly vercelSource: string;
  /** The HTML served for the path: `/app.html`, or a route's own share-card copy of it. */
  readonly shell: string;
}

function route(path: string): ClientRoute {
  if (!/^(?:\/(?:[a-z][a-z0-9-]*|:[a-z]+))+$/.test(path)) throw new Error(`Bad route: ${path}`);
  const card = SHARE_CARDS.find((entry) => entry.path === path);
  return Object.freeze({
    path,
    vercelSource: path.replace(/:[a-z]+/g, `(${SEGMENT})`),
    shell: card ? `/${card.shell}` : APP_SHELL,
  });
}

/** Every client path except "/", in the order of DESIGN_SYSTEM §3. */
export const CLIENT_ROUTES: readonly ClientRoute[] = Object.freeze([
  route('/about'),
  route('/signin'),
  route('/invite'),
  // Legacy path still served by the current SPA; `/#connect` and `/connect` move to /invite (E6).
  route('/connect'),
  route('/workflows'),
  route('/r/:slug'),
  route('/rooms'),
  route('/rooms/:id'),
  route('/agents'),
  route('/agents/:id'),
  // The console's Messages view (opened at "/", like /agents and /settings).
  route('/messages'),
  route('/elric'),
  // Result permalinks: the same shell for every id; nothing is revealed signed out (A6).
  route('/results/:id'),
  route('/settings'),
  route('/settings/:tab'),
  // The newsletter email links (docs/EMAIL.md), public, no session, never indexed.
  route('/newsletter/confirm'),
  route('/newsletter/unsubscribe'),
  route('/downtown'),
  // Trust pages (DESIGN_SYSTEM §2.2 Trust column), public, no session.
  route('/privacy'),
  route('/terms'),
  route('/security'),
  route('/support'),
  // Footer pages: help, policies and company, public, no session.
  route('/status'),
  route('/privacy-choices'),
  route('/acceptable-use'),
  route('/dpa'),
  route('/imprint'),
  route('/contact'),
  // The verifiable agent count ("Verify here" on the homepage ticker).
  route('/downtown/verify'),
  // The Live log: the count log's entries, newest first.
  route('/downtown/log'),
  // The Agent Explorer's short address (the same page as /downtown/log).
  route('/explorer'),
  // The Agent Explorer's On Base view: the agents with a Base ID, read from Base.
  route('/explorer/base'),
  // The docs site.
  route('/docs'),
  route('/docs/start'),
  route('/docs/rooms'),
  route('/docs/room-management'),
  route('/docs/coding'),
  route('/docs/microsoft-copilot'),
  route('/docs/mistral-le-chat'),
  route('/docs/api'),
  // The use-case pages (shared/use-cases.ts).
  route(USE_CASES_INDEX.path),
  ...USE_CASES.map((entry) => route(useCasePath(entry.slug))),
]);

const MATCHERS = CLIENT_ROUTES.map(
  (entry) => new RegExp(`^${entry.path.replace(/:[a-z]+/g, SEGMENT)}$`),
);

/**
 * True when `pathname` (no query or fragment) is a client route. Matching is exact, like
 * Vercel's: a trailing slash is a different path, which TRAILING_SLASH_REDIRECT sends to the path
 * without it (see tests/routes.test.ts).
 */
export function isClientRoute(pathname: string): boolean {
  if (pathname === '/') return true;
  return MATCHERS.some((matcher) => matcher.test(pathname));
}

/** The HTML file (relative to the output root) to serve for a client route. */
export function shellFor(pathname: string): string {
  if (pathname === '/') return 'index.html';
  const entry = CLIENT_ROUTES.find((item) => item.path === pathname);
  return (entry?.shell ?? APP_SHELL).slice(1);
}

/**
 * `/path/` → `/path` (308, the query string kept) for every non-root path that is not
 * server-owned. vercel.json has this exact rule (`redirects`); server/index.ts applies
 * `withoutTrailingSlash` for local and e2e parity.
 *
 * - Server-owned prefixes (/api, /mcp, /oauth, /.well-known, /a2a, /j) are never redirected: their
 *   paths stay exactly as clients send them.
 * - Files (a last segment with a dot, e.g. /docs/room-tasks.md) are never redirected.
 * - The path must start with a letter or digit and have no empty segments, so the target can never
 *   be `//host` or `/\host` (no open redirect). "/" is not matched.
 */
const SERVER_OWNED = '(?:api|mcp|oauth|\\.well-known|a2a|j)(?:/|$)';
// One segment starting with a letter or digit, then more segments; the last has no dot. Only
// lookaheads and non-capturing groups, which both vercel.json (path-to-regexp) and JS accept.
const REDIRECTABLE = `(?!${SERVER_OWNED})[A-Za-z0-9](?:[^/.]*|[^/]*(?:/[^/]+)*/[^/.]+)`;

export const TRAILING_SLASH_REDIRECT = Object.freeze({
  source: `/:path(${REDIRECTABLE})/`,
  destination: '/:path',
  permanent: true,
});

const TRAILING = new RegExp(`^/(${REDIRECTABLE})/$`);

/** The redirect target for `pathname` (no query), or null when it keeps its path. */
export function withoutTrailingSlash(pathname: string): string | null {
  const match = TRAILING.exec(pathname);
  return match ? `/${match[1]}` : null;
}

/**
 * Retired client paths that move for good (301): vercel.json has one `redirects` entry per item,
 * after the trailing-slash rule, and server/index.ts applies `movedPath` for local and e2e
 * parity (tests/routes.test.ts).
 *
 * - /how → the landing's "How it works" section (/#how).
 * - /answers → the docs.
 */
export const CLIENT_REDIRECTS = Object.freeze([
  Object.freeze({ source: '/how', destination: '/#how', statusCode: 301 as const }),
  Object.freeze({ source: '/answers', destination: '/docs', statusCode: 301 as const }),
]);

/**
 * The redirect target for `url` (a path with an optional query), or null when it is not a
 * retired path. The query is kept, before the target's fragment (`/how?x=1` → `/?x=1#how`).
 */
export function movedPath(url: string): string | null {
  const [path, ...rest] = url.split('?');
  const entry = CLIENT_REDIRECTS.find((item) => item.source === path);
  if (!entry) return null;
  if (!rest.length) return entry.destination;
  const [target, fragment] = entry.destination.split('#');
  return `${target}?${rest.join('?')}${fragment === undefined ? '' : `#${fragment}`}`;
}
