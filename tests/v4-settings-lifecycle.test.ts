import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ConnectionRequest } from '../shared/assistant';
import type { Agent, Connection } from '../shared/types';
import { permissionRows } from '../src/agents/v4/settingsActionsModel';
import {
  NOTICE_MS,
  SETTINGS_READ_DEADLINE_MS,
  SettingsLifecycle,
  loadOf,
  settingsView,
} from '../src/agents/v4/settingsLifecycle';
import {
  AUTO_REPLY_READS,
  PERMISSIONS_READS,
  SNAPSHOT_READS,
  responderFailure,
  rotateKey,
  setAutoReply,
  turnOffPermission,
  type AutoReplyData,
  type PermissionsData,
} from '../src/agents/v4/settingsRequests';
import { harness, settle } from './v4-settings-harness';

/*
 * The lifecycle behind the v4 settings screens (Rotate key, Auto-reply, Permissions, Connect an
 * agent), with a scripted server, a selected workspace the test switches, and a manual clock:
 * answers arrive only when a test releases them, so a late answer can be placed exactly
 * (tests/v4-settings-harness.ts).
 */

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
/** Another agent with A's name: names may repeat, so they never decide what is shown. */
const A_TWIN = '33333333-3333-4333-8333-333333333333';
const COURIER = '44444444-4444-4444-8444-444444444444';
const NOVA = '55555555-5555-4555-8555-555555555555';

function agent(id: string, name: string, over: Partial<Agent> = {}): Agent {
  return {
    id,
    name,
    description: '',
    capability: 'research',
    mode: 'external',
    isDemo: false,
    status: 'online',
    lastSeenAt: null,
    createdAt: '2026-10-10T07:19:00.000Z',
    revokedAt: null,
    ...over,
  } as Agent;
}
const connection = (id: string, from: string, to: string): Connection => ({
  id,
  fromAgentId: from,
  toAgentId: to,
  createdAt: '2026-10-10T07:20:00.000Z',
});
function cross(over: Partial<ConnectionRequest> & { id: string }): ConnectionRequest {
  return {
    direction: 'incoming',
    status: 'approved',
    from_agent_id: NOVA,
    from_agent_name: 'Nova',
    from_owner_label: 'Mira',
    to_agent_id: A,
    to_agent_name: 'Winry',
    note: '',
    requested_at: '2026-10-09T07:00:00.000Z',
    expires_at: '2026-10-16T07:00:00.000Z',
    decided_at: '2026-10-09T08:00:00.000Z',
    revoked_at: null,
    ...over,
  };
}
const snapshot = (agents: Agent[], connections: Connection[] = []) => ({ agents, connections });

test('A to B: none of A’s answers lands on B, and B reads its own', async () => {
  const h = harness();
  const screen = new SettingsLifecycle({ reads: SNAPSHOT_READS, deps: h.deps });
  screen.bind(A, 'ws-1');
  const readA = h.open('GET', '/api/snapshot')[0]!;
  assert.equal(readA.headers['X-City-Workspace'], 'ws-1');
  await readA.reply(200, snapshot([agent(A, 'Winry')]));
  assert.equal(loadOf(screen.getSnapshot(), 'snapshot').state, 'ready');

  screen.setConfirm('Winry');
  void rotateKey(screen, screen.getSnapshot().generation);
  await settle();
  const rotateA = h.open('POST')[0]!;
  assert.ok(rotateA.url.includes(`/api/agents/${A}/rotate-credential`));
  assert.equal(rotateA.headers['X-City-Workspace'], 'ws-1');
  assert.equal(screen.getSnapshot().busy, 'rotate');

  // The pane switches to B while A's rotation is on its way.
  screen.bind(B, 'ws-1');
  const now = screen.getSnapshot();
  assert.equal(now.agentId, B);
  assert.equal(now.busy, '');
  assert.equal(now.confirm, '');
  assert.equal(now.secret, null);
  assert.equal(loadOf(now, 'snapshot').state, 'loading');
  assert.equal(rotateA.signal?.aborted, true, 'A’s request is given up');

  // A's key arrives late: it is never shown, not even as an error.
  await rotateA.reply(200, { agent: agent(A, 'Winry'), token: 'secret-of-a' });
  assert.equal(screen.getSnapshot().secret, null);
  assert.equal(screen.getSnapshot().error, '');
  assert.equal(screen.getSnapshot().busy, '');

  const readB = h.open('GET', '/api/snapshot')[0]!;
  await readB.reply(200, snapshot([agent(B, 'Courier', { credentialHint: '…b0b0' })]));
  const load = loadOf<{ agents: Agent[] }>(screen.getSnapshot(), 'snapshot');
  assert.equal(load.state === 'ready' && load.data.agents[0]!.id, B);
});

test('A to B: a read of A that answers after the switch is dropped', async () => {
  const h = harness();
  const screen = new SettingsLifecycle({ reads: SNAPSHOT_READS, deps: h.deps });
  screen.bind(A, 'ws-1');
  const readA = h.open('GET')[0]!;
  screen.bind(B, 'ws-1');
  await readA.reply(200, snapshot([agent(A, 'Winry')]));
  assert.equal(loadOf(screen.getSnapshot(), 'snapshot').state, 'loading');
  await h.open('GET')[0]!.reply(500, { error: 'nope' });
  assert.equal(loadOf(screen.getSnapshot(), 'snapshot').state, 'error');
  // Try again reads B again, still for B.
  void screen.reload('snapshot');
  await settle();
  assert.equal(loadOf(screen.getSnapshot(), 'snapshot').state, 'loading');
  await h.open('GET')[0]!.reply(200, snapshot([agent(B, 'Courier')]));
  assert.equal(loadOf(screen.getSnapshot(), 'snapshot').state, 'ready');
});

test('A to B to A: the first A answers are dropped, only the new A generation shows', async () => {
  const h = harness();
  const screen = new SettingsLifecycle({ reads: SNAPSHOT_READS, deps: h.deps });
  screen.bind(A, 'ws-1');
  const firstRead = h.open('GET')[0]!;
  const first = screen.getSnapshot().generation;
  // The first read has not answered yet; the rotation is asked anyway once it has.
  await firstRead.reply(200, snapshot([agent(A, 'Winry')]));
  void rotateKey(screen, first);
  await settle();
  const firstRotation = h.open('POST')[0]!;

  screen.bind(B, 'ws-1');
  screen.bind(A, 'ws-1');
  const again = screen.getSnapshot();
  assert.equal(again.agentId, A);
  assert.notEqual(again.generation, first, 'coming back is a new generation');
  const secondRead = h.open('GET')[0]!;

  // The first rotation's key arrives now: same agent, same workspace, still dropped.
  await firstRotation.reply(200, { agent: agent(A, 'Winry'), token: 'first-key' });
  assert.equal(screen.getSnapshot().secret, null);
  assert.equal(screen.getSnapshot().busy, '');

  // An action from the first generation (a stale click) is not started.
  await rotateKey(screen, first);
  assert.equal(h.open('POST').length, 0);

  await secondRead.reply(200, snapshot([agent(A, 'Winry')]));
  void rotateKey(screen, screen.getSnapshot().generation);
  await settle();
  await h.open('POST')[0]!.reply(200, { agent: agent(A, 'Winry'), token: 'second-key' });
  assert.equal(screen.getSnapshot().secret, 'second-key');
  screen.clearSecret();
  assert.equal(screen.getSnapshot().secret, null);
});

test('A to B to A: a first read of A that answers after coming back is dropped', async () => {
  const h = harness();
  const screen = new SettingsLifecycle({ reads: SNAPSHOT_READS, deps: h.deps });
  screen.bind(A, 'ws-1');
  const firstRead = h.open('GET')[0]!;
  screen.bind(B, 'ws-1');
  screen.bind(A, 'ws-1');
  await firstRead.reply(200, snapshot([agent(A, 'Old answer')]));
  assert.equal(loadOf(screen.getSnapshot(), 'snapshot').state, 'loading');
  const reads = h.open('GET');
  // B's read and the new A read are still open; only the latter may land.
  await reads.at(-1)!.reply(200, snapshot([agent(A, 'New answer')]));
  const load = loadOf<{ agents: Agent[] }>(screen.getSnapshot(), 'snapshot');
  assert.equal(load.state === 'ready' && load.data.agents[0]!.name, 'New answer');
  await reads[0]!.reply(200, snapshot([agent(B, 'B answer')]));
  const after = loadOf<{ agents: Agent[] }>(screen.getSnapshot(), 'snapshot');
  assert.equal(after.state === 'ready' && after.data.agents[0]!.name, 'New answer');
});

/** Permissions bound to A in ws-1, read: Courier (2 workspace connections) and Nova (2 requests). */
async function permissionsOnA(h: ReturnType<typeof harness>) {
  const screen = new SettingsLifecycle({ reads: PERMISSIONS_READS, deps: h.deps });
  screen.bind(A, 'ws-1');
  await h
    .open('GET', '/api/snapshot')[0]!
    .reply(
      200,
      snapshot(
        [agent(A, 'Winry'), agent(COURIER, 'Courier')],
        [connection('c1', COURIER, A), connection('c2', A, COURIER)],
      ),
    );
  await h.open('GET', 'direction=incoming')[0]!.reply(200, {
    incoming: [cross({ id: 'x1' })],
    next_before: null,
  });
  await h.open('GET', 'direction=outgoing')[0]!.reply(200, {
    outgoing: [
      cross({
        id: 'x2',
        direction: 'outgoing',
        from_agent_id: A,
        from_owner_label: 'You',
        to_agent_id: NOVA,
        to_agent_name: 'Nova',
      }),
    ],
    next_before: null,
  });
  const load = loadOf<PermissionsData>(screen.getSnapshot(), 'permissions');
  assert.equal(load.state, 'ready');
  const data = (load as { data: PermissionsData }).data;
  const rows = permissionRows(A, data.snapshot.agents, data.snapshot.connections, data.cross);
  assert.deepEqual(
    rows.map((row) => [row.name, row.local, row.cross]),
    [
      ['Courier', ['c1', 'c2'], []],
      ['Nova', [], ['x1', 'x2']],
    ],
  );
  for (const call of h.calls) assert.equal(call.headers['X-City-Workspace'], 'ws-1');
  return { screen, courier: rows[0]!, nova: rows[1]! };
}

test('permissions: turning a row off sends every request for its workspace, then says so', async () => {
  const h = harness();
  const { screen, courier } = await permissionsOnA(h);
  void turnOffPermission(screen, courier, screen.getSnapshot().generation);
  await settle();
  assert.equal(screen.getSnapshot().busy, courier.key);
  await h.open('DELETE')[0]!.reply(200, {});
  // The workspace selected now changes nothing: the request carries the run's own.
  await h.open('DELETE')[0]!.reply(200, {});
  assert.deepEqual(
    h.writes().map((call) => [call.method, call.url, call.headers['X-City-Workspace']]),
    [
      ['DELETE', '/api/connections/c1', 'ws-1'],
      ['DELETE', '/api/connections/c2', 'ws-1'],
    ],
  );
  // The server refuses a cookie-session write without the request protection header (403),
  // and api() only sends it with a JSON body: every DELETE carries one.
  for (const call of h.writes()) {
    assert.equal(call.headers['X-City-Request'], '1', call.url);
    assert.equal(call.headers['Content-Type'], 'application/json', call.url);
  }
  const now = screen.getSnapshot();
  assert.equal(now.busy, '');
  assert.equal(now.notice, 'Courier removed');
  const load = loadOf<PermissionsData>(now, 'permissions');
  assert.deepEqual(load.state === 'ready' && load.data.snapshot.connections, []);
  await h.advance(NOTICE_MS);
  assert.equal(screen.getSnapshot().notice, '');
});

test('permissions: another workspace selected mid turn-off stops the remaining DELETEs', async () => {
  const h = harness();
  const { screen, courier } = await permissionsOnA(h);
  void turnOffPermission(screen, courier, screen.getSnapshot().generation);
  await settle();
  const first = h.open('DELETE')[0]!;
  assert.equal(first.url, '/api/connections/c1');

  // The person picks another workspace; the pane has not drawn it yet.
  h.selection.workspace = 'ws-2';
  await first.reply(200, {});
  assert.equal(h.writes().length, 1, 'c2 is never sent');
  for (const call of h.calls) assert.notEqual(call.headers['X-City-Workspace'], 'ws-2');
  const now = screen.getSnapshot();
  assert.equal(now.notice, '', 'no toast for a turn-off that did not finish here');
  assert.equal(now.error, '');
  assert.equal(now.busy, '');

  // The pane draws the new workspace: it reads there, and sends nothing destructive.
  h.selection.workspace = 'ws-2';
  screen.bind(A, 'ws-2');
  assert.ok(h.open('GET').every((call) => call.headers['X-City-Workspace'] === 'ws-2'));
  assert.equal(h.writes().length, 1);
});

test('permissions: a bind to another workspace mid turn-off stops the remaining revokes', async () => {
  const h = harness();
  const { screen, nova } = await permissionsOnA(h);
  void turnOffPermission(screen, nova, screen.getSnapshot().generation);
  await settle();
  const first = h.open('POST')[0]!;
  assert.equal(first.url, '/api/v2/connections/requests/x1/revoke');
  assert.equal(first.headers['X-City-Workspace'], 'ws-1');

  h.selection.workspace = 'ws-2';
  screen.bind(A, 'ws-2');
  assert.equal(screen.getSnapshot().busy, '');
  await first.reply(200, {});
  assert.deepEqual(
    h.writes().map((call) => call.url),
    ['/api/v2/connections/requests/x1/revoke'],
    'x2 is never revoked',
  );
  assert.ok(h.writes().every((call) => call.headers['X-City-Workspace'] === 'ws-1'));
  assert.equal(screen.getSnapshot().notice, '');
  assert.equal(screen.getSnapshot().workspace, 'ws-2');
});

test('permissions: a read that spans pages stops when the workspace changes between them', async () => {
  const h = harness();
  const screen = new SettingsLifecycle({ reads: PERMISSIONS_READS, deps: h.deps });
  screen.bind(A, 'ws-1');
  await h.open('GET', 'direction=incoming')[0]!.reply(200, { incoming: [], next_before: 'p2' });
  assert.equal(h.open('GET', 'before=p2').length, 1);
  h.selection.workspace = 'ws-2';
  await h.open('GET', 'before=p2')[0]!.reply(200, { incoming: [], next_before: null });
  assert.equal(h.open('GET', 'direction=outgoing').length, 0, 'no further page is asked');
  await h.open('GET', '/api/snapshot')[0]!.reply(200, snapshot([agent(A, 'Winry')]));
  assert.equal(loadOf(screen.getSnapshot(), 'permissions').state, 'loading');
  for (const call of h.calls) assert.equal(call.headers['X-City-Workspace'], 'ws-1');
});

test('the typed confirmation resets per agent and per workspace, also for agents of one name', () => {
  const h = harness();
  const screen = new SettingsLifecycle({ deps: h.deps });
  screen.bind(A, 'ws-1');
  screen.setConfirm('Winry');
  assert.equal(screen.getSnapshot().confirm, 'Winry');
  screen.bind(A, 'ws-1');
  assert.equal(screen.getSnapshot().confirm, 'Winry', 'the same pair keeps it');

  screen.bind(A_TWIN, 'ws-1');
  assert.equal(screen.getSnapshot().confirm, '', 'another agent named Winry starts empty');
  screen.setConfirm('Winry');
  h.selection.workspace = 'ws-2';
  screen.bind(A_TWIN, 'ws-2');
  assert.equal(screen.getSnapshot().confirm, '', 'the same agent in another workspace too');
  screen.setConfirm('Winry');
  screen.bind(A_TWIN, null);
  assert.equal(screen.getSnapshot().confirm, '');

  // Before the screen has been bound to what it renders, it shows nothing typed.
  screen.setConfirm('Winry');
  const state = screen.getSnapshot();
  assert.equal(settingsView(state, A_TWIN, null).confirm, 'Winry');
  assert.equal(settingsView(state, A, null).confirm, '');
  assert.equal(settingsView(state, A_TWIN, 'ws-1').confirm, '');

  screen.close();
  assert.equal(screen.getSnapshot().confirm, '');
  screen.setConfirm('Winry');
  assert.equal(screen.getSnapshot().confirm, '', 'nothing is typed into a closed screen');
});

test('closing the screen drops every answer and sends nothing more', async () => {
  const h = harness();
  const screen = new SettingsLifecycle({ reads: SNAPSHOT_READS, deps: h.deps });
  screen.bind(A, 'ws-1');
  const read = h.open('GET')[0]!;
  screen.setConfirm('Winry');
  void rotateKey(screen, screen.getSnapshot().generation);
  await settle();
  const rotation = h.open('POST')[0]!;
  const generation = screen.getSnapshot().generation;

  screen.close();
  assert.equal(screen.getSnapshot().open, false);
  assert.notEqual(screen.getSnapshot().generation, generation);
  assert.equal(read.signal?.aborted, true);
  assert.equal(rotation.signal?.aborted, true);

  await read.reply(200, snapshot([agent(A, 'Winry')]));
  await rotation.reply(200, { agent: agent(A, 'Winry'), token: 'secret-after-close' });
  const now = screen.getSnapshot();
  assert.equal(now.secret, null);
  assert.equal(loadOf(now, 'snapshot').state, 'loading');
  assert.equal(now.busy, '');
  assert.equal(now.confirm, '');

  await rotateKey(screen, now.generation);
  await screen.reload('snapshot');
  assert.equal(h.calls.length, 2, 'a closed screen sends nothing');
  assert.equal(settingsView(now, A, 'ws-1').secret, null);
});

test('a read that hangs gives up at the deadline with a plain line', async () => {
  const h = harness();
  h.selection.honourAbort = true;
  const screen = new SettingsLifecycle({ reads: SNAPSHOT_READS, deps: h.deps });
  screen.bind(A, 'ws-1');
  await h.advance(SETTINGS_READ_DEADLINE_MS);
  const load = loadOf(screen.getSnapshot(), 'snapshot');
  assert.deepEqual(load, { state: 'error', message: 'This took too long.' });
});

test('auto-reply: not offered is not an error, a failed save says why, a late save is dropped', async () => {
  const h = harness();
  const screen = new SettingsLifecycle({
    reads: AUTO_REPLY_READS,
    describe: responderFailure,
    deps: h.deps,
  });
  screen.bind(A, 'ws-1');
  await h.open('GET', `/api/agents/${A}/responder`)[0]!.reply(404, { error: 'Not found.' });
  assert.deepEqual(loadOf(screen.getSnapshot(), 'autoReply'), {
    state: 'ready',
    data: { settings: null, notFound: true, models: [] },
  });

  screen.bind(B, 'ws-1');
  const settings = { agent_id: B, enabled: false, status: 'off', key: { status: 'active' } };
  await h.open('GET', `/api/agents/${B}/responder`)[0]!.reply(200, settings);
  void setAutoReply(screen, true, screen.getSnapshot().generation);
  await settle();
  const save = h.open('PUT')[0]!;
  assert.deepEqual(save.body, { enabled: true });
  assert.equal(save.headers['X-City-Workspace'], 'ws-1');
  await save.reply(400, { error: 'Add a key first.', code: 'key_required' });
  assert.equal(screen.getSnapshot().error, 'Set up auto-reply with a working key first.');

  void setAutoReply(screen, true, screen.getSnapshot().generation);
  await settle();
  const late = h.open('PUT')[0]!;
  screen.bind(A, 'ws-1');
  await late.reply(200, { ...settings, enabled: true, status: 'active' });
  const now = screen.getSnapshot();
  assert.equal(now.agentId, A);
  assert.equal(now.error, '');
  assert.equal(loadOf<AutoReplyData>(now, 'autoReply').state, 'loading');
});
