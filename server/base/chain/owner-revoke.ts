/*
 * The owner's revoke of a spending limit (Operation Base Wallet W3): a UserOperation FROM the
 * agent wallet calling SpendPermissionManager.revoke(permission), authorized by the wallet's owner
 * key. That key lives only in the browser (the owner vault); the server never holds it. A Coinbase
 * Smart Wallet checks the owner's signature over the RAW userOpHash, so it is two-phase:
 *
 *   prepare  the unsigned, sponsored operation on the wallet's owner nonce lane, with the wallet's
 *            initCode while it has no code; sponsored means a pinned paymaster charging the wallet
 *            nothing (shared/base/paymasters.ts), else NOT_SPONSORED; nothing is signed or stored
 *   submit   exactly that operation with the owner's signature (checked here), wrapped as
 *            SignatureWrapper{ownerIndex: 0}; stored before broadcast and sent on the chain
 *            module's durable path (submit.ts), idempotent per key
 *   refresh  reconcile and finality of the stored operation; never signs
 *
 * Minimal on purpose, until the owner-operations port of the withdrawals milestone (W2) is merged:
 * submit.ts is not changed. `submitOperation` is given a bundler that hands back the prepared
 * operation unchanged (it re-checks sender, nonce, initCode and calls against it) and a signer that
 * only returns the owner's signature for exactly that operation's hash. Every owner operation of a
 * wallet uses the same nonce lane as W2's (`OWNER_NONCE_KEY`), so two owner operations prepared at
 * the same time share a nonce and at most one of them can ever land.
 *
 * On mainnet nothing is prepared or sent without a cost cap (FEE_BUDGET_REQUIRED), like W2's owner
 * operations: real money is never spent without a fee budget.
 *
 * The bundler URL carries a key: no error from here repeats an RPC or bundler message.
 */
import {
  createPublicClient,
  encodeFunctionData,
  getAddress,
  parseAbi,
  recoverAddress,
  type Hex,
  type PublicClient,
} from 'viem';
import { getUserOperationHash, type UserOperation } from 'viem/account-abstraction';
import type { Database } from '../../database.js';
import {
  BASE_MAINNET,
  baseNetwork,
  type Address,
  type BaseChainId,
  type BaseNetwork,
} from '../../../shared/base/chains.js';
import {
  SPONSOR_PAYMASTERS,
  sponsoredWithoutCharge,
  type SponsorAllowlist,
} from '../../../shared/base/paymasters.js';
import { createAccountCall, deriveAddressLocal, type DerivationRecipe } from './derive.js';
import { walletSignature } from './permissions.js';
import { BundlerError, rpcBundler } from './rpc-bundler.js';
import { CDP_RETRY } from './rpc-budget.js';
import { baseReadTransport, baseReadUrls } from './read-transport.js';
import { ChainRuntimeError, WALLET_FEE_CAP_SETTING, walletFeeCap } from './runtime.js';
import { pgChainOperationStore } from './stores.js';
import {
  encodeAccountCalls,
  maxCostWei,
  nonceLaneFor,
  refreshFinality,
  submitOperation,
  SubmitError,
  type Bundler,
  type Call,
  type ChainOperationStore,
  type OperationSigner,
  type StoredOperation,
  type SubmitDeps,
} from './submit.js';

/** The one nonce lane of every owner operation of a wallet (the same derivation as W2's). */
export const OWNER_NONCE_KEY = nonceLaneFor('cc.base.wallet.owner-ops.v1');

/** The wallet's owner key is owner 0: owners are [owner key, SpendPermissionManager]. */
export const OWNER_INDEX = 0;

export type OwnerRevokeErrorCode =
  /** Fees or the operation's cost bound are above the configured cap; nothing was prepared. */
  | 'FEE_CAP'
  /** Mainnet without a cost cap: nothing is prepared or sent (the runtime never builds one). */
  | 'FEE_BUDGET_REQUIRED'
  /** The paymaster did not sponsor the operation. */
  | 'NOT_SPONSORED'
  /** The wallet moved on since it was prepared (nonce used, or deployed): prepare again. */
  | 'OUTDATED'
  /** The stored derivation does not produce this wallet. */
  | 'WALLET_MISMATCH'
  /** The signature is not the owner's over this exact operation. */
  | 'SIGNATURE_MISMATCH'
  /** The key was used for another operation. */
  | 'IDEMPOTENCY_CONFLICT'
  /** The chain, bundler or paymaster could not be reached or answered something unusable. */
  | 'UNAVAILABLE';

export class OwnerRevokeError extends Error {
  constructor(
    readonly code: OwnerRevokeErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface PreparedOwnerOperation {
  /** Unsigned (`signature: '0x'`), sponsored (`paymasterAndData` set). */
  operation: UserOperation<'0.6'>;
  /** The raw hash the owner key signs. */
  userOpHash: Hex;
  maxCostWei: bigint;
  /** The wallet had code when prepared (otherwise the operation deploys it). */
  deployed: boolean;
}

export interface OwnerRevokePort {
  readonly chainId: number;
  readonly entryPoint: Address;
  prepare(input: {
    wallet: Address;
    recipe: DerivationRecipe;
    calls: Call[];
  }): Promise<PreparedOwnerOperation>;
  /** Stores and sends a prepared operation with the owner's signature (idempotent per key). */
  submit(input: {
    idempotencyKey: string;
    intentHash: Hex;
    wallet: Address;
    recipe: DerivationRecipe;
    calls: Call[];
    operation: UserOperation<'0.6'>;
    userOpHash: Hex;
    owner: Address;
    /** 65 bytes over the raw userOpHash. */
    signature: Hex;
  }): Promise<StoredOperation>;
  /** The stored operation with its inclusion and finality brought up to date; never signs. */
  refresh(idempotencyKey: string): Promise<StoredOperation | null>;
}

export interface OwnerRevokeDeps {
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
}

const entryPointAbi = parseAbi([
  'function getNonce(address sender, uint192 key) view returns (uint256)',
]);

/** Maps chain-module failures to the port's codes; any other failure is UNAVAILABLE. */
function classify(error: unknown): OwnerRevokeError {
  if (error instanceof OwnerRevokeError) return error;
  if (error instanceof BundlerError && error.code === 'FEE_CAP_EXCEEDED')
    return new OwnerRevokeError('FEE_CAP', 'Network fees are above the cap right now.');
  if (error instanceof SubmitError) {
    if (error.code === 'COST_CAP_EXCEEDED')
      return new OwnerRevokeError('FEE_CAP', 'The operation could cost more than the cap.');
    if (error.code === 'NONCE_MOVED' || error.code === 'SENDER_MISMATCH')
      return new OwnerRevokeError('OUTDATED', 'The wallet changed since this was prepared.');
    if (error.code === 'IDEMPOTENCY_CONFLICT')
      return new OwnerRevokeError('IDEMPOTENCY_CONFLICT', error.message);
  }
  return new OwnerRevokeError('UNAVAILABLE', 'Base could not be reached right now.');
}

/** The raw-hash signer of a 65-byte signature, or null when it does not recover. */
export async function rawSigner(hash: Hex, signature: Hex): Promise<Address | null> {
  if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) return null;
  try {
    return getAddress(await recoverAddress({ hash, signature }));
  } catch {
    return null;
  }
}

export function createOwnerRevokePort(deps: OwnerRevokeDeps): OwnerRevokePort {
  const entryPoint = deps.network.contracts.entryPointV06;
  const chainId = deps.network.chainId;
  const sponsors = deps.sponsors ?? SPONSOR_PAYMASTERS;
  const hashOf = (operation: UserOperation<'0.6'>) =>
    getUserOperationHash({
      chainId,
      entryPointAddress: entryPoint,
      entryPointVersion: '0.6',
      userOperation: operation,
    });
  /** Real money is never spent without a fee budget: on mainnet a cost cap is mandatory. */
  function requireBudget() {
    if (chainId === BASE_MAINNET && deps.maxCostWeiCap === undefined)
      throw new OwnerRevokeError(
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
      throw new OwnerRevokeError('WALLET_MISMATCH', 'The wallet recipe is not usable.');
    }
    if (derived !== address)
      throw new OwnerRevokeError('WALLET_MISMATCH', 'The recipe does not derive this wallet.');
    return address;
  }

  return {
    chainId,
    entryPoint,

    async prepare(input) {
      requireBudget();
      const sender = checkWallet(input.wallet, input.recipe);
      try {
        const deployed = (await deps.client.getCode({ address: sender })) !== undefined;
        const nonce = await deps.client.readContract({
          address: entryPoint,
          abi: entryPointAbi,
          functionName: 'getNonce',
          args: [sender, OWNER_NONCE_KEY],
        });
        const initCode: Hex = deployed
          ? '0x'
          : (`${input.recipe.factory}${encodeFunctionData(createAccountCall(input.recipe)).slice(2)}` as Hex);
        const callData = await encodeAccountCalls(deps.client, input.calls);
        const operation = await deps.bundler.prepare({
          sender,
          nonce,
          initCode,
          callData,
          callGasLimit: 0n,
          verificationGasLimit: 0n,
          preVerificationGas: 0n,
          maxFeePerGas: 0n,
          maxPriorityFeePerGas: 0n,
          paymasterAndData: '0x',
          signature: '0x',
        });
        if (
          getAddress(operation.sender) !== sender ||
          operation.nonce !== nonce ||
          (operation.initCode ?? '0x') !== initCode ||
          operation.callData !== callData ||
          operation.maxPriorityFeePerGas > operation.maxFeePerGas
        )
          throw new OwnerRevokeError('UNAVAILABLE', 'The bundler changed the operation.');
        // An empty answer, an unknown paymaster or one set to take a token is no sponsorship.
        if (!sponsoredWithoutCharge(chainId, operation.paymasterAndData, sponsors))
          throw new OwnerRevokeError('NOT_SPONSORED', 'The operation is not sponsored.');
        const bound = maxCostWei(operation);
        if (deps.maxCostWeiCap !== undefined && bound > deps.maxCostWeiCap)
          throw new OwnerRevokeError('FEE_CAP', 'The operation could cost more than the cap.');
        const unsigned = { ...operation, signature: '0x' as Hex };
        return { operation: unsigned, userOpHash: hashOf(unsigned), maxCostWei: bound, deployed };
      } catch (error) {
        throw classify(error);
      }
    },

    async submit(input) {
      requireBudget();
      const wallet = checkWallet(input.wallet, input.recipe);
      const owner = getAddress(input.owner);
      const unsigned = { ...input.operation, signature: '0x' as Hex };
      // Only what prepare can produce: never one the wallet could be charged for.
      if (!sponsoredWithoutCharge(chainId, unsigned.paymasterAndData, sponsors))
        throw new OwnerRevokeError('NOT_SPONSORED', 'The operation is not sponsored.');
      if (hashOf(unsigned).toLowerCase() !== input.userOpHash.toLowerCase())
        throw new OwnerRevokeError('SIGNATURE_MISMATCH', 'The hash is not this operation.');
      if ((await rawSigner(input.userOpHash, input.signature)) !== owner)
        throw new OwnerRevokeError('SIGNATURE_MISMATCH', 'Not signed by the wallet owner.');
      const wrapped = walletSignature(input.signature, { ownerIndex: OWNER_INDEX });
      // Hands back exactly the prepared operation: submitOperation checks it against the calls.
      const replay: Bundler = {
        prepare: async () => unsigned,
        send: (op) => deps.bundler.send(op),
        receipt: (hash) => deps.bundler.receipt(hash),
      };
      const signer: OperationSigner = {
        address: owner,
        async signUserOperation(op, sender) {
          const hash = hashOf({ ...op, sender, signature: '0x' });
          if (hash.toLowerCase() !== input.userOpHash.toLowerCase())
            throw new OwnerRevokeError('SIGNATURE_MISMATCH', 'Signed for another operation.');
          return wrapped;
        },
      };
      try {
        return await submitOperation(
          {
            network: deps.network,
            client: deps.client,
            store: deps.store,
            bundler: replay,
            signer,
          },
          {
            idempotencyKey: input.idempotencyKey,
            intentHash: input.intentHash,
            kind: 'userop',
            account: { address: wallet, recipe: input.recipe },
            calls: input.calls,
            nonceKey: OWNER_NONCE_KEY,
            pinnedNonce: unsigned.nonce,
            maxCostWeiCap: deps.maxCostWeiCap,
            // Revoking only takes power away: the owner's own signature is the whole authority.
            beforeBroadcast: async () => {},
          },
        );
      } catch (error) {
        throw classify(error);
      }
    },

    async refresh(idempotencyKey) {
      const readOnly: SubmitDeps = {
        network: deps.network,
        client: deps.client,
        store: deps.store,
        bundler: deps.bundler,
        signer: {
          address: '0x0000000000000000000000000000000000000000',
          signUserOperation: async () => {
            throw new Error('Reconciliation never signs.');
          },
        },
      };
      try {
        return await refreshFinality(readOnly, idempotencyKey, { retireLapsed: true });
      } catch {
        // An RPC hiccup leaves the stored state as it is; the next read tries again.
        return deps.store.get(idempotencyKey);
      }
    },
  };
}

const POSITIVE_INT = /^[1-9][0-9]{0,77}$/;

/**
 * The port from the environment, with the same settings as the chain runtime (runtime.ts): the
 * network's bundler/RPC URL and CITY_BASE_MAX_FEE_PER_GAS_WEI; CITY_BASE_WALLET_FEE_CAP_WEI caps one
 * owner operation, by the same rule as W2's owner operations (runtime.ts walletFeeCap: mandatory on
 * mainnet, never malformed). A missing setting throws ChainRuntimeError (no value in any message).
 * Its reads fall back like the runtime's (read-transport.ts); its bundler and paymaster calls, and
 * the nonce and code reads that build an operation, stay on the CDP endpoint.
 */
export function ownerRevokePortFromEnv(
  db: Database,
  env: Record<string, string | undefined>,
  chainId: BaseChainId,
  options: { hosted?: boolean } = {},
): OwnerRevokePort {
  const network = baseNetwork(chainId, env);
  if (!network) throw new ChainRuntimeError('network');
  const url = env[network.bundlerEnv]?.trim();
  if (!url) throw new ChainRuntimeError(network.bundlerEnv);
  const feeCap = env.CITY_BASE_MAX_FEE_PER_GAS_WEI?.trim();
  if (!feeCap || !POSITIVE_INT.test(feeCap))
    throw new ChainRuntimeError('CITY_BASE_MAX_FEE_PER_GAS_WEI');
  const opCap = walletFeeCap(env, network.chainId);
  if (!opCap) throw new ChainRuntimeError(WALLET_FEE_CAP_SETTING);
  const client = createPublicClient({
    chain: {
      id: network.chainId,
      name: network.name,
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: [url] } },
    },
    transport: baseReadTransport(baseReadUrls(url, env, network.chainId, options), {
      chainId: network.chainId,
      retry: CDP_RETRY,
    }),
  });
  return createOwnerRevokePort({
    network,
    client,
    store: pgChainOperationStore(db),
    bundler: rpcBundler({
      url,
      entryPoint: network.contracts.entryPointV06,
      chainId: network.chainId,
      client,
      maxFeePerGasCap: BigInt(feeCap),
      // The gas-estimation stub: a SignatureWrapper around a well-formed, never-real signature.
      stubSignature: walletSignature(`0x${'ff'.repeat(64)}1c` as Hex, { ownerIndex: OWNER_INDEX }),
    }),
    maxCostWeiCap: opCap.cap,
  });
}
