/**
 * The "While you were away" catch-up (POST /api/rooms/:room/catch-up; docs/ELRIC.md "Catch-up").
 * Shared by the server (server/elric/catch-up.ts) and the rooms client (src/rooms/useCatchUp.ts).
 *
 * Every bullet cites the room message seqs it comes from, so the UI can link them. Sections with
 * nothing in them are omitted; when every section is empty, `nothing_important` is true and the
 * UI shows CATCH_UP_NOTHING_TEXT.
 */

export const CATCH_UP_SECTIONS = ['needs_you', 'tasks', 'decisions', 'open_questions'] as const;
export type CatchUpSectionKind = (typeof CATCH_UP_SECTIONS)[number];

/** Section headings as the UI shows them (sentence case). */
export const CATCH_UP_SECTION_TITLES: Record<CatchUpSectionKind, string> = {
  needs_you: 'Needs you',
  tasks: 'Tasks that moved',
  decisions: 'Decisions',
  open_questions: 'Open questions',
};

export const CATCH_UP_TITLE = 'While you were away';
export const CATCH_UP_NOTHING_TEXT = 'Nothing important while you were away.';

export interface CatchUpBullet {
  /** One line of plain text (no Markdown, no mentions). */
  text: string;
  /** The room message seqs this bullet comes from (at least one, ascending). */
  seqs: number[];
  /** Tasks that moved, and Needs you items about a task: the task number (shown as T<n>). */
  task_number?: number;
}

export interface CatchUpSection {
  kind: CatchUpSectionKind;
  title: string;
  bullets: CatchUpBullet[];
}

export interface CatchUp {
  room_id: string;
  /** The range summarized: messages with from_seq < seq <= to_seq. */
  from_seq: number;
  to_seq: number;
  /** More than the message cap was waiting: only the newest messages were read. */
  truncated: boolean;
  /** Non-empty sections only, in CATCH_UP_SECTIONS order. */
  sections: CatchUpSection[];
  nothing_important: boolean;
  /** Served from the cache (no new model call, nothing billed). */
  cached: boolean;
  /**
   * Set when Elric could not write the Decisions and Open questions part (the sections from room
   * data are still given): `limit` (daily allowance or the global ceiling; see `notice`) or
   * `unavailable` (the model failed or is off). Such an answer is never cached.
   */
  incomplete?: 'limit' | 'unavailable';
  /** Owner-visible limit notice, e.g. "Summaries used up for today. Resets at 00:00 UTC." */
  notice?: string;
  resets_at?: string;
}

export interface CatchUpRequest {
  /** Summarize after this seq (default: the caller's read cursor in the room). */
  after_seq?: number;
  /** Up to and including this seq (default: the room's latest message). */
  to_seq?: number;
}

/** Refusal codes of the route (besides the rooms' own 404 room_not_found). */
export const CATCH_UP_OFF_CODE = 'elric_catch_up_off';
export const CATCH_UP_BUSY_CODE = 'elric_catch_up_busy';
/** Elric is off for everyone right now (the kill switch): the catch-up shows nothing at all. */
export const CATCH_UP_PAUSED_CODE = 'elric_catch_up_paused';
