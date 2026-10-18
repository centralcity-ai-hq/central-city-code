import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { purgeRoomMentions } from '../server/rooms/mention-purge.js';

/*
 * Every ack path locks the agent's wake_cursors row and then updates its mentions. Room delete and
 * the private-room purge must take the same order (cursors first, sorted), or a delete running
 * next to an ack can deadlock (40P01) and one of them fails.
 */

test('purgeRoomMentions locks the cursors, sorted, before it deletes any mention', async () => {
  const sql: string[] = [];
  const tx = {
    query: async (text: string) => {
      sql.push(text.replace(/\s+/g, ' ').trim());
      return { rows: text.startsWith('DELETE') ? [{ agent_id: 'b', read_at: null }] : [] };
    },
  };
  await purgeRoomMentions(tx as never, ['room-1'], 5);
  const lock = sql.findIndex((s) => /FROM wake_cursors .*ORDER BY agent_id FOR UPDATE/.test(s));
  const del = sql.findIndex((s) => s.startsWith('DELETE FROM mentions'));
  assert.ok(lock >= 0, 'the cursors are locked');
  assert.ok(del > lock, 'the mentions are deleted after the cursor lock');
  assert.match(sql[del + 1] ?? '', /^UPDATE wake_cursors .*updated_at=\$3/);
});

test('purgeRoomMentions erases the rooms mentions and their unread backlog', async () => {
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE mentions (room_id text, agent_id text, read_at bigint);
    CREATE TABLE wake_cursors (agent_id text PRIMARY KEY, unread_count int, updated_at bigint);
    INSERT INTO wake_cursors VALUES ('a', 3, 0), ('b', 1, 0);
    INSERT INTO mentions VALUES ('r1', 'a', NULL), ('r1', 'a', NULL), ('r1', 'a', 7),
      ('r1', 'b', NULL), ('r2', 'a', NULL);
  `);
  await db.transaction((tx) => purgeRoomMentions(tx as never, ['r1']));
  const cursors = await db.query<{ agent_id: string; unread_count: number }>(
    'SELECT agent_id, unread_count FROM wake_cursors ORDER BY agent_id',
  );
  assert.deepEqual(
    cursors.rows.map((r) => [r.agent_id, r.unread_count]),
    [
      ['a', 1],
      ['b', 0],
    ],
  );
  const left = await db.query<{ room_id: string }>('SELECT room_id FROM mentions');
  assert.deepEqual(
    left.rows.map((r) => r.room_id),
    ['r2'],
  );
  await db.close();
});

test('room delete and the private-room purge both go through purgeRoomMentions', () => {
  for (const file of ['server/rooms/service.ts', 'server/elric/erase.ts']) {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    assert.match(source, /purgeRoomMentions\(tx, /, file);
    assert.doesNotMatch(source, /DELETE FROM mentions WHERE room_id/, file);
  }
});
