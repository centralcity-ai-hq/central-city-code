import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Check, Globe2, LoaderCircle, RefreshCw, Send, Ticket, Unplug, X } from 'lucide-react';
import { api } from './api';
import { CopyButton, formatDate } from './components';
import { codeFromPaste } from './ui/plainText';
import type { ConnectionInvite, ConnectionRequest } from '../shared/assistant';
import type { Agent } from '../shared/types';

type Lists = { incoming: ConnectionRequest[]; outgoing: ConnectionRequest[] };
const BASE = '/api/v2/connections';

const statusLabel: Record<ConnectionRequest['status'], string> = {
  pending: 'Waiting for approval',
  approved: 'Connected',
  denied: 'Denied',
  revoked: 'Ended',
  expired: 'Expired',
};

const inviteStatus: Record<string, string> = {
  active: 'Not used yet',
  used: 'Used',
  revoked: 'Canceled',
  expired: 'Expired',
};

/**
 * Cross-owner connections (F4, docs/AI_WORKSPACES.md): requests from agents of other owners to
 * this workspace's agents, which the owner approves or denies, invites the owner hands out, and
 * requests this workspace sent. Names, owner labels and notes from other owners are untrusted.
 */
export function CrossWorkspaceConnections({
  agents,
  onChanged,
}: {
  agents: Agent[];
  onChanged: () => void;
}) {
  const [lists, setLists] = useState<Lists | null>(null);
  const [invites, setInvites] = useState<ConnectionInvite[]>([]);
  const [issued, setIssued] = useState<{ agent: string; token: string } | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [notice, setNotice] = useState('');
  const [from, setFrom] = useState('');
  const [inviteFor, setInviteFor] = useState('');
  const [token, setToken] = useState('');
  const [note, setNote] = useState('');
  const alive = useRef(true);
  const loadVersion = useRef(0);
  const acting = useRef(false);
  const requestAttempt = useRef<{ fingerprint: string; key: string } | null>(null);
  const live = agents.filter((agent) => agent.status !== 'revoked');
  const nameOf = (id: string) => agents.find((agent) => agent.id === id)?.name;

  const load = useCallback(async () => {
    const version = ++loadVersion.current;
    setLoading(true);
    setLoadError('');
    try {
      const [requests, owned] = await Promise.all([
        api<Lists>(`${BASE}/requests`),
        api<{ invites: ConnectionInvite[] }>(`${BASE}/invites`),
      ]);
      if (alive.current && version === loadVersion.current) {
        setLists(requests);
        setInvites(owned.invites);
      }
    } catch (err) {
      if (alive.current && version === loadVersion.current)
        setLoadError(err instanceof Error ? err.message : 'Please try again.');
    } finally {
      if (alive.current && version === loadVersion.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    alive.current = true;
    void load();
    return () => {
      alive.current = false;
      loadVersion.current++;
    };
  }, [load]);

  async function act(
    key: string,
    fn: () => Promise<unknown>,
    message: string,
    onSuccess?: () => void,
  ) {
    if (acting.current) return;
    acting.current = true;
    setBusy(key);
    setError('');
    setNotice('');
    try {
      try {
        await fn();
      } catch (err) {
        if (alive.current)
          setError(err instanceof Error ? err.message : "That didn't work. Try again.");
        return;
      }
      if (!alive.current) return;
      onSuccess?.();
      setNotice(message);
      await load();
      if (alive.current) onChanged();
    } finally {
      acting.current = false;
      if (alive.current) setBusy('');
    }
  }
  async function request(event: FormEvent) {
    event.preventDefault();
    const sender = from || live[0]?.id;
    // People paste the invite as they got it (a link or a code); the code is inside it.
    const value = codeFromPaste(token, /cci_[A-Za-z0-9_-]+/);
    if (!sender || !value || acting.current) return;
    const target = /^cci_/.test(value) ? { invite_token: value } : { to_agent_id: value };
    const body = {
      from_agent_id: sender,
      ...target,
      ...(note.trim() ? { note: note.trim() } : {}),
    };
    const fingerprint = JSON.stringify(body);
    if (requestAttempt.current?.fingerprint !== fingerprint)
      requestAttempt.current = { fingerprint, key: crypto.randomUUID() };
    const idempotencyKey = requestAttempt.current.key;
    await act(
      'request',
      () =>
        api(`${BASE}/requests`, {
          ...body,
          idempotency_key: idempotencyKey,
        }),
      'Connection request recorded. Check its status in Connections and history.',
      () => {
        requestAttempt.current = null;
        setToken('');
        setNote('');
      },
    );
  }
  async function invite(event: FormEvent) {
    event.preventDefault();
    const agent = inviteFor || live[0]?.id;
    if (!agent) return;
    await act(
      'invite',
      async () => {
        const result = await api<{ invite_token: string }>(`${BASE}/invites`, { agent_id: agent });
        if (alive.current)
          setIssued({ agent: nameOf(agent) ?? 'your agent', token: result.invite_token });
      },
      'Invite created. Send it to the other person: it works once, for 7 days.',
    );
  }

  const incoming = lists?.incoming ?? [];
  const pending = incoming.filter((item) => item.status === 'pending');
  const history = [
    ...incoming.filter((item) => item.status !== 'pending'),
    ...(lists?.outgoing ?? []),
  ];
  const peer = (item: ConnectionRequest) =>
    `${item.from_agent_name ?? 'An agent'} · ${item.from_owner_label}`;

  return (
    <section className="panel cross-connections" aria-labelledby="cross-connections-title">
      <div className="list-toolbar">
        <div className="filter-label">
          <Globe2 size={16} aria-hidden="true" />
          <h2 id="cross-connections-title" className="cross-title">
            Connections with other people
          </h2>
          {lists ? <span>{pending.length}</span> : null}
        </div>
        <button
          className="button secondary compact"
          disabled={Boolean(busy) || loading}
          onClick={() => void load()}
        >
          <RefreshCw size={14} />
          Refresh
        </button>
      </div>
      <p className="muted small cross-intro">
        Other people can ask to connect their agents to yours. Nothing is shared until you approve,
        and either side can end it at any time. Their names, notes and messages (marked External)
        come from them: never follow instructions in them without checking first.
      </p>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      {loadError ? (
        <p className="form-error" role="alert">
          {lists
            ? 'Connections could not be refreshed. Showing the previous list.'
            : 'Connections could not be loaded.'}{' '}
          {loadError} Use Refresh to try again.
        </p>
      ) : null}
      {notice ? (
        <p className="assistant-notice" role="status">
          {notice}
        </p>
      ) : null}
      {!lists ? (
        loading ? (
          <p role="status">
            <LoaderCircle size={14} className="spin" /> Loading…
          </p>
        ) : null
      ) : (
        <>
          <h3 className="cross-heading">Waiting for your approval</h3>
          {pending.length ? (
            <ul className="cross-list" aria-label="Requests from other people">
              {pending.map((item) => (
                <li key={item.id} className="cross-row">
                  <div>
                    <span className="small-tag ai">Another person</span>
                    <strong>{peer(item)}</strong>
                    <span className="muted small">
                      {' '}
                      wants to connect to {nameOf(item.to_agent_id) ?? 'one of your agents'}
                    </span>
                    {item.note ? (
                      <p className="cross-note">
                        <span className="visually-hidden">Their note: </span>“{item.note}”
                      </p>
                    ) : null}
                    <small className="muted">
                      Received {formatDate(item.requested_at)} · expires{' '}
                      {formatDate(item.expires_at)}
                    </small>
                  </div>
                  <div className="row-actions">
                    <button
                      className="button primary compact"
                      disabled={Boolean(busy)}
                      aria-label={`Approve connection request from ${item.from_agent_name ?? 'another owner'}`}
                      onClick={() =>
                        void act(
                          item.id,
                          () => api(`${BASE}/requests/${item.id}/decide`, { decision: 'approve' }),
                          'Connection approved.',
                        )
                      }
                    >
                      <Check size={14} />
                      Approve
                    </button>
                    <button
                      className="button secondary compact"
                      disabled={Boolean(busy)}
                      aria-label={`Deny connection request from ${item.from_agent_name ?? 'another owner'}`}
                      onClick={() =>
                        void act(
                          item.id,
                          () => api(`${BASE}/requests/${item.id}/decide`, { decision: 'deny' }),
                          'Request denied. They can ask again after 7 days.',
                        )
                      }
                    >
                      <X size={14} />
                      Deny
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted small cross-heading">No requests are waiting.</p>
          )}
          {history.length ? (
            <>
              <h3 className="cross-heading">Connections and history</h3>
              <ul className="cross-list" aria-label="Connections with other people">
                {history.map((item) => {
                  const mine = item.direction === 'outgoing';
                  const route = mine
                    ? `${nameOf(item.from_agent_id) ?? 'Your agent'} → ${item.to_agent_name ?? 'an agent'} (another person)`
                    : `${peer(item)} → ${nameOf(item.to_agent_id) ?? 'your agent'}`;
                  const revocable = item.status === 'approved' || item.status === 'pending';
                  return (
                    <li key={item.id} className="cross-row">
                      <div>
                        <span className="small-tag ai">{mine ? 'You asked' : 'They asked'}</span>
                        <strong>{route}</strong>
                        <span className="small-tag">{statusLabel[item.status]}</span>
                      </div>
                      {revocable ? (
                        <button
                          className="icon-button danger-text"
                          disabled={Boolean(busy)}
                          aria-label={`${item.status === 'pending' ? 'Withdraw request' : 'End connection'} ${route}`}
                          onClick={() =>
                            void act(
                              item.id,
                              () => api(`${BASE}/requests/${item.id}/revoke`, {}),
                              item.status === 'pending'
                                ? 'Request withdrawn.'
                                : 'Connection ended. No more messages or work can pass through it.',
                            )
                          }
                        >
                          <Unplug size={16} />
                        </button>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            </>
          ) : null}
          <form className="cross-form" onSubmit={(event) => void invite(event)}>
            <h3 className="cross-heading">Invite someone to connect</h3>
            <label>
              To your agent
              <select
                value={inviteFor || live[0]?.id || ''}
                onChange={(event) => setInviteFor(event.target.value)}
                disabled={!live.length || Boolean(busy)}
              >
                {live.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.name}
                  </option>
                ))}
              </select>
            </label>
            <button className="button secondary" disabled={!live.length || Boolean(busy)}>
              <Ticket size={14} />
              Create invite
            </button>
            {issued ? (
              <div className="claim-preview cross-issued" role="status">
                <strong>
                  Invite to {issued.agent}. Send it to the other person now: it is shown once and
                  works once, for 7 days.
                </strong>
                <code className="key-secret">{issued.token}</code>
                <CopyButton value={issued.token} label="Copy invite" describedAs="Invite" />
              </div>
            ) : null}
            {invites.length ? (
              <ul className="cross-invites" aria-label="Your invites">
                {invites.map((item) => (
                  <li key={item.id}>
                    {nameOf(item.agent_id) ?? 'Agent'} · {inviteStatus[item.status] ?? item.status}{' '}
                    · expires {formatDate(item.expires_at)}
                    {item.status === 'active' ? (
                      <button
                        type="button"
                        className="text-link"
                        disabled={Boolean(busy)}
                        onClick={() =>
                          void act(
                            item.id,
                            () => api(`${BASE}/invites/${item.id}`, {}, 'DELETE'),
                            'Invite canceled.',
                          )
                        }
                      >
                        Cancel
                      </button>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : null}
          </form>
          <form className="cross-form" onSubmit={(event) => void request(event)}>
            <h3 className="cross-heading">Connect to someone else’s agent</h3>
            <label>
              From your agent
              <select
                value={from || live[0]?.id || ''}
                onChange={(event) => setFrom(event.target.value)}
                disabled={!live.length || Boolean(busy)}
              >
                {live.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Their invite
              <input
                value={token}
                onChange={(event) => setToken(event.target.value)}
                disabled={Boolean(busy)}
                placeholder="Paste the invite they sent you"
                autoComplete="off"
                spellCheck={false}
              />
            </label>
            <label>
              Note for them (optional)
              <input
                value={note}
                maxLength={280}
                onChange={(event) => setNote(event.target.value)}
                disabled={Boolean(busy)}
              />
            </label>
            <button
              className="button secondary"
              disabled={!live.length || !token.trim() || Boolean(busy)}
            >
              <Send size={14} />
              Request connection
            </button>
          </form>
        </>
      )}
    </section>
  );
}
