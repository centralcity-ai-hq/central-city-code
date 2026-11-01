import type { LookupAddress } from 'node:dns';
import { Resolver } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP } from 'node:net';
import { ASSERTION_ALGS, signingKeys } from './client-auth.js';

/** Resolves a Client ID Metadata Document URL to its parsed JSON body. Injectable for tests. */
export type ClientMetadataFetcher = (url: URL) => Promise<unknown>;

export const CLIENT_METADATA_LIMITS = { timeoutMs: 5_000, maxBytes: 16 * 1024 } as const;

export class ClientError extends Error {}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * Accepts https redirect URIs, RFC 8252 loopback http URIs and reverse-domain private-use
 * schemes (which must contain a period, excluding javascript:, data:, file: and similar).
 */
export function validRedirectUri(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.hash || value.includes('#') || url.username || url.password) return false;
  if (url.protocol === 'https:') return Boolean(url.hostname);
  if (url.protocol === 'http:') return LOOPBACK_HOSTS.has(url.hostname);
  return /^[a-z][a-z0-9+-]*(\.[a-z0-9+-]+)+:$/.test(url.protocol);
}

/**
 * Exact string match, except that loopback http redirect URIs may use any port
 * (RFC 8252 §7.3): scheme, host, path and query must still match exactly.
 */
export function redirectUriAllowed(registered: readonly string[], requested: string): boolean {
  if (!validRedirectUri(requested)) return false;
  if (registered.includes(requested)) return true;
  const target = new URL(requested);
  if (target.protocol !== 'http:' || !LOOPBACK_HOSTS.has(target.hostname)) return false;
  return registered.some((entry) => {
    try {
      const candidate = new URL(entry);
      return (
        candidate.protocol === 'http:' &&
        candidate.hostname === target.hostname &&
        candidate.pathname === target.pathname &&
        candidate.search === target.search
      );
    } catch {
      return false;
    }
  });
}

export function cleanClientName(value: unknown, fallback: string): string {
  const name =
    typeof value === 'string'
      ? value
          .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, '')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 64)
          .trim()
      : '';
  return name || fallback.slice(0, 64);
}

/** A client_id that names a Client ID Metadata Document (SEP-991 / CIMD). */
export function isMetadataDocumentClientId(clientId: string): boolean {
  return clientId.startsWith('https://');
}

export function parseMetadataDocumentUrl(clientId: string): URL {
  let url: URL;
  try {
    url = new URL(clientId);
  } catch {
    throw new ClientError('The client_id is not a valid URL.');
  }
  if (
    clientId.length > 512 ||
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.hash ||
    url.port ||
    url.pathname === '/' ||
    url.href !== clientId
  )
    throw new ClientError(
      'A URL client_id must be a canonical https URL with a path, no port, credentials or fragment.',
    );
  return url;
}

export interface ResolvedClient {
  clientId: string;
  clientName: string;
  /** Redirect URIs this server honors for the client. */
  redirectUris: string[];
  /**
   * Metadata documents only: listed redirect URIs that are never honored because they are
   * neither on the client_id origin nor loopback (kept to explain the refusal).
   */
  refusedRedirectUris?: string[];
  /** True when the client identity is a fetched HTTPS metadata document (name bound to a domain). */
  verified: boolean;
  /**
   * Token endpoint client authentication: "none" (public client, PKCE) or, for metadata
   * documents only, "private_key_jwt" (RFC 7523) with keys from `jwks` or `jwksUri`.
   */
  authMethod: 'none' | 'private_key_jwt';
  jwks?: unknown;
  jwksUri?: string;
}

/**
 * CIMD redirect binding. A metadata document proves control of its URL's origin and nothing
 * else, so a metadata-document client may only return to that origin (https, the client_id host,
 * default port) or to an RFC 8252 §7.3 loopback URI on any port (a native client on the owner's
 * own machine, such as Claude Code or Codex). Other https hosts and private-use schemes are never
 * honored. Verified clients receive automatic error redirects, so this keeps /oauth/authorize
 * from redirecting to any site other than the one that published the client identity.
 * Checked against the published documents of claude.ai (https://claude.ai/api/mcp/auth_callback),
 * ChatGPT (https://chatgpt.com/connector_platform_oauth_redirect), Claude Code and Codex (loopback).
 */
export function metadataRedirectAllowed(clientId: string, redirectUri: string): boolean {
  let client: URL;
  let target: URL;
  try {
    client = new URL(clientId);
    target = new URL(redirectUri);
  } catch {
    return false;
  }
  if (target.protocol === 'http:') return LOOPBACK_HOSTS.has(target.hostname);
  return (
    target.protocol === 'https:' && client.protocol === 'https:' && target.origin === client.origin
  );
}

/** Validates a fetched Client ID Metadata Document against the URL it was fetched from. */
export function validateMetadataDocument(clientId: string, document: unknown): ResolvedClient {
  if (!document || typeof document !== 'object' || Array.isArray(document))
    throw new ClientError('The client metadata document is not a JSON object.');
  const doc = document as Record<string, unknown>;
  if (doc.client_id !== clientId)
    throw new ClientError('The client metadata document client_id does not match its URL.');
  if ('client_secret' in doc || 'client_secret_expires_at' in doc)
    throw new ClientError('Client metadata documents must not contain a client secret.');
  // Public clients ("none", PKCE only) or private_key_jwt with the client's own published keys
  // (ChatGPT declares private_key_jwt with an RS256 jwks_uri). Shared secrets are never accepted.
  const method = doc.token_endpoint_auth_method ?? 'none';
  if (method !== 'none' && method !== 'private_key_jwt')
    throw new ClientError(
      'Clients authenticate with token_endpoint_auth_method "none" (PKCE) or "private_key_jwt".',
    );
  const keys: Pick<ResolvedClient, 'jwks' | 'jwksUri'> = {};
  if (method === 'private_key_jwt') {
    if ((doc.jwks === undefined) === (doc.jwks_uri === undefined))
      throw new ClientError(
        'A private_key_jwt client must publish exactly one of jwks or jwks_uri.',
      );
    if (
      doc.token_endpoint_auth_signing_alg !== undefined &&
      !(ASSERTION_ALGS as readonly unknown[]).includes(doc.token_endpoint_auth_signing_alg)
    )
      throw new ClientError('Client assertions must use RS256, ES256 or EdDSA.');
    if (doc.jwks !== undefined) {
      try {
        signingKeys(doc.jwks);
      } catch (error) {
        throw new ClientError((error as Error).message);
      }
      keys.jwks = doc.jwks;
    } else {
      let url: URL;
      try {
        url = new URL(String(doc.jwks_uri));
      } catch {
        throw new ClientError('The client jwks_uri is not a valid URL.');
      }
      if (
        typeof doc.jwks_uri !== 'string' ||
        doc.jwks_uri.length > 512 ||
        url.protocol !== 'https:' ||
        url.port ||
        url.username ||
        url.password ||
        url.hash
      )
        throw new ClientError('The client jwks_uri must be an https URL on the default port.');
      keys.jwksUri = url.href;
    }
  }
  if (
    doc.grant_types !== undefined &&
    (!Array.isArray(doc.grant_types) || !doc.grant_types.includes('authorization_code'))
  )
    throw new ClientError('The client must support the authorization_code grant.');
  if (
    doc.response_types !== undefined &&
    (!Array.isArray(doc.response_types) || !doc.response_types.includes('code'))
  )
    throw new ClientError('The client must support the code response type.');
  const redirectUris = doc.redirect_uris;
  if (
    !Array.isArray(redirectUris) ||
    redirectUris.length === 0 ||
    redirectUris.length > 10 ||
    !redirectUris.every(validRedirectUri)
  )
    throw new ClientError('The client metadata document has invalid redirect_uris.');
  const honored = redirectUris.filter((uri) => metadataRedirectAllowed(clientId, uri));
  if (!honored.length)
    throw new ClientError(
      'The client metadata document lists no redirect_uris on its own origin or a loopback address.',
    );
  return {
    clientId,
    clientName: cleanClientName(doc.client_name, new URL(clientId).hostname),
    redirectUris: honored,
    refusedRedirectUris: redirectUris.filter((uri) => !honored.includes(uri)),
    verified: true,
    authMethod: method,
    ...keys,
  };
}

/** Validates an RFC 7591 registration request for a public client. */
export function validateRegistration(body: unknown): {
  clientName: string;
  redirectUris: string[];
} {
  if (!body || typeof body !== 'object' || Array.isArray(body))
    throw new ClientError('Registration metadata must be a JSON object.');
  const doc = body as Record<string, unknown>;
  const redirectUris = doc.redirect_uris;
  if (
    !Array.isArray(redirectUris) ||
    redirectUris.length === 0 ||
    redirectUris.length > 5 ||
    !redirectUris.every(validRedirectUri)
  )
    throw new ClientError('redirect_uris must list one to five https, loopback or app URIs.');
  if (
    doc.grant_types !== undefined &&
    (!Array.isArray(doc.grant_types) ||
      !doc.grant_types.every(
        (grant) => grant === 'authorization_code' || grant === 'refresh_token',
      ))
  )
    throw new ClientError('Only authorization_code and refresh_token grants are supported.');
  if (
    doc.response_types !== undefined &&
    (!Array.isArray(doc.response_types) || !doc.response_types.every((type) => type === 'code'))
  )
    throw new ClientError('Only the code response type is supported.');
  return {
    clientName: cleanClientName(doc.client_name, 'Unnamed MCP client'),
    redirectUris: [...new Set(redirectUris as string[])],
  };
}

const blocked = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const)
  blocked.addSubnet(network, prefix, 'ipv4');
for (const [network, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['::', 96],
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
] as const)
  blocked.addSubnet(network, prefix, 'ipv6');

/** True only for globally routable unicast addresses. Private, loopback and special ranges fail. */
export function isPublicAddress(address: string): boolean {
  const bare = address.startsWith('[') && address.endsWith(']') ? address.slice(1, -1) : address;
  const family = isIP(bare);
  if (family === 4) return !blocked.check(bare, 'ipv4');
  if (family !== 6) return false;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(bare);
  if (mapped) return isPublicAddress(mapped[1]!);
  if (/^::ffff:/i.test(bare)) return false;
  return !blocked.check(bare, 'ipv6');
}

type LookupCallback = (
  error: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void;
/** A connect-time `lookup` (net, tls, https) in Node's callback form. */
export type PublicLookup = (
  hostname: string,
  options: { all?: boolean; family?: number | string } | number | undefined,
  callback: LookupCallback,
) => void;
/** Every address a host name resolves to; rejects when it has none or the lookup failed. */
export type ResolveAddresses = (hostname: string, signal: AbortSignal) => Promise<LookupAddress[]>;

/** One lookup try waits at most this long for a name server (each transport's deadline still applies). */
const DNS_TRY_TIMEOUT_MS = 2_000;

/**
 * Resolves through the name servers directly (c-ares: A and AAAA, every answer), never
 * dns.lookup: getaddrinfo runs on libuv's small shared threadpool and cannot be cancelled, so a
 * name whose servers never answer would hold a pool thread past every deadline and stall password
 * hashing, file access and other lookups of the process (the rule feed/offers/safe-fetch.ts follows
 * too). Each lookup has its own resolver with one try per server, and is cancelled when the signal
 * aborts. No hosts file and no search domains are used. `servers` (host:port) defaults to the
 * system's name servers.
 */
export function createResolveAddresses(
  options: { servers?: readonly string[]; tryTimeoutMs?: number } = {},
): ResolveAddresses {
  return async (hostname, signal) => {
    // Already cancelled (the deadline passed first): no query is started at all.
    if (signal.aborted)
      throw Object.assign(new Error('The host name lookup was cancelled.'), {
        code: 'ECANCELLED',
      });
    const resolver = new Resolver({
      timeout: options.tryTimeoutMs ?? DNS_TRY_TIMEOUT_MS,
      tries: 1,
    });
    if (options.servers) resolver.setServers([...options.servers]);
    const cancel = () => resolver.cancel();
    signal.addEventListener('abort', cancel, { once: true });
    try {
      const [v4, v6] = await Promise.allSettled([
        resolver.resolve4(hostname),
        resolver.resolve6(hostname),
      ]);
      const answers: LookupAddress[] = [
        ...(v4.status === 'fulfilled' ? v4.value : []).map((address) => ({ address, family: 4 })),
        ...(v6.status === 'fulfilled' ? v6.value : []).map((address) => ({ address, family: 6 })),
      ];
      if (answers.length) return answers;
      throw Object.assign(new Error('The host name could not be resolved.'), { code: 'ENOTFOUND' });
    } finally {
      signal.removeEventListener('abort', cancel);
    }
  };
}
const systemResolveAddresses = createResolveAddresses();

/**
 * A connect-time lookup that refuses non-public answers (no rebinding window): every address the
 * name resolves to must be public. `signal` cancels a lookup still running (a transport's
 * deadline); `resolve` replaces the name servers in tests.
 */
export function createPublicLookup(
  options: { resolve?: ResolveAddresses; signal?: AbortSignal } = {},
): PublicLookup {
  const resolve = options.resolve ?? systemResolveAddresses;
  return (hostname, lookupOptions, callback) => {
    const signal = options.signal ?? new AbortController().signal;
    resolve(hostname, signal).then(
      (addresses) => {
        if (!addresses.length || !addresses.every((entry) => isPublicAddress(entry.address)))
          return callback(
            Object.assign(new Error('Client metadata host resolves to a non-public address.'), {
              code: 'ENOTPUBLIC',
            }),
            [],
          );
        const opts = typeof lookupOptions === 'object' ? lookupOptions : {};
        const wanted = typeof lookupOptions === 'number' ? lookupOptions : opts?.family;
        const family =
          wanted === 4 || wanted === 'IPv4' ? 4 : wanted === 6 || wanted === 'IPv6' ? 6 : 0;
        const list = family ? addresses.filter((entry) => entry.family === family) : addresses;
        if (!list.length)
          return callback(
            Object.assign(new Error('No address for this family.'), { code: 'ENOTFOUND' }),
            [],
          );
        if (opts?.all) return callback(null, list);
        return callback(null, list[0]!.address, list[0]!.family);
      },
      (error: NodeJS.ErrnoException) => callback(error, []),
    );
  };
}

/** The shared connect-time lookup of the outbound transports: public addresses only. */
export const publicLookup: PublicLookup = createPublicLookup();

/**
 * The one answer for every failure to reach a metadata document or JWK Set host: a name that
 * resolves only to private addresses, a missing name, a refused connection and a non-200 answer
 * look the same, so the answers do not tell an outside caller which internal names exist.
 */
const NOT_RETRIEVED = 'Client metadata document could not be retrieved.';
/** Suffixes that only mean something inside a network (as feed/offers/safe-fetch.ts refuses). */
const LOCAL_SUFFIX =
  /(?:^|\.)(?:localhost|local|localdomain|internal|intranet|lan|home|corp|arpa|test|invalid)$/i;

/**
 * True for a host name that is never public: no dot, or a local-only suffix, also with trailing
 * dots ("localhost." is localhost). The static check of the outbound fetchers and webhook urls,
 * refused without a DNS query; the connect-time lookup still checks every address.
 */
export function localOnlyHostName(hostname: string): boolean {
  const host = hostname.replace(/\.+$/, '');
  return !host.includes('.') || LOCAL_SUFFIX.test(host);
}

export interface ClientMetadataFetcherOptions {
  resolve?: ResolveAddresses;
  /** Tests only: connect to a local TLS server (port, its CA and a lookup to its address). */
  connect?: { port: number; ca: string | Buffer; lookup: PublicLookup };
}

/**
 * Fetches a Client ID Metadata Document: HTTPS on port 443 only, public addresses only,
 * no redirects, strict timeout and size limit, JSON content type required. A refused answer
 * closes the connection at once, and the deadline also cancels a host name lookup still running.
 */
export function createClientMetadataFetcher(
  options: ClientMetadataFetcherOptions = {},
): ClientMetadataFetcher {
  return (url) =>
    new Promise((resolve, reject) => {
      const fail = (message: string) => reject(new ClientError(message));
      if (url.protocol !== 'https:' || url.port || url.username || url.password)
        return fail('Client metadata must be served over https on the default port.');
      const host = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname;
      if (isIP(host) ? !isPublicAddress(host) : localOnlyHostName(host)) return fail(NOT_RETRIEVED);
      const lookups = new AbortController();
      let settled = false;
      const finish = (action: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        lookups.abort();
        action();
      };
      // A refused answer closes the socket: resuming it would keep the connection open and keep
      // downloading past the deadline and the size limit, for as long as the host keeps sending.
      const refuse = (message: string) => {
        req.destroy();
        finish(() => fail(message));
      };
      const req = httpsRequest(
        url,
        {
          method: 'GET',
          headers: { accept: 'application/json', 'user-agent': 'central-city-oauth/1' },
          lookup: (options.connect?.lookup ??
            createPublicLookup({ resolve: options.resolve, signal: lookups.signal })) as never,
          agent: false,
          ...(options.connect ? { port: options.connect.port, ca: options.connect.ca } : {}),
        },
        (res) => {
          if (res.statusCode !== 200) return refuse(NOT_RETRIEVED);
          if (!/^application\/([a-z.+-]*\+)?json\b/i.test(res.headers['content-type'] ?? ''))
            return refuse('Client metadata document must be JSON.');
          const chunks: Buffer[] = [];
          let length = 0;
          res.on('data', (chunk: Buffer) => {
            length += chunk.length;
            if (length > CLIENT_METADATA_LIMITS.maxBytes)
              return refuse('Client metadata document is too large.');
            chunks.push(chunk);
          });
          res.on('end', () =>
            finish(() => {
              try {
                resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
              } catch {
                fail('Client metadata document is not valid JSON.');
              }
            }),
          );
          res.on('error', () => finish(() => fail('Client metadata document could not be read.')));
        },
      );
      const timer = setTimeout(
        () => refuse('Client metadata request timed out.'),
        CLIENT_METADATA_LIMITS.timeoutMs,
      );
      // ENOTPUBLIC (only private addresses), a missing name and connection errors look the same.
      req.on('error', () => finish(() => fail(NOT_RETRIEVED)));
      req.end();
    });
}

/** The production metadata document and JWK Set fetcher. */
export const fetchClientMetadataDocument: ClientMetadataFetcher = createClientMetadataFetcher();
