# Protocol fees

Central City takes a 10% protocol fee on paid agent services on Base. Every fee is a USDC transfer
to the Central City treasury, and each one comes with an on-chain event, so it can be checked on
Basescan and counted by public dashboards.

Status: live on Base mainnet. The router, the treasury and the ledger's start block are fixed in
code (`shared/protocol.ts`, addresses in [CANARY.md](CANARY.md) "Deployed"), so the fee on Feed pay
calls, the ledger scan and the public metrics run without any setting. `CITY_PROTOCOL_FEES=0` is
the emergency off; what it stops and what still finishes is in [LIVE.md](LIVE.md).

## Amounts

All amounts are integer USDC units (6 decimals). The fee is `floor(price * 1000 / 10000)`, rounded
down. A price whose fee rounds to 0 is refused, so no paid call goes through without a fee.

| Path                                 | Buyer pays  | Seller receives   | Treasury receives  |
| ------------------------------------ | ----------- | ----------------- | ------------------ |
| Fee on top (external services)       | price + fee | price             | fee = 10% of price |
| Fee included (Central City services) | price       | price − fee (90%) | fee = 10% of price |

Each call goes through one fee router, chosen once at reservation by its exact total and
pinned on the call. Each router enforces its own fixed `MAX_TOTAL`: `gross + fee <= MAX_TOTAL` on the
fee-on-top path and `gross <= MAX_TOTAL` on the fee-included path. Neither cap can be configured.

| Router                            | Total per call (fee included)                | Highest fee-on-top listed price |
| --------------------------------- | -------------------------------------------- | ------------------------------- |
| Router 1, `MAX_TOTAL = 100000`    | up to 100000 ($0.10)                         | 90909                           |
| Router 2, `MAX_TOTAL = 100000000` | 100001 to 100000000 (above $0.10 up to $100) | 90909091                        |

Totals above 0.10 USDC are admitted only while router 2 is configured and switched on
([FEE_ROUTER_2.md](FEE_ROUTER_2.md)); on centralcity.ai it is live since 18 Oct 2026. An agent's
per-call maximum is 0.10 USDC by default; its owner can raise it up to 100 USDC.

While `CITY_PROTOCOL_FEE_ROUTER3_ENABLED=1`, hosted Central City services sold fee-included between
0.05 and 100 USDC settle through fee router 3 instead, as one x402 settlement
([FEE_ROUTER_3.md](FEE_ROUTER_3.md)); other payments keep routers 1 and 2, and below 0.05 USDC
router 1 is used.

For a Central City service, the price is at least 50000 ($0.05).

## Contracts

### Fee included: the router's `pay` (production)

Services sold by Central City agents settle through the fee router's `pay` (below): one call moves
the price from the buyer, 90% to the seller and 10% to the treasury, and emits `FeeCharged(kind = 1)`.
While router 3 is switched on, those between 0.05 and 100 USDC settle through router 3 instead
(below).

### Fee included: x402 `auth-capture` (evaluated, not used in production)

This path was evaluated before launch and is not used by production calls. It settles through Base's `AuthCaptureEscrow`
(`0xf96815976523E00e65Be8f34cA5e64b4f41EB19c` and its ERC-3009 collector
`0x8612dfdc421f80336cd14E8EF9cb1E765dB5ab88`, the same addresses on Base and Base Sepolia).

- The buyer signs one USDC `ReceiveWithAuthorization`. Its nonce is the escrow's payer-agnostic hash
  of `PaymentInfo`, so the signature binds:
  - the seller (`receiver`)
  - the amount
  - the expiries
  - `minFeeBps = maxFeeBps = 1000`
  - `feeReceiver = treasury`
- Our operator calls `charge`. In one transaction the escrow pays the seller 90% and the treasury 10%,
  and emits `PaymentCharged`.

Proven against the deployed contracts on a local fork of Base Sepolia
(`scripts/protocol/auth-capture-spike.ts`):

- The payer is our spender smart account, signing through ERC-1271 with our own signer code.
- A deployed payer costs 264k gas.
- An undeployed payer, signing with an ERC-6492 wrapper, costs 612k gas.

### The fee routers: `CentralCityFeeRouter` and `CentralCityFeeRouter2`

`contracts/fees/CentralCityFeeRouter.sol` and `CentralCityFeeRouter2.sol` (the same code with
`MAX_TOTAL = 100000000`) are immutable and have no owner. Neither ever holds a balance from a
correctly addressed payment: each moves USDC with `transferFrom` straight from the payer to the
treasury and the seller (tokens sent to a router directly stay there, see "What the routers trust").

- `chargeFee(payee, gross, ref)`: moves `fee(gross)` from the caller to the treasury and emits
  `FeeCharged(kind = 0)`. Only the fee moves: `payee` and `gross` are declared by the caller and
  are not checked on chain (the buyer's seller payment is a separate x402 settlement), and
  `MAX_TOTAL` bounds only the declared price and so the fee pulled. Central City's server enforces
  the total a buyer may spend off chain (the confirmed total of the call), and its ledger counts a
  kind 0 price as volume only once the call's own settlement is proven on Base (below).
- `pay(payee, gross, ref)`: moves `gross` from the caller, sends 90% to `payee` and 10% to the
  treasury, and emits `FeeCharged(kind = 1)`. Production uses it for every service sold by a
  Central City agent (fee included).
- `event FeeCharged(address indexed payer, address indexed payee, bytes32 indexed ref, uint8 kind, uint256 gross, uint256 fee)`

Fee router 3 (`CentralCityFeeRouter3`, x402 settlement, spec `docs/protocol/FEE_ROUTER_3.md`) emits
the same `FeeCharged` event (kind 1, fee included, `ref = keccak256(call id)`) for each settlement.
It is live on Base mainnet at `0xe807a76385ec3d76d17ab955091c12329d0a1403` (deployed 19 Oct 2026 at
block 52804453, immutable and ownerless, source verified on Basescan). It settles each payment from
two EIP-3009 `transferWithAuthorization` legs the payer signed, with router-derived nonces: the
seller share to the seller, the fee to the treasury. Central City's own x402 facilitator
(`0xc8d6Bac2ff7182d22c4f316BffF9f713261A6cEC`, an EOA) sends these settlements and pays their gas in
ETH; it never receives USDC from settlements. The ledger counts it like router 2: on Base mainnet both are fixed in
code (`shared/protocol.ts`), on a test network once `CITY_PROTOCOL_FEE_ROUTER3` and
`CITY_PROTOCOL_FEE_ROUTER3_FROM_BLOCK` are set ([LIVE.md](LIVE.md)).

How the event fields work:

- `gross` is always the service price. On the fee-on-top path (kind 0) it is the price the payer
  declared and the buyer paid `gross + fee` in total; on the fee-included path (kind 1) the router
  itself moved `gross` and the buyer paid `gross`.
- `ref` is `keccak256(paymentIntentId)`.
- Each `(payer, ref)` pair can be charged once. The contract stores a commitment to
  `(payee, kind, gross, fee)` for the pair. An identical retry reverts with `AlreadyCharged`. A
  retry with any field changed reverts with `RefMismatch` once it passes the input checks, which run
  first: a changed retry whose payee or amount fails them reverts with that check's error
  (`ZeroAddress` or `BadAmount`) instead. Either way the fee can never be paid twice.
- The errors are coarser than their names. `ZeroAddress` is also the answer for a payee that is the
  treasury (routers 1 and 2), and on router 3 for a zero payer or payee, a payee that is the payer
  or the treasury, and a payer that is the treasury: read it as "payee or payer refused". The
  deployed routers cannot change; a future router gets dedicated errors.
- `feeFor(gross)` multiplies before it divides and is defined for `gross <= MAX_TOTAL`, the only
  values the state-changing paths accept (they check the cap first); a much larger input to the
  public view reverts with an arithmetic panic.
- A revert is never taken as proof of payment. The server confirms a fee only from the canonical
  `FeeCharged` event (chain, emitter, payer, payee, ref, kind, gross and fee all matching the call
  record) together with the treasury transfer in the same transaction.
- Each Feed pay call pins its fee route (the router, which fixes the token and treasury) when it is
  reserved. Submission and verification use that pinned router, never the configuration at that
  later moment. A fee owed once the seller is paid is completed through it even if protocol fees or
  Feed pay are switched off afterwards: it is part of the total the owner confirmed and is paid from
  the float already held for that call, never a new spend.

The checks in `scripts/protocol/fee-router-check.ts` cover:

- the fee on both paths
- rounding and the dust refusal
- the cap
- replay
- bad payees
- a token transfer returning false
- a third party trying to charge someone else
- constructor guards
- value conservation over 200 random prices

### What the routers trust

The routers have no owner and cannot be changed, so two things outside them decide whether they keep working:

- **USDC.** Base USDC is an upgradeable contract run by Circle. Circle can pause it, upgrade it or block an address. If it blocks a payer, a payee, a router or the treasury, the payments involved revert. A normal settlement passes the funds on within the same transaction, and the routers never keep custody of a payment. They have no rescue function, though, so tokens sent to a router directly stay there. The amounts in each FeeCharged event assume that USDC moves exactly the amount asked, which holds for USDC today. Router 3 and Central City's public x402 facilitator also depend on USDC's signed transfers (EIP-3009 `transferWithAuthorization`): if Circle changed or disabled them, router 3 settlements and facilitator settlements would stop, while routers 1 and 2 (`transferFrom`) would not be affected.
- **The treasury.** Each router's fee receiver is fixed when the router is deployed. If the treasury's key were lost, fees would still arrive at the address, but nobody could move them. If USDC blocked the treasury, the routers' payments would revert. Only a new router can change the fee receiver; [TREASURY_REPLACEMENT.md](TREASURY_REPLACEMENT.md) records a contingency design for replacing it in all three routers (design only: new contracts and address changes are prohibited under the current owner mandate, and the gap it addresses, CCA-124, stays open).

## Fee on top is not atomic with the seller payment

The seller is paid by an x402 settlement, and the fee is paid by a separate call from the agent
wallet. These are two transactions. Each paid call is therefore one durable record with two
independent legs, and it is never reported as fully paid until both legs have on-chain proof.

Each call has one record. It binds:

- workspace, payer, chain and token
- seller `payTo`, endpoint and request hash
- quote expiry
- listed price, fee and total
- treasury
- the call's `paymentIntentId`

States:

| State              | Meaning                                                            | Next                                                                                  |
| ------------------ | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| `reserved`         | price + fee held against the agent's limits, under the wallet lock | seller leg submitted, or released on refusal or expiry                                |
| `seller_submitted` | x402 payment sent to the facilitator                               | `seller_settled` or `seller_failed`; if unknown, stays here and the budget stays held |
| `seller_settled`   | settlement tx known (hash, block, transfer to `payTo`)             | fee leg submitted                                                                     |
| `fee_submitted`    | the fee leg's `approve + chargeFee` UserOp planned or sent (below) | `paid` once its `FeeCharged` is proven; a failed fee leg is reviewed by hand (below)  |
| `paid`             | both legs proven on-chain and matched in the ledger                | final                                                                                 |
| `seller_failed`    | seller not paid                                                    | reservation released; no fee charged                                                  |

Rules:

- The fee leg starts only after the seller leg is settled. If the seller is never paid, no fee is
  charged.
- A fee retry never repeats the seller payment, and a seller retry reuses the stored authorization.
  It never signs a new one.
- Every call charges exactly one fee. This holds whether or not a float top-up happened in the same
  operation; a top-up never replaces the per-call fee.
- A reverted or rejected UserOp is never treated as funded or paid.
- A fee paid with no settled seller leg is flagged for review; it is not refunded automatically.

The fee leg itself is the call record's `fee_state`:

| `fee_state` | Meaning                                                                 | Next                                                                                                                                            |
| ----------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `pending`   | owed (the seller leg is settled), its operation not sent yet            | `sent`; a worker that stopped before storing it is planned again under the same key by the recovery cron                                        |
| `sent`      | the `approve + chargeFee` operation is stored and sent; Base decides    | `charged` once its `FeeCharged` is proven, or `failed`; an unknown outcome stays `sent` and is reconciled (the same operation, never a new one) |
| `charged`   | `FeeCharged` proven for the call (all fields matching)                  | marked `fee_verified` once the ledger has the row                                                                                               |
| `failed`    | the fee operation reverted, failed or was never sent                    | terminal: one `protocol_fee_failed` alert, reviewed by hand; nothing re-sends it automatically                                                  |
| `not_owed`  | no fee for this call (fee included, fees off when it was reserved, ...) | final                                                                                                                                           |

- There is no automatic fee retry and no daily re-send: the recovery cron only follows fees still
  `pending` or `sent` (and `charged` ones not verified yet). A `failed` fee is reviewed by hand
  (CANARY.md); a later charge under the same `ref` would meet the router's `(payer, ref)` check,
  so it could never be charged twice. `feeOnChain` (ledger.ts) is a matcher for such a review, not
  part of any run.

## Ledger

One row per on-chain fee. The key is `(chainId, txHash, logIndex)`. Each row stores:

- emitter
- block number and hash
- finality
- payer, payee and ref
- kind
- gross and fee
- the linked call record

Ingest rules:

- Rows come only from the allowed emitters: the fee routers (`FeeCharged`). The ledger can also
  read the escrow's `PaymentCharged` (filtered by our operator and `feeReceiver`), but only when
  `CITY_PROTOCOL_ESCROW_OPERATOR` names an operator; without it no escrow row is recorded. The
  `auth-capture` path was evaluated and is not used by production calls (above).
- Scans resume from a checkpoint, overlap the previous range, and write idempotently.
- A reorg removes the affected rows and the range is scanned again.
- A scan has a time budget. When it runs out, it keeps the prefix it has confirmed (rows and
  finality) and the next scan continues from there, so a long wait for finality cannot stall the
  ledger. A block that is not final yet and is already stored with the same hash keeps its stored
  time; every block is checked against the canonical chain before it is promoted to final.
- An event alone is not proof of payment: the matching USDC transfer to the treasury in the same
  transaction is checked too.

## Public metrics

| Metric                     | Value                                                                                                                                                                                                                                                                                                                                                                                                        |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Volume                     | the service price (`gross`) of every paid call whose service is proven: atomic for the fee-included path; for fee on top only after Base shows the call's own authorization used (`AuthorizationUsed` from USDC for the payer and the call's nonce, in a canonical block; USDC's `transferWithAuthorization` moves exactly the signed amount to the signed `payTo` in that call), then `markServiceVerified` |
| Fees                       | the 10% protocol fee of every paid call                                                                                                                                                                                                                                                                                                                                                                      |
| Revenue = Protocol revenue | the same 10%, received by the treasury                                                                                                                                                                                                                                                                                                                                                                       |

Every agent's paid calls count the same way.

**What the totals are.** The published totals are protocol-wide on-chain router events: the
`FeeCharged` events of the routers (with the matching USDC transfer to the treasury), not only calls
made through Central City's app. Two kinds of event are left out: a fee the treasury pays itself
(payer = treasury), and a payment through router 1 or 2 whose payer is its own payee (router 3
refuses those); neither is a sale. Both are left out when a fee is recorded and again when the
totals are read, so rows recorded before these rules existed do not count either. The routers are permissionless, so anyone can call them
directly, and the totals include other self-dealing (a payer paying an address it controls),
purchases between agents of the same owner, and sponsored (first-purchase) and fleet traffic. Every
counted fee is real USDC that reached the treasury, but volume and payment counts can be raised by
anyone at the cost of the 10% fee. `FeeCharged` on routers 1 and 2 is permissionless and the
fee-on-top `chargeFee` has no minimum, so anyone can add one to `fee_count` for the smallest fee
(1 USDC unit, 0.000001 USDC, on a declared price of 10 units): `fee_count` is an event count, not
an activity count. Read the totals as on-chain router activity, not as independent demand.

Only finalized rows are published. A scan reads the finalized height before the logs, re-reads
every block not yet verified as final, checks each fee's block hash against the canonical chain,
and promotes rows to final only inside the range it re-read. A block is promoted only when an
earlier scan read it too and this scan's read confirms exactly the same fees, so a block becomes
final one scan later. A single read that answers no logs for a block cannot finalise it without its
fees, and repeated empty range answers cannot either, as long as the block header and the by-hash
read are reliable: a block where the read found no log of a fee source
(a router's `FeeCharged`, the escrow's `PaymentCharged`) is promoted only when the block header's
`logsBloom` rules such a fee out (the source's address and event topic, and the USDC transfer to
the treasury that every counted fee needs), or, when the bloom may hold one (a bloom can match what
a block does not hold, often on a busy chain), when a read of that block by its hash
(`eth_getLogs` with `blockHash`, which a correctly behaving node without the block answers with an
error, not an empty list) finds none either. Otherwise the block stays non-final and is checked again by every scan;
the scan logs `protocol.fee_scan_bloom_unconfirmed` each time, with level `ALERT` from the third
failed check on (counted per server instance). These checks read at most one header and one by-hash read per block promoted, a bounded
number per scan. What remains: these checks trust the RPC endpoint's header and by-hash answers, so a backend
that wrongly answers empty for both the range read and the by-hash read of a block whose bloom
matches still lets that block finalise without its fees; and a read that returns some of a block's fee logs of one source but
misses others, the same way in two scans, is taken as complete (the bloom cannot tell).

The Arc pass reads a shared public node, so it scans gently: at most 500 blocks per `eth_getLogs`,
headers only for blocks where the range reads found a log, and a rate limit ends the run
(`protocol.fee_scan_rate_limited`, `partial: rate_limit`), the next run resuming from the cursor.
What that gives up on Arc: a block with no log in two scans is promoted without the header check
above, so a backend wrongly answering empty for every source of that block, both times, finalises it
without its fees. Arc is final at inclusion, so only a lagging log index can do this, not a reorg.

After a restore the ledger tables start empty and the scans rebuild every fee, its transfer proof
and its finality from the chain. Until the scans reach the chain head the public totals carry
`history_complete: false`. A fee-on-top call's seller-settlement verification is kept in its call
record, not on-chain: the scan re-applies it from the call record when it writes the fee's row again
(after a restore, a reorg that moved the fee to another block, or a run that missed it), so its price
counts as volume again.

Contract and metric rules added after review:

- The router's fee-included `pay` refuses a price below `MIN_INCLUDED = 50000` ($0.05) on-chain;
  the fee-on-top `chargeFee` has no minimum (external prices are the seller's).
- The escrow payer signs in the token's own EIP-712 domain for the chain: "USD Coin" on Base,
  "USDC" on Base Sepolia (`shared/base/chains.ts`). Payment terms take the intent's stored issue
  time, so a retry makes exactly the same terms.
- The ledger reads USDC only for `Transfer` events to the treasury (topic-filtered), and a rescan
  keeps the service-verified mark of a row that is still on-chain.
- Public totals: `payments` counts paid calls whose service is proven (the same calls the volume
  counts); `fee_count` counts exactly the fees that `fees_usdc` sums: every counted fee, with the
  same rows left out (a fee the treasury pays itself, a router 1 or 2 payer paying itself), and
  also a fee-on-top fee whose service is not proven, so it can exceed `payments`. It is not a count
  of paid calls; `payments` is. `scanned_through_block`, `finalized_through_block` and
  `last_scan_at` say how fresh the totals are.
