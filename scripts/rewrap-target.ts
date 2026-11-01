import { resolve } from 'node:path';

/**
 * Which database a key re-wrap script runs against, decided before anything is opened. A script
 * that silently fell back to the local data directory while DATABASE_URL pointed at the hosted
 * database would report "pending":0 from the wrong database, and the previous key would then be
 * removed too early. So the two settings must agree: DATABASE_URL only with CITY_HOSTED=1, and
 * CITY_HOSTED=1 only with DATABASE_URL. The description names the host and database (or the
 * local directory), never credentials.
 */
export type RewrapTarget =
  { hosted: true; description: string } | { hosted: false; dataDir: string; description: string };

export function rewrapTarget(env: Record<string, string | undefined>): RewrapTarget {
  const hosted = env.CITY_HOSTED === '1';
  const url = env.DATABASE_URL?.trim();
  if (url && !hosted)
    throw new Error(
      'DATABASE_URL is set without CITY_HOSTED=1; refusing to run against the local database by mistake. Set CITY_HOSTED=1 for the hosted database, or unset DATABASE_URL.',
    );
  if (hosted && !url) throw new Error('CITY_HOSTED=1 needs DATABASE_URL; nothing was changed.');
  if (hosted) {
    let host = 'unknown';
    let database = 'unknown';
    try {
      const parsed = new URL(url!);
      host = parsed.hostname || host;
      database = decodeURIComponent(parsed.pathname.replace(/^\//, '')) || database;
    } catch {
      // loadHostedConfig refuses a malformed URL with its own message.
    }
    return { hosted: true, description: `postgres host=${host} database=${database}` };
  }
  const dataDir = resolve(env.CITY_DATA_DIR ?? '.local/data');
  return { hosted: false, dataDir, description: `local pglite dir=${dataDir}` };
}
