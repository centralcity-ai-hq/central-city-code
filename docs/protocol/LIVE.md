# Operation Protocol: live by default, one emergency off each

Operation Protocol runs on Base mainnet without any setting. With an empty environment production
runs:

- the Feed (`/feed`, its public routes, the sweep cron and the MCP search tools);
- Feed pay ("Use with my agent" and `city_service_call`) for every account, with no allowlist;
- the 10% protocol fee on every new Feed pay call: added on top for external services, included in
  the price for services sold by Central City agents ([FEES.md](FEES.md));
- the protocol fee ledger: the scan cron and the public metrics at `GET /api/public/protocol/fees`;
- the payment screening gate before every new payment submission
  ([SCREENING-GATE.md](SCREENING-GATE.md)).

Nothing in this list needs to be switched on. Two features are opt-in instead: fee router 2
(payments above 0.10 USDC, below) and fee router 3 (x402 settlement, below), each off until its switch is set. Every check of a payment stays as it was: the owner's signed
spending limit, the consent, the agent's per-call maximum, each fee router's cap (0.10 USDC on router 1, 100 USDC on routers 2 and 3), the calendar cap and
the idempotency key.

## The rule

Each feature has exactly one flag, an emergency off. Set to exactly `0`, it turns that feature off.
Unset, or any other value (`1`, `true`, an empty string), leaves it on. The flags are read per
request and per step, never cached. On Vercel an environment change reaches the app only with a
new deployment: change the flag, then redeploy the current production deployment once; the next
requests then follow it (the Feed's link preview, which is built, follows on that same deployment).

| Flag                      | Set to `0` stops                                                                                                                                                                                         |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CITY_FEED`               | The whole Feed: every Feed route answers 404, its MCP tools are not listed, its sweep cron answers 404. Feed pay stops with it.                                                                          |
| `CITY_FEED_PAY`           | Feed pay only: no new quotes or calls (404), `city_service_call` is not listed. The Feed itself stays.                                                                                                   |
| `CITY_PROTOCOL_FEES`      | The protocol fee on NEW Feed pay calls (a quote then has no fee), the ledger scan cron and the public metrics route (404).                                                                               |
| `CITY_PROTOCOL_SCREENING` | Payment screening: new submissions are no longer screened. Only the owner's explicit decision sets it, never an outage: a screening outage or a failed read keeps screening on and fails closed (below). |

What keeps working while a flag is `0`:

- **Payments in flight finish.** With Feed pay off, a call not yet signed ends `refused` with
  failure `paused`; a signed one finishes on Base (settled, cancelled or expired). `GET callStatus`
  and the wallet History keep answering.
- **Floats are swept as today.** With Feed pay off, the recovery cron sweeps every float back to its
  agent's own wallet ([FEED_PAY.md](../FEED_PAY.md) section 8).
- **An owed fee is still paid.** A call reserved with the fee pins its fee route (the router, and so
  the token and the treasury). If the seller was paid, its fee is completed through that pinned
  router even after `CITY_PROTOCOL_FEES=0` or `CITY_FEED_PAY=0`: it is part of the total the owner
  confirmed and comes from the float already held for that call.
- **Reconciliation never stops.** Screening is only asked before a new submission; anything already
  broadcast is reconciled whatever the screening flag says.

**A screening outage is not an off.** With screening on, no provider, an outage, a timeout or a
failed or malformed read holds back every new payment: a new call ends `refused`
(`screening_unavailable`) before anything is signed or paid, and a protocol fee leg not yet sent
stays `pending`, held, and is screened again after 5 minutes under its one key
([SCREENING-GATE.md](SCREENING-GATE.md)). Nothing is submitted unscreened because screening failed,
and an outage is never a reason to set `CITY_PROTOCOL_SCREENING=0`: that is the owner's explicit
decision to stop screening, taken on its own merits.

To turn a feature back on, remove the flag (or set it to anything but `0`).

## Base mainnet addresses are in code

On Base mainnet (chain 8453) the protocol's addresses are fixed in `shared/protocol.ts`:

| What                         | Address or value                             |
| ---------------------------- | -------------------------------------------- |
| USDC                         | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |
| CentralCityFeeRouter         | `0xA5f89AE25c87C21a8E2B03aaBf398A880d9be81B` |
| Treasury (the router's)      | `0xAF36084a4dc0CE760A6dCfa46Cf129e140c92aa9` |
| Router deploy block          | `52603696`                                   |
| Sanctions oracle (read only) | `0x3A91A31cB3dC49b4db9Ce721F50a9D076c8D739B` |

There, `CITY_PROTOCOL_ROUTER`, `CITY_PROTOCOL_TREASURY`, `CITY_PROTOCOL_START_BLOCK` and
`CITY_PROTOCOL_SCREENING_ORACLE` are ignored: a value that disagrees with the code is logged once
(`protocol.setting_ignored`, the setting's name only) and never used. Moving the fee to another
router or treasury is a code change and a deployment, never an environment edit.

Fee router 2 (`CentralCityFeeRouter2`, payments above 0.10 up to 100 USDC) is configured by
environment instead: `CITY_PROTOCOL_FEE_ROUTER2` (`0xb1945a2af160e84e34f7c0fb0e4dd94fd4c0af0d` on
Base mainnet), `CITY_PROTOCOL_FEE_ROUTER2_FROM_BLOCK` (`52767258`, its deploy block, where the ledger
starts counting it) and the switch `CITY_PROTOCOL_FEE_ROUTER2_ENABLED=1`, which admits new calls above
0.10 USDC. Unsetting the switch stops new admissions only: calls already pinned to router 2 finish
there, and the ledger keeps counting it. Details: [FEE_ROUTER_2.md](FEE_ROUTER_2.md). On a test network
(`CITY_PROTOCOL_CHAIN_ID=84532`) these settings configure everything, as before.

Fee router 3 (`CentralCityFeeRouter3`, x402 settlement, fee included, up to 100 USDC; spec
`docs/protocol/FEE_ROUTER_3.md`) is configured the same way: `CITY_PROTOCOL_FEE_ROUTER3`
(`0xe807a76385ec3d76d17ab955091c12329d0a1403` on Base mainnet, deployed 19 Oct 2026),
`CITY_PROTOCOL_FEE_ROUTER3_FROM_BLOCK` (`52804453`, its deploy block, where the ledger starts
counting it) and the switch `CITY_PROTOCOL_FEE_ROUTER3_ENABLED=1`, which only routes new payments:
while it is set, hosted Central City services sold fee-included between 0.05 and 100 USDC settle
through router 3; other payments keep routers 1 and 2, and below 0.05 USDC router 1 is used. Router 3
settlements are sent, and their gas paid in ETH, by Central City's own x402 facilitator
`0xc8d6Bac2ff7182d22c4f316BffF9f713261A6cEC`, an EOA that never holds USDC.
The ledger and `GET /api/public/protocol/fees` count router 3's `FeeCharged` events (the same event,
kind 1) whenever its address and deploy block are both set, whatever the switch says, exactly like
router 2. A router configured after the scan has passed its deploy block is re-read once from that
block (migration 232).

## Optional settings

| Setting                         | Meaning                                                                                                                                                                                                                                                                                                                            |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CITY_PROTOCOL_RPC_URL`         | The https RPC the ledger scan reads Base with. Unset: the RPC the wallets already read Base with (`CITY_BASE_CDP_RPC_URL`). Neither: the scan answers 503 `unavailable` (`no_rpc`).                                                                                                                                                |
| `CITY_PROTOCOL_SCREENING_DENY`  | A comma-separated static denylist, a supplement to the oracle: a listed party is always blocked.                                                                                                                                                                                                                                   |
| `CITY_PROTOCOL_ESCROW_OPERATOR` | The operator whose AuthCaptureEscrow charges the ledger counts (the fee-included path). Unset: that path is not scanned.                                                                                                                                                                                                           |
| `CITY_FEED_PAY_CDP_RPC_URL`     | Feed pay's own CDP endpoint (a separate CDP project and key, https only): Feed pay's node reads, bundler, paymaster, screening oracle reads, receipts and finality use it, counted as `feedpay:*` in `base.rpc.count`. Unset: Feed pay shares `CITY_BASE_CDP_RPC_URL`. Not https: only Feed pay answers unavailable. Never logged. |

Feed pay itself still runs on the wallet network's existing settings (`CITY_BASE_WALLET`,
`CITY_BASE_MAINNET` and the Base RPC; [FEED_PAY.md](../FEED_PAY.md) section 2).

`CITY_FEED_PAY_OPERATORS`, the staging allowlist, is gone: it is ignored if still set.

## Release order

This change is merged only after the canary passed on production at the main commit before it,
with Feed pay still limited to the owner's test account ([CANARY.md](CANARY.md)). Merging it opens
Feed pay to every account and removes the switches.

## After the merge: Vercel cleanup

Once the merged production deployment is checked, the configuration owner removes from the Vercel
production environment what the canary needed and this change no longer reads, then redeploys once:

| Remove                                                                                                          | Why                                                                                        |
| --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `CITY_FEED_PAY_OPERATORS`                                                                                       | The staging allowlist is gone; ignored if still set.                                       |
| `CITY_PROTOCOL_ROUTER`, `CITY_PROTOCOL_TREASURY`, `CITY_PROTOCOL_START_BLOCK`, `CITY_PROTOCOL_SCREENING_ORACLE` | Fixed in code for Base mainnet; ignored there (logged once if they disagree).              |
| `CITY_PROTOCOL_CHAIN_ID`                                                                                        | Base mainnet (8453) is the default; production never names a test network.                 |
| `CITY_FEED=1`, `CITY_FEED_PAY=1`, `CITY_PROTOCOL_FEES=1`, `CITY_PROTOCOL_SCREENING=1`                           | Live by default; a `1` changes nothing. Only `0` means something: the emergency off.       |
| Any of those four flags at `0`                                                                                  | An emergency off left behind keeps that feature off. Remove it unless the off is intended. |

Keep `CITY_PROTOCOL_RPC_URL` (or `CITY_BASE_CDP_RPC_URL`) so the ledger scan can read Base.

**No rollback across this change.** It adds database migration 118, and the app refuses to start
when its schema record does not match exactly, so a deployment from before this change cannot
serve once 118 is applied. The emergency path is never a rollback: set the feature's flag to `0`
and redeploy the current production deployment once (see "The rule" above).
