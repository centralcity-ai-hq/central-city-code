import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { rewrapTarget, type RewrapTarget } from './rewrap-target.js';
import type { Database } from '../server/database.js';
import { cleanRoomLabels } from '../server/rooms/clean-labels.js';

/**
 * CCA-628, stored rooms: cleans the name and topic of every room with the create/rename cleaner
 * (server/rooms/clean-labels.ts), in batches, one audit row per changed room. Prints counts only,
 * never ids or text. Idempotent: run it again until the dry run reports "changed":0 (and again
 * after a deploy that makes the cleaner stricter).
 *
 *   CITY_HOSTED=1 DATABASE_URL=… node --import tsx scripts/clean-room-labels.ts            # dry run
 *   CITY_HOSTED=1 DATABASE_URL=… node --import tsx scripts/clean-room-labels.ts --confirm  # clean
 *   … --batch=200                                                    # rooms per transaction
 *
 * The target database goes to stderr first; DATABASE_URL without CITY_HOSTED=1 (or the reverse)
 * is refused. Each batch is its own short transaction (its rooms' rows locked for milliseconds,
 * lock_timeout 2 s): a failure stops the run with every earlier batch kept; run it again.
 */
async function main(argv: string[]): Promise<void> {
  const batchArg = argv.find((arg) => arg.startsWith('--batch='));
  const unknown = argv.filter(
    (arg) => arg !== '--confirm' && arg !== '--dry-run' && arg !== batchArg,
  );
  const batch = batchArg ? Number(batchArg.slice('--batch='.length)) : 200;
  if (
    unknown.length ||
    (argv.includes('--confirm') && argv.includes('--dry-run')) ||
    !Number.isSafeInteger(batch) ||
    batch < 1 ||
    batch > 1000
  ) {
    console.error(
      'Usage: clean-room-labels.ts [--dry-run (default) | --confirm] [--batch=1..1000]',
    );
    process.exit(1);
  }
  let target: RewrapTarget;
  try {
    target = rewrapTarget(process.env);
  } catch (error) {
    console.error((error as Error).message);
    process.exit(1);
  }
  const { openPostgres } = await import('../server/database.js');
  const { loadHostedConfig } = await import('../server/hosted.js');
  const { acquireDataLock } = await import('../server/data-lock.js');
  let db: Database;
  let release: (() => Promise<void>) | undefined;
  if (target.hosted) db = await openPostgres(loadHostedConfig().databaseUrl);
  else {
    const lock = await acquireDataLock(target.dataDir);
    const { PGlite } = await import('@electric-sql/pglite');
    db = (await PGlite.create(lock.dataDir)) as unknown as Database;
    release = () => lock.release();
  }
  const confirm = argv.includes('--confirm');
  console.error(
    `target: ${target.description}; ${confirm ? 'confirm' : 'dry run'}; batch ${batch}`,
  );
  try {
    const counts = await cleanRoomLabels(db, {
      confirm,
      batchSize: batch,
      onBatch: (so) => {
        if (so.batches % 50 === 0) console.error(JSON.stringify({ progress: so }));
      },
    });
    console.log(JSON.stringify({ dryRun: !confirm, ...counts }));
  } catch {
    console.error('Room label cleaning stopped; batches already done stay done. Run it again.');
    process.exitCode = 1;
  } finally {
    await db.close();
    await release?.();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await main(process.argv.slice(2));
