import { registerMigration, type Migration } from '../migrations.js';

/**
 * Migration 55 `room_message_search`: full-text search inside a room (docs/ROOMS.md, "Search").
 *
 * - `room_message_text(parts)`: the text parts of a message joined with newlines (data parts are
 *   not searchable). IMMUTABLE, so it can feed a generated column and the search snippet.
 * - `room_messages.search_tsv`: a STORED generated tsvector of that text under the 'simple'
 *   configuration (lower-cased words, no stemming and no stop words), because room text is
 *   multilingual: a language-specific dictionary would stem or drop words of other languages.
 *   Being generated, it can never drift from `parts`, including when a deleted room's content is
 *   erased.
 * - `room_messages_search`: a composite GIN index on (room_id, search_tsv) through btree_gin, so a
 *   search reads only the matches of its own room, never every match in the city. Where the
 *   extension cannot be created (an embedded test database started without it), the index falls
 *   back to search_tsv alone; the server's own PGlite loads btree_gin (server/app.ts).
 *
 * Substring matching (pg_trgm) is deliberately not used: it needs an extension on every database
 * (PGlite loads extensions per process) and word matching is what a chat search expects.
 */
export const roomMessageSearchMigration: Migration = {
  version: 55,
  name: 'room_message_search',
  sql: `
CREATE OR REPLACE FUNCTION room_message_text(parts jsonb) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $fn$
  SELECT coalesce(string_agg(p.value->>'text', E'\\n' ORDER BY p.ordinality), '')
    FROM jsonb_array_elements(
      CASE WHEN jsonb_typeof(parts) = 'array' THEN parts ELSE '[]'::jsonb END
    ) WITH ORDINALITY AS p(value, ordinality)
   WHERE p.value->>'type' = 'text'
$fn$;
-- Rewrites room_messages once (fine at today's size); a much larger table needs a batched backfill.
ALTER TABLE room_messages ADD COLUMN IF NOT EXISTS search_tsv tsvector
  GENERATED ALWAYS AS (to_tsvector('simple'::regconfig, room_message_text(parts))) STORED;
DO $search$
BEGIN
  BEGIN
    CREATE EXTENSION IF NOT EXISTS btree_gin;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'btree_gin unavailable; room search falls back to a single-column index';
  END;
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'btree_gin') THEN
    CREATE INDEX IF NOT EXISTS room_messages_search ON room_messages USING gin (room_id, search_tsv);
  ELSE
    CREATE INDEX IF NOT EXISTS room_messages_search ON room_messages USING gin (search_tsv);
  END IF;
END
$search$;
`,
};

/** Idempotent; registered by registerRoomsMigration (rooms/schema.ts). */
export function registerRoomMessageSearchMigration(): void {
  registerMigration(roomMessageSearchMigration);
}

/**
 * Search snippets (ts_headline): matches are wrapped in U+0001/U+0002, which the text never holds
 * (they are stripped before the headline), then turned into offsets. Short messages come back whole.
 */
const HEADLINE_OPTIONS = 'StartSel=\u0001, StopSel=\u0002, MaxWords=35, MinWords=15, ShortWord=0';
const SNIPPET_MAX = 400;
/** A headline as plain text (whitespace collapsed) and the [start, end) offsets of its matches. */
export function highlighted(headline: string): {
  snippet: string;
  highlights: Array<[number, number]>;
} {
  const flat = headline.replace(/\s+/g, ' ').trim();
  let snippet = '';
  const highlights: Array<[number, number]> = [];
  let start = -1;
  for (const char of flat) {
    if (char === '\u0001') start = snippet.length;
    else if (char === '\u0002') {
      if (start >= 0 && snippet.length > start) highlights.push([start, snippet.length]);
      start = -1;
    } else if (snippet.length < SNIPPET_MAX) snippet += char;
  }
  const end = snippet.length >= SNIPPET_MAX ? SNIPPET_MAX - 1 : snippet.length;
  if (end < snippet.length) snippet = `${snippet.slice(0, end)}…`;
  return {
    snippet,
    highlights: highlights
      .map(([from, to]): [number, number] => [from, Math.min(to, end)])
      .filter(([from, to]) => to > from),
  };
}

export interface RoomSearchFilters {
  roomId: string;
  /** The caller's history starts after this seq (min visible_from_seq of its memberships). */
  visibleFrom: number;
  q: string;
  /** Page cursor: only seqs below this. */
  before: number | null;
  sender: string | null;
  /** created_at bounds in epoch ms: from inclusive, to exclusive. */
  from: number | null;
  to: number | null;
  limit: number;
}
export type RoomSearchRow = {
  seq: string | number;
  id: string;
  sender_name: string;
  sender_agent_id: string;
  sender_owner_id: string;
  sender_kind: string | null;
  created_at: string | number;
  snippet: string;
};
/**
 * The search statement. The query text is only ever a bind parameter of websearch_to_tsquery
 * (which accepts any input and never raises a syntax error), so neither SQL nor tsquery syntax
 * can be injected. The matching seqs come first from the GIN index (MATERIALIZED keeps the
 * planner from walking the room's primary key backwards and testing every message for a word it
 * wrongly guesses is common), then the newest page of them, and the snippet for that page alone.
 */
export function roomSearchSql(f: RoomSearchFilters): { text: string; params: unknown[] } {
  const params: unknown[] = [f.roomId, f.visibleFrom, f.q];
  const where = [
    'room_id=$1',
    'seq>$2',
    "search_tsv @@ websearch_to_tsquery('simple'::regconfig, $3)",
  ];
  const add = (column: string, op: string, value: unknown) => {
    params.push(value);
    where.push(`${column}${op}$${params.length}`);
  };
  if (f.before !== null) add('seq', '<', f.before);
  if (f.sender !== null) add('sender_agent_id', '=', f.sender);
  if (f.from !== null) add('created_at', '>=', f.from);
  if (f.to !== null) add('created_at', '<', f.to);
  params.push(f.limit);
  const limit = `$${params.length}`;
  params.push(HEADLINE_OPTIONS);
  const options = `$${params.length}`;
  return {
    text: `WITH matches AS MATERIALIZED (
  SELECT seq FROM room_messages WHERE ${where.join(' AND ')}),
hits AS (SELECT seq FROM matches ORDER BY seq DESC LIMIT ${limit})
SELECT m.seq, m.id, m.sender_name, m.sender_agent_id, m.sender_owner_id, m.sender_kind, m.created_at,
       ts_headline('simple'::regconfig, translate(room_message_text(m.parts), E'\\x01\\x02', ''),
         websearch_to_tsquery('simple'::regconfig, $3), ${options}) AS snippet
  FROM hits h JOIN room_messages m ON m.room_id=$1 AND m.seq=h.seq
 ORDER BY m.seq DESC`,
    params,
  };
}
