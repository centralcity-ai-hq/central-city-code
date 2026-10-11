import { ChevronRight, Copy, ExternalLink } from 'lucide-react';
import { DeveloperReads } from './activityDeveloperReads';
import { PaneError, PaneLoading, PaneScreen, useScreenReads } from './activityDeveloperShared';
import type { DeveloperView } from './activityDeveloperModel';
import { failure, type AgentScreenProps } from './messagesRoomsShared';

/** The clipboard; a browser without one fails the copy, which says so. */
async function writeClipboard(text: string): Promise<void> {
  await navigator.clipboard.writeText(text);
}

/**
 * Developer details of one agent: its ID (copy), what it does, template and revision, when and by
 * whom it was created (and under which agent: removing that one removes this one too), what was
 * written about it, the Agent Card, and its key (masked) with Rotate key. Only rows the server has
 * data for.
 * The owner snapshot is read in the agent's workspace when the read starts, and the copy note
 * belongs to this agent (src/agents/v4/activityDeveloperReads.ts).
 */
export function DeveloperScreen({ agent, onBack, onOpen, backLabel }: AgentScreenProps) {
  const { reads, snapshot, mine } = useScreenReads((deps) => new DeveloperReads(deps), agent.id);

  return (
    <PaneScreen backLabel={backLabel ?? agent.name} onBack={onBack} title="Developer details">
      {!mine || snapshot.loading ? (
        <PaneLoading />
      ) : snapshot.error ? (
        <PaneError message={failure(snapshot.error)} onRetry={reads.reload} />
      ) : !snapshot.view ? (
        <PaneError message="This agent isn't in this workspace." onRetry={reads.reload} />
      ) : (
        <DeveloperRows
          view={snapshot.view}
          onCopy={() => void reads.copyId(writeClipboard)}
          onRotate={() => onOpen('rotate')}
        />
      )}
      {mine && snapshot.copy ? (
        <div className="ad4-toast" role="status">
          {snapshot.copy === 'copied' ? 'Copied' : "Couldn't copy"}
        </div>
      ) : null}
    </PaneScreen>
  );
}

function DeveloperRows({
  view,
  onCopy,
  onRotate,
}: {
  view: DeveloperView;
  onCopy: () => void;
  onRotate: () => void;
}) {
  return (
    <>
      <div className="ap4-group">
        <div className="ap4-row ad4-still">
          <span className="ap4-k">Agent ID</span>
          <span className="ap4-v ad4-mono" title={view.id}>
            {view.shortId}
          </span>
          <button
            type="button"
            className="ap4-btn ap4-ghost ap4-sq"
            aria-label="Copy agent ID"
            onClick={onCopy}
          >
            <Copy size={16} aria-hidden="true" />
          </button>
        </div>
        <div className="ap4-row ad4-still">
          <span className="ap4-k">Does</span>
          <span className="ap4-v">{view.does}</span>
        </div>
        {view.template ? (
          <div className="ap4-row ad4-still">
            <span className="ap4-k">Template</span>
            <span className="ap4-v ad4-mono">{view.template}</span>
          </div>
        ) : null}
        <div className="ap4-row ad4-still">
          <span className="ap4-k">Created</span>
          <span className="ap4-v">{view.created}</span>
        </div>
        <div className="ap4-row ad4-still">
          <span className="ap4-k">Created by</span>
          <span className="ap4-v">{view.createdBy}</span>
        </div>
        {view.createdUnder ? (
          <div className="ap4-row ad4-still">
            <span className="ap4-k">Created under</span>
            <span className="ap4-v ap4-v-clip" title={view.createdUnder}>
              {view.createdUnder}
            </span>
          </div>
        ) : null}
        {view.about ? (
          <div className="ap4-row ad4-still ad4-about">
            <span className="ap4-k">About</span>
            <span className="ap4-v">{view.about}</span>
          </div>
        ) : null}
        {view.cardPath ? (
          <a className="ap4-row ad4-link" href={view.cardPath} target="_blank" rel="noreferrer">
            <span className="ap4-k">Agent card</span>
            <span className="ap4-v">
              Open<span className="visually-hidden"> (opens in a new tab)</span>
            </span>
            <ExternalLink className="ap4-chev" size={14} aria-hidden="true" />
          </a>
        ) : null}
      </div>
      {view.key || view.canRotate ? (
        <div className="ap4-group">
          {view.key ? (
            <div className="ap4-row ad4-still">
              <span className="ap4-k">Key</span>
              <span className="ap4-v ad4-mono">{view.key}</span>
            </div>
          ) : null}
          {view.canRotate ? (
            <button type="button" className="ap4-row" onClick={onRotate}>
              <span className="ap4-k">Rotate key</span>
              <ChevronRight className="ap4-chev" size={14} aria-hidden="true" />
            </button>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
