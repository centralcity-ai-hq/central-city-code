import assert from 'node:assert/strict';
import test from 'node:test';
import type { ServiceCall } from '../shared/explorer-calls';
import {
  hourlyEarnings,
  starCounts,
  summarizeCalls,
  toMicro,
  usdcText,
} from '../src/explorer/agentModel';
import type { ReputationEntry } from '../src/verify/onBaseData';

const ME = '0x524c827cd1D5691817706763FB67574d107578B1';
const HOUR = 3_600_000;

const call = (over: Partial<ServiceCall>): ServiceCall => ({
  tx_hash: `0x${'1'.repeat(64)}`,
  block: 1,
  time: 0,
  payer: '0x0000000000000000000000000000000000000001',
  provider: ME.toLowerCase(),
  service: 'Address checksum premium',
  amount: '2',
  provider_amount: '1.8',
  fee: null,
  status: 'settled',
  ref: '0x00',
  ...over,
});

test('amounts are exact micro-USDC and print with two decimals at least', () => {
  assert.equal(toMicro('1.8'), 1_800_000n);
  assert.equal(toMicro('0.072'), 72_000n);
  assert.equal(toMicro('20'), 20_000_000n);
  assert.equal(toMicro('-1'), null);
  assert.equal(toMicro('1.1234567'), null, 'more than 6 decimals is not a USDC amount');
  assert.equal(usdcText(18_000_000n), '18.00');
  assert.equal(usdcText(72_000n), '0.072');
  assert.equal(usdcText(1_234_500_000n), '1,234.50');
});

test('a summary counts only what this wallet sold as earned, case-insensitively', () => {
  const calls = [
    call({ time: 3 * HOUR, payer: '0xAA00000000000000000000000000000000000001' }),
    call({ time: 2 * HOUR, payer: '0xaa00000000000000000000000000000000000001' }),
    call({
      time: 1 * HOUR,
      service: 'RFC 8032 full text',
      amount: '0.05',
      provider_amount: '0.045',
    }),
    call({ time: 4 * HOUR, payer: ME, provider: '0x00000000000000000000000000000000000000bb' }),
  ];
  const s = summarizeCalls(calls, ME);
  assert.equal(s.sold, 3);
  assert.equal(s.bought, 1);
  assert.equal(s.earnedMicro, 3_645_000n);
  assert.equal(s.buyers, 2, 'the same buyer in two cases is one buyer');
  assert.deepEqual(
    s.services.map((x) => [x.title, x.calls, x.price]),
    [
      ['Address checksum premium', 2, '2'],
      ['RFC 8032 full text', 1, '0.05'],
    ],
  );
  assert.equal(s.since, 1 * HOUR, 'the window starts at the oldest call read');
  assert.equal(summarizeCalls([], ME).since, null);
});

test('hourly earnings never reach back before the oldest call read', () => {
  const now = 10 * HOUR + 5;
  const calls = [call({ time: 8 * HOUR + 10 }), call({ time: 10 * HOUR + 1 })];
  const bars = hourlyEarnings(calls, ME, now);
  assert.equal(bars.length, 3, 'hours 8, 9 and 10 only');
  assert.deepEqual(
    bars.map((b) => b.micro),
    [1_800_000n, 0n, 1_800_000n],
  );
  assert.equal(hourlyEarnings([], ME, now).length, 0);
  const old = hourlyEarnings([call({ time: 0 })], ME, 100 * HOUR);
  assert.equal(old.length, 24, 'at most 24 hours');
});

test('stars use the score rule: latest valid rating of each counted wallet, never the agent itself', () => {
  const entry = (
    client: string,
    index: number,
    score: string,
    tag = 'starred',
  ): ReputationEntry => ({
    client,
    index,
    from: { name: 'R', baseId: '1' },
    score,
    tags: [tag],
  });
  const counts = starCounts(
    [
      entry('0xA', 2, '100'),
      entry('0xa', 1, '20'),
      entry('0xB', 1, '80'),
      entry('0xC', 1, '60'),
      entry('0xD', 1, '50'),
      entry('0xE', 1, '100', 'other'),
      entry(ME, 1, '100'),
    ],
    ['0xa', '0xb', '0xd', '0xe', ME],
    ME,
  );
  assert.deepEqual(
    counts,
    [1, 1, 0, 0, 0],
    'latest of 0xA is 5 stars, 0xB 4; 0xC is not counted, 50 is no star step, a wrong tag and the agent itself are out',
  );
});
