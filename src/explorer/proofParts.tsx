import type { ReactNode } from 'react';
import { PublicHeader } from '../shell/PublicHeader';
import { usePageTitle } from '../shell/usePageTitle';
import './explorer.css';

/*
 * The parts every proof page shares (approved design, 24 Oct 2026): breadcrumb, title and one
 * line, the number card, the Proof card (what was checked, against what, up to which block) and
 * panels for the evidence. A status pill only names a check that actually ran.
 */

export const PROOF_PATHS = {
  agents: '/explorer/proof/agents',
  base: '/explorer/proof/base',
  finalizing: '/explorer/proof/finalizing',
  calls: '/explorer/proof/calls',
  ratings: '/explorer/proof/ratings',
} as const;

export function ProofLayout({
  crumb,
  title,
  lede,
  children,
}: {
  crumb: string;
  title: string;
  lede: string;
  children: ReactNode;
}) {
  usePageTitle(`${title} · Verify · Central City Explorer`);
  return (
    <div className="xp">
      <PublicHeader current="downtown" />
      <main className="xp-main xp-proof" id="main-content">
        <nav aria-label="Breadcrumb" className="xp-crumbs">
          <a href="/explorer">Explorer</a>
          <span aria-hidden="true">/</span>
          <span>Verify</span>
          <span aria-hidden="true">/</span>
          <span aria-current="page">{crumb}</span>
        </nav>
        <div className="xp-proof-head">
          <h1>{title}</h1>
          <p>{lede}</p>
        </div>
        {children}
      </main>
    </div>
  );
}

export type PillTone = 'ok' | 'wait' | 'bad' | 'muted';

export function Pill({ tone, children }: { tone: PillTone; children: ReactNode }) {
  return <span className={`xp-pill xp-pill-${tone}`}>{children}</span>;
}

export function NumberCard({
  label,
  value,
  facts,
  children,
}: {
  label: string;
  value: string | null;
  facts?: Array<[string, string | null]>;
  children?: ReactNode;
}) {
  return (
    <div className="xp-card xp-numcard">
      <div className="xp-stat-label">{label}</div>
      <div className="xp-big">{value ?? '–'}</div>
      {facts?.length ? (
        <div className="xp-facts">
          {facts.map(([k, v]) => (
            <span key={k}>
              {k} <b>{v ?? '–'}</b>
            </span>
          ))}
        </div>
      ) : null}
      {children}
    </div>
  );
}

export function ProofCard({
  title = 'Proof',
  status,
  rows,
  actions,
}: {
  title?: string;
  status?: ReactNode;
  rows: Array<[string, ReactNode]>;
  actions?: ReactNode;
}) {
  return (
    <div className="xp-card xp-proofcard">
      <div className="xp-proofcard-head">
        <h2>{title}</h2>
        {status}
      </div>
      <dl>
        {rows.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      {actions ? <div className="xp-proofcard-actions">{actions}</div> : null}
    </div>
  );
}

export function Panel({
  title,
  note,
  children,
}: {
  title: string;
  note?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="xp-panel" aria-label={title}>
      <div className="xp-panel-head">
        <h2>{title}</h2>
        {note ? <span className="xp-stat-sub">{note}</span> : null}
      </div>
      {children}
    </section>
  );
}

export function CodeBox({
  title,
  text,
  children,
}: {
  title: string;
  text: string;
  children?: ReactNode;
}) {
  return (
    <section className="xp-card xp-codebox" aria-label={title}>
      <h2>{title}</h2>
      {children}
      <pre>{text}</pre>
    </section>
  );
}

/** Where the public Disclosures page lives (docs/DISCLOSURES.md, scripts/public-docs/build.ts). */
export const DISCLOSURES_PATH = '/docs/disclosures.md';

/**
 * The disclosure line under the Explorer's counters (Base home, On Base and On Arc): the figures
 * include agents Central City operates, all on chain, with a link to the Disclosures page.
 */
export function DisclosureLine() {
  return (
    <p className="xp-disclosure">
      Network figures include agents operated by Central City for testing, service provision and
      sponsored first purchases. All activity is recorded on chain.{' '}
      <a href={DISCLOSURES_PATH}>See Disclosures</a>.
    </p>
  );
}
