# Own paymaster: operations

Since 24 October 2026 Central City sponsors the supported Base user operations (registrations and
hand-overs, ratings, agent payments, withdrawals, cancels and revokes) with its own ERC-4337
paymaster and submits them with its own bundler. Fee router 3 settlements are separate: they are
sent by Central City's x402 facilitator, not as sponsored user operations. This page is the operator's view: settings, switching, recovery,
funding and monitoring. The design (policy, budget, provenance, drain, finality) is in
[OWN_PAYMASTER.md](OWN_PAYMASTER.md) and the code under `server/base/chain/`.

## Addresses (Base mainnet, chain 8453)

| What                                                                        | Address                                      |
| --------------------------------------------------------------------------- | -------------------------------------------- |
| Paymaster (VerifyingPaymaster v1.0.0, unmodified, EntryPoint v0.6)          | `0x8Bf5b18b733a864c17Cd92615cD45D833Fcfe105` |
| EntryPoint v0.6 (holds the paymaster's deposit)                             | `0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789` |
| Bundler submitter (sends `handleOps`, the paymaster's only allowed bundler) | `0xbbd1B99822d03a1C46F8b4C063dd1a66fCCa1D47` |
| Paymaster owner (admin: deposit, allowlist, signer)                         | `0x3Cc6b541a88fCE61d4ea769703fA5025ccF498d1` |

`GET /api/public/paymaster` answers the live state: `mode`, `paymaster`, `verifyingSigner`,
`submitter`, `bundlerConfigured` and `bundler`.

## Settings (Vercel production)

| Setting                       | Meaning                                                                                                                                                                                                                                                             |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CITY_BASE_PAYMASTER_ADDRESS` | The paymaster above. Required for `prepare` and `on`.                                                                                                                                                                                                               |
| `CITY_BASE_OWN_PAYMASTER`     | `off` (or unset): not used. `prepare`: keys and the budget exist, nothing is sponsored by it. `on`: it sponsors.                                                                                                                                                    |
| `CITY_BASE_BUNDLER`           | `direct`: new operations are signed by our paymaster and sent by our submitter. `cdp` (or unset): new work goes to the external provider, while our own sends already in flight are still followed to the end (drain). `direct` needs `CITY_BASE_OWN_PAYMASTER=on`. |

Env changes take effect only with a new production deployment. Batch them into one redeploy.

## Switching

- **On**: `CITY_BASE_OWN_PAYMASTER=on` and `CITY_BASE_BUNDLER=direct`, one redeploy. Then check
  `/api/public/paymaster` (`mode` `on`, `bundler` `direct`) and one controlled operation end to end.
- **Back to the provider (drain)**: `CITY_BASE_BUNDLER=cdp`, one redeploy. New work goes to the
  provider; the upkeep cron keeps rebroadcasting, settling and finalizing our open sends until none
  are left (`/api/cron/own-paymaster-maintain` answers `drain` with the open count, then `off`).
  This needs the provider to have capacity.
- **Planned shutdown**: drain first. Before removing keys or the deposit, wait until no own send
  is open, reconcile every outstanding sponsorship reservation and prepared operation, and make sure
  no running deployment can still submit with our paymaster or submitter.

## Recovery

- Schema migration 259 (`own_paymaster_sends_final`) is applied by the first production start of a
  build that knows it. **Builds older than 259 refuse to start afterwards** ("schema migration 259
  is unknown"), so never promote one. Promote only a healthy deployment that already has 259; fix
  code faults forward.
- A config fault is fixed by the drain switch above, not by a rollback.

## Budget (enforced in code, `server/base/chain/own-paymaster-budget.ts`)

| Limit                                                               | Value    |
| ------------------------------------------------------------------- | -------- |
| Ordinary total ceiling (includes the gas already paid by the admin) | 0.93 ETH |
| Ordinary per rolling hour                                           | 0.1 ETH  |
| Protected reserve (only exits: withdrawals, cancels, revokes)       | 0.05 ETH |

Every sponsored user operation reserves its **worst case** atomically when it is admitted:

```text
(callGasLimit + 3 × verificationGasLimit + preVerificationGas) × maxFeePerGas
```

The submitter's own outer
transaction exposure (its gas limit × max fee, plus the L1 fee) is accounted separately. Both are
settled to the real cost only when their block is final on Base, so the limits bind on worst-case
amounts well above the real spend. A refusal by a budget limit is answered as busy and may be
retried by its flow; policy, configuration and malformed-operation refusals are final. Nothing is
signed beyond the limits.

## Funding

- **Deposit**: `EntryPoint.depositTo(0x8Bf5…e105)` with ETH, from any wallet (on Basescan: Write
  Contract on the EntryPoint). Never a plain transfer to the paymaster contract: it has no plain
  receive and the transfer fails. Check with `EntryPoint.balanceOf(paymaster)`.
- **Submitter**: plain ETH transfer. It pays each `handleOps` up front and is repaid by the
  EntryPoint (it is the beneficiary), so its balance stays about level. Keep at least 0.0025 ETH;
  more allows more operations in flight.
- **Admin**: only for admin transactions. Keep about 0.005 ETH.
- A larger deposit does not raise the ceilings above; they change in code (one constant each).
- These are the mechanisms. Funding and spending are decided by the product owner.

## Observed cost (24 October 2026)

A sampled observation, not a promised or full operating cost: one registration (mint plus
hand-over) debited about 0.0000038 ETH from the paymaster's EntryPoint deposit (`actualGasCost`).
Debits vary with Base gas prices.

## Monitoring

- `/api/public/paymaster`: mode and bundler.
- `EntryPoint.balanceOf(paymaster)` and the submitter balance and nonce on Base.
- Production logs: `own bundler: <hash> sent nonce <n>` per send; refusals name their limit
  (`submitter exposure refused (hourly)`, `budget refused registration (hourly)`); upkeep failures
  read `own bundler: maintain <hash> failed (<Name> code=… rpc=… http=…)`; failed receipt lookups
  log `chain.receipt_unknown` / `chain.receipt_error`. These lines are designed to exclude arbitrary error messages and endpoint secrets: they carry
  allowlisted error names, code-shaped codes and a fixed set of our own guard messages.
- `/api/public/stats` `base_agents` and the Explorer's On Base total count registrations that are
  final or finalizing with a safe mint and hand-over.
