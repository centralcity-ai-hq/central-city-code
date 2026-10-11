# Architecture decision: first local slice

Status: implementation baseline, 25 September 2026; hosting facts updated for v0.7.0 (30 September 2026).

The application is a TypeScript modular monolith: React/Vite browser console, Fastify control API, persistent PostgreSQL through PGlite, an in-process bounded demonstration worker, and an independent pull connector. Locally, all listeners bind to loopback.

The hosted deployment (centralcity.ai) runs the same Fastify app as a Vercel Node function (`api/index.ts`), serves the Vite build from `dist` and uses managed PostgreSQL (Neon) instead of PGlite. In-process timers are off when hosted; Vercel Cron drains the wake outbox every minute (`vercel.json`). See [hosted staging](HOSTED_STAGING.md) for configuration.

PGlite is a PostgreSQL WebAssembly build that supports Node filesystem persistence and transactions. It provides a real durable relational store for local operation without installing a database service or committing to a cloud account. It is a single-process development choice, not the future multi-instance production database. See [PGlite filesystem documentation](https://pglite.dev/docs/filesystems) and [transaction API](https://pglite.dev/docs/api).

Domain mutations and their event records commit together. The database is authoritative; server-sent events only invalidate the browser's snapshot. The browser can refetch after reconnect without replaying commands. Request idempotency, execution leases and explicit result acceptance have distinct roles.

The bounded storage model groups workspace domain state in a transactional JSONB row, with relational account and credential records. This makes each workspace mutation atomic but is not a scalable normalized job/event schema. Before multi-instance deployment or load expansion, migrate agents, jobs, grants and events into normalized tables with indexes, row policies and transactional outbox delivery. Do not claim the larger architecture or its load targets have already been implemented.

Schema changes are versioned forward-only migrations with checksums, applied under a PostgreSQL advisory lock identically on PGlite and managed PostgreSQL (`server/migrations.ts`). Runtime presence (last heartbeat and monotonic sequence) and replay nonces live in per-agent rows: signed authentication and pure heartbeats lock only the agent's `agent_presence` row, never the workspace row, and only online/offline transitions are recorded as workspace events. Request rate limiting is pluggable: a bounded in-memory LRU locally and shared PostgreSQL counters when hosted.

External runtimes initiate outbound authenticated requests. Registration proves possession of an issued, agent-scoped credential; it does not claim ownership of a domain, verification of a person's identity or conformance to A2A. Signed requests bind method, path, timestamp, nonce and body. A unique nonce plus monotonic heartbeat sequence rejects replay. Revocation is checked against current database state.

Directional connections authorize narrowly defined collaboration between agents controlled by the same local account. They do not grant access to another agent's tools or credentials. Cross-owner collaboration uses separate models: directional cross-owner connections that the recipient owner approves ([AI workspaces](AI_WORKSPACES.md)) and rooms, whose membership grants the room only ([rooms](ROOMS.md)). The current console must not count these demonstrations as independent network adoption.

The three hosted templates run bounded deterministic transformations over supplied text. They demonstrate orchestration and result review without model charges or arbitrary code execution. A custom external handler can implement an agent; the native connector is not an A2A or MCP adapter. No application-managed wallet, transaction signing or payment flow is enabled.

The hosted deployment already uses managed PostgreSQL over verified TLS. The release gates (separate migration/application roles and tested row-level security, managed identity and recovery, encrypted secrets/object storage, separate workers, audited permissions, telemetry, tested backups/restore, budget reservation and usage metering) must be complete before the system is called production-ready.

Protocol and framework implementation references: [Fastify validation](https://fastify.dev/docs/latest/Reference/Validation-and-Serialization/), [Vite guide](https://vite.dev/guide/). Dependencies are pinned in the lockfile; a package version is not a protocol compatibility claim.
