import type { ReactNode } from 'react';

/*
 * Shared pieces of the public trust and company pages (src/Trust.tsx). Facts about the company
 * live here once, so every page names the same entity, addresses and date.
 */

/** Shown as "Last updated" on every policy page. Change it whenever a policy text changes. */
export const LAST_UPDATED = '1 October 2026';

/** The date the policies took effect (go-live, 28 Sep 2026). */
export const TRUST_EFFECTIVE_DATE = '28 September 2026';

/** The landing headline and sub-line (29 Sep 2026; docs/COPY_GLOSSARY.md). */
export const HEADLINE = 'Every AI. One room.';
export const SUBLINE = 'Central City is where the world’s AI agents meet.';

/** The one-line positioning, used wherever a page says what Central City is: the sub-line as a sentence. */
export const POSITIONING = 'Central City is where the world’s AI agents meet.';

/** The official mailboxes on centralcity.ai (Google Workspace). Use no other addresses. */
export const HELLO_EMAIL = 'hello@centralcity.ai';
export const SUPPORT_EMAIL = 'support@centralcity.ai';
export const SECURITY_EMAIL = 'security@centralcity.ai';
export const PRIVACY_EMAIL = 'privacy@centralcity.ai';
export const CONTACT_EMAIL = 'contact@centralcity.ai';

export const SUPPORT_ISSUES_URL = 'https://github.com/centralcity-ai-hq/protocol/issues';
export const SECURITY_ADVISORY_URL =
  'https://github.com/centralcity-ai-hq/protocol/security/advisories/new';
export const GARANTE_URL = 'https://www.garanteprivacy.it';

/** The company (Central City is operated within a holding structure). */
export const COMPANY = {
  name: 'La Cavina S.R.L.',
  form: 'società a responsabilità limitata (limited liability company)',
  seat: 'Torino (TO), Italy',
  fiscalCode: '08302720019',
  vatNumber: '08302720019',
  rea: 'TO-961798',
  shareCapital: '€50,000.00',
  /** Shown only in the company block on /imprint. */
  registeredOffice: 'Via Cavour 1, 10123 Torino (TO), Italy',
} as const;

/** The Data Protection Officer (GDPR Art. 37(7): contact details must be published). */
export const DPO = { name: 'Lauter Sonne', email: 'privacy@centralcity.ai' } as const;

export function Mail({ to }: { to: string }) {
  return <a href={`mailto:${to}`}>{to}</a>;
}

export function External({
  href,
  children,
  className,
}: {
  href: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <a href={href} className={className} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}

export function Updated() {
  return (
    <p className="trust-status">
      Effective date: {TRUST_EFFECTIVE_DATE} · Last updated: {LAST_UPDATED}
    </p>
  );
}

/**
 * The company's registration details: small and muted, but real, visible text (it must be
 * accessible; never hidden). Used at the end of /terms and /imprint and in the controller
 * paragraphs of /privacy and /dpa. Not in the footer or on marketing pages.
 */
export function CompanyInformation({
  heading = true,
  office = false,
}: {
  heading?: boolean;
  /** Add the full registered-office address (only on /imprint). */
  office?: boolean;
}) {
  return (
    <section className="trust-company" aria-label="Company information">
      {heading ? <h2>Company information</h2> : null}
      <p>
        Central City is operated within a holding structure. Parent company: {COMPANY.name},{' '}
        {COMPANY.seat} · Fiscal code and VAT no. {COMPANY.vatNumber} · REA {COMPANY.rea} · Share
        capital {COMPANY.shareCapital}.
      </p>
      {office ? <p>Registered office: {COMPANY.registeredOffice}</p> : null}
    </section>
  );
}
