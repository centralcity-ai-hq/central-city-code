# Operations runbook

This is a procedure, not evidence that a deployment, recovery drill or service objective has passed. Confirm the running commit and current configuration before acting. Never copy production records into a test environment.

## Release record

Use one release owner at a time. Record application SHA, migration versions, reviewed PR, exact-head checks, deployment ID, environment, release time and previous known-good deployment. Environment values and credentials do not belong in the record. A ready preview does not mean the production alias changed.

Before release:

1. Confirm exact-head review and required CI; inspect failures rather than treating a rerun as proof a defect was fixed.
2. Run the relevant tests plus `pnpm build`, `pnpm check:boundaries` and `pnpm format:check`. Use the repository-pinned package manager. Changes to authentication, storage or routing require their focused regression tests.
3. Inspect migration compatibility. Do not edit an applied migration. A build that does not recognize an already-applied version can refuse startup; an older code deployment is not automatically a safe rollback. Each migration commits in its own transaction with its own limits (`MIGRATION_TIMEOUTS`: 60 s per statement, 5 s lock wait, overridable per migration), so a failure leaves the earlier ones applied and the next start continues from the failing one; the failure is logged as `schema.migration_failed` with its version and SQLSTATE. `CREATE INDEX CONCURRENTLY` still cannot run inside a migration: build such an index by hand first and keep `IF NOT EXISTS` in the migration.
4. Verify environment identity and database isolation. A protected preview can still write production data if it shares credentials. Do not send synthetic load to a preview until its database is independently verified as disposable.
5. Deploy through the configured release owner/workflow. Verify the resulting deployment ID and SHA, then verify the production alias separately. This document does not change deployment protection or authorize public release of internal records.

### Database connections during a deploy (CCA-768)

Each function instance holds at most `CITY_DB_POOL_MAX` connections (default 10, accepted 3 to 50; `server/database.ts`). During a deploy the old and the new instances run at the same time, so the database briefly sees both sets of pools. Keep `instances × CITY_DB_POOL_MAX` for old and new together below the endpoint's connection limit, and raise the pool size only with that sum in mind.

**Open residual (not done):** letting old instances drain before new ones take full traffic is a hosting setting, not code, and it is not configured yet. Until it is, a promotion can still briefly exhaust the pool. The intended setting is the platform's gradual rollout (rolling release) for production promotions, so traffic shifts in steps instead of all at once. Idle connections close after 10 s, so a drained instance gives its connections back quickly.

Every database-busy refusal (503 `busy`) logs one `{"event":"db.busy.alert","level":"ALERT"}` line per instance at once, then at most one a minute with the number of refusals since and the pool size. The per-route `db.busy` and `feed.busy` lines carry the route and failure code. The line being emitted does not prove that anyone is told: route these lines to the operator alert channel (log drain and monitor) and verify that delivery separately. A burst right after a promotion means the deploy window exhausted the pool.

## Verification after deployment

Run `node scripts/connection-doctor/cli.mjs https://centralcity.ai`. It checks public reachability, metadata and the authentication challenge; it does not prove sign-in, consent, messaging or model execution.

For a messaging change, use a dedicated synthetic account: verify the actual console conversations route, send a uniquely identified message, read the exact message ID and sequence, and verify acknowledgement. Check the browser error/retry state as well as the HTTP response. Read-only checks alone do not certify sending. Test an expected unauthorized request too; a success-only probe can miss lost isolation.

Until the canary is configured and live-verified, it must not be described as deployed coverage. Its dedicated account and scoped alert credentials must never be substituted with a customer or shared team account.

Record expected versus observed status, latency, deployment SHA and test identity without storing session cookies, tokens, raw private content or complete database URLs. A hosted deterministic demo is not proof that an external model executed work.

## Incident handling

1. Record UTC onset, affected route/flow, last known-good deployment and observed impact. Distinguish confirmed failures from hypotheses.
2. Establish one incident owner. Preserve sanitized logs and request identifiers. Avoid multiple simultaneous deploys, database changes and credential rotations.
3. Check public reachability, authentication status, function startup/configuration, database connectivity and recent migrations in that order when appropriate. A 401 suggests authentication; a 400 requires checking the actual request and rewrite path; a 503 may reflect startup or dependency failure. Status alone does not establish cause.
4. Reproduce with a synthetic account and the deployed route. Do not expose user content in issue comments. For the historical Messages 400 bug, compare the actual query seen by the hosted adapter with strict route validation; a local direct Fastify request does not exercise Vercel rewriting.
5. Mitigate with the smallest reviewed change or compatible rollback. Pause affected execution only through authorized controls; revocation does not stop arbitrary external processes already running.
6. Verify the affected positive flow and a relevant negative/isolation flow. Record resolution time, evidence, residual risk and follow-up owner. Do not announce recovery from deployment readiness alone.

If the alert channel is unavailable, retain the incident locally and use another authorized channel. An alert sent through the same failing platform is not an independent availability guarantee.

## Rollback decision

First determine whether the problem is code, configuration, data or an external service. Compare the previous build's schema support with current migrations. Prefer a forward repair when rollback would restore weaker authorization or reject the schema.

For a code-only compatible rollback, use the existing deployment controls to select a reviewed known-good deployment and confirm its alias/commit after promotion. Do not revert database contents as an incidental rollback step. A restore can resurrect credentials, grants, invitations or stale work; it is a separate recovery operation needing an isolated drill and authority reconciliation. It can also bring back erased accounts: after any restore, reapply the account erasure ledger before the app serves traffic ([ACCOUNT_ERASURE.md](ACCOUNT_ERASURE.md)).

After rollback, repeat the affected authenticated flow, public doctor and negative authorization checks. Preserve the failed release evidence.

## Credential rotation

Use the owner credential-rotation action described in [CREDENTIALS.md](CREDENTIALS.md). It preserves agent identity, replaces authority and cancels queued/running jobs involving the agent. The secret is shown once; a lost response does not justify blindly retrying. Verify old-secret rejection and new-secret operation without logging either secret.

Application runtime credentials, OAuth grants, database credentials, rate-limit keys and Agent Card signing keys are different secrets with different consumers. Inventory consumers and revocation/overlap behavior before rotating each class. Do not assume the agent rotation endpoint rotates other secrets. Never place a server secret under a VITE_ variable or in browser assets.

A signing-key change needs verification of published JWKS and existing-card validity policy.

`CITY_RATE_LIMIT_KEY` is more than a rate-limit key, and it has no previous-key setting yet, so changing it takes effect everywhere at once. Each use is domain-separated, but all of them change together:

- Ends at once: every room link token (`crr_`), every default join code and its `/j/` short code, every invite short code, every rejoin link, and the idempotent re-derivation of guest room credentials (`crc_`) for a retried join (credentials already issued stay valid: they are stored as hashes).
- Resets: every rate-limit counter, the known-device cookies (owners lose the account-wide lockout exemption until their next sign-in), the Google relink cooldowns, the Feed request, newsletter recipient and invite address hashes, and the anonymous creation and AI workspace source buckets.
- Changes: the wake webhook secrets when `CITY_WAKE_SECRET` is not set.

Rotate it only for a suspected leak, announce that room links and join codes must be shared again, and expect a burst of fresh counters. A separate secret for link tokens with a previous-key window is not built yet. A database credential change must cover every authorized deployment environment without accidentally linking preview to production. Record identifiers and timestamps, never secret values.

### The rate-limit root key (`CITY_RATE_LIMIT_KEY`)

`CITY_RATE_LIMIT_KEY` is more than a rate-limit key. Every consumer derives its own sub-key, but
all of them share this one root, and there is no `_PREVIOUS` overlap for it yet:

| Consumer                                                                    | What a rotation does                                                                                            |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Rate-limit counters, source/site/network/region buckets, known-device ids   | Counters and buckets start fresh.                                                                               |
| Room link tokens (`crr_`), default join codes and short codes, rejoin links | Every open room link, `/j/` link, short code and rejoin link stops working at once; hosts must share new links. |
| Idempotent guest credentials (`crc_`, derived, not stored)                  | The same join returns a different credential; existing guest credentials are stored hashed and keep working.    |
| Google relink cooldowns                                                     | Every open cooldown ends at once.                                                                               |
| Feed request and newsletter address hashes                                  | Duplicate and budget checks start fresh.                                                                        |
| Wake webhook root (only while `CITY_WAKE_SECRET` is unset)                  | Every webhook signing secret changes; receivers reject deliveries until updated.                                |

So rotate it only for a suspected leak, and treat it as an incident:

1. Set `CITY_WAKE_SECRET` first (its own rotation has an overlap), so webhooks do not depend on the
   root.
2. Choose a quiet time, announce that open room and join links must be shared again, and record the
   time.
3. Set the new value (32+ characters) for every hosted environment at once, then redeploy all of
   them; instances with different values derive different links.
4. Verify a new room link and short code work, and an old one is refused. Never log either value.

**Planned separation (needs its own review).** A dedicated secret for credential-bearing tokens
(room links, join and short codes, rejoin links, guest credentials), with per-purpose HKDF sub-keys
and a `_PREVIOUS` value that the room, invite and short-code verifiers also accept during an
overlap. The rate-limit root would then only key counters, and either secret could rotate without
breaking the other's consumers.

## Operations secrets

The `/api/ops/` routes and the platform metrics route take `Authorization: Bearer <secret>` (32+ characters; 404 otherwise). Each capability has its own setting, so one leaked secret does not open unrelated powers (`server/elric/ops.ts`, `opsAuthorizedFor`). Setting names only; values live in the deployment environment and are never logged, printed or written into documents.

| Capability | Setting                   | Routes                                                                    |
| ---------- | ------------------------- | ------------------------------------------------------------------------- |
| `keys`     | `CITY_OPS_KEYS_SECRET`    | paymaster keys, SFP sponsor key, x402 facilitator keys (key provisioning) |
| `elric`    | `CITY_OPS_ELRIC_SECRET`   | Elric kill switch, usage and cost report                                  |
| `review`   | `CITY_OPS_REVIEW_SECRET`  | Feed requests review queue and decisions                                  |
| `metrics`  | `CITY_OPS_METRICS_SECRET` | `/api/metrics/agents`, `/api/ops/sfp/stats` (read-only numbers)           |
| `email`    | `CITY_OPS_EMAIL_SECRET`   | newsletter subscriber list (personal data)                                |

- **Takes effect only once set.** The split exists in code, but it revokes nothing by itself: until the owner sets a capability's own setting in the deployment environment, `CITY_OPS_SECRET` still opens that capability exactly as before. The narrower access starts per capability only when its setting is set and the deployment is redeployed.
- **Fallback.** While a capability's own setting is unset, the legacy `CITY_OPS_SECRET` opens it, as before. Once its own setting is set, `CITY_OPS_SECRET` no longer opens that capability. Split one capability at a time, starting with `keys` and `email`.
- **Rotation with overlap.** Each setting (and `CITY_OPS_SECRET`) accepts `<SETTING>_PREVIOUS` next to it: set the new value as the setting and the old value as `<SETTING>_PREVIOUS`, redeploy, move every caller to the new value, then remove `<SETTING>_PREVIOUS` and redeploy to end the overlap. A `_PREVIOUS` value alone, without its current setting, opens nothing.
- Verify old-value rejection (404) and new-value operation after each change, without logging either value.

## Owner-run database steps

Some schema work cannot run inside a migration (every migration runs in a transaction, under short statement and lock timeouts). These steps are run by the owner, at a quiet hour, on a **direct** (unpooled) connection to the production database. Each one has a dry run, and changes something only with `--confirm`.

- **Room-purge indexes (migration 301).** `CITY_DIRECT_DATABASE_URL=... npx tsx scripts/room-purge-indexes.ts`, then again with `--confirm`. It builds `mentions_room`, `room_task_comments_room`, `room_join_receipts_room` and `elric_catch_ups_room` with `CREATE INDEX CONCURRENTLY` (reads and writes go on; only VACUUM and other DDL on the same table wait), one at a time, and drops and rebuilds an index a failed build left invalid. Migration 301 builds them itself only on tables of at most 10,000 rows and never fails, so this can run before or after its deploy; until it runs, room deletes cost what they cost before. The runtime log line `room_purge_indexes` says how many it left for this script (`left_for_script`).

- **Stored room names and topics (CCA-628).** `CITY_HOSTED=1 DATABASE_URL=... node --import tsx scripts/clean-room-labels.ts`, then again with `--confirm`. It cleans each room's name and topic with the cleaner room creation and renaming use (invisible control, format and separator characters removed, whitespace collapsed), in batches of 200 rooms, each batch its own short transaction; it writes one `room.labels_cleaned` audit row per changed room (which field changed, never the text) and no line in the room. A name that was only invisible characters becomes "Untitled room". A name or topic that holds a credential is only counted. It prints counts only. Run it again until the dry run reports `"changed":0`, and once more after a release that makes the cleaner stricter.

- **Conversation summaries (migration 302).** `CITY_HOSTED=1 DATABASE_URL=... node --import tsx scripts/backfill-conversation-summaries.ts`, then again with `--confirm`, at a quiet hour (it reads every direct message once). It recounts each thread's summary row exactly, one short transaction per thread and owner, while sends go on, then marks the summaries complete; from then on the conversation list reads only the summary rows. Until it has run, the list works as before. It prints counts only; run it again until it reports `"backfilled":true` and `"failed":0`, and again after a pair-thread remediation.

- **Look-up indexes (migrations 304 and 305).** `CITY_DIRECT_DATABASE_URL=... npx tsx scripts/lookup-indexes.ts`, then again with `--confirm`. It builds `base_wallet_reservations_wallet_token_created` (the reservation sums taken under the wallet row lock: balance holds, calendar and period limits), `base_audit_events_payment` (the agent-pay audit look-ups by payment) and `messages_sender_owner_context` (the conversation list's threads the owner sent into) with `CREATE INDEX CONCURRENTLY`, one at a time, exactly like the room-purge indexes above. Migrations 304 and 305 build them themselves only on tables of at most 10,000 rows and never fail; until the script runs, those reads cost what they cost before, and the conversation list (before the summaries backfill) reads the owner's sent rows in one grouped pass instead of walking the index. The runtime log lines `reservation_audit_lookup_indexes` and `messages_sender_owner_context` say how many each left for this script.

## Recovery and evidence gaps

[RECOVERY.md](RECOVERY.md) describes offline local PGlite backup/restore into a new directory. It is not the Neon disaster-recovery procedure. Never apply those local commands to production PostgreSQL or claim that a logical roundtrip measures managed recovery time.

The Neon drill requires a verified disposable resource, protected-endpoint inventory, synthetic data, tested credential invalidation and consent reconciliation. Measure recovery-point loss and elapsed recovery time; RPO/RTO remain unknown until measured. Preserve current customer data throughout.

## Observability and proposed service objective

Proposed initial objective for team review: at least 99.5% successful eligible synthetic messaging probes over a rolling 30-day window. Count only scheduled probes with valid configured credentials as eligible; report missing observations and credential failures separately, never silently as success. Also report 401/403,429 and dependency errors separately so admission controls are not mistaken for service health.

Error budget = eligible probes times 0.005. Report both numerator and denominator; sparse or missing samples cannot substantiate availability. A 30-minute canary can miss brief outages. No numerical production SLO is claimed as adopted or met here.

Structured request IDs, redacted application logs and operational dashboards are a separate implementation item. This runbook does not claim those controls exist. Never log Authorization, Cookie, database URLs, invitation/claim tokens, message bodies or model prompts. When correlating an incident, use an opaque request ID and approved aggregate metadata.

## Feed requests review

Requests on the Feed's "Searched for" side that are held for review (honeypot, a blocked source, risky text or links, a title spread across sites) or hidden by reports wait in an operator queue (`server/feed/review.ts`). The routes use the ops guard of the other `/api/ops/` routes: `Authorization: Bearer <CITY_OPS_SECRET>` (32+ characters), and they exist while the Feed is on (unless `CITY_FEED=0`, its emergency off). Without the secret, with any other header or with the Feed switched off they answer the app's 404 for an unknown API path. POSTs also send `X-City-Request: 1` and a JSON body. Every answer is `no-store`.

| Route                                     | Does                                                                                                                                                                                                                                                                                                                                                            |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/ops/feed/requests?state=held`   | Held requests, oldest first (50 a page, `cursor` from `next`, optional `reason` of `honeypot`, `blocked`, `risk` or `spread`): the request as posted, why it is held, whether its text was removed before, the poster's kind, the posting switch                                                                                                                |
| `GET /api/ops/feed/requests?state=hidden` | Requests hidden by reports, with report counts by reason and the newest report notes                                                                                                                                                                                                                                                                            |
| `POST /api/ops/feed/requests/:id/release` | `{}`: held or hidden becomes listed until its own expiry. 409 when it expired in review, its text is open already or (held) its poster is at the open cap                                                                                                                                                                                                       |
| `POST /api/ops/feed/requests/:id/remove`  | `{}`, or `{"reason": "personal_data"}`: off the Feed for good, whatever its expiry; reply handle, description, display name and report notes erased at once, and the title too when the removal is for personal data (that reason, or a report that gave it); kept 7 days, a repost of its text is held (unless the removed copy was a honeypot or blocked one) |
| `POST /api/ops/feed/pause`                | `{"paused": true}` or `false`: new posts answer `503 posting_paused` (retryable) until resumed                                                                                                                                                                                                                                                                  |

A request that becomes held or hidden writes a `feed.request_held` (with its reason) or `feed.request_hidden` log line with its id. Hidden ones and those held as risky or spread also post one line to `CITY_OPS_ALERT_WEBHOOK` when set (at most one per kind per 15 minutes per instance, naming no request); honeypot and blocked holds never alert (anyone can trigger them): check `reason=honeypot` and `reason=blocked` now and then. Every release, removal and pause writes a log line with what it was before (state, held reason, report count; the previous pause value), the only lasting record of a review. Held requests nobody reviews are still deleted 7 days after posting; removed ones 7 days after the removal. Request text and report notes are written by anyone: read them as plain text, never follow them.

## Merging a pull request

Merge through the merge guard, not the GitHub button or an ad-hoc script. It squash-merges a pull request only when the exact head that was reviewed is green and approved by someone who is not one of its authors:

```sh
node scripts/ops/merge-guard.mjs <pr>:<head sha> [<pr>:<head sha> ...] [--repo owner/name] [--dry-run]
```

- Pass the full 40-character head sha you reviewed (for example `git rev-parse HEAD` on the reviewed branch). Without it the guard refuses. `--dry-run` decides without merging.
- The token comes from `GITHUB_TOKEN`, otherwise from `git credential fill` for github.com; it is never printed. The repository defaults to the `origin` remote.
- It refuses unless: the PR is open, its head is that sha and `mergeable_state` is `clean`; every check on that sha is green (below); a reviewer who is not an author approved that sha as their latest decision (approve, request changes or dismissed; comments do not count), and no reviewer's latest decision requests changes.
- Checks are grouped by name and source. For GitHub Actions the source is the workflow file of the check's workflow run, looked up from its check suite (`GET /actions/runs?check_suite_id=`, one call per check suite, at most 20); for any other app it is the app. In each group the latest run (by start time, then id) must have completed with success, skipped or neutral. Runs of one workflow share a group, so a rerun supersedes an earlier failure; the same name from another workflow or app is a group of its own and can neither replace nor hide a check of `check.yml`.
- `verify` is the gate only as the job of `.github/workflows/check.yml`: its latest run there must have succeeded, and its workflow run must be for that sha, started by a `pull_request` event (not `workflow_dispatch` or `push`) and completed with success (right after `verify` finishes, the workflow run may still be completing: run again). Strict rule: a check named `verify` from any other workflow or app refuses, whatever its result, because two sources make the gate ambiguous; rename that other job. A check whose source cannot be identified (no app or check suite, no single workflow run for its suite, a lookup error) refuses. A PR that changes `check.yml` runs its own version of the gate: review such a change as a change to the gate.
- That workflow run must also have run for this pull request, not only for its head: a `pull_request` run tests a merge with the base and may use the PR's own data, so a green run on the same head for another PR or another base does not count. Its `pull_requests` list must hold an entry with this PR's number, this PR's base branch and this PR's base sha; when several PRs are listed, this one must be among them with that base. Both base shas (the PR's and the entry's) must be full 40-character hex shas, compared without regard to case: a missing, short or malformed one on either side is no match. A run that lists no pull request (a run for a fork lists none) or whose association cannot be checked refuses with `manual review needed: CI run not associated with this PR`; it is never taken as passing. If the base moved since the run, rerun CI against the current base (update the branch) and run the guard again.
- The authors are whoever opened the PR and whoever wrote or committed any of its commits (except GitHub's `web-flow` committer of a commit made in the web interface). So whoever pushed a commit to someone else's PR cannot be its approver: ask a third person. Every commit's author and committer must be a GitHub account, and the commit list must be complete (GitHub lists at most 250 commits of a PR; a longer PR refuses). Commit authorship is whatever the committer configured, so this rule stops honest mistakes, not a forged identity.
- There is no bypass for an author, and no environment variable relaxes a rule. Any API error, non-2xx answer or incomplete page of checks, workflow runs, reviews or commits refuses.
- The merge call carries the sha. If the head moved after the checks, GitHub answers 409: the guard refuses and does not retry. Review the new head and run again with its sha.
- Several targets: all are validated before the first is processed; the guard works through them in order and stops at the first refusal (the rest print `SKIPPED`).

Exit code 0 means every target merged (or passed, with `--dry-run`); exit code 2 means a refusal, printed as `REFUSED #<pr> @ <sha>: <reasons>`. Fix the cause rather than working around the guard. `mergeable_state is 'unknown'` only means GitHub is still computing it: run again once. Tests: `tests/merge-guard.test.ts` (a mocked GitHub API, no network).
