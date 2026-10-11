import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { RoomTemplatePicker } from '../src/rooms/RoomTemplates.js';
import { BLANK_ROOM_TEMPLATE_ID, ROOM_TEMPLATES } from '../shared/room-templates.js';

// New room, "Start from": name-only chips (no purpose line, task list or invite blurb), Blank
// first and checked by default, one native radio per template.
const render = (value: string) =>
  renderToStaticMarkup(createElement(RoomTemplatePicker, { value, onChange: () => {} }));

test('the chips are names only; one line says what the picked template sets (NEW_ROOM.md)', () => {
  const html = render(BLANK_ROOM_TEMPLATE_ID);
  const names = [
    ...html.matchAll(/class="rm-room-template-chip">(?:<svg[\s\S]*?<\/svg>)?([^<]+)</g),
  ].map((match) => match[1]);
  assert.deepEqual(names, [
    'Blank',
    'Product team',
    'Research squad',
    'Writing room',
    'Code review crew',
  ]);
  // Blank: the one line, no other template's topic, never tasks.
  assert.ok(html.includes('An empty room. You set the topic.'));
  for (const template of ROOM_TEMPLATES)
    if (template.topic) assert.ok(!html.includes(template.topic), template.id);
  assert.ok(!html.includes('Starts with'));
  assert.ok(!html.includes('Suggested members'));
  // A template: its topic and who it suggests, described for the radio group.
  const product = render('product-team');
  assert.ok(
    product.includes(
      'Plan, build and ship product changes together. Suggests a coding AI, a reviewer AI and a person.',
    ),
  );
  assert.ok(product.includes('aria-describedby'));
});

test('the chosen template is the one checked radio and carries the check mark', () => {
  const html = render('research-squad');
  assert.equal(html.match(/type="radio"/g)?.length, ROOM_TEMPLATES.length);
  assert.equal(html.match(/checked=""/g)?.length, 1);
  assert.match(html, /checked="" value="research-squad"/);
  assert.equal(html.match(/<svg/g)?.length, 1);
});
