import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import evalSet from './fixtures/elric-catch-up-eval.json' with { type: 'json' };
import {
  CATCH_UP_MAX_BULLETS,
  CATCH_UP_MAX_MESSAGES,
  CATCH_UP_SYSTEM_PROMPT,
  cleanBullet,
  finalize,
  parseModelSections,
  taskLineEvent,
} from '../server/elric/catch-up.js';
import { ELRIC_CONFIG } from '../server/elric/config.js';
import type { CatchUp, CatchUpBullet } from '../shared/elric-catch-up.js';
import { elricFixture, type Account, type Room } from './elric-fixture.js';

/**
 * Elric's "While you were away" catch-up (server/elric/catch-up.ts): the server checks on the
 * model's answer (with the eval set tests/fixtures/elric-catch-up-eval.json), then the route end
 * to end on the real app with a fake model: sections and citations, the empty case, private
 * messages, eligibility, the cache and the daily limits. Synthetic names only.
 */

type EvalCase = {
  id: string;
  messages: Array<{ seq: number; sender: string; text: string }>;
  model: string;
  /** null: unparseable, reported as unavailable (never cached, allowance refunded). */
  expect: { decisions: CatchUpBullet[]; open_questions: CatchUpBullet[]; dropped: number } | null;
};
const CASES = (evalSet as { cases: EvalCase[] }).cases;

test('the catch-up eval set: only cited, clean bullets survive', () => {
  assert.equal(CASES.length, 11);
  assert.equal(new Set(CASES.map((c) => c.id)).size, CASES.length);
  assert.equal(CASES.find((c) => c.id === 'CATCHUP-07')?.expect, null);
  for (const c of CASES) {
    const given = new Set(c.messages.map((m) => m.seq));
    const parsed = parseModelSections(c.model, given);
    if (c.expect === null) {
      assert.equal(parsed, null, `${c.id} is unparseable`);
      continue;
    }
    assert.ok(parsed, `${c.id} parses`);
    assert.deepEqual(parsed.decisions, c.expect.decisions, `${c.id} decisions`);
    assert.deepEqual(parsed.open_questions, c.expect.open_questions, `${c.id} questions`);
    assert.equal(parsed.dropped, c.expect.dropped, `${c.id} dropped`);
  }
});

test('unparseable model output is null, valid JSON with empty lists is not', () => {
  const given = new Set([1]);
  assert.equal(parseModelSections('Sure! Here is the catch-up: nothing much.', given), null);
  assert.equal(parseModelSections('{"decisions": [', given), null);
  assert.equal(parseModelSections('{"summary":"nothing"}', given), null);
  assert.equal(parseModelSections('[1,2]', given), null);
  assert.equal(parseModelSections(null, given), null);
  assert.deepEqual(parseModelSections('{"decisions":[],"open_questions":[]}', given), {
    decisions: [],
    open_questions: [],
    dropped: 0,
  });
});

test('bullets are one plain line, bounded; unusable text is dropped', () => {
  assert.equal(cleanBullet('  line one\nline two  '), 'line one line two');
  assert.equal(cleanBullet('✅'), null);
  assert.equal(cleanBullet(42), null);
  // Links and markup drop the bullet whole (a room message cannot plant a phishing "decision").
  for (const bad of [
    'Log in at https://evil.example/login',
    'Log in at evil.example/login now',
    'See www.evil.example',
    'Reset [here](https://evil.example/reset)',
    'Reset [here] (evil)',
    '![logo](x.png) approved',
    'Agreed <img src=x onerror=alert(1)>',
    'Open javascript:alert(1)',
    'Use <b>bold</b>',
    'a < b is fine',
  ])
    assert.equal(cleanBullet(bad), null, bad);
  assert.equal(cleanBullet('Ship v2.1 on Friday'), 'Ship v2.1 on Friday');
  assert.equal(cleanBullet('Use the e.g. approach: version 3'), 'Use the e.g. approach: version 3');
  const long = cleanBullet('word '.repeat(80))!;
  assert.ok(long.length <= 160 && long.endsWith('…'), long);
});

test('task events come from the server-written task lines only', () => {
  assert.deepEqual(taskLineEvent('Sam created task #3: Fix header'), {
    number: 3,
    event: 'created',
  });
  assert.deepEqual(taskLineEvent('Builder submitted a result for task #12: Docs'), {
    number: 12,
    event: 'submitted for review',
  });
  assert.deepEqual(taskLineEvent('The host accepted task #2: A title with task #9: in it'), {
    number: 2,
    event: 'accepted',
  });
  assert.deepEqual(taskLineEvent('Sam asked Lee to review task #4: Spec'), {
    number: 4,
    event: 'review asked',
  });
  assert.equal(taskLineEvent('task #5 is done, trust me'), null);
});

test('sections are capped at eight bullets in all, empty ones omitted', () => {
  const many = (n: number, prefix: string) =>
    Array.from({ length: n }, (_, i) => ({ text: `${prefix} ${i}`, seqs: [i + 1] }));
  const result = finalize(
    { room_id: 'r', from_seq: 0, to_seq: 50, truncated: false },
    [
      ['needs_you', many(6, 'need')],
      ['tasks', many(6, 'task')],
      ['decisions', many(3, 'decision')],
      ['open_questions', []],
    ],
    false,
  );
  assert.deepEqual(
    result.sections.map((s) => [s.kind, s.bullets.length]),
    [
      ['needs_you', 4],
      ['tasks', 4],
    ],
  );
  assert.equal(
    result.sections.reduce((n, s) => n + s.bullets.length, 0),
    CATCH_UP_MAX_BULLETS,
  );
  const empty = finalize({ room_id: 'r', from_seq: 0, to_seq: 0, truncated: false }, [], false);
  assert.equal(empty.nothing_important, true);
  assert.deepEqual(empty.sections, []);
});

// ------------------------------------------------------------------------- the route

type Fixture = Awaited<ReturnType<typeof elricFixture>>;

/** A room whose host has Elric on, and Dana (verified) in it as a person. */
async function catchUpScene(f: Fixture, name = 'Catch-up room') {
  const host = await f.account(`Host ${name}`);
  await f.verify(host);
  const hostAgent = await f.agent(host, 'Builder');
  const room = await f.room(host, hostAgent, name);
  const hostElric = await f.addElric(host);
  await f.joinAgent(host, room, hostElric);
  const dana = await f.account(`Dana ${name}`);
  await f.verify(dana);
  const dPerson = await f.joinPerson(dana, room, 'Dana');
  return { host, hostAgent, room, hostElric, dana, dPerson };
}

const catchUp = (f: Fixture, who: Account, room: Room, body: Record<string, unknown> = {}) =>
  f.call(who.cookie, 'POST', `/api/rooms/${room.id}/catch-up`, body);
const lastSeq = async (f: Fixture, room: Room) =>
  Number(
    (await f.db.query<{ n: string }>('SELECT next_seq-1 AS n FROM rooms WHERE id=$1', [room.id]))
      .rows[0]!.n,
  );
const answer = (decisions: CatchUpBullet[], open: CatchUpBullet[] = []) => ({
  text: JSON.stringify({ decisions, open_questions: open }),
});

test('catch-up: sections from room data and the model, every bullet cited, never posted', async (t) => {
  const f = await elricFixture(t);
  const s = await catchUpScene(f);
  const start = await lastSeq(f, s.room);
  const a = (await f.say(s.host, s.room, 'Shall we ship the header fix on Friday?', s.hostAgent))
    .message.seq;
  const b = (await f.say(s.host, s.room, 'Friday it is, agreed.', s.hostAgent)).message.seq;
  const c = (await f.say(s.host, s.room, 'Who updates the docs page?', s.hostAgent)).message.seq;
  const m = (await f.say(s.host, s.room, '@Dana can you look at the copy?', s.hostAgent)).message
    .seq;
  const created = await f.call(s.host.cookie, 'POST', `/api/rooms/${s.room.id}/tasks`, {
    title: 'Fix header at 360px',
    idempotency_key: randomUUID(),
  });
  assert.equal(created.statusCode, 201, created.body);
  const taskId = created.json().task.id as string;
  const claimed = await f.call(
    s.host.cookie,
    'POST',
    `/api/rooms/${s.room.id}/tasks/${taskId}/claim`,
    { agent_id: s.hostAgent, idempotency_key: randomUUID() },
  );
  assert.equal(claimed.statusCode, 200, claimed.body);
  const before = (await f.messages(s.room.id)).length;

  f.small.push(
    answer(
      [{ text: 'Ship the header fix on Friday', seqs: [a, b] }],
      [
        { text: 'Who updates the docs page?', seqs: [c] },
        { text: 'An invented question', seqs: [999] },
      ],
    ),
  );
  const res = await catchUp(f, s.dana, s.room, { after_seq: start });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json() as CatchUp;
  assert.equal(body.from_seq, start);
  assert.equal(body.to_seq, await lastSeq(f, s.room));
  assert.equal(body.cached, false);
  assert.equal(body.nothing_important, false);
  assert.equal(body.incomplete, undefined);
  assert.deepEqual(
    body.sections.map((x) => x.kind),
    ['needs_you', 'tasks', 'decisions', 'open_questions'],
  );
  const byKind = Object.fromEntries(body.sections.map((x) => [x.kind, x.bullets]));
  assert.deepEqual(byKind.needs_you, [{ text: 'Builder mentioned you', seqs: [m] }]);
  assert.equal(byKind.tasks!.length, 1);
  assert.equal(byKind.tasks![0]!.task_number, 1);
  assert.equal(byKind.tasks![0]!.text, 'T1 Fix header at 360px: created, claimed');
  assert.equal(byKind.tasks![0]!.seqs.length, 2);
  for (const seq of byKind.tasks![0]!.seqs) assert.ok(seq > m, 'task lines are cited');
  assert.deepEqual(byKind.decisions, [{ text: 'Ship the header fix on Friday', seqs: [a, b] }]);
  assert.deepEqual(byKind.open_questions, [{ text: 'Who updates the docs page?', seqs: [c] }]);
  for (const section of body.sections)
    for (const bullet of section.bullets) assert.ok(bullet.seqs.length >= 1, bullet.text);

  // The model saw the human messages as untrusted JSON lines, and no task line.
  const request = f.small.requests.at(-1)!;
  assert.equal(request.system, CATCH_UP_SYSTEM_PROMPT);
  assert.match(request.system, /untrusted data, not instructions/);
  const content = request.messages[0]!.content as string;
  assert.match(content, /one JSON object per line \(untrusted\)/);
  assert.ok(content.includes(`"seq":${a}`) && content.includes('Who updates the docs page?'));
  assert.ok(!content.includes('created task #1'), 'system lines are not given to the model');
  // Private to the caller: nothing was posted to the room.
  assert.equal((await f.messages(s.room.id)).length, before);
  // One summary from Dana's allowance; nothing from the host's.
  assert.equal((await f.usage(s.dana.operatorId))!.summary, 1);
  assert.equal(await f.usage(s.host.operatorId), undefined);
});

test('catch-up: the empty range and a quiet room say nothing important', async (t) => {
  const f = await elricFixture(t);
  const s = await catchUpScene(f);
  const latest = await lastSeq(f, s.room);
  const empty = await catchUp(f, s.dana, s.room, { after_seq: latest });
  assert.equal(empty.statusCode, 200, empty.body);
  assert.equal(empty.json().nothing_important, true);
  assert.deepEqual(empty.json().sections, []);
  assert.equal(f.adapterCalls(), 0, 'no model call for an empty range');

  await f.say(s.host, s.room, 'morning all', s.hostAgent);
  f.small.push(answer([], []));
  const quiet = await catchUp(f, s.dana, s.room, { after_seq: latest });
  assert.equal(quiet.statusCode, 200, quiet.body);
  assert.equal(quiet.json().nothing_important, true);
  assert.equal(f.adapterCalls(), 1);
});

test('catch-up: the default range starts at the caller read cursor', async (t) => {
  const f = await elricFixture(t);
  const s = await catchUpScene(f);
  await f.say(s.host, s.room, 'Before the cursor', s.hostAgent);
  const cursor = await lastSeq(f, s.room);
  await f.db.query('UPDATE room_members SET last_read_seq=$3 WHERE room_id=$1 AND agent_id=$2', [
    s.room.id,
    s.dPerson,
    cursor,
  ]);
  await f.say(s.host, s.room, 'After the cursor', s.hostAgent);
  f.small.push(answer([], []));
  const res = await catchUp(f, s.dana, s.room);
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().from_seq, cursor);
  const content = f.small.requests.at(-1)!.messages[0]!.content as string;
  assert.ok(content.includes('After the cursor') && !content.includes('Before the cursor'));
});

test('catch-up: private messages and other rooms never reach it; the private chat is refused', async (t) => {
  const f = await elricFixture(t);
  const s = await catchUpScene(f);
  const other = await catchUpScene(f, 'Other room');
  const start = await lastSeq(f, s.room);
  await f.say(s.host, s.room, 'Room text for everyone', s.hostAgent);
  await f.say(other.host, other.room, 'OTHER-ROOM-SECRET', other.hostAgent);
  // A private message between the two (the messages table): never read by the catch-up.
  await f.db.query(
    `INSERT INTO messages(recipient_id,seq,id,sender_id,sender_owner_id,recipient_owner_id,
       context_id,parts,created_at)
     VALUES($1,1,$2,$3,$4,$5,$6,$7::jsonb,$8)`,
    [
      s.dPerson,
      randomUUID(),
      s.hostAgent,
      s.host.operatorId,
      s.dana.operatorId,
      randomUUID(),
      JSON.stringify([{ type: 'text', text: 'PRIVATE-DM-SECRET' }]),
      f.now(),
    ],
  );
  f.small.push(answer([], []));
  const res = await catchUp(f, s.dana, s.room, { after_seq: start });
  assert.equal(res.statusCode, 200, res.body);
  const seen = JSON.stringify(f.small.requests);
  assert.ok(seen.includes('Room text for everyone'));
  assert.ok(!seen.includes('PRIVATE-DM-SECRET'), 'no private message');
  assert.ok(!seen.includes('OTHER-ROOM-SECRET'), 'no other room');

  // Dana's private /elric chat is not a shared room: refused like a room that does not exist.
  await f.addElric(s.dana);
  const chat = await f.call(s.dana.cookie, 'GET', '/api/elric/chat');
  assert.equal(chat.statusCode, 200, chat.body);
  const refused = await f.call(
    s.dana.cookie,
    'POST',
    `/api/rooms/${chat.json().room_id}/catch-up`,
    {},
  );
  assert.equal(refused.statusCode, 404, refused.body);
  assert.equal(refused.json().code, 'room_not_found');
});

test('catch-up: eligibility — host Elric on, caller verified adult, a member, kill switch off', async (t) => {
  const f = await elricFixture(t);
  const s = await catchUpScene(f);
  await f.say(s.host, s.room, 'Something happened', s.hostAgent);

  // Not a member: the same 404 as a room that does not exist.
  const outsider = await f.account('Outsider');
  await f.verify(outsider);
  const out = await catchUp(f, outsider, s.room);
  assert.equal(out.statusCode, 404, out.body);
  assert.equal(out.json().code, 'room_not_found');

  // A member without a verified Google identity.
  const lee = await f.account('Lee');
  await f.joinPerson(lee, s.room, 'Lee');
  const unverified = await catchUp(f, lee, s.room);
  assert.equal(unverified.statusCode, 403, unverified.body);
  assert.equal(unverified.json().code, 'elric_not_eligible');

  // The host's Elric paused: off in this room.
  const paused = await f.call(s.host.cookie, 'POST', '/api/elric/pause');
  assert.equal(paused.statusCode, 200, paused.body);
  const off = await catchUp(f, s.dana, s.room);
  assert.equal(off.statusCode, 409, off.body);
  assert.equal(off.json().code, 'elric_catch_up_off');
  await f.call(s.host.cookie, 'POST', '/api/elric/resume');

  // A room whose host has no Elric at all.
  const plainHost = await f.account('Plain host');
  const plainAgent = await f.agent(plainHost, 'Plain desk');
  const plain = await f.room(plainHost, plainAgent, 'Plain room');
  await f.joinPerson(s.dana, plain, 'Dana');
  const none = await catchUp(f, s.dana, plain);
  assert.equal(none.statusCode, 409, none.body);
  assert.equal(none.json().code, 'elric_catch_up_off');

  // The kill switch.
  await f.db.query(
    `INSERT INTO elric_flags(name,enabled,updated_at,updated_by) VALUES('kill',true,$1,'test')
     ON CONFLICT (name) DO UPDATE SET enabled=true`,
    [f.now()],
  );
  const killed = await catchUp(f, s.dana, s.room);
  assert.equal(killed.statusCode, 409, killed.body);
  assert.equal(killed.json().code, 'elric_catch_up_paused');
  assert.equal(f.adapterCalls(), 0, 'no refusal reached the model');
});

test('catch-up: the same range is served from the cache, billed once', async (t) => {
  const f = await elricFixture(t);
  const s = await catchUpScene(f);
  const start = await lastSeq(f, s.room);
  const a = (await f.say(s.host, s.room, 'We go with blue.', s.hostAgent)).message.seq;
  f.small.push(answer([{ text: 'Blue it is', seqs: [a] }]));
  const first = await catchUp(f, s.dana, s.room, { after_seq: start });
  assert.equal(first.statusCode, 200, first.body);
  const spent = (await f.usage(s.dana.operatorId))!;
  const second = await catchUp(f, s.dana, s.room, { after_seq: start });
  assert.equal(second.statusCode, 200, second.body);
  assert.equal(second.json().cached, true);
  assert.deepEqual(second.json().sections, first.json().sections);
  assert.equal(f.adapterCalls(), 1, 'no second model call');
  assert.deepEqual(await f.usage(s.dana.operatorId), spent, 'nothing billed again');

  // Another person's catch-up of the same range is their own (never shared).
  const lee = await f.account('Lee cache');
  await f.verify(lee);
  await f.joinPerson(lee, s.room, 'Lee');
  f.small.push(answer([]));
  const theirs = await catchUp(f, lee, s.room, { after_seq: start, to_seq: a });
  assert.equal(theirs.json().cached, false);
  assert.equal(f.adapterCalls(), 2);

  // A new message is a new range: a new catch-up.
  await f.say(s.host, s.room, 'And green for links.', s.hostAgent);
  f.small.push(answer([]));
  const third = await catchUp(f, s.dana, s.room, { after_seq: start });
  assert.equal(third.json().cached, false);
  assert.equal(f.adapterCalls(), 3);

  // Expired (a day later): written again.
  const expires = await f.db.query<{ expires_at: string; created_at: string }>(
    'SELECT expires_at, created_at FROM elric_catch_ups WHERE owner_id=$1 AND to_seq=$2',
    [s.dana.operatorId, a],
  );
  assert.equal(
    Number(expires.rows[0]!.expires_at) - Number(expires.rows[0]!.created_at),
    24 * 60 * 60_000,
  );
  await f.db.query('UPDATE elric_catch_ups SET expires_at=$2 WHERE owner_id=$1', [
    s.dana.operatorId,
    f.now(),
  ]);
  f.small.push(answer([]));
  const later = await catchUp(f, s.dana, s.room, { after_seq: start, to_seq: a });
  assert.equal(later.statusCode, 200, later.body);
  assert.equal(later.json().cached, false);
});

test('catch-up: a used-up allowance still gives the room-data sections, uncached, unbilled', async (t) => {
  const f = await elricFixture(t, {
    config: { allowance: { ...ELRIC_CONFIG.allowance, summary: 0 } },
  });
  const s = await catchUpScene(f);
  const start = await lastSeq(f, s.room);
  const m = (await f.say(s.host, s.room, '@Dana please check this', s.hostAgent)).message.seq;
  const res = await catchUp(f, s.dana, s.room, { after_seq: start });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json() as CatchUp;
  assert.equal(body.incomplete, 'limit');
  assert.equal(body.notice, 'Summaries used up for today. Resets at 00:00 UTC.');
  assert.ok(body.resets_at);
  assert.equal(body.nothing_important, false);
  assert.deepEqual(body.sections, [
    {
      kind: 'needs_you',
      title: 'Needs you',
      bullets: [{ text: 'Builder mentioned you', seqs: [m] }],
    },
  ]);
  assert.equal(f.adapterCalls(), 0);
  const again = await catchUp(f, s.dana, s.room, { after_seq: start });
  assert.equal(again.json().cached, false, 'an incomplete answer is never cached');
});

test('catch-up: a failed model call refunds the allowance and is not cached', async (t) => {
  const f = await elricFixture(t);
  const s = await catchUpScene(f);
  const start = await lastSeq(f, s.room);
  await f.say(s.host, s.room, 'Let us decide tomorrow.', s.hostAgent);
  f.small.push({ error: 'bad_request' });
  const res = await catchUp(f, s.dana, s.room, { after_seq: start });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().incomplete, 'unavailable');
  assert.equal((await f.usage(s.dana.operatorId))!.summary, 0, 'allowance given back');
  // A transient failure is retried once.
  f.small.push({ error: 'rate_limited' }, answer([]));
  const retried = await catchUp(f, s.dana, s.room, { after_seq: start });
  assert.equal(retried.json().incomplete, undefined, retried.body);
  assert.equal(retried.json().cached, false);
  assert.equal((await f.usage(s.dana.operatorId))!.summary, 1);
});

test('catch-up: non-JSON model output is unavailable, refunded and not cached', async (t) => {
  const lines: string[] = [];
  const f = await elricFixture(t, { log: (line) => lines.push(line) });
  const s = await catchUpScene(f);
  const start = await lastSeq(f, s.room);
  await f.say(s.host, s.room, 'Let us decide tomorrow.', s.hostAgent);
  f.small.push({ text: 'Sure! Nothing much happened while you were away.' });
  const res = await catchUp(f, s.dana, s.room, { after_seq: start });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json() as CatchUp;
  assert.equal(body.incomplete, 'unavailable');
  assert.equal(body.nothing_important, false, 'never reported as nothing important');
  assert.equal((await f.usage(s.dana.operatorId))!.summary, 0, 'allowance given back');
  const global = await f.db.query<{ reserved_units: string }>(
    'SELECT reserved_units FROM elric_global_usage',
  );
  assert.equal(Number(global.rows[0]!.reserved_units), 0, 'reservation released');
  assert.ok(lines.some((line) => line.includes('elric_catch_up_unparseable')));
  const cached = await f.db.query('SELECT 1 FROM elric_catch_ups WHERE owner_id=$1', [
    s.dana.operatorId,
  ]);
  assert.equal(cached.rows.length, 0, 'not cached');
  f.small.push(answer([]));
  const again = await catchUp(f, s.dana, s.room, { after_seq: start });
  assert.equal(again.json().cached, false);
  assert.equal(again.json().nothing_important, true);
});

test('catch-up: a failed settle is retried so the reservation is released', async (t) => {
  const lines: string[] = [];
  const f = await elricFixture(t, { log: (line) => lines.push(line) });
  const s = await catchUpScene(f);
  const start = await lastSeq(f, s.room);
  const a = (await f.say(s.host, s.room, 'We go with blue.', s.hostAgent)).message.seq;
  // The first settle (a release of reserved units) fails once, then the trigger disarms itself.
  // A sequence is not rolled back with the failed transaction.
  await f.db.query('CREATE SEQUENCE settle_fail_once');
  await f.db.query(`CREATE FUNCTION settle_fail_once_fn() RETURNS trigger AS $$
    BEGIN
      IF NEW.reserved_units < OLD.reserved_units AND nextval('settle_fail_once') = 1 THEN
        RAISE EXCEPTION 'settle down';
      END IF;
      RETURN NEW;
    END $$ LANGUAGE plpgsql`);
  await f.db.query(`CREATE TRIGGER settle_fail_once_t BEFORE UPDATE ON elric_global_usage
    FOR EACH ROW EXECUTE FUNCTION settle_fail_once_fn()`);
  f.small.push(answer([{ text: 'Blue it is', seqs: [a] }]));
  const res = await catchUp(f, s.dana, s.room, { after_seq: start });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().incomplete, undefined, res.body);
  assert.ok(lines.some((line) => line.includes('elric_catch_up_settle_failed')));
  const global = await f.db.query<{ reserved_units: string }>(
    'SELECT reserved_units FROM elric_global_usage',
  );
  assert.equal(Number(global.rows[0]!.reserved_units), 0, 'nothing left reserved');
});

test('catch-up: both settle attempts fail: unavailable, not cached, nothing thrown', async (t) => {
  const lines: string[] = [];
  const f = await elricFixture(t, { log: (line) => lines.push(line) });
  const s = await catchUpScene(f);
  const start = await lastSeq(f, s.room);
  const a = (await f.say(s.host, s.room, 'We go with green.', s.hostAgent)).message.seq;
  // Every release of reserved units fails: the settle and its one retry both throw.
  await f.db.query(`CREATE FUNCTION settle_fail_always_fn() RETURNS trigger AS $$
    BEGIN
      IF NEW.reserved_units < OLD.reserved_units THEN
        RAISE EXCEPTION 'settle down';
      END IF;
      RETURN NEW;
    END $$ LANGUAGE plpgsql`);
  await f.db.query(`CREATE TRIGGER settle_fail_always_t BEFORE UPDATE ON elric_global_usage
    FOR EACH ROW EXECUTE FUNCTION settle_fail_always_fn()`);
  f.small.push(answer([{ text: 'Green it is', seqs: [a] }]));
  const res = await catchUp(f, s.dana, s.room, { after_seq: start });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json() as CatchUp;
  assert.equal(body.incomplete, 'unavailable');
  assert.equal(body.cached, false);
  assert.ok(!JSON.stringify(body).includes('Green it is'), 'the unsettled answer is not shown');
  assert.ok(lines.some((line) => line.includes('"attempt":1') && line.includes('settle_failed')));
  assert.ok(lines.some((line) => line.includes('"attempt":2') && line.includes('settle_failed')));
  const cached = await f.db.query('SELECT 1 FROM elric_catch_ups WHERE owner_id=$1', [
    s.dana.operatorId,
  ]);
  assert.equal(cached.rows.length, 0, 'not cached');
});

test('catch-up: a small per-caller rate limit', async (t) => {
  const f = await elricFixture(t);
  const s = await catchUpScene(f);
  const codes: number[] = [];
  for (let i = 0; i < 7; i++) codes.push((await catchUp(f, s.dana, s.room)).statusCode);
  assert.deepEqual(codes, [200, 200, 200, 200, 200, 200, 429]);
});

test('catch-up: at most 300 messages are read, the newest', async (t) => {
  const f = await elricFixture(t);
  const s = await catchUpScene(f);
  const start = await lastSeq(f, s.room);
  const total = CATCH_UP_MAX_MESSAGES + 5;
  await f.db.query(
    `INSERT INTO room_messages(room_id,seq,id,sender_agent_id,sender_owner_id,sender_name,
       sender_owner_label,parts,created_at)
     SELECT $1, $2 + g, gen_random_uuid(), $3, $4, 'Builder', 'Host',
            jsonb_build_array(jsonb_build_object('type','text','text','note ' || g)), $5
       FROM generate_series(1, $6::int) g`,
    [s.room.id, start, s.hostAgent, s.host.operatorId, f.now(), total],
  );
  await f.db.query('UPDATE rooms SET next_seq=$2 WHERE id=$1', [s.room.id, start + total + 1]);
  f.small.push(answer([]));
  const res = await catchUp(f, s.dana, s.room, { after_seq: start });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().truncated, true);
  assert.equal(res.json().to_seq, start + total);
  assert.equal(res.json().from_seq, start + total - CATCH_UP_MAX_MESSAGES);
  const content = f.small.requests.at(-1)!.messages[0]!.content as string;
  assert.ok(content.includes('"note 305"') && !content.includes('"note 5"'));
});
