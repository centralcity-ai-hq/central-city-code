import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// The screens import stylesheets (Vite bundles them); under Node a .css import is empty.
registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true };
    return nextLoad(url, context);
  },
});
const { ElricActivityLoadFailed, loadIfCurrent, statusChipLabel } =
  await import('../src/elric/ElricActivity.js');
const { onPageRestore } = await import('../src/pageRestore.js');
const { holdEscape } = await import('../src/agents/v4/settingsShared.js');
const { AGENT_NAME_MAX } = await import('../shared/agent-name.js');
const { assistantAgentSchema } = await import('../server/assistant-access.js');

const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

/** Every element in a rendered tree (function components are not expanded). */
function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...elements(node.props.children as ReactNode)];
}

test('Elric activity: a failed load says the status is unknown and offers Try again', () => {
  assert.equal(statusChipLabel(null, true), 'Status unknown');
  assert.equal(statusChipLabel(null, false), 'Not added');
  assert.equal(statusChipLabel('paused', true), 'Paused');

  let retries = 0;
  const onRetry = () => {
    retries++;
  };
  const html = renderToStaticMarkup(createElement(ElricActivityLoadFailed, { onRetry }));
  assert.match(html, /role="alert"/);
  assert.match(html, /<button type="button"[^>]*>Try again<\/button>/);
  const button = elements(ElricActivityLoadFailed({ onRetry })).find((e) => e.type === 'button');
  assert.ok(button);
  (button.props.onClick as () => void)();
  assert.equal(retries, 1);

  // The retry runs the load effect again.
  assert.match(
    source('src/elric/ElricActivity.tsx'),
    /\[loadStatus, loadTurns, loadPending, attempt\]/,
  );
});

test('Elric activity: a slow answer for an old filter never replaces the new list', async () => {
  const generation = { current: 0 };
  const applied: string[] = [];
  let answerOld!: (value: string) => void;
  let answerNew!: (value: string) => void;

  generation.current += 1; // Room A
  const old = loadIfCurrent(
    generation,
    () => new Promise<string>((resolve) => (answerOld = resolve)),
    (page) => applied.push(page),
  );
  generation.current += 1; // Room B
  const fresh = loadIfCurrent(
    generation,
    () => new Promise<string>((resolve) => (answerNew = resolve)),
    (page) => applied.push(page),
  );
  answerNew('room-b');
  await fresh;
  answerOld('room-a');
  await old;
  assert.deepEqual(applied, ['room-b']);

  // Load more for the old filter, answered after the filter changed, is dropped too.
  let answerMore!: (value: string) => void;
  const more = loadIfCurrent(
    generation,
    () => new Promise<string>((resolve) => (answerMore = resolve)),
    (page) => applied.push(page),
  );
  generation.current += 1;
  answerMore('room-b-page-2');
  await more;
  assert.deepEqual(applied, ['room-b']);

  const page = source('src/elric/ElricActivity.tsx');
  assert.match(page, /generation\.current \+= 1;/);
  assert.match(page, /await loadIfCurrent\(\s*generation,/);
});

test('Continue with Google: a page shown again from the back/forward cache is not busy', () => {
  const target = new EventTarget();
  let resets = 0;
  const stop = onPageRestore(target, () => resets++);
  target.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: false }));
  assert.equal(resets, 0, 'a normal load changes nothing');
  target.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }));
  assert.equal(resets, 1);
  stop();
  target.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }));
  assert.equal(resets, 1, 'removed with the button');

  for (const path of ['src/GoogleAccount.tsx', 'src/elric/ElricSignedOut.tsx'])
    assert.match(
      source(path),
      /onPageRestore\(window, \(\) => setBusy\(false\)\)/,
      `${path} resets busy`,
    );
});

test('Rotate key: Back and Escape stay put while the rotate request runs', () => {
  const target = new EventTarget();
  const escape = () => {
    const event = Object.assign(new Event('keydown', { cancelable: true }), { key: 'Escape' });
    target.dispatchEvent(event);
    return event.defaultPrevented;
  };
  assert.equal(escape(), false);
  const release = holdEscape(target);
  assert.equal(escape(), true, 'the pane and the page see a handled Escape');
  const other = Object.assign(new Event('keydown', { cancelable: true }), { key: 'Enter' });
  target.dispatchEvent(other);
  assert.equal(other.defaultPrevented, false, 'only Escape is held');
  release();
  assert.equal(escape(), false);

  assert.match(
    source('src/agents/v4/RotateKeyScreen.tsx'),
    /backDisabled=\{view\.busy === 'rotate'\}/,
  );
  assert.match(
    source('src/agents/v4/settingsShared.tsx'),
    /useEffect\(\(\) => \(backDisabled \? holdEscape\(window\) : undefined\), \[backDisabled\]\)/,
  );
});

test('agent name fields hold no more than the server accepts', () => {
  const base = { capability: 'research', mode: 'external' } as const;
  assert.equal(
    assistantAgentSchema.safeParse({ ...base, name: 'a'.repeat(AGENT_NAME_MAX) }).success,
    true,
  );
  assert.equal(
    assistantAgentSchema.safeParse({ ...base, name: 'a'.repeat(AGENT_NAME_MAX + 1) }).success,
    false,
  );
  for (const path of ['src/agents/v4/AgentPane.tsx', 'src/agents/v4/AddPane.tsx']) {
    const text = source(path);
    assert.doesNotMatch(text, /maxLength=\{80\}/, path);
    assert.match(text, /aria-label="Name"[\s\S]{0,80}maxLength=\{AGENT_NAME_MAX\}/, path);
  }
});
