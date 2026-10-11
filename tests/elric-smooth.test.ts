import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  advance,
  closeOpenMarks,
  cutAt,
  rebase,
  REVEAL,
  splitBlocks,
  START,
  type RevealState,
} from '../src/rooms/markdown/smooth.js';
import { answersPost, type RoomMessage } from '../src/rooms/api.js';

/** Runs the reveal at 60 frames a second while `arrive(t)` gives the text available at t ms. */
function simulate(
  arrive: (t: number) => { text: string; done: boolean },
  { frameMs = 1000 / 60, maxMs = 20_000 } = {},
) {
  let state: RevealState = START;
  let shownText = '';
  let previous = '';
  const frames: { t: number; shown: number; available: number }[] = [];
  for (let t = 0; t <= maxMs; t += frameMs) {
    const { text, done } = arrive(t);
    if (text !== previous) {
      state = rebase(state, shownText, text);
      previous = text;
    }
    state = advance(state, text.length, done, frameMs);
    state = { ...state, shown: cutAt(text, state.shown) };
    shownText = text.slice(0, state.shown);
    frames.push({ t, shown: state.shown, available: text.length });
    if (done && state.shown === text.length) return { frames, shownText, doneAt: t };
  }
  return { frames, shownText, doneAt: Infinity };
}

const ANSWER =
  'Here is a calm answer that arrives a few words at a time. '.repeat(6) +
  '\n\n- one\n- two\n\n```js\nconst a = 1;\n\nconst b = 2;\n```\n\nThe end. 😀 done.';

/** Text arriving like the drafts: a batch every `everyMs`, then complete at `doneMs`. */
function batches(text: string, everyMs: number, doneMs: number) {
  return (t: number) => {
    const share = Math.min(1, Math.floor(t / everyMs) / Math.floor(doneMs / everyMs));
    return { text: text.slice(0, Math.floor(text.length * share)), done: t >= doneMs };
  };
}

test('smooth reveal: grows in many small steps, never past the text, and completes', () => {
  const { frames, shownText, doneAt } = simulate(batches(ANSWER, 500, 4_000));
  assert.equal(shownText, ANSWER);
  assert.ok(doneAt < 4_000 + REVEAL.doneS * 1000 + 50, `finished at ${doneAt}`);
  let steps = 0;
  let maxStep = 0;
  for (let i = 1; i < frames.length; i += 1) {
    const step = frames[i]!.shown - frames[i - 1]!.shown;
    assert.ok(step >= 0, 'never goes back while the text only grows');
    assert.ok(frames[i]!.shown <= frames[i]!.available, 'never shows text that has not arrived');
    if (step > 0) steps += 1;
    maxStep = Math.max(maxStep, step);
  }
  // Batches of ~45 characters every 500 ms become a few characters a frame.
  assert.ok(steps > 100, `${steps} steps`);
  assert.ok(maxStep <= 6, `largest step ${maxStep}`);
});

test('smooth reveal: the pace adapts to the backlog and never lags far behind', () => {
  const small = advance({ shown: 0, cps: 60, carry: 0 }, 10, false, 1_000);
  const large = advance({ shown: 0, cps: 60, carry: 0 }, 2_000, false, 1_000);
  assert.ok(large.cps > small.cps * 10, `${large.cps} vs ${small.cps}`);
  // A burst of 3000 characters at once is caught up within about 3 s, not 3000 / minCps.
  const burst = 'x'.repeat(3_000);
  const { frames } = simulate((t) => ({ text: t < 100 ? '' : burst, done: false }), {
    maxMs: 6_000,
  });
  const caught = frames.find((frame) => frame.shown === 3_000);
  assert.ok(caught && caught.t < 3_500, `caught up at ${caught?.t}`);
  // The pace changes gradually, no sudden jumps between two frames.
  let previous = START.cps;
  let state: RevealState = START;
  for (let i = 0; i < 30; i += 1) {
    state = advance(state, 1_000, false, 16);
    assert.ok(state.cps - previous <= (1_000 / REVEAL.lagS) * (16 / REVEAL.easeMs) + 1);
    previous = state.cps;
  }
});

test('smooth reveal: once complete it finishes at a steady pace within doneS', () => {
  const text = 'y'.repeat(400);
  const { frames, doneAt } = simulate(() => ({ text, done: true }));
  assert.ok(doneAt <= REVEAL.doneS * 1000 + 20, `done at ${doneAt}`);
  const steps = frames.slice(1).map((frame, i) => frame.shown - frames[i]!.shown);
  // Steady: frame steps differ by at most one character (the carried fraction).
  const inner = steps.slice(1, -1);
  assert.ok(Math.max(...inner) - Math.min(...inner) <= 1, inner.join(','));
  // A short ending does not crawl.
  const short = simulate(() => ({ text: 'ok.', done: true }));
  assert.ok(short.doneAt < 100);
});

test('smooth reveal: nothing is dropped or duplicated when the text changes underneath', () => {
  // A draft, then the posted message that differs from the draft near its end.
  const draft = 'The answer so far, with a draft ending';
  const final = 'The answer so far, with a final ending that is longer.';
  const { shownText, frames } = simulate((t) =>
    t < 1_500 ? { text: draft, done: false } : { text: final, done: true },
  );
  assert.equal(shownText, final);
  const at = frames.find((frame) => frame.t >= 1_500)!;
  assert.ok(at.shown <= 'The answer so far, with a '.length + 3, 'went back to the shared part');
  // Every shown text is a prefix of the text it was cut from.
  let state: RevealState = START;
  const text = 'abc😀def\r\nghi';
  const seen: string[] = [];
  while (state.shown < text.length) {
    state = advance(state, text.length, true, 5);
    state = { ...state, shown: cutAt(text, state.shown) };
    seen.push(text.slice(0, state.shown));
  }
  for (const part of seen) {
    assert.ok(!/[\uD800-\uDBFF]$/.test(part), 'never half an emoji');
    assert.ok(!part.endsWith('\r'), 'never between \\r and \\n');
  }
  assert.equal(seen.at(-1), text);
});

test('cutAt: whole code points and line breaks', () => {
  const text = 'a😀b\r\nc';
  assert.equal(cutAt(text, 2), 3); // inside the emoji: after it
  assert.equal(cutAt(text, 1), 1);
  assert.equal(cutAt(text, 5), 6); // between \r and \n: after \n
  assert.equal(cutAt(text, 99), text.length);
  assert.equal(cutAt(text, -1), 0);
});

const MARKDOWN = [
  'A first paragraph.\n\n',
  '## A heading\n\n',
  'Intro to a list:\n\n- one\n- two\n\n- three, same list\n\n',
  '```ts\nconst a = 1;\n\n\nconst b = 2;\n```\n\n',
  '> a quote\n\n',
  '1. first\n2. second\n\n',
  'The last paragraph.',
].join('');

test('markdown blocks: complete blocks never change, text is never lost or repeated', () => {
  let previous: string[] = [];
  for (let n = 0; n <= MARKDOWN.length; n += 1) {
    const text = MARKDOWN.slice(0, n);
    const { complete, tail } = splitBlocks(text);
    assert.equal(complete.join('') + tail, text, `at ${n}`);
    // Blocks only get added: a completed block is rendered once and stays as it was.
    assert.deepEqual(complete.slice(0, previous.length), previous, `at ${n}`);
    previous = complete;
  }
  const { complete, tail } = splitBlocks(MARKDOWN);
  assert.deepEqual(complete, [
    'A first paragraph.\n\n',
    '## A heading\n\n',
    'Intro to a list:\n\n- one\n- two\n\n- three, same list\n\n',
    '```ts\nconst a = 1;\n\n\nconst b = 2;\n```\n\n',
    // A list right after a block stays with it (it may continue a list): never wrong, just later.
    '> a quote\n\n1. first\n2. second\n\n',
  ]);
  assert.equal(tail, 'The last paragraph.');
});

test('markdown blocks: no split inside an open code fence or before a list item is known', () => {
  const open = 'Text.\n\n```\ncode\n\nmore code';
  assert.deepEqual(splitBlocks(open), { complete: ['Text.\n\n'], tail: '```\ncode\n\nmore code' });
  // "1" may become "1. item" (the same list): wait for the line to tell.
  assert.deepEqual(splitBlocks('- a\n\n1').complete, []);
  assert.deepEqual(splitBlocks('Para.\n\n1990 was a year').complete, ['Para.\n\n']);
  // Indented lines continue the block above (a list item's paragraph, indented code).
  assert.deepEqual(splitBlocks('- a\n\n  still a\n\nNext').complete, ['- a\n\n  still a\n\n']);
  assert.deepEqual(splitBlocks('').complete, []);
});

test('markdown tail: open bold or inline code shows formatted while it is written', () => {
  assert.equal(closeOpenMarks('with **some bo'), 'with **some bo**');
  assert.equal(closeOpenMarks('with **'), 'with ');
  assert.equal(closeOpenMarks('with **bold** done'), 'with **bold** done');
  assert.equal(closeOpenMarks('run `npm i'), 'run `npm i`');
  assert.equal(closeOpenMarks('run `'), 'run ');
  assert.equal(closeOpenMarks('`a**b` and'), '`a**b` and');
  assert.equal(closeOpenMarks('```js\nconst a = `x'), '```js\nconst a = `x');
});

test('a draft is replaced only by the answer to the viewer’s own post', () => {
  const message = (seq: number, auto_reply: RoomMessage['auto_reply']) =>
    ({ id: String(seq), seq, auto_reply }) as RoomMessage;
  const elric = (seq: number, replyTo?: number) =>
    message(seq, {
      provider: 'elric',
      model: 'elric-1.0',
      ...(replyTo === undefined ? {} : { reply_to: replyTo }),
    });
  // The viewer posted seq 10; Elric answering someone else's post 9 at seq 11 does not count.
  assert.equal(answersPost(elric(11, 9), 10), false);
  assert.equal(answersPost(elric(12, 10), 10), true);
  // Not Elric, or before the post: never.
  assert.equal(answersPost(message(12, null), 10), false);
  assert.equal(answersPost(elric(8, 10), 10), false);
  // A reply without reply_to (written before it existed) counts when it follows the post.
  assert.equal(answersPost(elric(11), 10), true);
});
