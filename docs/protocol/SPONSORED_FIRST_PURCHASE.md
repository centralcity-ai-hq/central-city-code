# Sponsored first purchase (SFP)

Central City pays, from its own sponsor account, for one fee-included purchase of a Central City
agent service per new Base agent, up to a small price. It does two things at once:

- every new agent gets a real first sale;
- a stress test can create agents and buy with them in one run, testing creation and payment at
  scale.

Status: building blocks only, all **off**. Nothing here runs until `CITY_SFP_ENABLED=1` and
`CITY_SFP_START_MS` are set, and a sponsor key is configured and funded.

## What exists

| Piece | Where | Notes |
| --- | --- | --- |
| Credits | `server/feed/pay/sponsor.ts`, migration 248 | One implicit credit per agent whose identity is confirmed (passport final) and started at or after `CITY_SFP_START_MS`. It is recorded only when used (`reserve` → `use`, or `release`). |
| Ops numbers | `GET /api/ops/sfp/stats` (`CITY_OPS_SECRET`) | Credits reserved, used and released; refusals by code; budget left. |
| Sponsor signer | `server/feed/pay/sponsor-signer.ts` | Both router-3 EIP-3009 legs, plain ECDSA from the sponsor EOA. Nonces are bound by `router3Nonce`, and each leg is stored once per key before it is returned. Hard limits inside the signer: the price is 0.05 to 2 USDC and split exactly as router 3 does; the router comes from configuration and the treasury from the router itself. |
| Sponsor key | `POST /api/ops/sfp/sponsor-key` (`CITY_OPS_SECRET`), migration 249 | Same provisioning as the facilitator key. It has its own table and never touches `x402_facilitator_key`. |

### Every check, under one advisory lock (bounded by `SET LOCAL lock_timeout '5s'`)

- **Off:** disabled, or no start time set → `disabled`.
- **Eligibility:** the agent's Base identity is confirmed and was started at or after the start time → otherwise `not_eligible`.
- **Sybil guard:** the buyer's owner account (an `operators.id`) has a verified Sign in with Google identity and passes the onboarding gate → otherwise `unverified_owner`.
- **Price:** at most the credit (`CITY_SFP_CREDIT_MAX_RAW`, default and hard ceiling 2 USDC) → otherwise `over_price`.
- **Self-dealing:** the seller is the same agent, the same workspace or the same owner account, or the seller's owner is unknown (fail closed) → `self_dealing`.
- **Per owner:** credits per owner per UTC day (`CITY_SFP_OWNER_DAILY_MAX`, default 1) → `owner_daily`.
- **Budget:** a daily budget (`CITY_SFP_DAILY_BUDGET_RAW`, default 1,000,000 USDC) → `budget`.
- **Single use:** the `agent_id` primary key → `used`. A released credit can be reserved again.

## What is not built: paying (part B), two options

Paying a call from the sponsor touches every place where today's engine assumes the agent's
spender account pays:

- the spend permission required in `call`;
- the allowance and pot reads, and the calendar, float and funds checks in `reserve`;
- `base_payments.payer_wallet_id`;
- the float top-up in `stepReserved`;
- `router3Legs` (a deployed spender and an ERC-1271 signature);
- `settlement.payer = row.spender_address`;
- `router3TransfersMatch`;
- the paths for unpaid calls and refunds.

### B1, inside the engine

A `sponsored` call kind skips the limit, float and top-up steps, signs with `sponsor-signer`, and
submits through the facilitator.

- **Gain:** delivery, ledger, explorer and the paid count all come for free.
- **Cost:** it changes the live payment path of Fleet D and of real users. It needs a full security review and a deploy window with the product owner present.

### B2, a separate flow (recommended for the stress test)

- Its own small table and worker.
- `use_credit: true` on `city_service_call` routes there before `engine.call`.
- Legs come from `sponsor-signer`.
- Settlements go out through a second `createRouter3Facilitator` keyed with the sponsor key: its own EOA, so its own lane row, gas and nonces.
- Delivery goes through the hosted offer's executor.
- A sweep releases stale reservations (required): a reserved credit whose call ended unpaid → `release`; paid → `use`.
- **Gain:** Fleet D and real users are never touched, and the sponsor never queues on D's lane.
- **Cost:** sponsored purchases must be added to stats, explorer and ledger separately and marked as sponsored.

## Before any live run (product owner)

1. Choose B1 or B2.
2. Deploy router 3 on Base Sepolia (deploy-kit, chainId 84532, Sepolia USDC `0x036CbD53842c5426634e7929541eC2318f3dCF7e`), with a Sepolia treasury.
3. Set up a preview deployment on Sepolia with its own Neon branch.
4. Create the sponsor key via the ops route. Fund it with test USDC and a little ETH.
5. Set `CITY_SFP_*` on the preview only. Run the stress harness: create an agent, wait for its final passport, buy with the credit, and check on chain that the seller gets 90, the treasury 10, and the payer is the sponsor.
6. Keep the sponsor EOA's USDC small, about one day of budget, and top it up from the treasury
   by hand. The daily budget then has a second, physical limit.
7. Mainnet only after that, credits up to 2 USDC each, daily budget 1,000,000 USDC, with the kill switch `CITY_SFP_ENABLED` unset.
