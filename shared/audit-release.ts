/*
 * The published version of the Central City Security Audit (src/trust/audit-release.json, written by
 * scripts/audit/release.ts): what /audit shows above the report, and where the PDF and its
 * GitHub record are.
 */

export const AUDIT_SEVERITIES = ['Critical', 'High', 'Medium', 'Low', 'Info'] as const;
export type AuditSeverity = (typeof AUDIT_SEVERITIES)[number];

/** Findings by status for one severity (or the total row), as in the report's summary table. */
export type AuditCounts = { byStatus: Record<string, number>; total: number };

export type AuditSummary = {
  /** The status columns, in the report's order (e.g. Fixed, Accepted risk, Open). */
  statuses: string[];
  rows: Record<AuditSeverity, AuditCounts>;
  total: AuditCounts;
};

export type AuditRelease = {
  title: string;
  version: string;
  /** YYYY-MM-DD */
  date: string;
  draft: boolean;
  reportCommit: string;
  pdf: { path: string; bytes: number; pages: number; sha256: string };
  github: string;
  summary: AuditSummary;
};

const cellsOf = (line: string) =>
  line
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((cell) => cell.trim().replace(/^\*\*(.*)\*\*$/, '$1'));

/**
 * The counts from the first table under "## Summary of findings" in the report's Markdown, so the
 * page and the report cannot disagree. Throws if the table is missing or does not add up.
 */
export function auditSummary(markdown: string): AuditSummary {
  const section = markdown.split(/^## Summary of findings\s*$/m)[1]?.split(/^## /m)[0];
  if (!section) throw new Error('the report has no "Summary of findings" section');
  const lines = section.split('\n');
  const start = lines.findIndex((line) => line.trim().startsWith('|'));
  const table: string[] = [];
  for (const line of lines.slice(start)) {
    if (!line.trim().startsWith('|')) break;
    table.push(line);
  }
  const [head, , ...body] = table;
  const columns = head ? cellsOf(head) : [];
  if (columns[0] !== 'Severity' || columns.at(-1) !== 'Total')
    throw new Error('the summary table must have Severity first and Total last');
  const statuses = columns.slice(1, -1);
  const parsed = new Map<string, AuditCounts>();
  for (const line of body) {
    const [label, ...values] = cellsOf(line);
    const numbers = values.map(Number);
    if (
      !label ||
      numbers.length !== statuses.length + 1 ||
      numbers.some((n) => !Number.isInteger(n))
    )
      throw new Error(`summary row is not counts: ${line.trim()}`);
    const byStatus = Object.fromEntries(statuses.map((status, i) => [status, numbers[i]!]));
    const total = numbers.at(-1)!;
    if (numbers.slice(0, -1).reduce((a, b) => a + b, 0) !== total)
      throw new Error(`summary row does not add up: ${line.trim()}`);
    parsed.set(label, { byStatus, total });
  }
  const rows = {} as Record<AuditSeverity, AuditCounts>;
  for (const severity of AUDIT_SEVERITIES) {
    const row = parsed.get(severity);
    if (!row) throw new Error(`the summary table has no ${severity} row`);
    rows[severity] = row;
  }
  const total = parsed.get('Total');
  if (!total) throw new Error('the summary table has no Total row');
  for (const status of [...statuses, null]) {
    const sum = AUDIT_SEVERITIES.reduce(
      (a, s) => a + (status ? rows[s].byStatus[status]! : rows[s].total),
      0,
    );
    if (sum !== (status ? total.byStatus[status] : total.total))
      throw new Error(`the Total row does not match the severities${status ? ` (${status})` : ''}`);
  }
  return { statuses, rows, total };
}
