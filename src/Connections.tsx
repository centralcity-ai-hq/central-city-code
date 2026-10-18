import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Check, LoaderCircle, RefreshCw, X } from 'lucide-react';
import { api } from './api';
import { CopyButton } from './components';
import { codeFromPaste } from './ui/plainText';
import type { ConnectionInvite, ConnectionRequest } from '../shared/assistant';
import type { Agent } from '../shared/types';
import { AgentAvatar, AgentLabel, CardHead, MoreMenu, Wire } from './permissions/parts';
import {
  OTHERS_FILTERS,
  crossHistory,
  crossStatusLabel,
  crossTone,
  crossWhen,
  matchesFilter,
  pendingRequests,
  revocable,
  shortDate,
  type CrossLists,
  type OthersFilter,
} from './permissions/model';

const BASE = '/api/v2/connections';

const inviteStatus: Record<string, string> = {
  active: 'Not used yet',
  used: 'Used',
  revoked: 'Canceled',
  expired: 'Expired',
};

/** Where a message about an action shows: the card the action belongs to. */
export type CrossArea = 'requests' | 'others' | 'invite' | 'use';
type Feedback = { area: CrossArea; text: string } | null;

/** The message after a request to connect went through. */
export const REQUEST_RECORDED =
  'Connection request recorded. Check its status under With other people.';

/**
 * Cross-owner connections (F4, docs/AI_WORKSPACES.md): requests from agents of other owners to
 * this workspace's agents, which the owner approves or denies, invites the owner hands out, and
 * requests this workspace sent. Names, owner labels and notes from other owners are untrusted.
 *
 * One state for the whole Agent permissions page: its cards (requests, With other people,
 * Invite someone, Use an invite) read it, and only one action runs at a time. A failed read
 * keeps the previous lists; a request keeps one idempotency key per logical request, so a
 * retry after a lost answer never creates a second one.
 */
export function useCrossConnections(agents: Agent[], onChanged: () => void) {
  const [lists, setLists] = useState<CrossLists | null>(null);
  const [invites, setInvites] = useState<ConnectionInvite[]>([]);
  const [issued, setIssued] = useState<{ agent: string; token: string; id: string } | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState<Feedback>(null);
  const [notice, setNotice] = useState<Feedback>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
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
        api<CrossLists>(`${BASE}/requests`),
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

  /**
   * Runs one action: its failure shows in `area`, its message in `noticeArea` (an approved
   * request leaves the requests card, so its message shows where the connection now is).
   * Resolves true when the action went through.
   */
  async function act(
    key: string,
    area: CrossArea,
    fn: () => Promise<unknown>,
    message: string,
    onSuccess?: () => void,
    noticeArea: CrossArea = area,
  ) {
    if (acting.current) return false;
    acting.current = true;
    setBusy(key);
    setError(null);
    setNotice(null);
    try {
      try {
        await fn();
      } catch (err) {
        if (alive.current)
          setError({
            area,
            text: err instanceof Error ? err.message : "That didn't work. Try again.",
          });
        return false;
      }
      if (!alive.current) return true;
      onSuccess?.();
      if (message) setNotice({ area: noticeArea, text: message });
      await load();
      if (alive.current) onChanged();
      return true;
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
      'use',
      () =>
        api(`${BASE}/requests`, {
          ...body,
          idempotency_key: idempotencyKey,
        }),
      REQUEST_RECORDED,
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
      'invite',
      async () => {
        const result = await api<{ invite_token: string; invite?: ConnectionInvite }>(
          `${BASE}/invites`,
          { agent_id: agent },
        );
        if (alive.current)
          setIssued({
            agent: nameOf(agent) ?? 'your agent',
            token: result.invite_token,
            id: result.invite?.id ?? '',
          });
      },
      // The new invite itself is the message (a status with the code, in the Invite card).
      '',
    );
  }
  const decide = (item: ConnectionRequest, decision: 'approve' | 'deny') =>
    act(
      item.id,
      'requests',
      () => api(`${BASE}/requests/${item.id}/decide`, { decision }),
      decision === 'approve'
        ? 'Connection approved.'
        : 'Request denied. They can ask again after 7 days.',
      undefined,
      'others',
    );
  const revoke = (item: ConnectionRequest) =>
    act(
      item.id,
      'others',
      () => api(`${BASE}/requests/${item.id}/revoke`, {}),
      item.status === 'pending'
        ? 'Request withdrawn.'
        : 'Connection ended. No more messages or work can pass through it.',
    );
  const cancelInvite = (item: ConnectionInvite) =>
    act(
      item.id,
      'invite',
      () => api(`${BASE}/invites/${item.id}`, {}, 'DELETE'),
      'Invite canceled.',
      () => setIssued((current) => (current?.id === item.id ? null : current)),
    );

  return {
    lists,
    invites,
    issued,
    busy,
    error,
    notice,
    loading,
    loadError,
    live,
    nameOf,
    load,
    pending: pendingRequests(lists),
    history: crossHistory(lists),
    form: { from, setFrom, inviteFor, setInviteFor, token, setToken, note, setNote },
    request,
    invite,
    decide,
    revoke,
    cancelInvite,
  };
}
export type CrossConnections = ReturnType<typeof useCrossConnections>;

/** An action's failure (alert) or message (status), in the card the action belongs to. */
function AreaFeedback({ cross, area }: { cross: CrossConnections; area: CrossArea }) {
  return (
    <>
      {cross.error?.area === area ? (
        <p className="perm3-alert" role="alert">
          {cross.error.text}
        </p>
      ) : null}
      {cross.notice?.area === area ? (
        <p className="perm3-notice" role="status">
          <Check size={15} aria-hidden="true" />
          <span>{cross.notice.text}</span>
        </p>
      ) : null}
    </>
  );
}

/** "Waiting for your approval": shown only while requests from other people wait. */
export function RequestsCard({
  cross,
  onApprove,
  onDeny,
}: {
  cross: CrossConnections;
  onApprove: (item: ConnectionRequest) => void;
  /** Deny asks first (a confirm on the page). */
  onDeny: (item: ConnectionRequest) => void;
}) {
  if (!cross.lists || !cross.pending.length) return null;
  return (
    <section
      className="perm3-card perm3-request"
      id="perm3-requests"
      aria-labelledby="perm3-requests-title"
    >
      <CardHead
        id="perm3-requests-title"
        title="Waiting for your approval"
        count={cross.pending.length}
      />
      <AreaFeedback cross={cross} area="requests" />
      <ul className="perm3-reqlist" aria-label="Requests from other people">
        {cross.pending.map((item) => {
          const theirs = item.from_agent_name ?? 'An agent';
          const mine = cross.nameOf(item.to_agent_id) ?? 'your agent';
          const who = item.from_agent_name ?? 'another owner';
          return (
            <li key={item.id} className="perm3-reqrow">
              <AgentAvatar id={item.from_agent_id} name={theirs} external />
              <div className="perm3-reqmain">
                <div className="perm3-reqwho">
                  <b>{theirs}</b>
                  <span className="perm3-tag">External</span>
                  <small>
                    {item.from_owner_label} · received {shortDate(item.requested_at)} · expires{' '}
                    {shortDate(item.expires_at)}
                  </small>
                </div>
                <div className="perm3-path perm3-preview">
                  <AgentLabel id={item.from_agent_id} name={theirs} external />
                  <Wire />
                  <AgentLabel id={item.to_agent_id} name={mine} />
                  <span className="visually-hidden">
                    {theirs} wants to send work to {mine}
                  </span>
                </div>
                <p className="perm3-say">
                  Wants to send work to <b>{mine}</b>. {mine} can't send work back.
                </p>
                {item.note ? (
                  <div className="perm3-quote">
                    <small>Their note · External, check before your agent follows it</small>
                    <p>
                      <span className="visually-hidden">Their note: </span>
                      {item.note}
                    </p>
                  </div>
                ) : null}
                <div className="perm3-actions">
                  <button
                    type="button"
                    className="perm3-btn"
                    data-tone="primary"
                    disabled={Boolean(cross.busy)}
                    aria-label={`Approve connection request from ${who}`}
                    onClick={() => onApprove(item)}
                  >
                    {cross.busy === item.id ? (
                      <LoaderCircle size={15} className="spin" aria-hidden="true" />
                    ) : (
                      <Check size={15} aria-hidden="true" />
                    )}
                    Approve
                  </button>
                  <button
                    type="button"
                    className="perm3-btn"
                    data-tone="ghost"
                    disabled={Boolean(cross.busy)}
                    aria-label={`Deny connection request from ${who}`}
                    onClick={() => onDeny(item)}
                  >
                    <X size={15} aria-hidden="true" />
                    Deny
                  </button>
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** The other side of a connection with another person, as the row names it. */
export function crossNames(item: ConnectionRequest, nameOf: (id: string) => string | undefined) {
  const outgoing = item.direction === 'outgoing';
  return {
    outgoing,
    theirs: outgoing ? (item.to_agent_name ?? 'Their agent') : (item.from_agent_name ?? 'An agent'),
    theirId: outgoing ? item.to_agent_id : item.from_agent_id,
    mine: (outgoing ? nameOf(item.from_agent_id) : nameOf(item.to_agent_id)) ?? 'agent',
  };
}

/** "With other people": every connection with another person's agent, filtered by state. */
export function OthersCard({
  cross,
  onRevoke,
}: {
  cross: CrossConnections;
  onRevoke: (item: ConnectionRequest) => void;
}) {
  const [filter, setFilter] = useState<OthersFilter>('all');
  const { lists, history } = cross;
  const shown = history.filter((item) => matchesFilter(item, filter));
  return (
    <section className="perm3-card" id="perm3-others" aria-labelledby="perm3-others-title">
      <CardHead
        id="perm3-others-title"
        title="With other people"
        count={lists ? history.length : undefined}
        sub="Connections to agents in other workspaces. Nothing is shared until you approve."
        tools={
          <>
            {lists && history.length ? (
              <div className="perm3-tabs" role="group" aria-label="Show">
                {OTHERS_FILTERS.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    aria-pressed={filter === item.id}
                    onClick={() => setFilter(item.id)}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            ) : null}
            <button
              type="button"
              className="perm3-round"
              aria-label="Refresh"
              title="Refresh"
              disabled={Boolean(cross.busy) || cross.loading}
              onClick={() => void cross.load()}
            >
              <RefreshCw size={16} className={cross.loading ? 'spin' : ''} aria-hidden="true" />
            </button>
          </>
        }
      />
      {cross.loadError ? (
        <p className="perm3-alert" role="alert">
          {lists
            ? 'Connections could not be refreshed. Showing the previous list.'
            : 'Connections could not be loaded.'}{' '}
          {cross.loadError} Use Refresh to try again.
        </p>
      ) : null}
      <AreaFeedback cross={cross} area="others" />
      {!lists ? (
        cross.loading ? (
          <p className="perm3-loading" role="status">
            <LoaderCircle size={15} className="spin" aria-hidden="true" /> Loading…
          </p>
        ) : null
      ) : !history.length ? (
        <div className="perm3-empty">
          <b>No one yet</b>
          Invite someone, or use an invite they sent you.
        </div>
      ) : shown.length ? (
        <ul className="perm3-list" aria-label="Connections with other people">
          {shown.map((item) => {
            const names = crossNames(item, cross.nameOf);
            const line = names.outgoing
              ? `With your ${names.mine} · You asked · ${crossWhen(item)}`
              : `${item.from_owner_label} · with your ${names.mine} · They asked · ${crossWhen(item)}`;
            const ending = item.status === 'pending' ? 'Withdraw request' : 'End connection';
            return (
              <li key={item.id} className="perm3-hist">
                <div className="perm3-who">
                  <AgentAvatar id={names.theirId} name={names.theirs} external />
                  <div>
                    <b>
                      {names.theirs}
                      <span className="perm3-tag">External</span>
                    </b>
                    <small>{line}</small>
                  </div>
                </div>
                <span className="perm3-status" data-tone={crossTone(item.status)}>
                  <i aria-hidden="true" />
                  {crossStatusLabel[item.status]}
                </span>
                {revocable(item) ? (
                  <MoreMenu
                    label={`More for ${names.theirs} with your ${names.mine}`}
                    items={[{ label: ending, danger: true, onSelect: () => onRevoke(item) }]}
                  />
                ) : (
                  <span className="perm3-more-gap" aria-hidden="true" />
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        <div className="perm3-empty">
          <b>Nothing here</b>
          {filter === 'waiting'
            ? 'No requests you sent are waiting.'
            : 'No connections in this list.'}
        </div>
      )}
    </section>
  );
}

/** "Invite someone": an invite for one of your agents, and the invites you made. */
export function InviteCard({ cross }: { cross: CrossConnections }) {
  const id = useId();
  const { live, busy, issued } = cross;
  if (!cross.lists) return null;
  const selected = cross.form.inviteFor || live[0]?.id || '';
  return (
    <section
      className="perm3-card perm3-formcard"
      id="perm3-invite"
      aria-labelledby="perm3-invite-title"
    >
      <CardHead
        id="perm3-invite-title"
        title="Invite someone"
        sub="Create an invite for one of your agents. It works once, for 7 days."
      />
      <form className="perm3-form" onSubmit={(event) => void cross.invite(event)}>
        <div>
          <label className="perm3-label" htmlFor={`${id}-agent`}>
            To your agent
          </label>
          <select
            id={`${id}-agent`}
            className="perm3-field"
            value={selected}
            onChange={(event) => cross.form.setInviteFor(event.target.value)}
            disabled={!live.length || Boolean(busy)}
          >
            {live.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.name}
              </option>
            ))}
          </select>
        </div>
        <button className="perm3-btn" data-tone="soft" disabled={!live.length || Boolean(busy)}>
          {busy === 'invite' ? (
            <LoaderCircle size={15} className="spin" aria-hidden="true" />
          ) : null}
          Create invite
        </button>
      </form>
      {issued ? (
        <div className="perm3-issued" role="status">
          <p>
            Invite to <b>{issued.agent}</b>. Send it to the other person now: it is shown once and
            works once, for 7 days.
          </p>
          <div className="perm3-snippet">
            <code>{issued.token}</code>
            <CopyButton value={issued.token} label="Copy invite" describedAs="Invite" />
          </div>
        </div>
      ) : null}
      <AreaFeedback cross={cross} area="invite" />
      {cross.invites.length ? (
        <div className="perm3-invites">
          <p className="perm3-group" aria-hidden="true">
            Your invites
          </p>
          <ul aria-label="Your invites">
            {cross.invites.map((item) => {
              const agent = cross.nameOf(item.agent_id) ?? 'Agent';
              return (
                <li key={item.id}>
                  <span className="perm3-grow">
                    <b>{agent}</b> · {inviteStatus[item.status] ?? item.status}
                    <small> · expires {shortDate(item.expires_at)}</small>
                  </span>
                  {item.status === 'active' && issued?.id === item.id ? (
                    <CopyButton
                      value={issued.token}
                      label="Copy"
                      describedAs="Invite"
                      variant="quiet"
                    />
                  ) : null}
                  {item.status === 'active' ? (
                    <button
                      type="button"
                      className="perm3-link"
                      disabled={Boolean(busy)}
                      aria-label={`Cancel invite for ${agent}`}
                      onClick={() => void cross.cancelInvite(item)}
                    >
                      Cancel
                    </button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

/** "Use an invite": ask to connect one of your agents to someone else's. */
export function UseInviteCard({ cross }: { cross: CrossConnections }) {
  const id = useId();
  const { live, busy, form } = cross;
  if (!cross.lists) return null;
  return (
    <section className="perm3-card perm3-formcard" id="perm3-use" aria-labelledby="perm3-use-title">
      <CardHead
        id="perm3-use-title"
        title="Use an invite"
        sub="Got an invite from someone? Ask to connect one of your agents to theirs."
      />
      <form className="perm3-form" onSubmit={(event) => void cross.request(event)}>
        <div>
          <label className="perm3-label" htmlFor={`${id}-from`}>
            From your agent
          </label>
          <select
            id={`${id}-from`}
            className="perm3-field"
            value={form.from || live[0]?.id || ''}
            onChange={(event) => form.setFrom(event.target.value)}
            disabled={!live.length || Boolean(busy)}
          >
            {live.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="perm3-label" htmlFor={`${id}-invite`}>
            Their invite
          </label>
          <input
            id={`${id}-invite`}
            className="perm3-field"
            value={form.token}
            onChange={(event) => form.setToken(event.target.value)}
            disabled={Boolean(busy)}
            placeholder="Paste the invite they sent you"
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        <div>
          <label className="perm3-label" htmlFor={`${id}-note`}>
            Note for them <span className="perm3-optional">(optional)</span>
          </label>
          <input
            id={`${id}-note`}
            className="perm3-field"
            value={form.note}
            maxLength={280}
            onChange={(event) => form.setNote(event.target.value)}
            disabled={Boolean(busy)}
            placeholder="Who you are, what you'll send"
          />
        </div>
        <button
          className="perm3-btn"
          data-tone="primary"
          disabled={!live.length || !form.token.trim() || Boolean(busy)}
        >
          {busy === 'request' ? (
            <LoaderCircle size={15} className="spin" aria-hidden="true" />
          ) : null}
          Request connection
        </button>
      </form>
      <AreaFeedback cross={cross} area="use" />
    </section>
  );
}
