import assert from 'node:assert/strict';
import test from 'node:test';
import { capturePrerendered, prerendered, releasePrerendered } from '../src/shell/prerendered.js';

/* src/shell/prerendered.ts: the prerendered #root before React mounts. */

function fakeRoot(html: string, gated: boolean) {
  const attributes = new Set([
    'aria-busy',
    'aria-disabled',
    ...(gated ? ['data-session-gated'] : []),
  ]);
  const root = {
    innerHTML: html,
    cleared: 0,
    hasAttribute: (name: string) => attributes.has(name),
    removeAttribute: (name: string) => void attributes.delete(name),
    replaceChildren: () => {
      root.cleared += 1;
      root.innerHTML = '';
    },
    attributes,
  };
  return root;
}

function withBoot(boot: string | undefined, run: () => void) {
  const previous = (globalThis as { document?: unknown }).document;
  (globalThis as { document?: unknown }).document = { documentElement: { dataset: { boot } } };
  try {
    run();
  } finally {
    (globalThis as { document?: unknown }).document = previous;
  }
}

test('a gated page hidden for a signed-in browser is cleared with replaceChildren', () => {
  const root = fakeRoot('<main>Signed-out copy</main>', true);
  withBoot('app', () => capturePrerendered(root as unknown as HTMLElement));
  assert.equal(root.cleared, 1);
  assert.equal(root.innerHTML, '');
  assert.equal(prerendered(), '');
  assert.ok(!root.attributes.has('data-session-gated'));
  releasePrerendered();
});

test('otherwise the markup is kept for the loading fallback until release', () => {
  const root = fakeRoot('  <main>Copy</main> ', true);
  withBoot(undefined, () => capturePrerendered(root as unknown as HTMLElement));
  assert.equal(root.cleared, 0);
  assert.equal(prerendered(), '<main>Copy</main>');
  releasePrerendered();
  assert.equal(prerendered(), '');
  assert.equal(root.attributes.size, 0);
});
