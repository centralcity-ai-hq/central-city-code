import { useEffect, useRef, type ReactNode } from 'react';
import { PublicFooter } from './shell/PublicFooter';
import { PublicHeader } from './shell/PublicHeader';
import { usePageTitle } from './shell/usePageTitle';
import { About } from './trust/About';
import { AcceptableUse } from './trust/AcceptableUse';
import { Contact } from './trust/Contact';
import { Dpa } from './trust/Dpa';
import { Imprint } from './trust/Imprint';
import { Privacy } from './trust/Privacy';
import { PrivacyChoices } from './trust/PrivacyChoices';
import { Security } from './trust/Security';
import { Status } from './trust/Status';
import { Support } from './trust/Support';
import { Terms } from './trust/Terms';
import { TocDisclosure, TocSidebar, useSections } from './trust/Toc';
import { Updated } from './trust/common';
import './trust.css';

/*
 * The public trust and company pages linked from the footer (src/shell/links.ts): policies, help
 * and company information. One reading column in the public shell; no session needed. The texts
 * follow what the Service does today: check the code before changing a statement.
 */

export {
  CONTACT_EMAIL,
  HELLO_EMAIL,
  PRIVACY_EMAIL,
  SECURITY_EMAIL,
  SUPPORT_EMAIL,
  TRUST_EFFECTIVE_DATE,
} from './trust/common';

export type TrustPageId =
  | 'privacy'
  | 'privacy-choices'
  | 'terms'
  | 'acceptable-use'
  | 'dpa'
  | 'imprint'
  | 'security'
  | 'support'
  | 'status'
  | 'about'
  | 'contact';

type PageInfo = {
  title: string;
  /** The small label above the title (design v8). */
  eyebrow: string;
  group: 'help' | 'policies' | 'company';
  /** Policy pages show their effective and last-updated dates under the title. */
  dated?: boolean;
  /** Long pages get an "On this page" table of contents (design pages-v1). */
  toc?: boolean;
  body: () => ReactNode;
};

const PAGES: Record<TrustPageId, PageInfo> = {
  support: { title: 'Support Center', eyebrow: 'Help & guidance', group: 'help', body: Support },
  status: { title: 'Status', eyebrow: 'System health', group: 'help', body: Status },
  security: {
    title: 'Security',
    eyebrow: 'Trust & assurance',
    group: 'help',
    dated: true,
    toc: true,
    body: Security,
  },
  privacy: {
    title: 'Privacy Policy',
    eyebrow: 'Data protection',
    group: 'policies',
    dated: true,
    toc: true,
    body: Privacy,
  },
  'privacy-choices': {
    title: 'Privacy Choices and Cookies',
    eyebrow: 'Choices & storage',
    group: 'policies',
    dated: true,
    body: PrivacyChoices,
  },
  terms: {
    title: 'Terms of Service',
    eyebrow: 'Legal agreement',
    group: 'policies',
    dated: true,
    toc: true,
    body: Terms,
  },
  'acceptable-use': {
    title: 'Acceptable Use Policy',
    eyebrow: 'Community & usage',
    group: 'policies',
    dated: true,
    toc: true,
    body: AcceptableUse,
  },
  dpa: {
    title: 'Data Processing Addendum',
    eyebrow: 'GDPR Article 28',
    group: 'policies',
    dated: true,
    toc: true,
    body: Dpa,
  },
  imprint: {
    title: 'Imprint',
    eyebrow: 'Statutory notice',
    group: 'policies',
    dated: true,
    body: Imprint,
  },
  about: { title: 'About Central City', eyebrow: 'Company', group: 'company', body: About },
  contact: { title: 'Contact', eyebrow: 'Communication', group: 'company', body: Contact },
};

const RELATED_LABEL: Record<PageInfo['group'], string> = {
  help: 'Help and safety',
  policies: 'Terms and policies',
  company: 'Company',
};

/** Small groups also link the pages people look for next (a lone link reads as orphaned). */
const RELATED_EXTRA: Record<PageInfo['group'], TrustPageId[]> = {
  help: ['contact'],
  policies: [],
  company: ['security', 'privacy', 'terms', 'imprint'],
};

export const TRUST_PAGE_IDS = Object.keys(PAGES) as TrustPageId[];
export const trustTitle = (page: TrustPageId) => PAGES[page].title;

export function TrustPage({ page }: { page: TrustPageId }) {
  const { title, eyebrow, group, dated, toc, body: Body } = PAGES[page];
  const body = useRef<HTMLDivElement>(null);
  const sections = useSections(body, page);
  // "About Central City" already names the site; the others get it after their own name. Either
  // way the same title the server sends for the page (shared/share-cards.ts).
  usePageTitle(title.endsWith('Central City') ? title : `${title} · Central City`);
  // A deep link such as /security#disclosure: the section exists only after this chunk loads,
  // and on pages with a table of contents only once it is in place (it adds height above).
  const scrolled = useRef<string | null>(null);
  useEffect(() => {
    if (scrolled.current === page || (toc && !sections.length)) return;
    scrolled.current = page;
    const target = window.location.hash.slice(1);
    if (/^[a-z-]+$/.test(target)) document.getElementById(target)?.scrollIntoView();
  }, [page, toc, sections]);
  const related = [
    ...TRUST_PAGE_IDS.filter((id) => PAGES[id].group === group),
    ...RELATED_EXTRA[group],
  ].filter((id) => id !== page);
  return (
    <div className="public-shell">
      <PublicHeader current="home" />
      <main id="main-content" tabIndex={-1} className="public-main trust-page">
        <article
          className={`trust trust-page-${page}${toc ? ' trust-has-toc' : ''}`}
          aria-labelledby="trust-title"
        >
          <header className="trust-head">
            <p className="trust-eyebrow">{eyebrow}</p>
            <h1 id="trust-title">{title}</h1>
            {dated ? <Updated /> : null}
          </header>
          <div className="trust-layout">
            <div className="trust-body" ref={body}>
              {toc ? <TocDisclosure sections={sections} /> : null}
              <Body />
            </div>
            {toc ? <TocSidebar sections={sections} /> : null}
          </div>
          <nav className="trust-related" aria-label={RELATED_LABEL[group]}>
            {related.map((id) => (
              <a key={id} href={`/${id}`}>
                {PAGES[id].title}
              </a>
            ))}
          </nav>
        </article>
      </main>
      <PublicFooter />
    </div>
  );
}
