import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { auditSummary, type AuditRelease } from '../shared/audit-release.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (...path: string[]) => readFileSync(join(root, ...path));

const report = (rows: string) => `# Central City Audit

## Summary of findings

| Severity | Fixed | Accepted risk | Open | Total |
|---|---:|---:|---:|---:|
${rows}

| ID | Title |
|---|---|
| CCA-1 | One |

## Findings
`;

const ROWS = [
  '| Critical | 1 | 0 | 0 | 1 |',
  '| High | 2 | 0 | 0 | 2 |',
  '| Medium | 3 | 1 | 2 | 6 |',
  '| Low | 0 | 0 | 4 | 4 |',
  '| Info | 0 | 2 | 1 | 3 |',
  '| **Total** | **6** | **3** | **7** | **16** |',
];

test('the summary counts come from the report table', () => {
  const summary = auditSummary(report(ROWS.join('\n')));
  assert.deepEqual(summary.statuses, ['Fixed', 'Accepted risk', 'Open']);
  assert.deepEqual(summary.rows.Medium, {
    byStatus: { Fixed: 3, 'Accepted risk': 1, Open: 2 },
    total: 6,
  });
  assert.deepEqual(summary.total, {
    byStatus: { Fixed: 6, 'Accepted risk': 3, Open: 7 },
    total: 16,
  });
});

test('a summary table that does not add up is refused', () => {
  const wrongRow = ROWS.map((row) => (row.startsWith('| Low') ? '| Low | 0 | 0 | 4 | 5 |' : row));
  assert.throws(() => auditSummary(report(wrongRow.join('\n'))), /does not add up/);
  const wrongTotal = ROWS.map((row) =>
    row.startsWith('| **Total') ? '| **Total** | **6** | **3** | **8** | **17** |' : row,
  );
  assert.throws(() => auditSummary(report(wrongTotal.join('\n'))), /Total row does not match/);
  const missing = ROWS.filter((row) => !row.startsWith('| High'));
  assert.throws(() => auditSummary(report(missing.join('\n'))), /no High row/);
  assert.throws(() => auditSummary('# Central City Audit\n\n## Findings\n'), /no "Summary/);
});

test('/audit, docs/AUDIT.md and the PDF are the same release', () => {
  const release = JSON.parse(read('src', 'trust', 'audit-release.json').toString()) as AuditRelease;
  assert.deepEqual(release.summary, auditSummary(read('docs', 'AUDIT.md').toString()));
  assert.match(release.pdf.path, /^\/audit\/central-city-audit-\d{4}-\d{2}-v\d+\.\d+\.pdf$/);
  assert.ok(release.pdf.path.includes(`-v${release.version}.pdf`));
  assert.ok(release.pdf.path.includes(release.date.slice(0, 7)));
  const pdf = read('public', ...release.pdf.path.split('/').filter(Boolean));
  assert.equal(pdf.length, release.pdf.bytes);
  assert.equal(createHash('sha256').update(pdf).digest('hex'), release.pdf.sha256);
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
  assert.match(release.github, /^https:\/\/github\.com\/centralcity-ai-hq\/central-city-code\//);
});
