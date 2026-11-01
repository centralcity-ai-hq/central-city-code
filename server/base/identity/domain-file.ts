/*
 * The domain file (`/.well-known/agent-registration.json`, short-links.ts) built off the request
 * path. A cron (vercel.json crons, every minute) reads the registrations once per origin it serves
 * and stores the body, gzip-compressed, in `base_domain_files`; the route only reads that row. So
 * a request never reads the identities, the workspaces or the cards, however many agents there
 * are, and the file a third party fetches is the same for one minute on every instance.
 *
 * Size (CCA-118): the function host refuses a response body over DOMAIN_FILE_BODY_LIMIT, and a
 * file that lists every registration would pass it, compressed too, and then fail for every
 * reader. So the file is scoped (short-links.ts: the newest DOMAIN_FILE_SCOPE registrations of
 * each chain, the full list paginated at DOMAIN_PAGES_PATH), and each build has a size guard:
 *   - `domain_file_large` (level ALERT) once the uncompressed body passes DOMAIN_FILE_ALERT_BYTES,
 *     well below the limit: the scope no longer keeps the file small and needs a look;
 *   - `domain_file_refused` (level ALERT) for a body over DOMAIN_FILE_MAX_BYTES: it is never
 *     stored, and readers keep getting the last stored file, which fits;
 *   - `domain_file_built` whenever the file changed.
 * Lines go to options.logLine, else the console (ALERT lines to console.error): the app's Fastify
 * logger is off in production, so a request logger would drop them.
 */
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import type { FastifyInstance } from 'fastify';
import type { Database } from '../../database.js';
import { registerMigration, type Migration } from '../../migrations.js';
import { cronAuthorized } from '../../wake/cron.js';
import { buildDomainRegistrations } from '../../../shared/base/registration.js';
import {
  DOMAIN_FILE_ALERT_BYTES,
  DOMAIN_FILE_BODY_LIMIT,
  DOMAIN_FILE_MAX_BYTES,
  DOMAIN_FILE_SCOPE,
  domainRegistrations,
} from './short-links.js';

export const DOMAIN_FILE_TABLES = ['base_domain_files'] as const;

/**
 * Migration 281 `base_domain_files`: the stored domain file of each origin: its JSON body
 * gzip-compressed, the body's SHA-256 (a build that changed nothing writes only built_at), its
 * entry count and uncompressed size, and when it was last built. Derived data: built again by the
 * next cron run, never exported or restored.
 */
export const BASE_DOMAIN_FILES_SQL = `
CREATE TABLE IF NOT EXISTS base_domain_files (
  origin text PRIMARY KEY,
  body bytea NOT NULL,
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  entries integer NOT NULL CHECK (entries >= 0),
  bytes integer NOT NULL CHECK (bytes >= 0),
  built_at bigint NOT NULL
);`;

export const baseDomainFilesMigration: Migration = {
  version: 281,
  name: 'base_domain_files',
  sql: BASE_DOMAIN_FILES_SQL,
};

/** Idempotent; call before runMigrations. */
export function registerBaseDomainFilesMigration(): void {
  registerMigration(baseDomainFilesMigration);
}

export const DOMAIN_FILE_PATH = '/api/cron/base-domain-file';
/** The build's own statement timeout: off the request path, it may read every identity. */
export const DOMAIN_FILE_BUILD_TIMEOUT_MS = 60_000;

export interface DomainFileBuild {
  entries: number;
  bytes: number;
  gzipBytes: number;
  changed: boolean;
  /** Over DOMAIN_FILE_MAX_BYTES: not stored (see the header). */
  refused?: true;
}

export interface DomainFileOptions {
  now?: () => number;
  /** One JSON line per event; default the console (see the header). */
  logLine?: (line: string) => void;
  /** Tests only: the scope and the guard's bounds (default the constants). */
  scope?: number;
  alertBytes?: number;
  maxBytes?: number;
}

/** One line to the effective sink: options.logLine, else console.error (ALERT) or console.info. */
function domainLog(options: DomainFileOptions, fields: Record<string, unknown>): void {
  const line = JSON.stringify(fields);
  if (options.logLine) options.logLine(line);
  else if (fields.level === 'ALERT') console.error(line);
  else console.info(line);
}

/** Builds and stores the domain file of one origin, scoped and size-guarded (see the header). */
export async function buildDomainFile(
  db: Pick<Database, 'query' | 'transaction'>,
  origin: string,
  options: DomainFileOptions = {},
): Promise<DomainFileBuild> {
  const now = options.now ?? Date.now;
  const maxBytes = options.maxBytes ?? DOMAIN_FILE_MAX_BYTES;
  const rows = await domainRegistrations(db, origin, {
    statementTimeoutMs: DOMAIN_FILE_BUILD_TIMEOUT_MS,
    scope: options.scope ?? DOMAIN_FILE_SCOPE,
  });
  const json = JSON.stringify(
    buildDomainRegistrations(
      rows.map((row) => ({
        chainId: row.chain_id,
        registry: row.registry_address,
        erc8004AgentId: row.erc8004_agent_id,
      })),
    ),
  );
  const bytes = Buffer.byteLength(json);
  if (bytes > maxBytes) {
    // Never stored: the last stored file (which fit) stays what readers get.
    domainLog(options, {
      event: 'domain_file_refused',
      level: 'ALERT',
      origin,
      entries: rows.length,
      bytes,
      maxBytes,
      limitBytes: DOMAIN_FILE_BODY_LIMIT,
    });
    return { entries: rows.length, bytes, gzipBytes: 0, changed: false, refused: true };
  }
  const sha256 = createHash('sha256').update(json).digest('hex');
  const builtAt = now();
  const same = await db.query(
    'UPDATE base_domain_files SET built_at = $3 WHERE origin = $1 AND sha256 = $2 RETURNING origin',
    [origin, sha256, builtAt],
  );
  const body = gzipSync(json);
  const changed = same.rows.length === 0;
  if (changed)
    await db.query(
      `INSERT INTO base_domain_files (origin, body, sha256, entries, bytes, built_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (origin) DO UPDATE SET body = EXCLUDED.body, sha256 = EXCLUDED.sha256,
         entries = EXCLUDED.entries, bytes = EXCLUDED.bytes, built_at = EXCLUDED.built_at`,
      [origin, body, sha256, rows.length, bytes, builtAt],
    );
  const fields = { entries: rows.length, bytes, gzipBytes: body.length };
  if (changed) domainLog(options, { event: 'domain_file_built', ...fields });
  if (bytes >= (options.alertBytes ?? DOMAIN_FILE_ALERT_BYTES))
    domainLog(options, {
      event: 'domain_file_large',
      level: 'ALERT',
      origin,
      ...fields,
      limitBytes: DOMAIN_FILE_BODY_LIMIT,
    });
  return { ...fields, changed };
}

/**
 * The cron: one build per origin `origins()` names (the hosted origins); a failed origin is
 * logged and the others still build. Without the secret the route is absent.
 */
export function registerDomainFileCron(
  app: FastifyInstance,
  deps: {
    db: Database;
    cronSecret?: string;
    origins: () => readonly string[];
    now?: () => number;
    /** Runs first in every run: the confirmed IDs' log watch (moves.ts), whose moves it builds on. */
    before?: () => Promise<unknown>;
    /** The builds' log sink (app options.logLine); default the console (see the header). */
    logLine?: (line: string) => void;
  },
): void {
  const cronSecret = deps.cronSecret;
  if (!cronSecret) return;
  app.get(DOMAIN_FILE_PATH, async (request, reply) => {
    if (!cronAuthorized(request.headers.authorization, cronSecret))
      return reply.code(404).send({ error: 'Not found.' });
    const watched = deps.before ? await deps.before() : undefined;
    const built: Record<string, DomainFileBuild | { error: true }> = {};
    for (const origin of deps.origins()) {
      const options: DomainFileOptions = {
        ...(deps.now ? { now: deps.now } : {}),
        ...(deps.logLine ? { logLine: deps.logLine } : {}),
      };
      try {
        built[origin] = await buildDomainFile(deps.db, origin, options);
      } catch {
        (deps.logLine ?? console.error)(
          JSON.stringify({ event: 'domain_file_build_failed', origin }),
        );
        built[origin] = { error: true };
      }
    }
    return reply
      .header('Cache-Control', 'no-store')
      .send({ ...(watched === undefined ? {} : { watched }), built });
  });
}
