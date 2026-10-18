/*
 * The test runs of the offer kinds go through agreeingRun: before each run, the pre-payment check
 * (checkOffer: the schema, then kind.check) is called on the same input, and the two must agree:
 *
 *   - check() throws only OfferKindInputError, and is synchronous (no promise, no network);
 *   - run() never throws OfferKindInputError for an input check() accepted (the buyer has paid);
 *   - run() refuses with OfferKindInputError every input check() refused (run calls check first).
 *
 * So every input of the kinds' tests is also a case of this property; checkAgreementSeen asserts
 * at the end of a file that both sides were exercised.
 */
import assert from 'node:assert/strict';
import {
  checkOffer,
  OfferKindInputError,
  type OfferKind,
  type OfferKindAnswer,
  type OfferKindContext,
} from '../server/feed/offers/kinds.js';

export interface AgreementLog {
  accepted: Map<string, number>;
  refused: Map<string, number>;
}

export const agreementLog = (): AgreementLog => ({ accepted: new Map(), refused: new Map() });

const bump = (map: Map<string, number>, key: string) => map.set(key, (map.get(key) ?? 0) + 1);

export function agreeingRun(
  kind: OfferKind,
  input: unknown,
  ctx: OfferKindContext,
  log: AgreementLog,
): Promise<OfferKindAnswer> {
  let refusal: OfferKindInputError | null = null;
  try {
    const returned: unknown = checkOffer(kind, input);
    assert.ok(!(returned instanceof Promise), `${kind.name}: check is synchronous`);
  } catch (error) {
    assert.ok(error instanceof OfferKindInputError, `${kind.name}: check threw ${String(error)}`);
    refusal = error;
  }
  bump(refusal ? log.refused : log.accepted, kind.name);
  return kind.run(input, ctx).then(
    (answer) => {
      assert.equal(refusal, null, `${kind.name}: check refused an input run answered`);
      return answer;
    },
    (error: unknown) => {
      if (error instanceof OfferKindInputError)
        assert.ok(
          refusal,
          `${kind.name}: run refused an input check accepted (after payment): ${error.message}`,
        );
      else if (refusal && !ctx.signal.aborted)
        assert.fail(`${kind.name}: check refused, run failed otherwise: ${String(error)}`);
      throw error;
    },
  );
}

/** Both sides of the property were exercised, for at least `kinds` kinds each. */
export function checkAgreementSeen(log: AgreementLog, kinds: number): void {
  assert.ok(log.accepted.size >= kinds, `accepted kinds: ${[...log.accepted.keys()].join(', ')}`);
  assert.ok(log.refused.size >= kinds, `refused kinds: ${[...log.refused.keys()].join(', ')}`);
}
