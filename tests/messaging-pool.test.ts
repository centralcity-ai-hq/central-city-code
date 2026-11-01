import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { postgresDatabase } from '../server/database.js';
import { createMessaging, pairKey } from '../server/messaging/service.js';
import { emptyWorkspace, type StoredAgent } from '../server/model.js';
import { MemoryRateLimiter, PostgresRateLimiter } from '../server/rate-limit.js';

function agent(name: string): StoredAgent {
  return {
    id: randomUUID(),
    name,
    description: 'Synthetic pool regression',
    capability: 'research',
    mode: 'external',
    isDemo: false,
    lastSeenAt: null,
    createdAt: new Date(0).toISOString(),
    revokedAt: null,
    lastSequence: -1,
    announcedOnline: false,
  };
}

/**
 * A bounded-pool contract test, not a PostgreSQL concurrency or performance benchmark. With
 * `samePair`, the three overlapping sends are first messages of one pair: the modelled
 * `INSERT … ON CONFLICT DO NOTHING RETURNING` (as PostgreSQL behaves under READ COMMITTED) must
 * leave all three in the pair's one stored conversation.
 */
async function concurrentSends(samePair: boolean) {
  const shared = { sender: agent('Sender'), recipient: agent('Recipient') };
  const fixtures = Array.from({ length: 3 }, () => {
    const { sender, recipient } = samePair
      ? shared
      : { sender: agent('Sender'), recipient: agent('Recipient') };
    const workspace = emptyWorkspace();
    workspace.agents = [sender, recipient];
    workspace.connections = [
      {
        id: randomUUID(),
        fromAgentId: sender.id,
        toAgentId: recipient.id,
        createdAt: new Date(0).toISOString(),
      },
    ];
    return { operatorId: randomUUID(), sender, recipient, workspace };
  });
  const pairs = new Map<string, string>();
  let held = 0,
    peak = 0,
    arrived = 0,
    nestedAcquisitions = 0,
    fallbacks = 0,
    sharedHits = 0;
  let ready!: () => void;
  const allTransactionsStarted = new Promise<void>((resolve) => {
    ready = resolve;
  });
  // Only SQL needed for distinct, new sends is modelled. Unexpected queries fail the fixture.
  async function query(sql: string, params: unknown[] = []): Promise<{ rows: object[] }> {
    if (sql === 'BEGIN') {
      if (++arrived === 3) ready();
      await allTransactionsStarted;
      return { rows: [] };
    }
    if (sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
    if (sql.startsWith('SELECT data FROM workspaces')) {
      const fixture = fixtures.find((item) => item.operatorId === params[0]);
      assert.ok(fixture);
      return { rows: [{ data: fixture.workspace }] };
    }
    if (sql.startsWith('SELECT request_hash') || sql.startsWith('SELECT 1 FROM message_receipts'))
      return { rows: [] };
    if (sql.includes('INSERT INTO message_receipts')) return { rows: [{ message_id: params[3] }] };
    // Pair thread (docs/MESSAGING.md "Threads"): no pair has talked yet, so there is no latest
    // message; the pair's default is stored once (the first insert wins, the others read it).
    if (sql.startsWith('SELECT context_id FROM (')) return { rows: [] };
    if (sql.includes('INSERT INTO pair_contexts')) {
      const key = `${params[0]}\n${params[1]}`;
      if (pairs.has(key)) return { rows: [] };
      pairs.set(key, String(params[2]));
      return { rows: [{ context_id: params[2] }] };
    }
    if (sql.startsWith('SELECT context_id FROM pair_contexts'))
      return { rows: [{ context_id: pairs.get(`${params[0]}\n${params[1]}`) }] };
    if (sql.includes('INSERT INTO inbox_cursors') || sql.startsWith('UPDATE message_receipts'))
      return { rows: [] };
    if (sql.includes('UPDATE inbox_cursors')) return { rows: [{ seq: 1 }] };
    // Wake-up outbox (docs/WAKE.md): no webhooks registered in this fixture.
    if (sql.includes('INSERT INTO wake_outbox')) return { rows: [] };
    if (sql.includes('INSERT INTO messages'))
      return {
        rows: [
          {
            recipient_id: params[0],
            seq: params[1],
            id: params[2],
            sender_id: params[3],
            context_id: params[5],
            reply_to: params[6],
            parts: JSON.parse(String(params[7])),
            created_at: params[8],
          },
        ],
      };
    if (sql.includes('INSERT INTO rate_limits')) {
      sharedHits++;
      return { rows: [{ count: 1, expires_at: 60_000 }] };
    }
    throw new Error(`Unexpected fixture query: ${sql}`);
  }
  const pool = {
    on() {},
    async connect() {
      held++;
      peak = Math.max(peak, held);
      assert.ok(held <= 3, 'transaction clients must fit the production pool size');
      return {
        query,
        release() {
          held--;
        },
        // The transaction listens for a connection lost while checked out (#939).
        on() {},
        removeListener() {},
      };
    },
    async query(sql: string, params: unknown[]) {
      if (held === 3) {
        nestedAcquisitions++;
        // Model the acquisition timeout immediately: no wall-clock timing assertion needed.
        throw new Error('Synthetic bounded pool acquisition timeout');
      }
      return query(sql, params);
    },
    async end() {},
  };
  const db = postgresDatabase(pool as unknown as Pool);
  const memory = new MemoryRateLimiter(() => 1);
  const limiter = new PostgresRateLimiter(db, () => 1, {
    async hit(key, max, windowMs) {
      fallbacks++;
      return memory.hit(key, max, windowMs);
    },
    count: (key, windowMs) => memory.count(key, windowMs),
  });
  const messaging = createMessaging({
    db,
    clock: () => 1,
    async limit(key, max, windowMs) {
      assert.equal((await limiter.hit(key, max, windowMs)).allowed, true);
    },
  });
  const messages = await Promise.all(
    fixtures.map(({ operatorId, sender, recipient }) =>
      messaging.send({ operatorId }, sender.id, {
        to_agent_id: recipient.id,
        text: 'Synthetic concurrent message',
        idempotency_key: randomUUID(),
      }),
    ),
  );
  assert.equal(messages.length, 3);
  assert.deepEqual(
    messages.map(({ message }) => message.context_id),
    fixtures.map(({ sender, recipient }) => pairs.get(pairKey(sender.id, recipient.id).join('\n'))),
  );
  assert.equal(pairs.size, samePair ? 1 : 3);
  assert.equal(new Set(messages.map(({ message }) => message.context_id)).size, pairs.size);
  assert.equal(peak, 3, 'the test must saturate all transaction slots');
  assert.equal(held, 0, 'all transaction clients must be released');
  assert.equal(nestedAcquisitions, 0);
  assert.equal(fallbacks, 0);
  assert.equal(sharedHits, 3, 'all new sends must use the shared limiter');
}

test(
  'three concurrent messaging sends do not acquire another pool client or fall back',
  { timeout: 5000 },
  () => concurrentSends(false),
);
test(
  "overlapping first sends of one pair converge on the pair's one stored conversation",
  { timeout: 5000 },
  () => concurrentSends(true),
);
