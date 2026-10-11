import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentActivityItem, AgentActivityPage } from '../shared/types';
import { api, apiInWorkspace, selectWorkspace } from '../src/api';
import {
  ACTIVITY_POLL_MS,
  ActivityNameReads,
  ActivityReads,
  COPY_NOTE_MS,
  DeveloperReads,
  sameScope,
  type ReadDeps,
} from '../src/agents/v4/activityDeveloperReads';

/*
 * The reads behind the v4 Activity and Developer details screens, with a scripted server and a
 * manual clock: answers arrive only when a test releases them, so a late answer can be placed
 * after an agent or workspace switch, or after the screen closed.
 */

const A = 'aaaaaaaa-0000-4000-8000-000000000001';
const B = 'bbbbbbbb-0000-4000-8000-000000000002';
const W1 = 'ws-1';
const W2 = 'ws-2';

interface Call {
  url: string;
  headers: Record<string, string>;
  signal: AbortSignal | undefined;
  reply: (status: number, json: unknown) => Promise<void>;
}

function harness(options: { visible?: boolean; deadlineMs?: number } = {}) {
  const calls: Call[] = [];
  let clock = 0;
  let nextTimer = 1;
  const timers = new Map<number, { at: number; run: () => void }>();
  const deps: ReadDeps = {
    fetch: ((url: string, init: RequestInit) =>
      new Promise((resolve) => {
        calls.push({
          url,
          headers: (init.headers ?? {}) as Record<string, string>,
          signal: init.signal ?? undefined,
          reply: async (status, json) => {
            resolve({
              ok: status >= 200 && status < 300,
              status,
              json: async () => json,
              headers: { get: () => null },
            } as unknown as Response);
            await settle();
          },
        });
      })) as unknown as typeof fetch,
    setTimeout: (run, ms) => {
      const id = nextTimer++;
      timers.set(id, { at: clock + ms, run });
      return id;
    },
    clearTimeout: (id) => void timers.delete(id as number),
    visible: () => options.visible ?? true,
    deadlineMs: options.deadlineMs ?? 15_000,
  };
  /** Moves the clock on and fires every timer that is due by then. */
  async function advance(ms: number) {
    clock += ms;
    for (const [id, timer] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
      if (timer.at > clock || !timers.has(id)) continue;
      timers.delete(id);
      timer.run();
      await settle();
    }
  }
  return { calls, deps, advance };
}

async function settle() {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
}

function event(id: string, at = '2026-10-10T08:00:00.000Z'): AgentActivityItem {
  return { kind: 'event', id, at, type: 'room.joined', text: `line ${id}`, jobId: null };
}
const page = (ids: string[], nextBefore: string | null = null): AgentActivityPage =>
  ({ items: ids.map((id) => event(id)), nextBefore }) as AgentActivityPage;
const ids = (reads: ActivityReads) => reads.getSnapshot().feed?.items.map((item) => item.id);

/* ---------- the workspace a read asks in ---------- */

test('apiInWorkspace sends the workspace it is given, whatever is selected; api() keeps the selected one', async () => {
  const seen: Record<string, string>[] = [];
  const fetcher = (async (_url: string, init: RequestInit) => {
    seen.push({ ...(init.headers as Record<string, string>) });
    return { ok: true, status: 200, json: async () => ({}), headers: { get: () => null } };
  }) as unknown as typeof fetch;
  const original = globalThis.fetch;
  globalThis.fetch = fetcher;
  try {
    selectWorkspace(W2);
    await apiInWorkspace(W1, '/x', { method: 'GET', fetcher });
    await apiInWorkspace(null, '/x', { method: 'GET', fetcher });
    await api('/x', undefined, 'GET');
    selectWorkspace(null);
    await api('/x', undefined, 'GET');
  } finally {
    selectWorkspace(null);
    globalThis.fetch = original;
  }
  assert.deepEqual(seen, [{ 'X-City-Workspace': W1 }, {}, { 'X-City-Workspace': W2 }, {}]);
});

test('sameScope: the same agent in the same workspace only', () => {
  assert.equal(sameScope({ agentId: A, workspace: W1 }, A, W1), true);
  assert.equal(sameScope({ agentId: A, workspace: W1 }, A, W2), false);
  assert.equal(sameScope({ agentId: A, workspace: null }, A, W1), false);
  assert.equal(sameScope({ agentId: A, workspace: W1 }, B, W1), false);
  assert.equal(sameScope(null, A, W1), false);
});

/* ---------- Activity ---------- */

test('Activity reads the agent in the workspace it shows, sent as X-City-Workspace', async () => {
  const h = harness();
  const reads = new ActivityReads(h.deps);
  reads.show(A, W1);
  assert.equal(h.calls.length, 1);
  assert.match(h.calls[0]!.url, new RegExp(`/api/agents/${A}/activity\\?limit=`));
  assert.deepEqual(h.calls[0]!.headers, { 'X-City-Workspace': W1 });
  await h.calls[0]!.reply(200, page(['1']));
  assert.deepEqual(ids(reads), ['1']);
  // The person's own workspace sends none.
  reads.show(A, null);
  assert.deepEqual(h.calls[1]!.headers, {});
  reads.close();
});

test('Activity A → B: a late answer for A is dropped and never shows for B', async () => {
  const h = harness();
  const reads = new ActivityReads(h.deps);
  reads.show(A, W1);
  reads.show(B, W1);
  assert.equal(h.calls[0]!.signal?.aborted, true, 'the request for A is given up');
  await h.calls[0]!.reply(200, page(['a1']));
  assert.equal(reads.getSnapshot().feed, null);
  assert.deepEqual(reads.getSnapshot().scope, { agentId: B, workspace: W1 });
  assert.match(h.calls[1]!.url, new RegExp(B));
  await h.calls[1]!.reply(200, page(['b1']));
  assert.deepEqual(ids(reads), ['b1']);
  reads.close();
});

test('Activity A → B → A: the first answer for A is still dropped', async () => {
  const h = harness();
  const reads = new ActivityReads(h.deps);
  reads.show(A, W1);
  reads.show(B, W1);
  reads.show(A, W1);
  assert.equal(h.calls.length, 3);
  await h.calls[0]!.reply(200, page(['stale']));
  assert.equal(reads.getSnapshot().feed, null, 'the first A answer is from an ended generation');
  await h.calls[1]!.reply(200, page(['b1']));
  assert.equal(reads.getSnapshot().feed, null);
  await h.calls[2]!.reply(200, page(['fresh']));
  assert.deepEqual(ids(reads), ['fresh']);
  reads.close();
});

test('Activity: the same agent in another workspace drops the first workspace’s answer', async () => {
  const h = harness();
  const reads = new ActivityReads(h.deps);
  reads.show(A, W1);
  reads.show(A, W2);
  assert.deepEqual(h.calls[1]!.headers, { 'X-City-Workspace': W2 });
  await h.calls[0]!.reply(200, page(['w1']));
  assert.equal(reads.getSnapshot().feed, null);
  await h.calls[1]!.reply(200, page(['w2']));
  assert.deepEqual(ids(reads), ['w2']);
  reads.close();
});

test('Activity: Show older after A → B is dropped, also once B shows its own feed', async () => {
  const h = harness();
  const reads = new ActivityReads(h.deps);
  reads.show(A, W1);
  await h.calls[0]!.reply(200, page(['a2'], 'cursor-a'));
  void reads.showOlder();
  assert.equal(reads.getSnapshot().older, true);
  const older = h.calls[1]!;
  assert.match(older.url, new RegExp(`/api/agents/${A}/activity\?.*before=cursor-a`));
  assert.deepEqual(older.headers, { 'X-City-Workspace': W1 });
  reads.show(B, W1);
  assert.equal(older.signal?.aborted, true);
  assert.equal(reads.getSnapshot().older, false, 'B starts without A’s paging');
  await h.calls[2]!.reply(200, page(['b2'], 'cursor-b'));
  await older.reply(200, page(['a1'], 'cursor-a-older'));
  assert.deepEqual(ids(reads), ['b2'], 'A’s older page never joins B’s feed');
  assert.equal(reads.getSnapshot().feed?.nextBefore, 'cursor-b');
  assert.equal(reads.getSnapshot().older, false);
  reads.close();
});

test('Activity: Show older after A → B → A is dropped', async () => {
  const h = harness();
  const reads = new ActivityReads(h.deps);
  reads.show(A, W1);
  await h.calls[0]!.reply(200, page(['a2'], 'cursor-a'));
  void reads.showOlder();
  const older = h.calls[1]!;
  reads.show(B, W1);
  reads.show(A, W1);
  await h.calls[3]!.reply(200, page(['a2'], 'cursor-a'));
  // The older page asked by the first A answers now: it belongs to an ended generation.
  await older.reply(200, page(['a1'], 'cursor-a-older'));
  assert.deepEqual(ids(reads), ['a2']);
  assert.equal(reads.getSnapshot().feed?.nextBefore, 'cursor-a');
  assert.equal(reads.getSnapshot().older, false);
  reads.close();
});

test('Activity: Show older after a workspace switch is dropped', async () => {
  const h = harness();
  const reads = new ActivityReads(h.deps);
  reads.show(A, W1);
  await h.calls[0]!.reply(200, page(['a2'], 'cursor-a'));
  void reads.showOlder();
  const older = h.calls[1]!;
  reads.show(A, W2);
  await h.calls[2]!.reply(200, page(['w2'], 'cursor-w2'));
  await older.reply(200, page(['a1'], 'cursor-w1-older'));
  assert.deepEqual(ids(reads), ['w2']);
  assert.equal(reads.getSnapshot().feed?.nextBefore, 'cursor-w2');
  reads.close();
});

test('Activity: Show older joins the feed and moves the cursor on; a failure says so', async () => {
  const h = harness();
  const reads = new ActivityReads(h.deps);
  reads.show(A, W1);
  await h.calls[0]!.reply(200, page(['3'], 'c1'));
  void reads.showOlder();
  void reads.showOlder(); // one at a time
  assert.equal(h.calls.length, 2);
  await h.calls[1]!.reply(200, page(['2'], 'c2'));
  assert.deepEqual(ids(reads), ['3', '2']);
  assert.equal(reads.getSnapshot().feed?.nextBefore, 'c2');
  void reads.showOlder();
  await h.calls[2]!.reply(500, { error: 'boom' });
  assert.equal(reads.getSnapshot().older, false);
  assert.ok(reads.getSnapshot().olderError);
  assert.deepEqual(ids(reads), ['3', '2']);
  reads.close();
});

test('Activity re-reads the newest page every 10 s while visible; a failed refresh keeps the feed', async () => {
  const h = harness();
  const reads = new ActivityReads(h.deps);
  reads.show(A, W1);
  await h.calls[0]!.reply(200, page(['1'], 'c1'));
  await h.advance(ACTIVITY_POLL_MS);
  assert.equal(h.calls.length, 2);
  assert.doesNotMatch(h.calls[1]!.url, /before=/);
  assert.deepEqual(h.calls[1]!.headers, { 'X-City-Workspace': W1 });
  await h.calls[1]!.reply(200, page(['2', '1'], 'c9'));
  assert.deepEqual(ids(reads), ['2', '1']);
  assert.equal(reads.getSnapshot().feed?.nextBefore, 'c1', 'a refresh keeps the older cursor');
  await h.advance(ACTIVITY_POLL_MS);
  await h.calls[2]!.reply(503, null);
  assert.deepEqual(ids(reads), ['2', '1']);
  assert.equal(reads.getSnapshot().error, null);
  reads.close();
});

test('Activity does not refresh while the page is hidden', async () => {
  const h = harness({ visible: false });
  const reads = new ActivityReads(h.deps);
  reads.show(A, W1);
  await h.calls[0]!.reply(200, page(['1']));
  await h.advance(ACTIVITY_POLL_MS * 3);
  assert.equal(h.calls.length, 1);
  reads.close();
});

test('Activity: a refresh answering after the screen closed is dropped, and no timer fires after', async () => {
  const h = harness();
  const reads = new ActivityReads(h.deps);
  let changes = 0;
  reads.subscribe(() => changes++);
  reads.show(A, W1);
  await h.calls[0]!.reply(200, page(['1']));
  await h.advance(ACTIVITY_POLL_MS);
  const refresh = h.calls[1]!;
  reads.close();
  assert.equal(refresh.signal?.aborted, true);
  const before = changes;
  await refresh.reply(200, page(['late', '1']));
  assert.equal(changes, before, 'nothing changes after close');
  assert.equal(reads.getSnapshot().feed, null);
  assert.equal(reads.getSnapshot().scope, null);
  await h.advance(ACTIVITY_POLL_MS * 3);
  assert.equal(h.calls.length, 2, 'no refresh after close');
});

test('Activity: a refresh started for A and answering after A → B is dropped', async () => {
  const h = harness();
  const reads = new ActivityReads(h.deps);
  reads.show(A, W1);
  await h.calls[0]!.reply(200, page(['a1']));
  await h.advance(ACTIVITY_POLL_MS);
  const refresh = h.calls[1]!;
  reads.show(B, W1);
  await refresh.reply(200, page(['a2', 'a1']));
  assert.equal(reads.getSnapshot().feed, null);
  await h.calls[2]!.reply(200, page([]));
  assert.deepEqual(ids(reads), []);
  reads.close();
});

test('Activity: a failed first read shows the error; Try again reads again; a timeout says so', async () => {
  const h = harness();
  const reads = new ActivityReads(h.deps);
  reads.show(A, W1);
  await h.calls[0]!.reply(500, { error: 'nope' });
  assert.ok(reads.getSnapshot().error);
  reads.reload();
  assert.equal(reads.getSnapshot().error, null);
  assert.equal(h.calls.length, 2);
  await h.calls[1]!.reply(200, page(['1']));
  assert.deepEqual(ids(reads), ['1']);
  reads.close();

  // A read that hangs is given up at its deadline (here shorter than the refresh).
  const t = harness({ deadlineMs: 5_000 });
  const timed = new ActivityReads(t.deps);
  timed.show(A, W1);
  const stuck = t.calls[0]!;
  stuck.signal?.addEventListener('abort', () => void stuck.reply(0, null));
  await t.advance(5_000);
  await settle();
  assert.equal(timed.getSnapshot().error?.name, 'TimeoutError');
  timed.close();
});

/* ---------- Activity names ---------- */

const ROOM_1 = 'aaaaaaa1-0000-4000-8000-000000000001';
const call = (h: ReturnType<typeof harness>, path: string) =>
  h.calls.find((item) => new URL(item.url, 'http://x').pathname === path)!;

test('Activity names: the owner snapshot and the rooms list of the workspace shown', async () => {
  const h = harness();
  const reads = new ActivityNameReads(h.deps);
  reads.show(A, W1);
  assert.deepEqual(
    h.calls.map((item) => [item.url, item.headers]),
    [
      ['/api/snapshot', { 'X-City-Workspace': W1 }],
      ['/api/rooms', { 'X-City-Workspace': W1 }],
    ],
  );
  await call(h, '/api/snapshot').reply(200, { agents: [{ id: B, name: 'Scout helper' }] });
  // Nothing until both have answered.
  assert.equal(reads.getSnapshot().names, null);
  await call(h, '/api/rooms').reply(200, { rooms: [{ id: ROOM_1, name: 'Q4 review' }] });
  const names = reads.getSnapshot().names!;
  assert.equal(names.agents.get(B), 'Scout helper');
  assert.equal(names.rooms.get(ROOM_1), 'Q4 review');
  assert.equal(names.ownerAgents, true);
  reads.close();
  assert.equal(reads.getSnapshot().names, null);
});

test('Activity names: a failed read leaves its names out; without the snapshot no agent is another owner’s', async () => {
  const h = harness();
  const reads = new ActivityNameReads(h.deps);
  reads.show(A, null);
  await call(h, '/api/snapshot').reply(500, { error: 'nope' });
  await call(h, '/api/rooms').reply(200, { rooms: [{ id: ROOM_1, name: 'Q4 review' }] });
  const names = reads.getSnapshot().names!;
  assert.equal(names.ownerAgents, false);
  assert.equal(names.agents.size, 0);
  assert.equal(names.rooms.get(ROOM_1), 'Q4 review');
  // Try again reads both again.
  reads.reload();
  assert.equal(h.calls.length, 4);
  await h.calls[2]!.reply(200, { agents: [{ id: B, name: 'Scout helper' }] });
  await h.calls[3]!.reply(500, { error: 'nope' });
  assert.equal(reads.getSnapshot().names!.ownerAgents, true);
  assert.equal(reads.getSnapshot().names!.rooms.size, 0);
  reads.close();
});

test('Activity names: answers for A after A → B, or after close, are dropped', async () => {
  const h = harness();
  const reads = new ActivityNameReads(h.deps);
  reads.show(A, W1);
  const [snapA, roomsA] = h.calls;
  reads.show(B, W1);
  await snapA!.reply(200, { agents: [{ id: A, name: 'Old' }] });
  await roomsA!.reply(200, { rooms: [] });
  assert.equal(reads.getSnapshot().names, null);
  await h.calls[2]!.reply(200, { agents: [{ id: B, name: 'Scout helper' }] });
  await h.calls[3]!.reply(200, { rooms: [] });
  assert.equal(reads.getSnapshot().names!.agents.get(A), undefined);
  assert.equal(reads.getSnapshot().names!.agents.get(B), 'Scout helper');
  reads.show(A, W2);
  const [snapW2, roomsW2] = h.calls.slice(4);
  reads.close();
  await snapW2!.reply(200, { agents: [{ id: A, name: 'Late' }] });
  await roomsW2!.reply(200, { rooms: [] });
  assert.equal(reads.getSnapshot().names, null);
  assert.equal(reads.getSnapshot().scope, null);
});

/** Runs a hook once both name reads have answered (each passed its own check), before the pair is set. */
class HookedNameReads extends ActivityNameReads {
  afterBoth: (() => void) | null = null;
  private answered = 0;
  protected override async read<T>(lane: string, path: (agentId: string) => string) {
    const outcome = await super.read<T>(lane, path);
    if (outcome && ++this.answered === 2) {
      this.answered = 0;
      const hook = this.afterBoth;
      this.afterBoth = null;
      hook?.();
    }
    return outcome;
  }
}

test('Activity names: a switch or close after both reads answered, before the pair is set, drops it (A → B → A too)', async () => {
  const h = harness();
  const reads = new HookedNameReads(h.deps);
  // Close between the answers and the commit: nothing is set.
  reads.show(A, W1);
  reads.afterBoth = () => reads.close();
  await call(h, '/api/snapshot').reply(200, { agents: [{ id: A, name: 'Stale' }] });
  await call(h, '/api/rooms').reply(200, { rooms: [] });
  assert.equal(reads.getSnapshot().names, null);
  assert.equal(reads.getSnapshot().scope, null);
  // A → B at the same point: B's names come only from B's own reads.
  reads.show(A, W1);
  const [snapA, roomsA] = h.calls.slice(2);
  reads.afterBoth = () => reads.show(B, W1);
  await snapA!.reply(200, { agents: [{ id: A, name: 'Stale' }] });
  await roomsA!.reply(200, { rooms: [] });
  assert.equal(reads.getSnapshot().names, null);
  // … and back to A: the first A pair is still dropped; only the new A reads count.
  reads.show(A, W1);
  const [snapA2, roomsA2] = h.calls.slice(-2);
  await snapA2!.reply(200, { agents: [{ id: A, name: 'Fresh' }] });
  await roomsA2!.reply(200, { rooms: [] });
  assert.equal(reads.getSnapshot().names!.agents.get(A), 'Fresh');
  reads.close();
});

/* ---------- Developer details ---------- */

const snapshotWith = (...agents: Array<Record<string, unknown>>) => ({
  agents: agents.map((over) => ({
    capability: 'research',
    mode: 'external',
    createdAt: '2026-10-10T07:19:00.000Z',
    revokedAt: null,
    manifestName: null,
    revision: null,
    credentialHint: '…a91f',
    ...over,
  })),
});

test('Developer reads the owner snapshot of the workspace it shows, and finds its agent', async () => {
  const h = harness();
  const reads = new DeveloperReads(h.deps);
  reads.show(A, W1);
  assert.equal(reads.getSnapshot().loading, true);
  assert.equal(h.calls[0]!.url, '/api/snapshot');
  assert.deepEqual(h.calls[0]!.headers, { 'X-City-Workspace': W1 });
  await h.calls[0]!.reply(200, snapshotWith({ id: B }, { id: A }));
  const snap = reads.getSnapshot();
  assert.equal(snap.loading, false);
  assert.equal(snap.view?.id, A);
  assert.equal(snap.view?.key, '…a91f');
  assert.equal(snap.missing, false);
  reads.close();
});

test('Developer: an agent the snapshot does not have is missing', async () => {
  const h = harness();
  const reads = new DeveloperReads(h.deps);
  reads.show(A, W1);
  await h.calls[0]!.reply(200, snapshotWith({ id: B }));
  assert.equal(reads.getSnapshot().view, null);
  assert.equal(reads.getSnapshot().missing, true);
  reads.close();
});

test('Developer A → B and A → B → A: late snapshots are dropped', async () => {
  const h = harness();
  const reads = new DeveloperReads(h.deps);
  reads.show(A, W1);
  reads.show(B, W1);
  await h.calls[0]!.reply(200, snapshotWith({ id: A }, { id: B }));
  assert.equal(reads.getSnapshot().view, null);
  assert.equal(reads.getSnapshot().loading, true);
  reads.show(A, W1);
  await h.calls[1]!.reply(200, snapshotWith({ id: A }, { id: B }));
  assert.equal(reads.getSnapshot().view, null, 'B’s answer does not count for A');
  await h.calls[2]!.reply(200, snapshotWith({ id: A }));
  assert.equal(reads.getSnapshot().view?.id, A);
  reads.close();
});

test('Developer: a workspace switch reads the new workspace and drops the old answer', async () => {
  const h = harness();
  const reads = new DeveloperReads(h.deps);
  reads.show(A, W1);
  reads.show(A, W2);
  assert.deepEqual(h.calls[1]!.headers, { 'X-City-Workspace': W2 });
  await h.calls[0]!.reply(200, snapshotWith({ id: A, credentialHint: '…w1w1' }));
  assert.equal(reads.getSnapshot().view, null);
  await h.calls[1]!.reply(200, snapshotWith({ id: A, credentialHint: '…w2w2' }));
  assert.equal(reads.getSnapshot().view?.key, '…w2w2');
  reads.close();
});

test('Developer: a snapshot answering after close is dropped', async () => {
  const h = harness();
  const reads = new DeveloperReads(h.deps);
  reads.show(A, W1);
  reads.close();
  await h.calls[0]!.reply(200, snapshotWith({ id: A }));
  assert.equal(reads.getSnapshot().view, null);
  assert.equal(reads.getSnapshot().scope, null);
});

test('Developer: copying the ID leaves a short note that belongs to this agent', async () => {
  const h = harness();
  const reads = new DeveloperReads(h.deps);
  reads.show(A, W1);
  await h.calls[0]!.reply(200, snapshotWith({ id: A }, { id: B }));
  const written: string[] = [];
  await reads.copyId(async (text) => void written.push(text));
  assert.deepEqual(written, [A]);
  assert.equal(reads.getSnapshot().copy, 'copied');
  await h.advance(COPY_NOTE_MS);
  assert.equal(reads.getSnapshot().copy, null);
  await reads.copyId(async () => {
    throw new Error('denied');
  });
  assert.equal(reads.getSnapshot().copy, 'failed');

  // Another agent starts without the note, and its timer is gone with it.
  reads.show(B, W1);
  assert.equal(reads.getSnapshot().copy, null);
  await h.calls[1]!.reply(200, snapshotWith({ id: A }, { id: B }));
  assert.equal(reads.getSnapshot().copy, null);

  // A clipboard answering after a switch leaves no note on the next agent.
  let release: () => void = () => {};
  const copying = reads.copyId(() => new Promise<void>((resolve) => (release = resolve)));
  reads.show(A, W1);
  release();
  await copying;
  assert.equal(reads.getSnapshot().copy, null);
  reads.close();
});
