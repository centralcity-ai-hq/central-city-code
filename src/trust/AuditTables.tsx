import type { Nodes, PhrasingContent, Table, TableCell, TableRow } from 'mdast';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { AUDIT_SEVERITIES } from '../../shared/audit-release';
import { markdownHref, type TableRenderer, type TableTools } from '../docs/markdown';

/*
 * How /audit draws the report's tables (./Audit.tsx). The text is docs/AUDIT.md as published;
 * only its presentation changes here:
 * - the two contract tables in Scope become one card per contract, label and value rows;
 * - the findings lists become rows with a severity badge and a green status mark, as in the PDF;
 * - each finding's fields table becomes a short definition list with the status as a green box;
 * - any other table stays a table, with severity names as badges.
 * Addresses show shortened, link to BaseScan as in the text, and copy in full.
 */

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const DEPLOY = /^block (\d+), (.+)$/;
const SEVERITIES: readonly string[] = AUDIT_SEVERITIES;

function textOf(node: Nodes): string {
  if ('value' in node && typeof node.value === 'string') return node.value;
  if ('children' in node) return (node.children as Nodes[]).map(textOf).join('');
  return '';
}

const cellText = (cell: TableCell | undefined) => (cell ? textOf(cell).trim() : '');
const headers = (table: Table) => (table.children[0]?.children ?? []).map(cellText);

/** 0xA5f89AE25c87C21a8E2B03aaBf398A880d9be81B as 0xA5f8…e81B. */
export const shortAddress = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;

/** 52603696 as 52,603,696. */
export const thousands = (digits: string) => digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/** "Title (a note)" as the title and its note, so the note can read quieter. */
export function splitNote(text: string): [string, string | null] {
  const open = text.indexOf(' (');
  return open > 0 && text.endsWith(')')
    ? [text.slice(0, open), text.slice(open + 1)]
    : [text, null];
}

function CopyAddress({ address }: { address: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return (
    <>
      <button
        type="button"
        className="audit-copy"
        aria-label={`Copy the full address ${address}`}
        data-copied={copied ? '' : undefined}
        onClick={() => {
          try {
            void navigator.clipboard?.writeText(address).then(
              () => {
                setCopied(true);
                window.clearTimeout(timer.current);
                timer.current = window.setTimeout(() => setCopied(false), 1600);
              },
              () => undefined,
            );
          } catch {
            // No clipboard here: the address stays readable and linked.
          }
        }}
      >
        {copied ? (
          'Copied'
        ) : (
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
            <rect
              x="5.5"
              y="5.5"
              width="8"
              height="8"
              rx="1.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.3"
            />
            <path
              d="M10.5 3.5v-.5A1.5 1.5 0 0 0 9 1.5H4A1.5 1.5 0 0 0 2.5 3v5A1.5 1.5 0 0 0 4 9.5h.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.3"
            />
          </svg>
        )}
      </button>
      <span className="visually-hidden" role="status">
        {copied ? 'Address copied' : ''}
      </span>
    </>
  );
}

function Address({ address, href }: { address: string; href: string | null }) {
  const label = <code>{shortAddress(address)}</code>;
  return (
    <span className="audit-address">
      {href ? (
        <a href={href} title={address}>
          {label}
        </a>
      ) : (
        label
      )}
      <CopyAddress address={address} />
    </span>
  );
}

/** A cell's content: addresses shortened with a copy button, deploy blocks with separators. */
function Inline({ nodes, tools, at }: { nodes: PhrasingContent[]; tools: TableTools; at: string }) {
  return (
    <>
      {nodes.map((node, index) => {
        const key = `${at}.${index}`;
        if (node.type === 'link') {
          const text = textOf(node).trim();
          const href = markdownHref(node.url);
          if (ADDRESS.test(text)) return <Address key={key} address={text} href={href} />;
          const deploy = DEPLOY.exec(text);
          if (deploy && href)
            return (
              <a key={key} href={href} className="audit-deploy">
                block {thousands(deploy[1]!)} · {deploy[2]}
              </a>
            );
        }
        return tools.inline(node, key);
      })}
    </>
  );
}

const severityClass = (severity: string) => `audit-sev audit-sev-${severity.toLowerCase()}`;

export function SeverityBadge({ severity }: { severity: string }) {
  return <span className={severityClass(severity)}>{severity}</span>;
}

export function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`audit-status${status === 'Fixed' ? ' audit-status-fixed' : ''}`}>
      {status}
    </span>
  );
}

/** A contract card: the name as its heading, then one label and value row per column. */
function ContractCards({ table, tools, grid }: { table: Table; tools: TableTools; grid: boolean }) {
  const labels = headers(table);
  const rows = table.children.slice(1);
  return (
    <ul className={`audit-cards${grid ? ' audit-cards-grid' : ''}`} aria-label={tools.section}>
      {rows.map((row, rowIndex) => {
        const [nameCell, ...cells] = row.children;
        const [name, note] = splitNote(cellText(nameCell));
        const at = `${tools.key}.${rowIndex}`;
        return (
          <li key={at} className="audit-card">
            <h4 className="audit-card-title">
              {name}
              {note ? <span className="audit-card-note"> {note}</span> : null}
            </h4>
            <dl className="audit-kv">
              {cells.map((cell, index) => (
                <div key={`${at}.${index}`}>
                  <dt>{labels[index + 1]}</dt>
                  <dd>
                    <Inline nodes={cell.children} tools={tools} at={`${at}.${index}`} />
                  </dd>
                </div>
              ))}
            </dl>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * A findings list (ID, Title, Severity, Status): one row per finding, the status as a green mark
 * after the severity instead of its own column. A finding with its own section links to it.
 */
function FindingRows({
  table,
  tools,
  anchors,
}: {
  table: Table;
  tools: TableTools;
  anchors: ReadonlyMap<string, string>;
}) {
  const labels = headers(table);
  return (
    <ul className="audit-findings" aria-label={`${tools.section}: findings`}>
      {table.children.slice(1).map((row, rowIndex) => {
        const [idCell, titleCell, severityCell, statusCell] = row.children;
        const id = cellText(idCell);
        const [title, note] = splitNote(cellText(titleCell));
        const severity = cellText(severityCell);
        const status = cellText(statusCell);
        const anchor = anchors.get(id);
        return (
          <li key={`${tools.key}.${rowIndex}`} className="audit-finding">
            <span className="audit-finding-id">
              {anchor ? <a href={`#${anchor}`}>{id}</a> : id}
            </span>
            <span className="audit-finding-title">
              {title}
              {note ? <span className="audit-finding-note"> {note}</span> : null}
            </span>
            <span className="audit-finding-marks">
              <span className="visually-hidden">{labels[2]}: </span>
              <SeverityBadge severity={severity} />
              <span className="visually-hidden">, {labels[3]}: </span>
              <StatusBadge status={status} />
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/** A finding's fields (Severity, Status, Component, Fixed on, Fix reference). */
function FindingFields({ table, tools }: { table: Table; tools: TableTools }) {
  return (
    <dl className="audit-kv audit-fields">
      {table.children.slice(1).map((row, index) => {
        const [labelCell, valueCell] = row.children;
        const label = cellText(labelCell);
        const value = cellText(valueCell);
        const at = `${tools.key}.${index}`;
        if (label === 'Status')
          return (
            <div key={at} className={`audit-field-status${value === 'Fixed' ? ' is-fixed' : ''}`}>
              <dt>{label}</dt>
              <dd>
                {value === 'Fixed' ? (
                  <svg
                    viewBox="0 0 16 16"
                    width="14"
                    height="14"
                    aria-hidden="true"
                    focusable="false"
                  >
                    <path
                      d="M3.5 8.5l3 3 6-7"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                ) : null}
                {value}
              </dd>
            </div>
          );
        return (
          <div key={at}>
            <dt>{label}</dt>
            <dd>
              {label === 'Severity' && SEVERITIES.includes(value) ? (
                <SeverityBadge severity={value} />
              ) : (
                <Inline nodes={valueCell?.children ?? []} tools={tools} at={at} />
              )}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

/** Any other table: as in the docs, with severity names as badges and long tokens wrapping. */
function PlainTable({ table, tools }: { table: Table; tools: TableTools }) {
  const labels = headers(table);
  const matrix = labels[0] === 'Impact';
  const align = table.align ?? [];
  const cells = (row: TableRow, Cell: 'th' | 'td', at: string) =>
    row.children.map((cell, index) => {
      const text = cellText(cell);
      const badge =
        Cell === 'td' &&
        SEVERITIES.includes(text) &&
        ((labels[index] ?? '').startsWith('Severity') || (matrix && index > 0));
      return (
        <Cell
          key={`${at}.${index}`}
          style={align[index] ? { textAlign: align[index]! } : undefined}
        >
          {badge ? (
            <SeverityBadge severity={text} />
          ) : (
            <Inline nodes={cell.children} tools={tools} at={`${at}.${index}`} />
          )}
        </Cell>
      );
    });
  const [head, ...body] = table.children;
  return (
    <div
      className="docs-table audit-table"
      tabIndex={0}
      role="region"
      aria-label={tools.section ? `Table: ${tools.section}` : 'Table'}
    >
      <table>
        {head ? (
          <thead>
            <tr>{cells(head, 'th', `${tools.key}.h`)}</tr>
          </thead>
        ) : null}
        <tbody>
          {body.map((row, index) => (
            <tr key={`${tools.key}.${index}`}>{cells(row, 'td', `${tools.key}.${index}`)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The audit's table renderer; `anchors` maps a finding id (CCA-731) to its section's id. */
export function auditTables(anchors: ReadonlyMap<string, string>): TableRenderer {
  return (table, tools) => {
    const labels = headers(table);
    if (labels[0] === 'Contract' && labels.includes('Bytecode matches source'))
      return <ContractCards table={table} tools={tools} grid={false} />;
    if (labels[0] === 'Contract' && labels.includes('Reviewed?'))
      return <ContractCards table={table} tools={tools} grid />;
    if (labels[0] === 'ID' && labels[1] === 'Title' && labels.length === 4)
      if (labels[2]?.startsWith('Severity') && labels[3]?.startsWith('Status'))
        return <FindingRows table={table} tools={tools} anchors={anchors} />;
    if (labels.length === 2 && labels.every((label) => label === ''))
      return <FindingFields table={table} tools={tools} />;
    return <PlainTable table={table} tools={tools} />;
  };
}
