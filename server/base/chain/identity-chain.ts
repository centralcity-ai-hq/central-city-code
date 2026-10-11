/*
 * The chain side of ERC-8004 identities (decision (b′)): the agent's spender account registers the
 * identity, then transfers it to the agent's own wallet, which stays counterfactual (no deployment,
 * no extra cost). The registry sets agentWallet on registration and clears it on transfer; it is set
 * again later with the owner's next browser signature, so no extra click is needed here.
 *
 *   registerIdentities: ONE UserOp, register(uri) for up to 50 agents   → ids read from the receipt
 *   transferIdentities: ONE UserOp, transferFrom(spender, wallet, id)    for up to 50 identities
 *   provenMint:         read-only proof that one stored registration minted one id for its URI
 *
 * Both are ordinary durable operations (stored before broadcast, idempotent on the operation key).
 * The identity service persists `base_identities`; this module never writes it.
 */
import {
  encodeFunctionData,
  getAddress,
  parseAbi,
  parseEventLogs,
  type Hex,
  type PublicClient,
} from 'viem';
import { BASE_MAINNET, type Address } from '../../../shared/base/chains.js';
import type { DerivationRecipe } from './derive.js';
import { submitOperation, type StoredOperation, type SubmitDeps } from './submit.js';

export const identityRegistryAbi = parseAbi([
  'function register(string agentURI) returns (uint256)',
  'function transferFrom(address from, address to, uint256 tokenId)',
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function tokenURI(uint256 tokenId) view returns (string)',
  'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
]);

/** At most this many identities per operation (one UserOp stays well inside the gas limit). */
export const MAX_IDENTITIES_PER_OP = 50;
/** The short agent URI (`https://centralcity.ai/a/<6 base62>`) fits one storage slot. */
const MAX_URI_BYTES = 31;

export class IdentityChainError extends Error {
  constructor(
    readonly code:
      | 'NO_REGISTRY'
      | 'INVALID_BATCH'
      | 'FEE_BUDGET_REQUIRED'
      | 'NOT_INCLUDED'
      | 'IDS_INCOMPLETE'
      | 'IDENTITY_NOT_HELD',
    message: string,
  ) {
    super(message);
  }
}

export interface IdentityOperationInput {
  operationKey: string;
  intentHash: `0x${string}`;
  /** The agent's (or batch's) spender smart account that sends the operation. */
  spender: { address: Address; recipe: DerivationRecipe };
  maxCostWeiCap?: bigint;
  /** 2D nonce lane; a retry passes the first attempt's lane so at most one attempt can land. */
  nonceKey?: bigint;
  /** Replacement of an earlier attempt: its exact nonce (see SubmitInput.pinnedNonce). */
  pinnedNonce?: bigint;
  /** Current authority right before the first broadcast (see submitOperation). */
  beforeBroadcast?: () => Promise<void>;
}

function registryOf(deps: SubmitDeps): Address {
  const registry = deps.network.contracts.identityRegistry;
  if (!registry) throw new IdentityChainError('NO_REGISTRY', 'No identity registry here.');
  return registry;
}

function requireBudget(deps: SubmitDeps, cap: bigint | undefined) {
  // Real money is never spent without a fee budget: on the real network a cap is mandatory.
  if (deps.network.chainId === BASE_MAINNET && cap === undefined)
    throw new IdentityChainError('FEE_BUDGET_REQUIRED', 'Mainnet identities need a fee budget.');
}

function checkUris(uris: readonly string[]) {
  if (uris.length < 1 || uris.length > MAX_IDENTITIES_PER_OP)
    throw new IdentityChainError('INVALID_BATCH', `1 to ${MAX_IDENTITIES_PER_OP} identities.`);
  if (new Set(uris).size !== uris.length)
    throw new IdentityChainError('INVALID_BATCH', 'Each agent URI appears once.');
  for (const uri of uris)
    if (!/^https:\/\/[\x21-\x7e]+$/.test(uri) || Buffer.byteLength(uri) > MAX_URI_BYTES)
      throw new IdentityChainError('INVALID_BATCH', 'Agent URIs are short https URLs.');
}

/** Registers one identity per URI in a single operation from the spender account. */
export async function registerIdentities(
  deps: SubmitDeps,
  input: IdentityOperationInput & { uris: readonly string[] },
): Promise<StoredOperation> {
  const registry = registryOf(deps);
  checkUris(input.uris);
  requireBudget(deps, input.maxCostWeiCap);
  return submitOperation(deps, {
    idempotencyKey: input.operationKey,
    intentHash: input.intentHash,
    kind: 'register',
    account: input.spender,
    calls: input.uris.map((uri) => ({
      target: registry,
      value: 0n,
      data: encodeFunctionData({ abi: identityRegistryAbi, functionName: 'register', args: [uri] }),
    })),
    maxCostWeiCap: input.maxCostWeiCap,
    nonceKey: input.nonceKey,
    pinnedNonce: input.pinnedNonce,
    beforeBroadcast: input.beforeBroadcast,
  });
}

/**
 * The identity ids a included registration minted, by URI. Read from the operation's own receipt:
 * mints (Transfer from 0) to the spender, each matched to its URI through tokenURI, so another
 * operation in the same bundle can never be mistaken for ours. Throws unless every URI is found.
 */
export async function registeredIds(
  client: PublicClient,
  deps: Pick<SubmitDeps, 'network'>,
  stored: StoredOperation,
  uris: readonly string[],
): Promise<Map<string, bigint>> {
  const registry = registryOf(deps as SubmitDeps);
  if (!stored.txHash || (stored.status !== 'included' && stored.status !== 'final'))
    throw new IdentityChainError('NOT_INCLUDED', 'The registration is not included yet.');
  const receipt = await client.getTransactionReceipt({ hash: stored.txHash });
  const mints = parseEventLogs({
    abi: identityRegistryAbi,
    eventName: 'Transfer',
    logs: receipt.logs.filter((log) => getAddress(log.address) === registry),
  }).filter(
    (log) => BigInt(log.args.from) === 0n && getAddress(log.args.to) === getAddress(stored.sender),
  );
  const wanted = new Set(uris);
  const ids = new Map<string, bigint>();
  for (const mint of mints) {
    // Read at the receipt block: the holder may change the URI later, and only the URI the id had
    // when this operation minted it ties the id to the URI it was registered for.
    const uri = await client.readContract({
      address: registry,
      abi: identityRegistryAbi,
      functionName: 'tokenURI',
      args: [mint.args.tokenId],
      blockNumber: receipt.blockNumber,
    });
    // Every id returned has exactly the expected URI at that block.
    if (wanted.has(uri) && !ids.has(uri)) ids.set(uri, mint.args.tokenId);
  }
  if (ids.size !== wanted.size)
    throw new IdentityChainError('IDS_INCOMPLETE', 'Not every identity was found in the receipt.');
  return ids;
}

/** EntryPoint v0.6 events that delimit each operation's execution inside a bundle. */
const entryPointEvents = parseAbi([
  'event BeforeExecution()',
  'event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)',
]);

/** Why a stored registration does not prove a mint right now. None of these is a final verdict. */
export type MintGap =
  /** The stored row has no transaction or block yet. */
  | 'NOT_INCLUDED'
  /** The node returns no receipt for the stored transaction (not seen yet, reorged, or down). */
  | 'RECEIPT_MISSING'
  /** The receipt is in another block than the stored one; the row has not caught up yet. */
  | 'BLOCK_MOVED'
  /** Another block is canonical at the stored height now. */
  | 'NOT_CANONICAL'
  /** The receipt holds no single UserOperationEvent for the stored operation. */
  | 'NO_OPERATION_EVENT'
  /** The EntryPoint reports the operation as reverted, or for another sender. */
  | 'OPERATION_FAILED'
  /** Not exactly one registry mint to the sender inside the operation's own execution. */
  | 'NO_UNIQUE_MINT'
  /** tokenURI of the minted id at the receipt block is not the URI asked for. */
  | 'URI_MISMATCH'
  /** A read failed; nothing can be concluded. */
  | 'UNAVAILABLE';

export interface MintProof {
  txHash: Hex;
  blockNumber: bigint;
  blockHash: Hex;
  id: bigint;
  registry: Address;
  /** tokenURI of the id at the receipt block. */
  tokenUri: string;
  /** The id's holder at the latest block. */
  owner: Address;
}

const sameHex = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * Proves from the chain alone that a stored registration minted exactly one identity for `uri`:
 *
 *   - the receipt of the stored transaction is in the stored block, and that block is canonical
 *     now: the block at that height has the receipt's hash (a number alone does not survive a
 *     reorg to another block at the same height);
 *   - the EntryPoint's UserOperationEvent for the stored operation hash and sender says success;
 *   - exactly one registry mint (Transfer from 0) to the sender lies inside THIS operation's
 *     execution. EntryPoint v0.6 validates every operation of a bundle first, emits BeforeExecution
 *     once, then runs each operation and emits its UserOperationEvent right after it, so the
 *     operation's own logs are those after the previous UserOperationEvent (or BeforeExecution)
 *     and before its own. Mints of other operations in the bundle, even from the same sender, and
 *     anything emitted during validation, are outside that range;
 *   - tokenURI of that id, read at the receipt block, is `uri`.
 *
 * The holder at the latest block is reported with the proof. Never throws on a missing receipt or
 * a failed read: the answer is then a gap, never a proof.
 */
export async function provenMint(
  client: PublicClient,
  deps: Pick<SubmitDeps, 'network'>,
  stored: StoredOperation,
  uri: string,
): Promise<{ proof: MintProof } | { gap: MintGap }> {
  if (!stored.txHash || stored.blockNumber === null) return { gap: 'NOT_INCLUDED' };
  const registry = getAddress(registryOf(deps as SubmitDeps));
  const entryPoint = getAddress(deps.network.contracts.entryPointV06);
  const sender = getAddress(stored.sender);
  const blockNumber = BigInt(stored.blockNumber);
  const receipt = await client.getTransactionReceipt({ hash: stored.txHash }).catch(() => null);
  if (!receipt) return { gap: 'RECEIPT_MISSING' };
  if (receipt.blockNumber !== blockNumber) return { gap: 'BLOCK_MOVED' };

  try {
    const boundaries = parseEventLogs({
      abi: entryPointEvents,
      logs: receipt.logs.filter((log) => getAddress(log.address) === entryPoint),
    });
    const ours = boundaries.filter(
      (log) =>
        log.eventName === 'UserOperationEvent' && sameHex(log.args.userOpHash, stored.userOpHash),
    );
    const event = ours[0];
    if (ours.length !== 1 || event.eventName !== 'UserOperationEvent')
      return { gap: 'NO_OPERATION_EVENT' };
    if (!event.args.success || getAddress(event.args.sender) !== sender)
      return { gap: 'OPERATION_FAILED' };
    const start = boundaries
      .map((log) => log.logIndex)
      .filter((index) => index < event.logIndex)
      .reduce<number | null>((last, index) => (last === null || index > last ? index : last), null);
    // Without a BeforeExecution before it, this is not a v0.6 bundle as described: fail closed.
    if (start === null) return { gap: 'NO_OPERATION_EVENT' };
    const mints = parseEventLogs({
      abi: identityRegistryAbi,
      eventName: 'Transfer',
      logs: receipt.logs.filter(
        (log) =>
          getAddress(log.address) === registry &&
          log.logIndex > start &&
          log.logIndex < event.logIndex,
      ),
    }).filter((log) => BigInt(log.args.from) === 0n && getAddress(log.args.to) === sender);
    if (mints.length !== 1) return { gap: 'NO_UNIQUE_MINT' };
    const id = mints[0].args.tokenId;

    const tokenUri = await client.readContract({
      address: registry,
      abi: identityRegistryAbi,
      functionName: 'tokenURI',
      args: [id],
      blockNumber,
    });
    if (tokenUri !== uri) return { gap: 'URI_MISMATCH' };
    const owner = getAddress(
      await client.readContract({
        address: registry,
        abi: identityRegistryAbi,
        functionName: 'ownerOf',
        args: [id],
      }),
    );
    // Checked after every read at this height: a reorg in between makes the hash differ, so a
    // tokenURI read from a replaced block can never pass as proof.
    const block = await client.getBlock({ blockNumber });
    if (!block.hash || !sameHex(block.hash, receipt.blockHash)) return { gap: 'NOT_CANONICAL' };
    return {
      proof: {
        txHash: receipt.transactionHash,
        blockNumber,
        blockHash: receipt.blockHash,
        id,
        registry,
        tokenUri,
        owner,
      },
    };
  } catch {
    return { gap: 'UNAVAILABLE' };
  }
}

/**
 * Transfers identities from the spender account to each agent's wallet in a single operation.
 * Refused before anything is stored unless the spender still holds every identity (a transfer of
 * one it no longer holds would revert the whole operation).
 */
export async function transferIdentities(
  deps: SubmitDeps,
  input: IdentityOperationInput & { transfers: readonly { id: bigint; to: Address }[] },
): Promise<StoredOperation> {
  const registry = registryOf(deps);
  const { transfers } = input;
  if (transfers.length < 1 || transfers.length > MAX_IDENTITIES_PER_OP)
    throw new IdentityChainError('INVALID_BATCH', `1 to ${MAX_IDENTITIES_PER_OP} identities.`);
  if (new Set(transfers.map((t) => t.id)).size !== transfers.length)
    throw new IdentityChainError('INVALID_BATCH', 'Each identity appears once.');
  requireBudget(deps, input.maxCostWeiCap);
  const spender = getAddress(input.spender.address);
  // A retry of a stored operation never re-checks holdings: the stored operation is reconciled.
  if (!(await deps.store.get(input.operationKey)))
    for (const { id } of transfers) {
      const owner = await deps.client.readContract({
        address: registry,
        abi: identityRegistryAbi,
        functionName: 'ownerOf',
        args: [id],
      });
      if (getAddress(owner) !== spender)
        throw new IdentityChainError('IDENTITY_NOT_HELD', `Identity ${id} is not held here.`);
    }
  return submitOperation(deps, {
    idempotencyKey: input.operationKey,
    intentHash: input.intentHash,
    kind: 'transfer',
    account: input.spender,
    calls: transfers.map(({ id, to }) => ({
      target: registry,
      value: 0n,
      data: encodeFunctionData({
        abi: identityRegistryAbi,
        functionName: 'transferFrom',
        args: [spender, getAddress(to), id],
      }),
    })),
    maxCostWeiCap: input.maxCostWeiCap,
    nonceKey: input.nonceKey,
    pinnedNonce: input.pinnedNonce,
    beforeBroadcast: input.beforeBroadcast,
  });
}
