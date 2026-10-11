import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentActivityItem } from '../shared/types';
import {
  ACTIVITY_PAGE,
  NO_NAMES,
  activityNames,
  activityPath,
  activityRow,
  activityTime,
  agentCardPath,
  appendPage,
  clock,
  createdLabel,
  dayLabel,
  dayOf,
  developerView,
  groupByDay,
  mergeItems,
  nameIds,
  refreshFeed,
  shortAgentId,
  withAgent,
  type DeveloperAgent,
} from '../src/agents/v4/activityDeveloperModel';

/* My agents v4: the pure rules behind the agent pane's Activity and Developer details screens. */

const AGENT = '3261ccd0-5a1b-4c2d-8e3f-9a0b1c2aa77c';
const COURIER = '22222222-2222-4222-8222-222222222222';
const now = new Date(2026, 9, 10, 8, 10).getTime();
const local = (day: number, hours: number, minutes: number) =>
  new Date(2026, 9, day, hours, minutes).toISOString();

function event(id: string, at: string, text = 'Winry joined “Q4 review”.'): AgentActivityItem {
  return { kind: 'event', id, at, type: 'room.joined', text, jobId: null };
}
function run(
  id: string,
  at: string,
  over: Partial<Extract<AgentActivityItem, { kind: 'run' }>> = {},
): AgentActivityItem {
  return {
    kind: 'run',
    id,
    at,
    updatedAt: at,
    completedAt: null,
    status: 'running',
    capability: 'research',
    role: 'provider',
    counterpart: { id: COURIER, name: 'Courier' },
    error: null,
    ...over,
  };
}

test('activityPath asks for one page, older pages with the cursor', () => {
  assert.equal(activityPath(AGENT), `/api/agents/${AGENT}/activity?limit=${ACTIVITY_PAGE}`);
  assert.equal(
    activityPath(AGENT, 'WzE3LCJydW46YSJd'),
    `/api/agents/${AGENT}/activity?limit=${ACTIVITY_PAGE}&before=WzE3LCJydW46YSJd`,
  );
  assert.ok(activityPath('a/b').startsWith('/api/agents/a%2Fb/activity'));
});

test('activityTime uses the mockup words: now, minutes, hours, then the clock', () => {
  const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
  assert.equal(activityTime(ago(0), now), 'now');
  assert.equal(activityTime(ago(-2), now), 'now');
  assert.equal(activityTime(ago(4), now), '4 min');
  assert.equal(activityTime(ago(60), now), '1 h');
  assert.equal(activityTime(ago(150), now), '2 h');
  assert.equal(activityTime(local(10, 7, 38), new Date(2026, 9, 10, 11, 0).getTime()), '07:38');
  assert.equal(activityTime(local(9, 18, 20), now), '18:20');
  assert.equal(activityTime('nope', now), '');
  assert.equal(clock(local(10, 7, 5)), '07:05');
});

test('dayLabel: Today, Yesterday, then the date (with the year when not this year)', () => {
  assert.equal(dayLabel(dayOf(local(10, 0, 1)), now), 'Today');
  assert.equal(dayLabel(dayOf(local(9, 23, 59)), now), 'Yesterday');
  assert.equal(dayLabel(dayOf(local(8, 12, 0)), now, 'en-US'), 'Oct 8');
  assert.equal(
    dayLabel(dayOf(new Date(2025, 11, 31, 12).toISOString()), now, 'en-US'),
    'Dec 31, 2025',
  );
  assert.equal(dayLabel(Number.NaN, now), '');
});

test('activityRow: events say the server sentence, runs get a status pill', () => {
  assert.deepEqual(
    activityRow(event('e1', local(10, 7, 38), 'Registered on Base as agent #99029.')),
    {
      key: 'event:e1',
      at: local(10, 7, 38),
      title: 'Registered on Base as agent #99029.',
      status: null,
    },
  );
  const done = activityRow(run('j1', local(10, 8, 6), { status: 'done' }));
  assert.equal(done.key, 'run:j1');
  assert.equal(done.title, 'Run: research for Courier');
  assert.deepEqual(done.status, { tone: 'ok', label: 'Done' });
  assert.deepEqual(activityRow(run('j2', local(10, 8, 6))).status, {
    tone: 'warn',
    label: 'Running',
  });
  const asked = activityRow(
    run('j3', local(9, 18, 20), { status: 'failed', capability: 'extract', role: 'requester' }),
  );
  assert.equal(asked.title, 'Run: extract by Courier');
  assert.deepEqual(asked.status, { tone: 'bad', label: 'Failed' });
  // A requester in another workspace is not named.
  assert.equal(
    activityRow(run('j4', local(10, 8, 0), { counterpart: { id: COURIER, name: null } })).title,
    'Run: research',
  );
});

test('groupByDay keeps the order and splits at local midnight', () => {
  const days = groupByDay(
    [
      run('j1', local(10, 8, 6), { status: 'done' }),
      event('e1', local(10, 7, 38)),
      run('j2', local(9, 18, 20), { status: 'failed' }),
      event('e2', local(7, 9, 0)),
    ],
    now,
    'en-US',
  );
  assert.deepEqual(
    days.map((day) => [day.label, day.rows.map((row) => row.key)]),
    [
      ['Today', ['run:j1', 'event:e1']],
      ['Yesterday', ['run:j2']],
      ['Oct 7', ['event:e2']],
    ],
  );
  assert.deepEqual(groupByDay([], now), []);
});

/* ---------- names for the IDs in event lines ---------- */

const OTHER = 'e9764f84-3b1a-4c2e-9d7f-1a2b3c4d5e6f';
const GONE_ROOM = '89c1fa37-5d2e-4f1a-8b3c-6d7e8f9a0b1c';
const ROOM = 'aaaaaaa1-0000-4000-8000-000000000001';
const HELPER = '44444444-4444-4444-8444-444444444444';
const JOB = 'cccccccc-0000-4000-8000-00000000000c';
const names = activityNames(
  [
    { id: AGENT, name: 'Research scout' },
    { id: HELPER, name: 'Scout helper' },
  ],
  [{ id: ROOM, name: 'Q4 review' }],
);
/** The owner's agents could not be read: nobody is known to be another owner's. */
const roomsOnly = activityNames(null, [{ id: ROOM, name: 'Q4 review' }]);

test('nameIds: the production lines read with names, or "an agent of another owner" / "a room"', () => {
  const joined = `Agent ${OTHER} of another owner joined your room ${ROOM} with its invite link.`;
  assert.equal(
    nameIds(joined, names),
    'An agent of another owner joined your room Q4 review with its invite link.',
  );
  // A room the owner does not see: the ID goes, "your room" stays.
  assert.equal(
    nameIds(`Agent ${OTHER} of another owner joined your room ${GONE_ROOM} with its invite link.`),
    'An agent of another owner joined your room with its invite link.',
  );
  // A deleted room is in no list any more.
  assert.equal(
    nameIds(
      `Room ${GONE_ROOM} deleted by the owner: its messages, tasks and files are erased and every link is revoked.`,
      names,
    ),
    'A room deleted by the owner: its messages, tasks and files are erased and every link is revoked.',
  );
  assert.equal(
    nameIds(`Room ${ROOM} deleted by the owner: its messages are erased.`, names),
    'Room Q4 review deleted by the owner: its messages are erased.',
  );
});

test('nameIds: start and middle of a sentence keep sentence case', () => {
  // Start: the owner's agent by name, another's as "An agent of another owner".
  assert.equal(
    nameIds(`Agent ${HELPER} removed from room ${ROOM} by the owner.`, names),
    'Scout helper removed from room Q4 review by the owner.',
  );
  assert.equal(
    nameIds(`Agent ${OTHER} removed from room ${GONE_ROOM} by the owner.`, names),
    'An agent of another owner removed from a room by the owner.',
  );
  // Middle: lower case.
  assert.equal(
    nameIds(
      `Research scout requested a cross-owner connection to agent ${OTHER} (by the owner).`,
      names,
    ),
    'Research scout requested a cross-owner connection to an agent of another owner (by the owner).',
  );
  assert.equal(
    nameIds(
      `Research scout joined room ${GONE_ROOM} (by the owner). Room messages are untrusted input.`,
      names,
    ),
    'Research scout joined a room (by the owner). Room messages are untrusted input.',
  );
  assert.equal(
    nameIds(`Invite link of room ${ROOM} rotated by the owner.`, names),
    'Invite link of room Q4 review rotated by the owner.',
  );
  // After a determiner only the ID changes; "your agent" is never another owner's.
  assert.equal(
    nameIds(`The host removed your agent ${OTHER} from room ${ROOM}.`, names),
    'The host removed your agent from room Q4 review.',
  );
  assert.equal(
    nameIds(`The host removed your agent ${HELPER} from the room ${GONE_ROOM}.`, names),
    'The host removed your agent Scout helper from the room.',
  );
  // A sentence after a period starts again.
  assert.equal(
    nameIds(`Done. Room ${GONE_ROOM} closed. ${JOB} failed.`, names),
    'Done. A room closed. An item failed.',
  );
});

test('nameIds: several IDs, upper case, unknown owners and other IDs', () => {
  assert.equal(
    nameIds(
      `Agent ${HELPER} and agent ${OTHER} joined room ${ROOM}; agent ${AGENT.toUpperCase()} left room ${GONE_ROOM}.`,
      names,
    ),
    'Scout helper and an agent of another owner joined room Q4 review; Research scout left a room.',
  );
  // Without the owner's agents nobody is called another owner's, and the server's own words stay once.
  assert.equal(
    nameIds(`Agent ${HELPER} removed from room ${ROOM}.`, roomsOnly),
    'An agent removed from room Q4 review.',
  );
  assert.equal(
    nameIds(
      `Agent ${OTHER} of another owner joined your room ${ROOM} with its invite link.`,
      roomsOnly,
    ),
    'An agent of another owner joined your room Q4 review with its invite link.',
  );
  // Other IDs: a parenthesis that only holds one goes; after a noun the noun stays; else "an item".
  assert.equal(
    nameIds(
      `The owner requested research for Research scout from an agent in another workspace (job ${JOB}).`,
      names,
    ),
    'The owner requested research for Research scout from an agent in another workspace.',
  );
  assert.equal(
    nameIds(`Result ${JOB} unpublished by the owner; its content was erased.`, names),
    'Result unpublished by the owner; its content was erased.',
  );
  assert.equal(nameIds(`Shared with ${JOB}.`, names), 'Shared with an item.');
  // Text without an ID is the server's own sentence.
  for (const text of ['Registered on Base as agent #99029.', 'Winry joined “Q4 review”.', ''])
    assert.equal(nameIds(text, names), text);
});

test('nameIds: names go in as written', () => {
  const odd = activityNames([{ id: HELPER, name: `$& $1 ${OTHER}` }], [{ id: ROOM, name: '  ' }]);
  assert.equal(
    nameIds(`Agent ${HELPER} joined room ${ROOM}.`, odd),
    `$& $1 ${OTHER} joined a room.`,
  );
});

test('activityNames and withAgent: only the owner’s names; the screen’s own agent always', () => {
  const read = activityNames([{ id: AGENT.toUpperCase(), name: ' Scout ' }], null);
  assert.equal(read.agents.get(AGENT), 'Scout');
  assert.equal(read.rooms.size, 0);
  assert.equal(read.ownerAgents, true);
  assert.equal(NO_NAMES.ownerAgents, false);
  const own = withAgent(NO_NAMES, { id: HELPER, name: 'Scout helper' });
  assert.equal(own.agents.get(HELPER), 'Scout helper');
  assert.equal(NO_NAMES.agents.size, 0, 'the shared empty names stay empty');
  assert.equal(nameIds(`Agent ${HELPER} went offline.`, own), 'Scout helper went offline.');
});

test('activityRow and groupByDay put names in event lines', () => {
  const line = event(
    'e1',
    local(10, 7, 38),
    `Agent ${OTHER} of another owner joined your room ${ROOM} with its invite link.`,
  );
  assert.equal(
    activityRow(line, names).title,
    'An agent of another owner joined your room Q4 review with its invite link.',
  );
  assert.equal(
    activityRow(line).title,
    'An agent of another owner joined your room with its invite link.',
  );
  assert.equal(
    groupByDay([line], now, 'en-US', names)[0]!.rows[0]!.title,
    'An agent of another owner joined your room Q4 review with its invite link.',
  );
});

test('mergeItems: one line per item, the fresh copy wins, newest first', () => {
  const merged = mergeItems(
    [run('j1', local(10, 8, 0)), event('e1', local(10, 7, 0))],
    [run('j1', local(10, 8, 0), { status: 'done' }), event('e2', local(10, 8, 5))],
  );
  assert.deepEqual(
    merged.map((item) => item.id),
    ['e2', 'j1', 'e1'],
  );
  assert.equal(merged[1]!.kind === 'run' && merged[1]!.status, 'done');
  // Equal times: the server's tie-break (key, descending).
  const tie = mergeItems([event('a', local(10, 8, 0))], [run('a', local(10, 8, 0))]);
  assert.deepEqual(
    tie.map((item) => item.kind),
    ['run', 'event'],
  );
});

test('refreshFeed keeps older pages and their cursor; appendPage moves the cursor on', () => {
  const first = refreshFeed(null, { items: [event('e3', local(10, 8, 0))], nextBefore: 'c1' });
  assert.equal(first.nextBefore, 'c1');
  const more = appendPage(first, { items: [event('e2', local(9, 8, 0))], nextBefore: 'c2' });
  assert.deepEqual(
    more.items.map((item) => item.id),
    ['e3', 'e2'],
  );
  assert.equal(more.nextBefore, 'c2');
  const polled = refreshFeed(more, {
    items: [event('e4', local(10, 8, 5)), event('e3', local(10, 8, 0))],
    nextBefore: 'c1',
  });
  assert.deepEqual(
    polled.items.map((item) => item.id),
    ['e4', 'e3', 'e2'],
  );
  assert.equal(polled.nextBefore, 'c2');
  const last = appendPage(polled, { items: [], nextBefore: null });
  assert.equal(last.nextBefore, null);
});

function devAgent(over: Partial<DeveloperAgent> = {}): DeveloperAgent {
  return {
    id: AGENT,
    capability: 'research',
    mode: 'external',
    createdAt: local(10, 7, 19),
    revokedAt: null,
    manifestName: 'winry-70845c',
    revision: 1,
    credentialHint: '…a91f',
    ...over,
  };
}

test('shortAgentId shortens like the mockup and leaves short ids alone', () => {
  assert.equal(shortAgentId(AGENT), '3261ccd0…aa77c');
  assert.equal(shortAgentId('elric'), 'elric');
});

test('createdLabel: month, day and the 24-hour clock', () => {
  assert.equal(createdLabel(local(10, 7, 19), 'en-US'), 'Oct 10, 07:19');
  assert.equal(createdLabel('nope'), '');
});

test('developerView shows only what the server has', () => {
  const view = developerView(devAgent(), 'en-US');
  assert.deepEqual(view, {
    id: AGENT,
    shortId: '3261ccd0…aa77c',
    does: 'Research',
    template: 'winry-70845c · v1',
    created: 'Oct 10, 07:19',
    createdBy: 'You',
    createdUnder: null,
    about: null,
    cardPath: agentCardPath(AGENT),
    key: '…a91f',
    canRotate: true,
  });
  assert.equal(agentCardPath(AGENT), `/a2a/${AGENT}/.well-known/agent-card.json`);
  assert.equal(developerView(devAgent({ revision: 3 })).template, 'winry-70845c · v3');
  assert.equal(developerView(devAgent({ capability: 'extract' })).does, 'Extract');
  assert.equal(developerView(devAgent({ capability: 'verify' })).does, 'Verify');

  // No manifest: no template and no Agent Card.
  const plain = developerView(devAgent({ manifestName: undefined, revision: undefined }));
  assert.equal(plain.template, null);
  assert.equal(plain.cardPath, null);
  // Hosted agents have no key to show or rotate.
  const hosted = developerView(devAgent({ mode: 'hosted', credentialHint: null }));
  assert.equal(hosted.key, null);
  assert.equal(hosted.canRotate, false);
  // A key issued before hints were kept: Rotate key still, no masked key.
  const noHint = developerView(devAgent({ credentialHint: undefined }));
  assert.equal(noHint.key, null);
  assert.equal(noHint.canRotate, true);
  // Revoked: no card, no rotation.
  const revoked = developerView(devAgent({ revokedAt: local(10, 8, 0) }));
  assert.equal(revoked.cardPath, null);
  assert.equal(revoked.canRotate, false);
});

test('developerView says who created the agent, under which agent, and what was written about it', () => {
  const by = (createdBy: DeveloperAgent['createdBy'], over: Partial<DeveloperAgent> = {}) =>
    developerView(devAgent({ createdBy, ...over })).createdBy;
  assert.equal(by(undefined), 'You');
  assert.equal(by({ kind: 'owner' }), 'You');
  assert.equal(by({ kind: 'assistant' }), 'Your AI');
  assert.equal(by({ kind: 'oauth-client' }), 'A connected AI app');
  assert.equal(by({ kind: 'workspace-key' }), 'An AI in this workspace');
  assert.equal(by({ kind: 'anonymous-client' }), 'An AI app');
  assert.equal(by({ kind: 'agent' }), 'An agent');
  assert.equal(
    by({ kind: 'anonymous-client' }, { claimedAt: local(10, 8, 0) }),
    'An AI app · claimed',
  );
  // Created under another agent: who made it, and the parent by name (removing it removes this).
  const PARENT = '0b5e7a11-0000-4000-8000-00000000c0de';
  const names = (id: string) => (id === PARENT ? 'Harbor Lead' : undefined);
  const child = developerView(
    devAgent({ parentAgentId: PARENT, createdBy: { kind: 'assistant' } }),
    'en-US',
    names,
  );
  assert.equal(child.createdBy, 'Your AI');
  assert.equal(child.createdUnder, 'Harbor Lead');
  const orphan = developerView(devAgent({ parentAgentId: PARENT }));
  assert.equal(orphan.createdUnder, 'another agent');
  // About: only real text, never filler.
  assert.equal(
    developerView(devAgent({ description: '  Reads filings.  ' })).about,
    'Reads filings.',
  );
  assert.equal(developerView(devAgent({ description: '   ' })).about, null);
  assert.equal(developerView(devAgent({ description: '' })).about, null);
});
