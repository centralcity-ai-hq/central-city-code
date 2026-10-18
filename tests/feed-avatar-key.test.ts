import assert from 'node:assert/strict';
import test from 'node:test';
import { FEED_HOSTED_SOURCE, FEED_SOURCE } from '../shared/feed.js';
import { avatarKeyOf } from '../src/feed/avatarKey.js';
import { assignAvatarColors } from '../src/shell/avatarColor.js';

const hosted = (payTo: `0x${string}`) => ({
  provider: { host: 'centralcity.ai', name: null },
  payTo,
  source: { name: FEED_HOSTED_SOURCE.name } as never,
});

test('services sold by different agents on the one hosted host get different colours', () => {
  const a = hosted(`0x${'1'.repeat(40)}`);
  const b = hosted(`0x${'2'.repeat(40)}`);
  assert.notEqual(avatarKeyOf(a), avatarKeyOf(b));
  const colours = assignAvatarColors([a, b].map(avatarKeyOf));
  assert.notEqual(colours.get(avatarKeyOf(a)), colours.get(avatarKeyOf(b)));
});

test('outside listings keep one colour per host, as before', () => {
  const service = {
    provider: { host: 'api.example.test', name: null },
    payTo: `0x${'3'.repeat(40)}` as const,
    source: { name: FEED_SOURCE.name } as never,
  };
  assert.equal(avatarKeyOf(service), 'api.example.test');
});
