import type { Root } from 'mdast';

/*
 * The parsed text of /docs/audit.md (docs/AUDIT.md), shown on /audit (./Audit.tsx). As with
 * src/docs/guide-content.ts, this file is a real module so every Vite server and its dependency
 * scan can resolve the import, but its content is replaced by the `publicDocGuides` plugin
 * (scripts/public-docs/guides.ts). A server without the plugin fails loudly here instead of
 * rendering an empty page.
 */

function withoutPlugin(): never {
  throw new Error('src/trust/audit-content.ts needs the publicDocGuides Vite plugin');
}

const audit: Root = withoutPlugin();
export default audit;
