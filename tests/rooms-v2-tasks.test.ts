import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import type { PeerReview, RoomTask, TaskStatus } from '../src/rooms/tasks.js';
import {
  STAGE_FLOW,
  TASK_FILTERS,
  canAskReview,
  countTasks,
  filterTasks,
  taskPerson,
  taskPill,
  taskProgress,
} from '../src/rooms/taskViewV2.js';

/*
 * Smart Rooms v2 Tasks sheet (src/rooms/taskViewV2.ts, rooms-v2-tasks.css): chip counts,
 * client-side filtering, one status per card with the peer review folded in, and CSS that stays
 * scoped to the preview with no orange.
 */

let next = 1;
function task(status: TaskStatus, review?: PeerReview['status']): RoomTask {
  const number = next++;
  return {
    id: `t${number}`,
    number,
    title: `Task ${number}`,
    body: null,
    status,
    created_by_agent_id: 'a1',
    claim: status === 'open' ? null : { agent_id: 'a2', expires_at: '2026-10-03T12:00:00Z' },
    result: null,
    peer_review: review
      ? {
          id: `r${number}`,
          status: review,
          reviewer_agent_id: 'a3',
          requested_by_agent_id: 'a2',
          checklist: [],
          comment: null,
          requested_at: '2026-10-03T10:00:00Z',
          decided_at: null,
        }
      : null,
    comment_count: 0,
    created_at: '2026-10-03T09:00:00Z',
    updated_at: '2026-10-03T09:00:00Z',
  };
}

test('the chips are All, Open, Claimed, In review, Done', () => {
  assert.deepEqual(
    TASK_FILTERS.map((filter) => filter.label),
    ['All', 'Open', 'Claimed', 'In review', 'Done'],
  );
});

test('counts follow the real stages; All includes cancelled tasks', () => {
  const tasks = [
    task('open'),
    task('open'),
    task('claimed'),
    task('in_review'),
    task('done'),
    task('done'),
    task('done'),
    task('cancelled'),
  ];
  assert.deepEqual(countTasks(tasks), { all: 8, open: 2, claimed: 1, in_review: 1, done: 3 });
  assert.deepEqual(countTasks([]), { all: 0, open: 0, claimed: 0, in_review: 0, done: 0 });
});

test('filtering keeps the order and only the chosen stage', () => {
  const tasks = [task('done'), task('open'), task('claimed'), task('open')];
  assert.deepEqual(
    filterTasks(tasks, 'open').map((item) => item.id),
    [tasks[1].id, tasks[3].id],
  );
  assert.equal(filterTasks(tasks, 'all').length, 4);
  assert.notEqual(filterTasks(tasks, 'all'), tasks);
  assert.equal(filterTasks(tasks, 'in_review').length, 0);
});

test('one status label per card: Needs review and In review merge, Accepted becomes Done', () => {
  assert.deepEqual(taskPill(task('open')), { label: 'Open', tone: 'neutral' });
  assert.deepEqual(taskPill(task('claimed')), { label: 'Claimed', tone: 'accent' });
  assert.deepEqual(taskPill(task('in_review')), { label: 'In review', tone: 'strong' });
  assert.deepEqual(taskPill(task('done')), { label: 'Done', tone: 'done' });
  assert.deepEqual(taskPill(task('done', 'approved')), { label: 'Done', tone: 'done' });
  assert.deepEqual(taskPill(task('cancelled')), { label: 'Cancelled', tone: 'muted' });
});

test('the peer review is folded into the single label', () => {
  assert.equal(taskPill(task('claimed', 'requested')).label, 'Claimed · review asked');
  assert.equal(taskPill(task('in_review', 'approved')).label, 'In review · peer approved');
  assert.equal(taskPill(task('in_review', 'changes_requested')).label, 'In review · changes asked');
  assert.equal(taskPill(task('claimed', 'cancelled')).label, 'Claimed');
});

test('cards name the claim holder, then who handed the work in ("by <name>")', () => {
  const handed = (status: TaskStatus, submittedBy: string | null | undefined): RoomTask => ({
    ...task(status),
    claim: null,
    submitted_by: submittedBy,
  });
  assert.deepEqual(taskPerson(task('claimed')), { agentId: 'a2', handedIn: false });
  assert.deepEqual(taskPerson(handed('in_review', 'a4')), { agentId: 'a4', handedIn: true });
  assert.deepEqual(taskPerson(handed('done', 'a4')), { agentId: 'a4', handedIn: true });
  // Open (sent back) and cancelled cards name nobody; a removed member or an older server
  // (null / absent) leaves the hand-in unnamed.
  assert.equal(taskPerson(handed('open', 'a4')), null);
  assert.equal(taskPerson(handed('cancelled', 'a4')), null);
  assert.equal(taskPerson(handed('done', null)), null);
  assert.equal(taskPerson(handed('in_review', undefined)), null);
});

test('rooms-v2-tasks.css is scoped to the preview and has no orange', () => {
  const css = readFileSync(resolve(process.cwd(), 'src/rooms/rooms-v2-tasks.css'), 'utf8');
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const rule of withoutComments.matchAll(/([^{}]+)\{/g)) {
    for (const selector of rule[1].split(',')) {
      const text = selector.trim();
      if (!text || text.startsWith('@') || /^(to|from|\d+%)$/.test(text)) continue;
      assert.match(text, /\.rm-app\[data-rooms='v2'\]/, `unscoped selector: ${text}`);
    }
  }
  for (const hex of withoutComments.matchAll(/#([0-9a-f]{6})\b/gi)) {
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex[1].slice(i, i + 2), 16));
    const orange = r > 200 && g > 80 && g < 190 && b < 90;
    assert.ok(!orange, `orange colour in rooms-v2-tasks.css: #${hex[1]}`);
  }
});

// Workspace v3 task cards (docs/design/WORKSPACE_V3.md §4.5): stage pills and progress come from
// the real status; the card's Ask for a review follows the detail's rule.
test('v3: the stage pills are the status flow Open, Claimed, In review, Done', () => {
  assert.deepEqual(
    STAGE_FLOW.map((step) => [step.status, step.label]),
    [
      ['open', 'Open'],
      ['claimed', 'Claimed'],
      ['in_review', 'In review'],
      ['done', 'Done'],
    ],
  );
});

test('v3: progress follows the status; a cancelled task shows none', () => {
  assert.equal(taskProgress(task('open')), 0);
  assert.equal(taskProgress(task('claimed')), 1 / 3);
  assert.equal(taskProgress(task('in_review')), 2 / 3);
  assert.equal(taskProgress(task('done')), 1);
  assert.equal(taskProgress(task('cancelled')), 0);
});

test('v3: Ask for a review on a card follows the detail rule', () => {
  const host = { host: true, closed: false, own: new Set<string>() };
  const claimer = { host: false, closed: false, own: new Set(['a2']) };
  const other = { host: false, closed: false, own: new Set(['a9']) };
  // Offered once the work has started, to the host or the claim holder.
  assert.equal(canAskReview(task('claimed'), host), true);
  assert.equal(canAskReview(task('in_review'), claimer), true);
  assert.equal(canAskReview(task('claimed'), other), false);
  // Not on an open, done or cancelled task, in a closed room, or while a review is waiting.
  assert.equal(canAskReview(task('open'), host), false);
  assert.equal(canAskReview(task('done'), host), false);
  assert.equal(canAskReview(task('cancelled'), host), false);
  assert.equal(canAskReview(task('claimed'), { ...host, closed: true }), false);
  assert.equal(canAskReview(task('claimed', 'requested'), host), false);
  assert.equal(canAskReview(task('claimed', 'changes_requested'), claimer), true);
});

test('v3: rooms-v3-panels.css stays in the workspace scale, scoped, calm and without orange', () => {
  const css = readFileSync(resolve(process.cwd(), 'src/rooms/rooms-v3-panels.css'), 'utf8');
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const rule of withoutComments.matchAll(/([^{}]+)\{/g)) {
    if (rule[1].trim().startsWith('@')) continue;
    // Commas inside :is(...) do not separate selectors.
    for (const selector of rule[1].split(/,(?![^(]*\))/)) {
      const text = selector.trim();
      if (!text || text.startsWith('@') || /^(to|from|\d+%)$/.test(text)) continue;
      assert.match(text, /^\.rm-app\s/, `unscoped selector: ${text}`);
    }
  }
  for (const hex of withoutComments.matchAll(/#([0-9a-f]{6})\b/gi)) {
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex[1].slice(i, i + 2), 16));
    assert.ok(!(r > 200 && g > 80 && g < 190 && b < 90), `orange colour: #${hex[1]}`);
  }
  // Motion stays within 150 to 250 ms and is switched off under reduced motion.
  for (const ms of withoutComments.matchAll(/(\d+)ms/g))
    assert.ok(Number(ms[1]) >= 150 && Number(ms[1]) <= 250, `motion of ${ms[1]}ms`);
  assert.match(withoutComments, /prefers-reduced-motion: reduce[\s\S]*animation: none !important/);
  // The panel is 360 design pixels wide, in workspace units.
  assert.match(withoutComments, /width: calc\(360 \* var\(--ws-px\)\)/);
});
