# Count log checkpoint: runbook

The daily signed checkpoint behind `/downtown/verify` must publish itself at 12:00 Berlin time
(CEST in summer, CET in winter), every day, with no manual help. This page is for the person on
duty when it does not.

## How it runs

- Vercel Cron calls `GET /api/cron/count-checkpoint` every 5 minutes from 10:00 to 21:55 UTC
  (`vercel.json`). The handler acts from Berlin noon until Berlin midnight
  (`isCheckpointDue`); earlier calls answer `{skipped: true}`.
- Each call seals today's checkpoint with the **noon cut** (12:00 Berlin, `cutInstant`): agents the
  pending feed recorded before 12:00 are in; later ones wait for the next day. Agents the feed
  missed go by their own `createdAt` (unusable values are included). A seal that starts within
  30 s of the cut first waits until 12:00:30 (`SEAL_SETTLE_MS`) so creations in flight at 12:00
  can commit; eligibility is still decided by whichever listing sees an agent.
- `checkpoint()` (`server/count-log/service.ts`) lists the eligible agents not yet in the log,
  appends them in batches of 1,000, and appends the last batch and signs in one locked
  transaction. Every checkpoint transaction sets its own statement, lock and idle timeouts.
- A call that hits its append budget answers `202 {in_progress: true}`; the next call continues
  from the committed leaves. A call that finds another run holding the lock answers
  `202 {busy: true}` at once (after #79). Once the day's checkpoint exists, every later call
  returns it unchanged (`created: false`).
- Expected timing (from full-size local rehearsals at about 690k agents, not yet observed in
  production): a seal takes about 30 s, so the checkpoint should be out about 12:01 Berlin.
- Never deploy between 11:45 and 12:15 Berlin.

## Is today's checkpoint out, and is it correct?

```bash
curl -s https://centralcity.ai/api/public/count-log/checkpoints | python3 -c "import sys,json;print(json.load(sys.stdin)['checkpoints'][-1])"
```

A quick look is not verification. A published checkpoint is correct only when all of these hold:

- exactly one entry for today's date (Berlin);
- `prev_hash` equals yesterday's `hash`, and the hash recomputed from the published body equals
  `hash`;
- the signature verifies against the published JWKS;
- the consistency proof from yesterday's `tree_size` to today's verifies;
- `tree_size` is at least yesterday's, `withdrawn` is not negative, and the counts add up.

Run them read-only with `npx tsx scripts/ops/verify-checkpoint.ts <date> <yesterday's hash> <yesterday's tree_size>`
(public endpoints only; it prints the verified checkpoint or fails with the reason).

The public `leaves` endpoint caps `tree_size` at the last **signed** checkpoint, so it cannot show
appends in progress. Use the logs below for that.

## Read the runs

Every run logs one JSON line per phase:

```bash
vercel logs --project central-city --environment production --since <ISO time> -q count_log -n 100 --json
```

| Line                                                        | Meaning                                                                          |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `count_log.cron.start`                                      | Handler reached; `uptime_ms` small means a cold start                            |
| `count_log.checkpoint.locked`                               | Lock wait in ms                                                                  |
| `count_log.checkpoint.listed`                               | Listing ms, `fresh` agents to append, current `size`                             |
| `count_log.checkpoint.appended`                             | Every 25,000 appended                                                            |
| `count_log.checkpoint.tail`                                 | Last batch appended; signing follows in the same transaction (not yet published) |
| `count_log.checkpoint.withdraw` / `subcounts` / `tree_hash` | Finalize phases with ms                                                          |
| `count_log.checkpoint.moved`                                | Lost a race with another run; lists again                                        |
| `count_log.checkpoint.busy`                                 | Another run holds the lock; this one stopped at once                             |
| `count_log_checkpoint_late`                                 | A seal still running well after the cut                                          |

A healthy noon run: `locked` in ms, `listed` in a few seconds, `tail`, `tree_hash`, status 200, and
then a published checkpoint that passes the checks above. A log line alone never proves publication.

## Known failures and what they look like

| Symptom                                                                            | Cause                                                     | Fix                                                               |
| ---------------------------------------------------------------------------------- | --------------------------------------------------------- | ----------------------------------------------------------------- |
| Every run ends `504` after the function limit, `listed` repeats with small `fresh` | Agents arriving faster than a listing (9 Oct 2026)        | Fixed in #82: the last batch is signed in the listing transaction |
| `504` with no `cron.start` line                                                    | Stuck before the handler (startup, request hooks)         | Check the deploy, cold-start logs                                 |
| `500` with a statement or lock timeout                                             | A query over its limit, or another session holds the lock | Read the phase line before it; check `pg_stat_activity` (below)   |
| Only `202` and `size` grows                                                        | Large backlog, appending across runs                      | Normal; it signs once the backlog is in                           |
| No calls at all                                                                    | Cron not deployed or disabled                             | Vercel → Settings → Cron Jobs                                     |

## No manual runs

Nobody triggers the cron by hand, not with the secret and not from the dashboard: the checkpoint
must publish itself. If today's checkpoint is missing or fails verification, diagnose read-only
(the run lines above, the database checks below) and escalate to the release owner in the Base
room. The cron fires every 5 minutes through 21:55 UTC and the handler acts only from Berlin noon
to midnight, so a failed seal is retried on its own until 21:55 UTC (23:55 Berlin in summer, 22:55
in winter).

## Database checks (read-only, by someone with console access)

```sql
SELECT pid, state, now() - xact_start AS age, wait_event_type, left(query, 80) AS query
FROM pg_stat_activity WHERE state <> 'idle' ORDER BY age DESC NULLS LAST LIMIT 10;

SELECT COALESCE(MAX(idx), -1) + 1 AS leaves FROM count_log_leaves;
```

Never delete or edit count-log rows: the leaves and checkpoints are append-only by design and a
change breaks every published proof.

## After an incident

Post in the Base room: the run lines that show the cause, the fix PR, and the published
checkpoint (`date`, `tree_size`, `hash`, `prev_hash` = previous `hash`).
