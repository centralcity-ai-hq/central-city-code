import type { Transaction } from '../../database.js';
import { reserveFleetBudget } from './budget.js';
import { fleetProviderFee } from './pricing.js';

export interface FleetFeeHold {
  jobId: string;
  workspaceId: string;
  chainId: number;
  batchNo: number;
  operationKey: string;
  intentHash: string;
  maxCostWei: bigint;
}

/** Transaction-scoped accounting only. Caller must verify the signed run, reserve principal,
 * and commit all holds together before broadcast. Acquire wallet union locks before this call.
 * Does not authorize a send, release unknown holds, or establish treasury funding.
 */
export async function holdFleetFee(
  tx: Transaction,
  input: FleetFeeHold,
  now: () => number = Date.now,
): Promise<bigint> {
  const i = { ...input };
  if (
    !i.jobId ||
    !i.workspaceId ||
    !i.operationKey ||
    !i.intentHash ||
    ![31337, 84532, 8453].includes(i.chainId) ||
    !Number.isSafeInteger(i.batchNo) ||
    i.batchNo < 0 ||
    typeof i.maxCostWei !== 'bigint' ||
    i.maxCostWei < 0n ||
    i.maxCostWei >= 2n ** 256n
  )
    throw new Error('Invalid fleet fee hold.');
  const job = (
    await tx.query<{ state: string; expires_at: string }>(
      `SELECT state, expires_at FROM base_fleet_jobs
     WHERE job_id=$1 AND operator_id=$2 AND chain_id=$3 FOR UPDATE`,
      [i.jobId, i.workspaceId, i.chainId],
    )
  ).rows[0];
  const batch = (
    await tx.query<{
      state: string;
      attempted: boolean;
      refused_at: string | null;
      max_fee_reserved_wei: string;
    }>(
      `SELECT state, attempted, refused_at, max_fee_reserved_wei FROM base_fleet_batches
      WHERE job_id=$1 AND batch_no=$2 AND operation_key=$3 AND intent_hash=$4 FOR UPDATE`,
      [i.jobId, i.batchNo, i.operationKey, i.intentHash],
    )
  ).rows[0];
  const budget = (
    await tx.query<{
      ceiling_wei: string;
      reserved_wei: string;
      spent_wei: string;
      provider_pricing_version: string;
      provider_terms: unknown;
    }>(
      `SELECT ceiling_wei, reserved_wei, spent_wei, provider_pricing_version, provider_terms
      FROM base_fleet_fee_budgets WHERE job_id=$1 FOR UPDATE`,
      [i.jobId],
    )
  ).rows[0];
  // Check time after all blocking locks, never with a timestamp captured before them.
  const time = now();
  if (
    !Number.isSafeInteger(time) ||
    time < 0 ||
    !job ||
    job.state !== 'running' ||
    BigInt(job.expires_at) <= BigInt(time) ||
    !batch ||
    batch.state !== 'pending' ||
    batch.attempted ||
    batch.refused_at !== null ||
    !budget
  )
    throw new Error('Fleet fee hold is not admissible.');
  const bound = fleetProviderFee(
    i.maxCostWei,
    budget.provider_pricing_version,
    budget.provider_terms,
  );
  // Zero is the schema's unacquired sentinel; never accept it as an immutable hold.
  if (bound === 0n) throw new Error('Fleet fee hold must be positive.');
  const current = reserveFleetBudget(
    {
      cap: BigInt(budget.ceiling_wei),
      spent: BigInt(budget.spent_wei),
      held: BigInt(budget.reserved_wei),
    },
    0n,
  );
  const prior = BigInt(batch.max_fee_reserved_wei);
  // A retry may use its immutable hold, but cannot silently enlarge it or free the difference.
  if (prior > 0n) {
    if (bound > prior || prior > current.held)
      throw new Error('Fleet fee hold conflicts with existing reservation.');
    return prior;
  }
  const balance = reserveFleetBudget(current, bound);
  await tx.query('UPDATE base_fleet_fee_budgets SET reserved_wei=$2 WHERE job_id=$1', [
    i.jobId,
    balance.held.toString(),
  ]);
  await tx.query(
    `UPDATE base_fleet_batches SET max_fee_reserved_wei=$3, updated_at=$4
    WHERE job_id=$1 AND batch_no=$2`,
    [i.jobId, i.batchNo, bound.toString(), time],
  );
  return bound;
}
