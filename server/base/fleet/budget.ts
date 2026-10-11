/** Integer base-unit accounting. Caller must read and reserve these values in one transaction.
 * This is arithmetic only: it does not verify signatures, ownership, balances, or reserve funds. */
export interface FleetBudgetLine {
  cap: bigint;
  spent: bigint;
  held: bigint;
  requested: bigint;
}

export type FleetBudgetBalance = Omit<FleetBudgetLine, 'requested'>;

/** Arithmetic for a new hold. Caller locks the budget and checks the batch's existing
 * reservation first: replaying this function is not idempotent. No database or funds change here.
 */
export function reserveFleetBudget(
  balance: FleetBudgetBalance,
  requested: bigint,
): FleetBudgetBalance {
  if (!fleetBudgetFits([{ ...balance, requested }]))
    throw new Error('Fleet reservation exceeds available budget.');
  return { cap: balance.cap, spent: balance.spent, held: balance.held + requested };
}

/** Arithmetic for one definitively settled batch, not permission to release a hold.
 * Caller must lock the budget and batch, verify a canonical receipt or an unsent fence,
 * and atomically persist the result with the batch's terminal transition exactly once.
 * Unknown outcomes must not call this function. Fees use the job's stored pricing terms.
 */
export function settleFleetBudget(
  balance: FleetBudgetBalance,
  reserved: bigint,
  actual: bigint,
): FleetBudgetBalance {
  if (
    !fleetBudgetFits([{ ...balance, requested: 0n }]) ||
    typeof reserved !== 'bigint' ||
    typeof actual !== 'bigint' ||
    reserved < 0n ||
    actual < 0n ||
    reserved > balance.held ||
    actual > reserved
  )
    throw new Error('Invalid fleet budget settlement.');
  return { cap: balance.cap, spent: balance.spent + actual, held: balance.held - reserved };
}

export function fleetBudgetFits(lines: readonly FleetBudgetLine[]): boolean {
  if (lines.length === 0) return false;
  const max = 1n << 256n;
  for (const line of lines) {
    if (
      !line ||
      [line.cap, line.spent, line.held, line.requested].some(
        (value) => typeof value !== 'bigint' || value < 0n || value >= max,
      )
    )
      return false;
    // Subtract instead of converting to Number or adding values in bounded integer storage.
    if (line.spent > line.cap) return false;
    const afterSpent = line.cap - line.spent;
    if (line.held > afterSpent || line.requested > afterSpent - line.held) return false;
  }
  return true;
}
