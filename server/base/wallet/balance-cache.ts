/*
 * Wallet balances as the wallet screen shows them: a read of Base is reused for ~10 s per wallet,
 * and concurrent requests for one wallet share one read. When a read fails, the last good read is
 * served with its true time and `stale: true`; without one the caller gets ChainUnavailableError.
 * A failure is never turned into zeros with a fresh time. A failed wallet is not read again within
 * the same window, so an outage does not multiply into one RPC call per request.
 */
import type { Address } from '../../../shared/base/chains.js';
import type { BalanceReader, WalletBalances } from '../chain/balances.js';

export const BALANCE_CACHE_MS = 10_000;
/** Wallets remembered at once per instance; the oldest idle entry makes room for a new one. */
export const BALANCE_CACHE_ENTRIES = 10_000;

export class ChainUnavailableError extends Error {
  constructor() {
    super('Base could not be read.');
  }
}

export interface BalanceRead {
  balances: WalletBalances;
  /** When this read answered (ms); kept as it was when the read is served again. */
  readAt: number;
  /** True when a newer read failed and this older one is served instead. */
  stale: boolean;
}

interface Entry {
  good: { balances: WalletBalances; readAt: number } | null;
  failedAt: number | null;
  pending: Promise<void> | null;
}

export function balanceCache(
  reader: BalanceReader,
  options: { now?: () => number; ttlMs?: number; maxEntries?: number } = {},
) {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? BALANCE_CACHE_MS;
  const maxEntries = options.maxEntries ?? BALANCE_CACHE_ENTRIES;
  const entries = new Map<string, Entry>();

  const fallback = (entry: Entry): BalanceRead => {
    if (!entry.good) throw new ChainUnavailableError();
    return { ...entry.good, stale: true };
  };

  function entryFor(key: string): Entry {
    const known = entries.get(key);
    if (known) return known;
    if (entries.size >= maxEntries)
      for (const [oldKey, old] of entries)
        if (!old.pending) {
          entries.delete(oldKey);
          break;
        }
    const entry: Entry = { good: null, failedAt: null, pending: null };
    entries.set(key, entry);
    return entry;
  }

  return {
    async read(wallet: Address): Promise<BalanceRead> {
      const entry = entryFor(wallet.toLowerCase());
      const at = now();
      if (!entry.pending) {
        if (entry.good && at - entry.good.readAt < ttlMs) return { ...entry.good, stale: false };
        if (entry.failedAt !== null && at - entry.failedAt < ttlMs) return fallback(entry);
        entry.pending = reader.balances(wallet).then(
          (balances) => {
            entry.good = { balances, readAt: now() };
            entry.failedAt = null;
          },
          () => {
            entry.failedAt = now();
          },
        );
        void entry.pending.finally(() => {
          entry.pending = null;
        });
      }
      await entry.pending;
      if (entry.failedAt === null && entry.good) return { ...entry.good, stale: false };
      return fallback(entry);
    },
  };
}
