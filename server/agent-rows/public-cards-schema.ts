import { registerMigration, type Migration } from '../migrations.js';

/**
 * Migration 280 `agent_public_cards`: every agent's current public card as one narrow row, kept
 * by the database on every write that can change it, so public reads (the Agent Explorer's list,
 * search and passport, the directory, ratings, payments, the domain file) find an agent's public
 * name with one index probe instead of reading its owner's whole workspace document.
 *
 * - `agent_public_cards`: one row per agent whose card is public now, by the card route's rule
 *   (server/autonomy/index.ts): the agent in the workspace of its manifests, the first with its id
 *   in array order, not revoked, its current manifest revision with visibility 'public'. `name` is
 *   that revision's displayName, trimmed, NULL when blank. Any other agent has no row.
 * - `agent_public_cards_name`: a trigram index on `name` (pg_trgm), which the name searches read.
 *   Where the extension cannot be created the table is read without it (still one narrow row per
 *   agent, never a workspace document).
 * - `agent_public_cards_refresh(ids)`: recomputes those agents' rows from the workspaces and the
 *   manifests; the one place the rule is written down. Up to 8 ids read their agent with
 *   workspace_agent(); more read each workspace's agents once (workspace_agents).
 * - Kept on every write: the workspaces trigger refreshes the agents added, removed, or whose
 *   revision or revocation changed, or whose records (an id written more than once) changed order
 *   among themselves (a rename or visibility change is a new manifest revision,
 *   written before the workspace that points at it; a create, revoke, claim or delete changes the
 *   array), the agents trigger does the same in rows mode, a manifest inserted after the
 *   workspace that already points at it is caught at commit (a deferred trigger, one index probe
 *   otherwise), and a manifest updated or deleted in place refreshes its agents.
 * - `agent_public_cards_backfill`: the agents that existed before this migration are filled in by
 *   a cron (server/agent-rows/public-cards.ts), a few workspaces per run in operator id order,
 *   never in this migration (one statement over every workspace would pass the statement
 *   timeout). Until it has walked every workspace `ready` is false and the readers keep their
 *   previous rule (PUBLIC_CARDS_READY); a database without any manifest is ready at once.
 *
 * Derived data: rebuilt from workspaces and manifests, never exported or restored.
 */
export const PUBLIC_CARDS_TABLES = ['agent_public_cards', 'agent_public_cards_backfill'] as const;

export const AGENT_PUBLIC_CARDS_SQL = `
DO $trgm$
BEGIN
  BEGIN
    CREATE EXTENSION IF NOT EXISTS pg_trgm;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'pg_trgm unavailable; public names are searched without a trigram index';
  END;
END
$trgm$;

CREATE TABLE IF NOT EXISTS agent_public_cards (
  agent_id text PRIMARY KEY,
  operator_id text NOT NULL,
  revision integer NOT NULL,
  name text
);
CREATE INDEX IF NOT EXISTS agent_public_cards_operator ON agent_public_cards(operator_id);
DO $index$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') THEN
    CREATE INDEX IF NOT EXISTS agent_public_cards_name ON agent_public_cards
      USING gin (name gin_trgm_ops);
  END IF;
END
$index$;

CREATE TABLE IF NOT EXISTS agent_public_cards_backfill (
  id integer PRIMARY KEY CHECK (id = 1),
  after_operator text,
  ready boolean NOT NULL,
  updated_at bigint
);
INSERT INTO agent_public_cards_backfill (id, after_operator, ready)
  SELECT 1, NULL, NOT EXISTS (SELECT 1 FROM agent_manifests)
  ON CONFLICT (id) DO NOTHING;

-- A revision as stored in the agent object; anything but a plain integer is no revision.
CREATE OR REPLACE FUNCTION agent_public_cards_revision(value jsonb) RETURNS integer
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN jsonb_typeof(value) = 'number' AND (value #>> '{}') ~ '^[0-9]{1,9}$'
              THEN (value #>> '{}')::integer END
$$;

CREATE OR REPLACE FUNCTION agent_public_cards_refresh(ids text[]) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF ids IS NULL OR cardinality(ids) = 0 THEN
    RETURN;
  END IF;
  DELETE FROM agent_public_cards WHERE agent_id = ANY (ids);
  IF cardinality(ids) <= 8 THEN
    INSERT INTO agent_public_cards (agent_id, operator_id, revision, name)
    SELECT w.aid, ws.operator_id, m.revision,
           NULLIF(btrim(m.manifest->'metadata'->>'displayName'), '')
      FROM (SELECT DISTINCT x AS aid FROM unnest(ids) x WHERE x IS NOT NULL) w
      JOIN workspaces ws
        ON ws.operator_id = (SELECT operator_id FROM agent_manifests WHERE agent_id = w.aid LIMIT 1)
      CROSS JOIN LATERAL (SELECT workspace_agent(ws.operator_id, ws.data, w.aid) AS a OFFSET 0) x
      JOIN agent_manifests m
        ON m.agent_id = w.aid AND m.revision = agent_public_cards_revision(x.a->'revision')
     WHERE x.a->>'revokedAt' IS NULL AND m.manifest->'spec'->>'visibility' = 'public';
  ELSE
    INSERT INTO agent_public_cards (agent_id, operator_id, revision, name)
    WITH want AS MATERIALIZED (
      SELECT w.aid,
             (SELECT operator_id FROM agent_manifests WHERE agent_id = w.aid LIMIT 1) AS ws_id
        FROM (SELECT DISTINCT x AS aid FROM unnest(ids) x WHERE x IS NOT NULL) w),
    listed AS MATERIALIZED (
      SELECT ws.operator_id AS ws_id, wa.ordinal, wa.agent->>'id' AS aid,
             agent_public_cards_revision(wa.agent->'revision') AS revision,
             wa.agent->>'revokedAt' IS NULL AS live
        FROM workspaces ws
        CROSS JOIN LATERAL workspace_agents(ws.operator_id, ws.data) wa
       WHERE ws.operator_id IN (SELECT ws_id FROM want)),
    cur AS (
      SELECT DISTINCT ON (e.aid) e.aid, e.ws_id, e.revision, e.live
        FROM listed e JOIN want w ON w.aid = e.aid AND w.ws_id = e.ws_id
       ORDER BY e.aid, e.ordinal)
    SELECT c.aid, c.ws_id, m.revision, NULLIF(btrim(m.manifest->'metadata'->>'displayName'), '')
      FROM cur c
      JOIN agent_manifests m ON m.agent_id = c.aid AND m.revision = c.revision
     WHERE c.live AND m.manifest->'spec'->>'visibility' = 'public';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION workspaces_public_cards_sync() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  before jsonb := '[]'::jsonb;
  after jsonb := '[]'::jsonb;
  after_ids jsonb;
  changed text[];
BEGIN
  IF TG_OP <> 'INSERT' AND (TG_OP = 'DELETE' OR OLD.operator_id IS DISTINCT FROM NEW.operator_id) THEN
    PERFORM agent_public_cards_refresh(
      ARRAY(SELECT agent_id FROM agent_public_cards WHERE operator_id = OLD.operator_id));
    IF TG_OP = 'DELETE' THEN
      RETURN NULL;
    END IF;
  END IF;
  -- Rows mode: the agents table's own trigger keeps the cards.
  IF EXISTS (SELECT 1 FROM workspace_storage s WHERE s.operator_id = NEW.operator_id AND s.mode = 'rows') THEN
    RETURN NULL;
  END IF;
  IF jsonb_typeof(NEW.data->'agents') = 'array' THEN
    after := NEW.data->'agents';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.operator_id = NEW.operator_id THEN
    IF jsonb_typeof(OLD.data->'agents') = 'array' THEN
      before := OLD.data->'agents';
    END IF;
    -- Most writes change other fields of the agents (presence, work): the same ids in the same
    -- order, the same revisions and the same revoked agents leave every card as it was. These
    -- lists say which agent each revision and revocation belongs to only while no id appears
    -- twice; with a repeated id they cannot tell its records apart (a live and a revoked record
    -- swapped give the same lists), so such a workspace is compared record by record below.
    after_ids := jsonb_path_query_array(after, '$[*].id');
    IF jsonb_path_query_array(before, '$[*].id') = after_ids
       AND jsonb_path_query_array(before, '$[*] ? (exists(@.revision)).id')
         = jsonb_path_query_array(after, '$[*] ? (exists(@.revision)).id')
       AND jsonb_path_query_array(before, '$[*].revision')
         = jsonb_path_query_array(after, '$[*].revision')
       AND jsonb_path_query_array(before, '$[*] ? (@.revokedAt.type() != "null").id')
         = jsonb_path_query_array(after, '$[*] ? (@.revokedAt.type() != "null").id')
       AND (SELECT count(*) = count(DISTINCT v) FROM jsonb_array_elements_text(after_ids) v) THEN
      RETURN NULL;
    END IF;
  END IF;
  -- An agent's card is read from the first of its records in array order, so every agent whose
  -- records, in order (revision, revoked or not), differ between the two arrays is read again:
  -- added, removed, changed, or only moved among its other records.
  SELECT array_agg(COALESCE(b.id, f.id)) INTO changed
    FROM (SELECT a->>'id' AS id,
                 jsonb_agg(jsonb_build_array(a->'revision', a->>'revokedAt' IS NULL) ORDER BY o) AS seq
            FROM jsonb_array_elements(before) WITH ORDINALITY e(a, o)
           WHERE a->>'id' IS NOT NULL GROUP BY 1) b
    FULL JOIN
         (SELECT a->>'id' AS id,
                 jsonb_agg(jsonb_build_array(a->'revision', a->>'revokedAt' IS NULL) ORDER BY o) AS seq
            FROM jsonb_array_elements(after) WITH ORDINALITY e(a, o)
           WHERE a->>'id' IS NOT NULL GROUP BY 1) f
      ON f.id = b.id
   WHERE b.seq IS DISTINCT FROM f.seq;
  PERFORM agent_public_cards_refresh(changed);
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS workspaces_public_cards_on_insert ON workspaces;
CREATE TRIGGER workspaces_public_cards_on_insert AFTER INSERT ON workspaces
  FOR EACH ROW EXECUTE FUNCTION workspaces_public_cards_sync();
DROP TRIGGER IF EXISTS workspaces_public_cards_on_update ON workspaces;
CREATE TRIGGER workspaces_public_cards_on_update AFTER UPDATE ON workspaces
  FOR EACH ROW WHEN (OLD.data->'agents' IS DISTINCT FROM NEW.data->'agents'
                     OR OLD.operator_id IS DISTINCT FROM NEW.operator_id)
  EXECUTE FUNCTION workspaces_public_cards_sync();
DROP TRIGGER IF EXISTS workspaces_public_cards_on_delete ON workspaces;
CREATE TRIGGER workspaces_public_cards_on_delete AFTER DELETE ON workspaces
  FOR EACH ROW EXECUTE FUNCTION workspaces_public_cards_sync();

CREATE OR REPLACE FUNCTION agents_public_cards_sync() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.operator_id = NEW.operator_id AND OLD.agent_id = NEW.agent_id
     AND OLD.ordinal = NEW.ordinal
     AND (OLD.agent->'revision') IS NOT DISTINCT FROM (NEW.agent->'revision')
     AND (OLD.agent->>'revokedAt' IS NULL) = (NEW.agent->>'revokedAt' IS NULL) THEN
    RETURN NULL;
  END IF;
  IF TG_OP <> 'INSERT' THEN
    PERFORM agent_public_cards_refresh(ARRAY[OLD.agent_id::text]);
  END IF;
  IF TG_OP <> 'DELETE' THEN
    PERFORM agent_public_cards_refresh(ARRAY[NEW.agent_id::text]);
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS agents_public_cards ON agents;
CREATE TRIGGER agents_public_cards AFTER INSERT OR UPDATE OR DELETE ON agents
  FOR EACH ROW EXECUTE FUNCTION agents_public_cards_sync();

-- A public manifest whose agent has no card at that revision or a later one at commit: its
-- workspace may already point at it (written first), so the agent is read again. Every other
-- manifest (written before its workspace, which then refreshes the agent) costs one probe.
CREATE OR REPLACE FUNCTION agent_manifests_public_cards_sync() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.manifest->'spec'->>'visibility' = 'public' AND NOT EXISTS (
       SELECT 1 FROM agent_public_cards c
        WHERE c.agent_id = NEW.agent_id AND c.revision >= NEW.revision) THEN
    PERFORM agent_public_cards_refresh(ARRAY[NEW.agent_id]);
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS agent_manifests_public_cards ON agent_manifests;
CREATE CONSTRAINT TRIGGER agent_manifests_public_cards AFTER INSERT ON agent_manifests
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION agent_manifests_public_cards_sync();

-- A manifest changed or deleted in place (a claim moves its operator_id; a workspace's cleanup
-- deletes them): its agents are read again, once per statement.
CREATE OR REPLACE FUNCTION agent_manifests_public_cards_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM agent_public_cards_refresh(ARRAY(SELECT DISTINCT agent_id FROM changed_manifests));
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS agent_manifests_public_cards_updated ON agent_manifests;
CREATE TRIGGER agent_manifests_public_cards_updated AFTER UPDATE ON agent_manifests
  REFERENCING NEW TABLE AS changed_manifests
  FOR EACH STATEMENT EXECUTE FUNCTION agent_manifests_public_cards_changed();
DROP TRIGGER IF EXISTS agent_manifests_public_cards_deleted ON agent_manifests;
CREATE TRIGGER agent_manifests_public_cards_deleted AFTER DELETE ON agent_manifests
  REFERENCING OLD TABLE AS changed_manifests
  FOR EACH STATEMENT EXECUTE FUNCTION agent_manifests_public_cards_changed();
`;

export const agentPublicCardsMigration: Migration = {
  version: 280,
  name: 'agent_public_cards',
  sql: AGENT_PUBLIC_CARDS_SQL,
};

/** Idempotent; call before runMigrations (after 245 and 254, whose functions it reads through). */
export function registerAgentPublicCardsMigration(): void {
  registerMigration(agentPublicCardsMigration);
}

/**
 * True once every agent is in agent_public_cards (the backfill below finished). An uncorrelated
 * subquery, so a statement reads it once; readers branch on it until then.
 */
export const PUBLIC_CARDS_READY =
  '(SELECT b.ready FROM agent_public_cards_backfill b WHERE b.id = 1)';
