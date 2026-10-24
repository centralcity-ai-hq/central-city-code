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
