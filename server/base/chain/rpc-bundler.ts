/*
 * Bundler + paymaster over the standard JSON-RPC interfaces (ERC-4337 bundler methods, ERC-7677
 * paymaster methods), as served by the CDP endpoint named by the network's `bundlerEnv` (one URL for both; `CITY_BASE_CDP_RPC_URL` on Base mainnet).
 * EntryPoint v0.6 only (Coinbase Smart Wallet v1). The URL contains a key: it is never logged,
 * never returned, and never put into an error message.
 *
 * Fee guard: an operation is never prepared above `maxFeePerGasCap`. During a fee spike nothing is
 * signed or sent, and the caller retries later with the same idempotency key.
 */
import { numberToHex, type Hex, type PublicClient } from 'viem';
import { countRpc } from './rpc-count.js';
import { getUserOperationHash, type UserOperation } from 'viem/account-abstraction';
import type { Address } from '../../../shared/base/chains.js';
import type { Bundler, BundlerReceipt } from './submit.js';
import { busyRpcAnswer } from './transient.js';

/**
 * What a bundler's JSON-RPC error said, classified here so its text never leaves this module.
 * 'busy': the endpoint said "not now" inside an HTTP 200, and said it is a rate limit (see
 * busyRpcAnswer: never a spending policy, a gas limit or a denial); the request was not taken and
 * the same call may be made again later.
 */
export type BundlerRejection = 'already_known' | 'nonce_invalid' | 'busy' | 'other';

export class BundlerError extends Error {
  constructor(
    readonly code:
      'FEE_CAP_EXCEEDED' | 'RPC_ERROR' | 'RPC_UNAVAILABLE' | 'BAD_RESPONSE' | 'NONCE_CONSUMED',
    message: string,
    /** For RPC_ERROR: the classified rejection (the upstream text itself is never kept). */
    readonly rejection?: BundlerRejection,
    /** For RPC_ERROR: the numeric JSON-RPC error code, when the bundler gave one. */
    readonly rpcCode?: number,
    /** For RPC_UNAVAILABLE from a non-OK answer: its HTTP status (429: the provider's rate limit). */
    readonly httpStatus?: number,
    /**
     * With httpStatus: the provider's Retry-After in ms (delay seconds or an HTTP date); null when
     * it sent none, or none that parses. A caller that plans a new try never asks earlier.
     */
    readonly retryAfterMs?: number | null,
  ) {
    super(message);
  }
}

/**
 * Whether a bundler or paymaster refusal says only "not now": an HTTP 429 (the provider's rate
 * limit) or a JSON-RPC answer classified 'busy' (busyRpcAnswer). Configuration, sponsorship
 * policy, allowlist, fee cap, nonce and every other error is not, and ends its work as before.
 */
export function bundlerRateLimited(error: unknown): error is BundlerError {
  return (
    error instanceof BundlerError &&
    ((error.code === 'RPC_UNAVAILABLE' && error.httpStatus === 429) ||
      (error.code === 'RPC_ERROR' && error.rejection === 'busy'))
  );
}

/**
 * Whether an error that stopped an operation before it was stored says only "not now" from the
 * provider, with its Retry-After (ms; null when it sent none, or none that parses):
 *   - a bundler or paymaster refusal that bundlerRateLimited accepts (an HTTP 429, or a JSON-RPC
 *     answer classified 'busy', -32002/-32005 included, see busyRpcAnswer);
 *   - a node read made while preparing the operation (its nonce, its code) that the configured
 *     endpoint refused with an HTTP 429 (viem's HttpRequestError carries `status` and `headers`),
 *     or with a JSON-RPC error that busyRpcAnswer calls a rate limit; found anywhere in the
 *     error's causes (viem wraps a contract read's transport error).
 * Everything else (a 500, a timeout, a policy, an allowlist, funds, a revert) is null. The upstream
 * text is only matched, never kept. This says nothing about whether the operation went out: only
 * its stored row (NEVER_BROADCAST) proves that.
 */
export function providerRateLimit(error: unknown): { retryAfterMs: number | null } | null {
  let current: unknown = error;
  for (let depth = 0; current && typeof current === 'object' && depth < 6; depth++) {
    if (bundlerRateLimited(current)) return { retryAfterMs: current.retryAfterMs ?? null };
    // Any other BundlerError is the bundler's own word, and it is not a rate limit.
    if (current instanceof BundlerError) return null;
    const e = current as {
      status?: unknown;
      headers?: unknown;
      code?: unknown;
      details?: unknown;
      message?: unknown;
      cause?: unknown;
    };
    if (e.status === 429) {
      const headers = e.headers as { get?: (name: string) => string | null } | undefined;
      const header = typeof headers?.get === 'function' ? headers.get('retry-after') : null;
      return { retryAfterMs: retryAfterHeaderMs(typeof header === 'string' ? header : null) };
    }
    if (typeof e.code === 'number' && Number.isSafeInteger(e.code)) {
      const text =
        typeof e.details === 'string' ? e.details : typeof e.message === 'string' ? e.message : '';
      if (busyRpcAnswer(e.code, text)) return { retryAfterMs: null };
    }
    current = e.cause;
  }
  return null;
}

/**
 * The paymaster refused to sponsor, or could not be asked (pm_* calls). Still a BundlerError with
 * the same code, so callers that only know BundlerError see no change; a caller with an
 * unsponsored path (owner operations) can fall back to it.
 */
export class SponsorError extends BundlerError {
  constructor(cause: unknown) {
    const known = cause instanceof BundlerError ? cause : null;
    super(
      known?.code ?? 'RPC_UNAVAILABLE',
      known?.message ?? 'The paymaster could not be asked.',
      known?.rejection,
      known?.rpcCode,
      known?.httpStatus,
      known?.retryAfterMs,
    );
  }
}

export interface RpcBundlerOptions {
  url: string;
  entryPoint: Address;
  chainId: number;
  client: PublicClient;
  /** Hard cap on maxFeePerGas (wei). Above it, prepare() refuses; nothing is signed. */
  maxFeePerGasCap: bigint;
  /** Stub signature the account uses for gas estimation (Coinbase Smart Wallet wrapper). */
  stubSignature: Hex;
  /** Optional ERC-7677 paymaster context (e.g. a sponsorship policy id). */
  paymasterContext?: Record<string, unknown>;
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** The key its requests count under per minute (rpc-count.ts); 'bundler:configured' by default. */
  countKey?: string;
  /**
   * Waits before asking again after an HTTP 429 (BUNDLER_429_WAITS_MS for payments); none by
   * default, so bulk work never multiplies its requests against a provider that is already limiting.
   */
  rateLimitWaitsMs?: readonly number[];
  /** Waits between rate-limited tries (tests pass a no-op). */
  sleep?: (ms: number) => Promise<void>;
}

/** The v0.6 UserOperation as JSON-RPC expects it: every number hex-encoded. */
export function toRpc(op: UserOperation<'0.6'>) {
  return {
    sender: op.sender,
    nonce: numberToHex(op.nonce),
    initCode: op.initCode ?? '0x',
    callData: op.callData,
    callGasLimit: numberToHex(op.callGasLimit),
    verificationGasLimit: numberToHex(op.verificationGasLimit),
    preVerificationGas: numberToHex(op.preVerificationGas),
    maxFeePerGas: numberToHex(op.maxFeePerGas),
    maxPriorityFeePerGas: numberToHex(op.maxPriorityFeePerGas),
    paymasterAndData: op.paymasterAndData ?? '0x',
    signature: op.signature,
  };
}

const bigintField = (value: unknown, name: string): bigint => {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]+$/.test(value))
    throw new BundlerError('BAD_RESPONSE', `Bundler returned an invalid ${name}.`);
  return BigInt(value);
};

const hexData = (value: unknown, name: string): Hex => {
  if (typeof value !== 'string' || !/^0x([0-9a-fA-F]{2})*$/.test(value))
    throw new BundlerError('BAD_RESPONSE', `Bundler returned invalid ${name}.`);
  return value as Hex;
};

/** Errors bundlers return when an identical operation is already in their mempool or mined. */
/** Only messages that say this exact operation is already held count as a successful resend. */
const ALREADY_KNOWN = /already known|already in (the )?mempool/i;
const NONCE_INVALID = /AA25 invalid account nonce/i;
/** The ERC-4337 EntryPoint failure code (AA10..AA99), the only part of upstream text we repeat. */
const AA_CODE = /\bAA[1-9][0-9]\b/;

/**
 * A safe message for a bundler's JSON-RPC error. Provider text can echo the request URL (which
 * contains the key) or the payload, and truncating it is not redacting it, so only the method,
 * the numeric JSON-RPC code and an EntryPoint AA code are kept.
 */
export function bundlerRejection(
  method: string,
  error: { code?: unknown; message?: unknown },
): BundlerError {
  const text = typeof error.message === 'string' ? error.message : '';
  const code = Number.isSafeInteger(error.code) ? (error.code as number) : undefined;
  // "Not now" only when the code and the text say it is a rate limit (transient.ts busyRpcAnswer).
  const busy = code !== undefined && busyRpcAnswer(code, text);
  const rejection: BundlerRejection = ALREADY_KNOWN.test(text)
    ? 'already_known'
    : NONCE_INVALID.test(text)
      ? 'nonce_invalid'
      : busy
        ? 'busy'
        : 'other';
  const rpcCode = code === undefined ? '' : ` ${code}`;
  const aa = AA_CODE.exec(text)?.[0];
  return new BundlerError(
    'RPC_ERROR',
    `${method}: bundler rejected the request (code${rpcCode || ' unknown'}${aa ? `, ${aa}` : ''}).`,
    rejection,
    code,
  );
}

/**
 * Fees a bundler accepts with margin: twice the latest base fee plus the priority fee. A plain
 * estimate (base fee × 1.2 + tip) can sit just under a bundler's precheck minimum and then is
 * refused on every send (observed: 7,303,829 offered, 7,660,000 required). The fee cap still
 * bounds it, and the charged fee is the actual base fee + tip, not this maximum.
 */
export async function bundlerFees(client: Pick<PublicClient, 'estimateFeesPerGas' | 'getBlock'>) {
  const [estimate, block] = await Promise.all([client.estimateFeesPerGas(), client.getBlock()]);
  const priority = estimate.maxPriorityFeePerGas;
  const baseFee = block.baseFeePerGas ?? 0n;
  const withMargin = baseFee * 2n + priority;
  return {
    maxPriorityFeePerGas: priority,
    maxFeePerGas: withMargin > estimate.maxFeePerGas ? withMargin : estimate.maxFeePerGas,
  };
}

/** The waits before asking a rate-limited (HTTP 429) bundler again: three more tries in ~4.5 s. */
export const BUNDLER_429_WAITS_MS = [500, 1_500, 2_500] as const;

/** The longest provider delay a paid call waits for before asking again. */
export const BUNDLER_429_MAX_WAIT_MS = 3_000;

/**
 * How long to wait before asking a rate-limited bundler again: the provider's Retry-After (seconds
 * or an HTTP date) when it is at most BUNDLER_429_MAX_WAIT_MS; null when it asks for longer (never
 * ask earlier than the provider said: the sequence stops and the usual transient failure stands);
 * our own wait when there is no usable header.
 */
export function retryAfterMs(
  header: string | null,
  fallbackMs: number,
  nowMs: number = Date.now(),
): number | null {
  const ms = retryAfterHeaderMs(header, nowMs);
  if (ms === null) return fallbackMs;
  return ms <= BUNDLER_429_MAX_WAIT_MS ? ms : null;
}

/** A Retry-After header in ms (delay seconds or an HTTP date); null when absent or unreadable. */
export function retryAfterHeaderMs(
  header: string | null,
  nowMs: number = Date.now(),
): number | null {
  const text = header?.trim() ?? '';
  if (!text) return null;
  if (/^\d+$/.test(text)) return Number(text) * 1000;
  const at = Date.parse(text);
  if (!Number.isFinite(at)) return null;
  return Math.max(0, at - nowMs);
}

export function rpcBundler(options: RpcBundlerOptions): Bundler {
  const doFetch = options.fetch ?? fetch;
  const waits = options.rateLimitWaitsMs ?? [];
  const wait = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const chainHex = numberToHex(options.chainId);
  const countKey = options.countKey ?? 'bundler:configured';
  let id = 0;

  async function call<T>(method: string, params: unknown[]): Promise<T> {
    let response: Response;
    for (let attempt = 0; ; attempt++) {
      try {
        response = await doFetch(options.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
          signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
        });
      } catch {
        countRpc(countKey, 'failed');
        throw new BundlerError('RPC_UNAVAILABLE', `${method}: bundler not reachable.`);
      }
      // A 429 is the provider's rate limit. Asking again sends the very same request (the same
      // operation, signature and nonce, so the same hash); whether an earlier try was accepted
      // anyway is settled as for any ambiguous send, by the stored operation's reconciliation.
      // A few short waits ride out a busy minute instead of failing the payment it belongs to.
      if (response.status !== 429 || attempt >= waits.length) break;
      const delay = retryAfterMs(response.headers.get('retry-after'), waits[attempt]!);
      if (delay === null) break;
      countRpc(countKey, 'http429');
      await wait(delay);
    }
    if (!response.ok) {
      countRpc(countKey, response.status === 429 ? 'http429' : 'failed');
      // The status and the provider's Retry-After travel as data (never its body): a caller can
      // tell a rate limit from every other failure and plan a later try no earlier than asked.
      throw new BundlerError(
        'RPC_UNAVAILABLE',
        `${method}: HTTP ${response.status}.`,
        undefined,
        undefined,
        response.status,
        retryAfterHeaderMs(response.headers.get('retry-after')),
      );
    }
    const body = (await response.json().catch(() => null)) as {
      result?: T;
      error?: { code?: unknown; message?: unknown };
    } | null;
    if (!body) {
      countRpc(countKey, 'failed');
      throw new BundlerError('BAD_RESPONSE', `${method}: response is not JSON.`);
    }
    if (body.error) {
      const rejection = bundlerRejection(method, body.error);
      countRpc(countKey, rejection.rejection === 'busy' ? 'busy' : 'failed');
      throw rejection;
    }
    countRpc(countKey, 'ok');
    return body.result as T;
  }

  return {
    async prepare(op, prepareOptions) {
      const sponsor = prepareOptions?.sponsor ?? true;
      const estimate = await bundlerFees(options.client);
      // Fee fields set on the incoming operation are minimums: a replacement at the same nonce
      // must outbid the operation it replaces. Callers that set none (zero) get the estimate.
      const maxPriorityFeePerGas =
        op.maxPriorityFeePerGas > estimate.maxPriorityFeePerGas
          ? op.maxPriorityFeePerGas
          : estimate.maxPriorityFeePerGas;
      const maxFeeFloor =
        op.maxFeePerGas > maxPriorityFeePerGas ? op.maxFeePerGas : maxPriorityFeePerGas;
      const fees = {
        maxPriorityFeePerGas,
        maxFeePerGas: maxFeeFloor > estimate.maxFeePerGas ? maxFeeFloor : estimate.maxFeePerGas,
      };
      if (fees.maxFeePerGas > options.maxFeePerGasCap)
        throw new BundlerError('FEE_CAP_EXCEEDED', 'Network fees are above the configured cap.');
      const draft: UserOperation<'0.6'> = {
        ...op,
        maxFeePerGas: fees.maxFeePerGas,
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
        signature: options.stubSignature,
      };
      const context = options.paymasterContext ?? {};
      /** A paymaster call; any failure of it is a SponsorError. */
      const paymaster = async (method: string, name: string) => {
        try {
          const answer = await call<{ paymasterAndData?: string }>(method, [
            toRpc(draft),
            options.entryPoint,
            chainHex,
            context,
          ]);
          return hexData(answer?.paymasterAndData, name);
        } catch (error) {
          throw new SponsorError(error);
        }
      };

      // Unsponsored: the account prefunds its own gas from its balance; no paymaster is asked.
      draft.paymasterAndData = sponsor
        ? await paymaster('pm_getPaymasterStubData', 'stub paymasterAndData')
        : '0x';

      const gas = await call<Record<string, unknown>>('eth_estimateUserOperationGas', [
        toRpc(draft),
        options.entryPoint,
      ]);
      draft.callGasLimit = bigintField(gas?.callGasLimit, 'callGasLimit');
      draft.verificationGasLimit = bigintField(gas?.verificationGasLimit, 'verificationGasLimit');
      draft.preVerificationGas = bigintField(gas?.preVerificationGas, 'preVerificationGas');

      return {
        ...draft,
        paymasterAndData: sponsor
          ? await paymaster('pm_getPaymasterData', 'paymasterAndData')
          : '0x',
        signature: '0x',
      };
    },

    async send(op) {
      try {
        return hexData(
          await call<string>('eth_sendUserOperation', [toRpc(op), options.entryPoint]),
          'userOpHash',
        );
      } catch (error) {
        if (!(error instanceof BundlerError) || error.code !== 'RPC_ERROR') throw error;
        // Resending this exact operation, which the bundler already has, is success. Return the
        // locally computed hash so callers never store a placeholder.
        if (error.rejection === 'already_known')
          return getUserOperationHash({
            chainId: options.chainId,
            entryPointAddress: options.entryPoint,
            entryPointVersion: '0.6',
            userOperation: op,
          });
        // AA25 only says the nonce is no longer valid: maybe this op landed, maybe another one
        // used the nonce. Never treat it as success; the caller reconciles by the stored hash.
        if (error.rejection === 'nonce_invalid')
          throw new BundlerError('NONCE_CONSUMED', 'eth_sendUserOperation: nonce already used.');
        throw error;
      }
    },

    async receipt(userOpHash): Promise<BundlerReceipt | null> {
      const result = await call<{
        success?: boolean;
        actualGasCost?: string;
        actualGasUsed?: string;
        receipt?: { transactionHash?: string; blockNumber?: string };
      } | null>('eth_getUserOperationReceipt', [userOpHash]);
      if (!result) return null;
      if (typeof result.success !== 'boolean' || !result.receipt)
        throw new BundlerError('BAD_RESPONSE', 'Bundler returned an invalid receipt.');
      return {
        success: result.success,
        txHash: hexData(result.receipt.transactionHash, 'transactionHash'),
        blockNumber: bigintField(result.receipt.blockNumber, 'blockNumber'),
        actualGasUsed: bigintField(result.actualGasUsed, 'actualGasUsed'),
        actualGasCost: bigintField(result.actualGasCost, 'actualGasCost'),
      };
    },
  };
}
