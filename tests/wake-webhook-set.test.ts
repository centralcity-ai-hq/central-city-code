import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/app.js';
import type { Database, Transaction } from '../server/database.js';
import { createWake, WakeError } from '../server/wake/service.js';
import { wakeKeys } from '../server/wake/webhooks.js';

/**
 * Two overlapping sets of one agent's wake webhook (a double submit, a client retry): the set is
 * serialized per owner, and a collision on the agent's row answers 409, never a 500. Test data only.
 */
type App = Awaited<ReturnType<typeof createApp>>;
const jsonHeaders = { 'content-type': 'application/json', 'x-city-request': '1' };

async function setup(t: { after: (fn: () => Promise<unknown>) => void }) {
  const app: App = await createApp({ dataDir: ':memory:', startWorkers: false });
  t.after(() => app.close());
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    headers: jsonHeaders,
    payload: JSON.stringify({ name: 'Webhook owner', password: 'Webhook owner test password' }),
  });
  assert.equal(res.statusCode, 201, res.body);
  const cookie = `cc_session=${res.cookies.find((item) => item.name === 'cc_session')!.value}`;
  const created = await app.inject({
    method: 'POST',
    url: '/api/agents',
    headers: { ...jsonHeaders, cookie },
    payload: JSON.stringify({ name: 'Hook desk', capability: 'research', mode: 'external' }),
  });
  assert.equal(created.statusCode, 201, created.body);
  const agentId = created.json().agent.id as string;
  const operatorId = (
    await app.city.db.query<{ id: string }>('SELECT id FROM operators WHERE name=$1', [
      'Webhook owner',
    ])
  ).rows[0]!.id;
  return { db: app.city.db, agentId, operatorId };
}

/** The app's database with every transaction statement recorded, and a hook after each one. */
function recorded(db: Database, after: (sql: string, tx: Transaction) => Promise<void>) {
  const statements: string[] = [];
  const wrapped: Database = {
    ...db,
    query: (sql, params) => db.query(sql, params),
    exec: (sql) => db.exec(sql),
    close: () => db.close(),
    transaction: (action) =>
      db.transaction((tx) =>
        action({
          exec: (sql) => tx.exec(sql),
          async query(sql, params) {
            statements.push(sql);
            const result = await tx.query(sql, params);
            await after(sql, tx);
            return result as never;
          },
        }),
      ),
  };
  return { wrapped, statements };
}

function wakeOn(db: Database) {
  return createWake({
    db,
    clock: () => Date.now(),
    limit: async () => {},
    keys: wakeKeys({}, 'test-only-wake-root'),
    retryTimer: false,
  });
}

const isReplace = (sql: string) => sql.startsWith('DELETE FROM wake_webhooks WHERE agent_id=$1');

test('a set takes the per-owner lock before it replaces the row and counts the cap', async (t) => {
  const s = await setup(t);
  const { wrapped, statements } = recorded(s.db, async () => {});
  const wake = wakeOn(wrapped);
  t.after(() => wake.close());
  const set = await wake.setWebhook({ operatorId: s.operatorId, actor: 'owner' }, s.agentId, {
    url: 'https://hooks.example.com/wake',
  });
  assert.equal(set.webhook.url, 'https://hooks.example.com/wake');
  const lock = statements.findIndex((sql) => sql.includes('pg_advisory_xact_lock'));
  const replace = statements.findIndex(isReplace);
  assert.ok(lock >= 0, 'the set is serialized');
  assert.ok(replace > lock, 'the lock comes before the replace and the count');
});

test('a set that collides with another on the agent row answers 409, not a 500', async (t) => {
  const s = await setup(t);
  // The other set's row appears right after this one's replace, as when both overlap.
  const { wrapped } = recorded(s.db, async (sql, tx) => {
    if (!isReplace(sql)) return;
    await tx.query(
      `INSERT INTO wake_webhooks(id,agent_id,owner_id,url,events,salt,created_at,created_by)
       VALUES(gen_random_uuid()::text,$1,$2,'https://other.example.com/wake',ARRAY['mention'],'salt',0,'owner')`,
      [s.agentId, s.operatorId],
    );
  });
  const wake = wakeOn(wrapped);
  t.after(() => wake.close());
  await assert.rejects(
    wake.setWebhook({ operatorId: s.operatorId, actor: 'owner' }, s.agentId, {
      url: 'https://hooks.example.com/wake',
    }),
    (error: unknown) =>
      error instanceof WakeError &&
      error.statusCode === 409 &&
      error.errorCode === 'webhook_conflict',
  );
  // Nothing half-written: the transaction rolled back as a whole.
  const rows = await s.db.query('SELECT 1 FROM wake_webhooks WHERE agent_id=$1', [s.agentId]);
  assert.equal(rows.rows.length, 0);
});
