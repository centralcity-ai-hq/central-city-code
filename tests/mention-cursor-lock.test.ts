import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { ackElricMention } from '../server/elric/hook.js';

/**
 * Every path that marks mentions read and then moves `acked_mention_seq` row-locks the mention
 * cursor first, as ackMentions does. insertMention holds that lock while it writes a mention, so
 * the cursor update cannot see the new next_mention_seq without the new mention and skip it.
 */
const LOCK = 'SELECT 1 FROM wake_cursors WHERE agent_id=$1 FOR UPDATE';

test('ackElricMention locks the mention cursor before it marks or moves anything', async () => {
  const seen: string[] = [];
  const q = {
    async query(sql: string) {
      seen.push(sql.replace(/\s+/g, ' ').trim());
      return { rows: seen.length === 2 ? [{ seq: 3 }] : [] } as never;
    },
  };
  await ackElricMention(q as never, 'agent-1', 'room-1', 7, 1);
  assert.equal(seen[0], LOCK);
  assert.match(seen[1]!, /^UPDATE mentions /);
  assert.match(seen[2]!, /^UPDATE wake_cursors c SET/);
});

test('each mention-ack cursor update follows a cursor lock taken before its mention update', () => {
  const files = [
    'server/responder/deliver.ts',
    'server/elric/hook.ts',
    'server/rooms/service.ts',
    'server/wake/service.ts',
  ];
  let checked = 0;
  for (const file of files) {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    const pattern = /acked_mention_seq=GREATEST\(c\.acked_mention_seq/g;
    for (let match = pattern.exec(source); match; match = pattern.exec(source)) {
      const update = source.lastIndexOf('UPDATE mentions', match.index);
      assert.ok(update >= 0, `${file}: no mention update before the cursor update`);
      const lock = source.lastIndexOf('lockMentionCursor(', update);
      assert.ok(
        lock >= 0 && update - lock < 300,
        `${file}:${source.slice(0, match.index).split('\n').length} moves the cursor without locking it first`,
      );
      checked++;
    }
  }
  assert.equal(checked, 4, 'the four ack paths (ack, skipUnanswerable, Elric, person read)');
});
