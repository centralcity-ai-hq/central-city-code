import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BaseRegistrationController,
  type ControllerDeps,
} from '../src/base/baseRegistrationController';
import {
  KNOWN_STATUS_LIMIT,
  forgetAllStatuses,
  knownStatus,
  rememberStatus,
} from '../src/base/baseStatusCache';
import { baseScreenState } from '../src/agents/v4/baseScreenModel';

/*
 * The Base registration controller behind both Base panels, with a scripted server and a manual
 * clock: answers arrive only when a test releases them, so a late answer can be placed exactly.
 */

const OWNER_A = `0x${'aa'.repeat(20)}`;
const OWNER_B = `0x${'bb'.repeat(20)}`;
let ids = 0;
/** A fresh agent id per test: the controller remembers owners per agent for the page session. */
const agent = (name: string) => `${name}-${++ids}-0000-4000-8000-000000000000`;

interface Call {
  url: string;
  method: string;
  body: Record<string, unknown> | null;
  headers: Record<string, string>;
  reply: (status: number, json: unknown) => Promise<void>;
  settled: boolean;
}

function harness() {
  const calls: Call[] = [];
  let clock = 1_000_000;
  let nextTimer = 1;
  const timers = new Map<number, { at: number; run: () => void }>();
  const deps: ControllerDeps = {
    fetch: ((url: string, init: RequestInit) =>
      new Promise((resolve) => {
        const call: Call = {
          url,
          method: init.method ?? 'GET',
          body: init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null,
          headers: (init.headers ?? {}) as Record<string, string>,
          settled: false,
          reply: async (status, json) => {
            call.settled = true;
            resolve({
              ok: status >= 200 && status < 300,
              status,
              json: async () => json,
              headers: { get: () => null },
            } as unknown as Response);
            await settle();
          },
        };
        calls.push(call);
      })) as unknown as typeof fetch,
    setTimeout: (run, ms) => {
      const id = nextTimer++;
      timers.set(id, { at: clock + ms, run });
      return id;
    },
    clearTimeout: (id) => void timers.delete(id as number),
    now: () => clock,
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
  const open = (method?: string) =>
    calls.filter((call) => !call.settled && (!method || call.method === method));
  return { calls, deps, advance, open };
}

async function settle() {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
}

const inProgress = (agentUri = 'https://centralcity.ai/a/k3P9xQ') => ({
  state: 'submitted',
  stage: 'registering',
  erc8004AgentId: null,
  agentUri,
  pollAfterMs: 2000,
});

test('switching A to B while A’s registration is pending: B never shows A and never sends A’s owner', async () => {
  const h = harness();
  const a = agent('a');
  const b = agent('b');
  const first = new BaseRegistrationController(a, 'ws-1', { deps: h.deps });
  first.start();
  await h.open('GET')[0]!.reply(200, { identities: [] });
  first.setAddress(OWNER_A);
  first.submit();
  await settle();
  const pendingA = h.open('POST')[0]!;
  assert.ok(pendingA.url.includes(a));
  assert.equal(first.getSnapshot().busy, true);

  // The pane switches to B: A's controller stops, B's starts.
  first.stop();
  const second = new BaseRegistrationController(b, 'ws-1', { deps: h.deps });
  second.start();
  assert.equal(second.getSnapshot().identity, null);
  assert.equal(second.getSnapshot().owner, null);
  assert.equal(second.getSnapshot().address, '');
  assert.equal(second.getSnapshot().busy, false);

  // A's answer arrives late: it changes nothing anywhere.
  const before = first.getSnapshot();
  await pendingA.reply(200, {
    wallet: { address: `0x${'cd'.repeat(20)}`, ownerAddress: OWNER_A, state: 'derived' },
    identity: { ...inProgress('https://centralcity.ai/a/AAAAAA'), provisionalAgentId: '1' },
  });
  assert.equal(first.getSnapshot(), before);
  assert.equal(second.getSnapshot().identity, null);
  assert.equal(second.getSnapshot().wallet, null);

  // B reads its own registration in progress and advances with its own owner only.
  await h.open('GET')[0]!.reply(200, {
    identities: [
      {
        chainId: 8453,
        ...inProgress('https://centralcity.ai/a/BBBBBB'),
        wallet: { address: `0x${'ef'.repeat(20)}`, ownerAddress: OWNER_B, state: 'derived' },
      },
    ],
  });
  assert.equal(second.getSnapshot().identity?.agentUri, 'https://centralcity.ai/a/BBBBBB');
  assert.equal(second.getSnapshot().owner, OWNER_B);
  await h.advance(10_000);
  const toB = h.calls.filter((call) => call.url.includes(b));
  assert.ok(toB.some((call) => call.method === 'POST'));
  for (const call of toB) {
    assert.notEqual(call.body?.ownerAddress, OWNER_A);
    assert.equal(call.headers['X-City-Workspace'], 'ws-1');
  }
  // Nothing more ever goes to A after the switch.
  assert.equal(h.calls.filter((call) => call.url.includes(a)).length, 2);
  second.stop();
});

test('a poll of A that is due or on its way when A is left is dropped', async () => {
  const h = harness();
  const a = agent('a');
  const first = new BaseRegistrationController(a, null, { deps: h.deps });
  first.start();
  await h.open('GET')[0]!.reply(200, {
    identities: [{ chainId: 8453, ...inProgress(), wallet: { ownerAddress: OWNER_A } }],
  });
  // Resumed with the bound owner; its answer sets up the next poll.
  await h
    .open('POST')[0]!
    .reply(200, { wallet: { ownerAddress: OWNER_A }, identity: inProgress() });
  assert.equal(first.getSnapshot().polling, true);
  // The next poll goes out, and A is left while it is on its way.
  await h.advance(2000);
  const late = h.open('POST')[0]!;
  first.stop();
  const shown = first.getSnapshot();
  await late.reply(200, {
    wallet: { ownerAddress: OWNER_A },
    identity: { ...inProgress(), state: 'confirmed', stage: 'confirmed', erc8004AgentId: '9' },
  });
  assert.equal(first.getSnapshot(), shown);
  // No timer of A's fires after it is left.
  const sent = h.calls.length;
  await h.advance(120_000);
  assert.equal(h.calls.length, sent);
});

test('a restarted controller (as a re-mounted pane) drops the answer of its earlier run', async () => {
  const h = harness();
  const a = agent('a');
  const controller = new BaseRegistrationController(a, null, { deps: h.deps });
  controller.start();
  const stale = h.open('GET')[0]!;
  controller.stop();
  controller.start();
  await stale.reply(200, {
    identities: [{ chainId: 8453, ...inProgress('https://centralcity.ai/a/STALE1') }],
  });
  assert.equal(controller.getSnapshot().loading, true);
  assert.equal(controller.getSnapshot().identity, null);
  await h.open('GET')[0]!.reply(200, { identities: [] });
  assert.equal(controller.getSnapshot().loading, false);
  assert.equal(controller.getSnapshot().identity, null);
  controller.stop();
});

test('read-only never sends a registration, and re-reads only while one is in progress', async () => {
  const h = harness();
  const a = agent('a');
  const status = new BaseRegistrationController(a, 'ws-2', { readOnly: true, deps: h.deps });
  status.start();
  await h.open('GET')[0]!.reply(200, {
    identities: [{ chainId: 8453, ...inProgress(), wallet: { ownerAddress: OWNER_A } }],
  });
  // Every action is a no-op, even with an owner known to the server.
  status.setAddress(OWNER_A);
  status.submit();
  status.retryNow();
  status.checkAgain();
  status.continueWithBound(OWNER_A, true);
  await settle();
  assert.equal(status.getSnapshot().polling, true);
  // It re-reads as often as the server says, until the registration is finished.
  await h.advance(2000);
  await h.open('GET')[0]!.reply(200, {
    identities: [{ chainId: 8453, ...inProgress(), stage: 'finalizing', provisionalAgentId: '5' }],
  });
  await h.advance(2000);
  await h.open('GET')[0]!.reply(200, {
    identities: [
      {
        chainId: 8453,
        ...inProgress(),
        state: 'confirmed',
        stage: 'confirmed',
        erc8004AgentId: '5',
      },
    ],
  });
  assert.equal(status.getSnapshot().stage, 'confirmed');
  assert.equal(status.getSnapshot().polling, false);
  const reads = h.calls.length;
  await h.advance(120_000);
  assert.equal(h.calls.length, reads);
  assert.equal(h.calls.filter((call) => call.method !== 'GET').length, 0);
  for (const call of h.calls) assert.equal(call.headers['X-City-Workspace'], 'ws-2');
  status.stop();
});

test('a 404 status read is "not available", not an empty registration', async () => {
  const h = harness();
  const controller = new BaseRegistrationController(agent('a'), null, { deps: h.deps });
  controller.start();
  await h.open('GET')[0]!.reply(404, { error: 'Not found.' });
  assert.equal(controller.getSnapshot().loadFailed, true);
  assert.equal(controller.getSnapshot().notAvailable, true);
  controller.stop();
});

test('the wait for a Base ID is timed from the server’s start, else from when it was first seen', async () => {
  const h = harness();
  const controller = new BaseRegistrationController(agent('a'), null, {
    readOnly: true,
    deps: h.deps,
  });
  controller.start();
  await h.open('GET')[0]!.reply(200, { identities: [{ chainId: 8453, ...inProgress() }] });
  const seen = controller.getSnapshot().waitingSince;
  assert.equal(typeof seen, 'number');
  await h.advance(2000);
  await h.open('GET')[0]!.reply(200, {
    identities: [{ chainId: 8453, ...inProgress(), startedAt: 42 }],
  });
  assert.equal(controller.getSnapshot().waitingSince, 42);
  await h.advance(2000);
  await h.open('GET')[0]!.reply(200, {
    identities: [{ chainId: 8453, ...inProgress(), stage: 'finalizing', provisionalAgentId: '1' }],
  });
  assert.equal(controller.getSnapshot().waitingSince, null);
  controller.stop();
});

/*
 * Make public for Base (decision G4, option B): a private agent with a profile is made public on
 * the owner's yes to one question, then registers exactly as a public agent does.
 */

type Harness = ReturnType<typeof harness>;

/** A controller for a private agent, its status read answered (nothing registered yet). */
async function privateAgent(h: Harness, id: string, workspace: string | null) {
  const controller = new BaseRegistrationController(id, workspace, { deps: h.deps });
  controller.start();
  await h
    .open('GET')
    .find((call) => call.url.includes(id))!
    .reply(200, { identities: [] });
  controller.setAddress(OWNER_A);
  return controller;
}

/** The state the v4 Base screen shows for a private agent with a profile. */
const screen = (controller: BaseRegistrationController) =>
  baseScreenState({ ...controller.getSnapshot(), isPublic: false, hasProfile: true, now: 0 });

const sent = (h: Harness, id: string, method: string) =>
  h.calls.filter((call) => call.url.includes(id) && call.method === method);

const madePublic = (id: string) => ({ agent: { id, visibility: 'public' }, changed: true });

test('make public: nothing is sent before the yes; then PATCH public and the registration, in the controller’s workspace', async () => {
  const h = harness();
  const a = agent('a');
  const controller = await privateAgent(h, a, 'ws-9');
  assert.equal(screen(controller), 'start');
  // The yes counts only after the question was asked.
  controller.makePublicAndRegister();
  await settle();
  assert.equal(h.calls.length, 1);
  controller.askMakePublic();
  assert.equal(controller.getSnapshot().confirmingPublic, true);
  assert.equal(screen(controller), 'confirm');
  assert.equal(h.calls.length, 1);

  let changed = 0;
  controller.makePublicAndRegister(() => changed++);
  // A second click (or Cancel) while the change is on its way does nothing.
  controller.makePublicAndRegister(() => changed++);
  controller.cancelMakePublic();
  await settle();
  const patches = sent(h, a, 'PATCH');
  assert.equal(patches.length, 1);
  const patch = patches[0]!;
  assert.ok(patch.url.endsWith(`/api/agents/${a}`));
  assert.deepEqual(patch.body, { visibility: 'public' });
  assert.equal(patch.headers['X-City-Workspace'], 'ws-9');
  assert.equal(patch.headers['X-City-Request'], '1');
  // Nothing registers before the profile is public; the question stays, busy.
  assert.equal(sent(h, a, 'POST').length, 0);
  assert.equal(controller.getSnapshot().busy, true);
  assert.equal(screen(controller), 'confirm');

  await patch.reply(200, madePublic(a));
  assert.equal(changed, 1);
  assert.equal(controller.getSnapshot().madePublic, true);
  assert.equal(controller.getSnapshot().confirmingPublic, false);
  assert.equal(screen(controller), 'registering');
  const register = h.open('POST')[0]!;
  assert.ok(register.url.endsWith(`/api/base/agents/${a}/register`));
  assert.deepEqual(register.body, { ownerAddress: OWNER_A });
  assert.equal(register.headers['X-City-Workspace'], 'ws-9');
  assert.deepEqual(
    h.calls.map((call) => call.method),
    ['GET', 'PATCH', 'POST'],
  );
  await register.reply(200, {
    wallet: { address: `0x${'cd'.repeat(20)}`, ownerAddress: OWNER_A, state: 'derived' },
    identity: inProgress(),
  });
  assert.equal(controller.getSnapshot().stage, 'registering');
  assert.equal(controller.getSnapshot().owner, OWNER_A);
  assert.equal(controller.getSnapshot().polling, true);
  controller.stop();
});

test('make public: Cancel goes back to the offer and sends nothing; a bad address is never asked about', async () => {
  const h = harness();
  const controller = await privateAgent(h, agent('a'), null);
  controller.setAddress('0x123');
  controller.askMakePublic();
  assert.equal(controller.getSnapshot().confirmingPublic, false);
  assert.match(controller.getSnapshot().error, /wallet address/);
  controller.setAddress(OWNER_A);
  controller.askMakePublic();
  assert.equal(controller.getSnapshot().error, '');
  assert.equal(screen(controller), 'confirm');
  controller.cancelMakePublic();
  assert.equal(screen(controller), 'start');
  assert.equal(controller.getSnapshot().address, OWNER_A);
  // A yes after Cancel is no yes: the question has to be asked again.
  controller.makePublicAndRegister();
  await h.advance(120_000);
  assert.deepEqual(
    h.calls.map((call) => call.method),
    ['GET'],
  );
  controller.stop();
});

test('make public: an agent or workspace switch while the change is on its way drops its answer and never registers', async () => {
  for (const to of ['agent', 'workspace'] as const) {
    const h = harness();
    const a = agent('a');
    const first = await privateAgent(h, a, 'ws-1');
    first.askMakePublic();
    let changed = 0;
    first.makePublicAndRegister(() => changed++);
    await settle();
    const pending = h.open('PATCH')[0]!;

    // The pane switches: the first controller stops, the next one starts.
    first.stop();
    const next =
      to === 'agent'
        ? new BaseRegistrationController(agent('b'), 'ws-1', { deps: h.deps })
        : new BaseRegistrationController(a, 'ws-2', { deps: h.deps });
    next.start();
    const shown = first.getSnapshot();
    await pending.reply(200, madePublic(a));
    assert.equal(first.getSnapshot(), shown, to);
    assert.equal(changed, 0, to);
    assert.equal(next.getSnapshot().madePublic, false, to);
    assert.equal(next.getSnapshot().busy, false, to);
    await h.open('GET')[0]!.reply(200, { identities: [] });
    await h.advance(120_000);
    // Nothing was registered, for either.
    assert.equal(h.calls.filter((call) => call.method === 'POST').length, 0, to);
    assert.equal(screen(next), 'start', to);
    next.stop();
  }
});

test('make public: A, then B, then A again never takes the first A’s answer', async () => {
  const h = harness();
  const a = agent('a');
  const b = agent('b');
  const firstA = await privateAgent(h, a, 'ws-1');
  firstA.askMakePublic();
  let changedFirst = 0;
  firstA.makePublicAndRegister(() => changedFirst++);
  await settle();
  const late = h.open('PATCH')[0]!;
  firstA.stop();
  const onB = new BaseRegistrationController(b, 'ws-1', { deps: h.deps });
  onB.start();
  onB.stop();
  const againA = await privateAgent(h, a, 'ws-1');
  assert.equal(againA.getSnapshot().confirmingPublic, false);

  await late.reply(200, madePublic(a));
  assert.equal(changedFirst, 0);
  assert.equal(againA.getSnapshot().madePublic, false);
  assert.equal(againA.getSnapshot().busy, false);
  assert.equal(screen(againA), 'start');
  assert.equal(h.calls.filter((call) => call.method === 'POST').length, 0);

  // The second A asks for itself, and only its own answer registers it.
  againA.askMakePublic();
  let changedAgain = 0;
  againA.makePublicAndRegister(() => changedAgain++);
  await settle();
  const own = h.open('PATCH')[0]!;
  assert.notEqual(own, late);
  await own.reply(200, { agent: { id: a, visibility: 'public' }, changed: false });
  assert.equal(changedAgain, 1);
  assert.equal(sent(h, a, 'POST').length, 1);
  assert.equal(sent(h, b, 'POST').length, 0);
  againA.stop();
});

test('make public: a restarted controller drops the answer of its earlier run and is not left busy', async () => {
  const h = harness();
  const a = agent('a');
  const controller = await privateAgent(h, a, null);
  controller.askMakePublic();
  controller.makePublicAndRegister();
  await settle();
  const late = h.open('PATCH')[0]!;
  controller.stop();
  controller.start();
  assert.equal(controller.getSnapshot().busy, false);
  await h.open('GET')[0]!.reply(200, { identities: [] });
  await late.reply(200, madePublic(a));
  assert.equal(controller.getSnapshot().madePublic, false);
  assert.equal(h.calls.filter((call) => call.method === 'POST').length, 0);
  controller.stop();
});

test('make public: 409 no_profile is "not available", and nothing registers', async () => {
  const h = harness();
  const controller = await privateAgent(h, agent('a'), null);
  controller.askMakePublic();
  let changed = 0;
  controller.makePublicAndRegister(() => changed++);
  await settle();
  await h.open('PATCH')[0]!.reply(409, {
    error:
      'This agent was created without a profile, so it cannot be made public. Create a new agent with a public profile instead.',
    code: 'no_profile',
  });
  const snapshot = controller.getSnapshot();
  assert.equal(snapshot.noProfile, true);
  assert.equal(snapshot.confirmingPublic, false);
  assert.equal(snapshot.busy, false);
  assert.equal(snapshot.madePublic, false);
  assert.equal(screen(controller), 'unavailable');
  assert.equal(changed, 0);
  await h.advance(120_000);
  assert.equal(h.calls.filter((call) => call.method === 'POST').length, 0);
  controller.stop();
});

test('make public: any other refusal keeps the question with the reason, and the yes can be given again', async () => {
  const h = harness();
  const a = agent('a');
  const controller = await privateAgent(h, a, null);
  controller.askMakePublic();
  controller.makePublicAndRegister();
  await settle();
  await h.open('PATCH')[0]!.reply(500, { error: 'Internal error.' });
  assert.equal(screen(controller), 'confirm');
  assert.equal(controller.getSnapshot().busy, false);
  assert.equal(controller.getSnapshot().error, 'The profile couldn’t be made public. Try again.');
  assert.equal(h.calls.filter((call) => call.method === 'POST').length, 0);
  controller.makePublicAndRegister();
  await settle();
  assert.equal(controller.getSnapshot().error, '');
  await h.open('PATCH')[0]!.reply(200, madePublic(a));
  assert.equal(sent(h, a, 'POST').length, 1);
  controller.stop();
});

test('make public: a registration that fails afterwards is the normal failed state; the agent is never made private again', async () => {
  const h = harness();
  const a = agent('a');
  const controller = await privateAgent(h, a, 'ws-3');
  controller.askMakePublic();
  controller.makePublicAndRegister();
  await settle();
  await h.open('PATCH')[0]!.reply(200, madePublic(a));
  await h.open('POST')[0]!.reply(200, {
    wallet: { address: `0x${'cd'.repeat(20)}`, ownerAddress: OWNER_A, state: 'derived' },
    identity: { ...inProgress(), state: 'failed', stage: 'failed', canRetry: true },
  });
  assert.equal(controller.getSnapshot().stage, 'failed');
  assert.equal(controller.getSnapshot().madePublic, true);
  assert.equal(screen(controller), 'failed');
  // Try again is the normal retry: a register call with retry, no new PATCH.
  controller.retryNow();
  await settle();
  const retry = h.open('POST')[0]!;
  assert.deepEqual(retry.body, { ownerAddress: OWNER_A, retry: true });
  await retry.reply(500, { error: 'Internal error.' });
  await h.advance(120_000);
  const patches = h.calls.filter((call) => call.method === 'PATCH');
  assert.equal(patches.length, 1);
  assert.deepEqual(patches[0]!.body, { visibility: 'public' });

  // A register call refused outright: its reason shows on the offer, which now registers directly.
  const b = agent('b');
  const other = await privateAgent(h, b, null);
  other.askMakePublic();
  other.makePublicAndRegister();
  await settle();
  await h.open('PATCH')[0]!.reply(200, madePublic(b));
  await h.open('POST')[0]!.reply(503, { error: 'Base registration is not available yet.' });
  assert.equal(other.getSnapshot().error, 'Base registration isn’t available right now.');
  assert.equal(screen(other), 'start');
  other.submit();
  await settle();
  assert.equal(sent(h, b, 'POST').length, 2);
  assert.equal(sent(h, b, 'PATCH').length, 1);
  controller.stop();
  other.stop();
});

/*
 * The last answer per (agent, workspace) (src/base/baseStatusCache.ts): the home row of an agent
 * opened again shows it at once, and a fresh read replaces it.
 */

const confirmedRow = (id: string) => ({
  chainId: 8453,
  ...inProgress(),
  state: 'confirmed',
  stage: 'confirmed',
  erc8004AgentId: id,
  pollAfterMs: null,
});
const failedRow = () => ({ chainId: 8453, ...inProgress(), state: 'failed', stage: 'failed' });

/** The state the v4 home row shows for a public agent. */
const row = (controller: BaseRegistrationController) =>
  baseScreenState({ ...controller.getSnapshot(), isPublic: true, hasProfile: true, now: 0 });

/** A read-only controller (the home row) for `id` that has read `identities` and was left. */
async function readOnce(h: Harness, id: string, workspace: string | null, identities: unknown[]) {
  const status = new BaseRegistrationController(id, workspace, { readOnly: true, deps: h.deps });
  status.start();
  await h
    .open('GET')
    .find((call) => call.url.includes(id))!
    .reply(200, { identities });
  status.stop();
  return status;
}

const rowFor = (h: Harness, id: string, workspace: string | null) =>
  new BaseRegistrationController(id, workspace, { readOnly: true, deps: h.deps });

test('last answer: a re-opened agent shows it at once, and the fresh read replaces it quietly', async () => {
  const h = harness();
  const a = agent('a');
  await readOnce(h, a, 'ws-1', [confirmedRow('7')]);
  // Opened again: the row shows ID 7 before anything is read, and while the fresh read is out.
  const again = rowFor(h, a, 'ws-1');
  assert.equal(again.getSnapshot().loading, false);
  assert.equal(row(again), 'final');
  assert.equal(again.getSnapshot().identity?.erc8004AgentId, '7');
  again.start();
  const fresh = h.open('GET')[0]!;
  assert.ok(fresh.url.includes(a));
  assert.equal(row(again), 'final');
  // The fresh answer replaces it, here and for the next time the agent is opened.
  await fresh.reply(200, { identities: [failedRow()] });
  assert.equal(row(again), 'failed');
  again.stop();
  const third = rowFor(h, a, 'ws-1');
  assert.equal(row(third), 'failed');
  // A registration that is gone on the server is gone from the row as well.
  third.start();
  await h.open('GET')[0]!.reply(200, { identities: [] });
  assert.equal(row(third), 'start');
  third.stop();
  assert.equal(row(rowFor(h, a, 'ws-1')), 'start');
});

test('last answer: never another workspace’s or another agent’s, and never for the full panel', async () => {
  const h = harness();
  const a = agent('a');
  const b = agent('b');
  await readOnce(h, a, 'ws-1', [confirmedRow('7')]);
  for (const [id, workspace] of [
    [a, 'ws-2'],
    [a, null],
    [b, 'ws-1'],
  ] as const) {
    const other = rowFor(h, id, workspace);
    assert.equal(other.getSnapshot().loading, true, `${id} ${workspace}`);
    assert.equal(other.getSnapshot().identity, null);
    assert.equal(row(other), 'loading');
  }
  // The full panel always waits for its own read: it never offers anything on an old answer.
  const panel = new BaseRegistrationController(a, 'ws-1', { deps: h.deps });
  assert.equal(panel.getSnapshot().loading, true);
  assert.equal(panel.getSnapshot().identity, null);
  // Each workspace keeps its own: ws-2's answer leaves ws-1's as it was.
  await readOnce(h, a, 'ws-2', [failedRow()]);
  assert.equal(row(rowFor(h, a, 'ws-1')), 'final');
  assert.equal(row(rowFor(h, a, 'ws-2')), 'failed');
});

test('last answer: an ended run’s late answer never becomes it', async () => {
  const h = harness();
  const a = agent('a');
  const status = rowFor(h, a, 'ws-1');
  status.start();
  const late = h.open('GET')[0]!;
  status.stop();
  await late.reply(200, { identities: [confirmedRow('7')] });
  assert.equal(status.getSnapshot().loading, true);
  const again = rowFor(h, a, 'ws-1');
  assert.equal(again.getSnapshot().loading, true);
  assert.equal(again.getSnapshot().identity, null);
  // A restarted controller's earlier run is dropped the same way.
  await readOnce(h, a, 'ws-1', [confirmedRow('7')]);
  const restarted = rowFor(h, a, 'ws-1');
  restarted.start();
  const stale = h.open('GET')[0]!;
  restarted.stop();
  restarted.start();
  await stale.reply(200, { identities: [failedRow()] });
  assert.equal(row(restarted), 'final');
  assert.equal(row(rowFor(h, a, 'ws-1')), 'final');
  await h.open('GET')[0]!.reply(200, { identities: [confirmedRow('7')] });
  assert.equal(row(rowFor(h, a, 'ws-1')), 'final');
  restarted.stop();
});

test('last answer: a failed read forgets it; "not available" is an answer too', async () => {
  const h = harness();
  const a = agent('a');
  await readOnce(h, a, 'ws-1', [confirmedRow('7')]);
  const again = rowFor(h, a, 'ws-1');
  again.start();
  await h.open('GET')[0]!.reply(503, { error: 'Base registration is not available yet.' });
  // A failed read is never the old answer: the row is unknown, as without one.
  assert.equal(row(again), 'error');
  again.stop();
  assert.equal(row(rowFor(h, a, 'ws-1')), 'loading');
  // 404: "Not available" at once next time, until a fresh answer says otherwise.
  const b = agent('b');
  const missing = rowFor(h, b, 'ws-1');
  missing.start();
  await h.open('GET')[0]!.reply(404, { error: 'Not found.' });
  missing.stop();
  const back = rowFor(h, b, 'ws-1');
  assert.equal(row(back), 'unavailable');
  back.start();
  assert.equal(row(back), 'unavailable');
  await h.open('GET')[0]!.reply(200, { identities: [] });
  assert.equal(back.getSnapshot().notAvailable, false);
  assert.equal(back.getSnapshot().loadFailed, false);
  assert.equal(row(back), 'start');
  back.stop();
});

test('last answer: unpaused, the row keeps its answer while it reads afresh, and polls as before', async () => {
  const h = harness();
  const a = agent('a');
  const status = rowFor(h, a, 'ws-1');
  status.start();
  await h.open('GET')[0]!.reply(200, { identities: [{ chainId: 8453, ...inProgress() }] });
  const since = status.getSnapshot().waitingSince;
  assert.equal(typeof since, 'number');
  status.stop();
  await h.advance(10_000);
  status.start();
  assert.equal(status.getSnapshot().loading, false);
  assert.equal(row(status), 'registering');
  // One read out, and no poll beside it.
  assert.equal(h.open('GET').length, 1);
  await h.advance(10_000);
  assert.equal(h.open('GET').length, 1);
  await h.open('GET')[0]!.reply(200, { identities: [{ chainId: 8453, ...inProgress() }] });
  // The wait is still timed from when it was first seen, also for the agent opened again.
  assert.equal(status.getSnapshot().waitingSince, since);
  await h.advance(2000);
  assert.equal(h.open('GET').length, 1);
  status.stop();
  assert.equal(rowFor(h, a, 'ws-1').getSnapshot().waitingSince, since);
});

test('last answer: the full panel’s answers are the row’s next one', async () => {
  const h = harness();
  const a = agent('a');
  const panel = new BaseRegistrationController(a, 'ws-1', { deps: h.deps });
  panel.start();
  await h.open('GET')[0]!.reply(200, { identities: [] });
  panel.setAddress(OWNER_A);
  panel.submit();
  await settle();
  await h.open('POST')[0]!.reply(200, {
    wallet: { address: `0x${'cd'.repeat(20)}`, ownerAddress: OWNER_A, state: 'derived' },
    identity: { ...confirmedRow('9'), txHash: `0x${'f0'.repeat(32)}` },
  });
  panel.stop();
  const home = rowFor(h, a, 'ws-1');
  assert.equal(row(home), 'final');
  assert.equal(home.getSnapshot().identity?.erc8004AgentId, '9');
});

test('last answer: display only, it never enables an action before the fresh read', async () => {
  const h = harness();
  const ownerWallet = { address: `0x${'cd'.repeat(20)}`, ownerAddress: OWNER_A, state: 'derived' };
  // Last answers that would each offer something: Continue, Try again, and resuming with the
  // owner the server bound.
  const offers = [
    { id: agent('start'), identities: [] },
    { id: agent('failed'), identities: [{ ...failedRow(), canRetry: true }] },
    {
      id: agent('progress'),
      identities: [{ chainId: 8453, ...inProgress(), wallet: ownerWallet }],
    },
  ];
  for (const offer of offers) {
    await readOnce(h, offer.id, 'ws-1', offer.identities);
    // The row shows it at once…
    assert.notEqual(row(rowFor(h, offer.id, 'ws-1')), 'loading');
    // …but the Base screen offers nothing until its own read answers: no form, no button.
    const panel = new BaseRegistrationController(offer.id, 'ws-1', { deps: h.deps });
    assert.equal(panel.getSnapshot().loading, true);
    assert.equal(panel.getSnapshot().identity, null);
    assert.equal(panel.getSnapshot().owner, null);
    assert.equal(row(panel), 'loading');
    panel.start();
    await settle();
    assert.equal(row(panel), 'loading');
    // The fresh read decides, here that the registration is finished: nothing is sent.
    await h
      .open('GET')
      .find((call) => call.url.includes(offer.id))!
      .reply(200, { identities: [confirmedRow('7')] });
    assert.equal(row(panel), 'final');
    panel.stop();
  }
  // The row's own controller sends nothing whatever its last answer says.
  const status = rowFor(h, offers[1]!.id, 'ws-1');
  status.start();
  status.setAddress(OWNER_A);
  status.submit();
  status.retryNow();
  status.checkAgain();
  status.askMakePublic();
  status.makePublicAndRegister();
  status.continueWithBound(OWNER_A, true);
  await settle();
  assert.deepEqual(
    h.calls.filter((call) => call.method !== 'GET'),
    [],
  );
  status.stop();
});

test('last answer: a read of the last person that answers after the switch writes nothing for the next', async () => {
  forgetAllStatuses();
  const h = harness();
  const a = agent('a');
  // Old session: the row's read is out when the person changes (Root clears in render, the
  // controller stops later in effect cleanup).
  const old = rowFor(h, a, null);
  old.start();
  const pending = h.open('GET').find((call) => call.url.includes(a))!;
  forgetAllStatuses();
  await pending.reply(200, { identities: [confirmedRow('7')] });
  assert.equal(knownStatus(a, null), null, 'the old session never writes the new one');
  // A failed late read can't delete the new session's answer either.
  const b = agent('b');
  await readOnce(h, b, null, [confirmedRow('8')]);
  const answer = knownStatus(b, null)!;
  assert.ok(answer);
  const oldB = rowFor(h, b, null);
  oldB.start();
  const pendingB = h.open('GET').find((call) => call.url.includes(b) && !call.settled)!;
  forgetAllStatuses();
  rememberStatus(b, null, answer);
  await pendingB.reply(500, { error: 'nope' });
  assert.ok(knownStatus(b, null), "the old session's failure doesn't forget the new answer");
  old.stop();
  oldB.stop();
});

test('last answer: only the most recent ones are kept, and another person starts without them', () => {
  forgetAllStatuses();
  const view = { identity: null, wallet: null };
  const ids = Array.from({ length: KNOWN_STATUS_LIMIT + 1 }, (_, i) => `limit-${i}`);
  for (const id of ids) rememberStatus(id, 'ws-1', { view, notAvailable: false, seenWaitingAt: 1 });
  assert.equal(knownStatus(ids[0]!, 'ws-1'), null);
  assert.ok(knownStatus(ids[1]!, 'ws-1'));
  assert.ok(knownStatus(ids.at(-1)!, 'ws-1'));
  // A fresh answer counts as the newest.
  rememberStatus(ids[1]!, 'ws-1', { view, notAvailable: true, seenWaitingAt: null });
  rememberStatus('limit-new', 'ws-1', { view, notAvailable: false, seenWaitingAt: null });
  assert.equal(knownStatus(ids[1]!, 'ws-1')?.notAvailable, true);
  assert.equal(knownStatus(ids[2]!, 'ws-1'), null);
  forgetAllStatuses();
  assert.equal(knownStatus('limit-new', 'ws-1'), null);
});
