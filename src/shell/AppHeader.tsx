import { Menu } from 'lucide-react';
import './shell.css';

/**
 * The phone's top row in the signed-in workspace (docs/design/WORKSPACE_V3.md §1, §3): the round
 * ☰ chip that opens the navigation drawer, and the page title. From 900 px up there is no header
 * bar at all (one calm canvas): each page's own floating pill or heading carries its context and
 * its h1, so this row is hidden there.
 */
export function AppHeader({
  title,
  showTitle = true,
  onOpenNavigation,
}: {
  title: string;
  /** False when the page's own pill already shows the title on a phone (Messages). */
  showTitle?: boolean;
  onOpenNavigation: () => void;
}) {
  return (
    <header className="topbar cc-app-header">
      <div className="cc-app-header-title">
        <button
          type="button"
          className="icon-button mobile-menu"
          onClick={onOpenNavigation}
          aria-label="Open navigation"
        >
          <Menu size={20} aria-hidden="true" />
        </button>
        {showTitle ? <p title={title}>{title}</p> : null}
      </div>
    </header>
  );
}
