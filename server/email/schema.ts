import { registerMigration, type Migration } from '../migrations.js';

/**
 * Migration 76 (docs/EMAIL.md):
 * - `email_outbox`: transactional emails waiting to be sent. One row per `dedupe_key` (for
 *   example `welcome:<account>`), so an email is queued at most once; sent from the drain with
 *   retry and backoff, never inside a sign-up request.
 * - `newsletter_consents`: one row per account: the address, the exact opt-in text version, the
 *   source, and when it was given, confirmed (double opt-in) and withdrawn. Only confirmed and
 *   not withdrawn addresses are subscribers.
 * - `newsletter_consent_events`: every consent change, append-only (a trigger refuses UPDATE,
 *   DELETE and TRUNCATE, except the retention purge of records past their retention period).
 * The outbox and the subscription cascade with the account. The consent events do not: they
 * are the proof of consent, kept 2 years at most after the last change (docs/EMAIL.md).
 */
export const EMAIL_TABLES = [
  'email_outbox',
  'newsletter_consents',
  'newsletter_consent_events',
] as const;

export const EMAIL_MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS email_outbox (
  id bigserial PRIMARY KEY,
  operator_id text NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
  dedupe_key text NOT NULL UNIQUE CHECK (char_length(dedupe_key) BETWEEN 1 AND 200),
  kind text NOT NULL CHECK (kind IN ('welcome','newsletter_confirm')),
  to_email text NOT NULL CHECK (char_length(to_email) BETWEEN 3 AND 320),
  subject text NOT NULL,
  body text NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at bigint NOT NULL,
  sent_at bigint,
  failed_at bigint,
  last_error text,
  created_at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS email_outbox_due ON email_outbox(next_attempt_at)
  WHERE sent_at IS NULL AND failed_at IS NULL;
CREATE TABLE IF NOT EXISTS newsletter_consents (
  operator_id text PRIMARY KEY REFERENCES operators(id) ON DELETE CASCADE,
  email text NOT NULL CHECK (char_length(email) BETWEEN 3 AND 320),
  text_version text NOT NULL CHECK (char_length(text_version) BETWEEN 1 AND 64),
  source text NOT NULL CHECK (source IN ('signup','onboarding','settings')),
  opted_in_at bigint NOT NULL,
  confirmed_at bigint,
  unsubscribed_at bigint
);
CREATE TABLE IF NOT EXISTS newsletter_consent_events (
  id bigserial PRIMARY KEY,
  operator_id text NOT NULL,
  event text NOT NULL CHECK (event IN ('opt_in','confirm','unsubscribe','expired')),
  email text NOT NULL,
  text_version text NOT NULL,
  source text NOT NULL,
  at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS newsletter_consent_events_operator ON newsletter_consent_events(operator_id, at);
CREATE INDEX IF NOT EXISTS newsletter_consents_unconfirmed ON newsletter_consents(opted_in_at)
  WHERE confirmed_at IS NULL AND unsubscribed_at IS NULL;
CREATE OR REPLACE FUNCTION newsletter_consent_events_append_only() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  -- The retention purge (server/email/index.ts purge) of records past their retention period.
  IF TG_OP = 'DELETE' AND current_setting('newsletter.purge', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'newsletter_consent_events is append-only';
END;
$$;
DROP TRIGGER IF EXISTS newsletter_consent_events_append_only ON newsletter_consent_events;
CREATE TRIGGER newsletter_consent_events_append_only
  BEFORE UPDATE OR DELETE ON newsletter_consent_events
  FOR EACH ROW EXECUTE FUNCTION newsletter_consent_events_append_only();
DROP TRIGGER IF EXISTS newsletter_consent_events_no_truncate ON newsletter_consent_events;
CREATE TRIGGER newsletter_consent_events_no_truncate BEFORE TRUNCATE ON newsletter_consent_events
  FOR EACH STATEMENT EXECUTE FUNCTION newsletter_consent_events_append_only();
`;

export const emailMigration: Migration = {
  version: 76,
  name: 'email_newsletter',
  sql: EMAIL_MIGRATION_SQL,
};

/** Migration 77: the HTML part next to the text body (null for rows queued before it). */
export const emailHtmlMigration: Migration = {
  version: 77,
  name: 'email_outbox_html',
  sql: 'ALTER TABLE email_outbox ADD COLUMN IF NOT EXISTS html text;',
};

export function registerEmailMigration(): void {
  registerMigration(emailMigration);
  registerMigration(emailHtmlMigration);
}
