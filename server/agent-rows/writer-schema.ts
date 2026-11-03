import { registerMigration, type Migration } from '../migrations.js';

/**
 * Migration 360 `agent_rows_writer`: how a workspace that stores its agents as rows (migration 245)
 * is written. `workspace_agents_write(ws, list)` makes the workspace's `agents` rows equal `list`,
 * the agents array the document would have carried: agents no longer in it are deleted, the others
 * inserted or updated with their position as `ordinal`.
 *
 * In rows mode the three triggers on `workspaces` that read the agents array return early (245's
 * guards), so this function does their work for the agents it writes, with their own rules:
 * - counted_agent_ids: the same set `counted_agent_ids_of` would give for the list (stats);
 * - count_log_record_agent for each agent this write added (count log);
 * - room_members of agents added, removed or renamed lose their cached name (rooms).
 * public_cards follows the `agents` rows through its own trigger, which this migration also
 * replaces (document-mode guard, default-collation ids; see the SQL).
 *
 * Only for a workspace in rows mode; a list that is not an array of objects with distinct string
 * ids is refused, as the precopy refuses it. Creating the functions touches no table.
 */
export const AGENT_ROWS_WRITER_SQL = `
-- Every write compares the whole list with the workspace's rows, so hash joins in memory: the
-- planner guesses 100 elements for the list and picks nested loops, and the hashes spilled to disk
-- (45,504 agents: 85 s, then 22 s with hash joins, 2.5 s with both; document mode 2.3 s).
-- Writes to one workspace are serial (its row lock), so the memory is taken once per workspace.
CREATE OR REPLACE FUNCTION workspace_agents_write(ws text, list jsonb) RETURNS void
LANGUAGE plpgsql SET enable_nestloop = off SET work_mem = '128MB' AS $$
DECLARE
  added jsonb;
  changed text[];
  ids jsonb;
  kept jsonb;
  agent jsonb;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM workspace_storage s WHERE s.operator_id = ws AND s.mode = 'rows') THEN
    RAISE EXCEPTION 'This workspace stores its agents in its document.' USING ERRCODE = '55000';
  END IF;
  IF jsonb_typeof(list) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'The agents are not an array.' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(list) e
              WHERE jsonb_typeof(e.value) <> 'object' OR jsonb_typeof(e.value->'id') IS DISTINCT FROM 'string') THEN
    RAISE EXCEPTION 'Every agent is an object with a string id.' USING ERRCODE = '22023';
  END IF;
  IF (SELECT count(*) FROM jsonb_array_elements(list)) <>
     (SELECT count(DISTINCT e.value->>'id') FROM jsonb_array_elements(list) e) THEN
    RAISE EXCEPTION 'Two agents share an id.' USING ERRCODE = '22023';
  END IF;

  -- Before anything is written: the agents this write adds, and those added, removed or renamed.
  SELECT COALESCE(jsonb_agg(e.value ORDER BY e.ordinal), '[]'::jsonb) INTO added
    FROM jsonb_array_elements(list) WITH ORDINALITY AS e(value, ordinal)
   WHERE NOT EXISTS (SELECT 1 FROM agents a WHERE a.operator_id = ws AND a.agent_id = e.value->>'id');
  SELECT array_agg(DISTINCT COALESCE(o.id, n.id)) INTO changed
    FROM (SELECT a.agent_id AS id, a.agent->'name' AS name FROM agents a WHERE a.operator_id = ws) o
    FULL JOIN (SELECT e.value->>'id' AS id, e.value->'name' AS name FROM jsonb_array_elements(list) e) n
      ON n.id = o.id
   WHERE o.id IS NULL OR n.id IS NULL OR o.name IS DISTINCT FROM n.name;

  -- The rows: positions may swap within the write, so the ordinal is checked at its end.
  SET CONSTRAINTS agents_operator_ordinal DEFERRED;
  DELETE FROM agents a WHERE a.operator_id = ws
     AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(list) e WHERE e.value->>'id' = a.agent_id);
  -- Only new and changed agents: ON CONFLICT locks every conflicting row even when its WHERE
  -- skips the update (19,934 agents: 16.8 s with it, 0.44 s like this; rehearsal, 2 Nov 2026).
  INSERT INTO agents (operator_id, agent_id, ordinal, agent)
  SELECT ws, e.value->>'id', e.ordinal, e.value
    FROM jsonb_array_elements(list) WITH ORDINALITY AS e(value, ordinal)
    LEFT JOIN agents a ON a.operator_id = ws AND a.agent_id = e.value->>'id'
   WHERE a.agent_id IS NULL OR a.ordinal <> e.ordinal OR a.agent IS DISTINCT FROM e.value
  ON CONFLICT (operator_id, agent_id) DO UPDATE
     SET ordinal = EXCLUDED.ordinal, agent = EXCLUDED.agent;
  SET CONSTRAINTS agents_operator_ordinal IMMEDIATE;

  -- counted_agent_ids, as counted_agent_ids_sync keeps it for a document.
  SELECT COALESCE(jsonb_object_agg(n.agent_id, true), '{}'::jsonb) INTO ids
    FROM counted_agent_ids_of(jsonb_build_object('agents', list)) n;
  SELECT COALESCE(jsonb_object_agg(c.agent_id, true), '{}'::jsonb) INTO kept
    FROM counted_agent_ids c WHERE c.operator_id = ws;
  DELETE FROM counted_agent_ids c WHERE c.operator_id = ws AND NOT (ids ? c.agent_id);
  INSERT INTO counted_agent_ids(operator_id, agent_id)
    SELECT ws, k.agent_id FROM jsonb_object_keys(ids) AS k(agent_id)
     WHERE NOT (kept ? k.agent_id)
    ON CONFLICT DO NOTHING;

  -- The count log, as count_log_record_pending records an agent a write added.
  FOR agent IN SELECT value FROM jsonb_array_elements(added) LOOP
    PERFORM count_log_record_agent(agent, ws);
  END LOOP;

  -- Room members' cached names, as workspaces_agent_names_reset clears them.
  IF changed IS NOT NULL THEN
    UPDATE room_members SET name_key = NULL, slug_key = NULL, name_rev = name_rev + 1
      WHERE owner_id = ws AND kind = 'agent'
        AND lower(agent_id) = ANY (SELECT lower(x COLLATE "default") FROM unnest(changed) x);
  END IF;
END;
$$;

-- The agents rows' public cards trigger (migration 280), two changes:
-- - document mode returns at once: the workspaces trigger keeps those cards, and the rows are
--   unread (the mover's precopy and switch delta write them; 100 agents took 172 s before);
-- - the id is passed in the default collation: agents.agent_id is COLLATE "C", which the ::text
--   cast keeps, so agent_manifests and agent_public_cards were scanned instead of read by their
--   index (~0.9 s a call on the prod copy instead of ~3 ms).
CREATE OR REPLACE FUNCTION agents_public_cards_sync() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM workspace_storage s
                  WHERE s.operator_id = COALESCE(NEW.operator_id, OLD.operator_id) AND s.mode = 'rows') THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.operator_id = NEW.operator_id AND OLD.agent_id = NEW.agent_id
     AND OLD.ordinal = NEW.ordinal
     AND (OLD.agent->'revision') IS NOT DISTINCT FROM (NEW.agent->'revision')
     AND (OLD.agent->>'revokedAt' IS NULL) = (NEW.agent->>'revokedAt' IS NULL) THEN
    RETURN NULL;
  END IF;
  IF TG_OP <> 'INSERT' THEN
    PERFORM agent_public_cards_refresh(ARRAY[OLD.agent_id::text COLLATE "default"]);
  END IF;
  IF TG_OP <> 'DELETE' THEN
    PERFORM agent_public_cards_refresh(ARRAY[NEW.agent_id::text COLLATE "default"]);
  END IF;
  RETURN NULL;
END $$;
`;

export const agentRowsWriterMigration: Migration = {
  version: 360,
  name: 'agent_rows_writer',
  sql: AGENT_ROWS_WRITER_SQL,
};

/** Idempotent; call before runMigrations (after 245 and the count log, stats and rooms schemas). */
export function registerAgentRowsWriterMigration(): void {
  registerMigration(agentRowsWriterMigration);
}
