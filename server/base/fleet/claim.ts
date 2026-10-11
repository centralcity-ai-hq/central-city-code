import type { Database } from '../../database.js';
import type { FleetClaim } from './worker.js';

/** Claim standalone provisioning stages only; funded batches have a separate execution owner. */
export async function claimFleetItem(
  db: Database,
  jobId: string,
  workerId: string,
  nowMs: number,
  leaseMs = 30_000,
): Promise<FleetClaim | null> {
  if (
    !jobId ||
    !workerId ||
    !Number.isSafeInteger(nowMs) ||
    nowMs < 0 ||
    !Number.isSafeInteger(leaseMs) ||
    leaseMs < 1000 ||
    leaseMs > 300_000 ||
    !Number.isSafeInteger(nowMs + leaseMs)
  )
    throw new Error('Invalid fleet lease.');
  return db.transaction(async (tx) => {
    const result = await tx.query<{
      job_id: string;
      ordinal: number;
      stage: 'wallet' | 'registration';
      agent_id: string;
      operation_key: string;
      intent_hash: string;
      attempted: boolean;
      fence: string;
      operator_id: string;
      chain_id: number;
      registration_mode: 'lazy' | 'immediate';
    }>(
      `WITH candidate AS (
        SELECT i.job_id, i.ordinal, i.stage
        FROM base_fleet_items i JOIN base_fleet_jobs j ON j.job_id = i.job_id
        WHERE i.job_id = $1 AND i.batch_no IS NULL AND i.status IN ('pending','unknown')
          AND (i.lease_expires_at IS NULL OR i.lease_expires_at <= $2)
          AND (i.next_retry_at IS NULL OR i.next_retry_at <= $2)
          AND (i.attempted OR (j.state = 'running' AND j.expires_at > $2
            AND i.refused_at IS NULL
            AND (i.stage = 'wallet' OR (j.registration_mode = 'immediate' AND EXISTS (
              SELECT 1 FROM base_fleet_items w WHERE w.job_id = i.job_id
                AND w.ordinal = i.ordinal AND w.agent_id = i.agent_id
                AND w.stage = 'wallet' AND w.status = 'final')))))
        ORDER BY COALESCE(i.next_retry_at,0), i.ordinal, i.stage
        FOR UPDATE OF i SKIP LOCKED LIMIT 1
      ), claimed AS (
        UPDATE base_fleet_items i SET lease_owner = $3, lease_expires_at = $4,
          fence = i.fence + 1, updated_at = $2
        FROM candidate c WHERE i.job_id = c.job_id AND i.ordinal = c.ordinal AND i.stage = c.stage
        RETURNING i.*
      ) SELECT c.job_id,c.ordinal,c.stage,c.agent_id,c.operation_key,c.intent_hash,c.attempted,
          c.fence::text AS fence,j.operator_id,j.chain_id,j.registration_mode
        FROM claimed c JOIN base_fleet_jobs j ON j.job_id = c.job_id`,
      [jobId, nowMs, workerId, nowMs + leaseMs],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      fence: row.fence,
      item: {
        jobId: row.job_id,
        workspaceId: row.operator_id,
        chainId: row.chain_id,
        agentId: row.agent_id,
        ordinal: row.ordinal,
        intentHash: row.intent_hash,
        registrationMode: row.registration_mode,
        stage: row.stage,
        operationKey: row.operation_key,
        attempted: row.attempted,
      },
    };
  });
}
