import type { Hex } from 'viem';
import type { SettleResult } from '../chain/x402-facilitator.js';
import type { ReceiveEvidence } from './receive-evidence.js';
import type { createReceiveReconciler } from './receive-reconcile.js';
import type { ReceiveBinding, createReceiveStore } from './receive-store.js';

type Store = ReturnType<typeof createReceiveStore>;

/** Internal orchestration only: the caller must authenticate and verify the exact authorization.
 * Delivery must be idempotent by receiptId. A delivery crash may retry, but settlement never does.
 */
export function createReceiveRuntime<T>(dependencies: {
  store: Store;
  evidence(chainId: number, transaction: Hex): Promise<ReceiveEvidence | null>;
  deliver(claim: Readonly<ReceiveBinding & { receiptId: string }>): Promise<T>;
  /** Resolves a claim without a transaction from the chain itself; absent, it stays pending. */
  reconciler?: ReturnType<typeof createReceiveReconciler>;
}) {
  return async (
    input: ReceiveBinding & { validBefore?: string },
    settleVerifiedAuthorization: () => Promise<SettleResult>,
    reconcileOnly = false,
  ): Promise<
    | { kind: 'pending'; receiptId: string }
    | { kind: 'failed'; receiptId: string }
    | { kind: 'paid'; receiptId: string; transaction: Hex; value: T }
  > => {
    const binding = Object.freeze({
      workspaceId: input.workspaceId,
      resource: input.resource,
      chainId: input.chainId,
      token: input.token,
      payer: input.payer,
      nonce: input.nonce,
      recipient: input.recipient,
      amount: input.amount,
    });
    const claim = reconcileOnly
      ? await dependencies.store.find(binding)
      : await dependencies.store.claim(binding, {
          validBefore: input.validBefore ?? null,
          searchFromBlock: (await dependencies.reconciler?.startBlock()) ?? null,
        });
    if (!claim) throw new Error('RECEIVE_CLAIM_NOT_FOUND');
    const pending = { kind: 'pending' as const, receiptId: claim.receiptId };
    let transaction = claim.transaction;
    if (claim.acquired) {
      // Persist uncertainty before the external side effect. Never reacquire on timeout/crash.
      if (!(await dependencies.store.reconcile(binding.workspaceId, claim.receiptId, null)))
        return pending;
      let result: SettleResult;
      try {
        result = await settleVerifiedAuthorization();
      } catch {
        return pending;
      }
      if (result.kind !== 'settled' && result.kind !== 'pending') return pending;
      transaction = result.transaction;
      if (!(await dependencies.store.reconcile(binding.workspaceId, claim.receiptId, transaction)))
        return pending;
    }
    // The authorization can never be used: the resource is offered again with a fresh nonce.
    if (claim.state === 'failed') return { kind: 'failed', receiptId: claim.receiptId };
    if (!transaction && !claim.acquired && dependencies.reconciler) {
      // Settlement threw or ended without a transaction (or a crash before it): ask the chain.
      const outcome = await dependencies.reconciler.reconcile(binding.workspaceId, claim.receiptId);
      if (outcome.kind === 'failed') return { kind: 'failed', receiptId: claim.receiptId };
      if (outcome.kind === 'transaction') transaction = outcome.transaction;
    }
    if (!transaction) return pending;
    // Even a paid replay must still have canonical evidence before delivering.
    const evidence = await dependencies.evidence(binding.chainId, transaction as Hex);
    if (!evidence || !(await dependencies.store.markPaid(binding, claim.receiptId, evidence)))
      return pending;
    const value = await dependencies.deliver(
      Object.freeze({ ...binding, receiptId: claim.receiptId }),
    );
    return { kind: 'paid', receiptId: claim.receiptId, transaction: transaction as Hex, value };
  };
}
