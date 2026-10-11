import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { PAGE_SOURCES } from '../../shared/seo';

export type Git = (args: string[]) => string;

/**
 * The sitemap's per-page `lastmod` (shared/seo.ts sitemapXml): the date of the last commit that
 * touched one of the page's source files (PAGE_SOURCES). Null, so the sitemap has no dates, when
 * the build has no git or only a shallow clone (Vercel clones shallow): there, a file not changed
 * within the clone's depth would get the clone's boundary commit, a wrong date.
 */
export function gitLastmod(
  root: string,
  warn: (message: string) => void = console.warn,
  git: Git = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe' }),
): ((path: string) => string | null) | null {
  try {
    if (git(['rev-parse', '--is-shallow-repository']).trim() !== 'false') {
      warn('sitemap: shallow git clone, so no lastmod');
      return null;
    }
  } catch {
    warn('sitemap: no git history, so no lastmod');
    return null;
  }
  return (path) => {
    const files = PAGE_SOURCES[path];
    if (!files) return null;
    try {
      const date = git(['log', '-1', '--format=%cI', '--', ...files]).trim();
      return /^\d{4}-\d{2}-\d{2}T/.test(date) ? date.slice(0, 10) : null;
    } catch {
      return null;
    }
  };
}

/** The committed dates (scripts/seo/lastmod.json): path -> the date and the sources it was for. */
export type LastmodMap = Record<string, { date: string; hash: string }>;
export const LASTMOD_FILE = 'scripts/seo/lastmod.json';

/** Every file under the given sources (files or directories), repository-relative and sorted. */
function sourceFiles(root: string, sources: readonly string[]): string[] {
  const out: string[] = [];
  const walk = (relative: string) => {
    const full = join(root, relative);
    if (!existsSync(full)) return;
    if (statSync(full).isDirectory())
      for (const name of readdirSync(full)) walk(`${relative}/${name}`);
    else out.push(relative);
  };
  for (const source of sources) walk(source);
  return [...new Set(out)].sort();
}

/** A hash of a page's sources (names and contents): it changes exactly when the page may have. */
export function sourceHash(root: string, sources: readonly string[]): string {
  const hash = createHash('sha256');
  for (const file of sourceFiles(root, sources)) {
    hash.update(`${file}\0`);
    hash.update(readFileSync(join(root, file)));
    hash.update('\0');
  }
  return hash.digest('hex').slice(0, 16);
}

export function readLastmodMap(root: string): LastmodMap {
  try {
    return JSON.parse(readFileSync(join(root, LASTMOD_FILE), 'utf8')) as LastmodMap;
  } catch {
    return {};
  }
}

/**
 * The committed dates, for builds without full history (Vercel's shallow clone): a page's date
 * counts only while its sources still hash to what was recorded, so a stale entry gives no date
 * rather than a wrong one. `npm run seo:lastmod` refreshes the file; a test keeps it current.
 */
export function committedLastmod(
  root: string,
  map: LastmodMap = readLastmodMap(root),
): (path: string) => string | null {
  return (path) => {
    const entry = map[path];
    const files = PAGE_SOURCES[path];
    if (!entry || !files) return null;
    return entry.hash === sourceHash(root, files) ? entry.date : null;
  };
}

/** The sitemap's dates: git when the history is complete, else the committed map. */
export function pageLastmod(
  root: string,
  warn: (message: string) => void = console.warn,
): (path: string) => string | null {
  const fromGit = gitLastmod(root, warn);
  const committed = committedLastmod(root);
  return fromGit ? (path) => fromGit(path) ?? committed(path) : committed;
}

/**
 * The refreshed map: an unchanged page keeps its date; a changed or new one gets its last
 * commit's date when git knows it and the sources are committed as they are, else `today`.
 */
export function refreshLastmodMap(
  root: string,
  today: string,
  previous: LastmodMap = readLastmodMap(root),
  fromGit: ((path: string) => string | null) | null = gitLastmod(root, () => undefined),
  dirty: (files: readonly string[]) => boolean = (files) => {
    try {
      return (
        execFileSync('git', ['status', '--porcelain', '--', ...files], {
          cwd: root,
          encoding: 'utf8',
          stdio: 'pipe',
        }).trim() !== ''
      );
    } catch {
      return true;
    }
  },
): LastmodMap {
  const next: LastmodMap = {};
  for (const [path, files] of Object.entries(PAGE_SOURCES).sort(([a], [b]) => a.localeCompare(b))) {
    const hash = sourceHash(root, files);
    const kept = previous[path];
    if (kept && kept.hash === hash) next[path] = kept;
    else next[path] = { date: (!dirty(files) && fromGit?.(path)) || today, hash };
  }
  return next;
}
