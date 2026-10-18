import assert from 'node:assert/strict';
import test from 'node:test';
import {
  JOIN_LINK_MARGIN_MS,
  cachedJoinLink,
  joinLinkCache,
  joinLinkFresh,
} from '../src/rooms/joinLinkCache.js';

/*
 * The Invite and Add an AI sheets start from the page's cached join link (src/rooms/joinLinkCache.ts).
 * A link past the server's 24 h cap must not be shown or copied: the cache drops it so a new one
 * is made.
 */

const now = Date.parse('2026-10-15T12:00:00Z');
const link = (expiresAt: string) => ({
  id: 'l1',
  url: 'https://example.test/j/x',
  expires_at: expiresAt,
});

test('a live cached link is reused', () => {
  joinLinkCache.clear();
  const live = link('2026-10-16T11:00:00Z');
  joinLinkCache.set('room-1', live);
  assert.equal(cachedJoinLink('room-1', now), live);
  assert.equal(joinLinkCache.has('room-1'), true);
});

test('an expired or nearly expired cached link is dropped', () => {
  joinLinkCache.clear();
  joinLinkCache.set('room-1', link('2026-10-15T11:00:00Z'));
  assert.equal(cachedJoinLink('room-1', now), null);
  assert.equal(joinLinkCache.has('room-1'), false);
  joinLinkCache.set('room-2', link(new Date(now + JOIN_LINK_MARGIN_MS - 1).toISOString()));
  assert.equal(cachedJoinLink('room-2', now), null);
  assert.equal(cachedJoinLink('room-3', now), null);
});

test('joinLinkFresh treats a missing or unreadable date as dead', () => {
  assert.equal(joinLinkFresh(null, now), false);
  assert.equal(joinLinkFresh(link('not a date'), now), false);
  assert.equal(joinLinkFresh(link('2026-10-15T13:00:00Z'), now), true);
});
