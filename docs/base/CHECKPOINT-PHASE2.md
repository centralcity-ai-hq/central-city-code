# Checkpoint phase two: durable ordering and incremental sealing

Status: design proposal, not implemented or approved for deployment. Two independent
reviewers are required. No runtime, migration, scheduler or count-policy change
before A11 completes and the release lead authorizes the next phase.

## Existing behavior and the failure to avoid

`server/count-log/pending.ts` records fingerprints in the workspace transaction,
using a sequence and application creation time. The recorder catches failures.
`server/count-log/service.ts` scans workspace documents, applies the noon cut,
appends batches and then streams all leaves to build the root and consistency
proof (`server/count-log/tree.ts`). Its fallback can discover an agent later.

Neither createdAt nor recorded_at is a commit timestamp. A transaction can write
before noon and commit after the listing; a backdated agent can appear after a
cursor has advanced. Waiting 30 seconds reduces a race window, but does not close
it. Likewise nextval values can commit out of order or be abandoned. Never advance
a durable cursor to MAX(seq) on the assumption that all lower numbers are visible.

References: [PostgreSQL sequence semantics](https://www.postgresql.org/docs/17/functions-sequence.html)
and [transaction-held locks](https://www.postgresql.org/docs/17/explicit-locking.html).

## Proposed ordering fence

Use a dedicated journal and a singleton transactional counter, not a SQL sequence.
Every count-affecting writer locks the counter before its first relevant mutation,
increments it and records its events in the SAME transaction. The counter lock
remains held through commit. A later writer cannot obtain a later ordinal until
the earlier transaction ends; rollback removes both events and counter increment.
Within a transaction, order events by a stable event ordinal.

The fence producer takes the same lock and commits a uniquely keyed day marker
with the current event ordinal. Once the marker is visible, every event at or
below its watermark is committed and no future writer can insert below it.
Consumers use READ COMMITTED statements after lock acquisition; do not reuse an
older snapshot established before waiting. Unique day markers make retries return
the original boundary, never silently move it forward.

All participating write paths must follow counter -> workspace lock order. This
includes creation, removal, revocation, operator-kind changes and exclusion-policy
changes affecting checkpoint totals. A trigger reached only AFTER a workspace row
lock is insufficient to establish this global lock order. Audit every writer and
bulk import; disallow bypass roles in application credentials. The reliable journal
must fail the source transaction if recording fails, unlike the current best-effort
pending feed. This availability tradeoff needs explicit approval and measurement.

The consumer can append committed journal prefixes continuously before noon.
Atomically commit leaves, processed watermark, eligibility projection and tree
frontier. Journal progress is not leaf count: excluded/non-creation events can
advance the former without adding a leaf. Preserve existing salts and fingerprints,
and never reorder or rewrite the already published prefix.

## Noon semantics: decided (Option A)

**Decision, 10 Oct 2026 (product owner):** Option A. The daily checkpoint is a logical
cut requested at 12:00 Berlin time. Option B is rejected.

Current behavior (live today, until phase two ships):

- Membership is listing-time eligibility: an agent counts in a day when it is
  committed and eligible when that day's seal lists it. An agent whose creating
  transaction is still open at the seal is not in that day's checkpoint; it is
  included once in a later day's checkpoint if it is still eligible and that seal
  succeeds (covered by the real two-session test in the postgres-races job).

Phase-two membership (after this design ships):

- A day's checkpoint contains exactly the committed journal prefix up to and
  including that day's persisted fence watermark. This differs from listing-time
  eligibility: a transaction that commits after the fence but before a consumer
  lists it belongs to the next day, not the current one.
- Every fence must persist, internally and immutably, the requested boundary time,
  the actual boundary time and the watermark (requested_at, actual_at, watermark).
  These are required for operations and audit.

For both:

- The public page keeps its current form. The History heading already states that a
  checkpoint is published every day at 12:00 Berlin time; no per-checkpoint cut time
  is added to the table and no new public field is introduced.
- No checkpoint, page or document may describe the count as "every agent created
  before 12:00:00". It is the count at the noon cut.
- Existing checkpoints are not rewritten.

Historical record (non-operative since the decision), the options as they were put to
the product owner:

- Option A: a linearizable logical fence requested at noon, with actual boundary
  time disclosed and a separately agreed publication-latency SLO. Superseded by the
  decision above: the actual boundary time is recorded internally, not published.
- Option B: all-and-only qualifying commits before exactly noon. Rejected; the
  implementation block that applied to it no longer applies.

The decision does not change the current A11 acceptance criteria. Exact publication at
12:00 and exact membership at 12:00 are separate requirements; neither follows
automatically from a safe ordering fence.

A transaction holding the sequencer across noon can delay the fence. A delayed cron
can also admit post-noon events before it takes the fence. Consequently this design
ALONE guarantees a linearizable journal boundary, NOT all-and-only commits before
12:00:00 Europe/Berlin, and NOT zero-latency publication at noon.

Recommended first deliverable: explicitly documented logical-fence semantics, with
scheduled noon attempt, recorded requested/actual boundary times and bounded
publication latency. Do not relabel a late fence as an exact noon snapshot. If exact
wall-clock commit membership is mandatory, reject this simplification and design a
durable commit-observation mechanism or an at-noon snapshot with durable membership
capture before implementation. A finite settle delay is not that mechanism.

Do not promise bounded latency without bounded write transaction duration and a
measured backlog budget. Use transaction/lock timeouts and retry the same day job;
never publish a partial prefix as the completed daily checkpoint. Do not silently
abort unrelated production transactions to meet the deadline.

An xmin-safe watermark alternative needs full transaction IDs, snapshot visibility
and complete source capture. A long-running oldest transaction can stall it, and a
safe prefix alone does not identify exactly the noon membership set. It is not a
drop-in filter on existing bigserial rows. Evaluate separately if serialization
cost makes the counter unacceptable.

## Stored Merkle frontier and proof nodes

Persist tree size, frontier peaks and version under one checkpoint-writer lock.
For each new leaf, merge equal-sized peaks with existing RFC 6962 node hashing;
fold remaining peaks right-to-left for the root. Store every newly completed
aligned subtree keyed by start index and height. A frontier alone cannot answer
arbitrary historical inclusion/consistency proofs; the node index is required.
Use existing proof algorithms as the oracle and compose non-perfect ranges from
aligned nodes. Never change leaf encoding, hash separation or checkpoint signing
bytes as an incidental optimization.

Appending k leaves costs amortized O(k) hashing plus logarithmic frontier state;
seal root construction is O(log n), without scanning all leaves. Proof generation
must use the node index, not fall back to an unbounded full-tree scan. Missing or
inconsistent nodes block publication. Check persisted size against leaf prefix and
watermark; CAS/version guards reject stale worker updates. Checkpoint body, hash,
signature, predecessor and publication row are immutable and atomically published.

The current seal generates a fresh subcounts commitment salt before signing.
With separate jobs, persist a private prepared body, salt, signing-key identifier,
predecessor and watermark once, before requesting a signature. Retried signing
must reuse that exact body. An uncommitted preparation may be regenerated, but
must never have been exposed or signed externally. Publishing rechecks predecessor
and prepared-body hash under the writer lock, then inserts the complete checkpoint
atomically. A preparation is not a public checkpoint. Preserve salt/subcount
privacy; no new public projection may expose this private recovery state.

## Split bounded jobs

1. Journal consumer: short resumable append/projection transactions all day.
2. Fence producer: idempotent Berlin-day boundary, separately authorized cron.
3. Seal worker: drain exactly through frozen watermark, compute proof/root and sign
   immutable body. Check prior-day chain and unique day before publication.
4. Read-only verifier: validate published signature, chain, root and consistency;
   it never creates a replacement checkpoint or manually invokes the seal.

Separate function time budgets, least-privilege authentication and durable cursors.
No in-memory leases as correctness boundaries. Retry unknown outcomes by reading
the durable job before repeating writes. Cron frequency is not evidence of an
exact invocation time. Retain deployment blackout and existing A11 procedure.

## Migration and provenance

After A11, build frontier/node index from the immutable existing prefix in bounded
restartable batches; compare every retained checkpoint root/proof independently.
Establish journal coverage with a reviewed writer barrier and consistent bootstrap
snapshot. Do not scan concurrently and call the result complete without proving
the snapshot/change overlap has no gaps. Shadow-consume first; enable sealing only
after parity and failure-injection tests. Rollback disables new sealing but retains
published history, journal and recovery state; never truncate or rewind the log.

Checkpoint count semantics and user-adoption claims are separate. Keep accurate creation
provenance (who created an agent, and how) for every leaf. Which agents count in which
public number is the product owner's policy decision, not part of this design; this optimization must not
change labels, exclusions or counting policy, and does not certify the current rules. Freeze
the applicable policy version with each boundary and journal policy transitions.

## Acceptance tests

- Real PostgreSQL independent sessions: first writer pauses before commit; second
  writer and fence contend. Prove no watermark skips the first event; rollback
  leaves no phantom event. Include reversed workspace acquisition and deadlock retry.
- Backdated creation, missing/malformed timestamps, transaction started before noon
  but committed after, late cron, and transaction spanning midnight: assert chosen
  semantics explicitly, including rejection of an exact-noon claim when not met.
- Kill after source write, journal insert, append, frontier update, signing and
  publication. Restart produces one checkpoint with identical bytes and no gaps.
- Trigger failure, unjournaled writer, excluded operator, withdrawal, revocation,
  operator-kind and policy changes: checkpoint projection remains boundary-consistent.
- Frontier/node oracle comparisons for empty, singleton, powers of two and adjacent
  sizes, randomized batches and all historical proof endpoints; corrupt nodes block.
- Berlin spring/fall DST transitions, delayed invocation, duplicate invocation and
  UTC date mismatch: one Berlin-day marker, explicit actual boundary timestamp.
- Benchmark realistic backlog and long writer contention on isolated authorized
  infrastructure. CI includes real-session races; PGlite alone is insufficient.

Release gates: accepted noon semantics, complete writer inventory, measured lock
overhead, migration parity, independent review, full green CI, then staged rollout
and live read-only verification. This document authorizes none of those executions.
