import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { createApp } from './app.js';
import { loadHostedConfig } from './hosted.js';
import { errorFacts, errorLine } from './error-log.js';

// Re-exported so scripts/bundle-request-smoke.mjs can boot the built bundle against an
// in-memory database; the deployed function only uses the default export.
export { createApp };

/** Rewrite prefixes in vercel.json whose `:path*` parameter the destination (`/api`) does not use. */
const REWRITE_PREFIXES = [
  '/api/',
  '/oauth/',
  '/.well-known/oauth-protected-resource/',
  '/a2a/',
  // Join links: the code must never be copied into a query string that reaches logs.
  '/j/',
];

const decode = (value: string) => {
  try {
    return decodeURIComponent(value.replace(/\+/g, ' '));
  } catch {
    return undefined;
  }
};

/**
 * Vercel appends rewrite parameters that the destination does not use to the query string
 * (`/api/messages/x` arrives as `/api/messages/x?path=messages%2Fx`). Remove exactly that
 * parameter, textually, so strict query schemas see the client's request and query-signed
 * runtime requests keep their original bytes. A `path` value that is not the rewritten tail is
 * left alone.
 */
export function withoutRewriteParameter(url: string): string {
  const mark = url.indexOf('?');
  if (mark < 0) return url;
  const pathname = url.slice(0, mark);
  const prefix = REWRITE_PREFIXES.find((candidate) => pathname.startsWith(candidate));
  if (!prefix) return url;
  const tail = decode(pathname.slice(prefix.length));
  const kept = url
    .slice(mark + 1)
    .split('&')
    .filter((pair) => {
      if (!pair.startsWith('path=')) return true;
      return decode(pair.slice('path='.length)) !== tail;
    });
  // Nothing but the rewrite parameter (and at most one empty segment beside it, as a bare '?' may
  // arrive): the client's own URL had no query. More empty segments ('?&&') are the client's and are
  // kept: the edge cache keys by them, so a route that takes no query must see them.
  if (!kept.some(Boolean) && kept.length <= 1) return pathname;
  return `${pathname}?${kept.join('&')}`;
}

/**
 * The homepage ticker (GET /api/public/stats) is cached at the edge per URL, query included, so a
 * query string (e.g. `?random`) would skip the cache and reach the database-backed rate limiter
 * and the count. It takes no parameters: any query is answered here, before the application and
 * the database, with a cacheable permanent redirect to the one canonical URL.
 */
export const PUBLIC_STATS_PATH = '/api/public/stats';
export function publicStatsRedirect(method: string | undefined, url: string): string | null {
  if (method !== 'GET' && method !== 'HEAD') return null;
  const mark = url.indexOf('?');
  if (mark < 0 || url.slice(0, mark) !== PUBLIC_STATS_PATH) return null;
  return PUBLIC_STATS_PATH;
}

export function createHostedHandler(
  create: () => Promise<FastifyInstance>,
  log: (line: string) => void = console.info,
) {
  let application: Promise<FastifyInstance> | undefined;
  return async function handler(request: IncomingMessage, response: ServerResponse) {
    const checkpoint = request.url?.split('?')[0] === '/api/cron/count-checkpoint';
    const started = Date.now();
    const trace = checkpoint ? randomUUID() : null;
    const phase = (name: string) => {
      if (trace)
        log(
          JSON.stringify({
            event: `count_log.request.${name}`,
            trace,
            elapsed_ms: Date.now() - started,
          }),
        );
    };
    phase('entry');
    if (request.url) request.url = withoutRewriteParameter(request.url);
    const canonical = publicStatsRedirect(request.method, request.url ?? '');
    if (canonical) {
      response.writeHead(308, {
        Location: canonical,
        'Cache-Control': 'public, max-age=3600, s-maxage=86400',
        'X-Content-Type-Options': 'nosniff',
      });
      response.end();
      return;
    }
    let starting = true;
    try {
      application ??= create()
        .then(async (app) => {
          await app.ready();
          return app;
        })
        .catch((error) => {
          application = undefined;
          throw error;
        });
      const app = await application;
      starting = false;
      phase('app_ready');
      // Await the response; no work relies on execution after the function returns.
      await new Promise<void>((resolve, reject) => {
        response.once('finish', resolve);
        response.once('close', resolve);
        response.once('error', reject);
        app.server.emit('request', request, response);
      });
      phase('response_end');
    } catch (error) {
      phase('failed');
      // One line per failed cold start (or a request that failed outside the app's own error
      // handler): the error class and code, and its cause's, never the message (audit CCA-515).
      log(errorLine(starting ? 'cold_start_failed' : 'hosted_request_failed', errorFacts(error)));
      if (!response.headersSent) {
        response.writeHead(503, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
        });
        response.end(
          JSON.stringify({ error: 'Hosted staging is unavailable. Check server configuration.' }),
        );
      } else response.end();
    }
  };
}

/**
 * A crash is recorded before Node ends the process: 'uncaughtExceptionMonitor' only observes
 * (also for an unhandled rejection, origin 'unhandledRejection'), so Node's own behaviour is
 * unchanged. Class and code only (audit CCA-515). Installed once per process.
 */
let crashMonitor: ((error: Error, origin: string) => void) | undefined;
export function installCrashMonitor(
  log: (line: string) => void = (line) => console.error(line),
): void {
  if (crashMonitor) return;
  crashMonitor = (error, origin) =>
    log(errorLine('process_crash', { origin: String(origin), ...errorFacts(error) }));
  process.on('uncaughtExceptionMonitor', crashMonitor);
}

installCrashMonitor();

export default createHostedHandler(() => createApp({ hosted: loadHostedConfig() }));
