# Elric (server core)

Elric is Central City's AI assistant. Each person owns their own Elric. It's a normal member of the rooms its owner adds it to, and it acts only when its owner @mentions it (in the owner's private chat, every message is for Elric). This document covers the **server core**, behind `CITY_ELRIC=1`. The public page for users is [ELRIC_ABOUT.md](ELRIC_ABOUT.md).

> Google sign-in writes the verified identity Elric eligibility reads (server/google/, behind `CITY_GOOGLE_SIGNIN=1`; see [GOOGLE_SIGNIN.md](GOOGLE_SIGNIN.md)). Eligibility is re-checked on every invocation, so unlinking stops Elric at once.

## What exists

- **Identity** (`server/elric/service.ts` `addElric`). "Add Elric" creates a workspace agent (`mode: hosted`, `isDemo: false`, name "Elric") plus an `elric_agents` row. It's idempotent: at most one non-revoked Elric per owner.
- **Reserved name** (`server/elric/names.ts` `reservedName`). No other agent and no person may be called "Elric". The match is a skeleton comparison:
  - NFKC, case-insensitive;
  - invisible characters, spaces, punctuation and accents removed;
  - Cyrillic, Greek and small-capital look-alikes folded;
  - digits folded to the letters they resemble (0→o, 3→e, …), with `i`/`l`/`1`/`|` as one class.

  Every name-setting path checks it: console create, `city_create_agent`, manifest apply, a new agent on room join, the accountless invite join, and a person joining a room. Room member lists mark Elric agents with the server-set `auto_reply: { provider: 'elric' }`, and a client can't set it.

- **Eligibility** (`server/elric/access.ts` `elricEligibility`). Only a **person** owner (`operators.kind = 'owner'`) with a server-stored verified Google identity qualifies. It's re-checked on **every** invocation and on every pending-action approval. AI and unclaimed operators never qualify.
- **Agent-bound access** (`access.ts` `elricRoomAccess`). A room is admitted only through **this Elric's** own active member row. A foreign room gives the same `not_found` as a room that doesn't exist.
  - Refused: removed members; deleted, closed, host-muted and self-muted rooms; rooms with `responders_allowed = false`.
  - A paused or revoked Elric can neither read nor write.
  - The locked variant takes `elric_agents` FOR SHARE, then the room FOR UPDATE. Pause and revoke take `elric_agents` FOR UPDATE, so they are ordered against every recheck.
- **Invocation gate** (`server/elric/hook.ts`, called from `wake/hooks.ts roomPosted`). Only a mention by the owner's **person** member queues an invocation. So does the room host's person member, if the owner turned on "host may invoke" (off by default).
  - Everything else gets zero adapter calls, zero reservation and one audit row.
  - The sender gets an `elric_notice` in their **own** POST response, at most once per sender, room and UTC day. It's never posted to the room.
- **Budgets** (`server/elric/budget.ts`).
  - The per-owner, per-UTC-day allowance is 20 short answers, 4 summaries and 5 tool tasks.
  - The global daily ceiling is in cost units; see "Cost units" below.
  - Both are reserved in **one** transaction under row locks (owner row, then global row). The kill switch is checked before and inside it.
  - Any database error is a refusal.
  - Settling records the **true** spend, even above the reservation. The overage is visible in the turn as `cost_units` > `reserved_units`.
  - Cancel and error refund the allowance exactly once (lease-guarded). A run lost mid-flight is settled as **spent** when its lease expires.
- **Limit notices**. When a kind is used up, the owner gets an ephemeral notice, never a room post, in three places:
  - their POST response, as `elric_notice.code = 'elric_limit'` with `kind`, `text` and `resets_at`;
  - the invocation result (`notice`);
  - `GET /api/elric` `limit_notices`.

  For example: "Summaries used up for today. Resets at 00:00 UTC."

- **Context** (`server/elric/context.ts`). Only the invoking room, from Elric's **own** `visible_from_seq`, up to the trigger, at most 100 messages and 80,000 characters (`contextMessages`, `transcriptChars`). They go in as JSON lines (`responder/prompt.ts renderLine`), marked untrusted. There's no cross-room memory.
- **Model** (`server/elric/adapter.ts`, `anthropic.ts`, `endpoints.ts`). `CITY_ELRIC_PROVIDER` selects the provider.
  - `ModelAdapter` is the interface; every failure becomes a fixed code and no provider text is returned.
  - `AnthropicAdapter` (`anthropic.ts`) calls the hosted provider's Messages API directly (no SDK): prompt caching on the system prompt and the newest history block, native tool use, streamed replies (`stream: true`, drafts in `server/elric/draft.ts`), and extended thinking on Tier 2 and complex questions. Thinking is never posted or stored. The model id and the key come only from the environment (`CITY_ELRIC_T1_MODEL`, `CITY_ELRIC_ANTHROPIC_KEY`); the key stays in the secret store and never appears in logs or errors.
  - `FallbackAdapter` retries a failed call once on a configured self-hosted endpoint.
  - A streamed answer that breaks off (and whose retry cannot run or fails too) after at least 40 visible characters is posted as far as its last complete sentence or line, any open code fence closed, with `(cut short)` as its own paragraph. A sentence end counts only when the stream continues after it (a space or line break after `.` `!` `?`, anything after `。` `！` `？`), the cut is at a grapheme boundary, and with no such boundary there is no partial. The refusal checks run on the whole streamed text (a credential anywhere, or drafting stopped for one, means no partial); the kept text then passes the same reply checks as a whole answer (`checkReply` in `service.ts`). Otherwise the room gets the plain "couldn't answer" line. Billing is what the calls consumed, as for any failure; the allowance count is kept (not refunded), since an answer was posted. A private conversation whose first reply is cut short is still titled. Logged as `elric_turn_partial` with the code and a length, never the text.
  - `OpenAICompatibleAdapter(baseUrl, model)` talks to a self-hosted OpenAI-compatible endpoint: https only (http only on loopback), no SDK, no redirects, bounded time and body size. Endpoints, cold start, health and rates: [ELRIC_MODEL.md](ELRIC_MODEL.md).
  - `MockAdapter` is deterministic, scriptable, and records what it received (tests and `CITY_ELRIC_MOCK=1`).
  - Without a configured model, every model call is `model_unavailable`.
- **Router** (`server/elric/router.ts`).
  - Tier 0 is plain code with no model and 0 units: "who is here" and "open tasks".
  - "Summarize" is a _summary_ and "create a task" is a _tool_ task; both go to Tier 2.
  - Everything else goes to Tier 1 as _short_.
- **Tools** (`server/elric/tools.ts`, enforced in `service.ts`).
  - The allowlist is `room_read` and `room_task_create` (both bound to the invoking room; the second only with `CITY_ROOM_TASKS=1`), plus `city_help`, a read-only search over the published docs that touches no room data (`server/elric/help.ts`).
  - The tool `room_id` must equal the invoking room.
  - At most 4 tool calls per step, 48,000 characters of tool results per invocation, and 8 adapter steps.
  - Before every step, the next call's estimated cost must fit what is left of the reservation. Otherwise the run stops with an honest message (`step_limit`, `turn_budget`).
  - Before **every** adapter step and **every** tool call, and again before the post, a recheck runs under the Elric row and room locks. It checks access, the lease and the reservation, and it renews the lease.
  - `room_task_create` runs its recheck **inside** the task-create transaction, under the room lock (`tasks.create` precondition).
- **Pending actions** (`server/elric/pending.ts`).
  - Only an **owner session** principal can approve, and it must name the arguments hash it was shown.
  - Approval rechecks eligibility and agent-bound access under the locks, then executes the **stored** arguments in the same transaction.
  - `room_task_create` is consequential: a valid call becomes a pending action (exact validated arguments, hash, 15-minute expiry); the turn's outcome is `pending`, the model gets a fixed result and nothing is created until the owner approves. Approval runs the stored arguments once, with eligibility and access rechecked inside the create transaction (details in [ELRIC_MODEL.md](ELRIC_MODEL.md)).
- **Posting** (`service.ts` → `rooms.post`).
  - Precondition under the room lock; idempotent per (Elric, room, mention seq).
  - The reply is NFKC-normalised, then checked for credentials (refused), then stripped of every mention-position `@`, including the look-alikes ＠ and ﹫.
  - `[#seq]` citations are kept only for messages of this room visible to Elric.
  - Each post carries the public, server-stamped `auto_reply: { provider: 'elric', model, label }`, where `label` is `elricReplyLabel()` from `shared/elric-copy.ts`: "Elric · AI" (the name plus the AI tag) for a model reply, or "Elric · automated" for Tier 0 (never "AI" there). The real model stays in the database: every API response end users read carries the public model `elric-1.0` (or `deterministic` for Tier 0), and the label is recomputed from the shared copy. The version shows only in the hover tooltip ("Elric v1.0") and the profile ("Elric · Version 1.0"), from `ELRIC_VERSION`. The stamp is visible to every member through the read API, and responders are never woken by it. `elric_posts` links the post to its turn.
- **Turn log** (`server/elric/turns.ts`).
  - Append-only `elric_turns`: a trigger refuses UPDATE, DELETE and TRUNCATE.
  - One row per decision: invoker, room, context seq range, tier, model, tokens, `cost_units`, `reserved_units`, and the outcome, reason and posted seq.
  - Each tool call is recorded with its name (an allowlisted name, else `other`), `name_hash`, `args_hash` and status.
  - **No message content** is stored.
  - Owners read it with `GET /api/elric/turns`: newest first, cursor-paginated, no cap. Filters: `room_id` and `result`. Each turn also carries:
    - `result`: `posted`, `refused`, `limit`, `cancelled` or `error` (`turnResult`), plus `reason_code` (the stored reason, else the outcome);
    - `room`: `{ id, name }` while the owner can still see the room (an active membership, room not deleted), else `null`;
    - `link`: the room page of a posted reply, when the room is visible.

    The view adds no message content.
- **Managed agent**. Elric is managed by Central City. The console's per-agent routes `POST /api/agents/:id/revoke`, `POST /api/agents/:id/rotate-credential`, `POST /api/agents/:id/pause` and `POST /api/agents/:id/resume` (also when Elric is a descendant of the revoked agent), and `city_control` (pause, resume or revoke, from any grant or key) answer `409 elric_managed`: "Elric is managed by Central City. Turn it off in Elric settings instead." Elric is identified by its `elric_agents` row, never by name. Elric's own routes below and account erasure are unaffected. It can't be renamed or re-scoped either: Elric wasn't created from a manifest, and the name is reserved.

Owner console routes (session cookie only):

- `GET /api/elric`
- `POST /api/elric`
- `POST /api/elric/pause`, `/resume` and `/revoke`
- `PUT /api/elric/settings` `{ host_may_invoke }`
- `GET /api/elric/turns`
- `POST /api/elric/pending/:id/approve` `{ args_hash }`
- `GET /api/elric/pending`: the owner's open, unexpired pending actions. Each has the tool name, a safe summary (the task title, cleaned and capped at 200 characters), the task description it would create as `detail` (control and bidi characters removed, line breaks kept, capped at 4,000 characters; no other stored argument), the `args_hash` to approve with, the room (name only while visible), and the created and expiry times.
- `POST /api/elric/pending/:id/reject`: owner session only. A repeated reject answers like the first. A rejected action can't be approved (`not_pending`).

## Owner console

With `CITY_ELRIC=1`, the console shows an Elric page (`src/elric/ElricActivity.tsx`):

- status, with Pause, Resume and Revoke (Revoke asks to confirm) through the routes above;
- today's allowance per type (`GET /api/elric` `usage`);
- the turn log (`GET /api/elric/turns`), filtered by room and result.
- "Waiting for your approval": the open pending actions, with Approve and Reject.

The page shows no message content: the log has none.

## Cost units

A cost unit is **1 micro-USD** (`ELRIC_COST_UNIT_USD`, since migration 45, which multiplied every stored amount by 2500 from the old USD 0.0025 unit). Migration 45 briefly disables the `elric_turns` append-only trigger for that rescale (`ALTER TABLE … DISABLE TRIGGER`), which needs the table owner's role: migrations must run as the owner of the Elric tables.

- **Hosted model, priced per token** (`server/elric/token-cost.ts`): input, output, cache-read and cache-write tokens at the provider's prices. The turn log records the four token counts the API reports.
- **Self-hosted fallback**: GPU-second costing (`docs/ELRIC_MODEL.md`).

A global daily ceiling across all owners (`ELRIC_GLOBAL_DAILY_UNITS`) is a platform constant.

A per-token step reserves its worst case: 72k context tokens all cache-written (1.25x) plus 4,400 output tokens (the largest answer, 2,400, plus a 2,000-token thinking budget) = 112,000 units (USD 0.112). A GPU-priced step reserves the tier's rate for the same context (Tier 1 25,500, Tier 2 142,000); with a GPU fallback configured, the larger of the two. An invocation reserves 8 steps, and each step's estimate stops the run honestly (`turn_budget`) before the reservation is exceeded.

## Flags and limits

- `CITY_ELRIC=1` registers the routes and turns on the hook, the reserved name and the member marker. When it's off, `/api/elric*` is a 404 and the hook is a no-op. Migration 39 exists either way.
- `CITY_ELRIC_KILL=1`, or the `elric_flags` row `kill`, refuses every invocation before any adapter call, including Tier 0.
- Limits live in `server/elric/config.ts` and owners can't raise them:
  - allowance 20 / 4 / 5 per day, reset at 00:00 UTC;
  - a global daily spending ceiling;
  - 8 steps, 4 tool calls per step and 48k tool-result characters per run;
  - answers of 1,600 (Tier 1) and 2,400 (Tier 2) output tokens, plus a 2,000-token thinking budget on Tier 2 and complex questions;
  - 100 context messages (80,000 characters);
  - 12,000-character replies;
  - a 55 s run budget per function run (`vercel.json` `maxDuration` 60);
  - 10-minute expiry;
  - a 190 s lease, renewed at every recheck.

## Dashboard chat

The `/elric` dashboard talks to Elric in a **private room** (migration 43, `rooms.elric_private`; `server/rooms/private.ts`, `server/elric/chat.ts`):

- The room is created on the first `GET /api/elric/chat`, at most once per Elric (under the Elric row lock; `elric_agents.chat_room_id` is unique). The **owner's person hosts it**, the owner's Elric is a normal member, `member_cap` is 2, nobody can join, and no join link is ever minted. It doesn't count against the owner's room limits.
- The dashboard posts `@Elric <text>` through `POST /api/rooms/:room/messages` as the owner's person member. Every Elric guarantee applies unchanged: room-only context, the invocation gate, budgets, approvals, the turn log, the label, pause and the kill switch.
- **Locked for its whole life.** Links (create, rotate, `POST /api/links`), joins of anyone, people/AI settings, history, rename, topic, close, removing Elric, leaving and host invites answer `409 room_private`. Repo code answers 404. An empty chat (nothing said yet) is not listed in the chat history, and the console stores a new chat only with its first message. Deleting it as a room (`DELETE /api/rooms/:room` with `confirm_name`, the room settings' Delete, since the chat lists among the console's rooms under its title) deletes the chat exactly as `DELETE /api/elric/conversations/:id` does.
- **Console only.** Only the owner's console session and Elric itself reach the room. Any other principal of the same owner (an assistant grant, MCP, a workspace key) gets the uniform 404, and the room isn't in their room list. Room tasks follow the same rule.
- **Lifecycle.** Paused Elric: no turns. A revoked Elric, or one whose agent is gone, has its chat closed (read-only history) on the next `GET /api/elric/chat`. A re-added Elric gets a new room.

Routes (owner console session only):

- `GET /api/elric/chat[?since=<seq>]`: `{ room_id, slug, person_member_id, status, latest_seq, waking, pending_count }`. With `since` it's a cheap poll: one read, no creation scan. Poll every 2 s only while a turn is queued or running; back off up to 60 s when idle, and not at all while the tab is hidden.
- `GET /api/elric/rooms`: the "@ room" picker. Open shared rooms where the owner's person is an active member, with `elric_member` (this Elric, active, not paused) and `member_count`, `hosting`. No names of other members, no content.
- `POST /api/elric/ask` `{ room_id }`: the server check before an "@ room" post. It answers `{ room_id, person_member_id, posts_publicly: true }`, or `409 elric_room_requires_membership` with `details.missing` = `person`, `elric` or `both`. A room the owner isn't in, or the private chat, is 404. The post itself then goes through the room route, and the invocation gate checks the same memberships again. The question and the answer are public in that room.

## Catch-up

"While you were away" in a room's New-since divider (`server/elric/catch-up.ts`, migration 66 `elric_catch_ups`; types in `shared/elric-catch-up.ts`, client hook `src/rooms/useCatchUp.ts`). It's private to the person asking: it comes back in the response and is never posted to the room.

`POST /api/rooms/:room/catch-up` `{ after_seq?, to_seq? }` (owner console session only) answers `{ room_id, from_seq, to_seq, truncated, sections, nothing_important, cached, incomplete?, notice?, resets_at? }`. Each section is `{ kind, title, bullets: [{ text, seqs, task_number? }] }`, in this order: `needs_you`, `tasks`, `decisions`, `open_questions`. Sections with nothing in them are left out, there are at most 8 bullets in all, and every bullet cites the message seqs it comes from.

- **Range.** Messages after `after_seq` (default: the caller's read cursor) up to `to_seq` (default: the latest message). The range never starts before the caller's own history or Elric's. At most 300 messages are read, the newest first (`truncated`).
- **Where the sections come from.** _Needs you_ comes from @mentions of the caller's members in the range, plus, for the host, results waiting for review. _Tasks that moved_ comes from the server-written task lines and `room_tasks`, shown as `T<n>`. Neither uses the model. _Decisions_ and _Open questions_ come from one Tier 1 call over the human messages. That call is given the messages as untrusted JSON lines and has to answer in JSON. A bullet is kept only when it cites a message the model was actually given. Mentions, tool names, check marks and Markdown are taken out, and a credential drops the bullet. When every section is empty, `nothing_important` is true.
- **What is never read.** Private messages, which live in another table. The private `/elric` chat answers 404.
- **Eligibility.** The room's host Elric must be on: active, a member of the room, and passing the agent-bound read check. The caller must pass `elricEligibility` (verified Google, 18+) Otherwise the answer is `409 elric_catch_up_off` (Elric off in this room) or the usual `403 elric_*`. While the global kill switch is on, it is `409 elric_catch_up_paused`.
- **Money.** The call takes one `summary` from the caller's allowance, and its worst case is reserved against the global ceiling (`reserve` without an invocation). The true cost is settled afterwards. A failed call gives the allowance back. A transient error is retried once. When the allowance is used up, the response still has the sections from room data, plus `incomplete: 'limit'` and the limit notice.
- **Cache.** One row per (caller, room, from_seq, to_seq), kept for 24 hours, so reopening the divider bills nothing. A second request while one is being written gets `409 elric_catch_up_busy`. Incomplete answers are never cached. Erasure deletes the owner's rows, and the offline backup recognizes the table but never exports it.

## Operator controls

A deployment's operator has a kill switch and an aggregate usage view behind a separate operator secret (`server/elric/ops.ts`), plus optional spend alerts to a webhook. They exist only with `CITY_ELRIC=1`; without the secret they answer 404 like an unknown path.

## Edits outside `server/elric/**`

| File                                                                                                                                                                  | Change                                                                                                                                                                                                                                                                                                                   | Why                                                                                                                                  |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| `server/app.ts`                                                                                                                                                       | `registerElricMigration()` runs unconditionally. `AppOptions.elric` holds test injection. `registerElric(app, …)` runs behind the flag, with `postReply` → `rooms.post(…, { autoReply: stamp, precondition })` and `createTask` → `tasks.create(…, { precondition })`. The reserved-name check is on `POST /api/agents`. | wiring                                                                                                                               |
| `server/wake/hooks.ts`                                                                                                                                                | One call in `roomPosted`: `if (mentioned.length) await elricOnRoomPosted(tx, row, mentioned);`                                                                                                                                                                                                                           | invocation gate                                                                                                                      |
| `server/recovery.ts`                                                                                                                                                  | The offline backup recognizes the Elric tables: all or none, never exported.                                                                                                                                                                                                                                             | Without it, `backupDatabase` refuses every database with migration 39. The `tests/rooms-security.test.ts` "stale backup" test fails. |
| `server/rooms/tasks-service.ts`                                                                                                                                       | `create(p, body, { precondition })`, run under the room lock in the create transaction.                                                                                                                                                                                                                                  | P2-3: the agent-bound recheck in the same locked transaction                                                                         |
| `server/rooms/service.ts`, `server/rooms/contract.ts`, `server/remote-mcp/tools.ts`, `protocol/schemas/rooms/{message,read-page,member}.v1.schema.json` (regenerated) | `auto_reply.provider` gains `'elric'` plus an optional `label`. The member list marks Elric agents.                                                                                                                                                                                                                      | §7 visible label and the first-party marker. The MCP output schema must accept it.                                                   |
| `server/autonomy/service.ts`                                                                                                                                          | `city_control` refuses every action on an Elric (`409 elric_managed`). The manifest apply refuses the reserved name.                                                                                                                                                                                                                      | §6 and the name reservation                                                                                                          |
| `server/assistant-access.ts`                                                                                                                                          | One line in `city_create_agent`: `if (reservedName(values.name)) d.fail(409, ELRIC_RESERVED_NAME_MESSAGE);` (plus its import)                                                                                                                                                                                            | Reserved name                                                                                                                        |
| `server/rooms/service.ts` (name)                                                                                                                                      | One line in `joinPerson` and one in `joinWith`'s new-agent branch: `if (reservedName(name)) refuse(409, ELRIC_RESERVED_NAME_CODE, ELRIC_RESERVED_NAME_MESSAGE);` (plus the import)                                                                                                                                       | Reserved name, for people and for new agents on join                                                                                 |
| `server/links/invites.ts`                                                                                                                                             | One line before the accountless guest is created: `if (reservedName(values.name)) throw new RoomError(409, ELRIC_RESERVED_NAME_CODE, …);` (plus the import)                                                                                                                                                              | Reserved name on `city_join_invite` and redeem                                                                                       |
| `server/migrations.ts`                                                                                                                                                | None. Migration 39 (`elric_core`) registers through `registerMigration`, like every feature module.                                                                                                                                                                                                                      | —                                                                                                                                    |

**Optional:** add measured weights for `tests/elric-*.test.ts` to `WEIGHTS` in `scripts/test-shard.mjs`. The files already run, at the default weight of 10 s; `elric-flood` takes about 21 s.

## Security acceptance checklist mapping

| #   | Item                                                                       | Proof (test file: test name)                                                                                                                                                                                                                                                |
| --- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Access by agent; foreign room = not found; person-only room unreachable    | elric-isolation: "a room where the owner is only a person…", "cross-user…", "cross-room…"                                                                                                                                                                                   |
| 1   | No grant, key or session inside Elric; no model-visible token              | By construction; elric-units: "tool gate…"                                                                                                                                                                                                                                  |
| 2   | Refused callers: 0 adapter calls, 0 reservations, ≤ 1 notice, never posted | elric-invocation: "non-owner mentions…"; elric-flood: "1000 guest mentions create 0 room posts and 0 adapter calls"                                                                                                                                                         |
| 2   | Order: eligible → owner → active → reserve                                 | elric-identity: "eligibility is re-checked on every invocation…"; elric-tools: "pause while a model call…"                                                                                                                                                                  |
| 3   | One transaction; fail closed; kill switch for everyone                     | elric-budget: "per-owner allowance…", "global ceiling…", "kill switch…", "1,000 concurrent reservations…", both "50 concurrent…" tests; elric-units: "money controls fail closed…"                                                                                          |
| 3   | Refund exactly once; lost run = spent; true spend                          | elric-budget: "a reservation cancelled before…", "an adapter error…", "a run lost mid-flight…", "true spend is recorded…", "lease: every recheck renews it…"                                                                                                                |
| 3   | Reset boundary; limit visible to the owner                                 | elric-budget: "per-owner allowance…", "limit notices…"                                                                                                                                                                                                                      |
| 3   | Global daily ceiling                                                       | elric-units: the global ceiling test                                                                                                                                                                                                                                        |
| 4   | Room-only context, nothing at or before the join seq, untrusted JSON lines | elric-isolation: "cross-room…", "from_join…"; elric-invocation: "injection…"                                                                                                                                                                                                |
| 5   | Allowlist by name and schema; `room_id` = invoking room                    | elric-tools: "unauthorized tools…", "room_task_create: only in the invoking room…"                                                                                                                                                                                          |
| 5   | Recheck before each tool and before the post                               | elric-tools: "revocation between tool steps…", "room_task_create rechecks inside the create transaction…", "the host removes Elric mid-task…"                                                                                                                               |
| 5   | 8 steps; per-step and per-turn caps                                        | elric-tools: "the tool loop stops at 8…"; elric-budget: "a turn stays inside its reservation…"                                                                                                                                                                              |
| 5   | pending_action: owner session only, stored args, recheck                   | elric-audit: "pending actions…", "pending approval rechecks Elric under the lock…"                                                                                                                                                                                          |
| 6   | Pause and revoke stop reads and writes; cancel and refund                  | elric-tools: "pause while a model call…", "revocation between tool steps…"                                                                                                                                                                                                  |
| 6   | Console revoke/rotate and grants refused (`elric_managed`); no rename     | elric-control: "Elric is managed: console revoke/rotate and city_control answer 409 elric_managed"                                                                                                                                                                 |
| 6   | No self-approval of proposals or tasks                                     | By construction: no review, apply or accept tool (elric-tools: "unauthorized tools…")                                                                                                                                                                                       |
| 7   | Credential check, citations, look-alike @, visible label                   | elric-invocation: "replies: citations validated…", "look-alike @ signs…", "a public label on every Elric post (the shared elricReplyLabel, every tier)…"                                                                                                                    |
| 7   | Name reservation and first-party marker                                    | elric-identity: "the name "Elric" (and look-alikes) is reserved…", "the reserved name holds on every path…"; elric-control: "the accountless invite join cannot take the reserved name…"; elric-invocation: label test (member list); elric-units: "reserved name folding…" |
| 8   | Append-only, owner-queryable, no content, only allowlisted tool names      | elric-audit: "turn log…", "no message content…"; elric-tools: "unauthorized tools…" (`other` + `name_hash`)                                                                                                                                                                 |
| 9   | Google ID token verification                                               | Done: Google ID token verified server-side before the row is written (server/google/verify.ts; [GOOGLE_SIGNIN.md](GOOGLE_SIGNIN.md)). The stored row is re-checked per invocation (elric-identity).                                                                         |
| 10  | Flag off: 404, no effect                                                   | elric-control: "flag off: routes are not registered…"                                                                                                                                                                                                                       |

## Not done yet

- **UI:**
  - the "Add Elric" button;
  - displaying `elric_notice`, the `auto_reply` label and the member marker;
  - pending-action cards.
- **Real model host.** Wiring `OpenAICompatibleAdapter` needs a decision on the model host and a key from the secret store. Models and cold start: [ELRIC_MODEL.md](ELRIC_MODEL.md).
- **Degrade mode** near the global ceiling. The ceiling alerts exist (see Operator controls).
