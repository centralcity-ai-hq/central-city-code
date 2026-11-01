import type { ServiceCall } from '../../shared/explorer-calls';
import type { VerifyResult } from '../verify/onBaseData';

/*
 * The proof pages' pure rules (reviews #44 and #51 on #620): when a payment receipt counts as
 * proof of its row, and when a ratings check counts as a pass.
 */

export type Outcome = 'pass' | 'fail' | 'none';

/** keccak256("FeeCharged(address,address,bytes32,uint8,uint256,uint256)"), the routers' event. */
export const FEE_CHARGED = '0xc9baea22cceca5bb8411bc7c26fb3c9459c041867454c5a4f2ef67c3d9b49263';

export type Receipt = {
  status?: string;
  logs?: Array<{ address?: string; topics?: string[] }>;
} | null;

const topicAddress = (topic: string | undefined) => `0x${(topic ?? '').slice(-40)}`.toLowerCase();

/**
 * pass: the transaction succeeded and holds a FeeCharged event from one of `routers` whose
 * payer, payee and payment ref are the row's own; fail: Base answered otherwise; none: no receipt.
 */
export function receiptOutcome(
  call: Pick<ServiceCall, 'payer' | 'provider' | 'ref'>,
  receipt: Receipt | undefined,
  routers: ReadonlySet<string>,
): Outcome {
  if (!receipt) return 'none';
  const charged = (receipt.logs ?? []).some(
    (l) =>
      routers.has((l.address ?? '').toLowerCase()) &&
      l.topics?.[0]?.toLowerCase() === FEE_CHARGED &&
      topicAddress(l.topics[1]) === call.payer.toLowerCase() &&
      topicAddress(l.topics[2]) === call.provider.toLowerCase() &&
      l.topics[3]?.toLowerCase() === call.ref.toLowerCase(),
  );
  return receipt.status === '0x1' && charged ? 'pass' : 'fail';
}

/**
 * An identity check (owner, passport address, registration, final) as the proof pages count it:
 * any check that failed is a fail; a check Base or the registration file could not answer yet
 * (pending: an unreadable file, finality not reached) is 'none', never a red fail; all passed is
 * a pass. Unreachable Base is 'none'.
 */
export function identityOutcome(result: VerifyResult): Outcome {
  if (result.kind !== 'checked') return 'none';
  const identity = [result.owner, result.uri, result.registeredBy, result.final];
  if (identity.some((tick) => tick.state === 'fail')) return 'fail';
  return identity.every((tick) => tick.state === 'pass') ? 'pass' : 'none';
}

/**
 * A ratings check passes only when the identity checks pass AND the score was recomputed from the
 * registry. A score not read (pending) or no score check is 'none', never a pass; a score that
 * differs, or an identity check that failed, is a fail.
 */
export function ratingOutcome(result: VerifyResult): Outcome {
  const identity = identityOutcome(result);
  if (result.kind !== 'checked' || identity === 'fail') return identity;
  if (result.score?.state === 'fail') return 'fail';
  if (identity === 'none') return 'none';
  return result.score?.state === 'pass' ? 'pass' : 'none';
}
