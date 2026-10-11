import { useEffect, useState } from 'react';
import { ON_BASE_PATHS, type OnBasePassport } from '../../shared/base/on-base';
import type { CityScore } from '../../shared/base/rating-score';

/*
 * An agent's own Central City score in My agents (shared/base/rating-score.ts), read from its
 * public passport (the same answer the passport page shows). Only for a final Base ID; anything
 * else, a failed read or no counted rating is null, and the screens then show no score line.
 */

const scores = new Map<string, CityScore | null>();

/** The passport's score for this Base ID; null until read, without one, or while `baseId` is null. */
export function useCityScore(baseId: string | null, paused = false): CityScore | null {
  const [score, setScore] = useState<CityScore | null>(() =>
    baseId === null ? null : (scores.get(baseId) ?? null),
  );
  useEffect(() => {
    if (baseId === null || !/^[0-9]{1,78}$/.test(baseId)) {
      setScore(null);
      return;
    }
    setScore(scores.get(baseId) ?? null);
    if (paused) return;
    const controller = new AbortController();
    fetch(`${ON_BASE_PATHS.passport}/${baseId}`, {
      headers: { accept: 'application/json' },
      signal: controller.signal,
    })
      .then((response) => (response.ok ? (response.json() as Promise<OnBasePassport>) : null))
      .then((passport) => {
        // Not read on Base keeps the last score known; a read without one clears it.
        if (!passport || passport.reputation?.readAtBlock == null) return;
        const found = passport.reputation.score ?? null;
        scores.set(baseId, found);
        setScore(found);
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [baseId, paused]);
  return score;
}
