import { ChevronLeft } from 'lucide-react';
import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { selectedWorkspaceId } from '../../api';
import { READ_DEADLINE_MS } from './messagesRoomsShared';
import { sameScope, type ReadScope, type ReadDeps } from './activityDeveloperReads';
import './activity-developer.css';

/*
 * What the Activity and Developer details screens share: the agent pane's own frame (the ap4-*
 * classes of src/agents/v4/agent-pane.css, like its Remove screen) and the hook that binds a
 * screen's reads to the agent and workspace it shows.
 */

interface Reads {
  show: (agentId: string, workspace: string | null) => void;
  close: () => void;
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => { scope: ReadScope | null };
}

/**
 * The reads of one screen, pointed at this agent in the workspace selected now. Until they have
 * moved there (the effect runs after the render), `mine` is false and the screen shows nothing of
 * the previous pair; closing the screen drops every answer still on its way.
 */
export function useScreenReads<R extends Reads>(
  make: (deps: Partial<ReadDeps>) => R,
  agentId: string,
): { reads: R; snapshot: ReturnType<R['getSnapshot']>; mine: boolean } {
  const workspace = selectedWorkspaceId();
  const [reads] = useState(() => make({ deadlineMs: READ_DEADLINE_MS }));
  useEffect(() => {
    reads.show(agentId, workspace);
    return () => reads.close();
  }, [reads, agentId, workspace]);
  const snapshot = useSyncExternalStore(reads.subscribe, reads.getSnapshot) as ReturnType<
    R['getSnapshot']
  >;
  return { reads, snapshot, mine: sameScope(snapshot.scope, agentId, workspace) };
}

/** A pushed screen of the pane: the back link, the title, the body. */
export function PaneScreen({
  backLabel,
  onBack,
  title,
  children,
}: {
  backLabel: string;
  onBack: () => void;
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="ap4-wrap ad4">
      <button type="button" className="ap4-back" onClick={onBack}>
        <ChevronLeft size={16} aria-hidden="true" />
        {backLabel}
      </button>
      <h3 className="ap4-title">{title}</h3>
      {children}
    </div>
  );
}

/** While a read is on its way: one quiet row (every read has a deadline, so it always ends). */
export function PaneLoading() {
  return (
    <div className="ap4-group" role="status" aria-label="Loading">
      <div className="ap4-row ad4-still">
        <span className="ad4-spin" />
      </div>
    </div>
  );
}

/** A failed read: one line and Try again. */
export function PaneError({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="ad4-error" role="alert">
      <p className="ap4-note">{message}</p>
      {onRetry ? (
        <button type="button" className="ap4-btn ap4-ghost" onClick={onRetry}>
          Try again
        </button>
      ) : null}
    </div>
  );
}
