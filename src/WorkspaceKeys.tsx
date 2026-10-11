import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { KeyRound, LoaderCircle, RefreshCw } from 'lucide-react';
import { api, selectedWorkspaceId } from './api';
import { permissionLabel } from './AssistantAccess';
import { CopyButton, formatDate } from './components';
import { ASSISTANT_SCOPES, type AssistantScope, type WorkspaceKey } from '../shared/assistant';

/**
 * Keys of an AI-owned workspace (docs/AI_WORKSPACES.md), for its co-owners. The AI created the
 * first key; co-owners can mint more (shown once) and revoke any of them.
 */
export function WorkspaceKeys({ workspaceName }: { workspaceName: string }) {
  const [keys, setKeys] = useState<WorkspaceKey[] | null>(null);
  const [label, setLabel] = useState('Another AI');
  const [scopes, setScopes] = useState<AssistantScope[]>(['workspace:read']);
  const [issued, setIssued] = useState<{ key: WorkspaceKey; workspace_key: string } | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const alive = useRef(true);
  const readVersion = useRef(0);
  const readController = useRef<AbortController | null>(null);
  const acting = useRef(false);

  const load = useCallback(async () => {
    if (!alive.current) return;
    readController.current?.abort();
    const controller = new AbortController();
    readController.current = controller;
    const version = ++readVersion.current;
    const workspace = selectedWorkspaceId();
    const isCurrent = () =>
      alive.current &&
      !controller.signal.aborted &&
      version === readVersion.current &&
      selectedWorkspaceId() === workspace;
    setLoading(true);
    setLoadError('');
    try {
      const value = await api<{ keys: WorkspaceKey[] }>(
        '/api/workspace-keys',
        undefined,
        'GET',
        controller.signal,
      );
      if (isCurrent()) setKeys(value.keys);
    } catch (err) {
      if (isCurrent()) setLoadError(err instanceof Error ? err.message : 'Please try again.');
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, []);
  useEffect(() => {
    alive.current = true;
    void load();
    return () => {
      alive.current = false;
      readVersion.current++;
      readController.current?.abort();
    };
  }, [load]);

  async function run(key: string, fn: () => Promise<void>) {
    if (acting.current) return;
    acting.current = true;
    const workspace = selectedWorkspaceId();
    const isCurrent = () => alive.current && selectedWorkspaceId() === workspace;
    setBusy(key);
    setError('');
    try {
      await fn();
      if (isCurrent()) await load();
    } catch (err) {
      if (isCurrent())
        setError(err instanceof Error ? err.message : "That didn't work. Try again.");
    } finally {
      acting.current = false;
      if (isCurrent()) setBusy('');
    }
  }
  function mint(event: FormEvent) {
    event.preventDefault();
    const workspace = selectedWorkspaceId();
    void run('mint', async () => {
      const result = await api<{ key: WorkspaceKey; workspace_key: string }>(
        '/api/workspace-keys',
        { label, scopes },
      );
      if (alive.current && selectedWorkspaceId() === workspace) {
        setIssued(result);
        setBusy('refresh');
      }
    });
  }

  return (
    <section className="panel assistant-card" aria-labelledby="workspace-keys-title">
      <div className="assistant-list-heading">
        <div className="panel-title">
          <KeyRound size={18} />
          <h2 id="workspace-keys-title">AI access keys</h2>
        </div>
        <button
          className="button secondary"
          disabled={Boolean(busy) || loading}
          onClick={() => void load()}
        >
          <RefreshCw size={14} />
          Refresh
        </button>
      </div>
      <p>
        <strong>{workspaceName}</strong> belongs to an AI. Each AI that works here has its own
        access key. You co-own this workspace, so you can remove any key; that AI loses access at
        once.
      </p>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      {loadError ? (
        <p className="form-error" role="alert">
          {keys
            ? 'The access keys could not be refreshed. Showing the previous list; it may have changed.'
            : 'The access keys could not be loaded.'}{' '}
          {loadError} Use Refresh to try again.
        </p>
      ) : null}
      {busy === 'mint' && !issued ? (
        <p className="assistant-notice" role="status">
          Creating an access key for {workspaceName}. Keep this workspace open until the key
          appears; it can only be shown once.
        </p>
      ) : null}
      {issued ? (
        <div className="assistant-issued" role="status">
          <strong>Access key for {issued.key.label} created. It is shown only once.</strong>
          <code className="key-secret">{issued.workspace_key}</code>
          <CopyButton value={issued.workspace_key} label="Copy key" describedAs="Access key" />
          <button className="button secondary" onClick={() => setIssued(null)}>
            I saved it
          </button>
        </div>
      ) : null}
      {keys && loading ? <p role="status">Refreshing access keys…</p> : null}
      {!keys ? (
        loading ? (
          <p role="status">
            <LoaderCircle size={14} className="spin" /> Loading access keys…
          </p>
        ) : null
      ) : (
        <ul className="assistant-grants" aria-label="AI access keys">
          {keys.map((key) => (
            <li key={key.id}>
              <div>
                <strong>{key.label}</strong>
                <span className="small-tag">{key.revokedAt ? 'Removed' : 'Active'}</span>
                <p>{key.scopes.map(permissionLabel).join(' · ')}</p>
                <small>
                  Created {formatDate(key.createdAt)} ·{' '}
                  {key.lastUsedAt ? `Last used ${formatDate(key.lastUsedAt)}` : 'Never used'}
                </small>
              </div>
              <button
                className="button secondary"
                disabled={Boolean(busy) || Boolean(key.revokedAt)}
                aria-label={`Remove access key ${key.label}`}
                onClick={() =>
                  void run(key.id, async () => {
                    await api(`/api/workspace-keys/${key.id}`, {}, 'DELETE');
                  })
                }
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      <form className="form-stack" onSubmit={mint}>
        <label>
          New key for
          <input
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            maxLength={64}
            required
          />
        </label>
        <fieldset className="assistant-permissions" disabled={Boolean(busy)}>
          <legend>What this AI may do</legend>
          {ASSISTANT_SCOPES.map((scope) => (
            <label key={scope}>
              <input
                type="checkbox"
                checked={scopes.includes(scope)}
                disabled={scope === 'workspace:read'}
                onChange={(event) =>
                  setScopes((current) =>
                    event.target.checked
                      ? [...current, scope]
                      : current.filter((item) => item !== scope),
                  )
                }
              />
              <span>
                <strong>{permissionLabel(scope)}</strong>
              </span>
            </label>
          ))}
        </fieldset>
        <button className="button primary" disabled={Boolean(busy) || Boolean(issued)}>
          <KeyRound size={16} />
          Create key
        </button>
      </form>
    </section>
  );
}
