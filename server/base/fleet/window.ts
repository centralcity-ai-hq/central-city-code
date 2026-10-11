/** Recheck after acquiring transaction locks, immediately before reserving a batch.
 * Signed timestamps are seconds; storage and the server clock are milliseconds.
 * This only checks time: signature, principal, balances and atomic caps remain required.
 */
export function fleetWindowOpen(notBefore: number, expiry: number, nowMs: number): boolean {
  if (![notBefore, expiry, nowMs].every((v) => Number.isSafeInteger(v) && v >= 0)) return false;
  if (expiry <= notBefore) return false;
  // BigInt preserves exact boundaries without overflowing the safe Number range.
  const now = BigInt(nowMs);
  return now >= BigInt(notBefore) * 1000n && now < BigInt(expiry) * 1000n;
}
