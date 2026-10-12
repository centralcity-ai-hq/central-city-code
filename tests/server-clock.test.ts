import assert from 'node:assert/strict';
import test from 'node:test';
import { offsetFrom } from '../src/shell/serverClock.js';

const header = (ms: number) => new Date(ms).toUTCString();

test('the offset is the server second against the request midpoint', () => {
  const t = Date.UTC(2026, 9, 12, 6, 0, 0);
  // Server 90 s behind a fast device; 200 ms round trip.
  assert.equal(offsetFrom(header(t - 90_000), t - 100, t + 100), -90_000 + 500);
  // Server ahead of a slow device by 30 s.
  assert.equal(offsetFrom(header(t + 30_000), t, t), 30_500);
});

test('unusable headers are ignored', () => {
  const t = Date.UTC(2026, 9, 12, 6, 0, 0);
  for (const value of [undefined, null, '', 'not a date'])
    assert.equal(offsetFrom(value as string | null | undefined, t, t), null);
  assert.equal(offsetFrom(header(t), t, t - 1), null, 'answer before the request');
  assert.equal(offsetFrom(header(t + 7 * 3600 * 1000), t, t), null, 'implausibly far off');
});
