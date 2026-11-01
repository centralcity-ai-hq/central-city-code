import { latestRatings, RATING_DECIMALS } from '../../shared/base/rating-score';
import type { ServiceCall } from '../../shared/explorer-calls';
import type { ReputationEntry } from '../verify/onBaseData';

/*
 * The Explorer agent page's pure rules (approved design, 24 Oct 2026). Until the X3 series exist,
 * the page reads the agent's newest paid calls and says which window they cover; every number here
 * is computed from those calls only, never estimated past them.
 */

/** "1.8" USDC as micro-USDC (6 decimals), exact; null for anything that is not a plain amount. */
export function toMicro(text: string): bigint | null {
  const m = /^(\d+)(?:\.(\d{1,6}))?$/.exec(text.trim());
  if (!m) return null;
  return BigInt(m[1]) * 1_000_000n + BigInt((m[2] ?? '').padEnd(6, '0'));
}

/** Micro-USDC as "18.00": two decimals, more only when they carry a value ("0.072"). */
export function usdcText(micro: bigint): string {
  const whole = micro / 1_000_000n;
  const frac = (micro % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return `${whole.toLocaleString('en-US')}.${frac.padEnd(2, '0')}`;
}

export type SoldService = { title: string; calls: number; price: string; earnedMicro: bigint };

export type CallsSummary = {
  /** Calls in the window where this wallet was paid, and where it paid. */
  sold: number;
  bought: number;
  /** What reached this wallet (after the fee) in the window. */
  earnedMicro: bigint;
  /** Distinct wallets that paid it in the window. */
  buyers: number;
  /** Services it was paid for in the window, most calls first. */
  services: SoldService[];
  /** The oldest call read: the window is from here to now. Null without calls. */
  since: number | null;
};

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Sums the calls of one wallet: what it sold (it was the provider) and what it bought. */
export function summarizeCalls(calls: ServiceCall[], wallet: string): CallsSummary {
  let sold = 0;
  let bought = 0;
  let earnedMicro = 0n;
  const buyers = new Set<string>();
  const services = new Map<string, SoldService>();
  let since: number | null = null;
  for (const call of calls) {
    since = since === null ? call.time : Math.min(since, call.time);
    if (same(call.payer, wallet)) bought += 1;
    if (!same(call.provider, wallet)) continue;
    sold += 1;
    buyers.add(call.payer.toLowerCase());
    const earned = toMicro(call.provider_amount) ?? 0n;
    earnedMicro += earned;
    const service = services.get(call.service) ?? {
      title: call.service,
      calls: 0,
      price: call.amount,
      earnedMicro: 0n,
    };
    service.calls += 1;
    service.earnedMicro += earned;
    services.set(call.service, service);
  }
  return {
    sold,
    bought,
    earnedMicro,
    buyers: buyers.size,
    services: [...services.values()].sort((a, b) => b.calls - a.calls),
    since,
  };
}

/**
 * What this wallet earned per hour over the window the calls cover, oldest hour first: at most
 * `hours` buckets ending at `now`, and never an hour before the oldest call read (no call read
 * there is not the same as nothing earned).
 */
export function hourlyEarnings(
  calls: ServiceCall[],
  wallet: string,
  now: number,
  hours = 24,
): Array<{ start: number; micro: bigint }> {
  const HOUR = 3_600_000;
  const end = Math.floor(now / HOUR) * HOUR + HOUR;
  const oldest = calls.reduce((min, c) => Math.min(min, c.time), Infinity);
  if (!Number.isFinite(oldest)) return [];
  const first = Math.max(end - hours * HOUR, Math.floor(oldest / HOUR) * HOUR);
  const buckets: Array<{ start: number; micro: bigint }> = [];
  for (let start = first; start < end; start += HOUR) buckets.push({ start, micro: 0n });
  for (const call of calls) {
    if (!same(call.provider, wallet) || call.time < first || call.time >= end) continue;
    const bucket = buckets[Math.floor((call.time - first) / HOUR)];
    if (bucket) bucket.micro += toMicro(call.provider_amount) ?? 0n;
  }
  return buckets;
}

/**
 * The stars behind the Central City score among the entries read (the registry's last ones): the
 * latest valid rating of each wallet the score counts, by the score's own rule
 * (shared/base/rating-score.ts), as counts for 5 down to 1 star.
 */
export function starCounts(
  entries: ReputationEntry[],
  scoredBy: readonly string[],
  agentWallet: string | null,
): number[] {
  const feedback = entries.flatMap((entry) =>
    /^\d{1,30}$/.test(entry.score)
      ? [
          {
            client: entry.client,
            index: BigInt(entry.index),
            value: BigInt(entry.score),
            decimals: RATING_DECIMALS,
            tag1: entry.tags[0] ?? '',
          },
        ]
      : [],
  );
  const counts = [0, 0, 0, 0, 0];
  for (const rating of latestRatings(feedback, scoredBy, agentWallet))
    counts[5 - rating.stars] += 1;
  return counts;
}
