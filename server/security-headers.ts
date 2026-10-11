import { PUBLIC_BASE_RPC } from '../shared/base/on-base.js';

/*
 * The Content-Security-Policy of every page and answer, the same here (server/index.ts) and at the
 * edge (vercel.json, kept equal by tests/security-headers.test.ts). connect-src allows the app's
 * own origin and the public Base endpoint, which a passport's Verify reads in the visitor's
 * browser (src/verify/onBaseVerify.ts); without it the browser refuses that read.
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  `connect-src 'self' ${new URL(PUBLIC_BASE_RPC).origin}`,
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join('; ');
