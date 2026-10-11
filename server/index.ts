import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import fastifyStatic from '@fastify/static';
import { createApp } from './app.js';
import {
  APP_SHELL,
  isClientRoute,
  movedPath,
  shellFor,
  withoutTrailingSlash,
} from '../shared/routes.js';
import { CONTENT_SECURITY_POLICY } from './security-headers.js';

const port = Number(process.env.PORT ?? 4310);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid local port');
// CITY_DIST_DIR is for tests (tests/routes.test.ts); normal runs serve the built dist/.
const dist = resolve(process.env.CITY_DIST_DIR ?? 'dist');
const spa = existsSync(resolve(dist, 'index.html'));
// public/404.html is copied into dist by the build; Vercel serves the same file with status 404.
const notFoundPage = existsSync(resolve(dist, '404.html'));
// The docs index for AIs, written by the build as dist/docs-index.md; vercel.json serves it at
// /docs/index.md and /docs.md, and so does this server.
const docsIndex = existsSync(resolve(dist, 'docs-index.md'));
// Unknown paths: client routes (shared/routes.ts) get the SPA; everything else is a real 404,
// matching vercel.json. Room pages are /r/<slug>; their token stays in the fragment. Unknown
// /api/ routes are answered by createApp itself.
// CITY_COUNT_LOG_CRON_NOW (an ISO instant in a Berlin-noon hour) pins the count-log cron gate
// for the e2e suite (playwright.config.ts) so the specs pass at any time of day. Deployments
// never set it; the gate then reads the app clock.
const countLogCronNow = process.env.CITY_COUNT_LOG_CRON_NOW;
if (countLogCronNow !== undefined && Number.isNaN(Date.parse(countLogCronNow)))
  throw new Error('CITY_COUNT_LOG_CRON_NOW must be an ISO instant (e.g. 2026-10-01T10:00:00Z).');
const app = await createApp({
  dataDir: process.env.CITY_DATA_DIR ?? resolve('.local/data'),
  ...(countLogCronNow ? { countLogCronNow: () => Date.parse(countLogCronNow) } : {}),
  notFound: (request, reply) => {
    const path = request.url.split(/[?#]/)[0]!;
    const read = request.method === 'GET' || request.method === 'HEAD';
    if (spa && read && isClientRoute(path)) return reply.type('text/html').sendFile(shellFor(path));
    if (notFoundPage && read) return reply.code(404).type('text/html').sendFile('404.html');
    return reply.code(404).send({ error: 'Page not found' });
  },
  // A browser at /a/<short> gets the passport page, like vercel.json's rewrite; resolvers keep
  // the registration file.
  ...(spa
    ? { passportPage: (_request, reply) => reply.type('text/html').sendFile(APP_SHELL.slice(1)) }
    : {}),
});
if (spa) {
  await app.register(fastifyStatic, { root: dist, dotfiles: 'deny' });
}
if (docsIndex)
  for (const path of ['/docs/index.md', '/docs.md'])
    app.get(path, (_request, reply) =>
      reply.type('text/markdown; charset=utf-8').sendFile('docs-index.md'),
    );
// `/path/` → `/path` (308, query kept) for non-server-owned paths, like vercel.json's redirect
// (shared/routes.ts TRAILING_SLASH_REDIRECT).
app.addHook('onRequest', async (request, reply) => {
  if (request.method !== 'GET' && request.method !== 'HEAD') return;
  const [path, ...query] = request.url.split('?');
  const target = withoutTrailingSlash(path!);
  if (target) return reply.redirect(query.length ? `${target}?${query.join('?')}` : target, 308);
});
// Retired client paths (/how, /answers) move for good (301, query kept), like vercel.json's
// redirects (shared/routes.ts CLIENT_REDIRECTS).
app.addHook('onRequest', async (request, reply) => {
  if (request.method !== 'GET' && request.method !== 'HEAD') return;
  const target = movedPath(request.url);
  if (target) return reply.redirect(target, 301);
});
app.addHook('onSend', async (request, reply) => {
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('X-Frame-Options', 'DENY');
  // OAuth consent pages need same-origin so browsers send a real Origin on their form POSTs.
  reply.header(
    'Referrer-Policy',
    request.url.startsWith('/oauth/') ? 'same-origin' : 'no-referrer',
  );
  reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  reply.header('Content-Security-Policy', CONTENT_SECURITY_POLICY);
});
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  await app.close();
}
process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
await app.listen({ host: '127.0.0.1', port });
console.log(`Central City is available locally at http://127.0.0.1:${port}`);
