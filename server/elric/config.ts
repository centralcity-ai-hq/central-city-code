/**
 * Elric configuration (docs/ELRIC.md). Everything is off unless CITY_ELRIC=1. The numbers are
 * the launch proposal and are constants on purpose: allowances are platform
 * limits, never owner-raisable.
 */
export type ElricKind = 'short' | 'summary' | 'tool';
type Env = Record<string, string | undefined>;
export type ElricTier = 0 | 1 | 2;

export interface ElricConfig {
  /** Free allowance per owner and UTC day, per kind of request. */
  allowance: Record<ElricKind, number>;
  /**
   * Global ceiling per UTC day in cost units (ELRIC_COST_UNIT_USD each), across every owner,
   * inside the same atomic reservation as the allowance.
   */
  globalDailyUnits: number;
  /**
   * Cost units one owner may reserve and spend per UTC day, across every kind, checked in the same
   * reservation as the allowance count: the count alone does not bound cost, so without this a
   * few owners steering every run to its worst case could use up the global ceiling for everyone.
   */
  ownerDailyUnits: number;
  /**
   * Cost units reserved per adapter step: the worst case of one call on that tier, with the
   * largest context a turn can build (transcript + tool results + system ≈ 76k characters ≈ 25k
   * tokens at 3 characters per token) and maxOutputTokens.
   */
  unitsPerStep: Record<1 | 2, number>;
  /** Cost units per 1,000 input and output tokens, for the settled (measured) cost. */
  unitsPer1kTokens: Record<1 | 2, { input: number; output: number }>;
  /** Model ids per tier (served by the self-hosted endpoint, or the mock in tests). */
  models: Record<1 | 2, string>;
  /** Adapter calls (steps) per invocation, tool calls included. */
  maxSteps: number;
  /** Tool calls honoured per adapter step; the rest are refused (refused_cap). */
  maxToolCallsPerStep: number;
  /** Characters of tool results per invocation (bounds the context the loop can build). */
  toolResultChars: number;
  /** Output tokens per adapter call. */
  maxOutputTokens: number;
  /** Room messages given as context (newest first up to the trigger). */
  contextMessages: number;
  /** Characters of rendered room transcript given as context (the newest messages win). */
  transcriptChars: number;
  /** Characters of a posted reply. */
  replyChars: number;
  /** An invocation older than this is not answered. */
  expiryMs: number;
  /**
   * A lease is renewed by every recheck (before each adapter step, each tool call, each
   * cold-start retry and the post), so it must outlast the longest stretch between two rechecks:
   * one adapter call (at most 45 s plus the 5 s connect) or one cold-start wait (at most 15 s),
   * with a wide margin. A live run never loses its lease to another drain.
   */
  leaseMs: number;
  /** Pending actions expire after this. */
  pendingActionTtlMs: number;
  /**
   * Cold start, never waited for inside a function run: on `waking` the invocation is deferred
   * (lease released, reservation kept) and retried by a later drain no sooner than `wakeRetryMs`;
   * `wakeMaxMs` after the first `waking` it gives up with `model_waking` and a refund.
   */
  wakeMaxMs: number;
  wakeRetryMs: number;
  /**
   * Wall time one function run may spend on invocations (the drain budget). It must stay inside
   * the platform's function limit (vercel.json `maxDuration` 30 s) with a margin; a test ties the
   * two together. Each model call is capped at what is left minus `callMarginMs`; when less than
   * `minCallMs` would be left, the invocation is deferred (before its first model call) or stopped
   * honestly (after one). CITY_ELRIC_RUN_BUDGET_MS overrides it when the limit is raised.
   */
  runBudgetMs: number;
  callMarginMs: number;
  minCallMs: number;
  /** Pending actions (consequential tool calls) one run may create; more are refused. */
  maxPendingPerRun: number;
}

/**
 * The cost unit: 1 micro-USD (migration 45; it was USD 0.0025 of GPU time). Hosted model calls
 * are priced per token (token-cost.ts); self-hosted fallback turns keep GPU-second
 * costing below. The global ceiling is USD 50 per day (H3): 50 / 0.000001 = 50,000,000 units.
 */
export const ELRIC_COST_UNIT_USD = 0.000001;
export const ELRIC_GLOBAL_DAILY_USD = 50;
export const ELRIC_GLOBAL_DAILY_UNITS = Math.round(ELRIC_GLOBAL_DAILY_USD / ELRIC_COST_UNIT_USD);
/**
 * One owner's share of the day: USD 5 (a tenth of the global ceiling). It fits several
 * worst-case reservations at once (about USD 0.9 each), and a typical answer spends far less.
 */
export const ELRIC_OWNER_DAILY_USD = 5;
export const ELRIC_OWNER_DAILY_UNITS = Math.round(ELRIC_OWNER_DAILY_USD / ELRIC_COST_UNIT_USD);

/**
 * Measured GPU time per 1,000 tokens on each tier (seconds), and the GPU price. Cost units follow
 * from them: units per 1k tokens = GPU-seconds × (USD per hour / 3600) / ELRIC_COST_UNIT_USD. The
 * defaults are the ASSUMED figures (at USD 2.50 per hour one unit is 3.6 GPU-seconds) until a
 * self-hosted run is measured; then set CITY_ELRIC_GPU_USD_PER_HOUR and
 * CITY_ELRIC_T{1,2}_GPU_S_PER_1K_{IN,OUT} (elricRates).
 */
export interface ElricGpuRates {
  gpuUsdPerHour: number;
  gpuSecondsPer1k: Record<1 | 2, { input: number; output: number }>;
}
export const ELRIC_DEFAULT_GPU_RATES: ElricGpuRates = {
  gpuUsdPerHour: 2.5,
  gpuSecondsPer1k: { 1: { input: 0.18, output: 5.4 }, 2: { input: 1.08, output: 28.8 } },
};
/**
 * The largest context one step can carry (tokens), for the per-step reservation: transcript
 * (80k chars) + tool results (48k) + system, tools and earlier steps (about 12k) = about 140k
 * characters, at the estimate's 2 characters per token (token-cost.ts), so dense text (CJK, emoji)
 * is covered too.
 */
export const ELRIC_STEP_CONTEXT_TOKENS = 72_000;

/**
 * Extended thinking budget (tokens) on Tier 2 and on questions the router marks complex. Thinking
 * tokens are billed as output, so they are part of maxOutputTokens (the reservation's worst case).
 */
export const ELRIC_THINKING_BUDGET_TOKENS = 2_000;

/** Cost units per 1k tokens per tier, from GPU rates (rounded to 1/10,000 of a unit). */
export function unitsPer1kFromGpu(rates: ElricGpuRates): ElricConfig['unitsPer1kTokens'] {
  const perSecond = rates.gpuUsdPerHour / 3600 / ELRIC_COST_UNIT_USD;
  const round = (value: number) => Math.round(value * perSecond * 10_000) / 10_000;
  const tier = (t: 1 | 2) => ({
    input: round(rates.gpuSecondsPer1k[t].input),
    output: round(rates.gpuSecondsPer1k[t].output),
  });
  return { 1: tier(1), 2: tier(2) };
}
/**
 * Units reserved per step on the self-hosted (GPU-priced) path: the largest context plus
 * maxOutputTokens at the tier's rate. A per-token provider reserves its own worst case instead
 * (service.ts, token-cost.ts anthropicWorstUnits).
 */
export function unitsPerStepFrom(
  perK: ElricConfig['unitsPer1kTokens'],
  maxOutputTokens: number,
): ElricConfig['unitsPerStep'] {
  const step = (t: 1 | 2) =>
    Math.ceil(
      (ELRIC_STEP_CONTEXT_TOKENS / 1000) * perK[t].input +
        (maxOutputTokens / 1000) * perK[t].output,
    );
  return { 1: step(1), 2: step(2) };
}

/**
 * Rates from the environment (names only; values are measurements, not secrets). Missing values
 * keep the defaults; an invalid value (not a positive finite number) fails startup.
 */
export function elricRates(env: Env = process.env): ElricGpuRates {
  const read = (name: string, fallback: number) => {
    const raw = env[name];
    if (raw === undefined || raw === '') return fallback;
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0 || value > 1_000_000)
      throw new Error(`${name} must be a positive number.`);
    return value;
  };
  const d = ELRIC_DEFAULT_GPU_RATES;
  const tier = (t: 1 | 2) => ({
    input: read(`CITY_ELRIC_T${t}_GPU_S_PER_1K_IN`, d.gpuSecondsPer1k[t].input),
    output: read(`CITY_ELRIC_T${t}_GPU_S_PER_1K_OUT`, d.gpuSecondsPer1k[t].output),
  });
  return {
    gpuUsdPerHour: read('CITY_ELRIC_GPU_USD_PER_HOUR', d.gpuUsdPerHour),
    gpuSecondsPer1k: { 1: tier(1), 2: tier(2) },
  };
}

/** The rate-dependent part of the configuration, for the given GPU rates. */
export function elricRateConfig(
  rates: ElricGpuRates,
  // The worst case of one step: the largest answer plus the thinking budget.
  maxOutputTokens = 2_400 + ELRIC_THINKING_BUDGET_TOKENS,
): Pick<ElricConfig, 'unitsPer1kTokens' | 'unitsPerStep'> {
  const unitsPer1kTokens = unitsPer1kFromGpu(rates);
  return { unitsPer1kTokens, unitsPerStep: unitsPerStepFrom(unitsPer1kTokens, maxOutputTokens) };
}

export const ELRIC_CONFIG: ElricConfig = {
  allowance: { short: 20, summary: 4, tool: 5 },
  globalDailyUnits: ELRIC_GLOBAL_DAILY_UNITS,
  ownerDailyUnits: ELRIC_OWNER_DAILY_UNITS,
  ...elricRateConfig(ELRIC_DEFAULT_GPU_RATES),
  models: { 1: 'elric-small', 2: 'elric-large' },
  maxSteps: 8,
  maxToolCallsPerStep: 4,
  toolResultChars: 48_000,
  // The largest answer (Tier 2: 2,400 tokens) plus the thinking budget: the reservation's worst case.
  maxOutputTokens: 2_400 + ELRIC_THINKING_BUDGET_TOKENS,
  contextMessages: 100,
  transcriptChars: 80_000,
  replyChars: 12_000,
  expiryMs: 10 * 60_000,
  leaseMs: 8 * 20_000 + 30_000,
  pendingActionTtlMs: 15 * 60_000,
  wakeMaxMs: 120_000,
  wakeRetryMs: 10_000,
  runBudgetMs: 55_000,
  callMarginMs: 2_000,
  minCallMs: 4_000,
  maxPendingPerRun: 3,
};

/** The run budget from CITY_ELRIC_RUN_BUDGET_MS (when the function limit is raised), else 55 s. */
export function elricRunBudgetMs(env: Env = process.env): number {
  const raw = env.CITY_ELRIC_RUN_BUDGET_MS;
  if (raw === undefined || raw === '') return ELRIC_CONFIG.runBudgetMs;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 10_000 || value > 790_000)
    throw new Error(
      'CITY_ELRIC_RUN_BUDGET_MS must be a whole number of ms between 10000 and 790000.',
    );
  return value;
}

/** The feature flag, read at call time. */
export function elricEnabled(env: Env = process.env): boolean {
  return env.CITY_ELRIC === '1';
}

/** The environment kill switch (the database flag is checked separately, see budget.ts). */
export function elricKilledByEnv(env: Env = process.env): boolean {
  return env.CITY_ELRIC_KILL === '1';
}

export const DAY_MS = 86_400_000;
export const dayOf = (time: number) => new Date(time).toISOString().slice(0, 10);
/** The next 00:00 UTC after `time`: when allowances reset. */
export const resetAt = (time: number) => Math.floor(time / DAY_MS) * DAY_MS + DAY_MS;
