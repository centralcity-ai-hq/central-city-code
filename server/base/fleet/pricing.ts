import { parseProviderPricing, providerBoundWei } from '../chain/provider-pricing.js';

export interface FleetPricingSnapshot {
  version: string;
  terms: { markupBps: number; fixedPerOpWei: string };
}

/** Persist both fields with the job fee budget; never re-read live pricing at settlement. */
export function snapshotFleetPricing(setting: string): FleetPricingSnapshot {
  const pricing = parseProviderPricing(setting);
  return {
    version: pricing.version,
    terms: { markupBps: pricing.markupBps, fixedPerOpWei: pricing.fixedPerOpWei.toString() },
  };
}

/** Used for both the initial maximum hold and the canonical receipt's actual fee.
 * The caller supplies the locked budget row's version and terms, not environment settings.
 */
export function fleetProviderFee(wei: bigint, version: string, terms: unknown): bigint {
  if (typeof wei !== 'bigint' || wei < 0n || wei >= 2n ** 256n)
    throw new Error('Invalid fleet fee amount.');
  if (!terms || typeof terms !== 'object') throw new Error('Invalid stored fleet pricing.');
  const { markupBps, fixedPerOpWei } = terms as Record<string, unknown>;
  if (
    typeof version !== 'string' ||
    !/^[A-Za-z0-9._-]{1,64}$/.test(version) ||
    typeof markupBps !== 'number' ||
    !Number.isInteger(markupBps) ||
    markupBps < 0 ||
    markupBps > 10_000 ||
    typeof fixedPerOpWei !== 'string' ||
    !/^(0|[1-9][0-9]{0,29})$/.test(fixedPerOpWei)
  )
    throw new Error('Invalid stored fleet pricing.');
  const result = providerBoundWei(
    wei,
    parseProviderPricing(`${version}:${markupBps}:${fixedPerOpWei}`),
  );
  if (result >= 2n ** 256n) throw new Error('Fleet provider fee exceeds uint256.');
  return result;
}
