import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  CircleAlert,
  Download,
  KeyRound,
  LoaderCircle,
  Plug,
  Plus,
  RefreshCw,
  ShieldCheck,
  Unplug,
} from 'lucide-react';
import { api } from './api';
import { ConfirmDialog, formatDate } from './components';
import { useWorkspaceV2 } from './shell/workspaceV2';
import { SettingsEmpty, SettingsLoading, SettingsSectionHead } from './settings/SettingsLayout';
import { ROLLING_GRANT_DAYS, type AssistantGrant, type AssistantScope } from '../shared/assistant';
import './assistant.css';

const permissions: { scope: AssistantScope; label: string; description: string }[] = [
  {
    scope: 'workspace:read',
    label: 'See your workspace',
    description:
      'See your agents, connections and exchanges, including what was sent and what came back.',
  },
  {
    scope: 'agents:create',
    label: 'Create agents',
    description:
      'Add CC agents, or agents that run on your own computer (those still need your setup).',
  },
  {
    scope: 'jobs:create',
    label: 'Ask CC agents for work',
    description: 'Send work to the free CC agents, along connections you already allowed.',
  },
  {
    scope: 'jobs:cancel',
    label: 'Cancel work',
    description: 'Stop work that is still running in your workspace.',
  },
  {
    scope: 'connections:create',
    label: 'Connect team members',
    description:
      'Connect the agents of a team it creates, and ask to connect to (or disconnect from) other people’s agents. Existing connections stay as they are.',
  },
  {
    scope: 'agents:control',
    label: 'Control agents',
    description:
      'Pause, resume or remove agents. Removing an agent also removes the agents created under it.',
  },
  {
    scope: 'messages:read',
    label: 'Read agent messages',
    description:
      'Read messages sent to your agents. They come from other agents, so treat them with care.',
  },
  {
    scope: 'messages:send',
    label: 'Send agent messages',
    description:
      'Send messages as your agents, to agents they are connected to (yours or other people’s).',
  },
  {
    scope: 'connections:approve',
    label: 'Answer connection requests',
    description:
      'Approve or deny other people’s requests to connect to your agents. Leave off to decide yourself.',
  },
  {
    scope: 'workspace:keys',
    label: 'Manage AI workspace access',
    description:
      'Create and remove access keys of an AI workspace. Has no effect on your own account.',
  },
];

/**
 * The plain name of every permission, including those the form above doesn't offer: an app
 * connected over OAuth holds rooms:join by default, and an AI workspace key may hold any scope.
 */
const MORE_LABELS: Readonly<Record<string, string>> = {
  'rooms:join': 'Join rooms',
  'rooms:host': 'Host rooms',
  'rooms:apply': 'Open draft pull requests',
  'agents:wake': 'Wake your agents',
  'results:read': 'Ask for published results',
  'results:publish': 'Publish results',
  // Two scopes, two kinds of payee: Central City agents (Base Pay), and Feed services outside
  // Central City (Feed pay, docs/FEED_PAY.md). A grant for one never pays the other.
  pay: 'Pay other agents',
  'services:pay': 'Pay Feed services',
  // Listing services the agents sell in the Feed (fee included); it moves no money itself.
  'services:sell': 'Sell services in the Feed',
};
const PERMISSION_LABELS: Record<AssistantScope, string> = {
  ...(Object.fromEntries(permissions.map((item) => [item.scope, item.label])) as Record<
    AssistantScope,
    string
  >),
  ...MORE_LABELS,
};

/** The plain name of a permission ("workspace:read" → "See your workspace"). */
export function permissionLabel(scope: string): string {
  return Object.hasOwn(PERMISSION_LABELS, scope)
    ? PERMISSION_LABELS[scope as AssistantScope]
    : scope.replace(':', ': ');
}

/** "Connected", or why the access no longer works. */
function grantStatus(grant: AssistantGrant): 'Connected' | 'Removed' | 'Ended' {
  return grant.revokedAt
    ? 'Removed'
    : Date.parse(grant.expiresAt) <= Date.now()
      ? 'Ended'
      : 'Connected';
}

/** How long the access lasts: rolling (until disconnected) or a fixed end. */
function grantLifetime(grant: AssistantGrant): string {
  return grant.renewal === 'rolling' && grantStatus(grant) === 'Connected'
    ? `Until you disconnect · ends if unused for ${ROLLING_GRANT_DAYS} days${grant.endsAtLatest ? `, at the latest on ${formatDate(grant.endsAtLatest)}` : ''}`
    : `Expires ${formatDate(grant.expiresAt)}`;
}

/** The classic list's one line: lifetime, then last use. */
function grantTiming(grant: AssistantGrant): string {
  return `${grantLifetime(grant)} · ${grant.lastUsedAt ? `Last used ${formatDate(grant.lastUsedAt)}` : 'Not used yet'}`;
}

export function AssistantAccess({ onConnect }: { onConnect?: () => void }) {
  const workspaceV2 = useWorkspaceV2();
  const localBridgeAvailable = ['localhost', '127.0.0.1', '[::1]'].includes(
    window.location.hostname,
  );
  const [grants, setGrants] = useState<AssistantGrant[]>([]);
  const [label, setLabel] = useState('My desktop assistant');
  const [scopes, setScopes] = useState<AssistantScope[]>(['workspace:read']);
  const [days, setDays] = useState<1 | 7 | 30>(1);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState('loading');
  const [error, setError] = useState('');
  const [issued, setIssued] = useState<{ grant: AssistantGrant; token: string } | null>(null);
  const [notice, setNotice] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [revokeTarget, setRevokeTarget] = useState<AssistantGrant | null>(null);
  const [revokeError, setRevokeError] = useState('');
  const refreshButton = useRef<HTMLButtonElement>(null);
  const focusAfterRevoke = useRef(false);
  const alive = useRef(true);
  const operation = useRef(false);
  useEffect(() => {
    // Wait for the dialog to unmount and Refresh to be enabled in the committed DOM.
    if (workspaceV2 && focusAfterRevoke.current && !revokeTarget && !busy) {
      focusAfterRevoke.current = false;
      refreshButton.current?.focus();
    }
  }, [workspaceV2, revokeTarget, busy]);
  useEffect(() => {
    let current = true;
    alive.current = true;
    void api<{ grants: AssistantGrant[] }>('/api/assistant-access')
      .then((value) => {
        if (current) {
          setGrants(value.grants);
          setLoaded(true);
        }
      })
      .catch((err: unknown) => {
        if (current) {
          const message =
            err instanceof Error ? err.message : 'Your AI connections could not be loaded.';
          if (!workspaceV2) setError(message);
          setLoadError(message);
        }
      })
      .finally(() => {
        if (current) setBusy('');
      });
    return () => {
      current = false;
      alive.current = false;
    };
  }, [workspaceV2]);

  async function refresh() {
    if (operation.current) return;
    operation.current = true;
    setBusy('refresh');
    setError('');
    setLoadError('');
    try {
      const value = await api<{ grants: AssistantGrant[] }>('/api/assistant-access');
      if (alive.current) {
        setGrants(value.grants);
        setLoaded(true);
      }
    } catch (err) {
      if (alive.current) {
        const message =
          err instanceof Error ? err.message : 'Your AI connections could not be loaded.';
        if (!workspaceV2) setError(message);
        setLoadError(message);
      }
    } finally {
      operation.current = false;
      if (alive.current) setBusy('');
    }
  }
  async function create(event: FormEvent) {
    event.preventDefault();
    if (!localBridgeAvailable || operation.current || !consent || issued) return;
    operation.current = true;
    setBusy('create');
    setError('');
    setNotice('');
    try {
      const result = await api<{ grant: AssistantGrant; token: string }>('/api/assistant-access', {
        label,
        scopes,
        expiresInDays: days,
      });
      if (!alive.current) return;
      setIssued(result);
      setGrants((current) => [result.grant, ...current]);
      setConsent(false);
    } catch (err) {
      if (alive.current)
        setError(err instanceof Error ? err.message : 'Access could not be created.');
    } finally {
      operation.current = false;
      if (alive.current) setBusy('');
    }
  }
  async function revoke(grant: AssistantGrant) {
    if (operation.current) return;
    operation.current = true;
    setBusy(grant.id);
    setError('');
    setRevokeError('');
    if (workspaceV2) setNotice('');
    try {
      await api(`/api/assistant-access/${grant.id}`, {}, 'DELETE');
      if (!alive.current) return;
      setGrants((current) =>
        current.map((item) =>
          item.id === grant.id ? { ...item, revokedAt: new Date().toISOString() } : item,
        ),
      );
      setIssued((current) => (current?.grant.id === grant.id ? null : current));
      setNotice(
        `${grant.label} no longer has access. Work it already started stays under Exchanges.`,
      );
      if (workspaceV2) {
        focusAfterRevoke.current = true;
        setRevokeTarget(null);
      }
    } catch (err) {
      if (alive.current) {
        const message = err instanceof Error ? err.message : 'Access could not be removed.';
        if (workspaceV2) setRevokeError(message);
        else setError(message);
      }
    } finally {
      operation.current = false;
      if (alive.current) setBusy('');
    }
  }
  function download() {
    if (!issued) return;
    const baseUrl = window.location.origin.replace('://localhost', '://127.0.0.1');
    const blob = new Blob([JSON.stringify({ baseUrl, token: issued.token }, null, 2) + '\n'], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'central-city-assistant.private.json';
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  const localBridge = localBridgeAvailable ? (
    <div className="assistant-columns">
      <section className="panel assistant-card">
        <div className="panel-title">
          <ShieldCheck size={18} />
          <h2>Access for an AI on this computer</h2>
        </div>
        <form className="form-stack" onSubmit={(event) => void create(event)}>
          <label>
            Connection name
            <input
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              minLength={2}
              maxLength={64}
              required
              disabled={Boolean(busy) || Boolean(issued)}
            />
          </label>
          <fieldset disabled={Boolean(busy) || Boolean(issued)} className="assistant-permissions">
            <legend>Allowed actions</legend>
            {permissions.map((item) => (
              <label key={item.scope}>
                <input
                  type="checkbox"
                  checked={scopes.includes(item.scope)}
                  disabled={item.scope === 'workspace:read'}
                  onChange={(event) =>
                    setScopes((current) =>
                      event.target.checked
                        ? [...current, item.scope]
                        : current.filter((scope) => scope !== item.scope),
                    )
                  }
                />
                <span>
                  <strong>{item.label}</strong>
                  <small>{item.description}</small>
                </span>
              </label>
            ))}
          </fieldset>
          <label>
            Access expires after
            <select
              value={days}
              disabled={Boolean(busy) || Boolean(issued)}
              onChange={(event) => setDays(Number(event.target.value) as 1 | 7 | 30)}
            >
              <option value={1}>1 day</option>
              <option value={7}>7 days</option>
              <option value={30}>30 days</option>
            </select>
          </label>
          <label className="assistant-consent">
            <input
              type="checkbox"
              checked={consent}
              disabled={Boolean(busy) || Boolean(issued)}
              onChange={(event) => setConsent(event.target.checked)}
            />
            <span>
              I allow these actions, and sharing the data they need with the company behind my AI.
            </span>
          </label>
          <button
            className="button primary"
            disabled={!localBridgeAvailable || Boolean(busy) || !consent || Boolean(issued)}
          >
            {busy === 'create' ? (
              <LoaderCircle size={16} className="spin" />
            ) : (
              <KeyRound size={16} />
            )}
            Create access
          </button>
          <p className="field-note">
            Your AI can never accept results for you, see agents' access tokens or use paid agents.
            Work it already started keeps running when its access ends.
          </p>
        </form>
      </section>
      <section className="panel assistant-card">
        <div className="panel-title">
          <KeyRound size={18} />
          <h2>Set it up on this computer</h2>
        </div>
        {issued ? (
          <div className="assistant-issued" role="status">
            <strong>{issued.grant.label} is ready to configure.</strong>
            <p>
              Download the connection file now. It holds a secret and is only available until you
              leave this page. Keep it private.
            </p>
            <button className="button primary" onClick={download}>
              <Download size={16} />
              Download private connection file
            </button>
            <button className="button secondary" onClick={() => setIssued(null)}>
              I saved it — dismiss
            </button>
            <p className="field-note">
              Never paste the file into a chat or share it. If you lose it, remove this access and
              create a new one.
            </p>
          </div>
        ) : (
          <p>Create access, then download your private connection file.</p>
        )}
        <ol className="assistant-steps">
          <li>Keep Central City running on this computer.</li>
          <li>Follow the connection guide to add Central City to your AI app.</li>
          <li>Point it to your private connection file.</li>
        </ol>
        <a
          className="text-link"
          href="https://github.com/centralcity-ai-hq/protocol/blob/main/docs/ASSISTANT_CONNECTION.md"
          target="_blank"
          rel="noreferrer"
        >
          Open connection guide ↗
        </a>
      </section>
    </div>
  ) : null;
  // Workspace v2 Settings: one card per app, its allowed actions as chips, and Remove access
  // always visible on the card (never behind a menu).
  const previewList = (
    <section className="assistant-card stv2-apps" aria-labelledby="app-access-title">
      <div className="assistant-list-heading">
        <h3 id="app-access-title">App access</h3>
        <button
          ref={refreshButton}
          className="button secondary"
          disabled={Boolean(busy)}
          onClick={() => void refresh()}
        >
          <RefreshCw size={14} aria-hidden="true" />
          Refresh
        </button>
      </div>
      {loadError ? (
        <div className="assistant-load-error stv2-error">
          <CircleAlert size={18} aria-hidden="true" />
          <div>
            <p role="alert">
              {loadError}
              {loaded ? ' Showing the last loaded app access.' : ''}
            </p>
            <button
              className="button secondary"
              disabled={Boolean(busy)}
              onClick={() => void refresh()}
            >
              Retry
            </button>
          </div>
        </div>
      ) : null}
      {busy === 'refresh' && loaded ? (
        <p className="stv2-muted" role="status">
          Refreshing connected apps…
        </p>
      ) : null}
      {busy === 'loading' || (busy === 'refresh' && !loaded) ? (
        <SettingsLoading label="Loading connected apps…" />
      ) : !loaded && !grants.length ? null : !grants.length ? (
        <SettingsEmpty
          icon={<Plug size={22} />}
          title="No apps connected yet."
          action={
            onConnect ? (
              <button type="button" className="button secondary" onClick={onConnect}>
                Set up an AI app
              </button>
            ) : undefined
          }
        >
          Connect AI to choose an app and approve its access.
        </SettingsEmpty>
      ) : (
        <ul className="assistant-grants stv2-grants">
          {grants.map((grant) => {
            const status = grantStatus(grant);
            return (
              <li key={grant.id}>
                <div className="stv2-grant-top">
                  <span className="stv2-grant-icon" aria-hidden="true">
                    <Plug size={18} />
                  </span>
                  <div className="stv2-grant-name">
                    <strong>{grant.label}</strong>
                    <small>
                      Approved {formatDate(grant.createdAt)} ·{' '}
                      {grant.lastUsedAt
                        ? `Last used ${formatDate(grant.lastUsedAt)}`
                        : 'Not used yet'}
                    </small>
                  </div>
                  <span className={`stv2-pill${status === 'Connected' ? ' live' : ''}`}>
                    {status}
                  </span>
                </div>
                <p className="stv2-scopes">
                  <span className="visually-hidden">Allowed actions: </span>
                  {grant.scopes.map((scope) => (
                    <span key={scope} className="stv2-chip">
                      {permissionLabel(scope)}
                    </span>
                  ))}
                </p>
                <div className="stv2-grant-foot">
                  <small>{grantLifetime(grant)}</small>
                  <button
                    className="button stv2-danger"
                    disabled={Boolean(busy) || Boolean(grant.revokedAt)}
                    onClick={() => {
                      setRevokeError('');
                      setRevokeTarget(grant);
                    }}
                    aria-label={`Remove access for ${grant.label}`}
                  >
                    <Unplug size={15} aria-hidden="true" />
                    Remove access
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
  return (
    <div className={`assistant-layout${workspaceV2 ? ' assistant-preview' : ''}`}>
      {workspaceV2 ? (
        <SettingsSectionHead
          title="Connected apps"
          lede="AI apps you approved to act in your account, with what each may do. Removing an app’s access takes effect at once; connections between your agents stay as they are."
          action={
            onConnect ? (
              <button type="button" className="button primary" onClick={onConnect}>
                <Plus size={16} aria-hidden="true" />
                Connect AI
              </button>
            ) : undefined
          }
        />
      ) : (
        <section className="panel assistant-intro">
          <div>
            <p className="eyebrow">Your AI, your rules</p>
            <h2>Choose what your AI may do.</h2>
            <p>
              When you connect ChatGPT, Claude or another AI app, you approve what it may do in your
              account. Every app you connected is listed below.
            </p>
            {onConnect ? (
              <button type="button" className="button secondary" onClick={onConnect}>
                Connect an AI app
              </button>
            ) : null}
          </div>
        </section>
      )}
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p className="assistant-notice" role="status">
          {notice}
        </p>
      ) : null}
      {!workspaceV2 ? localBridge : null}
      {workspaceV2 ? (
        previewList
      ) : (
        <section className="panel assistant-card">
          <div className="assistant-list-heading">
            <div className="panel-title">
              <ShieldCheck size={18} />
              <h2>Connected AI apps</h2>
            </div>
            <button
              ref={refreshButton}
              className="button secondary"
              disabled={Boolean(busy)}
              onClick={() => void refresh()}
            >
              <RefreshCw size={14} />
              Refresh
            </button>
          </div>
          {busy === 'loading' ? (
            <p role="status">Loading…</p>
          ) : !grants.length ? (
            <p>No AI app has access yet.</p>
          ) : (
            <ul className="assistant-grants">
              {grants.map((grant) => {
                const status = grantStatus(grant);
                return (
                  <li key={grant.id}>
                    <div>
                      <strong>{grant.label}</strong>
                      <span className="small-tag">{status}</span>
                      <p>{grant.scopes.map(permissionLabel).join(' · ')}</p>
                      <small>{grantTiming(grant)}</small>
                    </div>
                    <button
                      className="button secondary"
                      disabled={Boolean(busy) || Boolean(grant.revokedAt)}
                      onClick={() => void revoke(grant)}
                      aria-label={`Remove access for ${grant.label}`}
                    >
                      <Unplug size={15} />
                      Remove access
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      )}
      {workspaceV2 && localBridge ? (
        <details className="assistant-advanced">
          <summary>Advanced: local bridge</summary>
          <p>Set up an AI that runs on this computer with a private connection file.</p>
          {localBridge}
        </details>
      ) : null}
      {workspaceV2 && revokeTarget ? (
        <ConfirmDialog
          title="Remove app access?"
          confirmLabel="Remove access"
          busy={busy === revokeTarget.id}
          error={revokeError}
          status={busy === revokeTarget.id ? 'Removing access…' : undefined}
          onClose={() => {
            if (!operation.current) setRevokeTarget(null);
          }}
          onConfirm={() => void revoke(revokeTarget)}
        >
          <p>
            <strong>{revokeTarget.label}</strong> will no longer be able to use this access to your
            account. Your agents and their connections stay in place. Work already started keeps
            running, and existing results stay under Exchanges.
          </p>
        </ConfirmDialog>
      ) : null}
    </div>
  );
}
