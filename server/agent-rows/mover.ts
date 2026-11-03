/*
 * The mover (agents as rows, phase 2c): moves one workspace's agents from its document into the
 * agents table and back. Operator SQL, not a migration: nothing in the application calls these
 * functions, and an operator installs and runs them by hand (rehearsal first, on a Neon branch).
 * agent_rows_control keeps the precopy and the switch off until an operator turns them on; the
 * rollback is always allowed.
 *
 *   SELECT agent_rows_precopy_run(ws);  -- outside the lock: copy, count, digest
 *   SELECT agent_rows_switch(ws);       -- under the row lock (2 s wait at most): delta, verify, flip
 *   SELECT agent_rows_rollback(ws);     -- under the row lock: document from the rows, flip back
 *
 * One call per transaction: the switch and rollback set lock_timeout and city.agent_rows_writer
 * for their transaction, so in a wrapping transaction those would stay for the rest of it. No
 * workspace switches on production until every reader is on the dual-mode reads (2a, both parts):
 * an instance that reads the agents from the document would see a switched workspace as empty.
 *
 * Each returns its timings (copy_ms; lock_wait_ms, delta_ms, verify_ms, held_ms) for the
 * rehearsal numbers. Rehearsed on a prod copy (2 Nov 2026): the switch held the lock 6 ms to 0.9 s
 * (100 to 45,504 agents). The rollback rewrites the whole document under the lock, 1.5 s at 45,504
 * agents: no longer than one ordinary document-mode write of that workspace (2.3 s). The switch and the rollback leave the counted ids, count log, cards and room
 * names as they were: the agents themselves do not change.
 */
export const AGENT_ROWS_MOVER_SQL = `
-- The mover: one workspace at a time, document -> rows and back. Nothing calls these from the
-- application; an operator runs them, and each refuses while agent_rows_control says so.

-- Why a document's agents cannot be stored as rows (agent_rows_precopy.refused), or NULL.
CREATE OR REPLACE FUNCTION agent_rows_refusal(list jsonb) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN jsonb_typeof(list) IS DISTINCT FROM 'array' THEN 'not_array'
    WHEN EXISTS (SELECT 1 FROM jsonb_array_elements(list) e WHERE jsonb_typeof(e.value) <> 'object')
      THEN 'not_object'
    WHEN EXISTS (SELECT 1 FROM jsonb_array_elements(list) e
                  WHERE jsonb_typeof(e.value->'id') IS DISTINCT FROM 'string') THEN 'id_not_string'
    WHEN (SELECT count(*) <> count(DISTINCT e.value->>'id') FROM jsonb_array_elements(list) e)
      THEN 'duplicate_id'
  END
$$;

CREATE OR REPLACE FUNCTION agent_rows_ms(at timestamptz) RETURNS bigint LANGUAGE sql IMMUTABLE AS $$
  SELECT (extract(epoch FROM at) * 1000)::bigint
$$;

-- Step 1, outside the workspace's lock: copies its agents into rows, which nothing reads while it
-- stays in document mode, and records how many and their digest. Run it again to start over.
CREATE OR REPLACE FUNCTION agent_rows_precopy_run(ws text) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  list jsonb;
  bad text;
  n bigint;
  started timestamptz := clock_timestamp();
BEGIN
  IF NOT (SELECT c.precopy_enabled FROM agent_rows_control c) THEN
    RAISE EXCEPTION 'The precopy is off (agent_rows_control).' USING ERRCODE = '55000';
  END IF;
  IF workspace_storage_mode(ws) = 'rows' THEN
    RAISE EXCEPTION 'This workspace already stores its agents as rows.' USING ERRCODE = '55000';
  END IF;
  SELECT COALESCE(w.data->'agents', '[]'::jsonb) INTO list FROM workspaces w WHERE w.operator_id = ws;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'No such workspace.' USING ERRCODE = '22023';
  END IF;
  bad := agent_rows_refusal(list);
  INSERT INTO agent_rows_precopy (operator_id, state, copied, total, refused, started_at, updated_at)
  VALUES (ws, CASE WHEN bad IS NULL THEN 'copying' ELSE 'refused' END, 0,
          CASE WHEN jsonb_typeof(list) = 'array' THEN jsonb_array_length(list) ELSE 0 END, bad,
          agent_rows_ms(started), agent_rows_ms(started))
  ON CONFLICT (operator_id) DO UPDATE
     SET state = EXCLUDED.state, copied = 0, total = EXCLUDED.total, refused = EXCLUDED.refused,
         digest = NULL, checked_at = NULL, mismatches = NULL,
         started_at = EXCLUDED.started_at, updated_at = EXCLUDED.updated_at;
  IF bad IS NOT NULL THEN
    RETURN jsonb_build_object('refused', bad);
  END IF;
  DELETE FROM agents WHERE operator_id = ws;
  INSERT INTO agents (operator_id, agent_id, ordinal, agent)
  SELECT ws, e.value->>'id', e.ordinal, e.value
    FROM jsonb_array_elements(list) WITH ORDINALITY AS e(value, ordinal);
  GET DIAGNOSTICS n = ROW_COUNT;
  UPDATE agent_rows_precopy
     SET state = 'copied', copied = n, digest = encode(sha256(convert_to(list::text, 'UTF8')), 'hex'),
         updated_at = agent_rows_ms(clock_timestamp())
   WHERE operator_id = ws;
  RETURN jsonb_build_object('copied', n,
    'copy_ms', agent_rows_ms(clock_timestamp()) - agent_rows_ms(started));
END $$;

-- Step 2, under the workspace's row lock (waits at most 2 s): brings the rows level with the
-- document (the delta since the precopy), checks every position against it, then switches the
-- workspace to rows mode and stores its document without agents. Any difference: nothing switches.
-- Hash joins in memory and only new or changed rows upserted, as workspace_agents_write (360).
CREATE OR REPLACE FUNCTION agent_rows_switch(ws text) RETURNS jsonb LANGUAGE plpgsql
SET enable_nestloop = off SET work_mem = '128MB' AS $$
DECLARE
  list jsonb;
  bad text;
  removed bigint;
  written bigint;
  mismatches bigint;
  asked timestamptz := clock_timestamp();
  locked timestamptz;
  copied timestamptz;
  verified timestamptz;
BEGIN
  IF NOT (SELECT c.switch_enabled FROM agent_rows_control c) THEN
    RAISE EXCEPTION 'The switch is off (agent_rows_control).' USING ERRCODE = '55000';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM agent_rows_precopy p WHERE p.operator_id = ws AND p.state = 'copied') THEN
    RAISE EXCEPTION 'Precopy this workspace first.' USING ERRCODE = '55000';
  END IF;
  PERFORM set_config('lock_timeout', '2s', true);
  SELECT COALESCE(w.data->'agents', '[]'::jsonb) INTO list
    FROM workspaces w WHERE w.operator_id = ws FOR UPDATE;
  locked := clock_timestamp();
  IF workspace_storage_mode(ws) = 'rows' THEN
    RAISE EXCEPTION 'This workspace already stores its agents as rows.' USING ERRCODE = '55000';
  END IF;
  bad := agent_rows_refusal(list);
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'Its agents cannot be stored as rows (%).', bad USING ERRCODE = '22023';
  END IF;
  SET CONSTRAINTS agents_operator_ordinal DEFERRED;
  DELETE FROM agents a WHERE a.operator_id = ws
     AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(list) e WHERE e.value->>'id' = a.agent_id);
  GET DIAGNOSTICS removed = ROW_COUNT;
  INSERT INTO agents (operator_id, agent_id, ordinal, agent)
  SELECT ws, e.value->>'id', e.ordinal, e.value
    FROM jsonb_array_elements(list) WITH ORDINALITY AS e(value, ordinal)
    LEFT JOIN agents a ON a.operator_id = ws AND a.agent_id = e.value->>'id'
   WHERE a.agent_id IS NULL OR a.ordinal <> e.ordinal OR a.agent IS DISTINCT FROM e.value
  ON CONFLICT (operator_id, agent_id) DO UPDATE
     SET ordinal = EXCLUDED.ordinal, agent = EXCLUDED.agent;
  GET DIAGNOSTICS written = ROW_COUNT;
  SET CONSTRAINTS agents_operator_ordinal IMMEDIATE;
  copied := clock_timestamp();
  SELECT count(*) INTO mismatches
    FROM (SELECT a.ordinal, a.agent FROM agents a WHERE a.operator_id = ws) r
    FULL JOIN (SELECT e.ordinal, e.value FROM jsonb_array_elements(list) WITH ORDINALITY AS e(value, ordinal)) d
      ON d.ordinal = r.ordinal
   WHERE r.agent IS DISTINCT FROM d.value;
  verified := clock_timestamp();
  IF mismatches > 0 THEN
    RAISE EXCEPTION 'The rows differ from the document at % positions; nothing switched.', mismatches
      USING ERRCODE = '55000';
  END IF;
  UPDATE agent_rows_precopy SET checked_at = agent_rows_ms(verified), mismatches = 0,
         updated_at = agent_rows_ms(verified) WHERE operator_id = ws;
  INSERT INTO workspace_storage (operator_id, mode, changed_at)
  VALUES (ws, 'rows', agent_rows_ms(verified))
  ON CONFLICT (operator_id) DO UPDATE SET mode = 'rows', changed_at = EXCLUDED.changed_at;
  UPDATE workspaces SET data = data - 'agents' WHERE operator_id = ws;
  RETURN jsonb_build_object('agents', jsonb_array_length(list), 'removed', removed, 'written', written,
    'lock_wait_ms', agent_rows_ms(locked) - agent_rows_ms(asked),
    'delta_ms', agent_rows_ms(copied) - agent_rows_ms(locked),
    'verify_ms', agent_rows_ms(verified) - agent_rows_ms(copied),
    'held_ms', agent_rows_ms(clock_timestamp()) - agent_rows_ms(locked));
END $$;

-- Back: under the workspace's row lock, writes its agents from the rows into its document and
-- switches it to document mode. The rows stay (unread in document mode); a new precopy replaces
-- them. Always allowed, whatever agent_rows_control says.
CREATE OR REPLACE FUNCTION agent_rows_rollback(ws text) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  doc jsonb;
  asked timestamptz := clock_timestamp();
  locked timestamptz;
BEGIN
  PERFORM set_config('lock_timeout', '2s', true);
  SELECT workspace_document(w.operator_id, w.data) INTO doc
    FROM workspaces w WHERE w.operator_id = ws FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'No such workspace.' USING ERRCODE = '22023';
  END IF;
  locked := clock_timestamp();
  IF workspace_storage_mode(ws) <> 'rows' THEN
    RAISE EXCEPTION 'This workspace stores its agents in its document already.' USING ERRCODE = '55000';
  END IF;
  -- Written while still in rows mode, so the triggers that read the agents array do nothing; the
  -- counted ids, count log and cards already match these agents.
  PERFORM set_config('city.agent_rows_writer', 'on', true);
  UPDATE workspaces SET data = doc WHERE operator_id = ws;
  PERFORM set_config('city.agent_rows_writer', '', true);
  UPDATE workspace_storage SET mode = 'document', changed_at = agent_rows_ms(clock_timestamp())
   WHERE operator_id = ws;
  DELETE FROM agent_rows_precopy WHERE operator_id = ws;
  RETURN jsonb_build_object('agents', jsonb_array_length(COALESCE(doc->'agents', '[]'::jsonb)),
    'lock_wait_ms', agent_rows_ms(locked) - agent_rows_ms(asked),
    'held_ms', agent_rows_ms(clock_timestamp()) - agent_rows_ms(locked));
END $$;
`;
