import {
  encodeAbiParameters,
  encodeEventTopics,
  getAddress,
  parseAbi,
  recoverTypedDataAddress,
  type Hex,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import type { FeedPayOp } from '../../server/base/chain/feed-pay-chain.js';
import {
  BroadcastDeferred,
  decodeSettle,
  FacilitatorError,
} from '../../server/protocol/x402/facilitator.js';
import {
  LEG_FEE,
  LEG_SELLER,
  router3Nonce,
  router3SettleData,
} from '../../server/feed/pay/router3.js';
import type {
  PublicFeeLog,
  PublicLegsState,
  PublicOfferLane,
  PublicPayment,
} from '../../server/feed/offers/public-pay.js';

/*
 * A double of the public offers' lane: nothing reaches a network and no real key is used. `simulate`
 * does what router 3 would check of a settlement: both EIP-3009 signatures recovered against the
 * nonces it derives, one-time nonces and (payer, ref). Only `submit` records a send; the test decides
 * what Base then says. `signedPayment` is the outside buyer: fresh keys, both legs really signed.
 */

const FEE_CHARGED = parseAbi([
  'event FeeCharged(address indexed payer, address indexed payee, bytes32 indexed ref, uint8 kind, uint256 gross, uint256 fee)',
]);

const TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const;

export interface LaneConfig {
  chainId: number;
  router: Hex;
  treasury: Hex;
  usdc: Hex;
}

const domain = (config: LaneConfig) => ({
  name: 'USD Coin',
  version: '2',
  chainId: config.chainId,
  verifyingContract: config.usdc,
});

export function fakePublicLane(config: LaneConfig) {
  const state = {
    canPay: true,
    eth: 100_000_000_000_000_000n,
    lag: 600,
    simulateDown: false,
    /** The next this many simulations right before the first send answer "Base did not answer". */
    hookSimulateDown: 0,
    /** Simulations right before the first send answer that the settlement would revert. */
    hookSimulateRefused: false,
    /** Addresses with code on Base: their signatures are not recovered, router 3 asks them. */
    code: new Set<string>(),
    /** USDC by lowercase address; absent: more than any price here. */
    usdc: new Map<string, bigint>(),
    /** Reading a balance throws (Base did not answer). */
    usdcDown: false,
    /** A contract payer's isValidSignature says yes to whatever it is given. */
    contractAccepts: false,
    /** The send would stay within the gas and L1 fee caps. */
    withinCaps: true,
    /** What a search of Base finds for this payer, payee and ref; null: unreadable. */
    feeLogs: [] as PublicFeeLog[] | null,
    /** Every submit throws before anything is stored, until cleared (the request's crash). */
    submitThrows: null as string | null,
    /** The next submit stores and sends the settlement, then throws (a crash after the hand-over). */
    throwAfterStore: false,
    legs: 'wait' as PublicLegsState,
    /** Status the next follow reads for a key; absent: 'submitted'. */
    status: new Map<string, FeedPayOp>(),
    /** `waiting`: stored, its first send put off (BroadcastDeferred), still queued and unsigned. */
    submitted: new Map<
      string,
      { calldata: Hex; intentHash: Hex; count: number; ran: boolean; waiting: boolean }
    >(),
    fenced: new Set<string>(),
    simulations: 0,
    /** Receipt logs by transaction. */
    logs: new Map<string, { address: Hex; topics: readonly Hex[]; data: Hex }[]>(),
  };
  const usedNonces = new Set<string>();

  let hookDown = 0;
  let inHook = false;
  const legOk = async (s: ReturnType<typeof decodeSettle>, leg: 0 | 1) => {
    const fee = s.gross / 10n;
    const nonce = router3Nonce({
      chainId: config.chainId,
      router: config.router,
      treasury: config.treasury,
      payer: s.payer,
      payee: s.payee,
      gross: s.gross,
      ref: s.ref,
      validAfter: s.validAfter,
      validBefore: s.validBefore,
      leg,
    });
    if (usedNonces.has(nonce)) return false;
    const recovered = await recoverTypedDataAddress({
      domain: domain(config),
      types: TYPES,
      primaryType: 'TransferWithAuthorization',
      message: {
        from: s.payer,
        to: leg === LEG_SELLER ? s.payee : config.treasury,
        value: leg === LEG_SELLER ? s.gross - fee : fee,
        validAfter: s.validAfter,
        validBefore: s.validBefore,
        nonce,
      },
      signature: leg === LEG_SELLER ? s.sellerSignature : s.feeSignature,
    }).catch(() => null);
    return !!recovered && getAddress(recovered) === getAddress(s.payer);
  };

  const simulate: PublicOfferLane['simulate'] = async (data) => {
    state.simulations += 1;
    if (state.simulateDown) return { ok: false, retryable: true };
    if (inHook && state.hookSimulateRefused) return { ok: false, retryable: false };
    if (hookDown > 0) {
      hookDown -= 1;
      return { ok: false, retryable: true };
    }
    const s = decodeSettle(data);
    const ok =
      (state.contractAccepts && state.code.has(s.payer.toLowerCase())) ||
      ((await legOk(s, LEG_SELLER)) && (await legOk(s, LEG_FEE)));
    return ok ? { ok: true, gas: 200_000n } : { ok: false, retryable: false };
  };

  const lane: PublicOfferLane = {
    address: async () => getAddress(`0x${'6f'.repeat(20)}`) as Hex,
    canPay: async () => state.canPay,
    ethBalance: async () => state.eth,
    finalityLagSeconds: async () => state.lag,
    simulate,
    withinCaps: async () => state.withinCaps,
    hasCode: async (address) => state.code.has(address.toLowerCase()),
    usdcBalance: async (address) => {
      if (state.usdcDown) throw new Error('base down');
      return state.usdc.get(address.toLowerCase()) ?? 10n ** 12n;
    },
    submit: async (input) => {
      if (state.submitThrows) throw new Error(state.submitThrows);
      const data = router3SettleData(input.settlement);
      const known = state.submitted.get(input.key);
      if (known) known.count += 1;
      if (known && !known.waiting) return state.status.get(input.key) ?? op(input.key, 'submitted');
      if (state.fenced.has(input.key)) throw new Error('fenced');
      const stored = known ?? {
        calldata: data,
        intentHash: input.intentHash,
        count: 1,
        ran: false,
        waiting: false,
      };
      state.submitted.set(input.key, stored);
      try {
        hookDown = state.hookSimulateDown;
        inHook = true;
        await input.beforeBroadcast().finally(() => {
          hookDown = 0;
          inHook = false;
        });
        stored.waiting = false;
        stored.ran = true;
        if (state.throwAfterStore) {
          state.throwAfterStore = false;
          throw new Error('crash after the hand-over');
        }
      } catch (error) {
        if (error instanceof Error && error.message === 'crash after the hand-over') throw error;
        if (error instanceof BroadcastDeferred) {
          stored.waiting = true;
          throw new FacilitatorError('DEFERRED', 'The first send was put off.');
        }
        stored.waiting = false;
        const failed: FeedPayOp = {
          ...op(input.key, 'failed'),
          neverSent: true,
          errorCode: 'REFUSED_BEFORE_BROADCAST',
        };
        state.status.set(input.key, failed);
        return failed;
      }
      return state.status.get(input.key) ?? op(input.key, 'submitted');
    },
    status: async (key) =>
      state.status.get(key) ??
      (state.submitted.get(key)?.waiting
        ? op(key, 'queued')
        : state.submitted.has(key)
          ? op(key, 'submitted')
          : null),
    endUnsent: async (key) => {
      const stored = state.submitted.get(key);
      if (stored?.ran) return false;
      if (stored?.waiting) {
        stored.waiting = false;
        state.status.set(key, {
          ...op(key, 'failed'),
          neverSent: true,
          errorCode: 'ABANDONED_BEFORE_BROADCAST',
        });
      }
      state.fenced.add(key);
      return true;
    },
    legsState: async () => state.legs,
    receiptLogs: async (hash) => state.logs.get(hash) ?? null,
    feeLogs: async () => state.feeLogs,
  };

  /** The FeeCharged of the settlement stored under `key`, as router 3 would log it. */
  const feeLog = (key: string, grossOverride?: bigint) => {
    const stored = state.submitted.get(key);
    if (!stored) throw new Error('not submitted');
    const s = decodeSettle(stored.calldata);
    const gross = grossOverride ?? s.gross;
    return {
      address: config.router,
      topics: encodeEventTopics({
        abi: FEE_CHARGED,
        eventName: 'FeeCharged',
        args: { payer: s.payer, payee: s.payee, ref: s.ref },
      }) as Hex[],
      data: encodeAbiParameters(
        [{ type: 'uint8' }, { type: 'uint256' }, { type: 'uint256' }],
        [1, gross, gross / 10n],
      ),
    };
  };

  /** Base includes the settlement of `key`: one FeeCharged, or `events` as given. */
  const include = (key: string, txHash: Hex, block = 777n, events?: 0 | 1 | 2) => {
    const stored = state.submitted.get(key);
    if (!stored) throw new Error('not submitted');
    const s = decodeSettle(stored.calldata);
    usedNonces.add(
      router3Nonce({
        chainId: config.chainId,
        router: config.router,
        treasury: config.treasury,
        payer: s.payer,
        payee: s.payee,
        gross: s.gross,
        ref: s.ref,
        validAfter: s.validAfter,
        validBefore: s.validBefore,
        leg: LEG_SELLER,
      }),
    );
    const log = feeLog(key);
    state.logs.set(
      txHash,
      Array.from({ length: events ?? 1 }, () => log),
    );
    state.status.set(key, { ...op(key, 'included'), txHash, blockNumber: block });
  };

  return { lane, state, include, feeLog };
}

const op = (key: string, status: FeedPayOp['status']): FeedPayOp => ({
  key,
  status,
  txHash: null,
  blockNumber: null,
  neverSent: false,
  errorCode: null,
});

export const newBuyer = () => privateKeyToAccount(generatePrivateKey());

/** The buyer: signs both legs of an `accepts` entry, nonces as the router derives them. */
export async function signedPayment(
  buyer: PrivateKeyAccount,
  config: LaneConfig,
  accepted: PublicPayment['accepted'],
  options: { swapLegs?: boolean } = {},
): Promise<PublicPayment> {
  const e = accepted.extra;
  const payee = getAddress(accepted.payTo) as Hex;
  const gross = BigInt(accepted.amount);
  const leg = async (which: 0 | 1, to: Hex, value: bigint) => {
    const nonce = router3Nonce({
      chainId: config.chainId,
      router: config.router,
      treasury: config.treasury,
      payer: buyer.address,
      payee,
      gross,
      ref: e.ref as Hex,
      validAfter: BigInt(e.validAfter),
      validBefore: BigInt(e.validBefore),
      leg: which,
    });
    const signature = await buyer.signTypedData({
      domain: domain(config),
      types: TYPES,
      primaryType: 'TransferWithAuthorization',
      message: {
        from: buyer.address,
        to,
        value,
        validAfter: BigInt(e.validAfter),
        validBefore: BigInt(e.validBefore),
        nonce,
      },
    });
    return {
      from: buyer.address as string,
      to: to as string,
      value: value.toString(),
      validAfter: e.validAfter,
      validBefore: e.validBefore,
      nonce: nonce as string,
      signature: signature as string,
    };
  };
  const seller = await leg(LEG_SELLER, payee, BigInt(e.sellerAmount));
  const fee = await leg(LEG_FEE, config.treasury, BigInt(e.feeAmount));
  return {
    x402Version: 2,
    accepted,
    payload: options.swapLegs
      ? {
          payer: buyer.address,
          seller: { ...seller, signature: fee.signature },
          fee: { ...fee, signature: seller.signature },
        }
      : { payer: buyer.address, seller, fee },
  };
}

export const paymentHeader = (payment: unknown) =>
  Buffer.from(JSON.stringify(payment)).toString('base64');
