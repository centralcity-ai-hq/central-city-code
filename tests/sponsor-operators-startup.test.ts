import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/app.js';

// The app's start (server/app.ts): a malformed CITY_BASE_SPONSOR_OPERATOR_OWNERS stops it; a list
// with a repeated owner (in another case) starts.

test('a malformed sponsor operator owner stops startup; a repeated one is ignored', async (t) => {
  const before = process.env.CITY_BASE_SPONSOR_OPERATOR_OWNERS;
  t.after(() => {
    if (before === undefined) delete process.env.CITY_BASE_SPONSOR_OPERATOR_OWNERS;
    else process.env.CITY_BASE_SPONSOR_OPERATOR_OWNERS = before;
  });
  process.env.CITY_BASE_SPONSOR_OPERATOR_OWNERS = `0x${'ab'.repeat(20)},0x1234`;
  await assert.rejects(
    createApp({ dataDir: ':memory:', startWorkers: false }),
    /CITY_BASE_SPONSOR_OPERATOR_OWNERS/,
  );
  process.env.CITY_BASE_SPONSOR_OPERATOR_OWNERS = `0x${'ab'.repeat(20)}, 0x${'AB'.repeat(20)}`;
  const app = await createApp({ dataDir: ':memory:', startWorkers: false });
  await app.close();
});
