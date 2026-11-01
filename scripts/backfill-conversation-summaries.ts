import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { rewrapTarget, type RewrapTarget } from './rewrap-target.js';
import type { Database } from '../server/database.js';
import { backfillConversationSummaries } from '../server/messaging/summaries-backfill.js';

/**
 * R8-2: the one-off backfill of migration 302 (conversation_summaries,
 * server/messaging/summaries-backfill.ts). Recounts every (owner, thread) exactly, one short
 * transaction each, then sets conversation_summaries_meta.backfilled_at, after which the
 * conversation list picks its page from the summaries. It reads every message once: run it at a
 * quiet hour. Prints counts only, never ids or text. Safe to run again (complete rows are
 * skipped); run it again until it reports "backfilled":true and "failed":0.
 *
 *   CITY_HOSTED=1 DATABASE_URL=… node --import tsx scripts/backfill-conversation-summaries.ts            # dry run
 *   CITY_HOSTED=1 DATABASE_URL=… node --import tsx scripts/backfill-conversation-summaries.ts --confirm  # backfill
 *   … --batch=100                                                    # threads read per step
 *
 * The target database goes to stderr first; DATABASE_URL without CITY_HOSTED=1 (or the reverse)
 * is refused.
 */
async function main(argv: string[]): Promise<void> {
  const batchArg = argv.find((arg) => arg.startsWith('--batch='));
  const unknown = argv.filter(
    (arg) => arg !== '--confirm' && arg !== '--dry-run' && arg !== batchArg,
  );
  const batch = batchArg ? Number(batchArg.slice('--batch='.length)) : 100;
  if (
    unknown.length ||
    (argv.includes('--confirm') && argv.includes('--dry-run')) ||
    !Number.isSafeInteger(batch) ||
    batch < 1 ||
    batch > 1000
  ) {
    console.error(
      'Usage: backfill-conversation-summaries.ts [--dry-run (default) | --confirm] [--batch=1..1000]',
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
    const counts = await backfillConversationSummaries(db, {
      confirm,
      threadsPerBatch: batch,
      onBatch: (so) => {
        if (so.batches % 50 === 0) console.error(JSON.stringify({ progress: so }));
      },
    });
    console.log(JSON.stringify({ dryRun: !confirm, ...counts }));
    if (counts.failed > 0) process.exitCode = 1;
  } catch {
    console.error('The backfill stopped; rows already recounted stay complete. Run it again.');
    process.exitCode = 1;
  } finally {
    await db.close();
    await release?.();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await main(process.argv.slice(2));
