import { Menu, PanelLeft } from 'lucide-react';
import { CityMark } from '../brand';
import { ELRIC_AI_TAG, ELRIC_NAME } from '../../shared/elric-copy';
import { useLayoutEffect } from 'react';
import { openSidebar } from '../shell/sidebarRooms';
import { ElricMark } from './ElricMark';
import './elric-tokens.css';
import './skeleton.css';

let shownAt = -Infinity;

/** The skeleton was on screen a moment ago: the chat then settles in over it (elric-v3.css). */
export function skeletonJustShown() {
  return performance.now() - shownAt < 3000;
}

/**
 * Elric's page while it opens: the same Workspace v3 frame as the dashboard (the floating top bar
 * with Elric's pill, Manage Elric and New chat; the chats column; the floating composer) so
 * nothing moves when the chat arrives, never a spinner or an empty screen. The placeholders only
 * fade in when the wait is noticeable. Shown while the dashboard's chunk and status load
 * (src/Root.tsx) and while it reads the chat (ElricDashboard).
 */
export function ElricSkeleton({
  embedded = false,
}: {
  embedded?: boolean;
  /** Kept for the route's call; the v3 top bar has no person avatar. */
  initial?: string;
}) {
  useLayoutEffect(() => {
    shownAt = performance.now();
    return () => {
      shownAt = performance.now();
    };
  }, []);
  return (
    <div
      className="elx-skel"
      data-embedded={embedded ? 'true' : undefined}
      data-testid="elric-skeleton"
      aria-busy="true"
    >
      <div className="elx-skel-header">
        {/* The workspace's ☰ chip, usable while the chat opens (the dashboard's bar has it too). */}
        {embedded ? (
          <button
            type="button"
            className="elx-skel-chip elx3-menu"
            aria-label="Open navigation"
            onClick={openSidebar}
          >
            <Menu size={18} aria-hidden="true" />
          </button>
        ) : null}
        {/* The Chats chip on narrow screens, where the dashboard shows it. */}
        <span className="elx-skel-chip elx-skel-toggle" aria-hidden="true">
          <PanelLeft size={17} strokeWidth={1.9} />
        </span>
        {embedded ? null : (
          <span className="elx-skel-chip elx-skel-home" aria-hidden="true">
            <CityMark small />
          </span>
        )}
        <div className="elx-skel-title" aria-hidden="true">
          <ElricMark size="sm" />
          <h1>{ELRIC_NAME}</h1>
          <span className="elx-skel-tag">built-in {ELRIC_AI_TAG}</span>
        </div>
        {/* Manage Elric and New chat as placeholders (their icons come with the dashboard). */}
        <span className="elx-skel-chip elx-skel-manage" aria-hidden="true">
          <span className="elx-skel-icon" />
          <span className="elx-skel-label">Manage Elric</span>
        </span>
        <span className="elx-skel-new" aria-hidden="true">
          <span className="elx-skel-label">New chat</span>
        </span>
      </div>
      <div className="elx-skel-side" aria-hidden="true">
        <span className="elx-skel-bar is-label" />
        <span className="elx-skel-bar is-wide" />
        <span className="elx-skel-bar" />
        <span className="elx-skel-bar is-short" />
      </div>
      <p className="elx-skel-label-sr" role="status">
        Opening Elric…
      </p>
      <div className="elx-skel-dock" aria-hidden="true">
        <div className="elx-skel-composer" />
      </div>
    </div>
  );
}
