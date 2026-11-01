/*
 * Audit CCA-709: fleet spend permissions are held to about twice the planned spend and must end.
 * An oversized or endless permission is refused before anything is signed, unless an explicit
 * exception is passed, which is logged as ALERT. Fake addresses and keys only; no chain.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { Hex } from 'viem';
import { BASE_SEPOLIA, NATIVE_ETH, baseNetwork, type Address } from '../shared/base/chains.js';
import { BatchChainError, createBatchChain } from '../server/base/chain/fleet-batch-chain.js';
import {
  FLEET_PERMISSION_MAX_LIFETIME_S,
  FleetPermissionRefused,
  checkFleetPermission,
  fleetPermissionPolicyFromEnv,
  fleetPermissionTerms,
} from '../server/base/fleet/permission-policy.js';

const USDC = 1_000_000n;
const NO_END = 2 ** 48 - 1;
const now = 1_790_000_000;
const treasury = '0x1111111111111111111111111111111111111111' as Address;
const spender = '0x2222222222222222222222222222222222222222' as Address;
const agent = '0x3333333333333333333333333333333333333333' as Address;

const permission = (
  overrides: Partial<{ allowance: bigint; start: number; end: number }> = {},
) => ({
  account: treasury,
  spender,
  token: NATIVE_ETH,
  allowance: 2n * USDC,
  period: 86_400,
  start: now - 60,
  end: now + 30 * 86_400,
  salt: 1n,
  extraData: '0x' as Hex,
  ...overrides,
});

const refusedWith = (code: string) => (e: unknown) =>
  e instanceof FleetPermissionRefused && e.code === code;

test('fleet permission: at most twice the planned spend, with an end date', () => {
  const policy = { plannedPerPeriod: 1n * USDC };
  assert.deepEqual(checkFleetPermission(permission(), policy, { now }), { exception: false });
  // The 100,000 USDC a day permissions of the audit, for a fleet that plans 1 USDC a day.
  assert.throws(
    () => checkFleetPermission(permission({ allowance: 100_000n * USDC }), policy, { now }),
    refusedWith('OVER_PLANNED_SPEND'),
  );
  assert.throws(
    () => checkFleetPermission(permission({ allowance: 2n * USDC + 1n }), policy, { now }),
    refusedWith('OVER_PLANNED_SPEND'),
  );
  assert.throws(
    () => checkFleetPermission(permission({ end: NO_END }), policy, { now }),
    refusedWith('NO_END'),
  );
  assert.throws(
    () =>
      checkFleetPermission(permission({ end: now + FLEET_PERMISSION_MAX_LIFETIME_S + 1 }), policy, {
        now,
      }),
    refusedWith('TOO_LONG'),
  );
  assert.throws(
    () => checkFleetPermission(permission(), { plannedPerPeriod: 0n }, { now }),
    refusedWith('NO_PLANNED_SPEND'),
  );
  assert.throws(
    () => checkFleetPermission(permission(), undefined as never, { now }),
    refusedWith('NO_PLANNED_SPEND'),
  );
});

test('fleet permission: an explicit exception lets it through and is logged as ALERT', () => {
  const lines: string[] = [];
  const result = checkFleetPermission(
    permission({ allowance: 100_000n * USDC, end: NO_END }),
    {
      plannedPerPeriod: 1n * USDC,
      exception: { approvedBy: 'treasury owner', reason: 'stress test window' },
    },
    { now, log: (line) => lines.push(line) },
  );
  assert.deepEqual(result, { exception: true });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /ALERT exception used \(OVER_PLANNED_SPEND, NO_END\)/);
  assert.match(lines[0], /"approvedBy":"treasury owner"/);
  assert.match(lines[0], /"allowance":"100000000000"/);
  // An exception without who or why is not an exception.
  assert.throws(
    () =>
      checkFleetPermission(
        permission({ end: NO_END }),
        { plannedPerPeriod: 1n * USDC, exception: { approvedBy: ' ', reason: 'x' } },
        { now },
      ),
    refusedWith('INVALID_EXCEPTION'),
  );
});

test('fleet permission: re-issue terms are twice the planned spend and end 90 days out by default', () => {
  const terms = fleetPermissionTerms({ plannedPerPeriod: 3n * USDC, period: 86_400, start: now });
  assert.deepEqual(terms, {
    allowance: 6n * USDC,
    period: 86_400,
    start: now,
    end: now + FLEET_PERMISSION_MAX_LIFETIME_S,
  });
  assert.deepEqual(
    checkFleetPermission({ ...permission(), ...terms }, { plannedPerPeriod: 3n * USDC }, { now }),
    { exception: false },
  );
  assert.throws(() =>
    fleetPermissionTerms({
      plannedPerPeriod: 1n,
      period: 86_400,
      start: now,
      lifetimeSeconds: 365 * 86_400 + 1,
    }),
  );
});

test('fleet permission: policy from the environment', () => {
  assert.equal(fleetPermissionPolicyFromEnv({}), null);
  assert.equal(fleetPermissionPolicyFromEnv({ CITY_FLEET_PLANNED_SPEND_PER_PERIOD: '0' }), null);
  assert.equal(fleetPermissionPolicyFromEnv({ CITY_FLEET_PLANNED_SPEND_PER_PERIOD: '1.5' }), null);
  assert.deepEqual(
    fleetPermissionPolicyFromEnv({
      CITY_FLEET_PLANNED_SPEND_PER_PERIOD: '1000000',
      CITY_FLEET_PERMISSION_MAX_DAYS: '30',
      CITY_FLEET_PERMISSION_EXCEPTION: 'ops lead: migration week',
    }),
    {
      plannedPerPeriod: 1_000_000n,
      maxLifetimeSeconds: 30 * 86_400,
      exception: { approvedBy: 'ops lead', reason: 'migration week' },
    },
  );
  assert.equal(
    fleetPermissionPolicyFromEnv({
      CITY_FLEET_PLANNED_SPEND_PER_PERIOD: '1000000',
      CITY_FLEET_PERMISSION_EXCEPTION: 'no reason given',
    })?.exception,
    null,
  );
});

test('fleet permission: lifetime is 90 days by default, configurable up to 365, 366 refused', () => {
  const DAY = 86_400;
  const planned = { CITY_FLEET_PLANNED_SPEND_PER_PERIOD: '1000000' };
  const at = (days: number, extra = 0) => permission({ start: now, end: now + days * DAY + extra });
  // Default 90 days: an end exactly at the limit is accepted, one second more is not.
  const byDefault = fleetPermissionPolicyFromEnv(planned)!;
  assert.equal(byDefault.maxLifetimeSeconds, 90 * DAY);
  assert.deepEqual(checkFleetPermission(at(90), byDefault, { now }), { exception: false });
  assert.throws(() => checkFleetPermission(at(90, 1), byDefault, { now }), refusedWith('TOO_LONG'));
  assert.deepEqual(checkFleetPermission(at(90), { plannedPerPeriod: USDC }, { now }), {
    exception: false,
  });
  // 365 configured: accepted, exactly at the limit too.
  const year = fleetPermissionPolicyFromEnv({ ...planned, CITY_FLEET_PERMISSION_MAX_DAYS: '365' })!;
  assert.equal(year.maxLifetimeSeconds, 365 * DAY);
  assert.deepEqual(checkFleetPermission(at(365), year, { now }), { exception: false });
  assert.throws(() => checkFleetPermission(at(365, 1), year, { now }), refusedWith('TOO_LONG'));
  // 366 (or 0, or not a whole number) configured: refused, so no policy and every batch refused.
  for (const days of ['366', '1000', '0', '30.5', '-1', 'ninety'])
    assert.equal(
      fleetPermissionPolicyFromEnv({ ...planned, CITY_FLEET_PERMISSION_MAX_DAYS: days }),
      null,
      days,
    );
  // A policy built in code above 365 days is refused too.
  assert.throws(
    () =>
      checkFleetPermission(
        at(30),
        { plannedPerPeriod: USDC, maxLifetimeSeconds: 366 * DAY },
        { now },
      ),
    refusedWith('TOO_LONG'),
  );
  // The lifetime is counted from now for a permission that started earlier.
  assert.deepEqual(
    checkFleetPermission(permission({ start: now - 10 * DAY, end: now + 90 * DAY }), byDefault, {
      now,
    }),
    { exception: false },
  );
  assert.equal(
    fleetPermissionTerms({
      plannedPerPeriod: 1n,
      period: DAY,
      start: now,
      lifetimeSeconds: 365 * DAY,
    }).end,
    now + 365 * DAY,
  );
  assert.throws(() =>
    fleetPermissionTerms({
      plannedPerPeriod: 1n,
      period: DAY,
      start: now,
      lifetimeSeconds: 366 * DAY,
    }),
  );
});

test('fleet permission: without a sink the exception ALERT still reaches the console', () => {
  const original = console.error;
  const lines: string[] = [];
  console.error = (line: unknown) => void lines.push(String(line));
  try {
    checkFleetPermission(
      permission({ end: NO_END }),
      { plannedPerPeriod: USDC, exception: { approvedBy: 'ops lead', reason: 'drill' } },
      { now },
    );
  } finally {
    console.error = original;
  }
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^fleet permission: ALERT exception used \(NO_END\) /);
});

test('fleet batch, enforcement off (default): a violation goes on as before with one ALERT', async () => {
  const network = baseNetwork(BASE_SEPOLIA)!;
  let signerReads = 0;
  const make = (deps: { enforcePermissionPolicy?: boolean; log?: (line: string) => void }) =>
    createBatchChain({
      network,
      client: {} as never,
      operations: { get: async () => null } as never,
      bundler: {} as never,
      keystore: {} as never,
      signerOf: async () => {
        signerReads++;
        throw new Error('validated: next step reached');
      },
      ...deps,
    });
  const t = Math.floor(Date.now() / 1000);
  const input = (overrides: object) => ({
    operationKey: 'fleet:job-2:0',
    intentHash: `0x${'bb'.repeat(32)}` as Hex,
    treasury: { wallet: treasury, spender, spenderKeyRef: 'v1:fake' },
    permission: permission({ start: t - 60, end: t + 86_400 }),
    permissionSignature: null,
    permissionPolicy: { plannedPerPeriod: 1n * USDC },
    token: NATIVE_ETH,
    transfers: [{ to: agent, amount: 1n * USDC }],
    ...overrides,
  });
  const cases: [string, object, string][] = [
    ['missing policy', { permissionPolicy: undefined }, 'NO_PLANNED_SPEND'],
    [
      'oversized permission',
      { permission: permission({ allowance: 100_000n * USDC, start: t - 60, end: t + 86_400 }) },
      'OVER_PLANNED_SPEND',
    ],
    ['endless permission', { permission: permission({ start: t - 60, end: NO_END }) }, 'NO_END'],
  ];
  for (const [name, overrides, code] of cases) {
    const lines: string[] = [];
    const batches = make({ enforcePermissionPolicy: false, log: (line) => lines.push(line) });
    await assert.rejects(
      batches.submitBatchTransfer(input(overrides)),
      /validated: next step reached/,
      `${name}: not refused`,
    );
    assert.equal(lines.length, 1, `${name}: exactly one line`);
    assert.match(
      lines[0],
      new RegExp(
        `^fleet permission: ALERT ${code} not enforced \\(CITY_FLEET_PERMISSION_ENFORCE is off\\), batch allowed \\{"account":`,
      ),
    );
    assert.ok(!lines[0].includes('v1:fake'), `${name}: never a key ref`);
  }
  assert.equal(signerReads, 3);
  // Unset setting (no deps flag): off, and the line reaches the console without a sink.
  const saved = process.env.CITY_FLEET_PERMISSION_ENFORCE;
  delete process.env.CITY_FLEET_PERMISSION_ENFORCE;
  const original = console.error;
  const lines: string[] = [];
  console.error = (line: unknown) => void lines.push(String(line));
  try {
    await assert.rejects(
      make({}).submitBatchTransfer(input({ permissionPolicy: undefined })),
      /validated: next step reached/,
    );
    // The setting set to '1' refuses.
    process.env.CITY_FLEET_PERMISSION_ENFORCE = '1';
    await assert.rejects(
      make({}).submitBatchTransfer(input({ permissionPolicy: undefined })),
      (e: unknown) => e instanceof BatchChainError && e.code === 'PERMISSION_POLICY',
    );
  } finally {
    console.error = original;
    if (saved === undefined) delete process.env.CITY_FLEET_PERMISSION_ENFORCE;
    else process.env.CITY_FLEET_PERMISSION_ENFORCE = saved;
  }
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^fleet permission: ALERT NO_PLANNED_SPEND not enforced/);
});

test('fleet batch, enforcement on: an oversized or endless permission is refused before anything is signed', async () => {
  const network = baseNetwork(BASE_SEPOLIA)!;
  let signerReads = 0;
  const lines: string[] = [];
  const batches = createBatchChain({
    enforcePermissionPolicy: true,
    network,
    client: {} as never,
    operations: { get: async () => null } as never,
    bundler: {} as never,
    keystore: {} as never,
    signerOf: async () => {
      signerReads++;
      throw new Error('validated: next step reached');
    },
    log: (line) => lines.push(line),
  });
  const input = (overrides: object) => ({
    operationKey: 'fleet:job-1:0',
    intentHash: `0x${'aa'.repeat(32)}` as Hex,
    treasury: { wallet: treasury, spender, spenderKeyRef: 'v1:fake' },
    permission: permission({
      start: Math.floor(Date.now() / 1000) - 60,
      end: Math.floor(Date.now() / 1000) + 86_400,
    }),
    permissionSignature: null,
    permissionPolicy: { plannedPerPeriod: 1n * USDC },
    token: NATIVE_ETH,
    transfers: [{ to: agent, amount: 1n * USDC }],
    ...overrides,
  });
  const policyRefusal = (e: unknown) =>
    e instanceof BatchChainError && e.code === 'PERMISSION_POLICY';
  const t = Math.floor(Date.now() / 1000);
  await assert.rejects(
    batches.submitBatchTransfer(
      input({
        permission: permission({ allowance: 100_000n * USDC, start: t - 60, end: t + 86_400 }),
      }),
    ),
    policyRefusal,
  );
  await assert.rejects(
    batches.submitBatchTransfer(input({ permission: permission({ start: t - 60, end: NO_END }) })),
    policyRefusal,
  );
  await assert.rejects(
    batches.submitBatchTransfer(input({ permissionPolicy: undefined })),
    policyRefusal,
  );
  assert.equal(signerReads, 0, 'refused before the spender key is touched');
  // Within policy (or with a logged exception) the batch goes on to the signing step.
  await assert.rejects(batches.submitBatchTransfer(input({})), /validated: next step reached/);
  await assert.rejects(
    batches.submitBatchTransfer(
      input({
        permission: permission({ allowance: 100_000n * USDC, start: t - 60, end: NO_END }),
        permissionPolicy: {
          plannedPerPeriod: 1n * USDC,
          exception: { approvedBy: 'treasury owner', reason: 'drill' },
        },
      }),
    ),
    /validated: next step reached/,
  );
  assert.equal(signerReads, 2);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /ALERT exception used/);
});
