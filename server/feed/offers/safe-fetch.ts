/*
 * The one outbound HTTP reader of the Feed's offer kinds (web-read): GET only, for a public
 * http(s) page, never anything inside a private network.
 *
 *   - http or https (https only, redirects included, with `httpsOnly`), port 80 or 443 only, no user name or password in the URL, at most
 *     SAFE_FETCH_MAX_URL_LENGTH characters as written and once percent-encoded
 *   - the host is a public DNS name. An IP literal is refused: a private, loopback, link-local,
 *     CGNAT, multicast, unspecified, documentation or metadata one as not public
 *     (isPublicAddress in oauth/clients.ts, v4 and v6, IPv4-mapped v6 included), a public one
 *     because reading a page by bare address would let a buyer sweep address ranges. The
 *     WHATWG URL parser has already turned decimal, octal and hex IPv4 forms (2130706433,
 *     017700000001, 0x7f000001) into the dotted form, so they meet the same check. Names such as
 *     localhost, *.local or *.internal are refused without a lookup.
 *   - a host name is resolved once (c-ares, not the libuv threadpool, cancelled at the deadline)
 *     and EVERY answer must be public; the connection may then only use those checked answers
 *     (pinnedLookup): no second lookup, so no DNS rebinding window
 *   - at most `maxRedirects` redirects, each target checked again from the start (URL and DNS)
 *   - one deadline for everything (DNS, connect, redirects, body), which the caller's own signal
 *     can end sooner, a byte cap and a cap on the
 *     number of pieces the body arrives in: either one aborts the read, nothing is cut silently.
 *     The body is copied into one buffer as it arrives (never a list of the parser's pieces).
 *   - only the listed content types are read; anything else is refused before the body
 *   - no cookies, no keep-alive agent, no proxy, identity encoding only
 *   - limits per fetcher (create ONE per process): reads in flight at once; per host name reads in
 *     flight and reads started per minute; and the same per resolved address, so many names on
 *     one address (subdomains) share one budget (SAFE_FETCH_LIMITS)
 *   - every refusal says whether a connection to the page's host was already opened
 *     (`outboundSent`). For web-read the buyer has already paid when this fetcher runs: the flag
 *     only labels the paid call's outcome (whether a request reached a third party); it never
 *     decides whether money moves
 */
import { Resolver } from 'node:dns/promises';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { connect as netConnect, isIP, type Socket } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { isPublicAddress } from '../../oauth/clients.js';

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

export type SafeFetchErrorKind =
  /** The URL breaks a static rule (scheme, port, credentials, length, not a URL). */
  | 'bad_url'
  /** The host is, or resolves to, an address that is not public. */
  | 'not_public'
  /** The host name has no address. */
  | 'not_found'
  /** DNS, connection, TLS or HTTP failure. */
  | 'unreachable'
  | 'timeout'
  /** The body is larger than `maxBytes` (declared or received). */
  | 'too_large'
  /** The body arrived in more pieces than maxBodyPieces(maxBytes). */
  | 'fragmented'
  /** The content type is not one of `contentTypes`. */
  | 'content_type'
  /** A content encoding other than identity. */
  | 'encoding'
  | 'too_many_redirects'
  /** This fetcher already has `maxInFlight` reads in flight. */
  | 'busy'
  /** The host already has `maxInFlightPerHost` reads in flight, or its per-minute budget is used. */
  | 'host_busy';

export class SafeFetchError extends Error {
  constructor(
    readonly kind: SafeFetchErrorKind,
    message: string,
    /** True once a connection to a page's host was opened: the request may have reached it. */
    readonly outboundSent = false,
  ) {
    super(message);
    this.name = 'SafeFetchError';
  }
}

export interface PublicFetchRequest {
  url: string;
  /** One deadline for the whole read, redirects included. */
  timeoutMs: number;
  /** The largest body read; a larger one aborts with `too_large`. */
  maxBytes: number;
  maxRedirects: number;
  /** Lower-case media types (no parameters) whose body is read; anything else is refused. */
  contentTypes: readonly string[];
  /** Only https URLs, the first one and every redirect target (http is refused as `bad_url`). */
  httpsOnly?: boolean;
  /** The caller's own end: aborting it ends the read as its deadline does (`timeout`). */
  signal?: AbortSignal;
  /** The call's time (ms since the epoch) for the per-host minute; the fetcher's clock otherwise. */
  now?: number;
}

export interface PublicFetchResponse {
  /** The final URL, after redirects. */
  url: string;
  status: number;
  /** Lower-case media type without parameters, one of the request's `contentTypes`. */
  contentType: string;
  /** Lower-case charset parameter, or null. */
  charset: string | null;
  body: Buffer;
  redirects: number;
}

/** A safe outbound GET. Rejects only with SafeFetchError. */
export type FetchPublic = (request: PublicFetchRequest) => Promise<PublicFetchResponse>;

/**
 * Every address a host name has (all answers, not one). The signal aborts at the read's deadline:
 * the lookup should then stop and free what it holds.
 */
export type ResolveHost = (hostname: string, signal?: AbortSignal) => Promise<ResolvedAddress[]>;

export interface ConnectTarget {
  /** The host as named in the URL, without brackets or trailing dots (TLS name, never re-resolved). */
  hostname: string;
  port: number;
  tls: boolean;
  /** The checked, public addresses the connection may use. */
  addresses: readonly ResolvedAddress[];
}

/** Opens the connection for one request. */
export type OpenSocket = (target: ConnectTarget) => Socket;

export const SAFE_FETCH_MAX_URL_LENGTH = 2048;

/** Sent with every request, with a public page that names a contact for reports. */
export const SAFE_FETCH_USER_AGENT =
  'central-city-web-read/1 (+https://centralcity.ai/.well-known/security.txt)';

export interface SafeFetchLimits {
  /** Reads in flight at once in this fetcher; one more is refused with `busy`. */
  maxInFlight: number;
  /** Requests in flight at once to one host name; one more is refused with `host_busy`. */
  maxInFlightPerHost: number;
  /** Requests started per host name per minute (redirect hops count); more are `host_busy`. */
  maxPerHostPerMinute: number;
  /** Requests in flight at once to one resolved address (any name); one more is `host_busy`. */
  maxInFlightPerAddress: number;
  /** Requests started per resolved address per minute (any name); more are `host_busy`. */
  maxPerAddressPerMinute: number;
}

export const SAFE_FETCH_LIMITS: Readonly<SafeFetchLimits> = Object.freeze({
  maxInFlight: 16,
  maxInFlightPerHost: 4,
  maxPerHostPerMinute: 60,
  // Looser than per host: unrelated sites may share one CDN address.
  maxInFlightPerAddress: 8,
  maxPerAddressPerMinute: 120,
});

/** A body may arrive in at least this many pieces, whatever its byte cap. */
export const SAFE_FETCH_MIN_BODY_PIECES = 1024;
/** Past the floor above, the pieces of a body must average at least this many bytes. */
export const SAFE_FETCH_MIN_AVERAGE_PIECE_BYTES = 256;

/**
 * The most pieces ('data' events) a body of at most `maxBytes` may arrive in: 4096 for 1 MiB.
 * Every piece is a Buffer the HTTP parser allocates and a callback, so a body sent as a million
 * one-byte chunks costs far more memory and CPU than its bytes; it is refused instead.
 */
export function maxBodyPieces(maxBytes: number): number {
  return Math.max(
    SAFE_FETCH_MIN_BODY_PIECES,
    Math.ceil(maxBytes / SAFE_FETCH_MIN_AVERAGE_PIECE_BYTES),
  );
}

/** The first buffer for a body without a declared length; it doubles as needed, up to the cap. */
const INITIAL_BODY_BYTES = 16 * 1024;
/** One lookup try waits at most this long for a name server (the read's deadline still applies). */
const DNS_TRY_TIMEOUT_MS = 2_000;
/** Per-host windows kept before the expired (then the oldest) are forgotten. */
const MAX_TRACKED_HOSTS = 4096;
const MINUTE_MS = 60_000;

const PORTS = new Set(['', '80', '443']);
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
/** Names that only mean something inside a network; refused without a lookup. */
const LOCAL_SUFFIX =
  /(?:^|\.)(?:localhost|local|internal|intranet|lan|home|corp|arpa|test|invalid)$/i;

/** The host of a URL without IPv6 brackets or trailing dots ("localhost." is localhost). */
export function bareHost(url: URL): string {
  const host = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname;
  return host.replace(/\.+$/, '');
}

/**
 * Why a URL is never fetched, or null when its static rules pass. The DNS answers are checked
 * when the URL is fetched. `reason` is fixed text (never the URL).
 */
export function publicUrlProblem(
  value: string,
  options: { httpsOnly?: boolean } = {},
): { kind: 'bad_url' | 'not_public'; reason: string } | null {
  if (value.length > SAFE_FETCH_MAX_URL_LENGTH)
    return { kind: 'bad_url', reason: `must be at most ${SAFE_FETCH_MAX_URL_LENGTH} characters` };
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { kind: 'bad_url', reason: 'must be an absolute http or https URL' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    return { kind: 'bad_url', reason: 'must use http or https' };
  if (options.httpsOnly && url.protocol !== 'https:')
    return { kind: 'bad_url', reason: 'must use https' };
  if (!PORTS.has(url.port)) return { kind: 'bad_url', reason: 'must use port 80 or 443' };
  if (url.username || url.password)
    return { kind: 'bad_url', reason: 'must not contain a user name or password' };
  // The written form can grow up to 9 times when percent-encoded; the encoded one is what is sent
  // and echoed back.
  if (url.href.length > SAFE_FETCH_MAX_URL_LENGTH)
    return {
      kind: 'bad_url',
      reason: `must be at most ${SAFE_FETCH_MAX_URL_LENGTH} characters once percent-encoded`,
    };
  const host = bareHost(url);
  if (isIP(host)) {
    if (!isPublicAddress(host)) return { kind: 'not_public', reason: 'must name a public host' };
    return { kind: 'bad_url', reason: 'must name the host by its DNS name, not an IP address' };
  }
  if (!host.includes('.') || LOCAL_SUFFIX.test(host))
    return { kind: 'not_public', reason: 'must name a public host' };
  return null;
}

const NO_ADDRESS = new Set(['ENOTFOUND', 'ENODATA']);

/**
 * A resolver that asks the name servers directly (c-ares: A and AAAA, every answer), never
 * dns.lookup: getaddrinfo runs on libuv's small shared threadpool and cannot be cancelled, so a
 * name whose servers never answer would hold a pool thread past the deadline and stall every fs,
 * crypto and lookup call of the process. Each lookup has its own resolver, one try per server of
 * at most `tryTimeoutMs`, and is cancelled when the signal aborts. No hosts file and no search
 * domains are used. `servers` (host:port) defaults to the system's name servers.
 */
export function createSystemResolve(
  options: { servers?: readonly string[]; tryTimeoutMs?: number } = {},
): ResolveHost {
  return async (hostname, signal) => {
    const resolver = new Resolver({
      timeout: options.tryTimeoutMs ?? DNS_TRY_TIMEOUT_MS,
      tries: 1,
    });
    if (options.servers) resolver.setServers([...options.servers]);
    const cancel = () => resolver.cancel();
    if (signal?.aborted) cancel();
    else signal?.addEventListener('abort', cancel, { once: true });
    try {
      const [v4, v6] = await Promise.allSettled([
        resolver.resolve4(hostname),
        resolver.resolve6(hostname),
      ]);
      const answers: ResolvedAddress[] = [
        ...(v4.status === 'fulfilled' ? v4.value : []).map((address) => ({
          address,
          family: 4 as const,
        })),
        ...(v6.status === 'fulfilled' ? v6.value : []).map((address) => ({
          address,
          family: 6 as const,
        })),
      ];
      if (answers.length) return answers;
      // Only a name that both families report as missing is not found; anything else failed.
      const missing = [v4, v6].every(
        (result) =>
          result.status === 'fulfilled' ||
          NO_ADDRESS.has(String((result.reason as { code?: unknown } | null)?.code)),
      );
      throw Object.assign(new Error('The host name could not be resolved.'), {
        code: missing ? 'ENOTFOUND' : 'ESERVFAIL',
      });
    } finally {
      signal?.removeEventListener('abort', cancel);
    }
  };
}

/** The production resolver (system name servers, through c-ares). */
export const systemResolve: ResolveHost = createSystemResolve();

type LookupCallback = (
  error: NodeJS.ErrnoException | null,
  address: string | ResolvedAddress[],
  family?: number,
) => void;

/**
 * A `lookup` for net/tls connect that answers ONLY with the already checked addresses: the
 * connection is pinned to what was checked, whatever name it asks for.
 */
export function pinnedLookup(addresses: readonly ResolvedAddress[]) {
  return (_hostname: string, options: unknown, callback: LookupCallback): void => {
    const opts = (typeof options === 'object' && options !== null ? options : {}) as {
      all?: boolean;
      family?: number | string;
    };
    const wanted = typeof options === 'number' ? options : opts.family;
    const family =
      wanted === 4 || wanted === 'IPv4' ? 4 : wanted === 6 || wanted === 'IPv6' ? 6 : 0;
    const list = addresses
      .filter((entry) => !family || entry.family === family)
      .map((entry) => ({ address: entry.address, family: entry.family }));
    process.nextTick(() => {
      if (!list.length)
        return callback(
          Object.assign(new Error('No checked address for this family.'), { code: 'ENOTFOUND' }),
          opts.all ? [] : '',
        );
      if (opts.all) return callback(null, list);
      callback(null, list[0]!.address, list[0]!.family);
    });
  };
}

/** The production connection: TCP (or TLS, verified against the host name) to checked addresses. */
export const openPinnedSocket: OpenSocket = ({ hostname, port, tls, addresses }) => {
  const options = {
    host: hostname,
    port,
    lookup: pinnedLookup(addresses) as never,
    autoSelectFamily: true,
  };
  if (!tls) return netConnect(options);
  return tlsConnect({
    ...options,
    // SNI and the certificate check use the name; an IP literal has no SNI.
    ...(isIP(hostname) ? {} : { servername: hostname }),
    ALPNProtocols: ['http/1.1'],
  });
};

const timeoutError = () => new SafeFetchError('timeout', 'The page did not answer in time.');

/** Rejects with a timeout as soon as the signal aborts. */
function beforeDeadline<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(timeoutError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(timeoutError());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

function checkUrl(value: string, httpsOnly: boolean): URL {
  const problem = publicUrlProblem(value, { httpsOnly });
  if (problem)
    throw new SafeFetchError(
      problem.kind,
      problem.kind === 'not_public'
        ? 'The URL does not name a public host.'
        : `The URL ${problem.reason}.`,
    );
  const url = new URL(value);
  url.hash = '';
  return url;
}

async function resolvePublic(
  host: string,
  resolve: ResolveHost,
  signal: AbortSignal,
): Promise<ResolvedAddress[]> {
  // IP literals never get here: checkUrl refuses them.
  let answers: ResolvedAddress[];
  try {
    answers = await beforeDeadline(resolve(host, signal), signal);
  } catch (error) {
    if (error instanceof SafeFetchError) throw error;
    const code = (error as { code?: unknown } | null)?.code;
    if (NO_ADDRESS.has(String(code)))
      throw new SafeFetchError('not_found', 'The host name has no address.');
    throw new SafeFetchError('unreachable', 'The host name could not be resolved.');
  }
  if (!answers.length) throw new SafeFetchError('not_found', 'The host name has no address.');
  // Every answer, not the first: a client may connect to any of them.
  if (!answers.every((entry) => isIP(entry.address) && isPublicAddress(entry.address)))
    throw new SafeFetchError(
      'not_public',
      'The host name resolves to an address that is not public.',
    );
  return answers.map((entry) => ({
    address: entry.address,
    family: isIP(entry.address) === 6 ? 6 : 4,
  }));
}

function parseContentType(header: string | undefined): { type: string; charset: string | null } {
  const [media = '', ...params] = (header ?? '').split(';');
  let charset: string | null = null;
  for (const param of params) {
    const match = /^\s*charset\s*=\s*"?([^";\s]+)"?\s*$/i.exec(param);
    if (match) charset = match[1]!.toLowerCase();
  }
  return { type: media.trim().toLowerCase(), charset };
}

type Hop =
  | { kind: 'redirect'; location: string }
  | { kind: 'final'; status: number; contentType: string; charset: string | null; body: Buffer };

/** What one read has done so far, kept across its hops. */
interface ReadState {
  /** A connection to a page's host was opened (the request may have reached it). */
  outboundSent: boolean;
}

function getOnce(
  url: URL,
  addresses: readonly ResolvedAddress[],
  openSocket: OpenSocket,
  request: PublicFetchRequest,
  signal: AbortSignal,
  state: ReadState,
): Promise<Hop> {
  return new Promise<Hop>((resolve, reject) => {
    if (signal.aborted) return reject(timeoutError());
    const tls = url.protocol === 'https:';
    const port = url.port ? Number(url.port) : tls ? 443 : 80;
    const hostname = bareHost(url);
    let settled = false;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      action();
    };
    const fail = (kind: SafeFetchErrorKind, message: string) =>
      finish(() => reject(new SafeFetchError(kind, message)));
    const req = httpRequest(
      {
        method: 'GET',
        host: hostname,
        port,
        path: `${url.pathname}${url.search}`,
        defaultPort: tls ? 443 : 80,
        headers: {
          host: url.host,
          accept: request.contentTypes.join(', '),
          'accept-encoding': 'identity',
          'user-agent': SAFE_FETCH_USER_AGENT,
          connection: 'close',
        },
        // No agent: a fresh connection to the checked addresses only, never a pooled one.
        createConnection: () => {
          state.outboundSent = true;
          return openSocket({ hostname, port, tls, addresses });
        },
      },
      (res: IncomingMessage) => {
        res.on('error', () => fail('unreachable', 'The page could not be read.'));
        const status = res.statusCode ?? 0;
        const location = res.headers.location;
        if (REDIRECTS.has(status) && typeof location === 'string' && location) {
          finish(() => resolve({ kind: 'redirect', location }));
          req.destroy();
          return;
        }
        const { type, charset } = parseContentType(res.headers['content-type']);
        if (!request.contentTypes.includes(type)) {
          req.destroy();
          return fail('content_type', 'The page is not of a content type this service reads.');
        }
        const encoding = (res.headers['content-encoding'] ?? '').trim().toLowerCase();
        if (encoding && encoding !== 'identity') {
          req.destroy();
          return fail('encoding', 'The page was sent compressed although identity was asked for.');
        }
        const declared = Number(res.headers['content-length'] ?? Number.NaN);
        if (Number.isFinite(declared) && declared > request.maxBytes) {
          req.destroy();
          return fail('too_large', 'The page is larger than this service reads.');
        }
        // The body is copied into one buffer as it arrives: the parser's pieces are never kept, so
        // memory follows the bytes read, not the number of pieces they came in.
        const firstSize =
          Number.isFinite(declared) && declared >= 0 ? declared : INITIAL_BODY_BYTES;
        const maxPieces = maxBodyPieces(request.maxBytes);
        let body = Buffer.alloc(0);
        let length = 0;
        let pieces = 0;
        res.on('data', (chunk: Buffer) => {
          if (settled) return;
          if (++pieces > maxPieces) {
            req.destroy();
            return fail('fragmented', 'The page was sent in more pieces than this service reads.');
          }
          const next = length + chunk.length;
          if (next > request.maxBytes) {
            // Over the cap: abort, the rest is never read.
            req.destroy();
            return fail('too_large', 'The page is larger than this service reads.');
          }
          if (next > body.length) {
            const grown = Buffer.alloc(
              Math.min(request.maxBytes, Math.max(next, body.length * 2, firstSize)),
            );
            body.copy(grown, 0, 0, length);
            body = grown;
          }
          chunk.copy(body, length);
          length = next;
        });
        res.on('end', () =>
          finish(() =>
            resolve({
              kind: 'final',
              status,
              contentType: type,
              charset,
              body: body.subarray(0, length),
            }),
          ),
        );
        res.on('close', () => {
          if (!res.complete) fail('unreachable', 'The connection closed before the page ended.');
        });
      },
    );
    const onAbort = () => {
      req.destroy();
      finish(() => reject(timeoutError()));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    req.on('error', () => fail('unreachable', 'The page could not be reached.'));
    req.end();
  });
}

/**
 * Per key (a host name, or a resolved address): requests in flight and requests started in the
 * current minute. In memory, per fetcher; the expired windows (then the oldest) are forgotten past
 * MAX_TRACKED_HOSTS keys.
 */
class HostLimiter {
  private readonly inFlight = new Map<string, number>();
  private readonly windows = new Map<string, { start: number; count: number }>();

  constructor(
    private readonly limits: { maxInFlight: number; maxPerMinute: number },
    private readonly now: () => number,
  ) {}

  /**
   * Takes a slot for every key, all or none: false (nothing taken) when one is busy or over its
   * budget.
   */
  acquireAll(keys: readonly string[], at?: number): boolean {
    const taken: string[] = [];
    for (const key of keys) {
      if (!this.acquire(key, at)) {
        for (const done of taken) this.release(done);
        return false;
      }
      taken.push(key);
    }
    return true;
  }

  /** Takes a slot for one request to `host`; false when the host is busy or over its budget. */
  acquire(host: string, at?: number): boolean {
    const now = at ?? this.now();
    let window = this.windows.get(host);
    // A time before the window's start (a redirect hop stamped with its call's start, older than
    // another call's newer window) counts against that window; it never starts a new one.
    if (!window || now - window.start >= MINUTE_MS) {
      // A new window moves the host to the end, so the map stays ordered by window start.
      this.windows.delete(host);
      this.forget(now);
      window = { start: now, count: 0 };
      this.windows.set(host, window);
    }
    const busy = this.inFlight.get(host) ?? 0;
    if (busy >= this.limits.maxInFlight || window.count >= this.limits.maxPerMinute) return false;
    window.count++;
    this.inFlight.set(host, busy + 1);
    return true;
  }

  release(host: string): void {
    const left = (this.inFlight.get(host) ?? 1) - 1;
    if (left > 0) this.inFlight.set(host, left);
    else this.inFlight.delete(host);
  }

  private forget(now: number): void {
    if (this.windows.size < MAX_TRACKED_HOSTS) return;
    for (const [host, window] of this.windows)
      if (now - window.start >= MINUTE_MS) this.windows.delete(host);
    // Still full: forget the oldest windows, a quarter at once so this does not run every time.
    for (const host of this.windows.keys()) {
      if (this.windows.size < (MAX_TRACKED_HOSTS * 3) / 4) break;
      this.windows.delete(host);
    }
  }
}

export interface SafeFetchOptions {
  resolve?: ResolveHost;
  openSocket?: OpenSocket;
  /** Overrides of SAFE_FETCH_LIMITS. */
  limits?: Partial<SafeFetchLimits>;
  /** Milliseconds since the epoch, for the per-host minute (Date.now by default). */
  now?: () => number;
}

/**
 * The production safe fetch. `resolve` and `openSocket` default to the system resolver and a
 * connection pinned to the checked addresses; tests inject both (never a check). The limits hold
 * per returned function: create ONE per process and share it.
 */
export function createSafeFetch(options: SafeFetchOptions = {}): FetchPublic {
  const resolve = options.resolve ?? systemResolve;
  const openSocket = options.openSocket ?? openPinnedSocket;
  const limits: SafeFetchLimits = { ...SAFE_FETCH_LIMITS, ...options.limits };
  const now = options.now ?? Date.now;
  const hosts = new HostLimiter(
    { maxInFlight: limits.maxInFlightPerHost, maxPerMinute: limits.maxPerHostPerMinute },
    now,
  );
  const addresses = new HostLimiter(
    { maxInFlight: limits.maxInFlightPerAddress, maxPerMinute: limits.maxPerAddressPerMinute },
    now,
  );
  let inFlight = 0;
  return async (request) => {
    if (inFlight >= limits.maxInFlight)
      throw new SafeFetchError('busy', 'Too many pages are being read right now.');
    inFlight++;
    const state: ReadState = { outboundSent: false };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), request.timeoutMs);
    // The caller's signal ends the read as the deadline does.
    const stop = () => controller.abort();
    if (request.signal?.aborted) stop();
    else request.signal?.addEventListener('abort', stop, { once: true });
    try {
      return await follow(
        request,
        resolve,
        openSocket,
        { hosts, addresses },
        controller.signal,
        state,
      );
    } catch (error) {
      // Only SafeFetchError leaves: anything else (a socket that could not even be created) is a
      // failure to reach the page, with a fixed message. Each says whether a request went out.
      if (error instanceof SafeFetchError)
        throw new SafeFetchError(error.kind, error.message, state.outboundSent);
      throw new SafeFetchError('unreachable', 'The page could not be reached.', state.outboundSent);
    } finally {
      clearTimeout(timer);
      request.signal?.removeEventListener('abort', stop);
      inFlight--;
    }
  };
}

/** Reads `request.url`, following redirects; every hop is checked, resolved and pinned anew. */
async function follow(
  request: PublicFetchRequest,
  resolve: ResolveHost,
  openSocket: OpenSocket,
  limiters: { hosts: HostLimiter; addresses: HostLimiter },
  signal: AbortSignal,
  state: ReadState,
): Promise<PublicFetchResponse> {
  const { hosts } = limiters;
  let current = request.url;
  for (let redirects = 0; ; redirects++) {
    const url = checkUrl(current, request.httpsOnly === true);
    const host = bareHost(url).toLowerCase();
    if (!hosts.acquire(host, request.now))
      throw new SafeFetchError('host_busy', 'Too many reads of this host right now.');
    let hop: Hop;
    try {
      const addresses = await resolvePublic(host, resolve, signal);
      // The connection may use any of them: each one's budget is taken, all or none.
      const keys = [...new Set(addresses.map((entry) => entry.address.toLowerCase()))];
      if (!limiters.addresses.acquireAll(keys, request.now))
        throw new SafeFetchError('host_busy', 'Too many reads of this host right now.');
      try {
        hop = await getOnce(url, addresses, openSocket, request, signal, state);
      } finally {
        for (const key of keys) limiters.addresses.release(key);
      }
    } finally {
      hosts.release(host);
    }
    if (hop.kind === 'final')
      return {
        url: url.href,
        status: hop.status,
        contentType: hop.contentType,
        charset: hop.charset,
        body: hop.body,
        redirects,
      };
    if (redirects >= request.maxRedirects)
      throw new SafeFetchError('too_many_redirects', 'The page redirected too many times.');
    let next: URL;
    try {
      next = new URL(hop.location, url);
    } catch {
      throw new SafeFetchError('bad_url', 'The page redirected to something that is not a URL.');
    }
    current = next.href;
  }
}
