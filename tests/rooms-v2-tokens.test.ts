import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

/*
 * Smart Rooms v2 tokens (src/rooms/rooms-v2.css): text contrast meets WCAG AA (4.5:1) in light
 * and dark, the tokens stay scoped to [data-rooms='v2'] (the token blocks also to the Workspace
 * v3 shell), and there is no orange outside the v3 "in progress" token.
 */
const css = readFileSync(resolve(process.cwd(), 'src/rooms/rooms-v2.css'), 'utf8');

function block(selector: string): Map<string, string> {
  const start = css.indexOf(`${selector} {`);
  assert.ok(start >= 0, `rooms-v2.css has no ${selector} block`);
  const body = css.slice(css.indexOf('{', start) + 1, css.indexOf('}', start));
  const tokens = new Map<string, string>();
  for (const match of body.matchAll(/(--[\w-]+):\s*([^;]+);/g))
    tokens.set(match[1], match[2].trim());
  return tokens;
}

const light = block(".rm-app[data-rooms='v2']");
const dark = new Map([...light, ...block(":root[data-theme='dark'] .rm-app[data-rooms='v2']")]);

/** A token's colour, following var() references within the same theme. */
function color(tokens: Map<string, string>, name: string): string {
  let value = tokens.get(name);
  for (let depth = 0; value?.startsWith('var(') && depth < 5; depth++) {
    value = tokens.get(value.slice(4, -1).trim());
  }
  assert.ok(
    value && /^#[0-9a-f]{6}$/i.test(value),
    `${name} is not an opaque hex colour: ${value}`,
  );
  return value;
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const TEXT = ['--text-primary', '--text-secondary', '--text-muted'];
const BACKGROUNDS = [
  '--bg-page',
  '--bg-surface',
  '--bg-surface-elevated',
  '--bg-surface-hover',
  // v3 fills under text: bubbles, inputs, chips and the sidebar.
  '--bg-inset',
  '--bg-sidebar',
  '--accent-subtle',
];
const PAIRS: Array<[string, string]> = [
  ...TEXT.flatMap((text) => BACKGROUNDS.map((bg): [string, string] => [text, bg])),
  ['--accent-text', '--bg-page'],
  ['--accent-text', '--bg-surface-elevated'],
  ['--status-live', '--bg-surface-elevated'],
  ['--status-pending', '--bg-surface-elevated'],
  ['--status-danger', '--bg-surface-elevated'],
  ['--on-primary', '--primary'],
];

for (const [theme, tokens] of [
  ['light', light],
  ['dark', dark],
] as const) {
  test(`v2 ${theme}: text pairs meet WCAG AA (4.5:1)`, () => {
    for (const [fg, bg] of PAIRS) {
      const ratio = contrast(color(tokens, fg), color(tokens, bg));
      assert.ok(ratio >= 4.5, `${theme} ${fg} on ${bg} is ${ratio.toFixed(2)}:1, below 4.5:1`);
    }
  });
}

test('every v2 rule is scoped to [data-rooms=v2]', () => {
  const selectors = css
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('}')
    .map((rule) => rule.split('{')[0].trim())
    .filter(Boolean);
  assert.ok(selectors.length > 2);
  // The two token blocks also apply to the whole workspace (docs/design/WORKSPACE_V3.md §2).
  const shell = /^(?::root\[data-theme='dark'\] )?\.app-shell\[data-workspace='v2'\]$/;
  const tokenBlocks = selectors.filter((list) => list.split(',').some((s) => shell.test(s.trim())));
  assert.equal(tokenBlocks.length, 2);
  for (const list of selectors) {
    for (const selector of list.split(',')) {
      if (tokenBlocks.includes(list) && shell.test(selector.trim())) continue;
      assert.match(selector, /\.rm-app\[data-rooms='v2'\]/, `unscoped selector: ${selector}`);
    }
  }
});

test('no orange: every colour is blue, grey, green or red', () => {
  // The one exception is the v3 "in progress" state (--status-warn, -bg, -line; spec §2).
  const checked = css.replace(/--status-warn(?:-bg|-line)?:[^;]+;/g, '');
  for (const match of checked.matchAll(/#([0-9a-f]{6})\b|rgba\((\d+),\s*(\d+),\s*(\d+)/gi)) {
    const [r, g, b] = match[1]
      ? [0, 2, 4].map((i) => parseInt(match[1].slice(i, i + 2), 16))
      : [match[2], match[3], match[4]].map(Number);
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    if (max - min < 40) continue; // grey
    const hue =
      max === r
        ? (60 * ((g - b) / (max - min)) + 360) % 360
        : max === g
          ? 60 * ((b - r) / (max - min)) + 120
          : 60 * ((r - g) / (max - min)) + 240;
    assert.ok(hue < 15 || hue > 75, `orange-ish colour ${match[0]} (hue ${hue.toFixed(0)})`);
  }
});
