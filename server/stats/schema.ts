import { registerMigration, type Migration } from '../migrations.js';

/**
 * Migration 28 `public_stats`: one row per public statistic, shared by every instance, so the homepage count runs about once per refresh interval
 * globally instead of once per instance.
 *
 * - `value`: the last computed number; `refreshed_at`: when it was computed (epoch ms).
 * - `refreshing_until`: the refresh lease. An instance claims it with one conditional UPDATE and
 *   only the winner counts, outside any transaction; a crashed winner's lease simply expires.
 *
 * Derived data: recomputed from workspaces at any time, never exported or restored.
 */
export const publicStatsMigration: Migration = {
  version: 28,
  name: 'public_stats',
  sql: `
CREATE TABLE IF NOT EXISTS public_stats (
  key text PRIMARY KEY CHECK (key ~ '^[a-z_]{1,64}$'),
  value bigint NOT NULL DEFAULT 0 CHECK (value >= 0),
  refreshed_at bigint NOT NULL DEFAULT 0,
  refreshing_until bigint NOT NULL DEFAULT 0
);
`,
};

registerMigration(publicStatsMigration);

/**
 * The ids `ai_agents_total` counts, one row per (workspace, agent id), kept by triggers on
 * `workspaces` in the same transaction as every workspace write. Row rule, exactly the scan's
 * (server/stats/public-stats.ts AI_AGENTS_TOTAL_SCAN_SQL): every element of `data->'agents'` whose
 * `->>'id'` is not null and whose `->>'demoKey'` is null. The count then reads this narrow,
 * indexed table instead of every workspace document. A document whose `agents` is not an array
 * contributes nothing, in the scan as well (a workspace write must never fail here).
 *
 * Derived data: rebuilt from workspaces by the backfill below, never exported or restored.
 */
export const COUNTED_AGENT_IDS_SQL = `
CREATE TABLE IF NOT EXISTS counted_agent_ids (
  operator_id text NOT NULL,
  agent_id text NOT NULL,
  PRIMARY KEY (operator_id, agent_id)
);
-- count(DISTINCT agent_id) as an index-only scan in agent_id order.
CREATE INDEX IF NOT EXISTS counted_agent_ids_agent ON counted_agent_ids(agent_id, operator_id);

CREATE OR REPLACE FUNCTION counted_agent_ids_of(doc jsonb) RETURNS TABLE(agent_id text)
LANGUAGE sql IMMUTABLE AS $$
  SELECT DISTINCT a.value->>'id'
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(doc->'agents') = 'array'
                                   THEN doc->'agents' ELSE '[]'::jsonb END) AS a(value)
   WHERE a.value->>'id' IS NOT NULL AND a.value->>'demoKey' IS NULL
$$;

CREATE OR REPLACE FUNCTION counted_agent_ids_sync() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR (TG_OP = 'UPDATE' AND OLD.operator_id IS DISTINCT FROM NEW.operator_id) THEN
    DELETE FROM counted_agent_ids WHERE operator_id = OLD.operator_id;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  DELETE FROM counted_agent_ids c
   WHERE c.operator_id = NEW.operator_id
     AND NOT EXISTS (SELECT 1 FROM counted_agent_ids_of(NEW.data) n WHERE n.agent_id = c.agent_id);
  INSERT INTO counted_agent_ids(operator_id, agent_id)
    SELECT NEW.operator_id, n.agent_id FROM counted_agent_ids_of(NEW.data) n
    ON CONFLICT DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS counted_agent_ids_on_insert ON workspaces;
CREATE TRIGGER counted_agent_ids_on_insert AFTER INSERT ON workspaces
  FOR EACH ROW EXECUTE FUNCTION counted_agent_ids_sync();
DROP TRIGGER IF EXISTS counted_agent_ids_on_update ON workspaces;
CREATE TRIGGER counted_agent_ids_on_update AFTER UPDATE ON workspaces
  FOR EACH ROW WHEN (OLD.data->'agents' IS DISTINCT FROM NEW.data->'agents'
                     OR OLD.operator_id IS DISTINCT FROM NEW.operator_id)
  EXECUTE FUNCTION counted_agent_ids_sync();
DROP TRIGGER IF EXISTS counted_agent_ids_on_delete ON workspaces;
CREATE TRIGGER counted_agent_ids_on_delete AFTER DELETE ON workspaces
  FOR EACH ROW EXECUTE FUNCTION counted_agent_ids_sync();

-- Backfill (idempotent): every workspace that exists now.
INSERT INTO counted_agent_ids(operator_id, agent_id)
  SELECT w.operator_id, n.agent_id FROM workspaces w CROSS JOIN LATERAL counted_agent_ids_of(w.data) n
  ON CONFLICT DO NOTHING;
`;

/**
 * Migration 59 `fast_counts`: the public agent count from `counted_agent_ids` (above), and a
 * partial index so "does any owner account exist" (GET /api/session's setupRequired) is one index
 * probe instead of a scan over every operator, unclaimed partitions included.
 */
export const fastCountsMigration: Migration = {
  version: 59,
  name: 'fast_counts',
  sql: `${COUNTED_AGENT_IDS_SQL}
CREATE INDEX IF NOT EXISTS operators_owner ON operators(id) WHERE kind = 'owner';
`,
};

registerMigration(fastCountsMigration);

/**
 * The trigger function of `counted_agent_ids` without a plan-dependent join. Migration 59's
 * version deleted the rows missing from `counted_agent_ids_of(NEW.data)` with a NOT EXISTS over
 * that function; once PostgreSQL caches a generic plan for it (after a few executions on one
 * connection) that can become a nested loop that re-reads the whole document for every row:
 * quadratic, seconds per create in a workspace of thousands of agents, all under the workspace
 * row lock. Same rows as before: the new document's ids (by the same `counted_agent_ids_of`) and
 * the owner's current rows are each collected once into a jsonb object; rows whose id is not in
 * the document are deleted and ids without a row inserted (one key lookup each), so each write
 * still leaves exactly the document's ids for its owner, repairing any drift as before.
 */
export const COUNTED_AGENT_IDS_SYNC_SQL = `
CREATE OR REPLACE FUNCTION counted_agent_ids_sync() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  ids jsonb;
  kept jsonb;
BEGIN
  IF TG_OP = 'DELETE' OR (TG_OP = 'UPDATE' AND OLD.operator_id IS DISTINCT FROM NEW.operator_id) THEN
    DELETE FROM counted_agent_ids WHERE operator_id = OLD.operator_id;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  SELECT COALESCE(jsonb_object_agg(n.agent_id, true), '{}'::jsonb) INTO ids
    FROM counted_agent_ids_of(NEW.data) n;
  SELECT COALESCE(jsonb_object_agg(c.agent_id, true), '{}'::jsonb) INTO kept
    FROM counted_agent_ids c WHERE c.operator_id = NEW.operator_id;
  DELETE FROM counted_agent_ids c WHERE c.operator_id = NEW.operator_id AND NOT (ids ? c.agent_id);
  INSERT INTO counted_agent_ids(operator_id, agent_id)
    SELECT NEW.operator_id, k.agent_id FROM jsonb_object_keys(ids) AS k(agent_id)
     WHERE NOT (kept ? k.agent_id)
    ON CONFLICT DO NOTHING;
  RETURN NEW;
END;
$$;
`;

/** Migration 111 `counted_agent_ids_sync_linear`: the function above. */
export const countedAgentIdsSyncLinearMigration: Migration = {
  version: 111,
  name: 'counted_agent_ids_sync_linear',
  sql: COUNTED_AGENT_IDS_SYNC_SQL,
};

registerMigration(countedAgentIdsSyncLinearMigration);
