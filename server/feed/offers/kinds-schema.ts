import { registerMigration, type Migration } from '../../migrations.js';

/**
 * Migration 230 `feed_offer_kinds_v2`: city_offers.kind accepts the ten kinds added after the
 * first twenty (shared/feed-offers.ts OFFER_KINDS): web-meta, web-links, keyword-density,
 * text-diff, json-query, json-schema-check, csv-stats, base-tx, base-erc20-balance and base-gas.
 *
 * Migration 122 wrote the kind list out in the column's CHECK, and a migration's text never
 * changes once applied, so the CHECK is replaced here: dropped by its name (Postgres names an
 * unnamed column CHECK <table>_<column>_check) and added again with the whole list, under the
 * same name. Only city_offers changes; adding the CHECK reads its rows once (a small table) and
 * every existing kind is still in the list, so no row can fail it. No other table is touched.
 *
 * The kind list is written out here as in 122 (tests/feed-offers.test.ts checks it against
 * OFFER_KINDS).
 *
 * Version 230: 220 is the newest on main; 119 and 126 belong to other open changes.
 */
export const FEED_OFFER_KINDS_V2_SQL = `
ALTER TABLE city_offers DROP CONSTRAINT IF EXISTS city_offers_kind_check;
ALTER TABLE city_offers ADD CONSTRAINT city_offers_kind_check CHECK (kind IN ('web-read',
  'text-stats','json-check','hash','base-usdc-balance','base-block','unit-convert','base64',
  'url-encode','case-convert','slugify','reading-time','csv-to-json','json-to-csv',
  'markdown-to-text','roman-numerals','number-to-words','color-convert','date-diff',
  'address-checksum','web-meta','web-links','keyword-density','text-diff','json-query',
  'json-schema-check','csv-stats','base-tx','base-erc20-balance','base-gas'));
`;

export const feedOfferKindsV2Migration: Migration = {
  version: 230,
  name: 'feed_offer_kinds_v2',
  sql: FEED_OFFER_KINDS_V2_SQL,
};

/** Idempotent; call before runMigrations (after 122, which creates city_offers). */
export function registerFeedOfferKindsV2Migration(): void {
  registerMigration(feedOfferKindsV2Migration);
}
