/*
 * What the Arc testnet scripts share (deploy-testnet.ts, testnet-e2e.ts). Testnet only: the RPC is
 * fixed in code, and nothing is sent until the node itself has answered with chain id 5042002.
 *
 * Keys are throwaway test keys, one file each, in the folder ARC_TESTNET_KEYS_DIR, which must lie
 * outside the repository. They are read here and never printed. The folder's testnet-state.json
 * holds public facts only (addresses, transaction hashes, gas), so a later run continues where the
 * last one stopped.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  type Hex,
  type TransactionReceipt,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { ARC_NETWORKS, ARC_TESTNET } from '../../shared/chains.js';

export const network = ARC_NETWORKS[ARC_TESTNET];

export const arcTestnet = defineChain({
  id: ARC_TESTNET,
  name: network.name,
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: { default: { http: [network.publicRpcUrl] } },
});

export const client = createPublicClient({ chain: arcTestnet, transport: http() });

/** Reads the chain id from the node, not from configuration. Everything that sends calls this. */
export async function assertTestnet(): Promise<void> {
  const answered = await client.request({ method: 'eth_chainId' });
  if (Number(answered) !== ARC_TESTNET)
    throw new Error(`The node answered chain ${Number(answered)}: this script is testnet only.`);
}

export function keysDir(): string {
  const dir = process.env.ARC_TESTNET_KEYS_DIR;
  if (!dir) throw new Error('ARC_TESTNET_KEYS_DIR is not set.');
  const full = resolve(dir);
  if (full.startsWith(resolve(process.cwd()))) throw new Error('The keys stay outside the repo.');
  return full;
}

/** A throwaway key by name, made on first use. `testnet-deployer` already exists. */
export function testKey(name: string): PrivateKeyAccount {
  const file = join(keysDir(), `testnet-${name}.key`);
  if (!existsSync(file)) {
    if (name === 'deployer') throw new Error('The deployer key file is missing.');
    writeFileSync(file, generatePrivateKey(), { mode: 0o600 });
  }
  return privateKeyToAccount(readFileSync(file, 'utf8').trim() as Hex);
}

export function walletOf(account: PrivateKeyAccount) {
  return createWalletClient({ account, chain: arcTestnet, transport: http() });
}

const statePath = () => join(keysDir(), 'testnet-state.json');

export function readState(): Record<string, any> {
  return existsSync(statePath()) ? JSON.parse(readFileSync(statePath(), 'utf8')) : {};
}

export function saveState(patch: Record<string, unknown>): void {
  writeFileSync(statePath(), JSON.stringify({ ...readState(), ...patch }, null, 2));
}

/** 1 USDC is 10^18 native wei. */
export const usdc18 = (wei: bigint): string => {
  const abs = wei < 0n ? -wei : wei;
  const whole = abs / 10n ** 18n;
  const rest = (abs % 10n ** 18n).toString().padStart(18, '0').replace(/0+$/, '');
  return `${wei < 0n ? '-' : ''}${whole}${rest ? `.${rest}` : ''}`;
};

/** Fees over the 20 gwei floor (under it a transaction is dropped without an error). */
export async function fees(): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }> {
  const block = await client.getBlock();
  const base = block.baseFeePerGas ?? 20_000_000_000n;
  const maxPriorityFeePerGas = 5_000_000_000n;
  const wanted = 2n * base + maxPriorityFeePerGas;
  return {
    maxFeePerGas: wanted > 60_000_000_000n ? wanted : 60_000_000_000n,
    maxPriorityFeePerGas,
  };
}

export interface Recorded {
  hash: Hex;
  gasUsed: string;
  effectiveGasPrice: string;
  costUsdc: string;
  block: string;
  status: string;
}

export function recorded(receipt: TransactionReceipt): Recorded {
  return {
    hash: receipt.transactionHash,
    gasUsed: receipt.gasUsed.toString(),
    effectiveGasPrice: receipt.effectiveGasPrice.toString(),
    costUsdc: usdc18(receipt.gasUsed * receipt.effectiveGasPrice),
    block: receipt.blockNumber.toString(),
    status: receipt.status,
  };
}

/** Records one step in the state file and prints it. */
export function record(step: string, value: Record<string, unknown> | Recorded): void {
  const steps = readState().steps ?? {};
  saveState({ steps: { ...steps, [step]: value } });
  console.log(`${step}: ${JSON.stringify(value)}`);
}
