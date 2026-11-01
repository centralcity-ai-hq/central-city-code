import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

/**
 * Bundles the Vercel function (server/vercel-handler.ts and everything it imports) into
 * api/_bundle/index.mjs, which api/index.js re-exports. Files under api/ starting with `_` are
 * not deployed as functions of their own.
 *
 * No environment value or secret is defined at build time: process.env is read at runtime. The one
 * build-time value is __CITY_APP_CODE__, the line count of this repository's own checked-out code
 * (scripts/app-code-count.ts; derived from the source, nothing secret), so the live code count
 * moves with every deploy. If counting fails the build goes on and only the public repositories
 * count. Only modules that cannot or need not be bundled stay external:
 * - @electric-sql/pglite: the local embedded database, loaded lazily and never on Vercel (it
 *   ships WebAssembly and data files next to its code);
 * - pg-native: an optional native binding `pg` only loads when asked to.
 */
const root = fileURLToPath(new URL('..', import.meta.url));
const outdir = `${root}api/_bundle`;

await rm(outdir, { recursive: true, force: true });

/** The application repository's own lines, counted now; null if it cannot be counted. */
function appCodeCount() {
  try {
    const out = execFileSync(process.execPath, ['--import', 'tsx', 'scripts/app-code-count.ts'], {
      cwd: root,
      encoding: 'utf8',
      timeout: 120_000,
    });
    const count = JSON.parse(out.trim().split('\n').pop());
    const whole = (n) => Number.isSafeInteger(n) && n >= 0;
    if (
      count.name !== 'central-city' ||
      !whole(count.code) ||
      !whole(count.tests) ||
      !whole(count.files)
    )
      throw new Error('malformed');
    // The source (git or walk) is only logged, never shipped.
    const { source, ...rest } = count;
    console.log(`app code count from ${source}`);
    return rest;
  } catch (error) {
    console.warn(`app code count skipped: ${error instanceof Error ? error.message : error}`);
    return null;
  }
}
const appCode = appCodeCount();
if (appCode)
  console.log(
    `app code count: ${appCode.code + appCode.tests} lines at ${appCode.commit ?? 'unknown commit'}`,
  );

const result = await build({
  absWorkingDir: root,
  // The PDF text worker is its own entry: pdf-text.ts starts it as ./pdf-worker.mjs.
  entryPoints: { index: 'server/vercel-handler.ts', 'pdf-worker': 'server/rooms/pdf-worker.ts' },
  outdir,
  outExtension: { '.js': '.mjs' },
  bundle: true,
  splitting: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  minify: true,
  // errorFacts logs the error's class name: minified, a 500 line would only say "Hn".
  keepNames: true,
  sourcemap: true,
  legalComments: 'none',
  external: ['@electric-sql/pglite', '@electric-sql/pglite/*', 'pg-native'],
  ...(appCode ? { define: { __CITY_APP_CODE__: JSON.stringify(appCode) } } : {}),
  // Bundled CommonJS dependencies call require() for Node built-ins.
  banner: {
    js: "import{createRequire as __cityRequire}from'node:module';const require=__cityRequire(import.meta.url);",
  },
  metafile: true,
  logLevel: 'warning',
});
const bytes = Object.values(result.metafile.outputs).reduce((sum, output) => sum + output.bytes, 0);
console.log(
  `api bundle: ${Object.keys(result.metafile.outputs).length} files, ${(bytes / 1e6).toFixed(2)} MB`,
);
