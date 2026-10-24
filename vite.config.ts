import { defineConfig, type Plugin } from 'vite';
type OutputBundle = Parameters<NonNullable<Extract<Plugin['generateBundle'], Function>>>[1];
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { writePublicDocs } from './scripts/public-docs/build';
import { publicDocGuides } from './scripts/public-docs/guides';
import { loadPrerender } from './scripts/prerender/load';
import { fetchBuildHomeStats } from './scripts/prerender/agent-count';
import {
  homeHtml,
  SHARE_CARDS,
  shareCardHtml,
  shareCardLive,
  withShareCard,
} from './shared/share-cards';
import { APP_SHELL } from './shared/routes';
import { sitemapXml, withStructuredData } from './shared/seo';
import { pageLastmod } from './scripts/seo/lastmod';

const fontSource = 'src/shell/fonts/inter-latin-wght-normal.woff2';

/**
 * Preloads the one font file (DESIGN_SYSTEM §1.2) by its built, hashed URL, so it can be cached
 * as immutable. In dev the unhashed source path is preloaded instead.
 */
function preloadFont(): Plugin {
  const tag = (href: string) => ({
    tag: 'link',
    attrs: { rel: 'preload', href, as: 'font', type: 'font/woff2', crossorigin: '' },
    injectTo: 'head' as const,
  });
  return {
    name: 'central-city:preload-font',
    transformIndexHtml(_html, context) {
      if (!context.bundle) return [tag(`/${fontSource}`)];
      const asset = Object.values(context.bundle).find(
        (output) =>
          output.type === 'asset' &&
          output.originalFileNames.some((name) => name.endsWith(fontSource)),
      );
      if (!asset) throw new Error(`preload-font: ${fontSource} is not in the bundle`);
      return [tag(`/${asset.fileName}`)];
    },
  };
}

/**
 * Applies the visitor's theme before the first paint (src/shell/theme-boot.js): a classic script
 * in <head>, which holds rendering until it has run. The Content Security Policy
 * allows no inline scripts, so it is a file, emitted with a hashed name so it can be cached as
 * immutable. In dev the source file is loaded instead.
 */
function themeBoot(): Plugin {
  const source = 'src/shell/theme-boot.js';
  const tag = (src: string) => ({
    tag: 'script',
    attrs: { src },
    injectTo: 'head' as const,
  });
  return {
    name: 'central-city:theme-boot',
    buildStart() {
      if (this.meta.watchMode) return;
      this.emitFile({
        type: 'asset',
        name: 'theme-boot.js',
        originalFileName: source,
        source: readFileSync(new URL(source, import.meta.url), 'utf8'),
      });
    },
    transformIndexHtml(_html, context) {
      if (!context.bundle) return [tag(`/${source}`)];
      const asset = Object.values(context.bundle).find(
        (output) => output.type === 'asset' && output.originalFileNames.includes(source),
      );
      if (!asset) throw new Error(`theme-boot: ${source} is not in the bundle`);
      return [tag(`/${asset.fileName}`)];
    },
  };
}

/**
 * Writes the public Markdown docs for AIs (dist/docs/*.md, dist/docs.md) from docs/*.md after
 * the bundle; see scripts/public-docs/build.ts. A page that fails the public-safety check fails
 * the build.
 */
function publicDocs(): Plugin {
  return {
    name: 'central-city:public-docs',
    apply: 'build',
    writeBundle(options) {
      writePublicDocs(fileURLToPath(new URL('.', import.meta.url)), options.dir ?? 'dist');
    },
  };
}

/**
 * Emits a copy of index.html per share card (shared/share-cards.ts) with that route's head, so
 * crawlers, which do not run JavaScript, see each page's own title and link preview. The public
 * content pages (src/prerender.tsx) also get their rendered markup inside #root, so their text is
 * in the first HTML; a page that fails to render keeps the plain shell, with a warning.
 * A card whose page is switched off for this deployment (shareCardLive: the Feed while CITY_FEED
 * is 0, its emergency off) gets the plain shell instead, as its route is the app's 404.
 * vercel.json and server/index.ts serve the copy for the route. index.html ("/") gets the
 * signed-out landing; the plain shell every other client route uses is app.html.
 */
/** The module whose lazy chunk renders a prerendered route (src/prerender.tsx), for its CSS. */
function prerenderedPageModule(path: string): string | null {
  if (/^\/docs(?:\/(?:start|rooms|room-management|coding|api))?$/.test(path))
    return 'src/docs/DocsPages.tsx';
  if (path === '/') return 'src/Landing.tsx';
  if (path === '/elric') return 'src/elric/ElricSignedOut.tsx';
  if (path === '/connect') return 'src/Connect.tsx';
  if (path === '/invite') return 'src/Invite.tsx';
  if (path === '/downtown') return 'src/Downtown.tsx';
  if (path === '/downtown/verify') return 'src/verify/VerifyPage.tsx';
  if (path === '/explorer' || path === '/downtown/log') return 'src/verify/LiveLog.tsx';
  if (path === '/workflows') return 'src/WorkflowsPage.tsx';
  if (/^\/use-cases(?:\/[a-z-]+)?$/.test(path)) return 'src/use-cases/UseCasePage.tsx';
  return 'src/Trust.tsx';
}

/**
 * The stylesheets of the chunk that contains `module` and of the chunks it imports, so the
 * prerendered markup is styled from the first paint instead of shifting when the lazy chunk's
 * CSS arrives.
 */
function chunkCss(bundle: OutputBundle, module: string): string[] {
  const chunks = Object.values(bundle).filter((item) => item.type === 'chunk');
  const start = chunks.find((chunk) =>
    Object.keys(chunk.modules).some((id) => id.replace(/\\/g, '/').endsWith(`/${module}`)),
  );
  const css = new Set<string>();
  const seen = new Set<string>();
  const visit = (fileName: string) => {
    if (seen.has(fileName)) return;
    seen.add(fileName);
    const chunk = bundle[fileName];
    if (!chunk || chunk.type !== 'chunk') return;
    for (const file of chunk.viteMetadata?.importedCss ?? []) css.add(file);
    for (const imported of chunk.imports) visit(imported);
  };
  if (start) visit(start.fileName);
  return [...css];
}

function withStylesheets(html: string, files: string[]): string {
  const links = files
    .filter((file) => !html.includes(`/${file}"`))
    .map((file) => `<link rel="stylesheet" crossorigin href="/${file}">`)
    .join('');
  return links ? html.replace('</head>', `${links}</head>`) : html;
}

function shareCards(): Plugin {
  return {
    name: 'central-city:share-cards',
    apply: 'build',
    enforce: 'post',
    async generateBundle(_options, bundle) {
      const index = bundle['index.html'];
      if (!index || index.type !== 'asset') throw new Error('share-cards: no index.html');
      const html = String(index.source);
      const warn = (message: string) => this.warn(message);
      // The landing's agent count, read once for this build (never per request) and never failing
      // it: without a count the landing is built as before (scripts/prerender/agent-count.ts). The
      // same response gives the Base agents number and says whether to reserve the paid service
      // calls line (never a number).
      const homeStats = fetchBuildHomeStats({ warn });
      let prerender: Awaited<ReturnType<typeof loadPrerender>> | null = null;
      try {
        prerender = await loadPrerender(fileURLToPath(new URL('.', import.meta.url)));
      } catch (error) {
        warn(`share-cards: prerender unavailable, serving plain shells (${String(error)})`);
      }
      try {
        for (const card of SHARE_CARDS) {
          if (!shareCardLive(card, process.env)) {
            this.emitFile({ type: 'asset', fileName: card.shell, source: html });
            continue;
          }
          let source = withShareCard(html, card);
          if (prerender) {
            const page = shareCardHtml(html, card, prerender.render, warn);
            const module = page.prerendered ? prerenderedPageModule(card.path) : null;
            source = module ? withStylesheets(page.html, chunkCss(bundle, module)) : page.html;
          }
          source = withStructuredData(source, card);
          this.emitFile({ type: 'asset', fileName: card.shell, source });
        }
        this.emitFile({ type: 'asset', fileName: APP_SHELL.slice(1), source: html });
        if (prerender) {
          const stats = await homeStats;
          prerender.setAgentCount(stats.count);
          prerender.setBaseAgents(stats.base);
          prerender.setPaidCallsLine(stats.paidCalls);
          const home = homeHtml(html, prerender.render, warn);
          index.source = home.prerendered
            ? withStylesheets(home.html, chunkCss(bundle, prerenderedPageModule('/')!))
            : home.html;
        }
        // The sitemap lists exactly the public pages (shared/seo.ts), each dated with the last
        // commit of its source files when the build has the full git history, else with the
        // committed scripts/seo/lastmod.json (Vercel clones shallow), else undated.
        this.emitFile({
          type: 'asset',
          fileName: 'sitemap.xml',
          source: sitemapXml(pageLastmod(fileURLToPath(new URL('.', import.meta.url)), warn)),
        });
      } finally {
        await prerender?.close();
      }
    },
  };
}

/**
 * Workers have no DOM. `decode-named-character-reference` (used by the Markdown parser, which runs
 * only in src/rooms/markdown/parse.worker.ts) picks a DOM-based build under the browser
 * condition, which throws in a worker. Alias it to its plain build, resolved from the parser's
 * own dependency chain (pnpm keeps it a transitive dependency).
 */
const fromParser = [
  'mdast-util-from-markdown',
  'micromark-util-decode-string',
  'decode-named-character-reference',
].reduce((base, name) => createRequire(base).resolve(name), fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [
    react(),
    themeBoot(),
    preloadFont(),
    publicDocGuides(fileURLToPath(new URL('.', import.meta.url))),
    publicDocs(),
    shareCards(),
  ],
  resolve: { alias: [{ find: /^decode-named-character-reference$/, replacement: fromParser }] },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: { '/api': 'http://127.0.0.1:4310' },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    // scripts/bundle-budget/check.mjs reads dist/.vite/manifest.json (DESIGN_SYSTEM §5, E4).
    manifest: true,
    // Keep the font a separate, hashed file even though it is small enough to inline.
    assetsInlineLimit: (file) => (file.endsWith('.woff2') ? false : undefined),
    rolldownOptions: {
      output: {
        // The vendor chunk (react, react-dom, scheduler), cached across deploys and routes.
        // codeSplitting.groups is the current name of advancedChunks.groups in Rolldown.
        codeSplitting: {
          groups: [
            {
              name: 'vendor',
              test: /[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/,
              priority: 10,
            },
          ],
        },
      },
    },
  },
});
