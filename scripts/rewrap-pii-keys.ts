import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { rewrapTarget, type RewrapTarget } from './rewrap-target.js';
import type { Database } from '../server/database.js';
import { piiKeys } from '../server/google/pii-keys.js';
import { rewrapPiiKeys } from '../server/google/pii.js';

/**
 * Retires CITY_PII_KEK_PREVIOUS (docs/GOOGLE_SIGNIN.md "Date of birth"). Re-wraps every stored
 * date of birth's data key under the current CITY_PII_KEK; the ciphertext is unchanged. Prints
 * counts only, never ids, dates, keys or database errors.
 *
 *   CITY_HOSTED=1 DATABASE_URL=… CITY_PII_KEK=<new> CITY_PII_KEK_PREVIOUS=<old> \
 *     node --import tsx scripts/rewrap-pii-keys.ts            # dry run: {"pending":N,...}
 *   … scripts/rewrap-pii-keys.ts --confirm                    # re-wrap
 *
 * The target database and the key ids go to stderr first; DATABASE_URL without CITY_HOSTED=1 (or
 * the reverse) is refused. A row that fails is counted as "failed" (exit 1) and the run continues.
 * Idempotent: run --confirm until the dry run reports "pending":0, then remove
 * CITY_PII_KEK_PREVIOUS and deploy. "unknownRoot" rows were wrapped under a key the server no
 * longer has: those owners enter their date of birth again. "ageLocksNotRewrapped" counts every
 * Google age lock: none is re-keyed here (see the age lock note in docs/GOOGLE_SIGNIN.md).
 */
async function main(argv: string[]): Promise<void> {
  const unknown = argv.filter((arg) => arg !== '--confirm' && arg !== '--dry-run');
  if (unknown.length || (argv.includes('--confirm') && argv.includes('--dry-run'))) {
    console.error('Usage: rewrap-pii-keys.ts [--dry-run (default) | --confirm]');
    process.exit(1);
  }
  let target: RewrapTarget;
  try {
    target = rewrapTarget(process.env);
  } catch (error) {
    console.error((error as Error).message);
    process.exit(1);
  }
  const keyring = piiKeys(process.env, { hosted: true });
  if (!keyring.available) {
    console.error(`PII key unavailable (reason=${keyring.reason}); nothing was changed.`);
    process.exit(1);
  }
  const { openPostgres } = await import('../server/database.js');
  const { loadHostedConfig } = await import('../server/hosted.js');
  const { acquireDataLock } = await import('../server/data-lock.js');
  let db: Pick<Database, 'query' | 'transaction'> & { close(): Promise<void> };
  let release: (() => Promise<void>) | undefined;
  if (target.hosted)
    db = (await openPostgres(loadHostedConfig().databaseUrl)) as unknown as typeof db;
  else {
    const lock = await acquireDataLock(target.dataDir);
    const { PGlite } = await import('@electric-sql/pglite');
    db = (await PGlite.create(lock.dataDir)) as unknown as typeof db;
    release = () => lock.release();
  }
  // On stderr, so stdout stays the JSON counts. Key ids are public fingerprints.
  console.error(
    `target: ${target.description}; current key ${keyring.current.kid}; also opens ${
      keyring.all
        .slice(1)
        .map((key) => key.kid)
        .join(',') || 'none'
    }`,
  );
  try {
    const counts = await rewrapPiiKeys(db, keyring, { confirm: argv.includes('--confirm') });
    // Google age locks are keyed hashes of subjects that are not stored, so this script cannot
    // carry them to the new key: each moves when its Google account is seen while both keys are
    // set (server/google/cooldown.ts). The total is printed so the previous key is not removed
    // without that decision (docs/GOOGLE_SIGNIN.md "Age locks during a rotation").
    const ageLocks = Number(
      (await db.query<{ n: string }>('SELECT count(*) AS n FROM google_age_locks')).rows[0]?.n ?? 0,
    );
    console.log(JSON.stringify({ ...counts, ageLocksNotRewrapped: ageLocks }));
    if (counts.failed > 0) process.exitCode = 1;
  } catch {
    console.error('PII key re-wrap failed; rows already re-wrapped stay valid. Re-run it.');
    process.exitCode = 1;
  } finally {
    await db.close();
    await release?.();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await main(process.argv.slice(2));
