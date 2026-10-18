import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import {
  gateSteps,
  isOpenChat,
  liveLine,
  messageClock,
  sendAttempt,
  usageShare,
  waitingLabel,
} from '../src/elric/elricV3';

/*
 * Workspace v3, Elric (docs/design/WORKSPACE_V3_ELRIC_AGENTS.md §1): the words the page draws
 * from real data, and its styles: the Rooms v2 / v3 tokens, AA contrast in both themes, sizes in
 * the workspace units, and no orange or amber anywhere on Elric.
 */

test('a late read or post merges only into the chat still open', () => {
  assert.equal(isOpenChat('room-a', 'room-a'), true);
  // Chat B was picked while chat A was loading: A’s messages are dropped.
  assert.equal(isOpenChat('room-b', 'room-a'), false);
  // "New chat" (no room yet) matches nothing, not even another empty id.
  assert.equal(isOpenChat('', 'room-a'), false);
  assert.equal(isOpenChat('', ''), false);
  assert.equal(isOpenChat(undefined, 'room-a'), false);
});

test('Home approval pill: one line for one or more actions, nothing for none', () => {
  assert.equal(waitingLabel(0), '');
  assert.equal(waitingLabel(-1), '');
  assert.equal(waitingLabel(Number.NaN), '');
  assert.equal(waitingLabel(1), '1 action waiting for you');
  assert.equal(waitingLabel(3), '3 actions waiting for you');
});

test('the top bar live line: rooms Elric is in, paused, or nothing while unknown', () => {
  assert.equal(liveLine(null, 'active'), null);
  assert.deepEqual(liveLine(2, 'active'), { text: 'On in 2 rooms', live: true });
  assert.deepEqual(liveLine(1, 'active'), { text: 'On in 1 room', live: true });
  assert.deepEqual(liveLine(0, 'active'), { text: 'In no rooms yet', live: false });
  // Paused wins over the room count: it is not on anywhere.
  assert.deepEqual(liveLine(4, 'paused'), { text: 'Paused', live: false });
  assert.deepEqual(liveLine(null, 'paused'), { text: 'Paused', live: false });
});

test('first-visit steps follow GET /api/elric eligibility', () => {
  // No Google yet: neither step is done, and the age is not asked before Google.
  assert.deepEqual(gateSteps(false, 'unverified'), {
    google: false,
    age: false,
    ageOpen: false,
    adultsOnly: false,
  });
  // Google linked, date of birth missing: step one done, step two open.
  assert.deepEqual(gateSteps(false, 'age_unknown'), {
    google: true,
    age: false,
    ageOpen: true,
    adultsOnly: false,
  });
  // Under 18: the adults-only state, no age step.
  assert.deepEqual(gateSteps(false, 'age_under_18'), {
    google: true,
    age: false,
    ageOpen: false,
    adultsOnly: true,
  });
  // Eligible: both done.
  assert.deepEqual(gateSteps(true, null), {
    google: true,
    age: true,
    ageOpen: false,
    adultsOnly: false,
  });
  // An unknown answer (or none, a status that could not be read): no green check is claimed and
  // the age step stays closed until Google is positively linked.
  for (const reason of [undefined, null, 'unknown', 'not_person']) {
    assert.equal(gateSteps(false, reason).google, false, String(reason));
    assert.equal(gateSteps(false, reason).ageOpen, false, String(reason));
  }
});

test('message times and usage meters', () => {
  assert.equal(messageClock(undefined), '');
  assert.equal(messageClock('not a date'), '');
  assert.match(messageClock('2026-10-05T07:02:00.000Z'), /\d{1,2}[:.]\d{2}/);
  assert.deepEqual(usageShare(5, 10), { share: 0.5, full: false });
  assert.deepEqual(usageShare(12, 10), { share: 1, full: true });
  assert.deepEqual(usageShare(0, 0), { share: 1, full: true });
});

function block(css: string, selector: string): Map<string, string> {
  const start = css.indexOf(`${selector} {`);
  assert.ok(start >= 0, `no ${selector} block`);
  const body = css.slice(css.indexOf('{', start) + 1, css.indexOf('}', start));
  const tokens = new Map<string, string>();
  for (const match of body.matchAll(/(--[\w-]+):\s*([^;]+);/g))
    tokens.set(match[1]!, match[2]!.trim());
  return tokens;
}

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');
const tokensCss = read('src/elric/elric-tokens.css');
const v3Css = read('src/elric/elric-v3.css');
const skeletonCss = read('src/elric/skeleton.css');
const roomsCss = read('src/rooms/rooms-v2.css');

const THEMES = [
  ['light', '.elx-skel', ".rm-app[data-rooms='v2']"],
  [
    'dark',
    ":root[data-theme='dark'] .elx-skel",
    ":root[data-theme='dark'] .rm-app[data-rooms='v2']",
  ],
] as const;

for (const [theme, elricSelector, roomsSelector] of THEMES)
  test(`Elric ${theme} tokens are the Rooms v2 values`, () => {
    const elric = block(tokensCss, elricSelector);
    const rooms = block(roomsCss, roomsSelector);
    let shared = 0;
    for (const [name, value] of elric) {
      const theirs = rooms.get(name);
      if (!theirs || value.startsWith('var(') || theirs.startsWith('var(')) continue;
      shared += 1;
      assert.equal(value, theirs, `${theme} ${name} differs from rooms-v2.css`);
    }
    assert.ok(shared >= 20, `only ${shared} tokens compared`);
  });

/** WCAG 2 contrast of two colours (#rrggbb, or rgba() composited over `under`). */
function rgb(value: string, under?: [number, number, number]): [number, number, number] {
  const hex = /^#([0-9a-f]{6})$/i.exec(value);
  if (hex) {
    const n = parseInt(hex[1]!, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const rgba = /^rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)$/.exec(value);
  assert.ok(rgba && under, `cannot read ${value}`);
  const alpha = Number(rgba[4]);
  return [1, 2, 3].map((index) =>
    Math.round(Number(rgba[index]) * alpha + under[index - 1]! * (1 - alpha)),
  ) as [number, number, number];
}
function luminance([r, g, b]: [number, number, number]) {
  const channel = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}
function contrast(a: [number, number, number], b: [number, number, number]) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

for (const [theme, elricSelector] of THEMES)
  test(`Elric ${theme}: the text pairs on the page reach AA (4.5:1)`, () => {
    const t = {
      ...Object.fromEntries(block(tokensCss, '.elx-skel')),
      ...Object.fromEntries(block(tokensCss, elricSelector)),
    };
    const surface = rgb(t['--bg-surface-elevated']!);
    const pairs: Array<[string, string, string]> = [
      ['text on the page', '--text-primary', '--bg-page'],
      ['muted on a card', '--text-muted', '--bg-surface-elevated'],
      ['muted on a bubble or pill', '--text-muted', '--bg-inset'],
      ['muted on the page end', '--text-muted', '--bg-page-2'],
      ['text in a bubble', '--text-primary', '--bg-inset'],
      ['badge and waiting pill', '--accent-text', '--accent-subtle'],
      ['white on a filled button', '--accent-contrast', '--primary'],
    ];
    for (const [label, fg, bg] of pairs) {
      const ratio = contrast(rgb(t[fg]!), rgb(t[bg]!));
      assert.ok(ratio >= 4.5, `${theme} ${label}: ${ratio.toFixed(2)}`);
    }
    // "Done" and "On": the live green on its tint over a card.
    const live = contrast(rgb(t['--status-live']!), rgb(t['--status-live-bg']!, surface));
    assert.ok(live >= 4.5, `${theme} done pill: ${live.toFixed(2)}`);
    const danger = contrast(rgb(t['--status-danger']!), surface);
    assert.ok(danger >= 4.5, `${theme} error text: ${danger.toFixed(2)}`);
  });

test('Elric styles stay scoped, use the workspace units and no orange or amber', () => {
  for (const [name, css, scope] of [
    ['elric-v3.css', v3Css, /\.elx3|^@keyframes|^(from|to|\d+%)$/],
    ['skeleton.css', skeletonCss, /\.elx-skel|^@keyframes|^(from|to|\d+%)$/],
    ['elric-tokens.css', tokensCss, /\.elx3|\.elx-skel|^@keyframes|^(from|to|\d+%)$/],
  ] as const) {
    const rules = css.replace(/\/\*[\s\S]*?\*\//g, '');
    for (const match of rules.matchAll(/(?:^|})\s*([^{}@]+?)\s*\{/g)) {
      for (const selector of match[1]!.split(/,(?![^(]*\))/).map((item) => item.trim()))
        if (selector) assert.match(selector, scope, `unscoped selector in ${name}: ${selector}`);
    }
    assert.doesNotMatch(
      rules,
      /#f97316|#fb923c|#ea580c|#f59e0b|#fbbf24|#d97706|#b45309|#fff7ed|#fed7aa|orange|amber|--status-warn|--warning/i,
      `${name} uses orange or amber`,
    );
    // Font sizes scale with the workspace (a px value only as a floor inside max()).
    for (const match of rules.matchAll(/font(?:-size)?:\s*([^;]+);/g)) {
      const value = match[1]!;
      if (/^(inherit|var\(|\d+(\.\d+)?$)/.test(value) || !/\d(px|rem|em)\b/.test(value)) continue;
      assert.match(value, /--ws-type-px|--elx3-bar-type|max\(1[12](\.5)?px/, `${name}: ${value}`);
    }
  }
});

test('the top bar is 10% smaller than the room top bar, and phones keep 44px targets', () => {
  assert.match(tokensCss, /--elx3-bar:\s*0\.9;/);
  // The bar's chips, pill, gaps and padding are all drawn at the bar scale.
  assert.match(v3Css, /--elx3-chip-h:\s*calc\(44 \* var\(--elx3-bar-px\)\)/);
  assert.match(v3Css, /font: 600 calc\(17 \* var\(--elx3-bar-type\)\)/);
  // On phones and touch screens the chips are 44px (the 10% never shrinks a touch target).
  assert.match(
    v3Css,
    /@media \(max-width: 640px\), \(pointer: coarse\) \{\s*\.elx\.elx3 \{\s*--elx3-chip-h: 44px;/,
  );
  // Reduced motion: no animation or transition on the page (the orb's halo included).
  assert.match(v3Css, /@media \(prefers-reduced-motion: reduce\) \{\s*\.elx3 \*,/);
  assert.match(
    tokensCss,
    /@media \(prefers-reduced-motion: reduce\) \{\s*\.elx3-mark-orb \{\s*animation: none;/,
  );
});

test('a resend of the same text to the same room keeps the idempotency key', () => {
  let n = 0;
  const next = () => `key-${++n}`;
  const first = sendAttempt(null, 'room-a', 'hello', next);
  assert.equal(first.key, 'key-1');
  // The response was lost: the same text again to the same room is the same post.
  assert.equal(sendAttempt(first, 'room-a', 'hello', next).key, 'key-1');
  // Other text, or another room, is a new post.
  assert.equal(sendAttempt(first, 'room-a', 'hello again', next).key, 'key-2');
  assert.equal(sendAttempt(first, 'room-b', 'hello', next).key, 'key-3');
  assert.equal(sendAttempt(null, 'room-a', 'hello', next).key, 'key-4');
  // Both posts of the Elric page take their key from the last attempt, never a fresh one.
  const page = readFileSync(resolve('src/elric/ElricDashboard.tsx'), 'utf8');
  assert.doesNotMatch(page, /idempotency_key:\s*crypto\.randomUUID\(\)/);
  assert.equal(page.match(/idempotency_key: attempt\.key/g)?.length, 2);
});
