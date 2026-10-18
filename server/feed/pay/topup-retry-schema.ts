import { registerMigration, type Migration } from '../../migrations.js';

/**
 * Migration 129 `feed_pay_topup_retry` (126, 127 and 128 belong to other open changes): a Feed pay
 * call whose float top-up the bundler or paymaster refused ONLY for its rate (HTTP 429 or a 'busy'
 * answer) and that provably never left the server plans a new top-up later instead of ending
 * refused (server/feed/pay/engine.ts FEED_PAY_TOPUP_RETRY). Two columns on feed_pay_calls (a small
 * table); nothing live is rewritten.
 *
 * - topup_attempts: how often the call planned a top-up again (at most 3); 0 for every call so far.
 * - topup_retry_at: from when the next top-up may be planned (ms), set when the call goes back to
 *   'reserved' after a rate-limited one; no worker and no recovery run takes the call before it.
 */
export const FEED_PAY_TOPUP_RETRY_SQL = `
ALTER TABLE feed_pay_calls
  ADD COLUMN IF NOT EXISTS topup_attempts integer NOT NULL DEFAULT 0
    CHECK (topup_attempts >= 0 AND topup_attempts <= 3),
  ADD COLUMN IF NOT EXISTS topup_retry_at bigint;
`;

export const feedPayTopUpRetryMigration: Migration = {
  version: 129,
  name: 'feed_pay_topup_retry',
  sql: FEED_PAY_TOPUP_RETRY_SQL,
};

/** Idempotent; call before runMigrations (after 112, which creates feed_pay_calls). */
export function registerFeedPayTopUpRetryMigration(): void {
  registerMigration(feedPayTopUpRetryMigration);
}
