/*
 * Owner withdrawals (Operation Base Wallet W2; contract v1, v1.1 gate 2): what the browser and the
 * server share. The server prepares an unsigned, sponsored UserOperation from the agent's wallet;
 * the browser holds the owner key and signs the operation's RAW userOpHash (a Coinbase Smart Wallet
 * checks exactly that hash, with no message prefix). Before it signs, the browser recomputes the
 * hash from the operation it was given (`ownerOperationHash`) and decodes its one call
 * (`decodeOwnerCall`), so the owner signs exactly the withdrawal on screen and nothing else.
 *
 * One network: the wallet network (wallet-network.ts; Base, chain 8453), EntryPoint v0.6.
 */
import {
  decodeFunctionData,
  encodeFunctionData,
  getAddress,
  isAddress,
  numberToHex,
  parseAbi,
  type Hex,
} from 'viem';
import { getUserOperationHash, type UserOperation } from 'viem/account-abstraction';
import { BASE_NETWORKS, type Address } from './chains.js';
import { WALLET_CHAIN_ID } from './wallet-network.js';

export const WITHDRAWAL_CHAIN_ID = WALLET_CHAIN_ID;
const NETWORK = BASE_NETWORKS[WITHDRAWAL_CHAIN_ID];
export const WITHDRAWAL_ENTRY_POINT = NETWORK.contracts.entryPointV06;

/** How long an unsigned withdrawal (or cancel) can still be signed. A signed one never expires. */
export const WITHDRAWAL_SIGNATURE_TTL_MS = 10 * 60_000;

export type WithdrawalToken = 'USDC' | 'ETH';

export type WithdrawalState =
  /** Prepared; the owner has not signed it. Only this state can become `expired`. */
  | 'awaiting_signature'
  /** Signed and sent (or being sent); not in a block yet. Live until its nonce is used. */
  | 'submitted'
  /** In a block, not final yet. */
  | 'included'
  | 'final'
  | 'failed'
  /** Never signed within its time; nothing can ever be sent for it. */
  | 'expired'
  /** Signed, and the owner asked for a no-op at the same nonce; the original may still land. */
  | 'cancel_pending'
  /** The no-op at its nonce is final and the withdrawal never landed. */
  | 'cancelled';

/** One unfinished owner operation per wallet at a time (gate 2). */
export const WITHDRAWAL_OPEN_STATES: readonly WithdrawalState[] = [
  'awaiting_signature',
  'submitted',
  'included',
  'cancel_pending',
];

/** A v0.6 UserOperation as JSON-RPC carries it: every number a hex quantity. */
export interface RpcUserOperation {
  sender: Address;
  nonce: Hex;
  initCode: Hex;
  callData: Hex;
  callGasLimit: Hex;
  verificationGasLimit: Hex;
  preVerificationGas: Hex;
  maxFeePerGas: Hex;
  maxPriorityFeePerGas: Hex;
  paymasterAndData: Hex;
  signature: Hex;
}

const QUANTITIES = [
  'nonce',
  'callGasLimit',
  'verificationGasLimit',
  'preVerificationGas',
  'maxFeePerGas',
  'maxPriorityFeePerGas',
] as const;
const BYTES = ['initCode', 'callData', 'paymasterAndData', 'signature'] as const;
const QUANTITY = /^0x(0|[1-9a-f][0-9a-f]{0,63})$/;
const DATA = /^0x([0-9a-fA-F]{2})*$/;

export function userOperationToRpc(op: UserOperation<'0.6'>): RpcUserOperation {
  return {
    sender: getAddress(op.sender),
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

/** Parses the JSON-RPC form strictly; anything malformed throws. */
export function userOperationFromRpc(value: unknown): UserOperation<'0.6'> {
  if (typeof value !== 'object' || value === null) throw new Error('Not a UserOperation.');
  const json = value as Record<string, unknown>;
  const keys = Object.keys(json).sort();
  const expected = ['sender', ...QUANTITIES, ...BYTES].sort();
  if (keys.length !== expected.length || keys.some((key, i) => key !== expected[i]))
    throw new Error('A UserOperation has exactly the v0.6 fields.');
  if (typeof json.sender !== 'string' || !isAddress(json.sender, { strict: false }))
    throw new Error('sender is not an address.');
  const op: Record<string, unknown> = { sender: getAddress(json.sender) };
  for (const field of QUANTITIES) {
    const raw = json[field];
    if (typeof raw !== 'string' || !QUANTITY.test(raw))
      throw new Error(`${field} is not a hex quantity.`);
    op[field] = BigInt(raw);
  }
  for (const field of BYTES) {
    const raw = json[field];
    if (typeof raw !== 'string' || !DATA.test(raw)) throw new Error(`${field} is not hex data.`);
    op[field] = raw;
  }
  return op as unknown as UserOperation<'0.6'>;
}

/** The hash the owner key signs, raw (no prefix): the wallet network, EntryPoint v0.6. */
export function ownerOperationHash(op: UserOperation<'0.6'>): Hex {
  return getUserOperationHash({
    chainId: WITHDRAWAL_CHAIN_ID,
    entryPointAddress: WITHDRAWAL_ENTRY_POINT,
    entryPointVersion: '0.6',
    userOperation: op,
  });
}

/** The Coinbase Smart Wallet's own calls; an owner operation is only ever one `execute`. */
export const walletAbi = parseAbi([
  'function execute(address target, uint256 value, bytes data)',
  'function executeBatch((address target, uint256 value, bytes data)[] calls)',
]);
const erc20Abi = parseAbi(['function transfer(address to, uint256 amount) returns (bool)']);

export interface OwnerCallEncoding {
  target: Address;
  value: bigint;
  data: Hex;
}

/** The one call of a withdrawal: USDC.transfer(to, amount), or `amount` wei sent to `to`. */
export function withdrawalCall(
  token: WithdrawalToken,
  to: Address,
  amount: bigint,
): OwnerCallEncoding {
  if (token === 'USDC')
    return {
      target: NETWORK.tokens.USDC.address,
      value: 0n,
      data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [to, amount] }),
    };
  return { target: getAddress(to), value: amount, data: '0x' };
}

/**
 * The cancel: the wallet calls itself with no value and no data, which does nothing. Signed at the
 * nonce of a withdrawal, it makes that withdrawal impossible once it lands.
 */
export function noopCall(wallet: Address): OwnerCallEncoding {
  return { target: getAddress(wallet), value: 0n, data: '0x' };
}

export type OwnerCall =
  { kind: 'withdraw'; token: WithdrawalToken; to: Address; amount: bigint } | { kind: 'noop' };

/**
 * What an owner operation's callData does, or null when it is anything but exactly one of: a USDC
 * transfer, a plain ETH send to another address, or the wallet's own no-op. The browser refuses to
 * sign an operation this does not decode to what the owner asked for.
 */
export function decodeOwnerCall(callData: Hex, wallet: Address): OwnerCall | null {
  let decoded;
  try {
    decoded = decodeFunctionData({ abi: walletAbi, data: callData });
  } catch {
    return null;
  }
  if (decoded.functionName !== 'execute') return null;
  const [target, value, data] = decoded.args;
  // Re-encoding must give the same bytes: no trailing data rides along.
  if (
    encodeFunctionData({ abi: walletAbi, functionName: 'execute', args: decoded.args }) !==
    callData.toLowerCase()
  )
    return null;
  const self = getAddress(wallet);
  if (getAddress(target) === self) return value === 0n && data === '0x' ? { kind: 'noop' } : null;
  if (getAddress(target) === NETWORK.tokens.USDC.address) {
    if (value !== 0n) return null;
    try {
      const transfer = decodeFunctionData({ abi: erc20Abi, data });
      if (transfer.functionName !== 'transfer') return null;
      if (
        encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: transfer.args }) !==
        data.toLowerCase()
      )
        return null;
      const [to, amount] = transfer.args;
      return amount > 0n ? { kind: 'withdraw', token: 'USDC', to: getAddress(to), amount } : null;
    } catch {
      return null;
    }
  }
  if (data !== '0x' || value <= 0n) return null;
  return { kind: 'withdraw', token: 'ETH', to: getAddress(target), amount: value };
}
