import { Pool } from 'pg';

/** Small common surface implemented by both PGlite and managed PostgreSQL. */
export interface Transaction {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  exec(sql: string): Promise<unknown>;
}
export interface Database extends Transaction {
  transaction<T>(action: (tx: Transaction) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

// Longer than the checkpoint's 120s server statement limit, shorter than the 300s invocation.
export const POSTGRES_QUERY_TIMEOUT_MS = 130_000;
const readTimedOut = (error: unknown) =>
  error instanceof Error && error.message === 'Query read timeout';

/**
 * Postgres conditions that say "not now", never "wrong": a lock or statement that timed out, a
 * serialization conflict or deadlock victim, or a server that is restarting or out of slots. Class
 * 08 (connection exception) is matched by prefix.
 */
const TRANSIENT_SQLSTATES = new Set([
  '40001', // serialization_failure
  '40P01', // deadlock_detected
  '55P03', // lock_not_available (lock_timeout)
  '57014', // query_canceled (statement_timeout)
  '57P01', // admin_shutdown
  '57P02', // crash_shutdown
  '57P03', // cannot_connect_now
  '53300', // too_many_connections
]);
/** Socket failures under the driver (the database host went away mid-query). */
const TRANSIENT_SOCKET_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE']);
/** The pool's own messages: no free client in time, or a client lost mid-query. */
const TRANSIENT_POOL_MESSAGE =
  /^(timeout exceeded when trying to connect|Connection terminated|Query read timeout)/;

/**
 * A database failure that a later identical request may not meet: the request did nothing it can
 * report, but nothing it wrote is half-done either (every statement is atomic). Anything else
 * (a constraint violation, a syntax error, a programming error) is not transient.
 */
export function transientDatabaseError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string')
    if (
      TRANSIENT_SQLSTATES.has(code) ||
      /^08[0-9A-Z]{3}$/.test(code) ||
      TRANSIENT_SOCKET_CODES.has(code)
    )
      return true;
  return error instanceof Error && TRANSIENT_POOL_MESSAGE.test(error.message);
}

export function postgresDatabase(pool: Pool): Database {
  // Idle network errors must not become uncaught exceptions or leak connection details.
  pool.on('error', () => {});
  const query: Transaction['query'] = async (sql, params) => {
    const result = await pool.query(sql, params);
    return { rows: result.rows };
  };
  const transaction: Database['transaction'] = async (action) => {
    const client = await pool.connect();
    let broken = false;
    let readFailure: unknown;
    const run = async (sql: string, params?: unknown[]) => {
      if (broken) throw readFailure;
      try {
        return await client.query(sql, params);
      } catch (error) {
        if (readTimedOut(error)) {
          broken = true;
          readFailure = error;
        }
        throw error;
      }
    };
    try {
      await run('BEGIN');
      const result = await action({
        query: async (sql, params) => ({ rows: (await run(sql, params)).rows }),
        exec: (sql) => run(sql),
      });
      if (broken) throw readFailure;
      await run('COMMIT');
      return result;
    } catch (error) {
      // pg's read timeout does not guarantee cancellation. Do not queue ROLLBACK behind a
      // possibly stuck query or return that connection to the pool; discard it below.
      if (!broken) {
        try {
          await run('ROLLBACK');
        } catch {
          broken = true;
        }
      }
      throw error;
    } finally {
      client.release(broken);
    }
  };
  return {
    query,
    transaction,
    // Serialize schema initialization across independent function instances.
    exec: (sql) =>
      transaction(async (tx) => {
        await tx.query('SELECT pg_advisory_xact_lock(1128485465)');
        return tx.exec(sql);
      }),
    close: () => pool.end(),
  };
}

/** Connections per instance when CITY_DB_POOL_MAX is not set (or not a whole number in bounds). */
export const DB_POOL_MAX_DEFAULT = 10;
export const DB_POOL_MAX_MIN = 3;
export const DB_POOL_MAX_MAX = 50;

/**
 * The pool size per instance: CITY_DB_POOL_MAX as a whole number from DB_POOL_MAX_MIN to
 * DB_POOL_MAX_MAX, else DB_POOL_MAX_DEFAULT. Raised under load when every route answers db.busy
 * code "pool" (21 Oct: Block D, the Base fleets and the joiners queued past the 5 s connect
 * timeout on 10 connections per instance).
 */
export function dbPoolMax(env: Record<string, string | undefined> = process.env): number {
  const raw = env.CITY_DB_POOL_MAX?.trim();
  if (!raw || !/^\d{1,3}$/.test(raw)) return DB_POOL_MAX_DEFAULT;
  const n = Number(raw);
  return n >= DB_POOL_MAX_MIN && n <= DB_POOL_MAX_MAX ? n : DB_POOL_MAX_DEFAULT;
}

export async function openPostgres(connectionString: string): Promise<Database> {
  const url = new URL(connectionString);
  // pg connection-string SSL switches can override the explicit TLS object.
  for (const key of [...url.searchParams.keys()])
    if (key.toLowerCase().startsWith('ssl') || key === 'uselibpqcompat')
      url.searchParams.delete(key);
  const db = postgresDatabase(
    new Pool({
      connectionString: url.toString(),
      ssl: { rejectUnauthorized: true },
      // DATABASE_URL is Neon's pooled endpoint (PgBouncer, up to 10,000 clients), so one instance
      // may hold more than 3 clients: with 3, concurrent requests queued past the 5 s connect
      // timeout and answered busy (db.busy code "pool") under load.
      max: dbPoolMax(),
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 5_000,
      statement_timeout: 8_000,
      query_timeout: POSTGRES_QUERY_TIMEOUT_MS,
      lock_timeout: 5_000,
      idle_in_transaction_session_timeout: 10_000,
      allowExitOnIdle: true,
    }),
  );
  try {
    await db.query('SELECT 1');
    return db;
  } catch {
    await db.close();
    throw new Error('Hosted database connection failed.');
  }
}
