/*
 * Counts this repository's own source and test lines, by the same rules as the live code count
 * (shared/code-count.ts: tracked files with a counted extension, non-blank lines, identical files
 * once). Run at build time, where the code is already checked out, so the private application
 * repository counts on every deploy without any GitHub token. Prints one JSON object.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { classifyPath, countLines } from '../shared/code-count.js';

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

/** Tracked files with their git blob ids, or null where git is not available (some CI builds). */
function trackedFiles(): Array<{ path: string; blob: string | null }> | null {
  try {
    const out = execFileSync('git', ['ls-files', '-s', '-z'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out
      .split('\0')
      .filter(Boolean)
      .map((line) => {
        const [meta, path] = line.split('\t');
        return { path: path!, blob: meta!.split(' ')[1] ?? null };
      });
  } catch {
    return null;
  }
}

/** Without git: every file under the source folders, skipping build output and dependencies. */
const SKIP = new Set([
  'node_modules',
  'dist',
  '.git',
  '.vercel',
  '_bundle',
  'test-results',
  'playwright-report',
]);
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(relative(root, full).split('\\').join('/'));
  }
  return out;
}

const tracked = trackedFiles();
// Which way the files were found, for the build log (git where it exists, else a walk).
const source = tracked ? 'git' : 'walk';
const files = tracked ?? walk(root).map((path) => ({ path, blob: null }));
const seen = new Set<string>();
let code = 0;
let tests = 0;
let counted = 0;
for (const { path, blob } of files) {
  const kind = classifyPath(path);
  if (!kind) continue;
  if (blob) {
    if (seen.has(blob)) continue;
    seen.add(blob);
  }
  let text: string;
  try {
    text = readFileSync(join(root, path), 'utf8');
  } catch {
    continue;
  }
  const lines = countLines(text);
  // Binary content (a NUL byte) is not source.
  if (lines === null) continue;
  if (kind === 'tests') tests += lines;
  else code += lines;
  counted += 1;
}
let commit = process.env.VERCEL_GIT_COMMIT_SHA ?? '';
if (!/^[0-9a-f]{40}$/.test(commit)) {
  try {
    commit = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    commit = '';
  }
}
console.log(
  JSON.stringify({
    name: 'central-city',
    source,
    code,
    tests,
    files: counted,
    commit: /^[0-9a-f]{40}$/.test(commit) ? commit : null,
    counted_at: new Date().toISOString(),
  }),
);
