import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { countsAsNew, newSinceOf, updatesLabel } from '../src/rooms/newSince.js';

/* The "New since" divider (src/rooms/newSince.ts) and the v2 thread styles' scope. */

type Row = { id: string; seq: number; own: boolean; created_at: string; sender_kind?: string };
const at = (minute: number) => new Date(Date.UTC(2026, 9, 3, 10, minute)).toISOString();
const row = (seq: number, extra: Partial<Row> = {}): Row => ({
  id: `m${seq}`,
  seq,
  own: false,
  created_at: at(seq),
  sender_kind: 'agent',
  ...extra,
});

test('no mark (never opened on this device) means no divider', () => {
  assert.equal(newSinceOf([row(1), row(2)], undefined, false), null);
});

test('nothing after the mark means no divider', () => {
  assert.equal(newSinceOf([row(1), row(2)], 2, false), null);
});

test('the divider sits above the first message from others after the mark', () => {
  const messages = [
    row(1),
    row(2),
    row(3, { own: true }),
    row(4, { sender_kind: 'system' }),
    row(5),
    row(6),
  ];
  const info = newSinceOf(messages, 2, false);
  assert.ok(info);
  assert.equal(info.firstId, 'm5');
  assert.equal(info.count, 2);
  assert.equal(info.more, false);
  // "Since" is when the last seen message was written.
  assert.equal(info.since.toISOString(), at(2));
});

test('own posts and system lines alone never show a divider', () => {
  const messages = [row(1), row(2, { own: true }), row(3, { sender_kind: 'system' })];
  assert.equal(newSinceOf(messages, 1, false), null);
  assert.equal(countsAsNew(row(1, { own: true })), false);
  assert.equal(countsAsNew(row(1, { sender_kind: 'system' })), false);
  assert.equal(countsAsNew(row(1, { sender_kind: 'person' })), true);
});

test('with older pages not loaded, the count is a lower bound', () => {
  const info = newSinceOf([row(10), row(11)], 3, true);
  assert.ok(info);
  assert.equal(info.firstId, 'm10');
  assert.equal(info.more, true);
  assert.equal(info.since.toISOString(), at(10));
  assert.equal(newSinceOf([row(3), row(10)], 3, true)?.more, false);
});

test('invalid marks are ignored', () => {
  assert.equal(newSinceOf([row(1)], -1, false), null);
  assert.equal(newSinceOf([row(1)], 1.5, false), null);
});

test('updates label', () => {
  assert.equal(updatesLabel(1, false), '1 update');
  assert.equal(updatesLabel(3, false), '3 updates');
  assert.equal(updatesLabel(100, true), '100+ updates');
});

test('every v2 thread rule is scoped to the preview flag and uses no orange', () => {
  const css = readFileSync(new URL('../src/rooms/rooms-v2-thread.css', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/@media[^{]+\{/g, '');
  const selectors = [...css.matchAll(/([^{}]+)\{[^{}]*\}/g)].map((match) => match[1]!.trim());
  assert.ok(selectors.length > 10);
  for (const group of selectors)
    for (const selector of group.split(','))
      assert.match(selector.trim(), /\.rm-app\[data-rooms='v2'\]/, selector);
  assert.doesNotMatch(css, /orange|amber|#f97316|#f59e0b|#ea580c|#fb923c/i);
});
