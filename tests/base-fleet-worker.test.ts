import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runFleetSlice, type FleetItem, type FleetOutcome } from '../server/base/fleet/worker.js';

function fixture(overrides: Partial<FleetItem> = {}) {
  const item: FleetItem = {
    jobId: 'test-job',
    workspaceId: 'test-workspace',
    chainId: 31337,
    agentId: 'test-agent',
    ordinal: 0,
    intentHash: 'test-intent',
    registrationMode: 'lazy',
    stage: 'wallet',
    operationKey: 'test-operation',
    attempted: false,
    ...overrides,
  };
  let claimed = false;
  let submissions = 0;
  let current = true;
  let saved: string | undefined;
  let prior: FleetOutcome = 'absent';
  let crash = false;
  let failSave = false;
  let deny = false;
  let refused = false;
  const ports = {
    store: {
      async claim() {
        if (claimed) return null;
        claimed = true;
        return { item: { ...item }, fence: 'test-fence' };
      },
      async begin() {
        if (!current || item.attempted) return false;
        item.attempted = true;
        return true;
      },
      async refuse() {
        if (!current) return false;
        refused = true;
        return true;
      },
      async settle(_claim: unknown, outcome: string) {
        if (failSave) throw new Error('test-storage');
        saved = outcome;
      },
    },
    authority: {
      async authorize() {
        if (deny) throw new Error('test-denied');
      },
    },
    adapter: {
      async reconcile() {
        return prior;
      },
      async submit(): Promise<'final'> {
        submissions++;
        if (crash) throw new Error('test-provider');
        return 'final';
      },
    },
  };
  return {
    item,
    ports,
    get refused() {
      return refused;
    },
    get submissions() {
      return submissions;
    },
    get saved() {
      return saved;
    },
    reset() {
      claimed = false;
    },
    prior(v: FleetOutcome) {
      prior = v;
    },
    stale() {
      current = false;
    },
    crash() {
      crash = true;
    },
    failSave(v: boolean) {
      failSave = v;
    },
    deny() {
      deny = true;
    },
  };
}

test('wallet provisioning completes through the injected adapter', async () => {
  const f = fixture();
  assert.deepEqual(await runFleetSlice('test-job', f.ports), {
    claimed: 1,
    final: 1,
    failed: 0,
    deferred: 0,
    refused: 0,
  });
  assert.equal(f.submissions, 1);
  assert.equal(f.item.attempted, true);
});

test('provider timeout is unknown and restart cannot submit again on absent lookup', async () => {
  const f = fixture();
  f.crash();
  await runFleetSlice('test-job', f.ports);
  assert.equal(f.saved, 'unknown');
  f.reset();
  await runFleetSlice('test-job', f.ports);
  assert.equal(f.submissions, 1);
});

test('crash after external success but before save reconciles without replay', async () => {
  const f = fixture();
  f.failSave(true);
  await assert.rejects(runFleetSlice('test-job', f.ports), /test-storage/);
  f.reset();
  f.failSave(false);
  f.prior('final');
  assert.equal((await runFleetSlice('test-job', f.ports)).final, 1);
  assert.equal(f.submissions, 1);
});

test('a stale lease or cancelled job cannot start submission', async () => {
  const f = fixture();
  f.stale();
  assert.equal((await runFleetSlice('test-job', f.ports)).refused, 1);
  assert.equal(f.submissions, 0);
});

test('revoked authority prevents adapter work', async () => {
  const f = fixture();
  f.deny();
  f.ports.adapter.reconcile = async () => {
    assert.fail('adapter must not be called');
  };
  assert.equal((await runFleetSlice('test-job', f.ports)).refused, 1);
  assert.equal(f.submissions, 0);
});

test('already submitted operations reconcile even when new submissions are stopped', async () => {
  const f = fixture({ attempted: true });
  f.stale();
  f.prior('final');
  assert.equal((await runFleetSlice('test-job', f.ports)).final, 1);
  assert.equal(f.submissions, 0);
});

test('pending results never count as complete', async () => {
  const f = fixture({ attempted: true });
  f.prior('pending');
  assert.equal((await runFleetSlice('test-job', f.ports)).deferred, 1);
  assert.equal(f.submissions, 0);
});

test('rejects mainnet even if another application flag enables it', async () => {
  const f = fixture({ chainId: 8453 });
  await assert.rejects(runFleetSlice('test-job', f.ports), /Invalid fleet claim/);
  assert.equal(f.submissions, 0);
});

test('rejects wrong job and lazy registration claims', async () => {
  for (const patch of [{ jobId: 'different-job' }, { stage: 'registration' as const }]) {
    const f = fixture(patch);
    await assert.rejects(runFleetSlice('test-job', f.ports), /Invalid fleet claim/);
    assert.equal(f.submissions, 0);
  }
});

test('slice limits are bounded and validated', async () => {
  for (const limit of [0, 201, NaN, 1.5]) {
    await assert.rejects(runFleetSlice('test-job', fixture().ports, limit), /Invalid fleet slice/);
  }
  const f = fixture();
  f.ports.store.claim = async () => ({ item: { ...f.item }, fence: 'test-fence' });
  assert.equal((await runFleetSlice('test-job', f.ports, 200)).claimed, 1);
  assert.equal(f.submissions, 1);
});

test('authority is rechecked after lookup and before a new submission', async () => {
  const f = fixture();
  let checks = 0;
  f.ports.authority.authorize = async () => {
    if (++checks === 2) throw new Error('test-revoked');
  };
  const result = await runFleetSlice('test-job', f.ports);
  assert.equal(result.refused, 1);
  assert.equal(f.item.attempted, false);
  assert.equal(f.submissions, 0);
});

test('failed lookup never permits a submission', async () => {
  const f = fixture();
  f.ports.adapter.reconcile = async () => {
    throw new Error('test-unavailable');
  };
  assert.equal((await runFleetSlice('test-job', f.ports)).deferred, 1);
  assert.equal(f.saved, 'unknown');
  assert.equal(f.submissions, 0);
});

test('invalid adapter outcomes fail closed', async () => {
  const f = fixture();
  f.prior('unexpected' as FleetOutcome);
  await runFleetSlice('test-job', f.ports);
  assert.equal(f.saved, 'unknown');
  assert.equal(f.submissions, 0);
});

test('an adapter cannot mutate the approved item during reconciliation', async () => {
  const f = fixture();
  f.ports.authority.authorize = async (...args: unknown[]) => {
    assert.equal(Object.isFrozen(args[0]), true);
  };
  await runFleetSlice('test-job', f.ports);
  assert.equal(f.submissions, 1);
});

test('immediate registration runs only its persisted stage', async () => {
  const f = fixture({ registrationMode: 'immediate', stage: 'registration' });
  assert.equal((await runFleetSlice('test-job', f.ports)).final, 1);
  assert.equal(f.submissions, 1);
});

test('a finalized failed operation is settled without success or replay', async () => {
  const f = fixture({ attempted: true, registrationMode: 'immediate' });
  f.prior('failed');
  const result = await runFleetSlice('test-job', f.ports);
  assert.equal(result.failed, 1);
  assert.equal(result.final, 0);
  assert.equal(result.deferred, 0);
  assert.equal(f.saved, 'failed');
  assert.equal(f.submissions, 0);
});

test('failure discovered during submission is terminal, not deferred', async () => {
  const f = fixture();
  const ports = {
    ...f.ports,
    adapter: {
      ...f.ports.adapter,
      async submit(): Promise<'failed'> {
        return 'failed';
      },
    },
  };
  const result = await runFleetSlice('test-job', ports);
  assert.equal(result.failed, 1);
  assert.equal(result.final, 0);
  assert.equal(f.saved, 'failed');
});

test('workflow refusal is persisted without changing attempted operation state', async () => {
  const f = fixture({ attempted: true });
  f.deny();
  await runFleetSlice('test-job', f.ports);
  assert.equal(f.refused, true);
  assert.equal(f.item.attempted, true);
  assert.equal(f.saved, undefined);
  assert.equal(f.submissions, 0);
});

test('a stale claimant cannot persist refusal over a winner', async () => {
  const f = fixture();
  f.stale();
  await runFleetSlice('test-job', f.ports);
  assert.equal(f.refused, false);
  assert.equal(f.saved, undefined);
  assert.equal(f.submissions, 0);
});
