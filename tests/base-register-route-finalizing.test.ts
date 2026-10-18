import { bundlerRejection, SponsorError } from '../server/base/chain/rpc-bundler.js';
import { transientChainError } from '../server/base/chain/transient.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import Fastify from 'fastify';
import { transientDatabaseError, type Database, type Transaction } from '../server/database.js';
import {
  BASE_IDENTITY_PROVISIONAL_SQL,
  BASE_IDENTITY_HANDOVER_BACKOFF_SQL,
  BASE_SEARCH_CURSOR_REGISTER_BACKOFF_SQL,
  BASE_MIGRATION_SQL,
  BASE_PAYMENTS_MIGRATION_SQL,
  BASE_WALLET_VAULT_SQL,
  baseShortIdsMigration,
} from '../server/base/schema.js';
import {
  FINALIZE_FRESH_MS,
  IDENTITY_FINALIZE_PATH,
  registerBaseRegistrationRoutes,
  TRANSIENT_RETRY_AFTER_S,
  type ChainRuntime,
} from '../server/base/identity/routes.js';
import {
  handoverKey,
  registerKey,
  type IdentityEvent,
  type IdentityOp,
} from '../server/base/identity/service.js';
import { BASE_MAINNET, baseNetwork, type Address } from '../shared/base/chains.js';
import { FakeIdentityChain } from './base-identity-fake-chain.js';

/*
 * The owner repeats POST /register (wallet key flow) while the registration waits at Base's SAFE
 * tag for FINALIZED, and the finalize cron advances the same rows. A Base read that fails or
 * answers nothing usable, a transient database failure (lock or statement timeout, no free
 * connection) and the cron's concurrent advance must never be a 500: the call answers the current
 * state unchanged, and a later call moves it on to confirmed. Real errors still throw.
 */

const AGENT = '9f8e7d6c-5b4a-4321-8fed-cba987654321';
const WALLET: Address = `0x${'1'.repeat(40)}`;
const KEY_OWNER: Address = `0x${'a'.repeat(40)}`;
const SPENDER: Address = `0x${'3'.repeat(40)}`;
const ENV = { CITY_BASE_MAINNET: '1', CITY_BASE_WALLET: '1' };
const REGISTRY = baseNetwork(BASE_MAINNET, ENV)!.contracts.identityRegistry!;
const SECRET = 's'.repeat(32);
const R0 = registerKey(AGENT, BASE_MAINNET);
const H0 = handoverKey(AGENT, BASE_MAINNET, 99029n);

/** A database error as the driver reports it (SQLSTATE in `code`). */
const pgError = (code: string, message: string) => Object.assign(new Error(message), { code });

interface Fault {
  match: RegExp;
  error: Error;
  times: number;
}

async function setup(
  t: { after: (fn: () => Promise<unknown>) => void },
  wallets = true,
  options: { throttle?: boolean } = {},
) {
  const pg = await PGlite.create('memory://');
  t.after(() => pg.close());
  await pg.exec(`CREATE TABLE operators (id text PRIMARY KEY, kind text NOT NULL);
    INSERT INTO operators VALUES ('p-1', 'owner');
    CREATE TABLE workspaces (operator_id text PRIMARY KEY, data jsonb NOT NULL);
    CREATE TABLE agent_manifests (agent_id text, operator_id text, revision integer, manifest jsonb);
    INSERT INTO workspaces VALUES ('p-1', '{"agents":[{"id":"${AGENT}","revision":1}]}');
    INSERT INTO agent_manifests VALUES ('${AGENT}', 'p-1', 1, '{"spec":{"visibility":"public"}}');`);
  await pg.exec(BASE_MIGRATION_SQL);
  await pg.exec(BASE_PAYMENTS_MIGRATION_SQL);
  await pg.exec(baseShortIdsMigration.sql);
  await pg.exec(BASE_IDENTITY_PROVISIONAL_SQL);
  await pg.exec(BASE_IDENTITY_HANDOVER_BACKOFF_SQL);
  await pg.exec(BASE_SEARCH_CURSOR_REGISTER_BACKOFF_SQL);
  await pg.exec(BASE_WALLET_VAULT_SQL);
  await pg.query(
    `INSERT INTO base_owner_vaults (operator_id, owner_address, encrypted_owner_key, kdf_params,
       cipher_params, version, backup_confirmed_at, created_at, updated_at)
     VALUES ('p-1', $1, $2, '{}', '{}', 1, 2, 1, 1)`,
    [KEY_OWNER, new Uint8Array(32)],
  );

  // Every statement passes the fault list first: a matching fault throws instead of running it.
  const faults: Fault[] = [];
  const statements: string[] = [];
  const guard = (sql: string) => {
    statements.push(sql);
    const fault = faults.find((candidate) => candidate.match.test(sql));
    if (!fault) return;
    if (--fault.times <= 0) faults.splice(faults.indexOf(fault), 1);
    throw fault.error;
  };
  const wrap = (inner: Pick<Transaction, 'query' | 'exec'>): Transaction => ({
    query: async (sql, params) => {
      guard(sql);
      return (await inner.query(sql, params)) as never;
    },
    exec: (sql) => inner.exec(sql),
  });
  const db: Database = {
    ...wrap({
      query: (sql, params) => pg.query(sql, params) as never,
      exec: (sql) => pg.exec(sql),
    }),
    transaction: (action) => pg.transaction((tx) => action(wrap(tx as never))),
    close: () => pg.close(),
  };
  const chain = new FakeIdentityChain({ spender: SPENDER, registry: REGISTRY });
  const runtime: ChainRuntime = {
    walletPort: {
      implementationVersion: 'cbsw-1.1',
      deriveSmartAccount: async () => WALLET,
      createSpender: async () => ({ spender: SPENDER, keyRef: 'v1:k' }),
      commitSpender: async () => {},
    },
    identityPort: chain,
  };
  const events: IdentityEvent[] = [];
  const app = Fastify();
  t.after(() => app.close());
  registerBaseRegistrationRoutes(app, {
    // Every call here is one advance (no clock passes between them); the chain-check pacing is
    // covered in base-rpc-calls-per-agent.test.ts.
    throttleChainChecks: options.throttle === true,
    db,
    env: wallets ? ENV : { CITY_BASE_MAINNET: '1' },
    currentOperator: async (request) => {
      const who = request.headers['x-test-person'];
      return typeof who === 'string' ? { id: who } : null;
    },
    currentPerson: async (request) => {
      const who = request.headers['x-test-person'];
      return typeof who === 'string' ? { id: who } : null;
    },
    runtime: async () => runtime,
    cronSecret: SECRET,
    log: (event) => events.push(event),
  });
  /** With wallets on, the browser's derived wallet; with wallets off, an owner address. */
  const register = (address: string = wallets ? WALLET : KEY_OWNER) =>
    app.inject({
      method: 'POST',
      url: `/api/base/agents/${AGENT}/register`,
      headers: { 'x-test-person': 'p-1' },
      payload: wallets ? { expectedWallet: address } : { ownerAddress: address },
    });
  const cron = () =>
    app.inject({ url: IDENTITY_FINALIZE_PATH, headers: { authorization: `Bearer ${SECRET}` } });
  const row = async () =>
    (
      await pg.query<{
        state: string;
        evidence_rev: string;
        erc8004_agent_id: string | null;
        destination_mismatch: string | null;
      }>(
        `SELECT state, evidence_rev::text AS evidence_rev,
           erc8004_agent_id::text AS erc8004_agent_id, destination_mismatch
         FROM base_identities WHERE agent_id = $1`,
        [AGENT],
      )
    ).rows[0];
  const fault = (match: RegExp, error: Error, times = 1) => faults.push({ match, error, times });
  /** The row's last change moved back past FINALIZE_FRESH_MS: no poll moved it just now. */
  const age = () =>
    pg.query('UPDATE base_identities SET updated_at = updated_at - $1::bigint', [
      FINALIZE_FRESH_MS,
    ]);
  return { app, pg, chain, events, statements, faults, fault, register, cron, row, age };
}

type Setup = Awaited<ReturnType<typeof setup>>;

/**
 * Mint and hand-over both at Base's SAFE tag ('registered'), then both FINALIZED on chain: the next
 * advance runs the finality checks (the mint's final evidence, the hand-over's final receipt and
 * the destination read at the finalized block) and confirms.
 */
async function registeredAwaitingFinality(s: Setup) {
  assert.equal((await s.register()).statusCode, 200);
  s.chain.include(R0, { tx: '0xa1', block: 100, id: 99029n }, 'safe');
  assert.equal((await s.register()).json().identity.stage, 'handing_over');
  s.chain.include(H0, { tx: '0xb1', block: 101 }, 'safe');
  const at = (await s.register()).json().identity;
  assert.equal(at.state, 'submitted');
  assert.equal(at.stage, 'registered');
  s.chain.finalize(R0);
  s.chain.finalize(H0);
}

/** The answer is the current state: 200, still submitted at stage 'registered', never confirmed. */
async function assertStillRegistered(s: Setup, response: Awaited<ReturnType<Setup['register']>>) {
  assert.equal(response.statusCode, 200, response.body);
  const body = response.json();
  assert.equal(body.identity.state, 'submitted');
  assert.equal(body.identity.stage, 'registered');
  assert.equal(body.identity.pollAfterMs, 30000);
  assert.equal(body.wallet.address, WALLET);
  assert.equal((await s.row()).state, 'submitted');
  assert.equal((await s.row()).destination_mismatch, null, 'nothing concluded from the failure');
}

async function assertConfirmsNext(s: Setup) {
  const next = await s.register();
  assert.equal(next.statusCode, 200, next.body);
  assert.equal(next.json().identity.state, 'confirmed');
  assert.equal(next.json().identity.erc8004AgentId, '99029');
  assert.equal((await s.row()).state, 'confirmed');
}

/** A failed RPC read; a node's JSON-RPC error carries no string code. */
const lagging = (message: string, code?: string): Error & { code?: string } =>
  Object.assign(new Error(message), code === undefined ? {} : { code });

const CHAIN_FAILURES: Array<{
  name: string;
  arm: (s: Setup) => void;
  event: string;
  code: string;
}> = [
  {
    name: 'the mint evidence read fails on a lagging node ("header not found")',
    arm: (s) => s.chain.evidenceQueue.push(() => Promise.reject(lagging('header not found'))),
    event: 'identity.evidence_unavailable',
    code: 'error',
  },
  {
    name: 'the mint evidence read answers nothing usable',
    arm: (s) => s.chain.evidenceQueue.push(() => undefined as never),
    event: 'identity.evidence_unavailable',
    code: 'MALFORMED',
  },
  {
    name: 'the finalized read is unavailable (timeout, HTTP error)',
    arm: (s) =>
      s.chain.identityAtQueue.push(() => Promise.reject(lagging('unavailable', 'UNAVAILABLE'))),
    event: 'identity.destination_unavailable',
    code: 'UNAVAILABLE',
  },
  {
    name: 'the finalized block changed under a load-balanced endpoint',
    arm: (s) =>
      s.chain.identityAtQueue.push(() => Promise.reject(lagging('changed', 'BLOCK_CHANGED'))),
    event: 'identity.destination_unavailable',
    code: 'BLOCK_CHANGED',
  },
  {
    name: 'the finalized read answers null',
    arm: (s) => s.chain.identityAtQueue.push(() => null as never),
    event: 'identity.destination_unavailable',
    code: 'MALFORMED',
  },
  {
    name: 'the hand-over receipt read fails',
    arm: (s) => {
      s.chain.transferError = lagging('request timed out', 'TIMEOUT');
    },
    event: 'identity.handover_refused',
    code: 'TIMEOUT',
  },
  {
    name: 'the hand-over receipt read answers null',
    arm: (s) => {
      const real = s.chain.transfer.bind(s.chain);
      s.chain.transfer = async (input) => {
        s.chain.transfer = real;
        await real(input);
        return null as unknown as IdentityOp;
      };
    },
    event: 'identity.handover_refused',
    code: 'MALFORMED',
  },
];

for (const failure of CHAIN_FAILURES)
  test(`finalizing: ${failure.name} answers the current state, then confirms`, async (t) => {
    const s = await setup(t);
    await registeredAwaitingFinality(s);
    failure.arm(s);
    await assertStillRegistered(s, await s.register());
    assert.ok(
      s.events.some((e) => e.event === failure.event && e.code === failure.code),
      JSON.stringify(s.events),
    );
    s.chain.transferError = null;
    await assertConfirmsNext(s);
  });

const DB_FAILURES: Array<{ name: string; match: RegExp; error: Error; code: string }> = [
  {
    name: 'a lock timeout on the identity row write',
    match: /^\s*UPDATE base_identities SET/,
    error: pgError('55P03', 'canceling statement due to lock timeout'),
    code: '55P03',
  },
  {
    name: 'a serialization failure on the identity row write',
    match: /^\s*UPDATE base_identities SET/,
    error: pgError('40001', 'could not serialize access due to concurrent update'),
    code: '40001',
  },
  {
    name: 'a statement timeout on the identity row read',
    match: /FROM base_identities WHERE agent_id = \$1 AND chain_id = \$2$/,
    error: pgError('57014', 'canceling statement due to statement timeout'),
    code: '57014',
  },
  {
    name: 'no free pooled connection in time',
    match: /^SELECT operator_id, address, spender_address/,
    error: new Error('timeout exceeded when trying to connect'),
    code: 'error',
  },
];

for (const failure of DB_FAILURES)
  test(`finalizing: ${failure.name} answers the stored state, then confirms`, async (t) => {
    const s = await setup(t);
    await registeredAwaitingFinality(s);
    const before = await s.row();
    s.fault(failure.match, failure.error);
    const response = await s.register();
    await assertStillRegistered(s, response);
    assert.equal(response.headers['retry-after'], undefined);
    assert.equal((await s.row()).evidence_rev, before.evidence_rev, 'nothing written');
    assert.ok(
      s.events.some((e) => e.event === 'identity.register_transient' && e.code === failure.code),
      JSON.stringify(s.events),
    );
    await assertConfirmsNext(s);
  });

test('repeated calls never take the workspace row lock, so its timeout cannot fail them', async (t) => {
  const s = await setup(t);
  // The first call assigns the short id under the workspace row lock.
  await s.register();
  const lock = /FROM workspaces WHERE operator_id = \$1 FOR UPDATE/;
  assert.equal(s.statements.filter((sql) => lock.test(sql)).length, 1);
  // From then on every workspace writer of this owner may hold the lock past lock_timeout.
  s.fault(lock, pgError('55P03', 'canceling statement due to lock timeout'), Infinity);
  s.chain.include(R0, { tx: '0xa1', block: 100, id: 99029n }, 'safe');
  assert.equal((await s.register()).statusCode, 200);
  s.chain.include(H0, { tx: '0xb1', block: 101 }, 'safe');
  assert.equal((await s.register()).json().identity.stage, 'registered');
  s.chain.finalize(R0);
  s.chain.finalize(H0);
  await assertConfirmsNext(s);
  assert.equal(s.statements.filter((sql) => lock.test(sql)).length, 1, 'locked once per agent');

  // The profile check itself still runs on every call: a private card is still refused.
  await s.pg.query(
    `UPDATE agent_manifests SET manifest = '{"spec":{"visibility":"private"}}' WHERE agent_id = $1`,
    [AGENT],
  );
  assert.equal((await s.register()).json().code, 'profile_private');
});

test('a first call that meets the workspace lock timeout answers 503 with Retry-After', async (t) => {
  const s = await setup(t);
  s.fault(
    /FROM workspaces WHERE operator_id = \$1 FOR UPDATE/,
    pgError('55P03', 'canceling statement due to lock timeout'),
  );
  const busy = await s.register();
  assert.equal(busy.statusCode, 503);
  assert.equal(busy.headers['retry-after'], String(TRANSIENT_RETRY_AFTER_S));
  assert.equal(busy.json().code, 'busy');
  assert.equal(await s.row(), undefined, 'nothing started');
  assert.equal(s.chain.calls.register.length, 0);
  const next = await s.register();
  assert.equal(next.statusCode, 200);
  assert.equal(next.json().identity.stage, 'registering');
});

test('when even the stored state cannot be read, the answer is 503 with Retry-After', async (t) => {
  const s = await setup(t);
  await registeredAwaitingFinality(s);
  s.fault(/^\s*UPDATE base_identities SET/, pgError('55P03', 'lock timeout'));
  s.fault(/LEFT JOIN base_wallets w/, pgError('57014', 'statement timeout'));
  const busy = await s.register();
  assert.equal(busy.statusCode, 503);
  assert.equal(busy.headers['retry-after'], String(TRANSIENT_RETRY_AFTER_S));
  assert.equal((await s.row()).state, 'submitted');
  await assertConfirmsNext(s);
});

test('the stored state answers only the browser whose wallet it is', async (t) => {
  const s = await setup(t);
  await registeredAwaitingFinality(s);
  const vault = /FROM base_owner_vaults WHERE operator_id = \$1/;
  s.fault(vault, pgError('55P03', 'lock timeout'));
  const other = await s.register(`0x${'4'.repeat(40)}`);
  assert.equal(other.statusCode, 503, 'another wallet never gets this registration as its answer');
  s.fault(vault, pgError('55P03', 'lock timeout'));
  await assertStillRegistered(s, await s.register());
});

test('with wallets off, the stored state answers only the owner address it was started with', async (t) => {
  const s = await setup(t, false);
  await s.register();
  s.chain.include(R0, { tx: '0xa1', block: 100, id: 99029n }, 'safe');
  await s.register();
  const write = /^\s*UPDATE base_identities SET/;
  s.fault(write, pgError('55P03', 'lock timeout'));
  assert.equal((await s.register(`0x${'4'.repeat(40)}`)).statusCode, 409, 'refused as before');
  s.fault(/^SELECT \* FROM base_wallets/, pgError('55P03', 'lock timeout'));
  assert.equal((await s.register(`0x${'4'.repeat(40)}`)).statusCode, 503);
  s.faults.length = 0;
  s.fault(write, pgError('55P03', 'lock timeout'));
  const own = await s.register();
  assert.equal(own.statusCode, 200);
  assert.equal(own.json().wallet.ownerAddress.toLowerCase(), KEY_OWNER);
  assert.equal(own.json().identity.state, 'submitted');
});

test('Base\'s endpoint saying "not now" (429, timeout, 5xx) answers the stored state, never a 500', async (t) => {
  const s = await setup(t);
  await registeredAwaitingFinality(s);
  // As viem reports the CDP endpoint's rate limit seen in production (the URL is never shown).
  const rateLimited = Object.assign(new Error('HTTP request failed.\n\nStatus: 429'), {
    name: 'HttpRequestError',
    status: 429,
  });
  s.fault(/^\s*UPDATE base_identities SET/, rateLimited);
  const res = await s.register();
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().identity.state, 'submitted');
  assert.equal(res.json().identity.stage, 'registered');
  const timedOut = Object.assign(new Error('The request took too long to respond.'), {
    name: 'TimeoutError',
  });
  s.fault(/^\s*UPDATE base_identities SET/, timedOut);
  assert.equal((await s.register()).statusCode, 200);
  await assertConfirmsNext(s);
});

test('a JSON-RPC rate limit inside an HTTP 200 (-32002) is never a 500, and the cron retries it', async (t) => {
  const s = await setup(t);
  // As rpc-bundler reports the paymaster answering 200 {"error":{"code":-32002}} while preparing
  // the register operation: nothing was signed or stored for it.
  s.chain.registerError = new SponsorError(
    bundlerRejection('pm_getPaymasterStubData', { code: -32002, message: 'resource unavailable' }),
  );
  const busy = await s.register();
  // The route's answer for Base saying "not now": where the registration stands (open, not a 500).
  assert.equal(busy.statusCode, 200, busy.body);
  assert.equal(busy.json().identity.state, 'pending');
  assert.equal(busy.json().identity.stage, 'registering');
  assert.ok(s.events.some((e) => e.event === 'identity.register_transient'));
  assert.equal(s.chain.signs.get(R0), undefined, 'nothing signed for the busy attempt');
  const { rows } = await s.pg.query<{ op_id: string | null; register_op_id: string | null }>(
    'SELECT op_id, register_op_id FROM base_identities WHERE agent_id = $1',
    [AGENT],
  );
  assert.deepEqual(rows[0], { op_id: R0, register_op_id: R0 }, 'the attempt is recorded');
  // The finalize cron picks the open attempt up once its backoff ended, and asks again with the
  // same key.
  await s.age();
  await s.pg.query('UPDATE base_identities SET register_retry_at = 0 WHERE agent_id = $1', [AGENT]);
  assert.deepEqual((await s.cron()).json(), { advanced: 1, confirmed: 0, errors: 0 });
  assert.deepEqual(s.chain.calls.register, [R0, R0]);
  assert.equal(s.chain.signs.get(R0), 1);
  assert.equal((await s.row()).state, 'submitted');
  // With no registration stored yet the same failure is the 503 busy answer.
  const t2 = await setup(t);
  t2.fault(
    /^SELECT \* FROM base_wallets/,
    new SponsorError(bundlerRejection('pm_getPaymasterData', { code: -32005, message: 'x' })),
  );
  const unstored = await t2.register();
  assert.equal(unstored.statusCode, 503, unstored.body);
  assert.equal(unstored.headers['retry-after'], String(TRANSIENT_RETRY_AFTER_S));
  assert.equal(unstored.json().code, 'busy');
  // A real JSON-RPC error is still a 500, and records nothing.
  const t3 = await setup(t);
  t3.chain.registerError = bundlerRejection('eth_estimateUserOperationGas', {
    code: -32500,
    message: 'AA21 didnt pay prefund',
  });
  assert.equal((await t3.register()).statusCode, 500);
});

test('a late busy answer never moves a registration another call stored back to pending', async (t) => {
  const s = await setup(t);
  const rowOf = async () =>
    (
      await s.pg.query<{
        state: string;
        op_id: string | null;
        register_op_id: string | null;
        tx_hash: string | null;
        updated_at: string;
        evidence_rev: string;
        register_refusals: number;
        register_retry_at: string | null;
      }>(
        `SELECT state, op_id, register_op_id, tx_hash, updated_at::text AS updated_at,
           evidence_rev::text AS evidence_rev, register_refusals,
           register_retry_at::text AS register_retry_at
         FROM base_identities WHERE agent_id = $1`,
        [AGENT],
      )
    ).rows[0];
  // A reads the row (pending, no attempt) and asks Base to register. Before Base answers A, call B
  // registers and stores it (submitted, with its transaction); then Base answers A "429".
  let afterB: Awaited<ReturnType<typeof rowOf>> | undefined;
  s.chain.beforeRegister = async () => {
    const b = await s.register();
    assert.equal(b.statusCode, 200, b.body);
    await s.pg.query(`UPDATE base_identities SET tx_hash = '0xabc' WHERE agent_id = $1`, [AGENT]);
    afterB = await rowOf();
    assert.equal(afterB.state, 'submitted');
    s.chain.registerError = Object.assign(new Error('Too Many Requests'), { status: 429 });
  };
  const a = await s.register();
  assert.equal(a.statusCode, 200, a.body);
  assert.deepEqual(s.chain.calls.register, [R0, R0]);
  assert.equal(s.chain.signs.get(R0), 1, 'one operation for the one attempt');
  // A's late refusal wrote nothing: still submitted, same attempt, same transaction, same write
  // time (the stuck timer does not restart), no refusal counted.
  assert.deepEqual(await rowOf(), afterB);
  assert.equal(afterB!.op_id, R0);
  assert.equal(afterB!.tx_hash, '0xabc');
  assert.equal(afterB!.register_refusals, 0);
});

test('busy refusals back off, the cron skips the row meanwhile, and Try again is offered after 3', async (t) => {
  const s = await setup(t);
  const busy = () => {
    s.chain.registerError = new SponsorError(
      bundlerRejection('pm_getPaymasterStubData', { code: -32603, message: 'rate limit exceeded' }),
    );
  };
  const refusals = async () =>
    (
      await s.pg.query<{ register_refusals: number; register_retry_at: string | null }>(
        `SELECT register_refusals, register_retry_at::text AS register_retry_at
         FROM base_identities WHERE agent_id = $1`,
        [AGENT],
      )
    ).rows[0];
  /** The backoff ends now: as if its wait had passed. */
  const waitOut = () =>
    s.pg.query('UPDATE base_identities SET register_retry_at = 0 WHERE agent_id = $1', [AGENT]);
  busy();
  const first = await s.register();
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(first.json().identity.state, 'pending');
  assert.equal(first.json().identity.canRetry, false, 'not offered after one refusal');
  assert.equal((await refusals()).register_refusals, 1);
  assert.ok(Number((await refusals()).register_retry_at) > Date.now(), 'backing off');
  // While it backs off, neither the owner's poll nor the cron asks Base again.
  await s.register();
  await s.age();
  assert.deepEqual((await s.cron()).json(), { advanced: 0, confirmed: 0, errors: 0 });
  assert.deepEqual(s.chain.calls.register, [R0]);
  // Two more refusals after their waits: the owner is offered Try again; still pending, one key.
  for (let i = 2; i <= 3; i++) {
    await waitOut();
    busy();
    const next = await s.register();
    assert.equal(next.statusCode, 200, next.body);
    assert.equal((await refusals()).register_refusals, i);
  }
  const offered = await s.register();
  assert.equal(offered.json().identity.state, 'pending');
  assert.equal(offered.json().identity.canRetry, true, 'Try again after 3 refusals');
  assert.deepEqual(s.chain.calls.register, [R0, R0, R0]);
  assert.equal(s.chain.signs.get(R0), undefined, 'nothing signed while refused');
  // Try again asks at once, with the same attempt key, and an answer ends the backoff.
  const retried = await s.app.inject({
    method: 'POST',
    url: `/api/base/agents/${AGENT}/register`,
    headers: { 'x-test-person': 'p-1' },
    payload: { expectedWallet: WALLET, retry: true },
  });
  assert.equal(retried.statusCode, 200, retried.body);
  assert.equal(retried.json().identity.state, 'submitted');
  assert.equal(s.chain.signs.get(R0), 1, 'one registration');
  assert.equal(s.chain.calls.register.at(-1), R0);
  assert.deepEqual(await refusals(), { register_refusals: 0, register_retry_at: null });
});

test('transient Base errors are told apart from real ones', () => {
  assert.equal(transientChainError(Object.assign(new Error('x'), { status: 429 })), true);
  assert.equal(transientChainError(Object.assign(new Error('x'), { status: 503 })), true);
  assert.equal(transientChainError(Object.assign(new Error('x'), { code: -32005 })), true);
  assert.equal(transientChainError(new Error('Too Many Requests')), true);
  assert.equal(
    transientChainError(
      new Error('outer', { cause: Object.assign(new Error('in'), { status: 429 }) }),
    ),
    true,
  );
  assert.equal(transientChainError(Object.assign(new Error('x'), { status: 400 })), false);
  assert.equal(transientChainError(new Error('boom')), false);
  assert.equal(transientChainError(null), false);
});

test('a real error still throws (no transient code): 500', async (t) => {
  const s = await setup(t);
  await registeredAwaitingFinality(s);
  s.fault(/^\s*UPDATE base_identities SET/, new Error('boom'));
  assert.equal((await s.register()).statusCode, 500);
  s.fault(/^\s*UPDATE base_identities SET/, pgError('23514', 'check constraint violated'));
  assert.equal((await s.register()).statusCode, 500);
  await assertConfirmsNext(s);
});

test('the owner’s call and the finalize cron advance the same row at once: no 500', async (t) => {
  const s = await setup(t);
  await registeredAwaitingFinality(s);
  // The owner's call stops inside its hand-over read; the cron confirms the row meanwhile.
  const release = s.chain.holdNextTransfer();
  const transfers = s.chain.calls.transfer.length;
  const owner = s.register();
  while (s.chain.calls.transfer.length === transfers) await new Promise((r) => setImmediate(r));
  // As if the owner's call had stalled past FINALIZE_FRESH_MS: the cron takes the row meanwhile.
  await s.age();
  const run = await s.cron();
  assert.deepEqual(run.json(), { advanced: 1, confirmed: 1, errors: 0 });
  release();
  const late = await owner;
  assert.equal(late.statusCode, 200, late.body);
  assert.equal(late.json().identity.state, 'confirmed');
  assert.equal((await s.row()).state, 'confirmed');
  assert.deepEqual(s.chain.signedKeys(), { [R0]: 1, [H0]: 1 }, 'nothing sent twice');
});

test('transient database errors are told apart from real ones', () => {
  for (const code of ['55P03', '40001', '40P01', '57014', '57P01', '53300', '08006', 'ECONNRESET'])
    assert.equal(transientDatabaseError(pgError(code, 'x')), true, code);
  for (const message of [
    'timeout exceeded when trying to connect',
    'Connection terminated unexpectedly',
    'Query read timeout',
  ])
    assert.equal(transientDatabaseError(new Error(message)), true, message);
  for (const error of [
    pgError('23505', 'duplicate key'),
    pgError('23514', 'check'),
    pgError('42601', 'syntax'),
    new TypeError('x is undefined'),
    pgError('UNAVAILABLE', 'chain'),
    null,
    'text',
  ])
    assert.equal(transientDatabaseError(error), false, String(error));
});

test('the finalize cron skips a row while its refused hand-over backs off, and takes it after', async (t) => {
  const s = await setup(t);
  await registeredAwaitingFinality(s);
  await s.age();
  // Backing off long past this run: its place in the batch goes to rows that can move.
  await s.pg.query('UPDATE base_identities SET handover_refusals = 3, handover_retry_at = $1', [
    Number.MAX_SAFE_INTEGER,
  ]);
  const calls = JSON.stringify(s.chain.calls);
  assert.deepEqual((await s.cron()).json(), { advanced: 0, confirmed: 0, errors: 0 });
  assert.equal(JSON.stringify(s.chain.calls), calls, 'no Base read for a row backing off');
  const swept = await s.pg.query<{ swept_at: string | null }>(
    'SELECT swept_at::text AS swept_at FROM base_identities',
  );
  assert.equal(swept.rows[0].swept_at, null, 'not claimed');
  // The backoff ended: the next run moves it on.
  await s.pg.query('UPDATE base_identities SET handover_retry_at = 1');
  assert.deepEqual((await s.cron()).json(), { advanced: 1, confirmed: 1, errors: 0 });
  assert.equal((await s.row()).state, 'confirmed');
});

test('the finalize cron leaves a row a poll just moved to that poll, and takes it on a later run', async (t) => {
  const s = await setup(t);
  await registeredAwaitingFinality(s);
  // The owner's poll moved the row a moment ago: the cron neither claims it nor reads Base for it.
  const calls = JSON.stringify(s.chain.calls);
  assert.deepEqual((await s.cron()).json(), { advanced: 0, confirmed: 0, errors: 0 });
  assert.equal(JSON.stringify(s.chain.calls), calls, 'no Base read for a fresh row');
  const swept = await s.pg.query<{ swept_at: string | null }>(
    'SELECT swept_at::text AS swept_at FROM base_identities',
  );
  assert.equal(swept.rows[0].swept_at, null, 'not claimed: first in line next run');
  assert.equal((await s.row()).state, 'submitted');
  // Once its last change is older than FINALIZE_FRESH_MS, the next run moves it on.
  await s.age();
  assert.deepEqual((await s.cron()).json(), { advanced: 1, confirmed: 1, errors: 0 });
  assert.equal((await s.row()).state, 'confirmed');
});

test('a frozen or closed wallet is refused also while the chain checks are throttled', async (t) => {
  for (const state of ['frozen', 'closed']) {
    const s = await setup(t, true, { throttle: true });
    assert.equal((await s.register()).statusCode, 200);
    // The chain was asked just now: the next call would answer the stored state.
    await s.pg.query('UPDATE base_identities SET swept_at = $1::bigint', [Date.now()]);
    assert.equal((await s.register()).statusCode, 200, 'throttled, stored state');
    await s.pg.query('UPDATE base_wallets SET state = $1', [state]);
    const refused = await s.register();
    assert.equal(refused.statusCode, 409, `${state}: ${refused.body}`);
    assert.equal(refused.json().code, 'wallet_frozen');
  }
});
