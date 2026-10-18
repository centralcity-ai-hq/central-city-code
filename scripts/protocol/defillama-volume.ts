/**
 * The DefiLlama adapter's volume rule (docs/protocol/DEFILLAMA_ADAPTER.md), kept here so it is
 * tested: the adapter in that doc carries this exact function (tests/defillama-adapter.test.ts).
 *
 * A fee-on-top call (kind 0) moves only the fee through the router; the seller's payment is a
 * separate USDC transfer made right before it. Its price counts as volume only when it is matched
 * to such a transfer in the SAME fetch window: exactly `gross`, from the payer to the payee, earlier
 * in the chain than the fee (block, then log index) and at most `lookback` blocks before it. Each
 * transfer (transaction hash + log index) backs one fee at most, matched in chain order, earliest
 * first. Only the window's own transfers are passed in, so a transfer is never counted in two
 * windows; a payment just before a window's start is not matched (an undercount, never an
 * overcount). A fee-included call (kind 1) moves the price itself in the router call, so its price
 * always counts.
 */
export function settledVolume(
  fees: {
    kind: number;
    payer: string;
    payee: string;
    gross: bigint;
    block: number;
    index: number;
  }[],
  transfers: {
    from: string;
    to: string;
    value: bigint;
    block: number;
    index: number;
    tx: string;
  }[],
  lookback: number,
): bigint[] {
  const key = (from: string, to: string, value: bigint) =>
    `${from.toLowerCase()}:${to.toLowerCase()}:${value.toString()}`;
  const before = (a: { block: number; index: number }, b: { block: number; index: number }) =>
    a.block < b.block || (a.block === b.block && a.index < b.index);
  const seen = new Set<string>();
  const open = new Map<string, { block: number; index: number }[]>();
  for (const t of [...transfers].sort((a, b) => a.block - b.block || a.index - b.index)) {
    const id = `${t.tx.toLowerCase()}:${t.index}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const k = key(t.from, t.to, t.value);
    open.set(k, [...(open.get(k) ?? []), { block: t.block, index: t.index }]);
  }
  const order = fees
    .map((_, i) => i)
    .sort((a, b) => fees[a].block - fees[b].block || fees[a].index - fees[b].index);
  const volume = fees.map(() => 0n);
  for (const i of order) {
    const fee = fees[i];
    if (Number(fee.kind) === 1) {
      volume[i] = fee.gross;
      continue;
    }
    const candidates = open.get(key(fee.payer, fee.payee, fee.gross)) ?? [];
    const at = candidates.findIndex((t) => before(t, fee) && t.block >= fee.block - lookback);
    if (at === -1) continue;
    candidates.splice(at, 1);
    volume[i] = fee.gross;
  }
  return volume;
}
