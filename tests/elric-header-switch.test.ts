import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { registerHooks } from 'node:module';

// The switch imports its stylesheet (Vite bundles it); under Node a .css import is empty.
registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true };
    return nextLoad(url, context);
  },
});
const { ElricHeaderSwitch, showHeaderElricSwitch } =
  await import('../src/rooms/elric/ElricHeaderSwitch.js');

const noop = async () => {};

test('only the host sees the header switch, and never someone under 18', () => {
  assert.equal(showHeaderElricSwitch({ host: true }), true);
  assert.equal(showHeaderElricSwitch({ host: true, eligibilityReason: null }), true);
  assert.equal(showHeaderElricSwitch({ host: true, eligibilityReason: 'age_unknown' }), true);
  assert.equal(showHeaderElricSwitch({ host: true, eligibilityReason: 'unverified' }), true);
  assert.equal(showHeaderElricSwitch({ host: true, eligibilityReason: 'age_under_18' }), false);
  assert.equal(showHeaderElricSwitch({ host: false }), false);
  assert.equal(showHeaderElricSwitch({ host: false, eligibilityReason: 'age_under_18' }), false);
});

test('the header switch is a labelled role="switch" that shows its state', () => {
  const on = renderToStaticMarkup(
    createElement(ElricHeaderSwitch, { on: true, disabledReason: null, change: noop }),
  );
  assert.match(on, /role="switch"/);
  assert.match(on, /aria-checked="true"/);
  assert.match(on, /<span class="cc-switch-label">Elric<\/span>/);
  assert.match(on, />On</);
  assert.doesNotMatch(on, /role="alertdialog"/);

  const off = renderToStaticMarkup(
    createElement(ElricHeaderSwitch, { on: false, disabledReason: null, change: noop }),
  );
  assert.match(off, /aria-checked="false"/);
  assert.match(off, />Off</);
  // A native button: focusable, and Space/Enter toggle it.
  assert.match(off, /<button type="button" role="switch"/);
  assert.doesNotMatch(off, /disabled=""/);
});

test('switching off never asks: no "Remove Elric from this room?" question anywhere', () => {
  for (const on of [true, false]) {
    const html = renderToStaticMarkup(
      createElement(ElricHeaderSwitch, { on, disabledReason: null, change: noop }),
    );
    assert.doesNotMatch(html, /role="alertdialog"/);
    assert.doesNotMatch(html, /Remove Elric/);
  }
});

test('before Elric was ever added, the header offers "+ Add Elric" instead of the switch', () => {
  const add = renderToStaticMarkup(
    createElement(ElricHeaderSwitch, {
      on: false,
      disabledReason: null,
      change: noop,
      onAdd: () => {},
    }),
  );
  assert.match(add, /<button type="button" class="rm-outline rm-head-btn rm-head-add-elric"/);
  assert.match(add, /<span><span class="rm-head-label">Add <\/span>Elric<\/span>/);
  assert.doesNotMatch(add, /role="switch"/);

  // Once Elric is in the room, or when adding is blocked, it is the switch.
  const on = renderToStaticMarkup(
    createElement(ElricHeaderSwitch, {
      on: true,
      disabledReason: null,
      change: noop,
      onAdd: () => {},
    }),
  );
  assert.match(on, /role="switch"/);
  assert.doesNotMatch(on, /Add Elric/);
  const blocked = renderToStaticMarkup(
    createElement(ElricHeaderSwitch, {
      on: false,
      disabledReason: 'This room is closed.',
      change: noop,
      onAdd: () => {},
    }),
  );
  assert.match(blocked, /role="switch"/);
  // Without onAdd (Elric was added before) an off switch shows.
  const off = renderToStaticMarkup(
    createElement(ElricHeaderSwitch, { on: false, disabledReason: null, change: noop }),
  );
  assert.match(off, /aria-checked="false"/);
});

test('a host with a step missing gets a usable switch that opens the step, never a disabled one', () => {
  const onDob = async () => null;
  for (const setup of ['google', 'dob'] as const) {
    const html = renderToStaticMarkup(
      createElement(ElricHeaderSwitch, {
        on: false,
        disabledReason: null,
        change: noop,
        setup,
        onDob,
        // Never added: with no Google link there is nothing to add yet, so it is the switch.
        onAdd: setup === 'google' ? () => {} : null,
      }),
    );
    assert.match(html, /<button type="button" role="switch"/);
    assert.match(html, /aria-checked="false"/);
    assert.doesNotMatch(html, /disabled=""/);
    assert.doesNotMatch(html, /title="/);
    assert.match(html, /aria-describedby="/);
    assert.match(
      html,
      setup === 'google' ? /Needs a linked Google account\./ : /Needs your date of birth\./,
    );
    // The popover opens on a click only.
    assert.doesNotMatch(html, /role="dialog"/);
  }
  // No date of birth and never added: the header keeps "+ Add Elric" (it asks the date once).
  const add = renderToStaticMarkup(
    createElement(ElricHeaderSwitch, {
      on: false,
      disabledReason: null,
      change: noop,
      setup: 'dob',
      onDob,
      onAdd: () => {},
    }),
  );
  assert.match(add, /rm-head-add-elric/);
  // Once Elric is in the room the plain switch shows, whatever the step said.
  const on = renderToStaticMarkup(
    createElement(ElricHeaderSwitch, {
      on: true,
      disabledReason: null,
      change: noop,
      setup: 'google',
      onDob,
    }),
  );
  assert.match(on, /aria-checked="true"/);
  assert.doesNotMatch(on, /aria-describedby/);
});
