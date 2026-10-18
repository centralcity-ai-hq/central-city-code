import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { selectWorkspace } from '../src/api.js';
import {
  APPROVAL_GONE_MESSAGE,
  decidePendingAction,
  ElricApprovalLoadFailed,
  loadPendingAction,
} from '../src/rooms/elric/ElricApprovalCard.js';

/**
 * The in-room approval card: a failed load offers a retry, requests carry the selected workspace,
 * a refused decision shows the server's own (plain) message from `error`, and an action decided
 * elsewhere says so instead of keeping Approve / Reject.
 */
type Call = { url: string; init: RequestInit };

function fakeFetch(answers: { status: number; body: unknown }[]) {
  const calls: Call[] = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const next = answers.shift() ?? { status: 500, body: {} };
    return new Response(JSON.stringify(next.body), {
      status: next.status,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { calls, fetcher };
}

const ITEM = {
  id: 'p1',
  tool: 'room_task_create',
  summary: 'Write the brief',
  args_hash: 'h1',
  room: null,
  created_at: '2026-10-16T00:00:00Z',
  expires_at: '2026-10-16T01:00:00Z',
};

function header(call: Call, name: string): string | undefined {
  return (call.init.headers as Record<string, string> | undefined)?.[name];
}

test('loadPendingAction: a failed read is "failed" (retry), a missing id is null', async (t) => {
  t.after(() => selectWorkspace(null));
  selectWorkspace('ws-1');
  const failed = fakeFetch([{ status: 503, body: { error: 'Busy.' } }]);
  assert.equal(await loadPendingAction('p1', failed.fetcher), 'failed');
  assert.equal(header(failed.calls[0]!, 'X-City-Workspace'), 'ws-1', 'sends the workspace');
  const missing = fakeFetch([{ status: 200, body: { pending: [] } }]);
  assert.equal(await loadPendingAction('p1', missing.fetcher), null);
  const found = fakeFetch([{ status: 200, body: { pending: [ITEM] } }]);
  assert.deepEqual(await loadPendingAction('p1', found.fetcher), ITEM);
});

test('decidePendingAction: approve sends the args hash and the workspace', async (t) => {
  t.after(() => selectWorkspace(null));
  selectWorkspace('ws-2');
  const ok = fakeFetch([{ status: 200, body: { id: 'p1', status: 'approved' } }]);
  assert.deepEqual(await decidePendingAction(ITEM, 'approve', ok.fetcher), { ok: true });
  const call = ok.calls[0]!;
  assert.equal(call.url, '/api/elric/pending/p1/approve');
  assert.equal(call.init.method, 'POST');
  assert.equal(header(call, 'X-City-Workspace'), 'ws-2');
  assert.deepEqual(JSON.parse(String(call.init.body)), { args_hash: 'h1' });
});

test('decidePendingAction: an action decided elsewhere says so (no buttons)', async () => {
  const gone = fakeFetch([
    { status: 409, body: { error: 'The action cannot be approved.' } },
    { status: 200, body: { pending: [] } },
  ]);
  assert.deepEqual(await decidePendingAction(ITEM, 'approve', gone.fetcher), {
    ok: false,
    gone: true,
    message: APPROVAL_GONE_MESSAGE,
  });
  assert.equal(gone.calls[1]!.url, '/api/elric/pending', 'reads the pending list again');
});

test('decidePendingAction: a refusal while still open shows the server message from `error`', async () => {
  const open = fakeFetch([
    { status: 409, body: { error: 'The action cannot be rejected.' } },
    { status: 200, body: { pending: [ITEM] } },
  ]);
  assert.deepEqual(await decidePendingAction(ITEM, 'reject', open.fetcher), {
    ok: false,
    gone: false,
    message: 'The action cannot be rejected.',
  });
});

/** Every element in a rendered tree (function components are not expanded). */
function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...elements(node.props.children as ReactNode)];
}

test('a failed load shows an error with a "Try again" button that reloads', () => {
  let retries = 0;
  const onRetry = () => {
    retries++;
  };
  const html = renderToStaticMarkup(createElement(ElricApprovalLoadFailed, { onRetry }));
  assert.match(html, /role="alert"/);
  assert.match(html, />Try again<\/button>/);
  const button = elements(ElricApprovalLoadFailed({ onRetry })).find((e) => e.type === 'button');
  assert.ok(button);
  (button.props.onClick as () => void)();
  assert.equal(retries, 1);
});
