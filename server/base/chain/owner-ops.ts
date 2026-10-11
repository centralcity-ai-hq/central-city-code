/*
 * Owner operations (Operation Base Wallet W2): UserOperations FROM an agent wallet, authorized by
 * the wallet's owner key. That key lives only in the browser (the owner vault); the server never
 * holds it. Two phases, both on the chain module's durable path (submit.ts):
 *
 *   prepare  the unsigned, sponsored operation on the wallet's owner nonce lane, with the wallet's
 *            initCode while it has no code; a refused, unreachable or empty sponsorship, or one
 *            that isn't a pinned paymaster charging the wallet nothing (shared/base/paymasters.ts),
 *            fails closed (SPONSORSHIP_UNAVAILABLE). An owner-funded operation (no paymaster) is prepared
 *            only when explicitly asked for; the same fee caps either way; nothing is signed or
 *            stored
 *   submit   that exact operation with the owner's signature over its raw userOpHash, wrapped as
 *            SignatureWrapper{ownerIndex, signatureData}; stored before broadcast, idempotent per key
 *   refresh  reconcile and finality of a stored operation; never signs
 *
 * Every owner operation of a wallet uses ONE nonce lane, so two owner operations prepared at the
 * same time share a nonce and at most one of them can ever land (an unsigned one the browser may
 * still hold included). A cancel is the wallet's no-op pinned to the withdrawal's nonce. With pay
 * without waiting (CITY_BASE_LANES=1, wallet/withdrawals.ts) an operation may instead name its own
 * lane (`nonceKey`, shared/base/lanes.ts): never the shared lane 0, never the replayable key 8453;
 * its cancel is pinned to its full nonce in that lane.
 *
 * On mainnet nothing is prepared or sent without a cost cap (FEE_BUDGET_REQUIRED), like identity
 * operations, agent payments and fleet batches: real money is never spent without a fee budget.
 *
 * The bundler URL carries a key: no error from here repeats an RPC or bundler message.
 */
import {
  decodeFunctionResult,
  encodeFunctionData,
  getAddress,
  parseAbi,
  type Hex,
  type PublicClient,
} from 'viem';
import { getUserOperationHash, type UserOperation } from 'viem/account-abstraction';
import { BASE_MAINNET, type Address, type BaseNetwork } from '../../../shared/base/chains.js';
import { usableLaneKey } from '../../../shared/base/lanes.js';
import {
  SPONSOR_PAYMASTERS,
  sponsoredWithoutCharge,
  sponsoredWithinDeadline,
  type SponsorAllowlist,
} from '../../../shared/base/paymasters.js';
import { deriveAddressLocal, type DerivationRecipe } from './derive.js';
import { BundlerError, SponsorError } from './rpc-bundler.js';
import {
  canonicalOutcome,
  nonceLaneFor,
  ownerSignatureSigner,
  prepareOperation,
  refreshFinality,
  submitOperation,
  SubmitError,
  type Bundler,
  type Call,
  type ChainOperationStore,
  type StoredOperation,
  type SubmitDeps,
} from './submit.js';

/** The one nonce lane of every owner operation of a wallet (never the wallet's replayable lane). */
export const OWNER_NONCE_KEY = nonceLaneFor('cc.base.wallet.owner-ops.v1');
const entryPointNonceAbi = parseAbi([
  'function getNonce(address sender, uint192 key) view returns (uint256 nonce)',
]);
/** The sequence part of a 2D nonce (its low 64 bits). */
const NONCE_SEQ = 2n ** 64n - 1n;
/** A safe-head proof that takes longer than this answers null (Base can't tell right now). */
export const SAFE_PROOF_TIMEOUT_MS = 5_000;

export type OwnerOperationErrorCode =
  /** Fees or the operation's cost bound are above the configured cap; nothing was prepared. */
  | 'FEE_CAP'
  /** Mainnet without a cost cap: nothing is prepared or sent (the runtime never builds one). */
  | 'FEE_BUDGET_REQUIRED'
  /** The paymaster refused, could not be reached or sponsored nothing; nothing was prepared. */
  | 'SPONSORSHIP_UNAVAILABLE'
  /** The pinned nonce was already used (a cancel whose withdrawal already landed). */
  | 'NONCE_MOVED'
  /** The lane named is not one an owner operation may use (0, 8453, out of range, mismatched). */
  | 'LANE_REFUSED'
  /** The stored derivation does not produce this wallet. */
  | 'WALLET_MISMATCH'
  /** The signature is not the owner's over this exact operation. */
  | 'SIGNATURE_MISMATCH'
  /** The key was used for another operation. */
  | 'IDEMPOTENCY_CONFLICT'
  /** The chain, bundler or paymaster could not be reached or answered something unusable. */
  | 'UNAVAILABLE';

export class OwnerOperationError extends Error {
  constructor(
    readonly code: OwnerOperationErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface PreparedOwnerOperation {
  /** Unsigned (`signature: '0x'`); `paymasterAndData` set when sponsored. */
  operation: UserOperation<'0.6'>;
  /** The raw hash the owner key signs. */
  userOpHash: Hex;
  /**
   * A paymaster pays the gas. When false the wallet prefunds it from its own ETH and can be charged
   * up to `maxCostWei` (the unused part comes back to it).
   */
  sponsored: boolean;
  maxCostWei: bigint;
  /** The wallet had code when prepared (otherwise the operation deploys it). */
  deployed: boolean;
}

export interface OwnerOperationsPort {
  readonly chainId: number;
  readonly entryPoint: Address;
  /** Checks a stored sponsorship against its original deadline before accepting a signature. */
  sponsorshipValid?(paymasterAndData: string | undefined, deadline: number): boolean;
  prepare(input: {
    wallet: Address;
    recipe: DerivationRecipe;
    calls: Call[];
    /** For a cancel: the nonce of the operation it replaces. */
    pinnedNonce?: bigint;
    /**
     * The operation's own nonce lane (pay without waiting); default the one owner lane. A pinned
     * nonce must be in it.
     */
    nonceKey?: bigint;
    /** For a cancel: the fees it must reach to replace that operation in a bundler's pool. */
    feeFloor?: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint };
    /**
     * Sponsored only by default: a refused, unreachable or empty sponsorship is
     * SPONSORSHIP_UNAVAILABLE and nothing is prepared. true: an owner-funded operation (no
     * paymaster; the wallet prefunds its own gas). Only the withdrawal service asks for that, and
     * only behind its owner-funded fallback setting (wallet/withdrawals.ts); this port never
     * falls back by itself.
     */
    ownerFunded?: true;
    /** Fixed signing deadline in milliseconds; never recomputed for retries. */
    sponsorshipDeadline?: number;
  }): Promise<PreparedOwnerOperation>;
  /** Whether an address has code (null when the chain cannot tell right now). */
  isContract(address: Address): Promise<boolean | null>;
  /**
   * Whether an included operation is settled at Base's safe head (the newest block whose batch is
   * on L1), proven for THIS operation with the evidence finality uses (canonicalOutcome in
   * submit.ts): the transaction succeeded and holds exactly one UserOperationEvent of the pinned
   * EntryPoint for this userOpHash, sender and nonce with the recorded outcome; its block is the
   * canonical one at that height, at or below the safe head; and the sender's nonce read at the
   * safe head is on the operation's own lane (the same key) and past its sequence. All of it on one
   * chain view: the nonce is read at the safe block's hash, and that block and the operation's are
   * checked canonical again at the end. False when not (yet) or when anything contradicts it, null
   * when Base cannot tell right now or the proof takes over 5 s. Optional: without it every
   * included operation counts as unsettled.
   */
  settledAtSafe?(input: {
    sender: Address;
    nonce: bigint;
    userOpHash: Hex;
    txHash: Hex;
    blockNumber: bigint;
    /** The outcome recorded for it: false for a reverted operation (its nonce is used too). */
    success: boolean;
  }): Promise<boolean | null>;
  /** Stores and sends a prepared operation with the owner's signature (idempotent per key). */
  submit(input: {
    idempotencyKey: string;
    intentHash: Hex;
    kind: 'withdraw' | 'withdraw_cancel' | 'rate';
    wallet: Address;
    recipe: DerivationRecipe;
    calls: Call[];
    operation: UserOperation<'0.6'>;
    userOpHash: Hex;
    owner: Address;
    ownerIndex: number;
    /** 65 bytes over the raw userOpHash. */
    signature: Hex;
    /** The lane it was prepared in (default the one owner lane); its nonce must be in it. */
    nonceKey?: bigint;
  }): Promise<StoredOperation>;
  /** The stored operation with its inclusion and finality brought up to date; never signs. */
  refresh(idempotencyKey: string): Promise<StoredOperation | null>;
}

export interface OwnerOperationsDeps {
  network: BaseNetwork;
  client: PublicClient;
  store: ChainOperationStore;
  bundler: Bundler;
  /**
   * Upper bound on one owner operation's cost (wei); above it nothing is prepared or sent. Required
   * on mainnet: without it nothing is prepared or sent there (FEE_BUDGET_REQUIRED).
   */
  maxCostWeiCap?: bigint;
  /** The paymasters that may sponsor (tests pass their own); default the pinned ones. */
  sponsors?: SponsorAllowlist;
  /** How long one safe-head proof may take before it answers null (default 5 s). */
  proofTimeoutMs?: number;
  now?: () => number;
}

/** Maps chain-module failures to the port's codes; any other failure is UNAVAILABLE. */
function classify(error: unknown): OwnerOperationError {
  if (error instanceof OwnerOperationError) return error;
  if (error instanceof BundlerError && error.code === 'FEE_CAP_EXCEEDED')
    return new OwnerOperationError('FEE_CAP', 'Network fees are above the cap right now.');
  if (error instanceof SubmitError) {
    if (error.code === 'COST_CAP_EXCEEDED')
      return new OwnerOperationError('FEE_CAP', 'The operation could cost more than the cap.');
    if (error.code === 'NONCE_MOVED')
      return new OwnerOperationError('NONCE_MOVED', 'That nonce was already used.');
    if (error.code === 'SIGNATURE_MISMATCH')
      return new OwnerOperationError('SIGNATURE_MISMATCH', error.message);
    if (error.code === 'IDEMPOTENCY_CONFLICT')
      return new OwnerOperationError('IDEMPOTENCY_CONFLICT', error.message);
  }
  return new OwnerOperationError('UNAVAILABLE', 'Base could not be reached right now.');
}

export function createOwnerOperationsPort(deps: OwnerOperationsDeps): OwnerOperationsPort {
  const entryPoint = deps.network.contracts.entryPointV06;
  const chainId = deps.network.chainId;
  const sponsors = deps.sponsors ?? SPONSOR_PAYMASTERS;
  const notSponsored = () =>
    new OwnerOperationError(
      'SPONSORSHIP_UNAVAILABLE',
      'The network fee cannot be sponsored right now.',
    );
  /** Real money is never spent without a fee budget: on mainnet a cost cap is mandatory. */
  function requireBudget() {
    if (chainId === BASE_MAINNET && deps.maxCostWeiCap === undefined)
      throw new OwnerOperationError(
        'FEE_BUDGET_REQUIRED',
        'Owner operations on Base need a fee budget.',
      );
  }

  function checkWallet(wallet: Address, recipe: DerivationRecipe): Address {
    const address = getAddress(wallet);
    let derived: Address;
    try {
      derived = deriveAddressLocal(recipe);
    } catch {
      throw new OwnerOperationError('WALLET_MISMATCH', 'The wallet recipe is not usable.');
    }
    if (derived !== address)
      throw new OwnerOperationError('WALLET_MISMATCH', 'The recipe does not derive this wallet.');
    return address;
  }

  /** The operation's lane: the one owner lane, or a usable lane of its own; a pin must be in it. */
  function laneOf(nonceKey: bigint | undefined, nonce: bigint | undefined): bigint {
    const key = nonceKey ?? OWNER_NONCE_KEY;
    if (key !== OWNER_NONCE_KEY && !usableLaneKey(key))
      throw new OwnerOperationError('LANE_REFUSED', 'That nonce lane is not one to use.');
    if (nonce !== undefined && nonce >> 64n !== key)
      throw new OwnerOperationError('LANE_REFUSED', 'The nonce is not in the operation’s lane.');
    return key;
  }

  return {
    chainId,
    entryPoint,
    sponsorshipValid: (data, deadline) =>
      sponsoredWithinDeadline(chainId, data, { now: (deps.now ?? Date.now)(), deadline }, sponsors),

    async prepare(input) {
      requireBudget();
      const wallet = checkWallet(input.wallet, input.recipe);
      const nonceKey = laneOf(input.nonceKey, input.pinnedNonce);
      const attempt = (sponsor: boolean) =>
        prepareOperation(deps, {
          account: { address: wallet, recipe: input.recipe },
          calls: input.calls,
          nonceKey,
          pinnedNonce: input.pinnedNonce,
          // The same caps on both paths: whoever pays, nothing above them is prepared.
          maxCostWeiCap: deps.maxCostWeiCap,
          feeFloor: input.feeFloor,
          sponsor,
        });
      const sponsored = input.ownerFunded !== true;
      let prepared;
      try {
        prepared = await attempt(sponsored);
      } catch (error) {
        // Fees covered or nothing: a refused or unreachable paymaster is never retried unsponsored
        // here. Fee caps and every other failure keep their own codes.
        if (error instanceof SponsorError) throw notSponsored();
        throw classify(error);
      }
      // Sponsored means a pinned paymaster charging the wallet nothing: an empty answer, an
      // unknown paymaster or one set to take a token is no sponsorship.
      if (
        sponsored &&
        !sponsoredWithoutCharge(chainId, prepared.operation.paymasterAndData, sponsors)
      )
        throw notSponsored();
      if (
        sponsored &&
        input.sponsorshipDeadline !== undefined &&
        !sponsoredWithinDeadline(
          chainId,
          prepared.operation.paymasterAndData,
          { now: (deps.now ?? Date.now)(), deadline: input.sponsorshipDeadline },
          sponsors,
        )
      )
        throw notSponsored();
      return {
        sponsored,
        operation: prepared.operation,
        userOpHash: getUserOperationHash({
          chainId,
          entryPointAddress: entryPoint,
          entryPointVersion: '0.6',
          userOperation: prepared.operation,
        }),
        maxCostWei: prepared.maxCostWei,
        deployed: prepared.deployed,
      };
    },

    async isContract(address) {
      try {
        return (await deps.client.getCode({ address: getAddress(address) })) !== undefined;
      } catch {
        return null;
      }
    },

    async settledAtSafe(input) {
      // One chain view: the safe block by number AND hash; the nonce read at exactly that hash
      // (EIP-1898); both blocks re-checked as canonical at the end. Anything else is not proof.
      const proof = async (): Promise<boolean | null> => {
        const safeBlock = await deps.client.getBlock({ blockTag: 'safe' });
        const safe = safeBlock.number;
        const safeHash = safeBlock.hash;
        if (safe === null || safe === undefined || !safeHash) return null;
        if (input.blockNumber > safe) return false;
        // The receipt is this operation's own, in the canonical block at its height: a cancel's
        // or any other operation's transaction never proves it.
        const canonical = await canonicalOutcome(
          { network: deps.network, client: deps.client },
          {
            userOpHash: input.userOpHash,
            sender: getAddress(input.sender),
            nonce: input.nonce.toString(10),
          },
          { txHash: input.txHash, blockNumber: input.blockNumber, success: input.success },
        );
        if (canonical.kind === 'unknown') return null;
        if (canonical.kind !== 'agrees') return false;
        // Its nonce is used at that safe block, on its own lane: nothing can reuse it any more.
        const raw = (await deps.client.request({
          method: 'eth_call',
          params: [
            {
              to: entryPoint,
              data: encodeFunctionData({
                abi: entryPointNonceAbi,
                functionName: 'getNonce',
                args: [getAddress(input.sender), input.nonce >> 64n],
              }),
            },
            { blockHash: safeHash },
          ],
        } as never)) as Hex;
        const next = decodeFunctionResult({
          abi: entryPointNonceAbi,
          functionName: 'getNonce',
          data: raw,
        });
        if (next >> 64n !== input.nonce >> 64n) return false;
        if ((next & NONCE_SEQ) <= (input.nonce & NONCE_SEQ)) return false;
        // Still the same chain: the safe block and the operation's block are canonical now.
        const [safeNow, opNow] = await Promise.all([
          deps.client.getBlock({ blockNumber: safe }),
          deps.client.getBlock({ blockNumber: input.blockNumber }),
        ]);
        if (safeNow.hash !== safeHash || opNow.hash !== canonical.blockHash) return false;
        return true;
      };
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          proof(),
          new Promise<null>((resolve) => {
            timer = setTimeout(() => resolve(null), deps.proofTimeoutMs ?? SAFE_PROOF_TIMEOUT_MS);
            timer.unref?.();
          }),
        ]);
      } catch {
        return null;
      } finally {
        if (timer) clearTimeout(timer);
      }
    },

    async submit(input) {
      requireBudget();
      const wallet = checkWallet(input.wallet, input.recipe);
      const nonceKey = laneOf(input.nonceKey, input.operation.nonce);
      // Only what prepare can produce: no paymaster (the owner-funded fallback) or an allowed one
      // charging nothing.
      const paymasterAndData = input.operation.paymasterAndData ?? '0x';
      if (paymasterAndData !== '0x' && !sponsoredWithoutCharge(chainId, paymasterAndData, sponsors))
        throw notSponsored();
      const submit: SubmitDeps = {
        ...deps,
        signer: ownerSignatureSigner({
          owner: input.owner,
          ownerIndex: input.ownerIndex,
          signature: input.signature,
          userOpHash: input.userOpHash,
          chainId,
          entryPoint,
        }),
      };
      try {
        return await submitOperation(submit, {
          idempotencyKey: input.idempotencyKey,
          intentHash: input.intentHash,
          kind: input.kind,
          account: { address: wallet, recipe: input.recipe },
          calls: input.calls,
          nonceKey,
          pinnedNonce: input.operation.nonce,
          prepared: input.operation,
          maxCostWeiCap: deps.maxCostWeiCap,
          // The owner can always withdraw (contract decision 4): no authority beyond the owner's
          // own signature applies at broadcast, also for a frozen wallet.
          beforeBroadcast: async () => {},
        });
      } catch (error) {
        throw classify(error);
      }
    },

    async refresh(idempotencyKey) {
      const readOnly: SubmitDeps = {
        ...deps,
        signer: {
          address: '0x0000000000000000000000000000000000000000',
          signUserOperation: async () => {
            throw new Error('Reconciliation never signs.');
          },
        },
      };
      try {
        return await refreshFinality(readOnly, idempotencyKey);
      } catch {
        // An RPC hiccup leaves the stored state as it is; the next read tries again.
        return deps.store.get(idempotencyKey);
      }
    },
  };
}
