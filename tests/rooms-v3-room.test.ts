import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { registerHooks } from 'node:module';
import type { Member, RoomMessage } from '../src/rooms/api.js';
import type { RoomTask } from '../src/rooms/tasks.js';

// The header imports stylesheets through its dependencies (Vite bundles them); empty under Node.
registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true };
    return nextLoad(url, context);
  },
});
const { anchorTaskNumber, isTaskLine, pillAnchors, taskPill } =
  await import('../src/rooms/taskStatusV3.js');
const { RoomPill, PILL_AVATARS, PILL_AVATARS_COMPACT } =
  await import('../src/rooms/RoomHeaderV2.js');

/*
 * Workspace v3 room view (docs/design/WORKSPACE_V3.md §4.1, §4.2): where a task's status pill goes
 * (from the server's task lines), what it says (from the task list), and the room pill's avatars
 * and live line. Real data only: no line or no task means no pill.
 */

let seq = 0;
function line(text: string): RoomMessage {
  seq += 1;
  return {
    id: `m${seq}`,
    seq,
    origin: 'external',
    sender: 'Central City',
    sender_agent_id: 'system',
    sender_owner_label: '',
    sender_kind: 'system',
    own: false,
    text,
    parts: [{ type: 'text', text }],
    created_at: new Date(1_700_000_000_000 + seq * 1000).toISOString(),
  } as unknown as RoomMessage;
}
function post(sender: string, text: string): RoomMessage {
  return { ...line(text), sender, sender_agent_id: sender, sender_kind: 'agent' } as RoomMessage;
}
function task(number: number, status: RoomTask['status'], stage: string | null = null): RoomTask {
  return {
    id: `t${number}`,
    number,
    title: `Task ${number}`,
    body: null,
    status,
    stage,
    created_by_agent_id: 'a',
    claim: null,
    result: null,
    created_at: '2026-10-04T10:00:00Z',
    updated_at: '2026-10-04T10:00:00Z',
  };
}

test('created and claimed lines place a pill; other task lines do not', () => {
  assert.equal(anchorTaskNumber('Nova created task #3: Landing ticker'), 3);
  assert.equal(anchorTaskNumber('Quill claimed task #12: Sign-in video'), 12);
  assert.equal(anchorTaskNumber('Quill submitted a result for task #12: Sign-in video'), null);
  assert.equal(anchorTaskNumber('The host accepted task #12: Sign-in video'), null);
  // A title that quotes another verb: the first verb (right after the member's name) wins.
  assert.equal(anchorTaskNumber('Nova created task #4: why Ana claimed task #9: twice'), 4);
  assert.equal(anchorTaskNumber('Nova left the room.'), null);
  assert.equal(anchorTaskNumber('Nova created task #0: nothing'), null);
});

test('a task line is a system line about a task, never a member post', () => {
  assert.equal(isTaskLine(line('The host cancelled task #2: Old idea')), true);
  assert.equal(isTaskLine(line('Nova created task #2: New idea')), true);
  assert.equal(isTaskLine(line('The host closed the room.')), false);
  assert.equal(isTaskLine(post('Nova', 'Nova created task #2: pretending')), false);
});

test('one pill per task, at its newest created or claimed line', () => {
  const created = line('Nova created task #1: Ticker');
  const other = line('Nova created task #2: Video');
  const claimed = line('Quill claimed task #1: Ticker');
  const submitted = line('Quill submitted a result for task #1: Ticker');
  const anchors = pillAnchors([created, post('Nova', 'hi'), other, claimed, submitted]);
  assert.deepEqual(
    [...anchors].sort(),
    [
      [claimed.id, 1],
      [other.id, 2],
    ].sort(),
  );
});

test('the pill says the task state from the task list', () => {
  assert.deepEqual(taskPill(task(1, 'open')), { label: 'Task · open', tone: 'warn' });
  assert.deepEqual(taskPill(task(1, 'claimed')), { label: 'Claimed · In progress', tone: 'warn' });
  assert.deepEqual(taskPill(task(1, 'claimed', 'Design')), {
    label: 'Claimed · Design',
    tone: 'warn',
  });
  assert.deepEqual(taskPill(task(1, 'in_review')), { label: 'In review', tone: 'accent' });
  assert.deepEqual(taskPill(task(1, 'done')), { label: '✓ Done', tone: 'ok' });
  assert.deepEqual(taskPill(task(1, 'cancelled')), { label: 'Cancelled', tone: 'idle' });
});

function member(name: string, extra: Partial<Member> = {}): Member {
  return {
    id: name.toLowerCase(),
    name,
    kind: 'agent',
    role: 'member',
    owner_label: 'Someone',
    own: false,
    joined_at: '2026-10-04T10:00:00Z',
    ...extra,
  } as Member;
}

test('room pill: # name, at most six avatars then +N, active AIs first, and the live line', () => {
  const members = [
    member('Host', { role: 'host', kind: 'person' }),
    ...['A', 'B', 'C', 'D', 'E', 'F', 'G'].map((name) => member(name)),
    member('Live', { active_now: true }),
  ];
  const html = renderToStaticMarkup(
    createElement(RoomPill, {
      name: 'The ROOM',
      members,
      memberCount: members.length,
      aisActive: 1,
      open: false,
      onOpen: () => undefined,
    }),
  );
  assert.match(html, /<h1[^>]*>.*#.*The ROOM<\/span><\/h1>/);
  const avatars = html.match(/class="rm-avatar rm3-av rm3-av-sm"/g) ?? [];
  assert.equal(avatars.length, PILL_AVATARS);
  // The active AI leads, then the host.
  assert.match(html, /rm3-stack[^>]*><span[^>]*>L<\/span><span[^>]*data-kind="person"[^>]*>H</);
  assert.match(html, />\+3</);
  assert.match(html, /1 AI active/);
  // One button covers the pill: it opens Members (the top bar has no separate Members chip).
  assert.match(
    html,
    /<button type="button" class="rm3-pill-hit" aria-label="Members of The ROOM: 9 members, 1 AI active" aria-expanded="false"/,
  );
  assert.match(html, /data-testid="room-pill"/);
  assert.equal(html.match(/<button/g)?.length, 1);
  assert.doesNotMatch(html, /data-open/);
  // Open: aria-expanded and the active-chip look (data-open on the pill).
  const open = renderToStaticMarkup(
    createElement(RoomPill, {
      name: 'The ROOM',
      members,
      memberCount: members.length,
      aisActive: 1,
      summary: '9 members · 1 AI active now (8 in room)',
      open: true,
      onOpen: () => undefined,
    }),
  );
  assert.match(open, /class="rm3-pill" data-open="true"/);
  assert.match(open, /aria-expanded="true"/);
  assert.match(
    open,
    /title="9 members · 1 AI active now \(8 in room\)\. AIs connected to this room now"/,
  );
});

test('room pill on phones: three avatars, and +N counts everyone not shown', () => {
  const members = ['A', 'B', 'C', 'D', 'E'].map((name) => member(name));
  const html = renderToStaticMarkup(
    createElement(RoomPill, {
      name: 'R',
      members,
      memberCount: 12,
      aisActive: 0,
      avatars: PILL_AVATARS_COMPACT,
      open: false,
      onOpen: () => undefined,
    }),
  );
  const avatars = html.match(/class="rm-avatar rm3-av rm3-av-sm"/g) ?? [];
  assert.equal(PILL_AVATARS_COMPACT, 3);
  assert.equal(avatars.length, 3);
  assert.match(html, />\+9</);
});

test('room pill: no live line while the count is unknown, a quiet one at zero', () => {
  const base = { name: 'R', members: [], memberCount: 2, open: false, onOpen: () => undefined };
  const unknown = renderToStaticMarkup(createElement(RoomPill, { ...base, aisActive: null }));
  assert.doesNotMatch(unknown, /active/);
  const zero = renderToStaticMarkup(createElement(RoomPill, { ...base, aisActive: 0 }));
  assert.match(zero, /data-idle="true"[^>]*>.*0 AIs active/);
});

const { lineIsBy, pillPlacement } = await import('../src/rooms/taskStatusV3.js');

test('a task line belongs to the exact member name, never a name that only starts the same', () => {
  assert.equal(lineIsBy('Nova created task #3: Ticker', 'Nova', 3), true);
  assert.equal(lineIsBy('Nova Bot created task #3: Ticker', 'Nova', 3), false);
  assert.equal(lineIsBy('Nova Bot claimed task #3: Ticker', 'Nova Bot', 3), true);
  assert.equal(lineIsBy('Nova created task #31: Ticker', 'Nova', 3), false);
  assert.equal(lineIsBy('A.B created task #1: x', 'A+B', 1), false);
  assert.equal(lineIsBy('Nova created task #3: Ticker', '', 3), false);
});

test('pill placement: under the asking message only when its author is the member the line names', () => {
  const novaAsks = post('Nova', '@Quill can you take the ticker?');
  const byNovaBot = line('Nova Bot created task #5: Ticker');
  const quillAsks = post('Quill', 'I will take the video.');
  const byQuill = line('Quill created task #6: Video');
  const placement = pillPlacement([novaAsks, byNovaBot, quillAsks, byQuill], 5 * 60_000);
  // "Nova" did not create task 5 ("Nova Bot" did): the pill stays under the line.
  assert.equal(placement.on.get(novaAsks.id), undefined);
  assert.equal(placement.after.get(byNovaBot.id), 5);
  // Quill asked and Quill created task 6: the pill goes under Quill's message.
  assert.equal(placement.on.get(quillAsks.id), 6);
  assert.equal(placement.after.has(byQuill.id), false);
  // Its line folds away (the pill says it under the message); the line pill's line stays.
  assert.equal(placement.folded.get(byQuill.id), 6);
  assert.equal(placement.folded.has(byNovaBot.id), false);
});

test('pill placement: a line long after the message stays a line pill', () => {
  const asks = post('Nova', 'Later today.');
  const late = { ...line('Nova created task #7: Later'), created_at: '2030-01-01T00:00:00Z' };
  const placement = pillPlacement([asks, late as RoomMessage], 5 * 60_000);
  assert.equal(placement.on.size, 0);
  assert.equal(placement.after.get(late.id), 7);
  assert.equal(placement.folded.size, 0);
});
