/*
 * Writing a workspace document (migrations 245 and 360). In document mode, as always: the document
 * with its agents array. In rows mode the document is stored without `agents`, and the agents go
 * to their rows (workspace_agents_write), in the same transaction under the workspace's row lock.
 * Reading gives back the same document in both modes (workspace_document).
 */
import type { Transaction } from '../database.js';

type Tx = Pick<Transaction, 'query'>;

/**
 * The document as read: its agents from their rows in rows mode, the stored column itself in
 * document mode. The mode is checked inline: calling workspace_document in document mode copies the
 * whole document (2 Nov 2026, the 45,504-agent workspace: 173 ms instead of 113 ms per read).
 */
export const WORKSPACE_DATA_SQL = `CASE WHEN EXISTS (SELECT 1 FROM workspace_storage s
    WHERE s.operator_id = ws.operator_id AND s.mode = 'rows')
  THEN workspace_document(ws.operator_id, ws.data) ELSE ws.data END`;

/** Stores `data` (the document as JSON) for `operatorId`, its agents as rows in rows mode. */
export async function writeWorkspaceData(tx: Tx, operatorId: string, data: string): Promise<void> {
  const { rows } = await tx.query<{ rows_mode: boolean }>(
    // The statement keeps the `UPDATE workspaces SET data=` prefix that failure-injection tests match.
    `UPDATE workspaces SET data=CASE WHEN workspace_storage_mode($1) = 'rows' THEN $2::jsonb - 'agents' ELSE $2::jsonb END
      WHERE operator_id = $1
      RETURNING workspace_storage_mode($1) = 'rows' AS rows_mode`,
    [operatorId, data],
  );
  if (rows[0]?.rows_mode)
    await tx.query(
      `SELECT workspace_agents_write($1, COALESCE($2::jsonb->'agents', '[]'::jsonb))`,
      [operatorId, data],
    );
}
