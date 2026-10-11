import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { sectionsOf, type NavGroup, type NavItem } from './links';

/**
 * The phone menu (under 900 px): a full-screen sheet with the header's four groups as simple
 * expandable sections, then Sign in (or Open app) and the theme. Loaded only when the menu opens,
 * so the first load of a public page stays small.
 */
export default function PhoneMenu({
  id,
  groups,
  renderLink,
  signIn,
  theme,
  chevron,
  closing = false,
  onClose,
}: {
  id: string;
  groups: NavGroup[];
  renderLink: (item: NavItem) => ReactNode;
  signIn: ReactNode;
  /** The theme toggle (passed in, so this chunk shares no module with the page). */
  theme: ReactNode;
  /** The sections' chevron icon (from the page, like the theme toggle). */
  chevron: ReactNode;
  /** Leaving: the menu plays its exit (motion.css) and takes no more input. */
  closing?: boolean;
  /** Closes the menu; after Escape, focus returns to the menu button. */
  onClose: (escape: boolean) => void;
}) {
  const sheet = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  // Focus moves into the menu once, when it opens; Escape closes it.
  useEffect(() => {
    sheet.current?.querySelector<HTMLElement>('a, button')?.focus();
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close.current(true);
    };
    document.addEventListener('keydown', escape);
    return () => document.removeEventListener('keydown', escape);
  }, []);
  return (
    <div
      ref={sheet}
      id={id}
      className="cc-header-menu"
      data-state={closing ? 'closing' : undefined}
      inert={closing}
      onClick={(event) => {
        if ((event.target as HTMLElement).closest('a')) onClose(false);
      }}
    >
      <nav aria-label="Menu">
        {groups.map((group) => (
          <MenuGroup key={group.id} group={group} renderLink={renderLink} chevron={chevron} />
        ))}
        {signIn}
      </nav>
      <div className="cc-header-menu-theme">
        <span>Theme</span>
        {theme}
      </div>
    </div>
  );
}

function MenuGroup({
  group,
  renderLink,
  chevron,
}: {
  group: NavGroup;
  chevron: ReactNode;
  renderLink: (item: NavItem) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  return (
    <div className="cc-menu-group">
      <button
        type="button"
        className="cc-menu-group-button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
      >
        {group.label}
        {chevron}
      </button>
      {/* Eases open and shut; closed, its links are hidden from everyone (motion.css). */}
      <div id={panelId} className="cc-collapse" data-open={open ? 'true' : undefined}>
        <div>
          {sectionsOf(group.items).map(({ section, items }) => (
            <div key={section ?? ''} className="cc-mega-section">
              {section ? <p className="cc-mega-label">{section}</p> : null}
              <ul className="cc-menu-group-panel" role="list" aria-label={section ?? undefined}>
                {items.map((item) => (
                  <li key={item.href}>{renderLink(item)}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
