import type { Transaction } from '../database.js';
import {
  aiRoomLabel,
  ownerKindOf,
  ownerLabelKey,
  personRoomLabel,
  PERSON_OWNER_LABEL,
  unclaimedRoomLabel,
  type OwnerKind,
} from './owner-labels.js';

/**
 * One-off relabel of the owner labels stored in rooms before they were keyed per room and before
 * AI workspaces got their own label form (server/rooms/owner-labels.ts, docs/ROOMS.md
 * "Member"). Until it runs, a person keeps one label in every room it was already in, and an AI
 * workspace keeps its bare name.
 *
 * For every room member, every room message and every private room message it writes the label
 * and owner kind the server gives a new member of that owner in that room today:
 *
 * - a person's account: `Account <8 hex>`, the HMAC of account and room under the key derived
 *   from CITY_RATE_LIMIT_KEY, the same derivation as the server;
 * - an unclaimed account (an invite-link AI): `Unclaimed AI <8 hex>`, keyed the same way, kind 'ai';
 * - an AI workspace: `AI workspace "<name>" · <8 hex>` with its current name;
 * - an owner whose account no longer exists: a person's label is re-keyed the same way (it needs
 *   only the account id); any other label stays and is marked 'ai'.
 *
 * A person and its AIs in one room get the same label, as a new join does. Idempotent: rows that
 * already match are left alone, so a second run reports 0 changed (run it again if members joined
 * while it ran). One transaction per batch of rows, in primary key order. Without confirm it is a
 * dry run. The secret is never printed; output is counts only, never labels, ids or content. Run
 * by scripts/relabel-room-owners.ts and, on production, by the room-relabel cron (relabel-job.ts).
 */

export interface TableCounts {
  /** Rows read. */
  scanned: number;
  /** Rows whose label or owner kind changed (or would change in a dry run). */
  changed: number;
}
export interface RelabelCounts {
  mode: 'dry-run' | 'applied';
  members: TableCounts;
  messages: TableCounts;
  direct: TableCounts;
}

export type RelabelDb = Transaction & {
  transaction<T>(action: (tx: Transaction) => Promise<T>): Promise<T>;
};
type Db = RelabelDb;
type Owner = { id: string; name: string; kind: string };
type Label = { label: string; kind: OwnerKind };

/** The label and kind of one owner in one room, from its account (or its stored label). */
function labelFor(
  key: Buffer,
  owners: ReadonlyMap<string, Owner>,
  ownerId: string,
  roomId: string,
  stored: string,
): Label {
  const owner = owners.get(ownerId);
  if (owner?.kind === 'unclaimed')
    return { label: unclaimedRoomLabel(key, ownerId, roomId), kind: 'ai' };
  if (owner && ownerKindOf(owner.kind) === 'ai') return { label: aiRoomLabel(owner), kind: 'ai' };
  if (owner || PERSON_OWNER_LABEL.test(stored) || stored === 'Unknown owner')
    return { label: personRoomLabel(key, ownerId, roomId), kind: 'person' };
  return { label: stored, kind: 'ai' };
}

async function ownersOf(tx: Transaction, ids: string[]): Promise<Map<string, Owner>> {
  if (!ids.length) return new Map();
  return new Map(
    (
      await tx.query<Owner>('SELECT id,name,kind FROM operators WHERE id = ANY($1::text[])', [
        [...new Set(ids)],
      ])
    ).rows.map((row) => [row.id, row]),
  );
}

export async function relabelRoomOwners(
  db: Db,
  options: { secret: string; confirm?: boolean; batch?: number },
): Promise<RelabelCounts> {
  if (options.secret.length < 32) throw new Error('The server secret is missing or too short.');
  const key = ownerLabelKey(options.secret);
  const batch = options.batch ?? 500;
  const counts: RelabelCounts = {
    mode: options.confirm ? 'applied' : 'dry-run',
    members: { scanned: 0, changed: 0 },
    messages: { scanned: 0, changed: 0 },
    direct: { scanned: 0, changed: 0 },
  };

  // Room members, by (room_id, agent_id).
  let after: [string, string] = ['', ''];
  for (;;) {
    const done = await db.transaction(async (tx) => {
      const rows = (
        await tx.query<{
          room_id: string;
          agent_id: string;
          owner_id: string;
          owner_label: string;
          owner_kind: string | null;
        }>(
          `SELECT room_id, agent_id, owner_id, owner_label, owner_kind FROM room_members
            WHERE (room_id, agent_id) > ($1, $2) ORDER BY room_id, agent_id LIMIT $3
            ${options.confirm ? 'FOR UPDATE' : ''}`,
          [after[0], after[1], batch],
        )
      ).rows;
      if (!rows.length) return true;
      after = [rows.at(-1)!.room_id, rows.at(-1)!.agent_id];
      counts.members.scanned += rows.length;
      const owners = await ownersOf(
        tx,
        rows.map((row) => row.owner_id),
      );
      const changes = rows
        .map((row) => ({
          row,
          next: labelFor(key, owners, row.owner_id, row.room_id, row.owner_label),
        }))
        .filter(({ row, next }) => row.owner_label !== next.label || row.owner_kind !== next.kind);
      counts.members.changed += changes.length;
      if (options.confirm && changes.length)
        await tx.query(
          `UPDATE room_members m SET owner_label = c.label, owner_kind = c.kind
             FROM unnest($1::text[], $2::text[], $3::text[], $4::text[]) AS c(room_id, agent_id, label, kind)
            WHERE m.room_id = c.room_id AND m.agent_id = c.agent_id`,
          [
            changes.map(({ row }) => row.room_id),
            changes.map(({ row }) => row.agent_id),
            changes.map(({ next }) => next.label),
            changes.map(({ next }) => next.kind),
          ],
        );
      return rows.length < batch;
    });
    if (done) break;
  }

  // Room messages, by (room_id, seq). Server lines have no owner and stay as they are.
  let at: [string, number] = ['', -1];
  for (;;) {
    const done = await db.transaction(async (tx) => {
      const rows = (
        await tx.query<{
          room_id: string;
          seq: string | number;
          sender_owner_id: string;
          sender_owner_label: string;
          sender_owner_kind: string | null;
          sender_kind: string | null;
        }>(
          `SELECT room_id, seq, sender_owner_id, sender_owner_label, sender_owner_kind, sender_kind
             FROM room_messages WHERE (room_id, seq) > ($1, $2) ORDER BY room_id, seq LIMIT $3
            ${options.confirm ? 'FOR UPDATE' : ''}`,
          [at[0], at[1], batch],
        )
      ).rows;
      if (!rows.length) return true;
      at = [rows.at(-1)!.room_id, Number(rows.at(-1)!.seq)];
      counts.messages.scanned += rows.length;
      const owned = rows.filter((row) => row.sender_kind !== 'system');
      const owners = await ownersOf(
        tx,
        owned.map((row) => row.sender_owner_id),
      );
      const changes = owned
        .map((row) => ({
          row,
          next: labelFor(key, owners, row.sender_owner_id, row.room_id, row.sender_owner_label),
        }))
        .filter(
          ({ row, next }) =>
            row.sender_owner_label !== next.label || row.sender_owner_kind !== next.kind,
        );
      counts.messages.changed += changes.length;
      if (options.confirm && changes.length)
        await tx.query(
          `UPDATE room_messages m SET sender_owner_label = c.label, sender_owner_kind = c.kind
             FROM unnest($1::text[], $2::bigint[], $3::text[], $4::text[]) AS c(room_id, seq, label, kind)
            WHERE m.room_id = c.room_id AND m.seq = c.seq`,
          [
            changes.map(({ row }) => row.room_id),
            changes.map(({ row }) => Number(row.seq)),
            changes.map(({ next }) => next.label),
            changes.map(({ next }) => next.kind),
          ],
        );
      return rows.length < batch;
    });
    if (done) break;
  }

  // Private room messages between two owners (their sender label; none between one owner's own
  // members), by (recipient_id, seq).
  let next: [string, number] = ['', -1];
  for (;;) {
    const done = await db.transaction(async (tx) => {
      const rows = (
        await tx.query<{
          recipient_id: string;
          seq: string | number;
          room_id: string | null;
          sender_owner_id: string | null;
          sender_owner_label: string | null;
        }>(
          `SELECT recipient_id, seq, room_id, sender_owner_id, sender_owner_label FROM messages
            WHERE (recipient_id, seq) > ($1, $2) ORDER BY recipient_id, seq LIMIT $3
            ${options.confirm ? 'FOR UPDATE' : ''}`,
          [next[0], next[1], batch],
        )
      ).rows;
      if (!rows.length) return true;
      next = [rows.at(-1)!.recipient_id, Number(rows.at(-1)!.seq)];
      const direct = rows.filter(
        (row) => row.room_id && row.sender_owner_id && row.sender_owner_label !== null,
      );
      counts.direct.scanned += direct.length;
      const owners = await ownersOf(
        tx,
        direct.map((row) => row.sender_owner_id!),
      );
      const changes = direct
        .map((row) => ({
          row,
          label: labelFor(key, owners, row.sender_owner_id!, row.room_id!, row.sender_owner_label!)
            .label,
        }))
        .filter(({ row, label }) => row.sender_owner_label !== label);
      counts.direct.changed += changes.length;
      if (options.confirm && changes.length)
        await tx.query(
          `UPDATE messages m SET sender_owner_label = c.label
             FROM unnest($1::text[], $2::bigint[], $3::text[]) AS c(recipient_id, seq, label)
            WHERE m.recipient_id = c.recipient_id AND m.seq = c.seq`,
          [
            changes.map(({ row }) => row.recipient_id),
            changes.map(({ row }) => Number(row.seq)),
            changes.map(({ label }) => label),
          ],
        );
      return rows.length < batch;
    });
    if (done) break;
  }
  return counts;
}
