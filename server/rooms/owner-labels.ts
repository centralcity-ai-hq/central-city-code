import { createHash, createHmac } from 'node:crypto';
import { registerMigration, type Migration } from '../migrations.js';
import { reservedOwnerName } from '../workspaces/owner-names.js';

/**
 * Owner labels in rooms (docs/ROOMS.md, "Member"): who owns a member, as every member of
 * the room sees it next to the member and its messages.
 *
 * - A person's account is `Account <8 hex>`, keyed per room: an HMAC of account and room under a
 *   key derived from the server secret, so the members of two rooms cannot tell one account is in
 *   both. An unclaimed account (an invite-link AI) is `Unclaimed AI <8 hex>`, keyed the same way.
 * - An AI workspace is `AI workspace "<name>" · <8 hex>`: its name, in a form no workspace name
 *   and no person label can take (workspace names have no quotes or middle dots), and a stable
 *   hash of the workspace so two workspaces of one name differ. A workspace whose name reads as a
 *   person's label, the viewer's own AI or Central City (named before such names were refused)
 *   is `AI workspace <8 hex>`.
 *
 * `owner_kind` ('person' | 'ai') says which of the two it is; clients decide on it, never on the
 * label text.
 */
export type OwnerKind = 'person' | 'ai';

/** A person's label (also the only label a stored row from before owner_kind reads as 'person'). */
export const PERSON_OWNER_LABEL = /^Account [0-9a-f]{8}$/;

/** The per-room person label key, derived from the server secret (never the secret itself). */
export const ownerLabelKey = (secret: string | Buffer): Buffer =>
  createHmac('sha256', secret).update('central-city/room-owner-label/v1').digest();

export function personRoomLabel(key: Buffer, ownerId: string, roomId: string): string {
  return `Account ${createHmac('sha256', key).update(`${ownerId}\0${roomId}`).digest('hex').slice(0, 8)}`;
}

export function aiRoomLabel(owner: { id: string; name: string }): string {
  const tail = createHash('sha256').update(`owner-label:ai:${owner.id}`).digest('hex').slice(0, 8);
  return reservedOwnerName(owner.name)
    ? `AI workspace ${tail}`
    : `AI workspace "${owner.name}" · ${tail}`;
}

/**
 * An unclaimed account: an AI that joined by invite link ('Room guest') or an AI-created agent
 * nobody claimed yet. Only AIs create such accounts (a person joins from a signed-in console), so
 * it is labelled an AI, keyed per room like a person's label. No workspace name can take the form
 * (theirs are quoted after "AI workspace").
 */
export function unclaimedRoomLabel(key: Buffer, ownerId: string, roomId: string): string {
  return `Unclaimed AI ${createHmac('sha256', key).update(`unclaimed\0${ownerId}\0${roomId}`).digest('hex').slice(0, 8)}`;
}

/** The kind of an account's members: 'ai' for an AI workspace or an unclaimed AI, else 'person'. */
export const ownerKindOf = (operatorKind: string): OwnerKind =>
  operatorKind === 'ai' || operatorKind === 'unclaimed' ? 'ai' : 'person';

/** A stored row's kind; a row from before migration 273 is judged by its label. */
export const storedOwnerKind = (kind: string | null | undefined, label: string): OwnerKind =>
  kind === 'person' || kind === 'ai' ? kind : PERSON_OWNER_LABEL.test(label) ? 'person' : 'ai';

/**
 * Migration 273 `room_owner_kind`: the owner kind of each room member and of each room message's
 * sender, written at join and post. Older rows stay null (read by their label, storedOwnerKind)
 * until scripts/relabel-room-owners.ts fills them in. Nullable columns without a default: adding
 * them rewrites no rows.
 */
export const roomOwnerKindMigration: Migration = {
  version: 273,
  name: 'room_owner_kind',
  sql: `
ALTER TABLE room_members ADD COLUMN IF NOT EXISTS owner_kind text;
ALTER TABLE room_messages ADD COLUMN IF NOT EXISTS sender_owner_kind text;
`,
};

/** Idempotent; call before runMigrations. */
export function registerRoomOwnerKindMigration(): void {
  registerMigration(roomOwnerKindMigration);
}
