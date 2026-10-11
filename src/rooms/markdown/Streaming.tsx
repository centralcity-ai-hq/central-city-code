/*
 * An answer shown smoothly as it is written (Elric's streamed replies, on /elric and in rooms).
 * The text that has arrived is revealed at an even, adaptive pace (smooth.ts) on animation frames,
 * and rendered block by block: completed Markdown blocks are parsed and rendered once, only the
 * growing tail changes. While it reveals, the answer is hidden from screen readers; when it is
 * complete and fully shown it becomes the normal message (the Markdown renderer), read once.
 * With reduced motion there is no reveal: the text shows as it arrives.
 */
import { memo, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Markdown } from './Markdown';
import { withoutBidiControls } from './guard';
import { parseSafely, MAX_MARKDOWN_CHARS } from './parse';
import { renderTree, withMentions } from './render';
import {
  advance,
  closeOpenMarks,
  cutAt,
  rebase,
  splitBlocks,
  START,
  type RevealState,
} from './smooth';
import { parseInWorker, VISIBLE_PRIORITY } from './workerClient';

/**
 * Blocks up to this long are parsed on the page itself while they form (a few hundred
 * microseconds); longer ones go to the parse worker as usual. guard.ts still applies.
 */
const SYNC_PARSE_CHARS = 2_000;

/** How far a reveal got, by key: the posted message continues where its draft stopped. */
const progress = new Map<string, { text: string; state: RevealState }>();

function subscribeMotion(change: () => void) {
  const query = window.matchMedia?.('(prefers-reduced-motion: reduce)');
  query?.addEventListener?.('change', change);
  return () => query?.removeEventListener?.('change', change);
}
const reducedMotion = () =>
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

/**
 * The part of `text` to show now. `done`: the text is complete. `key` names the answer, so a
 * reveal continues across components (the draft, then the posted message). Without `animate`
 * or with reduced motion everything shows at once.
 */
export function useSmoothReveal(
  text: string,
  { done, animate = true, revealKey }: { done: boolean; animate?: boolean; revealKey?: string },
): { shown: string; revealing: boolean } {
  const reduced = useSyncExternalStore(subscribeMotion, reducedMotion, () => false);
  const on = animate && !reduced;
  const state = useRef<RevealState | null>(null);
  const shownText = useRef('');
  if (state.current === null) {
    const saved = revealKey ? progress.get(revealKey) : undefined;
    state.current = saved ? rebase(saved.state, saved.text, text) : START;
    shownText.current = text.slice(0, state.current.shown);
  }
  const [, render] = useState(0);
  const target = useRef({ text, done });
  // The text changed: keep the shown part that is still the same.
  if (target.current.text !== text) {
    state.current = rebase(state.current, shownText.current, text);
    shownText.current = text.slice(0, state.current.shown);
  }
  target.current = { text, done };

  useEffect(() => {
    if (!on) return;
    let frame = 0;
    let last = 0;
    const tick = (time: number) => {
      const { text: full, done: complete } = target.current;
      const dt = last ? time - last : 16;
      last = time;
      const before = state.current!.shown;
      let next = advance(state.current!, full.length, complete, dt);
      next = { ...next, shown: cutAt(full, next.shown) };
      state.current = next;
      shownText.current = full.slice(0, next.shown);
      if (revealKey) {
        if (complete && next.shown >= full.length) progress.delete(revealKey);
        else progress.set(revealKey, { text: shownText.current, state: next });
      }
      if (next.shown !== before) render((n) => n + 1);
      // Caught up: wait for more text (a new text or `done` starts the loop again).
      if (next.shown < full.length) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    // Back from another tab: no catching up, show what has arrived.
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      const full = target.current.text;
      state.current = { ...state.current!, shown: full.length, carry: 0 };
      shownText.current = full;
      if (revealKey) {
        if (target.current.done) progress.delete(revealKey);
        else progress.set(revealKey, { text: full, state: state.current });
      }
      render((n) => n + 1);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [on, text, done, revealKey]);

  // Unmounted (handed over, or the answer stopped): the next component read it while rendering,
  // so the progress is dropped here and never outlives its answer.
  useEffect(
    () => () => {
      if (revealKey) progress.delete(revealKey);
    },
    [revealKey],
  );

  if (!on) {
    if (revealKey && done) progress.delete(revealKey);
    return { shown: text, revealing: false };
  }
  const shown = text.slice(0, state.current.shown);
  return { shown, revealing: !done || shown.length < text.length };
}

/** One part of the answer as Markdown children (no wrapper); plain text if it can't be parsed. */
function Part({
  text,
  names,
  forming,
}: {
  text: string;
  names: readonly string[];
  forming: boolean;
}) {
  const nameKey = names.join('\u0000');
  const content = useMemo(() => {
    if (text.length > SYNC_PARSE_CHARS) return null;
    const result = parseSafely(forming ? closeOpenMarks(text) : text);
    return 'tree' in result ? renderTree(result.tree, names, forming) : null;
  }, [text, nameKey, forming]); // eslint-disable-line react-hooks/exhaustive-deps
  if (content) return <>{content}</>;
  return (
    <p className="rm-text md-stream-plain" data-markdown="plain">
      {withMentions(text.trimEnd(), names, 'p')}
    </p>
  );
}
/** A completed block never changes: rendered once. */
const Block = memo(function Block({ text, names }: { text: string; names: readonly string[] }) {
  return <Part text={text} names={names} forming={false} />;
});

/**
 * An answer that may still be arriving. `done`: `text` is the complete answer. `animate`: reveal
 * it (a live answer); history passes false and is never animated.
 */
export function StreamingMarkdown({
  text,
  done,
  animate = true,
  revealKey,
  names = [],
}: {
  text: string;
  done: boolean;
  animate?: boolean;
  revealKey?: string;
  names?: readonly string[];
}) {
  // The whole text goes to the Markdown renderer at the end (it shows "(message truncated)"
  // past its limit, as after a reload); the reveal works on what it can render.
  const full = withoutBidiControls(text);
  const clean = full.slice(0, MAX_MARKDOWN_CHARS);
  const { shown, revealing } = useSmoothReveal(clean, { done, animate, revealKey });
  // The finished answer is parsed in the worker while the last words show, so the normal
  // message takes over without a flash of raw Markdown.
  const [parsed, setParsed] = useState<string | null>(null);
  useEffect(() => {
    if (!done) return;
    let live = true;
    void parseInWorker(full, VISIBLE_PRIORITY).then(() => live && setParsed(full));
    return () => {
      live = false;
    };
  }, [done, full]);
  const blocks = useMemo(() => splitBlocks(shown), [shown]);
  if (done && !revealing && parsed === full) return <Markdown text={full} names={names} />;
  return (
    <div className="md-body-wrap md-stream" aria-hidden="true" data-revealing={revealing}>
      <div className="md-body">
        {blocks.complete.map((block, index) => (
          <Block key={index} text={block} names={names} />
        ))}
        {blocks.tail.trim() ? <Part text={blocks.tail} names={names} forming={!done} /> : null}
      </div>
    </div>
  );
}
