/**
 * Elric's AI disclosure copy (EU AI Act Art. 50 transparency): the label on every Elric reply,
 * the one-line notice where a person first meets Elric, and the member badge. One source for the
 * room UI (import these; do not restate the wording) and for tests.
 *
 * The wording is pending approval. Minimal text and true statements only: no "safe", "private"
 * or "accurate" without the mechanism.
 *
 * Elric is behind CITY_ELRIC=1 and nothing here is public until it ships.
 */

/** The model name the server stamps on Tier 0 replies, which plain code produces (no model). */
export const ELRIC_DETERMINISTIC_MODEL = 'deterministic';

/** Elric's name on replies; the version is shown only on hover and in the profile. */
export const ELRIC_NAME = 'Elric';
/** The one place for Elric's public version. */
export const ELRIC_VERSION = '1.0';
/** The AI tag on a model reply (EU AI Act Art. 50 disclosure, on every model reply). */
export const ELRIC_AI_TAG = 'AI';
/**
 * What end users see as the "model" of an Elric reply: never the real model name (that stays in
 * the database and the internal configuration). Tier 0 keeps ELRIC_DETERMINISTIC_MODEL.
 */
export const ELRIC_PUBLIC_MODEL = `elric-${ELRIC_VERSION}`;
const isModel = (model: string | null | undefined) => {
  const name = (model ?? '').trim();
  return Boolean(name) && name !== ELRIC_DETERMINISTIC_MODEL;
};

/**
 * The label on one Elric reply, from the server stamp's model: a model reply is "Elric · AI" (the
 * name plus the AI tag); a Tier 0 reply (plain code, no model) is "Elric · automated", never AI.
 */
export function elricReplyLabel(model: string | null | undefined): string {
  return isModel(model) ? `${ELRIC_NAME} · ${ELRIC_AI_TAG}` : `${ELRIC_NAME} · automated`;
}
/** The tag a UI renders next to the name: "AI" on a model reply, none on a Tier 0 reply. */
export function elricReplyTag(model: string | null | undefined): string | null {
  return isModel(model) ? ELRIC_AI_TAG : null;
}
/** The public model of a reply as end users get it (API responses): never the real model. */
export function elricPublicModel(model: string | null | undefined): string {
  return isModel(model) ? ELRIC_PUBLIC_MODEL : ELRIC_DETERMINISTIC_MODEL;
}
/** The hover tooltip on Elric's name. */
export function elricTooltip(): string {
  return `${ELRIC_NAME} v${ELRIC_VERSION}`;
}
/** The title of Elric's profile or about panel. */
export function elricProfileTitle(): string {
  return `${ELRIC_NAME} · Version ${ELRIC_VERSION}`;
}

/** Shown once per person per room where they first meet Elric, and on "Add Elric". */
export const ELRIC_AI_NOTICE = 'Elric is the native AI assistant of Central City.';

/** The room's small Elric hint above the composer (Workspace v3 §4.3), before "Ask Elric". */
export const ELRIC_ROOM_HINT = 'Elric is Central City’s built-in AI';

/** The badge next to Elric in a room's member list. */
export const ELRIC_MEMBER_BADGE = 'AI assistant';

/** Where the fuller disclosure lives once Elric ships (docs/ELRIC_ABOUT.md). */
export const ELRIC_ABOUT_PATH = '/docs/elric.md';

/** Only the room's host may have their Elric in a room (at most one Elric per room). */
export const ELRIC_HOST_ONLY_CODE = 'elric_host_only';
export const ELRIC_HOST_ONLY_MESSAGE = "Only the room's host can add Elric to this room.";
