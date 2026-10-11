/**
 * The public Markdown pages that also have an HTML page for people (/docs/<slug> beside
 * /docs/<slug>.md). Both come from the same renderPublicDoc output, so they never drift: the
 * Markdown file is written by writePublicDocs, and the HTML page renders the parsed tree of the
 * same text, which this Vite plugin serves as the content of src/docs/guide-content.ts (a real
 * placeholder file, so a Vite server without the plugin, and Vite's dependency scan, can still
 * resolve the import; src/docs/Guide.tsx renders it). The tree is parsed here, at build time, with the parser the room
 * Markdown uses (mdast-util-from-markdown with GFM), so the docs chunk ships no parser.
 *
 * vite.config.ts and scripts/prerender/load.ts install the plugin.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Nodes, Root } from 'mdast';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { gfm } from 'micromark-extension-gfm';
import { normalizePath, type Plugin } from 'vite';
import { assertPublicSafe, PUBLIC_DOCS, renderPublicDoc } from './build';

/** Slugs with an HTML page at /docs/<slug>, in sidebar order. */
export const GUIDE_SLUGS = [
  'room-management',
  'coding',
  'microsoft-copilot',
  'mistral-le-chat',
] as const;
export type GuideSlug = (typeof GUIDE_SLUGS)[number];

export interface Guide {
  slug: GuideSlug;
  title: string;
  summary: string;
  tree: Root;
}

/** The placeholder module whose content the plugin replaces. */
const CONTENT_MODULE = 'src/docs/guide-content.ts';

function sourceOf(slug: GuideSlug) {
  const doc = PUBLIC_DOCS.find((entry) => entry.slug === slug);
  if (!doc) throw new Error(`public-doc-guides: no public doc "${slug}"`);
  return doc;
}

/** Drops source positions, so the module is smaller. */
function withoutPositions(root: Root): Root {
  const stack: Nodes[] = [root];
  while (stack.length) {
    const node = stack.pop()!;
    delete node.position;
    if ('children' in node) for (const child of node.children as Nodes[]) stack.push(child);
  }
  return root;
}

/** The parsed Markdown of each guide: exactly the text served at /docs/<slug>.md. */
export function renderGuides(root: string): Guide[] {
  return GUIDE_SLUGS.map((slug) => {
    const doc = sourceOf(slug);
    const markdown = renderPublicDoc(doc, readFileSync(join(root, 'docs', doc.source), 'utf8'));
    assertPublicSafe(`docs/${slug}.md`, markdown);
    const tree = fromMarkdown(markdown, {
      extensions: [gfm()],
      mdastExtensions: [gfmFromMarkdown()],
    });
    return { slug, title: doc.title, summary: doc.summary, tree: withoutPositions(tree) };
  });
}

export function publicDocGuides(root: string): Plugin {
  const content = normalizePath(join(root, CONTENT_MODULE)).toLowerCase();
  return {
    name: 'central-city:public-doc-guides',
    enforce: 'pre',
    load(id) {
      if (normalizePath(id.split('?')[0]!).toLowerCase() !== content) return null;
      for (const slug of GUIDE_SLUGS) this.addWatchFile(join(root, 'docs', sourceOf(slug).source));
      return `export default ${JSON.stringify(renderGuides(root))};`;
    },
  };
}
