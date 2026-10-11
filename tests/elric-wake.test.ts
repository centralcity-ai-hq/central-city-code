import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { elricModels } from '../server/elric/endpoints.js';
import { ELRIC_WAKING_TEXT } from '../server/elric/service.js';
import { ELRIC_HEALTH_PATH } from '../server/elric/health.js';
import { ELRIC_CONFIG } from '../server/elric/config.js';
import { CRON_DRAIN_BUDGET_MS } from '../server/wake/service.js';
import { elricFixture } from './elric-fixture.js';
import { chatCompletion, closedPort, modelServer } from './elric-model-server.js';

/**
 * Elric end to end on the self-hosted path: the real app and service, the OpenAI-compatible
 * client and a local mock model server (127.0.0.1, no network). Runs fit the function's time
 * limit: a cold endpoint is never waited for inside a run (the invocation is deferred and a later
 * drain retries it), each call is capped at what is left of the run, a call that was sent and then
 * failed counts its estimate, and a cut-off run settles what it recorded. Synthetic names only.
 */
const wiring = (url: string, connectTimeoutMs = 1_000) =>
  elricModels(
    {
      CITY_ELRIC_T1_URL: url,
      CITY_ELRIC_T1_MODEL: 'served-small',
      CITY_ELRIC_T2_URL: url,
      CITY_ELRIC_T2_MODEL: 'served-large',
    },
    { allowLoopback: true, connectTimeoutMs },
  )!;

type Fixture = Awaited<ReturnType<typeof elricFixture>>;
const invocation = async (f: Fixture, agentId: string) =>
  (
    await f.db.query<{
      status: string;
      waking_since: string | null;
      deferred_at: string | null;
      reserved_units: string;
      locked_until: string | null;
    }>(
      'SELECT status,waking_since,deferred_at,reserved_units,locked_until FROM elric_invocations WHERE agent_id=$1',
      [agentId],
    )
  ).rows[0]!;

test('the run budget fits the function limit (vercel.json maxDuration) with a margin', () => {
  const config = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8')) as {
    functions?: Record<string, { maxDuration?: number }>;
  };
  const limits = Object.values(config.functions ?? {})
    .map((item) => item.maxDuration)
    .filter((value): value is number => typeof value === 'number');
  assert.ok(limits.length, 'vercel.json sets maxDuration');
  const limitMs = Math.min(...limits) * 1000;
  // The drain stops starting work at its budget; the last call ends by the budget too (each call
  // is capped at what is left minus the margin). Leave at least 4 s for the response and writes.
  assert.ok(
    ELRIC_CONFIG.runBudgetMs + 4_000 <= limitMs,
    `${ELRIC_CONFIG.runBudgetMs} vs ${limitMs}`,
  );
  // The cron shares its deadline with the wake drain and caps Elric at the run budget.
  assert.ok(CRON_DRAIN_BUDGET_MS <= limitMs);
});

test('a reply through the self-hosted model: cost units from usage; the label names the configured model', async (t) => {
  const server = await modelServer(t);
  server.push({
    json: chatCompletion(
      { content: 'Two people are here.' },
      { prompt_tokens: 4000, completion_tokens: 200 },
      // What an endpoint might report as its name (a path): never shown.
      '/models/some-internal-path',
    ),
  });
  const f = await elricFixture(t, { models: wiring(server.url) });
  const s = await f.scene();
  const trigger = await f.say(s.owner, s.room, '@Elric anything new?', s.person);
  const result = await f.elric.run({
    agentId: s.elricId,
    roomId: s.room.id,
    sourceSeq: trigger.message.seq,
  });
  assert.equal(result?.outcome, 'ok', JSON.stringify(result));
  const [turn] = await f.turns(s.owner.operatorId);
  // Tier 1 at the default GPU rates (self-hosted, no per-token pricing), in micro-USD:
  // 4 × 125 + 0.2 × 3750 = 1250.
  assert.equal(Number(turn!.cost_units), 1250);
  assert.equal(turn!.model, 'served-small');
  const read = await f.call(s.host.cookie, 'GET', `/api/rooms/${s.room.id}/messages?since=0`);
  const posted = (
    read.json().messages as Array<{ auto_reply: { model: string; label: string } | null }>
  )
    .map((message) => message.auto_reply)
    .filter((stamp) => stamp !== null);
  assert.deepEqual(posted.at(-1), {
    provider: 'elric',
    model: 'elric-1.0',
    label: 'Elric · AI',
    // The post it answers (pages match a streamed draft to its own answer).
    reply_to: trigger.message.seq,
  });
  assert.equal(server.chats()[0]!.body!.model, 'served-small');
});

test('an answer without usage counts the step estimate, never a 1-unit minimum', async (t) => {
  const server = await modelServer(t);
  const noUsage = chatCompletion({ content: 'A short recap.' });
  delete (noUsage as { usage?: unknown }).usage;
  server.push({ json: noUsage });
  const f = await elricFixture(t, { models: wiring(server.url) });
  const s = await f.scene();
  // A summary goes to Tier 2, whose estimate (context + 600 output tokens) is several units.
  const trigger = await f.say(s.owner, s.room, '@Elric summarize this room', s.person);
  const result = await f.elric.run({
    agentId: s.elricId,
    roomId: s.room.id,
    sourceSeq: trigger.message.seq,
  });
  assert.equal(result?.outcome, 'ok', JSON.stringify(result));
  const [turn] = await f.turns(s.owner.operatorId);
  assert.ok(Number(turn!.cost_units) >= 5, String(turn!.cost_units));
});

test('cold start: deferred (not waited for), shown as waking, retried by a later drain, then the reply', async (t) => {
  const server = await modelServer(t);
  server.push(
    { json: { error: 'loading' }, status: 503 },
    { json: { error: 'loading' }, status: 503 },
    { json: chatCompletion({ content: 'Awake now.' }) },
  );
  const f = await elricFixture(t, { models: wiring(server.url) });
  const s = await f.scene();
  const key = () => ({ agentId: s.elricId, roomId: s.room.id, sourceSeq: trigger.message.seq });
  const trigger = await f.say(s.owner, s.room, '@Elric are you there?', s.person);
  const first = await f.elric.run(key());
  assert.deepEqual([first?.outcome, first?.reason], ['deferred', 'model_waking']);
  const row = await invocation(f, s.elricId);
  assert.equal(row.status, 'queued');
  assert.ok(Number(row.reserved_units) > 0, 'the reservation is kept');
  assert.ok(row.waking_since && row.deferred_at);
  assert.deepEqual(
    (await f.call(s.owner.cookie, 'GET', '/api/elric'))
      .json()
      .waking.map((item: { room_id: string; source_seq: number; text: string }) => [
        item.room_id,
        item.source_seq,
        item.text,
      ]),
    [[s.room.id, trigger.message.seq, ELRIC_WAKING_TEXT]],
  );
  // Not before the retry delay: a drain right away does not take it.
  assert.equal(await f.elric.run(key()), null);
  f.tick(ELRIC_CONFIG.wakeRetryMs);
  const second = await f.elric.run(key());
  assert.deepEqual([second?.outcome, second?.reason], ['deferred', 'model_waking']);
  f.tick(ELRIC_CONFIG.wakeRetryMs);
  // The scheduled drain picks it up and the model answers.
  assert.equal(await f.elric.drain(), 1);
  assert.equal(server.chats().length, 3);
  assert.equal(f.textOf((await f.messages(s.room.id)).at(-1)!), 'Awake now.');
  assert.deepEqual((await f.call(s.owner.cookie, 'GET', '/api/elric')).json().waking, []);
  assert.equal((await f.usage(s.owner.operatorId))!.short, 1, 'charged once, not per attempt');
  assert.equal(Number((await f.usage(s.owner.operatorId))!.reserved_units), 0);
  assert.equal((await f.turns(s.owner.operatorId)).length, 1, 'one turn for the whole invocation');
});

test('cold start: after wakeMaxMs from the first waking it gives up, refunded, nothing posted', async (t) => {
  const port = await closedPort();
  const f = await elricFixture(t, { models: wiring(`http://127.0.0.1:${port}`) });
  const s = await f.scene();
  const trigger = await f.say(s.owner, s.room, '@Elric hello?', s.person);
  const key = { agentId: s.elricId, roomId: s.room.id, sourceSeq: trigger.message.seq };
  const before = (await f.messages(s.room.id)).length;
  let result = await f.elric.run(key);
  let deferrals = 0;
  while (result?.outcome === 'deferred') {
    deferrals++;
    f.tick(ELRIC_CONFIG.wakeRetryMs);
    result = await f.elric.run(key);
  }
  assert.deepEqual([result?.outcome, result?.reason], ['error', 'model_waking']);
  assert.equal(deferrals, Math.ceil(ELRIC_CONFIG.wakeMaxMs / ELRIC_CONFIG.wakeRetryMs));
  assert.equal((await f.usage(s.owner.operatorId))!.short, 0, 'refunded');
  assert.equal(Number((await f.usage(s.owner.operatorId))!.reserved_units), 0);
  assert.equal(Number((await f.usage(s.owner.operatorId))!.spent_units), 0, 'nothing was sent');
  assert.equal((await f.messages(s.room.id)).length, before);
  const turns = await f.turns(s.owner.operatorId);
  assert.deepEqual(
    turns.map((turn) => [turn.outcome, turn.reason]),
    [['error', 'model_waking']],
  );
  assert.deepEqual((await f.call(s.owner.cookie, 'GET', '/api/elric')).json().waking, []);
});

test('cold start: pausing Elric while it is deferred cancels it and refunds the reservation', async (t) => {
  const server = await modelServer(t);
  server.setFallback({ json: { error: 'loading' }, status: 503 });
  const f = await elricFixture(t, { models: wiring(server.url) });
  const s = await f.scene();
  const trigger = await f.say(s.owner, s.room, '@Elric wake up', s.person);
  const first = await f.elric.run({
    agentId: s.elricId,
    roomId: s.room.id,
    sourceSeq: trigger.message.seq,
  });
  assert.equal(first?.outcome, 'deferred');
  await f.call(s.owner.cookie, 'POST', '/api/elric/pause', {});
  const row = await invocation(f, s.elricId);
  assert.equal(row.status, 'cancelled');
  assert.equal(Number(row.reserved_units), 0);
  assert.equal((await f.usage(s.owner.operatorId))!.short, 0);
  assert.equal(Number((await f.usage(s.owner.operatorId))!.reserved_units), 0);
  assert.equal(Number((await f.globalUsage())!.reserved_units), 0);
  f.tick(ELRIC_CONFIG.wakeRetryMs);
  assert.equal(await f.elric.drain(), 0);
  assert.equal(server.chats().length, 1, 'no retry after the pause');
});

test('time budget: too little left defers before the first call; after progress it stops honestly', async (t) => {
  const server = await modelServer(t);
  let wall = 1_000_000;
  const f = await elricFixture(t, { models: wiring(server.url), wallClock: () => wall });
  const s = await f.scene();
  const trigger = await f.say(s.owner, s.room, '@Elric how is it going?', s.person);
  const key = { agentId: s.elricId, roomId: s.room.id, sourceSeq: trigger.message.seq };
  // A deadline with less than one call's minimum left: deferred, nothing sent, reservation kept.
  const tight = await f.elric.run(key, { deadline: wall + ELRIC_CONFIG.minCallMs });
  assert.deepEqual([tight?.outcome, tight?.reason], ['deferred', 'time_budget']);
  assert.equal(server.chats().length, 0);
  assert.equal((await invocation(f, s.elricId)).status, 'queued');
  // The next run has time and answers, with one charge.
  const next = await f.elric.run(key);
  assert.equal(next?.outcome, 'ok', JSON.stringify(next));
  assert.equal((await f.usage(s.owner.operatorId))!.short, 1);

  // After a tool step the run cannot be resumed (its conversation is not stored): it stops.
  server.push({
    json: chatCompletion({
      content: null,
      tool_calls: [
        {
          id: 'r1',
          type: 'function',
          function: { name: 'room_read', arguments: JSON.stringify({ room_id: s.room.id }) },
        },
      ],
    }),
  });
  const again = await f.say(s.owner, s.room, '@Elric what did Ann say?', s.person);
  const deadline = wall + 30_000;
  f.setProbe(async (point) => {
    // After the read, almost no time is left.
    if (point === 'before_tool') wall = deadline - ELRIC_CONFIG.minCallMs;
  });
  const stopped = await f.elric.run(
    { agentId: s.elricId, roomId: s.room.id, sourceSeq: again.message.seq },
    { deadline },
  );
  assert.deepEqual([stopped?.outcome, stopped?.reason], ['step_limit', 'time_budget']);
});

test('a call sent and then failed counts its estimate; one never sent costs nothing', async (t) => {
  const server = await modelServer(t);
  // The first try and its one retry both fail.
  server.push({ json: { error: 'boom' }, status: 500 }, { json: { error: 'boom' }, status: 500 });
  const f = await elricFixture(t, { models: wiring(server.url) });
  const s = await f.scene();
  const trigger = await f.say(s.owner, s.room, '@Elric summarize the room', s.person);
  const result = await f.elric.run({
    agentId: s.elricId,
    roomId: s.room.id,
    sourceSeq: trigger.message.seq,
  });
  assert.deepEqual([result?.outcome, result?.reason], ['error', 'server_error']);
  const [turn] = await f.turns(s.owner.operatorId);
  assert.ok(Number(turn!.cost_units) >= 5, `charged ${turn!.cost_units}`);
  assert.equal(Number((await f.usage(s.owner.operatorId))!.spent_units), Number(turn!.cost_units));
  assert.equal(Number((await f.globalUsage())!.spent_units), Number(turn!.cost_units));
  // The allowance count is given back; the units stay counted.
  assert.equal((await f.usage(s.owner.operatorId))!.summary, 0);
});

test('a slow call is cut at the remaining run time and counted as sent', async (t) => {
  const server = await modelServer(t);
  server.push({ delayMs: 2_000, then: { json: chatCompletion({ content: 'late' }) } });
  const f = await elricFixture(t, {
    models: wiring(server.url),
    config: { runBudgetMs: 900, minCallMs: 200, callMarginMs: 100 },
  });
  const s = await f.scene();
  const trigger = await f.say(s.owner, s.room, '@Elric hello', s.person);
  const started = Date.now();
  const result = await f.elric.run({
    agentId: s.elricId,
    roomId: s.room.id,
    sourceSeq: trigger.message.seq,
  });
  assert.ok(Date.now() - started < 1_800, 'the call did not run to the tier timeout');
  assert.deepEqual([result?.outcome, result?.reason], ['error', 'timeout']);
  assert.ok(Number((await f.turns(s.owner.operatorId))[0]!.cost_units) >= 1);
});

test('a run cut off mid-flight settles what it recorded (plus an in-flight call), not the reservation', async (t) => {
  const server = await modelServer(t);
  const f = await elricFixture(t, { models: wiring(server.url) });
  const s = await f.scene();
  for (const [inflight, refunded] of [
    [0, true],
    [4, false],
  ] as const) {
    const trigger = await f.say(s.owner, s.room, '@Elric hello', s.person);
    const key = { agentId: s.elricId, roomId: s.room.id, sourceSeq: trigger.message.seq };
    // A run that reserved, spent 2 units, and lost its lease (the function was cut off).
    await f.db.query(
      `UPDATE elric_invocations SET status='running', lease_id='lost', locked_until=$4,
          reserved_units=24, usage_day=$5, kind='short', spent_units=2, inflight_units=$6
        WHERE agent_id=$1 AND room_id=$2 AND source_seq=$3`,
      [
        key.agentId,
        key.roomId,
        key.sourceSeq,
        f.now() - 1,
        new Date(f.now()).toISOString().slice(0, 10),
        inflight,
      ],
    );
    await f.db.query(
      `INSERT INTO elric_usage(owner_id,day,short,reserved_units) VALUES($1,$2,1,24)
         ON CONFLICT (owner_id,day) DO UPDATE SET short=elric_usage.short+1, reserved_units=elric_usage.reserved_units+24`,
      [s.owner.operatorId, new Date(f.now()).toISOString().slice(0, 10)],
    );
    const before = await f.usage(s.owner.operatorId);
    const result = await f.elric.run(key);
    assert.deepEqual([result?.outcome, result?.reason], ['error', 'lease_expired']);
    const turn = (await f.turns(s.owner.operatorId)).at(-1)!;
    assert.equal(Number(turn.cost_units), 2 + inflight, 'recorded spend, not the 24 reserved');
    const after = await f.usage(s.owner.operatorId);
    assert.equal(after!.short, before!.short - (refunded ? 1 : 0));
    assert.equal(Number(after!.reserved_units), Number(before!.reserved_units) - 24);
  }
});

test('health probe: cron secret only (404 otherwise), states per tier, no URLs or model text', async (t) => {
  const server = await modelServer(t);
  const previous = process.env.CRON_SECRET;
  // Generated per run: no secret-shaped literal in the repository.
  const cronSecret = randomBytes(24).toString('base64url');
  process.env.CRON_SECRET = cronSecret;
  t.after(() => {
    if (previous === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = previous;
  });
  const port = await closedPort();
  const models = elricModels(
    {
      CITY_ELRIC_T1_URL: server.url,
      CITY_ELRIC_T1_MODEL: 'served-small',
      CITY_ELRIC_T2_URL: `http://127.0.0.1:${port}`,
      CITY_ELRIC_T2_MODEL: 'served-large',
    },
    { allowLoopback: true, connectTimeoutMs: 500 },
  )!;
  const f = await elricFixture(t, { models });
  for (const headers of [
    {},
    { authorization: `Bearer ${randomBytes(24).toString('base64url')}` },
  ]) {
    const denied = await f.app.inject({ method: 'GET', url: ELRIC_HEALTH_PATH, headers });
    assert.equal(denied.statusCode, 404);
  }
  const res = await f.app.inject({
    method: 'GET',
    url: ELRIC_HEALTH_PATH,
    headers: { authorization: `Bearer ${cronSecret}` },
  });
  assert.equal(res.statusCode, 200, res.body);
  const tiers = res.json().tiers;
  assert.equal(tiers['1'].state, 'ready');
  assert.equal(tiers['2'].state, 'waking');
  assert.doesNotMatch(res.body, /127\.0\.0\.1|served-|http/);
  assert.equal(server.chats().length, 0, 'the probe spends no tokens');
});

test('the existing every-minute wake-drain cron retries a deferred invocation', async (t) => {
  const server = await modelServer(t);
  server.push(
    { json: { error: 'loading' }, status: 503 },
    { json: chatCompletion({ content: 'Up.' }) },
  );
  const previous = process.env.CRON_SECRET;
  const cronSecret = randomBytes(24).toString('base64url');
  process.env.CRON_SECRET = cronSecret;
  t.after(() => {
    if (previous === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = previous;
  });
  const f = await elricFixture(t, { models: wiring(server.url) });
  const s = await f.scene();
  const trigger = await f.say(s.owner, s.room, '@Elric ping', s.person);
  const first = await f.elric.run({
    agentId: s.elricId,
    roomId: s.room.id,
    sourceSeq: trigger.message.seq,
  });
  assert.equal(first?.outcome, 'deferred');
  f.tick(ELRIC_CONFIG.wakeRetryMs);
  const cron = await f.app.inject({
    method: 'GET',
    url: '/api/cron/wake-drain',
    headers: { authorization: `Bearer ${cronSecret}` },
  });
  assert.equal(cron.statusCode, 200, cron.body);
  assert.equal(f.textOf((await f.messages(s.room.id)).at(-1)!), 'Up.');
  assert.equal((await invocation(f, s.elricId)).status, 'done');
});
