import { randomUUID } from 'node:crypto';
import type { Database } from '../database.js';
import { partsContainCredential } from './contract.js';
import { cleanName } from './person.js';

/*
 * CCA-628, stored rooms: a one-off data migration (no schema change) that cleans the name and
 * topic of rooms created before create() applied the rename rules, with the same cleaner as
 * create() and renameIn (rooms/person.ts cleanName: control, format such as bidi, zero-width and
 * tag characters, and line/paragraph separators removed, whitespace collapsed, capped at 80 and
 * 280 characters). Run by the owner (scripts/clean-room-labels.ts), not at startup: the cleaner is
 * code, not SQL, and a room table can be larger than one migration transaction should lock.
 *
 * - In batches by room id (keyset), each batch in its own short transaction that locks only its
 *   rooms' rows (FOR UPDATE, in id order, lock_timeout 2 s) and re-reads them under the lock, so
 *   a concurrent rename is never overwritten with an older value.
 * - One audit row per changed room (room_events `room.labels_cleaned`, detail: which of name and
 *   topic changed; never the text), no system line in the room.
 * - Idempotent: the cleaner is idempotent, so a second run changes nothing and writes no rows.
 *   It can be run again after the cleaner grows (it then cleans what the new rules remove).
 * - A name that is only invisible characters becomes "Untitled room" (a room always has a name).
 * - A name or topic that contains a credential is counted (`credential`) but not rewritten: the
 *   owner decides about those rooms.
 * - Counts only in its results, never ids or text.
 */
export const UNTITLED_ROOM = 'Untitled room';
export const ROOM_NAME_MAX = 80;
export const ROOM_TOPIC_MAX = 280;

export interface CleanRoomLabelsCounts {
  /** Rooms read. */
  scanned: number;
  /** Rooms whose name or topic the cleaner changes (changed when confirmed). */
  changed: number;
  names: number;
  topics: number;
  /** Names that were only invisible characters (stored as UNTITLED_ROOM). */
  emptied: number;
  /** Rooms whose (cleaned) name or topic contains a credential: left as they are. */
  credential: number;
  batches: number;
}

interface RoomLabelRow {
  id: string;
  name: string;
  topic: string;
  host_owner_id: string;
}

function cleaned(row: RoomLabelRow) {
  const name = cleanName(row.name, ROOM_NAME_MAX) || UNTITLED_ROOM;
  const topic = cleanName(row.topic, ROOM_TOPIC_MAX);
  return {
    name,
    topic,
    nameChanged: name !== row.name,
    topicChanged: topic !== row.topic,
    emptied: name === UNTITLED_ROOM && row.name !== UNTITLED_ROOM,
    credential: partsContainCredential([row.name, row.topic, name, topic]),
  };
}

export async function cleanRoomLabels(
  db: Database,
  options: {
    confirm: boolean;
    batchSize?: number;
    now?: () => number;
    onBatch?: (counts: CleanRoomLabelsCounts) => void;
  },
): Promise<CleanRoomLabelsCounts> {
  const batchSize = Math.min(Math.max(Math.trunc(options.batchSize ?? 200), 1), 1000);
  const now = options.now ?? Date.now;
  const counts: CleanRoomLabelsCounts = {
    scanned: 0,
    changed: 0,
    names: 0,
    topics: 0,
    emptied: 0,
    credential: 0,
    batches: 0,
  };
  let after = '';
  for (;;) {
    const ids = (
      await db.query<{ id: string }>('SELECT id FROM rooms WHERE id > $1 ORDER BY id LIMIT $2', [
        after,
        batchSize,
      ])
    ).rows.map((row) => row.id);
    if (!ids.length) break;
    after = ids[ids.length - 1]!;
    const tally = (row: RoomLabelRow) => {
      const result = cleaned(row);
      counts.scanned += 1;
      if (result.credential) {
        counts.credential += 1;
        return null;
      }
      if (!result.nameChanged && !result.topicChanged) return null;
      counts.changed += 1;
      if (result.nameChanged) counts.names += 1;
      if (result.topicChanged) counts.topics += 1;
      if (result.emptied) counts.emptied += 1;
      return result;
    };
    if (!options.confirm) {
      const rows = await db.query<RoomLabelRow>(
        'SELECT id, name, topic, host_owner_id FROM rooms WHERE id = ANY($1::text[]) ORDER BY id',
        [ids],
      );
      for (const row of rows.rows) tally(row);
    } else
      await db.transaction(async (tx) => {
        await tx.exec("SET LOCAL lock_timeout = '2s'");
        const rows = await tx.query<RoomLabelRow>(
          `SELECT id, name, topic, host_owner_id FROM rooms WHERE id = ANY($1::text[])
            ORDER BY id FOR UPDATE`,
          [ids],
        );
        const time = now();
        for (const row of rows.rows) {
          const result = tally(row);
          if (!result) continue;
          await tx.query('UPDATE rooms SET name = $2, topic = $3 WHERE id = $1', [
            row.id,
            result.name,
            result.topic,
          ]);
          await tx.query(
            `INSERT INTO room_events(id, room_id, actor_owner_id, actor, action, agent_id, created_at, detail)
             VALUES ($1, $2, $3, 'Central City', 'room.labels_cleaned', NULL, $4, $5::jsonb)`,
            [
              randomUUID(),
              row.id,
              row.host_owner_id,
              time,
              JSON.stringify({ name: result.nameChanged, topic: result.topicChanged }),
            ],
          );
        }
      });
    counts.batches += 1;
    options.onBatch?.({ ...counts });
  }
  return counts;
}
