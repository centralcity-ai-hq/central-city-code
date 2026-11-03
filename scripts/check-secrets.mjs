import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const VERSION = '8.30.1';
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scanner = process.env.GITLEAKS_BIN || 'gitleaks';
const argv = process.argv.slice(2);
let temporary;

function execute(program, args, cwd) {
  const result = spawnSync(program, args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 180_000,
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, NO_COLOR: '1' },
  });
  if (result.error || result.signal)
    throw new Error('Scanner or Git could not complete; scan failed closed.');
  return result;
}

function git(args, source) {
  const result = execute('git', args, source);
  if (result.status !== 0)
    throw new Error('Git inspection failed; scan requires a readable repository.');
  return result.stdout;
}

const WAIVER = /^([0-9a-f]{40}):([^:\s]+):([a-z0-9-]+):([1-9][0-9]*)\s+#\s*\S.*$/;
const MAX_WAIVERS = 20;

function historyWaivers(source) {
  const file = path.join(source, '.secret-scan-history-waivers');
  if (!fs.existsSync(file)) return [];
  const fingerprints = [];
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const match = WAIVER.exec(line);
    if (!match) throw new Error('Malformed history waiver; scan failed closed.');
    fingerprints.push(`${match[1]}:${match[2]}:${match[3]}:${match[4]}`);
  }
  if (fingerprints.length > MAX_WAIVERS)
    throw new Error('Too many history waivers; scan failed closed.');
  return fingerprints;
}

function scan(mode, source, configuration, ignoreFile, label) {
  const reportPath = path.join(temporary, `${label}.json`);
  const args = [
    mode,
    '--config',
    configuration,
    '--redact=100',
    '--no-banner',
    '--no-color',
    '--log-level=error',
    '--ignore-gitleaks-allow',
    '--gitleaks-ignore-path',
    ignoreFile,
    '--report-format=json',
    '--report-path',
    reportPath,
    '--max-archive-depth=2',
    '--max-decode-depth=5',
    '--timeout=120',
    '--exit-code=1',
  ];
  if (mode === 'git') args.push('--log-opts=--all --full-history');
  args.push(source);
  const result = execute(scanner, args, project);
  // Never forward scanner stdout/stderr or raw findings, even on parser failure.
  if (![0, 1].includes(result.status))
    throw new Error('Gitleaks scan failed; no successful result is inferred.');
  if (!fs.existsSync(reportPath))
    throw new Error('Gitleaks report is missing; scan failed closed.');
  let findings;
  try {
    findings = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  } catch {
    throw new Error('Gitleaks report could not be read; scan failed closed.');
  }
  if (!Array.isArray(findings) || findings.length > 0 !== (result.status === 1))
    throw new Error('Gitleaks status/report mismatch; scan failed closed.');
  const rules = [...new Set(findings.map((finding) => finding.RuleID))];
  if (!rules.every((rule) => typeof rule === 'string' && /^[a-zA-Z0-9_-]+$/.test(rule)))
    throw new Error('Unexpected scanner rule metadata.');
  return { phase: label, findings: findings.length, rules };
}

try {
  if (argv.length && (argv.length !== 2 || argv[0] !== '--source'))
    throw new Error('Usage: node scripts/check-secrets.mjs [--source REPOSITORY]');
  const source = fs.realpathSync(argv[1] ?? project);
  const root = fs.realpathSync(git(['rev-parse', '--show-toplevel'], source).trim());
  if (root.toLowerCase() !== source.toLowerCase())
    throw new Error('Scan source must be the repository root.');
  if (git(['rev-parse', '--is-shallow-repository'], source).trim() !== 'false')
    throw new Error('Full history is required; fetch-depth must be zero.');
  const version = execute(scanner, ['version'], project);
  if (version.status !== 0 || version.stdout.trim() !== VERSION)
    throw new Error(
      `Install verified Gitleaks ${VERSION} and set GITLEAKS_BIN; scan failed closed.`,
    );
  const files = [
    ...new Set(
      git(['ls-files', '-z', '--cached', '--others', '--exclude-standard'], source)
        .split('\0')
        .filter(Boolean),
    ),
  ];
  if (files.length > 20_000)
    throw new Error('Repository snapshot exceeds the reviewed 20,000-file bound.');
  temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'central-city-secret-scan-'));
  const snapshot = path.join(temporary, 'snapshot');
  fs.mkdirSync(snapshot);
  const ignoreFile = path.join(temporary, 'empty.ignore');
  fs.writeFileSync(ignoreFile, '');
  // History findings that were reviewed as false positives (the owner's decision, 3 Nov 2026):
  // exact Gitleaks fingerprints, one per line with a reason, in the scanned repository's
  // .secret-scan-history-waivers. They apply to the history phase only; current files are always
  // scanned with no exceptions. A malformed list fails the scan closed.
  const historyIgnoreFile = path.join(temporary, 'history.ignore');
  fs.writeFileSync(historyIgnoreFile, historyWaivers(source).join('\n'));
  for (const relative of files) {
    const target = path.resolve(snapshot, relative);
    if (!target.startsWith(`${snapshot}${path.sep}`)) throw new Error('Invalid repository path.');
    const original = path.join(source, relative);
    let stat;
    try {
      stat = fs.lstatSync(original);
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw new Error('Repository file inspection failed.');
    }
    if (stat.isDirectory())
      throw new Error('Submodules require a separate reviewed scan; current scan failed closed.');
    if (!stat.isFile() && !stat.isSymbolicLink())
      throw new Error('Unsupported repository file type.');
    if (stat.size > 50 * 1024 * 1024)
      throw new Error('Repository file exceeds the reviewed 50 MiB bound.');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (stat.isSymbolicLink()) fs.writeFileSync(target, fs.readlinkSync(original));
    else fs.copyFileSync(original, target);
  }
  const configuration = path.join(project, '.gitleaks.toml');
  const results = [
    scan('git', source, configuration, historyIgnoreFile, 'history'),
    scan('dir', snapshot, configuration, ignoreFile, 'current-files'),
  ];
  // Only counts and rule identifiers leave this process. Reports are ephemeral.
  process.stdout.write(`${JSON.stringify({ scanner: `gitleaks ${VERSION}`, results })}\n`);
  process.exitCode = results.some((result) => result.findings > 0) ? 1 : 0;
} catch (error) {
  const known = error instanceof Error && error.message;
  process.stderr.write(`Secret scan failed: ${known || 'unexpected failure'}\n`);
  process.exitCode = 2;
} finally {
  if (
    temporary &&
    path.dirname(path.resolve(temporary)) === fs.realpathSync(os.tmpdir()) &&
    path.basename(temporary).startsWith('central-city-secret-scan-')
  )
    fs.rmSync(temporary, { recursive: true, force: true });
}
