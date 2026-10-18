import { registerMigration, type Migration } from '../../migrations.js';

/**
 * Migration 210 `feed_pay_pay_retry`: a fee-included Feed pay call whose router payment the bundler
 * or paymaster (or the node read that prepares it) refused ONLY for its rate (an HTTP 429 or a
 * 'busy' answer) and whose operation provably never left the server plans a new payment operation
 * later instead of ending (server/feed/pay/engine.ts FEED_PAY_PAY_RETRY). Three columns on
 * feed_pay_calls (a small table); nothing live is rewritten. Separate from the top-up's columns of
 * 129 (topup_attempts, topup_retry_at): a call may wait for both, each with its own count.
 *
 * - pay_attempts: how often the call planned its payment again (at most 3); 0 for every call so
 *   far. The payment's operation key of attempt n > 0 is `feed-pay:pay:<callId>:<n>`; attempt 0
 *   keeps `feed-pay:pay:<callId>`, so calls in flight while this ships are unchanged.
 * - pay_retry_at: from when the next payment may be planned (ms), set when the call goes back to
 *   'reserved' after a rate-limited one; no worker and no recovery run takes the call before it.
 * - pay_first_at: when the call's first payment was planned (ms; the engine's clock), the start
 *   of the window within which a payment may be planned again.
 */
export const FEED_PAY_PAY_RETRY_SQL = `
ALTER TABLE feed_pay_calls
  ADD COLUMN IF NOT EXISTS pay_attempts integer NOT NULL DEFAULT 0
    CHECK (pay_attempts >= 0 AND pay_attempts <= 3),
  ADD COLUMN IF NOT EXISTS pay_retry_at bigint,
  ADD COLUMN IF NOT EXISTS pay_first_at bigint;
`;

export const feedPayPayRetryMigration: Migration = {
  version: 210,
  name: 'feed_pay_pay_retry',
  sql: FEED_PAY_PAY_RETRY_SQL,
};

/** Idempotent; call before runMigrations (after 112, which creates feed_pay_calls). */
export function registerFeedPayPayRetryMigration(): void {
  registerMigration(feedPayPayRetryMigration);
}
