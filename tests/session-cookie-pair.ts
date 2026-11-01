import assert from 'node:assert/strict';

/**
 * The session cookie from a sign-in answer as a Cookie header pair, under the name the server
 * set: `__Host-cc_session` on a hosted (secure) app, `cc_session` on loopback development.
 */
export function sessionPair(cookies: readonly { name: string; value: string }[]): string {
  const session = cookies.find(
    (cookie) => cookie.name === '__Host-cc_session' || cookie.name === 'cc_session',
  );
  assert.ok(session?.value, 'the answer sets a session cookie');
  return `${session.name}=${session.value}`;
}
