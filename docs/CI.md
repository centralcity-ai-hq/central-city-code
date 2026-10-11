## Current CI cost policy

Test locally before pushing. Open PRs as drafts: classification, full secret scanning and scanner safeguards run, while application/portability tests are deferred. Mark ready only when local verification is complete; this triggers the full `unit` and `browser` jobs. Bundle subsequent fixes. Allow at most one rerun for a known infrastructure flake. Windows/macOS portability runs only on main pushes after integration.

The private repository may route trusted same-repository PRs and main pushes to a self-hosted runner named by `APP_CI_RUNNER`. Public repositories and fork PRs always use GitHub-hosted Ubuntu regardless of the variable. Each `unit` and `browser` shard has a 20-minute timeout on hosted runners (35 on `cc-mac`); an offline Mac queues work. To fall back, an administrator runs `gh variable set APP_CI_RUNNER --body ubuntu-24.04`. Before public release, restore that value AND remove the self-hosted runner. Repository collaborators who can modify trusted PR code can execute code on that runner; keep its account free of unrelated credentials.

Gitleaks and its safeguard tests stay on hosted Linux, including drafts. Application tests skip their redundant scanner-specific cases. Playwright installs Linux system dependencies only on Linux. Production canary runs every two hours and retains its successful-production-deployment trigger. Savings are an objective, not a measured result yet; retain the ten-green-main stability gate.

## Parallel jobs (28 September)

The former single `application` job (install, build, boundaries, all Node tests, formatting, all browser scenarios in sequence: 17–22 min, and up to 25.8 min, over its 25-minute timeout) is split into two matrix jobs that run side by side. They run the same checks; only where they run changes.

| Job       | Legs                            | Runs                                                                                                                     |
| --------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `unit`    | 6 (`shard: [1, 2, 3, 4, 5, 6]`) | install, build, `pnpm test:shard <n>/6`                                                                                  |
| `browser` | 4 (`shard: [1, 2, 3, 4]`)       | install, build, leg 1 also `check:boundaries` and `format:check`, Playwright Chromium, `pnpm test:browser --shard=<n>/4` |

- **Unit shards.** `scripts/test-shard.mjs` assigns every `tests/*.test.ts` file to exactly one shard, longest first, by the per-file seconds in its `WEIGHTS` table, then runs `pnpm test:files <files>`: the same `tsx --test --test-concurrency=1 --no-wasm-code-gc` command as `pnpm test`. A file missing from the table counts as 10 s, so a new test always runs. Refresh `WEIGHTS` when the shards drift apart: time each file with `pnpm test:files <file>`. `pnpm test` still runs everything locally and on Windows portability.
- **Browser shards.** Playwright's own `--shard` splits the spec files; `playwright.config.ts` is unchanged.
- **Caches.** `setup-node` restores the pnpm store (keyed on `pnpm-lock.yaml`; `pnpm/action-setup` now runs first so pnpm is on the path). `actions/cache` v5.1.0 (SHA-pinned) keeps `~/.cache/ms-playwright` per OS, architecture and Playwright version; on a hit, Linux installs only the system libraries (`playwright install-deps chromium`). A cache miss falls back to the full install, so a cache can make a run faster but never skip a check.
- **Failures.** Both matrices use `fail-fast: false`, so every failing shard is reported. `verify` needs `changes`, `secrets`, `docs`, `unit`, `browser`, `postgres-races` and `portability`; a matrix job's result is `success` only when every leg succeeded. For documentation-only PRs and drafts `verify` requires `unit`, `browser` and `portability` to be `skipped`, exactly as before — and, for non-draft documentation PRs, `docs` to be `success` (for drafts and code PRs, `skipped`).
- **Guard.** The `changes` job's inline guard fails the run if the job list changes without the guard; any job other than `changes`, `secrets`, `docs` and `verify` loses its `needs.changes.outputs.code == 'true'` gate, or the `docs` job loses its docs-only, non-draft gate or its cheap checks; `verify` stops needing, reading or requiring any job; a shard list disagrees with its shard count or with `UNIT_SHARDS`; a test file would be in no shard; `continue-on-error` appears on a shard; or build, boundaries, formatting or the install disappear. `tests/ci-workflow.test.ts` runs that guard against the real workflow and seventeen broken copies.
- **Cost.** Each job pays its own setup (about 30–60 s) and GitHub rounds each job up to a whole minute, so a run bills a few more minutes than the old single job; the wall time drops to the slowest shard. Measured numbers are in the PR that introduced this split.

Historical evidence and earlier policy below describe the previous workflow and do not override this section.

# Continuous integration and secret scanning

The `Verify application` workflow runs on pushes to main and pull requests with read-only repository permissions. It scans the full fetched Git history and current repository files in an independent job. Code runs also execute the build, file-boundary checks, Node tests, formatting and browser scenarios; dependency installation may overlap scanning. Failed installation, checksum/version checks, scanner errors and unreadable reports fail the job.

A second `portability` job runs `pnpm install --frozen-lockfile`, `pnpm build` and `pnpm test` on `windows-2025` for every main push and code-changing pull request and on `macos-15` only for pushes to `main` (the matrix is computed from the event with `fromJSON`). It uses `fail-fast: false` so one platform's failure does not hide the other's, and a 20-minute timeout. It does not repeat the secret scan, boundary check, formatting or browser scenarios, which stay on Ubuntu. The test step sets `CI` to an empty string so `tests/secret-scan.test.ts` skips honestly instead of requiring `GITLEAKS_BIN` there. On Windows, `TEMP`/`TMP` point at the runner's long-form temp directory so that an 8.3 short-name profile path is not mistaken for a filesystem alias by the data-lock checks.

GitHub bills macOS runner minutes at 10x and Windows at 2x the Linux rate for private repositories; public repositories on standard runners are not billed. Restricting macOS to pushes to `main` removes that leg from pull requests and other branch pushes.

The workflow-level `concurrency` group cancels an in-progress run when a newer one starts for the same branch or pull request ref. Each `main` run gets its own group (keyed by run ID), so runs on `main` are never canceled or superseded.

## Documentation-only pull requests

An unconditional `secrets` job scans history and current files even for documentation-only PRs. A small `changes` job compares the exact PR base and head with a merge-base diff. Files under `integrations/` and `docs/DISTRIBUTION.md` always count as code because distribution tests consume them; so do `protocol/` (the schema and leak checks read every spec there) and `public/` (served files such as `downtown.md`). Inline regression checks exercise the same classifier before it processes the diff. A PR changing only other `*.md` or files under `docs/` skips the expensive `unit`, `browser` and `portability` jobs; code changes run them. Docs-only, non-draft PRs still run a small `docs` job: `tests/internal-references.test.ts`, `tests/public-docs.test.ts`, `tests/public-copy.test.ts` and `tests/public-docs-private.test.ts`, so a broken reference or a private name in a published file cannot merge green. Drafts defer even these. Deleted and renamed files are checked as paths without rename detection so moving code into docs cannot hide its deletion. A diff error fails classification. Main pushes keep full verification; other branch pushes do not trigger this workflow, avoiding duplicate PR runs.

The workflow itself is not filtered with `paths-ignore`: a filtered-out workflow can leave its required check pending. An always-running `verify` result job fails if classification or secret scanning failed, or any required unit, browser or platform job did not succeed, and succeeds for a correctly classified documentation-only PR. Check the repository's required-check behavior on the first such PR; do not claim that local YAML validation proves GitHub branch protection behavior. The classification job is a dependency of the expensive jobs; its failure is also explicitly propagated to `verify`.

## Runtime and artifact pins

The runner is explicitly `ubuntu-24.04`, avoiding an implicit OS-family change when `ubuntu-latest` moves. This image still receives upstream updates; it is not an immutable VM digest. [GitHub runner documentation](https://github.com/actions/runner-images#available-images).

Existing checkout/setup-node actions remain SHA-pinned. The application runtime is pinned to **22.23.3** in both jobs as a candidate mitigation for the intermittent Node 24.21.0 V8 failure described below. This is distinct from the runtime used internally by JavaScript actions. Pinned pnpm 11.19.0 requires Node >=22.13; the application declares >=22.18.0; 22.23.3 satisfies both. `pnpm/action-setup` is now **v6.1.0**, commit `ea17c68df8912ef543352723c149a84f56e3d413`. Its exact manifest uses **Node 24**, addressing the previous Node 20 action warning. Package-manager version remains **pnpm 11.19.0**. The annotated tag was resolved to its commit using `git ls-remote`; the workflow uses the commit rather than the tag object or movable major tag. [Official release](https://github.com/pnpm/action-setup/releases/tag/v6.1.0) · [Pinned action manifest](https://github.com/pnpm/action-setup/blob/ea17c68df8912ef543352723c149a84f56e3d413/action.yml).

The standalone **Gitleaks 8.30.1** CLI uses the full upstream rules through `.gitleaks.toml` with `extend.useDefault = true`. There are no project rule substitutions, blanket source/test allowlists or accepted-finding baselines. This is the open-source CLI, not a paid service or license-gated action. Upstream describes Gitleaks as feature complete with future security patches; reassess maintenance and successor options when refreshing the pin. [Release](https://github.com/gitleaks/gitleaks/releases/tag/v8.30.1) · [Project and MIT license](https://github.com/gitleaks/gitleaks) · [Published checksums](https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/gitleaks_8.30.1_checksums.txt).

Archive hashes verified against the official release on 25 September 2026:

| Archive                            | SHA-256                                                            |
| ---------------------------------- | ------------------------------------------------------------------ |
| `gitleaks_8.30.1_linux_x64.tar.gz` | `551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb` |
| `gitleaks_8.30.1_windows_x64.zip`  | `d29144deff3a68aa93ced33dddf84b7fdc26070add4aa0f4513094c8332afc4e` |

CI downloads the exact Linux release over HTTPS, checks the pinned SHA-256 before extraction, and exports its executable path as `GITLEAKS_BIN`. The wrapper verifies the exact binary version. A pin update requires official release review, a newly verified checksum, synthetic tests and repository scan. Checksums establish integrity against a reviewed artifact; they do not prove an upstream publisher is uncompromised.

## Stability evidence and release gate

An exact runtime pin makes failures reproducible enough to investigate; it is **not a verified mitigation** for the observed V8 crash. Run 36270205211, job `108482590253`, used Node **24.21.0** on Linux and failed with `jit_page_->allocations_.erase(addr) == 1` and `UnregisterWasmAllocation` while running `tests/assistant-access.test.ts`. Run 36270203932 passed on the same commit. This establishes an intermittent native failure, not its root cause or a fix.

### Root cause and test-command mitigation (28 September)

The crash is a known V8 bug in Node 24.21.0 (V8 13.6), tracked as [nodejs/node#66366](https://github.com/nodejs/node/issues/66366) and fixed upstream in V8 `9b8ca54d5a` ("[wasm] Fix lookup of wrappers marked is_dying", crbug 409379692). No 24.x release has the backport yet. `Runtime_TierUpWasmToJSWrapper` takes a reference to a cached Wasm-to-JS import wrapper that Wasm code GC has already marked as dying; the wrapper is then freed twice. All five local crashes captured on 28 September had the same native stack: `Runtime_TierUpWasmToJSWrapper` → `~WasmCodeRefScope` → `WasmEngine::FreeDeadCode` → `WasmImportWrapperCache::Free` → `ThreadIsolation::UnregisterWasmAllocation`, failing `Check failed: end > addr` (the CI form is `jit_page_->allocations_.erase(addr) == 1`). Test processes run Wasm from PGlite (each in-memory test application instantiates one) and from undici's llhttp (`fetch`). Import wrappers are shared across modules, so each discarded PGlite instance can leave dying wrappers that a later tier-up races with.

Because the child process aborts, `node --test` reports the whole file as failed, with no failing subtest (for example `✖ tests/autonomous-creation.test.ts (14828ms)`). The crash lands on whichever PGlite-using file is running at the time. The captured stacks came from `a2a-transport` (twice), `mcp-open-invite`, `hosted-staging` and `cross-owner`. The file-level failures reported on 27 and 28 September in `autonomous-creation`, `rooms-security` and `rooms` have the same signature: the file aborts partway through, with no failing subtest. Each of those files passes alone and on a rerun. Test logic, ports, temporary directories and environment variables are not involved: each file runs in its own process.

`pnpm test` and the new `pnpm test:files <files…>` pass `--no-wasm-code-gc` to every test process. Wasm code GC is the other side of the race; in the upstream reproduction, this flag took CHECK failures and SIGSEGVs from 16 in 40 jobs to 0 in 20. Test processes are short-lived, so keeping dead Wasm code costs nothing measurable. The flag cannot go in `NODE_OPTIONS` (Node rejects it there), so run subsets with `pnpm test:files`, not bare `tsx --test`. CI already runs Node 22.23.3, which is unaffected, so the flag only changes behavior on local Node 24.x. Remove it once the local runtime has the V8 fix (a 24.x release with the backport, or Node 26).

Local evidence, 28 September, Node 24.21.0 on macOS arm64: five full-suite runs with the flag and five concurrent control runs without it. All passed (607/607 each), and the paired runs took the same time (628–1098 s, within 3 s of each other). The control also produced no crashes this time, so these runs show the flag is safe and free, not that it works. The evidence that it works is the upstream measurement above, together with our five crash stacks, which match the upstream bug exactly. Earlier, 13 looped runs of the implicated file combinations with `--test-reporter=tap` were also clean; each earlier crash was captured in a full-suite log from another session. If a file fails with no failing subtest, look for `Fatal error` / `Check failed` in the process output before treating it as a test failure.

Keep native runtime failures separate from application assertions, scanner findings, install failures and canceled runs. In particular, main run 36298597829 failed at **Scan repository history and current files**, before the test step. It must not be counted as a V8 crash. A snapshot of the latest 25 completed main push workflows on 27 September contained 24 successes and this one failure; that is a workflow outcome sample, not a measured V8 crash rate across all branches or attempts.

The stability gate is **10 consecutive successful main push workflows after the selected mitigation lands**. Count full workflows, including every required platform job, against their exact commit SHA. Pending or canceled runs are not successes; a failure resets the streak. Retrying a failed attempt does not erase that attempt from the evidence. Historical green runs before a mitigation do not establish its effectiveness. The runtime pin merged at `6841a1b1c93ecffa3a6b670f5fc68d88cdb6bbc8`; its first main run was still pending at the baseline measurement.

Before changing Node, check compatibility with the pinned package manager, dependencies and all three operating systems, then run the full suite on the candidate runtime. Do not add blanket retries or swallow assertion failures. If a narrowly targeted native-crash retry is introduced later, retain the failed attempt and bound the retry; it remains a mitigation, not proof of root-cause resolution. This change selects Node 22.23.3 for both application jobs; it introduces no retry policy. Linux and macOS verification and the ten-run main gate remain outstanding.

### Local candidate verification

On Windows, Node 22.23.3 passed `pnpm build` and `pnpm test` against application commit `e417d1bbb21c96ffaf435681e23ee0031a8f3e53` (the immediately preceding documentation revision). Test totals: **318 passed, 0 failed, 7 platform-specific skips, 1 existing TODO**, 326 total, about 476 seconds. Gitleaks was configured, so its tests were included. The TODO concerns the advertised server version; the skips concern POSIX/macOS filesystem semantics.

The [official Windows archive](https://nodejs.org/dist/v22.23.3/node-v22.23.3-win-x64.zip) matched SHA-256 `2b0ff57b049cda1bbcea2240eec20467018713c1efe1f7360c2681859b90ed71` from the official Node distribution checksum list before extraction. This used existing installed dependencies; a fresh frozen install, browser suite, Linux and macOS execution were not part of the local candidate run. A Windows pass is compatibility evidence, not proof the Linux native crash is resolved.

## Scan coverage and output

`node scripts/check-secrets.mjs` scans the application root; `--source PATH` supports isolated synthetic repositories. Shallow clones are refused. Checkout uses `fetch-depth: 0`; scanning includes all fetched refs with full history, including introduced-then-deleted secrets. Deleted/unfetched server refs and other repositories are outside that scope.

Current-file scanning snapshots tracked files plus nonignored untracked files. Tracked files remain included even if later ignored; missing working-tree files remain covered by history. Ignored local databases, credentials and dependencies are not copied. Do not force-add those files. Submodules fail closed and need separate review. File links are scanned as stored link text, without following their target.

The wrapper enables 100% redaction, disables inline `gitleaks:allow` suppression and uses an empty fingerprint-ignore file. Reports are temporary and removed on completion. Only phase counts and rule identifiers are printed; raw scanner output, finding values and source lines are not forwarded. No report artifact or SARIF file is uploaded. Investigate a failure locally with redacted scanner output; remove and rotate actual exposed credentials as appropriate. Deleting a value from the current file alone does not remove committed history.

Bounds: 20,000 current files; 50 MiB per snapshot file; two archive levels; five decoding levels; 120 seconds per scanner phase; 180 seconds per child process. Exceeded file/count bounds and execution errors fail closed. Encrypted/unsupported formats and patterns outside the pinned engine can evade detection. A pass supplements review and least privilege; it is not proof of absence. The separate file-boundary check protects internal operating material from application assets.

## Local verification

Download the exact platform archive, verify the SHA-256 above before extraction, and set the absolute executable path. The wrapper makes no automatic download or paid-service call.

```powershell
$env:GITLEAKS_BIN = 'C:\path\to\verified\gitleaks.exe'
node scripts/check-secrets.mjs
node --test tests/secret-scan.test.ts
```

The scanner tests create and remove synthetic repositories. They verify clean input, multiple provider patterns, nonexposure of fixture values, deleted history, untracked files despite inline suppression, and missing-executable failure. Synthetic strings are assembled at runtime and have no associated real accounts. The normal `pnpm test` includes these tests. They explicitly skip locally without `GITLEAKS_BIN`; absence fails in CI, which installs the binary first. Record skips honestly. No application package/dependency changes are required.

A subsequent remote run must pass before claiming this changed workflow, including the macOS and Windows legs, is verified. Local Windows evidence does not establish a new GitHub run or branch-protection policy; required checks and merge permissions remain separate administration.

### Mac execution budget

Run 36316814969 reached test 305 with continued passing output immediately before its 15-minute timeout. The private same-repository `cc-mac` application job therefore has a bounded 35-minute limit; hosted application jobs retain 15 minutes. This is a timeout correction, not a claim of faster tests or measured savings. Full-suite and browser completion still require a green run.
