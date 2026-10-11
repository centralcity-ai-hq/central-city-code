/**
 * A fixed test clock for the app fixture (`createApp({ now })`), pinned just after a UTC day
 * boundary, which is also a minute, quarter-hour and hour boundary. Rate-limit windows are fixed
 * and aligned to the clock, so with this clock every request of a test lands in one window: a
 * test that fills a per-minute (or hourly, or daily) budget and expects the next request to be
 * refused cannot be split across two windows by the wall clock ticking over during the run.
 *
 * `offsetMs` moves the pinned time within the window (e.g. 59_900, 0.1 s before the next minute).
 */
export function windowClock(offsetMs = 1): () => number {
  const DAY = 86_400_000;
  const pinned = Math.floor(Date.now() / DAY) * DAY + offsetMs;
  return () => pinned;
}
