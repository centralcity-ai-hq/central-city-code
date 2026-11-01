import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { resetBloomTries, resetLearnedLogRange, scanFees } from '../server/protocol/fees/ledger.js';
import { countingChain, feeAt, feeConfig, feeDb, ROUTER } from './helpers/fee-scan-fake.js';

// Base's fee scan, request by request: a fixed story through refusals, a rate limit and two runs.
// The digest below was taken on the code from before the gentle scan existed and must never move
// on its own: Base's public node budget and its CCA-107 proofs depend on these exact reads.
const EXPECTED = '4a00450a17b81d373eb3c1b8d530568d0ab6f259331d912c518909bfd43c4767';

test('Base: the scan asks for exactly the same requests as before', async (t) => {
  resetLearnedLogRange();
  resetBloomTries();
  const { db } = await feeDb(t);
  const config = { ...feeConfig(8453), startBlock: 1000n };
  const state = {
    logs: [...feeAt(1100n), ...feeAt(2600n)],
    latest: 3200n,
    finalized: 3100n,
    refuse: undefined as undefined | ((request: string) => unknown),
  };
  const { chain, requests } = countingChain(state);
  const scan = () => scanFees(db, chain, config, { maxBlocks: 5_000n, log: () => undefined });

  await scan();
  // A rate limit on the router, wider than the smallest range: Base splits as it always did.
  let limited = 3;
  state.logs.push(...feeAt(3300n));
  state.latest = 3500n;
  state.finalized = 3400n;
  state.refuse = (request) =>
    request.startsWith(`logs ${ROUTER}`) && limited-- > 0
      ? Object.assign(new Error('Request exceeds defined limit.'), { code: -32005 })
      : undefined;
  await scan();
  state.refuse = undefined;
  state.latest = 4600n;
  state.finalized = 4600n;
  await scan();
  await scan();

  const digest = createHash('sha256').update(requests.join('\n')).digest('hex');
  assert.equal(digest, EXPECTED, `${requests.length} requests`);
  // And the shape, read plainly: every block promoted had its header read.
  assert.ok(requests.filter((r) => r.startsWith('header ')).length > 1000);
  resetLearnedLogRange();
});
