/*
 * Audit CCA-714: one key per role. A key ref configured for two roles is refused (the runtime does
 * not build the signer), and at start every two roles that share an account (app-held keys, the
 * treasury, the funding wallet) are logged as ALERT. Fake key refs and addresses only.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import type { Database } from '../server/database.js';
import { BASE_MAINNET, BASE_SEPOLIA } from '../shared/base/chains.js';
import {
  arcFacilitatorKeySharedWithBase,
  arcFacilitatorKeyUsable,
  arcPaymasterKeySharedWithBase,
  arcPaymasterKeysUsable,
  checkKeyRolesAtStart,
  KEY_REF_SETTINGS,
  keyRefSharedWithOtherRole,
  keyRoleConflicts,
  roleKeyUsable,
} from '../server/base/chain/key-roles.js';
import { ARC_TESTNET } from '../shared/chains.js';
import { createChainRuntime } from '../server/base/chain/runtime.js';
import { createApp } from '../server/app.js';

const ref = (n: number) => `v1:0000000${n}-0000-0000-0000-000000000000`;
const addr = (n: number) => `0x${String(n).repeat(40).slice(0, 40)}`;

const quiet = () => ({ reported: new Set<string>(), log: () => {} });

test("key roles: Arc's facilitator is a role of its own; a key any role of Base names is refused on Arc", () => {
  assert.equal(KEY_REF_SETTINGS.arc_router3_facilitator, 'CITY_ARC_FACILITATOR_KEY_REF');
  const clean = {
    CITY_X402_FACILITATOR_KEY_REF: ref(1),
    CITY_X402_PUBLIC_SETTLE_KEY_REF: ref(2),
    CITY_SFP_SPONSOR_KEY_REF: ref(3),
    CITY_BASE_PAYMASTER_SIGNER_KEY_REF: ref(4),
    CITY_BASE_SUBMITTER_KEY_REFS: `${ref(5)}, ${ref(6)}`,
    CITY_ARC_FACILITATOR_KEY_REF: ref(7),
  };
  assert.equal(arcFacilitatorKeySharedWithBase(clean), null);
  assert.equal(arcFacilitatorKeyUsable(clean, quiet()), true);
  assert.equal(arcFacilitatorKeyUsable({}, quiet()), true, 'optional when unset');
  // Every role of Base, with and without enforcement, whatever the KEK version.
  for (const key of [ref(1), ref(2), ref(3), ref(4), ref(6), ref(1).replace('v1:', 'v2:')]) {
    const shared = { ...clean, CITY_ARC_FACILITATOR_KEY_REF: key };
    assert.equal(arcFacilitatorKeySharedWithBase(shared), 'CITY_ARC_FACILITATOR_KEY_REF');
    assert.equal(arcFacilitatorKeyUsable(shared, quiet()), false);
    assert.equal(
      arcFacilitatorKeyUsable({ ...shared, CITY_KEY_ROLES_ENFORCE: '1' }, quiet()),
      false,
    );
  }
  // The ALERT names the setting once, never a value.
  const lines: string[] = [];
  const options = { reported: new Set<string>(), log: (line: string) => lines.push(line) };
  const shared = { ...clean, CITY_ARC_FACILITATOR_KEY_REF: ref(1) };
  arcFacilitatorKeyUsable(shared, options);
  arcFacilitatorKeyUsable(shared, options);
  assert.deepEqual(lines, [
    "key roles: ALERT CITY_ARC_FACILITATOR_KEY_REF names a key also configured for a role on Base; Arc's facilitator is not built",
  ]);
});

test("key roles: Arc's facilitator sharing never blocks Base", () => {
  const shared = {
    CITY_KEY_ROLES_ENFORCE: '1',
    CITY_X402_FACILITATOR_KEY_REF: ref(1),
    CITY_X402_PUBLIC_SETTLE_KEY_REF: ref(2),
    CITY_SFP_SPONSOR_KEY_REF: ref(3),
  };
  for (const [role, key] of [
    ['router3_facilitator', ref(1)],
    ['public_settle', ref(2)],
    ['sfp_sponsor', ref(3)],
  ] as const) {
    const env = { ...shared, CITY_ARC_FACILITATOR_KEY_REF: key };
    assert.equal(keyRefSharedWithOtherRole(env, role), false, role);
    const lines: string[] = [];
    const options = { reported: new Set<string>(), log: (line: string) => lines.push(line) };
    assert.equal(roleKeyUsable(env, role, options), true, role);
    assert.deepEqual(lines, [], role);
  }
});

test("key roles: sharing inside Arc follows the ordinary rule, and isn't called sharing with Base", () => {
  const env = {
    CITY_ARC_FACILITATOR_KEY_REF: ref(1),
    CITY_ARC_SUBMITTER_KEY_REFS: ref(1),
  };
  assert.equal(arcFacilitatorKeySharedWithBase(env), null);
  assert.equal(arcPaymasterKeySharedWithBase(env), null);
  assert.equal(keyRefSharedWithOtherRole(env, 'arc_router3_facilitator'), true);
  assert.equal(keyRefSharedWithOtherRole(env, 'arc_paymaster_submitter'), true);
  assert.equal(arcFacilitatorKeyUsable(env, quiet()), true, 'ALERT only');
  assert.equal(arcPaymasterKeysUsable(env, quiet()), true, 'ALERT only');
  const enforced = { ...env, CITY_KEY_ROLES_ENFORCE: '1' };
  assert.equal(arcFacilitatorKeyUsable(enforced, quiet()), false);
  assert.equal(arcPaymasterKeysUsable(enforced, quiet()), false);
});

test("key roles: Arc's runtime builds its facilitator on its own key, also when enforced; refuses Base's", () => {
  const env = {
    CITY_KEY_ROLES_ENFORCE: '1',
    CITY_ARC: '1',
    CITY_ARC_CHAIN_ID: String(ARC_TESTNET),
    CITY_ARC_RPC_URL: 'https://arc.invalid/rpc',
    CITY_BASE_SPENDER_KEK: `v1:${randomBytes(32).toString('base64')}`,
    CITY_ARC_MAX_FEE_PER_GAS_WEI: '100000000000',
    CITY_ARC_PAYMASTER: `0x${'a1'.repeat(20)}`,
    CITY_ARC_OWN_PAYMASTER: 'on',
    CITY_ARC_FEE_ROUTER3: `0x${'a3'.repeat(20)}`,
    CITY_ARC_FEE_ROUTER3_FROM_BLOCK: '1',
    CITY_X402_FACILITATOR_KEY_REF: ref(1),
    CITY_SFP_SPONSOR_KEY_REF: ref(2),
    CITY_ARC_FACILITATOR_KEY_REF: ref(3),
  };
  const db = { query: async () => ({ rows: [] }) } as unknown as Database;
  const facilitator = (over: Record<string, string>) =>
    consoleLines(() =>
      createChainRuntime({
        db,
        env: { ...env, ...over },
        chainId: ARC_TESTNET,
      }).router3Facilitator?.(),
    );
  const own = facilitator({});
  assert.ok(own.result, 'Arc view names its key under both names: not counted as sharing');
  assert.deepEqual(
    own.lines.filter((line) => line.startsWith('key roles:')),
    [],
  );
  // Not only Base's facilitator: the sponsor too, which Arc's view doesn't even carry.
  const shared = facilitator({ CITY_ARC_FACILITATOR_KEY_REF: ref(2) });
  assert.equal(shared.result, null);
  assert.deepEqual(
    shared.lines.filter((line) => line.startsWith('key roles:')),
    [
      "key roles: ALERT CITY_ARC_FACILITATOR_KEY_REF names a key also configured for a role on Base; Arc's facilitator is not built",
    ],
  );
});

test("key roles: Base's runtime still builds its facilitator on a key Arc's setting also names", () => {
  const env = {
    CITY_KEY_ROLES_ENFORCE: '1',
    CITY_BASE_MAINNET: '1',
    CITY_BASE_CDP_RPC_URL: 'https://rpc.example.test/base',
    CITY_BASE_SPENDER_KEK: `v1:${randomBytes(32).toString('base64')}`,
    CITY_BASE_MAX_FEE_PER_GAS_WEI: '1000000000',
    CITY_BASE_IDENTITY_FEE_CAP_WEI: '50000000000000',
    CITY_BASE_WALLET_FEE_CAP_WEI: '20000000000000',
    CITY_X402_FACILITATOR_KEY_REF: ref(1),
    CITY_ARC_FACILITATOR_KEY_REF: ref(1),
  };
  const db = { query: async () => ({ rows: [] }) } as unknown as Database;
  const { result, lines } = consoleLines(() =>
    createChainRuntime({ db, env, chainId: BASE_MAINNET }).router3Facilitator?.(),
  );
  assert.ok(result);
  assert.deepEqual(
    lines.filter((line) => line.startsWith('key roles:')),
    [],
  );
});

test("key roles: the start check ALERTs on Arc's facilitator: shared with Base, or not a key ref", async () => {
  const db = { query: async () => ({ rows: [] }) } as unknown as Database;
  const run = async (env: Record<string, string>) => {
    const lines: string[] = [];
    await checkKeyRolesAtStart({
      db,
      env,
      chainId: BASE_MAINNET,
      log: (line) => lines.push(line),
    });
    return lines;
  };
  assert.deepEqual(
    await run({ CITY_X402_FACILITATOR_KEY_REF: ref(1), CITY_ARC_FACILITATOR_KEY_REF: ref(1) }),
    [
      'key roles: ALERT CITY_ARC_FACILITATOR_KEY_REF names a key also configured for a role on Base',
    ],
  );
  assert.deepEqual(await run({ CITY_ARC_FACILITATOR_KEY_REF: 'garbage' }), [
    'key roles: ALERT CITY_ARC_FACILITATOR_KEY_REF is not a key ref',
  ]);
  assert.deepEqual(await run({ CITY_X402_FACILITATOR_KEY_REF: ref(1) }), [], 'unset: nothing');
});

test('key roles: a key ref configured for two roles is shared; distinct refs are not', () => {
  const env = {
    CITY_X402_FACILITATOR_KEY_REF: ref(1),
    CITY_X402_PUBLIC_SETTLE_KEY_REF: ref(2),
    CITY_SFP_SPONSOR_KEY_REF: ref(3),
    CITY_BASE_PAYMASTER_SIGNER_KEY_REF: ref(4),
    CITY_BASE_SUBMITTER_KEY_REFS: `${ref(5)}, ${ref(6)}`,
  };
  for (const role of [
    'router3_facilitator',
    'public_settle',
    'sfp_sponsor',
    'paymaster_signer',
    'paymaster_submitter',
  ] as const)
    assert.equal(keyRefSharedWithOtherRole(env, role), false, role);
  const shared = { ...env, CITY_X402_PUBLIC_SETTLE_KEY_REF: ref(6) };
  assert.equal(keyRefSharedWithOtherRole(shared, 'public_settle'), true);
  assert.equal(keyRefSharedWithOtherRole(shared, 'paymaster_submitter'), true);
  assert.equal(keyRefSharedWithOtherRole(shared, 'sfp_sponsor'), false);
  assert.equal(keyRefSharedWithOtherRole({}, 'public_settle'), false, 'unset is not shared');
});

test('key roles: accounts shared by two roles are conflicts, case-insensitively, once per pair', () => {
  const upper = `0x${'A'.repeat(40)}`;
  assert.deepEqual(
    keyRoleConflicts([
      { role: 'sfp_sponsor', address: upper },
      { role: 'router3_facilitator', address: upper.toLowerCase() },
      { role: 'treasury', address: addr(7) },
      { role: 'funding', address: addr(8) },
      { role: 'paymaster_submitter', address: addr(9) },
      { role: 'paymaster_submitter', address: addr(9) },
    ]),
    [{ roles: ['router3_facilitator', 'sfp_sponsor'], address: upper.toLowerCase() }],
  );
});

test('key roles: the start check logs ALERT for shared accounts, public addresses only', async () => {
  const treasury = '0xAF36084a4dc0CE760A6dCfa46Cf129e140c92aa9';
  const signers: Record<string, string> = {
    '00000001-0000-0000-0000-000000000000': addr(1),
    '00000002-0000-0000-0000-000000000000': addr(1), // public settle on the facilitator's account
    '00000003-0000-0000-0000-000000000000': addr(3),
  };
  const db = {
    query: async (sql: string, params?: unknown[]) => {
      if (sql.includes('base_spender_keys'))
        return {
          rows: (params![0] as string[]).map((id) => ({ key_id: id, signer_address: signers[id] })),
        };
      if (sql.includes('own_paymaster_keys'))
        return { rows: [{ purpose: 'paymaster_submitter_1', address: addr(3) }] };
      return { rows: [] };
    },
  } as unknown as Database;
  const lines: string[] = [];
  const env = {
    CITY_X402_FACILITATOR_KEY_REF: ref(1),
    CITY_X402_PUBLIC_SETTLE_KEY_REF: ref(2),
    CITY_SFP_SPONSOR_KEY_REF: ref(3),
    CITY_FUNDING_WALLET_ADDRESS: treasury,
  };
  const result = await checkKeyRolesAtStart({
    db,
    env,
    chainId: BASE_MAINNET,
    log: (line) => lines.push(line),
  });
  assert.deepEqual(
    result.conflicts.map((c) => c.roles),
    [
      ['public_settle', 'router3_facilitator'],
      ['paymaster_submitter', 'sfp_sponsor'],
      ['funding', 'treasury'],
    ],
  );
  assert.equal(lines.length, 3);
  for (const line of lines) {
    assert.match(line, /^key roles: ALERT /);
    assert.ok(!line.includes('00000001-'), 'never a key ref');
  }
  // Distinct accounts: quiet.
  const quiet: string[] = [];
  await checkKeyRolesAtStart({
    db: { query: async () => ({ rows: [] }) } as unknown as Database,
    env: { CITY_FUNDING_WALLET_ADDRESS: addr(8) },
    chainId: BASE_MAINNET,
    log: (line) => quiet.push(line),
  });
  assert.deepEqual(quiet, []);
  // A broken database never throws from the check.
  const broken: string[] = [];
  await checkKeyRolesAtStart({
    db: {
      query: async () => {
        throw new Error('down');
      },
    } as unknown as Database,
    env: { CITY_SFP_SPONSOR_KEY_REF: ref(3) },
    chainId: BASE_SEPOLIA,
    log: (line) => broken.push(line),
  });
  assert.deepEqual(broken, ['key roles: ALERT the role check could not run']);
});

/** Captures console.error lines while `run` runs. */
const consoleLines = <T>(run: () => T): { result: T; lines: string[] } => {
  const original = console.error;
  const lines: string[] = [];
  console.error = (...args: unknown[]) => void lines.push(args.map(String).join(' '));
  try {
    return { result: run(), lines };
  } finally {
    console.error = original;
  }
};

test("key roles: enforcement off (default), the public sender on another lane's key ref ALERTs once and is still refused", () => {
  const env = {
    CITY_BASE_MAINNET: '1',
    CITY_BASE_CDP_RPC_URL: 'https://rpc.example.test/base',
    CITY_BASE_SPENDER_KEK: `v1:${randomBytes(32).toString('base64')}`,
    CITY_BASE_MAX_FEE_PER_GAS_WEI: '1000000000',
    CITY_BASE_IDENTITY_FEE_CAP_WEI: '50000000000000',
    CITY_BASE_WALLET_FEE_CAP_WEI: '20000000000000',
    CITY_X402_FACILITATOR_KEY_REF: ref(1),
    CITY_X402_PUBLIC_SETTLE_KEY_REF: ref(1),
  };
  const db = { query: async () => ({ rows: [] }) } as unknown as Database;
  const { result, lines } = consoleLines(() => {
    const runtime = createChainRuntime({ db, env, chainId: BASE_MAINNET });
    // Asked twice: one instance, one line.
    return [runtime.publicSettleFacilitator?.(), runtime.publicSettleFacilitator?.()];
  });
  // The runtime's own refusal of another lane's ref applies whatever the setting (CCA-704).
  assert.deepEqual(result, [null, null]);
  const roles = lines.filter((line) => line.startsWith('key roles:'));
  assert.deepEqual(roles, [
    'key roles: ALERT CITY_X402_PUBLIC_SETTLE_KEY_REF names a key also configured for another role; public_settle built anyway (CITY_KEY_ROLES_ENFORCE is off)',
  ]);
  for (const line of lines) assert.ok(!line.includes('00000001-'), 'never a key ref');
});

test('key roles: the runtime does not build the public settle sender on a shared key ref', () => {
  const env = {
    CITY_KEY_ROLES_ENFORCE: '1',
    CITY_BASE_MAINNET: '1',
    CITY_BASE_CDP_RPC_URL: 'https://rpc.example.test/base',
    CITY_BASE_SPENDER_KEK: `v1:${randomBytes(32).toString('base64')}`,
    CITY_BASE_MAX_FEE_PER_GAS_WEI: '1000000000',
    CITY_BASE_IDENTITY_FEE_CAP_WEI: '50000000000000',
    CITY_BASE_WALLET_FEE_CAP_WEI: '20000000000000',
    CITY_X402_FACILITATOR_KEY_REF: ref(1),
    CITY_X402_PUBLIC_SETTLE_KEY_REF: ref(2),
  };
  const db = { query: async () => ({ rows: [] }) } as unknown as Database;
  const own = createChainRuntime({ db, env, chainId: BASE_MAINNET });
  assert.ok(own.publicSettleFacilitator?.(), 'its own key: built');
  const { result, lines } = consoleLines(() =>
    createChainRuntime({
      db,
      env: { ...env, CITY_X402_PUBLIC_SETTLE_KEY_REF: ref(1) },
      chainId: BASE_MAINNET,
    }).publicSettleFacilitator?.(),
  );
  assert.equal(result, null, "with CITY_KEY_ROLES_ENFORCE=1, the facilitator's key: refused");
  assert.deepEqual(
    lines.filter((line) => line.startsWith('key roles:')),
    [
      'key roles: ALERT CITY_X402_PUBLIC_SETTLE_KEY_REF names a key also configured for another role; public_settle is not built (CITY_KEY_ROLES_ENFORCE=1)',
    ],
  );
});

test('key roles: with no logLine and no Fastify logger (production), the start ALERT reaches the console once', async () => {
  // The funding wallet set to the protocol treasury fixed in code for Base mainnet: two roles, one
  // account. No key refs and no database rows needed.
  const treasury = '0xAF36084a4dc0CE760A6dCfa46Cf129e140c92aa9';
  const saved = process.env.CITY_FUNDING_WALLET_ADDRESS;
  process.env.CITY_FUNDING_WALLET_ADDRESS = treasury;
  const original = console.error;
  const lines: string[] = [];
  console.error = (...args: unknown[]) => void lines.push(args.map(String).join(' '));
  let app: Awaited<ReturnType<typeof createApp>> | undefined;
  try {
    app = await createApp({ dataDir: ':memory:', startWorkers: false });
  } finally {
    console.error = original;
    if (saved === undefined) delete process.env.CITY_FUNDING_WALLET_ADDRESS;
    else process.env.CITY_FUNDING_WALLET_ADDRESS = saved;
    await app?.close();
  }
  const roles = lines.filter((line) => line.startsWith('key roles:'));
  assert.deepEqual(roles, [
    `key roles: ALERT funding and treasury use the same account ${treasury.toLowerCase()}`,
  ]);
});
