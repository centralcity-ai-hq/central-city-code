/**
 * One workspace's document with its agents, by operator id, in both storage modes. The mode check
 * is inline so a document-mode workspace returns `data` as stored, without the copy a bare
 * `workspace_document()` call makes (113 ms vs 173 ms on a 45k-agent workspace).
 */
export const WORKSPACE_DATA_BY_ID_SQL =
  "SELECT CASE WHEN EXISTS (SELECT 1 FROM workspace_storage s WHERE s.operator_id = ws.operator_id AND s.mode = 'rows') " +
  'THEN workspace_document(ws.operator_id, ws.data) ELSE ws.data END AS data FROM workspaces ws WHERE ws.operator_id=$1';
