import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { activityArea, activityFilters } from '../src/settings/activityAreas';

/*
 * Workspace v2 Settings: the Activity log filters, and the Settings tokens staying the Rooms v2
 * values (src/settings/settings-v2.css vs src/rooms/rooms-v2.css) with no orange.
 */

test('every event area maps to one Activity log filter, unknown areas to Other', () => {
  assert.equal(activityArea('job.completed'), 'exchanges');
  assert.equal(activityArea('result.published'), 'exchanges');
  assert.equal(activityArea('workflow.created'), 'exchanges');
  assert.equal(activityArea('connection.cross_requested'), 'connections');
  assert.equal(activityArea('agent.registered'), 'agents');
  assert.equal(activityArea('responder.enabled'), 'agents');
  assert.equal(activityArea('elric.added'), 'agents');
  assert.equal(activityArea('room.member_joined'), 'rooms');
  assert.equal(activityArea('operator.created'), 'account');
  assert.equal(activityArea('assistant.granted'), 'account');
  assert.equal(activityArea('workspace.paused'), 'account');
  assert.equal(activityArea('city.wake'), 'other');
  assert.equal(activityArea(''), 'other');
  // Inherited object keys are not areas.
  assert.equal(activityArea('constructor.x'), 'other');
  assert.equal(activityArea('__proto__.x'), 'other');
});

test('filters list only areas present in the loaded events, in display order, with counts', () => {
  assert.deepEqual(activityFilters([]), []);
  const filters = activityFilters([
    { type: 'room.created' },
    { type: 'job.completed' },
    { type: 'job.started' },
    { type: 'assistant.granted' },
    { type: 'city.wake' },
  ]);
  assert.deepEqual(
    filters.map(({ id, label, count }) => [id, label, count]),
    [
      ['exchanges', 'Exchanges', 2],
      ['rooms', 'Rooms', 1],
      ['account', 'Account', 1],
      ['other', 'Other', 1],
    ],
  );
  assert.equal(
    filters.reduce((sum, item) => sum + item.count, 0),
    5,
    'every event is counted exactly once',
  );
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

const settingsCss = readFileSync(resolve(process.cwd(), 'src/settings/settings-v2.css'), 'utf8');
const roomsCss = readFileSync(resolve(process.cwd(), 'src/rooms/rooms-v2.css'), 'utf8');

for (const [theme, settingsSelector, roomsSelector] of [
  ['light', '.stv2', ".rm-app[data-rooms='v2']"],
  ['dark', ":root[data-theme='dark'] .stv2", ":root[data-theme='dark'] .rm-app[data-rooms='v2']"],
] as const) {
  test(`settings ${theme} tokens are the Rooms v2 values`, () => {
    const settings = block(settingsCss, settingsSelector);
    const rooms = block(roomsCss, roomsSelector);
    let shared = 0;
    for (const [name, value] of settings) {
      const theirs = rooms.get(name);
      if (!theirs || value.startsWith('var(') || theirs.startsWith('var(')) continue;
      shared += 1;
      assert.equal(value, theirs, `${theme} ${name} differs from rooms-v2.css`);
    }
    assert.ok(shared >= 25, `only ${shared} tokens compared`);
  });
}

test('settings styles stay scoped and use no orange or amber', () => {
  for (const match of settingsCss.matchAll(/^([^@\s/*}][^{]*)\{/gm)) {
    const selectors = match[1]!.split(/,(?![^(]*\))/).map((item) => item.trim());
    for (const selector of selectors) {
      if (/^(from|to|\d+%)$/.test(selector)) continue;
      assert.match(
        selector,
        /\.(stv2|account-activity)/,
        `unscoped selector in settings-v2.css: ${selector}`,
      );
    }
  }
  const rules = settingsCss.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(rules, /#f97316|#fb923c|#ea580c|#f59e0b|#fbbf24|#d97706|orange|amber/i);
});
