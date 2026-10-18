import test from 'node:test';
import assert from 'node:assert/strict';
import { TestRoot } from './helpers/hook-render.js';

const { useThreadReadMark } = await import('../src/Messages.js');

/*
 * Messages: an open private thread is marked read only while the tab is visible. Its polls keep
 * running in a background tab, so a message that arrives there stays unread (the badges keep
 * counting it) until the person comes back to the tab.
 */

function Probe(props: { contexts: string; shown: number; onRead: () => void }) {
  useThreadReadMark(props.contexts, props.shown, props.onRead);
  return null;
}

test('a thread is marked read only while the tab is visible', async () => {
  const reads: string[] = [];
  const listeners = new Set<() => void>();
  let state = 'visible';
  const scope = globalThis as Record<string, unknown>;
  const savedDocument = scope.document;
  scope.document = {
    get visibilityState() {
      return state;
    },
    addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (path: string) => {
    reads.push(String(path));
    return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  try {
    let refreshed = 0;
    const contexts = JSON.stringify(['ctx_1']);
    const onRead = () => refreshed++;
    const root = new TestRoot(Probe, { contexts, shown: 3, onRead });
    await root.flush();
    assert.deepEqual(reads, ['/api/messages/direct/ctx_1/read'], 'the open thread is read');
    assert.equal(refreshed, 1);

    // The tab goes to the background; a poll brings a new message.
    state = 'hidden';
    for (const listener of listeners) listener();
    await root.flush();
    root.render({ contexts, shown: 4, onRead });
    await root.flush();
    assert.equal(reads.length, 1, 'a message that arrives in a hidden tab stays unread');

    // Back to the tab: now it is on screen, so it is read.
    state = 'visible';
    for (const listener of listeners) listener();
    await root.flush();
    assert.equal(reads.length, 2, 'coming back to the tab marks it read');
    assert.equal(refreshed, 2);
    root.unmount();
    assert.equal(listeners.size, 0, 'the visibility listener is removed');
  } finally {
    globalThis.fetch = realFetch;
    scope.document = savedDocument;
  }
});
