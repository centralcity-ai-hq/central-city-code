import type { Database } from '../../database.js';
import type { FleetClaim } from './worker.js';

/** All persisted timestamps and the injected clock use Unix milliseconds.
 * Database mutations for an existing claim. Claim acquisition and chain work are separate. */
export function createFleetLeaseUpdates(db: Database, now: () => number = Date.now) {
  const identity = (claim: FleetClaim) => {
    const { item, fence } = claim;
    if (!/^[1-9][0-9]*$/.test(fence)) throw new Error('Invalid fleet fence.');
    return [item.jobId, item.ordinal, item.stage, item.operationKey, item.intentHash, fence];
  };
  return {
    async begin(claim: FleetClaim): Promise<boolean> {
      const key = identity(claim);
      return db.transaction(async (tx) => {
        // Cancellation must lock/update this same job row. Check time after acquiring the lock.
        const job = await tx.query<{ state: string; expires_at: string }>(
          'SELECT state, expires_at::text FROM base_fleet_jobs WHERE job_id = $1 AND operator_id = $2 AND chain_id = $3 FOR UPDATE',
          [claim.item.jobId, claim.item.workspaceId, claim.item.chainId],
        );
        const at = now();
        if (!Number.isSafeInteger(at) || at < 0) throw new Error('Invalid fleet clock.');
        if (
          !job.rows[0] ||
          job.rows[0].state !== 'running' ||
          BigInt(job.rows[0].expires_at) <= BigInt(at)
        )
          return false;
        const result = await tx.query(
          `UPDATE base_fleet_items SET attempted = true, updated_at = $7
           WHERE job_id = $1 AND ordinal = $2 AND stage = $3
             AND operation_key = $4 AND intent_hash = $5 AND fence = $6::bigint
             AND batch_no IS NULL AND lease_expires_at > $7 AND attempted = false AND refused_at IS NULL
             AND status IN ('pending','unknown') AND agent_id = $8 RETURNING operation_key`,
          [...key, at, claim.item.agentId],
        );
        return result.rows.length === 1;
      });
    },
    async refuse(claim: FleetClaim): Promise<boolean> {
      const key = identity(claim);
      const at = now();
      if (!Number.isSafeInteger(at) || at < 0) throw new Error('Invalid fleet clock.');
      // Do not clear the lease or change status/attempted: uncertain work still needs reconciliation.
      const result = await db.query(
        `UPDATE base_fleet_items SET refused_at = COALESCE(refused_at, $7), updated_at = $7
         WHERE job_id = $1 AND ordinal = $2 AND stage = $3
           AND operation_key = $4 AND intent_hash = $5 AND fence = $6::bigint
           AND batch_no IS NULL AND lease_expires_at > $7 AND status IN ('pending','unknown') AND agent_id = $8
           AND EXISTS (SELECT 1 FROM base_fleet_jobs j WHERE j.job_id = $1
             AND j.operator_id = $9 AND j.chain_id = $10)
         RETURNING operation_key`,
        [...key, at, claim.item.agentId, claim.item.workspaceId, claim.item.chainId],
      );
      return result.rows.length === 1;
    },
  };
}
