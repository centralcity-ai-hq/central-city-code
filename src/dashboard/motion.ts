import { useEffect, useRef, useState } from 'react';

/*
 * Soft transitions for the Agent Dashboard: numbers count to their new value and chart series
 * morph point by point (a series of another length is first resampled onto the new one, so a
 * range switch morphs instead of redrawing). With prefers-reduced-motion the new values show at
 * once.
 */

export const NUMBER_MS = 600;
export const CHART_MS = 500;

export const easeOutCubic = (t: number) => 1 - (1 - t) ** 3;
export const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

export function reducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

/** `values` stretched onto `length` points by linear interpolation (same first and last). */
export function resample(values: readonly number[], length: number): number[] {
  if (length <= 0) return [];
  if (values.length === 0) return Array.from({ length }, () => 0);
  if (values.length === 1 || length === 1) return Array.from({ length }, () => values[0]!);
  if (values.length === length) return [...values];
  return Array.from({ length }, (_, i) => {
    const pos = (i / (length - 1)) * (values.length - 1);
    const lo = Math.floor(pos);
    const hi = Math.min(values.length - 1, lo + 1);
    return values[lo]! + (values[hi]! - values[lo]!) * (pos - lo);
  });
}

/** Mixes two arrays of the same length: from + (to - from) * k. */
export const mix = (from: readonly number[], to: readonly number[], k: number) =>
  to.map((v, i) => (from[i] ?? v) + (v - (from[i] ?? v)) * k);

/**
 * The array shown while it moves toward `target` over `ms`. A new target starts from what is on
 * screen at that moment, so quick clicks never jump.
 */
export function useTweenedArray(
  target: readonly number[],
  ms = CHART_MS,
  ease: (t: number) => number = easeInOutCubic,
): number[] {
  const [shown, setShown] = useState<number[]>(() => [...target]);
  const shownRef = useRef(shown);
  shownRef.current = shown;
  const key = target.join(',');
  useEffect(() => {
    const to = [...target];
    if (reducedMotion() || shownRef.current.length === 0) {
      setShown(to);
      return;
    }
    const from = resample(shownRef.current, to.length);
    const start = performance.now();
    let frame = 0;
    const step = (now: number) => {
      const k = Math.min(1, (now - start) / ms);
      setShown(mix(from, to, ease(k)));
      if (k < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
    // The values themselves are the dependency (a new array with the same numbers does nothing).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, ms]);
  return shown;
}

/** One number counting toward `target` (ease-out). */
export function useTweenedNumber(target: number, ms = NUMBER_MS): number {
  return useTweenedArray([target], ms, easeOutCubic)[0] ?? target;
}
