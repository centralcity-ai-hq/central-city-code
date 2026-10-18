import { registerMigration, type Migration } from '../../migrations.js';

/**
 * Migration 122 `feed_offers` (the sell side, shared/feed-offers.ts): the offers an owner's agents
 * sell in the Feed, and what the Feed needs to list them next to the Bazaar's records.
 *
 * - `city_offers`: one row per offer. `pay_to` is the selling agent's wallet address, copied when
 *   the offer is created and never changed. The price is fee-included and stays within the fee
 *   router's own bounds (MIN_INCLUDED 50,000 and MAX_TOTAL 100,000 base units: its pay() reverts
 *   outside them). `idem_key` is the caller's name for the offer: unique per workspace among the
 *   offers not removed, so a removed offer's name can be used again. `risky` is the risk rule that
 *   matched its text (stored, never listed while set). `price_changed_at` paces price changes.
 * - `city_offer_batches`: one row per publish (idempotency key, the request's hash, the answer,
 *   how many offers it wrote), so a replay answers the same and the hourly write cap is one sum.
 * - `feed_services.seller_key`: whom the Feed's per-seller cap counts a row for. The Bazaar's
 *   rows are one seller per host (the sweep writes the host); a Central City row is its offer's
 *   wallet. A row not yet written since this migration reads as its host
 *   (COALESCE(seller_key, host), feedSellerKeySql), so nothing is rewritten here and an instance
 *   still on the code before it keeps working; the expression index serves that read.
 * - `feed_sources.data_version` and the 'Central City' source row: every write that changes the
 *   listed Central City rows moves it once, in the same transaction, so the Feed's cached order,
 *   counts and cursors follow (server/feed/query.ts).
 *
 * The kind list and the price bounds are written out here: a migration's text never changes once
 * applied (tests/feed-offers.test.ts checks them against shared/feed-offers.ts).
 *
 * Version 122: 120 is the newest on main; 119 and 121 are taken by other changes.
 */
export const FEED_OFFER_TABLES = ['city_offers', 'city_offer_batches'] as const;

export const FEED_OFFERS_SQL = `
CREATE TABLE IF NOT EXISTS city_offers (
  offer_id text PRIMARY KEY CHECK (offer_id ~ '^off_[a-z2-7]{16}$'),
  operator_id text NOT NULL,
  agent_id text NOT NULL,
  wallet_id text NOT NULL,
  pay_to text NOT NULL CHECK (pay_to ~ '^0x[0-9a-fA-F]{40}$'),
  kind text NOT NULL CHECK (kind IN ('web-read','text-stats','json-check','hash',
    'base-usdc-balance','base-block','unit-convert','base64','url-encode','case-convert',
    'slugify','reading-time','csv-to-json','json-to-csv','markdown-to-text','roman-numerals',
    'number-to-words','color-convert','date-diff','address-checksum')),
  title text NOT NULL,
  description text NOT NULL DEFAULT '',
  tags text[] NOT NULL DEFAULT '{}',
  price_raw numeric(78,0) NOT NULL CHECK (price_raw >= 50000 AND price_raw <= 100000),
  discoverable boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active','paused','removed')),
  idem_key text NOT NULL,
  risky text,
  price_changed_at bigint NOT NULL,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS city_offers_key ON city_offers (operator_id, idem_key)
  WHERE state <> 'removed';
CREATE INDEX IF NOT EXISTS city_offers_agent ON city_offers (operator_id, agent_id)
  WHERE state <> 'removed';
CREATE TABLE IF NOT EXISTS city_offer_batches (
  operator_id text NOT NULL,
  idem_key text NOT NULL,
  request_hash text NOT NULL,
  result jsonb NOT NULL,
  writes integer NOT NULL CHECK (writes >= 0),
  created_at bigint NOT NULL,
  PRIMARY KEY (operator_id, idem_key)
);
CREATE INDEX IF NOT EXISTS city_offer_batches_time ON city_offer_batches (operator_id, created_at);
ALTER TABLE feed_services ADD COLUMN IF NOT EXISTS seller_key text;
CREATE INDEX IF NOT EXISTS feed_services_seller ON feed_services ((COALESCE(seller_key, host)));
ALTER TABLE feed_sources ADD COLUMN IF NOT EXISTS data_version bigint NOT NULL DEFAULT 0;
INSERT INTO feed_sources (name) VALUES ('Central City') ON CONFLICT (name) DO NOTHING;
`;

export const feedOffersMigration: Migration = {
  version: 122,
  name: 'feed_offers',
  sql: FEED_OFFERS_SQL,
};

/** Idempotent; call before runMigrations (after the Feed's services, migration 104). */
export function registerFeedOffersMigration(): void {
  registerMigration(feedOffersMigration);
}
