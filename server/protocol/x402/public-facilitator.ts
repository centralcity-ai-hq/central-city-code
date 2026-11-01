/*
 * Central City's PUBLIC x402 facilitator (x402 v2, scheme "exact", Base mainnet USDC through
 * EIP-3009), so any x402 resource server can use it and trackers (x402scan) can list it:
 *
 *   GET  /x402/facilitator/supported  what it accepts and its signer: static, no chain read
 *   POST /x402/facilitator/verify     would this payment settle? Nothing is signed or sent: USDC's
 *                                     own transferWithAuthorization is simulated (eth_call), so
 *                                     USDC itself judges the signature (EOA or ERC-1271 smart
 *                                     account), the time window, whether the nonce was used and
 *                                     the payer's balance
 *   POST /x402/facilitator/settle     sends the transfer (Central City's facilitator EOA pays the
 *                                     gas). Off until its sender and policy are reviewed
 *                                     (CITY_X402_PUBLIC_SETTLE): until then it answers a refusal
 *                                     that says so, never a fake success
 *
 * The facilitator only relays what the payer signed: money moves only by the payer's EIP-3009
 * signature, to exactly the payee and amount the signature names.
 */
import type { FastifyInstance } from 'fastify';
import {
  BaseError,
  encodeFunctionData,
  getAddress,
  isAddress,
  parseAbi,
  type Address,
  type Hex,
} from 'viem';
import { BASE_NETWORKS, allowedToken } from '../../../shared/base/chains.js';
import { clientAddressKey } from '../../rate-limit.js';

export const PUBLIC_FACILITATOR_PATH = '/x402/facilitator';
export const X402_VERSION = 2;
export const FACILITATOR_CHAIN_ID = 8453;
export const FACILITATOR_NETWORK = `eip155:${FACILITATOR_CHAIN_ID}`;
/**
 * The account /verify simulates from when no public sender is configured: fee router 3's
 * facilitator (docs/FEED_PAY.md). USDC's transferWithAuthorization accepts any caller, so the
 * simulation's answer does not depend on it. It is never advertised as a public signer.
 */
export const SIMULATION_ACCOUNT: Address = '0xc8d6Bac2ff7182d22c4f316BffF9f713261A6cEC';
/** How long a verification may wait for Base. */
const VERIFY_TIMEOUT_MS = 8_000;
/** Requests per IP per minute: /verify reads Base once, /supported reads nothing. */
export const FACILITATOR_RATE = { supported: 120, verify: 60, settle: 30 } as const;
/** Chain simulations for /verify per minute, every client and instance together. */
export const VERIFY_SIMULATIONS_PER_MINUTE = 600;
/** A payment must stay valid at least this long after verification, so it can still settle. */
export const MIN_VALIDITY_LEFT_S = 6;
/**
 * The longest signature taken, in bytes (CCA-704: unbounded, a request could make us send about
 * 12 KB of calldata and pay its L1 data fee). An EOA signs 65 bytes; a Coinbase Smart Wallet's
 * ERC-1271 signature with a passkey owner (WebAuthn) is about 0.6-1 KB, and the ERC-6492 wrapper a
 * counterfactual one carries (factory, its createAccount call, magic suffix) brings it to about
 * 1.5 KB. 2 KB admits all of them with room for a long clientDataJSON.
 */
export const MAX_SIGNATURE_BYTES = 2_048;

const usdc = BASE_NETWORKS[FACILITATOR_CHAIN_ID].tokens.USDC;

const transferWithAuthorization = parseAbi([
  'function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, bytes signature)',
]);

/** The x402 v2 invalid/error reasons this facilitator answers (the spec's own codes). */
export type InvalidReason =
  | 'invalid_x402_version'
  | 'invalid_payload'
  | 'invalid_payment_requirements'
  | 'unsupported_scheme'
  | 'invalid_network'
  | 'invalid_exact_evm_payload_recipient_mismatch'
  | 'invalid_exact_evm_payload_authorization_value'
  | 'invalid_exact_evm_payload_authorization_valid_after'
  | 'invalid_exact_evm_payload_authorization_valid_before'
  | 'invalid_exact_evm_payload_signature'
  | 'invalid_transaction_state'
  | 'insufficient_funds'
  | 'unexpected_verify_error';

export interface ExactPayment {
  requirements: {
    scheme: 'exact';
    network: string;
    amount: bigint;
    asset: Address;
    payTo: Address;
    maxTimeoutSeconds: number;
  };
  authorization: {
    from: Address;
    to: Address;
    value: bigint;
    validAfter: bigint;
    validBefore: bigint;
    nonce: Hex;
  };
  signature: Hex;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const UINT = /^(0|[1-9][0-9]{0,77})$/;
const uint = (v: unknown): bigint | null =>
  typeof v === 'string' && UINT.test(v) && BigInt(v) < 2n ** 256n
    ? BigInt(v)
    : typeof v === 'number' && Number.isSafeInteger(v) && v >= 0
      ? BigInt(v)
      : null;
const address = (v: unknown): Address | null =>
  typeof v === 'string' && isAddress(v, { strict: false }) ? getAddress(v) : null;

/**
 * The request body of /verify and /settle, strictly: x402 v2, the exact scheme on Base USDC.
 * Anything else is refused with the spec's reason, before any chain read.
 */
export function parseExactPayment(
  body: unknown,
): { ok: true; payment: ExactPayment } | { ok: false; reason: InvalidReason } {
  if (!isObject(body)) return { ok: false, reason: 'invalid_payload' };
  if (body.x402Version !== X402_VERSION) return { ok: false, reason: 'invalid_x402_version' };
  const req = body.paymentRequirements;
  const payload = body.paymentPayload;
  if (!isObject(req)) return { ok: false, reason: 'invalid_payment_requirements' };
  if (!isObject(payload) || !isObject(payload.payload))
    return { ok: false, reason: 'invalid_payload' };
  if (payload.x402Version !== undefined && payload.x402Version !== X402_VERSION)
    return { ok: false, reason: 'invalid_x402_version' };
  if (req.scheme !== 'exact') return { ok: false, reason: 'unsupported_scheme' };
  if (req.network !== FACILITATOR_NETWORK) return { ok: false, reason: 'invalid_network' };
  const amount = uint(req.amount);
  const asset = address(req.asset);
  const payTo = address(req.payTo);
  const maxTimeoutSeconds = req.maxTimeoutSeconds;
  if (
    amount === null ||
    amount === 0n ||
    !asset ||
    !payTo ||
    typeof maxTimeoutSeconds !== 'number' ||
    !Number.isSafeInteger(maxTimeoutSeconds) ||
    maxTimeoutSeconds <= 0
  )
    return { ok: false, reason: 'invalid_payment_requirements' };
  // Only USDC on Base, through EIP-3009 (no Permit2), with USDC's own EIP-712 domain.
  const token = allowedToken(BASE_NETWORKS[FACILITATOR_CHAIN_ID], asset);
  const extra = isObject(req.extra) ? req.extra : {};
  if (
    !token?.eip712 ||
    token.address.toLowerCase() !== usdc.address.toLowerCase() ||
    (extra.assetTransferMethod !== undefined && extra.assetTransferMethod !== 'eip3009') ||
    (extra.name !== undefined && extra.name !== token.eip712.name) ||
    (extra.version !== undefined && extra.version !== token.eip712.version)
  )
    return { ok: false, reason: 'invalid_payment_requirements' };

  const signature = payload.payload.signature;
  const auth = payload.payload.authorization;
  if (typeof signature === 'string' && signature.length > 2 + 2 * MAX_SIGNATURE_BYTES)
    return { ok: false, reason: 'invalid_exact_evm_payload_signature' };
  if (typeof signature !== 'string' || !/^0x([0-9a-fA-F]{2})+$/.test(signature) || !isObject(auth))
    return { ok: false, reason: 'invalid_payload' };
  const from = address(auth.from);
  const to = address(auth.to);
  const value = uint(auth.value);
  const validAfter = uint(auth.validAfter);
  const validBefore = uint(auth.validBefore);
  const nonce = auth.nonce;
  if (
    !from ||
    !to ||
    value === null ||
    validAfter === null ||
    validBefore === null ||
    typeof nonce !== 'string' ||
    !/^0x[0-9a-fA-F]{64}$/.test(nonce)
  )
    return { ok: false, reason: 'invalid_payload' };
  return {
    ok: true,
    payment: {
      requirements: {
        scheme: 'exact',
        network: FACILITATOR_NETWORK,
        amount,
        asset,
        payTo,
        maxTimeoutSeconds,
      },
      authorization: { from, to, value, validAfter, validBefore, nonce: nonce as Hex },
      signature: signature as Hex,
    },
  };
}

/**
 * The requirements describe exactly what was signed: the payee and the exact amount. Time-free, so
 * it also binds a retry of an earlier settlement (network and asset are fixed by the parser).
 *
 * And the payee is one this facilitator relays to: never the payer itself (CCA-704: a payment to
 * yourself moves nothing, so self-paying payers could spend the shared settlement budget for free),
 * and never a `reserved` payee (lowercase): Central City's treasury, fee routers, USDC itself and
 * its own senders and signers (publicSettleReservedPayees), none of which is ever a seller.
 */
export function bindingCheck(
  payment: ExactPayment,
  reserved?: ReadonlySet<string>,
): InvalidReason | null {
  const { requirements: r, authorization: a } = payment;
  if (a.to !== r.payTo) return 'invalid_exact_evm_payload_recipient_mismatch';
  if (a.value !== r.amount) return 'invalid_exact_evm_payload_authorization_value';
  if (a.to === a.from) return 'invalid_payment_requirements';
  if (reserved?.has(a.to.toLowerCase())) return 'invalid_payment_requirements';
  return null;
}

/** The checks that need no chain: payee, exact amount, and a validity window that can still settle. */
export function staticCheck(
  payment: ExactPayment,
  nowSeconds: number,
  reserved?: ReadonlySet<string>,
): InvalidReason | null {
  const unbound = bindingCheck(payment, reserved);
  if (unbound) return unbound;
  const a = payment.authorization;
  if (a.validAfter > BigInt(nowSeconds))
    return 'invalid_exact_evm_payload_authorization_valid_after';
  if (a.validBefore < BigInt(nowSeconds + MIN_VALIDITY_LEFT_S))
    return 'invalid_exact_evm_payload_authorization_valid_before';
  return null;
}

/** The call USDC would run: the exact transfer the payer signed, nothing else. */
export function transferCalldata(payment: ExactPayment): Hex {
  const a = payment.authorization;
  return encodeFunctionData({
    abi: transferWithAuthorization,
    functionName: 'transferWithAuthorization',
    args: [a.from, a.to, a.value, a.validAfter, a.validBefore, a.nonce, payment.signature],
  });
}

/**
 * USDC's revert, as the spec's reason. FiatToken v2.2 messages: "FiatTokenV2: invalid signature",
 * "FiatTokenV2: authorization is used or canceled", "FiatTokenV2: authorization is not yet
 * valid", "FiatTokenV2: authorization is expired", "ERC20: transfer amount exceeds balance",
 * "Blacklistable: account is blacklisted". Anything unrecognised is not called invalid.
 */
export function revertReason(message: string): InvalidReason {
  const m = message.toLowerCase();
  if (m.includes('invalid signature') || m.includes('invalid_signature'))
    return 'invalid_exact_evm_payload_signature';
  if (m.includes('used or canceled')) return 'invalid_transaction_state';
  if (m.includes('not yet valid')) return 'invalid_exact_evm_payload_authorization_valid_after';
  if (m.includes('authorization is expired'))
    return 'invalid_exact_evm_payload_authorization_valid_before';
  if (m.includes('exceeds balance')) return 'insufficient_funds';
  if (m.includes('blacklisted')) return 'invalid_transaction_state';
  return 'unexpected_verify_error';
}

export interface FacilitatorReader {
  call(args: { account: Address; to: Address; data: Hex; blockNumber?: bigint }): Promise<unknown>;
  /**
   * The head the simulation is pinned to (the chain runtime shares it for a moment): a read at a
   * block number may be answered by the second, keyless endpoint when the configured one cannot.
   */
  getBlockNumber?(): Promise<bigint>;
}

export type VerifyAnswer =
  | { isValid: true; payer: Address }
  | { isValid: false; invalidReason: InvalidReason; payer?: Address };

/** /verify: the static checks, then USDC's own simulation of exactly the signed transfer. */
export async function verifyExactPayment(
  body: unknown,
  deps: {
    reader: FacilitatorReader | null;
    nowSeconds: number;
    account?: Address;
    /**
     * Admission to the chain simulation, only for a payment that passed every static check: it
     * throws (a 429 from the shared limiter, or the sender's own cap) to refuse. Absent: no budget.
     */
    admit?: () => Promise<void>;
    /**
     * Simulate at the reader's head block (when it can name one) instead of 'latest', so the
     * second, keyless endpoint may answer when the configured one is busy. Only /verify: the
     * settle path checks right before its send and stays on the configured node's latest state.
     * A head that cannot be read leaves the simulation unpinned, as without this option.
     */
    pinToHead?: boolean;
    /** The payees never relayed to (bindingCheck), lowercase. */
    reserved?: ReadonlySet<string>;
  },
): Promise<VerifyAnswer> {
  const parsed = parseExactPayment(body);
  if (!parsed.ok) return { isValid: false, invalidReason: parsed.reason };
  const payer = parsed.payment.authorization.from;
  const reason = staticCheck(parsed.payment, deps.nowSeconds, deps.reserved);
  if (reason) return { isValid: false, invalidReason: reason, payer };
  if (!deps.reader) return { isValid: false, invalidReason: 'unexpected_verify_error', payer };
  await deps.admit?.();
  try {
    const reader = deps.reader;
    await withTimeout(
      (async () => {
        const blockNumber =
          deps.pinToHead && reader.getBlockNumber
            ? await reader.getBlockNumber().catch(() => undefined)
            : undefined;
        return reader.call({
          account: deps.account ?? SIMULATION_ACCOUNT,
          to: usdc.address,
          data: transferCalldata(parsed.payment),
          ...(blockNumber !== undefined ? { blockNumber } : {}),
        });
      })(),
      VERIFY_TIMEOUT_MS,
    );
    return { isValid: true, payer };
  } catch (error) {
    const message =
      error instanceof BaseError
        ? `${error.shortMessage} ${error.details ?? ''} ${error.message}`
        : error instanceof Error
          ? error.message
          : '';
    return { isValid: false, invalidReason: revertReason(message), payer };
  }
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('timeout')), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * GET /supported: static. The signers are the addresses that actually send our settlements, so
 * only the public sender's, and only while /settle is on; with settlement off the list is empty
 * (verification works, settlement readiness is never advertised).
 */
export function supportedAnswer(signers: readonly Address[]) {
  return {
    kinds: [{ x402Version: X402_VERSION, scheme: 'exact', network: FACILITATOR_NETWORK }],
    extensions: [],
    signers: { 'eip155:*': [...signers] },
  };
}

/**
 * The x402 v2 SettleResponse. `settlement_pending` with a transaction: our transaction is included
 * but not final yet; the payer's money may still move, so it is never reported as refused.
 */
export type SettleAnswer = {
  success: boolean;
  transaction: string;
  network: string;
  payer?: Address;
  errorReason?: string;
};

/**
 * The public sender (#652: its own EOA, the facilitator's durable path, its own policy and
 * budget). Absent, /settle stays off and no signer is advertised.
 *
 * settle() gets the parsed payment and `verify`, the exact /verify check for this request. The
 * sender looks up a settlement it already stored for this payment FIRST (bound to the whole
 * signed intent, not just payer and nonce), and only for a new one runs `verify` before storing
 * and again right before the first send. A retry after a successful settlement then gets that
 * settlement back, never "nonce already used"; verify and settle never disagree on a new payment.
 */
export interface PublicSettle {
  /** The EOA that sends public settlements (advertised in /supported). */
  address: Address;
  /**
   * `verify` takes the sender's admission to the chain simulation (its shared cap), run only once
   * the payment passed every static check, exactly as /verify's own (CCA-704).
   */
  settle(
    payment: ExactPayment,
    verify: (admit?: () => Promise<void>) => Promise<VerifyAnswer>,
    context?: SettleContext,
  ): Promise<SettleAnswer>;
}

/** What the route knows of the request beyond its body: the calling client, for its budget. */
export interface SettleContext {
  /** clientAddressKey of the caller's IP (the per-client gas budget, CCA-766). */
  client?: string;
}

export function registerPublicFacilitatorRoutes(
  app: FastifyInstance,
  deps: {
    /** Base mainnet's read client, or null when Base is not configured (verify answers an error). */
    reader: () => Promise<FacilitatorReader | null>;
    limit: (key: string, max: number, windowMs: number) => Promise<void>;
    now?: () => number;
    /** The public sender; absent (or switched off by its own flag) /settle answers 503. */
    settle?: PublicSettle | null;
    /**
     * The payees never relayed to (bindingCheck), read per request (CCA-704). A failed read fails
     * closed: /verify answers unexpected_verify_error. Absent: none, only for tests.
     */
    reserved?: () => Promise<ReadonlySet<string>>;
  },
) {
  const now = deps.now ?? Date.now;
  const json = { 'content-type': 'application/json; charset=utf-8' };
  /** The reserved payees, or null when they cannot be read now (callers fail closed). */
  const reservedNow = async (): Promise<ReadonlySet<string> | null | undefined> =>
    deps.reserved ? deps.reserved().catch(() => null) : undefined;

  app.get(`${PUBLIC_FACILITATOR_PATH}/supported`, async (request, reply) => {
    await deps.limit(
      `ip:x402-supported:${clientAddressKey(request.ip)}`,
      FACILITATOR_RATE.supported,
      60_000,
    );
    return reply
      .headers(json)
      .header('Cache-Control', 'public, max-age=300')
      .header('Access-Control-Allow-Origin', '*')
      .send(supportedAnswer(deps.settle ? [deps.settle.address] : []));
  });

  app.post(`${PUBLIC_FACILITATOR_PATH}/verify`, async (request, reply) => {
    await deps.limit(
      `ip:x402-verify:${clientAddressKey(request.ip)}`,
      FACILITATOR_RATE.verify,
      60_000,
    );
    const reserved = await reservedNow();
    const answer: VerifyAnswer =
      reserved === null
        ? { isValid: false, invalidReason: 'unexpected_verify_error' }
        : await verifyExactPayment(request.body, {
            reader: await deps.reader().catch(() => null),
            nowSeconds: Math.floor(now() / 1000),
            account: deps.settle?.address,
            // One budget for every client and instance together; it fails closed in a limiter outage.
            admit: () =>
              deps.limit('x402-verify:simulations', VERIFY_SIMULATIONS_PER_MINUTE, 60_000),
            pinToHead: true,
            ...(reserved ? { reserved } : {}),
          });
    return reply.headers(json).header('Cache-Control', 'no-store').send(answer);
  });

  app.post(`${PUBLIC_FACILITATOR_PATH}/settle`, async (request, reply) => {
    await deps.limit(
      `ip:x402-settle:${clientAddressKey(request.ip)}`,
      FACILITATOR_RATE.settle,
      60_000,
    );
    const parsed = parseExactPayment(request.body);
    const send = (code: number, answer: SettleAnswer) =>
      reply.code(code).headers(json).header('Cache-Control', 'no-store').send(answer);
    // Not live: a refusal that says so, never a pretend success (the payer's money stays put).
    if (!deps.settle)
      return send(503, {
        success: false,
        errorReason: 'settlement_unavailable',
        transaction: '',
        network: FACILITATOR_NETWORK,
        ...(parsed.ok ? { payer: parsed.payment.authorization.from } : {}),
      });
    // A malformed request never reaches the sender.
    if (!parsed.ok)
      return send(200, {
        success: false,
        errorReason: parsed.reason,
        transaction: '',
        network: FACILITATOR_NETWORK,
      });
    const settle = deps.settle;
    // The sender decides when to verify (after its lookup of a stored settlement, see
    // PublicSettle); the check itself is exactly /verify's.
    const verify = async (admit?: () => Promise<void>): Promise<VerifyAnswer> => {
      const reserved = await reservedNow();
      if (reserved === null)
        return {
          isValid: false,
          invalidReason: 'unexpected_verify_error',
          payer: parsed.payment.authorization.from,
        };
      return verifyExactPayment(request.body, {
        reader: await deps.reader().catch(() => null),
        nowSeconds: Math.floor(now() / 1000),
        account: settle.address,
        ...(admit ? { admit } : {}),
        ...(reserved ? { reserved } : {}),
      });
    };
    return send(
      200,
      await settle.settle(parsed.payment, verify, { client: clientAddressKey(request.ip) }),
    );
  });
}
