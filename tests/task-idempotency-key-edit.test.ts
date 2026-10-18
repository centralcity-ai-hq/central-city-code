import test from 'node:test';
import assert from 'node:assert/strict';
import type { ReactElement } from 'react';
import { TestRoot, elements } from './helpers/hook-render.js';
import type { Member, Room } from '../src/rooms/api.js';

const { TaskComments } = await import('../src/rooms/TaskComments.js');
const { TasksPanel } = await import('../src/rooms/TasksPanel.js');

/*
 * A comment or a new task keeps its idempotency key only while the request is unchanged. After a
 * lost answer (the server may have saved it) the same text is sent again with the same key, so it
 * is never added twice; an edited text takes a new key, since the server refuses a known key with
 * a different request (409) for as long as the form keeps it.
 */

interface Sent {
  path: string;
  body: Record<string, unknown>;
}

function stubFetch(answer: (sent: Sent) => Response | Promise<Response>) {
  const sent: Sent[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (path: string, init?: RequestInit) => {
    const call = { path: String(path), body: init?.body ? JSON.parse(String(init.body)) : {} };
    if (init?.method && init.method !== 'GET') sent.push(call);
    return answer(call);
  }) as typeof fetch;
  return { sent, restore: () => void (globalThis.fetch = realFetch) };
}

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const lost = () => Promise.reject(new TypeError('Failed to fetch'));
const submitEvent = { preventDefault() {} };

function field(root: { output: unknown }, type: string) {
  return elements(root.output as ReactElement).find((element) => element.type === type)!;
}
function form(root: { output: unknown }, className: string) {
  return elements(root.output as ReactElement).find(
    (element) => element.type === 'form' && element.props.className === className,
  )!;
}
function type(element: ReactElement<Record<string, unknown>>, value: string) {
  (element.props.onChange as (event: unknown) => void)({ target: { value } });
}
function submit(element: ReactElement<Record<string, unknown>>) {
  (element.props.onSubmit as (event: unknown) => void)(submitEvent);
}

test('task comment: a retry keeps the key, an edited comment gets a new one', async () => {
  const { sent, restore } = stubFetch((call) =>
    call.path.includes('/comments') && Object.keys(call.body).length
      ? lost()
      : json(200, { comments: [], has_more: false, next_after: null }),
  );
  try {
    const root = new TestRoot(TaskComments, {
      roomId: 'room_1',
      taskId: 'task_1',
      taskLabel: 'T1',
      host: true,
      canWrite: true,
      onCount: () => undefined,
    });
    await root.flush();
    type(field(root, 'textarea'), 'Looks good, shipping it');
    root.render();
    submit(form(root, 'rm-comment-form'));
    await root.flush();
    submit(form(root, 'rm-comment-form'));
    await root.flush();
    type(field(root, 'textarea'), 'Looks good, shipping it now');
    root.render();
    submit(form(root, 'rm-comment-form'));
    await root.flush();

    const keys = sent.map((call) => call.body.idempotency_key);
    assert.equal(keys.length, 3);
    assert.equal(keys[1], keys[0], 'the unchanged retry reuses the key');
    assert.notEqual(keys[2], keys[0], 'the edited comment gets a new key');
    root.unmount();
  } finally {
    restore();
  }
});

test('new task: a retry keeps the key, an edited form gets a new one', async () => {
  const { sent, restore } = stubFetch(lost);
  try {
    const room = { id: 'room_1', role: 'host', closed: false, muted: false } as unknown as Room;
    const members = [
      { id: 'agent_host', role: 'host', own: true, kind: 'agent', name: 'Host' },
    ] as unknown as Member[];
    const state = {
      tasks: [],
      stages: [],
      available: true,
      error: '',
      refresh: async () => undefined,
      setTasks: () => undefined,
    };
    const props = { room, members, state, startAdding: 1, onClose: () => undefined };
    const root = new TestRoot(TasksPanel, props);
    await root.flush();
    type(field(root, 'input'), 'Write the release notes');
    root.render();
    submit(form(root, 'rm-task-form'));
    await root.flush();
    submit(form(root, 'rm-task-form'));
    await root.flush();
    type(field(root, 'textarea'), 'Cover the new stages');
    root.render();
    submit(form(root, 'rm-task-form'));
    await root.flush();

    const keys = sent.map((call) => call.body.idempotency_key);
    assert.equal(keys.length, 3);
    assert.equal(keys[1], keys[0], 'the unchanged retry reuses the key');
    assert.notEqual(keys[2], keys[0], 'the edited form gets a new key');
    root.unmount();
  } finally {
    restore();
  }
});
