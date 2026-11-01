/*
 * The Markdown parse, shared by the worker (browser) and the tests (Node). It never runs on the
 * page's main thread in the browser: see workerClient.ts.
 */
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { gfm } from 'micromark-extension-gfm';
import type { Nodes, Root } from 'mdast';
import { tooComplexForMarkdown } from './guard';

/** The server's text limit per part; the parser never sees more (DoS bound). */
export const MAX_MARKDOWN_CHARS = 65_536;

export type ParseResult = { tree: Root } | { plain: true };

export function parseMarkdown(text: string): Root {
  return fromMarkdown(text.slice(0, MAX_MARKDOWN_CHARS), {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  });
}

/** Drops source positions (iteratively), so the tree is smaller to send between threads. */
function withoutPositions(root: Root): Root {
  const stack: Nodes[] = [root];
  while (stack.length) {
    const node = stack.pop()!;
    delete node.position;
    if ('children' in node) for (const child of node.children as Nodes[]) stack.push(child);
  }
  return root;
}

/** Guarded parse: plain text for pathological input or any parser failure. */
export function parseSafely(text: string): ParseResult {
  const bounded = text.slice(0, MAX_MARKDOWN_CHARS);
  if (tooComplexForMarkdown(bounded)) return { plain: true };
  try {
    return { tree: withoutPositions(parseMarkdown(bounded)) };
  } catch {
    return { plain: true };
  }
}
