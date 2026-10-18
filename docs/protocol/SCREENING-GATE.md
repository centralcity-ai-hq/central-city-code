# Payment screening gate (implemented, N3)

Status: engineering control, live by default; `CITY_PROTOCOL_SCREENING=0` is its emergency off ([LIVE.md](LIVE.md)). It implements part of the screening policy draft (SCREENING.md on the protocol policy branch). On Base mainnet its provider is the on-chain sanctions oracle fixed in code (`shared/protocol.ts`). It does not certify compliance or replace a legal determination, and that oracle covers its maintainer's sanctions list only: it is not a KYT service. Provider coverage (lists, KYT, networks) must be established by integration evidence, not by the mocks in the tests.

## Switches

| Setting                          | Meaning                                                                                                                                                                                                                                                                                                                            |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CITY_PROTOCOL_SCREENING`        | The emergency off: exactly `0` turns the gate off (read per step; nothing is screened, no behaviour change). Unset or anything else: on.                                                                                                                                                                                           |
| `CITY_PROTOCOL_SCREENING_ORACLE` | Ignored on Base mainnet, where the oracle is fixed in code: `0x3A91A31cB3dC49b4db9Ce721F50a9D076c8D739B` (`isSanctioned(address) returns (bool)`; a value that disagrees is logged once, never used). On a test network: the oracle's address, no default; missing or invalid there: no provider, every new submission is refused. |
| `CITY_PROTOCOL_SCREENING_DENY`   | Optional comma-separated static denylist. A supplement: a listed party is blocked whatever the provider says.                                                                                                                                                                                                                      |

## One decision interface

`server/protocol/screening/gate.ts`: `screen({chainId, token, amountRaw, intentId, parties})` answers `{allowed, outcome, decisionId, reason, expiresAt, reused}`. Parties carry a role (`payer`, `spender`, `payee`, `fee_recipient`) and an address. Callers never pass a clearance.

- Fail closed. No provider, an unknown chain, an outage, a timeout (5 s), a malformed answer, a stale answer (observed more than 5 minutes ago) and an invalid request all answer `allowed: false` with outcome `unavailable`. Nothing is stored for them.
- Durable decisions. Allowed and blocked decisions are stored in `protocol_screening_decisions` (migration 115). Each one is bound to the chain, the token, the exact amount, the intent id, every party (role and lowercase address), the policy version and the provider reference, and it expires after 10 minutes.
- Reuse. Only an unexpired decision with exactly the same binding is reused. A changed amount, destination, chain, intent, provider or denylist (policy version) means a new screening. A blocked decision is reused as blocked until it expires.
- No addresses or secrets are logged. The engine logs the intent id, outcome, reason and decision id.

The provider adapter interface is `ScreeningProvider` (`ref`, `supports(chainId)`, `check({chainId, addresses, signal})`). The first adapter is `server/protocol/screening/sanctions-oracle.ts`. It makes read-only `isSanctioned` calls through the wallet network's chain runtime read client. Tests inject a fake provider and never use the network.

## Where Feed pay asks

| Point                                                                                               | Parties                                                                    | Intent                     | Not cleared                                                                                                                                                                                                                                                                                       |
| --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Before a new seller authorization: on `reserved` (before any top-up) and again right before signing | payer wallet, spender, payTo                                               | `feed-pay:<callId>`        | The call ends `refused` with failure `screening_blocked` or `screening_unavailable`. Nothing was signed or paid.                                                                                                                                                                                  |
| Before a float top-up is first broadcast (the operation's authority hook)                           | payer wallet, spender                                                      | `feed-pay:top-up:<moveId>` | The top-up is not broadcast and the call ends `refused` with the screening failure code.                                                                                                                                                                                                          |
| Before the protocol fee leg is first submitted (`fee_state = 'pending'`)                            | spender, the treasury the call's pinned router really pays (read on chain) | `feed-pay:fee:<callId>`    | The fee stays `pending` under its one key `feed-pay:fee:<callId>`. Nothing is charged and nothing is sent under a new key. `fee_held_at` and `fee_hold_reason` are recorded, and ops get one `protocol_fee_screening_hold` alert per hold. It is screened again after 5 minutes (worker or cron). |

The fee recipient comes from the pinned router itself: its immutable `treasury()` and `token()` are read on the payment chain and cached per chain and router (a failed read is never cached). A configured address is never screened in its place. The fee is held instead when the read fails or is malformed (`fee_recipient_unknown`), when the router's token is not Feed pay's USDC (`fee_router_token_mismatch`), or when the router pays another address than the protocol treasury for the chain (`fee_recipient_mismatch`: on Base mainnet the treasury fixed in code, `shared/protocol.ts`; on a test network `CITY_PROTOCOL_TREASURY` when set). This binding check runs whether screening is on or off, for a fee on top as for a fee-included payment: with `CITY_PROTOCOL_SCREENING=0` only the screening is skipped, and a fee whose binding is right goes at once (an earlier screening hold is released).

Screening is never asked when reconciling something already broadcast: a `sent` fee operation, a top-up already stored, an authorization with the service, cancels, or sweeps of the float back to the agent's own wallet. An outage therefore never stops reconciliation. Sweeps, refunds and changed destinations still need the separately approved handling policy.

## Open

- List coverage beyond the oracle's sanctions list (KYT) and integration evidence for it.
- Retention period and access to `protocol_screening_decisions`, which holds addresses bound to intents.
- An accountable exception process. No override exists in code.
- Other entry points (agent Pay, the escrow operator and automated agent payments) are not wired yet.
