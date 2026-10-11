import { useEffect, useId, useState } from 'react';
import { Check } from 'lucide-react';
import { api } from '../api';
import { ElricSheet } from './ElricSheet';
import { usageShare } from './elricV3';

/** GET /api/elric as this sheet reads it (server/elric/service.ts ElricStatus). */
type Status = {
  agent_id?: string | null;
  status?: 'active' | 'paused' | 'revoked' | null;
  host_may_invoke?: boolean;
  eligible?: boolean;
  usage?: {
    used: Record<'short' | 'summary' | 'tool', number>;
    allowance: Record<'short' | 'summary' | 'tool', number>;
    resets_at: string;
  };
};

const KINDS = [
  ['short', 'Answers'],
  ['summary', 'Summaries'],
  ['tool', 'Tasks'],
] as const;

/**
 * Manage Elric (WORKSPACE_V3_ELRIC_AGENTS.md §1): the owner's Elric settings that exist today,
 * read fresh from GET /api/elric when the sheet opens.
 * - "Room hosts can ask your Elric": host_may_invoke (PUT /api/elric/settings).
 * - Today's allowance per type, and when it resets.
 * - Google linked / age confirmed, Pause or Resume (POST /api/elric/pause, /resume).
 * - Activity, the turn log and Revoke stay on the console's Elric page (/#elric).
 * The mockup's other switches (Elric in new rooms by default, daily catch-up, act without asking)
 * have no setting behind them yet, so they are not drawn.
 */
export function ManageElricSheet({
  onClose,
  onStatus,
}: {
  onClose: () => void;
  /** Elric was paused or resumed here: the chat follows at once. */
  onStatus: (status: 'active' | 'paused') => void;
}) {
  const [status, setStatus] = useState<Status | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const hostsId = useId();
  useEffect(() => {
    let live = true;
    api<Status>('/api/elric', undefined, 'GET')
      .then((value) => live && setStatus(value))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, []);

  async function power(action: 'pause' | 'resume') {
    setBusy(true);
    setError('');
    try {
      await api(`/api/elric/${action}`, {});
      const next = action === 'pause' ? 'paused' : 'active';
      setStatus((current) => (current ? { ...current, status: next } : current));
      onStatus(next);
    } catch {
      setError('That didn’t work. Try again.');
    } finally {
      setBusy(false);
    }
  }

  async function hosts(allowed: boolean) {
    setBusy(true);
    setError('');
    try {
      const saved = await api<{ host_may_invoke: boolean }>(
        '/api/elric/settings',
        { host_may_invoke: allowed },
        'PUT',
      );
      setStatus((current) =>
        current ? { ...current, host_may_invoke: saved.host_may_invoke ?? allowed } : current,
      );
    } catch {
      setError('The setting couldn’t be saved. Try again.');
    } finally {
      setBusy(false);
    }
  }

  const state = status?.status ?? null;
  const usage = status?.usage;
  return (
    <ElricSheet title="Manage Elric" onClose={onClose} className="elx3-manage">
      {failed ? (
        <p className="elx3-sheet-text" role="alert">
          Elric’s settings couldn’t be loaded. Try again.
        </p>
      ) : !status ? (
        <p className="elx3-sheet-text" role="status">
          Loading…
        </p>
      ) : (
        <>
          <p className="elx3-sheet-status">
            <span className={`elx3-status ${state === 'active' ? 'is-ok' : 'is-idle'}`}>
              <i aria-hidden="true" />
              {state === 'active' ? 'On' : state === 'paused' ? 'Paused' : 'Off'}
            </span>
          </p>
          <ul className="elx3-list">
            {/* The whole row is the target: its text is the switch's label (44px and up). */}
            <li className="elx3-row elx3-row-switch">
              <label className="elx3-row-text" htmlFor={`${hostsId}-switch`}>
                <span id={hostsId}>Room hosts can ask your Elric</span>
                <small>In a room someone else hosts, the host can mention your Elric too.</small>
              </label>
              <button
                type="button"
                role="switch"
                id={`${hostsId}-switch`}
                className="elx3-switch"
                aria-labelledby={hostsId}
                aria-checked={status.host_may_invoke === true}
                disabled={!status.agent_id}
                aria-disabled={busy || undefined}
                onClick={() => {
                  if (!busy) void hosts(status.host_may_invoke !== true);
                }}
              />
            </li>
            {usage ? (
              <li className="elx3-row elx3-usage">
                <span className="elx3-row-text">
                  <span>Today</span>
                  <small>
                    Resets at {new Date(usage.resets_at).toISOString().slice(11, 16)} UTC
                  </small>
                </span>
                <dl aria-label="Used today">
                  {KINDS.map(([kind, name]) => {
                    const used = usage.used[kind] ?? 0;
                    const allowance = usage.allowance[kind] ?? 0;
                    const meter = usageShare(used, allowance);
                    return (
                      <div key={kind}>
                        <dt>{name}</dt>
                        <dd>
                          <span
                            className="elx3-meter"
                            data-full={meter.full ? 'true' : undefined}
                            role="meter"
                            aria-label={`${name} used today`}
                            aria-valuemin={0}
                            aria-valuemax={allowance}
                            aria-valuenow={Math.min(used, allowance)}
                            aria-valuetext={`${used} of ${allowance}`}
                          >
                            <span style={{ width: `${meter.share * 100}%` }} />
                          </span>
                          {used} / {allowance}
                        </dd>
                      </div>
                    );
                  })}
                </dl>
              </li>
            ) : null}
          </ul>
          {error ? (
            <p className="elx3-sheet-error" role="alert">
              {error}
            </p>
          ) : null}
          <div className="elx3-sheet-foot">
            <span className="elx3-sheet-facts">
              {status.eligible ? (
                <>
                  <Check size={14} strokeWidth={2.4} aria-hidden="true" />
                  Google account linked · Age confirmed
                </>
              ) : null}
            </span>
            <a className="elx3-btn is-ghost" href="/#elric">
              Activity
            </a>
            {state === 'active' || state === 'paused' ? (
              // One button that changes its words: focus stays on it after Pause or Resume.
              <button
                type="button"
                className={`elx3-btn ${state === 'paused' ? 'is-primary' : 'is-ghost'}`}
                aria-disabled={busy || undefined}
                onClick={() => {
                  if (!busy) void power(state === 'paused' ? 'resume' : 'pause');
                }}
              >
                {state === 'paused' ? 'Resume Elric' : 'Pause Elric'}
              </button>
            ) : null}
          </div>
        </>
      )}
    </ElricSheet>
  );
}
