# Elric: the self-hosted model

This page covers how Elric (see `docs/ELRIC.md`) talks to its own model servers. They're OpenAI-compatible endpoints. Everything here is behind `CITY_ELRIC=1`. With no endpoint configured, nothing changes: every model call is `model_unavailable` and Tier 0 answers still work.

## Endpoints

There's one endpoint per router tier. They're configured in the environment by name; the values come from the secret store.

| Variable                                   | Meaning                                                 |
| ------------------------------------------ | ------------------------------------------------------- |
| `CITY_ELRIC_T1_URL`, `CITY_ELRIC_T1_MODEL` | Tier 1, the small model for short answers               |
| `CITY_ELRIC_T2_URL`, `CITY_ELRIC_T2_MODEL` | Tier 2, the large model for summaries and tool tasks    |
| `CITY_ELRIC_MODEL_KEY`                     | Optional. A static bearer, sent only to these endpoints |

The URL and model of a tier must be set together. A tier with neither is absent, and its calls are `model_unavailable`. Invalid values stop startup, and the error never repeats the value.

The URL rules (`checkBaseUrl`):

- https only;
- http only to a loopback host, and loopback only off a deployment (`VERCEL` unset and `NODE_ENV` not `production`), for a local model server during development;
- no credentials, query or fragment;
- a literal IP must be public.

## The client

The client is `OpenAICompatibleAdapter` in `server/elric/adapter.ts`, using the transport `elricTransport`.

- `POST <base>/v1/chat/completions` with `stream: false`, `max_tokens` set to 600, and the allowlisted tools as `function` tools. There's no SDK.
- The transport is `node:http(s)`, like the other outbound clients:
  - no connection reuse and no redirects followed;
  - https hosts resolve through `publicLookup`, so only public addresses are allowed, checked when the connection opens.
- Limits:
  - **connect** within 5 s (TCP, plus TLS for https);
  - **total** call time of 45 s on both tiers (a full 600-token answer on an L4 takes about 35 s at the measured single-stream speed);
  - requests up to 512 kB, never sent if larger;
  - responses up to 1 MB, whether the size is declared or streamed.
- Every failure becomes a fixed code. The provider's body is never returned or logged.

| Code                | When                                                                               |
| ------------------- | ---------------------------------------------------------------------------------- |
| `waking`            | 503, or the connection is refused or not open in time (nothing was sent)           |
| `timeout`           | the total time was used up                                                         |
| `server_error`      | 500, 502, 504 and other 5xx, or a connection dropped after the request was written |
| `unauthorized`      | 401, 403                                                                           |
| `model_unavailable` | 404, or no endpoint configured                                                     |
| `rate_limited`      | 429                                                                                |
| `too_large`         | 413, or a request or response over its cap                                         |
| `bad_request`       | other 4xx                                                                          |
| `bad_response`      | a redirect, malformed JSON, or no choice, text or tool call                        |
| `unreachable`       | DNS failure, or a non-public or refused address                                    |

- Tool calls come back as requests. An argument string that isn't a JSON object becomes `null`, and the service refuses it. At most 16 calls are read per answer, and the service still caps them at 4.

## Run time budget, cold start and charging

Elric runs inside a serverless function. On Vercel, `api/index.ts` has `maxDuration: 30`, so no run may wait past that. `server/elric/service.ts` handles it like this:

- **Budget.** One drain gets `runBudgetMs` of wall time (24 s; `CITY_ELRIC_RUN_BUDGET_MS` overrides it once the function limit is raised). A test ties it to `vercel.json`. Each model call is capped at what's left of the budget, minus a 2 s margin, and never above the tier's 45 s. With under 4 s left:
  - before its first answer, the invocation is **deferred**;
  - after one, it **stops honestly** (`step_limit`, reason `time_budget`), because a run's conversation isn't stored and can't be resumed.
- **Deferral.** The invocation goes back to `queued`. Its lease is released and its reservation kept (`deferred_at`, plus a not-before time in `locked_until`). The next drain resumes it with the same reservation and charges it once.
  - Drains run after each room post, and every minute from the existing `GET /api/cron/wake-drain` cron, side by side with the wake drain under one deadline.
  - Pausing or revoking Elric cancels a deferred invocation. Its reservation is released; the allowance count comes back only when it spent nothing.
- **Cold start (`waking`): never waited for inside a run.**
  1. The first `waking` sets `elric_invocations.waking_since` (migration 40). The owner's `GET /api/elric` then lists the invocation under `waking`, with the text "Elric is waking up…".
  2. The invocation is deferred, and retried by a drain no sooner than 10 s later.
  3. `wakeMaxMs` (120 s) after the first `waking`, it ends as `error` / `model_waking`. The reservation and allowance are refunded, and nothing is posted.
  4. When the model answers, `waking_since` is cleared.
  5. A `waking` after the run already made progress ends the same way, refunded.
- **Charging.**
  - A call that was **sent** and then failed (`timeout`, a 5xx, a bad or oversized answer, a connection dropped after the request was written) counts the step's estimate toward the owner's and the global spend. The GPU may have worked.
  - A failure **before** sending (refused or unopened connection, `waking`, a request over the cap) costs nothing.
  - The allowance count is given back in both cases.
  - An answer without usage counts the step's estimate.
  - The public label always names the **configured** model (`CITY_ELRIC_T*_MODEL`), never a string the endpoint returned.
- **A run cut off mid-flight** (the platform stopped the function) is found by a later drain once its lease expires. It settles what it recorded: `spent_units`, plus `inflight_units` when a model call was in flight. It never charges the whole reservation. The allowance comes back when no call was in flight.

## Health probe

`GET /api/cron/elric-health` is internal. It answers only `Authorization: Bearer <CRON_SECRET>`; anything else gets a 404, like an unknown path.

- It probes each configured tier with `GET /v1/models`, which spends no tokens.
- It returns `{ tiers: { 1: { state, latency_ms, code? }, 2: … } }`, where `state` is `ready`, `waking`, `down` or `unconfigured`.
- It logs one line: `{"event":"elric.model_health","t1":…,"t2":…}`.
- It never returns a URL, a model name or provider text.
- Scheduling it a few minutes before the busy hours wakes a sleeping endpoint ahead of the first invocation.

## Cost units from measured GPU time

This applies to the self-hosted fallback only; the hosted model is priced per token (`docs/ELRIC.md` "Cost units"). A cost unit is 1 micro-USD (`ELRIC_COST_UNIT_USD`). Per tier, the rate is GPU-seconds per 1,000 tokens:

```
units per 1k tokens = GPU-seconds per 1k × (GPU USD per hour / 3600) / 0.000001
```

| Variable                                 | Default (ASSUMED until measured) |
| ---------------------------------------- | -------------------------------- |
| `CITY_ELRIC_GPU_USD_PER_HOUR`            | 2.50                             |
| `CITY_ELRIC_T1_GPU_S_PER_1K_IN` / `_OUT` | 0.18 / 5.4                       |
| `CITY_ELRIC_T2_GPU_S_PER_1K_IN` / `_OUT` | 1.08 / 28.8                      |

The defaults give exactly the earlier figures: Tier 1 is 0.05 / 1.5 units per 1k input / output tokens, and Tier 2 is 0.3 / 8.

The per-step reservation follows from the rates: 25k tokens of context plus 600 output tokens at the tier rate, rounded up. That's 3 units for Tier 1 and 13 for Tier 2. A settled turn charges the usage the endpoint reported (`prompt_tokens`, `completion_tokens`) at these rates, at least 1 unit.

To measure, run a fixed set of real turns per tier, divide the GPU-seconds used by the tokens, and set the variables. A value that isn't a positive number stops startup.

## Owner approval for consequential tools

`room_task_create` is a consequential tool (`CONSEQUENTIAL_TOOLS` in `server/elric/tools.ts`). A valid call isn't executed from model output.

- After the usual checks (allowlist, tasks enabled, invoking room, arguments) and the recheck under the locks, it becomes a pending action (`server/elric/pending.ts`). The action holds the exact validated arguments, their hash and an expiry of 15 minutes.
- The model gets a fixed tool result: `{"status":"pending_approval","pending_id":…,"text":"Waiting for the owner's approval …"}`. Nothing is created.
- The turn's outcome is `pending`, which migration 40 adds to the turn log's outcome check. The tool call is recorded as `refused_pending`.
- Approval (`POST /api/elric/pending/:id/approve` with `{ args_hash }`) works from the owner's console session only. It runs as follows:
  1. A locked transaction checks the hash, the expiry, the owner's eligibility and Elric's agent-bound access, then claims the action as `approved`.
  2. The stored arguments, validated again, are created through the tasks path. Eligibility and access are rechecked once more inside that create transaction, under the room lock. The idempotency key is the pending id, so a second approval never creates a second task.
  3. A paused Elric executes nothing, and the action stays pending. If creation fails afterwards (for example, room tasks were turned off), the action becomes `failed`.
  4. An action claimed `approved` whose execution never recorded a result (the process stopped in between) is swept to `failed` after 5 minutes. It's never re-executed.
- One run creates at most 3 pending actions (`maxPendingPerRun`); further calls are refused (`refused_cap`).

## Local end-to-end runs: `CITY_ELRIC_MOCK=1`

For the local server only, as used by the end-to-end suite. Elric then answers from the deterministic `MockAdapter` instead of an endpoint.

Startup refuses it on a deployment: with `VERCEL=1`, `CITY_HOSTED=1`, a hosted configuration, or `NODE_ENV=production`.

The mock's behaviour is deterministic:

- When the owner's message says `create a task: <title>`, the first step asks for `room_task_create` with `{ room_id: <the invoking room>, title: <title> }`. That call becomes a pending action, as above.
- Every other step, including the one after the tool result, answers `Mock reply.`.

## Tests

- `tests/elric-adapter.test.ts` runs the client against a local mock server (`tests/elric-model-server.ts`, 127.0.0.1 only). It covers success, tool calls, timeouts, 5xx and 503, malformed JSON, oversized responses and requests, no redirects, refused connections, the probe, endpoint configuration, and usage to units.
- `tests/elric-approval.test.ts` covers the approval gate: one pending action and no task, a `pending` turn, owner session only with the exact hash, executed once with the stored arguments, a pause blocks it, tasks off fails it, and expiry.
- `tests/elric-wake.test.ts` runs the real app end to end. It covers:
  - the run budget tied to `vercel.json`;
  - a reply with cost units and the configured-model label, and missing usage;
  - cold start deferred, then answered by a later drain;
  - giving up after `wakeMaxMs` (refunded);
  - a pause while deferred;
  - the time budget, before and after progress;
  - sent-but-failed calls charged, and a slow call cut at the remaining time;
  - a cut-off run settling its recorded spend;
  - the wake-drain cron retrying a deferred invocation;
  - the health probe.
