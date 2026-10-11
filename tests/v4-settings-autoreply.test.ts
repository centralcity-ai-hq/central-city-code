import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  autoReplyKeyAction,
  autoReplyState,
  type AutoReplyState,
} from '../src/agents/v4/settingsActionsModel';
import { NOTICE_MS, SettingsLifecycle, loadOf } from '../src/agents/v4/settingsLifecycle';
import {
  AUTO_REPLY_READS,
  autoReplySheetSend,
  removeAutoReplyKey,
  responderFailure,
  setAutoReply,
  type AutoReplyData,
} from '../src/agents/v4/settingsRequests';
import { KEY_CHECK_TIMEOUT_MS, ResponderError, type ResponderClient } from '../src/responder/api';
import type { SheetSend } from '../src/responder/AutoReply';
import type { ModelOption, ResponderSettingsView } from '../src/responder/contract';
import { harness, settle } from './v4-settings-harness';

/*
 * The v4 Auto-reply screen's key flows on the shared lifecycle: Set up auto-reply and Change key
 * (the agent settings' sheet, its requests sent as the screen's one action) and Remove key. A
 * scripted server answers only when a test releases it (tests/v4-settings-harness.ts), so late
 * answers after a switch of agent or workspace, also back to the first one, are placed exactly.
 */

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
/** A synthetic, low-entropy key: never a real one. */
const KEY = 'test-key-0001-0000000000000000';
const MODELS: ModelOption[] = [
  {
    provider: 'anthropic',
    id: 'test-model-0001',
    name: 'Test model',
    est_cost_per_reply_usd: 0.01,
    default: true,
  },
];
const KEY_VIEW = {
  provider: 'anthropic' as const,
  added_at: '2026-10-10T08:00:00.000Z',
  validated_at: '2026-10-10T08:00:00.000Z',
  status: 'active' as const,
};

function settings(agentId: string, over: Partial<ResponderSettingsView> = {}) {
  return {
    agent_id: agentId,
    enabled: false,
    status: 'off',
    pause_reason: null,
    paused_until: null,
    provider: null,
    model: null,
    instructions: '',
    daily_reply_cap: 100,
    daily_spend_cap_usd: 2,
    key: null,
    replies_available: true,
    ...over,
  } as ResponderSettingsView;
}
const on = (agentId: string) =>
  settings(agentId, {
    enabled: true,
    status: 'active',
    provider: 'anthropic',
    model: MODELS[0]!.id,
    key: KEY_VIEW,
  });

/** What the screen shows now: its state and what it offers for the key. */
function shown(screen: SettingsLifecycle): {
  state: AutoReplyState;
  key: ReturnType<typeof autoReplyKeyAction>;
} {
  const load = loadOf<AutoReplyData>(screen.getSnapshot(), 'autoReply');
  const value = load.state === 'ready' ? load.data.settings : null;
  const state = autoReplyState({
    loading: load.state === 'loading',
    failed: load.state === 'error',
    notFound: load.state === 'ready' && load.data.notFound,
    settings: value,
  });
  return { state, key: autoReplyKeyAction(state, value) };
}

/** The screen bound to `agentId` in ws-1, read: these settings and the model list. */
async function screenOn(
  h: ReturnType<typeof harness>,
  agentId: string,
  value: ResponderSettingsView,
) {
  const screen = new SettingsLifecycle({
    reads: AUTO_REPLY_READS,
    describe: responderFailure,
    deps: h.deps,
  });
  screen.bind(agentId, 'ws-1');
  await answerRead(h, agentId, value);
  return screen;
}

async function answerRead(
  h: ReturnType<typeof harness>,
  agentId: string,
  value: ResponderSettingsView,
) {
  await h.open('GET', `/api/agents/${agentId}/responder`).at(-1)!.reply(200, value);
  await h.open('GET', '/api/responder/models').at(-1)!.reply(200, { models: MODELS });
}

/** The failure a promise ends with (taken at once, so it is never an unhandled rejection). */
const failureOf = (promise: Promise<unknown>) =>
  promise.then(
    () => assert.fail('expected a failure'),
    (error: unknown) => error,
  );

/** The sheet's work in setup mode: the key, then the settings with enabled (the consent). */
const setupWork =
  (agentId = A) =>
  async (client: ResponderClient) => {
    await client.saveKey(agentId, { provider: 'anthropic', model: MODELS[0]!.id, key: KEY });
    return client.updateSettings(agentId, {
      model: MODELS[0]!.id,
      instructions: '',
      daily_reply_cap: 100,
      daily_spend_cap_usd: 2,
      enabled: true,
    });
  };

test('the read: settings, then the models the setup sheet offers, both for the bound workspace', async () => {
  const h = harness();
  const screen = await screenOn(h, A, settings(A));
  const load = loadOf<AutoReplyData>(screen.getSnapshot(), 'autoReply');
  assert.deepEqual(load, {
    state: 'ready',
    data: { settings: settings(A), notFound: false, models: MODELS },
  });
  assert.deepEqual(
    h.calls.map((call) => [call.url, call.headers['X-City-Workspace']]),
    [
      [`/api/agents/${A}/responder`, 'ws-1'],
      ['/api/responder/models', 'ws-1'],
    ],
  );
  // No key yet: the switch is disabled and the screen offers Set up auto-reply.
  assert.deepEqual(shown(screen), { state: 'needs-key', key: 'setup' });
});

test('set up: key, then settings, one action for its workspace; then the switch can be used', async () => {
  const h = harness();
  const screen = await screenOn(h, A, settings(A));
  const send = autoReplySheetSend(screen, screen.getSnapshot().generation);
  const saving = send(setupWork(), 'Auto-reply is on.');
  await settle();
  assert.equal(screen.getSnapshot().busy, 'sheet');
  const key = h.open('POST', '/responder/key')[0]!;
  assert.equal(key.url, `/api/agents/${A}/responder/key`);
  assert.equal(key.headers['X-City-Workspace'], 'ws-1');
  assert.equal(key.headers['X-City-Request'], '1');
  assert.deepEqual(key.body, { provider: 'anthropic', model: MODELS[0]!.id, key: KEY });

  // No second submit and no switch while the setup is on its way.
  assert.equal(await send(setupWork(), 'Auto-reply is on.'), null);
  await setAutoReply(screen, true, screen.getSnapshot().generation);
  assert.equal(h.writes().length, 1);

  await key.reply(200, { key: KEY_VIEW });
  const put = h.open('PUT')[0]!;
  assert.equal(put.url, `/api/agents/${A}/responder`);
  assert.equal(put.headers['X-City-Workspace'], 'ws-1');
  assert.deepEqual(put.body, {
    model: MODELS[0]!.id,
    instructions: '',
    daily_reply_cap: 100,
    daily_spend_cap_usd: 2,
    enabled: true,
  });
  await put.reply(200, on(A));
  // What was saved shows at once; then the screen reads the settings again (same workspace).
  assert.deepEqual(shown(screen), { state: 'on', key: 'manage' });
  assert.equal(screen.getSnapshot().notice, 'Auto-reply is on.');
  const reread = h.open('GET', `/api/agents/${A}/responder`)[0]!;
  assert.equal(reread.headers['X-City-Workspace'], 'ws-1');
  assert.equal(screen.getSnapshot().busy, 'sheet', 'the switch waits for the re-read');
  await reread.reply(200, { ...on(A), instructions: 'Read again.' });
  assert.deepEqual(await saving, on(A));
  const load = loadOf<AutoReplyData>(screen.getSnapshot(), 'autoReply');
  assert.equal(load.state === 'ready' && load.data.settings?.instructions, 'Read again.');
  assert.equal(load.state === 'ready' && load.data.models.length, 1, 'the models stay');
  assert.equal(screen.getSnapshot().busy, '');
  assert.equal(screen.getSnapshot().error, '', 'the sheet says what happens, not the screen');

  // The switch works now, for the same workspace.
  void setAutoReply(screen, false, screen.getSnapshot().generation);
  await settle();
  const off = h.open('PUT')[0]!;
  assert.deepEqual(off.body, { enabled: false });
  assert.equal(off.headers['X-City-Workspace'], 'ws-1');
  await off.reply(200, { ...on(A), enabled: false, status: 'off' });
  assert.deepEqual(shown(screen), { state: 'off', key: 'manage' });
  await h.advance(NOTICE_MS);
  assert.equal(screen.getSnapshot().notice, '');
});

test('set up: a failed re-read keeps what the save answered', async () => {
  const h = harness();
  const screen = await screenOn(h, A, settings(A));
  const saving = autoReplySheetSend(screen, screen.getSnapshot().generation)(
    setupWork(),
    'Auto-reply is on.',
  );
  await settle();
  await h.open('POST')[0]!.reply(200, { key: KEY_VIEW });
  await h.open('PUT')[0]!.reply(200, on(A));
  await h.open('GET')[0]!.reply(503, { code: 'responder_unavailable' });
  assert.deepEqual(await saving, on(A));
  assert.deepEqual(shown(screen), { state: 'on', key: 'manage' });
  assert.equal(screen.getSnapshot().error, '');
});

test('set up: a rejected key goes back to the sheet as its code; nothing else is sent', async () => {
  const h = harness();
  const screen = await screenOn(h, A, settings(A));
  const failed = failureOf(
    autoReplySheetSend(screen, screen.getSnapshot().generation)(setupWork(), 'Auto-reply is on.'),
  );
  await settle();
  await h.open('POST')[0]!.reply(400, { error: 'server text', code: 'invalid_key' });
  const error = await failed;
  assert.ok(error instanceof ResponderError);
  assert.equal(error.code, 'invalid_key');
  assert.equal(error.status, 400);
  assert.equal(h.writes().length, 1, 'no settings step');
  const now = screen.getSnapshot();
  assert.equal(now.busy, '');
  assert.equal(now.error, '');
  assert.equal(now.notice, '');
  assert.deepEqual(shown(screen), { state: 'needs-key', key: 'setup' });
});

test('set up: key taken, settings step failed: the screen shows the key, the sheet the failure', async () => {
  const h = harness();
  const screen = await screenOn(h, A, settings(A));
  const failed = failureOf(
    autoReplySheetSend(screen, screen.getSnapshot().generation)(setupWork(), 'Auto-reply is on.'),
  );
  await settle();
  await h.open('POST')[0]!.reply(200, { key: KEY_VIEW });
  await h.open('PUT')[0]!.reply(500, { error: 'server text' });
  // Before the sheet hears of it, the screen reads what the server has now (same workspace).
  const reread = h.open('GET', `/api/agents/${A}/responder`)[0]!;
  assert.equal(reread.headers['X-City-Workspace'], 'ws-1');
  await reread.reply(200, settings(A, { provider: 'anthropic', key: KEY_VIEW }));
  const error = await failed;
  assert.ok(error instanceof ResponderError);
  assert.equal(error.status, 500);
  assert.deepEqual(shown(screen), { state: 'off', key: 'manage' });
  assert.equal(screen.getSnapshot().notice, '');
  assert.equal(screen.getSnapshot().busy, '');

  // The sheet's Try again sends the settings step only (it never sends the key twice).
  const retry = autoReplySheetSend(screen, screen.getSnapshot().generation)(
    (client) => client.updateSettings(A, { enabled: true }),
    'Auto-reply is on.',
  );
  await settle();
  await h.open('PUT')[0]!.reply(200, on(A));
  await h.open('GET')[0]!.reply(200, on(A));
  assert.deepEqual(await retry, on(A));
  assert.deepEqual(
    h.writes().map((call) => call.method),
    ['POST', 'PUT', 'PUT'],
  );
  assert.deepEqual(shown(screen), { state: 'on', key: 'manage' });
});

test('set up: a key check that hangs gives up with the timeout code', async () => {
  const h = harness();
  h.selection.honourAbort = true;
  const screen = await screenOn(h, A, settings(A));
  const failed = failureOf(
    autoReplySheetSend(screen, screen.getSnapshot().generation)(setupWork(), 'Auto-reply is on.'),
  );
  await settle();
  assert.equal(h.open('POST').length, 1);
  await h.advance(KEY_CHECK_TIMEOUT_MS);
  const error = await failed;
  assert.ok(error instanceof ResponderError);
  assert.equal(error.code, 'timeout');
  assert.equal(h.writes().length, 1);
  assert.equal(screen.getSnapshot().busy, '');
});

test('set up: A to B mid key check sends no settings step and lands nothing', async () => {
  const h = harness();
  const screen = await screenOn(h, A, settings(A));
  const saving = autoReplySheetSend(screen, screen.getSnapshot().generation)(
    setupWork(),
    'Auto-reply is on.',
  );
  await settle();
  const key = h.open('POST')[0]!;
  screen.bind(B, 'ws-1');
  assert.equal(key.signal?.aborted, true, 'A’s key check is given up');
  assert.equal(screen.getSnapshot().busy, '');
  await key.reply(200, { key: KEY_VIEW });
  assert.equal(await saving, null, 'the sheet shows nothing more');
  assert.equal(h.open('PUT').length, 0);
  assert.equal(h.writes().length, 1);
  const now = screen.getSnapshot();
  assert.equal(now.agentId, B);
  assert.equal(now.notice, '');
  assert.equal(now.error, '');
  assert.equal(loadOf(now, 'autoReply').state, 'loading');
});

test('set up: A to B to A drops the first sheet’s late answer and refuses its stale clicks', async () => {
  const h = harness();
  const screen = await screenOn(h, A, settings(A));
  const first = screen.getSnapshot().generation;
  const send = autoReplySheetSend(screen, first);
  const saving = send(setupWork(), 'Auto-reply is on.');
  await settle();
  await h.open('POST')[0]!.reply(200, { key: KEY_VIEW });
  const put = h.open('PUT')[0]!;

  screen.bind(B, 'ws-1');
  screen.bind(A, 'ws-1');
  assert.notEqual(screen.getSnapshot().generation, first);
  // The first generation's settings answer arrives now: same agent, same workspace, dropped.
  await put.reply(200, on(A));
  assert.equal(await saving, null);
  assert.equal(screen.getSnapshot().notice, '');
  assert.equal(loadOf(screen.getSnapshot(), 'autoReply').state, 'loading');
  assert.equal(h.open('GET', `/api/agents/${A}/responder`).length, 1, 'only the new read');

  // A submit from the first generation's sheet is not started.
  const before = h.calls.length;
  assert.equal(await send(setupWork(), 'Auto-reply is on.'), null);
  assert.equal(h.calls.length, before);

  // The new generation reads what the server has, and works from there.
  await answerRead(h, A, on(A));
  assert.deepEqual(shown(screen), { state: 'on', key: 'manage' });
});

test('set up: another workspace selected after the key check sends no settings step', async () => {
  const h = harness();
  const screen = await screenOn(h, A, settings(A));
  const saving = autoReplySheetSend(screen, screen.getSnapshot().generation)(
    setupWork(),
    'Auto-reply is on.',
  );
  await settle();
  // The person picks another workspace; the pane has not drawn it yet.
  h.selection.workspace = 'ws-2';
  await h.open('POST')[0]!.reply(200, { key: KEY_VIEW });
  assert.equal(await saving, null);
  assert.equal(h.writes().length, 1, 'the settings are never sent');
  for (const call of h.calls) assert.equal(call.headers['X-City-Workspace'], 'ws-1');
  assert.equal(screen.getSnapshot().notice, '');
  assert.deepEqual(shown(screen), { state: 'needs-key', key: 'setup' });
});

test('change key: the sheet may only name the screen’s agent', async () => {
  const h = harness();
  const screen = await screenOn(h, A, on(A));
  const before = h.calls.length;
  const saving = autoReplySheetSend(screen, screen.getSnapshot().generation)(
    setupWork(B),
    'Key saved.',
  );
  assert.equal(await saving, null);
  assert.equal(h.calls.length, before, 'nothing is sent for another agent');
  assert.equal(screen.getSnapshot().busy, '');
});

test('remove key: DELETE for its workspace, shown off at once, then read again', async () => {
  const h = harness();
  const screen = await screenOn(h, A, on(A));
  assert.deepEqual(shown(screen), { state: 'on', key: 'manage' });
  let closed = 0;
  const removing = removeAutoReplyKey(screen, screen.getSnapshot().generation, () => closed++);
  await settle();
  assert.equal(screen.getSnapshot().busy, 'remove');
  const remove = h.open('DELETE')[0]!;
  assert.equal(remove.url, `/api/agents/${A}/responder/key`);
  assert.equal(remove.headers['X-City-Workspace'], 'ws-1');
  // Like the console's other DELETEs: a JSON body, so the request-protection header goes along.
  assert.equal(remove.headers['X-City-Request'], '1');
  assert.equal(remove.headers['Content-Type'], 'application/json');
  assert.deepEqual(remove.body, {});

  // No second removal and no switch while it is on its way.
  await removeAutoReplyKey(screen, screen.getSnapshot().generation, () => closed++);
  await setAutoReply(screen, false, screen.getSnapshot().generation);
  assert.equal(h.writes().length, 1);

  await remove.reply(200, { agent_id: A, removed: true });
  assert.equal(closed, 1);
  assert.deepEqual(shown(screen), { state: 'needs-key', key: 'setup' }, 'the switch is disabled');
  assert.equal(screen.getSnapshot().notice, 'Key removed. Auto-reply is off.');
  const reread = h.open('GET', `/api/agents/${A}/responder`)[0]!;
  assert.equal(reread.headers['X-City-Workspace'], 'ws-1');
  await reread.reply(200, settings(A, { pause_reason: 'key_removed' }));
  await removing;
  assert.deepEqual(shown(screen), { state: 'needs-key', key: 'setup' });
  assert.equal(screen.getSnapshot().busy, '');
  assert.equal(screen.getSnapshot().error, '');
});

test('remove key: a failed DELETE keeps the key and says why', async () => {
  const h = harness();
  const screen = await screenOn(h, A, on(A));
  let closed = 0;
  const removing = removeAutoReplyKey(screen, screen.getSnapshot().generation, () => closed++);
  await settle();
  await h.open('DELETE')[0]!.reply(503, { code: 'responder_unavailable', error: 'server text' });
  await removing;
  assert.equal(closed, 0, 'the confirmation stays');
  assert.deepEqual(shown(screen), { state: 'on', key: 'manage' });
  assert.equal(
    screen.getSnapshot().error,
    'Auto-reply isn’t available right now. Try again later.',
  );
  assert.equal(screen.getSnapshot().notice, '');
  assert.equal(h.open('GET').length, 0, 'nothing to read again');
});

test('remove key: a failed re-read keeps what the DELETE confirmed', async () => {
  const h = harness();
  const screen = await screenOn(h, A, on(A));
  const removing = removeAutoReplyKey(screen, screen.getSnapshot().generation, () => {});
  await settle();
  await h.open('DELETE')[0]!.reply(200, { agent_id: A, removed: false });
  await h.open('GET')[0]!.reply(503, { code: 'responder_unavailable' });
  await removing;
  assert.deepEqual(shown(screen), { state: 'needs-key', key: 'setup' });
  assert.equal(screen.getSnapshot().error, '');
});

test('remove key: an answer after A to B to A is dropped and nothing more is sent', async () => {
  const h = harness();
  const screen = await screenOn(h, A, on(A));
  let closed = 0;
  void removeAutoReplyKey(screen, screen.getSnapshot().generation, () => closed++);
  await settle();
  const remove = h.open('DELETE')[0]!;
  screen.bind(B, 'ws-1');
  screen.bind(A, 'ws-1');
  await remove.reply(200, { agent_id: A, removed: true });
  assert.equal(closed, 0);
  const now = screen.getSnapshot();
  assert.equal(now.notice, '');
  assert.equal(now.busy, '');
  assert.equal(loadOf(now, 'autoReply').state, 'loading');
  // Only the reads of B and of the new A generation: the old run reads nothing again.
  assert.deepEqual(
    h.open('GET').map((call) => call.url),
    [`/api/agents/${B}/responder`, `/api/agents/${A}/responder`],
  );
  // The new generation shows what the server has now.
  await answerRead(h, A, settings(A, { pause_reason: 'key_removed' }));
  assert.deepEqual(shown(screen), { state: 'needs-key', key: 'setup' });
});

test('closing the screen gives up the sheet’s requests and drops their answers', async () => {
  const h = harness();
  const screen = await screenOn(h, A, settings(A));
  const saving = autoReplySheetSend(screen, screen.getSnapshot().generation)(
    setupWork(),
    'Auto-reply is on.',
  );
  await settle();
  const key = h.open('POST')[0]!;
  screen.close();
  assert.equal(key.signal?.aborted, true);
  await key.reply(200, { key: KEY_VIEW });
  assert.equal(await saving, null);
  assert.equal(h.writes().length, 1);
  assert.equal(screen.getSnapshot().busy, '');
});

/**
 * What the sheet (AutoReplySheet's submit) does with what `send` says: onSaved for a save, its
 * error line for a failure, nothing for null.
 */
function sheetSubmit(send: SheetSend, work: Parameters<SheetSend>[0], done: string) {
  const heard = { saved: [] as ResponderSettingsView[], failures: [] as unknown[] };
  const finished = send(work, done).then(
    (saved) => {
      if (saved) heard.saved.push(saved);
      return saved;
    },
    (failure: unknown) => {
      heard.failures.push(failure);
      return undefined;
    },
  );
  return { heard, finished };
}

/** The ways the screen moves on while the sheet's run reads the settings again. */
const MOVES_ON: [string, (h: ReturnType<typeof harness>, screen: SettingsLifecycle) => void][] = [
  ['the screen closes', (_h, screen) => screen.close()],
  [
    'another workspace is selected',
    (h) => {
      h.selection.workspace = 'ws-2';
    },
  ],
  [
    'A to B to A',
    (_h, screen) => {
      screen.bind(B, 'ws-1');
      screen.bind(A, 'ws-1');
    },
  ],
];

for (const [name, moveOn] of MOVES_ON) {
  test(`set up: saved, then ${name} during the re-read: the sheet hears nothing more`, async () => {
    const h = harness();
    const screen = await screenOn(h, A, settings(A));
    const { heard, finished } = sheetSubmit(
      autoReplySheetSend(screen, screen.getSnapshot().generation),
      setupWork(),
      'Auto-reply is on.',
    );
    await settle();
    await h.open('POST')[0]!.reply(200, { key: KEY_VIEW });
    await h.open('PUT')[0]!.reply(200, on(A));
    // Saved and shown; the re-read is on its way.
    assert.deepEqual(shown(screen), { state: 'on', key: 'manage' });
    const reread = h.open('GET', `/api/agents/${A}/responder`)[0]!;
    assert.equal(screen.getSnapshot().busy, 'sheet');

    moveOn(h, screen);
    await reread.reply(200, { ...on(A), instructions: 'Read again.' });
    assert.equal(await finished, null, 'send resolves null');
    assert.deepEqual(heard, { saved: [], failures: [] }, 'onSaved is never called');
    const now = screen.getSnapshot();
    const load = loadOf<AutoReplyData>(now, 'autoReply');
    assert.notEqual(load.state === 'ready' && load.data.settings?.instructions, 'Read again.');
    assert.equal(now.busy, '');
    assert.equal(now.error, '');
  });

  test(`set up: key taken, settings step failed, then ${name} during the re-read: no failure reaches the sheet`, async () => {
    const h = harness();
    const screen = await screenOn(h, A, settings(A));
    const { heard, finished } = sheetSubmit(
      autoReplySheetSend(screen, screen.getSnapshot().generation),
      setupWork(),
      'Auto-reply is on.',
    );
    await settle();
    await h.open('POST')[0]!.reply(200, { key: KEY_VIEW });
    await h.open('PUT')[0]!.reply(500, { error: 'server text' });
    const reread = h.open('GET', `/api/agents/${A}/responder`)[0]!;
    assert.equal(screen.getSnapshot().busy, 'sheet');

    moveOn(h, screen);
    await reread.reply(200, settings(A, { provider: 'anthropic', key: KEY_VIEW }));
    assert.equal(await finished, null, 'send resolves null, it does not reject');
    assert.deepEqual(heard, { saved: [], failures: [] });
    const now = screen.getSnapshot();
    assert.equal(now.busy, '');
    assert.equal(now.error, '');
  });
}

test('the key the sheet sends never reaches storage, logs or a URL on the v4 side either', () => {
  const dir = join(import.meta.dirname, '..', 'src', 'agents', 'v4');
  for (const file of [
    'AutoReplyScreen.tsx',
    'settingsRequests.ts',
    'settingsLifecycle.ts',
    'settingsShared.tsx',
  ]) {
    const source = readFileSync(join(dir, file), 'utf8');
    assert.doesNotMatch(
      source,
      /localStorage|sessionStorage|indexedDB|console\.(log|info|warn|error|debug)|document\.cookie/,
      file,
    );
    assert.doesNotMatch(source, /[?&]key=/, file);
  }
});
