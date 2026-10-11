import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runFleetSlice, type FleetStore, type FleetItem } from '../server/base/fleet/worker.js';

test('10001 synthetic items drain through bounded slices without duplicate submissions', async () => {
  const total = 10001;
  let cursor = 0;
  let active = 0;
  let peak = 0;
  const submitted = new Set<string>();
  const finished = new Set<string>();
  const store: FleetStore = {
    async claim() {
      if (cursor === total) return null;
      const ordinal = cursor++;
      const item: FleetItem = {
        jobId: 'test-job',
        workspaceId: 'test-workspace',
        chainId: 31337,
        agentId: `test-agent-${ordinal}`,
        ordinal,
        intentHash: 'test-intent',
        registrationMode: 'lazy',
        stage: 'wallet',
        operationKey: `test-operation-${ordinal}`,
        attempted: false,
      };
      return { item, fence: '1' };
    },
    async begin() {
      return true;
    },
    async refuse() {
      throw new Error('Unexpected refusal');
    },
    async settle(claim, outcome) {
      assert.equal(outcome, 'final');
      assert.equal(finished.has(claim.item.operationKey), false);
      finished.add(claim.item.operationKey);
    },
  };
  let slices = 0;
  while (finished.size < total) {
    const result = await runFleetSlice(
      'test-job',
      {
        store,
        authority: { async authorize() {} },
        adapter: {
          async reconcile() {
            return 'absent';
          },
          async submit(item) {
            active++;
            peak = Math.max(peak, active);
            assert.equal(submitted.has(item.operationKey), false);
            submitted.add(item.operationKey);
            await Promise.resolve();
            active--;
            return 'final';
          },
        },
      },
      200,
    );
    assert.ok(result.claimed > 0 && result.claimed <= 200);
    assert.equal(result.final, result.claimed);
    slices++;
  }
  assert.equal(slices, 51);
  assert.equal(submitted.size, total);
  assert.equal(peak, 1);
});
