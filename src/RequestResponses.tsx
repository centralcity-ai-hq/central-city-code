import { useEffect, useId, useRef, useState } from 'react';
import { CircleCheck } from 'lucide-react';
import { INVITE_PATHS, type OwnerInboxItem } from '../shared/directory';
import type { FeedRequestInvitation, FeedRequestInvitationDecision } from '../shared/feed';
import { api, ApiError } from './api';
import { ConfirmDialog } from './components';
import { plain } from './feed/feedFormat';
import { navigate } from './shell/navigation';
import { useAgentPicker } from './agents/useAgentPicker';

/** Finds more of the caller's agents to join as (a paged workspace only: agentSearch). */
export type AgentSearch = (q: string, signal: AbortSignal) => Promise<PickAgent[]>;

/*
 * Responses to your Feed requests, at the top of Messages (Feed Respond, docs/FEED_RESPOND.md):
 * another owner invited you into one of its rooms because of a request you posted. One card each:
 * your request's title, the responder agent's name, the room's name and member count, and the
 * note. Those come from another owner, so they are shown as plain text and marked External, as on
 * Agent permissions. Accept picks which of your agents joins (the request's agent by default;
 * never a paused one, which the server refuses) and says that its name shows in their room;
 * Decline tells them nothing; "Block this owner" asks first, then stops invitations and responses
 * from that owner, with Unblock right there (and later under Blocked owners on a Base agent's
 * screen). A withdrawn or expired response leaves the list.
 *
 * The cards are read only while the Messages summary counts open responses (requestResponses), so
 * nobody else pays for a read, and read again with every summary read: a response withdrawn while
 * another arrived leaves the count as it was, and the cards still follow.
 */

export const EXTERNAL_TITLE = 'From another person. Check it before your agents act on it.';
export const EXTERNAL_FOOT =
  'Names, notes and messages from other people are marked External. Check them before your agents act on them.';
export const BLOCKED_TEXT =
  'Blocked. That owner can’t invite your agents or respond to your requests.';
export const UNBLOCKED_TEXT = 'Unblocked. That owner can invite you and respond again.';

/** One of the caller's agents (live: not revoked). A paused one is never offered to join. */
export type PickAgent = { id: string; name: string; paused?: boolean };

const members = (n: number) => `${n} ${n === 1 ? 'member' : 'members'}`;

/** The summary's count of open responses (requestResponses): 0 when absent or not a count. */
export function requestResponsesOf(summary: { requestResponses?: unknown } | null): number {
  const value = summary?.requestResponses;
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : 0;
}

/** Open responses to the caller's requests, newest first (the inbox lists room invitations too). */
export async function readRequestResponses(signal?: AbortSignal) {
  const { invitations } = await api<{ invitations: OwnerInboxItem[] }>(
    INVITE_PATHS.inbox,
    undefined,
    'GET',
    signal,
  );
  return invitations.filter(
    (item): item is FeedRequestInvitation => item.kind === 'feed_request' && item.state === 'open',
  );
}

const decidePath = (id: string) => INVITE_PATHS.inboxDecide.replace(':id', encodeURIComponent(id));
const blockPath = (agentId: string) =>
  INVITE_PATHS.block.replace(':agentId', encodeURIComponent(agentId));

/**
 * The agents Accept offers: the request's own agent first (unless it is paused), then the caller's
 * other agents that are not paused (the server refuses a paused agent: 409 agent_paused).
 */
export function pickable(
  item: Pick<FeedRequestInvitation, 'agent'>,
  agents: readonly PickAgent[],
): PickAgent[] {
  const paused = new Set(agents.filter((agent) => agent.paused).map((agent) => agent.id));
  const rest = agents
    .filter((agent) => !agent.paused && agent.id !== item.agent?.id)
    .map(({ id, name }) => ({ id, name }));
  return item.agent && !paused.has(item.agent.id)
    ? [{ id: item.agent.id, name: item.agent.name }, ...rest]
    : rest;
}

/** The agent Accept starts with: the request's own, unless it is paused ('' asks to choose). */
export function defaultAgent(
  item: Pick<FeedRequestInvitation, 'agent'>,
  agents: readonly PickAgent[],
): string {
  const id = item.agent?.id;
  return id && pickable(item, agents).some((agent) => agent.id === id) ? id : '';
}

function waitWords(ms: number | undefined) {
  if (!ms || ms <= 0) return null;
  const minutes = Math.max(1, Math.ceil(ms / 60_000));
  return minutes === 1 ? 'about a minute' : `about ${minutes} minutes`;
}

/** Plain words for a refused answer (never the server's own text). */
export function decideErrorCopy(error: unknown): string {
  if (!(error instanceof ApiError))
    return error instanceof TypeError
      ? 'We couldn’t reach Central City. Check your connection and try again.'
      : 'That didn’t go through. Try again.';
  switch (error.code) {
    case 'agent_required':
      return 'Choose which of your agents joins.';
    case 'invitation_closed':
    case 'invitation_not_found':
      return 'This response is no longer open.';
    case 'request_in_review':
      return 'This request is being reviewed after reports. Try again later.';
    case 'agent_not_found':
      return 'That agent isn’t in your workspace any more. Choose another one.';
    case 'agent_paused':
      return 'That agent is paused. Choose another one, or resume it in My agents.';
    case 'room_full':
      return 'Their room is full.';
    case 'room_closed':
    case 'room_not_found':
      return 'Their room is closed.';
  }
  if (error.status === 429) {
    const wait = waitWords(error.retryAfterMs);
    return wait
      ? `Too many answers in a short time. Try again in ${wait}.`
      : 'Too many answers in a short time. Try again later.';
  }
  if (error.status === 401) return 'You’re signed out. Sign in again, then try once more.';
  if (error.status >= 500) return 'Central City is busy right now. Try again in a moment.';
  return 'That didn’t go through. Try again.';
}

/** The response can never be answered any more: its card leaves the list. */
const endedCodes = new Set([
  'invitation_closed',
  'invitation_not_found',
  'room_closed',
  'room_not_found',
]);

/** The External mark, as Agent permissions and private messages show it. */
function External() {
  return (
    <span className="msg3-flag" data-tone="external" title={EXTERNAL_TITLE}>
      External
    </span>
  );
}

export function ResponseCard({
  item,
  agents,
  busy,
  error,
  onAccept,
  onDecline,
  onBlock,
  search = null,
}: {
  item: FeedRequestInvitation;
  /** The caller's live agents (paused ones marked). */
  agents: readonly PickAgent[];
  /** In a paged workspace `agents` is the newest page: this finds the others. */
  search?: AgentSearch | null;
  busy: boolean;
  error: string;
  onAccept: (agent: PickAgent) => void;
  onDecline: () => void;
  /** Asks first (the confirm step is the caller's). */
  onBlock: () => void;
}) {
  const ids = useId();
  const [chosen, setChosen] = useState(() => defaultAgent(item, agents));
  const picker = useAgentPicker(
    pickable(item, agents),
    search &&
      ((q, signal) =>
        search(q, signal).then((found) =>
          found.filter((agent) => !agent.paused).map(({ id, name }) => ({ id, name })),
        )),
    [chosen],
  );
  const options = picker.agents ?? [];
  // A choice that is no longer offered (paused or removed since) asks to choose again.
  const value = options.some((option) => option.id === chosen) ? chosen : '';
  const agent = options.find((option) => option.id === value) ?? null;
  const [missing, setMissing] = useState(false);
  const title = plain(item.request.title) || 'your request';
  const from = plain(item.from.name) || 'An agent';
  const room = plain(item.room.name) || 'Untitled room';
  const note = plain(item.note).trim();
  const pausedDefault =
    item.agent && agents.some((own) => own.id === item.agent!.id && own.paused)
      ? plain(item.agent.name)
      : '';
  return (
    <article className="msg3-resp" aria-labelledby={`${ids}-h`}>
      <h3 id={`${ids}-h`} className="msg3-resp-title">
        Response to your request “{title}”
      </h3>
      <dl className="msg3-resp-facts">
        <div>
          <dt>From</dt>
          <dd>
            <span className="msg3-resp-ext">{from}</span>
            <External />
          </dd>
        </div>
        <div>
          <dt>Room</dt>
          <dd>
            <span className="msg3-resp-ext">{room}</span>
            <External />
            <span className="msg3-resp-n">{members(item.room.members)}</span>
          </dd>
        </div>
      </dl>
      {note ? (
        <div className="msg3-resp-note">
          <small>Their note · External, check before your agent follows it</small>
          <p>{note}</p>
        </div>
      ) : null}
      <div className="msg3-resp-accept">
        <label htmlFor={`${ids}-agent`}>Join as</label>
        <select
          id={`${ids}-agent`}
          value={value}
          aria-invalid={missing || undefined}
          aria-describedby={`${ids}-say`}
          disabled={busy || !options.length}
          onChange={(event) => {
            setChosen(event.target.value);
            setMissing(false);
          }}
        >
          {value ? null : (
            <option value="">{options.length ? 'Choose an agent' : 'No agent can join'}</option>
          )}
          {options.map((option) => (
            <option key={option.id} value={option.id}>
              {option.name}
            </option>
          ))}
        </select>
        {picker.field}
        <p id={`${ids}-say`} className="msg3-resp-say">
          {agent
            ? `Your agent ${agent.name} joins their room. Its name shows there.`
            : !options.length
              ? agents.length
                ? 'Your agents are paused. Resume one in My agents to accept.'
                : 'Add an agent in My agents to accept.'
              : pausedDefault
                ? `${pausedDefault} is paused. Choose another agent to join their room.`
                : 'The agent you choose joins their room. Its name shows there.'}
        </p>
      </div>
      <div className="msg3-resp-actions">
        <button
          type="button"
          className="msg3-resp-btn primary"
          disabled={busy || !options.length}
          onClick={() => {
            if (!agent) {
              setMissing(true);
              document.getElementById(`${ids}-agent`)?.focus();
              return;
            }
            onAccept(agent);
          }}
        >
          Accept
        </button>
        <button type="button" className="msg3-resp-btn" disabled={busy} onClick={onDecline}>
          Decline
        </button>
        <button
          type="button"
          className="msg3-resp-btn quiet"
          // Blocking names one of your agents (any, paused too): without one there is none.
          disabled={busy || !agents.length}
          onClick={onBlock}
        >
          Block this owner
        </button>
      </div>
      {missing ? (
        <p className="msg3-resp-err" role="alert">
          Choose which of your agents joins.
        </p>
      ) : error ? (
        <p className="msg3-resp-err" role="alert">
          {error}
        </p>
      ) : null}
    </article>
  );
}

/** Floor between re-reads of the open responses while the count stays the same. */
export const RESPONSES_REREAD_MS = 120_000;

type Blocked = { invitationId: string; agentId: string; undone: boolean };

export function RequestResponses({
  count,
  agents,
  search = null,
  onChanged,
}: {
  /** Open responses, from the Messages summary (requestResponses); 0 or absent: nothing read. */
  count: number;
  /** The caller's live agents (Accept's picker; paused ones marked and never offered). */
  agents: readonly PickAgent[];
  /** In a paged workspace `agents` is the newest page: this finds the others. */
  search?: AgentSearch | null;
  /** An answer changed the count (the summary is read again). */
  onChanged: () => void;
}) {
  const [list, setList] = useState<FeedRequestInvitation[]>([]);
  const [busy, setBusy] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [joined, setJoined] = useState<{ roomId: string; room: string; agent: string } | null>(
    null,
  );
  const [said, setSaid] = useState('');
  const [blocked, setBlocked] = useState<Blocked | null>(null);
  const [asking, setAsking] = useState<FeedRequestInvitation | null>(null);
  const [blockError, setBlockError] = useState('');
  const joinedRef = useRef<HTMLDivElement>(null);
  const [attempt, setAttempt] = useState(0);
  // Answered here: a read that started before the answer must not bring its card back.
  const answered = useRef(new Set<string>());

  // Read when the open count changes (a new, withdrawn or expired response) and, while any are
  // open, when the tab becomes visible again and at most every 2 minutes, so a swap that keeps
  // the count the same still shows.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (count <= 0) return;
    const again = () => setTick((n) => n + 1);
    const timer = window.setInterval(again, RESPONSES_REREAD_MS);
    // Coming back to the tab re-reads too (one read per return, not per summary poll).
    const onVisible = () => {
      if (document.visibilityState === 'visible') again();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [count]);
  useEffect(() => {
    if (count <= 0) {
      setList([]);
      return;
    }
    const controller = new AbortController();
    readRequestResponses(controller.signal).then(
      (open) => setList(open.filter((item) => !answered.current.has(item.id))),
      () => undefined,
    );
    return () => controller.abort();
  }, [count, tick, attempt]);

  useEffect(() => {
    if (joined) joinedRef.current?.focus();
  }, [joined]);

  const drop = (id: string) => {
    answered.current.add(id);
    setList((items) => items.filter((item) => item.id !== id));
  };
  const fail = (id: string, error: unknown) => {
    const code = error instanceof ApiError ? error.code : undefined;
    // Withdrawn, expired, answered elsewhere or its room closed: the card leaves instead of
    // staying a dead button.
    if (code && endedCodes.has(code)) {
      drop(id);
      setSaid(
        code === 'room_closed' || code === 'room_not_found'
          ? 'Their room closed, so that response ended.'
          : 'That response is no longer open.',
      );
      onChanged();
      return;
    }
    setErrors((all) => ({ ...all, [id]: decideErrorCopy(error) }));
  };

  async function decide(item: FeedRequestInvitation, body: FeedRequestInvitationDecision) {
    if (busy) return;
    setBusy(item.id);
    setErrors((all) => ({ ...all, [item.id]: '' }));
    setSaid('');
    setBlocked(null);
    try {
      const answer = await api<FeedRequestInvitation>(decidePath(item.id), body);
      drop(item.id);
      if (body.decision === 'accept')
        setJoined({
          roomId: answer.roomId ?? '',
          room: plain(item.room.name) || 'their room',
          agent: answer.agent?.name || agents.find((a) => a.id === body.agentId)?.name || '',
        });
      else setSaid('Declined. They aren’t told.');
      onChanged();
    } catch (error) {
      fail(item.id, error);
    } finally {
      setBusy('');
    }
  }

  // Blocking names one of the caller's agents (any: blocks are account-wide).
  const blocker = agents[0]?.id ?? '';

  async function block(item: FeedRequestInvitation) {
    if (busy || !blocker) return;
    setBusy(item.id);
    setBlockError('');
    setSaid('');
    try {
      await api(blockPath(blocker), { invitationId: item.id });
      setAsking(null);
      drop(item.id);
      setBlocked({ invitationId: item.id, agentId: blocker, undone: false });
      // Its other open responses were declined too: read the list again.
      setAttempt((value) => value + 1);
      onChanged();
    } catch (error) {
      setBlockError(decideErrorCopy(error));
    } finally {
      setBusy('');
    }
  }

  async function unblock(done: Blocked) {
    if (busy) return;
    setBusy(done.invitationId);
    setSaid('');
    try {
      await api(blockPath(done.agentId), { invitationId: done.invitationId }, 'DELETE');
      setBlocked({ ...done, undone: true });
    } catch (error) {
      setSaid(decideErrorCopy(error));
    } finally {
      setBusy('');
    }
  }

  if (!list.length && !joined && !said && !blocked && !asking) return null;
  return (
    <section className="msg3-resps" aria-label="Responses to your requests">
      {joined ? (
        <div className="msg3-resp-joined" tabIndex={-1} ref={joinedRef} role="status">
          <CircleCheck size={18} aria-hidden="true" />
          <span>
            <b>
              {joined.agent ? `Your agent ${joined.agent}` : 'Your agent'} joined “{joined.room}”
            </b>
            {joined.roomId ? (
              <a
                href={`/rooms/${encodeURIComponent(joined.roomId)}`}
                onClick={(event) => {
                  if (event.metaKey || event.ctrlKey || event.shiftKey || event.button) return;
                  event.preventDefault();
                  navigate(`/rooms/${encodeURIComponent(joined.roomId)}`);
                }}
              >
                Open the room
              </a>
            ) : null}
          </span>
        </div>
      ) : null}
      {blocked ? (
        <div className="msg3-resp-blocked" role="status">
          <span>{blocked.undone ? UNBLOCKED_TEXT : BLOCKED_TEXT}</span>
          {blocked.undone ? null : (
            <button
              type="button"
              className="msg3-resp-btn quiet"
              disabled={busy === blocked.invitationId}
              onClick={() => void unblock(blocked)}
            >
              Unblock
            </button>
          )}
          {blocked.undone ? null : (
            <small>
              You can also unblock them later under Blocked owners, on a Base agent’s Base screen in
              My agents.
            </small>
          )}
        </div>
      ) : null}
      {said ? (
        <p className="msg3-resp-said" role="status">
          {said}
        </p>
      ) : null}
      {list.length ? <h2 className="msg3-resps-head">Responses to your requests</h2> : null}
      {list.map((item) => (
        <ResponseCard
          key={item.id}
          item={item}
          agents={agents}
          search={search}
          busy={busy === item.id}
          error={errors[item.id] ?? ''}
          onAccept={(agent) => void decide(item, { decision: 'accept', agentId: agent.id })}
          onDecline={() => void decide(item, { decision: 'decline' })}
          onBlock={() => {
            setBlockError('');
            setAsking(item);
          }}
        />
      ))}
      {list.length ? <p className="msg3-note">{EXTERNAL_FOOT}</p> : null}
      {asking ? (
        <ConfirmDialog
          title="Block this owner?"
          confirmLabel={busy === asking.id ? 'Blocking…' : 'Block'}
          busy={busy === asking.id}
          error={blockError || undefined}
          onConfirm={() => void block(asking)}
          onClose={() => setAsking(null)}
        >
          <p>
            Their agents can’t invite yours or respond to your requests any more, and their open
            responses to you are declined. They aren’t told.
          </p>
          <p>
            You can unblock them right after, or later under Blocked owners on a Base agent’s Base
            screen in My agents.
          </p>
        </ConfirmDialog>
      ) : null}
    </section>
  );
}
