/*
 * Counterfactual smart-account addresses (docs/base/ARCHITECTURE.md §3, §11.1). An address is
 * known before anything is deployed: the Coinbase Smart Wallet factory derives it with CREATE2
 * from the ordered owner list and an index. Nothing here writes to the chain or costs gas.
 *
 * Agent wallets have two owners, [owner EOA, SpendPermissionManager]: without the manager as an
 * owner, SpendPermissionManager.spend reverts with Unauthorized (proven on an Anvil fork). Both
 * owners are part of the address, so the recipe is stored with every wallet and never changes.
 */
import {
  encodeAbiParameters,
  getAddress,
  getContractAddress,
  keccak256,
  parseAbi,
  type Hex,
  type PublicClient,
} from 'viem';
import type { Address, BaseNetwork } from '../../../shared/base/chains.js';

const factoryAbi = parseAbi([
  'function getAddress(bytes[] owners, uint256 nonce) view returns (address)',
  'function createAccount(bytes[] owners, uint256 nonce) payable returns (address)',
]);

/** Bump when the owner layout or factory changes; stored wallets keep the version they were made with. */
export const DERIVATION_VERSION = 1;

/** Everything needed to re-derive an address later, exactly as it was derived. */
export interface DerivationRecipe {
  version: number;
  factory: Address;
  /** Ordered: index 0 signs for the account; order is part of the address. */
  owners: Address[];
  index: bigint;
}

/** The owner list for a Coinbase Smart Wallet, each owner ABI-encoded as the factory expects. */
export function encodeOwners(owners: readonly Address[]): `0x${string}`[] {
  return owners.map((owner) => encodeAbiParameters([{ type: 'address' }], [getAddress(owner)]));
}

/** The recipe for an agent wallet: the owner's key plus SpendPermissionManager. */
export function agentWalletRecipe(
  network: BaseNetwork,
  owner: Address,
  index: bigint,
): DerivationRecipe {
  if (index < 0n) throw new Error('Derivation index must be non-negative.');
  return {
    version: DERIVATION_VERSION,
    factory: network.contracts.smartWalletFactory,
    owners: [getAddress(owner), network.contracts.spendPermissionManager],
    index,
  };
}

/** The recipe for a spender account: a smart account owned only by the server-held spender key. */
export function spenderAccountRecipe(
  network: BaseNetwork,
  spenderSigner: Address,
): DerivationRecipe {
  return {
    version: DERIVATION_VERSION,
    factory: network.contracts.smartWalletFactory,
    owners: [getAddress(spenderSigner)],
    index: 0n,
  };
}

/** Reads the counterfactual address from the factory (one eth_call); the cross-check for local derivation. */
export async function deriveAddress(
  client: PublicClient,
  recipe: DerivationRecipe,
): Promise<Address> {
  if (recipe.version !== DERIVATION_VERSION)
    throw new Error(`Unsupported derivation version ${recipe.version}.`);
  const address = await client.readContract({
    address: recipe.factory,
    abi: factoryAbi,
    functionName: 'getAddress',
    args: [encodeOwners(recipe.owners), recipe.index],
  });
  return getAddress(address);
}

/**
 * Init-code hash of the Coinbase Smart Wallet v1 proxy, per factory. Read from the factory's
 * `initCodeHash()` (identical on Base Sepolia and Base on 8 Oct 2026); tests cross-check it
 * against the factory so a changed factory fails loudly instead of deriving wrong addresses.
 */
export const INIT_CODE_HASHES: Readonly<Record<string, Hex>> = Object.freeze({
  '0x0BA5ED0c6AA8c49038F819E587E2633c4A9F428a':
    '0x5153041b4b8e36c84ca233b2fb610f85b8831b5e56a365618f507f8784fe034e',
});

/**
 * Computes the counterfactual address locally, exactly as the factory does: CREATE2 from the
 * factory with salt = keccak256(abi.encode(owners, nonce)). No RPC call, so hundreds of thousands
 * of wallets derive in memory.
 */
export function deriveAddressLocal(recipe: DerivationRecipe): Address {
  if (recipe.version !== DERIVATION_VERSION)
    throw new Error(`Unsupported derivation version ${recipe.version}.`);
  const bytecodeHash = INIT_CODE_HASHES[getAddress(recipe.factory)];
  if (!bytecodeHash) throw new Error('No init-code hash for this factory.');
  const salt = keccak256(
    encodeAbiParameters(
      [{ type: 'bytes[]' }, { type: 'uint256' }],
      [encodeOwners(recipe.owners), recipe.index],
    ),
  );
  return getContractAddress({ opcode: 'CREATE2', from: recipe.factory, salt, bytecodeHash });
}

/**
 * Derives the agent wallets for one owner at explicit indexes. The index belongs to the agent
 * (the wallet service derives it from the agent id), never to its position in a batch, so the
 * wallet service and bulk provisioning always produce the same address for the same agent.
 */
export function deriveAgentWallets(
  network: BaseNetwork,
  owner: Address,
  indexes: readonly bigint[],
): { recipe: DerivationRecipe; address: Address }[] {
  return indexes.map((index) => {
    const recipe = agentWalletRecipe(network, owner, index);
    return { recipe, address: deriveAddressLocal(recipe) };
  });
}

/** Calldata that deploys the account for a recipe; used in ERC-6492 signatures and initCode. */
export function createAccountCall(recipe: DerivationRecipe) {
  return {
    abi: factoryAbi,
    functionName: 'createAccount' as const,
    args: [encodeOwners(recipe.owners), recipe.index] as const,
  };
}
