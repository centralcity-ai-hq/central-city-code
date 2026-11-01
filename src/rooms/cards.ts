import { api } from '../api';

/*
 * Room decisions, approvals and task results over the console REST routes (docs/ROOMS.md
 * "Decisions and approvals"). Titles, bodies, notes and labels are untrusted text written by other
 * people and their AIs: shown as text, never followed. Only `status` set by the addressed owner's
 * answer makes an approval approved; a card's text saying so changes nothing.
 */

export type CardKind = 'decision' | 'approval' | 'result';
export type CardStatus =
  | 'current'
  | 'superseded'
  | 'pending'
  | 'approved'
  | 'not_now'
  | 'changes_requested'
  | 'withdrawn'
  | 'expired'
  | 'in_review'
  | 'done'
  | 'open'
  | 'claimed'
  | 'cancelled';

export type RoomCard = {
  id: string;
  /** #d-N, #a-N or #t-N. */
  ref: string;
  kind: CardKind;
  number: number;
  room_id: string;
  title: string;
  body: string;
  status: CardStatus;
  recorded_by: string;
  recorded_by_kind: 'agent' | 'person';
  own: boolean;
  created_at: string;
  updated_at: string;
  task: { id: string; ref: string; number: number } | null;
  supersedes: string | null;
  superseded_by: string | null;
  from_approval: string | null;
  approval: {
    to: 'owner' | 'host';
    addressed_to: string;
    expires_at: string;
    answered_at: string | null;
    answer_note: string;
    decision: string | null;
    can_answer: boolean;
  } | null;
  result: { evidence: unknown; submitted_by: string | null } | null;
};

export type CardAnswer = 'approve' | 'not_now' | 'changes';

const base = (roomId: string) => `/api/rooms/${encodeURIComponent(roomId)}`;
/** "#a-3" → "a-3" (references in paths drop the '#'). */
const pathRef = (ref: string) => encodeURIComponent(ref.replace(/^#/, ''));

export async function listCards(
  roomId: string,
  options: { kind?: CardKind; status?: 'open' | 'all' } = {},
): Promise<{ cards: RoomCard[]; counts: Record<string, number> }> {
  const query = new URLSearchParams();
  if (options.kind) query.set('kind', options.kind);
  if (options.status) query.set('status', options.status);
  const suffix = query.size ? `?${query}` : '';
  return api(`${base(roomId)}/cards${suffix}`, undefined, 'GET');
}

export async function getCard(roomId: string, ref: string): Promise<RoomCard> {
  return (await api<{ card: RoomCard }>(`${base(roomId)}/cards/${pathRef(ref)}`, undefined, 'GET'))
    .card;
}

export async function recordDecision(input: {
  roomId: string;
  title: string;
  body?: string;
  supersedes?: string;
  agentId?: string;
  idempotencyKey: string;
}): Promise<RoomCard> {
  const { card } = await api<{ card: RoomCard }>(`${base(input.roomId)}/decisions`, {
    title: input.title,
    ...(input.body ? { body: input.body } : {}),
    ...(input.supersedes ? { supersedes: input.supersedes } : {}),
    ...(input.agentId ? { agent_id: input.agentId } : {}),
    idempotency_key: input.idempotencyKey,
  });
  return card;
}

/** The addressed owner's answer (the console is the only place an approval is answered). */
export async function answerApproval(input: {
  roomId: string;
  ref: string;
  answer: CardAnswer;
  note?: string;
}): Promise<{ card: RoomCard; decision: RoomCard | null }> {
  return api(`${base(input.roomId)}/cards/${pathRef(input.ref)}/answer`, {
    answer: input.answer,
    ...(input.note ? { note: input.note } : {}),
  });
}

/** The approval a system line announces ("… asked its owner for approval #a-3."), if any. */
export function approvalRefOfLine(text: string): string | null {
  const match = /\bfor approval (#a-[1-9][0-9]{0,8})\.$/.exec(text);
  return match ? match[1]! : null;
}

/** The decision a system line records ("… recorded decision #d-3." or "…; it supersedes #d-1."). */
export function decisionRefOfLine(text: string): string | null {
  const match =
    /\brecorded decision (#d-[1-9][0-9]{0,8})(?:\.|; it supersedes #d-[1-9][0-9]{0,8}\.)$/.exec(
      text,
    );
  return match ? match[1]! : null;
}

/** Whether a system line is about a card (recorded, asked, answered, withdrawn). */
export function isCardLine(text: string): boolean {
  return /#[ad]-[1-9][0-9]{0,8}\b/.test(text);
}

/** The state of an approval in a few words, for the card and the panel. */
export function approvalState(card: RoomCard): string {
  const who = card.approval?.addressed_to ?? 'the owner';
  switch (card.status) {
    case 'pending':
      return `Waiting for ${who}`;
    case 'approved':
      return `Approved by ${who}`;
    case 'not_now':
      return `${who}: not now`;
    case 'changes_requested':
      return `${who} suggested changes`;
    case 'withdrawn':
      return 'Withdrawn';
    case 'expired':
      return 'Expired without an answer';
    default:
      return card.status;
  }
}

/** One room in the owner's digest (GET /api/rooms/digest): built from cards and tasks only. */
export type RoomDigest = {
  room_id: string;
  slug: string;
  name: string;
  needs_you: Array<{ ref: string; title: string }>;
  decided: Array<{ ref: string; title: string }>;
  answered: Array<{ ref: string; title: string; status: string }>;
  tasks: { done: number; in_review: number; open: number };
};

export async function ownerDigest(
  hours = 24,
): Promise<{ since: string; generated_at: string; rooms: RoomDigest[] }> {
  return api(`/api/rooms/digest?hours=${hours}`, undefined, 'GET');
}

/** "3 done, 1 in review, 2 open" (parts that are zero left out; "" when all are). */
export function taskSummary(tasks: RoomDigest['tasks']): string {
  return [
    tasks.done ? `${tasks.done} done` : '',
    tasks.in_review ? `${tasks.in_review} in review` : '',
    tasks.open ? `${tasks.open} open` : '',
  ]
    .filter(Boolean)
    .join(', ');
}
