import { registerMigration, type Migration } from '../migrations.js';

/**
 * Migration 245 `agent_rows`: the schema for storing a workspace's agents as one row each instead
 * of one array inside the workspace document. Schema only: nothing switches a workspace yet, and
 * every workspace stays in document mode (no `workspace_storage` row means 'document').
 *
 * - `agents`: one row per agent of a rows-mode workspace, the agent object unchanged in `agent`,
 *   its position in the old array in `ordinal`, and a few generated columns for indexes.
 * - `workspace_storage`: a workspace's storage mode; 'rows' only once its agents were moved.
 * - `agent_rows_precopy`: the progress of copying one workspace's agents ahead of its switch.
 * - `agent_rows_control`: one row of switches, all off.
 *
 * The read functions answer the same in both modes, so readers move to them before any workspace
 * switches: `workspace_agents` (every agent with its position), `workspace_agent` (one by id),
 * `workspace_document` (the document with its agents array, as stored before), plus the agent
 * count and the counted agent ids. In document mode each is computed from the document alone.
 *
 * The three trigger functions on `workspaces` that read the agents array get a guard each, in
 * blocks marked `-- 245 {` and `-- 245 }`; outside those blocks each function is its previous
 * text, line for line (tests/agent-rows-migration.test.ts). In document mode the guards change
 * nothing. Applying this migration creates only new, empty tables and replaces functions: its
 * cost does not depend on the data, and it locks no existing table.
 */
export const AGENT_ROWS_TABLES = [
  'agent_rows_control',
  'agent_rows_precopy',
  'agents',
  'workspace_storage',
] as const;

export const AGENT_ROWS_SQL = `
CREATE TABLE IF NOT EXISTS agents (
  operator_id text NOT NULL,
  agent_id text COLLATE "C" NOT NULL,
  ordinal bigint NOT NULL CHECK (ordinal >= 1),
  agent jsonb NOT NULL CHECK (jsonb_typeof(agent) = 'object' AND agent->'id' = to_jsonb(agent_id)),
  name text GENERATED ALWAYS AS (agent->>'name') STORED,
  created_at text COLLATE "C" GENERATED ALWAYS AS (agent->>'createdAt') STORED,
  revoked_at text GENERATED ALWAYS AS (agent->>'revokedAt') STORED,
  paused_at text GENERATED ALWAYS AS (agent->>'pausedAt') STORED,
  demo boolean GENERATED ALWAYS AS ((agent->>'demoKey') IS NOT NULL) STORED,
  revision integer GENERATED ALWAYS AS (
    CASE WHEN jsonb_typeof(agent->'revision') = 'number' AND (agent->>'revision') ~ '^[0-9]{1,9}$'
         THEN (agent->>'revision')::integer END) STORED,
  parent_agent_id text COLLATE "C" GENERATED ALWAYS AS (agent->>'parentAgentId') STORED,
  PRIMARY KEY (operator_id, agent_id),
  CONSTRAINT agents_operator_ordinal UNIQUE (operator_id, ordinal) DEFERRABLE INITIALLY IMMEDIATE
) WITH (fillfactor = 90);
CREATE INDEX IF NOT EXISTS agents_agent ON agents(agent_id);
CREATE INDEX IF NOT EXISTS agents_newest ON agents(operator_id, created_at DESC, agent_id DESC);
CREATE INDEX IF NOT EXISTS agents_children ON agents(operator_id, parent_agent_id)
  WHERE parent_agent_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS workspace_storage (
  operator_id text PRIMARY KEY,
  mode text NOT NULL CHECK (mode IN ('document', 'rows')),
  changed_at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS workspace_storage_rows ON workspace_storage(operator_id) WHERE mode = 'rows';

CREATE TABLE IF NOT EXISTS agent_rows_precopy (
  operator_id text PRIMARY KEY,
  state text NOT NULL CHECK (state IN ('copying', 'copied', 'refused')),
  copied bigint NOT NULL DEFAULT 0 CHECK (copied >= 0),
  total bigint NOT NULL DEFAULT 0 CHECK (total >= 0),
  digest text CHECK (digest IS NULL OR digest ~ '^[0-9a-f]{64}$'),
  refused text CHECK (refused IS NULL OR refused IN
    ('not_array', 'not_object', 'id_not_string', 'duplicate_id', 'bad_revision')),
  started_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  checked_at bigint,
  mismatches integer CHECK (mismatches IS NULL OR mismatches >= 0)
);
CREATE INDEX IF NOT EXISTS agent_rows_precopy_state ON agent_rows_precopy(state, updated_at);

CREATE TABLE IF NOT EXISTS agent_rows_control (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  precopy_enabled boolean NOT NULL DEFAULT false,
  switch_enabled boolean NOT NULL DEFAULT false,
  new_workspace_mode text NOT NULL DEFAULT 'document' CHECK (new_workspace_mode IN ('document', 'rows')),
  lease_until bigint NOT NULL DEFAULT 0,
  updated_at bigint NOT NULL
);
INSERT INTO agent_rows_control(id, updated_at) VALUES (true, 0) ON CONFLICT (id) DO NOTHING;

CREATE OR REPLACE FUNCTION workspace_storage_mode(ws text) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT COALESCE((SELECT s.mode FROM workspace_storage s WHERE s.operator_id = ws), 'document')
$$;

CREATE OR REPLACE FUNCTION workspace_agents(ws text, doc jsonb)
RETURNS TABLE(ordinal bigint, agent jsonb) LANGUAGE sql STABLE AS $$
  SELECT e.ordinal, e.agent
    FROM (SELECT doc->'agents' AS list OFFSET 0) d
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(d.list) = 'array' THEN d.list ELSE '[]'::jsonb END)
      WITH ORDINALITY AS e(agent, ordinal)
   WHERE NOT EXISTS (SELECT 1 FROM workspace_storage s WHERE s.operator_id = ws AND s.mode = 'rows')
  UNION ALL
  SELECT a.ordinal, a.agent FROM agents a
   WHERE a.operator_id = ws
     AND EXISTS (SELECT 1 FROM workspace_storage s WHERE s.operator_id = ws AND s.mode = 'rows')
$$;

CREATE OR REPLACE FUNCTION workspace_agent(ws text, doc jsonb, aid text) RETURNS jsonb
LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM workspace_storage s WHERE s.operator_id = ws AND s.mode = 'rows')
      THEN (SELECT a.agent FROM agents a WHERE a.operator_id = ws AND a.agent_id = aid)
    ELSE (SELECT e.agent
            FROM (SELECT doc->'agents' AS list OFFSET 0) d
            CROSS JOIN LATERAL jsonb_array_elements(
              CASE WHEN jsonb_typeof(d.list) = 'array' THEN d.list ELSE '[]'::jsonb END)
              WITH ORDINALITY AS e(agent, ordinal)
           WHERE e.agent->>'id' = aid
           ORDER BY e.ordinal
           LIMIT 1)
  END
$$;

CREATE OR REPLACE FUNCTION workspace_document(ws text, doc jsonb) RETURNS jsonb
LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM workspace_storage s WHERE s.operator_id = ws AND s.mode = 'rows')
      THEN jsonb_set(doc, '{agents}', COALESCE(
        (SELECT jsonb_agg(a.agent ORDER BY a.ordinal) FROM agents a WHERE a.operator_id = ws),
        '[]'::jsonb))
    ELSE doc
  END
$$;

CREATE OR REPLACE FUNCTION workspace_agent_count(ws text, doc jsonb) RETURNS integer
LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM workspace_storage s WHERE s.operator_id = ws AND s.mode = 'rows')
      THEN (SELECT count(*)::integer FROM agents a WHERE a.operator_id = ws)
    WHEN jsonb_typeof(doc->'agents') = 'array' THEN jsonb_array_length(doc->'agents')
  END
$$;

CREATE OR REPLACE FUNCTION workspace_counted_agent_ids(ws text, doc jsonb)
RETURNS TABLE(agent_id text) LANGUAGE sql STABLE AS $$
  SELECT DISTINCT w.agent->>'id'
    FROM workspace_agents(ws, doc) w
   WHERE w.agent->>'id' IS NOT NULL AND w.agent->>'demoKey' IS NULL
$$;

CREATE OR REPLACE FUNCTION count_log_record_pending() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  agent jsonb;
  old_ids jsonb := '{}'::jsonb;
BEGIN
  -- 245 {
  IF EXISTS (SELECT 1 FROM workspace_storage s WHERE s.operator_id = NEW.operator_id AND s.mode = 'rows') THEN
    RETURN NEW;
  END IF;
  -- 245 }
  IF TG_OP = 'UPDATE' AND jsonb_typeof(OLD.data->'agents') = 'array' THEN
    SELECT COALESCE(jsonb_object_agg(o.value->>'id', true), '{}'::jsonb) INTO old_ids
      FROM jsonb_array_elements(OLD.data->'agents') AS o(value)
     WHERE jsonb_typeof(o.value->'id') = 'string';
  END IF;
  FOR agent IN SELECT value FROM jsonb_array_elements(COALESCE(NEW.data->'agents', '[]'::jsonb)) LOOP
    -- Only agents this write added.
    CONTINUE WHEN agent->>'id' IS NOT NULL AND old_ids ? (agent->>'id');
    PERFORM count_log_record_agent(agent, NEW.operator_id);
  END LOOP;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION counted_agent_ids_sync() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  ids jsonb;
  kept jsonb;
BEGIN
  -- 245 {
  IF TG_OP = 'UPDATE' AND OLD.operator_id IS DISTINCT FROM NEW.operator_id
      AND EXISTS (SELECT 1 FROM workspace_storage s
                   WHERE s.operator_id IN (OLD.operator_id, NEW.operator_id) AND s.mode = 'rows') THEN
    RAISE EXCEPTION 'A workspace that stores its agents as rows keeps its id.' USING ERRCODE = '55000';
  END IF;
  -- 245 }
  IF TG_OP = 'DELETE' OR (TG_OP = 'UPDATE' AND OLD.operator_id IS DISTINCT FROM NEW.operator_id) THEN
    DELETE FROM counted_agent_ids WHERE operator_id = OLD.operator_id;
  END IF;
  IF TG_OP = 'DELETE' THEN
    -- 245 {
    DELETE FROM workspace_storage WHERE operator_id = OLD.operator_id;
    DELETE FROM agents WHERE operator_id = OLD.operator_id;
    DELETE FROM agent_rows_precopy WHERE operator_id = OLD.operator_id;
    -- 245 }
    RETURN OLD;
  END IF;
  -- 245 {
  IF EXISTS (SELECT 1 FROM workspace_storage s WHERE s.operator_id = NEW.operator_id AND s.mode = 'rows') THEN
    IF jsonb_typeof(NEW.data->'agents') = 'array' AND jsonb_array_length(NEW.data->'agents') > 0
        AND current_setting('city.agent_rows_writer', true) IS DISTINCT FROM 'on' THEN
      RAISE EXCEPTION 'This workspace stores its agents as rows; its document carries none.'
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;
  -- 245 }
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

CREATE OR REPLACE FUNCTION workspaces_agent_names_reset() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  before jsonb := CASE WHEN jsonb_typeof(OLD.data->'agents') = 'array' THEN OLD.data->'agents' ELSE '[]'::jsonb END;
  after jsonb := CASE WHEN jsonb_typeof(NEW.data->'agents') = 'array' THEN NEW.data->'agents' ELSE '[]'::jsonb END;
  changed text[];
BEGIN
  -- 245 {
  IF EXISTS (SELECT 1 FROM workspace_storage s WHERE s.operator_id = NEW.operator_id AND s.mode = 'rows') THEN
    RETURN NULL;
  END IF;
  -- 245 }
  SELECT array_agg(DISTINCT COALESCE(o.id, n.id)) INTO changed
    FROM (SELECT a->>'id' AS id, a->'name' AS name FROM jsonb_array_elements(before) a) o
    FULL JOIN (SELECT a->>'id' AS id, a->'name' AS name FROM jsonb_array_elements(after) a) n
      ON n.id = o.id
   WHERE COALESCE(o.id, n.id) IS NOT NULL
     AND (o.id IS NULL OR n.id IS NULL OR o.name IS DISTINCT FROM n.name);
  IF changed IS NOT NULL THEN
    UPDATE room_members SET name_key = NULL, slug_key = NULL, name_rev = name_rev + 1
      WHERE owner_id = NEW.operator_id AND kind = 'agent'
        AND lower(agent_id) = ANY (SELECT lower(x) FROM unnest(changed) x);
  END IF;
  RETURN NULL;
END $$;
`;

export const agentRowsMigration: Migration = {
  version: 245,
  name: 'agent_rows',
  sql: AGENT_ROWS_SQL,
};

/** Idempotent; call before runMigrations (after 110, 111 and 244, whose functions it replaces). */
export function registerAgentRowsMigration(): void {
  registerMigration(agentRowsMigration);
}
