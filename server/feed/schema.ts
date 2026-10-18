import { registerMigration, type Migration } from '../migrations.js';

/**
 * Migration 103 `feed_requests` (Operation Central City Feed, week 1, shared/feed.ts): the
 * "Searched for" requests anyone may post, signed in or not. Migration 102 is the Offered side
 * (services); the two are independent.
 *
 * - `feed_requests`: one row per request. `state` is the server's own lifecycle ('held': stored
 *   but never listed, in review: `held_reason` honeypot, blocked source, risky text or a title
 *   spread across sites; 'removed': erased by an operator); `hidden_at` is set by reports or an
 *   operator. `reply` is the poster's optional PUBLIC reply handle (a checksummed Base address or
 *   an https link), erased at close and expiry; no email or phone number is stored. No client
 *   address is stored: `source_hash` and `site_hash` are keyed HMACs of the address scopes,
 *   `poster_key` is 'src:<source_hash>' (signed out) or 'op:<workspace id>' (signed in). The
 *   manage token and the idempotency key are stored as SHA-256 only. `search` is a generated
 *   tsvector (title A, description B) behind a partial GIN index over what lists can show
 *   (since migration 105 lists search an expression index that reads the tags too). Only
 *   visible open rows hold their text unique: a hidden copy never stops its poster posting again.
 * - `feed_request_reports`: one report per request and reporter address (hashed), with the
 *   reporter's site (/24, /56) and network (/16, /48): hiding needs distinct networks.
 * - `feed_source_blocks`: hashed sources an operator blocked (expiring).
 * - `feed_flags`: database switches that need no redeploy ('posting' false pauses new posts).
 */
/** The tables migration 103 adds (server/recovery.ts recognizes them, never exports them). */
export const FEED_REQUEST_TABLES = [
  'feed_requests',
  'feed_request_reports',
  'feed_source_blocks',
  'feed_flags',
] as const;

export const FEED_REQUESTS_SQL = `
CREATE TABLE IF NOT EXISTS feed_requests (
  id text PRIMARY KEY,
  state text NOT NULL CHECK (state IN ('open','held','closed','expired','removed')),
  title text NOT NULL,
  description text NOT NULL,
  capabilities text[] NOT NULL DEFAULT '{}',
  budget_raw bigint CHECK (budget_raw > 0),
  deadline_at bigint,
  reply text,
  poster_kind text NOT NULL CHECK (poster_kind IN ('anonymous','account','agent')),
  display_name text,
  owner_id text REFERENCES operators(id) ON DELETE SET NULL,
  agent_id text,
  poster_key text NOT NULL,
  source_hash text NOT NULL,
  site_hash text NOT NULL,
  content_key text NOT NULL,
  title_key text NOT NULL,
  manage_hash text NOT NULL UNIQUE,
  idempotency_hash text NOT NULL,
  held_reason text CHECK (held_reason IN ('honeypot','blocked','risk','spread')),
  hidden_at bigint,
  reviewed_at bigint,
  report_count integer NOT NULL DEFAULT 0,
  created_at bigint NOT NULL,
  expires_at bigint NOT NULL,
  closed_at bigint,
  search tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(description, '')), 'B')
  ) STORED
);
CREATE INDEX IF NOT EXISTS feed_requests_open ON feed_requests(created_at DESC, id DESC)
  WHERE state = 'open' AND hidden_at IS NULL;
CREATE INDEX IF NOT EXISTS feed_requests_search ON feed_requests USING gin(search)
  WHERE state = 'open' AND hidden_at IS NULL;
CREATE INDEX IF NOT EXISTS feed_requests_tags ON feed_requests USING gin(capabilities)
  WHERE state = 'open' AND hidden_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS feed_requests_content ON feed_requests(content_key)
  WHERE state = 'open' AND hidden_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS feed_requests_idem ON feed_requests(poster_key, idempotency_hash);
CREATE INDEX IF NOT EXISTS feed_requests_poster ON feed_requests(poster_key, created_at);
CREATE INDEX IF NOT EXISTS feed_requests_title ON feed_requests(title_key, created_at);
CREATE INDEX IF NOT EXISTS feed_requests_expiry ON feed_requests(expires_at) WHERE state = 'open';
CREATE INDEX IF NOT EXISTS feed_requests_ended ON feed_requests(closed_at)
  WHERE state IN ('closed','expired');
CREATE INDEX IF NOT EXISTS feed_requests_held ON feed_requests(created_at)
  WHERE state IN ('held','removed');
CREATE TABLE IF NOT EXISTS feed_request_reports (
  request_id text NOT NULL REFERENCES feed_requests(id) ON DELETE CASCADE,
  reporter_hash text NOT NULL,
  reporter_site text NOT NULL,
  reporter_network text NOT NULL,
  reason text NOT NULL CHECK (reason IN ('spam','scam','illegal','personal_data','other')),
  note text,
  created_at bigint NOT NULL,
  PRIMARY KEY (request_id, reporter_hash)
);
CREATE TABLE IF NOT EXISTS feed_source_blocks (
  source_hash text PRIMARY KEY,
  expires_at bigint NOT NULL,
  created_at bigint NOT NULL
);
CREATE TABLE IF NOT EXISTS feed_flags (
  name text PRIMARY KEY,
  enabled boolean NOT NULL,
  updated_at bigint NOT NULL,
  updated_by text NOT NULL
);
`;

export const feedRequestsMigration: Migration = {
  version: 103,
  name: 'feed_requests',
  sql: FEED_REQUESTS_SQL,
};

/**
 * Migration 105 `feed_requests_search_tags`: the Searched-for text search (?q=) reads the tags
 * too, so a request tagged 'ocr' is found by "ocr" even when its title and description never say
 * it. Nothing is added to the table and no row is rewritten.
 *
 * - `feed_request_text(title, description, tags)`: the title, the description and the tags
 *   joined with spaces, every dash made a space. Postgres reads "-8004" as a signed number, so
 *   'erc-8004' (a tag, or "ERC-8004 rating" in a title) would index '-8004', which no search word
 *   (letters and digits only) ever matches; split, it indexes 'erc' and '8004'. Declared
 *   IMMUTABLE (array_to_string is only STABLE) so an index can use it; for text[] the result
 *   never changes. Changing its body later needs a migration that also rebuilds the index
 *   (REINDEX): rows indexed under the old body are not recomputed.
 * - `feed_requests_text`: a GIN index over FEED_REQUEST_TEXT ('simple', like `search`) over what
 *   lists can show. Lists match the identical expression (server/feed/requests.ts), so the
 *   planner uses this index. Building it reads the table and blocks writes to it for that time
 *   only; reads go on. The tags carry no weight: lists order by time, never by rank.
 * - `search` and its index (103) stay as they are: an instance still running the previous build
 *   reads them. A later migration may drop both once no build reads them.
 *
 * Version 105: 103 is the Feed requests (#309), 104 the Feed services (#311).
 */
export const FEED_REQUEST_TEXT =
  "to_tsvector('simple', feed_request_text(title, description, capabilities))";

export const FEED_REQUEST_SEARCH_SQL = `
CREATE OR REPLACE FUNCTION feed_request_text(title text, description text, tags text[])
  RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $fn$
  SELECT translate(
    coalesce(title, '') || ' ' || coalesce(description, '') || ' ' ||
      coalesce(array_to_string(tags, ' '), ''),
    '-', ' ')
$fn$;
CREATE INDEX IF NOT EXISTS feed_requests_text ON feed_requests USING gin ((${FEED_REQUEST_TEXT}))
  WHERE state = 'open' AND hidden_at IS NULL;
`;

export const feedRequestSearchMigration: Migration = {
  version: 105,
  name: 'feed_requests_search_tags',
  sql: FEED_REQUEST_SEARCH_SQL,
};

/** Idempotent; call before runMigrations. Registers 103 and its search follow-up, 105. */
export function registerFeedRequestsMigration(): void {
  registerMigration(feedRequestsMigration);
  registerMigration(feedRequestSearchMigration);
}
