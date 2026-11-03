/*
 * The strip's counts never go down within a page session (the same rule as the landing page's
 * LiveNumbers, #950): a poll that answers an older cached copy, from this view or one opened
 * before it, keeps the highest number already shown. Per number. A large drop (a real reset or
 * correction after a deploy) is shown at once.
 */
const HIGH_KEY = 'cc-explorer-strip-high';
/** A drop larger than this share of the known number is real, not a stale cache. */
export const STRIP_REAL_DROP = 0.01;
export type StripKey = 'all' | 'base' | 'arc' | 'calls';
const high: Partial<Record<StripKey, number>> = (() => {
  try {
    const raw = typeof sessionStorage === 'undefined' ? null : sessionStorage.getItem(HIGH_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === 'object'
      ? (parsed as Partial<Record<StripKey, number>>)
      : {};
  } catch {
    return {};
  }
})();

/** The number to show for `key`: never below the session's highest, unless it is a large drop. */
export function stripCount(key: StripKey, value: number): number {
  const known = high[key];
  if (typeof known === 'number' && value < known && known - value <= known * STRIP_REAL_DROP) {
    return known;
  }
  high[key] = value;
  try {
    sessionStorage.setItem(HIGH_KEY, JSON.stringify(high));
  } catch {
    // Storage blocked: the clamp still holds for this page.
  }
  return value;
}

/** Clears the session's highest numbers (tests). */
export function resetStripCounts() {
  for (const k of Object.keys(high) as StripKey[]) delete high[k];
}
