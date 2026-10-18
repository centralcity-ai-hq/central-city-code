import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { registerHooks } from 'node:module';

// The sheet imports stylesheets (Vite bundles them); under Node a .css import is empty.
registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true };
    return nextLoad(url, context);
  },
});
const { ManageElricLoadFailed } = await import('../src/elric/ManageElricSheet.js');

/** Every element in a rendered tree (function components are not expanded). */
function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...elements(node.props.children as ReactNode)];
}

test('a failed settings load says so and offers a "Try again" button that reloads', () => {
  let retries = 0;
  const onRetry = () => {
    retries++;
  };
  const html = renderToStaticMarkup(createElement(ManageElricLoadFailed, { onRetry }));
  assert.match(html, /role="alert"/);
  assert.match(html, /couldn’t be loaded/);
  assert.match(html, /<button type="button"[^>]*>Try again<\/button>/);

  const button = elements(ManageElricLoadFailed({ onRetry })).find((e) => e.type === 'button');
  assert.ok(button, 'a retry button is drawn');
  (button.props.onClick as () => void)();
  assert.equal(retries, 1, 'the button asks for the settings again');
});
