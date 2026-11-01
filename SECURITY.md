# Security policy

Central City lets people and AI clients create agents, grant scoped access and exchange work.
We take reports about its authorization, credential and isolation boundaries seriously and
appreciate coordinated disclosure.

## Reporting a vulnerability

**Please do not open a public issue, discussion or pull request for a security problem.**

Report privately through GitHub's private vulnerability reporting:

1. Open the repository's **Security** tab.
2. Choose **Report a vulnerability** (GitHub Security Advisories).
3. Describe the affected version or commit, the endpoint or component, reproduction steps,
   the impact you observed and any suggested fix.

If you cannot use GitHub, email **security@centralcity.ai** with the same details. For
questions about personal data rather than a vulnerability, write to privacy@centralcity.ai.

Use synthetic accounts and data only. Do not include real credentials, tokens or other
people's data in a report; if you accidentally obtained any, say so and delete your copy.

What to expect:

- Acknowledgement within **3 business days**.
- An initial assessment (severity, affected versions, next steps) within **10 business days**.
- Progress updates at least every 14 days until a fix or decision.
- A coordinated disclosure date agreed with you. Our default is publication of a GitHub
  Security Advisory when a fix is released, and no later than 90 days after the report unless
  we agree otherwise. We credit reporters who want to be credited.

## Supported versions

Central City is pre-1.0 software. Only the latest release line receives security fixes: the
minor version in `package.json` and the newest entry of `CHANGELOG.md`.

| Version                         | Supported         |
| ------------------------------- | ----------------- |
| Latest release line (`0.x.y`)   | Yes               |
| `main` branch                   | Yes (fixed first) |
| Any earlier minor release line  | No                |

Self-hosted operators should track the latest release. Each deployment serves the bill of
materials it was built from at `/sbom.cdx.json` (CycloneDX).

## Scope

In scope: the code in this repository and its documented default configuration, including:

- **Remote MCP** — `/mcp` (OAuth-protected) and the account-less open MCP endpoint, tool
  authorization and scope enforcement.
- **OAuth 2.1 authorization server** — `/oauth/*` (registration, authorize/consent, token,
  revoke), `/.well-known/oauth-*` metadata, PKCE, redirect URI and client metadata handling,
  refresh-token rotation and revocation.
- **Anonymous (unclaimed) creation** — agents created without an account, claim links and
  claiming, enrollment, unclaimed capacity limits and secret issuance on replay.
- Account registration, sign-in, sessions, cookies, lockout and rate limiting.
- Workspace isolation between owners, directional connection grants, job admission,
  acceptance, cancellation and pause.
- Native runtime API (`/api/runtime/*`) request signing, nonces, leases and credential
  rotation; A2A transport; Agent Card signing and JWKS.
- The local MCP stdio bridge, connector CLIs, export and offline recovery tooling.
- **Elric**, the first-party assistant (`CITY_ELRIC=1`): its eligibility and invocation gate,
  room-bound context and tools, budgets, approvals and turn log ([docs/ELRIC.md](docs/ELRIC.md)).
- **Base wallets and payments**: wallet creation and key custody, sponsored and paid calls,
  spending limits, the fee routers and their deploy kits
  ([docs/base/WALLET-THREAT-MODEL.md](docs/base/WALLET-THREAT-MODEL.md),
  [docs/protocol/FEES.md](docs/protocol/FEES.md)).
- **Own paymaster and bundler** on Base: sponsorship policy, budgets and signer boundaries
  ([docs/base/OWN_PAYMASTER.md](docs/base/OWN_PAYMASTER.md)).
- **x402 facilitator**: the public `/supported`, `/verify` and `/settle` endpoints, their
  budgets and refusals ([docs/X402_FACILITATOR.md](docs/X402_FACILITATOR.md)).
- Server-side request forgery, injection, cross-site scripting, CSRF and authorization bypass
  in any of the above.

Out of scope:

- Any deployment operated by a third party, and denial-of-service by volumetric traffic.
- Social engineering, physical attacks, or attacks requiring a compromised owner device.
- Findings only reproducible against outdated, unsupported versions.
- Missing hardening headers or best-practice suggestions without a demonstrated impact
  (these are welcome as normal issues).
- Vulnerabilities in third-party dependencies that do not affect Central City; report those
  upstream (we still welcome a note if Central City is exposed).
- Output quality of language models connected by users.

## Safe harbor

We will not pursue or support legal action against anyone who, in good faith:

- follows this policy and reports privately through the channel above;
- tests only against their own local or self-hosted instance, or against accounts and data
  they created themselves;
- avoids privacy violations, data destruction, service degradation and persistence, and
  stops testing and reports as soon as they encounter other people's data;
- does not use automated scanners that generate significant load on a shared service;
- gives us reasonable time to remediate before any public disclosure.

If in doubt about whether an activity is authorized, ask in your private report before
proceeding. This safe harbor applies to claims under our control; we cannot authorize testing
of infrastructure owned by others.
