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
import { getUserOperationHash, type UserOperation } from 'viem/account-abstraction';
import type { Address } from '../../../shared/base/chains.js';
import type { Bundler, BundlerReceipt } from './submit.js';

/** What a bundler's JSON-RPC error said, classified here so its text never leaves this module. */
export type BundlerRejection = 'already_known' | 'nonce_invalid' | 'other';

export class BundlerError extends Error {
  constructor(
    readonly code:
      'FEE_CAP_EXCEEDED' | 'RPC_ERROR' | 'RPC_UNAVAILABLE' | 'BAD_RESPONSE' | 'NONCE_CONSUMED',
    message: string,
    /** For RPC_ERROR: the classified rejection (the upstream text itself is never kept). */
    readonly rejection?: BundlerRejection,
  ) {
    super(message);
  }
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
  const rejection: BundlerRejection = ALREADY_KNOWN.test(text)
    ? 'already_known'
    : NONCE_INVALID.test(text)
      ? 'nonce_invalid'
      : 'other';
  const rpcCode = Number.isSafeInteger(error.code) ? ` ${error.code as number}` : '';
  const aa = AA_CODE.exec(text)?.[0];
  return new BundlerError(
    'RPC_ERROR',
    `${method}: bundler rejected the request (code${rpcCode || ' unknown'}${aa ? `, ${aa}` : ''}).`,
    rejection,
  );
}

/**
 * Fees a bundler accepts with margin: twice the latest base fee plus the priority fee. A plain
 * estimate (base fee × 1.2 + tip) can sit just under a bundler's precheck minimum and then is
 * refused on every send (Base room #435: 7,303,829 offered, 7,660,000 required). The fee cap still
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

export function rpcBundler(options: RpcBundlerOptions): Bundler {
  const doFetch = options.fetch ?? fetch;
  const chainHex = numberToHex(options.chainId);
  let id = 0;

  async function call<T>(method: string, params: unknown[]): Promise<T> {
    let response: Response;
    try {
      response = await doFetch(options.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
        signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
      });
    } catch {
      throw new BundlerError('RPC_UNAVAILABLE', `${method}: bundler not reachable.`);
    }
    if (!response.ok)
      throw new BundlerError('RPC_UNAVAILABLE', `${method}: HTTP ${response.status}.`);
    const body = (await response.json().catch(() => null)) as {
      result?: T;
      error?: { code?: unknown; message?: unknown };
    } | null;
    if (!body) throw new BundlerError('BAD_RESPONSE', `${method}: response is not JSON.`);
    if (body.error) throw bundlerRejection(method, body.error);
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
