import { useEffect, useState, type ReactElement } from 'react';
import { apiInWorkspace, ApiError, selectedWorkspaceId } from '../../api';

export interface ElricPendingAction {
  id: string;
  tool: string;
  summary: string | null;
  /** The task description the action would create (cleaned by the server). */
  detail?: string | null;
  args_hash: string;
  room: { id: string; name: string } | null;
  created_at: string;
  expires_at: string;
}

export interface ElricApprovalCardProps {
  pendingId: string;
}

const TOOL_LABELS: Record<string, string> = {
  room_task_create: 'Create a task',
  create_room_task: 'Create a task',
  city_room_task_create: 'Create a task',
  room_task_update: 'Update a task',
  update_room_task: 'Update a task',
  city_room_task_update: 'Update a task',
  room_task_delete: 'Delete a task',
  delete_room_task: 'Delete a task',
  city_room_task_delete: 'Delete a task',
  room_task_claim: 'Claim a task',
  claim_room_task: 'Claim a task',
  city_room_task_claim: 'Claim a task',
  room_task_release: 'Release a task',
  release_room_task: 'Release a task',
  city_room_task_release: 'Release a task',
  room_task_result: 'Submit task result',
  city_room_task_result: 'Submit task result',
  room_task_review: 'Review a task',
  city_room_task_review: 'Review a task',
  room_task_renew: 'Renew task lease',
  city_room_task_renew: 'Renew task lease',
};

function formatTool(tool?: string | null): string | null {
  if (!tool) return null;
  return TOOL_LABELS[tool] ?? null;
}

function formatRemaining(totalSeconds: number): string {
  if (totalSeconds <= 0) return 'Expired';
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

/** What the card shows when a decision was refused and the action is no longer open. */
export const APPROVAL_GONE_MESSAGE = 'Already decided or expired.';

type Fetcher = typeof fetch;

/**
 * Reads one open pending action (GET /api/elric/pending) in the selected workspace (api.ts sends
 * X-City-Workspace). 'failed': the read itself failed (the card offers a retry); null: it is not
 * open any more.
 */
export async function loadPendingAction(
  pendingId: string,
  fetcher?: Fetcher,
): Promise<ElricPendingAction | null | 'failed'> {
  try {
    const data = await apiInWorkspace<{ pending?: ElricPendingAction[] }>(
      selectedWorkspaceId(),
      '/api/elric/pending',
      { method: 'GET', ...(fetcher ? { fetcher } : {}) },
    );
    return data?.pending?.find((p) => p.id === pendingId) ?? null;
  } catch {
    return 'failed';
  }
}

export type DecideResult = { ok: true } | { ok: false; gone: boolean; message: string };

/**
 * Approves or rejects one pending action in the selected workspace. When the server refuses, the
 * pending list is read again: an action no longer open was decided elsewhere or expired ('gone').
 * The message is the server's own (plain) wording, or the fallback.
 */
export async function decidePendingAction(
  item: Pick<ElricPendingAction, 'id' | 'args_hash'>,
  decision: 'approve' | 'reject',
  fetcher?: Fetcher,
): Promise<DecideResult> {
  const fallback =
    decision === 'approve' ? 'Could not approve action.' : 'Could not reject action.';
  try {
    await apiInWorkspace(
      selectedWorkspaceId(),
      `/api/elric/pending/${encodeURIComponent(item.id)}/${decision}`,
      {
        body: decision === 'approve' ? { args_hash: item.args_hash } : {},
        ...(fetcher ? { fetcher } : {}),
      },
    );
    return { ok: true };
  } catch (error) {
    const message = error instanceof ApiError && error.message ? error.message : fallback;
    const now = await loadPendingAction(item.id, fetcher);
    if (now === null) return { ok: false, gone: true, message: APPROVAL_GONE_MESSAGE };
    return { ok: false, gone: false, message };
  }
}

/** The card when the pending action could not be read: says so, with a retry. */
export function ElricApprovalLoadFailed({ onRetry }: { onRetry: () => void }): ReactElement {
  return (
    <div
      className="rm-approval-card"
      data-testid="elric-approval-card"
      role="region"
      aria-label="Pending approval"
    >
      <p className="rm-error rm-approval-error" role="alert">
        This approval couldn’t be loaded.
      </p>
      <div className="rm-approval-actions">
        <button type="button" className="rm-btn-sm rm-quiet" onClick={onRetry}>
          Try again
        </button>
      </div>
    </div>
  );
}

/**
 * Inline approval card rendered under Elric's "Waiting for your approval." message.
 * Displays exact action (tool, title, room), live countdown to expiry, and
 * Approve / Reject buttons wired to /api/elric/pending endpoints.
 */
export function ElricApprovalCard({ pendingId }: { pendingId: string }): ReactElement | null {
  const [item, setItem] = useState<ElricPendingAction | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [decision, setDecision] = useState<'approved' | 'rejected' | null>(null);
  const [busy, setBusy] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [remainingSeconds, setRemainingSeconds] = useState<number>(0);
  const [loadFailed, setLoadFailed] = useState<boolean>(false);
  /** The action was decided elsewhere (or expired) after the card loaded: no buttons. */
  const [gone, setGone] = useState<boolean>(false);
  const [attempt, setAttempt] = useState<number>(0);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setLoadFailed(false);
    void loadPendingAction(pendingId).then((found) => {
      if (!active) return;
      if (found === 'failed') setLoadFailed(true);
      else setItem(found);
      setLoading(false);
    });
    return () => {
      active = false;
    };
  }, [pendingId, attempt]);

  useEffect(() => {
    if (!item?.expires_at || decision) return;
    function update() {
      const diff = Math.max(
        0,
        Math.floor((new Date(item!.expires_at).getTime() - Date.now()) / 1000),
      );
      setRemainingSeconds(diff);
    }
    update();
    const interval = setInterval(update, 1000);
    return () => clearInterval(interval);
  }, [item?.expires_at, decision]);

  if (loadFailed && !item && !decision)
    return <ElricApprovalLoadFailed onRetry={() => setAttempt((n) => n + 1)} />;
  if (loading || (!item && !decision)) {
    return null;
  }

  const expired = remainingSeconds <= 0 && !decision;
  const toolLabel = formatTool(item?.tool);

  async function decide(kind: 'approve' | 'reject') {
    if (!item || busy || expired || gone) return;
    setBusy(true);
    setError(null);
    const result = await decidePendingAction(item, kind);
    if (result.ok) setDecision(kind === 'approve' ? 'approved' : 'rejected');
    else {
      setError(result.message);
      if (result.gone) setGone(true);
    }
    setBusy(false);
  }
  const handleApprove = () => void decide('approve');
  const handleReject = () => void decide('reject');

  return (
    <div
      className={`rm-approval-card${decision ? ` decided ${decision}` : ''}${expired ? ' expired' : ''}`}
      data-testid="elric-approval-card"
      role="region"
      aria-label="Pending approval"
    >
      <div className="rm-approval-header">
        {toolLabel ? <span className="rm-approval-tool">{toolLabel}</span> : null}
        {!decision && !gone ? (
          <span className="rm-approval-countdown" data-testid="approval-countdown">
            {expired ? 'Expired' : `${formatRemaining(remainingSeconds)} remaining`}
          </span>
        ) : null}
      </div>

      <div className="rm-approval-body">
        {item?.summary ? (
          <strong className="rm-approval-title" data-testid="approval-title">
            {item.summary}
          </strong>
        ) : null}
        {item?.detail ? (
          <p className="rm-approval-detail" data-testid="approval-detail">
            {item.detail}
          </p>
        ) : null}
        <div className="rm-approval-meta">
          <span className="rm-approval-room" data-testid="approval-room">
            {item?.room?.name ? `Room: ${item.room.name}` : 'This room'}
          </span>
        </div>
      </div>

      {error ? (
        <p className="rm-error rm-approval-error" role="alert">
          {error}
        </p>
      ) : null}

      {decision ? (
        <div className="rm-approval-decided">
          <span
            className={`rm-approval-status ${decision}`}
            data-testid={`approval-status-${decision}`}
          >
            {decision === 'approved' ? 'Approved' : 'Rejected'}
          </span>
        </div>
      ) : !expired && !gone ? (
        <div className="rm-approval-actions">
          <button
            type="button"
            className="rm-btn-sm rm-quiet"
            onClick={handleReject}
            disabled={busy}
            data-testid="approval-reject"
          >
            Reject
          </button>
          <button
            type="button"
            className="rm-btn-sm rm-primary"
            onClick={handleApprove}
            disabled={busy}
            data-testid="approval-approve"
          >
            {busy ? 'Approving…' : 'Approve'}
          </button>
        </div>
      ) : null}
    </div>
  );
}
