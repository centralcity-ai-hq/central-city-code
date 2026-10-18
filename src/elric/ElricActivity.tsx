import { useCallback, useEffect, useRef, useState } from 'react';
import { ExternalLink, LoaderCircle, Pause, Play, ShieldOff } from 'lucide-react';
import { api } from '../api';
import { formatDate, Modal } from '../components';
import { ELRIC_AI_TAG } from '../../shared/elric-copy';
import './elric.css';

/**
 * The owner's Elric page in the console (docs/ELRIC.md "Owner console"): status and controls
 * (pause, resume, revoke with confirmation), today's allowance per type, and what Elric did:
 * GET /api/elric/turns, newest first, filtered by room and result. The turn log has no message
 * content, and neither does this page.
 */
type Kind = 'short' | 'summary' | 'tool';
type Result = 'posted' | 'refused' | 'limit' | 'cancelled' | 'error';
export type ElricStatusView = {
  agent_id: string | null;
  status: 'active' | 'paused' | 'revoked' | null;
  usage: {
    used: Record<Kind, number>;
    allowance: Record<Kind, number>;
    resets_at: string;
  };
};
type Turn = {
  id: string;
  room_id: string | null;
  invoker_kind: 'owner' | 'host' | 'other';
  tier: 0 | 1 | 2 | null;
  model: string | null;
  input_tokens: number;
  output_tokens: number;
  cost_units: number;
  tool_calls: Array<{ name: string; status: string }>;
  result: Result;
  reason_code: string;
  room: { id: string; name: string } | null;
  link: string | null;
  created_at: string;
};
type Page = { turns: Turn[]; next_cursor: string | null };
/** An open pending action (GET /api/elric/pending): the cleaned task title and description. */
export type PendingItem = {
  id: string;
  tool: string;
  summary: string | null;
  detail?: string | null;
  args_hash: string;
  room: { id: string; name: string } | null;
  created_at: string;
  expires_at: string;
};
const TOOL: Record<string, string> = { room_task_create: 'Create a task' };

const KINDS: Array<[Kind, string]> = [
  ['short', 'Answers'],
  ['summary', 'Summaries'],
  ['tool', 'Tasks'],
];
const RESULTS: Array<[Result, string]> = [
  ['posted', 'Posted'],
  ['refused', 'Refused'],
  ['limit', 'Limit'],
  ['cancelled', 'Cancelled'],
  ['error', 'Error'],
];
const TRIGGER: Record<Turn['invoker_kind'], string> = {
  owner: 'You',
  host: 'Room host',
  other: 'Someone else',
};
const STATUS: Record<NonNullable<ElricStatusView['status']>, string> = {
  active: 'Active',
  paused: 'Paused',
  revoked: 'Revoked',
};
const label = (value: string) => value.replace(/_/g, ' ');
const LOAD_FAILED = 'Elric’s activity could not be loaded.';

/** The status chip: unknown (not "Not added") while the status could not be loaded. */
export function statusChipLabel(state: ElricStatusView['status'], loadFailed: boolean) {
  if (state) return STATUS[state];
  return loadFailed ? 'Status unknown' : 'Not added';
}

/** A failed load of the page: one line and "Try again", which loads everything again. */
export function ElricActivityLoadFailed({ onRetry }: { onRetry: () => void }) {
  return (
    <p className="form-error" role="alert">
      {LOAD_FAILED}{' '}
      <button type="button" className="button secondary" onClick={onRetry}>
        Try again
      </button>
    </p>
  );
}

/**
 * Loads one page of turns and hands it to `apply` only if no newer load started meanwhile
 * (`generation` is bumped by every new filter or retry), so a slow answer for an old filter
 * never replaces the list or the cursor of the new one.
 */
export async function loadIfCurrent<T>(
  generation: { current: number },
  fetchPage: () => Promise<T>,
  apply: (page: T) => void,
) {
  const asked = generation.current;
  const page = await fetchPage();
  if (asked === generation.current) apply(page);
}

export function ElricActivity() {
  const [status, setStatus] = useState<ElricStatusView | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [room, setRoom] = useState('');
  const [result, setResult] = useState('');
  const [rooms, setRooms] = useState<Map<string, string>>(new Map());
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState('');
  const [pending, setPending] = useState<PendingItem[]>([]);
  const [loadFailed, setLoadFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const generation = useRef(0);

  const loadStatus = useCallback(async () => {
    setStatus(await api<ElricStatusView>('/api/elric'));
  }, []);
  const loadPending = useCallback(async () => {
    setPending((await api<{ pending: PendingItem[] }>('/api/elric/pending')).pending);
  }, []);
  const loadTurns = useCallback(
    async (after: string | null) => {
      const query = new URLSearchParams({ limit: '25' });
      if (after) query.set('cursor', after);
      if (room) query.set('room_id', room);
      if (result) query.set('result', result);
      await loadIfCurrent(
        generation,
        () => api<Page>(`/api/elric/turns?${query}`),
        (page) => {
          setTurns((current) => (after ? [...current, ...page.turns] : page.turns));
          setCursor(page.next_cursor);
          setRooms((current) => {
            const next = new Map(current);
            for (const turn of page.turns) if (turn.room) next.set(turn.room.id, turn.room.name);
            return next;
          });
        },
      );
    },
    [room, result],
  );
  useEffect(() => {
    let active = true;
    // A new filter or a retry: answers of earlier loads no longer land.
    generation.current += 1;
    setLoading(true);
    // The approval list is extra: if it cannot load, the activity still shows.
    Promise.all([loadStatus(), loadTurns(null), loadPending().catch(() => setPending([]))])
      .then(() => {
        if (!active) return;
        setError('');
        setLoadFailed(false);
      })
      .catch(() => {
        if (!active) return;
        setError('');
        setLoadFailed(true);
      })
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [loadStatus, loadTurns, loadPending, attempt]);

  async function control(action: 'pause' | 'resume' | 'revoke') {
    setBusy(true);
    try {
      await api(`/api/elric/${action}`, {});
      await loadStatus();
      setError('');
    } catch {
      setError('That did not work. Try again.');
    } finally {
      setBusy(false);
      setConfirm(false);
    }
  }
  async function decide(item: PendingItem, decision: 'approve' | 'reject') {
    setBusy(true);
    try {
      await api(
        `/api/elric/pending/${encodeURIComponent(item.id)}/${decision}`,
        decision === 'approve' ? { args_hash: item.args_hash } : {},
      );
      setError('');
    } catch {
      setError(
        decision === 'approve'
          ? 'This action could not be approved.'
          : 'That did not work. Try again.',
      );
    } finally {
      await Promise.all([loadPending(), loadTurns(null)]).catch(() => undefined);
      setBusy(false);
    }
  }
  async function more() {
    setBusy(true);
    try {
      await loadTurns(cursor);
    } catch {
      setError('More activity could not be loaded. Try again.');
    } finally {
      setBusy(false);
    }
  }

  const state = status?.status ?? null;
  return (
    <div className="elric-page">
      <section className="panel elric-head" aria-label="Elric">
        <div className="elric-state">
          <h2>Elric</h2>
          <span className={`elric-chip ${state ?? 'none'}`} data-testid="elric-status">
            {statusChipLabel(state, loadFailed)}
          </span>
        </div>
        {state === 'active' || state === 'paused' ? (
          <div className="elric-controls">
            {state === 'active' ? (
              <button
                type="button"
                className="button secondary"
                disabled={busy}
                onClick={() => void control('pause')}
              >
                <Pause size={16} aria-hidden="true" /> Pause
              </button>
            ) : (
              <button
                type="button"
                className="button secondary"
                disabled={busy}
                onClick={() => void control('resume')}
              >
                <Play size={16} aria-hidden="true" /> Resume
              </button>
            )}
            <button
              type="button"
              className="button danger"
              disabled={busy}
              onClick={() => setConfirm(true)}
            >
              <ShieldOff size={16} aria-hidden="true" /> Revoke
            </button>
          </div>
        ) : null}
        {status ? (
          <dl className="elric-usage" aria-label="Today">
            {KINDS.map(([kind, name]) => {
              const used = status.usage.used[kind];
              const allowance = status.usage.allowance[kind];
              // Today's use of each kind against its allowance: a meter, full (warn) at the limit.
              const share = allowance > 0 ? Math.min(used / allowance, 1) : 1;
              const level = share >= 1 ? 'full' : share >= 0.8 ? 'high' : 'ok';
              return (
                <div key={kind}>
                  <dt>{name}</dt>
                  <dd>
                    {used} / {allowance}
                    <span
                      className="elric-meter"
                      data-level={level}
                      role="meter"
                      aria-label={`${name} used today`}
                      aria-valuemin={0}
                      aria-valuemax={allowance}
                      aria-valuenow={Math.min(used, allowance)}
                      aria-valuetext={`${used} of ${allowance}`}
                    >
                      <span style={{ width: `${share * 100}%` }} />
                    </span>
                  </dd>
                </div>
              );
            })}
            <div>
              <dt>Resets</dt>
              <dd>{new Date(status.usage.resets_at).toISOString().slice(11, 16)} UTC</dd>
            </div>
          </dl>
        ) : null}
      </section>

      {pending.length ? (
        <section className="panel elric-log" aria-labelledby="elric-pending-title">
          <h2 id="elric-pending-title">Waiting for your approval</h2>
          <ul className="elric-turns" aria-label="Waiting for your approval">
            {pending.map((item) => (
              <li key={item.id} className="elric-turn" data-testid="elric-pending">
                <div className="elric-turn-main">
                  <strong>{TOOL[item.tool] ?? label(item.tool)}</strong>
                  <span>{item.room ? item.room.name : 'Room not available'}</span>
                  <time dateTime={item.expires_at}>Until {formatDate(item.expires_at)}</time>
                </div>
                {item.summary ? <p className="elric-summary">{item.summary}</p> : null}
                {item.detail ? (
                  <p className="elric-summary elric-detail" data-testid="elric-pending-detail">
                    {item.detail}
                  </p>
                ) : null}
                <div className="elric-controls elric-decide">
                  <button
                    type="button"
                    className="button secondary"
                    disabled={busy}
                    onClick={() => void decide(item, 'reject')}
                  >
                    Reject
                  </button>
                  <button
                    type="button"
                    className="button primary"
                    disabled={busy}
                    onClick={() => void decide(item, 'approve')}
                  >
                    Approve
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {loadFailed ? <ElricActivityLoadFailed onRetry={() => setAttempt((n) => n + 1)} /> : null}
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}

      <section className="panel elric-log" aria-labelledby="elric-log-title">
        <div className="elric-log-head">
          <h2 id="elric-log-title">Activity</h2>
          <div className="elric-filters">
            <label>
              <span>Room</span>
              <select value={room} onChange={(event) => setRoom(event.target.value)}>
                <option value="">All rooms</option>
                {[...rooms].map(([id, name]) => (
                  <option key={id} value={id}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>Result</span>
              <select value={result} onChange={(event) => setResult(event.target.value)}>
                <option value="">All results</option>
                {RESULTS.map(([value, name]) => (
                  <option key={value} value={value}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>
        {loading ? (
          <p className="elric-quiet" role="status">
            <LoaderCircle className="spin" size={15} aria-hidden="true" /> Loading
          </p>
        ) : turns.length ? (
          <ol className="elric-turns" aria-label="Elric activity">
            {turns.map((turn) => (
              <li key={turn.id} className="elric-turn" data-testid="elric-turn">
                <div className="elric-turn-main">
                  <span className={`elric-result ${turn.result}`}>
                    {RESULTS.find(([value]) => value === turn.result)?.[1]}
                  </span>
                  <strong>{turn.room ? turn.room.name : 'Room not available'}</strong>
                  <time dateTime={turn.created_at}>{formatDate(turn.created_at)}</time>
                </div>
                <dl className="elric-turn-facts">
                  <div>
                    <dt>By</dt>
                    <dd>{TRIGGER[turn.invoker_kind]}</dd>
                  </div>
                  <div>
                    <dt>Model</dt>
                    <dd>
                      {turn.tier === null
                        ? 'None'
                        : turn.tier === 0
                          ? 'Tier 0'
                          : `Tier ${turn.tier} · ${ELRIC_AI_TAG}`}
                    </dd>
                  </div>
                  <div>
                    <dt>Tokens</dt>
                    <dd>
                      {turn.input_tokens.toLocaleString()} in ·{' '}
                      {turn.output_tokens.toLocaleString()} out
                    </dd>
                  </div>
                  <div>
                    <dt>Units</dt>
                    <dd>{turn.cost_units.toLocaleString()}</dd>
                  </div>
                  {turn.tool_calls.length ? (
                    <div>
                      <dt>Tools</dt>
                      <dd>
                        {turn.tool_calls
                          .map((call) => `${call.name} (${label(call.status)})`)
                          .join(', ')}
                      </dd>
                    </div>
                  ) : null}
                  {turn.result !== 'posted' ? (
                    <div>
                      <dt>Reason</dt>
                      <dd>{label(turn.reason_code)}</dd>
                    </div>
                  ) : null}
                </dl>
                {turn.link ? (
                  <a className="elric-link" href={turn.link}>
                    Open room <ExternalLink size={14} aria-hidden="true" />
                  </a>
                ) : null}
              </li>
            ))}
          </ol>
        ) : (
          <p className="elric-quiet">No activity yet.</p>
        )}
        {cursor && !loading ? (
          <button
            type="button"
            className="button secondary elric-more"
            disabled={busy}
            onClick={() => void more()}
          >
            Load more
          </button>
        ) : null}
      </section>

      {confirm ? (
        <Modal title="Revoke Elric?" onClose={() => setConfirm(false)}>
          <p className="elric-confirm">Elric stops at once. You can add a new Elric later.</p>
          <div className="elric-controls">
            <button type="button" className="button secondary" onClick={() => setConfirm(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="button danger"
              disabled={busy}
              onClick={() => void control('revoke')}
            >
              Revoke Elric
            </button>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}
