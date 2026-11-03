/*
 * SQL fragments that read a workspace's agents in both storage modes (migration 245). The mode is
 * checked inline, and the document-mode branch is the expression the caller used before, so a
 * workspace in document mode is read exactly as before, with the same plan: no function call that
 * copies the document (workspace_document copies it: 173 ms instead of 113 ms on the 45,504-agent
 * workspace, 2 Nov 2026).
 *
 * `ws` must be qualified (`w.operator_id`) or a parameter (`$1`): a bare `operator_id` would bind to
 * the subqueries' own `s`/`ag` columns and match every workspace. The type rejects a bare one.
 */

/** A workspace id in SQL: a qualified `alias.operator_id` or a parameter `$n`. */
export type WorkspaceIdSql = `${string}.operator_id` | `$${number}`;

/** True when workspace `ws` (an SQL expression for its operator id) stores its agents as rows. */
export const rowsModeSql = (ws: WorkspaceIdSql) =>
  `EXISTS (SELECT 1 FROM workspace_storage s WHERE s.operator_id = ${ws} AND s.mode = 'rows')`;

/**
 * The workspace's agents array: its rows in order in rows mode, `${data}->'agents'` (as stored,
 * which may be missing or not an array) in document mode.
 */
export const agentsArraySql = (ws: WorkspaceIdSql, data: string) =>
  `(CASE WHEN ${rowsModeSql(ws)}
     THEN COALESCE((SELECT jsonb_agg(ag.agent ORDER BY ag.ordinal) FROM agents ag
                     WHERE ag.operator_id = ${ws}), '[]'::jsonb)
     ELSE ${data}->'agents' END)`;

/**
 * The workspace's agents array, always an array: as agentsArraySql, with `'[]'` in document mode
 * when `${data}->'agents'` is missing or not an array.
 */
export const agentsListSql = (ws: WorkspaceIdSql, data: string) =>
  `(CASE WHEN ${rowsModeSql(ws)}
     THEN COALESCE((SELECT jsonb_agg(ag.agent ORDER BY ag.ordinal) FROM agents ag
                     WHERE ag.operator_id = ${ws}), '[]'::jsonb)
     WHEN jsonb_typeof(${data}->'agents') = 'array' THEN ${data}->'agents'
     ELSE '[]'::jsonb END)`;

/**
 * The number of the workspace's agents: its rows in rows mode, `jsonb_array_length(${data}->'agents')`
 * in document mode (NULL when missing, an error when not an array, as before).
 */
export const agentCountSql = (ws: WorkspaceIdSql, data: string) =>
  `(CASE WHEN ${rowsModeSql(ws)}
     THEN (SELECT count(*)::int FROM agents ag WHERE ag.operator_id = ${ws})
     ELSE jsonb_array_length(${data}->'agents') END)`;

/**
 * A document whose `agents` is the workspace's agents in both modes, for functions that take a
 * document (counted_agent_ids_of): `${data}` itself in document mode.
 */
export const documentAgentsSql = (ws: WorkspaceIdSql, data: string) =>
  `(CASE WHEN ${rowsModeSql(ws)}
     THEN jsonb_build_object('agents', COALESCE((SELECT jsonb_agg(ag.agent ORDER BY ag.ordinal)
                                                   FROM agents ag WHERE ag.operator_id = ${ws}), '[]'::jsonb))
     ELSE ${data} END)`;

/**
 * One agent by id: its row in rows mode; in document mode `documentSql`, the caller's previous
 * expression for it.
 */
export const agentByIdSql = (ws: WorkspaceIdSql, id: string, documentSql: string) =>
  `(CASE WHEN ${rowsModeSql(ws)}
     THEN (SELECT ag.agent FROM agents ag WHERE ag.operator_id = ${ws} AND ag.agent_id = ${id})
     ELSE (${documentSql}) END)`;
