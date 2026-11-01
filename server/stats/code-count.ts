import { createHash, timingSafeEqual } from 'node:crypto';
import { Readable, Transform, pipeline } from 'node:stream';
import { createGunzip } from 'node:zlib';
import type { FastifyInstance } from 'fastify';
import type { Database, Transaction } from '../database.js';
import { registerMigration, type Migration } from '../migrations.js';
import { clientAddressKey } from '../rate-limit.js';
import {
  CODE_COUNT_OWNER,
  CODE_COUNT_REPOS,
  classifyPath,
  countLines,
  withAppCount,
  type AppCodeCount,
  type CodeCount,
  type CodeCountRepo,
  type CodeCountRepoResult,
} from '../../shared/code-count.js';
import './schema.js'; // migration 28 public_stats: the run lease below lives in its `code_count` row

/**
 * This deployment's own repository, counted when it was built (scripts/build-api.mjs runs
 * scripts/app-code-count.ts and defines it). Undefined in development and tests, where only the
 * public repositories count.
 */
declare const __CITY_APP_CODE__: AppCodeCount | undefined;
export const builtAppCount = (): AppCodeCount | null =>
  typeof __CITY_APP_CODE__ === 'undefined' ? null : __CITY_APP_CODE__;

/**
 * The live lines-of-code count on Downtown (shared/code-count.ts has the rules).
 *
 * Cron (GET /api/cron/code-count, every 30 minutes):
 * 1. One small GitHub API read per public repository: the head commit of its default branch.
 * 2. If every head equals the last stored count's, stop. This is the normal case.
 * 3. Otherwise claim the run lease, download each repository's tarball for exactly that commit,
 *    count it in memory as it streams (nothing is written to disk, no path is ever extracted),
 *    and append one row to `code_counts`.
 *
 * GET /api/public/code serves the latest row. It is edge-cached and rate-limited like
 * /api/public/stats, and it takes no parameters.
 *
 * Outbound requests go only to api.github.com and codeload.github.com, for the fixed repositories
 * in CODE_COUNT_REPOS. A redirect is an error, so a renamed or moved repository never leads the
 * counter elsewhere. No database connection is held while GitHub is read.
 */

export const CODE_COUNT_LIMITS = {
  /** One head read. */
  headTimeoutMs: 10_000,
  /** One repository's whole tarball, download and count (never more than what is left of the run). */
  repoTimeoutMs: 90_000,
  /** The whole run: well inside the lease and the function's 300 s limit. */
  runBudgetMs: 240_000,
  /** The compressed bytes of one tarball, as downloaded. */
  maxGzipBytes: 100 * 1024 * 1024,
  /** The decompressed bytes of one tarball. */
  maxTarBytes: 200 * 1024 * 1024,
  /** A single file above this is not counted (generated or vendored code). */
  maxFileBytes: 2 * 1024 * 1024,
  /** A pax or GNU long-name header's body. */
  maxMetaBytes: 64 * 1024,
  /** How long a claimed run may hold the lease before another instance may try. */
  leaseMs: 10 * 60_000,
} as const;

export const PUBLIC_CODE_RATE = { max: 60, windowMs: 60_000 } as const;
export const PUBLIC_CODE_CACHE_CONTROL =
  'public, max-age=60, s-maxage=300, stale-while-revalidate=600';
export const PUBLIC_CODE_EDGE_CACHE_CONTROL = 'public, max-age=300, stale-while-revalidate=86400';
const LEASE_KEY = 'code_count';
const COMMIT_ID = /^[0-9a-f]{40}$/;

/** Migration 261 `code_counts`: one row per count that found a changed head; append-only. */
export const codeCountsMigration: Migration = {
  version: 261,
  name: 'code_counts',
  sql: `
CREATE TABLE IF NOT EXISTS code_counts (
  id bigserial PRIMARY KEY,
  counted_at bigint NOT NULL,
  total bigint NOT NULL CHECK (total >= 0),
  code bigint NOT NULL CHECK (code >= 0),
  tests bigint NOT NULL CHECK (tests >= 0),
  files integer NOT NULL CHECK (files >= 0),
  repos jsonb NOT NULL CHECK (jsonb_typeof(repos) = 'array'),
  CHECK (total = code + tests)
);
`,
};
registerMigration(codeCountsMigration);

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;
export type CodeCountLog = (level: 'info' | 'error', fields: Record<string, unknown>) => void;

/** The only URLs the counter may request. */
export function headUrl(repo: CodeCountRepo): string {
  return `https://api.github.com/repos/${CODE_COUNT_OWNER}/${repo}/commits/HEAD`;
}
export function tarballUrl(repo: CodeCountRepo, commit: string): string {
  if (!COMMIT_ID.test(commit)) throw new Error('Invalid commit id.');
  return `https://codeload.github.com/${CODE_COUNT_OWNER}/${repo}/tar.gz/${commit}`;
}

function githubHeaders(token: string | undefined, accept: string): Record<string, string> {
  return {
    accept,
    'user-agent': 'centralcity-code-count',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}

export async function readHead(
  fetcher: Fetch,
  repo: CodeCountRepo,
  token?: string,
  timeoutMs: number = CODE_COUNT_LIMITS.headTimeoutMs,
): Promise<string> {
  const response = await fetcher(headUrl(repo), {
    headers: githubHeaders(token, 'application/vnd.github.sha'),
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`head_${response.status}`);
  const commit = (await response.text()).trim();
  if (!COMMIT_ID.test(commit)) throw new Error('head_invalid');
  return commit;
}

/** git's blob id, the same `git ls-files -s` prints: identical files across repositories match. */
export function blobId(bytes: Buffer): string {
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

/** An octal header field; anything else (base-256, stray characters) makes the archive invalid. */
const octal = (field: Buffer) => {
  if (field[0] & 0x80) throw new Error('tar_invalid');
  const text = field.toString('latin1').replace(/\0.*$/s, '').trim();
  if (!/^[0-7]*$/.test(text)) throw new Error('tar_invalid');
  return text ? parseInt(text, 8) : 0;
};
/** The header checksum: the byte sum with the checksum field counted as spaces. */
function checksumOk(header: Buffer): boolean {
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 0x20 : header[i];
  return octal(header.subarray(148, 156)) === sum;
}
const cstring = (field: Buffer) => field.toString('utf8').replace(/\0.*$/s, '');

/** The `path=` record of a pax extended header, if any. */
function paxPath(body: Buffer): string | null {
  let at = 0;
  let found: string | null = null;
  while (at < body.length) {
    const space = body.indexOf(0x20, at);
    if (space < 0) break;
    const length = parseInt(body.subarray(at, space).toString('latin1'), 10);
    if (!Number.isFinite(length) || length <= 0) break;
    const record = body.subarray(space + 1, at + length - 1).toString('utf8');
    if (record.startsWith('path=')) found = record.slice(5);
    at += length;
  }
  return found;
}

export interface TarFile {
  /** The path inside the repository (the archive's top folder removed). */
  path: string;
  bytes: Buffer;
}

/**
 * Reads a tar stream and yields its regular files at most `maxFileBytes` long (bigger files are
 * skipped without buffering them and reported to `onSkip`). Understands ustar, pax `path` records
 * and GNU long names, which is what GitHub's tarballs use. Only file contents are kept, and only
 * until yielded.
 *
 * Fails instead of counting less: a header with a bad checksum or size, a pax or long-name body
 * over `maxMetaBytes`, more than `maxTarBytes` in total, and an archive that ends inside an entry
 * or without its end-of-archive block all throw.
 */
export async function* tarFiles(
  chunks: AsyncIterable<Buffer>,
  limits: {
    maxTarBytes: number;
    maxFileBytes: number;
    maxMetaBytes?: number;
    onSkip?: (path: string) => void;
  },
): AsyncGenerator<TarFile> {
  const maxMeta = limits.maxMetaBytes ?? 64 * 1024;
  let pending: Buffer = Buffer.alloc(0);
  let total = 0;
  let ended = false;
  let longName: string | null = null;
  let entry: { type: string; name: string; size: number; padded: number } | null = null;
  let skip = 0;
  for await (const chunk of chunks) {
    total += chunk.length;
    if (total > limits.maxTarBytes) throw new Error('tar_too_large');
    if (ended) continue; // the zero padding after the end-of-archive block
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    for (;;) {
      if (skip > 0) {
        const n = Math.min(skip, pending.length);
        pending = pending.subarray(n);
        skip -= n;
        if (skip > 0) break;
      }
      if (!entry) {
        if (pending.length < 512) break;
        const header = pending.subarray(0, 512);
        pending = pending.subarray(512);
        if (header.every((b) => b === 0)) {
          ended = true;
          pending = Buffer.alloc(0);
          break;
        }
        if (!checksumOk(header)) throw new Error('tar_invalid');
        const size = octal(header.subarray(124, 136));
        if (!Number.isSafeInteger(size) || size < 0) throw new Error('tar_invalid');
        const type = String.fromCharCode(header[156] || 0x30);
        const prefix = cstring(header.subarray(345, 500));
        const base = cstring(header.subarray(0, 100));
        const name = longName ?? (prefix ? `${prefix}/${base}` : base);
        const meta = type === 'x' || type === 'L';
        if (meta && size > maxMeta) throw new Error('tar_invalid');
        if (!meta && type !== 'g') longName = null;
        const padded = Math.ceil(size / 512) * 512;
        const regular = type === '0' || type === '\0' || type === '7';
        if (!meta && !(regular && size <= limits.maxFileBytes)) {
          if (regular) limits.onSkip?.(name);
          skip = padded;
          continue;
        }
        entry = { type, name, size, padded };
      }
      if (pending.length < entry.padded) break;
      const body = pending.subarray(0, entry.size);
      pending = pending.subarray(entry.padded);
      const done = entry;
      entry = null;
      if (done.type === 'x') {
        longName = paxPath(body) ?? longName;
      } else if (done.type === 'L') {
        longName = cstring(body);
      } else {
        const slash = done.name.indexOf('/');
        const path = slash >= 0 ? done.name.slice(slash + 1) : '';
        if (path) yield { path, bytes: Buffer.from(body) };
      }
    }
  }
  if (!ended || entry || skip > 0) throw new Error('tar_truncated');
}

/** Counts one repository's files into `seen` (shared across repositories, so duplicates count once). */
export async function countFiles(
  files: AsyncIterable<TarFile>,
  seen: Set<string>,
): Promise<{ code: number; tests: number; files: number }> {
  const result = { code: 0, tests: 0, files: 0 };
  for await (const file of files) {
    const kind = classifyPath(file.path);
    if (!kind) continue;
    const id = blobId(file.bytes);
    if (seen.has(id)) continue;
    seen.add(id);
    const lines = countLines(file.bytes.toString('utf8'));
    if (lines === null) continue;
    result[kind] += lines;
    result.files++;
  }
  return result;
}

export async function countRepo(
  fetcher: Fetch,
  repo: CodeCountRepo,
  commit: string,
  seen: Set<string>,
  timeoutMs: number = CODE_COUNT_LIMITS.repoTimeoutMs,
): Promise<CodeCountRepoResult> {
  const response = await fetcher(tarballUrl(repo, commit), {
    headers: { 'user-agent': 'centralcity-code-count' },
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok || !response.body) throw new Error(`tarball_${response.status}`);
  let compressed = 0;
  const capped = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      compressed += chunk.length;
      if (compressed > CODE_COUNT_LIMITS.maxGzipBytes) done(new Error('tarball_too_large'));
      else done(null, chunk);
    },
  });
  const gunzip = createGunzip();
  // pipeline destroys every stage with the first error (a network failure or the timeout in the
  // body, the size cap, bad gzip), so the iteration below rejects instead of waiting.
  const source = Readable.fromWeb(response.body as never);
  pipeline(source, capped, gunzip, () => undefined);
  let skipped = 0;
  try {
    const counted = await countFiles(
      tarFiles(gunzip, {
        ...CODE_COUNT_LIMITS,
        onSkip: (name) => {
          // Only files that would have been counted make a count partial.
          if (classifyPath(name.slice(name.indexOf('/') + 1))) skipped++;
        },
      }),
      seen,
    );
    return { name: repo, commit, ...counted, skipped };
  } finally {
    source.destroy();
    gunzip.destroy();
  }
}

interface CodeCountRow {
  counted_at: string | number;
  total: string | number;
  code: string | number;
  tests: string | number;
  files: number;
  repos: CodeCountRepoResult[];
}

const toCount = (row: CodeCountRow): CodeCount => ({
  total: Number(row.total),
  code: Number(row.code),
  tests: Number(row.tests),
  files: Number(row.files),
  skipped_files: row.repos.reduce((s, r) => s + (r.skipped ?? 0), 0),
  counted_at: new Date(Number(row.counted_at)).toISOString(),
  repos: row.repos,
});

export async function latestCodeCount(db: Pick<Transaction, 'query'>): Promise<CodeCount | null> {
  const { rows } = await db.query<CodeCountRow>(
    'SELECT counted_at, total, code, tests, files, repos FROM code_counts ORDER BY id DESC LIMIT 1',
  );
  return rows[0] ? toCount(rows[0]) : null;
}

/** Claims the run lease; returns its value (the fence the commit and the release must match), or null. */
async function claimLease(db: Pick<Transaction, 'query'>, now: number): Promise<number | null> {
  await db.query(`INSERT INTO public_stats (key) VALUES ($1) ON CONFLICT (key) DO NOTHING`, [
    LEASE_KEY,
  ]);
  const until = now + CODE_COUNT_LIMITS.leaseMs;
  const { rows } = await db.query(
    `UPDATE public_stats SET refreshing_until = $2
      WHERE key = $1 AND refreshing_until < $3 RETURNING key`,
    [LEASE_KEY, until, now],
  );
  return rows.length === 1 ? until : null;
}

export type CodeCountRun =
  | { status: 'unchanged'; count: CodeCount }
  | { status: 'counted'; count: CodeCount }
  | { status: 'busy' }
  | { status: 'failed'; error: string };

export async function runCodeCount(d: {
  db: Pick<Database, 'query'>;
  fetcher: Fetch;
  token?: string;
  clock?: () => number;
  log?: CodeCountLog;
}): Promise<CodeCountRun> {
  const clock = d.clock ?? Date.now;
  const log = d.log ?? defaultLog;
  // The run's deadline starts before any read, so the head reads count against it too.
  const started = clock();
  const left = () => started + CODE_COUNT_LIMITS.runBudgetMs - clock();
  const last = await latestCodeCount(d.db);
  const heads: Record<string, string> = {};
  try {
    for (const repo of CODE_COUNT_REPOS) {
      if (left() <= 0) throw new Error('run_budget_exhausted');
      const timeout = Math.min(CODE_COUNT_LIMITS.headTimeoutMs, left());
      heads[repo] = await readHead(d.fetcher, repo, d.token, timeout);
    }
  } catch (error) {
    log('error', { event: 'code_count_head_failed', error: errorCode(error) });
    return { status: 'failed', error: errorCode(error) };
  }
  const unchanged =
    last !== null &&
    last.repos.length === CODE_COUNT_REPOS.length &&
    last.repos.every((r) => heads[r.name] === r.commit);
  if (unchanged) return { status: 'unchanged', count: last };
  const lease = await claimLease(d.db, clock());
  if (lease === null) return { status: 'busy' };
  try {
    const seen = new Set<string>();
    const repos: CodeCountRepoResult[] = [];
    for (const repo of CODE_COUNT_REPOS) {
      if (left() <= 0) throw new Error('run_budget_exhausted');
      const timeout = Math.min(CODE_COUNT_LIMITS.repoTimeoutMs, left());
      repos.push(await countRepo(d.fetcher, repo, heads[repo], seen, timeout));
    }
    const code = repos.reduce((s, r) => s + r.code, 0);
    const tests = repos.reduce((s, r) => s + r.tests, 0);
    const files = repos.reduce((s, r) => s + r.files, 0);
    const skipped = repos.reduce((s, r) => s + r.skipped, 0);
    const now = clock();
    // One statement: the row is stored only while this run still holds its own lease, so a run
    // that outlived its lease can never overwrite a newer one.
    const { rows } = await d.db.query(
      `WITH lease AS (
         UPDATE public_stats SET value = $2, refreshed_at = $1, refreshing_until = 0
          WHERE key = $7 AND refreshing_until = $8 RETURNING key
       )
       INSERT INTO code_counts (counted_at, total, code, tests, files, repos)
       SELECT $1, $2, $3, $4, $5, $6::jsonb FROM lease RETURNING id`,
      [now, code + tests, code, tests, files, JSON.stringify(repos), LEASE_KEY, lease],
    );
    if (rows.length !== 1) throw new Error('lease_lost');
    log('info', { event: 'code_count_done', total: code + tests, code, tests, files, skipped });
    return {
      status: 'counted',
      count: {
        total: code + tests,
        code,
        tests,
        files,
        skipped_files: skipped,
        counted_at: new Date(now).toISOString(),
        repos,
      },
    };
  } catch (error) {
    await d.db
      .query(
        'UPDATE public_stats SET refreshing_until = 0 WHERE key = $1 AND refreshing_until = $2',
        [LEASE_KEY, lease],
      )
      .catch(() => undefined);
    log('error', { event: 'code_count_failed', error: errorCode(error) });
    return { status: 'failed', error: errorCode(error) };
  }
}

function errorCode(error: unknown): string {
  if (error instanceof Error)
    return error.name === 'TimeoutError' ? 'timeout' : error.message.slice(0, 64);
  return 'error';
}

function defaultLog(level: 'info' | 'error', fields: Record<string, unknown>): void {
  (level === 'error' ? console.error : console.info)(JSON.stringify(fields));
}

function bearerMatches(header: string | undefined, secret: string | undefined): boolean {
  if (!secret || !header?.startsWith('Bearer ')) return false;
  const a = Buffer.from(header.slice(7));
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Per instance: the latest row is read at most once a minute; the edge caches the rest. */
const READ_CACHE_MS = 60_000;

export function registerCodeCountRoutes(
  app: FastifyInstance,
  d: {
    db: Pick<Database, 'query'>;
    limit: (key: string, max: number, windowMs: number) => Promise<void>;
    /** Without it the cron route answers 404, like the other cron routes. */
    cronSecret?: string;
    token?: string;
    fetcher?: Fetch;
    clock?: () => number;
    log?: CodeCountLog;
  },
): void {
  const clock = d.clock ?? Date.now;
  let cached: { at: number; count: CodeCount | null } | null = null;

  app.get('/api/cron/code-count', async (request, reply) => {
    if (!bearerMatches(request.headers.authorization, d.cronSecret))
      return reply.code(404).send({ error: 'Not found.' });
    const run = await runCodeCount({
      db: d.db,
      fetcher: d.fetcher ?? ((url, init) => fetch(url, init)),
      token: d.token,
      clock,
      log: d.log,
    });
    if (run.status === 'counted') cached = { at: clock(), count: run.count };
    const body =
      run.status === 'counted' || run.status === 'unchanged'
        ? { status: run.status, total: run.count.total, counted_at: run.count.counted_at }
        : run;
    return reply
      .code(run.status === 'failed' ? 502 : 200)
      .header('Cache-Control', 'no-store')
      .send(body);
  });

  app.get('/api/public/code', async (request, reply) => {
    // No query, refused before the limiter: the edge cache keeps one entry for the count (a bare
    // '?' or a stray '&' is another entry too).
    if (request.url.includes('?'))
      return reply
        .code(400)
        .header('Cache-Control', 'no-store')
        .send({ error: 'This address takes no query.' });
    await d.limit(
      `ip:code:${clientAddressKey(request.ip)}`,
      PUBLIC_CODE_RATE.max,
      PUBLIC_CODE_RATE.windowMs,
    );
    const now = clock();
    if (!cached || now - cached.at > READ_CACHE_MS)
      cached = { at: now, count: await latestCodeCount(d.db) };
    if (!cached.count)
      return reply.code(503).header('Cache-Control', 'no-store').send({ error: 'not_counted_yet' });
    return reply
      .header('Cache-Control', PUBLIC_CODE_CACHE_CONTROL)
      .header('Vercel-CDN-Cache-Control', PUBLIC_CODE_EDGE_CACHE_CONTROL)
      .send(withAppCount(cached.count, builtAppCount()));
  });
}
