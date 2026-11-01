# Contributing to Central City

Thank you for helping build Central City. This guide covers development setup, checks, pull
request rules, licensing of contributions and how AI agents may contribute.

By participating you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md). Report
security problems privately as described in [SECURITY.md](SECURITY.md), never in a public
issue or pull request.

## Development setup

Requirements:

- **Node.js 22.18.0 or later** (CI uses Node 22.23.3).
- **pnpm 11** through Corepack. The exact version is pinned in `package.json`
  (`packageManager`), so you do not need a global pnpm install.
- Git, and for browser tests either Microsoft Edge (Windows default) or Playwright Chromium.

```sh
corepack enable            # once per machine; or prefix commands with `corepack pnpm`
pnpm install --frozen-lockfile
pnpm build
pnpm start                 # http://127.0.0.1:4310, loopback only
```

For iterative development run `pnpm dev:server` and `pnpm dev` in two terminals; Vite serves
the frontend on `127.0.0.1:5173` and proxies the API. Local data lives in `.local/data`, which
is ignored by Git. See [README.md](README.md) for the full local flow and
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the code layout.

Dependency versions are exact and locked. Dependency install scripts are denied unless listed
in `pnpm-workspace.yaml`. Do not add dependencies casually: explain the need in the pull
request, prefer small, maintained packages, and check that the licence is compatible with
Apache-2.0 (see [docs/THIRD_PARTY_LICENSES.md](docs/THIRD_PARTY_LICENSES.md)).

## Tests and checks

CI runs the following on every push and pull request; run the relevant ones locally first:

```sh
pnpm build                 # type-check and production frontend build
pnpm check:boundaries      # keeps private/operating material and key patterns out
pnpm test                  # Node test suite (tests/*.test.ts)
pnpm format:check          # Prettier; `pnpm format` fixes formatting
pnpm test:browser          # Playwright end-to-end tests (e2e/)
node scripts/check-secrets.mjs   # pinned Gitleaks over history + files (see docs/CI.md)
```

The secret scan and a few integration tests need the checksum-pinned Gitleaks binary
(`GITLEAKS_BIN`); without it they skip locally and CI runs them. Use only synthetic data,
accounts and credentials in tests and fixtures. Add or update tests with every behaviour
change, especially around authorization, credentials, OAuth/MCP and workspace isolation.

Run `pnpm smoke:bundle` before merging server changes: it builds the single-file server bundle
and sends real requests through it on an in-memory database, which catches import cycles that
only exist in the bundle.

## Pull requests

1. Open an issue first for larger changes or anything touching security boundaries, so the
   approach can be agreed before you invest time.
2. Work on a branch from current `main`. Keep each pull request focused on one problem.
3. Fill in the pull request template:
   - **Problem** being solved and **change** made;
   - **Tests** added or run, with exact commands and outcomes;
   - **Failed or skipped checks**, with the reason and environment;
   - **Risks**, compatibility notes and follow-ups.
4. Never commit credentials, tokens, databases, backups, model weights, `.env` files or
   personal data. If you commit one by mistake, tell the maintainers; rotating it matters more
   than rewriting history.
5. Keep documentation truthful: do not describe capabilities, conformance or test results
   that were not actually implemented or observed.
6. `main` is protected. Changes merge through a reviewed pull request with passing CI.
   Maintainers may ask for changes, split a pull request or decline it with a reason.

## Licensing of contributions

Central City is licensed under the [Apache License 2.0](LICENSE). There is **no CLA**.
Contributions are accepted on an **inbound = outbound** basis: as stated in section 5 of the
Apache License, any contribution you intentionally submit is licensed under Apache-2.0,
without additional terms.

Every commit must carry a **Developer Certificate of Origin** sign-off
([developercertificate.org](https://developercertificate.org/)), certifying that you have the
right to submit it under the project licence:

```sh
git commit -s -m "Describe the change"
# adds: Signed-off-by: Your Name <you@example.com>
```

Use a name and an email address you are comfortable publishing; GitHub's `noreply` address is
fine. Do not submit code copied from sources whose licence is incompatible with Apache-2.0.

## Contributions by AI agents

AI coding agents are welcome contributors, under these rules:

- **A human is accountable.** Every AI-assisted pull request is opened by, or on behalf of, a
  named person who has reviewed the change and provides the DCO sign-off. An AI cannot
  certify the DCO by itself.
- **Mention assistance** in the pull request description, so reviewers know what to check.
  Naming the tool in a commit trailer is optional.
- **Follow the same rules as human contributors:** this guide, [SECURITY.md](SECURITY.md)
  and the [Code of Conduct](CODE_OF_CONDUCT.md). Use synthetic, low-entropy test data.
- **Report evidence honestly.** Record the exact commit, commands and results; list skipped
  or failed checks. Never claim tests ran that did not run, and never fabricate credentials,
  data or external results.
- **Stay in scope.** Do not weaken authorization, secret or boundary checks, do not
  force-push shared branches, and do not overwrite other contributors' work.
- Maintainers may close high-volume, unreviewed or low-quality automated submissions.

## Questions

Use GitHub Discussions or issues for questions and ideas. See [GOVERNANCE.md](GOVERNANCE.md)
for how decisions are made.
