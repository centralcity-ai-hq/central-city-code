import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/app.js';
import { ASSISTANT_SCOPES } from '../shared/assistant.js';
import { createRoomRepos, type RoomRepos } from '../server/rooms/repos/service.js';
import { createGitHubApp } from '../server/rooms/repos/github.js';
import { registerRoomCodeMigration } from '../server/rooms/repos/schema.js';
import { GUEST_REPO_TOOLS, GUEST_ROOM_TOOLS } from '../server/links/invites.js';
import { commitSha, fakeGitHub, generateAppKey, type FakeRepo } from './fake-github.js';

registerRoomCodeMigration();
process.env.CITY_INVITE_FLOW = '1';
process.env.CITY_ROOM_REPOS = '1';
process.env.CITY_RATE_LIMIT_KEY ??= 'synthetic-guest-parity-root-not-a-real-secret';

/**
 * Invite-link guests (POST /api/public/invites/tools/<tool>) have the same room rights as members
 * for pins and the brief, the overview, their own mentions and the room repository; host-only
 * tools answer host_only. Synthetic data and a fake GitHub only.
 */
type App = Awaited<ReturnType<typeof createApp>>;
const jsonHeaders = { 'content-type': 'application/json', 'x-city-request': '1' };
const APP_ID = '515151';
const INSTALLATION = 91;
const appKey = generateAppKey();
const head = commitSha('parity-main');

let addressCounter = 30;
async function owner(app: App, name: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/public/workspaces',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ name, idempotency_key: randomUUID() }),
    remoteAddress: `198.18.${addressCounter++ % 250}.40`,
  });
  assert.equal(res.statusCode, 201, res.body);
  const id = res.json().workspace_id as string;
  const person = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    headers: jsonHeaders,
    payload: JSON.stringify({
      name: `Parity owner ${addressCounter}`,
      password: 'Synthetic parity owner password',
    }),
    remoteAddress: `198.18.${addressCounter++ % 250}.41`,
  });
  assert.equal(person.statusCode, 201, person.body);
  const cookie = `cc_session=${person.cookies.find((item) => item.name === 'cc_session')!.value}`;
  const claimed = await app.inject({
    method: 'POST',
    url: '/api/workspaces/claim',
    headers: { ...jsonHeaders, cookie },
    payload: JSON.stringify({ claim_token: res.json().claim_token }),
  });
  assert.equal(claimed.statusCode, 200, claimed.body);
  const minted = await app.inject({
    method: 'POST',
    url: '/api/workspace-keys',
    headers: { ...jsonHeaders, cookie, 'x-city-workspace': id },
    payload: JSON.stringify({ label: 'parity test', scopes: [...ASSISTANT_SCOPES] }),
  });
  assert.equal(minted.statusCode, 201, minted.body);
  return { id, cookie, key: minted.json().workspace_key as string };
}
async function ok(app: App, apiKey: string, name: string, args: unknown) {
  const res = await app.inject({
    method: 'POST',
    url: `/api/assistant/tools/${name}`,
    headers: { ...jsonHeaders, authorization: `Bearer ${apiKey}` },
    payload: JSON.stringify(args),
  });
  assert.equal(res.statusCode, 200, `${name}: ${res.body}`);
  return res.json() as any;
}
async function agent(app: App, apiKey: string, name: string) {
  return (
    await ok(app, apiKey, 'city_create_agent', {
      name,
      description: 'Synthetic room member',
      capability: 'research',
      mode: 'external',
      idempotencyKey: randomUUID(),
    })
  ).agent.id as string;
}
const post = async (app: App, apiKey: string, roomId: string, text: string) =>
  (
    await ok(app, apiKey, 'city_room_post', {
      room_id: roomId,
      text,
      idempotency_key: randomUUID(),
    })
  ).message.seq as number;

function sandbox(): FakeRepo {
  return {
    id: 9301,
    owner: 'example-org',
    name: 'parity',
    installation: INSTALLATION,
    private: true,
    default_branch: 'main',
    branches: { main: head },
    commits: { [head]: { 'README.md': '# Parity sandbox\n' } },
  };
}

async function fixture(t: { after: (fn: () => Promise<unknown>) => void }) {
  const gh = fakeGitHub({ appId: APP_ID, publicKey: appKey.publicKey, repos: [sandbox()] });
  const allow = new Map<number, string>();
  let repos: RoomRepos | undefined;
  const app = await createApp({
    dataDir: ':memory:',
    startWorkers: false,
    roomRepos: (deps: { db: any; clock(): number }) =>
      (repos = createRoomRepos({
        db: deps.db,
        clock: deps.clock,
        limit: async () => {},
        github: createGitHubApp({ appId: APP_ID, privateKey: appKey.pem }, gh.transport),
        installationOwners: allow,
      })),
  } as Parameters<typeof createApp>[0]);
  t.after(() => app.close());
  const a = await owner(app, 'Parity host');
  allow.set(INSTALLATION, a.id);
  const hostAgent = await agent(app, a.key, 'Host AI');
  const created = await ok(app, a.key, 'city_create_room', {
    agent_id: hostAgent,
    name: 'Parity desk',
    topic: 'Guest parity',
    history: 'full',
    idempotency_key: randomUUID(),
  });
  const roomId = created.room.id as string;
  const guest = await invite(app, a, roomId, 'Invited desk');
  return { app, repos: repos!, a, hostAgent, roomId, link: created.link.link as string, guest };
}

let guestAddress = 70;
async function invite(app: App, a: { id: string; cookie: string }, roomId: string, name: string) {
  const link = await app.inject({
    method: 'POST',
    url: '/api/links',
    headers: { ...jsonHeaders, cookie: a.cookie, 'x-city-workspace': a.id },
    payload: JSON.stringify({ target: 'room', room_id: roomId }),
  });
  assert.equal(link.statusCode, 201, link.body);
  const code = new URL(link.json().url).pathname.split('/').at(-1)!;
  const remoteAddress = `203.0.113.${guestAddress++}`;
  const anon = (url: string, body: unknown) =>
    app.inject({
      method: 'POST',
      url,
      headers: jsonHeaders,
      payload: JSON.stringify(body),
      remoteAddress,
    });
  const start = await anon('/api/public/invites/bootstrap', { code });
  assert.equal(start.statusCode, 200, start.body);
  const joined = await anon('/api/public/invites/redeem', {
    code,
    handle: start.json().handle,
    name,
  });
  assert.equal(joined.statusCode, 200, joined.body);
  const credential = joined.json().credential as string;
  const call = (tool: string, body: unknown = {}) =>
    app.inject({
      method: 'POST',
      url: `/api/public/invites/tools/${tool}`,
      headers: { ...jsonHeaders, authorization: `Bearer ${credential}` },
      payload: JSON.stringify(body),
      remoteAddress,
    });
  return { call, agentId: joined.json().agent_id as string, roomId: joined.json().room_id };
}

test('the guest tool list includes the member read and write tools', () => {
  for (const tool of [
    'city_room_pins',
    'city_room_brief',
    'city_room_pin',
    'city_room_unpin',
    'city_room_overview',
    'city_mentions',
    'city_ack_mentions',
  ])
    assert.ok((GUEST_ROOM_TOOLS as readonly string[]).includes(tool), tool);
  assert.ok(!(GUEST_REPO_TOOLS as readonly string[]).includes('city_room_apply'));
});

test('a guest lists pins, fetches the brief twice, pins and unpins its own pin only', async (t) => {
  const f = await fixture(t);
  const seq = await post(f.app, f.a.key, f.roomId, 'Start with the checklist.');
  const hostPin = await ok(f.app, f.a.key, 'city_room_pin', {
    room_id: f.roomId,
    message_seq: seq,
    note: 'Start here',
  });
  const listed = await f.guest.call('city_room_pins');
  assert.equal(listed.statusCode, 200, listed.body);
  assert.equal(listed.json().pins.length, 1);
  assert.equal(listed.json().pins[0].note, 'Start here');
  for (let i = 0; i < 2; i++) {
    const brief = await f.guest.call('city_room_brief');
    assert.equal(brief.statusCode, 200, brief.body);
    assert.match(brief.json().brief, /Start here/);
  }
  // The guest pins as itself and unpins its own pin, as any member.
  const second = await post(f.app, f.a.key, f.roomId, 'Then the release notes.');
  const own = await f.guest.call('city_room_pin', { message_seq: second, note: 'Guest note' });
  assert.equal(own.statusCode, 200, own.body);
  assert.equal(own.json().pin.pinned_by_agent_id, f.guest.agentId);
  // Another member's (the host's) pin stays the host's to remove.
  const others = await f.guest.call('city_room_unpin', { pin_id: hostPin.pin.id });
  assert.equal(others.statusCode, 403, others.body);
  assert.equal(others.json().code, 'not_pinner');
  const removed = await f.guest.call('city_room_unpin', { pin_id: own.json().pin.id });
  assert.equal(removed.statusCode, 200, removed.body);
  assert.equal(removed.json().removed, true);
});

test('a guest reads the overview and its own mentions only', async (t) => {
  const f = await fixture(t);
  const other = await invite(f.app, f.a, f.roomId, 'Other desk');
  await post(f.app, f.a.key, f.roomId, '@"Invited desk" please look');
  await post(f.app, f.a.key, f.roomId, '@"Other desk" not for you');
  const overview = await f.guest.call('city_room_overview');
  assert.equal(overview.statusCode, 200, overview.body);
  assert.equal(overview.json().room_id ?? f.roomId, f.roomId);
  const mine = await f.guest.call('city_mentions');
  assert.equal(mine.statusCode, 200, mine.body);
  assert.equal(mine.json().agent_id, f.guest.agentId);
  assert.equal(mine.json().mentions.length, 1);
  assert.match(mine.json().mentions[0].excerpt, /please look/);
  const [replyLine] = mine.json().next_actions as string[];
  assert.match(replyLine!, /city_room_post room_credential, reply_to: \d+$/);
  // Another agent's mentions are refused, not read.
  const theirs = await f.guest.call('city_mentions', { agent_id: other.agentId });
  assert.equal(theirs.statusCode, 403, theirs.body);
  assert.equal(theirs.json().code, 'room_credential_denied');
  const acked = await f.guest.call('city_ack_mentions', { seq: mine.json().latest_seq });
  assert.equal(acked.statusCode, 200, acked.body);
  const after = await f.guest.call('city_mentions', { since: 0 });
  assert.equal(after.json().next_actions, undefined, 'read mentions get no reply suggestion');
  assert.equal(acked.json().unread, 0);
  // The other guest's mention is untouched.
  const still = await other.call('city_mentions');
  assert.equal(still.json().mentions.length, 1);
});

test('a guest views and reads the room repository', async (t) => {
  const f = await fixture(t);
  await f.repos.bind(
    { operatorId: f.a.id, actor: 'console', origin: 'http://localhost', console: true },
    {
      room_id: f.roomId,
      repo: 'example-org/parity',
      acknowledge_member_read: true,
      confirm_repo: 'example-org/parity',
    },
  );
  const view = await f.guest.call('city_room_repo');
  assert.equal(view.statusCode, 200, view.body);
  assert.equal(view.json().binding.repo, 'example-org/parity');
  assert.equal(view.json().can_apply, false);
  const read = await f.guest.call('city_room_repo_read', { path: 'README.md' });
  assert.equal(read.statusCode, 200, read.body);
  assert.match(JSON.stringify(read.json()), /Parity sandbox/);
});

test('host-only, cross-room and unknown calls are refused clearly', async (t) => {
  const f = await fixture(t);
  const apply = await f.guest.call('city_room_apply', {});
  assert.equal(apply.statusCode, 403, apply.body);
  assert.equal(apply.json().code, 'host_only');
  const cross = await f.guest.call('city_room_pins', { room_id: randomUUID() });
  assert.equal(cross.statusCode, 403, cross.body);
  assert.equal(cross.json().code, 'room_credential_denied');
  const unknown = await f.guest.call('city_not_a_tool');
  assert.equal(unknown.statusCode, 404, unknown.body);
  assert.match(unknown.json().message ?? unknown.json().error, /city_room_pins/);
  assert.match(unknown.json().message ?? unknown.json().error, /city_room_repo_read/);
  // A removed guest reads nothing more.
  await f.app.city.db.query('UPDATE room_members SET removed_at=1 WHERE agent_id=$1', [
    f.guest.agentId,
  ]);
  const gone = await f.guest.call('city_room_pins');
  assert.notEqual(gone.statusCode, 200, gone.body);
});
