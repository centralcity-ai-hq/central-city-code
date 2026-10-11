import { useEffect, useRef, type ReactNode } from 'react';
import { Activity, ChevronLeft, CircleUserRound, Download, Plug } from 'lucide-react';
import { navigate } from '../shell/navigation';
import './settings-v2.css';

/** The four Settings sections of the Workspace v2 preview, in rail order. */
export type SettingsSection = 'assistants' | 'data' | 'activity' | 'account';

export const SETTINGS_SECTIONS: { id: SettingsSection; label: string; icon: typeof Plug }[] = [
  { id: 'assistants', label: 'Connected apps', icon: Plug },
  { id: 'data', label: 'Data & export', icon: Download },
  { id: 'activity', label: 'Activity log', icon: Activity },
  { id: 'account', label: 'Account', icon: CircleUserRound },
];

/** Whether a console view is one of the Settings sections (Account is a path, not a view). */
export function isSettingsSection(view: string): view is SettingsSection {
  return SETTINGS_SECTIONS.some((section) => section.id === view);
}

/**
 * Workspace v2 Settings: a page header, a section rail (a horizontal strip on phones) and the
 * section's own content. Navigation only: every section keeps its data and server calls.
 */
export function SettingsLayout({
  section,
  onSection,
  children,
}: {
  section: SettingsSection;
  onSection: (section: SettingsSection) => void;
  children: ReactNode;
}) {
  const current = useRef<HTMLButtonElement>(null);
  const mounted = useRef(false);
  useEffect(() => {
    // On phones the rail is a horizontal strip: keep the current section in view. The first
    // pass jumps; later changes glide unless the visitor asked for reduced motion.
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    current.current?.scrollIntoView({
      inline: 'nearest',
      block: 'nearest',
      behavior: mounted.current && !reduced ? 'smooth' : 'auto',
    });
    mounted.current = true;
  }, [section]);
  return (
    <div className="stv2">
      <header className="stv2-header">
        <div>
          <h1>Settings</h1>
        </div>
        <a
          className="stv2-back"
          href="/rooms"
          onClick={(event) => {
            if (event.metaKey || event.ctrlKey || event.shiftKey || event.button) return;
            event.preventDefault();
            navigate('/rooms');
          }}
        >
          <ChevronLeft size={16} aria-hidden="true" />
          Back to Rooms
        </a>
      </header>
      <div className="stv2-body">
        <nav className="stv2-rail" aria-label="Settings sections">
          {SETTINGS_SECTIONS.map((item) => (
            <button
              key={item.id}
              ref={item.id === section ? current : undefined}
              type="button"
              className="stv2-rail-item"
              aria-current={item.id === section ? 'page' : undefined}
              onClick={() => {
                if (item.id !== section) onSection(item.id);
              }}
            >
              <item.icon size={18} strokeWidth={1.7} aria-hidden="true" />
              <span>{item.label}</span>
            </button>
          ))}
        </nav>
        <div className="stv2-panel">{children}</div>
      </div>
    </div>
  );
}

/** A section's heading row: title, one line of context and an optional primary action. */
export function SettingsSectionHead({
  title,
  lede,
  action,
}: {
  title: string;
  lede: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="stv2-head">
      <div>
        <h2>{title}</h2>
        <p>{lede}</p>
      </div>
      {action ? <div className="stv2-head-action">{action}</div> : null}
    </div>
  );
}

/** Card-shaped placeholders that mirror a list while it loads (hidden from assistive tech). */
export function SettingsSkeleton({ rows = 2 }: { rows?: number }) {
  return (
    <div className="stv2-skeletons" aria-hidden="true">
      {Array.from({ length: rows }, (_, index) => (
        <span key={index} className="stv2-skeleton">
          <span />
          <span />
        </span>
      ))}
    </div>
  );
}

/** Loading state: the announced label (role=status) above the placeholders. */
export function SettingsLoading({ label, rows = 2 }: { label: string; rows?: number }) {
  return (
    <div className="stv2-loading">
      <p role="status" aria-live="polite" aria-busy="true" className="stv2-loading-label">
        {label}
      </p>
      <SettingsSkeleton rows={rows} />
    </div>
  );
}

/** Empty state: icon, a short title and what fills the space. */
export function SettingsEmpty({
  icon,
  title,
  children,
  action,
}: {
  icon: ReactNode;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="stv2-empty">
      <span className="stv2-empty-icon" aria-hidden="true">
        {icon}
      </span>
      <p className="stv2-empty-title">{title}</p>
      {children ? <p>{children}</p> : null}
      {action}
    </div>
  );
}
