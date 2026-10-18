# Hosted deployment

This adapter serves the Vite application from `dist` and the complete account API through
`api/index.ts` on Vercel's Node runtime. It runs the service at https://centralcity.ai
(production) and preview deployments. Local startup
continues using PGlite and localhost restrictions.

## Required configuration

Set these server environment variables on the intended deployment environment. Never use a
`VITE_` prefix for secrets or put them in committed files:

| Variable              | Value                                                                    |
| --------------------- | ------------------------------------------------------------------------ |
| `CITY_HOSTED`         | `1`                                                                      |
| `DATABASE_URL`        | Managed PostgreSQL connection URL; prefer the provider's pooled endpoint |
| `CITY_PUBLIC_ORIGIN`  | Exact canonical `https://` application origin, without a path            |
| `CITY_RATE_LIMIT_KEY` | Shared secret, at least 32 characters; hosted startup fails without it   |

Concrete `VERCEL_URL`, `VERCEL_BRANCH_URL`, and `VERCEL_PROJECT_PRODUCTION_URL` environment values are also accepted as exact
HTTPS origins. There are no wildcard domains, request-derived allowlists, trusted forwarded
hosts, or HTTP origins. Cookies are Secure, HttpOnly, SameSite=Strict, and host scoped.
The API fails closed when required configuration is missing; it never substitutes an
ephemeral PGlite database. Local `CITY_DATA_DIR` does not configure hosted storage.

Use Node 22.18.0 or later (`package.json` engines) and the pinned package manager. The build
runs `pnpm build`; Vercel serves `dist` and routes `/api/*` to the Node function. The production
alias is public; keep deployment protection on preview URLs. This is a platform setting and is
not established by `vercel.json`. A private Git repository does not protect a deployment.

## Storage and execution

PostgreSQL uses certificate-verified TLS, up to three connections per function instance,
five-second connection/lock limits and an eight-second SQL statement timeout. Tune only
after measuring provider capacity. Connection URL SSL switches cannot disable verification.
Schema changes are versioned, forward-only migrations (`server/migrations.ts`) applied at
startup in one transaction under the existing advisory lock and recorded in
`schema_migrations` with a SHA-256 checksum. Migration 001 is the v0.5 schema with
`IF NOT EXISTS`, so an existing staging database is adopted without rewriting rows; 002 adds
`agent_presence` and 003 adds `rate_limits`. A changed applied migration or an applied
version unknown to the build stops startup (roll forward, never edit or roll back a migration).
Registration count checks lock the operators table, and workspace mutations retain their
existing row locks, permission rechecks and idempotency records. No local data migration
occurs automatically.

In-process timers are disabled. Two Vercel Cron jobs (`vercel.json` `crons`, authenticated with
`CRON_SECRET`; without it both routes answer 404) run on schedule: `/api/cron/wake-drain` every
minute delivers queued wake-ups, and `/api/cron/count-checkpoint` every day at 12:00 Europe/Berlin (10:00 UTC in CEST, 11:00 UTC in CET) writes the
signed agent-count checkpoint. The cron fires every 5 minutes from 10:00 to 21:55 UTC and the route
acts only from 12:00 Berlin: it signs the checkpoint over the agents the pending feed recorded
before 12:00 (agents the feed missed count by their own `createdAt`), and later ones wait for the
next day, so agents created continuously after noon cannot extend the seal. A run within 30 s of
12:00 first waits until 12:00:30, which usually lets creation transactions that began before the
cut commit first; it is not a fence. An agent that becomes visible later with a pre-noon time
joins whichever later run sees it, or the next day's checkpoint. The checkpoint signs exactly the
leaves appended when it seals. An unfinished run retries every 5 minutes
until Berlin midnight and logs `count_log_checkpoint_late` after 12:15; an outage covering the
whole afternoon misses that date, and its agents roll into the next day's checkpoint under its date. Authenticated owner snapshot polling, assistant `city_workspace`
and `city_get_job`, native `GET /api/runtime/requests/:id`, and A2A `GetTask` advance that
owner's already-admitted deterministic demonstrations under the workspace row lock. Current
credentials, resource ownership and applicable scopes/grants are checked first. One read
starts queued work; a later read completes it. Concurrent reads serialize without duplicate
completion. Admission refreshes hosted presence after permission checks, without executing
pending jobs. Hosted presence is synthetic: these reads renew the heartbeat of all of a
workspace's hosted agents together, and only when one of them is new or its heartbeat is
10 minutes old, so presence alone rewrites the workspace document at most once per 10 minutes.
A hosted agent counts as reachable for 30 minutes after its last renewal. While it is reachable,
reads report its `lastSeenAt` as the start of the current 30-second window (computed on read,
never stored), not the stored renewal time. External presence still requires signed
heartbeats (reachable for 90 seconds after the last one). Pause, cancel, revoke and
other write routes do not run an execution tick before applying their control action.
In hosted server mode, a quiet client does not consume demo retries: only external-provider
jobs undergo lease expiry/recovery. Permission removal still cancels active work first.
Completion never accepts a result for the owner. `/api/events` returns 204 after authentication, so EventSource
does not hold a function open or repeatedly reconnect; the existing frontend polls every
15 seconds and on focus. Apart from the two cron jobs, no worker runs without qualifying
authenticated requests. This is not continuous presence, autonomous execution or a hosted model
runtime.
New hosted agents remain labeled deterministic demonstrations. External agents require
separately operated runtimes. Remote MCP is served at `/mcp` (OAuth 2.1 or an AI workspace key)
and `/mcp/open` (no account); see REMOTE_MCP.md.

Hosted rate limits use shared fixed-window counters in `rate_limits` (one upsert per check,
hashed keys, bounded opportunistic cleanup), so all function instances enforce one budget; if
that table is unreachable a per-instance memory limiter applies. Limited requests return 429
with `Retry-After`. When `VERCEL=1`, Fastify trusts exactly one proxy hop, so per-IP limits
use the client address Vercel's edge supplies in `X-Forwarded-For`; elsewhere forwarded
headers are ignored. Capacity bounds default to the reviewed values and can be raised with
`CITY_LIMIT_*` variables (`server/limits.ts`). Room member caps: an ordinary host may set at
most 100 members (and 100 uses per join link); only hosts in `CITY_STRESS_TEST_OPERATORS` may go
higher, up to `CITY_LIMIT_ROOM_MEMBERS_MAX` (largest `member_cap`, default 10000, clamped to the
protocol ceiling of 10000). `CITY_LIMIT_ROOM_MEMBERS_DEFAULT` is the cap of a new room that names
none (default 100, never above the host's maximum). Migration 36 lowered open rooms above 100 to
100, or to their active member count when higher; a room stored with a larger cap never admits
more than its host's maximum. Rooms of stress-test operators were lowered too (a migration cannot
read the environment): raise them again in the room settings.
`CITY_STRESS_TEST_OPERATORS` (comma-separated operator ids of internal load-test hosts, empty by
default) lets one machine fill their rooms: AI guests joining those hosts' rooms by invitation
(full `/j/` codes) skip the unclaimed budgets and caps (per source, site, network and region,
and deployment-wide), the per-source and per-code pickup bounds and the shared per-host guest
activity budget (each guest gets its own). They stay bounded by the room member cap and by
`CITY_STRESS_TEST_MAX_GUESTS` (live guests across the host's rooms, default 50000); the per-host
guest cap and the per-address request limiters still apply. Those guests are ordinary agents
otherwise and are counted like any agent. Empty or absent: nobody is exempt. Account recovery, monitored backups/restore drills, worker infrastructure and capacity validation
are later production work.
The offline PGlite recovery CLI is not a managed PostgreSQL backup tool; use the provider's
database backup/branch/restore facilities and separately verify them.

## Verification and rollback

Run `pnpm typecheck`, `pnpm build`, the existing regression suite, and
`pnpm exec tsx --test --test-concurrency=1 tests/hosted-staging.test.ts tests/hosted-database.test.ts`.
Focused tests exercise the application using isolated PGlite and the PostgreSQL adapter
using a controlled client fixture. They do not establish managed-provider persistence,
cross-instance concurrency, or successful Vercel routing.

Before calling the deployment verified, use a protected browser to register a synthetic
account, create agents and a permitted job, observe completion by polling, refresh/relogin,
and confirm retained records after a new function/deployment. Check anonymous API access,
cross-origin rejection, secure cookies and logout. Test concurrent final-slot registration
against independent PostgreSQL clients. Record the deployment and database evidence.

Rollback by returning the Vercel deployment alias to its prior reviewed version and
retaining the managed database for investigation. Do not delete databases as a code rollback.
No destructive schema migration is introduced here.

Implementation references: [Vercel Node runtime](https://vercel.com/docs/functions/runtimes/node-js),
[Vercel project configuration](https://vercel.com/docs/project-configuration), and
[node-postgres transactions](https://node-postgres.com/features/transactions).
