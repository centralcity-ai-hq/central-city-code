# Operations runbook

This is a procedure, not evidence that a deployment, recovery drill or service objective has passed. Confirm the running commit and current configuration before acting. Never copy production records into a test environment.

## Release record

Use one release owner at a time. Record application SHA, migration versions, reviewed PR, exact-head checks, deployment ID, environment, release time and previous known-good deployment. Environment values and credentials do not belong in the record. A ready preview does not mean the production alias changed.

Before release:

1. Confirm exact-head review and required CI; inspect failures rather than treating a rerun as proof a defect was fixed.
2. Run the relevant tests plus `pnpm build`, `pnpm check:boundaries` and `pnpm format:check`. Use the repository-pinned package manager. Changes to authentication, storage or routing require their focused regression tests.
3. Inspect migration compatibility. Do not edit an applied migration. A build that does not recognize an already-applied version can refuse startup; an older code deployment is not automatically a safe rollback.
4. Verify environment identity and database isolation. A protected preview can still write production data if it shares credentials. Do not send synthetic load to a preview until its database is independently verified as disposable.
5. Deploy through the configured release owner/workflow. Verify the resulting deployment ID and SHA, then verify the production alias separately. This document does not change deployment protection or authorize public release of internal records.

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

For a code-only compatible rollback, use the existing deployment controls to select a reviewed known-good deployment and confirm its alias/commit after promotion. Do not revert database contents as an incidental rollback step. A restore can resurrect credentials, grants, invitations or stale work; it is a separate recovery operation needing an isolated drill and authority reconciliation.

After rollback, repeat the affected authenticated flow, public doctor and negative authorization checks. Preserve the failed release evidence.

## Credential rotation

Use the owner credential-rotation action described in [CREDENTIALS.md](CREDENTIALS.md). It preserves agent identity, replaces authority and cancels queued/running jobs involving the agent. The secret is shown once; a lost response does not justify blindly retrying. Verify old-secret rejection and new-secret operation without logging either secret.

Application runtime credentials, OAuth grants, database credentials, rate-limit keys and Agent Card signing keys are different secrets with different consumers. Inventory consumers and revocation/overlap behavior before rotating each class. Do not assume the agent rotation endpoint rotates other secrets. Never place a server secret under a VITE_ variable or in browser assets.

A signing-key change needs verification of published JWKS and existing-card validity policy. A rate-limit-key change may change counter identity. A database credential change must cover every authorized deployment environment without accidentally linking preview to production. Record identifiers and timestamps, never secret values.

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
