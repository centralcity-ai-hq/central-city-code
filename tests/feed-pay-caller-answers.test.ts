import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { calendarSpent } from '../server/base/chain/calendar-limit.js';
import type { Database } from '../server/database.js';
import { amountOf, loadCall, type CallRow } from '../server/feed/pay/store.js';
import {
  FeedPayToolError,
  feedPayRefusalFields,
  serviceCallOutputOf,
  serviceCallToolOutput,
} from '../server/feed/pay/tool.js';
import {
  FEED_PAY_FEE_STATES,
  FEED_PAY_NOTICE,
  FEED_PAY_PATHS,
  type FeedPayCall,
} from '../shared/feed-pay.js';
import { calendarPeriod } from '../shared/base/spend-limits.js';
import { PROTOCOL_BASE_MAINNET } from '../shared/protocol.js';
import { fullFlow, mcpCall, rpcResult } from './oauth-helpers.js';
import { BODY, json, SVC, setup, USDC, type FeedPayApp } from './helpers/feed-pay-app.js';

/*
 * city_service_call's answers to its caller and the cheap database fixes around them: refusals
 * over the REST tool route carry what remote MCP carries, the answer names the protocol fee, the
 * polling re-reads of a call skip the result's text, and a credential's last use is written at most
 * once a minute while its revoke and expiry check still runs on every call. createApp on PGlite
 * with the fake x402 service and the fake Base of tests/helpers/feed-pay-app.ts: nothing reaches a
 * network, no real payment is made. Synthetic data.
 */

const args = (agentId: string, extra: Record<string, unknown> = {}) => ({
  service_id: SVC,
  agent_id: agentId,
  inputs: BODY,
  max_price_usdc: '0.05',
  idempotency_key: randomUUID(),
  ...extra,
});

/** Records every read of one call's full row (CALL_SELECT or its form without the text). */
function recordCallReads(db: Database) {
  const reads: Array<{ withoutText: boolean; row: CallRow }> = [];
  const query = db.query.bind(db);
  db.query = (async (text: string, params?: unknown[]) => {
    const result = await query(text, params as never);
    if (text.includes('FROM feed_pay_calls c JOIN base_wallets w'))
      for (const row of result.rows as unknown as CallRow[])
        reads.push({ withoutText: text.includes('NULL::text AS result_text'), row });
    return result;
  }) as Database['query'];
  return reads;
}

async function consented(f: FeedPayApp) {
  const permission = await f.limit();
  assert.equal((await f.consent(permission.hash)).statusCode, 200);
}

test('REST tool route: a refusal carries the code, retryable and details that MCP carries', async (t) => {
  const f = await setup(t);
  await f.list();
  const permission = await f.limit();
  // No consent: the code, not retryable, no details (none apply).
  const refused = await f.tool(f.main.token, 'city_service_call', args(f.agentId));
  assert.equal(refused.statusCode, 403, refused.body);
  assert.deepEqual(Object.keys(refused.json()).sort(), ['code', 'error', 'retryable']);
  assert.equal(refused.json().code, 'no_consent');
  assert.equal(refused.json().retryable, false);
  assert.equal((await f.consent(permission.hash)).statusCode, 200);

  // Over the agent's per-call maximum: the amounts as USDC text, as over MCP.
  await f.app.inject({
    method: 'PUT',
    url: FEED_PAY_PATHS.agent.replace(':agentId', f.agentId),
    headers: { ...json, cookie: f.owner.cookie },
    payload: JSON.stringify({ perCallMaxRaw: '10000' }),
  });
  const rest = await f.tool(f.main.token, 'city_service_call', args(f.agentId));
  assert.equal(rest.statusCode, 409, rest.body);
  const body = rest.json();
  assert.equal(body.code, 'over_per_call_max');
  assert.equal(body.retryable, false);
  assert.deepEqual(body.details, { needed_usdc: '0.02', per_call_max_usdc: '0.01' });
  assert.equal(body.retry_after_ms, undefined);

  const oauth = await fullFlow(f.app, {
    scope: 'workspace:read pay services:pay',
    scopes: ['pay', 'services:pay'],
  });
  const over = rpcResult(
    (
      await mcpCall(f.app, oauth.tokens.access_token, 'tools/call', {
        name: 'city_service_call',
        arguments: args(f.agentId),
      })
    ).body,
  ).result;
  assert.equal(over.isError, true);
  const mcp = JSON.parse(over.content[0].text).error;
  assert.deepEqual(
    { code: body.code, error: body.error, retryable: body.retryable, details: body.details },
    { code: mcp.code, error: mcp.message, retryable: mcp.retryable, details: mcp.details },
  );
  assert.equal(f.service.paid().length, 0, 'nothing was paid');
});

test('refusal fields: retryable codes with their wait, details only when there are some', () => {
  assert.deepEqual(
    feedPayRefusalFields(new FeedPayToolError('busy', 'Busy.', undefined, 4_500.2)),
    { retryable: true, retry_after_ms: 4_501 },
  );
  assert.deepEqual(
    feedPayRefusalFields(new FeedPayToolError('service_unreachable', 'Unreachable.', undefined)),
    { retryable: true },
  );
  assert.deepEqual(
    feedPayRefusalFields(
      new FeedPayToolError('not_payable', 'Not payable.', { reason: 'upto_only' }),
    ),
    { retryable: false, details: { reason: 'upto_only' } },
  );
});

/** A call's view as the engine answers it (synthetic). */
function view(protocolFee: FeedPayCall['protocolFee']): FeedPayCall {
  return {
    callId: 'fc_aaaaaaaaaaaaaaaaaaaa',
    origin: 'mcp',
    state: 'reserved',
    moneyMoved: 'no',
    done: false,
    service: { id: SVC, title: 'Synthetic service', host: 'www.ax1.example', method: 'POST' },
    agent: { id: 'agent-1', name: 'Synthetic agent' },
    maxAmount: amountOf('50000'),
    payment: null,
    protocolFee,
    result: null,
    resultExpired: false,
    resultExpiresAt: null,
    failure: null,
    createdAt: 1,
    updatedAt: 1,
  };
}

test('tool output: protocol_fee is {amount, state} after payment, null without a fee', () => {
  const origin = 'https://centralcity.ai';
  const withFee = serviceCallOutputOf(
    view({ amountRaw: '2500', amount: amountOf('2500'), state: 'sent', txHash: null }),
    origin,
  );
  assert.deepEqual(withFee.protocol_fee, { amount: '0.0025', state: 'sent' });
  assert.deepEqual(Object.keys(withFee), [
    'notice',
    'call_id',
    'state',
    'done',
    'money_moved',
    'service',
    'agent',
    'payment',
    'protocol_fee',
    'result',
    'failure',
    'detail_url',
  ]);
  // The declared output schema (strict) holds the field, with every fee state.
  for (const state of FEED_PAY_FEE_STATES)
    serviceCallToolOutput.parse(
      serviceCallOutputOf(
        view({ amountRaw: '2000', amount: amountOf('2000'), state, txHash: null }),
        origin,
      ),
    );
  const without = serviceCallOutputOf(view(null), origin);
  assert.equal(without.protocol_fee, null);
  serviceCallToolOutput.parse(without);
  assert.throws(() => serviceCallToolOutput.parse({ ...without, protocol_fee: { amount: '1' } }));
});

test('city_service_call names the protocol fee: amount as USDC text and the fee leg state', async (t) => {
  const f = await setup(t, { env: { CITY_PROTOCOL_FEES: undefined } });
  f.base.state.feeRouter = {
    router: PROTOCOL_BASE_MAINNET.feeRouter,
    treasury: PROTOCOL_BASE_MAINNET.treasury,
  };
  await f.list();
  await consented(f);
  const input = args(f.agentId);
  const res = await f.tool(f.main.token, 'city_service_call', input);
  assert.equal(res.statusCode, 200, res.body);
  const out = res.json();
  assert.equal(out.notice, FEED_PAY_NOTICE);
  assert.equal(out.payment.amount.usdc, '0.02');
  assert.equal(out.protocol_fee.amount, '0.002');
  assert.ok((FEED_PAY_FEE_STATES as readonly string[]).includes(out.protocol_fee.state));
  // The cron finishes the fee leg; a re-read with the same key answers its state.
  for (let i = 0; i < 6; i++) {
    const [row] = await f.sql<{ fee_state: string }>(
      'SELECT fee_state FROM feed_pay_calls WHERE call_id = $1',
      [out.call_id],
    );
    if (row?.fee_state === 'charged') break;
    f.advance(60_000);
    assert.equal((await f.cron()).statusCode, 200);
  }
  f.advance(60_000);
  const again = await f.tool(f.main.token, 'city_service_call', input);
  assert.equal(again.statusCode, 200, again.body);
  assert.equal(again.json().call_id, out.call_id);
  assert.deepEqual(again.json().protocol_fee, { amount: '0.002', state: 'charged' });
  assert.equal(f.service.paid().length, 1);
  // The Berlin day's counter (one statement now, no schema probe) counts the price and the fee.
  assert.equal(
    await calendarSpent(f.db, {
      walletId: f.walletId,
      token: USDC,
      window: calendarPeriod('day', f.clock()),
    }),
    22_000n,
  );

  // Fees off ('0', the fixture's default): no fee is owed, protocol_fee is null.
  const off = await setup(t);
  await off.list();
  await consented(off);
  const plain = await off.tool(off.main.token, 'city_service_call', args(off.agentId));
  assert.equal(plain.statusCode, 200, plain.body);
  assert.equal(plain.json().protocol_fee, null);
});

test('polling re-reads skip result_text; the answer still carries the result', async (t) => {
  const f = await setup(t);
  await f.list({ result: { text: 'Synthetic answer text.' } });
  await consented(f);
  const reads = recordCallReads(f.db);
  const res = await f.tool(f.main.token, 'city_service_call', args(f.agentId));
  assert.equal(res.statusCode, 200, res.body);
  const out = res.json();
  assert.equal(out.done, true, res.body);
  assert.match(out.result.text, /Synthetic answer text/);
  const mine = reads.filter((read) => read.row.call_id === out.call_id);
  // The worker's loop and waitFor re-read the call after its result was stored, without its text.
  const polls = mine.filter((read) => read.withoutText);
  assert.ok(polls.some((read) => read.row.result_received_at !== null));
  assert.ok(polls.every((read) => read.row.result_text === null));
  // The text was read once: for the answer.
  assert.equal(mine.filter((read) => read.row.result_text !== null).length, 1);

  // Both forms of the read, side by side: the same row but for the text.
  const full = await loadCall(f.db, out.call_id);
  const light = await loadCall(f.db, out.call_id, { text: false });
  assert.match(full!.result_text!, /Synthetic answer text/);
  assert.equal(light!.result_text, null);
  assert.deepEqual({ ...full, result_text: null }, { ...light });

  // The Feed page's call answer (the same waitFor) carries the result too.
  const paid = await f.pay();
  assert.equal(paid.statusCode, 200, paid.body);
  const call = paid.json() as FeedPayCall;
  if (call.done) assert.match(call.result!.text!, /Synthetic answer text/);
  else assert.match((await f.settled(call.callId)).result!.text!, /Synthetic answer text/);
});

/** A grant's or key's stored last use (ms), as the owner's list reads it. */
async function lastUsed(f: FeedPayApp, table: 'assistant_grants' | 'workspace_keys', id: string) {
  const [row] = await f.sql<{ last_used_at: string | number | null }>(
    `SELECT last_used_at FROM ${table} WHERE id = $1`,
    [id],
  );
  return row?.last_used_at === null || row === undefined ? null : Number(row.last_used_at);
}

test('a grant: last use written at most once a minute; a revoke is refused within the same minute', async (t) => {
  const f = await setup(t);
  const reader = await f.grant(['workspace:read']);
  const use = () => f.tool(reader.token, 'city_workspace', {});
  assert.equal((await use()).statusCode, 200);
  const first = await lastUsed(f, 'assistant_grants', reader.grant.id);
  assert.equal(first, f.clock());
  // Within the minute: answered, not written again.
  f.advance(30_000);
  assert.equal((await use()).statusCode, 200);
  assert.equal(await lastUsed(f, 'assistant_grants', reader.grant.id), first);
  f.advance(29_999);
  assert.equal((await use()).statusCode, 200);
  assert.equal(await lastUsed(f, 'assistant_grants', reader.grant.id), first);
  // A minute after the last write: written again.
  f.advance(1);
  assert.equal((await use()).statusCode, 200);
  const second = await lastUsed(f, 'assistant_grants', reader.grant.id);
  assert.equal(second, f.clock());
  // Revoked a second later, inside the minute in which nothing more is written: refused at once.
  f.advance(1_000);
  assert.equal((await use()).statusCode, 200);
  const revoked = await f.app.inject({
    method: 'DELETE',
    url: `/api/assistant-access/${reader.grant.id}`,
    headers: { ...json, cookie: f.owner.cookie },
  });
  assert.equal(revoked.statusCode, 200, revoked.body);
  assert.equal((await use()).statusCode, 401);
  assert.equal(await lastUsed(f, 'assistant_grants', reader.grant.id), second);
  // The owner's list shows the throttled time.
  const listed = (
    await f.app.inject({ url: '/api/assistant-access', headers: { cookie: f.owner.cookie } })
  )
    .json()
    .grants.find((grant: { id: string }) => grant.id === reader.grant.id);
  assert.equal(listed.lastUsedAt, new Date(second!).toISOString());
});

test('city_service_call: a grant revoked within the minute of its last use pays nothing', async (t) => {
  const f = await setup(t);
  await f.list();
  await consented(f);
  const payer = await f.grant(['workspace:read', 'services:pay']);
  assert.equal((await f.tool(payer.token, 'city_workspace', {})).statusCode, 200);
  const written = await lastUsed(f, 'assistant_grants', payer.grant.id);
  assert.notEqual(written, null);
  const revoked = await f.app.inject({
    method: 'DELETE',
    url: `/api/assistant-access/${payer.grant.id}`,
    headers: { ...json, cookie: f.owner.cookie },
  });
  assert.equal(revoked.statusCode, 200, revoked.body);
  const res = await f.tool(payer.token, 'city_service_call', args(f.agentId));
  assert.equal(res.statusCode, 401, res.body);
  assert.equal(f.service.paid().length, 0);
  assert.equal((await f.sql('SELECT call_id FROM feed_pay_calls')).length, 0);
});

test('a workspace key: last use written at most once a minute; a revoke is refused at once', async (t) => {
  const f = await setup(t);
  const created = await f.app.inject({
    method: 'POST',
    url: '/api/public/workspaces',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ name: 'Synthetic lab', idempotency_key: randomUUID() }),
  });
  assert.equal(created.statusCode, 201, created.body);
  const primary = created.json().workspace_key as string;
  const minted = await f.tool(primary, 'city_create_workspace_key', { label: 'helper' });
  assert.equal(minted.statusCode, 200, minted.body);
  const helper = minted.json() as { key: { id: string }; workspace_key: string };
  const use = () => f.tool(helper.workspace_key, 'city_workspace', {});
  assert.equal((await use()).statusCode, 200);
  const first = await lastUsed(f, 'workspace_keys', helper.key.id);
  assert.equal(first, f.clock());
  f.advance(59_999);
  assert.equal((await use()).statusCode, 200);
  assert.equal(await lastUsed(f, 'workspace_keys', helper.key.id), first);
  f.advance(1);
  assert.equal((await use()).statusCode, 200);
  assert.equal(await lastUsed(f, 'workspace_keys', helper.key.id), f.clock());
  const revoke = await f.tool(primary, 'city_revoke_workspace_key', { key_id: helper.key.id });
  assert.equal(revoke.statusCode, 200, revoke.body);
  assert.equal((await use()).statusCode, 401);
});
