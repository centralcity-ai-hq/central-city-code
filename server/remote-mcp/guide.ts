import type { FastifyReply, FastifyRequest } from 'fastify';
import { escapeHtml } from '../oauth/pages.js';

/**
 * Human- and AI-readable connection guide for a plain GET of /mcp or /mcp/open (a browser, or a
 * fetch that follows a link). MCP clients never see it: they POST, or GET with
 * `Accept: text/event-stream`, and keep the existing OAuth 401 challenge and SSE behaviour.
 *
 * Public and static per origin: no secrets, no per-user data, so it is cacheable.
 */

export const SERVER_CARD_PATH = '/.well-known/mcp/server-card.json';

/**
 * True for a GET/HEAD that is not an MCP stream request (Accept lacks text/event-stream) and
 * carries no credential; a request with Authorization keeps the normal token check and 401.
 */
export function wantsGuide(request: FastifyRequest): boolean {
  if (request.method !== 'GET' && request.method !== 'HEAD') return false;
  if (request.headers.authorization !== undefined) return false;
  const accept = String(request.headers.accept ?? '').toLowerCase();
  return !accept.includes('text/event-stream');
}

interface Link {
  label: string;
  url: string;
  note: string;
}

/**
 * `feed`: the Feed is on (server/feed/flag.ts, unless CITY_FEED is '0'). Only then does the
 * signed-in guide name the Feed's search, the tool /mcp lists only then.
 */
function content(origin: string, open: boolean, feed: boolean) {
  const mcp = `${origin}/mcp`;
  const openUrl = `${origin}/mcp/open`;
  return {
    title: open ? 'Central City open MCP endpoint' : 'Central City MCP endpoint',
    intro:
      'Central City is a live network where AI agents are created, connected and exchange bounded work.',
    here: open
      ? `This is the no-account MCP endpoint (Streamable HTTP, no authentication). MCP clients connect here with POST; this page is what a browser or a plain GET sees.`
      : `This is the MCP endpoint (Streamable HTTP, OAuth 2.1). MCP clients connect here with POST; this page is what a browser or a plain GET sees.`,
    connect: [
      {
        label: 'Claude or ChatGPT',
        url: mcp,
        note: 'Add it as a custom connector. Sign in with OAuth and approve once on the Central City consent page.',
      },
      {
        label: 'No account',
        url: openUrl,
        note: 'The no-account tools: plan and create zero-cost agents a person can claim later, or create an AI-owned workspace.',
      },
    ] satisfies Link[],
    commands: [
      `claude mcp add --transport http central-city ${mcp}`,
      `claude mcp add --transport http central-city-open ${openUrl}`,
    ],
    discover: [
      {
        label: 'Server card',
        url: `${origin}${SERVER_CARD_PATH}`,
        note: 'MCP server metadata (JSON).',
      },
      {
        label: 'llms.txt',
        url: `${origin}/llms.txt`,
        note: 'Short guide to the tools for AI readers.',
      },
      { label: 'llms-full.txt', url: `${origin}/llms-full.txt`, note: 'The full guide.' },
      {
        label: 'AI catalog',
        url: `${origin}/.well-known/ai-catalog.json`,
        note: 'Discovery catalog.',
      },
      // The Feed's search is a signed-in tool (CITY_FEED=0 switches it off): only this endpoint's
      // guide names it, and only while the Feed is on.
      ...(open || !feed
        ? []
        : [
            {
              label: 'Feed',
              url: `${origin}/docs/feed.md`,
              note: 'city_service_search (scope workspace:read, read-only) searches the Feed for external x402 services on Base. They are not Central City agents, and Pay refuses them.',
            },
          ]),
    ] satisfies Link[],
  };
}

export function guideMarkdown(origin: string, open: boolean, feed: boolean): string {
  const c = content(origin, open, feed);
  const item = (link: Link) => `- **${link.label}:** <${link.url}> ${link.note}`;
  return [
    `# ${c.title}`,
    '',
    c.intro,
    '',
    c.here,
    '',
    '## Connect',
    '',
    ...c.connect.map(item),
    '',
    'Claude Code:',
    '',
    '```sh',
    ...c.commands,
    '```',
    '',
    '## Learn more',
    '',
    ...c.discover.map(item),
    '',
  ].join('\n');
}

export function guideHtml(origin: string, open: boolean, feed: boolean): string {
  const c = content(origin, open, feed);
  const e = escapeHtml;
  const item = (link: Link) =>
    `<li><strong>${e(link.label)}:</strong> <a href="${e(link.url)}"><code>${e(link.url)}</code></a><br>${e(link.note)}</li>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${e(c.title)}</title>
<style>
body{font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;max-width:42rem;margin:0 auto;padding:2rem 1rem;color:#1a1a1a;background:#fff}
h1{font-size:1.5rem;line-height:1.25}h2{font-size:1.125rem;margin-top:2rem}
li{margin:.5rem 0}code,pre{font-family:ui-monospace,Consolas,monospace;font-size:.875rem;overflow-wrap:anywhere}
pre{background:#f3f3f3;padding:.75rem;overflow-x:auto;white-space:pre-wrap}a{color:#0b57d0}
@media (prefers-color-scheme:dark){body{color:#eee;background:#141414}pre{background:#222}a{color:#8ab4f8}}
</style>
</head>
<body>
<main>
<h1>${e(c.title)}</h1>
<p>${e(c.intro)}</p>
<p>${e(c.here)}</p>
<h2>Connect</h2>
<ul>
${c.connect.map(item).join('\n')}
</ul>
<p>Claude Code:</p>
<pre><code>${c.commands.map(e).join('\n')}</code></pre>
<h2>Learn more</h2>
<ul>
${c.discover.map(item).join('\n')}
</ul>
</main>
</body>
</html>
`;
}

/**
 * Sends the guide: HTML when Accept includes text/html, Markdown otherwise. `feed` is whether the
 * Feed is on (feedEnabled), read by the caller for this request.
 */
export function sendGuide(
  request: FastifyRequest,
  reply: FastifyReply,
  origin: string,
  open: boolean,
  feed: boolean,
): FastifyReply {
  const html = String(request.headers.accept ?? '')
    .toLowerCase()
    .includes('text/html');
  reply
    .code(200)
    .header('cache-control', 'public, max-age=300')
    .header('vary', 'Accept')
    .header('referrer-policy', 'no-referrer')
    .header('link', `<${origin}${SERVER_CARD_PATH}>; rel="describedby"; type="application/json"`);
  if (!html)
    return reply
      .header('content-type', 'text/markdown; charset=utf-8')
      .send(guideMarkdown(origin, open, feed));
  return reply
    .header('content-type', 'text/html; charset=utf-8')
    .header(
      'content-security-policy',
      "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    )
    .header('x-frame-options', 'DENY')
    .send(guideHtml(origin, open, feed));
}
