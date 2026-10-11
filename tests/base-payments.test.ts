import assert from 'node:assert/strict';
import test from 'node:test';
import { BASE_MAINNET, BASE_NETWORKS, BASE_SEPOLIA } from '../shared/base/chains.js';
import type { ChainOpReceipt } from '../shared/base/types.js';
import {
  createPaymentService,
  intentFor,
  PaymentError,
  type TransferInput,
  type TransferIntent,
  type TransferRecord,
  type PaymentStore,
} from '../server/base/payments/service.js';

const actor = { workspaceId: 'test-workspace', actorId: 'test-actor' };
const input: TransferInput = {
  chainId: BASE_SEPOLIA,
  source: { agentId: 'test-agent' },
  to: '0x1111111111111111111111111111111111111111',
  token: BASE_NETWORKS[BASE_SEPOLIA].tokens.USDC.address,
  amount: 5n,
  idempotencyKey: 'test-transfer',
};

function fixture() {
  const rows = new Map<string, TransferRecord>();
  const operations = new Map<string, ChainOpReceipt>();
  let broadcasts = 0;
  let submissions = 0;
  let authorized = true;
  let timeout = false;
  let unavailable = false;
  let authorizationCalls = 0;
  let denyOnCall = Infinity;
  let failObservation = false;
  const store: PaymentStore = {
    async reserve(intent) {
      const previous = rows.get(intent.operationKey);
      if (previous) {
        if (previous.intent.intentHash !== intent.intentHash)
          throw new PaymentError('IDEMPOTENCY_CONFLICT');
        return structuredClone(previous);
      }
      const row: TransferRecord = { intent, state: 'created', receipt: null };
      rows.set(intent.operationKey, row);
      return structuredClone(row);
    },
    async begin(intent) {
      const row = rows.get(intent.operationKey)!;
      const acquired = row.state === 'created';
      if (acquired) row.state = 'settling';
      return { acquired, record: structuredClone(row) };
    },
    async observe(intent, receipt) {
      if (failObservation) throw new Error('storage unavailable');
      const row = rows.get(intent.operationKey)!;
      row.state = receipt?.status === 'final' ? 'paid' : 'reconciling';
      row.receipt = receipt;
      return structuredClone(row);
    },
  };
  const chain = {
    async status(intent: TransferIntent) {
      if (unavailable) throw new Error('RPC unavailable');
      return operations.get(intent.operationKey) ?? null;
    },
    async submit(intent: TransferIntent) {
      submissions++;
      let receipt = operations.get(intent.operationKey);
      if (!receipt) {
        broadcasts++;
        receipt = {
          opId: `test-op-${broadcasts}`,
          idempotencyKey: intent.operationKey,
          status: 'final' as const,
          userOpHash: null,
          txHash: null,
          blockNumber: 1n,
          gasUsed: 1n,
          feeWei: 1n,
          errorCode: null,
        };
        operations.set(intent.operationKey, receipt);
      }
      if (timeout) throw new Error('broadcast response lost');
      return receipt;
    },
  };
  const service = () =>
    createPaymentService({
      store,
      chain,
      authority: {
        async assertCanTransfer() {
          if (!authorized || ++authorizationCalls >= denyOnCall)
            throw new PaymentError('FORBIDDEN');
        },
      },
    });
  return {
    service,
    rows,
    operations,
    chain,
    broadcasts: () => broadcasts,
    submissions: () => submissions,
    revoke: () => {
      authorized = false;
    },
    revokeBeforeSubmit: () => {
      denyOnCall = 2;
    },
    loseResponse: () => {
      timeout = true;
    },
    unavailable: () => {
      unavailable = true;
    },
    available: () => {
      unavailable = false;
    },
    failObservation: (value: boolean) => {
      failObservation = value;
    },
  };
}

test('transfer retries survive service restart and reconcile a lost broadcast response', async () => {
  const f = fixture();
  f.loseResponse();
  assert.equal((await f.service().transfer(actor, input)).state, 'reconciling');
  assert.equal((await f.service().transfer(actor, input)).state, 'paid');
  assert.equal(f.broadcasts(), 1);
});

test('parallel duplicate requests share the adapter operation; conflicting intent is refused', async () => {
  const f = fixture();
  await Promise.all(Array.from({ length: 10 }, () => f.service().transfer(actor, input)));
  assert.equal(f.broadcasts(), 1);
  assert.equal(f.submissions(), 1);
  await assert.rejects(f.service().transfer(actor, { ...input, amount: 6n }), {
    code: 'IDEMPOTENCY_CONFLICT',
  });
});

test('permission revoked between reservation and submission prevents spending', async () => {
  const f = fixture();
  f.revokeBeforeSubmit();
  await assert.rejects(f.service().transfer(actor, input), { code: 'FORBIDDEN' });
  assert.equal(f.broadcasts(), 0);
});

test('retries do not bypass current authorization even for a previously paid intent', async () => {
  const f = fixture();
  await f.service().transfer(actor, input);
  f.revoke();
  await assert.rejects(f.service().transfer(actor, input), { code: 'FORBIDDEN' });
  assert.equal(f.broadcasts(), 1);
});

test('receipt persistence failure is recovered by lookup, not a new payment', async () => {
  const f = fixture();
  f.failObservation(true);
  await assert.rejects(f.service().transfer(actor, input), /storage unavailable/);
  f.failObservation(false);
  assert.equal((await f.service().transfer(actor, input)).state, 'paid');
  assert.equal(f.broadcasts(), 1);
});

test('missing or unavailable status after an attempt retains reconciliation without resubmit', async () => {
  const f = fixture();
  await f.service().transfer(actor, input);
  f.operations.clear();
  assert.equal((await f.service().transfer(actor, input)).state, 'reconciling');
  f.unavailable();
  assert.equal((await f.service().transfer(actor, input)).state, 'reconciling');
  assert.equal(f.broadcasts(), 1);
});

test('an outage before any attempt leaves the intent retryable when lookup recovers', async () => {
  const f = fixture();
  f.unavailable();
  assert.equal((await f.service().transfer(actor, input)).state, 'created');
  assert.equal(f.broadcasts(), 0);
  f.available();
  assert.equal((await f.service().transfer(actor, input)).state, 'paid');
  assert.equal(f.broadcasts(), 1);
});

test('reorg evidence revisits a paid transfer without submitting a replacement', async () => {
  const f = fixture();
  await f.service().transfer(actor, input);
  for (const receipt of f.operations.values()) receipt.status = 'reorged';
  assert.equal((await f.service().transfer(actor, input)).state, 'reconciling');
  assert.equal(f.broadcasts(), 1);
});

test('workspace and chain scope prevent cross-tenant idempotency collisions', async () => {
  const f = fixture();
  await f.service().transfer(actor, input);
  await f.service().transfer({ ...actor, workspaceId: 'test-workspace-two' }, input);
  await f.service().transfer(actor, { ...input, chainId: 31337 });
  assert.equal(f.broadcasts(), 3);
});

test('reject mainnet, unsupported tokens, invalid amounts and ambiguous sources before reserving', async () => {
  const f = fixture();
  for (const change of [
    { chainId: 8453 },
    { amount: 0n },
    { amount: -1n },
    { amount: 2n ** 256n },
    { token: input.to },
    { to: '0x0000000000000000000000000000000000000000' },
    { source: { agentId: 'test-agent', fleetJobId: 'test-job' } },
  ]) {
    await assert.rejects(
      f.service().transfer(actor, { ...input, ...change } as TransferInput),
      PaymentError,
    );
  }
  assert.equal(f.rows.size, 0);
  assert.equal(f.broadcasts(), 0);
});

test('fleet source is preserved for approved allocation validation by injected authority', async () => {
  const f = fixture();
  const row = await f.service().transfer(actor, { ...input, source: { fleetJobId: 'test-job' } });
  assert.deepEqual(row.intent.source, { fleetJobId: 'test-job' });
});

test('a receipt for another operation is refused', async () => {
  const f = fixture();
  const submit = f.chain.submit;
  f.chain.submit = async (intent) => ({
    ...(await submit(intent)),
    idempotencyKey: 'wrong-operation',
  });
  await assert.rejects(f.service().transfer(actor, input), { code: 'RECEIPT_MISMATCH' });
});

test('v1 intent hash is stable across caller property order and token casing', async () => {
  const f = fixture();
  const first = await f.service().transfer(actor, input);
  assert.equal(
    first.intent.intentHash,
    '0x35f6c3b19b945817ef2a4dc14f3b22318745db4e0cdb630d7fca7ab5b2d09bc0',
  );
  const reordered = await f.service().transfer(
    { actorId: actor.actorId, workspaceId: actor.workspaceId },
    {
      idempotencyKey: input.idempotencyKey,
      amount: input.amount,
      token: input.token.toLowerCase() as TransferInput['token'],
      to: input.to,
      source: input.source,
      chainId: input.chainId,
    },
  );
  assert.equal(reordered.intent.intentHash, first.intent.intentHash);
  assert.equal(f.submissions(), 1);
});

test('a Base intent exists only with the deployment’s own gate open; the test network needs none', () => {
  const mainnet = {
    ...input,
    chainId: BASE_MAINNET,
    token: BASE_NETWORKS[BASE_MAINNET].tokens.USDC.address,
  } as TransferInput;
  assert.throws(
    () => intentFor(actor, mainnet),
    (e: unknown) => e instanceof PaymentError && e.code === 'NETWORK_DISABLED',
  );
  assert.throws(
    () => intentFor(actor, mainnet, {}),
    (e: unknown) => e instanceof PaymentError && e.code === 'NETWORK_DISABLED',
  );
  const open = intentFor(actor, mainnet, { CITY_BASE_MAINNET: '1' });
  assert.equal(open.chainId, BASE_MAINNET);
  // The hash contract is unchanged: the same input on the test network hashes as before.
  assert.equal(intentFor(actor, input).intentHash, intentFor(actor, input, {}).intentHash);
});
