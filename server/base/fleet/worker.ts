import { ANVIL, BASE_SEPOLIA } from '../../../shared/base/chains.js';

/** A bounded provisioning worker. Persistence and authorization are injected, not implemented here. */
export interface FleetItem {
  jobId: string;
  workspaceId: string;
  chainId: number;
  agentId: string;
  ordinal: number;
  intentHash: string;
  registrationMode: 'lazy' | 'immediate';
  stage: 'wallet' | 'registration';
  operationKey: string;
  /** An attempted operation must be reconciled, even after a worker restart. */
  attempted: boolean;
}

export interface FleetClaim {
  item: Readonly<FleetItem>;
  fence: string;
}

export type FleetOutcome = 'final' | 'failed' | 'pending' | 'unknown' | 'absent';
export interface FleetStore {
  /** Atomically claims one eligible item, including cancelled items needing reconciliation.
   * Must persist a monotonic fence and stable operationKey before returning a claim.
   * Limit retries with next_retry_at; never return completed items.
   */
  claim(jobId: string): Promise<FleetClaim | null>;
  /** Checks the current fence/lease and atomically persists attempted=true before external work.
   * Returns false if cancelled, expired, already attempted, or no longer owned by this worker.
   */
  begin(claim: FleetClaim): Promise<boolean>;
  /** Fenced workflow refusal only. Preserve attempted state, operation status and reservations.
   * Return false without writing if the claim lost its fence; never terminalize an operation.
   * Pending/unknown attempted operations remain eligible for reconciliation.
   */
  refuse(claim: FleetClaim): Promise<boolean>;
  /** Fenced update: final advances wallet→registration only for immediate mode, otherwise done.
   * Failed is terminal for this operation: no stage advance or automatic resubmission.
   * Settle actual fees and release principal only after definitive chain reconciliation.
   * Pending/unknown retain the same operation identity and require reconciliation; cancelled jobs
   * never start a new stage. Stale fences must be rejected. No chain cancellation is implied.
   */
  settle(claim: FleetClaim, outcome: Exclude<FleetOutcome, 'absent'>): Promise<void>;
}

export interface FleetAuthority {
  /** Recheck current workspace/agent ownership, policy, approval and freeze state. */
  authorize(item: Readonly<FleetItem>, action: 'reconcile' | 'submit'): Promise<void>;
}

export interface FleetAdapter {
  /** Durable lookup by operationKey + immutable intentHash; missing is not permission to replay. */
  reconcile(item: Readonly<FleetItem>): Promise<FleetOutcome>;
  /** Must atomically dedupe/reserve operationKey + intentHash and recheck live authority.
   * Wallet stage calls ensureWallet; registration stage calls the identity service.
   * No key handling or payment settlement belongs in this worker.
   */
  submit(item: Readonly<FleetItem>): Promise<Exclude<FleetOutcome, 'absent'>>;
}

export interface FleetRunResult {
  claimed: number;
  final: number;
  failed: number;
  deferred: number;
  refused: number;
}

/** Process at most maxItems sequentially. No timer, background loop, or network client. */
export async function runFleetSlice(
  jobId: string,
  ports: { store: FleetStore; authority: FleetAuthority; adapter: FleetAdapter },
  maxItems = 50,
): Promise<FleetRunResult> {
  if (!jobId || !Number.isSafeInteger(maxItems) || maxItems < 1 || maxItems > 200)
    throw new Error('Invalid fleet slice.');
  const result: FleetRunResult = { claimed: 0, final: 0, failed: 0, deferred: 0, refused: 0 };
  const seen = new Set<string>();
  for (let n = 0; n < maxItems; n++) {
    const stored = await ports.store.claim(jobId);
    if (!stored) break;
    const claim = Object.freeze({ ...stored, item: Object.freeze({ ...stored.item }) });
    const item = claim.item;
    if (
      item.jobId !== jobId ||
      !item.workspaceId ||
      !item.agentId ||
      !item.intentHash ||
      !item.operationKey ||
      !claim.fence ||
      typeof item.attempted !== 'boolean' ||
      !Number.isSafeInteger(item.ordinal) ||
      item.ordinal < 0 ||
      (item.chainId !== BASE_SEPOLIA && item.chainId !== ANVIL) ||
      !['lazy', 'immediate'].includes(item.registrationMode) ||
      !['wallet', 'registration'].includes(item.stage) ||
      (item.stage === 'registration' && item.registrationMode === 'lazy')
    )
      throw new Error('Invalid fleet claim.');
    // A broken store cannot make this invocation hot-loop the same item/stage.
    const identity = JSON.stringify([item.jobId, item.ordinal, item.stage]);
    if (seen.has(identity)) break;
    seen.add(identity);
    result.claimed++;
    let outcome: Exclude<FleetOutcome, 'absent'>;
    try {
      await ports.authority.authorize(item, 'reconcile');
    } catch {
      await ports.store.refuse(claim);
      result.refused++;
      continue;
    }
    try {
      const prior = await ports.adapter.reconcile(item);
      if (prior !== 'absent') {
        outcome = prior;
      } else if (item.attempted) {
        // The send may have succeeded before durable receipt storage; never invent a new send.
        outcome = 'unknown';
      } else {
        try {
          await ports.authority.authorize(item, 'submit');
        } catch {
          await ports.store.refuse(claim);
          result.refused++;
          continue;
        }
        if (!(await ports.store.begin(claim))) {
          await ports.store.refuse(claim);
          result.refused++;
          continue;
        }
        outcome = await ports.adapter.submit(item);
      }
    } catch {
      // Deliberately do not persist arbitrary provider messages (which can contain secrets).
      outcome = 'unknown';
    }
    // Validate untrusted runtime port results, even when a TypeScript adapter declares the union.
    if (!['final', 'failed', 'pending', 'unknown'].includes(outcome)) outcome = 'unknown';
    // Persist failures propagate: the next invocation must see attempted=true and reconcile.
    await ports.store.settle(claim, outcome);
    if (outcome === 'final') result.final++;
    else if (outcome === 'failed') result.failed++;
    else result.deferred++;
  }
  return result;
}
