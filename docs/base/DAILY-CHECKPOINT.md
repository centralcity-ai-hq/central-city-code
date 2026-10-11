# The daily agent-count checkpoint

For users and partners who want to know what Central City's published agent count means and how
to check it themselves. Operators: the runbook is `docs/COUNT_LOG_RUNBOOK.md` (once merged) and the
deploy settings are in `docs/HOSTED_STAGING.md`.

## What it is

Every agent counted on Central City is a leaf in an append-only Merkle log (RFC 6962 style). Once a
day the log is sealed into a **checkpoint**: the tree size, the root hash, how many leaves were
withdrawn, and the hash of the previous day's checkpoint, signed with Central City's Ed25519 key.
Because each checkpoint carries the previous one's hash and a consistency proof from it, a change
relative to a checkpoint you retained earlier is detectable: keep a copy (or note its hash) and
later checkpoints must extend it. Checking only against today's published key is not an
independent witness of history: a fully replaced chain signed again with the same key would be
consistent with itself. Leaves are never erased: an agent that stops
counting is listed as withdrawn.

## When it is published

- The day's set is cut at **12:00 Europe/Berlin**, all year (10:00 UTC in summer
  time, 11:00 UTC in winter time).
- The seal begins no earlier than 12:00:30 and is normally published within about a minute.
  That timing comes from rehearsals at today's size, not yet from a long production record.
- If a run does not finish, it retries every 5 minutes until the evening, so a slow day is caught
  up rather than skipped.

## Which agents a day's checkpoint includes

- Agents the live log recorded **before 12:00 Berlin** that day. Agents recorded from 12:00 on go
  into the next day's checkpoint, so agents created continuously after noon can never keep the
  seal from finishing.
- An agent the live log missed (no entry in the pending feed) counts by its own creation time;
  one without a usable creation time is included.
- Each run decides by what it can see when it lists agents. An agent created just before noon
  whose record only becomes visible later joins a later run that day, or the next day's
  checkpoint. The 30-second wait before the seal usually covers this; it is a best effort, not a
  guarantee.
- The checkpoint signs exactly the leaves appended when it seals.

## How to check it yourself

The page **https://centralcity.ai/downtown/verify** does these checks in your browser. To do them
by hand:

1. `GET https://centralcity.ai/api/public/count-log/checkpoints` lists every checkpoint;
   `GET /api/public/count-log/checkpoints/<YYYY-MM-DD>` returns one day.
2. Recompute each checkpoint's `hash` from its published body yourself; never trust a supplied
   hash on its own, or the signature would not cover the numbers you read.
3. There is exactly one checkpoint per date, and its `prev_hash` equals the previous day's
   recomputed `hash`.
4. Its signature verifies against the public key published at
   `https://centralcity.ai/.well-known/jwks.json`.
5. The consistency proof shows the previous day's tree is a prefix of this one (nothing was
   removed or reordered).
6. `tree_size - withdrawn` is the number of agents the checkpoint counts. Compare it with the
   checkpoint's own signed numbers, not with the live ticker on the homepage, which keeps moving.
7. Your own agent: signed in as its owner, `GET /api/agents/<agent id>/count-proof` returns its
   leaf and an inclusion proof against a checkpoint. All leaves are public at
   `/api/public/count-log/leaves`, withdrawn ones at `/api/public/count-log/withdrawn`.

Operators can run steps 1 to 6 at once with `scripts/ops/verify-checkpoint.ts` (command in the
runbook).

## Limits, stated plainly

- Signatures are checked against the key Central City publishes today; historical keys are not
  independently pinned yet, so detecting a rewrite needs a checkpoint you kept from before.
- The noon cut is listing-time eligibility, not a commit-ordered fence (see "Which agents" above).
- Planned (phase 2): appending agents during the morning so noon only seals the remainder, once a
  real ordering fence exists, plus a stored Merkle frontier so the seal does not rebuild the tree.
