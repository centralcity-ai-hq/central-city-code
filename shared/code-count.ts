/**
 * The lines of code Central City is made of, as Downtown shows them (GET /api/public/code).
 *
 * What is counted:
 * - the public repositories below, each at the head commit of its default branch;
 * - non-blank lines of tracked source and test files (CODE_EXTENSIONS);
 * - nothing under SKIPPED_DIRS, no lockfiles, no minified files, no file with a NUL byte;
 * - identical files once across all repositories (by git blob id): the toolkit is mostly a synced
 *   copy of paths in central-city-code.
 *
 * The counter is plain functions, so the server, the tests and anyone re-running it by hand get
 * the same number. Measured on 24 Oct 2026: 293,624 code + 259,967 tests = 553,591 lines.
 */

export const CODE_COUNT_OWNER = 'centralcity-ai-hq';

/** Counted in this order: a file seen in an earlier repository is not counted again. */
export const CODE_COUNT_REPOS = [
  'central-city-code',
  'protocol',
  'toolkit',
  'sdk-ts',
  'examples',
  'conformance',
  'transparency',
] as const;
export type CodeCountRepo = (typeof CODE_COUNT_REPOS)[number];

export const CODE_EXTENSIONS: ReadonlySet<string> = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.mjs',
  '.cjs',
  '.jsx',
  '.sol',
  '.sql',
  '.css',
  '.html',
  '.sh',
]);

const SKIPPED_DIRS = /(^|\/)(node_modules|dist|build|coverage|vendor|\.next)\//;
const LOCKFILES = /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/;
const MINIFIED = /\.min\.(js|css)$/;
const TEST_PATH = /(^|\/)(tests?|__tests__|e2e|spec)\/|\.(test|spec)\.[cm]?[jt]sx?$/;

export type CodeKind = 'code' | 'tests';

/** Whether a repository path is counted, and as what. */
export function classifyPath(path: string): CodeKind | null {
  if (SKIPPED_DIRS.test(path) || LOCKFILES.test(path) || MINIFIED.test(path)) return null;
  const dot = path.lastIndexOf('.');
  const slash = path.lastIndexOf('/');
  if (dot <= slash + 1) return null;
  if (!CODE_EXTENSIONS.has(path.slice(dot).toLowerCase())) return null;
  return TEST_PATH.test(path) ? 'tests' : 'code';
}

/** Non-blank lines; null for binary content (a NUL byte), which is never counted. */
export function countLines(text: string): number | null {
  if (text.includes('\u0000')) return null;
  let lines = 0;
  for (const line of text.split('\n')) if (line.trim() !== '') lines++;
  return lines;
}

/**
 * The application repository itself (private). It is counted when the app is built
 * (scripts/app-code-count.ts), where its code is already checked out, so it needs no GitHub token
 * and the count moves with every deploy. Its public copy, central-city-code, is an older subset of
 * it, so with the app counted that copy is left out (no line counted twice).
 */
export const APP_REPO = 'central-city';
export type AppCodeCount = {
  name: typeof APP_REPO;
  code: number;
  tests: number;
  files: number;
  /** The deployed commit (null where the build could not tell). */
  commit: string | null;
  /** When the build counted it (ISO 8601). */
  counted_at: string;
};

export interface CodeCountRepoResult {
  name: CodeCountRepo | typeof APP_REPO;
  /** The full commit id that was counted. */
  commit: string;
  code: number;
  tests: number;
  /** Unique files counted in this repository (files already seen in an earlier one are not). */
  files: number;
  /** Files over the size limit (2 MB), not counted. Shown, so a count is never silently partial. */
  skipped: number;
}

/** The public answer of GET /api/public/code. */
export interface CodeCount {
  total: number;
  code: number;
  tests: number;
  files: number;
  /** Files over the size limit across all repositories (see CodeCountRepoResult.skipped). */
  skipped_files: number;
  /** When this count was made (ISO 8601); with the app counted, the later of the two counts. */
  counted_at: string;
  repos: CodeCountRepoResult[];
}

/**
 * The public repositories' stored count with the application repository's build count in place
 * of its public copy (central-city-code). Without a build count, the stored count unchanged.
 */
export function withAppCount(count: CodeCount, app: AppCodeCount | null): CodeCount {
  if (!app) return count;
  const repos: CodeCountRepoResult[] = [
    {
      name: APP_REPO,
      commit: app.commit ?? '',
      code: app.code,
      tests: app.tests,
      files: app.files,
      skipped: 0,
    },
    ...count.repos.filter((repo) => repo.name !== 'central-city-code'),
  ];
  const sum = (key: 'code' | 'tests' | 'files' | 'skipped') =>
    repos.reduce((total, repo) => total + repo[key], 0);
  const code = sum('code');
  const tests = sum('tests');
  return {
    total: code + tests,
    code,
    tests,
    files: sum('files'),
    skipped_files: sum('skipped'),
    counted_at:
      Date.parse(app.counted_at) > Date.parse(count.counted_at) ? app.counted_at : count.counted_at,
    repos,
  };
}
