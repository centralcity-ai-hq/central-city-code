import { Client } from 'pg';
import { prebuildIndexes } from '../server/concurrent-index.js';
import { ROOM_THREAD_INDEXES } from '../server/rooms/message-extras-schema.js';

/**
 * Builds the thread index of migration 333 (server/rooms/message-extras-schema.ts) on the hosted
 * database with CREATE INDEX CONCURRENTLY: posts and reads of room_messages go on while it
 * builds. After the deploy that carries migrations 332 and 333 (the migration never builds it on
 * a large table
 * and never fails). Dry run unless --confirm; prints one JSON line per index (its state before
 * and after, what was done, ms). An index a failed build left invalid is dropped and built again;
 * run it again after any failure.
 *
 * Needs a DIRECT connection (CITY_DIRECT_DATABASE_URL, the unpooled endpoint): CONCURRENTLY cannot
 * run in a transaction, and a build outlasts the pooled endpoint's limits. No statement timeout;
 * a lock wait longer than 30 s fails (only VACUUM and other DDL on the table conflict).
 *
 *   CITY_DIRECT_DATABASE_URL=... npx tsx scripts/room-thread-index.ts            # dry run
 *   CITY_DIRECT_DATABASE_URL=... npx tsx scripts/room-thread-index.ts --confirm  # build
 */
const args = process.argv.slice(2);
if (args.some((arg) => arg !== '--confirm')) {
  console.error('Usage: room-thread-index.ts [--confirm]');
  process.exit(1);
}
const confirm = args.includes('--confirm');
const raw = process.env.CITY_DIRECT_DATABASE_URL?.trim();
if (!raw) {
  console.error('Set CITY_DIRECT_DATABASE_URL to the unpooled (direct) database URL.');
  process.exit(1);
}
const url = new URL(raw);
if (/-pooler\./.test(url.hostname)) {
  console.error('That is the pooled endpoint; use the direct (unpooled) one.');
  process.exit(1);
}
for (const key of [...url.searchParams.keys()])
  if (key.toLowerCase().startsWith('ssl') || key === 'uselibpqcompat') url.searchParams.delete(key);
// The target, never the credentials.
console.error(JSON.stringify({ target: { host: url.hostname, database: url.pathname.slice(1) } }));

const client = new Client({
  connectionString: url.toString(),
  ssl: { rejectUnauthorized: true },
  application_name: 'room-thread-index',
});
await client.connect();
try {
  await client.query("SET statement_timeout = 0; SET lock_timeout = '30s'");
  await prebuildIndexes((sql) => client.query(sql), ROOM_THREAD_INDEXES, {
    confirm,
    onStep: (step) => console.log(JSON.stringify(step)),
  });
  if (!confirm) console.log(JSON.stringify({ dryRun: true, next: 'run again with --confirm' }));
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Index build failed.');
  process.exitCode = 1;
} finally {
  await client.end();
}
