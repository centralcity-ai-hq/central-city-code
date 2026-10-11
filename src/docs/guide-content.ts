import type { Root } from 'mdast';

/*
 * The parsed public Markdown guides (/docs/room-management, /docs/coding). This file is a real
 * module so every Vite server and its dependency scan can resolve the import, but its content
 * is replaced by the `publicDocGuides` plugin (scripts/public-docs/guides.ts) with the parsed
 * text of the .md files. A server without the plugin fails loudly here instead of rendering
 * empty pages.
 */

export interface PublicDocGuide {
  slug: 'room-management' | 'coding' | 'microsoft-copilot' | 'mistral-le-chat';
  title: string;
  summary: string;
  tree: Root;
}

function withoutPlugin(): never {
  throw new Error('src/docs/guide-content.ts needs the publicDocGuides Vite plugin');
}

const guides: readonly PublicDocGuide[] = withoutPlugin();
export default guides;
