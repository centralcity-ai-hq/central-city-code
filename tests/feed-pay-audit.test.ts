import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { getAddress, type Hex } from 'viem';
import type { UserOperation } from 'viem/account-abstraction';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import {
  LIMIT_PERMISSION_END,
  permissionToJson,
  spendPermissionHash,
} from '../shared/base/spend-limits.js';
import type { SpendPermission } from '../shared/base/types.js';
import { FEED_PAY_PATHS, type FeedPayCall } from '../shared/feed-pay.js';
import { BODY, CHAIN_ID, json, PAY_TO, setup, SVC, USDC } from './helpers/feed-pay-app.js';
import { SETTLE } from './helpers/feed-pay-fake-base.js';

/*
 * Regression tests for the review findings on Feed pay ("Use with my agent"). Each test is named
 * after its finding and fails until that finding is fixed. They reuse the Feed pay app fixture
 * (tests/helpers/feed-pay-app.ts) over the fake x402 service and the fake Base: nothing reaches a
 * network and no real payment is ever made. Synthetic data only.
 *
 * The client findings (leaving the sheet while paying, the copy with pay on) need the browser and
 * the signed-in pay access, so they live in e2e/feed-pay-audit.spec.ts.
 */

type Fixture = Awaited<ReturnType<typeof setup>>;

const perCallMax = (f: Fixture, perCallMaxRaw: string | null) =>
  f.app.inject({
    method: 'PUT',
    url: FEED_PAY_PATHS.agent.replace(':agentId', f.agentId),
    headers: { ...json, cookie: f.owner.cookie },
    payload: JSON.stringify({ perCallMaxRaw }),
  });

/**
 * A call that was not paid: refused before anything was reserved (a 4xx), or reserved and then
 * ended refused with no money moved. Either shape passes; a paid call never does.
 */
function assertRefused(
  res: { statusCode: number; body: string; json: () => unknown },
  why: string,
) {
  if (res.statusCode >= 400 && res.statusCode < 500) return;
  const call = res.json() as Partial<FeedPayCall>;
  assert.ok(
    res.statusCode === 200 && call.state === 'refused' && call.moneyMoved === 'no',
    `expected a refusal (${why}), got ${res.statusCode}: ${res.body}`,
  );
}

/** Polls the call until it is done or `rounds` reads passed; answers it as it is then. */
async function follow(f: Fixture, callId: string, rounds = 200): Promise<FeedPayCall> {
  let call = (await f.status(callId)).json() as FeedPayCall;
  for (let i = 0; i < rounds && !call.done; i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    call = (await f.status(callId)).json() as FeedPayCall;
  }
  return call;
}

const serviceCallArgs = (f: Fixture, extra: Record<string, unknown> = {}) => ({
  service_id: `https://centralcity.ai/feed/services/${SVC}`,
  agent_id: f.agentId,
  inputs: BODY,
  max_price_usdc: '0.05',
  idempotency_key: randomUUID(),
  ...extra,
});

// ---------------------------------------------------------------------------------------------
// 1. pay scope

test('finding 1 (pay scope): the pre-existing pay scope and Base Pay consent do not let city_service_call pay', async (t) => {
  const f = await setup(t);
  await f.list();
  const permission = await f.limit();
  // Everything the pre-existing Base Pay needs: a grant with `pay` and the agent-pay consent.
  const basePay = await f.grant(['workspace:read', 'pay']);
  assert.equal((await f.consent(permission.hash)).statusCode, 200);

  const res = await f.tool(basePay.token, 'city_service_call', serviceCallArgs(f));
  // Either fix passes: a scope of its own (403 for the missing scope) or a fresh, Feed-pay-specific
  // consent (refused for the missing consent). Never a paid call.
  assert.ok(
    res.statusCode >= 400 && res.statusCode < 500,
    `expected a refusal, got ${res.statusCode}: ${res.body}`,
  );
  assert.equal(f.service.paid().length, 0, 'nothing was sent to the service');
  assert.equal(f.base.balanceOf(PAY_TO), 0n, 'nothing was paid');
  assert.equal((await f.sql('SELECT 1 FROM feed_pay_calls')).length, 0, 'no call was reserved');
});

// ---------------------------------------------------------------------------------------------
// 2. price binding

test('finding 2 (price binding): a live price above the confirmed quote is refused even under maxAmountRaw', async (t) => {
  const f = await setup(t);
  // The quote reads 0.02; every later read asks 0.09.
  await f.list({ amount: '20000', priceChangeAfter: 1, nextAmount: '90000' });
  await f.limit();
  const q = await f.quote();
  assert.equal(q.statusCode, 200, q.body);
  assert.equal(q.json().amount.raw, '20000');

  const res = await f.callService({
    agentId: f.agentId,
    inputs: BODY,
    quoteId: q.json().quoteId,
    // A client that sends more than the confirmed quote (the per-call maximum of 0.10).
    maxAmountRaw: '100000',
    idempotencyKey: randomUUID(),
  });
  assertRefused(res, 'quote_mismatch or similar');
  assert.equal(f.service.paid().length, 0, 'no paid request');
  assert.equal(f.base.balanceOf(PAY_TO), 0n, 'nothing paid');
});

// ---------------------------------------------------------------------------------------------
// 3. payee binding

test('finding 3 (payee binding): a payee that changed after the quote is refused; nothing goes to the new payee', async (t) => {
  const f = await setup(t);
  await f.list();
  await f.limit();
  const q = await f.quote();
  assert.equal(q.json().payTo, PAY_TO, q.body);

  // The listing (and its live 402) now name another payee.
  const other = getAddress(`0x${'b2'.repeat(20)}`);
  await f.list({ payTo: other });
  const res = await f.callService({
    agentId: f.agentId,
    inputs: BODY,
    quoteId: q.json().quoteId,
    maxAmountRaw: q.json().amount.raw,
    idempotencyKey: randomUUID(),
  });
  assertRefused(res, 'payee changed since the quote');
  assert.equal(f.service.paid().length, 0, 'no paid request');
  assert.equal(f.base.balanceOf(other), 0n, 'nothing paid to the new payee');
  assert.equal(f.base.balanceOf(PAY_TO), 0n);
});

// ---------------------------------------------------------------------------------------------
// 4. hard cap

test('finding 4 (hard cap): a per-call maximum above 0.10 USDC is refused; a 0.11 service is not payable', async (t) => {
  const f = await setup(t);
  await f.limit();
  for (const raw of ['100001', '200000']) {
    const put = await perCallMax(f, raw);
    assert.ok(
      put.statusCode >= 400 && put.statusCode < 500,
      `per-call maximum ${raw} must be refused: ${put.statusCode} ${put.body}`,
    );
  }
  // The highest allowed maximum stays possible.
  assert.equal((await perCallMax(f, '100000')).statusCode, 200);

  await f.list({ amount: '110000' });
  const q = await f.quote();
  assert.equal(q.statusCode, 200, q.body);
  if (q.json().payable) {
    // A quote that still says payable must not lead to a payment with a higher max requested.
    const res = await f.callService({
      agentId: f.agentId,
      inputs: BODY,
      quoteId: q.json().quoteId,
      maxAmountRaw: '200000',
      idempotencyKey: randomUUID(),
    });
    assertRefused(res, 'over the 0.10 USDC hard cap');
  }
  assert.equal(q.json().payable, false, 'a service priced above 0.10 USDC is not payable');
  assert.equal(f.service.paid().length, 0, 'no paid request');
  assert.equal(f.base.balanceOf(PAY_TO), 0n);
});

// ---------------------------------------------------------------------------------------------
// 5. float top-up vs allowance

test('finding 5 (float top-up vs allowance): a 0.02 call does not pull the whole 1 USDC daily allowance', async (t) => {
  const f = await setup(t, { cap: 1_000_000n });
  await f.list();
  await f.limit(1_000_000n);
  const res = await f.pay();
  assert.equal(res.statusCode, 200, res.body);
  const call = await follow(f, res.json().callId);
  assert.equal(call.state, 'result_saved', JSON.stringify(call));

  const moves = await f.sql<{ amount: string }>(
    "SELECT amount_raw::text AS amount FROM feed_pay_float_moves WHERE kind = 'top_up'",
  );
  assert.equal(moves.length, 1);
  const topUp = BigInt(moves[0]!.amount);
  assert.ok(topUp >= 20_000n, 'the top-up covers the call');
  assert.ok(
    topUp < 1_000_000n,
    `the top-up (${topUp}) must leave allowance for other payments (allowance 1000000)`,
  );
  // What the limit still allows on Base (the city_pay-style check) has room after the call.
  const spentOnBase = f.base.state.spent.get(f.wallet.toLowerCase()) ?? 0n;
  assert.ok(1_000_000n - spentOnBase > 0n, `allowance left on Base: ${1_000_000n - spentOnBase}`);
});

// ---------------------------------------------------------------------------------------------
// 6. reverted top-up

test('finding 6 (reverted top-up): a top-up included with a revert never leads to a signed or sent payment', async (t) => {
  const f = await setup(t);
  await f.list();
  await f.limit();
  const reverted = new Set<Hex>();
  // Every operation lands in a block but reverts: no USDC moves, the receipt and the
  // UserOperationEvent say success=false, and it is not deep yet (included, not final).
  const send = f.base.bundler.send.bind(f.base.bundler);
  f.base.bundler.send = async (op: UserOperation<'0.6'>) => {
    const walletBefore = f.base.balanceOf(f.wallet);
    const spenderBefore = f.base.balanceOf(f.base.spender);
    const spentBefore = f.base.state.spent.get(f.wallet.toLowerCase()) ?? 0n;
    const hash = await send(op);
    f.base.credit(f.wallet, walletBefore - f.base.balanceOf(f.wallet));
    f.base.credit(f.base.spender, spenderBefore - f.base.balanceOf(f.base.spender));
    f.base.state.spent.set(f.wallet.toLowerCase(), spentBefore);
    f.base.state.head -= SETTLE;
    reverted.add(hash);
    return hash;
  };
  const receipt = f.base.bundler.receipt.bind(f.base.bundler);
  f.base.bundler.receipt = async (userOpHash: Hex) => {
    const found = await receipt(userOpHash);
    return found && reverted.has(userOpHash) ? { ...found, success: false } : found;
  };
  const client = f.base.client as unknown as {
    getLogs: (query: { args: Record<string, string> }) => Promise<Array<{ args: object }>>;
  };
  const getLogs = client.getLogs.bind(client);
  client.getLogs = async (query) => {
    const logs = await getLogs(query);
    return reverted.has(query.args?.userOpHash as Hex)
      ? logs.map((log) => ({ ...log, args: { ...log.args, success: false } }))
      : logs;
  };

  const res = await f.pay();
  assert.equal(res.statusCode, 200, res.body);
  const call = await follow(f, res.json().callId);
  assert.ok(reverted.size >= 1, 'the top-up was sent');
  assert.equal(f.service.paid().length, 0, 'no paid request after a reverted top-up');
  assert.equal(f.base.balanceOf(PAY_TO), 0n);
  assert.notEqual(call.moneyMoved, 'yes', JSON.stringify(call));
  // It waits for the top-up's outcome, or ends float_topup_failed; never past the top-up.
  if (call.done) {
    assert.equal(call.state, 'refused', JSON.stringify(call));
    assert.equal(call.failure?.code, 'float_topup_failed', JSON.stringify(call));
  } else assert.equal(call.state, 'float_topup', JSON.stringify(call));
  assert.equal(call.payment?.state ?? null, null, 'no payment was signed');
});

// ---------------------------------------------------------------------------------------------
// 7. concurrent top-ups

test('finding 7 (concurrent top-ups): two calls on one wallet started together pull the float at most once', async (t) => {
  const f = await setup(t);
  await f.list();
  await f.limit();
  // Lines up the limit reads of both calls (each read waits for the other, briefly), so both
  // workers plan their top-up at the same moment, as two requests on two instances can.
  const client = f.base.client as unknown as {
    readContract: (call: { functionName: string }) => Promise<unknown>;
  };
  const readContract = client.readContract.bind(client);
  let waiting: (() => void) | null = null;
  client.readContract = async (call) => {
    if (call.functionName === 'getCurrentPeriod') {
      if (waiting) {
        const release = waiting;
        waiting = null;
        release();
      } else
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            waiting = null;
            resolve();
          }, 150);
          waiting = () => {
            clearTimeout(timer);
            resolve();
          };
        });
    }
    return readContract(call);
  };
  const q1 = (await f.quote()).json();
  const q2 = (await f.quote()).json();
  const body = (q: { quoteId: string; amount: { raw: string } }) => ({
    agentId: f.agentId,
    inputs: BODY,
    quoteId: q.quoteId,
    maxAmountRaw: q.amount.raw,
    idempotencyKey: randomUUID(),
  });
  const [a, b] = await Promise.all([f.callService(body(q1)), f.callService(body(q2))]);
  assert.equal(a.statusCode, 200, a.body);
  assert.equal(b.statusCode, 200, b.body);
  await follow(f, a.json().callId);
  await follow(f, b.json().callId);
  const spends = f.base.state.effects.filter((effect) => effect === 'spend').length;
  const topUps = await f.sql("SELECT 1 FROM feed_pay_float_moves WHERE kind = 'top_up'");
  assert.ok(spends <= 1, `at most one top-up spend on Base, saw ${spends}`);
  assert.ok(topUps.length <= 1, `at most one top-up planned, saw ${topUps.length}`);
});

// ---------------------------------------------------------------------------------------------
// 8. sweep starvation

test('finding 8 (sweep starvation): a float behind 25 older floats with nothing to sweep is still swept', async (t) => {
  const f = await setup(t);
  await f.list();
  await f.limit();
  // The agent's float: opened by a call, then its limit is revoked (it has to go back; the end of
  // a Base period alone no longer is a reason, docs/FEED_PAY.md section 8).
  const paid = await f.pay();
  assert.equal(paid.json().state, 'result_saved', paid.body);
  const float = f.base.balanceOf(f.base.spender);
  assert.ok(float > 0n);
  await f.sql(
    `UPDATE base_spend_permissions SET state = 'revoked', revoked_block = 1
     WHERE wallet_id = $1 AND state <> 'revoked'`,
    [f.walletId],
  );
  f.advance(86_400_000 + 60_000);
  const nowS = Math.floor(f.clock() / 1000);

  // 25 older open floats, each inside its period under its current limit: nothing to sweep now.
  const [workspace] = await f.sql<{ agent: Record<string, unknown> }>(
    "SELECT data->'agents'->0 AS agent FROM workspaces WHERE operator_id = $1",
    [f.owner.id],
  );
  assert.ok(workspace);
  for (let i = 0; i < 25; i++) {
    const agentId = `agent-sweep-${String(i).padStart(2, '0')}-${randomUUID().slice(0, 8)}`;
    const walletId = `wallet-${agentId}`;
    const address = privateKeyToAccount(generatePrivateKey()).address;
    const spender = privateKeyToAccount(generatePrivateKey()).address;
    await f.sql(
      `UPDATE workspaces SET data = jsonb_set(data, '{agents}',
         (data->'agents') || jsonb_build_array($1::jsonb || jsonb_build_object('id', $2::text,
           'name', $3::text)))
       WHERE operator_id = $4`,
      [JSON.stringify(workspace.agent), agentId, `Kept ${i}`, f.owner.id],
    );
    await f.sql(
      `INSERT INTO base_wallets (wallet_id, agent_id, operator_id, chain_id, address,
         owner_address, spender_address, spender_key_ref, derivation, state, created_at,
         updated_at, owner_account_id)
       VALUES ($1, $2, $3, $4, $5, $5, $6, 'v1:00000000-0000-4000-8000-000000000002', '{}',
         'derived', 1, 1, $3)`,
      [walletId, agentId, f.owner.id, CHAIN_ID, address, spender],
    );
    const permission: SpendPermission = {
      account: getAddress(address),
      spender: getAddress(spender),
      token: getAddress(USDC),
      allowance: 5_000_000n,
      period: 86_400 * 30,
      start: nowS - 86_400,
      end: LIMIT_PERMISSION_END,
      salt: BigInt(i + 1),
      extraData: '0x',
    };
    const permissionId = randomUUID();
    await f.sql(
      `INSERT INTO base_spend_permissions (permission_id, wallet_id, chain_id, permission,
         signature, state, token, permission_hash, period_kind, cap_raw, onchain_model,
         owner_account_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 'signed', $6, $7, 'day', $8, 'full', $9, $10, $10)`,
      [
        permissionId,
        walletId,
        CHAIN_ID,
        JSON.stringify(permissionToJson(permission)),
        Buffer.from('ab'.repeat(65), 'hex'),
        USDC.toLowerCase(),
        spendPermissionHash(CHAIN_ID, permission).toLowerCase(),
        '5000000',
        f.owner.id,
        f.clock(),
      ],
    );
    await f.sql(
      `INSERT INTO feed_pay_agent_settings (wallet_id, float_open, float_period_end,
         float_permission_id, updated_at)
       VALUES ($1, true, $2, $3, $4)`,
      [walletId, nowS + 20 * 86_400, permissionId, i + 1],
    );
  }

  for (let run = 0; run < 4 && f.base.balanceOf(f.base.spender) > 0n; run++) {
    f.advance(60_000);
    assert.equal((await f.cron()).statusCode, 200);
  }
  assert.equal(
    f.base.balanceOf(f.base.spender),
    0n,
    'the float behind the 25 kept floats was swept within a few cron runs',
  );
  const sweeps = await f.sql<{ wallet_id: string }>(
    "SELECT wallet_id FROM feed_pay_float_moves WHERE kind = 'sweep'",
  );
  assert.deepEqual(
    sweeps.map((row) => row.wallet_id),
    [f.walletId],
  );
});

// ---------------------------------------------------------------------------------------------
// 9. client double payment (browser)

test.todo(
  'finding 9 (client double payment): covered in the browser, e2e/feed-pay-audit.spec.ts (leaving the sheet while paying)',
);

// ---------------------------------------------------------------------------------------------
// 10. 'Nothing was paid' while paying

test('finding 10 (nothing was paid while paying): a transient database error while waiting for a started call is not a busy refusal', async (t) => {
  const f = await setup(t);
  await f.list();
  await f.limit();
  const q = (await f.quote()).json();
  // Once the call is reserved and its work started, reads of the call fail for a moment.
  const db = f.db as unknown as {
    query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
  };
  const query = db.query.bind(db);
  let loads = 0;
  let failing = true;
  db.query = async (sql, params) => {
    if (failing && /WHERE c\.call_id = \$1/.test(sql) && !/FOR UPDATE/.test(sql)) {
      loads++;
      // The first read is the one engine.call answers with; every later one fails.
      if (loads > 1)
        throw Object.assign(new Error('canceling statement due to statement timeout'), {
          code: '57014',
        });
    }
    return query(sql, params);
  };
  const res = await f.callService({
    agentId: f.agentId,
    inputs: BODY,
    quoteId: q.quoteId,
    maxAmountRaw: q.amount.raw,
    idempotencyKey: randomUUID(),
  });
  failing = false;
  assert.ok(loads > 1, 'the wait read the call after the work started');
  const body = res.json() as Record<string, unknown>;
  const [stored] = await f.sql<{ call_id: string }>('SELECT call_id FROM feed_pay_calls');
  assert.ok(stored, 'the call was reserved');
  // Never the busy refusal the drawer shows as "Nothing was paid".
  assert.notEqual(body.code, 'busy', res.body);
  // The call as it is (its id to follow), or a retryable lost-answer shape that is not a refusal.
  if (res.statusCode === 200) assert.equal(body.callId, stored.call_id, res.body);
  else assert.equal(body.retryable, true, res.body);
});

// ---------------------------------------------------------------------------------------------
// 11. copy

test.todo(
  'finding 11 (copy with pay on): the drawer only knows pay access in the browser (a server render is always "unknown"); covered in e2e/feed-pay-audit.spec.ts',
);
