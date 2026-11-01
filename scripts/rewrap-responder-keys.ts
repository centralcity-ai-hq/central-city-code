import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { rewrapTarget, type RewrapTarget } from './rewrap-target.js';
import type { Transaction } from '../server/database.js';
import { responderKeys } from '../server/responder/keys.js';
import { rewrapResponderKeys } from '../server/responder/rotation.js';

/**
 * Retires CITY_RESPONDER_KEK_PREVIOUS (docs/RESPONDER.md "Rotation"). Re-wraps every stored
 * provider key's data key under the current CITY_RESPONDER_KEK. Prints counts only, never ids,
 * keys or database errors.
 *
 *   CITY_HOSTED=1 DATABASE_URL=… CITY_RESPONDER_KEK=<new> CITY_RESPONDER_KEK_PREVIOUS=<old> \
 *     node --import tsx scripts/rewrap-responder-keys.ts            # dry run: {"pending":N,...}
 *   … scripts/rewrap-responder-keys.ts --confirm                    # re-wrap
 *
 * The target database and the root key ids go to stderr first; DATABASE_URL without
 * CITY_HOSTED=1 (or the reverse) is refused. A row that fails is counted as "failed" (exit 1) and
 * the run continues. Run --confirm until the dry run reports "pending":0, then remove
 * CITY_RESPONDER_KEK_PREVIOUS and deploy. "unknownRoot" rows were wrapped under a key the server no longer has: their owners
 * must add the key again.
 */
type Db = Pick<Transaction, 'query'> & {
  transaction<T>(action: (tx: Transaction) => Promise<T>): Promise<T>;
  close(): Promise<void>;
};

async function main(argv: string[]): Promise<void> {
  const unknown = argv.filter((arg) => arg !== '--confirm' && arg !== '--dry-run');
  if (unknown.length || (argv.includes('--confirm') && argv.includes('--dry-run'))) {
    console.error('Usage: rewrap-responder-keys.ts [--dry-run (default) | --confirm]');
    process.exit(1);
  }
  let target: RewrapTarget;
  try {
    target = rewrapTarget(process.env);
  } catch (error) {
    console.error((error as Error).message);
    process.exit(1);
  }
  const keyring = responderKeys(process.env, { hosted: true });
  if (!keyring.available) {
    console.error(`Root key unavailable (reason=${keyring.reason}); nothing was changed.`);
    process.exit(1);
  }
  const { openPostgres } = await import('../server/database.js');
  const { loadHostedConfig } = await import('../server/hosted.js');
  const { acquireDataLock } = await import('../server/data-lock.js');
  let db: Db;
  let release: (() => Promise<void>) | undefined;
  if (target.hosted) db = (await openPostgres(loadHostedConfig().databaseUrl)) as unknown as Db;
  else {
    const lock = await acquireDataLock(target.dataDir);
    const { PGlite } = await import('@electric-sql/pglite');
    db = (await PGlite.create(lock.dataDir)) as unknown as Db;
    release = () => lock.release();
  }
  // On stderr, so stdout stays the JSON counts. Key ids and versions are public fingerprints.
  console.error(
    `target: ${target.description}; current root ${keyring.current.kid}; also opens ${
      keyring.all
        .slice(1)
        .map((key) => key.kid)
        .join(',') || 'none'
    }`,
  );
  try {
    const counts = await rewrapResponderKeys(db, keyring, { confirm: argv.includes('--confirm') });
    console.log(JSON.stringify(counts));
    // A row that failed stays on its old root: PREVIOUS must not be removed yet.
    if (counts.failed > 0) process.exitCode = 1;
  } catch {
    console.error('Responder key re-wrap failed; rows already re-wrapped stay valid. Re-run it.');
    process.exitCode = 1;
  } finally {
    await db.close();
    await release?.();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await main(process.argv.slice(2));
