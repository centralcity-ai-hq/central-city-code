/*
 * The public x402 facilitator's sender (x402 v2, scheme `exact`, network eip155:8453, USDC via
 * EIP-3009): the `settle` hook of POST /x402/facilitator/settle (public-facilitator.ts), called
 * only after the route ran exactly the /verify check. It sends the payer's signed
 * transferWithAuthorization to USDC from Central City's PUBLIC facilitator EOA, which pays the gas.
 *
 * It runs on its own facilitator instance (its own key, EOA and nonce lane, target = USDC), never
 * on the router 3 facilitator that the engine and the sponsored buys depend on: strangers'
 * traffic can never stall or gap that lane. The sending itself is the router 3 facilitator's
 * durable path (facilitator.ts submitCall): stored before anything is simulated or sent, a
 * simulation revert ends it failed and never sent, the nonce is taken under the lane lock,
 * rebroadcast exactly as stored, replaced at most maxReplacements times.
 *
 * Only the payer's signature moves money; this never decides that a payment may happen. What it
 * guards is our gas: off unless enabled, a minimum value, a validity window that leaves time to
 * send, the same answer for a repeated request (idempotent per payer and EIP-3009 nonce), the
 * check again right before the first send, nothing new once the EOA is below its gas floor, and
 * (CCA-704) one settlement in flight per payer with a cool-down after a revert on Base.
 */
import { keccak256, type Hex } from 'viem';
import type { FeedPayOp } from '../../base/chain/feed-pay-chain.js';
import { ownPaymasterAddress } from '../../base/chain/own-paymaster-keys.js';
import { protocolReservedPayees } from '../fees/cron.js';
import { FacilitatorError, STUCK_MS } from './facilitator.js';
import { payerCooldown } from './payer-cooldown.js';
import {
  FACILITATOR_NETWORK,
  transferCalldata,
  bindingCheck,
  type ExactPayment,
  type SettleAnswer,
  type SettleContext,
  type VerifyAnswer,
} from './public-facilitator.js';

/** One payer's EIP-3009 nonce is one settlement: a retried request returns the same one. */
export const settleKey = (payment: ExactPayment) =>
  `${payerKeyPrefix(payment.authorization.from)}${payment.authorization.nonce.toLowerCase()}`;
/** Every settle key of one payer starts with this (settleKey). */
export const payerKeyPrefix = (payer: Hex) => `x402:exact:8453:${payer.toLowerCase()}:`;

/** What the sender needs of its facilitator instance (facilitator.ts, target USDC). */
export interface PublicFacilitator {
  submitCall(input: {
    key: string;
    intentHash: Hex;
    calldata: Hex;
    beforeBroadcast: () => Promise<void>;
    /** No new settlement while another one of this key prefix is in flight (IN_FLIGHT). */
    oneInFlight?: string;
  }): Promise<FeedPayOp>;
  /**
   * The settlements of a key prefix in flight or in a block and not final yet (database only).
   * Absent: no per-payer check before /verify (the facilitator's own guard still holds), tests.
   */
  openWithPrefix?(prefix: string): Promise<FeedPayOp[]>;
  /** False in a fee spike (the capped fee would not get a new transaction mined); may throw. */
  feeRoom?(): Promise<boolean>;
  /** True while the lane's head has waited unmined longer than `olderThanMs`; may throw. */
  laneStuck?(olderThanMs: number): Promise<boolean>;
  /** Follows the settlement on Base (chain reads; may rebroadcast or replace it). */
  status(key: string): Promise<FeedPayOp | null>;
  /** The stored state only (database; safe for unauthenticated polling). */
  storedStatus(key: string): Promise<FeedPayOp | null>;
  /** The intent hash stored for a key (keccak of its calldata), null when unknown. */
  storedIntent(key: string): Promise<Hex | null>;
  /** The EOA that signs and sends (from its key). */
  address(): Promise<Hex>;
  canPay(): Promise<boolean>;
}

export interface PublicSettleDeps {
  facilitator: PublicFacilitator;
  /** Off unless enabled (CITY_X402_PUBLIC_SETTLE=1). */
  enabled: () => boolean;
  /**
   * The runtime switch, read on every request (CCA-704, publicSettlePaused): true or a throw
   * stops everything new (no check, no signature, no send) and Base is not followed; a stored
   * settlement still answers its stored state. Absent: never paused, only for tests.
   */
  paused?: () => Promise<boolean>;
  /**
   * The address /supported advertises (CITY_X402_PUBLIC_SETTLE_ADDRESS): nothing is sent unless
   * the key's own address is exactly this one, so the advertised signer is always the real one.
   */
  advertised?: Hex;
  /**
   * Takes one new settlement from the gas budget (sequential buckets, see limiterBudget: a daily
   * cap for the public sender, and caps per payer, per calling client and per payee); false:
   * nothing is stored or sent. A minimum
   * value alone cannot stop gas drain (a payer can pay itself), the caps can; the payee and client
   * caps keep many payers (one farm, one resource server) from using up the day (CCA-766). Absent:
   * no budget, only for tests.
   */
  budget?: (payer: Hex, scope: SettleScope) => Promise<boolean>;
  /**
   * The shared cap on chain simulations for new payments (the /verify check), across every client
   * and instance: false refuses before any simulation. Absent: no cap, only for tests.
   */
  simulations?: () => Promise<boolean>;
  /** At most this many new payments are checked and sent at once per instance (default 4). */
  maxInFlight?: number;
  /**
   * Sanctions screening of the payer and the payee, the payment engine's gate (fail closed: false
   * or a throw refuses). Only for a valid new payment, after /verify and before the gas budget.
   * Absent: no screening, only for tests.
   */
  screen?: (payment: ExactPayment) => Promise<boolean>;
  /**
   * The payees never relayed to (public-facilitator.ts bindingCheck; publicSettleReservedPayees),
   * checked first, with the binding. A failed read refuses (settlement_unavailable). Absent: none,
   * only for tests.
   */
  reserved?: () => Promise<ReadonlySet<string>>;
  /**
   * The cool-down of payers whose settlement reverted on Base (CCA-704, publicSettleCooldown):
   * `record` when one is seen reverted, `cooling` refuses that payer's new settlements before
   * /verify (fail closed). Absent: no cool-down, only for tests.
   */
  cooldown?: { record(payer: Hex): Promise<void>; cooling(payer: Hex): Promise<boolean> };
  /** A new authorization may be valid for at most this long from now (default 15 min). */
  maxWindowSeconds?: number;
  /** Least value (raw USDC) settled for anyone: a valid tiny authorization must not buy our gas. */
  minValueRaw?: bigint;
  /** validBefore must leave at least this much time to send and include (seconds). */
  minWindowSeconds?: number;
  now?: () => number;
}

/**
 * 0.05 USDC (CCA-766: raised from 0.01): each settlement costs us gas, so the least value relayed
 * for anyone matches router 3's own lower bound.
 */
export const MIN_VALUE_RAW = 50_000n;
export const MIN_WINDOW_SECONDS = 60;
/** The facilitator never takes an authorization valid further ahead than this (no far-future holds). */
export const MAX_WINDOW_SECONDS = 15 * 60;

/** What the payment engine's screening gate answers (server/protocol/screening/gate.ts). */
export interface ScreeningAnswer {
  allowed: boolean;
  outcome: string;
  reason: string;
  decisionId: string | null;
}
/**
 * Screening for the public sender: payer and payee through the payment engine's gate, bound to
 * the exact amount and to payer + nonce. Unlike the engine (whose emergency switch keeps Central
 * City's own payments running when the oracle breaks), a public relay of third-party transfers
 * stops when screening is switched off: then nothing settles.
 */
export function publicSettleScreening(deps: {
  enabled: () => boolean;
  screen: (request: {
    chainId: number;
    token: string;
    amountRaw: bigint;
    intentId: string;
    parties: { role: 'payer' | 'payee'; address: string }[];
  }) => Promise<ScreeningAnswer>;
  /**
   * One JSON line per decision (screeningLogLine). Default: the console, as the app's ALERT lines:
   * the app's Fastify logger is off in production, so a request logger would drop it.
   */
  log?: (line: string) => void;
}): (payment: ExactPayment) => Promise<boolean> {
  const log = deps.log ?? ((line: string) => console.error(line));
  return async (payment) => {
    if (!deps.enabled()) return false;
    const a = payment.authorization;
    let decision: ScreeningAnswer;
    try {
      decision = await deps.screen({
        chainId: 8453,
        token: payment.requirements.asset,
        amountRaw: a.value,
        intentId: `x402-settle:${a.from.toLowerCase()}:${a.nonce.toLowerCase()}`,
        parties: [
          { role: 'payer', address: a.from },
          { role: 'payee', address: a.to },
        ],
      });
    } catch (error) {
      // Fail closed (the caller refuses on a throw); logged with its code only, never its message.
      log(screeningLogLine({ outcome: 'error', reason: errorCode(error) }));
      throw error;
    }
    log(screeningLogLine(decision));
    return decision.allowed === true;
  };
}

/** A short code fit for the log, else 'other': never an address, id or free text. */
const logCode = (value: unknown): string =>
  typeof value === 'string' && /^[a-z][a-z0-9_.-]{0,47}$/i.test(value) && !/^0x/i.test(value)
    ? value
    : 'other';
const errorCode = (error: unknown): string => logCode((error as { code?: unknown } | null)?.code);

/**
 * The screening log line: the decision's outcome and reason codes only. No payer, payee, client,
 * intent or decision id, and no raw error message.
 */
export function screeningLogLine(decision: { outcome: unknown; reason: unknown }): string {
  return JSON.stringify({
    event: 'x402_settle_screening',
    outcome: logCode(decision.outcome),
    reason: logCode(decision.reason),
  });
}
/** A retry follows its settlement on Base at most this often; between, the stored state answers. */
export const REFRESH_MS = 10_000;
/** New payments checked and sent at once per instance. */
export const MAX_IN_FLIGHT = 4;
/**
 * The lane is called stuck once its head has waited unmined this long (CCA-704): twice the
 * facilitator's STUCK_MS, so its same-nonce replacement had its turn first.
 */
export const STUCK_LANE_MS = 2 * STUCK_MS;
/** Chain simulations for new payments per minute, all clients and instances together. */
export const SIMULATIONS_PER_MINUTE = 120;

const refuse = (errorReason: string, payer?: Hex): SettleAnswer => ({
  success: false,
  transaction: '',
  network: FACILITATOR_NETWORK,
  ...(payer ? { payer } : {}),
  errorReason,
});

/** Who a new settlement's budget is charged to besides its payer (see limiterBudget). */
export interface SettleScope {
  /** The payee the payer signed for. */
  payee: Hex;
  /** The calling client (its address key), when the route knows it. */
  client?: string;
}

/**
 * The sender's settle (public-facilitator.ts PublicSettle.settle): the route's exact /verify,
 * which runs `admit` (the shared simulation cap) after its static checks, right before simulating.
 */
export type SettleFn = (
  payment: ExactPayment,
  verify: (admit?: () => Promise<void>) => Promise<VerifyAnswer>,
  context?: SettleContext,
) => Promise<SettleAnswer>;

/** Thrown by the simulation admission when the shared cap is spent (or its limiter is down). */
class SimulationsSpent extends Error {}

export function createPublicSettle(deps: PublicSettleDeps): {
  settle: SettleFn;
  /** For the route, BEFORE /verify: a completed settlement answers even once its nonce is used. */
  known: (payment: ExactPayment) => Promise<SettleAnswer | null>;
} {
  const now = deps.now ?? Date.now;
  const minValue = deps.minValueRaw ?? MIN_VALUE_RAW;
  const minWindow = BigInt(deps.minWindowSeconds ?? MIN_WINDOW_SECONDS);
  const maxWindow = BigInt(deps.maxWindowSeconds ?? MAX_WINDOW_SECONDS);
  /** New payments being checked or sent right now (bounded by maxInFlight). */
  let inFlight = 0;
  const maxInFlight = deps.maxInFlight ?? MAX_IN_FLIGHT;
  /** When each settlement was last followed on Base (per instance, bounded). */
  const refreshedAt = new Map<string, number>();

  /**
   * The answer for a stored settlement: success for our own transaction once Base included it
   * (as x402 facilitators answer; finality on Base takes 15-30 min, far past an x402 client's
   * wait); sent but not in a block yet is settlement_pending with its transaction (the client asks
   * again with the same request and gets the same settlement), never refused while the money may
   * still move.
   */
  const answer = (op: FeedPayOp | null, payer: Hex): SettleAnswer => {
    if (!op) return refuse('unexpected_settle_error', payer);
    const hash = op.txHash ?? '';
    if ((op.status === 'included' || op.status === 'final') && hash)
      return { success: true, transaction: hash, network: FACILITATOR_NETWORK, payer };
    if (op.status === 'failed') return refuse(failure(op), payer);
    return { ...refuse('settlement_pending', payer), transaction: hash };
  };

  /**
   * A request seen before, bound to exactly what it asks: the stored intent (keccak of the
   * calldata) must be this request's, else it is refused (the same payer and nonce with another
   * recipient or amount never inherits another settlement's receipt). Checked before any time or
   * value rule, so a completed settlement still answers after its authorization expired. Null:
   * never seen.
   */
  const known = async (
    payment: ExactPayment,
    /** False while paused: the stored state only, Base is not followed (no replacement signed). */
    followBase = true,
  ): Promise<SettleAnswer | null> => {
    const payer = payment.authorization.from;
    const key = settleKey(payment);
    const stored = await deps.facilitator.storedIntent(key).catch(() => null);
    if (!stored) return null;
    if (stored.toLowerCase() !== keccak256(transferCalldata(payment)).toLowerCase())
      return refuse('invalid_transaction_state', payer);
    // Unauthenticated retries read the stored state; Base is followed (status: chain reads, maybe a
    // rebroadcast or replacement) at most once per REFRESH_MS per settlement, never per request.
    const op = await deps.facilitator.storedStatus(key).catch(() => null);
    const current =
      !op || op.status === 'final' || op.status === 'failed' || !followBase
        ? op
        : ((await follow(key)) ?? op);
    await noteRevert(current, payer);
    return answer(current, payer);
  };

  /**
   * A settlement followed on Base (status: chain reads, maybe a rebroadcast or replacement) at most
   * once per REFRESH_MS, never per request; null when it was followed too recently (or unreadable).
   */
  const follow = async (key: string): Promise<FeedPayOp | null> => {
    const at = now();
    if (at - (refreshedAt.get(key) ?? 0) < REFRESH_MS) return null;
    refreshedAt.set(key, at);
    if (refreshedAt.size > 10_000) refreshedAt.delete(refreshedAt.keys().next().value!);
    return deps.facilitator.status(key).catch(() => null);
  };

  /** A settlement that reverted on Base puts its payer on the cool-down (CCA-704). */
  const noteRevert = async (op: FeedPayOp | null, payer: Hex) => {
    if (op?.errorCode === 'REVERTED') await deps.cooldown?.record(payer).catch(() => {});
  };

  /**
   * One settlement in flight per payer (CCA-704): /verify simulates against the latest block and
   * nothing holds the payer's balance across pending settlements, so N authorizations for one
   * balance would all pass and all but one revert on Base at our gas cost. True while one of the
   * payer's settlements is sent and not in a block (followed on Base first, at most once per
   * REFRESH_MS); a reverted one starts the payer's cool-down. Null: unreadable (refused).
   */
  const payerBusy = async (payer: Hex): Promise<boolean | null> => {
    if (!deps.facilitator.openWithPrefix) return false;
    let open: FeedPayOp[];
    try {
      open = await deps.facilitator.openWithPrefix(payerKeyPrefix(payer));
    } catch {
      return null;
    }
    let busy = false;
    for (const listed of open) {
      const op = listed.status === 'included' ? listed : ((await follow(listed.key)) ?? listed);
      if (op.errorCode === 'REVERTED') await noteRevert(op, payer);
      else if (op.status !== 'included' && op.status !== 'final' && op.status !== 'failed')
        busy = true;
    }
    return busy;
  };

  const settle: SettleFn = async (payment, verify, context) => {
    const payer = payment.authorization.from;
    // The caller's requirements must be what was signed before any stored answer is returned: a
    // retry with another amount or payee never reuses an earlier success. A payee we never relay
    // to (the payer itself, a reserved one) is refused here too, before anything else (CCA-704).
    let reserved: ReadonlySet<string> | undefined;
    if (deps.reserved) {
      const read = await deps.reserved().catch(() => null);
      if (!read) return refuse('settlement_unavailable', payer);
      reserved = read;
    }
    const unbound = bindingCheck(payment, reserved);
    if (unbound) return refuse(unbound, payer);
    // The runtime switch, per request; unreadable is paused (fails closed).
    const paused = deps.paused ? await deps.paused().catch(() => true) : false;
    const seen = await known(payment, !paused);
    if (seen) return seen;
    if (paused || !deps.enabled()) return refuse('settlement_unavailable', payer);
    if (payment.authorization.value < minValue)
      return refuse('invalid_exact_evm_payload_authorization_value', payer);
    const nowS = BigInt(Math.floor(now() / 1000));
    if (
      payment.authorization.validBefore < nowS + minWindow ||
      payment.authorization.validBefore > nowS + maxWindow
    )
      return refuse('invalid_exact_evm_payload_authorization_valid_before', payer);
    // Bounded work (review finding 10): a capped number in flight per instance, checked before any
    // chain read; then (settleNew) the address and gas-balance reads, and only then /verify, which
    // takes the shared cap on chain simulations after its static checks (CCA-704, as /verify's own
    // admission, CCA-763): junk never uses it up. Refused, never queued.
    if (inFlight >= maxInFlight) return refuse('settlement_unavailable', payer);
    inFlight += 1;
    try {
      return await settleNew(payment, verify, payer, context);
    } finally {
      inFlight -= 1;
    }
  };

  /** The shared simulation cap, as /verify's admission: throws SimulationsSpent when refused. */
  const admit = deps.simulations
    ? async () => {
        if (!(await deps.simulations!().catch(() => false))) throw new SimulationsSpent();
      }
    : undefined;

  const settleNew = async (
    payment: ExactPayment,
    verify: (admit?: () => Promise<void>) => Promise<VerifyAnswer>,
    payer: Hex,
    context: SettleContext | undefined,
  ): Promise<SettleAnswer> => {
    if (deps.advertised) {
      const real = await deps.facilitator.address().catch(() => null);
      if (!real || real.toLowerCase() !== deps.advertised.toLowerCase())
        return refuse('settlement_unavailable', payer);
    }
    if (!(await deps.facilitator.canPay().catch(() => false)))
      return refuse('settlement_unavailable', payer);
    // Fees and lane (CCA-704): nothing new is signed while the fee cap would leave it unmined (it
    // would hold its nonce and every later one), nor while the lane's head has waited unmined past
    // STUCK_LANE_MS. Retryable; unreadable refuses.
    const facilitator = deps.facilitator;
    if (facilitator.feeRoom && !(await facilitator.feeRoom().catch(() => false)))
      return refuse('settlement_unavailable', payer);
    if (facilitator.laneStuck && (await facilitator.laneStuck(STUCK_LANE_MS).catch(() => true)))
      return refuse('settlement_unavailable', payer);
    // Per payer, before /verify and the budget: one in flight, and none while cooling down after a
    // revert. Retryable: the client asks again once its earlier settlement is in a block.
    const busy = await payerBusy(payer);
    if (busy === null) return refuse('settlement_unavailable', payer);
    if (busy) return refuse('payer_settlement_in_flight', payer);
    if (deps.cooldown && (await deps.cooldown.cooling(payer).catch(() => true)))
      return refuse('settlement_unavailable', payer);
    // Exactly /verify (the route's own check), only for a payment never seen before; BEFORE the
    // budget, so invalid requests (made-up payers, bad signatures) never use it up (review finding 21).
    let verified: VerifyAnswer;
    try {
      verified = await verify(admit);
    } catch (error) {
      if (error instanceof SimulationsSpent) return refuse('settlement_unavailable', payer);
      return refuse('unexpected_settle_error', payer);
    }
    if (!verified.isValid) return refuse(verified.invalidReason, payer);
    if (deps.screen && !(await deps.screen(payment).catch(() => false)))
      return refuse('settlement_unavailable', payer);
    const scope: SettleScope = {
      payee: payment.authorization.to,
      ...(context?.client ? { client: context.client } : {}),
    };
    if (deps.budget && !(await deps.budget(payer, scope).catch(() => false)))
      return refuse('settlement_unavailable', payer);

    const key = settleKey(payment);
    const calldata = transferCalldata(payment);
    // Why the check right before the first send refused, for the answer (the row records only
    // REFUSED_BEFORE_BROADCAST).
    let refusedBecause: string | null = null;
    try {
      const op = await deps.facilitator.submitCall({
        key,
        intentHash: keccak256(calldata),
        calldata,
        // The facilitator's atomic guard of the same rule (concurrent instances, races).
        oneInFlight: payerKeyPrefix(payer),
        beforeBroadcast: async () => {
          // /verify again right before the first send: used (front-run) or expired meanwhile.
          const again = await verify();
          if (!again.isValid) {
            refusedBecause = again.invalidReason;
            throw new Error(again.invalidReason);
          }
        },
      });
      if (refusedBecause && op.status === 'failed') return refuse(refusedBecause, payer);
      return answer(op, payer);
    } catch (error) {
      if (refusedBecause) return refuse(refusedBecause, payer);
      if (error instanceof FacilitatorError)
        return refuse(
          error.code === 'IDEMPOTENCY_CONFLICT'
            ? 'invalid_transaction_state'
            : error.code === 'IN_FLIGHT'
              ? 'payer_settlement_in_flight'
              : 'settlement_unavailable',
          payer,
        );
      return refuse('unexpected_settle_error', payer);
    }
  };
  return { settle, known };
}

/** A failed settlement's x402 errorReason (refused before its send, or a revert). */
function failure(op: FeedPayOp): string {
  const code = op.errorCode ?? '';
  if (code === 'REFUSED_BEFORE_BROADCAST') return 'invalid_transaction_state';
  if (code === 'SIMULATION_REVERTED' || code === 'REVERTED') return 'invalid_transaction_state';
  // Our L1 fee cap, not the payer's doing: the payer may sign again later.
  if (code === 'L1_FEE_CAP') return 'settlement_unavailable';
  return 'unexpected_settle_error';
}

/** Stands in while the public sender has no key: never sends (settle answers unavailable first). */
export const unavailablePublicFacilitator: PublicFacilitator = {
  submitCall: async () => {
    throw new FacilitatorError('RPC_UNAVAILABLE', 'The public facilitator is not configured.');
  },
  status: async () => null,
  storedStatus: async () => null,
  storedIntent: async () => null,
  address: async () => '0x0000000000000000000000000000000000000000',
  canPay: async () => false,
};

/**
 * Gas budget caps: new public settlements a day for the public EOA, an hour per payer, and a day
 * per payee and per calling client (CCA-766: many payers paying one payee, or sent by one client,
 * get at most a fifth of the day).
 */
export const PUBLIC_SETTLE_DAILY = 500;
export const PUBLIC_SETTLE_PER_PAYER_HOUR = 20;
export const PUBLIC_SETTLE_PER_PAYEE_DAY = 100;
export const PUBLIC_SETTLE_PER_CLIENT_DAY = 100;
/** At most one ALERT line per instance in this window while the daily cap refuses. */
export const PUBLIC_SETTLE_CAP_ALERT_EVERY_MS = 3_600_000;

/**
 * The budget over the shared limiter (the 'x402-settle' prefix fails closed). Each bucket's hit is
 * one limiter call; the admission across buckets is SEQUENTIAL, not one transaction: PAYER, then
 * CLIENT, then PAYEE, then the day, each only when the ones before it passed. So:
 *  - a payer, client or payee over its cap never uses up a unit of the day, and neither one payer
 *    nor many payers behind one payee or one client can block everyone (review finding 70,
 *    CCA-766);
 *  - a client over its cap is refused before any payee bucket, so it cannot spend a victim
 *    payee's day with requests that never settle (security gate on CCA-766);
 *  - a refusal at a later bucket has already taken units of the earlier ones (the payer's and the
 *    client's own), and a refusal by the day has taken payer, client and payee units while
 *    nothing settles.
 * A refusal by the day itself is logged as ALERT (throttled per instance), so the operator hears
 * at once that the public sender stopped settling.
 */
export function limiterBudget(
  hit: (key: string, limit: number, windowMs: number) => Promise<{ allowed: boolean }>,
  options: { log?: (line: string) => void; now?: () => number } = {},
): (payer: Hex, scope?: SettleScope) => Promise<boolean> {
  const now = options.now ?? Date.now;
  let alertedAt: number | null = null;
  let refusedSince = 0;
  return async (payer, scope) => {
    if (
      !(
        await hit(
          `x402-settle:payer:${payer.toLowerCase()}`,
          PUBLIC_SETTLE_PER_PAYER_HOUR,
          3_600_000,
        )
      ).allowed
    )
      return false;
    if (
      scope?.client &&
      !(await hit(`x402-settle:client:${scope.client}`, PUBLIC_SETTLE_PER_CLIENT_DAY, 86_400_000))
        .allowed
    )
      return false;
    if (
      scope?.payee &&
      !(
        await hit(
          `x402-settle:payee:${scope.payee.toLowerCase()}`,
          PUBLIC_SETTLE_PER_PAYEE_DAY,
          86_400_000,
        )
      ).allowed
    )
      return false;
    if ((await hit('x402-settle:day', PUBLIC_SETTLE_DAILY, 86_400_000)).allowed) return true;
    refusedSince += 1;
    const at = now();
    if (alertedAt === null || at - alertedAt >= PUBLIC_SETTLE_CAP_ALERT_EVERY_MS) {
      alertedAt = at;
      // No payer, payee or client in the line: the cap is the event, not who hit it.
      (options.log ?? console.error)(
        JSON.stringify({
          event: 'x402.settle.daily_cap',
          level: 'ALERT',
          limit: PUBLIC_SETTLE_DAILY,
          refused: refusedSince,
        }),
      );
      refusedSince = 0;
    }
    return false;
  };
}

/**
 * The payees the public facilitator never relays to (CCA-704): every payee no payment may name
 * (protocolReservedPayees: the zero address, USDC, fee routers 1-3, the treasury, router 3's
 * facilitator and the public sender), our own paymaster contract (CITY_BASE_PAYMASTER_ADDRESS),
 * and `keyAddresses`, the addresses of Central City's configured server keys (the chain runtime's
 * protocolKeyAddresses: both facilitators, the sponsor, the paymaster signer and submitters).
 * Lowercase.
 */
export function publicSettleReservedPayees(
  env: Record<string, string | undefined>,
  keyAddresses: Iterable<string>,
): ReadonlySet<string> {
  const all = new Set(protocolReservedPayees(env));
  const paymaster = ownPaymasterAddress(env);
  if (paymaster) all.add(paymaster.toLowerCase());
  for (const a of keyAddresses) all.add(a.toLowerCase());
  return all;
}

/**
 * The most Base L1 data fee the public sender reserves for one transaction (CCA-704): 0.00001 ETH.
 * A settlement's calldata is under 2.5 KB (MAX_SIGNATURE_BYTES), whose L1 fee on Base is normally
 * far below that even doubled by the oracle margin; above the cap it is not signed (ended never
 * sent, answered settlement_unavailable).
 */
export const PUBLIC_SETTLE_MAX_L1_FEE_WEI = 10_000_000_000_000n;

/**
 * One sender per instance (its in-flight cap is per instance): concurrent first callers share ONE
 * build, and the result is kept only once it can send (a sender built before the key was
 * reachable is rebuilt by the next caller).
 */
export function onceReady<T>(build: () => Promise<{ value: T; ready: boolean }>): () => Promise<T> {
  let kept: T | null = null;
  let pending: Promise<{ value: T; ready: boolean }> | null = null;
  return async () => {
    if (kept) return kept;
    pending ??= build().finally(() => {
      pending = null;
    });
    const { value, ready } = await pending;
    if (ready && !kept) kept = value;
    return kept ?? value;
  };
}

/**
 * The public settle's runtime switch (CCA-704): a row of feed_flags, the existing table of
 * database switches that need no redeploy (the Feed's 'posting' and 'sweep' rows), so no
 * migration. Operators pause settlement with the row (name 'x402-settle', enabled false) and
 * resume with enabled true or by deleting it; CITY_X402_PUBLIC_SETTLE still decides at startup
 * whether it can be on at all.
 */
export const PUBLIC_SETTLE_FLAG = 'x402-settle';

/**
 * Reads the switch on every call, never cached: no row is on, enabled false is paused, and a
 * failed read is paused too (fail closed). Another lane may read a row of its own the same way.
 */
export function publicSettlePaused(
  db: {
    query<T = unknown>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  },
  flag: string = PUBLIC_SETTLE_FLAG,
): () => Promise<boolean> {
  return async () => {
    try {
      const row = (
        await db.query<{ enabled: boolean }>('SELECT enabled FROM feed_flags WHERE name = $1', [
          flag,
        ])
      ).rows[0];
      return row !== undefined && row.enabled !== true;
    } catch {
      return true;
    }
  };
}

/** How long a payer whose settlement reverted on Base gets no new one. */
export const REVERT_COOLDOWN_MS = 3_600_000;

/**
 * The revert cool-down (CCA-704, server/protocol/x402/payer-cooldown.ts): a payer is refused for an
 * hour after a settlement of theirs is seen reverted. An unreadable table reads as cooling.
 */
export function publicSettleCooldown(
  db: Parameters<typeof payerCooldown>[0],
  now: () => number,
  log?: (line: string) => void,
): NonNullable<PublicSettleDeps['cooldown']> {
  return payerCooldown(db, {
    lane: 'x402-settle',
    ms: REVERT_COOLDOWN_MS,
    now,
    ...(log ? { log } : {}),
  });
}

/** The shared simulation cap over the limiter ('x402-settle' fails closed in an outage). */
export function limiterSimulations(
  hit: (key: string, limit: number, windowMs: number) => Promise<{ allowed: boolean }>,
): () => Promise<boolean> {
  return async () => (await hit('x402-settle:simulations', SIMULATIONS_PER_MINUTE, 60_000)).allowed;
}
