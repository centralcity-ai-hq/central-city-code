/**
 * Sign in with Google configuration (docs/GOOGLE_SIGNIN.md). Off unless CITY_GOOGLE_SIGNIN=1.
 * The OAuth client comes from GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET; their values
 * are never logged or returned.
 *
 * Google's endpoints and issuers are fixed here. Tests replace only the HTTP transport (through
 * createApp options), never the endpoints, so no setting can point the server at another issuer.
 */
export const GOOGLE_ENDPOINTS = Object.freeze({
  authorization: 'https://accounts.google.com/o/oauth2/v2/auth',
  token: 'https://oauth2.googleapis.com/token',
  jwks: 'https://www.googleapis.com/oauth2/v3/certs',
});
export const GOOGLE_ISSUERS: readonly string[] = Object.freeze([
  'accounts.google.com',
  'https://accounts.google.com',
]);

export const GOOGLE_LIMITS = Object.freeze({
  /** A started sign-in or link must come back within this time. */
  flowTtlMs: 10 * 60_000,
  /** Clock skew accepted on the ID token's exp and iat. */
  skewMs: 60_000,
  /** Starts per client address per window (sign-in and link together). */
  startsPerAddress: 20,
  /** Callbacks per client address per window. */
  callbacksPerAddress: 30,
  /** Unlinks per account per window. */
  unlinksPerAccount: 10,
  /** Date of birth entries and corrections per account per window. */
  ageWritesPerAccount: 10,
  windowMs: 15 * 60_000,
  /** JWKS cache bounds (Cache-Control max-age is clamped to these). */
  jwksMinTtlMs: 60_000,
  jwksMaxTtlMs: 24 * 60 * 60_000,
  jwksDefaultTtlMs: 60 * 60_000,
  /** An unknown key id refetches the JWKS at most this often. */
  jwksRefetchMs: 60_000,
  /** Response bodies from Google are read up to this size. */
  responseBytes: 65_536,
  timeoutMs: 10_000,
});

export interface GoogleHttpRequest {
  method: 'GET' | 'POST';
  url: string;
  headers: Record<string, string>;
  body?: string;
}
export interface GoogleHttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}
export type GoogleTransport = (request: GoogleHttpRequest) => Promise<GoogleHttpResponse>;

export interface GoogleSignInOptions {
  /** Overrides CITY_GOOGLE_SIGNIN. */
  enabled?: boolean;
  /** Replaces process.env for the flag and the client id and secret. */
  env?: Record<string, string | undefined>;
  /** Tests only: replaces the HTTP calls to Google's token and JWKS endpoints. */
  transport?: GoogleTransport;
  /**
   * Tests only, set through createApp options (never the environment): the per-address budgets
   * for starts and callbacks. The browser e2e server serves every Google spec from one address.
   */
  addressLimits?: { startsPerAddress?: number; callbacksPerAddress?: number };
}

export interface GoogleClient {
  clientId: string;
  clientSecret: string;
}

/** The feature flag. */
export function googleSignInEnabled(options: GoogleSignInOptions = {}): boolean {
  return options.enabled ?? (options.env ?? process.env).CITY_GOOGLE_SIGNIN === '1';
}

/**
 * The Google birthday scope for the link (user.birthday.read). Off by default: Google must verify
 * the app for this sensitive scope first. Without it, the owner enters the date of birth.
 */
export function googleBirthdayScopeEnabled(options: GoogleSignInOptions = {}): boolean {
  return (options.env ?? process.env).CITY_GOOGLE_BIRTHDAY_SCOPE === '1';
}

/** The OAuth client, or null when the flag is off or either value is missing. */
export function googleClient(options: GoogleSignInOptions = {}): GoogleClient | null {
  if (!googleSignInEnabled(options)) return null;
  const env = options.env ?? process.env;
  const clientId = env.GOOGLE_OAUTH_CLIENT_ID?.trim();
  const clientSecret = env.GOOGLE_OAUTH_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

/** The production transport: no redirects, a timeout, and a bounded body. */
export const fetchTransport: GoogleTransport = async (request) => {
  const response = await fetch(request.url, {
    method: request.method,
    headers: request.headers,
    ...(request.body === undefined ? {} : { body: request.body }),
    redirect: 'error',
    signal: AbortSignal.timeout(GOOGLE_LIMITS.timeoutMs),
  });
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader)
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > GOOGLE_LIMITS.responseBytes) {
        await reader.cancel();
        throw new Error('Google response too large.');
      }
      chunks.push(value);
    }
  const headers: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    headers[name.toLowerCase()] = value;
  });
  return {
    status: response.status,
    headers,
    body: Buffer.concat(chunks).toString('utf8'),
  };
};
