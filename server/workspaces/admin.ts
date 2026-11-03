import type { Database } from '../database.js';
import { AI_WORKSPACE_IDLE_MS } from './service.js';
import { agentCountSql } from '../agent-rows/sql.js';

/**
 * Operator reconciliation of the live AI workspace counters (docs/AI_WORKSPACES.md), run by
 * `pnpm unclaimed:admin -- reconcile` next to the unclaimed counters. Counters are maintained in
 * the same transaction as the rows they count, so drift only follows manual database edits. The
 * drift is measured in one snapshot and applied as a relative update, so creates and reclaims
 * running concurrently are neither blocked nor overwritten. Writes only with `confirm`.
 */
export interface AiCounterChange {
  scope: string;
  counter: number;
  actual: number;
}
export interface AiReconcileReport {
  applied: boolean;
  workspaces: number;
  changes: AiCounterChange[];
  /** Empty, idle AI workspaces that the next create at a capacity bound may reclaim. */
  reclaimable: number;
}

export async function reconcileAiWorkspaces(
  db: Database,
  options: { confirm: boolean; now?: number },
): Promise<AiReconcileReport | null> {
  const now = options.now ?? Date.now();
  const present = (
    await db.query<{ exists: string | null }>("SELECT to_regclass('ai_workspace_stats') AS exists")
  ).rows[0]?.exists;
  if (!present) return null;
  return db.transaction(async (tx) => {
    const rows = (
      await tx.query<{ source: string; scope_key: string; n: string }>(
        `SELECT 'actual' AS source, 'global' AS scope_key, count(*)::text AS n FROM ai_workspaces
         UNION ALL SELECT 'actual', 'source:'||source_key, count(*)::text FROM ai_workspaces GROUP BY source_key
         UNION ALL SELECT 'actual', 'site:'||site_key, count(*)::text FROM ai_workspaces GROUP BY site_key
         UNION ALL SELECT 'actual', 'network:'||network_key, count(*)::text FROM ai_workspaces GROUP BY network_key
         UNION ALL SELECT 'actual', 'region:'||region_key, count(*)::text FROM ai_workspaces GROUP BY region_key
         UNION ALL SELECT 'stats', scope_key, workspaces::text FROM ai_workspace_stats`,
      )
    ).rows;
    const actual = new Map<string, number>();
    const counters = new Map<string, number>();
    for (const row of rows)
      (row.source === 'actual' ? actual : counters).set(row.scope_key, Number(row.n));
    const changes: AiCounterChange[] = [];
    for (const scope of [...new Set([...actual.keys(), ...counters.keys()])].sort((a, b) =>
      a === 'global' ? -1 : b === 'global' ? 1 : a.localeCompare(b),
    )) {
      const counter = counters.get(scope) ?? 0;
      const real = actual.get(scope) ?? 0;
      if (counter !== real) changes.push({ scope, counter, actual: real });
    }
    if (options.confirm)
      for (const change of changes)
        await tx.query(
          `INSERT INTO ai_workspace_stats(scope_key,workspaces) VALUES($1,GREATEST(-$2::integer,0))
            ON CONFLICT (scope_key) DO UPDATE SET workspaces=GREATEST(ai_workspace_stats.workspaces-$2::integer,0)`,
          [change.scope, change.counter - change.actual],
        );
    const reclaimable = Number(
      (
        await tx.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM ai_workspaces a JOIN workspaces w ON w.operator_id=a.operator_id
            WHERE ${agentCountSql('w.operator_id', 'w.data')}=0 AND a.created_at<=$1
            AND NOT EXISTS (SELECT 1 FROM workspace_keys k WHERE k.operator_id=a.operator_id AND COALESCE(k.last_used_at,k.created_at)>$1)
            AND NOT EXISTS (SELECT 1 FROM operator_links l WHERE l.ai_operator_id=a.operator_id)`,
          [now - AI_WORKSPACE_IDLE_MS],
        )
      ).rows[0]?.n ?? 0,
    );
    return {
      applied: options.confirm,
      workspaces: actual.get('global') ?? 0,
      changes,
      reclaimable,
    };
  });
}
