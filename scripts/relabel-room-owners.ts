import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { relabelRoomOwners, type RelabelDb } from '../server/rooms/relabel-owners.js';

/**
 * One-off relabel of the stored room owner labels (server/rooms/relabel-owners.ts). The default
 * is a dry run; --confirm applies. Output is counts only. Production runs it in the server instead
 * (the room-relabel cron), because its database URL and key are not readable outside it.
 *
 *   CITY_HOSTED=1 DATABASE_URL=… CITY_RATE_LIMIT_KEY=… node --import tsx scripts/relabel-room-owners.ts            # dry run
 *   CITY_HOSTED=1 DATABASE_URL=… CITY_RATE_LIMIT_KEY=… node --import tsx scripts/relabel-room-owners.ts --confirm
 */

export { relabelRoomOwners };

async function main(argv: string[]): Promise<void> {
  const unknown = argv.filter((arg) => arg !== '--confirm' && arg !== '--dry-run');
  if (unknown.length || (argv.includes('--confirm') && argv.includes('--dry-run'))) {
    console.error('Usage: relabel-room-owners.ts [--dry-run (default) | --confirm]');
    process.exit(1);
  }
  // The same secret the server keys person labels with; never echoed.
  const secret = process.env.CITY_RATE_LIMIT_KEY ?? '';
  if (secret.length < 32) {
    console.error(
      'Set CITY_RATE_LIMIT_KEY to the server secret of this deployment (at least 32 characters).',
    );
    process.exit(1);
  }
  const { openPostgres } = await import('../server/database.js');
  const { loadHostedConfig } = await import('../server/hosted.js');
  const { acquireDataLock } = await import('../server/data-lock.js');
  let db: RelabelDb & { close(): Promise<void> };
  let release: (() => Promise<void>) | undefined;
  if (process.env.CITY_HOSTED === '1') db = await openPostgres(loadHostedConfig().databaseUrl);
  else {
    const lock = await acquireDataLock(resolve(process.env.CITY_DATA_DIR ?? '.local/data'));
    const { PGlite } = await import('@electric-sql/pglite');
    db = (await PGlite.create(lock.dataDir)) as unknown as RelabelDb & { close(): Promise<void> };
    release = () => lock.release();
  }
  try {
    console.log(
      JSON.stringify(await relabelRoomOwners(db, { secret, confirm: argv.includes('--confirm') })),
    );
  } catch (error) {
    // Database errors can quote SQL parameters; print only a fixed line.
    console.error('Room owner relabel failed; batches before the failing one are applied.');
    if (error instanceof Error && /owner_kind/.test(error.message))
      console.error('Is migration 273 (room_owner_kind) applied? Deploy the release first.');
    process.exitCode = 1;
  } finally {
    await db.close();
    await release?.();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await main(process.argv.slice(2));
