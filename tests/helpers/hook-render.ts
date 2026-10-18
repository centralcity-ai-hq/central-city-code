import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { registerHooks } from 'node:module';

/*
 * Import this before a component (with a dynamic import) to test its hooks under Node: files in
 * src/ get tests/helpers/fake-react.ts for 'react' (hooks that run in tests), and stylesheet
 * imports are empty. Render with TestRoot from that file.
 */
const fakeReact = new URL('./fake-react.ts', import.meta.url).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'react' && context.parentURL && /\/src\//.test(context.parentURL))
      return { url: fakeReact, shortCircuit: true };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true };
    return nextLoad(url, context);
  },
});

export { TestRoot } from './fake-react.js';

/** Every element in a rendered tree (function components are not called). */
export function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap((child) => elements(child as ReactNode));
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...elements(node.props.children as ReactNode)];
}

/** The text inside an element tree. */
export function text(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map((child) => text(child as ReactNode)).join('');
  if (!isValidElement<Record<string, unknown>>(node)) return '';
  return text(node.props.children as ReactNode);
}

/** The first button whose text is `label`. */
export function button(node: ReactNode, label: string) {
  return elements(node).find((element) => element.type === 'button' && text(element) === label);
}
