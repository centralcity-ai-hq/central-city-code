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
| Paymaster owner (admin: deposit, allowlist, signer)                         | `owner()` on chain                           |

The chain is the source of truth: these
addresses are fixed in code in `shared/base/own-paymaster-record.ts`, a test keeps this page equal
to it, and the owner history and the deploy transaction's constructor arguments are recorded in the
private operations repository.

`GET /api/public/paymaster` answers the live state: `mode`, `paymaster`, `verifyingSigner`,
`submitter`, `bundlerConfigured` and `bundler`.

## Settings (Vercel production)

| Setting                             | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CITY_BASE_PAYMASTER_ADDRESS`       | The paymaster above. Required for `prepare` and `on`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `CITY_BASE_OWN_PAYMASTER`           | `off` (or unset): not used. `prepare`: keys and the budget exist, nothing is sponsored by it. `on`: it sponsors.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `CITY_BASE_BUNDLER`                 | `direct`: new operations are signed by our paymaster and sent by our submitter. `cdp` (or unset): new work goes to the external provider, while our own sends already in flight are still followed to the end (drain). `direct` needs `CITY_BASE_OWN_PAYMASTER=on`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `CITY_BASE_SPONSOR_OPERATOR_OWNERS` | Comma-separated **public owner addresses** (EOAs) of the platform's own fleets, from the public WALLETS inventory. The server maps them to account ids itself, at start and then hourly, only through proof of the owner key it verified: the owner vault (the key signed the vault for that account) with the workspaces of the wallets bound to it, or an active spending limit whose owner signature it verified. A registration that merely typed the address never maps. Those accounts skip the per-account, per-sender and never-sent caps and the handout share below, the per-account unsigned caps and the registration rate (never the deployment-wide hours, the deposit, or the exit day beyond the first 3 exits a day that every account keeps past it, below). A proven account id may be a workspace: its exemption from the registration rate (and from the per-account caps on its registrations, which are sponsored for the workspace) is workspace-wide, so it covers every signed-in person acting in that workspace, a co-owner who holds no fleet key included, not only the person whose key proved it. A malformed address fails the start; a repeat is ignored. `CITY_BASE_SPONSOR_OPERATOR_ACCOUNTS` (account ids) is retired: no longer read, an alert at start while it is set; remove it. |

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

## Signer leak and signer rotation

The sponsorship signer (`CITY_BASE_PAYMASTER_SIGNER_KEY_REF`) only signs off-chain, but its
signature spends the paymaster's EntryPoint deposit. Two facts decide the order of the steps:

- **The contract accepts a pending signer immediately.** As soon as the owner calls
  `setPendingVerifyingSigner(new)`, sponsorships signed by the pending signer validate on chain,
  next to those of the current `verifyingSigner`, until `rotateVerifyingSigner()` completes the
  change. Setting a pending signer is therefore already a grant of the deposit.
- **Our service refuses to sponsor on an unexpected pending signer.** Its readiness check
  (`direct-bundler.ts`, `readiness`) sponsors only while the signer key decrypts to the configured
  address, the on-chain `verifyingSigner` is that address, and `pendingVerifyingSigner` is zero or
  that same configured address. Any other pending signer logs
  `own paymaster: ALERT signer mismatch, sponsoring refused` and sponsors nothing. A successful
  check is cached for up to 60 seconds.

### Signer leak (or suspected leak)

1. **Withdraw the deposit first.** The current owner calls `withdrawTo(<safe address>, <amount>)`
   on the paymaster for the whole `EntryPoint.balanceOf(paymaster)`. A leaked signer can spend only
   the deposit, so an empty deposit ends the exposure whatever happens next. Check the balance is 0.
2. Stop new sponsoring: `CITY_BASE_BUNDLER=cdp` (drain, see Switching), one redeploy.
3. Rotate the signer as below, then fund the deposit again (Funding) only after the rotation is
   verified.

### Signer rotation (planned or after a leak)

1. Have the new signer key and its address ready in the keystore. The keys route and prepare mode
   are idempotent per purpose and refuse while `CITY_BASE_PAYMASTER_SIGNER_KEY_REF` is set, so they
   do not mint a replacement signer; making the new key is a separate, reviewed step. The keys
   route answers public addresses only, never keyRefs.
2. **Set the pending signer and switch the service signer at the same time.** The service always
   uses the signer recorded in `own_paymaster_keys`; `CITY_BASE_PAYMASTER_SIGNER_KEY_REF` and
   `CITY_BASE_SUBMITTER_KEY_REFS` do not select keys, they only assert them: when set and not equal
   to the recorded keys, our own bundler is not built (CDP keeps serving) and the start log shows
   `own_paymaster_keys` state `settings_mismatch`. The owner calls
   `setPendingVerifyingSigner(new)`; in the same window record the new key as `paymaster_signer`
   (the reviewed step above) and prepare the production deployment with
   `CITY_BASE_PAYMASTER_SIGNER_KEY_REF` set to the new key (one redeploy). Readiness also requires
   the on-chain `verifyingSigner` to be the configured signer, so from the pending signer (once the
   60-second cache lapses) until the rotation the service refuses (`signer_mismatch`) on the old
   key and on the new one alike; a pending signer equal to the configured one only passes the
   pending check. That is expected; keep the window short by rotating right after the redeploy.
3. **Rotate**: the owner calls `rotateVerifyingSigner()`. The on-chain `verifyingSigner` is now the
   new address and the old signer's signatures stop validating.
4. **Verify**: `verifyingSigner()` is the new address; `pendingVerifyingSigner()` is zero (or the
   new address); `/api/public/paymaster` shows the new `verifyingSigner`; the production log has no
   `signer mismatch` after the redeploy; one controlled operation goes through end to end. Then
   switch `CITY_BASE_BUNDLER=direct` again if it was drained, and refund the deposit if it was
   withdrawn.

The app side of these steps is rehearsed with throwaway keys and a scripted contract in
`tests/own-paymaster-signer-rotation.test.ts`.

Never leave a pending signer set that the service is not configured for: the contract honours it
while our service refuses to sponsor, so it is a live grant of the deposit with no use.

## Budget (enforced in code, `server/base/chain/own-paymaster-budget.ts`)

| Limit                                                               | Value              |
| ------------------------------------------------------------------- | ------------------ |
| Ordinary total ceiling (includes the gas already paid by the admin) | 0.93 ETH           |
| Ordinary per rolling hour                                           | 0.1 ETH            |
| Protected reserve (only exits: withdrawals, cancels, revokes)       | 0.05 ETH           |
| Exits per rolling hour, deployment-wide (the bound on exits)        | 0.02 ETH           |
| Exits per rolling day, deployment-wide (an alert figure, see below) | 0.05 ETH           |
| An account's first exits of a day, past the deployment-wide day     | 3                  |
| Owner handouts never signed yet, of each shared hour                | 30% (see below)    |
| One account per rolling hour: ordinary / exits                      | 0.01 / 0.005 ETH   |
| One account's exits per rolling day                                 | 0.005 ETH          |
| One sender per rolling hour: ordinary / exits                       | 0.005 / 0.0025 ETH |
| Owner handouts never sent, per account at a time: all / exits       | 10 / 2             |
| Validity of a sponsorship: owner handouts / server-signed           | 5 / 9 minutes      |

An owner handout is a sponsored operation an owner signs in the browser (withdrawal, cancel,
revoke, payment, rating). Operations the server signs itself (registrations, agent payments, feed
pay) never take one of an account's 10 places. A handout the owner discards (or that lapses
unsigned, or that our own server refuses before any broadcast) is released: only our allowlisted
submitter can send our sponsorships, and it never sends a released one, so it holds nothing more of
the deposit or the shared hours; its own account's hourly and daily caps still count it. One left
open (never signed, never cancelled) holds its share until its validUntil + 2 minutes, about 7
minutes: owner handouts are valid 5 minutes (3 to sign and send). Our bundler no longer sends one
in the last 2 minutes before its validUntil, so the server takes no owner signature for it from
then on either: the withdrawal, payment, rating, cancel or revoke is refused up front (`expired`
or `sponsorship_expired`: prepare again), never accepted as submitted and lapsed afterwards.
Outside a nonce lane its signing deadline (`expiresAt`) is that point (validUntil − 2 minutes). In
its own lane `expiresAt` stays the validUntil, which the server and the browser check the
sponsorship against; the submit refuses the last 2 minutes all the same. Owner-funded operations
have no validUntil and keep their deadline.

The 30% handout share is fair per account: an account that holds no never-signed handout of a class
(ordinary, exit) may always take one, bound only by the shared hour and day, so the share never
refuses an owner's first withdrawal, cancel, revoke or payment. That holds for the share only: the
shared hour is checked first and binds first handouts too, so enough accounts that each hold one
never-signed first handout fill the shared hour between them, and an honest owner's first is then
refused (`exit_hourly`, `hourly`) until those lapse. For exits that takes about 37 accounts at the
0.5 gwei fee ceiling (about 26 when their second exits also fill the share) and over 1,000 at
Base's usual fees, each refreshed every 7 minutes; the ordinary hour takes the counts below. This
is the accepted residual of a shared hour, not a guarantee of the first. Past its first, an
account's handouts share the 30%. Operator accounts are not held to the share (the fleets
sign theirs at once). The rest of each hour stays with the server-signed flows and signed
operations unless very many accounts each hold one open past the full share: at Base's usual fees
that takes about 5,000 accounts for the ordinary hour and 1,000 for the exit hour; at the 0.5 gwei
fee ceiling about 130 and 26, each one refreshed every 7 minutes.

The deployment-wide exit day (0.05 ETH, the size of the protected reserve) is an alert figure, not
a ceiling: past it, each account (operator accounts too; not the platform's own exits, which have
no account) still keeps its first 3 exits of the day, so the day's exits can exceed it with no
refusal at all. The exit day does not hold those 3; the hourly exit caps and the deposit still do
(the shared hour always; a non-operator account's own hour, sender hour and own day too). The bound
on exits is therefore the shared exit hour: at most 24 × 0.02 = 0.48 ETH of worst-case exits a
rolling day, and never more than the deposit. When an exit is admitted past the day figure only as
one of its account's first 3, the log reads `ALERT exits past the deployment exit day`, at most once
a rolling day per server instance; an exit refused at the day figure logs `ALERT budget refused …
(exit_daily)`. Accounts that loop exits up to the day figure (it takes 10 at their own day) pause
exits only for themselves and other accounts past their first 3. The shared day counts the
sponsorships themselves, never the submitter's exposures for them.

Every sponsored user operation reserves its **worst case** atomically when it is admitted:

```text
(callGasLimit + 3 × verificationGasLimit + preVerificationGas) × maxFeePerGas
```

The submitter's own outer
transaction exposure (its gas limit × max fee, plus the L1 fee) is accounted separately: at send it
is checked against the deposit only, so an operation admitted at reserve and signed is never refused
for an hour others filled meanwhile. It counts in the shared hours and days (each operation about
twice there, by design: those caps are sized on worst cases), never in an account's or sender's own
caps (once there). A self-paid operation (no paymaster, the owner-funded fallback) is its own class:
its exposure is checked only against the submitter's float. Both are settled to the real cost only
when their block is final on Base, so the limits bind on worst-case amounts well above the real
spend. A refusal by a budget limit is answered as busy and may be retried by its flow; policy,
configuration and malformed-operation refusals are final. Nothing is signed beyond the limits.

While our bundler cannot be built and the provider is the automatic fallback, nothing is sponsored
(the log reads `ALERT sponsorship refused while CDP is the fallback`); self-paid operations still go
through. With `CITY_BASE_BUNDLER=cdp` (the planned switch back) the provider's own sponsorship policy
is the only cap besides the route rate limits: set its per-user and global limits there first.

## Funding

- **Deposit**: `EntryPoint.depositTo(0x8Bf5…e105)` with ETH, from any wallet (on Basescan: Write
  Contract on the EntryPoint), the clearest method. A plain ETH transfer to the paymaster contract
  with normal gas is credited to the deposit too (its `receive` forwards the ETH to the EntryPoint,
  whose own `receive` deposits it for the sender); a transfer limited to 2,300 gas (Solidity `transfer`/`send`) fails. Check
  with `EntryPoint.balanceOf(paymaster)`.
- **Submitter**: plain ETH transfer. It pays each `handleOps` up front and is repaid by the
  EntryPoint (it is the beneficiary), so its balance stays about level. Keep at least 0.0025 ETH;
  more allows more operations in flight.
- **Admin**: only for admin transactions. Keep about 0.005 ETH.
- A larger deposit does not raise the limits above; they change in code (one constant each).
- These are the mechanisms. Funding and spending are decided by the product owner.

## Observed cost (24 October 2026)

A sampled observation, not a promised or full operating cost: one registration (mint plus
hand-over) debited about 0.0000038 ETH from the paymaster's EntryPoint deposit (`actualGasCost`).
Debits vary with Base gas prices.

## Monitoring

- `/api/public/paymaster`: mode and bundler.
- `EntryPoint.balanceOf(paymaster)` and the submitter balance and nonce on Base.
- Reverted sponsored operations (CCA-752): an operation whose own execution reverts is still paid
  from the deposit, within the worst case reserved for it before signing. When its block is final,
  the log reads
  `own paymaster: ALERT sponsored operation <userOpHash> reverted, deposit paid <wei> wei`, once
  per operation. Count these lines: a steady rate points to a flow or an account whose operations
  keep failing.
- At start and at every hourly refresh: `sponsor_operator_owners` with counts only (never ids or
  addresses): `N owners -> M proven accounts, K owners unproven (not exempt)`. K > 0 is a warning:
  K listed owners have no proof row (no vault, no active verified limit), so nothing is exempt for
  them. `ALERT CITY_BASE_SPONSOR_OPERATOR_OWNERS is empty while our paymaster sponsors` means the
  fleets are held to the per-account caps: set the list and redeploy. `ALERT sponsor operator
owners could not be resolved` means the database read failed; the last resolution stands for at
  most 2 h, then nobody is exempt until a read succeeds (retried each minute).

### Deploy: the fleet owner list

1. Set `CITY_BASE_SPONSOR_OPERATOR_OWNERS` to every fleet owner address in the public WALLETS
   inventory (comma-separated, any case); remove `CITY_BASE_SPONSOR_OPERATOR_ACCOUNTS`. One
   redeploy with the other env changes.
2. Probe the start line in the production logs (`sponsor_operator_owners`): `owners` equals the
   number of distinct addresses listed, and `unprovenOwners` is 0. An unproven owner's fleet has
   not set up its wallet key (vault) or a spending limit on this deployment's database: it runs
   within the per-account caps and is paced, which is safe. Fix it there (wallet key or limit),
   not by listing account ids: the next hourly refresh picks it up without a redeploy.
3. `proven` counts the people and workspaces exempted; it changes when fleets add workspaces.
   A proven workspace is exempt from the registration rate for everyone acting in it (its
   co-owners too), not only for the fleet owner's own sign-in.
   No ALERT line about the retired setting.

- Production logs: `own bundler: <hash> sent nonce <n>` per send; refusals name their limit
  (`submitter exposure refused (deposit)`, `budget refused registration (hourly)`); the ones to act
  on at once read `ALERT budget refused exit (exit_daily)` (exits past an account's first 3 of the
  day paused until the rolling day frees: top up and review),
  `ALERT exits past the deployment exit day` (exits admitted past the 0.05 ETH day figure as
  accounts' first 3, reported once a rolling day per instance: review who is exiting; the exit
  hour still bounds them), `(deposit)` and `(protected_reserve)`; upkeep failures
  read `own bundler: maintain <hash> failed (<Name> code=… rpc=… http=…)`; failed receipt lookups
  log `chain.receipt_unknown` / `chain.receipt_error`. These lines are designed to exclude arbitrary error messages and endpoint secrets: they carry
  allowlisted error names, code-shaped codes and a fixed set of our own guard messages.
- `/api/public/stats` `base_agents` and the Explorer's On Base total count registrations that are
  final or finalizing with a safe mint and hand-over.
