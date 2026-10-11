import type { Database } from '../../database.js';
import type { FleetClaim, FleetOutcome } from './worker.js';

/** Persist a standalone stage observation. Never settles funded batches or releases reservations. */
export async function settleFleetItem(
  db: Database,
  claim: FleetClaim,
  outcome: Exclude<FleetOutcome, 'absent'>,
  nowMs: number,
  retryMs = 5000,
): Promise<boolean> {
  if (
    !['final', 'failed', 'pending', 'unknown'].includes(outcome) ||
    !/^[1-9][0-9]*$/.test(claim.fence) ||
    !Number.isSafeInteger(nowMs) ||
    nowMs < 0 ||
    !Number.isSafeInteger(retryMs) ||
    retryMs < 1000 ||
    retryMs > 300_000 ||
    !Number.isSafeInteger(nowMs + retryMs)
  )
    throw new Error('Invalid fleet settlement.');
  const i = claim.item;
  const terminal = outcome === 'final' || outcome === 'failed';
  const result = await db.query(
    `UPDATE base_fleet_items SET status = $7, updated_at = $8,
       next_retry_at = $9, lease_owner = NULL, lease_expires_at = NULL
     WHERE job_id = $1 AND ordinal = $2 AND stage = $3
       AND operation_key = $4 AND intent_hash = $5 AND fence = $6::bigint
       AND agent_id = $10 AND batch_no IS NULL AND lease_expires_at > $8
       AND status IN ('pending','unknown')
       AND EXISTS (SELECT 1 FROM base_fleet_jobs j WHERE j.job_id = $1
         AND j.operator_id = $11 AND j.chain_id = $12)
     RETURNING operation_key`,
    [
      i.jobId,
      i.ordinal,
      i.stage,
      i.operationKey,
      i.intentHash,
      claim.fence,
      outcome,
      nowMs,
      terminal ? null : nowMs + retryMs,
      i.agentId,
      i.workspaceId,
      i.chainId,
    ],
  );
  // False means ownership was lost or the operation is already terminal. Never overwrite either.
  return result.rows.length === 1;
}
