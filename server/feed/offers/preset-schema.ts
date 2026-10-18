import { registerMigration, type Migration } from '../../migrations.js';

/**
 * Migration 231 `feed_offer_presets`: city_offers.preset, an offer's fixed input fields
 * (OfferPreset in shared/feed-offers.ts): a JSON object of some of its kind's input fields with
 * their values, merged into every call's input by the purchase path. NULL for every offer so far
 * and for any offer that fixes nothing, so existing offers are unchanged.
 *
 * One nullable column on city_offers only (a small table; ADD COLUMN without a default rewrites
 * nothing), with a CHECK that it is an object when set. No payment table is touched.
 *
 * Version 231: 230 (the kind list, kinds-schema.ts) is this change's other migration.
 */
export const FEED_OFFER_PRESETS_SQL = `
ALTER TABLE city_offers ADD COLUMN IF NOT EXISTS preset jsonb
  CHECK (preset IS NULL OR jsonb_typeof(preset) = 'object');
`;

export const feedOfferPresetsMigration: Migration = {
  version: 231,
  name: 'feed_offer_presets',
  sql: FEED_OFFER_PRESETS_SQL,
};

/** Idempotent; call before runMigrations (after 122, which creates city_offers). */
export function registerFeedOfferPresetsMigration(): void {
  registerMigration(feedOfferPresetsMigration);
}
