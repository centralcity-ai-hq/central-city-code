import {
  decodeFunctionData,
  getAddress,
  parseAbi,
  parseEventLogs,
  type Hex,
  type TransactionReceipt,
  type PublicClient,
} from 'viem';
import type { ReceiveBinding } from './receive-store.js';

const abi = parseAbi([
  'event Transfer(address indexed from, address indexed to, uint256 value)',
  'event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)',
]);
const authorizationAbi = parseAbi([
  'function transferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce,bytes signature)',
  'function transferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce,uint8 v,bytes32 r,bytes32 s)',
  'function receiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce,bytes signature)',
  'function receiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce,uint8 v,bytes32 r,bytes32 s)',
]);

/** Trusted RPC adapter supplies these observations; never accept this object from a request. */
export interface ReceiveEvidence {
  chainId: number;
  transaction: Hex;
  receipt: TransactionReceipt | null;
  canonicalBlockHash: Hex | null;
  finalizedBlock: bigint | null;
  directCall: {
    hash: Hex;
    to: Hex | null;
    input: Hex;
    value: bigint;
    blockHash: Hex | null;
    blockNumber: bigint | null;
  } | null;
}

/** Trusted configured RPC only; requests never select the RPC URL. No signing or broadcasting. */
export async function readReceiveEvidence(
  client: Pick<
    PublicClient,
    'getChainId' | 'getTransactionReceipt' | 'getTransaction' | 'getBlock'
  >,
  transaction: Hex,
): Promise<ReceiveEvidence | null> {
  try {
    const chainId = await client.getChainId();
    const receipt = await client.getTransactionReceipt({ hash: transaction });
    const directCall = await client.getTransaction({ hash: transaction });
    const finalized = await client.getBlock({ blockTag: 'finalized' });
    // Read last: reject an inclusion replaced while the preceding observations were fetched.
    const canonical = await client.getBlock({ blockNumber: receipt.blockNumber });
    return {
      chainId,
      transaction,
      receipt,
      directCall,
      canonicalBlockHash: canonical.hash,
      finalizedBlock: finalized.number,
    };
  } catch {
    // RPC messages can carry credentials. Unavailability proves neither payment nor failure.
    return null;
  }
}

/**
 * Direct calls to the configured, trusted EIP-3009 token only. Router/batch calls require a
 * separate attribution proof. This does not consume a claim or authorize releasing a resource;
 * the durable receive store still owns replay protection and workspace/resource binding.
 * Absence, reorgs and unfinalized receipts are uncertainty, never proof of failure.
 */
export function receivePaymentProven(binding: ReceiveBinding, evidence: ReceiveEvidence): boolean {
  const r = evidence.receipt;
  if (
    evidence.chainId !== binding.chainId ||
    !r ||
    r.status !== 'success' ||
    r.transactionHash.toLowerCase() !== evidence.transaction.toLowerCase() ||
    evidence.canonicalBlockHash?.toLowerCase() !== r.blockHash.toLowerCase() ||
    evidence.finalizedBlock === null ||
    r.blockNumber > evidence.finalizedBlock
  )
    return false;
  try {
    const token = getAddress(binding.token);
    const payer = getAddress(binding.payer);
    const recipient = getAddress(binding.recipient);
    const call = evidence.directCall;
    if (
      !call ||
      !call.to ||
      getAddress(call.to) !== token ||
      !r.to ||
      getAddress(r.to) !== token ||
      call.value !== 0n ||
      call.hash.toLowerCase() !== r.transactionHash.toLowerCase() ||
      call.blockHash?.toLowerCase() !== r.blockHash.toLowerCase() ||
      call.blockNumber !== r.blockNumber
    )
      return false;
    // Transaction-wide event co-occurrence alone cannot attribute a batched transfer to a nonce.
    const { args } = decodeFunctionData({ abi: authorizationAbi, data: call.input });
    if (
      getAddress(args[0]) !== payer ||
      getAddress(args[1]) !== recipient ||
      args[2] !== BigInt(binding.amount) ||
      args[5].toLowerCase() !== binding.nonce.toLowerCase()
    )
      return false;
    const logs = r.logs.filter(
      (log) =>
        getAddress(log.address) === token &&
        !log.removed &&
        log.transactionHash?.toLowerCase() === r.transactionHash.toLowerCase() &&
        log.blockHash?.toLowerCase() === r.blockHash.toLowerCase() &&
        log.blockNumber === r.blockNumber,
    );
    const events = parseEventLogs({ abi, logs, strict: true });
    const used = events.filter(
      (e) =>
        e.eventName === 'AuthorizationUsed' &&
        getAddress(e.args.authorizer) === payer &&
        e.args.nonce.toLowerCase() === binding.nonce.toLowerCase(),
    );
    const transfers = events.filter(
      (e) =>
        e.eventName === 'Transfer' &&
        getAddress(e.args.from) === payer &&
        getAddress(e.args.to) === recipient &&
        e.args.value === BigInt(binding.amount),
    );
    return used.length === 1 && transfers.length === 1;
  } catch {
    return false;
  }
}
