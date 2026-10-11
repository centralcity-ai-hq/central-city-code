import { useState } from 'react';
import { Activity, ArrowRight, CircleAlert, LoaderCircle, RefreshCw } from 'lucide-react';
import type { Snapshot } from '../../shared/types';
import { formatDate } from '../components';
import { eventTypeLabel, plainEvent } from '../ui/plainText';
import { activityArea, activityFilters, type ActivityArea } from './activityAreas';
import { SettingsEmpty, SettingsSectionHead, SettingsSkeleton } from './SettingsLayout';
import './account-data.css';

export interface ActivityLogProps {
  snapshot: Snapshot | null;
  refreshing: boolean;
  error: string;
  onRefresh: () => Promise<void>;
  onJob: (jobId: string) => void;
  onExport?: () => void;
}

export function ActivityLog({
  snapshot,
  refreshing,
  error,
  onRefresh,
  onJob,
  onExport,
}: ActivityLogProps) {
  const [chosen, setChosen] = useState<ActivityArea | 'all'>('all');
  const availableJobs = new Set(snapshot?.jobs.map((job) => job.id));
  const events = snapshot?.events ?? [];
  const filters = activityFilters(events);
  // A filter whose events left the latest 100 falls back to All.
  const area = chosen !== 'all' && filters.some((item) => item.id === chosen) ? chosen : 'all';
  const shown = area === 'all' ? events : events.filter((e) => activityArea(e.type) === area);
  const total = `${events.length} recent ${events.length === 1 ? 'event' : 'events'}`;
  return (
    <section className="account-data" aria-label="Activity log">
      <SettingsSectionHead
        title="Activity log"
        lede="The latest 100 events in this workspace, newest first. Only the workspace’s owners see them."
      />
      <div className="account-data-card">
        <div className="account-data-heading">
          <div className="account-data-heading-copy">
            <h3>Recent activity</h3>
            <div role="status" aria-live="polite" className="account-data-muted">
              {!snapshot && !error
                ? 'Loading activity…'
                : refreshing
                  ? 'Refreshing activity…'
                  : snapshot
                    ? area === 'all'
                      ? total
                      : `${shown.length} of ${total}`
                    : ''}
            </div>
          </div>
          <button
            className="button secondary"
            onClick={() => void onRefresh()}
            disabled={refreshing}
            aria-label="Refresh activity"
          >
            {refreshing ? (
              <LoaderCircle size={16} className="spin" aria-hidden="true" />
            ) : (
              <RefreshCw size={16} aria-hidden="true" />
            )}
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
        {error ? (
          <div className="account-data-error" role="alert">
            <CircleAlert size={18} aria-hidden="true" />
            <div>
              <p className="account-data-error-title">
                {snapshot
                  ? 'Activity couldn’t be refreshed. Previously loaded events are still shown.'
                  : 'Activity couldn’t be loaded.'}
              </p>
              <p>{error}</p>
              <button
                className="button secondary"
                onClick={() => void onRefresh()}
                disabled={refreshing}
              >
                Try again
              </button>
            </div>
          </div>
        ) : null}
        {!snapshot && !error ? <SettingsSkeleton rows={3} /> : null}
        {snapshot && filters.length > 1 ? (
          <div className="account-activity-filters" role="group" aria-label="Show events from">
            <button type="button" aria-pressed={area === 'all'} onClick={() => setChosen('all')}>
              All ({events.length})
            </button>
            {filters.map((item) => (
              <button
                key={item.id}
                type="button"
                aria-pressed={area === item.id}
                onClick={() => setChosen(item.id)}
              >
                {item.label} ({item.count})
              </button>
            ))}
          </div>
        ) : null}
        {snapshot ? (
          events.length ? (
            <ol className="account-activity-list" aria-label="Recent events">
              {shown.map((event) => {
                const jobId = event.jobId;
                const message = plainEvent(event.message);
                return (
                  <li key={event.id}>
                    <span className="account-activity-dot" aria-hidden="true" />
                    <div>
                      <p>
                        {jobId && availableJobs.has(jobId) ? (
                          <button className="account-activity-result" onClick={() => onJob(jobId)}>
                            {message}
                            <ArrowRight size={14} aria-hidden="true" />
                          </button>
                        ) : (
                          message
                        )}
                      </p>
                      <div className="account-activity-meta">
                        <time dateTime={event.createdAt}>{formatDate(event.createdAt)}</time>
                        <span className="account-activity-type">{eventTypeLabel(event.type)}</span>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ol>
          ) : (
            <SettingsEmpty icon={<Activity size={22} />} title="No activity yet">
              New agents, connections, and exchanges will appear here as they happen.
            </SettingsEmpty>
          )
        ) : null}
        <div className="account-activity-history">
          <p>
            Only recent events are available here. Your workspace download includes up to 1,000
            retained activity events.
          </p>
          {onExport ? (
            <button className="account-data-link" onClick={onExport}>
              Go to Data & export
              <ArrowRight size={14} aria-hidden="true" />
            </button>
          ) : null}
        </div>
      </div>
    </section>
  );
}
