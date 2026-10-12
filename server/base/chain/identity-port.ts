/*
 * The chain module's side of the identity service (`IdentityChainPort`, server/base/identity):
 * register and hand over one agent's ERC-8004 identity through the agent's spender account. Every
 * call is keyed by the service's stable operation key: an operation already stored for that key is
 * only reconciled (finality refreshed, never signed or sent again). Keys stay in the keystore.
 * `mintEvidence` only reads: it proves from the chain whether a stored registration minted.
 * `identityAt` only reads too: an identity's owner and tokenURI at the finalized block.
 */
import {
  BaseError,
  ContractFunctionRevertedError,
  encodeAbiParameters,
  getAddress,
  keccak256,
  type Hex,
  type PublicClient,
} from 'viem';
import type { Database } from '../../database.js';
import type { Address, BaseChainId, BaseNetwork } from '../../../shared/base/chains.js';
import type { IdentityChainPort, IdentityOp } from '../identity/service.js';
import { deriveAddressLocal, spenderAccountRecipe } from './derive.js';
import {
  IdentityChainError,
  identityRegistryAbi,
  provenMint,
  registerIdentities,
  registeredIds,
  transferIdentities,
  type MintGap,
} from './identity-chain.js';
import {
  abandonBeforeBroadcast,
  canonicalOutcome,
  keystoreSigner,
  nonceLaneFor,
  SubmitError,
  refreshFinality,
  safeHead,
  headIsCanonical,
  type Bundler,
  type ChainOperationStore,
  type StoredOperation,
  type SubmitDeps,
} from './submit.js';
import { liveReads } from './rpc-budget.js';

export interface IdentityPortDeps {
  network: BaseNetwork;
  client: PublicClient;
  db: Database;
  operations: ChainOperationStore;
  bundler: Bundler;
  keystore: {
    withSigner<T>(
      ref: string,
      use: (account: import('viem/accounts').PrivateKeyAccount) => Promise<T>,
    ): Promise<T>;
  };
  /** The signer address behind a spender key ref (public data from the keystore table). */
  signerOf(keyRef: string): Promise<Address>;
  /** Fee budget per identity operation (wei); required on mainnet. */
  maxCostWeiCap?: bigint;
}

/**
 * How settled the block an operation landed in is: 'included' (in a block), 'safe' (on mainnet at
 * or below the 'safe' block; elsewhere the settled depth) or 'final' (finalized: status final, or a
 * revert made final). 'safe' is a separate signal and never changes what status 'final' means.
 */
export type IdentityOpFinality = 'included' | 'safe' | 'final';

/**
 * An identity operation as this port reports it: the service's IdentityOp plus where it landed.
 * Declared here as an extension so it stays compatible while the service's own type grows.
 */
export type IdentityChainOp = IdentityOp & {
  /** The block it landed in (decimal), for included, final and failed-after-inclusion operations. */
  blockNumber: string | null;
  /** How settled that block is; null whenever blockNumber is. */
  finality: IdentityOpFinality | null;
  /**
   * The canonical hash of that block, read from the chain (never the bundler's word): null when it
   * has not landed, or when the chain cannot confirm it right now (a read failed, the receipt names
   * another transaction or block or did not succeed, it holds no single event for this operation
   * with the stored outcome, or the canonical block at that height is another one).
   */
  blockHash: string | null;
  /** It landed and its UserOperation reverted (USEROP_REVERTED): included, nothing executed. */
  reverted: boolean;
};

export interface MintEvidenceInput {
  operationKey: string;
  chainId: BaseChainId;
  /** The agent URI the registration was for; the minted id must carry it at the receipt block. */
  uri: string;
}

/** What the chain shows for the registration stored under a key (see `mintEvidence`). */
export type MintEvidence =
  /** Nothing is stored for the key. */
  | { kind: 'none' }
  /** Not settled either way yet, or the chain cannot prove the mint right now. */
  | { kind: 'pending'; reason?: MintGap }
  /** Included and reverted, not final yet. */
  | { kind: 'reverted' }
  /**
   * Failed for good: a final revert, never broadcast, or a final consumed nonce that no earlier
   * attempt of the step landed on (each of them settled without landing).
   */
  | { kind: 'failed' }
  | {
      kind: 'minted';
      /** The attempt that minted (an earlier attempt when it used this attempt's nonce). */
      opKey: string;
      status: 'included' | 'final';
      finality: IdentityOpFinality;
      txHash: Hex;
      /** Decimal. */
      blockNumber: string;
      blockHash: Hex;
      /** The minted identity id, decimal. */
      id: string;
      registry: Address;
      /** tokenURI of the id at the receipt block (equal to the uri asked for). */
      tokenUri: string;
      /** The id's holder at the latest block. */
      owner: Address;
    };

export interface IdentityAtInput {
  chainId: BaseChainId;
  id: bigint;
  /** Only the finalized block is read; anything else is refused (also from untyped callers). */
  blockTag: 'finalized';
}

/**
 * What the chain says about an identity at one block (read-only). The identity service declares
 * the same shape for its `identityAt` port method.
 */
export interface IdentitySnapshot {
  owner: string;
  tokenUri: string;
  /** The block the read was made at (decimal) and its hash. */
  blockNumber: string;
  blockHash: string;
}

/** The identity service's chain port as this module implements it. */
export interface IdentityEvidencePort extends IdentityChainPort {
  register(input: Parameters<IdentityChainPort['register']>[0]): Promise<IdentityChainOp>;
  transfer(input: Parameters<IdentityChainPort['transfer']>[0]): Promise<IdentityChainOp>;
  /**
   * Read-only evidence for the registration stored under a key. It never signs, never fences a
   * key and never starts a replacement; it may refresh the stored operation's finality, which can
   * rebroadcast exactly the stored operation. Never throws on a missing receipt or RPC failure;
   * throws WRONG_NETWORK for another network, also when the key's stored row belongs to one.
   */
  mintEvidence(input: MintEvidenceInput): Promise<MintEvidence>;
  /**
   * The id's owner and tokenURI at the FINALIZED block, with that block's number and hash. Read
   * only: never signs, never touches the bundler. Both reads are pinned to that block's number and
   * the block is read again afterwards; a different hash then throws BLOCK_CHANGED. Throws NOT_FOUND
   * when ownerOf reverts at that block (no such token), UNAVAILABLE when a read fails.
   */
  identityAt(input: IdentityAtInput): Promise<IdentitySnapshot>;
}

export class IdentityPortError extends Error {
  constructor(
    readonly code:
      | 'WRONG_NETWORK'
      | 'WALLET_NOT_USABLE'
      | 'NOT_FOUND'
      | 'ATTEMPT_CONFLICT'
      | 'INVALID_BLOCK_TAG'
      | 'BLOCK_UNKNOWN'
      | 'BLOCK_CHANGED'
      | 'UNAVAILABLE',
    message: string,
  ) {
    super(message);
  }
}

/** Intent hashes bind each operation key to exactly what it does (a changed request is refused). */
export function registerIntentHash(chainId: number, spender: Address, uri: string): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: 'string' }, { type: 'uint256' }, { type: 'address' }, { type: 'string' }],
      ['identity-register-v1', BigInt(chainId), getAddress(spender), uri],
    ),
  );
}

export function transferIntentHash(
  chainId: number,
  spender: Address,
  id: bigint,
  to: Address,
): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: 'string' },
        { type: 'uint256' },
        { type: 'address' },
        { type: 'uint256' },
        { type: 'address' },
      ],
      ['identity-transfer-v1', BigInt(chainId), getAddress(spender), id, getAddress(to)],
    ),
  );
}

const sameHex = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** The call reverted on chain (as opposed to a transport or node failure). */
const reverted = (error: unknown): boolean =>
  error instanceof BaseError &&
  error.walk((e) => e instanceof ContractFunctionRevertedError) !== null;

const TERMINAL: readonly StoredOperation['status'][] = ['final', 'failed'];

/** Landed and executed: included or final, not reverted. */
const succeeded = (row: StoredOperation): boolean =>
  (row.status === 'included' || row.status === 'final') && row.errorCode !== 'USEROP_REVERTED';

const view = (row: StoredOperation): IdentityOp => ({
  idempotencyKey: row.idempotencyKey,
  // A reorged operation is not settled yet, and an included one that reverted did nothing: the
  // identity service treats both as reconciling ('included' always means it executed).
  status:
    row.status === 'reorged' || (row.status === 'included' && row.errorCode === 'USEROP_REVERTED')
      ? 'reconciling'
      : row.status,
  txHash: row.txHash,
});

/**
 * The block an operation landed in: for included and final operations, and for failed ones whose
 * revert was final. A row that moved on from an inclusion (reorged, nonce consumed) may still carry
 * that old block; it is not reported.
 */
const landedBlock = (row: StoredOperation): string | null =>
  row.status === 'included' ||
  row.status === 'final' ||
  (row.status === 'failed' && row.errorCode === 'USEROP_REVERTED')
    ? row.blockNumber
    : null;

/**
 * Every attempt of one identity step signs on the FIRST attempt's nonce lane, and every attempt after
 * the first signed one pins that attempt's exact nonce (see `replacing`). Identity keys are
 * `identity:<stage>:<chainId>:<agentId>` plus an optional `:<attempt>` (identity service); only the
 * first four parts choose the lane. A hand-over key names its identity inside the agent part
 * (`<agentId>~<id>`, never a ':'), so each identity handed over is a step of its own. Other keys
 * keep their own lane. This holds while the identity service runs one attempt of a step at a time
 * (its attempt fencing): attempts that sign concurrently cannot see each other's rows.
 */
/** The first attempt's key of an identity step (the key itself when it is the first attempt). */
export const firstAttemptKey = (operationKey: string): string => {
  const parts = operationKey.split(':');
  return parts[0] === 'identity' && parts.length > 4 ? parts.slice(0, 4).join(':') : operationKey;
};

/** The attempt number of an identity key: 0 for the first attempt, null for any other key. */
export function attemptOf(operationKey: string): number | null {
  const parts = operationKey.split(':');
  if (parts[0] !== 'identity' || parts.length < 4 || parts.length > 5) return null;
  if (parts.length === 4) return 0;
  return /^[1-9][0-9]{0,5}$/.test(parts[4]) ? Number(parts[4]) : null;
}

export const identityNonceLane = (operationKey: string): bigint =>
  nonceLaneFor(firstAttemptKey(operationKey));

export function createIdentityChainPort(deps: IdentityPortDeps): IdentityEvidencePort {
  function checkNetwork(chainId: number) {
    if (chainId !== deps.network.chainId)
      throw new IdentityPortError('WRONG_NETWORK', 'This port serves another network.');
  }

  /**
   * Final once the status says so; otherwise safe when the safe block has reached it AND that safe
   * block is on the chain now (its hash, read live by number): a shared safe head from another fork
   * or a rolled-back node never makes an inclusion look safe. Callers report 'safe' only together
   * with the receipt's block canonical at its height (describe: canonicalBlockHash; mintEvidence:
   * provenMint), so the receipt's block is an ancestor of the safe block.
   */
  async function finalityOf(
    status: StoredOperation['status'],
    blockNumber: bigint,
  ): Promise<IdentityOpFinality> {
    if (status === 'final' || status === 'failed') return 'final';
    const safe = await safeHead(deps).catch(() => null);
    if (safe === null || blockNumber > safe.number) return 'included';
    return (await headIsCanonical(deps, safe).catch(() => false)) ? 'safe' : 'included';
  }

  /**
   * The canonical hash of the block a landed operation is in, read from the chain with the same
   * evidence submit's finality uses (canonicalOutcome): the receipt of the stored transaction names
   * it at the stored block and succeeded, holds exactly one UserOperationEvent for the stored
   * operation (its sender, its nonce, and the outcome the row records: reverted or executed), and
   * the canonical block at that height (read last) is the receipt's block. Null otherwise, or when
   * a read fails; never throws.
   */
  async function canonicalBlockHash(
    row: StoredOperation,
    blockNumber: bigint,
  ): Promise<string | null> {
    if (!row.txHash) return null;
    const outcome = await canonicalOutcome(deps, row, {
      txHash: row.txHash,
      blockNumber,
      success: row.errorCode !== 'USEROP_REVERTED',
    }).catch(() => null);
    return outcome?.kind === 'agrees' ? outcome.blockHash : null;
  }

  /** Read-only: the chain is read only for an operation that landed; nothing is written. */
  async function describe(row: StoredOperation): Promise<IdentityChainOp> {
    const blockNumber = landedBlock(row);
    const landedAt = blockNumber === null ? null : BigInt(blockNumber);
    const [finality, blockHash] =
      landedAt === null
        ? [null, null]
        : await Promise.all([finalityOf(row.status, landedAt), canonicalBlockHash(row, landedAt)]);
    return {
      ...view(row),
      blockNumber,
      // 'safe' needs the receipt's block canonical too (finalityOf): without it, only included.
      finality: finality === 'safe' && blockHash === null ? 'included' : finality,
      blockHash,
      reverted: landedAt !== null && row.errorCode === 'USEROP_REVERTED',
    };
  }

  /** Reconciling only reads and rebroadcasts the stored operation; nothing is signed. */
  function readOnlyDeps(stored: StoredOperation): SubmitDeps {
    return {
      network: deps.network,
      client: deps.client,
      store: deps.operations,
      bundler: deps.bundler,
      signer: {
        address: getAddress(stored.signer),
        signUserOperation: async (): Promise<Hex> => {
          throw new Error('Reconciliation never signs.');
        },
      },
    };
  }

  async function sendingDeps(spenderKeyRef: string) {
    const signer = await deps.signerOf(spenderKeyRef);
    const submit: SubmitDeps = {
      network: deps.network,
      client: deps.client,
      store: deps.operations,
      bundler: deps.bundler,
      signer: keystoreSigner(
        deps.client,
        deps.keystore,
        spenderKeyRef,
        signer,
        deps.network.chainId,
      ),
    };
    return { submit, recipe: spenderAccountRecipe(deps.network, signer) };
  }

  /** The stored spender address must be the account its key derives to, or nothing is signed. */
  function checkSpender(spender: Address, recipe: ReturnType<typeof spenderAccountRecipe>) {
    if (deriveAddressLocal(recipe) !== spender)
      throw new IdentityPortError('WALLET_NOT_USABLE', 'The spender does not match its key.');
  }

  /** Current authority right before the first broadcast: the agent's wallet is still usable. */
  const walletUsable = (spender: Address) => async () => {
    const { rows } = await deps.db.query<{ state: string }>(
      'SELECT state FROM base_wallets WHERE spender_address = $1 AND chain_id = $2',
      [spender, deps.network.chainId],
    );
    if (!rows[0] || (rows[0].state !== 'derived' && rows[0].state !== 'deployed'))
      throw new IdentityPortError('WALLET_NOT_USABLE', 'The wallet is frozen, closed or gone.');
  };

  /**
   * A later attempt replaces the earlier ones of its step. Every earlier attempt's key is first
   * fenced: a key with no row gets a never-broadcast tombstone (insert-if-absent), so an older
   * worker still on its way to storing that attempt loses its insert and never sends. Then each
   * earlier row is bound to this step (network, kind, intent; sender when signed) and the nonce of
   * the signed ones is pinned: the first attempt may never have been signed while a later one was.
   * With none signed, every earlier key is fenced unsent and the next nonce is used. When the pinned
   * nonce is already used, nothing new is signed and the attempt that landed is reported instead.
   * A row that doesn't fit the step, or signed attempts on different nonces, refuse the
   * replacement before anything is signed.
   */
  async function replacing<T extends StoredOperation>(
    operationKey: string,
    step: { kind: StoredOperation['kind']; intentHash: Hex; spender: Address },
    send: (pinnedNonce: bigint | undefined) => Promise<T>,
  ): Promise<IdentityChainOp> {
    const attempt = attemptOf(operationKey);
    if (!attempt) return describe(await send(undefined));
    const firstKey = firstAttemptKey(operationKey);
    const keys = [firstKey];
    for (let n = 1; n < attempt; n++) keys.push(`${firstKey}:${n}`);
    const rows = await Promise.all(
      keys.map(
        async (key) =>
          (await deps.operations.get(key)) ??
          (
            await abandonBeforeBroadcast(deps.operations, {
              idempotencyKey: key,
              intentHash: step.intentHash,
              chainId: deps.network.chainId,
              kind: step.kind,
            })
          ).row,
      ),
    );
    const conflict = () =>
      new IdentityPortError('ATTEMPT_CONFLICT', 'An earlier attempt does not match this step.');
    for (const row of rows)
      if (
        row.chainId !== deps.network.chainId ||
        row.kind !== step.kind ||
        row.intentHash.toLowerCase() !== step.intentHash.toLowerCase()
      )
        throw conflict();
    const signed = rows.filter((row) => row.signedOperation !== '');
    if (signed.some((row) => getAddress(row.sender) !== step.spender)) throw conflict();

    // The current state of every signed earlier attempt decides what this one may do:
    //   one landed (not reverted)  → it is the step's outcome; nothing new is signed
    //   one still pending          → its nonce is pinned, so only one of them can ever land
    //   all dead (failed/reverted) → none can land any more; the next nonce is used
    //   one included but reverted, not final yet → it is reported; nothing is signed until the
    //                                                revert is final (a reorg could still change it)
    const decide = async (): Promise<
      { report: StoredOperation } | { report?: undefined; pinned: bigint | undefined }
    > => {
      const current = await Promise.all(signed.map(refreshed));
      const landed = current.find(succeeded) ?? current.find((row) => row.status === 'included');
      if (landed) return { report: landed };
      const pending = current.filter((row) => !TERMINAL.includes(row.status));
      if (new Set(pending.map((row) => row.nonce)).size > 1) throw conflict();
      return { pinned: pending[0] ? BigInt(pending[0].nonce) : undefined };
    };
    const first = await decide();
    if (first.report) return describe(first.report);
    try {
      return describe(await send(first.pinned));
    } catch (error) {
      if (!(error instanceof SubmitError && error.code === 'NONCE_MOVED')) throw error;
      // The pinned nonce was used meanwhile: by a pending attempt that landed or reverted (it is
      // reported), or by one whose revert is already final (then the next nonce is used).
      const again = await decide();
      if (again.report) return describe(again.report);
      if (again.pinned !== undefined && again.pinned === first.pinned) throw error;
      return describe(await send(again.pinned));
    }
  }

  /** A stored operation with its finality refreshed (read-only; nothing is signed). */
  async function refreshed(row: StoredOperation): Promise<StoredOperation> {
    return (await refreshFinality(readOnlyDeps(row), row.idempotencyKey)) ?? row;
  }

  /**
   * A row stored for another network is never reconciled through this port: its node would find
   * no receipt there and write RECEIPT_GONE or NONCE_CONSUMED onto a healthy row of that network
   * (every network shares one operations table, and the key and chain id are separate inputs).
   */
  function checkStoredNetwork(row: StoredOperation) {
    if (row.chainId !== deps.network.chainId)
      throw new IdentityPortError(
        'WRONG_NETWORK',
        'The operation stored under this key belongs to another network.',
      );
  }

  /**
   * The earlier attempts of a row's step that were signed on the same nonce (same intent, kind,
   * network and sender): the only operations of the step that can have used that nonce.
   */
  async function sameNonceAttempts(row: StoredOperation): Promise<StoredOperation[]> {
    const attempt = attemptOf(row.idempotencyKey);
    if (!attempt) return [];
    const firstKey = firstAttemptKey(row.idempotencyKey);
    const keys = [firstKey];
    for (let n = 1; n < attempt; n++) keys.push(`${firstKey}:${n}`);
    const siblings: StoredOperation[] = [];
    for (const key of keys) {
      const sibling = await deps.operations.get(key);
      if (
        sibling &&
        sibling.signedOperation !== '' &&
        sibling.intentHash.toLowerCase() === row.intentHash.toLowerCase() &&
        sibling.chainId === row.chainId &&
        sibling.kind === row.kind &&
        sibling.nonce === row.nonce &&
        getAddress(sibling.sender) === getAddress(row.sender)
      )
        siblings.push(sibling);
    }
    return siblings;
  }

  /**
   * What the earlier attempts that may have used a row's nonce show now, each refreshed (read
   * only): the first one that landed, else whether every one of them is settled for good without
   * landing. Throws when a refresh does (an RPC failure while reconciling).
   */
  async function nonceUsers(
    row: StoredOperation,
  ): Promise<{ landed: StoredOperation | null; allSettled: boolean }> {
    let allSettled = true;
    for (const sibling of await sameNonceAttempts(row)) {
      const current = await refreshed(sibling);
      if (succeeded(current)) return { landed: current, allSettled: true };
      if (!TERMINAL.includes(current.status)) allSettled = false;
    }
    return { landed: null, allSettled };
  }

  /**
   * An attempt whose nonce another attempt of its step used (NONCE_CONSUMED, reconciling or
   * failed) reports that attempt instead when it landed: the step did happen, under an earlier
   * key, and this attempt can never land on the same nonce.
   */
  async function outcomeOf(row: StoredOperation): Promise<StoredOperation> {
    if (row.errorCode !== 'NONCE_CONSUMED') return row;
    return (await nonceUsers(row)).landed ?? row;
  }

  /** Reconciles the operation stored under a key, reported as its step's real outcome. */
  async function reconcileStep(key: string): Promise<IdentityChainOp | null> {
    const stored = await deps.operations.get(key);
    if (!stored) return null;
    checkStoredNetwork(stored);
    return describe(await outcomeOf(await refreshed(stored)));
  }

  return {
    async register(input) {
      checkNetwork(input.chainId);
      const existing = await reconcileStep(input.operationKey);
      if (existing) return existing;
      const spender = getAddress(input.spender);
      const { submit, recipe } = await sendingDeps(input.spenderKeyRef);
      checkSpender(spender, recipe);
      const intentHash = registerIntentHash(input.chainId, spender, input.uri);
      return replacing(
        input.operationKey,
        { kind: 'register', intentHash, spender },
        (pinnedNonce) =>
          registerIdentities(submit, {
            operationKey: input.operationKey,
            nonceKey: identityNonceLane(input.operationKey),
            pinnedNonce,
            intentHash,
            spender: { address: spender, recipe },
            uris: [input.uri],
            maxCostWeiCap: deps.maxCostWeiCap,
            beforeBroadcast: walletUsable(spender),
          }),
      );
    },

    async registeredId(op, chainId, uri) {
      checkNetwork(chainId);
      const stored = await deps.operations.get(op.idempotencyKey);
      if (!stored) throw new IdentityPortError('NOT_FOUND', 'No stored registration.');
      checkStoredNetwork(stored);
      const ids = await registeredIds(deps.client, deps, stored, [uri]);
      return ids.get(uri)!;
    },

    async mintEvidence(input) {
      checkNetwork(input.chainId);
      const stored = await deps.operations.get(input.operationKey);
      if (!stored) return { kind: 'none' };
      if (stored.kind !== 'register')
        throw new IdentityPortError('NOT_FOUND', 'No registration is stored under this key.');
      checkStoredNetwork(stored);
      // Only reads and the stored operation's own reconciliation (which may rebroadcast it exactly
      // as stored) happen here; never `replacing`, which signs and fences keys. A failed refresh
      // keeps the row as stored: the chain checks below decide anyway.
      let row = await refreshed(stored).catch(() => stored);
      if (row.errorCode === 'NONCE_CONSUMED') {
        // Another operation used this attempt's nonce, possibly an earlier attempt that minted.
        // Its mint is the answer; the step failed only once every attempt that could have used
        // the nonce is settled without landing. One still in flight, or a refresh that failed
        // (an RPC hiccup, a log search that could not finish), leaves the step pending.
        const users = await nonceUsers(row).catch(() => null);
        if (!users) return { kind: 'pending' };
        if (users.landed) row = users.landed;
        else if (!users.allSettled || row.status !== 'failed') return { kind: 'pending' };
        else return { kind: 'failed' };
      }
      if (row.status === 'failed') return { kind: 'failed' };
      if (row.status === 'included' && row.errorCode === 'USEROP_REVERTED')
        return { kind: 'reverted' };
      if (row.status !== 'included' && row.status !== 'final') return { kind: 'pending' };
      const checked = await provenMint(deps.client, deps, row, input.uri);
      if ('gap' in checked) return { kind: 'pending', reason: checked.gap };
      const { proof } = checked;
      return {
        kind: 'minted',
        opKey: row.idempotencyKey,
        status: row.status,
        finality: await finalityOf(row.status, proof.blockNumber),
        txHash: proof.txHash,
        blockNumber: proof.blockNumber.toString(10),
        blockHash: proof.blockHash,
        id: proof.id.toString(10),
        registry: proof.registry,
        tokenUri: proof.tokenUri,
        owner: proof.owner,
      };
    },

    async identityAt(input) {
      checkNetwork(input.chainId);
      if (input.blockTag !== 'finalized')
        throw new IdentityPortError('INVALID_BLOCK_TAG', 'Only the finalized block is read.');
      const registry = deps.network.contracts.identityRegistry;
      if (!registry) throw new IdentityChainError('NO_REGISTRY', 'No identity registry here.');
      // A failed read becomes a fresh error without its cause: the node's message can carry the
      // RPC URL, and with it a key.
      const unavailable = () =>
        new IdentityPortError('UNAVAILABLE', 'The chain could not be read right now.');
      const rpc = async <T>(read: () => Promise<T>): Promise<T> => {
        try {
          return await read();
        } catch {
          throw unavailable();
        }
      };
      // Live, never the shared head (rpc-budget.ts): the hand-over may have been declared final by
      // another worker a moment ago, and an older finalized block would read as evidence_behind.
      const client = liveReads(deps.client);
      const block = await rpc(() => client.getBlock({ blockTag: 'finalized' }));
      if (block.number === null || block.number === undefined || !block.hash)
        throw new IdentityPortError('BLOCK_UNKNOWN', 'The finalized block has no number or hash.');
      const blockNumber: bigint = block.number;
      const blockHash: Hex = block.hash;
      // Checked after every read at this height: a node that served another block in between (a
      // lagging replica, another backend behind the same URL) makes the hash differ.
      const sameBlock = async () => {
        const again = await rpc(() => client.getBlock({ blockNumber }));
        if (!again.hash || !sameHex(again.hash, blockHash))
          throw new IdentityPortError('BLOCK_CHANGED', 'The block changed while it was read.');
      };
      const at = {
        address: registry,
        abi: identityRegistryAbi,
        args: [input.id] as const,
        blockNumber,
      };
      let owner: Address;
      try {
        owner = await client.readContract({ ...at, functionName: 'ownerOf' } as const);
      } catch (error) {
        if (!reverted(error)) throw unavailable();
        await sameBlock();
        throw new IdentityPortError('NOT_FOUND', 'No such identity at the finalized block.');
      }
      const tokenUri = await rpc(() =>
        client.readContract({ ...at, functionName: 'tokenURI' } as const),
      );
      await sameBlock();
      return {
        owner: getAddress(owner),
        tokenUri,
        blockNumber: blockNumber.toString(10),
        blockHash,
      };
    },

    async transfer(input) {
      checkNetwork(input.chainId);
      const existing = await reconcileStep(input.operationKey);
      if (existing) return existing;
      const spender = getAddress(input.spender);
      const { submit, recipe } = await sendingDeps(input.spenderKeyRef);
      checkSpender(spender, recipe);
      const intentHash = transferIntentHash(input.chainId, spender, input.id, getAddress(input.to));
      return replacing(
        input.operationKey,
        { kind: 'transfer', intentHash, spender },
        (pinnedNonce) =>
          transferIdentities(submit, {
            operationKey: input.operationKey,
            nonceKey: identityNonceLane(input.operationKey),
            pinnedNonce,
            intentHash,
            spender: { address: spender, recipe },
            transfers: [{ id: input.id, to: getAddress(input.to) }],
            maxCostWeiCap: deps.maxCostWeiCap,
            beforeBroadcast: walletUsable(spender),
          }),
      );
    },
  };
}
