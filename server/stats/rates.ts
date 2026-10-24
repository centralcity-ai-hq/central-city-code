/*
 * How fast each public number has grown recently, from the values this instance has served: per
 * key, the newest reading against the oldest one at least RATE_MIN_SPAN_MS older and at most
 * RATE_MAX_SPAN_MS old. The homepage uses it to count up at once, from the value about 30 s ago
 * to the current one, so every number it shows is one that was real. No rate while too little is
 * known, and none for a number that went down.
 */
export const RATE_MIN_SPAN_MS = 20_000;
export const RATE_MAX_SPAN_MS = 10 * 60_000;
const MAX_SAMPLES = 64;

interface Sample {
  value: number;
  at: number;
}

export interface RateTracker {
  /** One reading of `key`, taken at `at` (epoch ms); repeats of the same reading are ignored. */
  observe(key: string, value: number, at: number): void;
  /** Growth per second of `key` as of `now`, or null when not known. */
  rate(key: string, now: number): number | null;
}

export function createRateTracker(): RateTracker {
  const samples = new Map<string, Sample[]>();
  return {
    observe(key, value, at) {
      if (!Number.isFinite(value) || !Number.isFinite(at)) return;
      const list = samples.get(key) ?? [];
      const last = list.at(-1);
      if (last && at <= last.at) return;
      list.push({ value, at });
      while (list.length > MAX_SAMPLES || (list.length > 1 && at - list[0]!.at > RATE_MAX_SPAN_MS))
        list.shift();
      samples.set(key, list);
    },
    rate(key, now) {
      const list = samples.get(key);
      const newest = list?.at(-1);
      if (!list || !newest || now - newest.at > RATE_MAX_SPAN_MS) return null;
      const oldest = list.find((s) => newest.at - s.at >= RATE_MIN_SPAN_MS);
      if (!oldest) return null;
      const rate = ((newest.value - oldest.value) * 1000) / (newest.at - oldest.at);
      return rate >= 0 ? rate : null;
    },
  };
}
