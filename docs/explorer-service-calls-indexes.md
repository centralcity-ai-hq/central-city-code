# Service calls explorer: indexes to add later

The Agent Explorer's Service calls view (`/explorer/calls`, `GET /api/public/explorer/calls`,
`server/base/explorer/calls.ts`) ships **without a migration**. `feed_pay_calls` is the payment
table under live load, and any index on it needs the product owner's approval first.

## What the reads use today

- **Newest page and older pages:** the partial index `feed_pay_calls_paid` (migration 120,
  `(wallet_id, settled_at) WHERE payment_state = 'settled' AND tx_hash IS NOT NULL`), with
  `settled_at` bounded from below (the newest page by the `paid_call_count.recent` block times,
  an older page by its cursor minus one hour). Measured on 60,000 settled calls: 0.5 ms through
  the index against 62 ms for the unbounded scan.
- **Total and Per minute:** the `paid_call_count` row (one primary-key read, shared with
  `/api/public/stats`).
- **Last 24 h and Services used:** one aggregate over the last day's settled calls, at most once a
  minute per server, 3 s limit. A sequential scan today (32 ms on 60,000 rows).
- **Search (tx hash, block, address):** no matching index. A scan of the settled calls, 2 s limit,
  cached 5 s per search, rate limited per client address.

## Proposed indexes (for approval)

Each one is partial on settled calls only and built `CONCURRENTLY`. A migration runs inside one
transaction (`server/migrations.ts`), where `CONCURRENTLY` is not allowed, so these need a
one-off script or a migration runner change, not a plain migration.

```sql
-- Newest-first listing and the 24 h numbers, for every pay_kind, without the bound trick.
CREATE INDEX CONCURRENTLY IF NOT EXISTS feed_pay_calls_settled_recent
  ON feed_pay_calls (settled_at DESC, tx_hash DESC)
  INCLUDE (chain_id, service_id)
  WHERE payment_state = 'settled' AND tx_hash IS NOT NULL;

-- Search by transaction hash and by block.
CREATE INDEX CONCURRENTLY IF NOT EXISTS feed_pay_calls_settled_tx
  ON feed_pay_calls (tx_hash) WHERE payment_state = 'settled';
CREATE INDEX CONCURRENTLY IF NOT EXISTS feed_pay_calls_settled_block
  ON feed_pay_calls (settled_block) WHERE payment_state = 'settled';

-- Search by provider address.
CREATE INDEX CONCURRENTLY IF NOT EXISTS feed_pay_calls_settled_pay_to
  ON feed_pay_calls (lower(pay_to)) WHERE payment_state = 'settled';

-- Search by payer address (the paying wallet's spender account).
CREATE INDEX CONCURRENTLY IF NOT EXISTS base_wallets_spender_lower
  ON base_wallets (chain_id, lower(spender_address));
```

The first one is the one that matters for load; the search indexes can wait until searches show
up in the database's slow query log.
