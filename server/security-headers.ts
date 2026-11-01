import { PUBLIC_BASE_RPC } from '../shared/base/on-base.js';
import { ARC_MAINNET, ARC_NETWORKS, ARC_TESTNET } from '../shared/chains.js';

/*
 * The response header policy, in one place. Function answers get it from createApp's onRequest
 * hook (server/app.ts); static files and the app shell get it from vercel.json, kept equal by
 * tests/security-headers.test.ts, header by header and path by path; the local server
 * (server/index.ts) gives its static files the edge values. On Vercel a header the function sets
 * wins over the same header in vercel.json, so the function sends the same values as the edge,
 * except where noted below.
 *
 * Precedence is the same in both places: a route that sends its own value of one of these headers
 * (a stricter Content-Security-Policy on a page without scripts, for example) keeps it, because the
 * application sets the policy before the route runs and the edge never overrides a header the
 * function sent.
 */

/**
 * connect-src allows the app's own origin and the public Base endpoint, which a passport's Verify
 * reads in the visitor's browser (src/verify/onBaseVerify.ts); without it the browser refuses
 * that read. It allows Arc's two public endpoints, which the wallet's Pay and Rate read the same way
 * for an agent on Arc (src/base/wallet/pay.ts, rate.ts). It also allows the room file store's upload API (only its /api/blob/ path): the console
 * PUTs a room file straight to the one-shot URL the server issued (docs/ROOMS.md "Room files").
 * Server-rendered pages (OAuth consent, link pages, the MCP guide) replace the CSP
 * with a stricter one of their own.
 */
/** The room file store's upload API (presigned PUTs, server/rooms/artifact-store.ts). */
export const ROOM_FILE_UPLOAD_ORIGIN = 'https://vercel.com/api/blob/';

export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  `connect-src 'self' ${new URL(PUBLIC_BASE_RPC).origin} ${new URL(ARC_NETWORKS[ARC_MAINNET].publicRpcUrl).origin} ${new URL(ARC_NETWORKS[ARC_TESTNET].publicRpcUrl).origin} ${ROOM_FILE_UPLOAD_ORIGIN}`,
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join('; ');

/**
 * Every powerful browser feature the site does not use is switched off for it and for anything it
 * frames. Kept on for the site itself: autoplay (the muted landing video) and fullscreen (video).
 * Clipboard writes (the copy buttons) are not listed, so browsers keep their default for them.
 */
export const PERMISSIONS_POLICY = [
  'accelerometer=()',
  'autoplay=(self)',
  'bluetooth=()',
  'browsing-topics=()',
  'camera=()',
  'display-capture=()',
  'encrypted-media=()',
  'fullscreen=(self)',
  'gamepad=()',
  'geolocation=()',
  'gyroscope=()',
  'hid=()',
  'idle-detection=()',
  'local-fonts=()',
  'magnetometer=()',
  'microphone=()',
  'midi=()',
  'payment=()',
  'picture-in-picture=()',
  'publickey-credentials-get=()',
  'screen-wake-lock=()',
  'serial=()',
  'usb=()',
  'xr-spatial-tracking=()',
].join(', ');

/**
 * Trusted Types in report-only mode first: browsers report (in the console) every script sink that
 * takes a plain string, without blocking it, until the enforced policy can follow.
 */
export const CONTENT_SECURITY_POLICY_REPORT_ONLY = "require-trusted-types-for 'script'";

/*
 * Two years, this host only (the value the platform already sent by default). includeSubDomains
 * (CCA-403) and preload wait for an owner check of the authoritative DNS zone that every
 * centralcity.ai subdomain serves HTTPS. Until then the __Host- session and device cookies
 * (server/session-cookie.ts) are what keeps a subdomain from setting or shadowing them.
 */
export const STRICT_TRANSPORT_SECURITY = 'max-age=63072000';

/** Headers every response carries, from the function and from the edge alike. */
export const SHARED_SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': PERMISSIONS_POLICY,
  'Content-Security-Policy': CONTENT_SECURITY_POLICY,
  'Content-Security-Policy-Report-Only': CONTENT_SECURITY_POLICY_REPORT_ONLY,
  'Strict-Transport-Security': STRICT_TRANSPORT_SECURITY,
};

/**
 * Cross-Origin-Opener-Policy keeps other sites' windows out of the site's browsing context group;
 * allow-popups keeps the wallet popups the site opens working. The OAuth pages are left out: an
 * AI client may open the consent page in a popup of its own.
 */
export const CROSS_ORIGIN_OPENER_POLICY = 'same-origin-allow-popups';

/**
 * Cross-Origin-Resource-Policy same-origin for the signed-in API: no other site can load those
 * answers as an image or a script. Public reads (/api/public/) and static files stay embeddable,
 * as Base explorers show the agent icon (/brand/) on their own pages.
 */
export const CROSS_ORIGIN_RESOURCE_POLICY = 'same-origin';
const privateApi = (path: string) => path.startsWith('/api/') && !path.startsWith('/api/public/');

export const OAUTH_PATH_PREFIX = '/oauth/';

/** The path-dependent cross-origin headers, the same from the function and from the edge. */
function crossOriginHeaders(path: string): Record<string, string> {
  return {
    ...(path.startsWith(OAUTH_PATH_PREFIX)
      ? {}
      : { 'Cross-Origin-Opener-Policy': CROSS_ORIGIN_OPENER_POLICY }),
    ...(privateApi(path) ? { 'Cross-Origin-Resource-Policy': CROSS_ORIGIN_RESOURCE_POLICY } : {}),
  };
}

/*
 * Static files and the app shell send no referrer. The OAuth pages use same-origin, because
 * under no-referrer browsers send `Origin: null` on the consent form's POST.
 */
export function edgeReferrerPolicy(path: string): string {
  return path.startsWith(OAUTH_PATH_PREFIX) ? 'same-origin' : 'no-referrer';
}

/*
 * Function answers default to same-origin for the same reason: the server's own HTML forms
 * (OAuth consent, newsletter confirm and unsubscribe) must POST with a real Origin. Pages that
 * carry a secret in their URL (link pages) set no-referrer themselves.
 */
export const FUNCTION_REFERRER_POLICY = 'same-origin';

/** The security headers the edge (vercel.json) sends for `path` (the request path, no query). */
export function securityHeaders(path: string): Record<string, string> {
  return {
    ...SHARED_SECURITY_HEADERS,
    'Referrer-Policy': edgeReferrerPolicy(path),
    ...crossOriginHeaders(path),
  };
}

/**
 * The security headers of a function answer for `path` (the request path, without the query).
 * HSTS only on hosted (HTTPS) deployments: loopback development is plain HTTP, where browsers
 * ignore it anyway.
 */
export function functionSecurityHeaders(hosted: boolean, path: string): Record<string, string> {
  const headers: Record<string, string> = {
    ...SHARED_SECURITY_HEADERS,
    'Referrer-Policy': FUNCTION_REFERRER_POLICY,
    ...crossOriginHeaders(path),
  };
  if (!hosted) delete headers['Strict-Transport-Security'];
  return headers;
}

/** Every header name securityHeaders sets on some path, for the tests and the edge mirror. */
export const SECURITY_HEADER_NAMES: readonly string[] = [
  ...new Set(
    ['/', '/oauth/authorize', '/api/x'].flatMap((path) => Object.keys(securityHeaders(path))),
  ),
];
