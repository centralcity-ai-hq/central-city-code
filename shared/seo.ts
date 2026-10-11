/**
 * Search indexing: the list of public, indexable pages, the sitemap built from it, and the
 * per-page structured data (JSON-LD) the build adds to each page's head.
 *
 * The public pages are "/" plus every share card (shared/share-cards.ts) that is its own
 * canonical page; an alias such as /docs/start or /downtown/log points its canonical elsewhere and
 * is left out. App routes (rooms, settings, …) have no share card and are not indexed.
 */

import { SHARE_CARDS, SITE, type ShareCard } from './share-cards.js';
import { USE_CASES, useCasePath } from './use-cases.js';

/** The paths a search engine should index, "/" first, in share-card order. */
export const PUBLIC_PATHS: readonly string[] = Object.freeze([
  '/',
  ...SHARE_CARDS.filter((card) => card.canonical === `${SITE}${card.path}`).map(
    (card) => card.path,
  ),
]);

const xmlEscape = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const TRUST_SOURCES: Record<string, string> = {
  '/about': 'src/trust/About.tsx',
  '/contact': 'src/trust/Contact.tsx',
  '/support': 'src/trust/Support.tsx',
  '/status': 'src/trust/Status.tsx',
  '/security': 'src/trust/Security.tsx',
  '/privacy': 'src/trust/Privacy.tsx',
  '/privacy-choices': 'src/trust/PrivacyChoices.tsx',
  '/terms': 'src/trust/Terms.tsx',
  '/acceptable-use': 'src/trust/AcceptableUse.tsx',
  '/dpa': 'src/trust/Dpa.tsx',
  '/imprint': 'src/trust/Imprint.tsx',
};

/**
 * The files (relative to the repository root) whose content each public page shows: a page's
 * sitemap `lastmod` is the last commit that touched one of them (scripts/seo/lastmod.ts).
 */
export const PAGE_SOURCES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  '/': ['src/Landing.tsx', 'src/landing', 'src/trust/common.tsx'],
  '/elric': ['src/elric/ElricSignedOut.tsx'],
  '/explorer': ['src/verify/LiveLog.tsx'],
  '/explorer/base': ['src/verify/OnBase.tsx'],
  '/connect': ['src/Connect.tsx', 'src/shell/roomInvite.ts'],
  '/invite': ['src/Invite.tsx'],
  '/workflows': ['src/WorkflowsPage.tsx'],
  '/docs': ['src/docs/DocsPages.tsx'],
  '/docs/rooms': ['src/docs/DocsPages.tsx'],
  '/docs/room-management': ['docs/ROOM_MANAGEMENT.md'],
  '/docs/coding': ['docs/CODING_IN_ROOMS.md'],
  '/docs/microsoft-copilot': ['docs/MICROSOFT_COPILOT.md'],
  '/docs/mistral-le-chat': ['docs/MISTRAL_LE_CHAT.md'],
  '/docs/api': ['src/docs/DocsPages.tsx'],
  '/use-cases': ['shared/use-cases.ts'],
  ...Object.fromEntries(
    USE_CASES.map((entry) => [
      useCasePath(entry.slug),
      ['shared/use-cases.ts', 'src/use-cases/content.ts'],
    ]),
  ),
  '/downtown': ['src/Downtown.tsx'],
  '/downtown/verify': ['src/verify/VerifyPage.tsx'],
  ...Object.fromEntries(Object.entries(TRUST_SOURCES).map(([path, file]) => [path, [file]])),
});

/**
 * sitemap.xml listing exactly PUBLIC_PATHS. A page gets `lastmod` (YYYY-MM-DD) only when
 * `lastmod` knows when its content last changed; a build date would re-date every page on each
 * deploy, which search engines learn to ignore.
 */
export function sitemapXml(lastmod: ((path: string) => string | null) | null = null): string {
  const urls = PUBLIC_PATHS.map((path) => {
    const date = lastmod?.(path) ?? null;
    if (date !== null && !/^\d{4}-\d{2}-\d{2}$/.test(date))
      throw new Error(`sitemap: bad lastmod ${date} for ${path}`);
    const loc = `<loc>${xmlEscape(`${SITE}${path}`)}</loc>`;
    return `  <url>${loc}${date ? `<lastmod>${date}</lastmod>` : ''}</url>`;
  });
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...urls,
    '</urlset>',
    '',
  ].join('\n');
}

const DOCS_TITLE = 'Docs';

/**
 * The page's JSON-LD: a WebPage that belongs to the site (index.html declares the WebSite and
 * Organization), plus a BreadcrumbList for the docs pages below /docs.
 */
export function structuredData(card: ShareCard): Record<string, unknown> {
  const graph: Array<Record<string, unknown>> = [
    {
      '@type': 'WebPage',
      '@id': `${card.canonical}#webpage`,
      url: card.canonical,
      name: card.title,
      description: card.description,
      inLanguage: 'en',
      isPartOf: { '@id': `${SITE}/#website` },
    },
  ];
  const docsPage = card.canonical.startsWith(`${SITE}/docs/`);
  if (docsPage) {
    graph.push({
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Central City', item: `${SITE}/` },
        { '@type': 'ListItem', position: 2, name: DOCS_TITLE, item: `${SITE}/docs` },
        {
          '@type': 'ListItem',
          position: 3,
          name: card.title.replace(/ · Central City Docs$/, ''),
          item: card.canonical,
        },
      ],
    });
  }
  return { '@context': 'https://schema.org', '@graph': graph };
}

/** `structuredData` as a <script> tag; `<` is escaped so no value can close the element. */
export function structuredDataTag(card: ShareCard): string {
  const json = JSON.stringify(structuredData(card)).replace(/</g, '\\u003c');
  return `<script type="application/ld+json" data-page>${json}</script>`;
}

/** `html` with the page's JSON-LD added at the end of its <head>. */
export function withStructuredData(html: string, card: ShareCard): string {
  if (html.split('</head>').length !== 2)
    throw new Error(`share card ${card.path}: no single </head>`);
  return html.replace('</head>', () => `${structuredDataTag(card)}</head>`);
}
