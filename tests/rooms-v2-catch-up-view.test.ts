import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  CATCH_UP_ACCOUNT_OFF_TEXT,
  CATCH_UP_LIMIT_FALLBACK,
  CATCH_UP_ROOM_OFF_TEXT,
  catchUpLimitedText,
  catchUpView,
} from '../src/rooms/catchUpView.js';
import type { CatchUp } from '../shared/elric-catch-up.js';

/* The "Catch me up" part of the New-since divider (src/rooms/catchUpView.ts, CatchUpSummary). */

const data = (extra: Partial<CatchUp> = {}): CatchUp => ({
  room_id: 'r1',
  from_seq: 3,
  to_seq: 9,
  truncated: false,
  sections: [],
  nothing_important: true,
  cached: false,
  ...extra,
});
const tasks = {
  kind: 'tasks' as const,
  title: 'Tasks that moved',
  bullets: [{ text: 'T2 moved to review', seqs: [5], task_number: 2 }],
};

test('idle, loading, off and error map to collapsed, loading, hidden and error', () => {
  assert.deepEqual(catchUpView({ status: 'idle' }), { kind: 'collapsed' });
  assert.deepEqual(catchUpView({ status: 'loading' }), { kind: 'loading' });
  assert.deepEqual(catchUpView({ status: 'off', reason: null }), { kind: 'hidden' });
  assert.deepEqual(catchUpView({ status: 'error' }), { kind: 'error' });
});

test('off in this room or for this account is one quiet line saying why', () => {
  assert.deepEqual(catchUpView({ status: 'off', reason: 'room' }), {
    kind: 'unavailable',
    text: CATCH_UP_ROOM_OFF_TEXT,
  });
  assert.deepEqual(catchUpView({ status: 'off', reason: 'account' }), {
    kind: 'unavailable',
    text: CATCH_UP_ACCOUNT_OFF_TEXT,
  });
});

test('a 429 says when to try again', () => {
  assert.deepEqual(catchUpView({ status: 'limited', retryAfterMs: 30_000 }), {
    kind: 'limited',
    text: 'Too many catch-ups just now. Try again in 30 seconds.',
  });
  assert.equal(catchUpLimitedText(1000), 'Too many catch-ups just now. Try again in 1 second.');
  assert.equal(catchUpLimitedText(61_000), 'Too many catch-ups just now. Try again in 2 minutes.');
  assert.equal(catchUpLimitedText(), 'Too many catch-ups just now. Try again in a moment.');
});

test('nothing important is one quiet line', () => {
  assert.deepEqual(catchUpView({ status: 'ready', data: data() }), {
    kind: 'ready',
    sections: [],
    nothing: true,
    notice: null,
    retry: false,
  });
});

test('sections keep their order; empty ones are dropped', () => {
  const empty = { kind: 'decisions' as const, title: 'Decisions', bullets: [] };
  const view = catchUpView({
    status: 'ready',
    data: data({ sections: [tasks, empty], nothing_important: false }),
  });
  assert.equal(view.kind, 'ready');
  if (view.kind !== 'ready') return;
  assert.deepEqual(view.sections, [tasks]);
  assert.equal(view.nothing, false);
});

test('a limit shows the reset notice with the room-data sections, never "nothing important"', () => {
  const notice = 'Summaries used up for today. Resets at 00:00 UTC.';
  const view = catchUpView({
    status: 'ready',
    data: data({ sections: [tasks], incomplete: 'limit', notice }),
  });
  assert.deepEqual(view, {
    kind: 'ready',
    sections: [tasks],
    nothing: false,
    notice,
    retry: false,
  });
  const bare = catchUpView({ status: 'ready', data: data({ incomplete: 'limit' }) });
  assert.deepEqual(bare, {
    kind: 'ready',
    sections: [],
    nothing: false,
    notice: CATCH_UP_LIMIT_FALLBACK,
    retry: false,
  });
});

test('unavailable offers a plain retry', () => {
  assert.deepEqual(catchUpView({ status: 'ready', data: data({ incomplete: 'unavailable' }) }), {
    kind: 'ready',
    sections: [],
    nothing: false,
    notice: null,
    retry: true,
  });
});

test('bullet text is rendered as plain text, never as HTML or Markdown', () => {
  const source = readFileSync(new URL('../src/rooms/CatchUpSummary.tsx', import.meta.url), 'utf8');
  assert.ok(!source.includes('dangerouslySetInnerHTML'));
  assert.ok(!/Markdown/.test(source.replace(/\/\*[\s\S]*?\*\//g, '')));
});

test('refusals map to the off reason; other errors are not refusals', async () => {
  const { offReason } = await import('../src/rooms/useCatchUp.js');
  const { ApiError } = await import('../src/api.js');
  assert.equal(offReason(new ApiError('x', 409, 'elric_catch_up_off')), 'room');
  assert.equal(offReason(new ApiError('x', 403, 'elric_not_eligible')), 'account');
  assert.equal(offReason(new ApiError('x', 409, 'elric_catch_up_paused')), null);
  assert.equal(offReason(new ApiError('x', 404, 'room_not_found')), null);
  assert.equal(offReason(new ApiError('x', 429)), undefined);
  assert.equal(offReason(new Error('x')), undefined);
});

test('api() keeps the Retry-After of a refusal', async (t) => {
  const { api, ApiError } = await import('../src/api.js');
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json(
      { error: 'Too many requests.' },
      { status: 429, headers: { 'Retry-After': '12' } },
    ),
  );
  await assert.rejects(api('/api/rooms/r1/catch-up', {}), (error: unknown) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.status, 429);
    assert.equal(error.retryAfterMs, 12_000);
    return true;
  });
});
