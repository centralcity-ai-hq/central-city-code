import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditSummary, type AuditRelease } from '../../shared/audit-release';

/*
 * Takes one built Central City Security Audit (the report builder's output folder: AUDIT.md, the PDF and
 * manifest.json) into the app, so /audit, /docs/audit.md and the PDF are the same version:
 *
 *   tsx scripts/audit/release.ts <build folder> [--draft]
 *
 * Writes docs/AUDIT.md, public/audit/<pdf> and src/trust/audit-release.json. Refuses a draft build
 * unless --draft is given, and any file whose SHA-256 differs from the manifest.
 */

const GITHUB_AUDITS = 'https://github.com/centralcity-ai-hq/central-city-code/tree/main/audits';

const root = fileURLToPath(new URL('../..', import.meta.url));
const args = process.argv.slice(2);
const from = args.find((arg) => !arg.startsWith('--'));
if (!from) throw new Error('usage: tsx scripts/audit/release.ts <build folder> [--draft]');
const dir = resolve(from);

type Manifest = {
  title: string;
  mode: 'draft' | 'final';
  date: string;
  version: string;
  report_commit: string;
  report_source_clean: boolean;
  pdf: { pages: number };
  outputs: Record<string, { sha256: string; bytes: number }>;
};
const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as Manifest;
if (manifest.mode !== 'final' && !args.includes('--draft'))
  throw new Error(`the build is ${manifest.mode}, not final (pass --draft for a preview)`);
if (!manifest.report_source_clean)
  throw new Error('the build came from a report checkout with uncommitted changes');
// A draft build has no publication date yet; a preview shows today's date, a final build must carry one.
if (!manifest.date && manifest.mode !== 'final')
  manifest.date = new Date().toISOString().slice(0, 10);
if (!/^\d+\.\d+$/.test(manifest.version) || !/^\d{4}-\d{2}-\d{2}$/.test(manifest.date))
  throw new Error(`unexpected version or date: ${manifest.version} ${manifest.date}`);

/** A built file, checked against the manifest. */
function output(name: string): Buffer {
  const expected = manifest.outputs[name];
  if (!expected) throw new Error(`manifest.json lists no ${name}`);
  const bytes = readFileSync(join(dir, name));
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (sha256 !== expected.sha256 || bytes.length !== expected.bytes)
    throw new Error(`${name} does not match manifest.json`);
  return bytes;
}

const pdfName = Object.keys(manifest.outputs).find((name) => name.endsWith('.pdf'));
if (!pdfName) throw new Error('manifest.json lists no PDF');
const markdown = output('AUDIT.md').toString('utf8');
const pdf = output(pdfName);

// Versioned and never overwritten: a status update is a new version with its own file.
const month = manifest.date.slice(0, 7);
const pdfFile = `central-city-audit-${month}-v${manifest.version}.pdf`;
const release: AuditRelease = {
  title: manifest.title,
  version: manifest.version,
  date: manifest.date,
  draft: manifest.mode !== 'final',
  reportCommit: manifest.report_commit,
  pdf: {
    path: `/audit/${pdfFile}`,
    bytes: pdf.length,
    pages: manifest.pdf.pages,
    sha256: manifest.outputs[pdfName]!.sha256,
  },
  // The public repo keeps each version in its own folder (audits/2026-10-v1.1).
  github: `${GITHUB_AUDITS}/${month}-v${manifest.version}`,
  summary: auditSummary(markdown),
};

writeFileSync(join(root, 'docs', 'AUDIT.md'), markdown);
mkdirSync(join(root, 'public', 'audit'), { recursive: true });
writeFileSync(join(root, 'public', 'audit', pdfFile), pdf);
writeFileSync(
  join(root, 'src', 'trust', 'audit-release.json'),
  `${JSON.stringify(release, null, 2)}\n`,
);
console.log(
  `${release.title} v${release.version} (${release.date}${release.draft ? ', draft' : ''}): ` +
    `${release.summary.total.total} findings, PDF ${release.pdf.pages} pages, sha256 ${release.pdf.sha256}`,
);
