/*
 * A simulated Base node behind `fetch`, for counting what one agent's registration costs in calls.
 * It serves both the configured (CDP) endpoint (JSON-RPC node + ERC-4337 bundler + ERC-7677
 * paymaster) and a second, keyless read endpoint, over ONE chain state, and records every JSON-RPC
 * call by endpoint and method. Nothing leaves the process; every value is synthetic.
 *
 * The chain: one block every 2 s of the (mocked) clock; 'safe' and 'finalized' trail the head by a
 * fixed number of blocks. A sent UserOperation lands `inclusionBlocks` after the head it was sent
 * at; its execution is decoded from the Coinbase Smart Wallet calldata (identity register and
 * transferFrom), so receipts carry the EntryPoint's BeforeExecution / UserOperationEvent around the
 * registry's Transfer, nonces move, accounts get code, ids get owners and token URIs.
 */
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionResult,
  getAddress,
  keccak256,
  numberToHex,
  parseAbi,
  toHex,
  type Hex,
} from 'viem';
import { getUserOperationHash } from 'viem/account-abstraction';
import type { Address } from '../shared/base/chains.js';

export const CDP_URL = 'https://cdp.test/rpc/test-token-0001';
export const FALLBACK_URL = 'https://fallback.test/rpc';

const walletAbi = parseAbi([
  'function execute(address target, uint256 value, bytes data)',
  'function executeBatch((address target, uint256 value, bytes data)[] calls)',
]);
const registryAbi = parseAbi([
  'function register(string agentURI) returns (uint256)',
  'function transferFrom(address from, address to, uint256 tokenId)',
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function tokenURI(uint256 tokenId) view returns (string)',
  'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
]);
const entryPointAbi = parseAbi([
  'function getNonce(address sender, uint192 key) view returns (uint256)',
  'event BeforeExecution()',
  'event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)',
]);

const ZERO = '0x0000000000000000000000000000000000000000' as Address;
const PAYMASTER = '0x00000000000000000000000000000000000000fa' as Address;
const BUNDLER_EOA = '0x00000000000000000000000000000000000000b0' as Address;
const BASE_FEE = 10_000_000n;
const BLOCK_MS = 2000;

export const blockHash = (n: bigint): Hex => keccak256(toHex(`block:${n}`));

interface Landed {
  userOpHash: Hex;
  sender: Address;
  nonce: bigint;
  txHash: Hex;
  block: bigint;
  hasInitCode: boolean;
  /** register: the minted id and its URI; transfer: the moved id and its new holder. */
  effects: Array<
    { kind: 'mint'; id: bigint; uri: string } | { kind: 'move'; id: bigint; to: Address }
  >;
}

export interface FakeNodeOptions {
  entryPoint: Address;
  registry: Address;
  chainId: number;
  /** The mocked clock (ms) the head is derived from. */
  now: () => number;
  /** The clock value at block `startBlock`. */
  startAt: number;
  startBlock?: bigint;
  safeLag?: bigint;
  finalLag?: bigint;
  /** Blocks after the head at send time until an operation lands (by its order of first send). */
  inclusionBlocks?: (sendIndex: number) => bigint;
  /** The second endpoint answers these tags with this fixed block (a node stuck on an old head). */
  fallbackStuckAt?: Partial<Record<'safe' | 'finalized', bigint>>;
}

export interface CallRecord {
  at: number;
  endpoint: 'cdp' | 'fallback';
  method: string;
  /** Who made it (set by the harness: 'owner', 'cron', ...). */
  actor: string;
  /** Answered with HTTP 429 (busy). */
  busy: boolean;
}

export function fakeBaseNode(options: FakeNodeOptions) {
  const startBlock = options.startBlock ?? 30_000_000n;
  const safeLag = options.safeLag ?? 30n;
  const finalLag = options.finalLag ?? 600n;
  const inclusion = options.inclusionBlocks ?? (() => 2n);
  const calls: CallRecord[] = [];
  let actor = 'none';
  /** The configured endpoint answers 429 while this returns true. */
  let cdpBusy: (method: string) => boolean = () => false;
  const pending = new Map<Hex, { op: Record<string, Hex>; landsAt: bigint; index: number }>();
  const landed: Landed[] = [];
  const sends: Hex[] = [];
  let nextId = 99_000n;

  const head = () => startBlock + BigInt(Math.floor((options.now() - options.startAt) / BLOCK_MS));
  const tagged = (tag: unknown): bigint | null => {
    const h = head();
    if (tag === undefined || tag === 'latest' || tag === 'pending') return h;
    if (tag === 'safe') return h - safeLag;
    if (tag === 'finalized') return h - finalLag;
    if (tag === 'earliest') return 0n;
    if (typeof tag === 'string' && /^0x[0-9a-f]+$/i.test(tag)) {
      if (tag.length === 66) return byHash.get(tag.toLowerCase()) ?? null;
      const n = BigInt(tag);
      return n <= h ? n : null;
    }
    if (tag && typeof tag === 'object') {
      const t = tag as { blockNumber?: string; blockHash?: string };
      if (t.blockHash) return byHash.get(t.blockHash.toLowerCase()) ?? null;
      if (t.blockNumber) return tagged(t.blockNumber);
    }
    return null;
  };
  const byHash = new Map<string, bigint>();
  const hashOf = (n: bigint) => {
    const hash = blockHash(n);
    byHash.set(hash.toLowerCase(), n);
    return hash;
  };

  /** Moves every pending operation whose block has come onto the chain. */
  function settle() {
    const h = head();
    for (const [hash, entry] of pending) {
      if (entry.landsAt > h) continue;
      pending.delete(hash);
      const op = entry.op;
      const sender = getAddress(op.sender);
      const effects: Landed['effects'] = [];
      const { functionName, args } = decodeFunctionData({ abi: walletAbi, data: op.callData });
      const inner =
        functionName === 'execute'
          ? [{ target: args[0], data: args[2] }]
          : (args[0] as readonly { target: Address; data: Hex }[]).map((c) => c);
      for (const call of inner) {
        if (getAddress(call.target) !== getAddress(options.registry)) continue;
        const decoded = decodeFunctionData({ abi: registryAbi, data: call.data });
        if (decoded.functionName === 'register')
          effects.push({ kind: 'mint', id: nextId++, uri: decoded.args[0] as string });
        if (decoded.functionName === 'transferFrom')
          effects.push({
            kind: 'move',
            id: decoded.args[2] as bigint,
            to: getAddress(decoded.args[1] as Address),
          });
      }
      landed.push({
        userOpHash: hash,
        sender,
        nonce: BigInt(op.nonce),
        txHash: keccak256(toHex(`tx:${hash}`)),
        block: entry.landsAt,
        hasInitCode: op.initCode !== '0x',
        effects,
      });
    }
  }

  const landedBy = (block: bigint) => landed.filter((l) => l.block <= block);
  const nonceAt = (sender: Address, key: bigint, block: bigint) => {
    const used = landedBy(block).filter(
      (l) => getAddress(l.sender) === getAddress(sender) && l.nonce >> 64n === key,
    ).length;
    return (key << 64n) | BigInt(used);
  };
  const ownerAt = (id: bigint, block: bigint): Address | null => {
    let owner: Address | null = null;
    for (const l of landedBy(block))
      for (const e of l.effects) {
        if (e.kind === 'mint' && e.id === id) owner = l.sender;
        if (e.kind === 'move' && e.id === id) owner = e.to;
      }
    return owner;
  };
  const uriOf = (id: bigint, block: bigint): string | null => {
    for (const l of landedBy(block))
      for (const e of l.effects) if (e.kind === 'mint' && e.id === id) return e.uri;
    return null;
  };

  const block = (n: bigint) => ({
    number: numberToHex(n),
    hash: hashOf(n),
    parentHash: hashOf(n - 1n),
    timestamp: numberToHex(BigInt(Math.floor(options.startAt / 1000)) + (n - startBlock) * 2n),
    baseFeePerGas: numberToHex(BASE_FEE),
    gasLimit: '0x1c9c380',
    gasUsed: '0x0',
    miner: ZERO,
    nonce: '0x0000000000000000',
    difficulty: '0x0',
    totalDifficulty: '0x0',
    extraData: '0x',
    logsBloom: `0x${'00'.repeat(256)}`,
    transactions: [],
    uncles: [],
    size: '0x0',
    stateRoot: hashOf(n),
    receiptsRoot: hashOf(n),
    transactionsRoot: hashOf(n),
    sha3Uncles: hashOf(n),
    mixHash: hashOf(n),
  });

  const logsOf = (l: Landed) => {
    const base = {
      blockNumber: numberToHex(l.block),
      blockHash: hashOf(l.block),
      transactionHash: l.txHash,
      transactionIndex: '0x0',
      removed: false,
    };
    const raw: Array<{ address: Address; topics: Hex[]; data: Hex }> = [
      {
        address: options.entryPoint,
        topics: encodeEventTopics({ abi: entryPointAbi, eventName: 'BeforeExecution' }) as Hex[],
        data: '0x',
      },
      ...l.effects.map((e) => ({
        address: options.registry,
        topics: encodeEventTopics({
          abi: registryAbi,
          eventName: 'Transfer',
          args:
            e.kind === 'mint'
              ? { from: ZERO, to: l.sender, tokenId: e.id }
              : { from: l.sender, to: e.to, tokenId: e.id },
        }) as Hex[],
        data: '0x' as Hex,
      })),
      {
        address: options.entryPoint,
        topics: encodeEventTopics({
          abi: entryPointAbi,
          eventName: 'UserOperationEvent',
          args: { userOpHash: l.userOpHash, sender: l.sender, paymaster: PAYMASTER },
        }) as Hex[],
        data: encodeAbiParameters(
          [{ type: 'uint256' }, { type: 'bool' }, { type: 'uint256' }, { type: 'uint256' }],
          [l.nonce, true, 21_000n * BASE_FEE, 21_000n],
        ),
      },
    ];
    return raw.map((log, i) => ({ ...log, ...base, logIndex: numberToHex(i) }));
  };

  const receiptOf = (l: Landed) => ({
    transactionHash: l.txHash,
    transactionIndex: '0x0',
    blockHash: hashOf(l.block),
    blockNumber: numberToHex(l.block),
    from: BUNDLER_EOA,
    to: options.entryPoint,
    cumulativeGasUsed: '0x5208',
    gasUsed: '0x5208',
    effectiveGasPrice: numberToHex(BASE_FEE),
    contractAddress: null,
    logs: logsOf(l),
    logsBloom: `0x${'00'.repeat(256)}`,
    status: '0x1',
    type: '0x2',
  });

  class RpcError extends Error {
    constructor(
      readonly code: number,
      message: string,
      readonly data?: Hex,
    ) {
      super(message);
    }
  }

  const BUNDLER_METHODS = new Set([
    'eth_sendUserOperation',
    'eth_estimateUserOperationGas',
    'eth_getUserOperationReceipt',
    'eth_getUserOperationByHash',
    'pm_getPaymasterStubData',
    'pm_getPaymasterData',
  ]);

  function answer(endpoint: 'cdp' | 'fallback', method: string, params: unknown[]): unknown {
    settle();
    if (endpoint === 'fallback' && BUNDLER_METHODS.has(method))
      throw new RpcError(-32601, 'method not found');
    switch (method) {
      case 'eth_chainId':
        return numberToHex(options.chainId);
      case 'eth_blockNumber':
        return numberToHex(head());
      case 'eth_maxPriorityFeePerGas':
        return '0x186a0';
      case 'eth_gasPrice':
        return numberToHex(BASE_FEE + 100_000n);
      case 'eth_getBlockByNumber':
      case 'eth_getBlockByHash': {
        const stuck =
          endpoint === 'fallback' && method === 'eth_getBlockByNumber'
            ? options.fallbackStuckAt?.[params[0] as 'safe' | 'finalized']
            : undefined;
        if (stuck !== undefined) return block(stuck);
        const n = tagged(params[0]);
        return n === null ? null : block(n);
      }
      case 'eth_getCode': {
        const at = tagged(params[1]);
        if (at === null) throw new RpcError(-32000, 'header not found');
        const deployed = landedBy(at).some(
          (l) => l.hasInitCode && getAddress(l.sender) === getAddress(params[0] as Address),
        );
        return deployed ? '0x6080' : '0x';
      }
      case 'eth_call': {
        const call = params[0] as { to: Address; data: Hex };
        const at = tagged(params[1]);
        if (at === null) throw new RpcError(-32000, 'header not found');
        if (getAddress(call.to) === getAddress(options.entryPoint)) {
          const { args } = decodeFunctionData({ abi: entryPointAbi, data: call.data });
          const [sender, key] = args as readonly [Address, bigint];
          return encodeFunctionResult({
            abi: entryPointAbi,
            functionName: 'getNonce',
            result: nonceAt(sender, key, at),
          });
        }
        if (getAddress(call.to) === getAddress(options.registry)) {
          const decoded = decodeFunctionData({ abi: registryAbi, data: call.data });
          const id = decoded.args[0] as bigint;
          if (decoded.functionName === 'ownerOf') {
            const owner = ownerAt(id, at);
            if (!owner) throw new RpcError(3, 'execution reverted', '0x7e273289');
            return encodeFunctionResult({
              abi: registryAbi,
              functionName: 'ownerOf',
              result: owner,
            });
          }
          if (decoded.functionName === 'tokenURI') {
            const uri = uriOf(id, at);
            if (uri === null) throw new RpcError(3, 'execution reverted', '0x7e273289');
            return encodeFunctionResult({
              abi: registryAbi,
              functionName: 'tokenURI',
              result: uri,
            });
          }
        }
        throw new RpcError(3, 'execution reverted', '0x');
      }
      case 'eth_getTransactionReceipt': {
        const hit = landed.find((l) => l.txHash.toLowerCase() === String(params[0]).toLowerCase());
        return hit ? receiptOf(hit) : null;
      }
      case 'eth_getLogs': {
        const filter = params[0] as { topics?: Array<Hex | null>; fromBlock?: Hex; toBlock?: Hex };
        const from = filter.fromBlock ? BigInt(filter.fromBlock) : 0n;
        const to = filter.toBlock ? BigInt(filter.toBlock) : head();
        const wanted = filter.topics?.[1]?.toLowerCase();
        return landed
          .filter((l) => l.block >= from && l.block <= to && l.block <= head())
          .filter((l) => !wanted || l.userOpHash.toLowerCase() === wanted)
          .map((l) => logsOf(l).at(-1));
      }
      case 'pm_getPaymasterStubData':
      case 'pm_getPaymasterData':
        return { paymasterAndData: `${PAYMASTER}${'00'.repeat(64)}` };
      case 'eth_estimateUserOperationGas':
        return {
          callGasLimit: '0x30000',
          verificationGasLimit: '0x60000',
          preVerificationGas: '0x10000',
        };
      case 'eth_sendUserOperation': {
        const op = params[0] as Record<string, Hex>;
        const hash = getUserOperationHash({
          chainId: options.chainId,
          entryPointAddress: options.entryPoint,
          entryPointVersion: '0.6',
          userOperation: {
            sender: op.sender,
            nonce: BigInt(op.nonce),
            initCode: op.initCode,
            callData: op.callData,
            callGasLimit: BigInt(op.callGasLimit),
            verificationGasLimit: BigInt(op.verificationGasLimit),
            preVerificationGas: BigInt(op.preVerificationGas),
            maxFeePerGas: BigInt(op.maxFeePerGas),
            maxPriorityFeePerGas: BigInt(op.maxPriorityFeePerGas),
            paymasterAndData: op.paymasterAndData,
            signature: op.signature,
          },
        });
        sends.push(hash);
        if (landed.some((l) => l.userOpHash === hash)) return hash;
        if (!pending.has(hash)) {
          const index = new Set(sends).size - 1;
          pending.set(hash, { op, landsAt: head() + inclusion(index), index });
        }
        return hash;
      }
      case 'eth_getUserOperationReceipt': {
        const hit = landed.find(
          (l) => l.userOpHash.toLowerCase() === String(params[0]).toLowerCase(),
        );
        if (!hit) return null;
        return {
          success: true,
          actualGasCost: numberToHex(21_000n * BASE_FEE),
          actualGasUsed: numberToHex(21_000n),
          receipt: { transactionHash: hit.txHash, blockNumber: numberToHex(hit.block) },
        };
      }
      default:
        throw new RpcError(-32601, `method not found: ${method}`);
    }
  }

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  /** The `fetch` both endpoints are reached through. */
  const fetchImpl = async (input: unknown, init?: { body?: unknown }): Promise<Response> => {
    const url = String(input instanceof Request ? input.url : input);
    const endpoint = url.startsWith(CDP_URL)
      ? 'cdp'
      : url.startsWith(FALLBACK_URL)
        ? 'fallback'
        : null;
    if (!endpoint) throw new Error('The harness reaches no other host.');
    const raw = JSON.parse(String(init?.body ?? '{}')) as
      | { id: number; method: string; params?: unknown[] }
      | Array<{ id: number; method: string; params?: unknown[] }>;
    const one = (request: { id: number; method: string; params?: unknown[] }) => {
      try {
        return {
          jsonrpc: '2.0',
          id: request.id,
          result: answer(endpoint, request.method, request.params ?? []),
        };
      } catch (error) {
        if (!(error instanceof RpcError)) throw error;
        return {
          jsonrpc: '2.0',
          id: request.id,
          error: {
            code: error.code,
            message: error.message,
            ...(error.data ? { data: error.data } : {}),
          },
        };
      }
    };
    const requests = Array.isArray(raw) ? raw : [raw];
    const busy = endpoint === 'cdp' && requests.some((r) => cdpBusy(r.method));
    for (const request of requests)
      calls.push({ at: options.now(), endpoint, method: request.method, actor, busy });
    if (busy) return json({ error: 'Too Many Requests' }, 429);
    return json(Array.isArray(raw) ? raw.map(one) : one(raw));
  };

  return {
    fetch: fetchImpl as typeof fetch,
    calls,
    head,
    landed,
    /** Distinct operations ever sent (a resend of the same operation counts once). */
    distinctSends: () => new Set(sends).size,
    setActor(name: string) {
      actor = name;
    },
    setCdpBusy(rule: (method: string) => boolean) {
      cdpBusy = rule;
    },
  };
}

/** Calls per endpoint and method, for the report. */
export function tally(
  calls: readonly CallRecord[],
  filter: (c: CallRecord) => boolean = () => true,
) {
  const out: Record<string, number> = {};
  for (const call of calls.filter(filter)) {
    const key = `${call.endpoint} ${call.method}`;
    out[key] = (out[key] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(out).sort((a, b) => b[1] - a[1]));
}
