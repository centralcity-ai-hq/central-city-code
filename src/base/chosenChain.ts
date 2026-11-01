/*
 * The chain an agent lives on, as this browser knows it (Operation Arc): what the owner picked on
 * Choose a chain, or the chain of the registration the server named. The Base screen remembers it
 * and the Wallet screens read it, so a choice of Arc carries through the wallet key's setup and
 * never creates a Base wallet first. Per tab (sessionStorage), and in memory when storage is off.
 * Nothing here is sent anywhere: the server still decides from its own rows.
 */
import { ARC_MAINNET, ARC_TESTNET } from '../../shared/chains';
import { BASE_MAINNET } from '../../shared/base/chains';

const KEY = 'cc.chosenChain.v1';
const memory = new Map<string, number>();

const known = (value: unknown): value is number =>
  value === BASE_MAINNET || value === ARC_MAINNET || value === ARC_TESTNET;

function stored(): Record<string, number> {
  try {
    const raw = globalThis.sessionStorage?.getItem(KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, number>) : {};
  } catch {
    return {};
  }
}

/** Remembers the agent's chain; anything but Base or an Arc network is ignored. */
export function rememberChain(agentId: string, chainId: unknown): void {
  if (!agentId || !known(chainId)) return;
  memory.set(agentId, chainId);
  try {
    const all = stored();
    all[agentId] = chainId;
    globalThis.sessionStorage?.setItem(KEY, JSON.stringify(all));
  } catch {
    // Memory alone, then: the choice still holds for this page.
  }
}

/** The agent's chain as remembered here, or undefined when none is. */
export function rememberedChain(agentId: string): number | undefined {
  const value = memory.get(agentId) ?? stored()[agentId];
  return known(value) ? value : undefined;
}

/** Whether the owner's chain for this agent is an Arc network (then no Base wallet is made). */
export const choseArc = (agentId: string): boolean => {
  const chain = rememberedChain(agentId);
  return chain === ARC_MAINNET || chain === ARC_TESTNET;
};

/** Tests only. */
export function forgetChains(): void {
  memory.clear();
  try {
    globalThis.sessionStorage?.removeItem(KEY);
  } catch {
    // Nothing stored.
  }
}
