import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { workflowProgress } from '../src/Workflows';

/*
 * Workspace v2 Advanced views: the step track follows the recorded status only, and the tokens
 * in src/advanced-v2.css stay the Rooms v2 values, scoped to .adv2, with no orange.
 */

test('the collaboration step track follows the recorded status', () => {
  const at = (status: Parameters<typeof workflowProgress>[0]['status'], checkJobId = null) =>
    workflowProgress({ status, checkJobId });
  assert.deepEqual(at('briefing'), { done: 1, current: 1 });
  assert.deepEqual(at('awaiting_review'), { done: 1, current: 1 });
  assert.deepEqual(at('checking'), { done: 2, current: 2 });
  assert.deepEqual(at('completed'), { done: 3, current: 3 });
  assert.deepEqual(at('accepted'), { done: 4, current: null });
  assert.deepEqual(at('canceled'), { done: 1, current: null });
  assert.deepEqual(workflowProgress({ status: 'failed', checkJobId: 'job-test-0001' }), {
    done: 2,
    current: null,
  });
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

const css = readFileSync(resolve(process.cwd(), 'src/advanced-v2.css'), 'utf8');
const roomsCss = readFileSync(resolve(process.cwd(), 'src/rooms/rooms-v2.css'), 'utf8');

for (const [theme, selector, roomsSelector] of [
  ['light', '.adv2', ".rm-app[data-rooms='v2']"],
  ['dark', ":root[data-theme='dark'] .adv2", ":root[data-theme='dark'] .rm-app[data-rooms='v2']"],
] as const) {
  test(`advanced ${theme} tokens are the Rooms v2 values`, () => {
    const ours = block(css, selector);
    const rooms = block(roomsCss, roomsSelector);
    let shared = 0;
    for (const [name, value] of ours) {
      const theirs = rooms.get(name);
      if (!theirs || value.startsWith('var(') || theirs.startsWith('var(')) continue;
      shared += 1;
      assert.equal(value, theirs, `${theme} ${name} differs from rooms-v2.css`);
    }
    assert.ok(shared >= 25, `only ${shared} tokens compared`);
  });
}

test('advanced styles stay scoped and use no orange or amber', () => {
  for (const match of css.matchAll(/^([^@\s/*}][^{]*)\{/gm)) {
    const selectors = match[1]!.split(/,(?![^(]*\))/).map((item) => item.trim());
    for (const selector of selectors) assert.match(selector, /\.adv2/, `unscoped: ${selector}`);
  }
  const rules = css.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(rules, /#f97316|#fb923c|#ea580c|#f59e0b|#fbbf24|#d97706|orange|amber/i);
});
