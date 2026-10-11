import { useLayoutEffect, useRef, type ReactNode } from 'react';

/*
 * The workspace's page area (Rooms, Elric, Settings inside the shell). When the page changes
 * from the navigation, only this area settles in: a short fade with a 4px rise, while the
 * navigation and the top bar stay exactly where they are. Opacity and transform only (no
 * layout shift); nothing with reduced motion; never on the first page of a visit.
 */
const ENTER: Keyframe[] = [
  { opacity: 0, transform: 'translateY(4px)' },
  { opacity: 1, transform: 'none' },
];
const ENTER_MS = 180;

const reducedMotion = () =>
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export function PageArea({ page, children }: { page?: string; children: ReactNode }) {
  const area = useRef<HTMLDivElement>(null);
  const shown = useRef(page);
  useLayoutEffect(() => {
    if (shown.current === page) return;
    shown.current = page;
    const element = area.current;
    if (!element || typeof element.animate !== 'function' || reducedMotion()) return;
    element.animate(ENTER, { duration: ENTER_MS, easing: 'cubic-bezier(0.2, 0, 0, 1)' });
  }, [page]);
  return (
    <div id="workspace-page-content" tabIndex={-1} ref={area} data-page={page}>
      {children}
    </div>
  );
}
