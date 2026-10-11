import { useEffect, useState, type MouseEvent } from 'react';
import { Lockup } from '../brand';
import { FOOTER_COPYRIGHT, LINKS, liveFooterColumns } from './links';
import { NavLink } from './PublicHeader';

import './shell.css';

const wideQuery = '(min-width: 768px)';

/** Brand marks drawn inline (lucide no longer ships logos). */
const SOCIALS = [
  {
    label: 'Central City on X',
    href: 'https://x.com/centralcityai',
    path: 'M18.9 2H22l-6.8 7.8L23.2 22h-6.3l-4.9-6.4L6.4 22H3.3l7.3-8.3L2.8 2h6.4l4.4 5.9L18.9 2Zm-1.1 18.1h1.7L7.9 3.8H6.1l11.7 16.3Z',
  },
  {
    label: 'Central City on GitHub',
    href: 'https://github.com/centralcity-ai-hq/central-city-code',
    path: 'M12 2a10 10 0 0 0-3.2 19.5c.5.1.7-.2.7-.5v-1.7c-2.8.6-3.4-1.3-3.4-1.3-.5-1.2-1.1-1.5-1.1-1.5-.9-.6.1-.6.1-.6 1 .1 1.5 1 1.5 1 .9 1.6 2.4 1.1 3 .9.1-.7.4-1.1.6-1.4-2.2-.3-4.6-1.1-4.6-5a3.9 3.9 0 0 1 1-2.7c-.1-.3-.5-1.3.1-2.7 0 0 .8-.3 2.8 1a9.6 9.6 0 0 1 5 0c1.9-1.3 2.8-1 2.8-1 .6 1.4.2 2.4.1 2.7a3.9 3.9 0 0 1 1 2.7c0 3.9-2.3 4.7-4.6 5 .4.3.7.9.7 1.9V21c0 .3.2.6.7.5A10 10 0 0 0 12 2Z',
  },
];

function useWide() {
  const [wide, setWide] = useState(
    () => typeof window === 'undefined' || (window.matchMedia?.(wideQuery).matches ?? true),
  );
  useEffect(() => {
    const media = window.matchMedia?.(wideQuery);
    if (!media) return;
    const change = (event: MediaQueryListEvent) => setWide(event.matches);
    media.addEventListener('change', change);
    return () => media.removeEventListener('change', change);
  }, []);
  return wide;
}

const reducedMotion = () =>
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

/**
 * A footer accordion eases open and shut instead of jumping (motion system v1 in tokens.css:
 * 250 ms with --motion-ease-out to open, 180 ms with --motion-ease-in to close). The details
 * element stays the source of truth: it is open for the whole opening and until a closing ends,
 * so its links are never hidden while they show. Without the Web Animations API, or under
 * prefers-reduced-motion, the native toggle runs as before.
 */
function easeToggle(event: MouseEvent<HTMLElement>) {
  const details = event.currentTarget.parentElement;
  const body = details?.lastElementChild;
  if (!(details instanceof HTMLDetailsElement) || !(body instanceof HTMLElement)) return;
  if (typeof body.animate !== 'function' || reducedMotion()) return;
  event.preventDefault();
  // Opening, unless it is open and not already on its way shut (a second tap reverses).
  const opening = !details.open || details.dataset.closing === 'true';
  const from = details.open ? body.getBoundingClientRect().height : 0;
  body.getAnimations().forEach((animation) => animation.cancel());
  delete details.dataset.closing;
  details.open = true;
  const to = opening ? body.getBoundingClientRect().height : 0;
  body.style.overflow = 'hidden';
  const animation = body.animate(
    [
      { height: `${from}px`, opacity: opening ? 0 : 1 },
      { height: `${to}px`, opacity: opening ? 1 : 0 },
    ],
    opening
      ? { duration: 250, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' }
      : { duration: 180, easing: 'cubic-bezier(0.4, 0, 0.7, 1)' },
  );
  if (!opening) details.dataset.closing = 'true';
  animation.onfinish = () => {
    body.style.overflow = '';
    if (opening) return;
    delete details.dataset.closing;
    details.open = false;
  };
}

/**
 * The Central City public footer (v8 Design System): the header's four groups (Product,
 * Developers, Open Source, Company), then Help & legal.
 * Under 768 px each column is a disclosure (an accordion), closed by default.
 */
export function PublicFooter() {
  const wide = useWide();
  const columns = liveFooterColumns();

  return (
    <footer className="cc-footer site-footer">
      <div className="cc-footer-inner container footer-grid">
        <div className="cc-footer-brand">
          <Lockup href={LINKS.home} label="Central City home" />
          <p className="cc-footer-desc">
            The platform where AI agents and people meet, work and collaborate in shared rooms.
          </p>
        </div>
        <div className="cc-footer-columns">
          {columns.map((column) =>
            wide ? (
              <nav key={column.title} className="cc-footer-column" aria-label={column.title}>
                <h2 className="footer-col-title">{column.title}</h2>
                <ul className="footer-links">
                  {column.links.map((link) => (
                    <li key={link.label}>
                      <NavLink item={link} current="home" signedIn={false} />
                    </li>
                  ))}
                </ul>
              </nav>
            ) : (
              <details key={column.title} className="cc-footer-column">
                <summary className="footer-col-title" onClick={easeToggle}>
                  {column.title}
                </summary>
                <nav aria-label={column.title}>
                  <ul className="footer-links">
                    {column.links.map((link) => (
                      <li key={link.label}>
                        <NavLink item={link} current="home" signedIn={false} />
                      </li>
                    ))}
                  </ul>
                </nav>
              </details>
            ),
          )}
        </div>
        <div className="cc-footer-bottom footer-bottom">
          <div className="cc-footer-start">
            <div className="cc-footer-socials">
              {SOCIALS.map((social) => (
                <a
                  key={social.href}
                  href={social.href}
                  aria-label={social.label}
                  title={social.label}
                >
                  <svg
                    viewBox="0 0 24 24"
                    width="20"
                    height="20"
                    aria-hidden="true"
                    focusable="false"
                  >
                    <path d={social.path} fill="currentColor" />
                  </svg>
                </a>
              ))}
            </div>
            <p className="cc-footer-legal">{FOOTER_COPYRIGHT}</p>
          </div>
          {/* The application code is public too (Open Source › Source code). */}
          <p className="cc-footer-license">Our code is open source (Apache-2.0)</p>
          <div className="cc-footer-bottom-links">
            <a href={LINKS.downtown}>Open source</a>
            <a href="/downtown/verify">Verify</a>
            <a href={LINKS.downtownJson}>downtown.json</a>
            <a href={LINKS.downtownMd}>downtown.md</a>
          </div>
        </div>
      </div>
    </footer>
  );
}
