import type { Root } from 'mdast';
import { useEffect } from 'react';
import { AUDIT_SEVERITIES, type AuditRelease } from '../../shared/audit-release';
import { headingId, MarkdownBody } from '../docs/markdown';
import { auditTables, SeverityBadge } from './AuditTables';
import audit from './audit-content';
import releaseJson from './audit-release.json';
import { CopyText, External, Mail, SECURITY_EMAIL } from './common';

/*
 * /audit: the Central City Security Audit, the Central City Audit Division's internal security review. The
 * text is /docs/audit.md (docs/AUDIT.md), parsed at build time (scripts/public-docs/guides.ts), so
 * the page and the Markdown never drift. Above it, the report record as audit firms publish it:
 * version and date, what kind of review this is, the findings by severity and status, and the
 * versioned PDF with its SHA-256 and GitHub record. scripts/audit/release.ts writes all of it from
 * one build, so the page, the Markdown and the PDF are the same version.
 */

const release = releaseJson as AuditRelease;

const longDate = (iso: string) =>
  new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });

const megabytes = (bytes: number) => `${(bytes / 1_000_000).toFixed(1)} MB`;

function FindingsBySeverity() {
  const { statuses, rows, total } = release.summary;
  return (
    <div className="docs-table" tabIndex={0} role="region" aria-label="Findings by severity">
      <table className="audit-counts">
        <thead>
          <tr>
            <th scope="col">Severity</th>
            {statuses.map((status) => (
              <th key={status} scope="col">
                {status}
              </th>
            ))}
            <th scope="col">Total</th>
          </tr>
        </thead>
        <tbody>
          {AUDIT_SEVERITIES.map((severity) => (
            <tr key={severity}>
              <th scope="row">
                <SeverityBadge severity={severity} />
              </th>
              {statuses.map((status) => (
                <td key={status}>{rows[severity].byStatus[status]}</td>
              ))}
              <td>{rows[severity].total}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th scope="row">Total</th>
            {statuses.map((status) => (
              <td key={status}>{total.byStatus[status]}</td>
            ))}
            <td>{total.total}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

function AuditRecord() {
  const { pdf } = release;
  return (
    <section className="audit-record" aria-label="Report record">
      <dl className="audit-facts">
        <div>
          <dt>Version</dt>
          <dd>
            {release.version}, {longDate(release.date)}
          </dd>
        </div>
        <div>
          <dt>Prepared by</dt>
          <dd>Central City Audit Division</dd>
        </div>
        <div>
          <dt>Findings</dt>
          <dd>{release.summary.total.total}, by severity and status below</dd>
        </div>
        <div>
          <dt>Report a problem</dt>
          <dd>
            <Mail to={SECURITY_EMAIL} />
          </dd>
        </div>
      </dl>
      <FindingsBySeverity />
      <div className="audit-downloads">
        <a className="audit-pdf" href={pdf.path} type="application/pdf">
          Download the report (PDF, {pdf.pages} pages, {megabytes(pdf.bytes)})
        </a>
        <External href={release.github}>Report record on GitHub</External>
        <a href="/docs/audit.md" type="text/markdown">
          View as Markdown
        </a>
      </div>
      <div className="audit-hash">
        <span className="audit-hash-label">PDF SHA-256</span>
        <code>{pdf.sha256}</code>
        <CopyText text={pdf.sha256} label="the PDF's SHA-256" />
      </div>
    </section>
  );
}

// The report's opening (what kind of review this is, and its limits) stays first; the record
// follows it, then the sections.
const firstSection = audit.children.findIndex(
  (node) => node.type === 'heading' && node.depth === 2,
);
const intro: Root = { ...audit, children: audit.children.slice(0, firstSection) };
const sections: Root = { ...audit, children: audit.children.slice(firstSection) };

/** Each finding with its own section (### CCA-731: ...), by id, so the findings list links it. */
const findingAnchors = new Map<string, string>();
for (const node of audit.children) {
  if (node.type !== 'heading' || node.depth !== 3) continue;
  const text = node.children.map((child) => ('value' in child ? child.value : '')).join('');
  const id = /^([A-Z]+\d*-\d+):/.exec(text)?.[1];
  if (id) findingAnchors.set(id, headingId(text, new Map()));
}
const renderTable = auditTables(findingAnchors);

/** /audit#cca-704 opens that finding, whose heading id also carries its title. */
function useFindingLink() {
  useEffect(() => {
    const id = /^cca-\d+$/.exec(window.location.hash.slice(1))?.[0];
    if (!id) return;
    document.querySelector(`h3[id^="${id}-"]`)?.scrollIntoView();
  }, []);
}

export function Audit() {
  useFindingLink();
  return (
    <>
      <MarkdownBody tree={intro} table={renderTable} />
      <AuditRecord />
      <MarkdownBody tree={sections} table={renderTable} />
    </>
  );
}
