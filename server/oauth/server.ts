import { assertOnboarded } from '../onboarding.js';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  ASSISTANT_SCOPES,
  FIXED_GRANT_DAYS,
  ROLLING_GRANT_DAYS,
  grantRenewal,
  rollingGrantCeiling,
  type AssistantScope,
} from '../../shared/assistant.js';
import type { Operator } from '../../shared/types.js';
import type { AssistantAccess } from '../assistant-access.js';
import type { Database, Transaction as Tx } from '../database.js';
import type { HostedConfig } from '../hosted.js';
import { event, type Workspace } from '../model.js';
import {
  ClientError,
  cleanClientName,
  fetchClientMetadataDocument,
  isMetadataDocumentClientId,
  parseMetadataDocumentUrl,
  redirectUriAllowed,
  validateMetadataDocument,
  validateRegistration,
  type ClientMetadataFetcher,
  type ResolvedClient,
} from './clients.js';
import {
  consentPage,
  errorLinkPage,
  errorPage,
  loginPage,
  PAGE_HEADERS,
  redirectPage,
  type ConsentView,
} from './pages.js';
import {
  ASSERTION_ALGS,
  ASSERTION_LIMITS,
  candidateKeys,
  CLIENT_ASSERTION_TYPE,
  ClientAuthError,
  decodeAssertion,
  signingKeys,
  verifyAssertion,
} from './client-auth.js';
import { clientAddressKey } from '../rate-limit.js';

export const OAUTH_LIFETIMES = {
  accessTokenMs: 60 * 60_000,
  codeMs: 2 * 60_000,
  pendingMs: 10 * 60_000,
  /**
   * Margin after an authorization code expires before its never-exchanged grant is released
   * (absorbs clock skew between instances; an expired code can no longer be exchanged).
   */
  codeGraceMs: 60_000,
} as const;
/**
 * The one advisory lock every dynamic client registration takes first, so the capacity count,
 * eviction and insert are serialized across instances ("cc-oadcr" as a 64-bit key).
 */
export const CLIENT_REGISTRATION_LOCK_KEY = '7161617788847809394';
/**
 * Global table bounds. Unauthenticated state never refuses service at these bounds: the oldest
 * unauthenticated pending requests and never-used registrations are evicted instead.
 */
export const OAUTH_CAPS = {
  clients: 1000,
  registrationsPerAddressPerDay: 50,
  pending: 500,
  /** Authorization-page loads per address (/64 for IPv6) in 15 minutes. */
  authorizePerAddress: 60,
  cleanupBatch: 500,
  /**
   * Rotated refresh tokens kept per family as reuse-detection tombstones (newest first). Older
   * ones are pruned; presenting one still revokes the family through its embedded family id.
   */
  rotatedPerFamily: 50,
  /** Owners whose never-exchanged grants one token request releases. */
  releaseBatch: 5,
  /** Metadata documents and JWK Sets cached per instance for private_key_jwt verification. */
  keyCacheEntries: 200,
  keyCacheMs: 5 * 60_000,
  /** A JWK Set is fetched again for an unknown kid (key rotation) at most this often. */
  keyRefetchMs: 30_000,
} as const;
export const MCP_PATH = '/mcp';
export const PROTECTED_RESOURCE_PATH = '/.well-known/oauth-protected-resource';

export interface OAuthDependencies {
  db: Database;
  access: AssistantAccess;
  mutate<T>(
    operatorId: string,
    action: (workspace: Workspace, tx: Tx, time: number) => T | Promise<T>,
  ): Promise<T>;
  limit(key: string, max: number, window: number): Promise<void>;
  clock(): number;
  optionalOperator(request: FastifyRequest): Promise<Operator | null>;
  authenticate(values: unknown, address: string, request: FastifyRequest): Promise<Operator>;
  /** Sets the known-device cookie after a successful sign-in. */
  rememberDevice(reply: FastifyReply, operatorId: string): void;
  /** Starts a browser session (the `cc_session` cookie) for an owner who just signed in. */
  startSession(reply: FastifyReply, operatorId: string): Promise<void>;
  hosted?: HostedConfig;
  secureCookies: boolean;
  fetchClientMetadata?: ClientMetadataFetcher;
}

/** An OAuth protocol error with its RFC 6749 / 7591 / 8707 error code. */
export class OAuthFailure extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
  get statusCode(): number {
    return this.status;
  }
}
/** A failure shown to the resource owner, never redirected to an unvalidated client. */
export class PageFailure extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
  get statusCode(): number {
    return this.status;
  }
}

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const secret = () => randomBytes(32).toString('base64url');
/**
 * Refresh tokens are `ccr_` + base64url(16-byte family id || 16 random bytes). The family id is
 * an identifier, not a credential (128 random bits remain secret, and only the SHA-256 of the
 * whole token is stored), so a rotated token whose tombstone row was pruned still identifies
 * the family to revoke when it is replayed.
 */
/** Hosts of widely used AI clients whose metadata documents publish their callback there. */
const KNOWN_CLIENT_REDIRECT_HOSTS = new Set(['claude.ai', 'chatgpt.com']);
export function autoRedirectAllowed(verified: boolean, redirectUri: string): boolean {
  if (!verified) return false;
  let url: URL;
  try {
    url = new URL(redirectUri);
  } catch {
    return false;
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (url.protocol === 'http:' && ['127.0.0.1', '::1', 'localhost'].includes(host)) return true;
  return url.protocol === 'https:' && KNOWN_CLIENT_REDIRECT_HOSTS.has(host);
}

function refreshTokenFor(familyId: string): string {
  const id = Buffer.from(familyId.replaceAll('-', ''), 'hex');
  return `ccr_${Buffer.concat([id, randomBytes(16)]).toString('base64url')}`;
}
/**
 * private_key_jwt binding without new columns. Pending requests and token families of a
 * private_key_jwt client get version-8 UUIDs (randomUUID() is always version 4), and their
 * authorization codes start with "jw" (other codes never do). Each marker is read only from an id
 * or code that a database row matched, so a client cannot forge or strip it: from then on the
 * client must authenticate with a signed assertion, and presenting its tokens without one
 * changes nothing.
 */
function jwtBoundId(): string {
  const id = randomUUID();
  return `${id.slice(0, 14)}8${id.slice(15)}`;
}
const isJwtBound = (id: string) => id.charAt(14) === '8';
const JWT_CODE_PREFIX = 'jw';
function authorizationCode(jwt: boolean): string {
  if (jwt) return `${JWT_CODE_PREFIX}${randomBytes(31).toString('base64url').slice(0, 41)}`;
  for (;;) {
    const code = secret();
    if (!code.startsWith(JWT_CODE_PREFIX)) return code;
  }
}
/** The family id embedded in a well-formed refresh token (older random tokens yield none that exists). */
function familyOfRefreshToken(token: string): string | null {
  const bytes = Buffer.from(token.slice(4), 'base64url');
  if (!/^ccr_[A-Za-z0-9_-]{43}$/.test(token) || bytes.length !== 32) return null;
  const hex = bytes.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function sameSecret(value: unknown, expectedHash: string): boolean {
  if (typeof value !== 'string' || value.length > 256) return false;
  const a = Buffer.from(sha(value)),
    b = Buffer.from(expectedHash);
  return a.length === b.length && timingSafeEqual(a, b);
}
export function statusOf(error: unknown): number {
  const status = (error as { statusCode?: unknown })?.statusCode;
  return typeof status === 'number' && status >= 400 && status < 600 ? status : 500;
}

/**
 * The public origin this request was addressed to. Hosted mode accepts only configured
 * HTTPS origins; local mode accepts loopback hosts only. Issuer, resource and redirect
 * metadata are all derived from it, so tokens are bound to the host that issued them.
 */
export function requestOrigin(request: FastifyRequest, hosted: HostedConfig | undefined): string {
  const host = request.headers.host ?? '';
  if (hosted) {
    const origin = `https://${host}`;
    if (!hosted.allowedOrigins.includes(origin))
      throw new OAuthFailure(403, 'invalid_request', 'Host is not allowed.');
    return origin;
  }
  let url: URL;
  try {
    url = new URL(`http://${host}`);
  } catch {
    throw new OAuthFailure(403, 'invalid_request', 'Invalid host.');
  }
  if (
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    `${url.host}` !== host.toLowerCase().replace(/:80$/, '')
  )
    throw new OAuthFailure(
      403,
      'invalid_request',
      'This development server accepts localhost only.',
    );
  return `${request.protocol}://${url.host}`;
}

type TokenRow = {
  family_id: string;
  client_id: string;
  resource: string;
  scopes: AssistantScope[];
  expires_at: string | number;
  revoked_at: string | number | null;
  used_at: string | number | null;
  family_revoked: string | number | null;
  grant_id: string;
  operator_id: string;
  grant_scopes: AssistantScope[];
  grant_created: string | number;
  grant_expires: string | number;
  grant_revoked: string | number | null;
};
const TOKEN_JOIN = `SELECT t.family_id, t.expires_at, t.revoked_at, t.used_at, f.client_id, f.resource,
  f.scopes, f.revoked_at AS family_revoked, g.id AS grant_id, g.operator_id, g.scopes AS grant_scopes,
  g.created_at AS grant_created, g.expires_at AS grant_expires, g.revoked_at AS grant_revoked
  FROM oauth_tokens t JOIN oauth_families f ON f.id=t.family_id JOIN assistant_grants g ON g.id=f.grant_id`;

export interface VerifiedAccess {
  token: string;
  clientId: string;
  scopes: AssistantScope[];
  expiresAt: number;
  resource: string;
  grantId: string;
  operatorId: string;
  familyId: string;
}

type PendingRow = {
  id: string;
  form_hash: string;
  browser_hash: string;
  client_id: string;
  client_name: string;
  client_verified: boolean;
  redirect_uri: string;
  code_challenge: string;
  resource: string;
  scopes: AssistantScope[];
  state: string | null;
  operator_id: string | null;
  expires_at: string | number;
};

export interface OAuthServer {
  /** Resolves a presented access token for the resource at `origin`, or null when unusable. */
  verifyAccessToken(token: string, origin: string): Promise<VerifiedAccess | null>;
}

function parseScopes(value: unknown): AssistantScope[] {
  // A request that names no scope asks for the core set: read, plus joining rooms and creating
  // agent records (the main use case). The consent page shows each one and the owner can untick
  // the write scopes; nothing else is ever granted without being named.
  if (value === undefined || value === '') return ['workspace:read', 'agents:create', 'rooms:join'];
  if (typeof value !== 'string' || value.length > 512)
    throw new OAuthFailure(400, 'invalid_scope', 'The scope parameter is invalid.');
  const requested = new Set(value.split(' ').filter(Boolean));
  requested.delete('offline_access');
  for (const scope of requested)
    if (!(ASSISTANT_SCOPES as readonly string[]).includes(scope))
      throw new OAuthFailure(400, 'invalid_scope', `Unsupported scope: ${scope.slice(0, 40)}`);
  requested.add('workspace:read');
  return ASSISTANT_SCOPES.filter((scope) => requested.has(scope));
}

function formValue(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string')
    throw new OAuthFailure(400, 'invalid_request', `Parameter ${key} must appear once.`);
  return value;
}

export async function registerOAuthRoutes(
  app: FastifyInstance,
  d: OAuthDependencies,
): Promise<OAuthServer> {
  const fetchMetadata = d.fetchClientMetadata ?? fetchClientMetadataDocument;
  const origin = (request: FastifyRequest) => requestOrigin(request, d.hosted);

  function cors(reply: FastifyReply): void {
    reply
      .header('access-control-allow-origin', '*')
      .header('access-control-allow-methods', 'GET, POST, OPTIONS')
      .header('access-control-allow-headers', 'authorization, content-type, mcp-protocol-version')
      .header('access-control-max-age', '600');
  }
  const corsPaths = [
    PROTECTED_RESOURCE_PATH,
    `${PROTECTED_RESOURCE_PATH}${MCP_PATH}`,
    '/.well-known/oauth-authorization-server',
    '/oauth/register',
    '/oauth/token',
    '/oauth/revoke',
  ];
  for (const path of corsPaths)
    app.options(path, async (_request, reply) => {
      cors(reply);
      return reply.code(204).send();
    });

  function protectedResource(base: string) {
    return {
      resource: `${base}${MCP_PATH}`,
      authorization_servers: [base],
      scopes_supported: [...ASSISTANT_SCOPES],
      bearer_methods_supported: ['header'],
      resource_name: 'Central City',
    };
  }
  for (const path of [PROTECTED_RESOURCE_PATH, `${PROTECTED_RESOURCE_PATH}${MCP_PATH}`])
    app.get(path, async (request, reply) => {
      cors(reply);
      return protectedResource(origin(request));
    });
  app.get('/.well-known/oauth-authorization-server', async (request, reply) => {
    cors(reply);
    const base = origin(request);
    return {
      issuer: base,
      authorization_endpoint: `${base}/oauth/authorize`,
      token_endpoint: `${base}/oauth/token`,
      registration_endpoint: `${base}/oauth/register`,
      revocation_endpoint: `${base}/oauth/revoke`,
      response_types_supported: ['code'],
      response_modes_supported: ['query'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      // "none" stays listed: Claude and Codex choose metadata documents only when it is.
      token_endpoint_auth_methods_supported: ['none', 'private_key_jwt'],
      token_endpoint_auth_signing_alg_values_supported: [...ASSERTION_ALGS],
      revocation_endpoint_auth_methods_supported: ['none', 'private_key_jwt'],
      revocation_endpoint_auth_signing_alg_values_supported: [...ASSERTION_ALGS],
      scopes_supported: [...ASSISTANT_SCOPES],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
    };
  });

  // ---- Dynamic client registration (RFC 7591), public clients only -------------------------
  app.post('/oauth/register', async (request, reply) => {
    cors(reply);
    origin(request);
    const address = clientAddressKey(request.ip);
    await d.limit(`oauth-register:${address}`, 20, 15 * 60_000);
    await d.limit(
      `oauth-register-day:${address}`,
      OAUTH_CAPS.registrationsPerAddressPerDay,
      86_400_000,
    );
    let values: ReturnType<typeof validateRegistration>;
    try {
      values = validateRegistration(request.body);
    } catch (error) {
      const message = error instanceof ClientError ? error.message : 'Invalid client metadata.';
      throw new OAuthFailure(
        400,
        /redirect/.test(message) ? 'invalid_redirect_uri' : 'invalid_client_metadata',
        message,
      );
    }
    const time = d.clock();
    const clientId = `ccc_${randomBytes(18).toString('base64url')}`;
    await d.db.transaction(async (tx) => {
      // Taken first: without it, concurrent registrations each count the table, see room and
      // insert, overrunning the bound. Under it the sweep, eviction and insert are one step.
      await tx.query('SELECT pg_advisory_xact_lock($1::bigint)', [CLIENT_REGISTRATION_LOCK_KEY]);
      // Unused self-registrations are disposable; clients with tokens remain registered.
      await tx.query(
        `DELETE FROM oauth_clients c WHERE c.created_at<$1
         AND NOT EXISTS (SELECT 1 FROM oauth_families f WHERE f.client_id=c.client_id)`,
        [time - 86_400_000],
      );
      // At capacity, the oldest never-used registrations make room instead of refusing new
      // clients, so filling the table cannot lock legitimate clients out.
      const count = Number(
        (await tx.query<{ count: string }>('SELECT count(*) FROM oauth_clients')).rows[0]?.count,
      );
      if (count >= OAUTH_CAPS.clients)
        await tx.query(
          `DELETE FROM oauth_clients WHERE client_id IN (
             SELECT c.client_id FROM oauth_clients c
             WHERE NOT EXISTS (SELECT 1 FROM oauth_families f WHERE f.client_id=c.client_id)
               AND NOT EXISTS (SELECT 1 FROM oauth_codes o WHERE o.client_id=c.client_id)
             ORDER BY c.created_at, c.client_id LIMIT $1)`,
          [count - OAUTH_CAPS.clients + 1],
        );
      const remaining = Number(
        (await tx.query<{ count: string }>('SELECT count(*) FROM oauth_clients')).rows[0]?.count,
      );
      if (remaining >= OAUTH_CAPS.clients)
        throw new OAuthFailure(
          503,
          'temporarily_unavailable',
          'Client registration capacity reached. Try again later.',
        );
      await tx.query(
        'INSERT INTO oauth_clients(client_id,client_name,redirect_uris,created_at) VALUES($1,$2,$3::jsonb,$4)',
        [clientId, values.clientName, JSON.stringify(values.redirectUris), time],
      );
    });
    return reply.code(201).send({
      client_id: clientId,
      client_id_issued_at: Math.floor(time / 1000),
      client_name: values.clientName,
      redirect_uris: values.redirectUris,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    });
  });

  async function resolveClient(clientId: string): Promise<ResolvedClient> {
    if (!clientId || clientId.length > 512) throw new PageFailure(400, 'The client_id is missing.');
    if (isMetadataDocumentClientId(clientId)) {
      try {
        const url = parseMetadataDocumentUrl(clientId);
        return validateMetadataDocument(clientId, await fetchMetadata(url));
      } catch (error) {
        throw new PageFailure(
          400,
          error instanceof ClientError
            ? error.message
            : 'The client metadata document could not be verified.',
        );
      }
    }
    const row = (
      await d.db.query<{ client_id: string; client_name: string; redirect_uris: string[] }>(
        'SELECT client_id,client_name,redirect_uris FROM oauth_clients WHERE client_id=$1',
        [clientId],
      )
    ).rows[0];
    if (!row) throw new PageFailure(400, 'This client is not registered.');
    return {
      clientId: row.client_id,
      clientName: cleanClientName(row.client_name, 'Unnamed MCP client'),
      redirectUris: row.redirect_uris,
      verified: false,
      authMethod: 'none',
    };
  }

  function sendPage(reply: FastifyReply, status: number, html: string) {
    return reply.code(status).headers(PAGE_HEADERS).send(html);
  }
  function redirectTarget(
    redirectUri: string,
    issuer: string,
    params: Record<string, string | null | undefined>,
  ): string {
    const url = new URL(redirectUri);
    for (const [key, value] of Object.entries(params))
      if (value !== undefined && value !== null) url.searchParams.set(key, value);
    url.searchParams.set('iss', issuer);
    return url.toString();
  }
  const view = (pending: PendingRow, csrf: string, extra: Partial<ConsentView> = {}) => ({
    requestId: pending.id,
    csrf,
    clientName: pending.client_name,
    clientId: pending.client_id,
    verified: pending.client_verified,
    redirectUri: pending.redirect_uri,
    scopes: pending.scopes,
    ...extra,
  });
  const cookieName = (id: string) => `cc_oauth_${id.replaceAll('-', '')}`;
  const cookieOptions = {
    httpOnly: true,
    secure: d.secureCookies,
    sameSite: 'strict' as const,
    path: '/oauth/authorize',
  };

  // ---- Authorization endpoint --------------------------------------------------------------
  app.get('/oauth/authorize', async (request, reply) => {
    const issuer = origin(request);
    await d.limit(
      `oauth-authorize:${clientAddressKey(request.ip)}`,
      OAUTH_CAPS.authorizePerAddress,
      15 * 60_000,
    );
    const query = request.query as Record<string, unknown>;
    for (const [key, value] of Object.entries(query))
      if (typeof value !== 'string')
        throw new PageFailure(400, `The ${key.slice(0, 40)} parameter must appear once.`);
    const q = query as Record<string, string | undefined>;
    const client = await resolveClient(q.client_id ?? '');
    const redirectUri = q.redirect_uri ?? '';
    if (!redirectUriAllowed(client.redirectUris, redirectUri))
      throw new PageFailure(
        400,
        redirectUriAllowed(client.refusedRedirectUris ?? [], redirectUri)
          ? 'A metadata-document client may only return to its own origin or a loopback address; this redirect_uri is refused.'
          : 'The redirect_uri is not registered for this client.',
      );
    const state = q.state;
    // Error redirects are automatic only where they cannot send the owner to an arbitrary site:
    // loopback (the owner's own machine) or well-known published clients. Anyone can publish a
    // metadata document on their own domain, so "verified" alone is not enough (RFC 9700
    // 4.11.2); every other client gets a page with a link the owner can choose to follow.
    const back = (error: string, description: string) => {
      const target = redirectTarget(redirectUri, issuer, {
        error,
        error_description: description,
        state,
      });
      return autoRedirectAllowed(client.verified, redirectUri)
        ? sendPage(reply, 200, redirectPage(target, client.clientName))
        : sendPage(reply, 400, errorLinkPage(description, target));
    };
    if (state !== undefined && state.length > 1024)
      return back('invalid_request', 'The state parameter is too long.');
    if (q.response_type !== 'code')
      return back('unsupported_response_type', 'Only response_type=code is supported.');
    if (q.code_challenge_method !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(q.code_challenge ?? ''))
      return back('invalid_request', 'PKCE with code_challenge_method=S256 is required.');
    const resource = `${issuer}${MCP_PATH}`;
    if (q.resource !== undefined && q.resource !== resource)
      return back('invalid_target', 'The resource must be this server’s MCP endpoint.');
    let scopes: AssistantScope[];
    try {
      scopes = parseScopes(q.scope);
    } catch (error) {
      return back('invalid_scope', (error as Error).message);
    }
    const time = d.clock();
    const operator = await d.optionalOperator(request);
    const pending: PendingRow = {
      // A private_key_jwt client is marked by the id itself (see jwtBoundId).
      id: client.authMethod === 'private_key_jwt' ? jwtBoundId() : randomUUID(),
      form_hash: '',
      browser_hash: '',
      client_id: client.clientId,
      client_name: client.clientName,
      client_verified: client.verified,
      redirect_uri: redirectUri,
      code_challenge: q.code_challenge!,
      resource,
      scopes,
      state: state ?? null,
      operator_id: operator?.id ?? null,
      expires_at: time + OAUTH_LIFETIMES.pendingMs,
    };
    const csrf = secret(),
      browser = secret();
    await d.db.query('DELETE FROM oauth_pending WHERE expires_at<=$1', [time]);
    // Unauthenticated requests never refuse service at the global bound: the oldest ones are
    // evicted instead. Requests an owner has signed into are kept until they expire.
    const open = Number(
      (await d.db.query<{ count: string }>('SELECT count(*) FROM oauth_pending')).rows[0]?.count,
    );
    if (open >= OAUTH_CAPS.pending)
      await d.db.query(
        `DELETE FROM oauth_pending WHERE id IN (
           SELECT id FROM oauth_pending WHERE operator_id IS NULL
           ORDER BY created_at, id LIMIT $1)`,
        [open - OAUTH_CAPS.pending + 1],
      );
    await d.db.query(
      `INSERT INTO oauth_pending(id,form_hash,browser_hash,client_id,client_name,client_verified,
       redirect_uri,code_challenge,resource,scopes,state,operator_id,created_at,expires_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13,$14)`,
      [
        pending.id,
        sha(csrf),
        sha(browser),
        pending.client_id,
        pending.client_name,
        pending.client_verified,
        pending.redirect_uri,
        pending.code_challenge,
        pending.resource,
        JSON.stringify(scopes),
        pending.state,
        pending.operator_id,
        time,
        pending.expires_at,
      ],
    );
    reply.setCookie(cookieName(pending.id), browser, {
      ...cookieOptions,
      maxAge: OAUTH_LIFETIMES.pendingMs / 1000,
    });
    return sendPage(
      reply,
      200,
      operator
        ? consentPage(view(pending, csrf, { operatorName: operator.name }))
        : loginPage(view(pending, csrf)),
    );
  });

  app.post('/oauth/authorize', async (request, reply) => {
    const issuer = origin(request);
    await d.limit(
      `oauth-authorize:${clientAddressKey(request.ip)}`,
      OAUTH_CAPS.authorizePerAddress,
      15 * 60_000,
    );
    // Browser form posts carry Origin. A foreign origin is refused. `Origin: null` (sent by some
    // browsers under strict referrer policies) is accepted only when the browser also attests
    // the request is same-origin with Sec-Fetch-Site; CSRF token and flow cookie still apply.
    const requestOriginHeader = request.headers.origin;
    const fetchSite = request.headers['sec-fetch-site'];
    if (fetchSite !== undefined && fetchSite !== 'same-origin')
      throw new PageFailure(403, 'Cross-site authorization requests are not allowed.');
    if (
      requestOriginHeader !== undefined &&
      requestOriginHeader !== issuer &&
      !(requestOriginHeader === 'null' && fetchSite === 'same-origin')
    )
      throw new PageFailure(403, 'Cross-site authorization requests are not allowed.');
    if (!request.headers['content-type']?.startsWith('application/x-www-form-urlencoded'))
      throw new PageFailure(415, 'Unsupported form encoding.');
    const body = (request.body ?? {}) as Record<string, unknown>;
    const requestId = formValue(body, 'request_id') ?? '';
    const csrf = formValue(body, 'csrf') ?? '';
    const action = formValue(body, 'action');
    const invalid = 'This authorization request expired or is invalid.';
    if (!/^[0-9a-f-]{36}$/.test(requestId)) throw new PageFailure(400, invalid);
    const time = d.clock();
    const pending = (
      await d.db.query<PendingRow>('SELECT * FROM oauth_pending WHERE id=$1', [requestId])
    ).rows[0];
    if (
      !pending ||
      Number(pending.expires_at) <= time ||
      !sameSecret(csrf, pending.form_hash) ||
      !sameSecret(request.cookies[cookieName(requestId)], pending.browser_hash)
    )
      throw new PageFailure(400, invalid);
    const finish = async (params: Record<string, string | null | undefined>) => {
      reply.clearCookie(cookieName(requestId), cookieOptions);
      return sendPage(
        reply,
        200,
        redirectPage(
          redirectTarget(pending.redirect_uri, issuer, { ...params, state: pending.state }),
          pending.client_name,
        ),
      );
    };
    if (action === 'deny') {
      await d.db.query('DELETE FROM oauth_pending WHERE id=$1', [requestId]);
      return finish({ error: 'access_denied', error_description: 'The owner denied access.' });
    }
    if (action === 'login') {
      await d.limit(`login:${clientAddressKey(request.ip)}`, 20, 15 * 60_000);
      let operator: Operator;
      try {
        operator = await d.authenticate(
          {
            name: formValue(body, 'name') ?? '',
            password: formValue(body, 'password') ?? '',
          },
          clientAddressKey(request.ip),
          request,
        );
        d.rememberDevice(reply, operator.id);
        // Signing in here signs the browser in, like the sign-in page: approval then acts for
        // the current session only (below), so signing out cancels an open request.
        await d.startSession(reply, operator.id);
      } catch (error) {
        const status = error instanceof z.ZodError ? 401 : statusOf(error);
        if (status >= 500) throw error;
        return sendPage(
          reply,
          status === 429 ? 429 : 401,
          loginPage(
            view(pending, csrf, {
              error:
                status === 429
                  ? 'Too many sign-in attempts. Try again later.'
                  : 'Invalid account name or password.',
            }),
          ),
        );
      }
      await d.db.query('UPDATE oauth_pending SET operator_id=$2 WHERE id=$1', [
        requestId,
        operator.id,
      ]);
      return sendPage(
        reply,
        200,
        consentPage(view(pending, csrf, { operatorName: operator.name })),
      );
    }
    if (action !== 'approve') throw new PageFailure(400, 'Unknown action.');
    // Approval acts for whoever is signed in now, and only for the owner this request was shown
    // to (or signed in for): signing out, or another owner signing in on the same browser,
    // cancels the owner's open request instead of approving it for them.
    const current = await d.optionalOperator(request);
    // A mismatch keeps the stamp: only signing in on this form re-stamps the request.
    if (!current || (pending.operator_id !== null && pending.operator_id !== current.id))
      return sendPage(
        reply,
        401,
        loginPage(
          view(pending, csrf, {
            error: current
              ? 'The signed-in account changed. Sign in again to approve.'
              : 'Sign in before approving.',
          }),
        ),
      );
    const operatorId = current.id;
    const selected = body.scope === undefined ? [] : [body.scope].flat();
    const scopes = pending.scopes.filter(
      (scope) => scope === 'workspace:read' || selected.includes(scope),
    );
    // The consent page pre-checks "Until I disconnect", but only an explicit choice grants it: a
    // missing or unknown value falls back to the shortest fixed lifetime (FIXED_GRANT_DAYS[0]).
    const choice = formValue(body, 'expires_in_days');
    const days =
      choice === 'rolling'
        ? choice
        : (FIXED_GRANT_DAYS.find((option) => String(option) === choice) ?? FIXED_GRANT_DAYS[0]);
    const code = authorizationCode(isJwtBound(pending.id));
    await d.mutate(operatorId, async (workspace, tx, now) => {
      const claimed = await tx.query('DELETE FROM oauth_pending WHERE id=$1 RETURNING id', [
        requestId,
      ]);
      if (!claimed.rows.length) throw new PageFailure(400, invalid);
      // Dead grants (code expired, never exchanged) must not count against the active-grant bound.
      await releaseUnexchanged(workspace, tx, now, operatorId);
      const { grant } = await d.access.insertGrant(workspace, tx, now, operatorId, {
        label: pending.client_name,
        scopes,
        expiresInDays: days,
      });
      await tx.query(
        `INSERT INTO oauth_codes(code_hash,grant_id,client_id,redirect_uri,code_challenge,resource,scopes,expires_at)
         VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8)`,
        [
          sha(code),
          grant.id,
          pending.client_id,
          pending.redirect_uri,
          pending.code_challenge,
          pending.resource,
          JSON.stringify(scopes),
          now + OAUTH_LIFETIMES.codeMs,
        ],
      );
    });
    return finish({ code });
  });

  // ---- Token endpoint ----------------------------------------------------------------------
  async function issueTokens(tx: Tx, familyId: string, time: number, grantExpires: number) {
    const access = `cca_${secret()}`,
      refresh = refreshTokenFor(familyId);
    const accessExpires = Math.min(time + OAUTH_LIFETIMES.accessTokenMs, grantExpires);
    await tx.query(
      `INSERT INTO oauth_tokens(token_hash,family_id,kind,created_at,expires_at) VALUES
       ($1,$3,'access',$4,$5),($2,$3,'refresh',$4,$6)`,
      [sha(access), sha(refresh), familyId, time, accessExpires, grantExpires],
    );
    return {
      access_token: access,
      token_type: 'Bearer',
      expires_in: Math.max(1, Math.floor((accessExpires - time) / 1000)),
      refresh_token: refresh,
    };
  }
  /** Revokes a token family; its id is recorded so an idle grant can be retired afterwards. */
  async function revokeFamily(tx: Tx, familyId: string, time: number, retired: string[]) {
    retired.push(familyId);
    await tx.query('UPDATE oauth_families SET revoked_at=$2 WHERE id=$1 AND revoked_at IS NULL', [
      familyId,
      time,
    ]);
    await tx.query(
      'UPDATE oauth_tokens SET revoked_at=$2 WHERE family_id=$1 AND revoked_at IS NULL',
      [familyId, time],
    );
  }
  /**
   * After a family is revoked, a grant with no remaining live family is revoked too, so it
   * frees the active-grant bound and shows as revoked under AI connections.
   */
  async function retireIdleGrants(familyIds: readonly string[]): Promise<void> {
    for (const familyId of new Set(familyIds)) {
      const owner = (
        await d.db.query<{ grant_id: string; operator_id: string }>(
          `SELECT f.grant_id, g.operator_id FROM oauth_families f
           JOIN assistant_grants g ON g.id=f.grant_id WHERE f.id=$1`,
          [familyId],
        )
      ).rows[0];
      if (!owner) continue;
      await d.mutate(owner.operator_id, async (workspace, tx, time) => {
        const live = await tx.query(
          'SELECT 1 FROM oauth_families WHERE grant_id=$1 AND revoked_at IS NULL LIMIT 1',
          [owner.grant_id],
        );
        if (live.rows.length) return;
        const grant = (
          await tx.query<{ label: string }>(
            'UPDATE assistant_grants SET revoked_at=$2 WHERE id=$1 AND revoked_at IS NULL RETURNING label',
            [owner.grant_id, time],
          )
        ).rows[0];
        if (grant)
          event(
            workspace,
            time,
            'assistant.revoked',
            `Assistant grant ${owner.grant_id} (${grant.label}) revoked because its OAuth tokens were revoked.`,
          );
      });
    }
  }
  /**
   * Revokes, with an audit event, the owner's grants whose authorization code expired without
   * ever being exchanged: they have no token family and can never produce a token, so they must
   * not hold an active-grant slot until they expire. Only grants that still have
   * their OAuth code row qualify, so grants for the local bridge are never touched. Runs inside
   * the owner's workspace mutation. Returns the number released.
   */
  async function releaseUnexchanged(
    workspace: Workspace,
    tx: Tx,
    time: number,
    operatorId: string,
  ): Promise<number> {
    const released = (
      await tx.query<{ id: string; label: string }>(
        `UPDATE assistant_grants g SET revoked_at=$2
          WHERE g.operator_id=$1 AND g.revoked_at IS NULL AND g.expires_at>$2
          AND EXISTS (SELECT 1 FROM oauth_codes c WHERE c.grant_id=g.id)
          AND NOT EXISTS (SELECT 1 FROM oauth_codes c WHERE c.grant_id=g.id
            AND (c.expires_at>$3 OR c.family_id IS NOT NULL))
          AND NOT EXISTS (SELECT 1 FROM oauth_families f WHERE f.grant_id=g.id)
          RETURNING g.id, g.label`,
        [operatorId, time, time - OAUTH_LIFETIMES.codeGraceMs],
      )
    ).rows;
    for (const grant of released)
      event(
        workspace,
        time,
        'assistant.revoked',
        `Assistant grant ${grant.id} (${grant.label}) released because its authorization code expired without being exchanged.`,
      );
    return released.length;
  }
  /** Releases never-exchanged grants of the owners found by cleanup, one mutation per owner. */
  async function releaseStaleGrants(operatorIds: readonly string[]): Promise<void> {
    for (const operatorId of new Set(operatorIds))
      await d.mutate(operatorId, (workspace, tx, time) =>
        releaseUnexchanged(workspace, tx, time, operatorId),
      );
  }
  /**
   * Bounded removal of rows that can no longer authorize anything. Reuse-detection state is kept
   * for as long as it protects a live grant: an exchanged code and the newest rotated refresh
   * tokens (OAUTH_CAPS.rotatedPerFamily, pruned at rotation) stay until the grant expires or is
   * revoked or their family is revoked. A never-exchanged code stays until its grant is released.
   * Returns owners with never-exchanged grants to release after the transaction.
   */
  async function cleanup(tx: Tx, time: number): Promise<string[]> {
    const batch = OAUTH_CAPS.cleanupBatch;
    await tx.query(
      `DELETE FROM oauth_codes WHERE code_hash IN (
         SELECT c.code_hash FROM oauth_codes c
         LEFT JOIN assistant_grants g ON g.id=c.grant_id
         LEFT JOIN oauth_families f ON f.id=c.family_id
         WHERE c.expires_at<=$1 AND (g.id IS NULL OR g.revoked_at IS NOT NULL
           OR g.expires_at<=$2 OR f.revoked_at IS NOT NULL)
         LIMIT $3)`,
      [time - OAUTH_LIFETIMES.codeGraceMs, time, batch],
    );
    // Expired or revoked tokens. Rotated refresh tokens expire with their grant; revoked
    // families persist on the family row, not on token rows.
    await tx.query(
      `DELETE FROM oauth_tokens WHERE token_hash IN (
         SELECT token_hash FROM oauth_tokens WHERE expires_at<=$1 OR revoked_at IS NOT NULL LIMIT $2)`,
      [time, batch],
    );
    await tx.query(
      `DELETE FROM oauth_families WHERE id IN (
         SELECT id FROM oauth_families WHERE revoked_at<=$1 LIMIT $2)`,
      [time - 86_400_000, batch],
    );
    // Expired client-assertion jti tombstones (see authenticateClient).
    await tx.query(
      `DELETE FROM replay_nonces WHERE (agent_id,nonce) IN (
         SELECT agent_id,nonce FROM replay_nonces
         WHERE agent_id LIKE 'oauth-assertion:%' AND expires_at<=$1 LIMIT $2)`,
      [time, batch],
    );
    return (
      await tx.query<{ operator_id: string }>(
        `SELECT DISTINCT g.operator_id FROM assistant_grants g JOIN oauth_codes c ON c.grant_id=g.id
          WHERE g.revoked_at IS NULL AND g.expires_at>$1 AND c.expires_at<=$2
          AND c.family_id IS NULL AND NOT EXISTS (SELECT 1 FROM oauth_families f WHERE f.grant_id=g.id)
          LIMIT $3`,
        [time, time - OAUTH_LIFETIMES.codeGraceMs, OAUTH_CAPS.releaseBatch],
      )
    ).rows.map((row) => row.operator_id);
  }
  function formBody(request: FastifyRequest): Record<string, string | undefined> {
    if (!request.headers['content-type']?.startsWith('application/x-www-form-urlencoded'))
      throw new OAuthFailure(400, 'invalid_request', 'Use application/x-www-form-urlencoded.');
    const body = (request.body ?? {}) as Record<string, unknown>;
    const values: Record<string, string | undefined> = {};
    for (const key of Object.keys(body)) values[key] = formValue(body, key);
    return values;
  }
  function clientIdOf(request: FastifyRequest, body: Record<string, string | undefined>): string {
    let clientId = body.client_id;
    const basic = request.headers.authorization;
    if (typeof basic === 'string' && /^Basic /i.test(basic)) {
      let fromHeader: string;
      try {
        const encoded = basic.slice(6).trim();
        if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new Error();
        fromHeader = decodeURIComponent(
          Buffer.from(encoded, 'base64').toString('utf8').split(':')[0] ?? '',
        );
      } catch {
        throw new OAuthFailure(400, 'invalid_client', 'Malformed Basic client authentication.');
      }
      if (clientId !== undefined && clientId !== fromHeader)
        throw new OAuthFailure(401, 'invalid_client', 'Conflicting client identification.');
      clientId = fromHeader;
    }
    if (!clientId || clientId.length > 512)
      throw new OAuthFailure(401, 'invalid_client', 'client_id is required.');
    return clientId;
  }

  /** Metadata documents and JWK Sets for private_key_jwt, cached per instance (bounded, TTL). */
  const keyCache = new Map<string, { at: number; value: unknown }>();
  async function cachedDocument(url: string, maxAgeMs: number = OAUTH_CAPS.keyCacheMs) {
    const time = d.clock();
    const hit = keyCache.get(url);
    if (hit && time - hit.at < maxAgeMs) return hit.value;
    const value = await fetchMetadata(new URL(url));
    keyCache.delete(url);
    keyCache.set(url, { at: time, value });
    for (const stale of keyCache.keys()) {
      if (keyCache.size <= OAUTH_CAPS.keyCacheEntries) break;
      keyCache.delete(stale);
    }
    return value;
  }
  type ClientAuth = { clientId: string; method: 'none' | 'private_key_jwt' };
  /**
   * Identifies the client of a token or revocation request. Without a client assertion it is a
   * public client named by client_id. With one (RFC 7523), the assertion must verify against the
   * keys of the metadata document its iss names, which must declare private_key_jwt; its jti is
   * then recorded until the assertion expires, so each assertion is accepted once. Keys are never
   * taken from the JWT header, and all network I/O happens before any transaction starts.
   */
  async function authenticateClient(
    request: FastifyRequest,
    body: Record<string, string | undefined>,
    audiences: string[],
  ): Promise<ClientAuth> {
    const type = body.client_assertion_type;
    const assertion = body.client_assertion;
    if (type === undefined && assertion === undefined)
      return { clientId: clientIdOf(request, body), method: 'none' };
    const refuse = (message: string): never => {
      throw new OAuthFailure(401, 'invalid_client', message);
    };
    if (type !== CLIENT_ASSERTION_TYPE || !assertion)
      refuse(`Client assertions need client_assertion_type ${CLIENT_ASSERTION_TYPE}.`);
    if (typeof request.headers.authorization === 'string')
      refuse('Use exactly one client authentication method.');
    let decoded: ReturnType<typeof decodeAssertion>;
    try {
      decoded = decodeAssertion(assertion!);
    } catch (error) {
      return refuse((error as Error).message);
    }
    const clientId = decoded.claims.iss;
    if (
      typeof clientId !== 'string' ||
      !isMetadataDocumentClientId(clientId) ||
      (body.client_id !== undefined && body.client_id !== clientId)
    )
      return refuse('The client assertion must name this metadata-document client as its iss.');
    let client: ResolvedClient;
    let keys: ReturnType<typeof signingKeys>;
    try {
      client = validateMetadataDocument(
        clientId,
        await cachedDocument(parseMetadataDocumentUrl(clientId).href),
      );
      if (client.authMethod !== 'private_key_jwt')
        return refuse('This client does not use private_key_jwt.');
      keys = signingKeys(client.jwks ?? (await cachedDocument(client.jwksUri!)));
      // An unknown kid may mean the client rotated its keys: fetch its JWK Set again (throttled).
      if (client.jwksUri && !candidateKeys(decoded, keys).length)
        keys = signingKeys(await cachedDocument(client.jwksUri, OAUTH_CAPS.keyRefetchMs));
    } catch (error) {
      if (error instanceof OAuthFailure) throw error;
      return refuse(
        error instanceof ClientError || error instanceof ClientAuthError
          ? error.message
          : 'The client metadata document or keys could not be retrieved.',
      );
    }
    const time = d.clock();
    let verified: ReturnType<typeof verifyAssertion>;
    try {
      verified = verifyAssertion(decoded, keys, { clientId, audiences, now: time });
    } catch (error) {
      return refuse((error as Error).message);
    }
    // Single use: the jti is kept (hashed, in the replay table) until the assertion expires.
    const recorded = await d.db.query(
      `INSERT INTO replay_nonces(agent_id,nonce,expires_at) VALUES($1,$2,$3)
        ON CONFLICT (agent_id,nonce) DO UPDATE SET expires_at=EXCLUDED.expires_at
        WHERE replay_nonces.expires_at<=$4 RETURNING nonce`,
      [
        `oauth-assertion:${sha(clientId).slice(0, 32)}`,
        sha(verified.jti),
        verified.expiresAt + ASSERTION_LIMITS.skewMs,
        time,
      ],
    );
    if (!recorded.rows.length) refuse('The client assertion was already used.');
    return { clientId, method: 'private_key_jwt' };
  }
  /** A token family (or code) bound to private_key_jwt accepts only that method, and vice versa. */
  function requireMethod(auth: ClientAuth, jwtBound: boolean): void {
    if (jwtBound !== (auth.method === 'private_key_jwt'))
      throw new OAuthFailure(
        401,
        'invalid_client',
        jwtBound
          ? 'This client must authenticate with a private_key_jwt client assertion.'
          : 'This client authenticates without a client assertion.',
      );
  }

  app.post('/oauth/token', async (request, reply) => {
    cors(reply);
    const issuer = origin(request);
    await d.limit(`oauth-token:${clientAddressKey(request.ip)}`, 60, 60_000);
    reply.header('pragma', 'no-cache');
    const retired: string[] = [];
    let stale: string[] = [];
    const body = formBody(request);
    const auth = await authenticateClient(request, body, [issuer, `${issuer}/oauth/token`]);
    const clientId = auth.clientId;
    const resource = `${issuer}${MCP_PATH}`;
    if (body.resource !== undefined && body.resource !== resource)
      throw new OAuthFailure(400, 'invalid_target', 'The resource must be this MCP endpoint.');
    const time = d.clock();
    if (body.grant_type === 'authorization_code') {
      const code = body.code ?? '',
        verifier = body.code_verifier ?? '';
      if (!/^[A-Za-z0-9_-]{43}$/.test(code))
        throw new OAuthFailure(400, 'invalid_grant', 'The authorization code is invalid.');
      if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier))
        throw new OAuthFailure(400, 'invalid_grant', 'A valid PKCE code_verifier is required.');
      const result = await d.db.transaction(async (tx) => {
        stale = await cleanup(tx, time);
        const row = (
          await tx.query<{
            grant_id: string;
            client_id: string;
            redirect_uri: string;
            code_challenge: string;
            resource: string;
            scopes: AssistantScope[];
            expires_at: string | number;
            used_at: string | number | null;
            family_id: string | null;
          }>('SELECT * FROM oauth_codes WHERE code_hash=$1 FOR UPDATE', [sha(code)])
        ).rows[0];
        if (!row) return null;
        // Before anything changes: a private_key_jwt client's code needs its signed assertion.
        requireMethod(auth, code.startsWith(JWT_CODE_PREFIX));
        if (row.used_at !== null) {
          // Replayed code: the tokens it produced may be stolen.
          if (row.family_id) await revokeFamily(tx, row.family_id, time, retired);
          return null;
        }
        await tx.query('UPDATE oauth_codes SET used_at=$2 WHERE code_hash=$1', [sha(code), time]);
        const challenge = createHash('sha256').update(verifier).digest('base64url');
        if (
          Number(row.expires_at) <= time ||
          row.client_id !== clientId ||
          row.redirect_uri !== body.redirect_uri ||
          row.resource !== resource ||
          !timingSafeEqual(Buffer.from(challenge), Buffer.from(row.code_challenge.padEnd(43)))
        )
          return null;
        const grant = (
          await tx.query<{ expires_at: string | number; revoked_at: string | number | null }>(
            'SELECT expires_at,revoked_at FROM assistant_grants WHERE id=$1',
            [row.grant_id],
          )
        ).rows[0];
        if (!grant || grant.revoked_at !== null || Number(grant.expires_at) <= time) return null;
        const familyId = auth.method === 'private_key_jwt' ? jwtBoundId() : randomUUID();
        await tx.query(
          'INSERT INTO oauth_families(id,grant_id,client_id,resource,scopes,created_at) VALUES($1,$2,$3,$4,$5::jsonb,$6)',
          [familyId, row.grant_id, clientId, row.resource, JSON.stringify(row.scopes), time],
        );
        await tx.query('UPDATE oauth_codes SET family_id=$2 WHERE code_hash=$1', [
          sha(code),
          familyId,
        ]);
        return {
          ...(await issueTokens(tx, familyId, time, Number(grant.expires_at))),
          scope: row.scopes.join(' '),
        };
      });
      await retireIdleGrants(retired);
      await releaseStaleGrants(stale);
      if (!result)
        throw new OAuthFailure(
          400,
          'invalid_grant',
          'The authorization code is invalid, expired, already used or does not match this request.',
        );
      return result;
    }
    if (body.grant_type === 'refresh_token') {
      const presented = body.refresh_token ?? '';
      if (!/^ccr_[A-Za-z0-9_-]{43}$/.test(presented))
        throw new OAuthFailure(400, 'invalid_grant', 'The refresh token is invalid.');
      const result = await d.db.transaction(async (tx) => {
        stale = await cleanup(tx, time);
        const row = (
          await tx.query<TokenRow>(
            `${TOKEN_JOIN} WHERE t.token_hash=$1 AND t.kind='refresh' FOR UPDATE OF t`,
            [sha(presented)],
          )
        ).rows[0];
        if (!row) {
          // No row: a rotated token pruned beyond the per-family cap (or one never issued). Its
          // embedded family id still names the family, which is revoked while its grant is live,
          // so reuse is detected at any time before the grant ends.
          const familyId = familyOfRefreshToken(presented);
          const live = familyId
            ? (
                await tx.query<{ id: string; client_id: string }>(
                  `SELECT f.id, f.client_id FROM oauth_families f JOIN assistant_grants g ON g.id=f.grant_id
                    WHERE f.id=$1 AND f.revoked_at IS NULL AND g.revoked_at IS NULL AND g.expires_at>$2`,
                  [familyId, time],
                )
              ).rows[0]
            : undefined;
          if (live) {
            // A private_key_jwt family is revoked only at the request of its own client.
            if (isJwtBound(live.id)) {
              requireMethod(auth, true);
              if (live.client_id !== clientId) return null;
            }
            await revokeFamily(tx, live.id, time, retired);
          }
          return null;
        }
        // Checked first, so presenting a private_key_jwt family's token without its client's
        // assertion changes nothing: a stolen token alone can neither be used nor burned.
        requireMethod(auth, isJwtBound(row.family_id));
        if (row.used_at !== null || row.revoked_at !== null) {
          // Reuse of a rotated refresh token: revoke the whole family (RFC 9700 §4.14.2).
          await revokeFamily(tx, row.family_id, time, retired);
          return null;
        }
        if (
          row.family_revoked !== null ||
          Number(row.expires_at) <= time ||
          row.client_id !== clientId ||
          row.resource !== resource ||
          row.grant_revoked !== null ||
          Number(row.grant_expires) <= time
        )
          return null;
        if (body.scope !== undefined) {
          const requested = body.scope
            .split(' ')
            .filter((scope) => scope && scope !== 'offline_access');
          if (!requested.every((scope) => row.scopes.includes(scope as AssistantScope)))
            throw new OAuthFailure(400, 'invalid_scope', 'Refresh cannot widen the granted scope.');
          // Tokens carry the family's scopes, so a narrower request is refused rather than
          // silently answered with the full set (checked before the token is rotated).
          if (requested.length && new Set(requested).size < row.scopes.length)
            throw new OAuthFailure(
              400,
              'invalid_scope',
              'Refresh keeps the granted scope: omit scope or request the granted scopes.',
            );
        }
        await tx.query('UPDATE oauth_tokens SET used_at=$2 WHERE token_hash=$1', [
          sha(presented),
          time,
        ]);
        // The rotated token stays as a reuse-detection tombstone until the grant ends; only the
        // newest OAUTH_CAPS.rotatedPerFamily are kept, so a family's rows stay bounded.
        await tx.query(
          `DELETE FROM oauth_tokens WHERE token_hash IN (
             SELECT token_hash FROM oauth_tokens
             WHERE family_id=$1 AND kind='refresh' AND used_at IS NOT NULL
             ORDER BY used_at DESC, created_at DESC, token_hash OFFSET $2)`,
          [row.family_id, OAUTH_CAPS.rotatedPerFamily],
        );
        // A rolling grant is renewed by use: each successful exchange moves its end to
        // now + ROLLING_GRANT_DAYS (same clock as every other check here), but never past its
        // ceiling (created + ROLLING_GRANT_MAX_DAYS); from then on it has expired like any grant
        // and refresh fails with invalid_grant. The ceiling exceeds the initial ROLLING_GRANT_DAYS,
        // so a capped grant is still classified `rolling`. Fixed grants keep theirs.
        let grantExpires = Number(row.grant_expires);
        const grantCreated = Number(row.grant_created);
        if (grantRenewal(grantCreated, grantExpires) === 'rolling') {
          const renewed = (
            await tx.query<{ expires_at: string | number }>(
              `UPDATE assistant_grants SET expires_at=LEAST(GREATEST(expires_at,$2),$3)
               WHERE id=$1 AND revoked_at IS NULL RETURNING expires_at`,
              [
                row.grant_id,
                time + ROLLING_GRANT_DAYS * 86_400_000,
                rollingGrantCeiling(grantCreated),
              ],
            )
          ).rows[0];
          // Revoked concurrently: issue nothing.
          if (!renewed) return null;
          grantExpires = Number(renewed.expires_at);
          // At or past the ceiling the grant has expired: refuse rather than mint dead tokens.
          if (grantExpires <= time) return null;
        }
        return {
          ...(await issueTokens(tx, row.family_id, time, grantExpires)),
          scope: row.scopes.join(' '),
        };
      });
      await retireIdleGrants(retired);
      await releaseStaleGrants(stale);
      if (!result)
        throw new OAuthFailure(
          400,
          'invalid_grant',
          'The refresh token is invalid, expired, revoked or was already used.',
        );
      return result;
    }
    throw new OAuthFailure(
      400,
      'unsupported_grant_type',
      'Only authorization_code and refresh_token grants are supported.',
    );
  });

  // ---- Revocation (RFC 7009) ----------------------------------------------------------------
  app.post('/oauth/revoke', async (request, reply) => {
    cors(reply);
    const issuer = origin(request);
    await d.limit(`oauth-token:${clientAddressKey(request.ip)}`, 60, 60_000);
    const body = formBody(request);
    const auth = await authenticateClient(request, body, [
      issuer,
      `${issuer}/oauth/token`,
      `${issuer}/oauth/revoke`,
    ]);
    const clientId = auth.clientId;
    const token = body.token ?? '';
    if (!token) throw new OAuthFailure(400, 'invalid_request', 'token is required.');
    if (/^cc[ar]_[A-Za-z0-9_-]{43}$/.test(token)) {
      const time = d.clock();
      const retired: string[] = [];
      await d.db.transaction(async (tx) => {
        const familyId = token.startsWith('ccr_') ? familyOfRefreshToken(token) : null;
        const row =
          (
            await tx.query<{ kind: string; family_id: string; client_id: string }>(
              `SELECT t.kind, t.family_id, f.client_id FROM oauth_tokens t
             JOIN oauth_families f ON f.id=t.family_id WHERE t.token_hash=$1`,
              [sha(token)],
            )
          ).rows[0] ??
          // A rotated refresh token whose tombstone was pruned still names its family.
          (familyId
            ? (
                await tx.query<{ kind: string; family_id: string; client_id: string }>(
                  "SELECT 'refresh' AS kind, id AS family_id, client_id FROM oauth_families WHERE id=$1",
                  [familyId],
                )
              ).rows[0]
            : undefined);
        // Tokens of other clients, and of a private_key_jwt client without its assertion, are left
        // untouched; the response is identical (RFC 7009 §2.2).
        if (
          !row ||
          row.client_id !== clientId ||
          isJwtBound(row.family_id) !== (auth.method === 'private_key_jwt')
        )
          return;
        if (row.kind === 'refresh') await revokeFamily(tx, row.family_id, time, retired);
        else
          await tx.query(
            'UPDATE oauth_tokens SET revoked_at=$2 WHERE token_hash=$1 AND revoked_at IS NULL',
            [sha(token), time],
          );
      });
      await retireIdleGrants(retired);
    }
    return reply.code(200).send();
  });

  return {
    async verifyAccessToken(token, base) {
      if (!/^cca_[A-Za-z0-9_-]{43}$/.test(token)) return null;
      const row = (
        await d.db.query<TokenRow>(`${TOKEN_JOIN} WHERE t.token_hash=$1 AND t.kind='access'`, [
          sha(token),
        ])
      ).rows[0];
      const time = d.clock();
      if (
        !row ||
        row.revoked_at !== null ||
        row.family_revoked !== null ||
        Number(row.expires_at) <= time ||
        row.grant_revoked !== null ||
        Number(row.grant_expires) <= time ||
        row.resource !== `${base}${MCP_PATH}`
      )
        return null;
      // The shared onboarding gate (server/onboarding.ts) for existing access tokens.
      await assertOnboarded(d.db, row.operator_id);
      return {
        token,
        clientId: row.client_id,
        scopes: row.scopes.filter((scope) => row.grant_scopes.includes(scope)),
        expiresAt: Number(row.expires_at),
        resource: row.resource,
        grantId: row.grant_id,
        operatorId: row.operator_id,
        familyId: row.family_id,
      };
    },
  };
}
