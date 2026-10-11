import { build } from 'esbuild';
import { rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

/**
 * Bundles the Vercel function (server/vercel-handler.ts and everything it imports) into
 * api/_bundle/index.mjs, which api/index.js re-exports. Files under api/ starting with `_` are
 * not deployed as functions of their own.
 *
 * Nothing is defined at build time: process.env is read at runtime, so no environment value or
 * secret can be inlined. Only modules that cannot or need not be bundled stay external:
 * - @electric-sql/pglite: the local embedded database, loaded lazily and never on Vercel (it
 *   ships WebAssembly and data files next to its code);
 * - pg-native: an optional native binding `pg` only loads when asked to.
 */
const root = fileURLToPath(new URL('..', import.meta.url));
const outdir = `${root}api/_bundle`;

await rm(outdir, { recursive: true, force: true });
const result = await build({
  absWorkingDir: root,
  entryPoints: { index: 'server/vercel-handler.ts' },
  outdir,
  outExtension: { '.js': '.mjs' },
  bundle: true,
  splitting: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  minify: true,
  sourcemap: true,
  legalComments: 'none',
  external: ['@electric-sql/pglite', '@electric-sql/pglite/*', 'pg-native'],
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
