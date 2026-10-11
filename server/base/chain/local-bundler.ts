/*
 * A minimal bundler for a local Anvil fork: it calls EntryPoint v0.6 `handleOps` directly from a
 * funded local account and reads receipts from `UserOperationEvent` logs. For tests and local
 * development only; production uses the CDP bundler and paymaster. Never point it at a public RPC.
 */
import {
  parseAbi,
  parseAbiItem,
  parseEventLogs,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem';
import type { UserOperation } from 'viem/account-abstraction';
import type { Address } from '../../../shared/base/chains.js';
import type { Bundler, BundlerReceipt } from './submit.js';

const entryPointAbi = parseAbi([
  'struct UserOperation { address sender; uint256 nonce; bytes initCode; bytes callData; uint256 callGasLimit; uint256 verificationGasLimit; uint256 preVerificationGas; uint256 maxFeePerGas; uint256 maxPriorityFeePerGas; bytes paymasterAndData; bytes signature; }',
  'function handleOps(UserOperation[] ops, address beneficiary)',
]);
const userOperationEvent = parseAbiItem(
  'event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)',
);

export function localBundler(deps: {
  client: PublicClient;
  wallet: WalletClient;
  entryPoint: Address;
  /** Fixed gas for local runs; the fork does not run a gas estimator for UserOps. */
  gas?: { call: bigint; verification: bigint; preVerification: bigint };
}): Bundler {
  const gas = deps.gas ?? {
    call: 1_500_000n,
    verification: 1_500_000n,
    preVerification: 100_000n,
  };
  const sent = new Set<Hex>();
  const receipts = new Map<Hex, BundlerReceipt>();
  // One handleOps transaction at a time from the local account, like a real bundler's queue.
  let queue: Promise<unknown> = Promise.resolve();

  async function sendNow(op: UserOperation<'0.6'>): Promise<Hex> {
    const key = `${op.sender}:${op.nonce}` as Hex;
    if (sent.has(key)) return key; // already known: resending is a no-op, like a real bundler
    const hash = await deps.wallet.writeContract({
      account: deps.wallet.account!,
      chain: deps.wallet.chain,
      address: deps.entryPoint,
      abi: entryPointAbi,
      functionName: 'handleOps',
      args: [
        [
          {
            sender: op.sender,
            nonce: op.nonce,
            initCode: op.initCode ?? '0x',
            callData: op.callData,
            callGasLimit: op.callGasLimit,
            verificationGasLimit: op.verificationGasLimit,
            preVerificationGas: op.preVerificationGas,
            maxFeePerGas: op.maxFeePerGas,
            maxPriorityFeePerGas: op.maxPriorityFeePerGas,
            paymasterAndData: op.paymasterAndData ?? '0x',
            signature: op.signature,
          },
        ],
        deps.wallet.account!.address,
      ],
      gas: 8_000_000n,
    });
    const txReceipt = await deps.client.waitForTransactionReceipt({ hash });
    for (const log of parseEventLogs({ abi: [userOperationEvent], logs: txReceipt.logs }))
      receipts.set(log.args.userOpHash, {
        success: log.args.success,
        txHash: log.transactionHash,
        blockNumber: log.blockNumber,
        actualGasUsed: log.args.actualGasUsed,
        actualGasCost: log.args.actualGasCost,
      });
    sent.add(key);
    return key;
  }

  return {
    async prepare(op) {
      const fees = await deps.client.estimateFeesPerGas();
      return {
        ...op,
        callGasLimit: gas.call,
        verificationGasLimit: gas.verification,
        preVerificationGas: gas.preVerification,
        maxFeePerGas: fees.maxFeePerGas,
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      };
    },
    async send(op: UserOperation<'0.6'>) {
      const turn = queue.then(() => sendNow(op));
      queue = turn.catch(() => undefined);
      return turn;
    },
    async receipt(userOpHash: Hex): Promise<BundlerReceipt | null> {
      // A fork cannot scan logs from genesis; this bundler remembers the receipts of its own sends.
      const known = receipts.get(userOpHash);
      if (!known) return null;
      const stillThere = await deps.client
        .getTransactionReceipt({ hash: known.txHash })
        .catch(() => null);
      return stillThere ? known : null;
    },
  };
}
