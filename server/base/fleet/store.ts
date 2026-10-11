import type { Database } from '../../database.js';
import { claimFleetItem } from './claim.js';
import { createFleetLeaseUpdates } from './lease-updates.js';
import { settleFleetItem } from './settle.js';
import type { FleetStore } from './worker.js';

/** Standalone provisioning stages only. Funded batches require a separate atomic budget store.
 * Job/item creation, authority checks, and adapter wiring remain the caller's responsibility. */
export function createFleetStore(
  db: Database,
  workerId: string,
  now: () => number = Date.now,
): FleetStore {
  if (!workerId) throw new Error('Invalid fleet worker.');
  const updates = createFleetLeaseUpdates(db, now);
  return {
    claim: (jobId) => claimFleetItem(db, jobId, workerId, now()),
    begin: updates.begin,
    refuse: updates.refuse,
    async settle(claim, outcome) {
      if (!(await settleFleetItem(db, claim, outcome, now()))) {
        // Do not report completion for an observation rejected by the durable store.
        throw new Error('Fleet settlement lost ownership.');
      }
    },
  };
}
