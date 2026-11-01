import { registerMigration, type Migration } from '../migrations.js';

/**
 * Migration 254 `workspace_agent_path`: workspace_agent() (migration 245, server/agent-rows/
 * schema.ts) finds one agent of a document-mode workspace with jsonb_path_query_first, one pass
 * over the array in C that stops at the match, instead of expanding the whole array into rows and
 * sorting them. A fleet workspace holds ~19.5k agents, and the Explorer looks up one per listed
 * agent (50 a page: 23 s avg, 22-23 Oct 2026). The answer is the same: the first agent in array
 * order whose id is aid, NULL when there is none or `agents` is not an array. Agent ids are
 * strings (the agents table checks it), so comparing them as JSON strings matches `->>'id' = aid`.
 * Rows mode is unchanged. Replaces one function; no table is touched.
 */
export const WORKSPACE_AGENT_PATH_SQL = `
CREATE OR REPLACE FUNCTION workspace_agent(ws text, doc jsonb, aid text) RETURNS jsonb
LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM workspace_storage s WHERE s.operator_id = ws AND s.mode = 'rows')
      THEN (SELECT a.agent FROM agents a WHERE a.operator_id = ws AND a.agent_id = aid)
    WHEN jsonb_typeof(doc->'agents') = 'array'
      THEN jsonb_path_query_first(doc->'agents', '$[*] ? (@.id == $id)', jsonb_build_object('id', aid))
  END
$$;`;

export const workspaceAgentPathMigration: Migration = {
  version: 254,
  name: 'workspace_agent_path',
  sql: WORKSPACE_AGENT_PATH_SQL,
};

/** Idempotent; call before runMigrations (after migration 245, which creates workspace_agent). */
export function registerWorkspaceAgentPathMigration(): void {
  registerMigration(workspaceAgentPathMigration);
}

/**
 * Migration 290 `workspace_agent_exact`: migration 254's JSON path lookup did not answer exactly
 * as migration 245 in document mode. 245 matches `agent->>'id' = aid`, the id's text whatever its
 * JSON type; 254 compared JSON strings in lax mode, so (1) an agent whose id is a number, boolean,
 * array or object was never found by its text (`{"id":5}` for '5'), (2) lax mode unwrapped arrays:
 * an element that is itself an array of agents, or an id that is an array of strings, matched an
 * id inside it. This version keeps the one-pass path for every id that only a JSON string id can
 * have (all real ids: UUIDs, `ag_...`), in strict mode so nothing is unwrapped, and answers the
 * other ids (a number's text, true, false, a text starting with [ or {) with 245's own expansion.
 * jsonb prints a number in plain decimal (never an exponent), so those shapes cover every id text
 * a non-string id can have. Rows mode is unchanged. Replaces one function; no table is touched.
 */
export const WORKSPACE_AGENT_EXACT_SQL = `
CREATE OR REPLACE FUNCTION workspace_agent(ws text, doc jsonb, aid text) RETURNS jsonb
LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM workspace_storage s WHERE s.operator_id = ws AND s.mode = 'rows')
      THEN (SELECT a.agent FROM agents a WHERE a.operator_id = ws AND a.agent_id = aid)
    WHEN jsonb_typeof(doc->'agents') IS DISTINCT FROM 'array'
      THEN NULL
    WHEN aid ~ '^-?[0-9]+(\\.[0-9]+)?$' OR aid IN ('true', 'false') OR left(aid, 1) IN ('[', '{')
      THEN (SELECT e.agent
              FROM jsonb_array_elements(doc->'agents') WITH ORDINALITY AS e(agent, ordinal)
             WHERE e.agent->>'id' = aid
             ORDER BY e.ordinal
             LIMIT 1)
    ELSE jsonb_path_query_first(doc->'agents', 'strict $[*] ? (@.id == $id)', jsonb_build_object('id', aid))
  END
$$;`;

export const workspaceAgentExactMigration: Migration = {
  version: 290,
  name: 'workspace_agent_exact',
  sql: WORKSPACE_AGENT_EXACT_SQL,
};

/** Idempotent; call before runMigrations (after migration 254). */
export function registerWorkspaceAgentExactMigration(): void {
  registerMigration(workspaceAgentExactMigration);
}
