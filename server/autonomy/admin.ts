import { UNCLAIMED_AGENT_TTL_MS } from './expiry-schema.js';
import type { Database, Transaction as Tx } from '../database.js';
import { clientAddressPrefixes } from '../rate-limit.js';
import {
  parseUnclaimedHold,
  UNCLAIMED_HOLD_TTL_MS,
  unclaimedScopeId,
  type UnclaimedHold,
} from './index.js';
import { agentCountSql, agentsArraySql } from '../agent-rows/sql.js';

/**
 * Operator abuse response for unclaimed partitions (scripts/unclaimed-admin.ts). Purging deletes
 * unclaimed agents and is a deliberate operator action, never automatic.
 * Only rows with operators.kind = 'unclaimed' are ever touched; owned workspaces are not.
 */
export type TopBy = '/48' | '/32' | 'partition';
export type PurgeTarget = { partition: string } | { prefix: string };
export type AdminCommand =
  | { command: 'list-top'; by: TopBy; limit: number }
  | { command: 'purge'; target: PurgeTarget; confirm: true }
  | { command: 'reconcile'; confirm: boolean };

export const ADMIN_USAGE = `Usage:
  pnpm unclaimed:admin -- list-top --by /48|/32|partition [--limit N]
  pnpm unclaimed:admin -- purge --partition <operator-id> --confirm
  pnpm unclaimed:admin -- purge --prefix <2001:db8::/32 | 203.0.0.0/16 | network:<key>> --confirm
  pnpm unclaimed:admin -- reconcile [--confirm]   (dry run unless --confirm)`;

export function parseAdminArgs(argv: readonly string[]): AdminCommand {
  const args = argv[0] === '--' ? argv.slice(1) : [...argv];
  const [command, ...rest] = args;
  const flags = new Map<string, string | true>();
  for (let index = 0; index < rest.length; index++) {
    const flag = rest[index]!;
    if (!flag.startsWith('--')) throw new Error(`Unexpected argument ${flag}.\n${ADMIN_USAGE}`);
    const next = rest[index + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags.set(flag, next);
      index++;
    } else flags.set(flag, true);
  }
  if (command === 'list-top') {
    const by = flags.get('--by');
    if (by !== '/48' && by !== '/32' && by !== 'partition')
      throw new Error(`list-top needs --by /48, /32 or partition.\n${ADMIN_USAGE}`);
    const limit = Number(flags.get('--limit') ?? 20);
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
      throw new Error('--limit must be 1-1000.');
    return { command, by, limit };
  }
  if (command === 'purge') {
    const partition = flags.get('--partition');
    const prefix = flags.get('--prefix');
    if ((typeof partition === 'string') === (typeof prefix === 'string'))
      throw new Error(`purge needs exactly one of --partition or --prefix.\n${ADMIN_USAGE}`);
    if (flags.get('--confirm') !== true)
      throw new Error('purge deletes unclaimed agents permanently; refusing without --confirm.');
    return {
      command,
      target: typeof partition === 'string' ? { partition } : { prefix: prefix as string },
      confirm: true,
    };
  }
  if (command === 'reconcile') {
    for (const flag of flags.keys())
      if (flag !== '--confirm') throw new Error(`Unknown flag ${flag}.\n${ADMIN_USAGE}`);
    const confirm = flags.get('--confirm');
    if (confirm !== undefined && confirm !== true)
      throw new Error(`--confirm takes no value.\n${ADMIN_USAGE}`);
    return { command, confirm: confirm === true };
  }
  throw new Error(ADMIN_USAGE);
}

export async function listTop(db: Pick<Database, 'query'>, by: TopBy, limit = 20) {
  if (by === 'partition')
    return (
      await db.query<{
        partition: string;
        agents: number;
        created_at: string | null;
        last_used_at: string | null;
      }>(
        `SELECT o.id AS partition, ${agentCountSql('w.operator_id', 'w.data')} AS agents,
          b.created_at, b.last_used_at
          FROM operators o JOIN workspaces w ON w.operator_id=o.id
          LEFT JOIN unclaimed_buckets b ON b.operator_id=o.id
          WHERE o.kind='unclaimed' ORDER BY agents DESC, o.id LIMIT $1`,
        [limit],
      )
    ).rows.map((row) => ({ ...row, agents: Number(row.agents) }));
  const scope = by === '/48' ? 'network' : 'region';
  return (
    await db.query<{ scope_key: string; agents: number }>(
      `SELECT scope_key, agents FROM unclaimed_stats WHERE scope_key LIKE $1
        ORDER BY agents DESC, scope_key LIMIT $2`,
      [`${scope}:%`, limit],
    )
  ).rows.map((row) => ({ ...row, agents: Number(row.agents) }));
}

/** Maps a literal prefix (or an already hashed `scope:key`) to its counter scope and key. */
export function resolvePrefix(prefix: string, secret: string): { scope: string; key: string } {
  const hashed = /^(site|network|region):([0-9a-f]{32})$/.exec(prefix);
  if (hashed) return { scope: hashed[1]!, key: hashed[2]! };
  const match = /^([0-9a-fA-F:.]+)\/(\d{1,3})$/.exec(prefix);
  if (!match)
    throw new Error('Use a prefix such as 2001:db8::/32, 2001:db8:1::/48 or 203.0.0.0/16.');
  const bits = Number(match[2]);
  const v6 = match[1]!.includes(':');
  const scope = v6
    ? ({ 56: 'site', 48: 'network', 32: 'region' } as Record<number, string>)[bits]
    : ({ 24: 'site', 16: 'network', 8: 'region' } as Record<number, string>)[bits];
  if (!scope) throw new Error('Supported prefixes: IPv6 /56, /48, /32 and IPv4 /24, /16, /8.');
  const canonical = clientAddressPrefixes(match[1]!)[scope as 'site' | 'network' | 'region'];
  return { scope, key: unclaimedScopeId(secret, scope, canonical) };
}

async function purgePartition(tx: Tx, id: string): Promise<number | null> {
  const row = (
    await tx.query<{ agents: StoredAgentIds[] }>(
      `SELECT ${agentsArraySql('w.operator_id', 'w.data')} AS agents FROM workspaces w JOIN operators o ON o.id=w.operator_id
        WHERE w.operator_id=$1 AND o.kind='unclaimed' FOR UPDATE OF w`,
      [id],
    )
  ).rows[0];
  if (!row) return null;
  const agentIds = row.agents.map((agent) => agent.id);
  const scopes = (
    await tx.query<{ site_key: string; network_key: string; region_key: string | null }>(
      'SELECT site_key,network_key,region_key FROM unclaimed_buckets WHERE operator_id=$1',
      [id],
    )
  ).rows[0];
  if (agentIds.length)
    await tx.query('DELETE FROM replay_nonces WHERE agent_id = ANY($1::text[])', [agentIds]);
  for (const sql of [
    'DELETE FROM anonymous_receipts WHERE bucket_id=$1',
    'DELETE FROM claim_tokens WHERE bucket_id=$1',
    'DELETE FROM runtime_enrollments WHERE operator_id=$1',
    'DELETE FROM credentials WHERE operator_id=$1',
    'DELETE FROM agent_presence WHERE operator_id=$1',
    'DELETE FROM agent_manifests WHERE operator_id=$1',
    'DELETE FROM unclaimed_buckets WHERE operator_id=$1',
    'DELETE FROM workspaces WHERE operator_id=$1',
    "DELETE FROM operators WHERE id=$1 AND kind='unclaimed'",
  ])
    await tx.query(sql, [id]);
  // Counters are decremented in the same transaction as the deletion.
  await tx.query(
    "UPDATE unclaimed_stats SET agents=GREATEST(agents-$1,0), buckets=GREATEST(buckets-1,0) WHERE scope_key='global'",
    [agentIds.length],
  );
  for (const key of scopes
    ? [
        `site:${scopes.site_key}`,
        `network:${scopes.network_key}`,
        ...(scopes.region_key ? [`region:${scopes.region_key}`] : []),
      ]
    : [])
    await tx.query('UPDATE unclaimed_stats SET agents=GREATEST(agents-$2,0) WHERE scope_key=$1', [
      key,
      agentIds.length,
    ]);
  return agentIds.length;
}
type StoredAgentIds = { id: string };

/** Deletes whole unclaimed partitions, each in its own transaction. Returns what was removed. */
export async function purge(
  db: Database,
  target: PurgeTarget,
  secret: string,
): Promise<{ partitions: number; agents: number; scope?: string }> {
  let ids: string[];
  let scope: string | undefined;
  if ('partition' in target) ids = [target.partition];
  else {
    const resolved = resolvePrefix(target.prefix, secret);
    scope = `${resolved.scope}:${resolved.key}`;
    const column = `${resolved.scope}_key`;
    ids = (
      await db.query<{ operator_id: string }>(
        `SELECT operator_id FROM unclaimed_buckets WHERE ${column}=$1 ORDER BY operator_id`,
        [resolved.key],
      )
    ).rows.map((row) => row.operator_id);
  }
  let partitions = 0;
  let agents = 0;
  for (const id of ids) {
    const removed = await db.transaction((tx) => purgePartition(tx, id));
    if (removed === null) continue;
    partitions++;
    agents += removed;
  }
  return { partitions, agents, ...(scope ? { scope } : {}) };
}

/** One counter whose stored value differs from what the rows say it should be. */
export interface CounterChange {
  scope: string;
  /** Stored counter value. */
  counter: number;
  /** Agents in unclaimed partitions of this scope. */
  actual: number;
  /** Agents reserved by holds of creates still in flight (they stay in the counter). */
  in_flight: number;
  /** Agents reserved by abandoned holds (older than UNCLAIMED_HOLD_TTL_MS), released. */
  abandoned: number;
  /** Value after reconciling: actual + in_flight. */
  after: number;
}
export interface ReconcileReport {
  command: 'reconcile';
  applied: boolean;
  checked_at: string;
  partitions: { counter: number; actual: number; after: number };
  /** Only counters whose value changes. */
  agents: CounterChange[];
  abandoned_holds: Array<{ hold: string; agents: number; age_ms: number }>;
  /** Partitions without scope keys (created before migration 8, unused since): global only. */
  untracked: { partitions: number; agents: number };
  /** Tracked partitions without a region key (created before migration 9, unused since). */
  without_region: { partitions: number; agents: number };
  expiry_index: { missing: number; repaired: number; invalid_dates: number; batch_limit: number };
}

/** Serializes reconcile runs (transaction-scoped advisory lock). */
const RECONCILE_LOCK_KEY = 1128485466;

/**
 * Recomputes the unclaimed capacity counters (global agents and partitions, site, network and
 * region agents) from the partition rows and fixes drift. Dry run unless `confirm`.
 *
 * Every committed operation keeps each counter equal to the agents in its partitions plus the
 * agents held by reservation holds (see UNCLAIMED_HOLD_TTL_MS), so drift is that difference. It
 * is measured in one statement (one snapshot) and applied as a relative update, so concurrent
 * creates, claims and purges are neither blocked nor overwritten, and a reservation in flight is
 * never mistaken for drift. Holds older than UNCLAIMED_HOLD_TTL_MS were abandoned by a crashed
 * process: each is deleted and exactly its remaining amount released, so neither a late release
 * nor a late create can use it again.
 */
export async function reconcile(
  db: Database,
  options: { confirm: boolean; now?: number },
): Promise<ReconcileReport> {
  const now = options.now ?? Date.now();
  return db.transaction(async (tx) => {
    await tx.query("SET LOCAL statement_timeout = '60s'");
    if (options.confirm) await tx.query('SELECT pg_advisory_xact_lock($1)', [RECONCILE_LOCK_KEY]);
    // Rolling deploys can leave agents created by old instances without an index row.
    // Lock only available workspaces; never race a claim by inserting after its cleanup.
    const missingExpiry = (
      await tx.query<{ agent_id: string; operator_id: string; created_at: string }>(
        `SELECT a.value->>'id' AS agent_id,w.operator_id,a.value->>'createdAt' AS created_at
       FROM workspaces w JOIN operators o ON o.id=w.operator_id AND o.kind='unclaimed'
       CROSS JOIN LATERAL jsonb_array_elements(${agentsArraySql('w.operator_id', 'w.data')}) a(value)
       WHERE NOT EXISTS (SELECT 1 FROM unclaimed_agent_expiry e WHERE e.agent_id=a.value->>'id')
       ORDER BY w.operator_id,a.value->>'id' LIMIT 100 ${options.confirm ? 'FOR UPDATE OF w SKIP LOCKED' : ''}`,
      )
    ).rows;
    let repairedExpiry = 0;
    let invalidExpiry = 0;
    for (const row of missingExpiry) {
      const parsedExpiry = Date.parse(row.created_at) + UNCLAIMED_AGENT_TTL_MS;
      const validDate = Number.isSafeInteger(parsedExpiry);
      if (!validDate) invalidExpiry++;
      // Give invalid records a deferred index entry instead of letting the same
      // first 100 missing rows starve all later repairs. The sweep rechecks age;
      // invalid dates cannot authorize deletion and are deferred again on failure.
      const expires = validDate ? parsedExpiry : now + 3_600_000;
      if (options.confirm) {
        const inserted = await tx.query(
          'INSERT INTO unclaimed_agent_expiry(agent_id,operator_id,expires_at) VALUES($1,$2,$3) ON CONFLICT (agent_id) DO NOTHING RETURNING agent_id',
          [row.agent_id, row.operator_id, expires],
        );
        repairedExpiry += inserted.rows.length;
      }
    }
    const rows = (
      await tx.query<{ source: string; scope_key: string; agents: string; buckets: string }>(
        `WITH parts AS (
           SELECT COALESCE(${agentCountSql('w.operator_id', 'w.data')},0) AS n,
             b.operator_id IS NOT NULL AS tracked, b.site_key, b.network_key, b.region_key
           FROM operators o JOIN workspaces w ON w.operator_id=o.id
           LEFT JOIN unclaimed_buckets b ON b.operator_id=o.id
           WHERE o.kind='unclaimed')
         SELECT 'actual' AS source, 'global' AS scope_key, COALESCE(sum(n),0)::text AS agents,
           count(*)::text AS buckets FROM parts
         UNION ALL SELECT 'actual', 'site:'||site_key, sum(n)::text, '0'
           FROM parts WHERE site_key IS NOT NULL GROUP BY site_key
         UNION ALL SELECT 'actual', 'network:'||network_key, sum(n)::text, '0'
           FROM parts WHERE network_key IS NOT NULL GROUP BY network_key
         UNION ALL SELECT 'actual', 'region:'||region_key, sum(n)::text, '0'
           FROM parts WHERE region_key IS NOT NULL GROUP BY region_key
         UNION ALL SELECT 'untracked', '', COALESCE(sum(n),0)::text, count(*)::text
           FROM parts WHERE NOT tracked
         UNION ALL SELECT 'without_region', '', COALESCE(sum(n),0)::text, count(*)::text
           FROM parts WHERE tracked AND region_key IS NULL
         UNION ALL SELECT 'stats', scope_key, agents::text, buckets::text FROM unclaimed_stats`,
      )
    ).rows;
    const counters = new Map<string, number>();
    const actual = new Map<string, number>();
    const holds: Array<UnclaimedHold & { agents: number }> = [];
    let counterPartitions = 0;
    let actualPartitions = 0;
    const untracked = { partitions: 0, agents: 0 };
    const withoutRegion = { partitions: 0, agents: 0 };
    for (const row of rows) {
      const agents = Number(row.agents);
      const buckets = Number(row.buckets);
      if (row.source === 'actual') {
        actual.set(row.scope_key, agents);
        if (row.scope_key === 'global') actualPartitions = buckets;
      } else if (row.source === 'untracked')
        Object.assign(untracked, { partitions: buckets, agents });
      else if (row.source === 'without_region')
        Object.assign(withoutRegion, { partitions: buckets, agents });
      else {
        const hold = parseUnclaimedHold(row.scope_key);
        if (hold) holds.push({ ...hold, agents });
        else if (/^(global|(site|network|region):[0-9a-f]{32})$/.test(row.scope_key)) {
          counters.set(row.scope_key, agents);
          if (row.scope_key === 'global') counterPartitions = buckets;
        }
      }
    }
    const abandoned = holds.filter((hold) => now - hold.createdAt > UNCLAIMED_HOLD_TTL_MS);
    const held = new Map<string, number>();
    const released = new Map<string, number>();
    for (const hold of holds)
      for (const scope of hold.scopes) {
        held.set(scope, (held.get(scope) ?? 0) + hold.agents);
        if (abandoned.includes(hold)) released.set(scope, (released.get(scope) ?? 0) + hold.agents);
      }
    const rank = (key: string) =>
      key === 'global' ? 0 : key.startsWith('site:') ? 1 : key.startsWith('network:') ? 2 : 3;
    const order = (a: string, b: string) => rank(a) - rank(b) || a.localeCompare(b);
    const changes: Array<CounterChange & { drift: number }> = [];
    for (const scope of [...new Set([...counters.keys(), ...actual.keys(), ...held.keys()])].sort(
      order,
    )) {
      const counter = counters.get(scope) ?? 0;
      const inRows = actual.get(scope) ?? 0;
      const inFlight = (held.get(scope) ?? 0) - (released.get(scope) ?? 0);
      if (inRows + inFlight !== counter)
        changes.push({
          scope,
          counter,
          actual: inRows,
          in_flight: inFlight,
          abandoned: released.get(scope) ?? 0,
          after: inRows + inFlight,
          drift: counter - inRows - (held.get(scope) ?? 0),
        });
    }
    if (options.confirm) {
      const adjustments = new Map(
        changes
          .filter((change) => change.drift !== 0)
          .map((change) => [change.scope, change.drift]),
      );
      // A compensating release locks its hold before counters. Match that order, and
      // acquire all abandoned holds before any counter to avoid a hold/global cycle.
      for (const hold of abandoned.sort((a, b) => a.key.localeCompare(b.key))) {
        const remaining = Number(
          (
            await tx.query<{ agents: number | string }>(
              'DELETE FROM unclaimed_stats WHERE scope_key=$1 RETURNING agents',
              [hold.key],
            )
          ).rows[0]?.agents ?? 0,
        );
        if (remaining > 0)
          for (const scope of hold.scopes)
            adjustments.set(scope, (adjustments.get(scope) ?? 0) + remaining);
      }
      // Partition drift also takes the global row; do it before site/network/region.
      if (counterPartitions !== actualPartitions)
        await tx.query(
          `INSERT INTO unclaimed_stats(scope_key,agents,buckets) VALUES('global',0,GREATEST(-$1::integer,0))
            ON CONFLICT (scope_key) DO UPDATE SET buckets=GREATEST(unclaimed_stats.buckets-$1::integer,0)`,
          [counterPartitions - actualPartitions],
        );
      for (const [scope, delta] of [...adjustments].sort(([a], [b]) => order(a, b)))
        if (delta !== 0)
          await tx.query(
            `INSERT INTO unclaimed_stats(scope_key,agents,buckets) VALUES($1,GREATEST(-$2::integer,0),0)
           ON CONFLICT (scope_key) DO UPDATE SET agents=GREATEST(unclaimed_stats.agents-$2::integer,0)`,
            [scope, delta],
          );
    }
    return {
      command: 'reconcile' as const,
      applied: options.confirm,
      checked_at: new Date(now).toISOString(),
      partitions: { counter: counterPartitions, actual: actualPartitions, after: actualPartitions },
      agents: changes.map(({ drift: _drift, ...change }) => change),
      abandoned_holds: abandoned.map((hold) => ({
        hold: hold.key,
        agents: hold.agents,
        age_ms: now - hold.createdAt,
      })),
      untracked,
      without_region: withoutRegion,
      expiry_index: {
        missing: missingExpiry.length,
        repaired: repairedExpiry,
        invalid_dates: invalidExpiry,
        batch_limit: 100,
      },
    };
  });
}
