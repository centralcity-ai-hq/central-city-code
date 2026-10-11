import type { PublicClient } from 'viem';

/**
 * Base fee control for the tests on the shared Anvil fork (CITY_BASE_ANVIL_URL). A base fee set on
 * the fork outlives the test that set it: Base's fee rules lower it by only 0.4% per block, so a
 * few gwei last for hundreds of blocks, and a later test would price and send its operations
 * against a fee it never chose. So every Anvil test starts with `startAtLowBaseFee`, and a test
 * that raises the fee does it with `raiseBaseFee`, which puts the low fee back when the test ends.
 */

/** About what a fresh fork of Base Sepolia starts with (0.005 gwei). */
export const LOW_BASE_FEE_WEI = 5_000_000n;

type AfterHook = { after: (fn: () => Promise<unknown>) => void };

async function setBaseFee(client: PublicClient, wei: bigint): Promise<void> {
  await client.request({
    method: 'anvil_setNextBlockBaseFeePerGas' as never,
    params: [`0x${wei.toString(16)}`] as never,
  });
  // Mined at once: fee estimates read the latest block, so it must already carry the new fee.
  await client.request({ method: 'evm_mine' as never, params: [] as never });
}

/** Call first in every Anvil test: it then starts from the same low fee, whatever ran before. */
export const startAtLowBaseFee = (client: PublicClient): Promise<void> =>
  setBaseFee(client, LOW_BASE_FEE_WEI);

/**
 * Raises the base fee (as live network fees move) and restores the low fee when the test ends, so
 * no later test inherits it. The restore is registered first, so it also runs if raising fails
 * halfway.
 */
export async function raiseBaseFee(t: AfterHook, client: PublicClient, wei: bigint): Promise<void> {
  t.after(() => startAtLowBaseFee(client));
  await setBaseFee(client, wei);
}
