import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../server/app.js';
import { backupDatabase, restoreDatabase } from '../server/recovery.js';
import { signedHeaders } from '../connector/signing.js';
import type { Snapshot, WorkflowDetail } from '../shared/types.js';
import type { Workspace } from '../server/model.js';

type App = Awaited<ReturnType<typeof createApp>>;
const now = 1_800_000_000_000;
const password = 'Synthetic workflow password only';
const headers = { 'content-type': 'application/json', 'x-city-request': '1' };
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
function api(
  app: App,
  cookie: string,
  url: string,
  body?: unknown,
  method?: 'GET' | 'POST' | 'DELETE',
) {
  return app.inject({
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    url,
    headers: { ...headers, cookie },
    ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
  });
}
async function account(app: App, name: string) {
  const response = await api(app, '', '/api/auth/register', { name, password });
  assert.equal(response.statusCode, 201, response.body);
  return {
    cookie: `cc_session=${response.cookies[0]!.value}`,
    id: response.json().operator.id as string,
  };
}
function runtime(app: App, token: string, url: string, body?: unknown) {
  const raw = body === undefined ? '' : JSON.stringify(body),
    method = body === undefined ? 'GET' : 'POST';
  return app.inject({
    method,
    url,
    headers: signedHeaders(token, method, url, raw, String(now)),
    ...(body === undefined ? {} : { payload: raw }),
  });
}
async function fixture(
  t: { after: (fn: () => Promise<unknown>) => void },
  dataDir = ':memory:',
  externalResearcher = false,
) {
  let time = now;
  const app = await createApp({ dataDir, now: () => time, startWorkers: false });
  t.after(() => app.close());
  const owner = await account(app, 'Workflow owner');
  const register = async (name: string, capability: string, mode = 'hosted') => {
    const response = await api(app, owner.cookie, '/api/agents', { name, capability, mode });
    assert.equal(response.statusCode, 201, response.body);
    return response.json();
  };
  const requester = await register('Requester', 'extract');
  const researcher = await register(
    'Researcher',
    'research',
    externalResearcher ? 'external' : 'hosted',
  );
  const reviewer = await register('Reviewer', 'verify');
  if (externalResearcher)
    assert.equal(
      (await runtime(app, researcher.token, '/api/runtime/heartbeat', { sequence: 0 })).statusCode,
      200,
    );
  await app.city.tick();
  const grants = [];
  for (const [fromAgentId, toAgentId] of [
    [requester.agent.id, researcher.agent.id],
    [researcher.agent.id, reviewer.agent.id],
  ]) {
    const response = await api(app, owner.cookie, '/api/connections', { fromAgentId, toAgentId });
    assert.equal(response.statusCode, 201);
    grants.push(response.json().connection);
  }
  const body = {
    requesterId: requester.agent.id,
    researcherId: researcher.agent.id,
    reviewerId: reviewer.agent.id,
    source: 'Source: https://example.test/report\nRevenue: 42\nClaim: supplied text only',
    idempotencyKey: randomUUID(),
  };
  const create = async (changes = {}) => {
    const response = await api(app, owner.cookie, '/api/workflows', { ...body, ...changes });
    assert.equal(response.statusCode, 201, response.body);
    return response.json() as WorkflowDetail;
  };
  return {
    app,
    owner,
    requester,
    researcher,
    reviewer,
    grants,
    body,
    create,
    advance: (milliseconds: number) => {
      time += milliseconds;
    },
  };
}
async function finishHosted(app: App) {
  await app.city.tick();
  await app.city.tick();
}
async function detail(app: App, cookie: string, id: string) {
  const response = await api(app, cookie, `/api/workflows/${id}`);
  assert.equal(response.statusCode, 200, response.body);
  return response.json() as WorkflowDetail;
}

test('workflow saves source and linked results, requires explicit check, then owner acceptance', async (t) => {
  const f = await fixture(t);
  const created = await f.create();
  const id = created.workflow.id;
  assert.equal(created.workflow.status, 'briefing');
  assert.equal(created.checkJob, null);
  assert.equal(created.briefJob.input, f.body.source);
  assert.equal(
    (await api(f.app, f.owner.cookie, `/api/workflows/${id}/check`, {})).statusCode,
    409,
  );
  assert.equal(
    (await api(f.app, f.owner.cookie, `/api/workflows/${id}/accept`, {})).statusCode,
    409,
  );
  f.advance(1000);
  await f.app.city.tick();
  const running = await detail(f.app, f.owner.cookie, id);
  assert.equal(running.briefJob.status, 'running');
  assert.notEqual(running.workflow.updatedAt, created.workflow.updatedAt);
  f.advance(1000);
  await f.app.city.tick();
  const draft = await detail(f.app, f.owner.cookie, id);
  assert.equal(draft.workflow.status, 'awaiting_review');
  assert.equal(draft.checkJob, null);
  for (let i = 0; i < 3; i++) await f.app.city.tick();
  assert.equal((await detail(f.app, f.owner.cookie, id)).checkJob, null);
  const [check1, check2] = await Promise.all([
    api(f.app, f.owner.cookie, `/api/workflows/${id}/check`, {}),
    api(f.app, f.owner.cookie, `/api/workflows/${id}/check`, {}),
  ]);
  assert.equal(check1.statusCode, 200);
  assert.equal(check2.json().checkJob.id, check1.json().checkJob.id);
  assert.deepEqual(JSON.parse(check1.json().checkJob.input), {
    source: f.body.source,
    draft: draft.briefJob.output,
  });
  await finishHosted(f.app);
  assert.equal((await detail(f.app, f.owner.cookie, id)).workflow.status, 'completed');
  assert.equal(
    (await api(f.app, f.owner.cookie, `/api/jobs/${draft.briefJob.id}/accept`, {})).statusCode,
    200,
  );
  assert.equal((await detail(f.app, f.owner.cookie, id)).workflow.status, 'completed');
  const accepted = await api(f.app, f.owner.cookie, `/api/workflows/${id}/accept`, {});
  assert.equal(accepted.statusCode, 200);
  assert.equal(accepted.json().workflow.status, 'accepted');
  assert.equal(accepted.json().briefJob.acceptance, 'accepted');
  assert.equal(accepted.json().checkJob.acceptance, 'accepted');
  assert.deepEqual(
    (await api(f.app, f.owner.cookie, `/api/workflows/${id}/accept`, {})).json(),
    accepted.json(),
  );
  const snapshot = (await api(f.app, f.owner.cookie, '/api/snapshot')).json() as Snapshot;
  assert.equal(snapshot.workflows[0]?.id, id);
  const exported = (await api(f.app, f.owner.cookie, '/api/workspace/export')).json();
  assert.equal(exported.workflows[0].status, 'accepted');
  assert.ok(!JSON.stringify(exported.workflows).includes('idempotencyKey'));
  assert.ok(!JSON.stringify(exported.workflows).includes('requestHash'));
});

test('owner-scoped admission enforces capabilities, grants, bounds, duplicate input and reserved namespace', async (t) => {
  const f = await fixture(t);
  const other = await account(f.app, 'Other workflow owner');
  assert.equal((await api(f.app, '', '/api/workflows', f.body)).statusCode, 401);
  assert.equal((await api(f.app, other.cookie, '/api/workflows', f.body)).statusCode, 403);
  assert.equal(
    (await api(f.app, f.owner.cookie, '/api/workflows', { ...f.body, source: 'x'.repeat(4001) }))
      .statusCode,
    400,
  );
  assert.equal(
    (await api(f.app, f.owner.cookie, '/api/workflows', { ...f.body, source: ' ' })).statusCode,
    400,
  );
  assert.equal(
    (
      await api(f.app, f.owner.cookie, '/api/workflows', {
        ...f.body,
        reviewerId: f.researcher.agent.id,
      })
    ).statusCode,
    403,
  );
  const created = await f.create();
  const [retry1, retry2] = await Promise.all([f.create(), f.create()]);
  assert.equal(retry1.workflow.id, created.workflow.id);
  assert.equal(retry2.briefJob.id, created.briefJob.id);
  assert.equal(
    (await api(f.app, f.owner.cookie, '/api/workflows', { ...f.body, source: 'Changed input' }))
      .statusCode,
    409,
  );
  for (const action of ['', '/check', '/accept', '/cancel'])
    assert.equal(
      (
        await api(
          f.app,
          other.cookie,
          `/api/workflows/${created.workflow.id}${action}`,
          action ? {} : undefined,
        )
      ).statusCode,
      404,
    );
  assert.equal(
    (
      await api(f.app, f.owner.cookie, '/api/jobs', {
        requesterId: f.requester.agent.id,
        providerId: f.researcher.agent.id,
        input: 'Reserved key',
        idempotencyKey: 'workflow:reserved',
      })
    ).statusCode,
    400,
  );
  const state = (await api(f.app, f.owner.cookie, '/api/snapshot')).json();
  assert.equal(state.jobs.length, 1);
  assert.equal(state.workflows.length, 1);
});

test('pause, explicit cancel, revoked unused second grant and generic job cancel synchronize workflow state', async (t) => {
  const f = await fixture(t);
  await api(f.app, f.owner.cookie, '/api/workspace/pause', { paused: true });
  assert.equal((await api(f.app, f.owner.cookie, '/api/workflows', f.body)).statusCode, 409);
  await api(f.app, f.owner.cookie, '/api/workspace/pause', { paused: false });
  const first = await f.create();
  await finishHosted(f.app);
  await api(f.app, f.owner.cookie, '/api/workspace/pause', { paused: true });
  assert.equal(
    (await api(f.app, f.owner.cookie, `/api/workflows/${first.workflow.id}/check`, {})).statusCode,
    409,
  );
  assert.equal(
    (await api(f.app, f.owner.cookie, `/api/workflows/${first.workflow.id}/cancel`, {})).json()
      .workflow.status,
    'canceled',
  );
  await api(f.app, f.owner.cookie, '/api/workspace/pause', { paused: false });
  const second = await f.create({ idempotencyKey: randomUUID() });
  await api(f.app, f.owner.cookie, `/api/jobs/${second.briefJob.id}/cancel`, {});
  assert.equal(
    (await detail(f.app, f.owner.cookie, second.workflow.id)).workflow.status,
    'canceled',
  );
  const third = await f.create({ idempotencyKey: randomUUID() });
  await api(f.app, f.owner.cookie, `/api/connections/${f.grants[1]!.id}`, undefined, 'DELETE');
  const revoked = await detail(f.app, f.owner.cookie, third.workflow.id);
  assert.equal(revoked.workflow.status, 'canceled');
  assert.equal(revoked.briefJob.status, 'canceled');
  assert.equal(
    (await api(f.app, f.owner.cookie, `/api/workflows/${third.workflow.id}/check`, {})).statusCode,
    403,
  );
  await finishHosted(f.app);
  assert.equal((await detail(f.app, f.owner.cookie, third.workflow.id)).briefJob.output, null);
});

test('external brief commits feed full untruncated checker context, and oversized results fail the gate', async (t) => {
  const f = await fixture(t, ':memory:', true);
  const first = await f.create();
  const lease = (await runtime(f.app, f.researcher.token, '/api/runtime/jobs')).json();
  assert.equal(lease.job.id, first.briefJob.id);
  const output = { model: 'synthetic', brief: 'x'.repeat(12000) };
  for (const invalid of [{ oversized: 'x'.repeat(32769) }, ['not', 'an', 'object']]) {
    assert.equal(
      (
        await runtime(f.app, f.researcher.token, `/api/runtime/jobs/${lease.job.id}/result`, {
          leaseToken: lease.leaseToken,
          output: invalid,
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (await detail(f.app, f.owner.cookie, first.workflow.id)).workflow.status,
      'briefing',
    );
  }
  assert.equal(
    (
      await runtime(f.app, f.researcher.token, `/api/runtime/jobs/${lease.job.id}/result`, {
        leaseToken: lease.leaseToken,
        output,
      })
    ).statusCode,
    200,
  );
  assert.equal(
    (await detail(f.app, f.owner.cookie, first.workflow.id)).workflow.status,
    'awaiting_review',
  );
  const check = await api(f.app, f.owner.cookie, `/api/workflows/${first.workflow.id}/check`, {});
  assert.equal(check.statusCode, 409);
  assert.match(check.body, /Nothing was truncated/);
  const after = await detail(f.app, f.owner.cookie, first.workflow.id);
  assert.deepEqual(after.briefJob.output, output);
  assert.equal(after.checkJob, null);
  const second = await f.create({ idempotencyKey: randomUUID() });
  const claim = (await runtime(f.app, f.researcher.token, '/api/runtime/jobs')).json();
  await api(f.app, f.owner.cookie, `/api/workflows/${second.workflow.id}/cancel`, {});
  assert.equal(
    (
      await runtime(f.app, f.researcher.token, `/api/runtime/jobs/${claim.job.id}/result`, {
        leaseToken: claim.leaseToken,
        output: { late: true },
      })
    ).statusCode,
    409,
  );
});

test('provider failure commits a safe immediate workflow error and only identical retries succeed', async (t) => {
  const f = await fixture(t, ':memory:', true);
  const created = await f.create();
  const claim = (await runtime(f.app, f.researcher.token, '/api/runtime/jobs')).json();
  const path = `/api/runtime/jobs/${claim.job.id}/failure`;
  const failure = { leaseToken: claim.leaseToken, reason: 'invalid-output' };
  assert.equal(
    (
      await runtime(f.app, f.researcher.token, path, {
        ...failure,
        reason: 'include-private-model-text',
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (
      await runtime(f.app, f.researcher.token, path, {
        ...failure,
        leaseToken: 'bad-lease-token-value',
      })
    ).statusCode,
    409,
  );
  await api(f.app, f.owner.cookie, '/api/workspace/pause', { paused: true });
  assert.equal((await runtime(f.app, f.researcher.token, path, failure)).statusCode, 409);
  await api(f.app, f.owner.cookie, '/api/workspace/pause', { paused: false });
  const foreign = await account(f.app, 'Foreign failure owner');
  const outsider = (
    await api(f.app, foreign.cookie, '/api/agents', {
      name: 'Outsider',
      mode: 'external',
      capability: 'research',
    })
  ).json();
  assert.equal((await runtime(f.app, outsider.token, path, failure)).statusCode, 404);
  const response = await runtime(f.app, f.researcher.token, path, failure);
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().job.status, 'failed');
  assert.equal(response.json().job.error, 'Provider reported invalid model output.');
  assert.ok(response.json().job.completedAt);
  assert.deepEqual(
    (await runtime(f.app, f.researcher.token, path, failure)).json(),
    response.json(),
  );
  assert.equal(
    (await runtime(f.app, f.researcher.token, path, { ...failure, reason: 'runtime-unavailable' }))
      .statusCode,
    409,
  );
  assert.equal(
    (
      await runtime(f.app, f.researcher.token, `/api/runtime/jobs/${claim.job.id}/result`, {
        leaseToken: claim.leaseToken,
        output: { late: true },
      })
    ).statusCode,
    409,
  );
  const current = await detail(f.app, f.owner.cookie, created.workflow.id);
  assert.equal(current.workflow.status, 'failed');
  assert.equal(current.checkJob, null);
  assert.equal(
    (await api(f.app, f.owner.cookie, `/api/workflows/${created.workflow.id}/check`, {}))
      .statusCode,
    409,
  );
  assert.equal((await runtime(f.app, f.researcher.token, '/api/runtime/jobs')).json().job, null);
});

test('failure reports cannot revive revoked, rotated, canceled or completed work', async (t) => {
  for (const state of ['revoked-grant', 'rotated', 'canceled', 'completed', 'expired']) {
    await t.test(state, async (subtest) => {
      const f = await fixture(subtest, ':memory:', true);
      const created = await f.create();
      const claim = (await runtime(f.app, f.researcher.token, '/api/runtime/jobs')).json();
      let token = f.researcher.token;
      if (state === 'revoked-grant')
        await api(
          f.app,
          f.owner.cookie,
          `/api/connections/${f.grants[0]!.id}`,
          undefined,
          'DELETE',
        );
      if (state === 'rotated') {
        token = (
          await api(
            f.app,
            f.owner.cookie,
            `/api/agents/${f.researcher.agent.id}/rotate-credential`,
            {},
          )
        ).json().token;
        assert.equal(
          (
            await runtime(f.app, f.researcher.token, `/api/runtime/jobs/${claim.job.id}/failure`, {
              leaseToken: claim.leaseToken,
              reason: 'execution-timeout',
            })
          ).statusCode,
          401,
        );
      }
      if (state === 'canceled')
        await api(f.app, f.owner.cookie, `/api/workflows/${created.workflow.id}/cancel`, {});
      if (state === 'completed')
        await runtime(f.app, token, `/api/runtime/jobs/${claim.job.id}/result`, {
          leaseToken: claim.leaseToken,
          output: { complete: true },
        });
      if (state === 'expired') f.advance(60000);
      const response = await runtime(f.app, token, `/api/runtime/jobs/${claim.job.id}/failure`, {
        leaseToken: claim.leaseToken,
        reason: 'execution-timeout',
      });
      assert.equal(response.statusCode, state === 'revoked-grant' ? 403 : 409, response.body);
      assert.notEqual(
        (await detail(f.app, f.owner.cookie, created.workflow.id)).briefJob.error,
        'Provider reported an execution timeout.',
      );
    });
  }
});

test('failure report rechecks credentials rotated after authentication before its mutation', async (t) => {
  const f = await fixture(t, ':memory:', true);
  await f.create();
  const claim = (await runtime(f.app, f.researcher.token, '/api/runtime/jobs')).json();
  type Tx = Parameters<Parameters<App['city']['db']['transaction']>[0]>[0];
  let release!: () => void, observed!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const reached = new Promise<void>((resolve) => {
    observed = resolve;
  });
  const original = f.app.city.db.transaction.bind(f.app.city.db);
  let armed = true;
  const mock = t.mock.method(
    f.app.city.db,
    'transaction',
    async <T>(callback: (tx: Tx) => Promise<T>) => {
      const pause = armed;
      armed = false;
      const result = await original(callback);
      if (pause) {
        observed();
        await gate;
      }
      return result;
    },
  );
  const pending = Promise.resolve(
    runtime(f.app, f.researcher.token, `/api/runtime/jobs/${claim.job.id}/failure`, {
      leaseToken: claim.leaseToken,
      reason: 'invalid-output',
    }),
  );
  try {
    await reached;
    await api(f.app, f.owner.cookie, `/api/agents/${f.researcher.agent.id}/rotate-credential`, {});
  } finally {
    release();
  }
  assert.equal((await pending).statusCode, 401);
  mock.mock.restore();
});

test('check/cancel/revocation race does not leave a running orphan checker', async (t) => {
  const f = await fixture(t);
  const created = await f.create();
  await finishHosted(f.app);
  await Promise.all([
    api(f.app, f.owner.cookie, `/api/workflows/${created.workflow.id}/check`, {}),
    api(f.app, f.owner.cookie, `/api/workflows/${created.workflow.id}/cancel`, {}),
    api(f.app, f.owner.cookie, `/api/connections/${f.grants[1]!.id}`, undefined, 'DELETE'),
  ]);
  const current = await detail(f.app, f.owner.cookie, created.workflow.id);
  assert.equal(current.workflow.status, 'canceled');
  assert.ok(!current.checkJob || current.checkJob.status === 'canceled');
  await finishHosted(f.app);
  assert.equal(
    (await detail(f.app, f.owner.cookie, created.workflow.id)).checkJob?.output ?? null,
    null,
  );
});

test('linked result lookup and export retain workflow jobs older than the 50-job snapshot', async (t) => {
  const f = await fixture(t);
  const created = await f.create();
  await finishHosted(f.app);
  const row = (
    await f.app.city.db.query<{ data: Workspace }>(
      'SELECT data FROM workspaces WHERE operator_id=$1',
      [f.owner.id],
    )
  ).rows[0]!;
  const original = row.data.jobs[0]!;
  for (let i = 0; i < 55; i++)
    row.data.jobs.push({
      ...original,
      id: randomUUID(),
      idempotencyKey: randomUUID(),
      requestHash: sha(String(i)),
    });
  Object.assign(row.data.workflows![0]!, { futurePrivateField: 'private-do-not-export' });
  await f.app.city.db.query('UPDATE workspaces SET data=$2::jsonb WHERE operator_id=$1', [
    f.owner.id,
    JSON.stringify(row.data),
  ]);
  const snapshot = (await api(f.app, f.owner.cookie, '/api/snapshot')).json() as Snapshot;
  assert.equal(snapshot.jobs.length, 50);
  assert.ok(!snapshot.jobs.some((job) => job.id === created.briefJob.id));
  assert.equal(
    (await detail(f.app, f.owner.cookie, created.workflow.id)).briefJob.id,
    created.briefJob.id,
  );
  const exported = await api(f.app, f.owner.cookie, '/api/workspace/export');
  assert.equal(exported.json().jobs.length, 56);
  assert.equal(exported.json().workflows.length, 1);
  assert.ok(!exported.body.includes('private-do-not-export'));
  assert.ok(!JSON.stringify(snapshot.workflows).includes('private-do-not-export'));
});

test('persistent restart and isolated recovery preserve workflow history and old v1 backups', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'city-workflows-'));
  const dataDir = join(root, 'data');
  const f = await fixture(t, dataDir);
  const created = await f.create();
  await finishHosted(f.app);
  const accepted = await f.create({ idempotencyKey: randomUUID() });
  await finishHosted(f.app);
  await api(f.app, f.owner.cookie, `/api/workflows/${accepted.workflow.id}/check`, {});
  await finishHosted(f.app);
  await api(f.app, f.owner.cookie, `/api/workflows/${accepted.workflow.id}/accept`, {});
  await f.app.close();
  const reopened = await createApp({ dataDir, now: () => now, startWorkers: false });
  assert.equal(
    (await detail(reopened, f.owner.cookie, created.workflow.id)).workflow.status,
    'awaiting_review',
  );
  assert.equal(
    (await api(reopened, f.owner.cookie, '/api/workflows', f.body)).json().workflow.id,
    created.workflow.id,
  );
  await reopened.close();
  const backup = join(root, 'backup.json');
  await backupDatabase(dataDir, backup);
  await restoreDatabase(backup, join(root, 'restored'));
  const restored = await createApp({
    dataDir: join(root, 'restored'),
    now: () => now,
    startWorkers: false,
  });
  try {
    const login = await api(restored, '', '/api/auth/login', { name: 'Workflow owner', password });
    const cookie = `cc_session=${login.cookies[0]!.value}`;
    const current = await detail(restored, cookie, created.workflow.id);
    assert.equal(current.workflow.status, 'canceled');
    assert.equal(current.briefJob.status, 'completed');
    assert.deepEqual(
      current.briefJob.output,
      (await api(restored, cookie, '/api/workspace/export')).json().jobs[0].output,
    );
    assert.equal(
      (await api(restored, cookie, `/api/workflows/${created.workflow.id}/check`, {})).statusCode,
      409,
    );
    assert.equal(
      (await detail(restored, cookie, accepted.workflow.id)).workflow.status,
      'accepted',
    );
  } finally {
    await restored.close();
  }
  const envelope = JSON.parse(await readFile(backup, 'utf8'));
  const payload = JSON.parse(envelope.payload);
  for (const row of payload.workspaces) delete row.data.workflows;
  const legacyPayload = JSON.stringify(payload);
  const legacy = join(root, 'legacy.json');
  await writeFile(legacy, JSON.stringify({ payload: legacyPayload, sha256: sha(legacyPayload) }));
  await restoreDatabase(legacy, join(root, 'legacy-restored'));
  const legacyApp = await createApp({
    dataDir: join(root, 'legacy-restored'),
    startWorkers: false,
  });
  try {
    const login = await api(legacyApp, '', '/api/auth/login', { name: 'Workflow owner', password });
    const cookie = `cc_session=${login.cookies[0]!.value}`;
    assert.deepEqual((await api(legacyApp, cookie, '/api/snapshot')).json().workflows, []);
  } finally {
    await legacyApp.close();
  }
  const badPayload = JSON.parse(envelope.payload);
  badPayload.workspaces[0].data.workflows[0].briefJobId = randomUUID();
  const broken = JSON.stringify(badPayload);
  const bad = join(root, 'bad.json');
  await writeFile(bad, JSON.stringify({ payload: broken, sha256: sha(broken) }));
  await assert.rejects(restoreDatabase(bad, join(root, 'bad-restored')), /workflow job reference/);
  const inconsistent = JSON.parse(envelope.payload);
  inconsistent.workspaces[0].data.workflows[0].status = 'accepted';
  const inconsistentPayload = JSON.stringify(inconsistent);
  const inconsistentFile = join(root, 'inconsistent.json');
  await writeFile(
    inconsistentFile,
    JSON.stringify({ payload: inconsistentPayload, sha256: sha(inconsistentPayload) }),
  );
  await assert.rejects(
    restoreDatabase(inconsistentFile, join(root, 'inconsistent-restored')),
    /workflow job reference|inconsistent/,
  );
  await rm(root, { recursive: true, force: true });
});

test('pausing an agent leaves a workflow with no running job as it is', async (t) => {
  const f = await fixture(t);
  const first = await f.create();
  await finishHosted(f.app);
  assert.equal(
    (await detail(f.app, f.owner.cookie, first.workflow.id)).workflow.status,
    'awaiting_review',
  );
  const agent = `/api/agents/${f.researcher.agent.id}`;
  assert.equal((await api(f.app, f.owner.cookie, `${agent}/pause`, {})).statusCode, 200);
  assert.equal(
    (await detail(f.app, f.owner.cookie, first.workflow.id)).workflow.status,
    'awaiting_review',
  );
  assert.equal((await api(f.app, f.owner.cookie, `${agent}/resume`, {})).statusCode, 200);
  const checked = await api(f.app, f.owner.cookie, `/api/workflows/${first.workflow.id}/check`, {});
  assert.equal(checked.statusCode, 200, checked.body);
});
