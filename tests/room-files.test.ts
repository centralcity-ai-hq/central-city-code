import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createApp } from '../server/app.js';
import { ASSISTANT_SCOPES } from '../shared/assistant.js';
import { ARTIFACT_LIMITS, roomArtifactsMigration } from '../server/rooms/artifacts.js';
import { ROOM_FILE_TOOLS, roomFileOutputSchemas } from '../server/rooms/artifacts-tools.js';
import { ROOM_FILES_PURGE_PATH } from '../server/rooms/artifacts-routes.js';
import { memoryArtifactStore } from '../server/rooms/artifact-store.js';
import { remoteInputSchemas, remoteOutputSchemas } from '../server/remote-mcp/tools.js';
import { ASSISTANT_TOOL_SCOPES } from '../server/assistant-access.js';
import { GUEST_ROOM_TOOLS } from '../server/links/invites.js';

process.env.CITY_ROOM_TASKS = '1';
process.env.CITY_INVITE_FLOW = '1';
process.env.CRON_SECRET ??= 'synthetic-files-cron-secret';
process.env.CITY_RATE_LIMIT_KEY ??= 'synthetic-files-test-root-not-a-real-secret';

/**
 * Room files (docs/ROOMS.md "Room files"): upload through a presigned PUT (an in-memory store
 * here), finalize, versions, the checks on the bytes, quotas, console-only delete, purge and the
 * guest path. Synthetic data only.
 */
type App = Awaited<ReturnType<typeof createApp>>;
const jsonHeaders = { 'content-type': 'application/json', 'x-city-request': '1' };

async function fixture(t: { after: (fn: () => Promise<unknown>) => void }) {
  const app = await createApp({ dataDir: ':memory:', startWorkers: false });
  t.after(() => app.close());
  return app;
}
function call(app: App, key: string, name: string, args: unknown = {}) {
  return app.inject({
    method: 'POST',
    url: `/api/assistant/tools/${name}`,
    headers: { ...jsonHeaders, authorization: `Bearer ${key}` },
    payload: JSON.stringify(args),
  });
}
async function ok(app: App, key: string, name: string, args: unknown = {}) {
  const res = await call(app, key, name, args);
  assert.equal(res.statusCode, 200, `${name}: ${res.body}`);
  return res.json();
}
async function fails(app: App, key: string, name: string, args: unknown, code: string) {
  const res = await call(app, key, name, args);
  assert.notEqual(res.statusCode, 200, `${name} should fail: ${res.body}`);
  assert.equal(res.json().code, code, res.body);
  return res;
}
let addressCounter = 1;
type Owner = { id: string; key: string; cookie: string };
async function owner(app: App, name: string): Promise<Owner> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/public/workspaces',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ name, idempotency_key: randomUUID() }),
    remoteAddress: `198.51.${addressCounter++}.70`,
  });
  assert.equal(res.statusCode, 201, res.body);
  const id = res.json().workspace_id as string;
  const person = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    headers: jsonHeaders,
    payload: JSON.stringify({
      name: `Cards owner ${addressCounter}`,
      password: 'Synthetic cards owner password',
    }),
    remoteAddress: `198.51.${addressCounter++}.71`,
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
    payload: JSON.stringify({ label: 'cards test', scopes: [...ASSISTANT_SCOPES] }),
  });
  assert.equal(minted.statusCode, 201, minted.body);
  return { id, key: minted.json().workspace_key as string, cookie };
}
async function agent(app: App, key: string, name: string) {
  const body = await ok(app, key, 'city_create_agent', {
    name,
    description: 'Synthetic room member',
    capability: 'research',
    mode: 'external',
    idempotencyKey: randomUUID(),
  });
  return body.agent.id as string;
}
/** Console REST as the owner's person, acting in its workspace. */
function rest(app: App, o: Owner, method: 'GET' | 'POST' | 'DELETE', url: string, body?: unknown) {
  return app.inject({
    method,
    url,
    headers: { ...jsonHeaders, cookie: o.cookie, 'x-city-workspace': o.id },
    ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
  });
}
async function room(app: App) {
  const a = await owner(app, 'Cards host');
  const hostAgent = await agent(app, a.key, 'Host AI');
  const created = await ok(app, a.key, 'city_create_room', {
    agent_id: hostAgent,
    name: 'Decision desk',
    topic: 'Settle the launch plan',
    history: 'full',
    idempotency_key: randomUUID(),
  });
  return { a, hostAgent, roomId: created.room.id as string, link: created.link.link as string };
}
async function member(app: App, link: string, name = 'Member') {
  const b = await owner(app, name);
  const agentId = await agent(app, b.key, `${name} AI`);
  await ok(app, b.key, 'city_join_room', {
    link,
    agent_id: agentId,
    idempotency_key: randomUUID(),
  });
  return { ...b, agentId };
}
/** An invite-link AI with no account behind it (an unclaimed owner). */
async function guest(app: App, a: Owner, roomId: string) {
  const link = await rest(app, a, 'POST', '/api/links', { target: 'room', room_id: roomId });
  assert.equal(link.statusCode, 201, link.body);
  const code = new URL(link.json().url).pathname.split('/').at(-1)!;
  const address = `203.0.113.${addressCounter++}`;
  const publicPost = (url: string, body: unknown, extra = {}) =>
    app.inject({
      method: 'POST',
      url,
      headers: { ...jsonHeaders, ...extra },
      payload: JSON.stringify(body),
      remoteAddress: address,
    });
  const start = await publicPost('/api/public/invites/bootstrap', { code });
  assert.equal(start.statusCode, 200, start.body);
  const joined = await publicPost('/api/public/invites/redeem', {
    code,
    handle: start.json().handle,
    name: 'Invited AI',
  });
  assert.equal(joined.statusCode, 200, joined.body);
  const credential = joined.json().credential as string;
  const invoke = (tool: string, args: unknown = {}) =>
    publicPost(`/api/public/invites/tools/${tool}`, args, {
      authorization: `Bearer ${credential}`,
    });
  return { invoke, agentId: joined.json().agent_id as string, credential };
}
/** A stored (uncompressed) zip with the given entry names, for the listing checks. */
function zipOf(names: string[]): Uint8Array {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const name of names) {
    const nameBytes = Buffer.from(name);
    const data = Buffer.from('x');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    parts.push(local, nameBytes, data);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(nameBytes.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBytes);
    offset += local.length + nameBytes.length + data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(names.length, 8);
  end.writeUInt16LE(names.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...parts, directory, end]));
}

async function filesFixture(t: { after: (fn: () => Promise<unknown>) => void }) {
  const store = memoryArtifactStore();
  const app = await createApp({ dataDir: ':memory:', startWorkers: false, artifactStore: store });
  t.after(() => app.close());
  return { app, store };
}

/** Start, PUT (to the memory store) and finalize one file as an AI with a workspace key. */
async function share(
  app: App,
  store: ReturnType<typeof memoryArtifactStore>,
  key: string,
  roomId: string,
  name: string,
  bytes: Uint8Array,
) {
  const started = await ok(app, key, 'city_room_file_upload', {
    room_id: roomId,
    name,
    size_bytes: bytes.byteLength,
  });
  assert.ok(roomFileOutputSchemas.city_room_file_upload.safeParse(started).success);
  store.upload(started.upload.url, bytes, started.upload.headers['content-type']);
  return call(app, key, 'city_room_file_finalize', {
    room_id: roomId,
    file: started.file_id,
    version: started.version,
  });
}

test('the file tools are registered, offered to guests, and none of them deletes', () => {
  for (const name of ROOM_FILE_TOOLS) {
    assert.ok(remoteInputSchemas[name as keyof typeof remoteInputSchemas], name);
    assert.ok(remoteOutputSchemas[name as keyof typeof remoteOutputSchemas], name);
    assert.equal(ASSISTANT_TOOL_SCOPES[name], 'rooms:join');
    // A guest's credential holds one room: it has nothing to share across rooms.
    assert.equal(
      (GUEST_ROOM_TOOLS as readonly string[]).includes(name),
      name !== 'city_room_file_share',
      `${name} for guests`,
    );
  }
  for (const name of Object.keys(ASSISTANT_TOOL_SCOPES))
    assert.doesNotMatch(name, /file.*(delete|remove)/, name);
  assert.equal(roomArtifactsMigration.version, 331);
  assert.doesNotMatch(roomArtifactsMigration.sql, /\b(DROP|ALTER|DELETE|UPDATE|TRUNCATE)\b/i);
});

test('without a store every file tool answers 503 and the list says files are off', async (t) => {
  const app = await fixture(t);
  const { a, roomId } = await room(app);
  const listed = await ok(app, a.key, 'city_room_files', { room_id: roomId });
  assert.equal(listed.available, false);
  await fails(
    app,
    a.key,
    'city_room_file_upload',
    { room_id: roomId, name: 'notes.md', size_bytes: 10 },
    'files_unavailable',
  );
});

test('a member shares a file, a new version supersedes it, and AIs get its text pages', async (t) => {
  const { app, store } = await filesFixture(t);
  const { a, roomId, link } = await room(app);
  const b = await member(app, link, 'Bravo');
  const v1 = new TextEncoder().encode('# Spec\nline two\n');
  const first = await share(app, store, b.key, roomId, 'spec.md', v1);
  assert.equal(first.statusCode, 200, first.body);
  const done = first.json();
  assert.equal(done.finalized, true);
  assert.equal(done.file.current_version, 1);
  assert.equal(done.versions[0].status, 'ready');
  assert.equal(done.versions[0].sha256, createHash('sha256').update(v1).digest('hex'));
  assert.equal(done.versions[0].kind, 'text');
  assert.equal(done.versions[0].text_pages, 1);
  assert.equal(done.versions[0].uploaded_by, 'Bravo AI');
  // Every member sees it; the text page is stored for the AI read path.
  const listed = await ok(app, a.key, 'city_room_files', { room_id: roomId });
  assert.equal(listed.available, true);
  assert.deepEqual(
    listed.files.map((file: { name: string }) => file.name),
    ['spec.md'],
  );
  assert.equal(listed.usage.bytes, v1.byteLength);
  const page = (
    await app.city.db.query<{ text: string; room_id: string }>(
      'SELECT text, room_id FROM room_artifact_text WHERE artifact_id=$1',
      [done.file.id],
    )
  ).rows[0]!;
  assert.equal(page.room_id, roomId);
  assert.match(page.text, /line two/);
  // The same name again: version 2 is current, version 1 superseded (kept 30 days).
  const v2 = new TextEncoder().encode('# Spec\nline two, revised\n');
  const second = (await share(app, store, b.key, roomId, 'spec.md', v2)).json();
  assert.equal(second.file.current_version, 2);
  assert.equal(second.versions[1].version, 1);
  assert.ok(second.versions[1].superseded_at);
  // A finalize of a version that is no longer pending changes nothing.
  const again = await ok(app, b.key, 'city_room_file_finalize', {
    room_id: roomId,
    file: done.file.id,
    version: 1,
  });
  assert.equal(again.finalized, false);
  // Only the uploader's owner finalizes; another member cannot.
  const started = await ok(app, b.key, 'city_room_file_upload', {
    room_id: roomId,
    name: 'later.txt',
    size_bytes: 3,
  });
  await fails(
    app,
    a.key,
    'city_room_file_finalize',
    { room_id: roomId, file: started.file_id, version: started.version },
    'not_uploader',
  );
  await fails(
    app,
    b.key,
    'city_room_file_finalize',
    { room_id: roomId, file: started.file_id, version: started.version },
    'not_uploaded',
  );
  // The feed gets reference-free lines, never the file name.
  const lines = (
    await app.city.db.query<{ parts: Array<{ text: string }> }>(
      "SELECT parts FROM room_messages WHERE room_id=$1 AND sender_kind='system' ORDER BY seq",
      [roomId],
    )
  ).rows.map((row) => row.parts[0]!.text);
  assert.ok(lines.includes('Bravo AI shared a file.'), lines.join('\n'));
  assert.ok(lines.includes('Bravo AI shared a new version of a file (version 2).'));
  assert.ok(!lines.some((text) => text.includes('spec.md')));
});

test('files are judged by their own bytes: wrong types, credentials, unsafe zips', async (t) => {
  const { app, store } = await filesFixture(t);
  const { a, roomId } = await room(app);
  const refused = async (name: string, bytes: Uint8Array, reason: RegExp) => {
    const res = await share(app, store, a.key, roomId, name, bytes);
    assert.equal(res.statusCode, 400, res.body);
    assert.equal(res.json().code, 'file_refused', res.body);
    assert.match(res.json().error, reason);
  };
  const text = (value: string) => new TextEncoder().encode(value);
  await refused('report.pdf', text('not a pdf'), /not a pdf/);
  await refused('photo.png', text('GIF89a'), /not a png/);
  await refused('notes.txt', new Uint8Array([0xff, 0xfe, 0x00]), /UTF-8/);
  await refused('env.txt', text('token crk_ABCDEFGHIJKLMNOPQRSTUV'), /credential/);
  await refused('bad.zip', zipOf(['ok.txt', '../escape.sh']), /unsafe path/);
  await refused('abs.zip', zipOf(['/etc/passwd']), /unsafe path/);
  // Refused bytes are deleted from the store at once.
  assert.equal(store.objects.size, 0);
  // Types outside the allowlist never get an upload URL.
  for (const name of ['run.exe', 'icon.svg', '.env', 'dir/file.txt'])
    await fails(
      app,
      a.key,
      'city_room_file_upload',
      { room_id: roomId, name, size_bytes: 10 },
      'file_type_not_allowed',
    );
  // A good zip is listed (entry names become its text page), never unpacked.
  const good = await share(
    app,
    store,
    a.key,
    roomId,
    'bundle.zip',
    zipOf(['src/a.ts', 'README.md']),
  );
  assert.equal(good.statusCode, 200, good.body);
  const pdf = await share(app, store, a.key, roomId, 'real.pdf', text('%PDF-1.7\n%%EOF\n'));
  assert.equal(pdf.statusCode, 200, pdf.body);
  assert.equal(pdf.json().versions[0].kind, 'pdf');
  // An upload whose size differs from what it declared is refused.
  const started = await ok(app, a.key, 'city_room_file_upload', {
    room_id: roomId,
    name: 'short.txt',
    size_bytes: 10,
  });
  store.upload(started.upload.url, text('abc'), started.upload.headers['content-type']);
  await fails(
    app,
    a.key,
    'city_room_file_finalize',
    { room_id: roomId, file: started.file_id, version: started.version },
    'file_refused',
  );
});

test('inline put, download links within the egress budget, and the room quota', async (t) => {
  const { app, store } = await filesFixture(t);
  const { a, roomId } = await room(app);
  const content = Buffer.from('id,name\n1,alpha\n');
  const put = await ok(app, a.key, 'city_room_file_put', {
    room_id: roomId,
    name: 'table.csv',
    content_base64: content.toString('base64'),
  });
  assert.equal(put.finalized, true);
  const link = await ok(app, a.key, 'city_room_file_download', {
    room_id: roomId,
    file: 'table.csv',
  });
  assert.ok(roomFileOutputSchemas.city_room_file_download.safeParse(link).success);
  assert.match(link.url, /^memory:\/\/get\//);
  assert.equal(link.size_bytes, content.byteLength);
  assert.ok(Date.parse(link.expires_at) - Date.now() <= 61_000, 'links live 60 seconds');
  // Past 80% of the monthly egress budget, downloads pause (the text view keeps working).
  const scope = `egress:${new Date().toISOString().slice(0, 7)}`;
  await app.city.db.query('UPDATE room_storage_counters SET bytes=$2 WHERE scope=$1', [
    scope,
    Math.floor(ARTIFACT_LIMITS.monthlyEgressBytes * ARTIFACT_LIMITS.egressStopShare),
  ]);
  await fails(
    app,
    a.key,
    'city_room_file_download',
    { room_id: roomId, file: 'table.csv' },
    'downloads_paused',
  );
  // The room quota counts every ready and pending version.
  const ready = (
    await app.city.db.query<{ artifact_id: string }>(
      'SELECT artifact_id FROM room_artifact_versions',
    )
  ).rows[0]!;
  await app.city.db.query(
    `INSERT INTO room_artifact_versions(artifact_id,version,room_id,blob_path,size_bytes,content_type,kind,status,
        uploaded_by_agent_id,uploaded_by_owner_id,created_at)
      VALUES($1,99,$2,'seeded/path',$3,'text/plain','text','pending','x',$4,$5)`,
    [ready.artifact_id, roomId, ARTIFACT_LIMITS.fileBytes, a.id, Date.now()],
  );
  for (let n = 0; n < 9; n++)
    await app.city.db.query(
      `INSERT INTO room_artifact_versions(artifact_id,version,room_id,blob_path,size_bytes,content_type,kind,status,
          uploaded_by_agent_id,uploaded_by_owner_id,created_at)
        VALUES($1,$2,$3,$4,$5,'text/plain','text','pending','x',$6,$7)`,
      [
        ready.artifact_id,
        100 + n,
        roomId,
        `seeded/${n}`,
        ARTIFACT_LIMITS.fileBytes,
        a.id,
        Date.now(),
      ],
    );
  await fails(
    app,
    a.key,
    'city_room_file_upload',
    { room_id: roomId, name: 'one-more.txt', size_bytes: 1 },
    'room_storage_full',
  );
  assert.ok(store.objects.size >= 1);
});

test('deleting is a person in the console; purge and room deletion free the bytes', async (t) => {
  const { app, store } = await filesFixture(t);
  const { a, roomId, link } = await room(app);
  const b = await member(app, link, 'Bravo');
  const bytes = new TextEncoder().encode('hello');
  const shared = (await share(app, store, b.key, roomId, 'hello.txt', bytes)).json();
  // Values the database can't take are bad requests, not 500s.
  for (const path of ['%00.pdf/versions', 'hello.txt/versions/99999999999/finalize']) {
    const method = path.endsWith('finalize') ? 'POST' : 'GET';
    const bad = await rest(app, b, method, `/api/rooms/${roomId}/files/${path}`, {});
    assert.equal(bad.statusCode, 400, `${path}: ${bad.body}`);
  }
  // No AI tool deletes.
  assert.equal((await call(app, b.key, 'city_room_file_delete', {})).statusCode, 404);
  // Another owner (not the host) cannot delete Bravo's file in the console.
  const c = await member(app, link, 'Charlie');
  const denied = await rest(app, c, 'DELETE', `/api/rooms/${roomId}/files/hello.txt`);
  assert.equal(denied.statusCode, 403, denied.body);
  // The uploader's person deletes it; the bytes go and the name is free again.
  const deleted = await rest(app, b, 'DELETE', `/api/rooms/${roomId}/files/hello.txt`);
  assert.equal(deleted.statusCode, 200, deleted.body);
  assert.equal(store.objects.size, 0);
  const again = await share(app, store, b.key, roomId, 'hello.txt', bytes);
  assert.equal(again.statusCode, 200, again.body);
  assert.notEqual(again.json().file.id, shared.file.id);
  // A superseded version past 30 days, and an upload left pending over an hour, are purged.
  await share(app, store, b.key, roomId, 'hello.txt', new TextEncoder().encode('hello 2'));
  await ok(app, b.key, 'city_room_file_upload', {
    room_id: roomId,
    name: 'never.txt',
    size_bytes: 4,
  });
  await app.city.db.query(
    'UPDATE room_artifact_versions SET superseded_at=1 WHERE superseded_at IS NOT NULL',
  );
  await app.city.db.query("UPDATE room_artifact_versions SET created_at=1 WHERE status='pending'");
  const anonymous = await app.inject({ method: 'GET', url: ROOM_FILES_PURGE_PATH });
  assert.equal(anonymous.statusCode, 404);
  const swept = await app.inject({
    method: 'GET',
    url: ROOM_FILES_PURGE_PATH,
    headers: { authorization: `Bearer ${process.env.CRON_SECRET}` },
  });
  assert.equal(swept.statusCode, 200, swept.body);
  assert.equal(swept.json().purged, 2);
  assert.equal(store.objects.size, 1, 'only the current version keeps its bytes');
  // Deleting the room marks every version for the purge, which then frees the bytes.
  const removed = await app.inject({
    method: 'DELETE',
    url: `/api/rooms/${roomId}`,
    headers: { ...jsonHeaders, cookie: a.cookie, 'x-city-workspace': a.id },
    payload: JSON.stringify({ confirm_name: 'Decision desk' }),
  });
  assert.equal(removed.statusCode, 200, removed.body);
  await app.inject({
    method: 'GET',
    url: ROOM_FILES_PURGE_PATH,
    headers: { authorization: `Bearer ${process.env.CRON_SECRET}` },
  });
  assert.equal(store.objects.size, 0);
});

test('an invite-link AI shares a file through the guest API', async (t) => {
  const { app, store } = await filesFixture(t);
  const { a, roomId } = await room(app);
  const g = await guest(app, a, roomId);
  const bytes = new TextEncoder().encode('guest notes');
  const started = await g.invoke('city_room_file_upload', {
    name: 'guest.md',
    size_bytes: bytes.byteLength,
  });
  assert.equal(started.statusCode, 200, started.body);
  store.upload(started.json().upload.url, bytes, started.json().upload.headers['content-type']);
  const done = await g.invoke('city_room_file_finalize', {
    file: started.json().file_id,
    version: started.json().version,
  });
  assert.equal(done.statusCode, 200, done.body);
  assert.equal(done.json().versions[0].uploaded_by, 'Invited AI');
  // Its own secret never goes into a file name.
  const smuggle = await g.invoke('city_room_file_upload', {
    name: `${g.credential.slice(4)}.txt`,
    size_bytes: 3,
  });
  assert.equal(smuggle.statusCode, 400, smuggle.body);
  const listed = await ok(app, a.key, 'city_room_files', { room_id: roomId });
  assert.equal(listed.files.length, 1);
});

test('refused and abandoned uploads never hold a file slot', async (t) => {
  const { app, store } = await filesFixture(t);
  const { a, roomId } = await room(app);
  const refused = await share(app, store, a.key, roomId, 'fake.pdf', new TextEncoder().encode('x'));
  assert.equal(refused.statusCode, 400, refused.body);
  await ok(app, a.key, 'city_room_file_upload', {
    room_id: roomId,
    name: 'never.txt',
    size_bytes: 4,
  });
  await app.city.db.query("UPDATE room_artifact_versions SET created_at=1 WHERE status='pending'");
  const swept = await app.inject({
    method: 'GET',
    url: ROOM_FILES_PURGE_PATH,
    headers: { authorization: `Bearer ${process.env.CRON_SECRET}` },
  });
  assert.equal(swept.json().purged, 1);
  // Both files are released (soft-deleted, names free); none counts toward the cap.
  const live = await app.city.db.query(
    'SELECT name FROM room_artifacts WHERE room_id=$1 AND deleted_at IS NULL',
    [roomId],
  );
  assert.deepEqual(live.rows, []);
  // Only files with a ready version count toward the cap: seed cap-1 ready + 5 empty.
  for (let n = 0; n < ARTIFACT_LIMITS.perRoom - 1; n++)
    await app.city.db.query(
      `INSERT INTO room_artifacts(id,room_id,name,current_version,created_by_owner_id,created_at)
        VALUES($1,$2,$3,1,$4,0)`,
      [randomUUID(), roomId, `seed-${n}.txt`, a.id],
    );
  for (let n = 0; n < 5; n++)
    await app.city.db.query(
      `INSERT INTO room_artifacts(id,room_id,name,current_version,created_by_owner_id,created_at)
        VALUES($1,$2,$3,0,$4,0)`,
      [randomUUID(), roomId, `empty-${n}.txt`, a.id],
    );
  const last = await share(app, store, a.key, roomId, 'last.txt', new TextEncoder().encode('ok'));
  assert.equal(last.statusCode, 200, last.body);
  await fails(
    app,
    a.key,
    'city_room_file_upload',
    { room_id: roomId, name: 'over.txt', size_bytes: 2 },
    'file_limit',
  );
});

test('finalize re-checks the member: other owner, other room, removed member, closed room', async (t) => {
  const { app, store } = await filesFixture(t);
  const { a, roomId, link, hostAgent } = await room(app);
  const b = await member(app, link, 'Bravo');
  const bytes = new TextEncoder().encode('hello');
  const start = async (key: string, name: string) =>
    ok(app, key, 'city_room_file_upload', { room_id: roomId, name, size_bytes: bytes.byteLength });
  const s1 = await start(b.key, 'one.txt');
  store.upload(s1.upload.url, bytes, s1.upload.headers['content-type']);
  await fails(
    app,
    a.key,
    'city_room_file_finalize',
    { room_id: roomId, file: s1.file_id, version: s1.version },
    'not_uploader',
  );
  const other = await ok(app, a.key, 'city_create_room', {
    agent_id: hostAgent,
    name: 'Other room',
    idempotency_key: randomUUID(),
  });
  await fails(
    app,
    a.key,
    'city_room_file_finalize',
    { room_id: other.room.id, file: s1.file_id, version: s1.version },
    'file_not_found',
  );
  await ok(app, a.key, 'city_room_remove', { room_id: roomId, agent_id: b.agentId });
  await fails(
    app,
    b.key,
    'city_room_file_finalize',
    { room_id: roomId, file: s1.file_id, version: s1.version },
    'room_not_found',
  );
  const s2 = await start(a.key, 'two.txt');
  store.upload(s2.upload.url, bytes, s2.upload.headers['content-type']);
  await ok(app, a.key, 'city_room_close', { room_id: roomId });
  await fails(
    app,
    a.key,
    'city_room_file_finalize',
    { room_id: roomId, file: s2.file_id, version: s2.version },
    'room_closed',
  );
});

test('the server says who may delete; disguised and odd archives are refused', async (t) => {
  const { app, store } = await filesFixture(t);
  const { a, roomId, link } = await room(app);
  const b = await member(app, link, 'Bravo');
  const c = await member(app, link, 'Charlie');
  await share(app, store, b.key, roomId, 'b.txt', new TextEncoder().encode('bravo'));
  const canDelete = async (o: Owner) =>
    (await rest(app, o, 'GET', `/api/rooms/${roomId}/files`)).json().files[0].can_delete;
  assert.equal(await canDelete(b), true, 'the creator, in the console');
  assert.equal(await canDelete(a), true, 'the host, in the console');
  assert.equal(await canDelete(c), false, 'another member');
  const overMcp = await ok(app, b.key, 'city_room_files', { room_id: roomId });
  assert.equal(overMcp.files[0].can_delete, false, 'never over MCP');
  // A newer version by another owner does not make the file theirs to delete.
  await share(app, store, c.key, roomId, 'b.txt', new TextEncoder().encode('charlie v2'));
  assert.equal(await canDelete(c), false);
  // HTML bytes under a PDF or PNG name are refused by their content.
  const html = new TextEncoder().encode('<html><script>alert(1)</script></html>');
  for (const name of ['report.pdf', 'image.png']) {
    const res = await share(app, store, b.key, roomId, name, html);
    assert.equal(res.json().code, 'file_refused', res.body);
  }
  const many = zipOf(Array.from({ length: 1001 }, (_, n) => `f${n}.txt`));
  assert.equal(
    (await share(app, store, b.key, roomId, 'many.zip', many)).json().code,
    'file_refused',
  );
  const enc = zipOf(['secret.txt']);
  // The encryption flag of the central directory entry (offset 8 of its header).
  const view = new DataView(enc.buffer, enc.byteOffset, enc.byteLength);
  for (let i = 0; i < enc.length - 4; i++)
    if (view.getUint32(i, true) === 0x02014b50) view.setUint16(i + 8, 1, true);
  assert.equal(
    (await share(app, store, b.key, roomId, 'enc.zip', enc)).json().code,
    'file_refused',
  );
});

test('the download budget and the global ceiling hold at their boundaries', async (t) => {
  const { app, store } = await filesFixture(t);
  const { a, roomId } = await room(app);
  const bytes = new TextEncoder().encode('0123456789');
  await share(app, store, a.key, roomId, 'ten.txt', bytes);
  const scope = `egress:${new Date().toISOString().slice(0, 7)}`;
  const cap = Math.floor(ARTIFACT_LIMITS.monthlyEgressBytes * ARTIFACT_LIMITS.egressStopShare);
  await app.city.db.query(
    'INSERT INTO room_storage_counters(scope,bytes) VALUES($1,$2) ON CONFLICT (scope) DO UPDATE SET bytes=$2',
    [scope, cap - 10],
  );
  await ok(app, a.key, 'city_room_file_download', { room_id: roomId, file: 'ten.txt' });
  await fails(
    app,
    a.key,
    'city_room_file_download',
    { room_id: roomId, file: 'ten.txt' },
    'downloads_paused',
  );
  await app.city.db.query(
    "INSERT INTO room_storage_counters(scope,bytes) VALUES('global',$1) ON CONFLICT (scope) DO UPDATE SET bytes=$1",
    [ARTIFACT_LIMITS.globalStoredBytes - 20],
  );
  await ok(app, a.key, 'city_room_file_upload', { room_id: roomId, name: 'p.txt', size_bytes: 15 });
  await fails(
    app,
    a.key,
    'city_room_file_upload',
    { room_id: roomId, name: 'q.txt', size_bytes: 15 },
    'storage_full',
  );
});

test('two finalizes of the same upload publish it once', async (t) => {
  const { app, store } = await filesFixture(t);
  const { a, roomId } = await room(app);
  const bytes = new TextEncoder().encode('once');
  const started = await ok(app, a.key, 'city_room_file_upload', {
    room_id: roomId,
    name: 'once.txt',
    size_bytes: bytes.byteLength,
  });
  store.upload(started.upload.url, bytes, started.upload.headers['content-type']);
  const args = { room_id: roomId, file: started.file_id, version: started.version };
  const [one, two] = await Promise.all([
    call(app, a.key, 'city_room_file_finalize', args),
    call(app, a.key, 'city_room_file_finalize', args),
  ]);
  assert.equal(one.statusCode, 200, one.body);
  assert.equal(two.statusCode, 200, two.body);
  const lines = (
    await app.city.db.query(
      "SELECT 1 FROM room_messages WHERE room_id=$1 AND sender_kind='system' AND parts::text LIKE '%shared a file%'",
      [roomId],
    )
  ).rows.length;
  assert.equal(lines, 1);
  const global = (
    await app.city.db.query<{ bytes: string }>(
      "SELECT bytes FROM room_storage_counters WHERE scope='global'",
    )
  ).rows[0]!;
  assert.equal(Number(global.bytes), bytes.byteLength);
});

test('a member shares a file from one of its rooms into another, checked again there', async (t) => {
  const { app, store } = await filesFixture(t);
  const { a, hostAgent, roomId } = await room(app);
  const other = await ok(app, a.key, 'city_create_room', {
    agent_id: hostAgent,
    name: 'Second desk',
    idempotency_key: randomUUID(),
  });
  const target = other.room.id as string;
  const bytes = new TextEncoder().encode('Launch notes, version one.');
  const shared = await share(app, store, a.key, roomId, 'notes.txt', bytes);
  assert.equal(shared.statusCode, 200, shared.body);
  const copied = await ok(app, a.key, 'city_room_file_share', {
    room_id: target,
    from_room_id: roomId,
    file: 'notes.txt',
  });
  assert.ok(roomFileOutputSchemas.city_room_file_share.safeParse(copied).success);
  assert.equal(copied.file.name, 'notes.txt');
  assert.equal(copied.finalized, true);
  const read = await ok(app, a.key, 'city_room_file_read', { room_id: target, file: 'notes.txt' });
  assert.match(read.text, /Launch notes, version one\./);
  // Sharing again adds a version of the same file in the target.
  const again = await ok(app, a.key, 'city_room_file_share', {
    room_id: target,
    from_room_id: roomId,
    file: 'notes.txt',
  });
  assert.equal(again.file.current_version, 2);
  // Not into the same room, not from a room the caller is not in.
  await fails(
    app,
    a.key,
    'city_room_file_share',
    { room_id: roomId, from_room_id: roomId, file: 'notes.txt' },
    'same_room',
  );
  // Only your own material: another member's file stays in its room.
  const { link } = {
    link: (await ok(app, a.key, 'city_room_link', { room_id: roomId })).link as string,
  };
  const b = await member(app, link, 'Bravo');
  await share(app, store, b.key, roomId, 'bravo.txt', new TextEncoder().encode('Bravo notes.'));
  await fails(
    app,
    a.key,
    'city_room_file_share',
    { room_id: target, from_room_id: roomId, file: 'bravo.txt' },
    'not_your_file',
  );
  // A copy never lands on another owner's same-named file in the target.
  await ok(app, b.key, 'city_join_room', {
    link: other.link.link as string,
    agent_id: b.agentId,
    idempotency_key: randomUUID(),
  });
  await share(app, store, b.key, target, 'plan.txt', new TextEncoder().encode('Bravo plan.'));
  await share(app, store, a.key, roomId, 'plan.txt', new TextEncoder().encode('Alpha plan.'));
  await fails(
    app,
    a.key,
    'city_room_file_share',
    { room_id: target, from_room_id: roomId, file: 'plan.txt' },
    'name_taken',
  );
  const stranger = await owner(app, 'Stranger');
  const strangerAgent = await agent(app, stranger.key, 'Stranger AI');
  const own = await ok(app, stranger.key, 'city_create_room', {
    agent_id: strangerAgent,
    name: 'Stranger desk',
    idempotency_key: randomUUID(),
  });
  const refused = await call(app, stranger.key, 'city_room_file_share', {
    room_id: own.room.id,
    from_room_id: roomId,
    file: 'notes.txt',
  });
  assert.equal(refused.statusCode, 404, refused.body);
});

test('closed room: files can still be deleted; a muted owner cannot delete', async (t) => {
  const { app, store } = await filesFixture(t);
  const { a, roomId, link } = await room(app);
  const b = await member(app, link, 'Bravo');
  const bytes = new TextEncoder().encode('hello');
  for (const name of ['one.txt', 'two.txt'])
    assert.equal((await share(app, store, b.key, roomId, name, bytes)).statusCode, 200);
  const mute = await rest(app, a, 'POST', `/api/rooms/${roomId}/mute`, {
    agent_id: b.agentId,
    muted: true,
  });
  assert.equal(mute.statusCode, 200, mute.body);
  const muted = await rest(app, b, 'DELETE', `/api/rooms/${roomId}/files/one.txt`);
  assert.equal(muted.statusCode, 403, muted.body);
  assert.equal(muted.json().code, 'muted_in_room');
  await ok(app, a.key, 'city_room_close', { room_id: roomId });
  const closed = await rest(app, a, 'DELETE', `/api/rooms/${roomId}/files/one.txt`);
  assert.equal(closed.statusCode, 200, closed.body);
});
