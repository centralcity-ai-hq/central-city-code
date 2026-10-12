import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
// @ts-expect-error plain ESM script without types
import { UNIT_SHARDS, assignShards, testFiles } from '../scripts/test-shard.mjs';

/*
 * The `changes` job's guard (inline in .github/workflows/check.yml) is what keeps the split
 * `unit` and `browser` jobs from being silently skipped or dropped from `verify`. These tests
 * run that guard against the real workflow and against broken copies of it.
 */

const root = fileURLToPath(new URL('..', import.meta.url));
const workflow = readFileSync(join(root, '.github/workflows/check.yml'), 'utf8').replaceAll(
  '\r\n',
  '\n',
);

function guardScript(text: string) {
  const body = text.split("node --input-type=module <<'NODE'\n")[1]!.split('          NODE\n')[0]!;
  return body
    .split('\n')
    .map((line) => line.slice(10))
    .join('\n');
}

/** Runs the guard from `source` against `text` as the workflow, in a scratch checkout. */
function runGuard(text: string, source = workflow) {
  const dir = mkdtempSync(join(tmpdir(), 'cc-ci-guard-'));
  try {
    mkdirSync(join(dir, '.github/workflows'), { recursive: true });
    writeFileSync(join(dir, '.github/workflows/check.yml'), text);
    cpSync(join(root, 'scripts/test-shard.mjs'), join(dir, 'scripts/test-shard.mjs'));
    symlinkSync(
      join(root, 'tests'),
      join(dir, 'tests'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    return spawnSync(process.execPath, ['--input-type=module'], {
      cwd: dir,
      input: guardScript(source),
      encoding: 'utf8',
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('the changes guard accepts the current workflow', () => {
  const result = runGuard(workflow);
  assert.equal(result.status, 0, result.stderr);
});

const breakages: Array<[string, (text: string) => string]> = [
  [
    'verify forgets a job',
    (text) =>
      text.replace(
        'needs: [changes, secrets, docs, unit, browser, postgres-races, portability]',
        'needs: [changes, secrets, docs, unit, postgres-races, portability]',
      ),
  ],
  [
    'verify forgets the postgres-races job',
    (text) =>
      text.replace(
        'needs: [changes, secrets, docs, unit, browser, postgres-races, portability]',
        'needs: [changes, secrets, docs, unit, browser, portability]',
      ),
  ],
  [
    'verify forgets the docs job',
    (text) =>
      text.replace(
        'needs: [changes, secrets, docs, unit, browser, postgres-races, portability]',
        'needs: [changes, secrets, unit, browser, postgres-races, portability]',
      ),
  ],
  [
    'verify ignores the docs checks',
    (text) => text.replace('[[ "$DOCS_RESULT" == success ]] || exit 1\n', ''),
  ],
  [
    'the docs job loses its docs-only gate',
    (text) =>
      text.replace(
        "    if: needs.changes.outputs.code == 'false' && github.event.pull_request.draft != true\n",
        "    if: needs.changes.outputs.code == 'true'\n",
      ),
  ],
  [
    'the docs checks disappear',
    (text) =>
      // By pattern: the public copy of this workflow runs fewer docs files on the same line.
      text.replace(/      - run: pnpm test:files [^\n]*tests\/public-docs\.test\.ts[^\n]*\n/, ''),
  ],
  [
    'verify ignores the postgres-races result',
    (text) => text.replace(' && "$POSTGRES_RACES_RESULT" == success', ''),
  ],
  [
    'verify ignores the browser result',
    (text) => text.replace(' && "$BROWSER_RESULT" == success', ''),
  ],
  [
    'docs PRs no longer require unit to be skipped',
    (text) => text.replace('"$UNIT_RESULT" == skipped && ', ''),
  ],
  [
    'a heavy job loses its draft/docs gate',
    (text) =>
      text.replace(
        /(  browser:\n    needs: changes\n)    if: needs.changes.outputs.code == 'true'\n/,
        '$1',
      ),
  ],
  [
    'a shard is dropped from the matrix',
    (text) => text.replace('shard: [1, 2, 3, 4, 5, 6]', 'shard: [1, 2, 3, 4, 5]'),
  ],
  [
    'the shard count disagrees with the script',
    (text) =>
      text.replace(
        'pnpm test:shard ${{ matrix.shard }}/6',
        'pnpm test:shard ${{ matrix.shard }}/5',
      ),
  ],
  [
    'browser shards disagree',
    (text) => text.replace('--shard=${{ matrix.shard }}/4', '--shard=${{ matrix.shard }}/5'),
  ],
  ['a check disappears', (text) => text.replace('      - run: pnpm format:check\n', '')],
  [
    'a shard may fail quietly',
    (text) =>
      text.replace(/(  unit:\n(?:.*\n)*?    strategy:\n)/, '$1    continue-on-error: true\n'),
  ],
  [
    'a new job with digits and dashes in its id is added without the guard',
    (text) =>
      text.replace(
        '  portability:\n',
        '  e2e-extra2:\n    runs-on: ubuntu-24.04\n    steps:\n      - run: true\n  portability:\n',
      ),
  ],
  [
    'a new job is added without the guard',
    (text) =>
      text.replace(
        '  portability:\n',
        '  lint:\n    runs-on: ubuntu-24.04\n    steps:\n      - run: true\n  portability:\n',
      ),
  ],
];

for (const [name, mutate] of breakages)
  test(`the changes guard rejects a workflow where ${name}`, () => {
    const broken = mutate(workflow);
    assert.notEqual(broken, workflow, 'the mutation applies');
    assert.notEqual(runGuard(broken).status, 0);
  });

test('unit shards cover every test file exactly once and stay roughly balanced', () => {
  const files: string[] = testFiles();
  const shards: Array<{ files: string[]; seconds: number }> = assignShards(files, UNIT_SHARDS);
  assert.equal(shards.length, UNIT_SHARDS);
  const all = shards.flatMap((shard) => shard.files);
  assert.deepEqual([...all].sort(), files);
  assert.equal(new Set(all).size, files.length);
  const seconds = shards.map((shard) => shard.seconds);
  assert.ok(Math.min(...seconds) > 0, 'no empty shard');
  assert.ok(Math.max(...seconds) <= 1.5 * Math.min(...seconds), `balanced: ${seconds.join(', ')}`);
  // Deterministic: the same inputs give the same split on every runner.
  assert.deepEqual(assignShards([...files].reverse(), UNIT_SHARDS), shards);
});

/** The `paths` step's classifier and its inline regression checks, as a bash script. */
function classifierScript(text: string) {
  const start = text.indexOf('          classify_path() {');
  const end = text.indexOf('          # Draft policy regression checks');
  assert.ok(start > 0 && end > start, 'classifier found');
  return `set -euo pipefail\n${text
    .slice(start, end)
    .split('\n')
    .map((line) => line.slice(10))
    // macOS ships bash 3.2, where a failing [[ ]] does not trigger errexit; CI runs bash 5.
    .map((line) => (line.startsWith('[[') ? `${line} || exit 1` : line))
    .join('\n')}\necho ok\n`;
}

function runClassifier(text: string) {
  return spawnSync('bash', ['-c', classifierScript(text)], { encoding: 'utf8' });
}

test(
  'the docs classifier keeps protocol/ and public/ as code',
  { skip: process.platform === 'win32' },
  () => {
    const result = runClassifier(workflow);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), 'ok');
    for (const kept of ['|public/*)', '|protocol/*)']) {
      const broken = workflow.replace('|protocol/*|public/*)', kept);
      assert.notEqual(broken, workflow);
      assert.notEqual(runClassifier(broken).status, 0, `only ${kept} fails the regression checks`);
    }
  },
);
