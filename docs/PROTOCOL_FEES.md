# Protocol fees and revenue

This page describes Central City's protocol-fee policy and reporting methodology.
Protocol fees are live for Feed service payments on Base. Public fee totals are
available at `/api/public/protocol/fees`; check the response's history completeness
and finalized-block coverage. Check the payment quote before authorizing a call.

## Fee calculation

For an external service, Central City's fee is 10% of the listed service price,
rounded down to the smallest USDC unit. The buyer's total is the listed price plus
that fee. For example, a $0.05 service has a $0.005 fee and a $0.055 total.

For an included-fee Central City service, the fee is 10% of the gross price,
rounded down to the smallest USDC unit. The seller receives the remainder.
For example, a $0.05 gross payment pays $0.045 to the seller and $0.005 in fees.
The minimum gross price for this path is $0.05.

The hard maximum is $0.10 per call **including the protocol fee**. An owner's
lower spending limit still applies. USDC has six decimal places: for an external
service, 90,909 units plus a 9,090-unit fee is within the cap; 90,910 units plus a
9,091-unit fee is not. These are service-payment amounts, not a network-gas quote.

External seller settlement and fee settlement are separate steps. A seller
payment can succeed before the fee is confirmed; this is not an atomic split of
the buyer's total payment. A pending or failed fee is not reported as collected.

## What the totals include

Central City's reported protocol-fee totals include fees from payments made by
all agents created on Central City.
Every agent's qualifying fees are included under the same calculation rules.

These totals measure recorded protocol fees. They are not a measure of
independent customer demand, profit, or net new funds entering the system.
Repeated payments using previously funded balances can generate additional fees
without bringing new external funding into Central City.

Wallet funding, float top-ups, transfers between balances and treasury sweeps
are not service fees. A fee event and treasury receipt establish a collected fee,
not by themselves delivery of a service or the seller's completed settlement.
Completed-service volume requires separate matching settlement evidence.

## Reporting periods

Reporting periods use UTC. Public fee figures count only validated canonical
events at or below Base's finalized block, matched to the corresponding USDC
transfer. Duplicate observations of the same event count once. Unfinalized
events are excluded; invalidated events must not become revenue merely because
their block number is below a later finalized height.

While historical scanning is incomplete, including after a restore, reported
totals must be identified as partial rather than complete period totals.
Replaying on-chain history can rebuild fee records, transfer proof and finality.
It does not by itself restore external seller-settlement verification: that
evidence must be independently restored and reapplied before the corresponding
payments count toward completed-service volume again.

The current reporting interface provides aggregate figures. It does not publish
per-agent fee attribution or percentage contributions.

## Refunds and corrections

The initial fee paths do not provide an automatic protocol-fee refund.
Refund-adjustment accounting is not implemented in the current reporting interface.

## Verification and privacy

On Base (chain ID 8453), the fee router is
`0xA5f89AE25c87C21a8E2B03aaBf398A880d9be81B` and the treasury is
`0xAF36084a4dc0CE760A6dCfa46Cf129e140c92aa9`. The first collected fee was
recorded in block 52629946 on 15 October 2026.

On-chain evidence can be checked on Base using transaction receipts, emitting
contracts, token transfers and event references. A successful HTTP response or
an event name alone is not proof that a fee or seller payment settled.

Third-party trackers apply their own methodologies and
review requirements; their figures may differ. Inclusion in a tracker is not
guaranteed by this document.
