import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import type { Member, MemberSays } from '../src/rooms/api.js';
import type { RoomTask } from '../src/rooms/tasks.js';

// The panel imports stylesheets through its dependencies (Vite bundles them); empty under Node.
registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true };
    return nextLoad(url, context);
  },
});
const {
  activeAis,
  activityLine,
  claimedTask,
  compactCount,
  headerCounts,
  metaLine,
  needsYouLabel,
  needsYouText,
  parseNeedsYou,
  parseOverview,
  roomPillLabel,
  saysText,
  serverHasSays,
  taskSummary,
} = await import('../src/rooms/headerCountsV2.js');
const { MemberSaysLine } = await import('../src/rooms/MemberSays.js');
const { createElement } = await import('react');
const { renderToStaticMarkup } = await import('react-dom/server');

const NOW = Date.parse('2026-10-03T12:00:00.000Z');
const minutesAgo = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

function member(overrides: Partial<Member> = {}): Member {
  return {
    id: overrides.id ?? `a-${Math.random().toString(36).slice(2, 8)}`,
    name: 'Scout',
    kind: 'agent',
    role: 'member',
    owner_label: 'Ana',
    own: false,
    joined_at: minutesAgo(600),
    ...overrides,
  };
}
function task(overrides: Partial<RoomTask>): RoomTask {
  return {
    id: overrides.id ?? `t-${Math.random().toString(36).slice(2, 8)}`,
    number: 1,
    title: 'Task',
    body: null,
    status: 'open',
    created_by_agent_id: 'host',
    claim: null,
    result: null,
    created_at: minutesAgo(100),
    updated_at: minutesAgo(10),
    ...overrides,
  };
}
const overview = {
  room_id: 'r1',
  members: { total: 10_500, people: 10_480, ais: 20, ais_active_15m: 6 },
  tasks: { open: 3, claimed: 3, in_review: 1, done: 2 },
  unread: { messages: null, mentions: 0, mentions_capped: false },
  latest_seq: 12,
  as_of: '2026-10-03T12:00:00.000Z',
};

test('compact counts round down and never overstate', () => {
  assert.equal(compactCount(0), '0');
  assert.equal(compactCount(7), '7');
  assert.equal(compactCount(999), '999');
  assert.equal(compactCount(1000), '1k');
  assert.equal(compactCount(1250), '1.2k');
  assert.equal(compactCount(10_500), '10.5k');
  assert.equal(compactCount(10_599), '10.5k');
  assert.equal(compactCount(99_999), '99.9k');
  assert.equal(compactCount(250_400), '250k');
  assert.equal(compactCount(999_999), '999k');
  assert.equal(compactCount(1_000_000), '1M');
  assert.equal(compactCount(1_350_000), '1.3M');
  assert.equal(compactCount(-3), '0');
  assert.equal(compactCount(Number.NaN), '0');
});

test('the meta line and the room pill (it opens Members) say what they count, singular and plural', () => {
  const counts = { members: 10_500, aisActive: 6, aisInRoom: 20, openTasks: 3 };
  assert.equal(metaLine(counts), '10.5k members · 6 AIs active now (20 in room)');
  assert.equal(
    roomPillLabel('Design', 10_500, 6),
    'Members of Design: 10.5k members, 6 AIs active',
  );
  const one = { members: 1, aisActive: 1, aisInRoom: 1, openTasks: 1 };
  assert.equal(metaLine(one), '1 member · 1 AI active now (1 in room)');
  assert.equal(roomPillLabel('Design', 1, 1), 'Members of Design: 1 member, 1 AI active');
  assert.equal(roomPillLabel('Design', 3, 0), 'Members of Design: 3 members, 0 AIs active');
  // Unknown parts are left out, never shown as 0.
  assert.equal(
    metaLine({ members: 4, aisActive: 0, aisInRoom: null, openTasks: null }),
    '4 members · 0 AIs active now',
  );
  assert.equal(roomPillLabel('Design', 4, null), 'Members of Design: 4 members');
});

test('parseOverview: the real shape passes; anything else is "no overview"', () => {
  assert.deepEqual(parseOverview(overview), overview);
  // Older servers / non-JSON / wrong shapes: null, so the header falls back.
  assert.equal(parseOverview(null), null);
  assert.equal(parseOverview('<!doctype html>'), null);
  assert.equal(parseOverview({}), null);
  assert.equal(parseOverview({ members: { total: 3 } }), null);
  assert.equal(parseOverview({ members: { total: '3', ais: 1, ais_active_15m: 0 } }), null);
  // Tasks off (null) or malformed: tasks null, counts kept.
  const off = parseOverview({ ...overview, tasks: null });
  assert.equal(off?.tasks, null);
  assert.equal(off?.members.total, 10_500);
  assert.equal(parseOverview({ ...overview, tasks: { open: 1 } })?.tasks, null);
  // A missing unread block does not invent numbers.
  const bare = parseOverview({ members: overview.members });
  assert.deepEqual(bare?.unread, { messages: null, mentions: 0, mentions_capped: false });
});

test('headerCounts: the overview first, else the member list, else nothing', () => {
  const tasks = [task({ status: 'open' }), task({ status: 'claimed' }), task({ status: 'done' })];
  assert.deepEqual(headerCounts({ overview, memberCount: 2, members: [], tasks: null, now: NOW }), {
    members: 10_500,
    aisActive: 6,
    aisInRoom: 20,
    openTasks: 3,
  });
  // Without the overview: the room's member_count and the list it already has.
  const members = [
    member({ kind: 'person', role: 'host', own: true }),
    member({ last_active_at: minutesAgo(3) }),
    member({ status: 'active', last_active_at: null }),
    member({ status: 'idle', last_active_at: null }),
    member({ last_active_at: minutesAgo(16) }),
  ];
  assert.deepEqual(headerCounts({ overview: null, memberCount: 5, members, tasks, now: NOW }), {
    members: 5,
    aisActive: 2,
    aisInRoom: 4,
    openTasks: 1,
  });
  assert.equal(
    headerCounts({ overview: null, memberCount: 5, members, tasks: null, now: NOW })?.openTasks,
    null,
  );
  // Nothing loaded yet: no counts at all (the header hides them).
  assert.equal(headerCounts({ overview: null, memberCount: 5, members: null, tasks }), null);
  // Overview with tasks off but the list loaded: the list's open count.
  assert.equal(
    headerCounts({ overview: { ...overview, tasks: null }, memberCount: 1, members, tasks })
      ?.openTasks,
    1,
  );
});

test('active AIs: 15-minute window from last_active_at, else the server status; people never', () => {
  const recent = member({ id: 'recent', last_active_at: minutesAgo(1) });
  const older = member({ id: 'older', last_active_at: minutesAgo(12) });
  const statusOnly = member({ id: 'status', status: 'active', last_active_at: null });
  const stale = member({ id: 'stale', last_active_at: minutesAgo(15), status: 'active' });
  const person = member({ id: 'person', kind: 'person', status: 'active' });
  assert.deepEqual(
    activeAis([older, statusOnly, person, stale, recent], NOW).map((m) => m.id),
    ['recent', 'older', 'status'],
  );
  assert.equal(
    activityLine({ ...recent, messages_today: 12 }, NOW),
    'active 1 min ago · 12 msgs today',
  );
  assert.equal(
    activityLine({ ...recent, messages_today: 1 }, NOW),
    'active 1 min ago · 1 msg today',
  );
  assert.equal(activityLine({ ...statusOnly, messages_today: null }, NOW), 'active now');
  assert.equal(activityLine(member({ last_active_at: minutesAgo(0) }), NOW), 'active just now');
});

test('active now: one rule for the badge and the list (Elric, host agent, online, idle, departed)', () => {
  // The server's active_now (members) and ais_active_now (overview) come from one rule. A
  // connected AI whose list snapshot shows an older time still reads "Active now".
  const elric = member({
    id: 'elric',
    name: 'Elric',
    auto_reply: { provider: 'elric' },
    active_now: true,
    status: 'active',
    last_active_at: minutesAgo(1),
  });
  const hostAgent = member({
    id: 'host',
    role: 'host',
    own: true,
    active_now: true,
    status: 'active',
    last_active_at: minutesAgo(10),
  });
  const online = member({
    id: 'online',
    active_now: true,
    status: 'active',
    last_active_at: minutesAgo(10),
  });
  // Inside the old 15-minute window, but not active now: not listed, not counted.
  const idle = member({
    id: 'idle',
    active_now: false,
    status: 'idle',
    last_active_at: minutesAgo(10),
  });
  const viewer = member({ id: 'me', kind: 'person', role: 'host', own: true, status: 'active' });
  // A departed AI is not in the list at all (the server leaves it out of both).
  const members = [viewer, elric, hostAgent, online, idle];
  const shown = activeAis(members, NOW);
  assert.deepEqual(shown.map((m) => m.id).sort(), ['elric', 'host', 'online']);
  for (const m of shown) assert.match(activityLine(m, NOW), /^Active now\b/);
  assert.equal(activityLine(idle, NOW), 'active 10 min ago');

  const withNow = { ...overview, members: { ...overview.members, ais_active_now: 3 } };
  const counts = headerCounts({
    overview: withNow,
    memberCount: 5,
    members,
    tasks: null,
    now: NOW,
  });
  assert.equal(counts?.aisActive, shown.length);
  // The overview's ais_active_now wins over the older 15-minute count.
  assert.equal(parseOverview(withNow)?.members.ais_active_now, 3);
  // While the panel keeps the full list current, the badge counts the list itself.
  const stale = { ...overview, members: { ...overview.members, ais_active_now: 9 } };
  assert.equal(
    headerCounts({
      overview: stale,
      memberCount: 5,
      members,
      tasks: null,
      now: NOW,
      listCurrent: true,
    })?.aisActive,
    shown.length,
  );
});

test('task summary and claimed task come from real task data only', () => {
  assert.deepEqual(taskSummary(overview, null), { inProgress: 3, inReview: 1, done: 2 });
  const tasks = [
    task({ status: 'claimed', claim: { agent_id: 'x', expires_at: minutesAgo(-30) }, number: 3 }),
    task({ status: 'in_review' }),
    task({ status: 'done' }),
    task({ status: 'done' }),
    task({ status: 'cancelled' }),
  ];
  assert.deepEqual(taskSummary(null, tasks), { inProgress: 1, inReview: 1, done: 2 });
  assert.equal(taskSummary(null, null), null);
  assert.equal(taskSummary({ ...overview, tasks: null }, null), null);
  assert.equal(claimedTask(member({ id: 'x' }), tasks)?.number, 3);
  assert.equal(claimedTask(member({ id: 'y' }), tasks), null);
  assert.equal(claimedTask(member({ id: 'x' }), null), null);
});

test('parseNeedsYou keeps known kinds; an older server is null; labels count honestly', () => {
  assert.equal(parseNeedsYou(null), null);
  assert.equal(parseNeedsYou({ error: 'x' }), null);
  const page = parseNeedsYou({
    room_id: 'r1',
    items: [
      {
        kind: 'task_to_review',
        id: 't1',
        since: minutesAgo(5),
        task: { id: 't1', number: 4, title: 'Fix header', status: 'in_review' },
      },
      {
        kind: 'mention',
        id: 'a:9',
        since: minutesAgo(2),
        message_seq: 9,
        from_name: 'Scout',
        excerpt: '<b>hi</b>',
      },
      { kind: 'surprise', id: 'z', since: minutesAgo(1) },
      { kind: 'mention', since: minutesAgo(1) },
    ],
    next_cursor: 'abc',
  });
  assert.equal(page?.items.length, 2);
  assert.equal(page?.more, true);
  assert.equal(needsYouLabel(2, false), 'Needs you (2)');
  assert.equal(needsYouLabel(50, true), 'Needs you (50+)');
  // The real number up to 99, then 99+.
  assert.equal(needsYouLabel(99, false), 'Needs you (99)');
  assert.equal(needsYouLabel(100, false), 'Needs you (99+)');
  assert.equal(needsYouLabel(100, true), 'Needs you (99+)');
  assert.equal(needsYouText(page!.items[0]!), 'Review T4: Fix header');
  assert.equal(needsYouText(page!.items[1]!), 'Scout mentioned you: "<b>hi</b>"');
});

test('says: plain text only, cleaned, expired hidden', () => {
  const says = (text: string, expiresInMin = 20): MemberSays => ({
    text,
    eta: null,
    set_at: minutesAgo(1),
    expires_at: minutesAgo(-expiresInMin),
    self_reported: true,
  });
  assert.equal(saysText(says('running test harness'), NOW), 'running test harness');
  assert.equal(saysText(says('  two\n\nlines‮  '), NOW), 'two lines');
  assert.equal(saysText(says('zero​width'), NOW), 'zero width');
  assert.equal(saysText(says('done', -1), NOW), null);
  assert.equal(saysText(says('   '), NOW), null);
  assert.equal(saysText(null, NOW), null);
  assert.equal(saysText(undefined, NOW), null);
  assert.equal(saysText(says('x'.repeat(200)), NOW)?.length, 120);

  // The rows render it as a text node: markup is escaped and nothing becomes a link.
  const html = renderToStaticMarkup(
    createElement(MemberSaysLine, {
      text: '<img src=x onerror=alert(1)> see https://evil.example and <a href="x">me</a>',
    }),
  );
  assert.match(html, /says:/);
  assert.match(html, /“&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(html, /<img|<a[ >]/);
  assert.match(html, /https:\/\/evil\.example/);
});

test('the bulk mute shows only when the server sends says on members', () => {
  assert.equal(serverHasSays([member()]), false);
  assert.equal(serverHasSays([member({ says: null })]), true);
});
