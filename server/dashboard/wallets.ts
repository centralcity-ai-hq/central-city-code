/*
 * Live balances of the dashboard's contracts and wallets (shared/dashboard-contracts.ts): read from
 * Base at most once per WALLETS_TTL_MS per server, one read in flight. A failed read serves the
 * last good values with their own time (stale: true). Read only; never a transaction.
 * Balances: the facilitators' ETH (their gas) and the paymaster's EntryPoint deposit. The fee
 * routers hold no balance (they forward every payment in the same call).
 */
import { createPublicClient, parseAbi, type Address } from 'viem';
import { baseReadTransport } from '../base/chain/read-transport.js';
import { BASE_MAINNET } from '../../shared/base/chains.js';
import { OWN_PAYMASTER_RECORD } from '../../shared/base/own-paymaster-record.js';
import {
  DASHBOARD_CONTRACTS,
  type DashboardBalance,
  type DashboardWallet,
  type DashboardWallets,
} from '../../shared/dashboard-contracts.js';

export const WALLETS_TTL_MS = 60_000;
const READ_TIMEOUT_MS = 4_000;

const ABI = parseAbi(['function balanceOf(address) view returns (uint256)']);

/** The reads a refresh needs; a viem client satisfies it (tests pass a fake). */
export interface WalletChain {
  ethOf(holder: Address): Promise<bigint>;
  /** EntryPoint balanceOf: a paymaster's deposit. */
  depositOf(entryPoint: Address, holder: Address): Promise<bigint>;
  /** An EOA's nonce: exactly the transactions it has sent. */
  nonceOf?(holder: Address): Promise<number>;
}

export function viemWalletChain(urls: readonly string[]): WalletChain | null {
  if (!urls.length) return null;
  // The shared Base read transport (server/base/chain/balances.ts does the same): the configured
  // endpoint first, the second one when it fails, counted under its own purpose.
  const client = createPublicClient({
    transport: baseReadTransport(urls, {
      chainId: BASE_MAINNET,
      timeoutMs: READ_TIMEOUT_MS,
      purpose: 'dashboard',
    }),
  });
  return {
    ethOf: (holder) => client.getBalance({ address: holder }),
    nonceOf: (holder) => client.getTransactionCount({ address: holder }),
    depositOf: (entryPoint, holder) =>
      client.readContract({
        address: entryPoint,
        abi: ABI,
        functionName: 'balanceOf',
        args: [holder],
      }),
  };
}

export function createWalletsReader(deps: {
  chain: WalletChain | null;
  clock: () => number;
  ttlMs?: number;
  /** Settled paymaster operations so far (paymaster-ops.ts), or null while unknown. */
  operations?: () => Promise<number | null>;
}): () => Promise<DashboardWallets> {
  let good: { wallets: DashboardWallet[]; at: number } | null = null;
  let until = 0;
  let stale = false;
  let inflight: Promise<void> | null = null;
  const empty = (): DashboardWallet[] =>
    DASHBOARD_CONTRACTS.map((c) => ({ ...c, eth: null, deposit: null }));
  async function refresh() {
    const chain = deps.chain;
    if (!chain) throw new Error('no chain');
    const at = deps.clock();
    const stamp = (raw: bigint): DashboardBalance => ({
      raw: raw.toString(),
      as_of: new Date(at).toISOString(),
    });
    const wallets = await Promise.all(
      DASHBOARD_CONTRACTS.map(async (c): Promise<DashboardWallet> => {
        const out: DashboardWallet = { ...c, eth: null, deposit: null };
        const a = c.address as Address;
        if (c.kind === 'facilitator' || c.kind === 'public_facilitator') {
          out.eth = stamp(await chain.ethOf(a));
          out.transactions = (await chain.nonceOf?.(a)) ?? null;
        }
        if (c.kind === 'paymaster') {
          out.deposit = stamp(await chain.depositOf(OWN_PAYMASTER_RECORD.entryPoint as Address, a));
          out.operations = (await deps.operations?.()) ?? null;
        }
        return out;
      }),
    );
    good = { wallets, at };
  }
  return async () => {
    const now = deps.clock();
    if (now >= until) {
      inflight ??= refresh()
        .then(() => {
          stale = false;
        })
        .catch(() => {
          stale = true;
        })
        .finally(() => {
          until = deps.clock() + (deps.ttlMs ?? WALLETS_TTL_MS);
          inflight = null;
        });
      await inflight;
    }
    return {
      chain_id: BASE_MAINNET,
      wallets: good?.wallets ?? empty(),
      as_of: good ? new Date(good.at).toISOString() : null,
      stale: stale || !good,
    };
  };
}
