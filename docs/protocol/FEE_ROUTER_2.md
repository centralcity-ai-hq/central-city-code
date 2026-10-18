# Fee router 2: payments above 0.10 USDC (pinned spec)

18 Oct 2026. This file pins how payments above 0.10 USDC work in the app: code follows it, and a
change to it is agreed before the code changes.

All amounts are raw USDC units (6 decimals): `100_000` = 0.10 USDC, `100_000_000` = 100 USDC.

**Deployed and live (18 Oct 2026).** `CentralCityFeeRouter2` is at
`0xb1945a2af160e84e34f7c0fb0e4dd94fd4c0af0d` on Base (block `52767258`, source verified on Basescan,
runtime bytecode equal to the audited source), deployed by the treasury. Production has
`CITY_PROTOCOL_FEE_ROUTER2`, `CITY_PROTOCOL_FEE_ROUTER2_FROM_BLOCK=52767258` and
`CITY_PROTOCOL_FEE_ROUTER2_ENABLED=1`; the paymaster policy allows it; the 1 USDC canary is in
[CANARY.md](CANARY.md). DefiLlama: [DEFILLAMA_ADAPTER.md](DEFILLAMA_ADAPTER.md).

## 1. What changes and what does not

- **Router 1** (`CentralCityFeeRouter`, `0xA5f89AE25c87C21a8E2B03aaBf398A880d9be81B`, `MAX_TOTAL`
  `100_000`) stays live and unchanged. Every payment it takes today it keeps taking.
- **Router 2** (`CentralCityFeeRouter2`) is router 1 line for line except `MAX_TOTAL = 100_000_000`.
  Same token (USDC on Base), treasury (`0xAF36084a4dc0CE760A6dCfa46Cf129e140c92aa9`), `FEE_BPS`
  (1,000 = 10%), `MIN_INCLUDED` (`50_000`), functions (`pay`, `chargeFee`, `charged`), errors and
  `FeeCharged(payer, payee, ref, kind, gross, fee)` event. Ownerless and immutable .
- **Authorization does not change.** Every router payment is one UserOperation from the agent's
  spender account with an exact approval in the same operation: fee included
  `[USDC.approve(router, gross), router.pay(payee, gross, ref)]`, fee on top
  `[USDC.approve(router, fee), router.chargeFee(payee, gross, ref)]` (`fee-call.ts`). No standing
  allowance names a router; the owner-signed spending limit does not name one. Router 2 needs no new
  owner signature.

## 2. Configuration and the switch

| Setting                                                                        | Meaning                                                                                                             |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `CITY_PROTOCOL_FEE_ROUTER2`                                                    | router 2 address (all networks)                                                                                     |
| `CITY_PROTOCOL_FEE_ROUTER2_FROM_BLOCK`                                         | its deploy block; both are needed, else router 2 is not configured                                                  |
| `CITY_PROTOCOL_FEE_ROUTER2_ENABLED` (`FEE_ROUTER2_FLAG`, `shared/protocol.ts`) | exactly `1` routes new totals above 0.10 USDC to router 2; anything else (unset by default) keeps today's behaviour |

One parser, `protocolRouter2FromEnv` (`server/protocol/fees/cron.ts`, ledger PR #484), serves
the ledger and the payment side. The ledger counts router 2 whenever it is configured, independent of
`_ENABLED` (section 8).

**Readiness, verified on chain.** Before any money step above 0.10 USDC (a quote's
option choice, an offer's split, the reservation's route, a top-up, the payment, the fee leg) the
engine checks router 2 itself (`router2Ready`, `feeRouterLimits` + `feeRouterBinding`): code at the
address, `MAX_TOTAL() == 100_000_000`, `FEE_BPS() == 1_000`, `token()` = Feed pay's USDC and
`treasury()` = the protocol treasury. Any failed, unreadable or different value is not ready: no
quote, reservation, top-up or signature above 0.10 USDC (fail closed); a call already pinned to router
2 waits (bounded by the top-up retry window) and is never sent through router 1. Only a success is
cached (per chain and address).

**Switch off = byte-identical to today**: every total above `100_000` is refused exactly as now
(`over_per_call_max`), nothing is signed, no router 2 call is ever planned. Only the owner sets
`CITY_PROTOCOL_FEE_ROUTER2_ENABLED=1`.

## 3. Routing rule (one function, one place)

`routeFor({ total, router, router2 })` with `totalFor(kind, gross)` in
`server/protocol/fees/fee-call.ts`, called once at reservation (`server/feed/pay/engine.ts`):

1. `fee = floor(gross * 1_000 / 10_000)`; `total = gross` (fee included, kind 1) or `gross + fee`
   (fee on top, kind 0). Integers only: no display price, no float, no rounding up.
2. `total <= 100_000` → router 1.
3. `100_001 <= total <= 100_000_000` → router 2, only if router 2 is configured and enabled; else
   refused (`over_per_call_max`, as today).
4. `total > 100_000_000` → refused (`over_per_call_max`) before anything is signed.
5. Kind 1 still needs `gross >= 50_000` (`MIN_INCLUDED`, both routers); kind 0 still needs `fee > 0`.

Exact boundaries:

| Kind | gross       | fee        | total       | Route    |
| ---- | ----------- | ---------- | ----------- | -------- |
| 1    | 100_000     | 10_000     | 100_000     | router 1 |
| 1    | 100_001     | 10_000     | 100_001     | router 2 |
| 1    | 100_000_000 | 10_000_000 | 100_000_000 | router 2 |
| 1    | 100_000_001 | —          | 100_000_001 | refused  |
| 0    | 90_909      | 9_090      | 99_999      | router 1 |
| 0    | 90_910      | 9_091      | 100_001     | router 2 |
| 0    | 90_909_091  | 9_090_909  | 100_000_000 | router 2 |
| 0    | 90_909_092  | 9_090_909  | 100_000_001 | refused  |

A kind-0 total of exactly `100_000` is unreachable. The highest external price (kind 0) is
**90.909091 USDC** (`MAX_LISTED_PRICE_ROUTER2`, also the x402 option filter while router 2 is live, so
a higher external price stays `price_over_cap`); a 100 USDC external quote totals 110 USDC and is refused. Quotes, the Use sheet
and the `city_service_call` text say "up to 100 USDC including the 10% fee" for external services.

Kind 1 split above 0.10: the router computes `fee = gross / 10` (floor) and the seller gets
`gross - fee`; e.g. 100_001 → seller 90_001, treasury 10_000. Not a floating 90%.

## 4. Pinning, retries, recovery

- `feed_pay_calls.fee_router` is written at reservation from `routeFor` and never changes for that
  call. The payment intent hash already includes it (`payIntentOf`).
- Every re-plan, retry, recovery and reconciliation reads `row.fee_router`; none calls `routeFor`
  again. A config change after reservation (router 2 switched off, address changed) never moves a
  pinned call: such a call is finished on its pinned router or refused before signing, never sent to
  the other router.
- `ref = keccak256(callId)` on both routers: one call is charged at most once on its router, and it is
  never planned on two routers. No automatic fallback, no second payment.
- A row whose `fee_router` is neither router 1 nor the configured router 2 is never paid: the fee
  leg ends `no_fee_route` and a fee-included payment has no valid split (`pinnedMaxTotal` null).

## 5. Consent: nobody pays more without opting in

- `DEFAULT_PER_CALL_MAX_RAW` and `FEED_PAY_LIMITS.perCallMaxMaxRaw` stay `100_000`. While router 2 is
  switched on, an owner may set an agent's per-call maximum up to
  `FEED_PAY_LIMITS.perCallMaxMaxRouter2Raw` (`100_000_000`); with the switch off a higher value is
  refused (`invalid_request`) and a stored one is read as at most 0.10 USDC, exactly as the audit's
  hard-cap finding requires. An existing agent keeps its per-call maximum; a call above it is refused
  `over_per_call_max` as today.
- Spending limits (owner-signed, per period) are untouched: no default, cap or signature changes.
- Offers (`shared/feed-offers.ts`): price bounds become `50_000 .. 100_000_000` only while router 2 is
  enabled; otherwise `50_000 .. 100_000` exactly as today (an offer above 0.10 cannot be published
  while the switch is off).

## 6. Pay pot (float): one top-up, never per call (owner decision 2)

- **Pot target**, per agent wallet, owner-set (`float_target_raw`, migration 234): default
  `1_000_000` (1 USDC, today's `DEFAULT_FLOAT_RAW`), up to `100_000_000`. It is a discretionary reserve. Funding a call the owner
  explicitly allowed is separate: the promise is **no prefunding beyond the larger of the target and
  the call the owner allowed**, not "never above the target". Example: target 1, owner
  per-call 100, empty pot, call 80 → one top-up of at least 80 is required and allowed.
- **When a top-up happens.** Only when the pot's free balance (balance minus amounts held by other
  calls; the current reservation is excluded, `excludePaymentId`) is below the call's total. If the
  pot covers the call, no top-up, ever.
- **Short because of holds** : only for a router-2 call (total above
  `100_000`) or an owner-set target above 1 USDC. If the pot's balance covers the call but other
  calls' holds make the free balance short, the call waits, bounded by the existing `topUpInFlight`
  timeout, then is refused with the existing reason; no extra top-up. Calls of 0.10 USDC or less with
  the default target behave byte-identical to today (top-up on a short free balance, as now).
- **How much one top-up moves**: `fill = min(max(target, call total), wallet free, allowance
left, calendar cap)`, in ONE operation. If `fill` cannot cover the call: refused before signing with
  the existing limit reason; no partial fill used for the call, no retry top-ups. The
  quarter-of-allowance share (`(allowanceLeft - need) / 4`) does not apply to router-2 calls or an
  owner-set target above 1 USDC; the default keeps today's rule.
- **Pot vs period limit .** USDC moved into the pot counts as spent for the whole
  Base period (a sweep returns the USDC, not the allowance). Saving a pot target above the agent's
  current spending limit per period (or without a limit) is refused `over_period_limit`; a later lower
  limit clamps the top-up itself (allowance left), so a stored target never moves more than the limit
  allows.
- **Sweeps.** keep-float (#479) keeps the pot across Base periods; the midnight window applies as
  today.
- **Vectors for the matrix**: target 1 / per-call 100 / empty pot / call 80;
  balance 1, other hold 0.95, call 0.10 (default target: today's behaviour); target 100, allowance
  left 20, call 10 → fill 20; balance 60, holds 50, call 80, target 100 → one fill, never two.

## 7. Not-yet-final exposure (owner decision 1)

`CITY_FEED_PAY_UNFINAL_SELLER_MAX_RAW = 100_000_000` and `CITY_FEED_PAY_UNFINAL_TOTAL_MAX_RAW =
1_000_000_000` (1,000 USDC). Env only, no code change; set by the owner with the switch. The
`payment_anomaly` alert on a payment dropped after delivery stays.

## 8. Accounting: both routers, nothing dropped, nothing counted twice

- Ledger side (PR #484): the ledger reads `FeeCharged` from router 1 and router 2 (from
  `CITY_PROTOCOL_FEE_ROUTER2_FROM_BLOCK`; migration 232 records the start and rewinds once, so early
  router-2 fees are read once, never twice); explorer, metrics and the public fee API read the ledger.
- Key: chain id + transaction hash + log index. A log is counted once even if both readers see it.
- A fee is confirmed only when the event's emitter equals the call's pinned `fee_router` and every
  field matches (`feeMatches`), kind included.
- Router 1 history is never re-read or rewritten.

## 9. DefiLlama

`fees/central-city.ts`: `targets: [ROUTER_1, ROUTER_2]`, same event ABI, same rules for fees,
revenue and both volume rules (kind 1 gross; kind 0 gross matched to the seller transfer,
`settledVolume`). `start` unchanged. Opened the day router 2 is live and verified, with one real
router 2 `FeeCharged` as evidence. Acceptance and back-fill are DefiLlama's decision; we verify them,
we do not assume them.

## 10. Tests

- Every row of the table in section 3, both kinds, with the switch on and off.
- Pinning: router 2 switched off or re-addressed after reservation; retries, timeouts, duplicate and
  concurrent submissions, changed-intent replay.
- Pot: target 1 USDC unchanged behaviour; target 100 USDC filled in one top-up; 10 calls from the pot
  with zero further top-ups; pot short by holds waits; pot short by funds refills once.
- Accounting: both routers read together neither drop nor double-count; router 1 history unchanged.
- Regression: every payment of 0.10 USDC or less is byte-identical (calls, router, amounts) to main.
- Sepolia end to end: a 1 USDC and a 10 USDC fee-included call and one fee-on-top call above 0.10.

## 11. File scope of the payment side

- `shared/feed-pay.ts`, `shared/feed-offers.ts`, `shared/protocol.ts` (`FEE_ROUTER2_FLAG` only):
  limits and the switch.
- `server/protocol/fees/fee-call.ts`: `routeFor`, `MAX_TOTAL` per router, quotes.
- `server/feed/pay/engine.ts`, `x402-buyer.ts`, `tool.ts`, `schema.ts`: routing at reservation,
  `HARD_MAX_RAW`, pot target and top-up sizing.
- Not mine: ledger, cron, explorer and metrics readers.
- `server/feed/offers/*`: price bounds with the switch.
- `src/feed/pay/*`, `src/feed/OfferedView.tsx`: per-call max and pot target settings, price display.
- Texts: help index, assistant, docs (`docs/FEED_PAY.md`, protocol docs), public docs snapshots.
