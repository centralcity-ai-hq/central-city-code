import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { createApp } from '../server/app.js';
import { ASSISTANT_SCOPES } from '../shared/assistant.js';
import { createRoomRepos, type RoomRepos } from '../server/rooms/repos/service.js';
import { createGitHubApp } from '../server/rooms/repos/github.js';
import { registerRoomCodeMigration } from '../server/rooms/repos/schema.js';
import { registerRoomRepoRoutes } from '../server/rooms/repos/routes.js';
import { repoPreviewOutput } from '../server/rooms/repos/contract.js';
import { commitSha, fakeGitHub, generateAppKey, type FakeRepo } from './fake-github.js';

registerRoomCodeMigration();

/**
 * Console REST for connecting a repository (docs/ROOM_REPOS.md "Binding (console only)"): host session only, preview with the
 * private-repo notice, explicit confirmation (the notice ticked and the name typed), the CSRF
 * guard, the flag, and refusal for every non-console principal. The routes are registered here on
 * the real app with a session-cookie owner() equivalent to the console's; fake GitHub only.
 */
type App = Awaited<ReturnType<typeof createApp>>;
const jsonHeaders = { 'content-type': 'application/json', 'x-city-request': '1' };
const APP_ID = '424242';
const INSTALLATION = 77;
const key = generateAppKey();
const head = commitSha('routes-main');

class HttpError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
  }
}
const fail = (code: number, message: string): never => {
  throw new HttpError(code, message);
};

let addressCounter = 21;
async function owner(app: App, name: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/public/workspaces',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ name, idempotency_key: randomUUID() }),
    remoteAddress: `192.0.${addressCounter++ % 250}.50`,
  });
  assert.equal(res.statusCode, 201, res.body);
  const id = res.json().workspace_id as string;
  const person = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    headers: jsonHeaders,
    payload: JSON.stringify({
      name: `Routes co-owner ${addressCounter}`,
      password: 'Synthetic co-owner password',
    }),
    remoteAddress: `192.0.${addressCounter++ % 250}.51`,
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
    payload: JSON.stringify({ label: 'routes tester', scopes: [...ASSISTANT_SCOPES] }),
  });
  assert.equal(minted.statusCode, 201, minted.body);
  return { id, cookie, key: minted.json().workspace_key as string };
}
async function tool(app: App, apiKey: string, name: string, args: unknown) {
  const res = await app.inject({
    method: 'POST',
    url: `/api/assistant/tools/${name}`,
    headers: { ...jsonHeaders, authorization: `Bearer ${apiKey}` },
    payload: JSON.stringify(args),
  });
  assert.equal(res.statusCode, 200, `${name}: ${res.body}`);
  return res.json() as any;
}

function sandbox(): FakeRepo {
  return {
    id: 9201,
    owner: 'example-org',
    name: 'sandbox',
    installation: INSTALLATION,
    private: true,
    default_branch: 'main',
    branches: { main: head },
    commits: { [head]: { 'README.md': '# Sandbox\n' } },
  };
}

async function fixture(t: { after: (fn: () => Promise<unknown>) => void }) {
  const gh = fakeGitHub({ appId: APP_ID, publicKey: key.publicKey, repos: [sandbox()] });
  // Filled in once the host workspace exists.
  const allow = new Map<number, string>();
  const build = (deps: { db: any; clock(): number; limit(...args: any[]): Promise<void> }) =>
    createRoomRepos({
      db: deps.db,
      clock: deps.clock,
      limit: async () => {},
      github: createGitHubApp({ appId: APP_ID, privateKey: key.pem }, gh.transport),
      installationOwners: allow,
    });
  let repos: RoomRepos | undefined;
  // Once wired (server/app.ts), the app builds the service through this test hook and serves the
  // real console routes with the real owner(); before that, the routes are registered here.
  const app = await createApp({
    dataDir: ':memory:',
    startWorkers: false,
    roomRepos: (deps: Parameters<typeof build>[0]) => (repos = build(deps)),
  } as Parameters<typeof createApp>[0]);
  t.after(() => app.close());
  const wired = app.hasRoute({ method: 'GET', url: '/api/rooms/:room/repo' });
  if (!wired) repos = build({ db: app.city.db, clock: Date.now, limit: async () => {} });
  // The console's owner(): the signed-in session (cookie) and an optional co-owned workspace.
  const consoleOwner = async (request: FastifyRequest) => {
    const token = request.cookies.cc_session;
    if (!token) fail(401, 'Sign in to continue.');
    const person = (
      await app.city.db.query<{ operator_id: string }>(
        'SELECT operator_id FROM sessions WHERE token_hash=$1',
        [createHash('sha256').update(token!).digest('hex')],
      )
    ).rows[0];
    if (!person) fail(401, 'Sign in to continue.');
    const selected = request.headers['x-city-workspace'];
    if (typeof selected !== 'string') return { id: person!.operator_id, name: 'person' } as any;
    const link = (
      await app.city.db.query(
        'SELECT 1 FROM operator_links WHERE human_operator_id=$1 AND ai_operator_id=$2',
        [person!.operator_id, selected],
      )
    ).rows[0];
    if (!link) fail(404, 'Workspace not found.');
    return { id: selected, name: 'workspace' } as any;
  };
  if (!wired)
    registerRoomRepoRoutes(app, {
      repos: repos!,
      owner: consoleOwner,
      originOf: () => 'http://localhost',
      fail,
    });
  const a = await owner(app, 'Routes host workspace');
  const b = await owner(app, 'Routes member workspace');
  allow.set(INSTALLATION, a.id);
  const host = (
    await tool(app, a.key, 'city_create_agent', {
      name: 'Routes host',
      description: 'Synthetic host',
      capability: 'research',
      mode: 'external',
      idempotencyKey: randomUUID(),
    })
  ).agent.id as string;
  const member = (
    await tool(app, b.key, 'city_create_agent', {
      name: 'Routes member',
      description: 'Synthetic member',
      capability: 'research',
      mode: 'external',
      idempotencyKey: randomUUID(),
    })
  ).agent.id as string;
  const room = await tool(app, a.key, 'city_create_room', {
    agent_id: host,
    name: 'Synthetic routes room',
    topic: 'Routes test topic',
    idempotency_key: randomUUID(),
  });
  await tool(app, b.key, 'city_join_room', {
    link: room.link.link,
    agent_id: member,
    idempotency_key: randomUUID(),
  });
  return { app, gh, repos: repos!, a, b, roomId: room.room.id as string };
}

const send = (
  f: Awaited<ReturnType<typeof fixture>>,
  who: { id: string; cookie: string } | null,
  method: 'GET' | 'POST',
  path: string,
  payload?: unknown,
  headers: Record<string, string> = {},
) =>
  f.app.inject({
    method,
    url: `/api/rooms/${f.roomId}/repo${path}`,
    headers: {
      ...(method === 'POST' ? jsonHeaders : {}),
      ...(who ? { cookie: who.cookie, 'x-city-workspace': who.id } : {}),
      ...headers,
    },
    ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
  });

function withFlag(t: { after: (fn: () => void) => void }, value: string | undefined) {
  const saved = process.env.CITY_ROOM_REPOS;
  if (value === undefined) delete process.env.CITY_ROOM_REPOS;
  else process.env.CITY_ROOM_REPOS = value;
  t.after(() => {
    if (saved === undefined) delete process.env.CITY_ROOM_REPOS;
    else process.env.CITY_ROOM_REPOS = saved;
  });
}

test('the host previews, ticks the notice, types the name, and connects; then disconnects', async (t) => {
  withFlag(t, '1');
  const f = await fixture(t);
  const preview = await send(f, f.a, 'POST', '/preview', { repo: 'example-org/sandbox' });
  assert.equal(preview.statusCode, 200, preview.body);
  const shown = preview.json();
  assert.equal(repoPreviewOutput.safeParse(shown).success, true);
  assert.equal(shown.private, true);
  assert.equal(shown.confirm_repo, 'example-org/sandbox');
  assert.match(
    shown.notice,
    /All members of this room will be able to read files in example-org\/sandbox \(a private repository\)/,
  );
  assert.match(shown.notice, /CI with its secrets/);

  // No notice ticked, or the wrong name typed: nothing is connected.
  const unticked = await send(f, f.a, 'POST', '', {
    repo: 'example-org/sandbox',
    confirm_repo: 'example-org/sandbox',
  });
  assert.equal(unticked.statusCode, 400, unticked.body);
  const mistyped = await send(f, f.a, 'POST', '', {
    repo: 'example-org/sandbox',
    acknowledge_member_read: true,
    confirm_repo: 'example-org/sandbo',
  });
  assert.equal(mistyped.statusCode, 400, mistyped.body);
  assert.match(mistyped.body, /Type the repository name/);
  // Missing request protection header (CSRF guard).
  const forged = await send(
    f,
    f.a,
    'POST',
    '',
    {
      repo: 'example-org/sandbox',
      acknowledge_member_read: true,
      confirm_repo: 'example-org/sandbox',
    },
    { 'x-city-request': '0' },
  );
  assert.equal(forged.statusCode, 403, forged.body);
  let bindings = await f.app.city.db.query('SELECT 1 FROM room_repo_bindings');
  assert.equal(bindings.rows.length, 0);

  const bound = await send(f, f.a, 'POST', '', {
    repo: 'example-org/sandbox',
    acknowledge_member_read: true,
    confirm_repo: 'example-org/sandbox',
  });
  assert.equal(bound.statusCode, 201, bound.body);
  assert.equal(bound.json().binding.repo, 'example-org/sandbox');
  const events = (
    await f.app.city.db.query<{ actor: string; action: string }>(
      "SELECT actor,action FROM room_events WHERE room_id=$1 AND action LIKE 'repo.%'",
      [f.roomId],
    )
  ).rows;
  assert.deepEqual(events, [{ actor: 'the host (console)', action: 'repo.bound' }]);
  const got = await send(f, f.b, 'GET', '');
  assert.equal(got.statusCode, 200, got.body);
  assert.equal(got.json().binding.repo, 'example-org/sandbox');
  assert.equal(got.json().can_apply, false);

  // A member who is not the host can neither preview nor connect nor disconnect.
  assert.equal(
    (await send(f, f.b, 'POST', '/preview', { repo: 'example-org/sandbox' })).statusCode,
    403,
  );
  assert.equal((await send(f, f.b, 'POST', '/disconnect', {})).statusCode, 403);

  const off = await send(f, f.a, 'POST', '/disconnect', {});
  assert.equal(off.statusCode, 200, off.body);
  assert.deepEqual(off.json(), { room_id: f.roomId, unbound: true });
  bindings = await f.app.city.db.query("SELECT 1 FROM room_repo_bindings WHERE status='active'");
  assert.equal(bindings.rows.length, 0);
});

test('only a signed-in console session reaches the routes; the flag hides them', async (t) => {
  withFlag(t, '1');
  const f = await fixture(t);
  // No session, and a bearer workspace key instead of a session, are both refused.
  assert.equal((await send(f, null, 'GET', '')).statusCode, 401);
  const bearer = await send(
    f,
    null,
    'POST',
    '/preview',
    { repo: 'example-org/sandbox' },
    {
      authorization: `Bearer ${f.a.key}`,
    },
  );
  assert.equal(bearer.statusCode, 401, bearer.body);
  // The service refuses every principal that is not the console, whatever the caller.
  const p = { operatorId: f.a.id, actor: 'workspace key', origin: 'http://localhost' };
  for (const call of [
    () => f.repos.preview(p, { room_id: f.roomId, repo: 'example-org/sandbox' }),
    () =>
      f.repos.bind(p, {
        room_id: f.roomId,
        repo: 'example-org/sandbox',
        acknowledge_member_read: true,
        confirm_repo: 'example-org/sandbox',
      }),
    () => f.repos.unbind(p, { room_id: f.roomId }),
  ])
    await assert.rejects(
      call(),
      (error: { errorCode?: string }) => error.errorCode === 'console_only',
    );
  withFlag(t, undefined);
  // Off: reading answers a plain 'not available' (no 404 for the room to log); writes stay 404.
  const off = await send(f, f.a, 'GET', '');
  assert.equal(off.statusCode, 200);
  assert.deepEqual(JSON.parse(off.body), { available: false });
  assert.equal(
    (await send(f, f.a, 'POST', '/preview', { repo: 'example-org/sandbox' })).statusCode,
    404,
  );
});
