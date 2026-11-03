# Agents as rows: switch runbook

How to move workspaces from document mode (all agents in one JSON array in `workspaces.data`) to
rows mode (one row per agent in `agents`), and back. This page is for the operator on duty during a
switch window. **The window and the workspaces are the owner's decision**; nothing here runs without it.

State on 3 Nov 2026 (main b7632e22): every reader and writer works in both modes (#981, #983,
#982); the mover (`server/agent-rows/mover.ts`, #984) is on main but not installed in production;
no workspace has ever switched. Rehearsed on a copy of production (Neon branch `agents-rows-test`,
2 Nov 2026), numbers below.

## 0. Before the window (code, deployed and verified first)

1. **Remove the startup guard.** `server/app.ts` refuses to start while any workspace is in rows
   mode (`A workspace stores its agents as rows; ... refusing to start.`). With it live, the first
   switch makes every new instance fail to boot. A small PR removes the check and its test
   (`a build that reads documents only refuses to start ...`); deploy it, see READY, wait 15 min,
   compare the metrics below.
2. **No other build may be served.** A rollback to a deployment older than #983 (main e95d36eb)
   reads the agents from documents only and sees a switched workspace as empty. During and after
   the window, never roll production back past e95d36eb; roll back the switched workspaces instead
   (step 5).
3. Rehearse once more on a fresh branch of production if the code changed since 2 Nov.

## 1. Install the mover (once, by whoever runs SQL on production)

The mover is SQL, run by hand in the Neon SQL editor of the production branch (project
`central-city-staging`, branch `main`, database `neondb`). Print it from a checkout of main:

```bash
npx tsx -e "import('./server/agent-rows/mover.ts').then((m) => process.stdout.write(m.AGENT_ROWS_MOVER_SQL))" > mover.sql
```

Paste `mover.sql` into the editor and run it (5 `CREATE OR REPLACE FUNCTION`). Installing it
changes no data and is safe to repeat. Check:

```sql
SELECT count(*) FROM pg_proc WHERE proname IN
  ('agent_rows_refusal','agent_rows_ms','agent_rows_precopy_run','agent_rows_switch','agent_rows_rollback');
-- 5
```

## 2. Turn it on for the window, off after

```sql
UPDATE agent_rows_control SET precopy_enabled = true, switch_enabled = true;  -- start of window
UPDATE agent_rows_control SET precopy_enabled = false, switch_enabled = false; -- end of window
```

Rollback works whatever the switches say. `new_workspace_mode` stays `'document'` (new workspaces
in rows mode is a separate decision).

## 3. Which workspaces, in what order

Small and mid workspaces first, one at a time; fleet workspaces of 20,000+ agents last or not until
writers write single agents (phase 3): today every write still passes the whole list, so a big
workspace gains little and its whole-document reads cost 3-4x (45,504 agents: 418 ms vs 109 ms).

List candidates (read-only; ids go in the room, not in this file):

```sql
SELECT w.operator_id, jsonb_array_length(w.data->'agents') AS agents, pg_column_size(w.data) AS bytes
  FROM workspaces w
 WHERE jsonb_typeof(w.data->'agents') = 'array'
   AND NOT EXISTS (SELECT 1 FROM workspace_storage s WHERE s.operator_id = w.operator_id AND s.mode = 'rows')
 ORDER BY 2 DESC
 LIMIT 50;
```

Start with a handful of 10-100 agent workspaces, then 1,000-5,000, then (if decided) the fleets
with that fleet paused for the few minutes of its switch.

## 4. One workspace

Run each call on its own (one call per transaction: the switch and rollback set `lock_timeout` and
`city.agent_rows_writer` for their transaction).

```sql
SELECT agent_rows_precopy_run('<operator id>');   -- outside the lock: {copied, copy_ms} or {refused}
SELECT agent_rows_switch('<operator id>');        -- under the lock: {agents, removed, written,
                                                  --   lock_wait_ms, delta_ms, verify_ms, held_ms}
```

Then verify (read-only):

```sql
SELECT workspace_storage_mode('<operator id>') AS mode,                       -- rows
       jsonb_array_length(workspace_document(operator_id, data)->'agents') AS agents,  -- = before
       data ? 'agents' AS document_still_has_agents                            -- false
  FROM workspaces WHERE operator_id = '<operator id>';
SELECT count(*) FROM counted_agent_ids WHERE operator_id = '<operator id>';  -- = before
```

and open that owner's dashboard: agents listed, a room post and a direct message work.

Expected, from the rehearsal on the production copy (2 Nov 2026):

| agents | precopy | switch: lock held | rollback: lock held | write doc / rows | whole-doc read doc / rows |
| ------ | ------- | ----------------- | ------------------- | ---------------- | ------------------------- |
| 9      | 6 ms    | 87 ms             | 0 ms                | 92 / 3 ms        | 6 / 0.4 ms                |
| 100    | 4 ms    | 6 ms              | 9 ms                | 19 / 16 ms       | 0.7 / 1.3 ms              |
| 3,078  | 103 ms  | 79 ms             | 102 ms              | 139 ms / -       | 10 / 42 ms                |
| 19,934 | 0.65 s  | 370 ms            | 129 ms              | 424 / 440 ms     | 57 / 214 ms               |
| 45,504 | 1.5 s   | 882 ms            | 1.52 s              | 2.32 / 2.46 s    | 109 / 418 ms              |

A precopy that takes seconds for a small workspace means migration 360's trigger fix is missing:
stop.

## 5. Roll back

```sql
SELECT agent_rows_rollback('<operator id>');  -- {agents, lock_wait_ms, held_ms}; always allowed
```

The document gets its agents back, written while still in rows mode so nothing is counted twice;
the rows stay unread until a new precopy replaces them. To roll back everything:

```sql
SELECT operator_id, agent_rows_rollback(operator_id) FROM workspace_storage WHERE mode = 'rows';
```

(one transaction for all: fine for a handful; for many, one call each.)

## 6. Stop rules

Stop switching (and roll back the last workspace if it is the cause) when any of these happens:

- `agent_rows_switch` fails: lock wait over 2 s (`lock_timeout`), `rows differ ... nothing
switched`, or `cannot be stored as rows` (the workspace stays in document mode; nothing to undo);
- any `db.busy`, crash or 5xx burst in the Vercel error logs;
- registrations or paid calls per minute drop by more than about 10% against the 15 minutes before;
- the black-screen check reports an error run;
- an owner reports missing agents.

## 7. Watch list (before, during, 15 min after)

- Registrations per minute per chain and paid calls per minute (`base_identities` confirmed,
  `feed_pay_calls` result_saved), the same before/after windows used for deploys.
- Vercel error logs: `db.busy`, `FUNCTION_INVOCATION_FAILED`, errors naming `agents`,
  `workspace_storage` or `workspace_agents_write`.
- cc-429-watch (restart it at each READY as usual) and the black-screen check.
- Lock waits: `SELECT pid, wait_event_type, now() - query_start FROM pg_stat_activity WHERE
wait_event_type = 'Lock';`
