/*
 * The Feed's addresses (shared/feed.ts FEED_CLIENT_PATHS, client routes in shared/routes.ts):
 *
 *   /feed                          Offered
 *   /feed/requests                 Searched for
 *   /feed/requests/<id>            one request
 *   /feed/requests/<id>/manage     close a request (its manage token rides in the fragment)
 *   /feed/services/<id>            one service
 *   /feed/calls/<id>               one paid call of the person's agent (shared/feed-pay.ts
 *                                  FEED_PAY_CLIENT_PATHS; the owner only)
 *
 * Pure and tiny on purpose: Root imports it to route, so it stays out of the Feed's chunk.
 * tests/feed-ui.test.ts keeps it in step with FEED_CLIENT_PATHS.
 */

const ID = '[A-Za-z0-9_-]{1,64}';

export const FEED_PATH = new RegExp(
  `^/feed(?:(/requests)(?:/(${ID})(/manage)?)?|/services/(${ID})|/calls/(${ID}))?/?$`,
);

export type FeedRoute =
  | { view: 'offered' }
  | { view: 'requests' }
  | { view: 'service'; id: string }
  | { view: 'request'; id: string }
  | { view: 'manage'; id: string }
  | { view: 'call'; id: string };

export function feedRoute(pathname: string): FeedRoute | null {
  const match = FEED_PATH.exec(pathname);
  if (!match) return null;
  const [, requests, requestId, manage, serviceId, callId] = match;
  if (serviceId) return { view: 'service', id: serviceId };
  if (callId) return { view: 'call', id: callId };
  if (requestId)
    return manage ? { view: 'manage', id: requestId } : { view: 'request', id: requestId };
  return requests ? { view: 'requests' } : { view: 'offered' };
}

export const feedHref = {
  offered: '/feed',
  requests: '/feed/requests',
  service: (id: string) => `/feed/services/${encodeURIComponent(id)}`,
  request: (id: string) => `/feed/requests/${encodeURIComponent(id)}`,
  manage: (id: string) => `/feed/requests/${encodeURIComponent(id)}/manage`,
  call: (id: string) => `/feed/calls/${encodeURIComponent(id)}`,
} as const;

/** The manage token as the server makes it (ccf_ + base64url); the server decides the rest. */
const MANAGE_TOKEN = /^ccf_[A-Za-z0-9_-]{8,200}$/;

/** The token a manage link's fragment carries; null when it carries none. */
export function readManageToken(hash: string): string | null {
  const token = hash.replace(/^#/, '');
  return MANAGE_TOKEN.test(token) ? token : null;
}

let heldCode: { id: string; token: string } | null = null;

/**
 * A manage link (/feed/requests/<id>/manage#ccf_…): its private code leaves the address bar, and
 * so history, before anything renders (sign-in may come first), and waits in memory for the page
 * that closes that request. Called once at startup (src/main.tsx), like capturePendingJoin.
 */
export function captureManageCode(location: Location = window.location): void {
  const route = feedRoute(location.pathname);
  if (route?.view !== 'manage' || !location.hash) return;
  const token = readManageToken(location.hash);
  window.history.replaceState(window.history.state, '', `${location.pathname}${location.search}`);
  if (token) heldCode = { id: route.id, token };
}

/** The code captured for request `id` this page load, if any. */
export function heldManageCode(id: string): string | null {
  return heldCode?.id === id ? heldCode.token : null;
}

/**
 * Signed out on a Feed address: the request whose private link's page opens with no sign-in.
 * Only with its code, which closes the request without an account. A manage address without it
 * (reloaded, or copied from the address bar once the code left it) is null: sign-in comes first,
 * and the account that posted the request then closes it on the same page.
 */
export function signedOutManageId(pathname: string): string | null {
  const route = feedRoute(pathname);
  return route?.view === 'manage' && heldManageCode(route.id) ? route.id : null;
}

const forgetters = new Set<() => void>();

/** The Feed's memory of a signed-in person (its private close tokens, "Yours") registers here. */
export function onFeedForget(forget: () => void): void {
  forgetters.add(forget);
}

/**
 * Sign-out, or another account in this tab: the private close tokens and the requests marked
 * "Yours" belong to the account that posted them, so they are dropped (Root calls this).
 */
export function forgetFeedSession(): void {
  heldCode = null;
  for (const forget of forgetters) forget();
}
