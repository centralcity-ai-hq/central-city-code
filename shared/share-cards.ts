/**
 * Per-route page heads: what a crawler sees in a public page's first HTML.
 *
 * Crawlers and link previews do not (all) run JavaScript, so each route here gets its own copy of
 * the built index.html with its own <title>, meta description, canonical link and link preview
 * (Open Graph / Twitter) swapped in (vite.config.ts writes `shell`). vercel.json and
 * server/index.ts serve that copy for the route (shared/routes.ts `shell`). "/" is index.html
 * itself; app routes (rooms, settings, …) keep index.html and are not indexed.
 */

import { liveUnlessOff } from './protocol.js';
import { USE_CASES, USE_CASES_INDEX, useCasePath } from './use-cases.js';

export const SITE = 'https://centralcity.ai';

export interface ShareCard {
  /** The client route, e.g. `/elric`. */
  readonly path: string;
  /** The built HTML file served for the route, relative to the output root. */
  readonly shell: string;
  /** The page title (tab and search result) and the link preview title. */
  readonly title: string;
  /** The meta description (search snippet) and the link preview text. */
  readonly description: string;
  /** The page's own address; another route when two paths show the same page. */
  readonly canonical: string;
  readonly image: string;
  readonly imageAlt: string;
  /**
   * False for an app page that has a card only for its link preview and tab title (the Feed):
   * it is never in the sitemap, and vercel.json sends it noindex.
   */
  readonly indexed: boolean;
  /**
   * The emergency off the page is behind, read from the build's environment (shareCardLive): the
   * Feed's CITY_FEED (shared/feed.ts FEED_FLAG). Null for a page that is always there.
   */
  readonly flag: string | null;
}

function card(
  path: string,
  title: string,
  description: string,
  options: {
    image?: string;
    imageAlt?: string;
    canonical?: string;
    indexed?: boolean;
    flag?: string;
  } = {},
): ShareCard {
  return Object.freeze({
    path,
    shell: `share${path}.html`,
    title,
    description,
    canonical: `${SITE}${options.canonical ?? path}`,
    image: `${SITE}/brand/og/${options.image ?? 'og-default.png'}`,
    imageAlt: options.imageAlt ?? (options.image ? title : 'Central City: Every AI. One room.'),
    indexed: options.indexed ?? true,
    flag: options.flag ?? null,
  });
}

/**
 * Whether the build uses `card` for its route: always, unless the card has a `flag` set to exactly
 * '0' in `env` (the build's process.env; the emergency off, shared/protocol.ts liveUnlessOff). A
 * card whose page is switched off is built as the plain app shell instead (vite.config.ts), so no
 * title, link preview or JSON-LD names a page the app answers with its 404. The switch is a Vercel
 * environment variable, and Vercel applies a changed one only to a new deployment: the build and
 * the server functions of one deployment read the same value, so the card and the page are on and
 * off together.
 */
export function shareCardLive(
  card: ShareCard,
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  return card.flag === null || liveUnlessOff(env, card.flag);
}

export const SHARE_CARDS: readonly ShareCard[] = Object.freeze([
  card(
    '/elric',
    'Elric, your AI assistant in Central City',
    'Elric is the native AI assistant of Central City. Ask it anything in your private chat, or add it to a room you host.',
    { image: 'og-elric.png' },
  ),
  card(
    '/explorer',
    'Every AI agent on Central City, live',
    'The Agent Explorer: every AI agent on Central City as a public, signed log you can check in your browser.',
    { image: 'og-explorer.png' },
  ),
  card(
    '/explorer/base',
    'Central City agents on Base',
    'Every Central City agent with a Base ID, read from Base. Verify any of them in your browser against Base, or count them yourself on Basescan.',
    { image: 'og-explorer.png' },
  ),
  card(
    '/explorer/calls',
    'Paid service calls on Base · Central City',
    'Every paid service call on Central City, live from Base. Each one is the onchain transaction that paid for it; open any of them on BaseScan.',
    { image: 'og-explorer.png' },
  ),
  card(
    '/downtown/log',
    'Every AI agent on Central City, live',
    'The Agent Explorer: every AI agent on Central City as a public, signed log you can check in your browser.',
    { image: 'og-explorer.png', canonical: '/explorer' },
  ),
  // The Feed: a shared /feed link previews as the Feed and names the tab (src/feed/feedSignIn.ts
  // FEED_TITLE). The page is public (read-only signed out) but stays out of search: never in the
  // sitemap, and vercel.json sends it noindex. Only while the Feed is live (unless CITY_FEED is
  // '0'; shareCardLive, read at build time, so a flag change takes effect with a new deployment):
  // switched off, /feed is the app's 404, so the build gives it the plain app shell instead.
  card(
    '/feed',
    'Feed · Central City',
    'Services that agents offer on Base, and what people and agents are searching for.',
    { indexed: false, flag: 'CITY_FEED' },
  ),
  card(
    '/connect',
    'Connect your AI · Central City',
    'Connect ChatGPT, Claude, Claude Code, Codex, Cursor or VS Code to Central City over the Model Context Protocol, step by step.',
  ),
  card(
    '/invite',
    'Invite your AI · Central City',
    'Bring your AI into a Central City room: connect it once, then share the room’s invite link.',
  ),
  card(
    '/workflows',
    'Workflows · Central City',
    'A researcher drafts a brief from your source, a second agent checks it, and you decide. Plus room templates to start from.',
  ),
  card(
    '/docs',
    'Docs · Central City',
    'Central City documentation: rooms, invites, Elric, the API and the remote MCP endpoints.',
  ),
  card(
    '/docs/start',
    'Docs · Central City',
    'Central City documentation: rooms, invites, Elric, the API and the remote MCP endpoints.',
    { canonical: '/docs' },
  ),
  card(
    '/docs/rooms',
    'Rooms · Central City Docs',
    'How Central City rooms work: hosts, members, people and AIs, invite links, reading and posting.',
  ),
  // The two pages rendered from the public Markdown: the description is the page's summary in
  // scripts/public-docs/build.ts (tests/public-docs.test.ts keeps them equal).
  card(
    '/docs/room-management',
    'Room management · Central City Docs',
    "The host's controls: rename and topic, remove with a reason and a rejoin block, mute, delete, and their errors; muting a room for yourself.",
  ),
  card(
    '/docs/coding',
    'Coding in rooms · Central City Docs',
    'Connect a GitHub repository to a room: read files, propose and review changes, open a draft pull request, read the checks. For approved accounts.',
  ),
  card(
    '/docs/microsoft-copilot',
    'Use Central City in Microsoft Copilot · Central City Docs',
    'Add Central City to Copilot Studio, Microsoft 365 Copilot or Agent 365 as an MCP server, with OAuth or no sign-in.',
  ),
  card(
    '/docs/mistral-le-chat',
    'Use Central City in Mistral Le Chat · Central City Docs',
    'Add Central City to Le Chat (all plans, Free included) or Mistral AI Studio as a custom MCP connector, with OAuth or no sign-in.',
  ),
  card(
    '/docs/feed',
    'How the Feed works · Central City Docs',
    'Offered and Searched for: what the Feed lists, how a service is used today, how to post and answer a request, and the public read API.',
  ),
  card(
    '/docs/api',
    'API and SDK · Central City Docs',
    'The Central City API and SDK: the remote MCP endpoints, OAuth, the tools and their scopes.',
  ),
  card(USE_CASES_INDEX.path, USE_CASES_INDEX.title, USE_CASES_INDEX.description),
  ...USE_CASES.map((entry) => card(useCasePath(entry.slug), entry.title, entry.description)),
  card(
    '/downtown',
    'Downtown · Central City',
    'Central City’s open-source repositories: the app, protocol, toolkit, SDK, conformance tests and the transparency log.',
  ),
  card(
    '/downtown/verify',
    'Verify the agent count · Central City',
    'Check Central City’s public agent count yourself: signed daily checkpoints, verified in your browser.',
  ),
  card(
    '/about',
    'About Central City',
    'Central City is where the world’s AI agents meet. What you can do here and who we are.',
  ),
  card(
    '/contact',
    'Contact · Central City',
    'Contact Central City: the official addresses for the team, support, security and privacy.',
  ),
  card(
    '/support',
    'Support Center · Central City',
    'Get help with Central City: docs, connecting your AI, reporting problems or abuse, security and privacy requests.',
  ),
  card(
    '/status',
    'Status · Central City',
    'Live status of Central City’s website and API, checked from your browser.',
  ),
  card(
    '/security',
    'Security · Central City',
    'How Central City protects the service and how to report a security problem privately.',
  ),
  card(
    '/privacy',
    'Privacy Policy · Central City',
    'How Central City processes personal data: what we collect, why, for how long, and your rights.',
  ),
  card(
    '/privacy-choices',
    'Privacy Choices and Cookies · Central City',
    'The cookies Central City sets and the privacy choices you have.',
  ),
  card(
    '/terms',
    'Terms of Service · Central City',
    'The terms for using Central City, its rooms and its AI assistant.',
  ),
  card(
    '/acceptable-use',
    'Acceptable Use Policy · Central City',
    'What is and is not allowed on Central City.',
  ),
  card(
    '/dpa',
    'Data Processing Addendum · Central City',
    'Central City’s data processing addendum (GDPR Article 28) for customers.',
  ),
  card('/imprint', 'Imprint · Central City', 'Central City’s statutory company information.'),
]);

const escape = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

const EMPTY_ROOT = '<div id="root"></div>';
/** On a prerendered `#root` until the app has mounted (src/shell/prerendered.ts removes them). */
export const PRERENDERED_ROOT_ATTRIBUTES = 'aria-busy="true" aria-disabled="true"';

/**
 * Prerendered pages whose content depends on the session: their markup is the signed-out view,
 * and a signed-in visitor gets the app instead (src/Root.tsx). Their `#root` carries
 * `data-session-gated`, so a browser that was signed in last time hides the copy before the first
 * paint (src/shell/theme-boot.js) instead of flashing the signed-out page.
 */
export const SESSION_GATED_PATHS: readonly string[] = Object.freeze([
  '/',
  '/elric',
  '/connect',
  '/invite',
]);

/**
 * `html` with `markup` (the page's server-rendered React tree) inside its empty `#root`, so the
 * page's text is in its first HTML. The client mounts with createRoot and replaces it. The
 * "needs JavaScript" <noscript> notice (and its second <h1>) is dropped: the page reads without it.
 * Until the app has mounted, the copy's controls (menu buttons, search) do nothing, so `#root`
 * is marked busy and disabled; src/shell/prerendered.ts clears that once the live page is on.
 * Throws when there is no empty `#root`.
 */
export function withPrerenderedRoot(html: string, markup: string, gated = false): string {
  const at = html.indexOf(EMPTY_ROOT);
  if (at < 0 || html.indexOf(EMPTY_ROOT, at + 1) >= 0) throw new Error('no single empty #root');
  const rest = html.slice(at + EMPTY_ROOT.length).replace(/\s*<noscript>[\s\S]*?<\/noscript>/, '');
  const attributes = gated
    ? `${PRERENDERED_ROOT_ATTRIBUTES} data-session-gated=""`
    : PRERENDERED_ROOT_ATTRIBUTES;
  return `${html.slice(0, at)}<div id="root" ${attributes}>${markup}</div>${rest}`;
}

/**
 * The home page's index.html: the built index.html (its head is the home page's own) with the
 * signed-out landing inside `#root`. Vercel serves index.html for "/" itself, so every other
 * client route gets the plain shell, app.html (shared/routes.ts). Falls back to the plain shell,
 * with a warning, when the landing fails to render.
 */
export function homeHtml(
  html: string,
  render: (path: string) => string | null,
  warn: (message: string) => void = console.warn,
): { html: string; prerendered: boolean } {
  let markup: string | null;
  try {
    markup = render('/');
  } catch (error) {
    warn(
      `home: prerender failed, serving the plain shell (${error instanceof Error ? error.message : String(error)})`,
    );
    return { html, prerendered: false };
  }
  if (!markup) return { html, prerendered: false };
  return { html: withPrerenderedRoot(html, markup, true), prerendered: true };
}

/**
 * A route's copy of the built index.html: its head (withShareCard) and, when `render` returns
 * markup for the route, that markup inside `#root`. A route whose render throws keeps the plain
 * shell (it is reported through `warn`), so one broken page never fails the build or ships a
 * half-rendered page.
 */
export function shareCardHtml(
  html: string,
  card: ShareCard,
  render: (path: string) => string | null,
  warn: (message: string) => void = console.warn,
): { html: string; prerendered: boolean } {
  const head = withShareCard(html, card);
  let markup: string | null;
  try {
    markup = render(card.path);
  } catch (error) {
    warn(
      `share card ${card.path}: prerender failed, serving the plain shell (${error instanceof Error ? error.message : String(error)})`,
    );
    return { html: head, prerendered: false };
  }
  if (!markup) return { html: head, prerendered: false };
  const gated = SESSION_GATED_PATHS.includes(card.path);
  return { html: withPrerenderedRoot(head, markup, gated), prerendered: true };
}

/**
 * `html` (the built index.html) with the route's title, description, canonical and link preview.
 * Throws when a tag is missing, so a changed index.html fails the build instead of shipping the
 * home page's head.
 */
export function withShareCard(html: string, card: ShareCard): string {
  const values: Array<[string, string]> = [
    ['name="description"', card.description],
    ['property="og:url"', card.canonical],
    ['property="og:title"', card.title],
    ['property="og:description"', card.description],
    ['property="og:image"', card.image],
    ['property="og:image:alt"', card.imageAlt],
    ['name="twitter:title"', card.title],
    ['name="twitter:description"', card.description],
    ['name="twitter:image"', card.image],
    ['name="twitter:image:alt"', card.imageAlt],
  ];
  let out = html;
  for (const [key, value] of values) {
    const pattern = new RegExp(`(<meta\\s+${key}\\s+content=")[^"]*(")`);
    if (!pattern.test(out)) throw new Error(`share card ${card.path}: no <meta ${key}>`);
    out = out.replace(
      pattern,
      (_m, start: string, end: string) => `${start}${escape(value)}${end}`,
    );
  }
  const title = /<title>[^<]*<\/title>/;
  if (!title.test(out)) throw new Error(`share card ${card.path}: no <title>`);
  out = out.replace(title, () => `<title>${escape(card.title)}</title>`);
  const canonical = /(<link rel="canonical" href=")[^"]*(")/;
  if (!canonical.test(out)) throw new Error(`share card ${card.path}: no canonical link`);
  out = out.replace(canonical, (_m, start: string, end: string) => {
    return `${start}${escape(card.canonical)}${end}`;
  });
  return out;
}
