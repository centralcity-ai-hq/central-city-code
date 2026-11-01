import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Database } from '../server/database.js';
import { openPostgres } from '../server/database.js';
import { acquireDataLock } from '../server/data-lock.js';
import { loadHostedConfig } from '../server/hosted.js';
import { AccountErasureError, parseErasureArgs } from '../server/account/erase.js';
import { runAccountErasure } from '../server/account/erase-ledger.js';

/**
 * Erases a person's account on a verified request (docs/ACCOUNT_ERASURE.md). Uses the same
 * database configuration as the app: hosted PostgreSQL (CITY_HOSTED=1, DATABASE_URL) or the local
 * PGlite directory (CITY_DATA_DIR, default .local/data, which must not be in use by a running
 * app). Dry run unless --confirm; prints the JSON result. A confirmed erase needs --ledger, a file
 * kept outside the database: its intent line is flushed to disk before the erasure commits and
 * its done line after (server/account/erase-ledger.ts), and `reapply` erases those accounts again
 * after a backup restore. On any failure it prints the exact state and exits non-zero.
 */
let command: ReturnType<typeof parseErasureArgs>;
try {
  command = parseErasureArgs(process.argv.slice(2));
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}
let db: Database;
let release: (() => Promise<void>) | undefined;
if (process.env.CITY_HOSTED === '1') db = await openPostgres(loadHostedConfig().databaseUrl);
else {
  const lock = await acquireDataLock(resolve(process.env.CITY_DATA_DIR ?? '.local/data'));
  const { PGlite } = await import('@electric-sql/pglite');
  db = (await PGlite.create(lock.dataDir)) as unknown as Database;
  release = () => lock.release();
}
try {
  const run = await runAccountErasure(db, command, {
    now: Date.now(),
    readLedger: (path) => readFile(path, 'utf8'),
  });
  console.log(JSON.stringify(run.output));
  if (run.exitCode) console.error(String(run.output.error));
  process.exitCode = run.exitCode;
} catch (error) {
  console.error(
    error instanceof AccountErasureError
      ? `${error.code}: ${error.message}`
      : error instanceof Error
        ? error.message
        : 'Account erasure failed.',
  );
  process.exitCode = 1;
} finally {
  await db.close();
  await release?.();
}
