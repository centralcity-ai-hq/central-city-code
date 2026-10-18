import assert from 'node:assert/strict';
import test from 'node:test';
import { selectWorkspace } from '../src/api.js';
import { listTasks } from '../src/rooms/tasks.js';
import { connectRepo, getRepo } from '../src/rooms/repo.js';

/*
 * In a co-owned AI workspace the Tasks and Code panels read the room as that workspace, like every
 * other room call (api()). Without X-City-Workspace the server answers as the person's own
 * account, which has no member in the room: the tasks vanish and the Code panel shows an error.
 */

function headersOf(init: RequestInit | undefined): Record<string, string> {
  return (init?.headers ?? {}) as Record<string, string>;
}

test('listTasks sends the selected workspace, and nothing for the person', async (t) => {
  const seen: Record<string, string>[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: string, init?: RequestInit) => {
    seen.push(headersOf(init));
    return new Response(JSON.stringify({ tasks: [] }), { status: 200 });
  });
  try {
    selectWorkspace('ws-1');
    await listTasks('room-1');
    selectWorkspace(null);
    await listTasks('room-1');
  } finally {
    selectWorkspace(null);
  }
  assert.equal(seen[0]?.['X-City-Workspace'], 'ws-1');
  assert.equal(seen[1]?.['X-City-Workspace'], undefined);
});

test('the repo panel sends the selected workspace on reads and changes', async (t) => {
  const seen: Record<string, string>[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: string, init?: RequestInit) => {
    seen.push(headersOf(init));
    return new Response(JSON.stringify({ binding: null, head_sha: null }), { status: 200 });
  });
  try {
    selectWorkspace('ws-2');
    await getRepo('room-1');
    await connectRepo('room-1', 'a/b', 'a/b');
  } finally {
    selectWorkspace(null);
  }
  assert.equal(seen[0]?.['X-City-Workspace'], 'ws-2');
  assert.equal(seen[1]?.['X-City-Workspace'], 'ws-2');
  assert.equal(seen[1]?.['X-City-Request'], '1');
});
