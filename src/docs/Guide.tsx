import guides from './guide-content';
import { markdownHref, MarkdownBody } from './markdown';

/*
 * The docs pages rendered from the public Markdown for AIs (/docs/room-management and
 * /docs/coding beside their .md files). The tree is the parsed text of the .md file
 * (scripts/public-docs/guides.ts), so the two never drift; ./markdown.tsx renders it.
 */

export type GuideSlug = (typeof guides)[number]['slug'];
export const GUIDES = guides;

/** The Markdown pages that have an HTML page; their .md links point at it. */
const GUIDE_MD = new RegExp(`^/docs/(${guides.map((guide) => guide.slug).join('|')})\\.md$`);

/** The link target on the page, or null when the URL is not one we link (it shows as text). */
export function guideHref(url: string): string | null {
  return markdownHref(url, (path) => {
    const guide = GUIDE_MD.exec(path);
    return guide ? `/docs/${guide[1]}` : path;
  });
}

export function Guide({ slug }: { slug: GuideSlug }) {
  const guide = guides.find((item) => item.slug === slug)!;
  return (
    <>
      <p className="docs-source">
        <a href={`/docs/${slug}.md`} type="text/markdown">
          View as Markdown
        </a>
      </p>
      <MarkdownBody tree={guide.tree} href={guideHref} />
    </>
  );
}
