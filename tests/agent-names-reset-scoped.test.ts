import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/app.js';
import { agentNamesResetScopedMigration } from '../server/rooms/agent-names-schema.js';

/**
 * Migration 244: the workspaces agent-name trigger clears the mention keys only of agents whose
 * name can have changed (renamed, removed, added), never of every agent membership the owner has.
 * A create no longer rewrites the owner's room_members rows. Synthetic data.
 */
const headers = { 'content-type': 'application/json', 'x-city-request': '1' };

async function setup(t: { after: (fn: () => Promise<unknown>) => void }) {
  const app = await createApp({ dataDir: ':memory:', startWorkers: false });
  t.after(() => app.close());
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    headers,
    payload: JSON.stringify({ name: 'Names owner', password: 'Synthetic names reset password' }),
  });
  assert.equal(res.statusCode, 201, res.body);
  const owner = res.json().operator.id as string;
  const db = app.city.db;
  const agents = async (list: Array<{ id: string; name: string }>) =>
    db.query(
      `UPDATE workspaces SET data = jsonb_set(data, '{agents}', $2::jsonb) WHERE operator_id = $1`,
      [owner, JSON.stringify(list)],
    );
  await agents([
    { id: 'a1', name: 'Ada' },
    { id: 'b2', name: 'Bo' },
  ]);
  await db.query(
    `INSERT INTO rooms (id, slug, name, host_owner_id, host_agent_id, member_cap, history,
       link_ttl_ms, created_at, idempotency_key, request_hash)
     VALUES ('r1', 'r1', 'Room', $1, 'a1', 10, 'full', 1000, 0, 'k', 'h')`,
    [owner],
  );
  for (const id of ['a1', 'b2', 'c3'])
    await db.query(
      `INSERT INTO room_members (room_id, agent_id, owner_id, role, owner_label, visible_from_seq,
         joined_at, joined_by, name_key, slug_key)
       VALUES ('r1', $1, $2, 'member', 'Owner', 0, 0, $2, 'key', 'slug')`,
      [id, owner],
    );
  const keys = async () =>
    Object.fromEntries(
      (
        await db.query<{ agent_id: string; name_key: string | null; name_rev: number }>(
          `SELECT agent_id, name_key, name_rev FROM room_members WHERE room_id = 'r1' ORDER BY agent_id`,
        )
      ).rows.map((r) => [r.agent_id, `${r.name_key ?? 'NULL'}/${r.name_rev}`]),
    );
  const fill = () => db.query(`UPDATE room_members SET name_key = 'key' WHERE room_id = 'r1'`);
  return { agents, keys, fill };
}

test('adding an agent leaves every other membership key alone', async (t) => {
  const { agents, keys } = await setup(t);
  assert.deepEqual(await keys(), { a1: 'key/0', b2: 'key/0', c3: 'key/0' });
  await agents([
    { id: 'a1', name: 'Ada' },
    { id: 'b2', name: 'Bo' },
    { id: 'd4', name: 'Dee' },
  ]);
  assert.deepEqual(await keys(), { a1: 'key/0', b2: 'key/0', c3: 'key/0' });
});

test('a rename, a removal and a re-added id each reset only that agent', async (t) => {
  const { agents, keys, fill } = await setup(t);
  await agents([
    { id: 'a1', name: 'Ada Lovelace' },
    { id: 'b2', name: 'Bo' },
  ]);
  assert.deepEqual(await keys(), { a1: 'NULL/1', b2: 'key/0', c3: 'key/0' });
  await fill();
  await agents([{ id: 'a1', name: 'Ada Lovelace' }]);
  assert.deepEqual(await keys(), { a1: 'key/1', b2: 'NULL/1', c3: 'key/0' });
  await fill();
  // c3 has a membership from before: added back, its key is cleared.
  await agents([
    { id: 'a1', name: 'Ada Lovelace' },
    { id: 'C3', name: 'Cy' },
  ]);
  assert.deepEqual(await keys(), { a1: 'key/1', b2: 'key/1', c3: 'NULL/1' });
});

test('migration 244 replaces only the trigger function', () => {
  assert.equal(agentNamesResetScopedMigration.version, 244);
  assert.match(
    agentNamesResetScopedMigration.sql,
    /CREATE OR REPLACE FUNCTION workspaces_agent_names_reset\(\)/,
  );
  assert.doesNotMatch(agentNamesResetScopedMigration.sql, /CREATE TRIGGER|DROP TRIGGER/);
});
