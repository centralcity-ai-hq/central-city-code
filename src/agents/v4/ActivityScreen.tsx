import { useMemo } from 'react';
import { ActivityNameReads, ActivityReads } from './activityDeveloperReads';
import { PaneError, PaneLoading, PaneScreen, useScreenReads } from './activityDeveloperShared';
import { activityTime, groupByDay, withAgent } from './activityDeveloperModel';
import { failure, type AgentScreenProps } from './messagesRoomsShared';

/**
 * Activity of one agent (GET /api/agents/:id/activity, owner or co-owner): its events and runs in
 * day groups, newest first, with a status pill on each run. The newest page is re-read every 10 s
 * while the page is visible; older pages load with "Show older". Every read is bound to the agent
 * and workspace shown when it starts (src/agents/v4/activityDeveloperReads.ts). Event lines name
 * the agents and rooms the owner may see instead of their IDs, so the feed shows once those names
 * are read (or failed): an agent of the owner never reads as another owner's for a moment.
 * Empty: "Nothing yet".
 */
export function ActivityScreen({ agent, onBack, backLabel }: AgentScreenProps) {
  const { reads, snapshot, mine } = useScreenReads((deps) => new ActivityReads(deps), agent.id);
  const named = useScreenReads((deps) => new ActivityNameReads(deps), agent.id);
  const feed = mine ? snapshot.feed : null;
  const error = mine ? snapshot.error : null;
  const read = named.mine ? named.snapshot.names : null;
  const names = useMemo(
    () => (read ? withAgent(read, { id: agent.id, name: agent.name }) : null),
    [read, agent.id, agent.name],
  );
  const now = Date.now();
  const days = feed && names ? groupByDay(feed.items, now, undefined, names) : [];

  return (
    <PaneScreen backLabel={backLabel ?? agent.name} onBack={onBack} title="Activity">
      {!feed && error ? (
        <PaneError
          message={failure(error)}
          onRetry={() => {
            reads.reload();
            named.reads.reload();
          }}
        />
      ) : !feed || !names ? (
        <PaneLoading />
      ) : days.length ? (
        <>
          {days.map((day) => (
            <section key={day.day} className="ad4-day" aria-label={day.label}>
              <h4>{day.label}</h4>
              <div className="ap4-group" role="list">
                {day.rows.map((row) => (
                  <div key={row.key} className="ap4-row ad4-still" role="listitem">
                    <span className="ad4-two">
                      <b>{row.title}</b>
                      <time dateTime={row.at} title={new Date(row.at).toLocaleString()}>
                        {activityTime(row.at, now)}
                      </time>
                    </span>
                    {row.status ? (
                      <span className="ad4-status" data-tone={row.status.tone}>
                        {row.status.label}
                      </span>
                    ) : null}
                  </div>
                ))}
              </div>
            </section>
          ))}
          {snapshot.olderError ? <PaneError message={failure(snapshot.olderError)} /> : null}
          {feed.nextBefore ? (
            <button
              type="button"
              className="ap4-btn ap4-ghost ad4-older"
              disabled={snapshot.older}
              aria-busy={snapshot.older || undefined}
              onClick={() => void reads.showOlder()}
            >
              {snapshot.older ? <span className="ad4-spin" aria-hidden="true" /> : null}
              Show older
            </button>
          ) : null}
        </>
      ) : (
        <div className="ad4-empty">
          <b>Nothing yet</b>
          <span>What {agent.name} does shows up here.</span>
        </div>
      )}
    </PaneScreen>
  );
}
