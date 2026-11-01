/*
 * Names of the browser sign-in cookies. Secure cookies (every hosted deployment) carry the
 * __Host- prefix, so the browser only accepts them from this exact host over HTTPS with Path=/
 * and no Domain: a sibling subdomain cannot set one. Loopback development without HTTPS keeps
 * the plain names, which the browser would refuse with the prefix.
 *
 * Browsers that signed in before the rename still send the plain name. It is read when no
 * prefixed cookie is present, only for a session from before the rename (sessions.host_cookie
 * false, migration 274), and replaced by the prefixed one at the next session renewal or
 * sign-in, so nobody is signed out. A sign-in issued under the prefixed name never reads from the
 * plain name: a client sends the cookie back under the name it was set with. A plain name sent
 * more than once (a second cookie for a parent domain alongside the host's own) is ambiguous and
 * reads as signed out.
 *
 * The plain-name read on a secure deployment ends at LEGACY_COOKIE_READ_UNTIL. Every session
 * ends 30 days after sign-in (SESSION_MAX_AGE_MS), so a sign-in from before the rename has ended
 * by then if the rename is deployed at least 30 days earlier; one that has not reads as signed
 * out and signs in again. After that instant the fallback (and sessions.host_cookie) can be
 * deleted.
 */
export const SESSION_COOKIE = 'cc_session';
export const DEVICE_COOKIE = 'cc_device';
const HOST_PREFIX = '__Host-';

/** The last instant a secure deployment reads a sign-in cookie under its plain name. */
export const LEGACY_COOKIE_READ_UNTIL = Date.parse('2026-12-31T00:00:00Z');

export function cookieName(base: string, secure: boolean): string {
  return secure ? `${HOST_PREFIX}${base}` : base;
}

/** How often `name` appears in a raw Cookie header. */
function occurrences(header: string | undefined, name: string): number {
  if (!header) return 0;
  let count = 0;
  for (const part of header.split(';')) {
    const pair = part.trim();
    const end = pair.indexOf('=');
    if ((end === -1 ? pair : pair.slice(0, end).trim()) === name) count += 1;
  }
  return count;
}

export interface PresentedCookie {
  value: string;
  /** Sent under the plain name by a secure deployment (signed in before the rename). */
  legacy: boolean;
}

/**
 * The cookie `base` as the request presents it: the prefixed name on a secure deployment, else
 * the plain name (on a secure deployment only before LEGACY_COOKIE_READ_UNTIL). Either one sent
 * twice reads as absent.
 */
export function presentedCookie(
  header: string | undefined,
  cookies: Record<string, string | undefined>,
  base: string,
  secure: boolean,
  now: number = Date.now(),
): PresentedCookie | undefined {
  if (secure) {
    const prefixed = `${HOST_PREFIX}${base}`;
    const value = cookies[prefixed];
    if (value !== undefined)
      return occurrences(header, prefixed) === 1 ? { value, legacy: false } : undefined;
    if (now >= LEGACY_COOKIE_READ_UNTIL) return undefined;
  }
  const value = cookies[base];
  if (value === undefined || occurrences(header, base) !== 1) return undefined;
  return { value, legacy: secure };
}
