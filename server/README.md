# Local backend implementation

`createApp({ dataDir, now, startWorkers, secureCookies })` returns an unlistened Fastify instance. `server/index.ts` owns loopback binding and built frontend assets. Tests use `dataDir: 'memory://'`, an injected millisecond clock, and `startWorkers: false`; call `app.city.tick()` to run maintenance deterministically. Close each app to release timers, live streams, and the database.

## Persistence and transitions

Startup applies the versioned migrations in `migrations.ts` (ledger: `schema_migrations`); add a new migration with `registerMigration` rather than editing an applied one. PGlite runs PostgreSQL locally in a single process. Accounts, session hashes, scoped credential hashes, and replay nonces use individual tables. Each bounded operator workspace uses one JSONB row, locked and updated transactionally with its domain events. This is a deliberately limited storage model, not database-enforced row-level security or a distributed queue. Application queries scope all workspace access to the authenticated operator. Normalize domain tables and implement independently reviewed tenant policies before scaling further.

Jobs are admitted only with a directional connection, two reachable nonrevoked agents, and available capacity. A maximum of two active jobs may involve an agent; a workspace permits ten. Operator cancellation and permission revocation prevent late results from overwriting terminal state. External pure-compute leases last 60 seconds and recover at most three attempts. Lease recovery is appropriate only to this side-effect-free runtime contract; it must not be reused for money transfers, external messages, or arbitrary tools. Completion and explicit operator acceptance are distinct. Provider costs are unknown for external execution (`costCents: null`); hosted transformations incur no external API calls (`0`).

A signed external agent can directly request work through `POST /api/runtime/requests` and inspect its own requested result through `GET /api/runtime/requests/:id`. The authenticated credential supplies the requester identity. Native requests are restricted to authorized hosted demonstration providers; this prevents an agent-to-agent handoff from triggering unmetered external execution. Both admission and result access recheck current communication grants. Retrieving a result never accepts it on the operator's behalf.

Runtime presence is stored in `agent_presence` (`presence.ts`) and overlaid onto workspace reads. Signed authentication records the nonce and pure heartbeats advance the sequence under that agent's presence row lock only; the workspace row is written only when the agent transitions online (`agent.online` event). Expired nonces are removed per agent on authentication and by a throttled, bounded sweep. The one-second local maintenance timer refreshes hosted demonstration presence without an event per refresh: the synthetic heartbeat of all of a workspace's hosted agents is renewed together, and only when one is new or its heartbeat is 10 minutes old (`HOSTED_HEARTBEAT_MS`), so presence alone rewrites the workspace document at most once per 10 minutes. A hosted agent is reachable for 30 minutes after its last renewal (`HOSTED_PRESENCE_TTL`); while it is reachable, reads report its `lastSeenAt` as the start of the current 30-second window, computed on read and never stored. External presence expires 90 seconds after the last signed heartbeat. Snapshots derive current reachability directly from server time. The timer also records expiry events, starts queued hosted jobs, and computes already-running hosted jobs on the following tick. Hosted templates are deterministic demonstrations operating only on user-supplied text. They do not browse or call an AI model.

Hosted server mode disables that timer. After authorization, owner snapshots, assistant
workspace/job reads, native requester result reads and A2A GetTask run the same bounded
progression under the owner's workspace lock. Hosted admission refreshes demo presence but
does not execute jobs. Control writes apply without a preceding execution tick. No requests
means no execution; this is request-driven progress, not a durable background worker. Tests
cover this path without owner snapshots or manual ticks, including concurrent reads and
authority/control failures. Managed PostgreSQL multi-instance behavior requires separate
provider verification.

## Bounds and authentication

- 50 local operator accounts; 100 agents, 500 directional connections, and 1,000 retained jobs per workspace (defaults in `limits.ts`; override with `CITY_LIMIT_*` or `createApp({ limits })`). Reaching the job limit refuses admission rather than dropping idempotency history.
- Latest 1,000 events retained per workspace; snapshot returns 100 events and 50 jobs. This is bounded development history, not a permanent audit archive.
- Requests at most 64 KiB; input at most 12,000 characters; result at most 32 KiB, eight nesting levels, and 2,000 values.
- Passwords use salted scrypt. Session tokens are random, stored as SHA-256 hashes, and use HTTP-only SameSite=Strict cookies. Sessions slide: they expire after 24 hours without an authenticated request (`SESSION_TTL_MS`), and activity renews them (a single conditional UPDATE at most once an hour per session, refreshing the cookie with the same token) up to 30 days after sign-in (`SESSION_MAX_AGE_MS`). At most 20 sessions are retained per account (`SESSIONS_PER_ACCOUNT`); a new sign-in beyond that signs out the oldest (ties on sign-in time broken by token hash). Logout revokes only the current session. `secureCookies: false` is restricted to loopback development.
- External credentials are agent-scoped random secrets valid until rotated or revoked. They are returned once and stored as hashes. Owner-initiated rotation preserves the stable agent identity, resets presence and cancels active jobs atomically; every runtime transaction rechecks the exact current credential. There is no automatic rotation, expiry or permanent key-history ledger. See [credential operations](../docs/CREDENTIALS.md).
- Signed runtime requests use Unix milliseconds, a 60-second timestamp tolerance, HMAC-SHA256 over the specified raw-body envelope, and a per-agent nonce. Nonces remain for 130 seconds, beyond the entire possible acceptance window of a future-dated request. Monotonic heartbeat sequences additionally reject stale runtime sessions.
- Rate limits (`rate-limit.ts`) use a bounded in-memory limiter locally (LRU eviction, no global denial) and shared PostgreSQL counters in hosted mode; 429 responses include `Retry-After`. Forwarded client addresses are trusted only on Vercel (one hop).
- API Host must be localhost/loopback, browser mutation Origin must match, and browser mutations require `X-City-Request: 1`. No permissive CORS is configured. External runtime actions recheck revocation within their state transaction.

## Live updates

SSE sends only invalidation notices; authenticated clients retrieve their own snapshot. Notices follow committed state changes, and no-op runtime polling produces no activity event. Streams are bounded to four per operator, 100 total, and five minutes each. Logout closes streams for that session; keepalives recheck persisted session validity every 15 seconds. Reconnect immediately invalidates the snapshot, so a missed transient notification does not lose durable state. There is no exactly-once SSE claim. Shutdown closes raw streams before closing PostgreSQL.

## Reviewed implementation references

- [PGlite API: construction, parameterized queries, transactions and close](https://pglite.dev/docs/api)
- [Fastify lifecycle hooks](https://fastify.dev/docs/latest/Reference/Hooks/)

This backend includes no wallet signing, chain transactions, billing, arbitrary code execution, internet fetching, A2A adapter, or MCP adapter. Its native connector is a development protocol, not a standards-compliance claim.
