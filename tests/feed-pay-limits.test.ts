import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { FEED_PAY_IN_FLIGHT_RETRY_MS, FEED_PAY_IN_FLIGHT_SQL } from '../server/feed/pay/engine.js';
import { DEFAULT_LIMITS, loadLimits } from '../server/limits.js';
import { FEED_PAY_LIMITS } from '../shared/feed-pay.js';
import { BODY, setup, SVC, type FeedPayApp } from './helpers/feed-pay-app.js';
import { fullFlow, mcpCall, rpcResult } from './oauth-helpers.js';

/*
 * city_service_call's budgets and the in-flight cap (CityLimits feedPay*, docs/FEED_PAY.md
 * section 11): the same for every workspace, overridable through the environment. The app runs on
 * PGlite against a fake x402 service and a fake Base (tests/helpers/feed-pay-app.ts). Nothing
 * reaches a network; no real payment is ever made. Synthetic data.
 */

const callArgs = (agentId: string, extra: Record<string, unknown> = {}) => ({
  service_id: SVC,
  agent_id: agentId,
  inputs: BODY,
  max_price_usdc: '0.05',
  idempotency_key: randomUUID(),
  ...extra,
});

/** The fixture's owner with a live limit and consent for its agent, and a listed service. */
async function ready(f: FeedPayApp) {
  await f.list();
  const permission = await f.limit();
  assert.equal((await f.consent(permission.hash)).statusCode, 200);
}

/** The alphabet of call ids (fc_ and 20 of these). */
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

/** Copies of a finished call that stand for calls still running (state calling, payment sent). */
async function running(f: FeedPayApp, from: string, count: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const callId = `fc_${Array.from(randomBytes(20), (byte) => BASE32[byte % 32]).join('')}`;
    const changes = {
      call_id: callId,
      idempotency_key: randomBytes(32).toString('hex'),
      payment_id: randomUUID(),
      state: 'calling',
      payment_state: 'sent',
    };
    await f.sql(
      `INSERT INTO feed_pay_calls
       SELECT (jsonb_populate_record(c, $2::jsonb)).* FROM feed_pay_calls c WHERE c.call_id = $1`,
      [from, JSON.stringify(changes)],
    );
    ids.push(callId);
  }
  return ids;
}

const callCount = async (f: FeedPayApp) =>
  Number((await f.sql<{ n: number }>('SELECT count(*)::int AS n FROM feed_pay_calls'))[0]!.n);

test("Feed pay budgets are CityLimits: today's values by default, the same for every workspace", async () => {
  const limits = loadLimits({});
  assert.deepEqual(
    {
      calls: [limits.feedPayCallsPerGrantPerMinute, limits.feedPayCallsPerWorkspacePerMinute],
      reads: [limits.feedPayReadsPerGrantPerMinute, limits.feedPayReadsPerWorkspacePerMinute],
      inFlight: limits.feedPayCallsInFlightPerWorkspace,
    },
    // 20 new calls a minute per grant or key and per workspace, as before this move.
    { calls: [20, 20], reads: [120, 120], inFlight: 10 },
  );
  assert.equal(DEFAULT_LIMITS.feedPayCallsPerGrantPerMinute, 20);
  // One place for them: the shared Feed pay constants no longer carry an MCP call budget.
  assert.equal('mcpCallsPerMinute' in FEED_PAY_LIMITS, false);
  const raised = loadLimits({
    CITY_LIMIT_FEED_PAY_CALLS_PER_GRANT_PER_MINUTE: '30',
    CITY_LIMIT_FEED_PAY_CALLS_PER_WORKSPACE_PER_MINUTE: '60',
    CITY_LIMIT_FEED_PAY_READS_PER_GRANT_PER_MINUTE: '240',
    CITY_LIMIT_FEED_PAY_READS_PER_WORKSPACE_PER_MINUTE: '480',
    CITY_LIMIT_FEED_PAY_CALLS_IN_FLIGHT_PER_WORKSPACE: '25',
  });
  assert.deepEqual(
    [
      raised.feedPayCallsPerGrantPerMinute,
      raised.feedPayCallsPerWorkspacePerMinute,
      raised.feedPayReadsPerGrantPerMinute,
      raised.feedPayReadsPerWorkspacePerMinute,
      raised.feedPayCallsInFlightPerWorkspace,
    ],
    [30, 60, 240, 480, 25],
  );
  for (const bad of ['0', '-1', '2.5', 'many'])
    assert.throws(
      () => loadLimits({ CITY_LIMIT_FEED_PAY_CALLS_IN_FLIGHT_PER_WORKSPACE: bad }),
      /CITY_LIMIT_FEED_PAY_CALLS_IN_FLIGHT_PER_WORKSPACE must be a positive integer/,
    );
  // The tool reads them from CityLimits only: no list of workspaces or accounts beside them.
  const source = await readFile('server/assistant-access.ts', 'utf8');
  const tool = source.slice(source.indexOf('async function feedPayTool('));
  const body = tool.slice(0, tool.indexOf('\n  }\n'));
  assert.match(body, /caps\.feedPayCallsPerGrantPerMinute/);
  assert.doesNotMatch(body, /allowlist|stressTest|STRESS|operatorId\s*===/);
});

test('city_service_call: 20 new calls a minute per grant and per workspace by default', async (t) => {
  const f = await setup(t);
  await ready(f);
  const key = randomUUID();
  const paid = await f.tool(
    f.main.token,
    'city_service_call',
    callArgs(f.agentId, { idempotency_key: key }),
  );
  assert.equal(paid.statusCode, 200, paid.body);
  assert.equal(paid.json().done, true, paid.body);
  // 19 more new calls: an unknown agent is refused after the budget is charged, nothing is paid.
  for (let i = 1; i < 20; i++) {
    const res = await f.tool(f.main.token, 'city_service_call', callArgs('agent-unknown'));
    assert.equal(res.json().code, 'agent_not_found', `call ${i + 1}: ${res.body}`);
  }
  const over = await f.tool(f.main.token, 'city_service_call', callArgs(f.agentId));
  assert.equal(over.statusCode, 429, over.body);
  // A second grant of the same workspace shares the workspace's 20.
  const other = await f.grant(['workspace:read', 'services:pay']);
  const shared = await f.tool(other.token, 'city_service_call', callArgs(f.agentId));
  assert.equal(shared.statusCode, 429, shared.body);
  // A re-read of the paid call still answers: it never needed a call token.
  const again = await f.tool(
    f.main.token,
    'city_service_call',
    callArgs(f.agentId, { idempotency_key: key }),
  );
  assert.equal(again.statusCode, 200, again.body);
  assert.equal(again.json().call_id, paid.json().call_id);
  assert.equal(f.service.paid().length, 1);
  // A minute later the budget is back.
  f.advance(60_000);
  const next = await f.tool(f.main.token, 'city_service_call', callArgs(f.agentId));
  assert.equal(next.statusCode, 200, next.body);
  assert.equal(f.service.paid().length, 2);
});

test('a same-key re-read spends a read token and never a call token (environment overrides)', async (t) => {
  const f = await setup(t, {
    env: {
      CITY_LIMIT_FEED_PAY_CALLS_PER_GRANT_PER_MINUTE: '1',
      CITY_LIMIT_FEED_PAY_READS_PER_GRANT_PER_MINUTE: '3',
    },
  });
  await ready(f);
  const key = randomUUID();
  const call = (args: Record<string, unknown>) =>
    f.tool(f.main.token, 'city_service_call', callArgs(f.agentId, args));
  const first = await call({ idempotency_key: key });
  assert.equal(first.statusCode, 200, first.body);
  // The one call token is spent: a new key is refused before the service is asked.
  const asked = f.service.requests.length;
  const fresh = await call({});
  assert.equal(fresh.statusCode, 429, fresh.body);
  assert.equal(f.service.requests.length, asked);
  // Re-reads of the paid call answer it, the call budget spent or not.
  for (let i = 0; i < 2; i++) {
    const again = await call({ idempotency_key: key });
    assert.equal(again.statusCode, 200, again.body);
    assert.equal(again.json().call_id, first.json().call_id);
  }
  // The same key with other arguments is a read of that call too: refused as a conflict.
  const conflict = await call({ idempotency_key: key, max_price_usdc: '0.04' });
  assert.equal(conflict.statusCode, 409, conflict.body);
  assert.equal(conflict.json().code, 'idempotency_conflict');
  // Three reads: the read budget is spent now as well.
  const fourth = await call({ idempotency_key: key });
  assert.equal(fourth.statusCode, 429, fourth.body);
  assert.equal(f.service.paid().length, 1);
  assert.equal(await callCount(f), 1);
});

test('the in-flight cap: one bound for every workspace, read from the calls, freed as they finish', async (t) => {
  const f = await setup(t, { env: { CITY_LIMIT_FEED_PAY_CALLS_IN_FLIGHT_PER_WORKSPACE: '2' } });
  await ready(f);
  const other = await f.addPayer('Second owner', 'Synthetic second owner password');
  const otherLimit = await other.limit();
  assert.equal((await other.consent(otherLimit.hash)).statusCode, 200);
  const callA = (args: Record<string, unknown> = {}) =>
    f.tool(f.main.token, 'city_service_call', callArgs(f.agentId, args));
  const callB = () => f.tool(other.main.token, 'city_service_call', callArgs(other.agentId));

  // Each workspace pays one call (done); copies of it stand for its calls still running.
  const keyA = randomUUID();
  const doneA = await callA({ idempotency_key: keyA });
  assert.equal(doneA.json().done, true, doneA.body);
  const doneB = await callB();
  assert.equal(doneB.json().done, true, doneB.body);
  const runningA = await running(f, doneA.json().call_id, 2);

  // Workspace A at its cap: refused as a rate limit, before the service is asked; nothing stored.
  const asked = f.service.requests.length;
  const stored = await callCount(f);
  const refused = await callA();
  assert.equal(refused.statusCode, 429, refused.body);
  assert.equal(refused.headers['retry-after'], String(FEED_PAY_IN_FLIGHT_RETRY_MS / 1000));
  assert.match(refused.json().error, /still running/);
  assert.equal(f.service.requests.length, asked);
  assert.equal(await callCount(f), stored);
  // Over remote MCP: rate_limited, retryable, with retry_after_ms.
  const oauth = await fullFlow(f.app, {
    scope: 'workspace:read services:pay',
    scopes: ['services:pay'],
  });
  const mcp = rpcResult(
    (
      await mcpCall(f.app, oauth.tokens.access_token, 'tools/call', {
        name: 'city_service_call',
        arguments: callArgs(f.agentId),
      })
    ).body,
  ).result;
  assert.equal(mcp.isError, true);
  const error = JSON.parse(mcp.content[0].text).error;
  assert.deepEqual(
    { code: error.code, retryable: error.retryable, wait: error.retry_after_ms },
    { code: 'rate_limited', retryable: true, wait: FEED_PAY_IN_FLIGHT_RETRY_MS },
  );
  // A re-read is never held by the cap.
  const reread = await callA({ idempotency_key: keyA });
  assert.equal(reread.statusCode, 200, reread.body);
  // A Feed call of the same workspace counts the same calls and is held the same way.
  const fromFeed = await f.pay();
  assert.equal(fromFeed.statusCode, 429, fromFeed.body);

  // Workspace B is not held by A's calls: it pays.
  const paidB = await callB();
  assert.equal(paidB.statusCode, 200, paidB.body);
  // B at the same bound is held the same way.
  await running(f, doneB.json().call_id, 2);
  const refusedB = await callB();
  assert.equal(refusedB.statusCode, 429, refusedB.body);

  // One of A's calls finishes (paid and done): A may start a new one again.
  await f.sql(
    `UPDATE feed_pay_calls SET state = 'result_saved', payment_state = 'settled'
     WHERE call_id = $1`,
    [runningA[0]],
  );
  const freed = await callA();
  assert.equal(freed.statusCode, 200, freed.body);
  assert.equal(freed.json().done, true, freed.body);
  // A call that ended without moving money frees its place too.
  await f.sql(
    `UPDATE feed_pay_calls SET state = 'cancelled', payment_state = 'cancelled'
     WHERE call_id = $1`,
    [runningA[1]],
  );
  const freedAgain = await callA();
  assert.equal(freedAgain.statusCode, 200, freedAgain.body);
});

test('the in-flight count reads only the partial index of calls not done yet', async (t) => {
  const f = await setup(t);
  await f.sql('SET enable_seqscan = off');
  try {
    const plan = (
      await f.sql<{ 'QUERY PLAN': string }>(`EXPLAIN ${FEED_PAY_IN_FLIGHT_SQL}`, [
        'operator-synthetic',
        10,
      ])
    )
      .map((row) => row['QUERY PLAN'])
      .join('\n');
    assert.match(plan, /feed_pay_calls_live/, plan);
  } finally {
    await f.sql('RESET enable_seqscan');
  }
});
