import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const script = path.resolve('scripts/check-secrets.mjs');
const available = Boolean(process.env.GITLEAKS_BIN);
const options = { skip: !available && !process.env.CI, timeout: 30_000 };

function fixture(t: { after: (callback: () => void) => void }) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'central-city-scan-test-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(directory)), fs.realpathSync(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('central-city-scan-test-'));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const git = (...args: string[]) => {
    const result = spawnSync('git', args, { cwd: directory, encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, 'Synthetic repository operation failed.');
  };
  git('init', '--quiet');
  git('config', 'user.name', 'Synthetic scanner test');
  git('config', 'user.email', 'scanner-test@example.invalid');
  const commit = () => {
    git('add', '.');
    git('commit', '--quiet', '-m', 'Synthetic fixture');
  };
  const scan = () =>
    spawnSync(process.execPath, [script, '--source', directory], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 20_000,
      env: process.env,
    });
  fs.writeFileSync(
    path.join(directory, 'README.md'),
    'Synthetic scanner fixture with no credentials.\n',
  );
  commit();
  return { directory, commit, git, scan };
}

function syntheticTokens() {
  // Assembled at runtime so the real repository does not contain the fixture secrets.
  return [
    'gh' + 'p_' + 'A9b8C7d6E5f4G3h2I1j0K9l8M7n6O5p4Q3r2',
    'sk_' + 'live_' + '8Fj7sQ2rW9mP4aT6vH1kN3dL5cB0xZ',
  ];
}

test('secret scanner fails closed when the scanner executable is unavailable', options, (t) => {
  const f = fixture(t);
  const result = spawnSync(process.execPath, [script, '--source', f.directory], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 20_000,
    env: { ...process.env, GITLEAKS_BIN: path.join(f.directory, 'missing-scanner') },
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /failed closed/);
});

test('comprehensive secret scanner accepts an ordinary synthetic repository', options, (t) => {
  const result = fixture(t).scan();
  assert.equal(result.status, 0, 'Verified scanner must run successfully.');
  const report = JSON.parse(result.stdout);
  assert.equal(report.results.length, 2);
  assert.ok(report.results.every((phase: { findings: number }) => phase.findings === 0));
});

test('secret scanner detects multiple provider patterns without exposing values', options, (t) => {
  const f = fixture(t);
  const tokens = syntheticTokens();
  fs.writeFileSync(
    path.join(f.directory, 'synthetic.env'),
    `GITHUB_TOKEN=${tokens[0]}\nSTRIPE_KEY=${tokens[1]}\n`,
  );
  f.commit();
  const result = f.scan();
  assert.equal(result.status, 1, 'Synthetic provider credentials must fail the scan.');
  const report = JSON.parse(result.stdout);
  const rules = new Set(report.results.flatMap((phase: { rules: string[] }) => phase.rules));
  assert.ok(rules.has('github-pat'));
  assert.ok(rules.has('stripe-access-token'));
  for (const token of tokens)
    assert.ok(
      !`${result.stdout}${result.stderr}`.includes(token),
      'No finding value may escape into output.',
    );
});

test('secret scanner finds a deleted credential in repository history', options, (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.directory, 'removed.env'), `GITHUB_TOKEN=${syntheticTokens()[0]}\n`);
  f.commit();
  fs.unlinkSync(path.join(f.directory, 'removed.env'));
  f.commit();
  const result = f.scan();
  assert.equal(result.status, 1);
  const report = JSON.parse(result.stdout);
  assert.ok(
    report.results.find((phase: { phase: string }) => phase.phase === 'history').findings > 0,
  );
  assert.equal(
    report.results.find((phase: { phase: string }) => phase.phase === 'current-files').findings,
    0,
  );
});

test('secret scanner includes untracked files and rejects inline suppression', options, (t) => {
  const f = fixture(t);
  fs.writeFileSync(
    path.join(f.directory, 'untracked.txt'),
    `token=${syntheticTokens()[0]} # gitleaks:allow\n`,
  );
  const result = f.scan();
  assert.equal(result.status, 1);
  const report = JSON.parse(result.stdout);
  assert.equal(
    report.results.find((phase: { phase: string }) => phase.phase === 'history').findings,
    0,
  );
  assert.ok(
    report.results.find((phase: { phase: string }) => phase.phase === 'current-files').findings > 0,
  );
});

test('secret scanner detects Central City agent credentials', options, (t) => {
  const f = fixture(t);
  // Assembled at runtime: the prefixes plus 43 base64url characters.
  const body = 'Q7w' + 'E9r'.repeat(13) + 'x';
  const values = ['cc' + 'rt_' + body, 'cc' + 'ag_' + body.split('').reverse().join('')];
  fs.writeFileSync(path.join(f.directory, 'notes.txt'), `${values.join('\n')}\n`);
  f.commit();
  const result = f.scan();
  assert.equal(result.status, 1);
  const report = JSON.parse(result.stdout);
  const rules = new Set(report.results.flatMap((phase: { rules: string[] }) => phase.rules));
  assert.ok(rules.has('central-city-agent-credential'));
  for (const value of values) assert.ok(!`${result.stdout}${result.stderr}`.includes(value));
});

test('a reviewed history waiver hides only that exact history finding', options, (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.directory, 'removed.env'), `GITHUB_TOKEN=${syntheticTokens()[0]}\n`);
  f.commit();
  const added = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: f.directory,
    encoding: 'utf8',
  }).stdout.trim();
  fs.unlinkSync(path.join(f.directory, 'removed.env'));
  f.commit();
  const phase = (result: ReturnType<typeof f.scan>, name: string) =>
    JSON.parse(result.stdout).results.find((p: { phase: string }) => p.phase === name).findings;
  // The exact fingerprint, with a reason: the history phase passes.
  fs.writeFileSync(
    path.join(f.directory, '.secret-scan-history-waivers'),
    `# reviewed\n${added}:removed.env:github-pat:1 # synthetic fixture\n`,
  );
  const waived = f.scan();
  assert.equal(waived.status, 0);
  assert.equal(phase(waived, 'history'), 0);
  // The same value in a current file is still found: waivers never apply to current files.
  fs.writeFileSync(path.join(f.directory, 'again.env'), `GITHUB_TOKEN=${syntheticTokens()[0]}\n`);
  const current = f.scan();
  assert.equal(current.status, 1);
  assert.ok(phase(current, 'current-files') > 0);
  fs.unlinkSync(path.join(f.directory, 'again.env'));
  // A waiver without a reason, or of another line, waives nothing or fails closed.
  fs.writeFileSync(
    path.join(f.directory, '.secret-scan-history-waivers'),
    `${added}:removed.env:github-pat:1\n`,
  );
  assert.equal(f.scan().status, 2);
  fs.writeFileSync(
    path.join(f.directory, '.secret-scan-history-waivers'),
    `${added}:removed.env:github-pat:2 # wrong line\n`,
  );
  const other = f.scan();
  assert.equal(other.status, 1);
  assert.ok(phase(other, 'history') > 0);
});
