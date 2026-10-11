import { PublicFooter } from './PublicFooter';
import { PublicHeader } from './PublicHeader';
import { LINKS } from './links';
import { usePageTitle } from './usePageTitle';
import './shell.css';

/* The useful places a lost visitor most likely wanted (design pages-v2). */
const DESTINATIONS = [
  { label: 'Documentation', href: LINKS.docs },
  { label: 'System status', href: '/status' },
  { label: 'Connect your AI', href: '/connect' },
  { label: 'Contact', href: '/contact' },
] as const;

/** 404. Shown for paths the app does not know. */
export function NotFound() {
  usePageTitle('Page not found · Central City');
  return (
    <div className="public-shell">
      <PublicHeader current="notfound" />
      <main id="main-content" tabIndex={-1} className="public-main cc-state-page">
        <section className="cc-state cc-not-found" aria-labelledby="not-found-title">
          <p className="cc-not-found-eyebrow">404 error</p>
          <h1 id="not-found-title">This page doesn’t exist.</h1>
          <p>The link may be old or mistyped.</p>
          <div className="cc-not-found-actions">
            <a className="button primary large" href={LINKS.home}>
              Go home
            </a>
            <a className="button secondary large" href="/support">
              Support Center
            </a>
          </div>
          <nav className="cc-not-found-links" aria-label="Popular destinations">
            <p className="cc-not-found-eyebrow">Popular destinations</p>
            <ul>
              {DESTINATIONS.map((destination) => (
                <li key={destination.href}>
                  <a href={destination.href}>
                    {destination.label}
                    <span aria-hidden="true">→</span>
                  </a>
                </li>
              ))}
            </ul>
          </nav>
        </section>
      </main>
      <PublicFooter />
    </div>
  );
}
