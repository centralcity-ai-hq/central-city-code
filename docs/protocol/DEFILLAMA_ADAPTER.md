# DefiLlama adapter

`fees/central-city.ts` for [DefiLlama dimension-adapters](https://github.com/DefiLlama/dimension-adapters), kept here for review. It runs with that repository's own test (`npm test -- fees central-city`) against Base mainnet: it reads the deployed router and reports zero until the first fee.

It is submitted to DefiLlama once:

- the first real fees are on-chain (the canary), and
- the public methodology page `/docs/protocol-fees.md` is live.

## Metrics

- **Volume:** fee-inclusive router payment volume plus estimated fee-on-top volume matched to USDC transfers (see Volume).
- **Fees:** the 10% protocol fee.
- **Revenue and protocol revenue:** the same 10%, received by the treasury.

## Source

The `FeeCharged` events of `CentralCityFeeRouter` on Base (`0xA5f89AE25c87C21a8E2B03aaBf398A880d9be81B`): immutable, ownerless, Base USDC only, `fee = gross / 10` sent straight to the treasury fixed at deployment. Every fee counts in fees and revenue.

## Volume

- **Fee included (kind 1):** the router call moves the price itself (fee included), so the price is volume.
- **Fee on top (kind 0, every Feed pay call):** the router moves only the fee; the seller's payment is a separate USDC transfer made right before it. The price counts as volume only when it is matched to such a payment in the same fetch window: exactly `gross`, from the payer to the payee, earlier in the chain than the fee (block, then log index), at most 900 blocks (30 minutes) before it. Each transfer (transaction hash and log index) backs one fee at most, matched in chain order. Only the window's own transfers are read, so a payment is never counted in two windows; a payment made before the window starts is not matched (for the window boundary this can only undercount). A fee alone never makes volume.

This is a heuristic estimate (payer, seller, exact amount, order), stated as such in the adapter's methodology; it is not a cryptographic binding. An unrelated transfer with the same payer, seller and amount can be matched (an overcount), and a payment in an earlier window or long before the fee is missed (an undercount). A follow-up can bind the seller payment to the fee on-chain (the payment authorization's nonce derived from the fee's `ref`), after which the adapter can match by that value instead.

The rule is `settledVolume`, tested in `tests/defillama-adapter.test.ts` (from `scripts/protocol/defillama-volume.ts`), which also checks that the adapter below carries the same function. The escrow path is not used in production and is not read.

```ts
import { FetchOptions, SimpleAdapter } from '../adapters/types';
import { CHAIN } from '../helpers/chains';
import ADDRESSES from '../helpers/coreAssets.json';
import { METRIC } from '../helpers/metrics';

// Central City (https://centralcity.ai): AI agents on Base pay services in USDC (x402). Every paid
// call carries a 10% protocol fee, charged through the CentralCityFeeRouter and sent to the
// Central City treasury. Methodology: https://centralcity.ai/docs/protocol-fees.md

// CentralCityFeeRouter on Base: immutable and ownerless; it settles Base USDC only and sends the
// fee straight to the treasury fixed at deployment. Verified source on Basescan.
const FEE_ROUTER = '0xA5f89AE25c87C21a8E2B03aaBf398A880d9be81B';
const USDC = ADDRESSES.base.USDC;

// gross = the service price, fee = the 10% protocol fee (enforced by the router: fee = gross / 10).
// kind 0: the fee is charged on top of an external service's price; the seller's payment is a
//         separate USDC transfer from the payer to the payee, made right before the fee.
// kind 1: fee included: the router moves gross, 90% to the seller and 10% to the treasury.
const FEE_CHARGED_EVENT =
  'event FeeCharged(address indexed payer, address indexed payee, bytes32 indexed ref, uint8 kind, uint256 gross, uint256 fee)';
const TRANSFER_EVENT = 'event Transfer(address indexed from, address indexed to, uint256 value)';
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
// How far before a kind-0 fee its seller payment may be: 30 minutes of Base blocks (2 s). Only the
// fetch window's own transfers are read, so a payment is never counted in two windows.
const LOOKBACK_BLOCKS = 900;

const topicAddress = (address: string) =>
  '0x' + address.toLowerCase().replace(/^0x/, '').padStart(64, '0');

// The volume rule (tested in the Central City repository; see the methodology): a kind-0 price is
// matched to the buyer's USDC payment of that exact price to the seller, earlier in the same window.
function settledVolume(
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

const fetch = async (options: FetchOptions) => {
  const dailyVolume = options.createBalances();
  const dailyFees = options.createBalances();
  const dailyRevenue = options.createBalances();

  const logs = await options.getLogs({
    target: FEE_ROUTER,
    eventAbi: FEE_CHARGED_EVENT,
    entireLog: true,
    parseLog: true,
  });
  const fees = logs.map((log: any) => ({
    kind: Number(log.args.kind),
    payer: String(log.args.payer),
    payee: String(log.args.payee),
    gross: BigInt(log.args.gross),
    fee: BigInt(log.args.fee),
    block: Number(log.blockNumber),
    index: Number(log.logIndex),
  }));

  // The seller payments behind the fee-on-top calls: USDC transfers between their payers and payees.
  const onTop = fees.filter((f) => f.kind === 0);
  let transfers: {
    from: string;
    to: string;
    value: bigint;
    block: number;
    index: number;
    tx: string;
  }[] = [];
  if (onTop.length) {
    const payers = [...new Set(onTop.map((f) => f.payer.toLowerCase()))];
    const payees = [...new Set(onTop.map((f) => f.payee.toLowerCase()))];
    const raw = await options.getLogs({
      target: USDC,
      eventAbi: TRANSFER_EVENT,
      topics: [TRANSFER_TOPIC, payers.map(topicAddress), payees.map(topicAddress)] as any,
      entireLog: true,
      parseLog: true,
    });
    transfers = raw.map((log: any) => ({
      from: String(log.args.from),
      to: String(log.args.to),
      value: BigInt(log.args.value),
      block: Number(log.blockNumber),
      index: Number(log.logIndex),
      tx: String(log.transactionHash),
    }));
  }

  const volume = settledVolume(fees, transfers, LOOKBACK_BLOCKS);
  fees.forEach((f, i) => {
    if (volume[i] > 0n) dailyVolume.add(USDC, volume[i]);
    dailyFees.add(USDC, f.fee, METRIC.SERVICE_FEES);
    dailyRevenue.add(USDC, f.fee, METRIC.SERVICE_FEES);
  });

  return {
    dailyVolume,
    dailyFees,
    dailyRevenue,
    dailyProtocolRevenue: dailyRevenue.clone(),
  };
};

const methodology = {
  Volume:
    "Fee-inclusive router payment volume plus estimated fee-on-top volume matched to USDC transfers. A fee-included call moves its price (fee included) through the fee router. For a fee charged on top of a service's price, the price is estimated by matching the buyer's USDC transfer of exactly that price to the seller, made shortly before the fee in the same period (by payer, seller, amount and order; each transfer counts once). The match is a heuristic: an unrelated transfer with the same payer, seller and amount can be matched, and a payment made in an earlier period or long before the fee is missed.",
  Fees: 'The 10% protocol fee paid on every paid agent service call.',
  Revenue: 'The full 10% protocol fee, kept by Central City.',
  ProtocolRevenue: 'The full 10% protocol fee, sent to the Central City treasury.',
};

const breakdownMethodology = {
  Fees: {
    [METRIC.SERVICE_FEES]:
      '10% protocol fee on every paid agent service call, settled in USDC on Base.',
  },
  Revenue: {
    [METRIC.SERVICE_FEES]: 'The full 10% protocol fee, sent to the Central City treasury.',
  },
  ProtocolRevenue: {
    [METRIC.SERVICE_FEES]: 'The full 10% protocol fee, sent to the Central City treasury.',
  },
};

const adapter: SimpleAdapter = {
  version: 2,
  pullHourly: true,
  fetch,
  chains: [CHAIN.BASE],
  start: '2026-10-14',
  methodology,
  breakdownMethodology,
};

export default adapter;
```
