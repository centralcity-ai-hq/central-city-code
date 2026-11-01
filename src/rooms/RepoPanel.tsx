import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { X } from 'lucide-react';
import type { Room } from './api';
import {
  connectRepo,
  disconnectRepo,
  getRepo,
  previewRepo,
  repoErrorText,
  type RepoPreview,
  type RepoState,
} from './repo';

/*
 * The room's Code panel (docs/ROOM_REPOS.md): which repository the room works on. The
 * host connects one in two steps (check it, then tick the notice and type its name, because every
 * member will be able to read it, also when it is private) and can disconnect it. Members see
 * which repository is connected. Only in the signed-in console: AIs can never connect one.
 */

/** Loads the room's repository; `available` is false when the server has no room repositories. */
export function useRoomRepo(roomId: string) {
  const [state, setState] = useState<RepoState | null>(null);
  const [available, setAvailable] = useState<boolean | null>(null);
  const [error, setError] = useState('');
  const refresh = useCallback(async () => {
    try {
      const value = await getRepo(roomId);
      setAvailable(value !== null);
      if (value) setState(value);
      setError('');
    } catch (err) {
      setError(repoErrorText(err));
    }
  }, [roomId]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  return { state, available, error, refresh, setState };
}

export function RepoPanel({
  room,
  repo,
  onClose,
}: {
  room: Room;
  repo: ReturnType<typeof useRoomRepo>;
  onClose: () => void;
}) {
  const host = room.role === 'host';
  const [name, setName] = useState('');
  const [preview, setPreview] = useState<RepoPreview | null>(null);
  const [agreed, setAgreed] = useState(false);
  const [typed, setTyped] = useState('');
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const binding = repo.state?.binding ?? null;

  function reset() {
    setPreview(null);
    setAgreed(false);
    setTyped('');
  }

  async function check(event: FormEvent) {
    event.preventDefault();
    const value = name
      .trim()
      .replace(/^https:\/\/github\.com\//i, '')
      .replace(/\/+$/, '');
    if (!value) return;
    setBusy(true);
    setError('');
    try {
      setPreview(await previewRepo(room.id, value));
      setAgreed(false);
      setTyped('');
    } catch (err) {
      setError(repoErrorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function connect(event: FormEvent) {
    event.preventDefault();
    if (!preview) return;
    setBusy(true);
    setError('');
    try {
      const { binding: connected } = await connectRepo(room.id, preview.repo, typed.trim());
      repo.setState({ binding: connected, head_sha: null });
      reset();
      setName('');
    } catch (err) {
      setError(repoErrorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    setBusy(true);
    setError('');
    try {
      await disconnectRepo(room.id);
      repo.setState({ binding: null, head_sha: null });
      setConfirmDisconnect(false);
    } catch (err) {
      setError(repoErrorText(err));
    } finally {
      setBusy(false);
    }
  }

  const matches =
    preview !== null && typed.trim().toLowerCase() === preview.confirm_repo.toLowerCase();
  return (
    <aside className="rm-panel rm-repo-panel" aria-label="Code">
      <div className="rm-sheet-head">
        <h2>Code</h2>
        <button type="button" className="rm-icon" aria-label="Close code" onClick={onClose}>
          <X size={18} aria-hidden="true" />
        </button>
      </div>
      <p className="rm-meta">
        Connect a GitHub repository so members can read its files and propose changes. Only you
        decide what becomes a pull request.
      </p>
      {repo.error ? (
        <div className="rm-inline-error" role="alert">
          <span>{repo.error}</span>
          <button type="button" className="rm-quiet" onClick={() => void repo.refresh()}>
            Retry
          </button>
        </div>
      ) : null}
      {!repo.state ? (
        repo.error ? null : (
          <p className="rm-meta" role="status">
            Loading…
          </p>
        )
      ) : binding ? (
        <div className="rm-repo-card">
          <span className="rm-meta">Connected repository</span>
          <strong className="rm-repo-name">{binding.repo}</strong>
          <span className="rm-meta">
            {binding.private ? 'Private' : 'Public'} · main branch {binding.default_branch} ·
            connected {new Date(binding.bound_at).toLocaleDateString()}
          </span>
          {host && !room.closed ? (
            confirmDisconnect ? (
              <div className="rm-confirm">
                <span>Members stop reading {binding.repo} at once.</span>
                <button
                  type="button"
                  className="rm-danger"
                  disabled={busy}
                  onClick={() => void disconnect()}
                >
                  Disconnect
                </button>
                <button
                  type="button"
                  className="rm-quiet"
                  onClick={() => setConfirmDisconnect(false)}
                >
                  Cancel
                </button>
              </div>
            ) : (
              <button
                type="button"
                className="rm-quiet rm-task-cancel"
                onClick={() => setConfirmDisconnect(true)}
              >
                Disconnect repository
              </button>
            )
          ) : null}
        </div>
      ) : !host ? (
        <p className="rm-meta">No repository is connected. Only the host can connect one.</p>
      ) : room.closed ? (
        <p className="rm-meta">No repository is connected. The room is closed.</p>
      ) : !preview ? (
        <form className="rm-task-form" onSubmit={(event) => void check(event)}>
          <label className="rm-field">
            <span>Repository</span>
            <input
              className="rm-input"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="owner/name"
              autoComplete="off"
              spellCheck={false}
              required
            />
          </label>
          <p className="rm-meta">
            The Central City GitHub app must be installed on the repository for your account.
          </p>
          <button type="submit" className="rm-primary" disabled={busy || !name.trim()}>
            {busy ? 'Checking…' : 'Continue'}
          </button>
        </form>
      ) : (
        <form className="rm-task-form" onSubmit={(event) => void connect(event)}>
          <div className="rm-repo-card">
            <span className="rm-meta">Repository</span>
            <strong className="rm-repo-name">{preview.repo}</strong>
            <span className="rm-meta">
              {preview.private ? 'Private' : 'Public'} · main branch {preview.default_branch}
            </span>
          </div>
          <p className="rm-repo-notice" role="note">
            {preview.notice}
          </p>
          <p className="rm-meta">
            Invited AIs in this room can read a connected repository, including a private one.
          </p>
          <label className="rm-check">
            <input
              type="checkbox"
              checked={agreed}
              onChange={(event) => setAgreed(event.target.checked)}
            />
            <span>I understand that every member of this room can read this repository.</span>
          </label>
          <label className="rm-field">
            <span>
              Type <strong className="rm-repo-name">{preview.confirm_repo}</strong> to confirm
            </span>
            <input
              className="rm-input"
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              autoComplete="off"
              spellCheck={false}
              aria-label="Type the repository name to confirm"
            />
          </label>
          <div className="rm-task-actions">
            <button type="submit" className="rm-primary" disabled={busy || !agreed || !matches}>
              {busy ? 'Connecting…' : 'Connect repository'}
            </button>
            <button type="button" className="rm-quiet" onClick={reset}>
              Back
            </button>
          </div>
        </form>
      )}
      {error ? (
        <p className="rm-inline-error" role="alert">
          {error}
        </p>
      ) : null}
    </aside>
  );
}
