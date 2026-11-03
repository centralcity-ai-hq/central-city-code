import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import type { Database } from '../server/database.js';
import {
  FEED_PAY_SPONSORED_CHAIN_SQL,
  feedPaySponsoredChainMigration,
} from '../server/feed/pay/sponsored-count-schema.js';
import { sponsoredOnChains, type SponsoredCalls } from '../server/feed/pay/sponsored.js';
import { chainParams } from '../server/base/chain/chain-params.js';
import { checkPaidCalls } from '../server/stats/paid-calls.js';
import { migrated, quiet } from './paid-calls-fixtures.js';

/*
 * Sponsored first purchases on Arc (2 Nov 2026): the rows name their chain (migration 359), each
 * counts in its own chain's row of paid_call_count, the daily check recounts per chain, and the
 * routes reach the engine of the agent's chain. Synthetic values only.
 */

const BASE = 8453;
const ARC = 5042;
let seq = 0;

/** A sponsored call stored as sponsored.ts stores it, on `chain` (left out: the column default). */
async function sponsored(db: Pick<Database, 'query'>, chain?: number): Promise<string> {
  seq += 1;
  const id = `sp_${seq.toString().padStart(20, '0')}`;
  const columns = chain === undefined ? '' : ', chain_id';
  const value = chain === undefined ? '' : `, ${chain}`;
  await db.query(
    `INSERT INTO feed_pay_sponsored_calls (call_id, owner_account_id, idempotency_key,
       request_hash, operator_id, agent_id, service_id, offer_id, offer_kind, offer_version,
       pay_to, gross_raw, fee_raw, input, state, op_key, created_at, updated_at, fleet${columns})
     VALUES ($1, 'acct-1', $2, 'h', 'op-1', 'agent-1', 'svc-1', 'offer-1', 'kind', 1, $3,
       40000000, 4000000, '{}', 'reserved', $4, $5, $5, true${value})`,
    [id, `idem-${seq}`, `0x${'4'.repeat(40)}`, `sfp:${id}`, 1_000 + seq],
  );
  return id;
}

async function pay(db: Pick<Database, 'transaction'>, id: string) {
  for (const set of [
    { state: 'sent', valid_before: 9 },
    { state: 'paid', tx_hash: `0x${randomBytes(32).toString('hex')}`, block_number: 7 },
  ])
    await db.transaction(async (tx) => {
      const keys = Object.keys(set);
      await tx.query(
        `UPDATE feed_pay_sponsored_calls SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')},
           updated_at = updated_at + 1 WHERE call_id = $1`,
        [id, ...Object.values(set)],
      );
    });
}

const counted = async (db: Pick<Database, 'query'>, chain: number) => {
  const row = (
    await db.query<{ total: string; value: string }>(
      'SELECT total::text, value_raw::text AS value FROM paid_call_count WHERE chain_id = $1',
      [chain],
    )
  ).rows[0];
  return { total: Number(row?.total ?? 0), value: BigInt(row?.value ?? '0') };
};

test('migration 359: a chain column defaulting to Base, no index, no rewrite, and the count follows the row', () => {
  assert.equal(feedPaySponsoredChainMigration.version, 359);
  assert.equal(feedPaySponsoredChainMigration.name, 'feed_pay_sponsored_chain');
  assert.match(FEED_PAY_SPONSORED_CHAIN_SQL, /SET LOCAL lock_timeout = '2s'/);
  assert.match(
    FEED_PAY_SPONSORED_CHAIN_SQL,
    /ADD COLUMN IF NOT EXISTS chain_id integer NOT NULL DEFAULT 8453/,
  );
  assert.match(FEED_PAY_SPONSORED_CHAIN_SQL, /VALUES \(NEW\.chain_id, 1, ARRAY\[t\], n, v\)/);
  assert.doesNotMatch(FEED_PAY_SPONSORED_CHAIN_SQL, /CREATE\s+(UNIQUE\s+)?INDEX/i);
  // The triggers of 252 are kept as they are; only the function is replaced.
  assert.doesNotMatch(FEED_PAY_SPONSORED_CHAIN_SQL, /TRIGGER/);
});

test('a Base sponsored call still counts in Base, an Arc one in Arc, and the daily check agrees on each', async (t) => {
  const db = await migrated(t);
  const before = { base: await counted(db, BASE), arc: await counted(db, ARC) };
  // The default: every row stored without a chain is Base's, as every row before 359.
  await pay(db, await sponsored(db));
  await pay(db, await sponsored(db, BASE));
  await pay(db, await sponsored(db, ARC));
  const base = await counted(db, BASE);
  const arc = await counted(db, ARC);
  assert.equal(base.total - before.base.total, 2);
  assert.equal(base.value - before.base.value, 80_000_000n);
  assert.equal(arc.total - before.arc.total, 1);
  assert.equal(arc.value - before.arc.value, 40_000_000n);
  for (const chainId of [BASE, ARC]) {
    await checkPaidCalls(db, { chainId, log: quiet });
    assert.deepEqual(await counted(db, chainId), chainId === BASE ? base : arc, `chain ${chainId}`);
  }
});

test('the routes reach the engine of the agent chain; calls, steps and credits span both', async () => {
  const seen: string[] = [];
  const engine = (name: string, holds: Set<string>): SponsoredCalls =>
    ({
      async start(_account: string, call: { agentId: string }) {
        seen.push(`${name}:start:${call.agentId}`);
        return { callId: `${name}-call` } as never;
      },
      async step(callId: string) {
        return holds.has(callId);
      },
      async work() {
        seen.push(`${name}:work`);
        return name === 'base' ? 2 : 3;
      },
      async callFor(_account: string, callId: string) {
        return holds.has(callId) ? ({ callId } as never) : null;
      },
      authorize: async () => new Set<string>(),
      async credit() {
        return {
          agents: [{ agentId: `${name}-agent` } as never],
          serviceIds: [`svc-${name}`, 'svc-shared'],
          maxPriceRaw: '40000000',
        };
      },
    }) as unknown as SponsoredCalls;
  const both = sponsoredOnChains({
    base: engine('base', new Set(['b1'])),
    others: new Map([[ARC, engine('arc', new Set(['a1']))]]),
    agentChain: async (agentId) => (agentId.startsWith('arc') ? ARC : BASE),
  });
  await both.start('acct', { agentId: 'arc-7' } as never);
  await both.start('acct', { agentId: 'base-7' } as never);
  assert.deepEqual(seen, ['arc:start:arc-7', 'base:start:base-7']);
  assert.equal(await both.step('a1'), true);
  assert.equal(await both.step('nobody'), false);
  assert.deepEqual(await both.callFor('acct', 'a1'), { callId: 'a1' });
  assert.equal(await both.callFor('acct', 'nobody'), null);
  assert.equal(await both.work({ maxCalls: 10, budgetMs: 1000 }), 5);
  const credit = await both.credit('acct');
  assert.deepEqual(
    credit.agents.map((a) => a.agentId),
    ['base-agent', 'arc-agent'],
  );
  assert.deepEqual(credit.serviceIds, ['svc-base', 'svc-shared', 'svc-arc']);
});

test('one chain failing its pass leaves the other one moving', async () => {
  const ok = { work: async () => 4 } as unknown as SponsoredCalls;
  const broken = {
    work: async () => {
      throw new Error('Arc down');
    },
  } as unknown as SponsoredCalls;
  const both = sponsoredOnChains({
    base: ok,
    others: new Map([[ARC, broken]]),
    agentChain: async () => BASE,
  });
  assert.equal(await both.work({ maxCalls: 10, budgetMs: 1000 }), 4);
});

test('with no other chain the facade is Base engine itself', () => {
  const base = {} as SponsoredCalls;
  assert.equal(sponsoredOnChains({ base, others: new Map(), agentChain: async () => BASE }), base);
});

test('Arc sponsor hot-wallet figures fit the 40 USDC test; alerts only', () => {
  const arc = chainParams(ARC).hotWallets.sfp_sponsor!;
  assert.equal(arc.usdc!.outflowPerHour, 200_000_000_000n);
  assert.equal(arc.usdc!.ceiling, 250_000_000_000n);
});
