/*
 * What our own paymaster may sponsor (Operation Paymaster, D7/D9): every operation is decoded down
 * to each inner call and checked against the allowlist of the flow it claims to be. Unknown flows,
 * targets, selectors, a non-zero value outside an ETH withdrawal, trailing bytes, a foreign factory
 * and paused flows are refused. The signer is in-process (it only ever sees operations our own server
 * prepared), so this is defence in depth against our own bugs, not the only gate: the caller's flow
 * code (submit.ts, withdrawals.ts, ...) keeps its own checks.
 *
 * The flows and calls are the full inventory of what the server builds (23 Oct 2026):
 *   agent wallet (owners [owner EOA, SpendPermissionManager], signed in the browser), one execute:
 *     exit      USDC transfer (withdraw), ETH transfer (execute(to, value, 0x)), a no-op to itself
 *               (cancel), SpendPermissionManager.revoke (limit revoke)
 *     ownerPay  USDC transfer (pay)
 *     rate      ReputationRegistry.giveFeedback
 *   spender account (owner [server spender key], signed by the keystore), execute or executeBatch:
 *     registration  IdentityRegistry.register(string) / transferFrom (hand-over)
 *     feedPay       SPM approveWithSignature / spend, USDC approve / transfer / cancelAuthorization,
 *                   fee router 1/2 chargeFee / pay
 *     agentPay      SPM approveWithSignature / spend, USDC transfer
 * Only the exit flow may use the protected budget (own-paymaster-budget.ts).
 *
 * Out of scope, so refused: the fleet treasury batch (fleet-batch-chain.ts; not wired anywhere, its
 * 50-transfer batches exceed the call gas ceiling) and anything else not listed above.
 *
 * The caller names the sender it prepared the operation for (`expect.sender`, from its own records:
 * the agent wallet or the agent's spender account); an operation for any other sender is refused.
 */
import {
  decodeAbiParameters,
  decodeFunctionData,
  encodeFunctionData,
  getAddress,
  parseAbi,
  parseAbiParameters,
  type Hex,
} from 'viem';
import type { UserOperation } from 'viem/account-abstraction';
import type { Address } from '../../../shared/base/chains.js';

export type SponsorFlow = 'exit' | 'ownerPay' | 'rate' | 'registration' | 'feedPay' | 'agentPay';
/** Flows refused whatever their calls (none: ratings were resumed once the budget was funded). */
export const PAUSED_FLOWS: ReadonlySet<SponsorFlow> = new Set();
/** Flows that may use the protected exit budget. */
export const PROTECTED_FLOWS: ReadonlySet<SponsorFlow> = new Set(['exit']);

export interface PolicyAddresses {
  usdc: Address;
  spendPermissionManager: Address;
  identityRegistry: Address;
  reputationRegistry: Address;
  smartWalletFactory: Address;
  /** Fee routers 1 and 2 (router 3 never takes a user operation). */
  feeRouters: readonly Address[];
}

/** Ceilings on the signed gas fields (getHash binds them, so they hold on chain). */
export interface GasCeilings {
  callGasLimit: bigint;
  verificationGasLimit: bigint;
  /** With initCode (the account is deployed by this operation). */
  verificationGasLimitWithInit: bigint;
  preVerificationGas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}
export const GAS_CEILINGS: GasCeilings = {
  callGasLimit: 1_500_000n,
  verificationGasLimit: 300_000n,
  verificationGasLimitWithInit: 700_000n,
  preVerificationGas: 200_000n,
  maxFeePerGas: 500_000_000n, // 0.5 gwei (Base runs around 0.006 gwei), like the router-3 facilitator
  maxPriorityFeePerGas: 50_000_000n, // 0.05 gwei
};

export class PolicyRefusal extends Error {
  constructor(
    readonly reason:
      | 'paused'
      | 'malformed'
      | 'unknown_call'
      | 'value'
      | 'recipient'
      | 'factory'
      | 'gas_ceiling'
      | 'sender',
    message: string,
  ) {
    super(message);
  }
}

const walletAbi = parseAbi([
  'function execute(address target, uint256 value, bytes data)',
  'function executeBatch((address target, uint256 value, bytes data)[] calls)',
]);
const factoryAbi = parseAbi(['function createAccount(bytes[] owners, uint256 nonce)']);
const usdcAbi = parseAbi([
  'function transfer(address to, uint256 amount)',
  'function approve(address spender, uint256 amount)',
  'function cancelAuthorization(address authorizer, bytes32 nonce, bytes signature)',
]);
const spmAbi = parseAbi([
  'struct SpendPermission { address account; address spender; address token; uint160 allowance; uint48 period; uint48 start; uint48 end; uint256 salt; bytes extraData; }',
  'function approveWithSignature(SpendPermission spendPermission, bytes signature)',
  'function spend(SpendPermission spendPermission, uint160 value)',
  'function revoke(SpendPermission spendPermission)',
]);
const identityAbi = parseAbi([
  'function register(string tokenURI)',
  'function transferFrom(address from, address to, uint256 tokenId)',
]);
const reputationAbi = parseAbi([
  'function giveFeedback(uint256 agentId, int128 value, uint8 decimals, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash)',
]);
const routerAbi = parseAbi([
  'function chargeFee(address payer, uint256 amount, bytes32 ref)',
  'function pay(address seller, uint256 amount, bytes32 ref)',
]);

interface Call {
  target: Address;
  value: bigint;
  data: Hex;
}

const same = (a: string, b: string) => getAddress(a) === getAddress(b);

/**
 * Decodes data exactly: the ABI decode must succeed and re-encoding must not leave trailing bytes
 * (decodeFunctionData ignores them otherwise).
 */
function strictDecode<const A extends readonly unknown[]>(abi: A, data: Hex) {
  let decoded: { functionName: string; args: readonly unknown[] };
  try {
    decoded = decodeFunctionData({ abi: abi as never, data }) as never;
    // Canonical encoding only: trailing or non-canonical bytes would re-encode differently.
    const again = (encodeFunctionData as (input: unknown) => Hex)({
      abi,
      functionName: decoded.functionName,
      args: decoded.args,
    });
    if (again.toLowerCase() !== data.toLowerCase()) return null;
  } catch {
    return null;
  }
  return decoded;
}

/** The wallet calls of an operation: one execute, or executeBatch (spender accounts only). */
function walletCalls(op: UserOperation<'0.6'>, allowBatch: boolean): Call[] {
  const decoded = strictDecode(walletAbi, op.callData);
  if (!decoded) throw new PolicyRefusal('malformed', 'callData is not execute/executeBatch.');
  if (decoded.functionName === 'execute') {
    const [target, value, data] = decoded.args as [Address, bigint, Hex];
    return [{ target, value, data }];
  }
  if (!allowBatch) throw new PolicyRefusal('unknown_call', 'Owner operations send one execute.');
  const [calls] = decoded.args as [readonly Call[]];
  if (calls.length === 0 || calls.length > 60)
    throw new PolicyRefusal('malformed', 'executeBatch must hold 1-60 calls.');
  return [...calls];
}

/** A call's decoded function on one of the allowed targets, or a refusal. */
function callOn(
  call: Call,
  target: Address,
  abi: readonly unknown[],
  names: readonly string[],
): { functionName: string; args: readonly unknown[] } | null {
  if (!same(call.target, target)) return null;
  const decoded = strictDecode(abi, call.data);
  if (!decoded || !names.includes(decoded.functionName))
    throw new PolicyRefusal('unknown_call', `A call to ${target} is not an allowed function.`);
  return decoded;
}

function checkInitCode(op: UserOperation<'0.6'>, addresses: PolicyAddresses): void {
  const initCode = op.initCode ?? '0x';
  if (initCode === '0x') return;
  if (initCode.length < 42 + 8 || !same(initCode.slice(0, 42), addresses.smartWalletFactory))
    throw new PolicyRefusal('factory', 'initCode does not use the pinned wallet factory.');
  if (!strictDecode(factoryAbi, `0x${initCode.slice(42)}`))
    throw new PolicyRefusal('factory', 'initCode is not createAccount(owners, nonce).');
}

const ERC6492_SUFFIX = '6492649264926492649264926492649264926492649264926492649264926492';

/**
 * An owner signature wrapped in ERC-6492 (approveWithSignature while the wallet is not deployed: the
 * SpendPermissionManager deploys it from the wrapper) may only deploy through the pinned factory's
 * createAccount. An unwrapped signature is the wallet's own business.
 */
function checkErc6492(signature: Hex, addresses: PolicyAddresses): void {
  if (!signature.toLowerCase().endsWith(ERC6492_SUFFIX)) return;
  let factory: Address, factoryCalldata: Hex;
  try {
    [factory, factoryCalldata] = decodeAbiParameters(
      parseAbiParameters('address, bytes, bytes'),
      `0x${signature.slice(2, -64)}`,
    ) as unknown as [Address, Hex, Hex];
  } catch {
    throw new PolicyRefusal('factory', 'A malformed ERC-6492 signature.');
  }
  if (!same(factory, addresses.smartWalletFactory) || !strictDecode(factoryAbi, factoryCalldata))
    throw new PolicyRefusal('factory', 'ERC-6492 deploys only through the pinned factory.');
}

function checkGas(op: UserOperation<'0.6'>, ceilings: GasCeilings): void {
  const withInit = (op.initCode ?? '0x') !== '0x';
  const over =
    op.callGasLimit > ceilings.callGasLimit ||
    op.verificationGasLimit >
      (withInit ? ceilings.verificationGasLimitWithInit : ceilings.verificationGasLimit) ||
    op.preVerificationGas > ceilings.preVerificationGas ||
    op.maxFeePerGas > ceilings.maxFeePerGas ||
    op.maxPriorityFeePerGas > ceilings.maxPriorityFeePerGas ||
    op.maxPriorityFeePerGas > op.maxFeePerGas;
  if (over) throw new PolicyRefusal('gas_ceiling', 'A gas field is above its ceiling.');
}

/**
 * Checks one operation against its flow. Throws PolicyRefusal; returns nothing when it may be
 * sponsored. `context.owner` (the agent wallet's spender, for exits) names addresses an exit may not
 * pay to; the flow code checks recipients in full (withdrawals.ts), this is the second gate.
 */
export function checkSponsorship(
  op: UserOperation<'0.6'>,
  flow: SponsorFlow,
  config: {
    addresses: PolicyAddresses;
    /** The sender the caller prepared this operation for, from its own records. */
    expect: { sender: Address };
    ceilings?: GasCeilings;
    paused?: ReadonlySet<SponsorFlow>;
  },
): void {
  const a = config.addresses;
  if (!same(op.sender, config.expect.sender))
    throw new PolicyRefusal('sender', 'The operation is not for the expected sender.');
  if ((config.paused ?? PAUSED_FLOWS).has(flow))
    throw new PolicyRefusal('paused', `Sponsoring ${flow} is paused.`);
  checkGas(op, config.ceilings ?? GAS_CEILINGS);
  checkInitCode(op, a);
  const spenderFlow = flow === 'registration' || flow === 'feedPay' || flow === 'agentPay';
  const calls = walletCalls(op, spenderFlow);
  const never = [a.spendPermissionManager, a.smartWalletFactory, a.usdc, op.sender];

  for (const call of calls) {
    // ETH value only in an exit's plain ETH transfer (execute(to, value, 0x)).
    const ethTransfer = call.data === '0x' && !same(call.target, op.sender);
    if (call.value !== 0n && !(flow === 'exit' && ethTransfer))
      throw new PolicyRefusal('value', 'Only an ETH withdrawal may carry value.');

    if (flow === 'exit') {
      if (call.data === '0x' && same(call.target, op.sender) && call.value === 0n) continue; // cancel
      if (ethTransfer) {
        if (call.value === 0n)
          throw new PolicyRefusal('value', 'An ETH withdrawal moves more than 0.');
        if (never.some((x) => same(x, call.target)))
          throw new PolicyRefusal('recipient', 'An ETH withdrawal to a refused address.');
        continue;
      }
      const usdc = callOn(call, a.usdc, usdcAbi, ['transfer']);
      if (usdc) {
        const [to, amount] = usdc.args as [Address, bigint];
        if (amount === 0n) throw new PolicyRefusal('value', 'A withdrawal moves more than 0.');
        if (never.some((x) => same(x, to)))
          throw new PolicyRefusal('recipient', 'A USDC withdrawal to a refused address.');
        continue;
      }
      const spm = callOn(call, a.spendPermissionManager, spmAbi, ['revoke']);
      if (spm) {
        const [permission] = spm.args as [{ account: Address }];
        if (!same(permission.account, op.sender))
          throw new PolicyRefusal('recipient', "A revoke of another wallet's permission.");
        continue;
      }
      throw new PolicyRefusal('unknown_call', 'Not an exit call.');
    }

    if (flow === 'ownerPay') {
      const usdc = callOn(call, a.usdc, usdcAbi, ['transfer']);
      if (!usdc) throw new PolicyRefusal('unknown_call', 'Owner pay is one USDC transfer.');
      const [to, amount] = usdc.args as [Address, bigint];
      if (amount === 0n) throw new PolicyRefusal('value', 'A payment moves more than 0.');
      if (never.some((x) => same(x, to)))
        throw new PolicyRefusal('recipient', 'Pay to a refused address.');
      continue;
    }

    if (flow === 'rate') {
      if (!callOn(call, a.reputationRegistry, reputationAbi, ['giveFeedback']))
        throw new PolicyRefusal('unknown_call', 'A rating is one giveFeedback.');
      continue;
    }

    if (flow === 'registration') {
      const id = callOn(call, a.identityRegistry, identityAbi, ['register', 'transferFrom']);
      if (!id) throw new PolicyRefusal('unknown_call', 'Not an identity call.');
      if (id.functionName === 'transferFrom' && !same((id.args as [Address])[0], op.sender))
        throw new PolicyRefusal('recipient', 'A hand-over from another account.');
      continue;
    }

    // feedPay / agentPay: the spender's calls.
    const spm = callOn(call, a.spendPermissionManager, spmAbi, ['approveWithSignature', 'spend']);
    if (spm) {
      const [permission, second] = spm.args as [{ spender: Address; token: Address }, unknown];
      if (spm.functionName === 'approveWithSignature') checkErc6492(second as Hex, a);
      if (!same(permission.spender, op.sender))
        throw new PolicyRefusal('recipient', 'A spend permission for another spender.');
      if (!same(permission.token, a.usdc))
        throw new PolicyRefusal('recipient', 'A spend permission for another token.');
      continue;
    }
    const usdc = callOn(call, a.usdc, usdcAbi, ['transfer', 'approve', 'cancelAuthorization']);
    if (usdc) {
      if (usdc.functionName === 'approve') {
        const [spender] = usdc.args as [Address];
        if (flow !== 'feedPay' || !a.feeRouters.some((r) => same(r, spender)))
          throw new PolicyRefusal('recipient', 'USDC approve only to a fee router.');
      }
      if (usdc.functionName === 'cancelAuthorization') {
        const [authorizer] = usdc.args as [Address];
        if (flow !== 'feedPay' || !same(authorizer, op.sender))
          throw new PolicyRefusal('recipient', 'cancelAuthorization only for the spender itself.');
      }
      continue;
    }
    if (flow === 'feedPay') {
      const router = a.feeRouters.find((r) => same(r, call.target));
      if (router && callOn(call, router, routerAbi, ['chargeFee', 'pay'])) continue;
    }
    throw new PolicyRefusal('unknown_call', `A call not allowed in ${flow}.`);
  }
}
