import { Agent, request as httpRequest } from 'node:http';
import { performance } from 'node:perf_hooks';
import { signedHeaders } from '../../connector/signing.js';
import { Samples, round, type LatencySummary } from './histogram.js';

export const LOAD_HOST = 'load.test';
export const LOAD_ORIGIN = `https://${LOAD_HOST}`;

export type Outcome = 'ok' | 'expected' | 'refused' | 'error';

/** Capacity refusals are deliberate bounds, not failures (they carry these messages). */
const CAPACITY = /capacity|limit reached|limit of|history limit|too many/i;

export function classify(status: number, body: unknown, expect: readonly number[] = []): Outcome {
  if (expect.includes(status)) return 'expected';
  // The client never follows redirects, so an unsolicited 3xx is an error unless expected.
  if (status >= 200 && status < 300) return 'ok';
  if (status === 429) return 'refused';
  const message =
    body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string'
      ? (body as { error: string }).error
      : '';
  if ((status === 409 || status === 503) && CAPACITY.test(message)) return 'refused';
  return 'error';
}

interface RouteStats {
  latency: Samples;
  statuses: Map<number, number>;
  outcomes: Record<Outcome, number>;
  /** First few distinct error messages (server messages only; never request data). */
  errorSamples: Set<string>;
}

export interface RouteSummary extends LatencySummary {
  route: string;
  rps: number;
  statuses: Record<string, number>;
  ok: number;
  expected: number;
  refused: number;
  errors: number;
  errorSamples: string[];
}

/** Per-scenario request recorder keyed by route template. */
export class Recorder {
  private routes = new Map<string, RouteStats>();
  private started = performance.now();
  private stopped: number | null = null;
  /** A parent recorder also receives every sample (e.g. a scenario total across levels). */
  constructor(private readonly parent?: Recorder) {}
  record(route: string, status: number, ms: number, outcome: Outcome, message?: string): void {
    this.parent?.record(route, status, ms, outcome, message);
    let entry = this.routes.get(route);
    if (!entry) {
      entry = {
        latency: new Samples(),
        statuses: new Map(),
        outcomes: { ok: 0, expected: 0, refused: 0, error: 0 },
        errorSamples: new Set(),
      };
      this.routes.set(route, entry);
    }
    entry.latency.add(ms);
    entry.statuses.set(status, (entry.statuses.get(status) ?? 0) + 1);
    entry.outcomes[outcome]++;
    if (outcome === 'error' && message && entry.errorSamples.size < 5)
      entry.errorSamples.add(`${status} ${message.slice(0, 160)}`);
  }
  stop(): void {
    this.stopped ??= performance.now();
  }
  get elapsedSeconds(): number {
    return ((this.stopped ?? performance.now()) - this.started) / 1000;
  }
  summary(): { elapsedSeconds: number; routes: RouteSummary[]; totals: Totals } {
    const seconds = this.elapsedSeconds;
    const totals: Totals = { requests: 0, ok: 0, expected: 0, refused: 0, errors: 0, rps: 0 };
    const routes = [...this.routes.entries()]
      .map(([route, entry]) => {
        totals.requests += entry.latency.count;
        totals.ok += entry.outcomes.ok;
        totals.expected += entry.outcomes.expected;
        totals.refused += entry.outcomes.refused;
        totals.errors += entry.outcomes.error;
        return {
          route,
          ...entry.latency.summary(),
          rps: round(entry.latency.count / seconds),
          statuses: Object.fromEntries([...entry.statuses].sort(([a], [b]) => a - b)),
          ok: entry.outcomes.ok,
          expected: entry.outcomes.expected,
          refused: entry.outcomes.refused,
          errors: entry.outcomes.error,
          errorSamples: [...entry.errorSamples],
        };
      })
      .sort((a, b) => b.count - a.count);
    totals.rps = round(totals.requests / seconds);
    return { elapsedSeconds: round(seconds), routes, totals };
  }
}
export interface Totals {
  requests: number;
  ok: number;
  expected: number;
  refused: number;
  errors: number;
  rps: number;
}

export interface Response<T = any> {
  status: number;
  body: T;
  ms: number;
  outcome: Outcome;
  setCookie: string[];
}

export interface RequestSpec {
  method: 'GET' | 'POST' | 'DELETE';
  path: string;
  /** Route template used for aggregation, e.g. `POST /api/jobs/:id/accept`. */
  route?: string;
  body?: unknown;
  /** Client address presented through X-Forwarded-For (the app trusts exactly one hop). */
  ip: string;
  owner?: OwnerSession;
  /** Runtime bearer credential; the request is HMAC-signed like connector/signing.ts. */
  runtimeToken?: string;
  /** Statuses that this request is expected to return (probes). */
  expect?: readonly number[];
  /** Pre-built signed headers (replay probe). */
  headers?: Record<string, string>;
  /** Pre-serialized body (replay probe must send identical bytes). */
  raw?: string;
  recorder?: Recorder | null;
}

export class OwnerSession {
  cookie = '';
  constructor(
    readonly name: string,
    readonly ip: string,
  ) {}
  /** Keeps the session pair as set: `__Host-cc_session` when hosted, `cc_session` otherwise. */
  absorb(setCookie: string[]): void {
    for (const line of setCookie) {
      const pair = line.split(';')[0]!;
      // __Host-cc_session on the hosted site, cc_session on the local server.
      if (/^(?:__Host-)?cc_session=./.test(pair)) this.cookie = pair;
    }
  }
}

export class LoadClient {
  readonly agent: Agent;
  recorder: Recorder | null = null;
  constructor(
    readonly port: number,
    maxSockets = 256,
  ) {
    this.agent = new Agent({ keepAlive: true, maxSockets, keepAliveMsecs: 5_000 });
  }

  signed(token: string, method: string, path: string, body: string): Record<string, string> {
    return signedHeaders(token, method, path, body);
  }

  send<T = any>(spec: RequestSpec): Promise<Response<T>> {
    const payload = spec.raw ?? (spec.body === undefined ? '' : JSON.stringify(spec.body));
    const headers: Record<string, string> = {
      host: LOAD_HOST,
      'x-forwarded-for': spec.ip,
      ...(spec.headers ??
        (spec.runtimeToken ? this.signed(spec.runtimeToken, spec.method, spec.path, payload) : {})),
    };
    if (!spec.runtimeToken && !spec.headers) {
      if (spec.method !== 'GET') headers['content-type'] = 'application/json';
      if (spec.owner) {
        headers['x-city-request'] = '1';
        headers.origin = LOAD_ORIGIN;
        if (spec.owner.cookie) headers.cookie = spec.owner.cookie;
      }
    }
    if (payload) headers['content-length'] = String(Buffer.byteLength(payload));
    const route = spec.route ?? `${spec.method} ${spec.path}`;
    const recorder = spec.recorder === undefined ? this.recorder : spec.recorder;
    const start = performance.now();
    return new Promise((resolve) => {
      const finish = (status: number, text: string, setCookie: string[]) => {
        const ms = performance.now() - start;
        let body: any = null;
        try {
          body = text ? JSON.parse(text) : null;
        } catch {
          body = null;
        }
        const outcome = status === 0 ? 'error' : classify(status, body, spec.expect);
        const message =
          status === 0
            ? text
            : body && typeof body.error === 'string'
              ? body.error
              : body?.error?.message;
        recorder?.record(route, status, ms, outcome, message);
        if (spec.owner) spec.owner.absorb(setCookie);
        resolve({ status, body, ms, outcome, setCookie });
      };
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port: this.port,
          method: spec.method,
          path: spec.path,
          headers,
          agent: this.agent,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => {
            const cookies = res.headers['set-cookie'] ?? [];
            finish(res.statusCode ?? 0, Buffer.concat(chunks).toString('utf8'), cookies);
          });
          res.on('error', (error) => finish(0, error.message, []));
        },
      );
      req.setTimeout(30_000, () => req.destroy(new Error('client timeout')));
      req.on('error', (error) => finish(0, error.message, []));
      req.end(payload || undefined);
    });
  }

  close(): void {
    this.agent.destroy();
  }
}

/** Deterministic client address inside 198.18.0.0/15 (RFC 2544 benchmarking range). */
export function benchIp(index: number): string {
  const n = index % 131_070; // 2 × 65535 addresses, skipping .0
  const high = 18 + Math.floor(n / 65_535);
  const rest = (n % 65_535) + 1;
  return `198.${high}.${Math.floor(rest / 256)}.${rest % 256}`;
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
export const jitter = (ms: number) => ms * (0.5 + Math.random());
