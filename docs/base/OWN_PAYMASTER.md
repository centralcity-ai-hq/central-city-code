# Own paymaster and bundler on Base

Since 24 October 2026, Central City sponsors and submits its agents' Base operations with its own
ERC-4337 paymaster and its own bundler. Before that, both came from a third-party provider (Coinbase
Developer Platform). This page is the overview; the code is in `server/base/chain/`.

## What runs where

| Part                | What it does                                                                                       | Where                                                |
| ------------------- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Verifying paymaster | Pays the gas of the operations Central City signs a sponsorship for, from its EntryPoint deposit.  | `0x8Bf5b18b733a864c17Cd92615cD45D833Fcfe105` on Base |
| Sponsorship signer  | Signs each sponsorship off-chain after the policy and budget checks. It never sends a transaction. | `0x5DF424aB1BD45ce2faCBbC002Aa53504CF5710A5`         |
| Bundler submitter   | Sends `handleOps` to the EntryPoint v0.6 and is repaid by it as the beneficiary.                   | `0xbbd1B99822d03a1C46F8b4C063dd1a66fCCa1D47`         |
| Paymaster owner     | Admin actions only: deposits, withdrawals, signer rotation, bundler allowlist.                     | `0x3Cc6b541a88fcE61d4eA769703fA5025cCF498d1`         |
| EntryPoint v0.6     | The standard ERC-4337 entry point the agents' smart accounts use.                                  | `0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789`         |

The live configuration is public: `GET /api/public/paymaster` answers the mode, the chain, the
EntryPoint, the paymaster, the signer and submitter addresses, the configured bundler
(`bundlerConfigured`: `cdp` | `direct` | `direct_invalid`) and the bundler in effect
(`bundler`: `cdp` | `direct` | `cdp_fallback` | `direct_starting`).

## Supported flows

The paymaster signs an operation only when its calls match the flow that asked for it
(`own-paymaster-policy.ts`). Anything else is refused before a signature exists.

| Flow           | Account                     | Calls                                                                          |
| -------------- | --------------------------- | ------------------------------------------------------------------------------ |
| `registration` | the agent's spender account | ERC-8004 `register` and the hand-over `transferFrom` to the owner              |
| `rate`         | the agent wallet            | ERC-8004 `giveFeedback`                                                        |
| `ownerPay`     | the agent wallet            | a USDC transfer the owner signed                                               |
| `feedPay`      | the agent's spender account | Feed pay legs: spend permission, USDC transfer or approve, fee routers 1 and 2 |
| `agentPay`     | the agent's spender account | spend permission and a USDC transfer to another Central City agent             |
| `exit`         | the agent wallet            | withdrawals, revokes and cancels                                               |

Gas limits are capped per operation. Each operation is simulated when it is prepared, and the bundler
simulates the `handleOps` transaction again before it sends it: an operation whose pre-send simulation
fails is not broadcast.

Fee router 3 settlements are not part of this path: they are x402 payments sent by Central City's own
facilitator EOA, which pays its gas in ETH and is not a UserOperation (`docs/protocol/FEE_ROUTER_3.md`).

## Budget

Every sponsored operation is admitted against a budget kept in the database
(`own-paymaster-budget.ts`), in the same transaction that reserves it:

- **Worst case until final.** An operation reserves its maximum possible cost, and the submitter's
  own outer transaction reserves its worst case too. Both settle to the real cost only once the
  transaction is in a finalized Base block whose hash matches.
- **Ordinary ceiling.** A total for all ordinary work, inclusive of what was already spent before the
  budget existed (`BUDGET_LIMITS.ordinaryCeilingWei`).
- **Hourly cap.** A rolling-hour limit on ordinary reservations (`hourlyOrdinaryWei`). Because it
  counts worst cases until finality, it bounds the volume in flight, not only the real spend.
- **Protected reserve.** Kept for `exit` operations (withdrawals, authorized revokes and cancels);
  ordinary work can never use it (`protectedWei`).

A budget refusal (the hourly cap or the ceiling) is retryable (`sponsor_busy`) and charges nothing. A policy refusal
(calls outside the flow, a wrong sender, gas above the caps, a malformed operation) is final for that
operation and is not retried. The current limits are in
`BUDGET_LIMITS`; changing them is a reviewed code change.

## Uncertain outcomes

A timeout or an unclear answer is not proof that an operation failed. The bundler stores every send
before it broadcasts, follows it until its receipt is final, and declares an operation never sent
only when no instance can still send it (its reservation has expired under the budget lock). Every
other uncertain case stays pending: it is tracked and reconciled before any retry decision, so the
same operation is not prepared and sponsored again while its outcome is unknown.
Users see such operations as pending, not as refused.

## Switching and fallback

Two settings choose the path, and the switch is one configuration change:

- `CITY_BASE_OWN_PAYMASTER`: `off`, `prepare` (keys provisioned, addresses public, nothing sponsored)
  or `on`.
- `CITY_BASE_BUNDLER`: `direct` (our bundler) or `cdp` (the provider).

Routing is by provenance: an operation our bundler prepared or stored is only ever sent by it, and an
operation the provider prepared goes to the provider. With `CITY_BASE_BUNDLER=cdp`, new work goes to
the provider while our bundler drains what it already holds, so in-flight operations still settle.
That fallback works only while the provider is available and has capacity.

Upkeep (rebroadcast, fee bumps, cancels, receipts, finality settlement) runs from
`GET /api/cron/own-paymaster-maintain` every minute. Its tables come from migrations 256 to 259.

## What we still depend on

This removes our dependence on a third-party sponsor. Central City still depends on Base itself, on
its RPC providers and on its hosting. The design and code had independent source review inside the
team; that is engineering review, not an external security audit, and not a promise of uninterrupted
service. Withdrawing at any time remains an ownership goal, not a promise of network or sponsor
availability.
