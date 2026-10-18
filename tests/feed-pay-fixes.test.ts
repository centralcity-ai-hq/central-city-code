import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { consentPage, SCOPE_TEXT } from '../server/oauth/pages.js';
import { INITIAL_KEY_SCOPES } from '../server/workspaces/service.js';
import { floatTopUp } from '../server/feed/pay/engine.js';
import { jsonTooDeep, withoutQuery } from '../server/feed/pay/inputs.js';
import type { FeedPayChainPort } from '../server/base/chain/feed-pay-chain.js';
import {
  DEFAULT_FLOAT_RAW,
  FEED_PAY_LIMITS,
  FEED_PAY_PATHS,
  type FeedPayCall,
} from '../shared/feed-pay.js';
import type { FeedSchemaSummary } from '../shared/feed.js';
import {
  BODY,
  CHAIN_ID,
  json,
  PAY_TO,
  setup,
  SVC,
  USDC,
  type FeedPayApp,
} from './helpers/feed-pay-app.js';

/*
 * Feed pay ("Use with my agent"), the server fixes of the D6 review: each test names the finding
 * it guards. The app fixture (tests/helpers/feed-pay-app.ts) runs the real routes, engine, chain
 * side and MCP tool on PGlite against a fake x402 service and a fake Base: nothing reaches a
 * network and no real payment is made. Synthetic data only.
 */

/** Polls the call until it is done or `rounds` reads passed; answers it as it is then. */
async function follow(f: FeedPayApp, callId: string, rounds = 300): Promise<FeedPayCall> {
  let call = (await f.status(callId)).json() as FeedPayCall;
  for (let i = 0; i < rounds && !call.done; i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    call = (await f.status(callId)).json() as FeedPayCall;
  }
  return call;
}

/** Wraps the chain port every engine step builds (the fixture builds one per step). */
function wrapChain(f: FeedPayApp, wrap: (port: FeedPayChainPort) => FeedPayChainPort) {
  const chainFor = f.base.chainFor.bind(f.base);
  let builds = 0;
  f.base.chainFor = ((db: Parameters<typeof chainFor>[0]) => {
    builds++;
    return wrap(chainFor(db));
  }) as typeof f.base.chainFor;
  return { builds: () => builds };
}

/** The owner replaces the agent's spending limit (the old one is revoked). */
async function replaceLimit(f: FeedPayApp) {
  await f.sql(
    `UPDATE base_spend_permissions SET state = 'revoked', revoked_block = 1
     WHERE wallet_id = $1 AND state <> 'revoked'`,
    [f.walletId],
  );
  return f.limit();
}

const pauseWorkspace = (f: FeedPayApp, paused: boolean) =>
  f.sql(
    `UPDATE workspaces SET data = jsonb_set(data, '{paused}', $2::jsonb) WHERE operator_id = $1`,
    [f.owner.id, JSON.stringify(paused)],
  );

/** The confirm body of a fresh quote. */
async function confirmed(f: FeedPayApp, inputs: unknown = BODY) {
  const q = await f.quote(inputs);
  assert.equal(q.statusCode, 200, q.body);
  assert.equal(q.json().payable, true, q.body);
  return {
    agentId: f.agentId,
    inputs,
    quoteId: q.json().quoteId as string,
    maxAmountRaw: q.json().amount.raw as string,
    idempotencyKey: randomUUID(),
  };
}

/** Leaves a call `authorized` (signed, never sent) with no worker: stored() fails once. */
async function signedButStopped(f: FeedPayApp) {
  let failOnce = true;
  wrapChain(f, (port) => ({
    ...port,
    stored: async (paymentId: string) => {
      if (failOnce) {
        failOnce = false;
        throw new Error('stored read failed once');
      }
      return port.stored(paymentId);
    },
  }));
  const body = await confirmed(f);
  const res = await f.callService(body);
  assert.equal(res.statusCode, 200, res.body);
  const [row] = await f.sql<{ state: string; lease_until: string }>(
    'SELECT state, lease_until::text AS lease_until FROM feed_pay_calls WHERE call_id = $1',
    [res.json().callId],
  );
  assert.equal(row!.state, 'authorized');
  assert.equal(row!.lease_until, '0', 'no worker holds it');
  return { body, callId: res.json().callId as string };
}

// ---------------------------------------------------------------------------------------------
// A late worker never sends

test('stale authorization: a same-key retry after the window never sends it', async (t) => {
  const f = await setup(t);
  await f.list();
  await f.limit();
  const { body, callId } = await signedButStopped(f);
  f.advance(200_000);
  const again = await f.callService(body);
  assert.equal(again.statusCode, 200, again.body);
  const call = await follow(f, callId);
  assert.equal(f.service.paid().length, 0, 'no paid request with a stale authorization');
  assert.ok(!f.alerts.some((a) => a.kind === 'payment_rejected'), 'no false ops alert');
  assert.notEqual(call.moneyMoved, 'yes');
  assert.ok(['reconciling', 'expired', 'cancelled'].includes(call.state), JSON.stringify(call));
  assert.equal(call.failure?.code, 'interrupted');
});

test('stale authority: a same-key retry inside the window does not send once the agent is paused', async (t) => {
  const f = await setup(t);
  await f.list();
  await f.limit();
  const { body, callId } = await signedButStopped(f);
  await pauseWorkspace(f, true);
  f.advance(5_000);
  await f.callService(body);
  const call = await follow(f, callId, 20);
  assert.equal(f.service.paid().length, 0, 'not sent after the pause');
  assert.notEqual(call.moneyMoved, 'yes');
  assert.equal(call.failure?.code, 'interrupted');
  // Unpaused, a retry inside the window would have paid (the control).
  await pauseWorkspace(f, false);
});

// ---------------------------------------------------------------------------------------------
// Typed inputs are not kept

test('typed query values leave the stored call with the body', async (t) => {
  const f = await setup(t);
  const input: FeedSchemaSummary = {
    format: 'json',
    fields: [{ name: 'name', in: 'query', type: 'string', required: true, description: '' }],
    more: 0,
    example: null,
    exampleState: 'whole',
  } as unknown as FeedSchemaSummary;
  await f.list({ method: 'GET', url: 'https://www.ax1.example/api/lookup?name=example' }, input);
  await f.limit();
  const inputs = { query: { name: 'Private Person Name' } };
  const res = await f.pay(inputs);
  assert.equal(res.statusCode, 200, res.body);
  const call = await f.settled(res.json().callId);
  assert.equal(call.state, 'result_saved');
  assert.match(f.service.paid()[0]!.url, /Private/, 'the service got the typed query');
  const [row] = await f.sql<{ request_url: string; request_body: string | null; req: string }>(
    'SELECT request_url, request_body, requirements::text AS req FROM feed_pay_calls',
  );
  assert.equal(row!.request_url, 'https://www.ax1.example/api/lookup');
  assert.equal(row!.request_body, null);
  assert.doesNotMatch(row!.req, /Private/);
  assert.equal(withoutQuery('https://a.example/p?x=1#h'), 'https://a.example/p');
});

// ---------------------------------------------------------------------------------------------
// The agents list

test('agents: ready agents first, at most agentsMax, rate limited per person', async (t) => {
  const f = await setup(t);
  await f.limit();
  // Older wallets than hhuo's, without a spending limit (not ready).
  const [workspace] = await f.sql<{ agent: Record<string, unknown> }>(
    "SELECT data->'agents'->0 AS agent FROM workspaces WHERE operator_id = $1",
    [f.owner.id],
  );
  const extra = FEED_PAY_LIMITS.agentsMax;
  for (let i = 0; i < extra; i++) {
    const agentId = `agent-list-${String(i).padStart(2, '0')}-${randomUUID().slice(0, 8)}`;
    await f.sql(
      `UPDATE workspaces SET data = jsonb_set(data, '{agents}', (data->'agents') ||
         jsonb_build_array($1::jsonb || jsonb_build_object('id', $2::text, 'name', $3::text)))
       WHERE operator_id = $4`,
      [JSON.stringify(workspace!.agent), agentId, `Spare ${i}`, f.owner.id],
    );
    const address = privateKeyToAccount(generatePrivateKey()).address;
    await f.sql(
      `INSERT INTO base_wallets (wallet_id, agent_id, operator_id, chain_id, address,
         owner_address, spender_address, spender_key_ref, derivation, state, created_at,
         updated_at, owner_account_id)
       VALUES ($1, $2, $3, $4, $5, $5, $6, 'v1:00000000-0000-4000-8000-000000000003', '{}',
         'derived', 0, 0, $3)`,
      [`wallet-${agentId}`, agentId, f.owner.id, CHAIN_ID, address, f.base.spender],
    );
  }
  const res = await f.agents();
  assert.equal(res.statusCode, 200, res.body);
  const list = res.json() as { agents: Array<{ agentId: string; ready: boolean }>; more?: boolean };
  assert.equal(list.agents.length, FEED_PAY_LIMITS.agentsMax);
  assert.equal(list.more, true);
  assert.equal(list.agents[0]!.agentId, f.agentId, 'the agent that can pay comes first');
  assert.equal(list.agents[0]!.ready, true);
  assert.ok(list.agents.slice(1).every((agent) => !agent.ready));
  // At most agentsPerMinute answers a minute for one person.
  let limited = 0;
  for (let i = 0; i < FEED_PAY_LIMITS.agentsPerMinute + 1; i++)
    if ((await f.agents()).statusCode === 429) limited++;
  assert.ok(limited >= 1, 'the agents list is rate limited');
});

// ---------------------------------------------------------------------------------------------
// History reads Base only when there is something to read

test('history: a wallet Feed pay never touched reads no node', async (t) => {
  const f = await setup(t);
  const chain = wrapChain(f, (port) => port);
  const res = await f.history();
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().readyForServices.raw, '0');
  assert.equal(chain.builds(), 0, 'no chain read for an idle wallet');
  // With a float, it reads it.
  await f.list();
  await f.limit();
  assert.equal((await f.pay()).json().state, 'result_saved');
  const before = chain.builds();
  const after = (await f.history()).json();
  assert.ok(chain.builds() > before);
  assert.equal(after.readyForServices.raw, String(DEFAULT_FLOAT_RAW - 20_000));
});

// ---------------------------------------------------------------------------------------------
// Sweeps and their alerts

/** Opens the float, then makes the given sweep op outcome what Base says about every sweep. */
async function sweepWith(
  f: FeedPayApp,
  outcome: { status: 'failed'; errorCode: string; neverSent: boolean },
) {
  await f.list();
  await f.limit();
  assert.equal((await f.pay()).json().state, 'result_saved');
  wrapChain(f, (port) => ({
    ...port,
    sweep: async () => {
      throw new Error('not sent');
    },
    opStatus: async (key: string, walletId: string) =>
      key.startsWith('feed-pay:sweep:')
        ? {
            key,
            status: outcome.status,
            txHash: null,
            blockNumber: null,
            neverSent: outcome.neverSent,
            errorCode: outcome.errorCode,
          }
        : port.opStatus(key, walletId),
  }));
  await pauseWorkspace(f, true);
  f.advance(60_000);
  await f.cron();
  f.advance(60_000);
  await f.cron();
  const moves = await f.sql<{ state: string; reason: string }>(
    "SELECT state, reason FROM feed_pay_float_moves WHERE kind = 'sweep' ORDER BY created_at",
  );
  assert.ok(moves.length >= 1, 'a sweep was planned');
  assert.equal(moves[0]!.reason, 'agent_paused', 'a paused agent is a reason to sweep');
  assert.equal(moves[0]!.state, 'failed');
}

test('sweeps: one refused before it was sent is no failure (no ops alert)', async (t) => {
  const f = await setup(t);
  await sweepWith(f, { status: 'failed', errorCode: 'REFUSED_BEFORE_BROADCAST', neverSent: true });
  assert.ok(!f.alerts.some((a) => a.kind === 'sweep_failed'), JSON.stringify(f.alerts));
});

test('sweeps: one that failed on Base alerts ops', async (t) => {
  const f = await setup(t);
  await sweepWith(f, { status: 'failed', errorCode: 'USEROP_REVERTED', neverSent: false });
  assert.ok(
    f.alerts.some((a) => a.kind === 'sweep_failed'),
    JSON.stringify(f.alerts),
  );
});

test('sweeps: never while a call of the wallet is live; a replaced limit is a reason', async (t) => {
  const f = await setup(t);
  await f.list();
  await f.limit();
  const paid = (await f.pay()).json() as FeedPayCall;
  assert.equal(paid.state, 'result_saved');
  const float = f.base.balanceOf(f.base.spender);
  // A signed call held by a live worker (its lease runs): the sweep waits.
  await f.sql(
    `UPDATE feed_pay_calls SET state = 'authorized', payment_state = 'signed',
       lease_until = $2 WHERE call_id = $1`,
    [paid.callId, f.clock() + 3_600_000],
  );
  await replaceLimit(f); // a new limit replaces the one the float was pulled under
  f.advance(60_000);
  await f.cron();
  assert.equal(f.base.balanceOf(f.base.spender), float, 'kept while a call is live');
  assert.equal((await f.sql("SELECT 1 FROM feed_pay_float_moves WHERE kind = 'sweep'")).length, 0);
  // Once the call is over, the next run sweeps it back for the replaced limit.
  await f.sql(
    `UPDATE feed_pay_calls SET state = 'result_saved', payment_state = 'settled', lease_until = 0
     WHERE call_id = $1`,
    [paid.callId],
  );
  f.advance(60_000);
  await f.cron();
  await f.cron();
  assert.equal(f.base.balanceOf(f.base.spender), 0n);
  const [sweep] = await f.sql<{ reason: string }>(
    "SELECT reason FROM feed_pay_float_moves WHERE kind = 'sweep'",
  );
  assert.equal(sweep!.reason, 'limit_changed');
});

// ---------------------------------------------------------------------------------------------
// Recovery takes the least recently checked call first

test('recovery: calls that keep waiting on Base never block another one', async (t) => {
  const f = await setup(t);
  await f.list();
  await f.limit();
  const target = (await f.pay()).json() as FeedPayCall;
  const stale = f.clock() - 10 * 60_000;
  const [row] = await f.sql<{ c: Record<string, unknown> }>(
    'SELECT to_jsonb(c) AS c FROM feed_pay_calls c WHERE call_id = $1',
    [target.callId],
  );
  // 25 calls that wait on Base for a long time (their window is far ahead), all older.
  for (let i = 0; i < 25; i++) {
    const clone = {
      ...row!.c,
      call_id: `fc_${'abcdefghijklmnopqrstuvwxy'[i]!.repeat(20)}`,
      idempotency_key: randomUUID().replace(/-/g, '').padEnd(64, '0'),
      payment_id: randomUUID(),
      // Each clone is its own paid call (one quote pays for one call).
      quote_id: null,
      state: 'reconciling',
      payment_state: 'sent',
      nonce: `0x${randomUUID().replace(/-/g, '').padEnd(64, '1')}`,
      valid_before: Math.floor(f.clock() / 1000) + 100_000,
      lease_until: 0,
      checked_at: 0,
      updated_at: stale - 1_000 - i,
    };
    await f.sql(
      'INSERT INTO feed_pay_calls SELECT * FROM jsonb_populate_record(NULL::feed_pay_calls, $1::jsonb)',
      [JSON.stringify(clone)],
    );
  }
  // The call that needs the cron: its worker died while calling.
  await f.sql(
    `UPDATE feed_pay_calls SET state = 'calling', payment_state = 'sent', lease_until = 0,
       updated_at = $2 WHERE call_id = $1`,
    [target.callId, stale],
  );
  for (let run = 0; run < 3; run++) {
    f.advance(60_000);
    await f.cron();
  }
  const [after] = await f.sql<{ state: string }>(
    'SELECT state FROM feed_pay_calls WHERE call_id = $1',
    [target.callId],
  );
  assert.notEqual(after!.state, 'calling', 'the cron reached the call behind the 25 waiting ones');
});

// ---------------------------------------------------------------------------------------------
// Requests that are refused before anything is read

test('inputs nested past any real use are refused as invalid, not a server error', async (t) => {
  const f = await setup(t);
  await f.list();
  await f.limit();
  const deep = `{"body":${'{"a":'.repeat(5_000)}1${'}'.repeat(5_000)}}`;
  const quote = await f.app.inject({
    method: 'POST',
    url: FEED_PAY_PATHS.quote.replace(':id', SVC),
    headers: { ...json, cookie: f.owner.cookie },
    payload: `{"inputs":${deep}}`,
  });
  assert.equal(quote.statusCode, 400, quote.body);
  assert.equal(quote.json().code, 'invalid_request');
  const tool = await f.app.inject({
    method: 'POST',
    url: '/api/assistant/tools/city_service_call',
    headers: { ...json, authorization: `Bearer ${f.main.token}` },
    payload: `{"service_id":"${SVC}","agent_id":"${f.agentId}","inputs":${deep},"max_price_usdc":"0.05","idempotency_key":"${randomUUID()}"}`,
  });
  assert.ok(tool.statusCode >= 400 && tool.statusCode < 500, `${tool.statusCode} ${tool.body}`);
  assert.equal(f.service.requests.length, 0, 'nothing was requested');
  assert.equal(jsonTooDeep({ a: [{ b: 1 }] }, 3), false);
  assert.equal(jsonTooDeep({ a: [{ b: {} }] }, 3), true);
});

test('a listed address we never call (a private address) is not payable, not unreachable', async (t) => {
  const f = await setup(t);
  await f.list({ quote: 'not_public' });
  const res = await f.quote();
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual([res.json().payable, res.json().reason], [false, 'needs_own_setup']);
});

test('a listing the rules of this build call risky is never paid, even before the next sweep', async (t) => {
  const f = await setup(t);
  await f.list();
  await f.sql(
    "UPDATE feed_services SET description = 'Buy prepaid cards with USDC.' WHERE id = $1",
    [SVC],
  );
  const res = await f.quote();
  assert.equal(res.statusCode, 404, res.body);
  assert.equal(res.json().code, 'service_not_found');
});

// ---------------------------------------------------------------------------------------------
// Consent and scope texts

test('services:pay is its own opt-in scope, with its own consent text', () => {
  assert.match(SCOPE_TEXT['services:pay'], /services listed in the Feed/);
  assert.match(SCOPE_TEXT['services:pay'], /outside Central City/);
  assert.match(SCOPE_TEXT['services:pay'], /0\.10 USDC/);
  assert.doesNotMatch(SCOPE_TEXT.pay, /service/);
  const page = consentPage({
    requestId: 'r',
    csrf: 'c',
    clientName: 'Synthetic client',
    clientId: 'https://client.example/meta.json',
    verified: true,
    redirectUri: 'https://client.example/cb',
    scopes: ['workspace:read', 'pay', 'services:pay'],
    operatorName: 'Synthetic owner',
  });
  // Both payment scopes are opt-in: unchecked until the owner ticks them.
  assert.match(page, /name="scope" value="services:pay">/);
  assert.match(page, /name="scope" value="pay">/);
  assert.ok(!INITIAL_KEY_SCOPES.includes('services:pay'), 'never in an AI workspace initial key');
});

test('the agent-pay consent view says it covers Feed services while pay is on', async (t) => {
  const f = await setup(t);
  await f.limit();
  const read = async () =>
    (
      await f.app.inject({
        url: `/api/base/agents/${f.agentId}/wallet/agent-pay`,
        headers: { ...json, cookie: f.owner.cookie },
      })
    ).json() as { scope: { recipients: string } };
  assert.equal((await read()).scope.recipients, 'central-city-agents-and-feed-services');
  process.env.CITY_FEED_PAY = '0';
  assert.equal((await read()).scope.recipients, 'central-city-agents');
});

test('MCP: price_above_max speaks of max_price_usdc; a started call is answered, not an error', async (t) => {
  const f = await setup(t);
  await f.list();
  const permission = await f.limit();
  assert.equal((await f.consent(permission.hash)).statusCode, 200);
  const args = (extra: Record<string, unknown> = {}) => ({
    service_id: SVC,
    agent_id: f.agentId,
    inputs: BODY,
    max_price_usdc: '0.05',
    idempotency_key: randomUUID(),
    ...extra,
  });
  const cheap = await f.tool(f.main.token, 'city_service_call', args({ max_price_usdc: '0.01' }));
  assert.equal(cheap.statusCode, 409);
  assert.match(cheap.body, /more than max_price_usdc/);

  // Once reserved, reads of the call fail for a moment: the tool still answers the call.
  const db = f.db as unknown as {
    query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
  };
  const query = db.query.bind(db);
  let loads = 0;
  let failing = true;
  db.query = async (sql, params) => {
    if (failing && /WHERE c\.call_id = \$1/.test(sql) && ++loads > 1)
      throw Object.assign(new Error('canceling statement due to statement timeout'), {
        code: '57014',
      });
    return query(sql, params);
  };
  const res = await f.tool(f.main.token, 'city_service_call', args());
  failing = false;
  assert.equal(res.statusCode, 200, res.body);
  assert.match(res.json().call_id, /^fc_/);
});

// ---------------------------------------------------------------------------------------------
// The limits, each on its own (the fixtures elsewhere make several limits refuse together)

const capTo = (f: FeedPayApp, capRaw: bigint) =>
  f.sql('UPDATE base_spend_permissions SET cap_raw = $2 WHERE wallet_id = $1', [
    f.walletId,
    capRaw.toString(10),
  ]);

test('limits: a call the float covers is still refused when agent Pay used the calendar', async (t) => {
  const f = await setup(t);
  await f.list();
  await f.limit();
  assert.equal((await f.pay()).json().state, 'result_saved');
  // Agent Pay spent most of the day's cap; the float (0.98) would cover the next call.
  await f.sql(
    `INSERT INTO base_wallet_reservations (reservation_id, wallet_id, chain_id, token, amount,
       holder_kind, holder_ref, intent_hash, state, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 4970000, 'payment', $5, 'h', 'consumed', $6, $6)`,
    [randomUUID(), f.walletId, CHAIN_ID, USDC, randomUUID(), f.clock()],
  );
  const res = await f.pay();
  assert.equal(res.statusCode, 409, res.body);
  assert.equal(res.json().code, 'over_limit');
  assert.equal(f.service.paid().length, 1);
});

test('limits: a cap below the allowance decides; a cancelled payment frees it again', async (t) => {
  const f = await setup(t);
  await f.list({ paid: 'reject' });
  await f.limit();
  await capTo(f, 30_000n);
  // Refused by the service: cancelled on Base, so it does not count against the cap.
  const rejected = await f.settled((await f.pay()).json().callId);
  assert.equal(rejected.moneyMoved, 'no');
  await f.list({ paid: 'settle' });
  const first = await f.settled((await f.pay()).json().callId);
  assert.equal(first.moneyMoved, 'yes', 'the cancelled payment freed the cap');
  const second = await f.pay();
  assert.equal(second.statusCode, 409, second.body);
  assert.equal(second.json().code, 'over_limit');
  assert.equal(second.json().limitLeftRaw, '10000');
});

test('limits: the top-up never holds more than the calendar cap still allows', async (t) => {
  const f = await setup(t);
  await f.list();
  await f.limit();
  await capTo(f, 300_000n);
  assert.equal((await f.pay()).json().state, 'result_saved');
  const [move] = await f.sql<{ amount: string }>(
    "SELECT amount_raw::text AS amount FROM feed_pay_float_moves WHERE kind = 'top_up'",
  );
  assert.equal(move!.amount, '300000');
});

test('the float top-up: the target in all, a quarter of the allowance left at most', () => {
  const base = { floatFree: 0n, walletFree: 10_000_000n, calendar: null };
  assert.equal(floatTopUp({ ...base, amount: 20_000n, allowanceLeft: 5_000_000n }), 1_000_000n);
  assert.equal(floatTopUp({ ...base, amount: 20_000n, allowanceLeft: 1_000_000n }), 265_000n);
  assert.equal(floatTopUp({ ...base, amount: 20_000n, allowanceLeft: 20_000n }), 20_000n);
  assert.equal(
    floatTopUp({ ...base, amount: 20_000n, allowanceLeft: 10_000n }),
    'over_limit',
    'the allowance is short of the call',
  );
  assert.equal(
    floatTopUp({ ...base, amount: 20_000n, allowanceLeft: 5_000_000n, walletFree: 10_000n }),
    'insufficient_funds',
  );
  // What the float already has counts.
  assert.equal(
    floatTopUp({ ...base, amount: 20_000n, floatFree: 15_000n, allowanceLeft: 5_000_000n }),
    985_000n,
  );
});

// ---------------------------------------------------------------------------------------------
// Authority checked again between the reservation and the signature

/** Holds the call's top-up on Base, lets `change` happen, then lands it and follows the call. */
async function changedWhileToppingUp(
  f: FeedPayApp,
  change: () => Promise<unknown>,
  pay: () => Promise<{ statusCode: number; body: string; json: () => unknown }> = () => f.pay(),
) {
  f.base.state.autoLand = false;
  const res = await pay();
  assert.equal(res.statusCode, 200, res.body);
  const callId =
    (res.json() as { callId?: string; call_id?: string }).callId ??
    (res.json() as { call_id: string }).call_id;
  await change();
  f.base.land([...f.base.state.sends].at(-1)!);
  f.base.state.autoLand = true;
  let call = await follow(f, callId, 200);
  if (!call.done) {
    f.advance(5 * 60_000);
    await f.cron();
    call = await follow(f, callId, 50);
  }
  return call;
}

test('authority: a paused agent or a replaced limit stops the call before it is signed', async (t) => {
  for (const change of ['paused', 'replaced'] as const) {
    await t.test(change, async (st) => {
      const f = await setup(st);
      await f.list();
      await f.limit();
      const call = await changedWhileToppingUp(f, () =>
        change === 'paused' ? pauseWorkspace(f, true) : replaceLimit(f),
      );
      assert.equal(call.state, 'refused', JSON.stringify(call));
      assert.equal(call.payment, null, 'nothing was signed');
      assert.equal(f.service.paid().length, 0);
    });
  }
});

test('authority: a revoked grant or a withdrawn consent stops an MCP call before it is signed', async (t) => {
  for (const change of ['grant', 'consent'] as const) {
    await t.test(change, async (st) => {
      const f = await setup(st);
      await f.list();
      const permission = await f.limit();
      assert.equal((await f.consent(permission.hash)).statusCode, 200);
      const ai = await f.grant(['workspace:read', 'services:pay']);
      const call = await changedWhileToppingUp(
        f,
        () =>
          change === 'grant'
            ? f.app.inject({
                method: 'DELETE',
                url: `/api/assistant-access/${ai.grant.id}`,
                headers: { ...json, cookie: f.owner.cookie },
              })
            : f.app.inject({
                method: 'DELETE',
                url: `/api/base/agents/${f.agentId}/wallet/agent-pay`,
                headers: { ...json, cookie: f.owner.cookie },
              }),
        () =>
          f.tool(ai.token, 'city_service_call', {
            service_id: SVC,
            agent_id: f.agentId,
            inputs: BODY,
            max_price_usdc: '0.05',
            idempotency_key: randomUUID(),
          }),
      );
      assert.equal(call.state, 'refused', JSON.stringify(call));
      assert.equal(call.payment, null, 'nothing was signed');
      assert.equal(f.service.paid().length, 0);
    });
  }
});

test('two calls on a float that covers one: one more top-up, both paid once', async (t) => {
  const f = await setup(t);
  await f.list();
  await f.limit();
  assert.equal((await f.pay()).json().state, 'result_saved');
  // Leave 0.03 ready: enough for one 0.02 call, not two.
  const float = f.base.balanceOf(f.base.spender);
  f.base.credit(f.base.spender, -(float - 30_000n));
  f.base.credit(f.wallet, float - 30_000n);
  const [a, b] = await Promise.all([
    confirmed(f).then((body) => f.callService(body)),
    confirmed(f).then((body) => f.callService(body)),
  ]);
  const calls = [await f.settled(a.json().callId), await f.settled(b.json().callId)];
  assert.deepEqual(
    calls.map((call) => [call.state, call.moneyMoved]),
    [
      ['result_saved', 'yes'],
      ['result_saved', 'yes'],
    ],
  );
  assert.equal(f.service.paid().length, 3, 'each call sent once');
  const topUps = await f.sql("SELECT 1 FROM feed_pay_float_moves WHERE kind = 'top_up'");
  assert.equal(topUps.length, 2, 'the first call, then one for the call the float did not cover');
});

// ---------------------------------------------------------------------------------------------
// Protocol and contract rules

test('the window: validBefore is min(120 s, maxTimeoutSeconds)', async (t) => {
  const f = await setup(t);
  await f.list({ maxTimeoutSeconds: 30 });
  await f.limit();
  assert.equal((await f.pay()).json().state, 'result_saved');
  const auth = (f.service.paid()[0]!.payment!.payload as { authorization: Record<string, string> })
    .authorization;
  assert.equal(Number(auth.validBefore) - Number(auth.validAfter), 30 + 60);
});

test('quotes bind the person and the service', async (t) => {
  const f = await setup(t);
  await f.list();
  await f.list({ id: 'svc_bbbbbbbbbbbbbbbbbbbb', url: 'https://other.example/api/x' });
  await f.limit();
  const body = await confirmed(f);
  // Another service with this quote.
  const other = await f.callService(body, 'svc_bbbbbbbbbbbbbbbbbbbb');
  assert.equal(other.json().code, 'quote_mismatch', other.body);
  // Another person with this quote.
  const someone = await f.register('Synthetic Other', 'synthetic-password-0123');
  const theirs = await f.app.inject({
    method: 'POST',
    url: FEED_PAY_PATHS.call.replace(':id', SVC),
    headers: { ...json, cookie: someone.cookie },
    payload: JSON.stringify(body),
  });
  assert.equal(theirs.json().code, 'quote_mismatch', theirs.body);
  assert.equal(f.service.paid().length, 0);
});

test('one key, two different requests at once: one call, the other refused', async (t) => {
  const f = await setup(t);
  await f.list();
  await f.limit();
  const one = await confirmed(f);
  const two = { ...(await confirmed(f)), idempotencyKey: one.idempotencyKey };
  const answers = await Promise.all([f.callService(one), f.callService(two)]);
  const codes = answers.map((res) => (res.statusCode === 200 ? 'ok' : res.json().code)).sort();
  assert.deepEqual(codes, ['idempotency_conflict', 'ok']);
  assert.equal((await f.sql('SELECT 1 FROM feed_pay_calls')).length, 1);
});

test('a paid request that never left ends cancelled on Base: nothing paid', async (t) => {
  const f = await setup(t);
  await f.list({ paid: 'unreachable' });
  await f.limit();
  const call = await f.settled((await f.pay()).json().callId);
  assert.equal(call.state, 'cancelled', JSON.stringify(call));
  assert.equal(call.failure?.code, 'service_unreachable');
  assert.equal(call.moneyMoved, 'no');
});

test('a price equal to the per-call maximum is paid', async (t) => {
  const f = await setup(t);
  await f.list();
  await f.limit();
  const put = await f.app.inject({
    method: 'PUT',
    url: FEED_PAY_PATHS.agent.replace(':agentId', f.agentId),
    headers: { ...json, cookie: f.owner.cookie },
    payload: JSON.stringify({ perCallMaxRaw: '20000' }),
  });
  assert.equal(put.statusCode, 200, put.body);
  assert.equal((await f.pay()).json().state, 'result_saved');
  assert.equal(f.base.balanceOf(PAY_TO), 20_000n);
});
