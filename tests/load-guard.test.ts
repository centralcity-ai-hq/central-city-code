import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { classify, OwnerSession } from '../scripts/load/client.js';
import { connectServer } from '../scripts/load/server-handle.js';
import {
  assertNotProductionOrigin,
  CATALOG_EMPTY_SQL,
  checkDatabaseEmpty,
  checkNeonTarget,
  GuardError,
  neonEndpointId,
  parseTarget,
  preflight,
} from '../scripts/load/guard.js';

// Synthetic connection strings only; no network is touched by these guards.
const branchHost = 'ep-load-br-lucky-dew-a1b2c3.us-east-2.aws.neon.tech';
const good = {
  databaseUrl: `postgresql://load_user:synthetic@${branchHost}/city?sslmode=verify-full`,
  forbiddenEndpoints: 'ep-prod-main-000000,ep-staging-111111',
  disposableBranch: 'ep-load-br-lucky-dew-a1b2c3',
};

test('load target must be local or neon', () => {
  assert.equal(parseTarget('local'), 'local');
  assert.equal(parseTarget('neon'), 'neon');
  assert.throws(() => parseTarget(undefined), GuardError);
  assert.throws(() => parseTarget('production'), GuardError);
});

test('local target needs no database configuration', () => {
  assert.deepEqual(preflight('local', { LOAD_DATABASE_URL: 'postgres://x.example/db' }, {}), {});
});

test('a valid disposable Neon branch passes the guards', () => {
  assert.deepEqual(checkNeonTarget(good), {
    host: branchHost,
    endpoint: 'ep-load-br-lucky-dew-a1b2c3',
    databaseUrl: good.databaseUrl,
  });
  assert.equal(neonEndpointId('ep-abc-123-pooler.eu-central-1.aws.neon.tech'), 'ep-abc-123');
});

test('neon guard refuses a non-Neon host', () => {
  for (const databaseUrl of [
    'postgresql://u:p@db.example.com/city',
    'postgresql://u:p@neon.tech.example.com/city',
    'postgresql://u:p@localhost/city',
  ])
    assert.throws(
      () => checkNeonTarget({ ...good, databaseUrl }),
      /Neon endpoint host|centralcity|vercel/,
    );
  assert.throws(() => checkNeonTarget({ ...good, databaseUrl: undefined }), /required/);
  assert.throws(() => checkNeonTarget({ ...good, databaseUrl: 'not a url' }), /postgres:\/\/ URL/);
  assert.throws(
    () => checkNeonTarget({ ...good, databaseUrl: `mysql://u:p@${branchHost}/city` }),
    /postgres/,
  );
});

test('neon guard refuses forbidden endpoints, including the pooler form', () => {
  const forbidden = 'ep-load-br-lucky-dew-a1b2c3';
  assert.throws(
    () => checkNeonTarget({ ...good, forbiddenEndpoints: `ep-prod-main-000000, ${forbidden}` }),
    /forbidden endpoint/,
  );
  assert.throws(
    () =>
      checkNeonTarget({
        ...good,
        databaseUrl: `postgresql://u:p@${forbidden}-pooler.us-east-2.aws.neon.tech/city?sslmode=verify-full`,
        forbiddenEndpoints: forbidden,
      }),
    /forbidden endpoint/,
  );
  assert.throws(
    () => checkNeonTarget({ ...good, forbiddenEndpoints: branchHost.toUpperCase() }),
    /forbidden endpoint/,
  );
  // The protected list itself is mandatory.
  assert.throws(
    () => checkNeonTarget({ ...good, forbiddenEndpoints: undefined }),
    /LOAD_FORBIDDEN/,
  );
  assert.throws(() => checkNeonTarget({ ...good, forbiddenEndpoints: ' , ' }), /LOAD_FORBIDDEN/);
});

test('neon guard requires the exact disposable endpoint, never a substring (app#16 must-fix)', () => {
  assert.throws(
    () => checkNeonTarget({ ...good, disposableBranch: undefined }),
    (error: GuardError) => error.code === 'DISPOSABLE_MISSING',
  );
  assert.throws(() => checkNeonTarget({ ...good, disposableBranch: '' }), /disposable endpoint/);
  // A branch id cannot be proven from the host, so it is refused rather than substring-matched.
  assert.throws(
    () => checkNeonTarget({ ...good, disposableBranch: 'br-lucky-dew-a1b2c3' }),
    (error: GuardError) => error.code === 'DISPOSABLE_BRANCH_ID',
  );
  // Substrings of the endpoint id (which the old `host.includes(branch)` accepted) are refused.
  for (const partial of [
    'ep-load',
    'ep-load-br-lucky-dew',
    'load-br-lucky-dew-a1b2c3',
    'us-east-2',
  ])
    assert.throws(
      () => checkNeonTarget({ ...good, disposableBranch: partial }),
      GuardError,
      partial,
    );
  assert.throws(
    () => checkNeonTarget({ ...good, disposableBranch: 'ep-load-br-lucky-dew-a1b2c3x' }),
    (error: GuardError) => error.code === 'DISPOSABLE_MISMATCH',
  );
  assert.throws(() => checkNeonTarget({ ...good, disposableBranch: 'br/../x' }), GuardError);
  // The endpoint may be given as its host or pooler host.
  assert.doesNotThrow(() => checkNeonTarget({ ...good, disposableBranch: branchHost }));
  assert.doesNotThrow(() =>
    checkNeonTarget({ ...good, disposableBranch: 'EP-LOAD-BR-LUCKY-DEW-A1B2C3-pooler' }),
  );
});

test('neon guard forbids the shell DATABASE_URL endpoint automatically (app#28 follow-up)', () => {
  const pooled =
    'postgresql://app:synthetic@ep-load-br-lucky-dew-a1b2c3-pooler.us-east-2.aws.neon.tech/city';
  assert.throws(
    () => checkNeonTarget({ ...good, applicationDatabaseUrl: pooled }),
    (error: GuardError) => error.code === 'FORBIDDEN_ENDPOINT',
  );
  assert.doesNotThrow(() =>
    checkNeonTarget({
      ...good,
      applicationDatabaseUrl:
        'postgresql://app:synthetic@ep-prod-main-000000.us-east-2.aws.neon.tech/city',
    }),
  );
  assert.throws(
    () => checkNeonTarget({ ...good, applicationDatabaseUrl: 'garbage' }),
    (error: GuardError) => error.code === 'DATABASE_URL_UNPARSEABLE',
  );
});

test('public application origins are always refused', () => {
  for (const value of [
    'https://centralcity.ai',
    'https://app.centralcity.ai/',
    'https://central-city-git-main.vercel.app',
    'postgresql://u:p@ep-x.neon.tech/db?host=centralcity.ai',
  ])
    assert.throws(() => assertNotProductionOrigin(value), GuardError);
  assert.throws(
    () => assertNotProductionOrigin('https://city.example.org', ['https://city.example.org']),
    /production origin/,
  );
  assert.doesNotThrow(() =>
    assertNotProductionOrigin('https://load.test', ['https://city.example.org']),
  );
  assert.throws(
    () =>
      checkNeonTarget({
        ...good,
        databaseUrl: `postgresql://u:p@${branchHost}/city?options=vercel.app`,
      }),
    /vercel\.app/,
  );
  assert.throws(
    () =>
      checkNeonTarget({
        ...good,
        productionOrigins: [`https://${branchHost}`],
      }),
    /production origin/,
  );
});

test('neon preflight reads only LOAD_* configuration and the branch flag', () => {
  const env = {
    LOAD_DATABASE_URL: good.databaseUrl,
    LOAD_FORBIDDEN_ENDPOINTS: good.forbiddenEndpoints,
  };
  const expected = {
    host: branchHost,
    endpoint: 'ep-load-br-lucky-dew-a1b2c3',
    databaseUrl: good.databaseUrl,
  };
  const checked = preflight('neon', env, { 'disposable-endpoint': good.disposableBranch });
  assert.deepEqual(checked, expected);
  // The runner receives the exact validated string, frozen.
  assert.equal(checked.databaseUrl, env.LOAD_DATABASE_URL);
  assert.ok(Object.isFrozen(checked));
  assert.deepEqual(
    preflight('neon', env, { 'disposable-branch': good.disposableBranch }),
    expected,
  );
  // PGOPTIONS could add a Neon endpoint option after the check.
  assert.throws(
    () =>
      preflight(
        'neon',
        { ...env, PGOPTIONS: 'endpoint=ep-prod-main-000000' },
        { 'disposable-endpoint': good.disposableBranch },
      ),
    (error: GuardError) => error.code === 'PG_ENVIRONMENT' && /PGOPTIONS/.test(error.message),
  );
  // A trimmed production host in LOAD_FORBIDDEN_ENDPOINTS is refused, not ignored.
  assert.throws(
    () =>
      preflight(
        'neon',
        { ...env, LOAD_FORBIDDEN_ENDPOINTS: 'ep-prod-main-000000.us-east-2' },
        { 'disposable-endpoint': good.disposableBranch },
      ),
    (error: GuardError) =>
      error.code === 'FORBIDDEN_ENTRY_INVALID' && /LOAD_FORBIDDEN_ENDPOINTS/.test(error.message),
  );
  assert.throws(() => preflight('neon', env, {}), /disposable endpoint/);
  // The shell's DATABASE_URL is protected even though only LOAD_* configures the target.
  assert.throws(
    () =>
      preflight(
        'neon',
        { ...env, DATABASE_URL: good.databaseUrl },
        { 'disposable-endpoint': good.disposableBranch },
      ),
    /forbidden endpoint/,
  );
  assert.throws(
    () => preflight('neon', { ...env, DATABASE_URL: good.databaseUrl, LOAD_DATABASE_URL: '' }, {}),
    /LOAD_DATABASE_URL is required/,
  );
  assert.throws(
    () =>
      preflight(
        'neon',
        { ...env, LOAD_PRODUCTION_ORIGIN: `https://${branchHost}` },
        { 'disposable-branch': good.disposableBranch },
      ),
    /production origin/,
  );
});

test('the target database must be catalog-empty (app#16 must-fix: #28 check)', () => {
  const empty = { custom_schema_count: 0, relation_count: '0', function_count: 0, type_count: 0 };
  assert.doesNotThrow(() => checkDatabaseEmpty(empty));
  for (const key of Object.keys(empty) as (keyof typeof empty)[])
    assert.throws(() => checkDatabaseEmpty({ ...empty, [key]: 1 }), /not empty/, key);
  assert.throws(() => checkDatabaseEmpty(undefined), /not empty/);
  assert.throws(() => checkDatabaseEmpty({ ...empty, relation_count: 'x' }), /not empty/);
  assert.throws(() => checkDatabaseEmpty({ ...empty, type_count: -1 }), /not empty/);
  assert.match(CATALOG_EMPTY_SQL, /pg_catalog\.pg_class/);
});

test('only 2xx is ok: unsolicited redirects are errors unless expected', () => {
  assert.equal(classify(200, {}), 'ok');
  assert.equal(classify(204, null), 'ok');
  for (const status of [301, 302, 303, 304, 307, 308])
    assert.equal(classify(status, null), 'error', String(status));
  assert.equal(classify(302, null, [302]), 'expected');
  assert.equal(classify(429, null), 'refused');
  assert.equal(classify(409, { error: 'Active job capacity reached (2 per agent).' }), 'refused');
  assert.equal(classify(409, { error: 'Job lease is invalid.' }), 'error');
  assert.equal(classify(409, { error: 'Job lease is invalid.' }, [409]), 'expected');
});

/** In-process stand-in for the forked server child (no process is spawned). */
class FakeChild extends EventEmitter {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  connected = true;
  sent: Array<{ type: string; id?: number }> = [];
  send(message: { type: string; id?: number }): boolean {
    this.sent.push(message);
    return true;
  }
  kill(): boolean {
    this.die(null, 'SIGKILL');
    return true;
  }
  die(code: number | null, signal: NodeJS.Signals | null = null): void {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.exitCode = code;
    this.signalCode = signal;
    this.connected = false;
    this.emit('disconnect');
    this.emit('exit', code, signal);
  }
}

async function readyHandle(child: FakeChild, callTimeoutMs = 5_000) {
  const handle = connectServer(child, { callTimeoutMs, readyTimeoutMs: 1_000, stopTimeoutMs: 200 });
  child.emit('message', { type: 'ready', port: 4321 });
  return handle;
}

test('server child death after ready rejects pending calls promptly', async () => {
  const child = new FakeChild();
  const server = await readyHandle(child);
  assert.equal(server.port, 4321);
  const started = Date.now();
  const pending = Promise.all([
    assert.rejects(server.stats(), /Server child (exited|disconnected)/),
    assert.rejects(server.reset(), /Server child (exited|disconnected)/),
  ]);
  child.die(1);
  await pending;
  assert.ok(Date.now() - started < 1_000);
  // Later calls fail immediately and stop() is safe on an exited child.
  await assert.rejects(server.stats(), /Server child (exited|disconnected)/);
  await server.stop();
});

test('an unanswered server call rejects after its timeout', async () => {
  const child = new FakeChild();
  const server = await readyHandle(child, 50);
  const started = Date.now();
  await assert.rejects(server.stats(), /did not answer "stats" within 50 ms/);
  assert.ok(Date.now() - started < 1_000);
  // Answered calls still resolve.
  const reset = server.reset();
  const last = child.sent[child.sent.length - 1]!;
  child.emit('message', { type: 'reset', id: last.id });
  await reset;
  const stopping = server.stop();
  assert.equal(child.sent[child.sent.length - 1]!.type, 'stop');
  child.die(0);
  await stopping;
});

test('server child death before ready fails startup', async () => {
  const child = new FakeChild();
  const handle = connectServer(child, { readyTimeoutMs: 1_000 });
  child.die(1);
  await assert.rejects(handle, /Server child (exited|disconnected)/);
  const silent = new FakeChild();
  await assert.rejects(connectServer(silent, { readyTimeoutMs: 30 }), /ready in time/);
});

test('an owner session keeps the session pair under the name the server set', () => {
  const hosted = new OwnerSession('owner', '198.51.100.1');
  hosted.absorb([
    '__Host-cc_device=device; Path=/; HttpOnly; Secure',
    '__Host-cc_session=token; Path=/; HttpOnly; Secure; SameSite=Strict',
  ]);
  assert.equal(hosted.cookie, '__Host-cc_session=token');
  // A cleared cookie (the name before the prefix) does not replace it.
  hosted.absorb(['cc_session=; Path=/; Max-Age=0']);
  assert.equal(hosted.cookie, '__Host-cc_session=token');
  const loopback = new OwnerSession('owner', '198.51.100.1');
  loopback.absorb(['cc_session=token; Path=/; HttpOnly']);
  assert.equal(loopback.cookie, 'cc_session=token');
});
