import assert from 'node:assert/strict';
import test from 'node:test';
import { runningPolls, subscribePoll, type PollEnv } from '../src/shell/sharedPoll.js';

/** Timers the test runs by hand; visibility fired by the test. */
function fakeEnv() {
  const intervals = new Map<number, () => void>();
  const visible = new Set<() => void>();
  let id = 0;
  const env: PollEnv = {
    setInterval: (fn) => {
      intervals.set(++id, fn);
      return id;
    },
    clearInterval: (key) => void intervals.delete(key as number),
    setTimeout: () => ++id,
    clearTimeout: () => undefined,
    onVisible: (fn) => {
      visible.add(fn);
      return () => visible.delete(fn);
    },
  };
  return {
    env,
    tick: () => [...intervals.values()].forEach((fn) => fn()),
    show: () => [...visible].forEach((fn) => fn()),
    intervals: () => intervals.size,
  };
}

/** A read the test answers by hand, counting the requests. */
function fakeRead() {
  const waiting: Array<{ resolve: (v: unknown) => void; reject: (e: unknown) => void }> = [];
  let calls = 0;
  return {
    read: () => {
      calls += 1;
      return new Promise<unknown>((resolve, reject) => waiting.push({ resolve, reject }));
    },
    calls: () => calls,
    answer: async (value: unknown) => {
      waiting.shift()!.resolve(value);
      await new Promise((r) => setTimeout(r, 0));
    },
    fail: async (err: unknown) => {
      waiting.shift()!.reject(err);
      await new Promise((r) => setTimeout(r, 0));
    },
  };
}

const options = (net: ReturnType<typeof fakeRead>, env: PollEnv) => ({
  read: net.read,
  describe: (err: unknown) => (err instanceof Error ? err.message : 'failed'),
  lost: (err: unknown) => err instanceof Error && err.message === 'gone',
  everyMs: 10_000,
  env,
});

test('subscribers of one address share one poll, one request at a time', async () => {
  const clock = fakeEnv();
  const net = fakeRead();
  let changes = 0;
  const a = subscribePoll<{ n: number }>('w|/x', '/x', options(net, clock.env), () => changes++);
  const b = subscribePoll<{ n: number }>('w|/x', '/x', options(net, clock.env), () => changes++);
  const c = subscribePoll<{ n: number }>('w|/x', '/x', options(net, clock.env), () => changes++);
  assert.equal(net.calls(), 1, 'three subscribers, one request');
  assert.equal(clock.intervals(), 1, 'one timer');
  await net.answer({ n: 1 });
  assert.deepEqual(a.get().data, { n: 1 });
  assert.deepEqual(c.get().data, { n: 1 });
  assert.equal(a.get().loading, false);
  assert.ok(changes > 0);
  // A tick asks once for everyone; another tick while it is on its way asks nothing more.
  clock.tick();
  clock.tick();
  assert.equal(net.calls(), 2);
  // A refresh during that read asks once more, right after it (not twice).
  const r1 = b.refresh();
  const r2 = c.refresh();
  await net.answer({ n: 2 });
  assert.equal(net.calls(), 3);
  await net.answer({ n: 3 });
  await Promise.all([r1, r2]);
  assert.deepEqual(b.get().data, { n: 3 });
  // The page shown again: one read.
  clock.show();
  assert.equal(net.calls(), 4);
  await net.answer({ n: 4 });
  // The poll stops with the last subscriber.
  a.unsubscribe();
  b.unsubscribe();
  assert.equal(runningPolls(), 1);
  c.unsubscribe();
  assert.equal(runningPolls(), 0);
  assert.equal(clock.intervals(), 0);
  clock.tick();
  assert.equal(net.calls(), 4);
});

test('another key (another workspace) is its own poll; failures keep or clear data as before', async () => {
  const clock = fakeEnv();
  const net = fakeRead();
  const one = subscribePoll<{ n: number }>('w1|/x', '/x', options(net, clock.env), () => undefined);
  const two = subscribePoll<{ n: number }>('w2|/x', '/x', options(net, clock.env), () => undefined);
  assert.equal(net.calls(), 2);
  await net.answer({ n: 1 });
  await net.answer({ n: 9 });
  assert.deepEqual(one.get().data, { n: 1 });
  assert.deepEqual(two.get().data, { n: 9 });
  // A failed read keeps the last answer and says why; a lost-access read clears it.
  void one.refresh();
  await net.fail(new Error('offline'));
  assert.deepEqual(one.get().data, { n: 1 });
  assert.equal(one.get().error, 'offline');
  void one.refresh();
  await net.fail(new Error('gone'));
  assert.equal(one.get().data, null);
  one.unsubscribe();
  two.unsubscribe();
  assert.equal(runningPolls(), 0);
});
