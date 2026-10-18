# Protocol fee canary (Phase 0)

> Historical runbook: the router 1 canary passed on 15 Oct 2026 and the protocol has been live since.
> It is kept as the record of how launch was proven. The router 2 canary (18 Oct 2026) is under
> "Deployed" below.

One real paid call proves the fee path end to end on Base mainnet before the public is opened.
Bounded: one call, a service price of at most $0.02, so a fee of at most $0.002 and at most $0.022
in all, paid from the agent's existing float.

## Release order

1. **Canary first, on production, at the main commit before this PR.** Production keeps running
   main without the live-by-default change (`feat/protocol-live`), so every switch still works the
   old way: a feature is on only where its flag is `1`. The owner sets the canary environment
   below, and `CITY_FEED_PAY_OPERATORS` stays at the owner's test account, so the public is not
   opened: only that account's calls can pay a service and owe the fee.
2. **One call, then PASS or no merge.** The owner's test account makes the call below. PASS means
   every item under "PASS (all of them)". A call that is held (by screening or otherwise), pending
   or not finished in any other way is **not** PASS: wait until it finishes, and never resend it
   under a new intent.
3. **Then the owner's human P0 acceptance, a separate step.** PASS is evidence, not a go: the owner
   reviews the PASS evidence and the open P0 items and signs off in person. PASS alone never
   merges this PR, and nothing merges it on its own after PASS.
4. **Only after that sign-off is this PR merged.** It opens everything and removes the switches:
   the Feed, Feed pay for every account (no allowlist), the 10% fee, the ledger and metrics, and
   screening run without any setting, each with one emergency off ([LIVE.md](LIVE.md)).
5. **Then the Vercel cleanup** in [LIVE.md](LIVE.md) ("After the merge: Vercel cleanup"), once the
   merged production deployment is checked.

If the canary fails, or the owner does not sign off, this PR is not merged. On main,
`CITY_PROTOCOL_FEES=0` stops the fee on new calls (and `CITY_FEED_PAY=0` stops Feed pay) while what
is in flight finishes.

## Deployed

- CentralCityFeeRouter: `0xA5f89AE25c87C21a8E2B03aaBf398A880d9be81B` (Base, verified on Basescan)
- Deploy transaction: `0x42afd4b53120290151f3f7f4cdbacae5fced336a180b6ea2102d03d75c29e01e`,
  block `52603696`
- Treasury (fee receiver): `0xAF36084a4dc0CE760A6dCfa46Cf129e140c92aa9`
- Token: Base USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`

Fee router 2 (payments above 0.10 up to 100 USDC, [FEE_ROUTER_2.md](FEE_ROUTER_2.md)):

- CentralCityFeeRouter2: `0xb1945a2af160e84e34f7c0fb0e4dd94fd4c0af0d` (Base, verified on Basescan),
  deployed by the treasury
- Deploy transaction: `0x2e0399b26189d54d905b7d5f43ed4f50479429125a354581601c06d997324676`,
  block `52767258` (18 Oct 2026)
- Same treasury and token as router 1; the paymaster policy allows both routers
- Canary: `0xe2157b3e454633c4089982c1326a5dfa40d761a384b81ad065c6a43810a646e7` (block `52768015`):
  `FeeCharged` kind 1, gross 1.000000 USDC, fee 0.100000 USDC; 0.900000 to the seller and 0.100000
  to the treasury in the same transaction. This proves the payment settlement through router 2;
  the service itself returned no result for that call (`paid_no_result`), a seller-side error

## Owner prerequisites

- **Paymaster:** the Coinbase paymaster policy allows the router
  `0xA5f89AE25c87C21a8E2B03aaBf398A880d9be81B` (owner, in the Coinbase Developer Platform).
- **Screening provider:** the owner chooses the screening provider. The canary uses the on-chain
  sanctions oracle on Base `0x3A91A31cB3dC49b4db9Ce721F50a9D076c8D739B`, the one this PR fixes in
  code for Base mainnet (`shared/protocol.ts`). Another choice means changing that code before
  this PR is merged, and running the canary with that provider.

## Before the call

1. Production runs main before this PR, deploy checked: Feed pay (#352), the protocol P0 PR (#353,
   migration 113), Z2 (#356, migration 114), the client that shows price + fee = total (Z2b,
   #357) and the screening gate (#358, migration 115).
2. Vercel production environment (configuration owner), then one redeploy:

   | Variable                         | Value                                                             |
   | -------------------------------- | ----------------------------------------------------------------- |
   | `CITY_PROTOCOL_FEES`             | `1`                                                               |
   | `CITY_PROTOCOL_CHAIN_ID`         | `8453`                                                            |
   | `CITY_PROTOCOL_ROUTER`           | `0xA5f89AE25c87C21a8E2B03aaBf398A880d9be81B`                      |
   | `CITY_PROTOCOL_TREASURY`         | `0xAF36084a4dc0CE760A6dCfa46Cf129e140c92aa9`                      |
   | `CITY_PROTOCOL_START_BLOCK`      | `52603696`                                                        |
   | `CITY_PROTOCOL_RPC_URL`          | the Base mainnet RPC already used for wallet reads (https)        |
   | `CITY_PROTOCOL_SCREENING`        | `1`                                                               |
   | `CITY_PROTOCOL_SCREENING_ORACLE` | the chosen provider: `0x3A91A31cB3dC49b4db9Ce721F50a9D076c8D739B` |
   | `CITY_FEED_PAY_OPERATORS`        | unchanged: the owner's test account only (never `*`)              |

   `CITY_FEED=1` and `CITY_FEED_PAY=1` stay as they are: on main, Feed pay needs both, and the
   operator list keeps it to the owner's test account.

3. Check: `GET /api/public/protocol/fees` answers 200 with `fee_rate: "0.10"` and, after the first
   scan run, `history_complete: true`.

## The call

The owner picks a Feed service priced at most $0.02 and pays it once with the agent ("Use with my
agent"), confirming the quote that shows price + fee = total.

## PASS (all of them)

Capture before the call: the treasury and seller USDC balances, the public totals with their
`scanned_through_block` and `history_complete`, and the head block.

- The seller leg of THIS call settled: the call's payment shows its transaction, and that receipt
  moves exactly the price from the agent's spender account to the listing's `payTo` (the payer's
  authorization nonce used).
- Exactly one `FeeCharged` from the router for this call (`ref = keccak256(callId)`, `kind 0`,
  `gross` = price, `fee = floor(price / 10)`), and a USDC transfer of exactly that fee to the
  treasury in the same transaction.
- The call view shows the payment settled and `protocolFee.state = "charged"`.
- The fee ledger has this call's row (matched by tx, log index and ref; transfer proof; final once
  Base finalizes; service-verified).
- Against the captured baseline, the public totals moved by exactly this call: `fee_count` +1,
  `fees_usdc` + the fee, `payments` +1 and `volume_usdc` + the price once verified, with
  `history_complete: true`. The router is permissionless, so any other fee in the window is
  identified and reconciled separately; aggregate totals alone never identify the call.

A held, pending or unfinished call is not PASS. Anything unknown or partial stays pending: never
resend under a new intent. A failed fee raises the `protocol_fee_failed` alert and is reviewed, not
retried blindly.

## After PASS

1. The owner's human P0 acceptance: the owner reviews the PASS evidence and the P0 items and signs
   off. Without it, stop here: PASS alone is not a reason to merge.
2. Only then merge this PR (it opens Feed pay to every account and removes the switches;
   [LIVE.md](LIVE.md)).
3. Check the production deployment of the merge.
4. Do the Vercel cleanup in [LIVE.md](LIVE.md) ("After the merge: Vercel cleanup").
