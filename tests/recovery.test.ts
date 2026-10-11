import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { createApp } from '../server/app.js';
import { backupDatabase, restoreDatabase, MAX_BACKUP_BYTES } from '../server/recovery.js';
import { acquireDataLock, directPath, INCOMPLETE_RECOVERY } from '../server/data-lock.js';
import { signedHeaders } from '../connector/signing.js';
import type { Workspace, StoredJob } from '../server/model.js';

const now = 1_800_000_000_000;
const iso = new Date(now).toISOString();
const password = 'Synthetic recovery password only';
const headers = { 'content-type': 'application/json', 'x-city-request': '1' };
const sha = (value: string) => createHash('sha256').update(value).digest('hex');

test('offline recovery lifecycle and adversarial boundaries', async (t) => {
  const base = resolve(process.env.CC_RECOVERY_TEST_ROOT ?? tmpdir());
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, 'city-recovery-'));
  t.after(async () => {
    assert.ok(resolve(root).startsWith(`${base}${sep}`));
    await rm(root, { recursive: true, force: true });
  });
  const source = join(root, 'source');
  const backup = join(root, 'snapshot.json');
  const app = await createApp({ dataDir: source, startWorkers: false, now: () => now });
  const api = (url: string, body?: unknown, cookie = '') =>
    app.inject({
      method: body === undefined ? 'GET' : 'POST',
      url,
      headers: { ...headers, cookie },
      ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
    });
  const owner = await api('/api/auth/register', { name: 'Recovery owner', password });
  assert.equal(owner.statusCode, 201);
  const cookie = `cc_session=${owner.cookies.find((item) => item.name === 'cc_session')!.value}`;
  const ownerId = owner.json().operator.id as string;
  const second = await api('/api/auth/register', { name: 'Other owner', password });
  assert.equal(second.statusCode, 201);
  const external = (
    await api(
      '/api/agents',
      {
        name: 'External fixture',
        description: '',
        mode: 'external',
        capability: 'extract',
      },
      cookie,
    )
  ).json();
  const hosted = (
    await api(
      '/api/agents',
      {
        name: 'Hosted fixture',
        description: '',
        mode: 'hosted',
        capability: 'extract',
        // A visibility choice is stored on the agent and must survive a backup round trip.
        visibility: 'public',
      },
      cookie,
    )
  ).json();
  const data = (
    await app.city.db.query<{ data: Workspace }>(
      'SELECT data FROM workspaces WHERE operator_id=$1',
      [ownerId],
    )
  ).rows[0]!.data;
  data.connections.push({
    id: randomUUID(),
    fromAgentId: hosted.agent.id,
    toAgentId: external.agent.id,
    createdAt: iso,
  });
  for (const agent of data.agents) {
    agent.lastSeenAt = iso;
    agent.lastSequence = 44;
    agent.announcedOnline = true;
  }
  data.jobs = ['completed', 'running', 'queued'].map(
    (status, index) =>
      ({
        id: randomUUID(),
        requesterId: hosted.agent.id,
        providerId: external.agent.id,
        capability: 'extract',
        input: `synthetic task ${index}`,
        status,
        acceptance: status === 'completed' ? 'accepted' : 'pending',
        output:
          status === 'completed' ? { artifact: 'synthetic retained result', amount: 42 } : null,
        createdAt: iso,
        updatedAt: iso,
        completedAt: status === 'completed' ? iso : null,
        acceptedAt: status === 'completed' ? iso : null,
        costCents: null,
        error: null,
        isDemo: false,
        idempotencyKey: randomUUID(),
        requestHash: sha(`request ${index}`),
        attempts: status === 'queued' ? 0 : 1,
        leaseHash: sha('synthetic lease'),
        leaseExpiresAt: now + 60000,
        outputHash: status === 'completed' ? sha('synthetic result') : null,
      }) as StoredJob,
  );
  await app.city.db.query('UPDATE workspaces SET data=$2::jsonb WHERE operator_id=$1', [
    ownerId,
    JSON.stringify(data),
  ]);
  // operators.created_at (eligibility) is not part of the v1 backup format: a restore restarts
  // every account's age at the migration time, so restored accounts wait 7 days to be eligible.
  const OPERATOR_COLUMNS = 'id,name,name_key,password_hash,salt,kind';
  const operatorsBefore = (
    await app.city.db.query(`SELECT ${OPERATOR_COLUMNS} FROM operators ORDER BY id`)
  ).rows;

  await t.test('open application excludes backup and a second application', async () => {
    await assert.rejects(backupDatabase(source, backup), /locked/);
    await assert.rejects(createApp({ dataDir: source, startWorkers: false }), /locked/);
  });
  await app.close();
  await t.test(
    'closed application yields bounded coherent snapshot without runtime authority',
    async () => {
      const result = await backupDatabase(source, backup);
      assert.equal(result.operators, 2);
      assert.ok(result.bytes < MAX_BACKUP_BYTES);
      const text = await readFile(backup, 'utf8');
      assert.ok(!text.includes(external.token));
      assert.ok(!text.includes(sha(external.token)));
      assert.ok(!text.includes('token_hash'));
      if (process.platform !== 'win32') assert.equal((await stat(backup)).mode & 0o777, 0o600);
      await assert.rejects(backupDatabase(source, backup), /EEXIST/);
      await assert.rejects(backupDatabase(source, join(source, 'backup.json')), /outside/);
    },
  );
  await t.test(
    'isolated restore preserves history, clears authority and never replays active jobs',
    async () => {
      const restoredPath = join(root, 'restored');
      const result = await restoreDatabase(backup, restoredPath);
      assert.equal(result.operators, 2);
      const restored = await createApp({
        dataDir: restoredPath,
        startWorkers: false,
        now: () => now,
      });
      try {
        assert.deepEqual(
          (await restored.city.db.query(`SELECT ${OPERATOR_COLUMNS} FROM operators ORDER BY id`))
            .rows,
          operatorsBefore,
        );
        for (const table of ['sessions', 'credentials', 'replay_nonces'])
          assert.equal((await restored.city.db.query(`SELECT * FROM ${table}`)).rows.length, 0);
        const recovered = (
          await restored.city.db.query<{ data: Workspace }>(
            'SELECT data FROM workspaces WHERE operator_id=$1',
            [ownerId],
          )
        ).rows[0]!.data;
        assert.equal(recovered.paused, true);
        assert.deepEqual(recovered.connections, data.connections);
        assert.deepEqual(recovered.events.slice(0, -1), data.events);
        assert.equal(recovered.events.at(-1)!.type, 'workspace.recovered');
        assert.deepEqual(
          recovered.agents.map((agent) => agent.id),
          data.agents.map((agent) => agent.id),
        );
        assert.ok(
          recovered.agents.every(
            (agent) =>
              agent.lastSeenAt === null && agent.lastSequence === -1 && !agent.announcedOnline,
          ),
        );
        assert.deepEqual(recovered.jobs[0], {
          ...data.jobs[0],
          leaseHash: null,
          leaseExpiresAt: null,
        });
        assert.deepEqual(
          recovered.jobs.map((job) => job.status),
          ['completed', 'canceled', 'canceled'],
        );
        assert.ok(recovered.jobs.slice(1).every((job) => job.completedAt !== null));
        assert.ok(
          recovered.jobs.every((job) => job.leaseHash === null && job.leaseExpiresAt === null),
        );
        assert.equal(
          (await restored.inject({ url: '/api/snapshot', headers: { cookie } })).statusCode,
          401,
        );
        const heartbeat = JSON.stringify({ sequence: 1 });
        assert.equal(
          (
            await restored.inject({
              method: 'POST',
              url: '/api/runtime/heartbeat',
              payload: heartbeat,
              headers: signedHeaders(
                external.token,
                'POST',
                '/api/runtime/heartbeat',
                heartbeat,
                String(now),
              ),
            })
          ).statusCode,
          401,
        );
        const login = await restored.inject({
          method: 'POST',
          url: '/api/auth/login',
          headers,
          payload: { name: 'Recovery owner', password },
        });
        assert.equal(login.statusCode, 200);
        const restoredCookie = `cc_session=${login.cookies.find((item) => item.name === 'cc_session')!.value}`;
        const rotation = await restored.inject({
          method: 'POST',
          url: `/api/agents/${external.agent.id}/rotate-credential`,
          headers: { ...headers, cookie: restoredCookie },
          payload: {},
        });
        assert.equal(rotation.statusCode, 200);
        assert.equal(
          (
            await restored.inject({
              method: 'POST',
              url: '/api/runtime/heartbeat',
              payload: heartbeat,
              headers: signedHeaders(
                rotation.json().token,
                'POST',
                '/api/runtime/heartbeat',
                heartbeat,
                String(now),
              ),
            })
          ).statusCode,
          200,
        );
        await restored.inject({
          method: 'POST',
          url: '/api/workspace/pause',
          headers: { ...headers, cookie: restoredCookie },
          payload: { paused: false },
        });
        await restored.city.tick();
        const after = (
          await restored.city.db.query<{ data: Workspace }>(
            'SELECT data FROM workspaces WHERE operator_id=$1',
            [ownerId],
          )
        ).rows[0]!.data;
        assert.deepEqual(
          after.jobs.map((job) => job.status),
          ['completed', 'canceled', 'canceled'],
        );
      } finally {
        await restored.close();
      }
      const reopened = await createApp({ dataDir: source, startWorkers: false });
      try {
        assert.deepEqual(
          (
            await reopened.city.db.query<{ data: Workspace }>(
              'SELECT data FROM workspaces WHERE operator_id=$1',
              [ownerId],
            )
          ).rows[0]!.data,
          data,
        );
      } finally {
        await reopened.close();
      }
    },
  );
  await t.test(
    'existing restore directories, files and original source are never overwritten',
    async () => {
      const existing = join(root, 'empty');
      await mkdir(existing);
      for (const target of [existing, backup, source])
        await assert.rejects(restoreDatabase(backup, target), /EEXIST|ENOTDIR/);
      assert.equal((await stat(source)).isDirectory(), true);
    },
  );
  await t.test(
    'corruption, incompatible versions and dangling grants fail before destination creation',
    async () => {
      const envelope = JSON.parse(await readFile(backup, 'utf8'));
      const fixtures: unknown[] = [
        { ...envelope, sha256: '0'.repeat(64) },
        { ...envelope, extra: 'unsupported' },
      ];
      for (const mutate of [
        (value: any) => {
          value.version = 999;
        },
        (value: any) => {
          value.workspaces[0].data.connections.push({
            id: randomUUID(),
            fromAgentId: randomUUID(),
            toAgentId: randomUUID(),
            createdAt: iso,
          });
        },
        (value: any) => {
          value.operators.push(value.operators[0]);
        },
        (value: any) => {
          value.workspaces[0].data.unexpected = true;
        },
      ]) {
        const value = JSON.parse(envelope.payload);
        mutate(value);
        const payload = JSON.stringify(value);
        fixtures.push({ payload, sha256: sha(payload) });
      }
      for (const [index, fixture] of fixtures.entries()) {
        const file = join(root, `invalid-${index}.json`);
        const dest = join(root, `rejected-${index}`);
        await writeFile(file, JSON.stringify(fixture));
        await assert.rejects(restoreDatabase(file, dest));
        await assert.rejects(stat(dest), { code: 'ENOENT' });
      }
      const huge = join(root, 'oversized.json');
      const handle = await open(huge, 'wx');
      await handle.truncate(MAX_BACKUP_BYTES + 1);
      await handle.close();
      await assert.rejects(restoreDatabase(huge, join(root, 'too-big')), /32 MiB/);
    },
  );
  await t.test('junctions, hardlinks, reserved aliases and stale locks are refused', async () => {
    // A world-writable parent keeps the link untrusted even when tests run as root.
    const writable = join(root, 'writable');
    await mkdir(writable);
    await chmod(writable, 0o777);
    const alias = join(writable, 'alias');
    await symlink(source, alias, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(backupDatabase(alias, join(root, 'alias.json')), /aliases|links/);
    await assert.rejects(restoreDatabase(backup, join(alias, 'nested')), /aliases|links/);
    const hardlink = join(root, 'hardlink.json');
    await link(backup, hardlink);
    await assert.rejects(restoreDatabase(hardlink, join(root, 'hardlink-restore')), /Hard-linked/);
    await rm(hardlink);
    await assert.rejects(directPath(`${source}.`), /aliases/);
    await assert.rejects(directPath(join(root, 'NUL')), /reserved/);
    const destination = join(root, 'locked');
    await writeFile(`${destination}.central-city.lock`, JSON.stringify({ pid: 999999999 }));
    await assert.rejects(restoreDatabase(backup, destination), /locked/);
    assert.ok(await stat(`${destination}.central-city.lock`));
  });
  await t.test(
    'competing cooperative locks exclude each other and release is idempotent',
    async () => {
      const target = join(root, 'lock-target');
      const results = await Promise.allSettled([acquireDataLock(target), acquireDataLock(target)]);
      assert.equal(results.filter((entry) => entry.status === 'fulfilled').length, 1);
      const lock = results.find((entry) => entry.status === 'fulfilled')!;
      assert.equal(lock.status, 'fulfilled');
      if (lock.status === 'fulfilled') {
        await lock.value.release();
        await lock.value.release();
      }
      await (await acquireDataLock(target)).release();
    },
  );
  await t.test(
    'failed database initialization leaves a blocked incomplete destination',
    async () => {
      const destination = join(root, 'failed-restore');
      const mocked = t.mock.method(PGlite, 'create', async () => {
        throw new Error('Synthetic storage failure');
      });
      try {
        await assert.rejects(restoreDatabase(backup, destination), /Synthetic storage failure/);
      } finally {
        mocked.mock.restore();
      }
      assert.ok(await stat(join(destination, INCOMPLETE_RECOVERY)));
      await assert.rejects(
        createApp({ dataDir: destination, startWorkers: false }),
        /Incomplete recovery/,
      );
    },
  );
});
