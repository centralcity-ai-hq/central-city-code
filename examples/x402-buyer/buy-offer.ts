/*
 * A buyer for a Central City offer's public address (POST /api/public/x402/off_<id>) from outside
 * Central City. One file, one dependency (viem); copy it into your project.
 *
 * Stock x402 `exact` clients can't pay this route: its scheme, cc-router3-split-v1, takes two USDC
 * transferWithAuthorization legs (90% to the seller, 10% to the treasury) with nonces derived the
 * way fee router 3 derives them. This module asks for the price, checks every term against values
 * pinned here and against your maximum, signs both legs and follows the call to its result.
 *
 * Nothing is signed before every check has passed. A purchase is signed once and only once: after
 * signing, this module only ever resends the same request. Signed legs stay valid on USDC until
 * `validBefore` (at most about ten minutes), so never sign a second pair for a purchase whose first
 * pair may still be used. See docs/protocol/FEE_ROUTER_3.md, "Never re-sign a purchase".
 *
 * The returned transaction hash is what the server reports. To prove the payment yourself, read
 * that transaction on Base and check its FeeCharged event (payer, payee, ref, gross, fee).
 */
import { encodeAbiParameters, getAddress, isAddress, keccak256, stringToHex, type Hex } from 'viem';

export const SCHEME = 'cc-router3-split-v1';

/** What a purchase must match. `BASE_MAINNET_TERMS` is the live route; others are for local tests. */
export interface BuyerTerms {
  /** The only origin terms are accepted from: anyone else could name their own payTo. */
  origin: string;
  chainId: number;
  usdc: Hex;
  router: Hex;
  treasury: Hex;
  /** Never a seller: money signed to one of these is lost or goes to the wrong party. */
  reservedPayees: readonly Hex[];
}

export const BASE_MAINNET_TERMS: BuyerTerms = Object.freeze({
  origin: 'https://centralcity.ai',
  chainId: 8453,
  usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  router: '0xE807A76385EC3d76D17aB955091C12329d0A1403',
  treasury: '0xAF36084a4dc0CE760A6dCfa46Cf129e140c92aa9',
  reservedPayees: Object.freeze([
    '0x0000000000000000000000000000000000000000',
    '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // USDC
    '0xA5f89AE25c87C21a8E2B03aaBf398A880d9be81B', // fee router 1
    '0xb1945a2aF160e84E34F7C0FB0E4dD94fd4c0AF0D', // fee router 2
    '0xE807A76385EC3d76D17aB955091C12329d0A1403', // fee router 3
    '0xAF36084a4dc0CE760A6dCfa46Cf129e140c92aa9', // treasury
    '0x3A91A31cB3dC49b4db9Ce721F50a9D076c8D739B', // sanctions list
    '0xc8d6Bac2ff7182d22c4f316BffF9f713261A6cEC', // facilitator
  ]) as readonly Hex[],
});

/** Router 3's own limits, in USDC units (six decimals). */
const ROUTER_MIN_RAW = 50_000n;
const ROUTER_MAX_RAW = 100_000_000n;
/** The route's terms last 600 seconds from issue and start 60 seconds earlier. */
const MAX_LEFT_S = 600;
const MAX_WINDOW_S = 660;
const CLOCK_SKEW_S = 60;
/** The route refuses terms with less than this left; don't sign what it would refuse. */
const MIN_LEFT_S = 120;
const DEFAULT_MAX_WAIT_MS = 180_000;

const OFFER_PATH = /^\/api\/public\/x402\/off_[a-z2-7]{16}$/;
const CALL_ID = /^xp_[a-z2-7]{20}$/;
const UINT = /^(0|[1-9][0-9]{0,30})$/;
const HEX32 = /^0x[0-9a-fA-F]{64}$/;

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

const NONCE_TAG = keccak256(stringToHex('centralcity.router3.settle.v1'));

/** One leg's EIP-3009 nonce, exactly as CentralCityFeeRouter3.nonceFor derives it. */
export function legNonce(input: {
  chainId: number;
  router: Hex;
  treasury: Hex;
  payer: Hex;
  payee: Hex;
  gross: bigint;
  ref: Hex;
  validAfter: bigint;
  validBefore: bigint;
  leg: 0 | 1;
}): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: 'bytes32' },
        { type: 'uint256' },
        { type: 'address' },
        { type: 'address' },
        { type: 'address' },
        { type: 'address' },
        { type: 'uint256' },
        { type: 'bytes32' },
        { type: 'uint256' },
        { type: 'uint256' },
        { type: 'uint8' },
      ],
      [
        NONCE_TAG,
        BigInt(input.chainId),
        getAddress(input.router),
        getAddress(input.treasury),
        getAddress(input.payer),
        getAddress(input.payee),
        input.gross,
        input.ref,
        input.validAfter,
        input.validBefore,
        input.leg,
      ],
    ),
  );
}

/** Any viem account that signs typed data: a local account or a smart account. */
export interface BuyerAccount {
  address: Hex;
  signTypedData: (parameters: {
    domain: { name: string; version: string; chainId: number; verifyingContract: Hex };
    types: typeof TYPES;
    primaryType: 'TransferWithAuthorization';
    message: {
      from: Hex;
      to: Hex;
      value: bigint;
      validAfter: bigint;
      validBefore: bigint;
      nonce: Hex;
    };
  }) => Promise<Hex>;
}

/** A signed purchase. Keep it until it ends; `resumeOffer` sends it again, it never signs. */
export interface PendingPurchase {
  url: string;
  body: string;
  paymentHeader: string;
  callId: string;
  payer: Hex;
  network: string;
  amountRaw: string;
  /** Unix seconds: the legs stay usable on USDC until then. */
  validBefore: string;
}

export interface BuyerRuntime {
  terms?: BuyerTerms;
  fetch?: typeof globalThis.fetch;
  /** Milliseconds, as Date.now. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** How long to keep following a signed purchase before throwing `still_pending`. */
  maxWaitMs?: number;
}

export interface BuyOfferOptions extends BuyerRuntime {
  account: BuyerAccount;
  /** https://centralcity.ai/api/public/x402/off_<id> */
  url: string;
  /** The offer's input, a JSON object. */
  input?: Record<string, unknown>;
  /** The most you will pay, in USDC units (six decimals): 250_000n is 0.25 USDC. Required. */
  maxPriceRaw: bigint;
  /** The seller's address, when you know it (the Feed lists it): any other payTo is refused. */
  payTo?: string;
  /**
   * Called with the signed purchase before it is first sent; a throw stops the send. Store it here
   * to survive a crash: after a restart call `resumeOffer` with it, never `buyOffer` again.
   */
  onSigned?: (pending: PendingPurchase) => void | Promise<void>;
}

export interface BuyOfferResult {
  result: string;
  contentType: string | null;
  transaction: Hex;
  callId: string;
  payer: Hex;
  amountRaw: string;
}

export type BuyOfferErrorCode =
  | 'bad_argument'
  /** A term didn't match: nothing was signed. `term` names it. */
  | 'terms_mismatch'
  /** The server answered something other than valid terms: nothing was signed. */
  | 'no_terms'
  /** Followed for `maxWaitMs` and not over. `pending` holds what to resend. */
  | 'still_pending'
  /** After signing, the server asked for a new purchase. Not re-signed, by design. */
  | 'terms_changed'
  /** A 200 without a receipt that matches this purchase. */
  | 'invalid_receipt'
  /** Anything else is the server's own code: docs/FEED_PAY.md section 19. */
  | (string & {});

export class BuyOfferError extends Error {
  readonly code: BuyOfferErrorCode;
  readonly status?: number;
  readonly term?: string;
  /** From the server's answer, when it named a transaction. */
  readonly transaction?: Hex;
  /** Set once signed: the legs stay usable on USDC until `pending.validBefore`. */
  readonly pending?: PendingPurchase;

  constructor(
    code: BuyOfferErrorCode,
    message: string,
    details: {
      status?: number;
      term?: string;
      transaction?: Hex;
      pending?: PendingPurchase;
    } = {},
  ) {
    super(message);
    this.name = 'BuyOfferError';
    this.code = code;
    Object.assign(this, details);
  }
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const mismatch = (term: string, message: string) =>
  new BuyOfferError('terms_mismatch', `Not signed: ${message}`, { term });

function checkUrl(value: string, terms: BuyerTerms): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new BuyOfferError('bad_argument', 'The offer URL is not a URL.');
  }
  if (url.origin !== terms.origin || url.username || url.password)
    throw new BuyOfferError('bad_argument', `Offers are bought from ${terms.origin} only.`);
  if (!OFFER_PATH.test(url.pathname) || url.search || url.hash)
    throw new BuyOfferError('bad_argument', 'Not an offer URL: /api/public/x402/off_<id>.');
  return url;
}

interface CheckedTerms {
  accepted: Record<string, unknown>;
  payee: Hex;
  gross: bigint;
  seller: bigint;
  fee: bigint;
  ref: Hex;
  validAfter: bigint;
  validBefore: bigint;
  callId: string;
  network: string;
}

/** Every term against the pinned values and the caller's limits. Throws before anything is signed. */
export function checkOfferTerms(
  challenge: unknown,
  input: {
    payer: string;
    maxPriceRaw: bigint;
    payTo?: string;
    terms?: BuyerTerms;
    nowSeconds: number;
  },
): CheckedTerms {
  const terms = input.terms ?? BASE_MAINNET_TERMS;
  const c = challenge as { x402Version?: unknown; accepts?: unknown } | null;
  if (c?.x402Version !== 2) throw mismatch('x402Version', 'not x402 version 2.');
  if (!Array.isArray(c.accepts)) throw mismatch('accepts', 'the answer lists no payment terms.');
  const entries = c.accepts.filter((entry) => entry?.scheme === SCHEME) as Record<string, any>[];
  if (entries.length !== 1)
    throw mismatch('scheme', `expected exactly one ${SCHEME} entry, found ${entries.length}.`);
  const e = entries[0]!;
  const x = e.extra as Record<string, unknown> | null | undefined;
  if (typeof x !== 'object' || x === null) throw mismatch('extra', 'the terms have no details.');

  const network = `eip155:${terms.chainId}`;
  if (e.network !== network) throw mismatch('network', `network ${String(e.network)}.`);
  const address = (term: string, value: unknown): Hex => {
    if (typeof value !== 'string' || !isAddress(value, { strict: false }))
      throw mismatch(term, `${term} is not an address.`);
    return getAddress(value) as Hex;
  };
  const uint = (term: string, value: unknown): bigint => {
    if (typeof value !== 'string' || !UINT.test(value))
      throw mismatch(term, `${term} is not a whole number.`);
    return BigInt(value);
  };
  if (!same(address('asset', e.asset), terms.usdc))
    throw mismatch('asset', `asset ${String(e.asset)} is not USDC.`);
  if (!same(address('router', x.router), terms.router))
    throw mismatch('router', `router ${String(x.router)} is not fee router 3.`);
  if (!same(address('treasury', x.treasury), terms.treasury))
    throw mismatch('treasury', `treasury ${String(x.treasury)} is not the protocol's.`);
  if (x.name !== 'USD Coin' || x.version !== '2' || x.assetTransferMethod !== 'eip3009')
    throw mismatch('extra', 'not the USDC EIP-3009 signing domain.');

  const payee = address('payTo', e.payTo);
  if (input.payTo !== undefined && !same(payee, address('payTo', input.payTo)))
    throw mismatch('payTo', `payTo ${payee} is not the seller you named.`);
  if (same(payee, input.payer)) throw mismatch('payTo', 'payTo is the buyer.');
  if (
    same(payee, terms.router) ||
    same(payee, terms.treasury) ||
    same(payee, terms.usdc) ||
    terms.reservedPayees.some((reserved) => same(payee, reserved))
  )
    throw mismatch('payTo', `payTo ${payee} can't be a seller.`);

  const gross = uint('amount', e.amount);
  const seller = uint('sellerAmount', x.sellerAmount);
  const fee = uint('feeAmount', x.feeAmount);
  if (gross > input.maxPriceRaw)
    throw mismatch('amount', `the price ${gross} is above your maximum ${input.maxPriceRaw}.`);
  if (gross < ROUTER_MIN_RAW || gross > ROUTER_MAX_RAW)
    throw mismatch('amount', `the price ${gross} is outside router 3's limits.`);
  if (fee !== gross / 10n || seller !== gross - fee)
    throw mismatch('split', `${seller} to the seller and ${fee} in fees isn't 90/10 of ${gross}.`);

  if (typeof x.callId !== 'string' || !CALL_ID.test(x.callId))
    throw mismatch('callId', 'the terms name no call: this offer takes no payments now.');
  if (typeof x.ref !== 'string' || !HEX32.test(x.ref))
    throw mismatch('ref', 'ref is not 32 bytes.');
  if (!same(x.ref, keccak256(stringToHex(x.callId))))
    throw mismatch('ref', 'ref does not belong to this call.');

  const validAfter = uint('validAfter', x.validAfter);
  const validBefore = uint('validBefore', x.validBefore);
  const now = BigInt(input.nowSeconds);
  if (validBefore <= validAfter) throw mismatch('window', 'the window is empty.');
  if (validBefore - validAfter > BigInt(MAX_WINDOW_S))
    throw mismatch('window', `a window of ${validBefore - validAfter} seconds is too long.`);
  if (validAfter > now + BigInt(CLOCK_SKEW_S)) throw mismatch('window', 'the window starts later.');
  if (validBefore < now + BigInt(MIN_LEFT_S)) throw mismatch('window', 'the window is ending.');
  if (validBefore > now + BigInt(MAX_LEFT_S + CLOCK_SKEW_S))
    throw mismatch('window', 'the window ends too far ahead.');

  return {
    accepted: e,
    payee,
    gross,
    seller,
    fee,
    ref: x.ref as Hex,
    validAfter,
    validBefore,
    callId: x.callId,
    network,
  };
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const jsonOf = async (response: Response): Promise<any> => {
  try {
    return await response.clone().json();
  } catch {
    return null;
  }
};

function challengeOf(json: any, response: Response): unknown {
  if (json && Array.isArray(json.accepts)) return json;
  const header = response.headers.get('payment-required');
  if (!header) return null;
  try {
    return JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

/** Buys one call of an offer, within `maxPriceRaw`. See the file's header for what it guarantees. */
export async function buyOffer(options: BuyOfferOptions): Promise<BuyOfferResult> {
  const terms = options.terms ?? BASE_MAINNET_TERMS;
  if (typeof options.maxPriceRaw !== 'bigint' || options.maxPriceRaw <= 0n)
    throw new BuyOfferError('bad_argument', 'maxPriceRaw is required: a positive bigint.');
  checkUrl(options.url, terms);
  const send = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const payer = getAddress(options.account.address) as Hex;
  const body = JSON.stringify(options.input ?? {});

  const asked = await send(options.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
    redirect: 'error',
  });
  const askedJson = await jsonOf(asked);
  if (asked.status !== 402)
    throw new BuyOfferError(
      askedJson?.code ?? 'no_terms',
      `Not signed: expected a 402, got ${asked.status}${askedJson?.error ? `: ${askedJson.error}` : '.'}`,
      { status: asked.status },
    );
  const challenge = challengeOf(askedJson, asked);
  if (!challenge)
    throw new BuyOfferError('no_terms', 'Not signed: the 402 carried no terms.', { status: 402 });

  const checked = checkOfferTerms(challenge, {
    payer,
    maxPriceRaw: options.maxPriceRaw,
    terms,
    nowSeconds: Math.floor(now() / 1000),
    ...(options.payTo !== undefined ? { payTo: options.payTo } : {}),
  });

  const sign = async (leg: 0 | 1, to: Hex, value: bigint) => {
    const nonce = legNonce({
      chainId: terms.chainId,
      router: terms.router,
      treasury: terms.treasury,
      payer,
      payee: checked.payee,
      gross: checked.gross,
      ref: checked.ref,
      validAfter: checked.validAfter,
      validBefore: checked.validBefore,
      leg,
    });
    const signature = await options.account.signTypedData({
      domain: {
        name: 'USD Coin',
        version: '2',
        chainId: terms.chainId,
        verifyingContract: getAddress(terms.usdc) as Hex,
      },
      types: TYPES,
      primaryType: 'TransferWithAuthorization',
      message: {
        from: payer,
        to,
        value,
        validAfter: checked.validAfter,
        validBefore: checked.validBefore,
        nonce,
      },
    });
    return {
      from: payer,
      to,
      value: value.toString(),
      validAfter: checked.validAfter.toString(),
      validBefore: checked.validBefore.toString(),
      nonce,
      signature,
    };
  };
  const payment = {
    x402Version: 2,
    accepted: checked.accepted,
    payload: {
      payer,
      seller: await sign(0, checked.payee, checked.seller),
      fee: await sign(1, getAddress(terms.treasury) as Hex, checked.fee),
    },
  };
  const pending: PendingPurchase = {
    url: options.url,
    body,
    paymentHeader: Buffer.from(JSON.stringify(payment)).toString('base64'),
    callId: checked.callId,
    payer,
    network: checked.network,
    amountRaw: checked.gross.toString(),
    validBefore: checked.validBefore.toString(),
  };
  await options.onSigned?.(pending);
  return resumeOffer(pending, options);
}

/** Answers that end nothing: the same request may be sent again, with the same legs. */
const RESEND_CODES: ReadonlySet<string> = new Set([
  'payer_in_flight',
  'call_open',
  'rate_limited',
  'too_many_open',
  'payment_too_costly',
]);

/**
 * Follows a signed purchase: sends exactly the same request until the call ends. It never signs, so
 * it is safe to call again after a crash, a timeout or `still_pending`.
 */
export async function resumeOffer(
  pending: PendingPurchase,
  runtime: BuyerRuntime = {},
): Promise<BuyOfferResult> {
  checkUrl(pending.url, runtime.terms ?? BASE_MAINNET_TERMS);
  const send = runtime.fetch ?? globalThis.fetch;
  const now = runtime.now ?? Date.now;
  const sleep = runtime.sleep ?? defaultSleep;
  const deadline = now() + (runtime.maxWaitMs ?? DEFAULT_MAX_WAIT_MS);

  for (;;) {
    let waitS = 5;
    let response: Response | null = null;
    try {
      response = await send(pending.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'PAYMENT-SIGNATURE': pending.paymentHeader },
        body: pending.body,
        redirect: 'error',
      });
    } catch {
      // No answer says nothing about the call: the same request again is always safe.
    }
    if (response) {
      if (response.status === 200) return delivered(response, pending);
      const json = await jsonOf(response);
      const code = typeof json?.code === 'string' ? (json.code as string) : null;
      const again =
        response.status === 202 ||
        response.status === 503 ||
        (code ? RESEND_CODES.has(code) : response.status >= 500);
      if (!again) throw ended(response, json, code, pending);
      const retryAfter = Number(response.headers.get('retry-after'));
      if (Number.isFinite(retryAfter) && retryAfter > 0) waitS = Math.min(retryAfter, 30);
    }
    if (now() + waitS * 1000 > deadline)
      throw new BuyOfferError(
        'still_pending',
        `Call ${pending.callId} has not ended. Resume it with the same purchase; do not buy again.`,
        { pending },
      );
    await sleep(waitS * 1000);
  }
}

async function delivered(response: Response, pending: PendingPurchase): Promise<BuyOfferResult> {
  const receipt = receiptOf(response);
  if (
    receipt?.success !== true ||
    typeof receipt.transaction !== 'string' ||
    !HEX32.test(receipt.transaction) ||
    receipt.network !== pending.network ||
    typeof receipt.payer !== 'string' ||
    !same(receipt.payer, pending.payer)
  )
    throw new BuyOfferError(
      'invalid_receipt',
      'A 200 without a receipt for this purchase. Check Base before trusting it.',
      { status: 200, pending },
    );
  return {
    result: await response.text(),
    contentType: response.headers.get('content-type'),
    transaction: receipt.transaction as Hex,
    callId: pending.callId,
    payer: pending.payer,
    amountRaw: pending.amountRaw,
  };
}

function receiptOf(response: Response): Record<string, unknown> | null {
  const header = response.headers.get('payment-response');
  if (!header) return null;
  try {
    return JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

function ended(
  response: Response,
  json: any,
  code: string | null,
  pending: PendingPurchase,
): BuyOfferError {
  const named = receiptOf(response)?.transaction ?? json?.transaction;
  const transaction = typeof named === 'string' && HEX32.test(named) ? (named as Hex) : undefined;
  const details = {
    status: response.status,
    pending,
    ...(transaction ? { transaction } : {}),
  };
  // A new 402 for a signed purchase: the offer changed or the window ended. The legs already signed
  // are still valid until they expire, so this module refuses to sign another pair by itself.
  if (response.status === 402 && !code)
    return new BuyOfferError(
      'terms_changed',
      `The server asked for a new purchase. Not signed again; the legs of ${pending.callId} stay valid until ${pending.validBefore}.`,
      details,
    );
  return new BuyOfferError(
    code ?? `http_${response.status}`,
    typeof json?.error === 'string' ? json.error : `Answer ${response.status}.`,
    details,
  );
}
