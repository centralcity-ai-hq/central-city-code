import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AddressInfo } from 'node:net';

// scripts/own-paymaster-canary-report.mjs against a JSON-RPC stub: the repayment counts as verified
// only in an isolated block (no other transaction, or full call traces showing none touches the
// beneficiary, sender or EntryPoint); an internal call or a node without traces leaves it unverified.

const run = promisify(execFile);
const EP = '0x5ff137d4b0fdcd49dca30c7cf57e578a026d2789';
const PM = '0x8bf5b18b733a864c17cd92615cd45d833fcfe105';
const SUB = '0xbbd1b99822d03a1c46f8b4c063dd1a66fcca1d47';
const H = `0x${'a'.repeat(64)}`;
const X = `0x${'b'.repeat(64)}`;
const SYS = `0x${'c'.repeat(64)}`;
const word = (v: bigint | string) =>
  (typeof v === 'bigint' ? v.toString(16) : v.slice(2)).padStart(64, '0');
const hex = (n: bigint) => `0x${n.toString(16)}`;

// One sponsored op: actualGasCost 1000; outer L2 16 x 1, L1 fee 5; the submitter is repaid 1000.
const receipt = {
  status: '0x1',
  blockNumber: '0x64',
  gasUsed: '0x10',
  effectiveGasPrice: '0x1',
  l1Fee: '0x5',
  logs: [
    {
      address: EP,
      topics: [
        '0x49628fd1471006c1482da88028e9ce4dbb080b815c9b0344d39e5a8e6ec1419f',
        `0x${'1'.repeat(64)}`,
        `0x${word(`0x${'2'.repeat(40)}`)}`,
        `0x${word(PM)}`,
      ],
      data: `0x${word(0n)}${word(1n)}${word(1000n)}${word(900n)}`,
    },
  ],
};
const ours = {
  hash: H,
  from: SUB,
  to: EP,
  type: '0x2',
  input: `0x1fad948c${word(64n)}${word(SUB)}`,
};
const system = {
  hash: SYS,
  type: '0x7e',
  from: '0xdeaddeaddeaddeaddeaddeaddeaddeaddead0001',
  to: '0x4200000000000000000000000000000000000015',
};
const other = { hash: X, type: '0x2', from: `0x${'3'.repeat(40)}`, to: `0x${'4'.repeat(40)}` };
const balances: Record<string, [bigint, bigint]> = {
  [EP]: [5000n, 4000n], // paid out exactly actualGasCost
  [SUB]: [10_000n, 10_979n], // +1000 repaid - 21 fees
};

async function report(block: unknown[], trace: unknown | 'unsupported') {
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const { id, method, params } = JSON.parse(raw);
      const ok = (result: unknown) => res.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
      if (method === 'eth_getTransactionReceipt') return ok(receipt);
      if (method === 'eth_getTransactionByHash') return ok(ours);
      if (method === 'eth_getBlockByNumber') return ok({ transactions: block });
      if (method === 'eth_getBalance') {
        const [who, at] = params as [string, string];
        const pair = balances[who.toLowerCase()] ?? [0n, 0n];
        return ok(hex(at === '0x63' ? pair[0] : at === '0x64' ? pair[1] : pair[1]));
      }
      if (method === 'eth_call') return ok(`0x${word(4000n)}`);
      if (method === 'debug_traceTransaction') {
        if (trace === 'unsupported')
          return res.end(
            JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message: 'no' } }),
          );
        return ok(trace);
      }
      res.end(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message: method } }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  try {
    const { port } = server.address() as AddressInfo;
    const { stdout } = await run(process.execPath, ['scripts/own-paymaster-canary-report.mjs', H], {
      env: { ...process.env, BASE_RPC: `http://127.0.0.1:${port}` },
    });
    return stdout.split('\n').find((line) => line.startsWith(H))!;
  } finally {
    server.close();
  }
}

test('a block holding only the system transaction besides ours is isolated: repayment verified', async () => {
  const line = await report([system, ours], 'unsupported');
  assert.match(line, /1000 \(verified\)/);
  assert.doesNotMatch(line, /NO_TRACE|UNVERIFI/);
});

test('other transactions with full traces that never touch ours: verified', async () => {
  const trace = {
    type: 'CALL',
    from: other.from,
    to: other.to,
    calls: [{ type: 'CALL', from: other.to, to: `0x${'5'.repeat(40)}` }],
  };
  assert.match(await report([system, ours, other], trace), /1000 \(verified\)/);
});

test('an INTERNAL call to the EntryPoint in another transaction: never verified, never subtracted', async () => {
  // Top-level from/to of that transaction never names the EntryPoint; only its trace does.
  const trace = {
    type: 'CALL',
    from: other.from,
    to: other.to,
    calls: [{ type: 'CALL', from: other.to, to: EP, value: '0x1' }],
  };
  const line = await report([system, ours, other], trace);
  assert.match(line, /REPAYMENT_UNVERIFIABLE/);
  assert.match(line, /UNVERIFIED, not subtracted/);
  assert.match(line, /\| 21$/); // overhead = L2 + L1, no repayment subtracted
});

test('other transactions and a node without traces: unverified, never subtracted', async () => {
  const line = await report([system, ours, other], 'unsupported');
  assert.match(line, /NO_TRACE/);
  assert.match(line, /UNVERIFIED, not subtracted/);
  assert.match(line, /\| 21$/);
});

test('a missing or malformed trace never proves isolation: unverified, never subtracted', async () => {
  const sound = { type: 'CALL', from: other.from, to: other.to };
  const cases: [string, unknown][] = [
    ['empty object', {}],
    ['null', null],
    ['root from another sender', { ...sound, from: `0x${'6'.repeat(40)}` }],
    ['root to another target', { ...sound, to: `0x${'7'.repeat(40)}` }],
    ['root not a CALL', { ...sound, type: 'STATICCALL' }],
    ['nested frame without type', { ...sound, calls: [{ from: other.to, to: EP }] }],
    ['nested frame without to', { ...sound, calls: [{ type: 'CALL', from: other.to }] }],
    ['calls not an array', { ...sound, calls: { to: EP } }],
    [
      'unknown frame type',
      { ...sound, calls: [{ type: 'TELEPORT', from: other.to, to: other.from }] },
    ],
  ];
  for (const [name, trace] of cases) {
    const line = await report([system, ours, other], trace);
    assert.match(line, /MALFORMED_TRACE/, name);
    assert.match(line, /UNVERIFIED, not subtracted/, name);
    assert.match(line, /\| 21$/, name);
  }
});
