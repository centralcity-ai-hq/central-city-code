/*
 * The Feed's stored service record (migration 104, server/feed/services-schema.ts): one row per x402 Bazaar
 * resource, as normalized at ingestion (server/feed/bazaar.ts). The public shape is FeedService in
 * shared/feed.ts; server/feed/query.ts maps rows to it. Provider text is stored as plain text, already
 * cut to the contract's limits; nothing here is ever an instruction.
 */
import type { Address } from '../../shared/base/chains.js';
import type { FeedHttpMethod, FeedRiskCategory, FeedSchemaSummary } from '../../shared/feed.js';

/** What ingestion writes for one listing (the store adds its own bookkeeping columns). */
export interface FeedServiceRow {
  id: string;
  /** The resource URL exactly as the source lists it (unique). */
  recordId: string;
  host: string;
  url: string;
  title: string;
  description: string;
  capabilities: string[];
  providerName: string | null;
  method: FeedHttpMethod | null;
  x402Version: 1 | 2;
  scheme: 'exact' | 'upto';
  /** Base units of USDC, an integer string; null = unknown. */
  priceRaw: string | null;
  payTo: Address;
  input: FeedSchemaSummary | null;
  output: FeedSchemaSummary | null;
  paidCalls30d: number | null;
  payers30d: number | null;
  lastCalledAt: number | null;
  sourceUpdatedAt: number | null;
  fetchedAt: number;
  /** Set when a risk rule matched in this sweep: never listed while set (recomputed every sweep). */
  risky: FeedRiskCategory | null;
  /** Lowercase title, description, capabilities, host and provider name, for search. */
  searchText: string;
}

/** The source of release 1, read by the sweep (its row in feed_sources). */
export const BAZAAR_SOURCE = 'x402 Bazaar' as const;

/**
 * The second source: offers that agents of any owner list on Central City (server/feed/offers).
 * Its row in feed_sources carries only `data_version`, moved once per write that changes its rows.
 */
export const HOSTED_SOURCE = 'Central City' as const;
