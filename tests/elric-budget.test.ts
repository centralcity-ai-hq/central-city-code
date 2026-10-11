import test from 'node:test';
import assert from 'node:assert/strict';
import { reserve } from '../server/elric/budget.js';
import { ELRIC_CONFIG } from '../server/elric/config.js';
import { elricFixture, permissiveLimiter } from './elric-fixture.js';

const TIER1 = ELRIC_CONFIG.unitsPerStep[1] * ELRIC_CONFIG.maxSteps;

/** THREAT_PRIVACY_REVIEW §11 "Budget exhaustion": allowance, global ceiling, kill switch, races. */

test('per-owner allowance: refused before any adapter call, with the reset time', async (t) => {
  const f = await elricFixture(t, { config: { allowance: { short: 2, summary: 1, tool: 1 } } });
  const s = await f.scene();
  for (let i = 0; i < 3; i++) await f.say(s.owner, s.room, `@Elric question ${i}`, s.person);
  await f.elric.drain();
  assert.equal(f.adapterCalls(), 2);
  const turns = await f.turns(s.owner.operatorId);
  assert.deepEqual(
    turns.map((turn) => [turn.outcome, turn.reason]),
    [
      ['ok', null],
      ['ok', null],
      ['limit', 'owner_allowance'],
    ],
  );
  // The visible result names the reset (00:00 UTC).
  const next = await f.say(s.owner, s.room, '@Elric one more', s.person);
  const result = await f.elric.run({
    agentId: s.elricId,
    roomId: s.room.id,
    sourceSeq: next.message.seq,
  });
  assert.equal(result?.outcome, 'limit');
  assert.equal(result?.resetsAt, '2026-10-01T00:00:00.000Z');
  assert.equal(f.adapterCalls(), 2);
  const status = await f.call(s.owner.cookie, 'GET', '/api/elric');
  assert.deepEqual(status.json().usage.used, { short: 2, summary: 0, tool: 0 });
  // Another kind still has its own allowance; the next UTC day resets everything.
  await f.say(s.owner, s.room, '@Elric summarize please', s.person);
  await f.elric.drain();
  assert.equal(f.adapterCalls(), 3);
  f.tick(13 * 3_600_000);
  await f.say(s.owner, s.room, '@Elric good morning', s.person);
  await f.elric.drain();
  assert.equal(f.adapterCalls(), 4);
});

test('global ceiling: every owner is refused once the day is used up', async (t) => {
  // One Tier 1 invocation reserves unitsPerStep[1] * maxSteps = 24 units.
  const f = await elricFixture(t, { config: { globalDailyUnits: TIER1 + 6 } });
  const a = await f.scene('Room A');
  const b = await f.scene('Room B');
  const first = await f.say(a.owner, a.room, '@Elric first', a.person);
  const second = await f.say(b.owner, b.room, '@Elric second', b.person);
  // While A holds its reservation, B does not fit under the ceiling.
  f.setProbe(async (point) => {
    if (point !== 'reserved') return;
    f.setProbe(undefined);
    const refused = await f.elric.run({
      agentId: b.elricId,
      roomId: b.room.id,
      sourceSeq: second.message.seq,
    });
    assert.deepEqual([refused?.outcome, refused?.reason], ['limit', 'global_ceiling']);
  });
  const ok = await f.elric.run({
    agentId: a.elricId,
    roomId: a.room.id,
    sourceSeq: first.message.seq,
  });
  assert.equal(ok?.outcome, 'ok');
  assert.equal(f.adapterCalls(), 1);
  // What was not spent of A's reservation is back; spent units stay spent.
  const global = (await f.globalUsage())!;
  assert.equal(Number(global.reserved_units), 0);
  assert.ok(Number(global.spent_units) >= 1);
  // The day is used up: every owner is refused, before any adapter call.
  await f.db.query('UPDATE elric_global_usage SET spent_units=$1', [TIER1 + 6]);
  await f.say(a.owner, a.room, '@Elric again', a.person);
  await f.say(b.owner, b.room, '@Elric again', b.person);
  await f.elric.drain();
  assert.equal(f.adapterCalls(), 1);
  assert.equal((await f.turns(a.owner.operatorId)).at(-1)!.reason, 'global_ceiling');
  assert.equal((await f.turns(b.owner.operatorId)).at(-1)!.reason, 'global_ceiling');
});

test('kill switch (environment or database): refused before any adapter call; off again works', async (t) => {
  const f = await elricFixture(t);
  const s = await f.scene();
  const other = await f.scene('Other kill room');
  process.env.CITY_ELRIC_KILL = '1';
  try {
    await f.say(s.owner, s.room, '@Elric hello', s.person);
    await f.elric.drain();
  } finally {
    delete process.env.CITY_ELRIC_KILL;
  }
  await f.elric.killSwitch(true, 'operator');
  await f.say(s.owner, s.room, '@Elric hello again', s.person);
  await f.say(other.owner, other.room, '@Elric me too', other.person);
  await f.elric.drain();
  assert.equal(f.adapterCalls(), 0);
  assert.deepEqual(
    (await f.turns(other.owner.operatorId)).map((turn) => turn.outcome),
    ['refused_kill'],
    'every owner at once',
  );
  assert.equal(await f.usage(s.owner.operatorId), undefined, 'nothing reserved');
  await f.elric.killSwitch(false, 'operator');
  await f.say(s.owner, s.room, '@Elric and now?', s.person);
  await f.elric.drain();
  assert.equal(f.adapterCalls(), 1);
  assert.deepEqual(
    (await f.turns(s.owner.operatorId)).map((turn) => turn.outcome),
    ['refused_kill', 'refused_kill', 'ok'],
  );
  // Tier 0 is refused too while killed (fail closed for everything Elric does).
  await f.elric.killSwitch(true, 'operator');
  await f.say(s.owner, s.room, '@Elric who is here', s.person);
  await f.elric.drain();
  assert.equal((await f.turns(s.owner.operatorId)).at(-1)!.outcome, 'refused_kill');
});

test('a reservation cancelled before the adapter call is refunded in full', async (t) => {
  const f = await elricFixture(t);
  const s = await f.scene();
  const trigger = await f.say(s.owner, s.room, '@Elric quick one', s.person);
  f.setProbe(async (point) => {
    if (point === 'reserved') await f.elric.pause(s.owner.operatorId);
  });
  const result = await f.elric.run({
    agentId: s.elricId,
    roomId: s.room.id,
    sourceSeq: trigger.message.seq,
  });
  f.setProbe(undefined);
  assert.equal(result?.outcome, 'refused_inactive');
  assert.equal(f.adapterCalls(), 0);
  const usage = (await f.usage(s.owner.operatorId))!;
  assert.deepEqual(
    [usage.short, Number(usage.reserved_units), Number(usage.spent_units)],
    [0, 0, 0],
  );
  const global = (await f.globalUsage())!;
  assert.deepEqual([Number(global.reserved_units), Number(global.spent_units)], [0, 0]);
});

test('an adapter error refunds the allowance', async (t) => {
  const f = await elricFixture(t);
  const s = await f.scene();
  const trigger = await f.say(s.owner, s.room, '@Elric are you up?', s.person);
  // Persistent: the first try and its one retry both fail.
  f.small.push({ error: 'server_error' }, { error: 'server_error' });
  const result = await f.elric.run({
    agentId: s.elricId,
    roomId: s.room.id,
    sourceSeq: trigger.message.seq,
  });
  assert.deepEqual([result?.outcome, result?.reason], ['error', 'server_error']);
  assert.equal((await f.usage(s.owner.operatorId))!.short, 0);
  // The only Elric post is the plain failure line (no model wrote it).
  const fromElric = (await f.messages(s.room.id)).filter(
    (row) => row.sender_agent_id === s.elricId,
  );
  assert.deepEqual(
    fromElric.map((row) => row.parts[0]?.text),
    ["Elric couldn't answer, try again."],
  );
  // A platform-side model failure never pauses or blames the owner's Elric.
  assert.equal((await f.call(s.owner.cookie, 'GET', '/api/elric')).json().status, 'active');
});

test('50 concurrent invocations cannot over-reserve the owner allowance', async (t) => {
  const f = await elricFixture(t, {
    rateLimiter: permissiveLimiter,
    config: { allowance: { short: 20, summary: 4, tool: 5 }, globalDailyUnits: TIER1 * 30 },
  });
  const s = await f.scene();
  const keys: number[] = [];
  for (let i = 0; i < 50; i++)
    keys.push((await f.say(s.owner, s.room, `@Elric q${i}`, s.person)).message.seq);
  const results = await Promise.all(
    keys.map((seq) => f.elric.run({ agentId: s.elricId, roomId: s.room.id, sourceSeq: seq })),
  );
  const ok = results.filter((result) => result?.outcome === 'ok').length;
  const limited = results.filter((result) => result?.outcome === 'limit').length;
  assert.equal(ok, 20);
  assert.equal(limited, 30);
  assert.equal(f.adapterCalls(), 20);
  const usage = (await f.usage(s.owner.operatorId))!;
  assert.equal(usage.short, 20);
  assert.equal(Number(usage.reserved_units), 0);
  const global = (await f.globalUsage())!;
  assert.equal(global.invocations, 20);
  assert.equal(Number(global.reserved_units), 0);
});

test('50 concurrent reservations cannot over-reserve the global ceiling', async (t) => {
  // Exactly five Tier 1 reservations held at the same time.
  const f = await elricFixture(t, {
    rateLimiter: permissiveLimiter,
    config: { allowance: { short: 100, summary: 4, tool: 5 }, globalDailyUnits: TIER1 * 5 },
  });
  const s = await f.scene();
  const keys: number[] = [];
  for (let i = 0; i < 50; i++)
    keys.push((await f.say(s.owner, s.room, `@Elric q${i}`, s.person)).message.seq);
  // Every run that reserved waits until all 50 attempts are decided, so the reservations are
  // truly held together.
  let held = 0;
  let decided = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const check = () => {
    if (held + decided === 50) release();
  };
  f.setProbe(async (point) => {
    if (point !== 'reserved') return;
    held++;
    check();
    await gate;
  });
  const results = await Promise.all(
    keys.map(async (seq) => {
      const result = await f.elric.run({ agentId: s.elricId, roomId: s.room.id, sourceSeq: seq });
      if (result?.outcome === 'limit') {
        decided++;
        check();
      }
      return result;
    }),
  );
  f.setProbe(undefined);
  assert.equal(held, 5);
  assert.equal(results.filter((result) => result?.outcome === 'ok').length, 5);
  assert.equal(results.filter((result) => result?.reason === 'global_ceiling').length, 45);
  assert.equal(f.adapterCalls(), 5);
  const global = (await f.globalUsage())!;
  assert.equal(Number(global.reserved_units), 0);
  assert.ok(Number(global.spent_units) <= TIER1 * 5);
});

test('1,000 concurrent reservations: exactly the allowance, exactly the ceiling, nothing more', async (t) => {
  const f = await elricFixture(t);
  const config = { ...ELRIC_CONFIG, allowance: { short: 20, summary: 4, tool: 5 } };
  const leases = async (owner: string, count: number) => {
    const rows: Array<{ agentId: string; roomId: string; sourceSeq: number; leaseId: string }> = [];
    for (let i = 1; i <= count; i++)
      rows.push({
        agentId: `agent-${owner}`,
        roomId: 'room-x',
        sourceSeq: i,
        leaseId: `lease-${owner}-${i}`,
      });
    await f.db.query(
      `INSERT INTO elric_invocations(agent_id,room_id,source_seq,owner_id,invoker_member_id,invoker_kind,status,lease_id,created_at)
       SELECT $1,'room-x',n,$2,'person','owner','running','lease-'||$2||'-'||n,0 FROM generate_series(1,$3) n`,
      [`agent-${owner}`, owner, count],
    );
    return rows;
  };
  const day = '2026-09-30';
  // Allowance: 1,000 at once for one owner, a ceiling far away.
  const one = await leases('owner-one', 1_000);
  const first = await Promise.all(
    one.map((invocation) =>
      reserve(
        f.db,
        { ...config, globalDailyUnits: 1_000_000 },
        { ownerId: 'owner-one', kind: 'short', units: 16, day, invocation },
        {},
      ),
    ),
  );
  assert.equal(first.filter((result) => result.ok).length, 20);
  assert.ok(first.every((result) => result.ok || result.reason === 'owner_allowance'));
  // Ceiling: 1,000 owners at once; what is already reserved counts (20 × 16 = 320).
  const many = await Promise.all(
    Array.from({ length: 1_000 }, async (_, i) => (await leases(`owner-${i}`, 1))[0]!),
  );
  const second = await Promise.all(
    many.map((invocation, i) =>
      reserve(
        f.db,
        { ...config, globalDailyUnits: 320 + 16 * 7 },
        { ownerId: `owner-${i}`, kind: 'short', units: 16, day, invocation },
        {},
      ),
    ),
  );
  assert.equal(second.filter((result) => result.ok).length, 7);
  assert.ok(second.every((result) => result.ok || result.reason === 'global_ceiling'));
  const global = (await f.globalUsage())!;
  assert.equal(Number(global.reserved_units), 320 + 16 * 7);
  assert.equal(global.invocations, 27);
});

test('lease: every recheck renews it, so a slow live run is never stolen', async (t) => {
  const f = await elricFixture(t);
  const s = await f.scene();
  const trigger = await f.say(s.owner, s.room, '@Elric read slowly', s.person);
  const key = { agentId: s.elricId, roomId: s.room.id, sourceSeq: trigger.message.seq };
  f.small.push(
    { toolCalls: [{ name: 'room_read', args: { room_id: s.room.id } }] },
    { toolCalls: [{ name: 'room_read', args: { room_id: s.room.id } }] },
    { text: 'done' },
  );
  const steals: Array<unknown> = [];
  f.setProbe(async (point) => {
    if (point !== 'before_tool') return;
    // 150 s pass before each tool call: over two tool calls more than one lease (190 s).
    f.tick(150_000);
    steals.push(await f.elric.run(key));
  });
  const result = await f.elric.run(key);
  f.setProbe(undefined);
  assert.deepEqual(steals, [null, null], 'another drain never takes a live lease');
  assert.equal(result?.outcome, 'ok');
});

test('a run lost before any model call settles what it recorded (nothing) when its lease expires', async (t) => {
  const f = await elricFixture(t);
  const s = await f.scene();
  const trigger = await f.say(s.owner, s.room, '@Elric crash please', s.person);
  f.setProbe(async (point) => {
    if (point === 'reserved') throw new Error('the instance died');
  });
  await assert.rejects(
    f.elric.run({ agentId: s.elricId, roomId: s.room.id, sourceSeq: trigger.message.seq }),
  );
  f.setProbe(undefined);
  f.tick(ELRIC_CONFIG.leaseMs + 1);
  await f.elric.drain();
  const turn = (await f.turns(s.owner.operatorId)).at(-1)!;
  assert.deepEqual([turn.outcome, turn.reason], ['error', 'lease_expired']);
  const usage = (await f.usage(s.owner.operatorId))!;
  // Nothing was sent and nothing was in flight: no units, the allowance comes back. (A run cut
  // off during a model call counts that call's estimate: tests/elric-wake.test.ts.)
  assert.equal(usage.short, 0, 'the allowance is given back');
  assert.equal(Number(usage.reserved_units), 0);
  assert.equal(Number(usage.spent_units), 0, 'only the recorded spend counts, not the reservation');
  assert.equal(Number((await f.globalUsage())!.spent_units), 0);
  assert.equal(Number((await f.globalUsage())!.reserved_units), 0);
  assert.equal(f.adapterCalls(), 0);
});

test('a turn stays inside its reservation: tool calls per step, tool-result budget, pre-call estimate', async (t) => {
  const f = await elricFixture(t, {
    config: {
      toolResultChars: 400,
      // The pre-full-answers output cap and a reservation sized so the first estimate fits and
      // the second (after the tool results) does not.
      maxOutputTokens: 600,
      unitsPerStep: { 1: 7_500, 2: 30_750 },
      // Scaled like the default Tier 1 reservation (3 -> 5,375 units since migration 45), and by
      // 2/3 for the 2-chars-per-token estimate, so the second estimate still outgrows it.
      unitsPer1kTokens: {
        1: { input: 11_945, output: 11_945 },
        2: { input: 11_945, output: 11_945 },
      },
    },
  });
  const s = await f.scene();
  for (let i = 0; i < 5; i++)
    await f.say(s.host, s.room, `line ${i} ${'x'.repeat(60)}`, s.hostAgent);
  const trigger = await f.say(s.owner, s.room, '@Elric read everything', s.person);
  const read = { name: 'room_read', args: { room_id: s.room.id } };
  f.small.push({ toolCalls: [read, read, read, read, read, read] }, { toolCalls: [read] });
  const result = await f.elric.run({
    agentId: s.elricId,
    roomId: s.room.id,
    sourceSeq: trigger.message.seq,
  });
  const turn = (await f.turns(s.owner.operatorId))[0]!;
  // Six calls in one response: four ran (the result budget allowed some), two were capped.
  assert.deepEqual(
    turn.tool_calls.slice(4, 6).map((call) => call.status),
    ['refused_cap', 'refused_cap'],
  );
  const results = f.small.requests
    .at(-1)!
    .messages.filter((message) => message.role === 'tool' && message.content.includes('messages'))
    .map((message) => (message.role === 'tool' ? message.content : ''))
    .join('');
  assert.ok(results.length <= 400 + 200, `tool results stay near the budget (${results.length})`);
  // The next call's estimate no longer fits the reservation: stopped honestly before the call.
  assert.deepEqual([result?.outcome, result?.reason], ['step_limit', 'turn_budget']);
  assert.ok(Number(turn.cost_units) <= Number(turn.reserved_units));
  assert.equal(Number(turn.reserved_units), 7_500 * ELRIC_CONFIG.maxSteps);
});

test('true spend is recorded even above the reservation (the overage is visible, never capped)', async (t) => {
  const f = await elricFixture(t);
  const s = await f.scene();
  const trigger = await f.say(s.owner, s.room, '@Elric long answer', s.person);
  f.small.push({ text: 'A very long answer.', usage: { outputTokens: 100_000 } });
  await f.elric.run({ agentId: s.elricId, roomId: s.room.id, sourceSeq: trigger.message.seq });
  const turn = (await f.turns(s.owner.operatorId))[0]!;
  assert.ok(Number(turn.cost_units) > Number(turn.reserved_units));
  assert.equal(Number((await f.globalUsage())!.spent_units), Number(turn.cost_units));
  assert.equal(Number((await f.usage(s.owner.operatorId))!.spent_units), Number(turn.cost_units));
});

test('limit notices: owner-only and ephemeral, per kind, with the reset time', async (t) => {
  const f = await elricFixture(t, { config: { allowance: { short: 1, summary: 1, tool: 1 } } });
  const s = await f.scene();
  const first = await f.say(s.owner, s.room, '@Elric summarize please', s.person);
  assert.equal(first.elric_notice, undefined);
  await f.elric.drain();
  const second = await f.say(s.owner, s.room, '@Elric summarize again', s.person);
  assert.deepEqual(second.elric_notice, {
    code: 'elric_limit',
    kind: 'summary',
    text: 'Summaries used up for today. Resets at 00:00 UTC.',
    resets_at: '2026-10-01T00:00:00.000Z',
  });
  const result = await f.elric.run({
    agentId: s.elricId,
    roomId: s.room.id,
    sourceSeq: second.message.seq,
  });
  assert.equal(result?.notice, 'Summaries used up for today. Resets at 00:00 UTC.');
  // A short question still has its own allowance: no notice.
  const short = await f.say(s.owner, s.room, '@Elric quick one', s.person);
  assert.equal(short.elric_notice, undefined);
  const status = await f.call(s.owner.cookie, 'GET', '/api/elric');
  assert.deepEqual(status.json().limit_notices, [
    'Summaries used up for today. Resets at 00:00 UTC.',
  ]);
  // Nothing about limits is ever posted into the room.
  assert.ok((await f.messages(s.room.id)).every((row) => !f.textOf(row).includes('used up')));
});
