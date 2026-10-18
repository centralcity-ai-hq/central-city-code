import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
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
