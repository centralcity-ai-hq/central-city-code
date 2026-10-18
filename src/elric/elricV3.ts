/*
 * Workspace v3, Elric (docs/design/WORKSPACE_V3_ELRIC_AGENTS.md §1): the words and small decisions
 * the page draws from real data. Pure functions, so tests/elric-v3.test.ts can pin them.
 */

/** The Home pill while approvals are pending: "1 action waiting for you". Empty for none. */
export function waitingLabel(count: number): string {
  if (!Number.isFinite(count) || count < 1) return '';
  return `${count} ${count === 1 ? 'action' : 'actions'} waiting for you`;
}

/**
 * The top bar's live line from GET /api/elric/rooms (rooms where Elric is a member). Null while
 * unknown (nothing is drawn); "Paused" while Elric is paused.
 */
export function liveLine(
  rooms: number | null,
  status: 'active' | 'paused' | null | undefined,
): { text: string; live: boolean } | null {
  if (status === 'paused') return { text: 'Paused', live: false };
  if (rooms === null || !Number.isFinite(rooms)) return null;
  if (rooms < 1) return { text: 'In no rooms yet', live: false };
  return { text: `On in ${rooms} ${rooms === 1 ? 'room' : 'rooms'}`, live: true };
}

export type GateReason = 'unverified' | 'age_unknown' | 'age_under_18' | string | null | undefined;

/**
 * The first-visit card's two steps (GET /api/elric eligibility): a linked Google account, then
 * the age check. 'unverified' means no Google yet (the age is not asked before it); 'age_unknown'
 * means Google is linked and the date of birth is still to be given; eligible means both are done.
 */
export function gateSteps(eligible: boolean, reason: GateReason) {
  const google = eligible || reason === 'age_unknown' || reason === 'age_under_18';
  return {
    google,
    age: eligible,
    // The age step opens only once Google is positively linked (an unknown answer, or a status
    // that could not be read, keeps it closed).
    ageOpen: google && !eligible && reason !== 'age_under_18',
    adultsOnly: !eligible && reason === 'age_under_18',
  };
}

/** A message time as the rooms show it: "09:41" in the reader's own clock. Empty if unknown. */
export function messageClock(iso: string | null | undefined): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** Today's use of one kind against its allowance, for the Manage Elric meters. */
export function usageShare(used: number, allowance: number) {
  const share = allowance > 0 ? Math.min(Math.max(used, 0) / allowance, 1) : 1;
  return { share, full: share >= 1 };
}

/**
 * Whether a reply that arrives after an await still belongs to the chat on screen: seqs are per
 * room, so messages of a chat the person has since left must never merge into the open one (nor
 * move its poll cursor). A new chat with no room yet matches nothing.
 */
export function isOpenChat(openRoomId: string | null | undefined, roomId: string): boolean {
  return Boolean(roomId) && openRoomId === roomId;
}

export interface SendAttempt {
  scope: string;
  body: string;
  key: string;
}

/**
 * The idempotency key of a send: the same text sent again to the same room keeps the key of the
 * attempt that failed, so a post the server stored before its response was lost is not stored
 * (and answered) twice. Other text, or another room, gets a new key.
 */
export function sendAttempt(
  last: SendAttempt | null,
  scope: string,
  body: string,
  newKey: () => string,
): SendAttempt {
  if (last && last.scope === scope && last.body === body) return last;
  return { scope, body, key: newKey() };
}
