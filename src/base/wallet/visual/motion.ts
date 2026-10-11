/*
 * Base Wallet visuals: whether to move at all. Under prefers-reduced-motion every visual shows
 * its final state at once (the stylesheet turns the CSS transitions off; this covers the canvas
 * and the frame loops).
 */
export function reducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}
