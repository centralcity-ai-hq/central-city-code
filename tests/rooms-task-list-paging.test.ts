import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TasksCutNotice } from '../src/rooms/TasksPanel.js';
import {
  listTasks,
  taskRefreshDelay,
  TASK_LIST_MAX_PAGES,
  TASK_REFRESH_MAX_MS,
  TASK_REFRESH_MS,
  type RoomTask,
} from '../src/rooms/tasks.js';

/*
 * The Tasks panel reads every page of the room's tasks (src/rooms/tasks.ts listTasks), so a room
 * with more than 100 tasks keeps its newest ones on every refresh.
 */

const task = (number: number) => ({ id: `t${number}`, number }) as unknown as RoomTask;

test('listTasks follows next_after until has_more is false', async (t) => {
  const urls: string[] = [];
  const pages = [
    { tasks: [task(1), task(2)], stages: ['Doing'], next_after: 2, has_more: true },
    { tasks: [task(3)], stages: ['Doing'], next_after: 3, has_more: false },
  ];
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    urls.push(url);
    return new Response(JSON.stringify(pages[urls.length - 1]), { status: 200 });
  });
  const listed = await listTasks('room-1');
  assert.deepEqual(
    listed?.tasks.map((item) => item.number),
    [1, 2, 3],
  );
  assert.deepEqual(listed?.stages, ['Doing']);
  assert.deepEqual(urls, [
    '/api/rooms/room-1/tasks?limit=100',
    '/api/rooms/room-1/tasks?limit=100&after_number=2',
  ]);
});

test('listTasks reads one page from a server without a cursor, and null on 404', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return new Response(JSON.stringify({ tasks: [task(1)] }), { status: 200 });
  });
  assert.deepEqual((await listTasks('room-1'))?.tasks.length, 1);
  assert.equal(calls, 1);
  t.mock.restoreAll();
  t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 404 }));
  assert.equal(await listTasks('room-1'), null);
});

/*
 * An open panel re-reads every page, so the wait between re-reads grows with the page count
 * (taskRefreshDelay): a room of 3,000 tasks no longer costs 30 requests every 10 s.
 */
test('listTasks reports the pages read, and bigger rooms are re-read less often', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    const more = calls < 3;
    return new Response(
      JSON.stringify({ tasks: [task(calls)], next_after: calls, has_more: more }),
      { status: 200 },
    );
  });
  assert.equal((await listTasks('room-1'))?.pages, 3);
  assert.equal(taskRefreshDelay(1), TASK_REFRESH_MS);
  assert.equal(taskRefreshDelay(0), TASK_REFRESH_MS);
  for (const pages of [1, 3, 30, 50]) {
    const perMinute = (pages * 60_000) / taskRefreshDelay(pages);
    assert.ok(perMinute <= 10, `${pages} pages: ${perMinute} requests a minute`);
  }
  assert.equal(taskRefreshDelay(TASK_LIST_MAX_PAGES), TASK_REFRESH_MAX_MS);
});

test('the Tasks panel plans each re-read after the last one, by page count, in visible tabs', () => {
  const source = readFileSync(new URL('../src/rooms/TasksPanel.tsx', import.meta.url), 'utf8');
  const hook = source.slice(source.indexOf('export function useRoomTasks'));
  const body = hook.slice(0, hook.indexOf('\nexport function'));
  assert.doesNotMatch(body, /setInterval/);
  assert.match(body, /taskRefreshDelay\(pages\.current\)/);
  assert.match(body, /pageVisible\(\)/);
});

/*
 * R1-7: a room past the page budget. The read in number order stops early and the rest of the
 * budget reads the active tasks after it, so the newest open work is listed; the panel says that
 * finished tasks are missing.
 */
function bigRoom(total: number, activeFrom: number) {
  // Tasks 1..total; every task numbered >= activeFrom is open, the rest done.
  const urls: string[] = [];
  const fetch = async (url: string) => {
    urls.push(url);
    const query = new URLSearchParams(url.split('?')[1]);
    const after = Number(query.get('after_number') ?? 0);
    const status = query.get('status');
    const matching: number[] = [];
    for (let n = after + 1; n <= total && matching.length <= 100; n++) {
      const open = n >= activeFrom;
      if (status === null || (status === 'open') === open) {
        if (status === null || status === 'open') matching.push(n);
      }
    }
    const shown = matching.slice(0, 100);
    return new Response(
      JSON.stringify({
        tasks: shown.map(task),
        stages: [],
        next_after: shown.at(-1) ?? null,
        has_more: matching.length > 100,
      }),
      { status: 200 },
    );
  };
  return { urls, fetch };
}

test('R1-7: past the page budget the newest active tasks are still listed, and the cut is reported', async (t) => {
  const room = bigRoom(6_000, 5_901); // 5,900 done tasks, then 100 open ones
  t.mock.method(globalThis, 'fetch', room.fetch);
  const listed = (await listTasks('room-1'))!;
  const numbers = new Set(listed.tasks.map((item) => item.number));
  for (let n = 5_901; n <= 6_000; n++) assert.ok(numbers.has(n), `open task T${n} is listed`);
  assert.equal(listed.cut, 'finished');
  assert.ok(listed.pages <= TASK_LIST_MAX_PAGES, `${listed.pages} pages`);
  assert.ok(room.urls.some((url) => url.includes('status=open')));
  assert.match(
    renderToStaticMarkup(createElement(TasksCutNotice, { cut: listed.cut })),
    /some done or cancelled tasks are not/,
  );
});

test('R1-7: a room that fits is read as before and shows no notice', async (t) => {
  const room = bigRoom(250, 1);
  t.mock.method(globalThis, 'fetch', room.fetch);
  const listed = (await listTasks('room-1'))!;
  assert.equal(listed.tasks.length, 250);
  assert.equal(listed.cut, 'none');
  assert.equal(room.urls.length, 3);
  assert.equal(
    room.urls.some((url) => url.includes('status=')),
    false,
  );
  assert.equal(renderToStaticMarkup(createElement(TasksCutNotice, { cut: listed.cut })), '');
});

test('R1-7: when even the active tasks exceed the budget, the panel says some tasks are not listed', async (t) => {
  const room = bigRoom(9_000, 1); // every task open
  t.mock.method(globalThis, 'fetch', room.fetch);
  const listed = (await listTasks('room-1'))!;
  assert.equal(listed.cut, 'some');
  assert.equal(listed.pages, TASK_LIST_MAX_PAGES);
  assert.match(
    renderToStaticMarkup(createElement(TasksCutNotice, { cut: listed.cut })),
    /Some tasks are not listed/,
  );
});
