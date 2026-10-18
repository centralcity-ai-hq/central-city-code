/**
 * Where "Continue with Google" may return after signing in (docs/GOOGLE_SIGNIN.md): only these
 * same-origin, relative paths. Anything else (another origin, `//host`, a backslash, a scheme,
 * a query or fragment, an unknown path) is null, and the server uses its default. The server
 * checks it when the flow starts and again at the callback; the client checks it once more.
 */
const EXACT = new Set(['/elric', '/rooms', '/settings/account', '/feed', '/feed/requests']);
const ROOM = /^\/rooms\/[A-Za-z0-9-]{1,64}$/;
/** One Feed request or service (shared/feed.ts FEED_CLIENT_PATHS); never a request's manage page. */
const FEED_ITEM = /^\/feed\/(?:requests|services)\/[A-Za-z0-9_-]{1,64}$/;

export function safeReturnPath(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 80) return null;
  const path = value.length > 1 && value.endsWith('/') ? value.slice(0, -1) : value;
  if (!path.startsWith('/') || path.startsWith('//')) return null;
  return EXACT.has(path) || ROOM.test(path) || FEED_ITEM.test(path) ? path : null;
}
