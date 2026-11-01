# Key roles, hot balances and fleet permissions: owner runbook

Several findings of the October 2026 internal audit about key roles have an app side and an owner side.
The app side is in the code (listed per finding below). The steps here are owner actions: they
sign with owner-held or operator-held keys, move funds or change hosting settings, so the app
never does them. This runbook names settings and roles only; it never contains a key, a key ref or
a secret value. Do every on-chain step on a Base Sepolia fork first.

## CCA-709: fleet spend permissions

**In the app.** `server/base/fleet/permission-policy.ts` flags a fleet spend permission whose
allowance is above twice the fleet's planned spend per period, or that has no end date or runs
longer than the configured lifetime: default 90 days, configurable up to 365 days via
`CITY_FLEET_PERMISSION_MAX_DAYS`; values above 365 (or 0, or not a whole number) are refused and
leave no policy (a missing policy is itself a violation). An end exactly at the limit is
accepted. The fleet batch (`server/base/chain/fleet-batch-chain.ts`) checks it before anything is
signed. **Enforcement is opt-in** (`CITY_FLEET_PERMISSION_ENFORCE=1`, the last owner step below):
until then a violation logs one `fleet permission: ALERT <code> not enforced` line and the batch
goes on exactly as before; with it, the batch is refused (`PERMISSION_POLICY`). No production path
calls the fleet batch today (it is not wired), so nothing changes at deploy either way. An exception needs who approved it and why, and is logged
as `fleet permission: ALERT exception used` every time it is used (to the app's log sink, else
the console; production runs Fastify without a logger, so app.log is never used for ALERT lines).

Settings: `CITY_FLEET_PLANNED_SPEND_PER_PERIOD` (raw token units, for example `1000000` for
1 USDC a day), `CITY_FLEET_PERMISSION_MAX_DAYS` (default 90, 1 to 365, above 365 refused) and, only for a stated exception,
`CITY_FLEET_PERMISSION_EXCEPTION` as `approver: reason`. Remove the exception when it ends.

**Owner steps: re-issue.** For each funded fleet (the audit report, Fleet owner accounts):

1. Write down the fleet's planned spend per day from its recent calls (cents per call times
   calls per day per agent), and round up.
2. Compute the new terms with `fleetPermissionTerms({ plannedPerPeriod, period: 86400, start })`:
   twice the planned spend, a 24 hour period, an end 90 days after the start by default (never
   more than the configured `CITY_FLEET_PERMISSION_MAX_DAYS`, at most 365).
3. With the fleet owner key (operator-held, on the operator host, never in the app), sign one new
   permission per agent wallet with those terms and a new salt, and approve it.
4. Revoke the old permission of each agent (step below) in the same window, so no agent has both.
5. Read `isValid` for old and new permissions at one block and record the counts in the ops log.
6. Put a calendar reminder 14 days before the end date to re-issue again.

**Owner steps: revoke retired fleets.** For every fleet that no longer runs, and every old
permission replaced above: the fleet owner calls `SpendPermissionManager.revoke(permission)` for
each agent wallet (batched in one UserOperation per owner where possible). Confirm with
`isRevoked` at a settled block, then sweep what the agent wallets still hold back to the funding
wallet.

## CCA-706: app-held keys and hot balances

**In the app.** `server/base/chain/hot-wallets.ts` states a hot-balance ceiling and a planned
net balance decrease per hour for each app-held wallet role:

| Role | Asset | Default ceiling | Default planned decrease per hour |
|---|---|---|---|
| Sponsor (sponsored first purchase) | USDC | 500 USDC | 100 USDC |
| Sponsor | ETH | 0.05 ETH | 0.005 ETH |
| Fee router facilitator | ETH | 0.05 ETH | 0.005 ETH |
| Public x402 settlement sender | ETH | 0.05 ETH | 0.005 ETH |
| Paymaster submitter | ETH | 0.1 ETH | 0.01 ETH |
| Paymaster verifying signer | ETH | 0 (holds no funds) | 0 |

Each can be changed with `CITY_HOT_CEILING_<ROLE>_<ASSET>` and `CITY_HOT_OUTFLOW_<ROLE>_<ASSET>`
in raw units (for example `CITY_HOT_CEILING_SFP_SPONSOR_USDC=500000000`). Every balance read the
app already makes (sponsor USDC, facilitator and settlement sender ETH, paymaster submitter ETH)
logs `hot wallet: ALERT` when the balance is above its ceiling, or when the observed net balance
decrease between reads runs faster than the planned decrease per hour, at most once an hour per
role and asset. Lines go to the console (production has no Fastify logger).

This is monitoring, not a full outflow record: it compares balance reads with their times, so a
top-up between two reads masks spending in the same interval, and nothing between reads is seen.
Decreases are rated over the time they span (at least an hour); when the previous read is more
than an hour old the read is reported as stale and its decrease is not charged to the last hour.
It does not remediate CCA-706: the KMS/HSM move and the owner steps below stay open.

`sizeTopUp` and `topUpFor` size a top-up so the wallet ends at most at its ceiling, and refuse one
when it is already there.

**Owner steps.**

1. Agree the ceilings above (or set others) and record them in the ops log.
2. Top up only from the funding wallet (CCA-714), sized with `topUpFor`: never more than the room
   under the ceiling. Top-ups larger than that are refused by procedure, not sent and corrected
   later.
3. Route `hot wallet: ALERT` and `key roles: ALERT` log lines to the operations alert channel.
4. On a decrease ALERT nobody planned: stop the role (unset its key ref setting and redeploy),
   then follow the hot wallet rotation of CCA-708.
5. Keep production deploy and environment access to the fewest people.

**Remaining step (infrastructure).** Move signing to non-exportable keys (a KMS or HSM) behind a
separate signing service, so production code can request signatures within limits but can never
read a key. Until then every app-held key shares the production trust boundary, and the ceilings
above are what bounds the loss.

## CCA-714: one key per role

**In the app.** `server/base/chain/key-roles.ts`:

- When the key ref setting of the fee router facilitator, the public settlement sender or the
  sponsor names a key that another role's setting also names, the runtime logs one
  `key roles: ALERT <setting> names a key also configured for another role` line. **Enforcement is
  opt-in** (`CITY_KEY_ROLES_ENFORCE=1`, the last owner step below): until then the role is built
  exactly as before; with it, the role is not built (fail closed).
- At start, the app resolves each role to its public address (paymaster signer and submitters,
  facilitator, public settlement sender, sponsor, the protocol treasury and
  `CITY_FUNDING_WALLET_ADDRESS`) and logs `key roles: ALERT <role> and <role> use the same account`
  for every two roles that share one, to the app's log sink or else the console (production runs
  Fastify without a logger). Lines carry role names, setting names and public addresses only.

**Owner steps.**

1. Create a funding wallet: a new owner-held key that only tops up app-held wallets, holding no
   more than one round of top-ups. Set its public address as `CITY_FUNDING_WALLET_ADDRESS` and pin
   it in the address book. The treasury then only receives fees and funds the funding wallet.
2. Give the sponsor its own sender: set `CITY_SFP_SEND_VIA_FACILITATOR=1` so the fee router
   facilitator sends sponsored settlements and the sponsor key only signs.
3. Retire the former paymaster owner key as an attestation identity, mark what it signed as
   superseded, create a separate attestation key, and never use the new paymaster owner key for
   attestations.
4. After each deploy, check the start log for `key roles: ALERT`; there must be none.
5. Correct the role descriptions in the audit report (Wallets and keys) once the split is done.

## Last owner step: turn enforcement on

Both guards only ALERT until the owner turns them on, so the app keeps working exactly as before
while the steps above are done. Turn them on last, one at a time, and watch the log after each:

1. `CITY_FLEET_PERMISSION_ENFORCE=1`, only after CCA-709 steps 1 to 5 (planned spend set in
   `CITY_FLEET_PLANNED_SPEND_PER_PERIOD`, every funded fleet re-issued, old and retired
   permissions revoked) and after a day with no `fleet permission: ALERT` line. From then on a
   violation refuses the batch.
2. `CITY_KEY_ROLES_ENFORCE=1`, only after CCA-714 steps 1 and 2 (funding wallet set, sponsor on
   its own sender) and after a deploy whose start log has no `key roles: ALERT` line. From then on
   a role whose key ref is shared with another role is not built. Arc's paymaster keys
   (`CITY_ARC_PAYMASTER_SIGNER_KEY_REF`, `CITY_ARC_SUBMITTER_KEY_REFS`, both optional) are roles of
   their own, and so is Arc's facilitator (`CITY_ARC_FACILITATOR_KEY_REF`, optional); a key that a
   role on Base also names is refused on Arc even without this setting. The facilitator's sharing
   never blocks a role on Base.

To step back, unset the setting: the guard returns to ALERT only.

## CCA-707: retiring an old spender KEK version

**In the app.** `CITY_BASE_SPENDER_KEK` lists the key-encryption key by version
(`v<N>:<key>` entries); the highest version seals new keys, every listed version opens. Each app-held
key in `base_spender_keys` is sealed under one version, and its ref (`v<N>:<key id>`) names that
version. Copies of the ref live in `base_wallets`, in the service key tables (`own_paymaster_keys`,
`feed_pay_sponsor_key`, `x402_facilitator_key`) and in the service key ref settings. Removing a
version while any of them is still bound to it strands those keys: the wallet can no longer spend
and the service can no longer sign. Two scripts:

- `scripts/rewrap-spender-keys.ts` re-wraps **wallet keys only** (key row and wallet refs in one
  transaction), dry run by default. It never touches service keys or keys nobody references, and
  refuses to run while a service key ref setting is not loaded.
- `scripts/rewrap-service-key.ts --service <setting>` moves **one service key** (the one the
  setting names; `--index <n>` picks the entry of `CITY_BASE_SUBMITTER_KEY_REFS`) to the current
  version in place, dry run by default, `--confirm` to write. In one transaction it opens the key
  with the old version and seals it again under the current one inside the script process, checks
  the key's address against the stored and the table's address before the write, opens the new
  seal and checks it again, writes the key row and the role's table row, reads them back and
  checks once more; any mismatch rolls everything back. It refuses an unknown setting name, a
  setting not loaded (or any other service setting, unless `--allow-missing-service-refs`), a key
  a wallet references, a key another role names, a setting and table row that disagree, an
  uncommitted key, a `--to` version that is not the configured current one, and an old version
  not configured. It never prints a key, a key ref or a key id: it prints how the setting must
  change (same value, version prefix N becomes M).
- `scripts/rewrap-service-key.ts --orphans [--version v<N>] [--show-addresses]` reports the keys
  no wallet, service table or service setting references, per version (committed and
  uncommitted). Report only: it never re-seals and never deletes. `--show-addresses` with a
  version adds the public addresses of the committed ones, nothing else.
- `scripts/kek-retirement-check.ts v<N>` is the **gate**. Read-only (one read-only transaction,
  never selects sealed columns, never reads the KEK, never decrypts). It counts, for version N: the
  sealed keys in `base_spender_keys` by kind (wallet, service, uncommitted, unreferenced), the
  `base_wallets` refs, the rows of each service key table (with their purpose), and the names of
  the service key ref settings bound to it (`CITY_BASE_PAYMASTER_SIGNER_KEY_REF`,
  `CITY_BASE_SUBMITTER_KEY_REFS`, `CITY_SFP_SPONSOR_KEY_REF`, `CITY_X402_FACILITATOR_KEY_REF`,
  `CITY_X402_PUBLIC_SETTLE_KEY_REF`, `CITY_X402_PUBLIC_OFFER_KEY_REF`). It prints counts, table, purpose and setting names only,
  then `SAFE TO RETIRE v<N>` (exit 0) only when every count is zero, else `NOT SAFE TO RETIRE v<N>`
  (exit 1). It also refuses on a read error, a missing keystore table, a table with a key ref or
  sealed column it does not know, a malformed recorded ref, or a service setting not loaded
  (`--allow-missing-service-refs` only when that role holds no key in this deployment, written in
  the ops log).

`CITY_RESPONDER_KEK` and `CITY_PII_KEK` are separate key rings with their own rotation
(`docs/RESPONDER.md`, `docs/GOOGLE_SIGNIN.md`); the owner vaults are sealed by each owner's
password. None of them is part of this procedure.

**Procedure.** One order, no step skipped. N is the old version, M the new one. Steps that need
production settings, the production database or the hosting provider are **OWNER STEP**. Run the
scripts as `node --import tsx scripts/<name>.ts` with the deployment's settings loaded, at a quiet
time. Record every gate output (counts and names only) in the ops log.

1. **OWNER STEP: add the new version.** Create a new 32-byte KEK, keep the old one, set
   `CITY_BASE_SPENDER_KEK` to both entries (N and M, M the highest), redeploy. Verify: the start
   log is clean, one existing agent wallet still pays, and the gate for M shows new keys landing
   under M (`versions`). Rollback: remove the M entry and redeploy, only while the gate for M
   reports no sealed key; once a key is sealed under M, M stays.
2. **OWNER STEP: inventory.** Run the gate for N. It must answer `NOT SAFE TO RETIRE` with real
   counts and no `missing_service_refs`; a refusal for a missing setting means the settings are
   not loaded, so fix that first. Keep its `sealedKeys` and `serviceTables` as the work list.
3. **OWNER STEP: re-wrap wallet keys.** Dry run `rewrap-spender-keys.ts`: `walletKeys` must match
   the gate's `sealedKeys.wallet` and `serviceKeys` its `sealedKeys.service`; anything else, stop
   and find out why. Then `rewrap-spender-keys.ts --confirm`, and repeat the dry run until it
   reports `"walletKeys":0`. Verify: the gate shows `walletRefs` 0 and `sealedKeys.wallet` 0, and
   one controlled agent payment goes through end to end. Rollback: none needed; a re-wrapped key is
   the same key under M and N still opens the others. A payment that read the old ref just before
   the commit fails once (`Spender key not found`) and succeeds on its retry.
4. **OWNER STEP: move each service key, one at a time, in this order:** public settlement sender,
   fee router 3 facilitator, sponsor, paymaster submitters, paymaster signer. Each move re-wraps
   the same key under M in place: same key, same address, nothing changes on chain, only the
   ref's version changes from N to M. The tool is `rewrap-service-key.ts --service <setting>`.
   For each role:
   1. **Stop new work for the role.** Public settlement sender: unset `CITY_X402_PUBLIC_SETTLE`,
      redeploy. Paymaster submitters and signer: drain to the provider (`CITY_BASE_BUNDLER=cdp`,
      `docs/base/OWN_PAYMASTER_OPS.md`), redeploy, wait until our own sends in flight are final.
      Fee router 3 facilitator and sponsor have no switch of their own: do them at the quietest
      time; between the re-wrap and the redeploy their sends fail before anything is signed.
   2. **Write down the role's public address** (start log `key roles` check, the keys route, or
      `/api/public/paymaster` for the signer) and take a database restore point.
   3. **Re-wrap the role's key.** Dry run `rewrap-service-key.ts --service <setting>`: it must
      answer `"verified":true` with the expected `table` and `purpose`; a refusal names its
      `reason`, stop there. Then the same with `--confirm`: `"moved":true`. For the submitters run
      it for `--index 1` and `--index 2`, then make one setting change. A rerun answers
      `"alreadyCurrent":true` and repeats the setting change.
   4. **Set the role's setting to the new ref** as the script says (same value, only the version
      prefix changes; the new ref is also in the role's table row) and redeploy:
      `CITY_X402_PUBLIC_SETTLE_KEY_REF`, `CITY_X402_FACILITATOR_KEY_REF`,
      `CITY_SFP_SPONSOR_KEY_REF`, `CITY_BASE_SUBMITTER_KEY_REFS`,
      `CITY_BASE_PAYMASTER_SIGNER_KEY_REF`. For the paymaster the key row in `own_paymaster_keys`
      selects the key and the settings assert it: both must name the new ref, else the start log
      shows `own_paymaster_keys` state `settings_mismatch` and our bundler is not built.
   5. **Verify the role still signs.** The address is the one written down; the start log has no
      `key roles: ALERT` and no `settings_mismatch`; the log has no `Spender key not found` and no
      `Key-encryption key version is not available`. Then one controlled operation of the role end
      to end: one public `/settle` (after `CITY_X402_PUBLIC_SETTLE=1` again), one router 3
      settlement, one sponsored first purchase, one sponsored UserOperation (after
      `CITY_BASE_BUNDLER=direct` again, signer last; `verifyingSigner()` on chain is unchanged, so
      no signer rotation is needed). The gate for N no longer lists the role's table row or
      setting.
   6. **Rollback of this role.** Restore the key row and the role's table row from the restore
      point and set the setting back to the old ref, together, then redeploy (N is still listed,
      so the old ref opens again). Never restore only one of them. If only the setting was wrong,
      fix the setting forward instead.
5. **OWNER STEP: keys nobody references.** Run `rewrap-service-key.ts --orphans --version v<N>`.
   Uncommitted keys under N are removed by the app's orphan cleanup after an hour: wait and run it
   again. A committed key nobody references (for example the spender of a wallet whose account was
   erased) may still control an address that holds funds: run it again with `--show-addresses`
   and check each address's balances. The owner decides per key and writes the decision in the
   ops log; the scripts never re-seal or delete these keys. Keeping one means a separate reviewed
   re-seal; archiving one means an offline copy of its sealed row and of N's KEK before a reviewed
   removal, never for an address that holds funds. The gate stays `NOT SAFE` while any is left.
6. **OWNER STEP: run the gate until it passes.** `kek-retirement-check.ts v<N>` with every service
   setting loaded and without `--allow-missing-service-refs` (unless step 2 recorded why) must
   print `SAFE TO RETIRE v<N>` and exit 0. Run it again right before step 7, in the same quiet
   window.
7. **OWNER STEP: retire N.** Keep a sealed offline copy of N's KEK in owner custody for 30 days.
   Remove the N entry from `CITY_BASE_SPENDER_KEK` (M stays the highest, so nothing new changes
   version), redeploy. Rollback: put the N entry back exactly and redeploy.
8. **OWNER STEP: after retirement.** The start log is clean (no `key roles: ALERT`, no
   `settings_mismatch`); the log has no `Key-encryption key version is not available` and no
   `Spender key not found`; the gate for N still exits 0 and `versions` lists M only; one
   controlled operation per role and one agent wallet payment go through. After 30 days without
   such errors, destroy the offline copy of N and write it in the ops log. Never reuse the
   version number N.
