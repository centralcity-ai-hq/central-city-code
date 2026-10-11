/*
 * Paymaster provider pricing (fee budgets for bulk runs). The on-chain bound of an operation
 * (`maxCostWei`) is what the EntryPoint can charge the paymaster; the provider may bill on top of
 * that. A run's fee budget therefore needs an explicit, versioned pricing configuration, frozen into
 * the run when it is authorized, so a later config change can never alter an approved budget.
 *
 * `CITY_BASE_PROVIDER_PRICING` = `<version>:<markupBps>:<fixedPerOpWei>`, e.g. `2026-10-08:700:0`
 * (7 % markup, no fixed per-operation charge). Without it, bulk runs on the real network refuse.
 */

export interface ProviderPricing {
  /** Identifies the published pricing this was taken from; stored with every run. */
  version: string;
  /** Markup on sponsored gas, in basis points (1 bps = 0.01 %). */
  markupBps: number;
  /** Fixed charge per sponsored operation, in wei (0 when the provider has none). */
  fixedPerOpWei: bigint;
}

export class PricingError extends Error {
  constructor(
    readonly code: 'PRICING_MISSING' | 'PRICING_MALFORMED',
    message: string,
  ) {
    super(message);
  }
}

/** Parses the pricing setting; refuses missing or malformed values (callers fail closed). */
export function parseProviderPricing(value: string | undefined): ProviderPricing {
  if (!value) throw new PricingError('PRICING_MISSING', 'Provider pricing is not configured.');
  const match = /^([A-Za-z0-9._-]{1,64}):(\d{1,5}):(\d{1,30})$/.exec(value.trim());
  if (!match) throw new PricingError('PRICING_MALFORMED', 'Provider pricing is malformed.');
  const markupBps = Number(match[2]);
  if (markupBps > 10_000)
    throw new PricingError('PRICING_MALFORMED', 'Markup above 100 % is not accepted.');
  return { version: match[1], markupBps, fixedPerOpWei: BigInt(match[3]) };
}

/**
 * Upper bound of what one operation can cost in total: its on-chain bound plus the provider's
 * markup (rounded up, never down) plus any fixed per-operation charge.
 */
export function providerBoundWei(maxCostWei: bigint, pricing: ProviderPricing): bigint {
  if (maxCostWei < 0n) throw new RangeError('Cost bound must be non-negative.');
  const markup = (maxCostWei * BigInt(pricing.markupBps) + 9_999n) / 10_000n;
  return maxCostWei + markup + pricing.fixedPerOpWei;
}
