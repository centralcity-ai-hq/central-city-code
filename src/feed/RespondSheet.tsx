import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { CircleAlert, CircleCheck, LoaderCircle } from 'lucide-react';
import {
  FEED_RESPOND_LIMITS,
  type FeedResponseSent,
  type PublicFeedRequest,
} from '../../shared/feed';
import { ApiError } from '../api';
import { FeedFailure, newIdempotencyKey } from './feedApi';
import { plain } from './feedFormat';
import { SignInButton } from './FeedParts';
import { useAgentPicker } from '../agents/useAgentPicker';
import {
  cleanNote,
  getMyResponses,
  hostedRooms,
  keptAgent,
  NEW_ROOM,
  newRoomAgents,
  newRoomHostSearch,
  noteLength,
  noteTooLong,
  openFromRoom,
  respondErrorCopy,
  roomAgents,
  sendResponse,
  withdrawResponse,
  type HostedRoom,
  type NewRoomAgents,
  type OwnAgent,
} from './respondApi';

/*
 * Respond on a signed-in request (docs/FEED_RESPOND.md): one sheet with Room (one the responder
 * hosts and is still open, or a new room named after the request), Respond as (its agent in that
 * room; for a new room any of its agents that is not paused) and Note. Send invites the poster
 * into that room; the poster answers in Messages. Nothing more is ever said about the answer. A
 * room that already has an open response to this request says "Already sent" (with Withdraw)
 * instead of Send; Withdraw says it was withdrawn and moves focus there.
 *
 * The note is counted and sent as the server cleans it (respondApi cleanNote). One idempotency
 * key per response meant: a retry of the same room, agent and note keeps it, so a New room
 * retried after a lost answer finds the room the first try made.
 */

export const SENT_TEXT = 'Sent. If they accept, their agent joins your room.';
export const WITHDRAWN_TEXT = 'Withdrawn. It left their Messages.';
/** The session ended (a call answered 401). */
export const SESSION_ENDED_TEXT = 'Your session ended. Sign in again to respond.';
/** The Feed is switched off (CITY_FEED=0; the respond routes answer 404 not_found). */
export const RESPOND_OFF_TEXT = 'Responding isn’t available right now. Try again later.';

type Phase = 'loading' | 'ready' | 'signed_out' | 'off' | 'failed';

const signedOut = (error: unknown) =>
  (error instanceof ApiError && error.status === 401) ||
  (error instanceof FeedFailure && error.code === 'signed_out');

/** The Feed is off: Respond's own routes answer 404 not_found. */
const featureOff = (error: unknown) => error instanceof FeedFailure && error.code === 'not_found';

/** Why Respond as offers nobody (or the sentence about what the poster sees). */
export function agentHint(
  room: string,
  agents: readonly OwnAgent[] | null,
  hosts: Pick<NewRoomAgents, 'paused' | 'workspacePaused'> | null,
  failed: boolean,
): string {
  if (failed) return 'Your agents couldn’t be loaded.';
  if (agents?.length !== 0)
    return 'The poster sees this agent’s name, the room’s name and how many are in it.';
  if (room !== NEW_ROOM) return 'None of your agents is in this room. Pick another room.';
  if (hosts?.workspacePaused) return 'Your workspace is paused. Resume it to start a room.';
  if (hosts?.paused)
    return 'Your agents are paused, and a paused agent can’t start a room. Resume one in My agents.';
  return 'Add an agent in My agents first.';
}

/**
 * The hint under Respond as. When loading the agents failed it offers Try again, which reloads
 * them for the same room (picking the same room again changes nothing, and a person hosting no
 * rooms has no other room to pick).
 */
export function AgentHint({
  id,
  room,
  agents,
  hosts,
  failed,
  onRetry,
}: {
  id: string;
  room: string;
  agents: readonly OwnAgent[] | null;
  hosts: Pick<NewRoomAgents, 'paused' | 'workspacePaused'> | null;
  failed: boolean;
  onRetry: () => void;
}) {
  return (
    <p className="fd-hint" id={id}>
      {agentHint(room, agents, hosts, failed)}
      {failed ? (
        <>
          {' '}
          <button type="button" className="fd-link" onClick={onRetry}>
            Try again
          </button>
        </>
      ) : null}
    </p>
  );
}

export function RespondSheet({ request }: { request: PublicFeedRequest }) {
  const ids = useId();
  const title = plain(request.title);
  const [phase, setPhase] = useState<Phase>('loading');
  const [attempt, setAttempt] = useState(0);
  const [rooms, setRooms] = useState<HostedRoom[]>([]);
  const [sent, setSent] = useState<FeedResponseSent[] | null>(null);
  const [room, setRoom] = useState('');
  const [agents, setAgents] = useState<OwnAgent[] | null>(null);
  const [hosts, setHosts] = useState<NewRoomAgents | null>(null);
  const [agentsFailed, setAgentsFailed] = useState(false);
  const [agentsAttempt, setAgentsAttempt] = useState(0);
  const [from, setFrom] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<'' | 'send' | 'withdraw'>('');
  const [problem, setProblem] = useState('');
  const [done, setDone] = useState(false);
  const [withdrawn, setWithdrawn] = useState(false);
  const key = useRef(newIdempotencyKey());
  const doneRef = useRef<HTMLDivElement>(null);
  const withdrawnRef = useRef<HTMLParagraphElement>(null);
  // A new room's hosts in a paged workspace: the newest agents, and a search for any other.
  const picker = useAgentPicker(
    agents,
    room === NEW_ROOM && hosts ? newRoomHostSearch(hosts.workspacePaused) : null,
    [from],
    { className: 'fd-agent-search' },
  );

  // One key per response meant: another room, agent or note is another response (the same key
  // with other values would be refused). A retry of the same response keeps its key.
  const cleaned = cleanNote(note);
  useEffect(() => {
    key.current = newIdempotencyKey();
  }, [room, from, cleaned]);

  useEffect(() => {
    if (done) doneRef.current?.focus();
  }, [done]);
  useEffect(() => {
    if (withdrawn) withdrawnRef.current?.focus();
  }, [withdrawn]);

  // The rooms this account hosts, and what it already sent to this request.
  useEffect(() => {
    const controller = new AbortController();
    setPhase('loading');
    Promise.all([
      hostedRooms(controller.signal),
      getMyResponses(request.id, { signal: controller.signal }),
    ]).then(
      ([hosted, mine]) => {
        setRooms(hosted);
        setSent(mine);
        setRoom((current) =>
          current && (current === NEW_ROOM || hosted.some((item) => item.id === current))
            ? current
            : (hosted[0]?.id ?? NEW_ROOM),
        );
        setPhase('ready');
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        setPhase(signedOut(error) ? 'signed_out' : featureOff(error) ? 'off' : 'failed');
      },
    );
    return () => controller.abort();
  }, [request.id, attempt]);

  // Respond as: the account's agents in the chosen room (a new room: its agents that may host).
  useEffect(() => {
    if (!room) return;
    const controller = new AbortController();
    setAgents(null);
    setHosts(null);
    setAgentsFailed(false);
    const load =
      room === NEW_ROOM
        ? newRoomAgents(controller.signal).then((found) => {
            setHosts(found);
            return found.agents;
          })
        : roomAgents(room, controller.signal);
    load
      .then((list) => {
        setAgents(list);
        setFrom((chosen) => keptAgent(list, chosen));
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        if (signedOut(error)) setPhase('signed_out');
        else setAgentsFailed(true);
      });
    return () => controller.abort();
  }, [room, agentsAttempt]);

  const already = openFromRoom(sent, room);

  async function send(event: FormEvent) {
    event.preventDefault();
    if (busy || already || !from) return;
    if (noteTooLong(note)) {
      setProblem(
        `Keep the note to ${FEED_RESPOND_LIMITS.noteMax.toLocaleString('en')} characters.`,
      );
      return;
    }
    setBusy('send');
    setProblem('');
    setWithdrawn(false);
    try {
      const answer = await sendResponse(request.id, {
        ...(room === NEW_ROOM ? { newRoom: true as const } : { roomId: room }),
        fromAgentId: from,
        note: cleaned,
        idempotencyKey: key.current,
      });
      setSent((list) => [answer, ...(list ?? []).filter((item) => item.id !== answer.id)]);
      if (room === NEW_ROOM && !rooms.some((item) => item.id === answer.roomId)) {
        // The new room is now one of the rooms this account hosts: shown as already sent.
        setRooms((list) => [{ id: answer.roomId, name: title || 'New room' }, ...list]);
        setRoom(answer.roomId);
      }
      setNote('');
      setDone(true);
    } catch (error) {
      if (error instanceof FeedFailure && error.code === 'response_open') {
        // Sent from this room before (another tab, a lost answer): read what is open.
        void getMyResponses(request.id).then(setSent, () => undefined);
      }
      // The key was used for other values (it can't be retried as it is): the next try is new.
      if (error instanceof FeedFailure && error.code === 'idempotency_conflict')
        key.current = newIdempotencyKey();
      if (signedOut(error)) setPhase('signed_out');
      else setProblem(respondErrorCopy(error));
    } finally {
      setBusy('');
    }
  }

  async function withdraw(response: FeedResponseSent) {
    if (busy) return;
    setBusy('withdraw');
    setProblem('');
    setWithdrawn(false);
    try {
      const answer = await withdrawResponse(response.id);
      setSent((list) => (list ?? []).map((item) => (item.id === answer.id ? answer : item)));
      setWithdrawn(true);
    } catch (error) {
      if (signedOut(error)) {
        setPhase('signed_out');
        return;
      }
      setProblem(respondErrorCopy(error));
      // No longer open (joined or ended meanwhile): read what it is now.
      if (
        error instanceof FeedFailure &&
        (error.code === 'invitation_closed' || error.code === 'invitation_not_found')
      )
        void getMyResponses(request.id).then(setSent, () => undefined);
    } finally {
      setBusy('');
    }
  }

  if (phase === 'signed_out')
    return (
      <div className="fd-signin-respond">
        <p className="fd-fine" role="status">
          {SESSION_ENDED_TEXT}
        </p>
        <SignInButton action="respond" reload />
      </div>
    );
  if (phase === 'loading')
    return (
      <p className="fd-fine" role="status">
        <LoaderCircle className="spin" size={14} aria-hidden="true" /> Loading your rooms…
      </p>
    );
  if (phase === 'off' || phase === 'failed')
    return (
      <p className="fd-err" role="alert">
        <CircleAlert size={14} aria-hidden="true" />
        <span>
          {phase === 'off' ? RESPOND_OFF_TEXT : 'Your rooms couldn’t be loaded.'}{' '}
          <button
            type="button"
            className="fd-link"
            onClick={() => setAttempt((value) => value + 1)}
          >
            Try again
          </button>
        </span>
      </p>
    );
  if (done)
    return (
      <div className="fd-done" tabIndex={-1} role="status" ref={doneRef}>
        <CircleCheck size={18} aria-hidden="true" />
        <div>
          <b>{SENT_TEXT}</b>
          <p className="fd-fine">You won’t hear if they decline.</p>
          <button type="button" className="fd-link" onClick={() => setDone(false)}>
            Respond from another room
          </button>
        </div>
      </div>
    );
  const count = noteLength(note);
  return (
    <form
      className="fd-respond"
      aria-label="Invite the poster to a room"
      onSubmit={(event) => void send(event)}
      noValidate
    >
      <div className="fd-fl">
        <label htmlFor={`${ids}-room`}>Room</label>
        <select
          className="fd-input"
          id={`${ids}-room`}
          value={room}
          onChange={(event) => {
            setRoom(event.target.value);
            setProblem('');
            setWithdrawn(false);
          }}
        >
          {rooms.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
          <option value={NEW_ROOM}>New room: {title || 'named after the request'}</option>
        </select>
      </div>
      {already ? (
        <div className="fd-already" role="status">
          <span>
            <b>Already sent</b> from this room. If they accept, their agent joins it.
          </span>
          <button
            type="button"
            className="fd-btn"
            aria-disabled={busy === 'withdraw' || undefined}
            onClick={() => void withdraw(already)}
          >
            {busy === 'withdraw' ? (
              <LoaderCircle className="spin" size={14} aria-hidden="true" />
            ) : null}
            {busy === 'withdraw' ? 'Withdrawing…' : 'Withdraw'}
          </button>
        </div>
      ) : (
        <>
          {withdrawn ? (
            <p className="fd-withdrawn" role="status" tabIndex={-1} ref={withdrawnRef}>
              <CircleCheck size={14} aria-hidden="true" />
              <span>{WITHDRAWN_TEXT}</span>
            </p>
          ) : null}
          <div className="fd-fl">
            <label htmlFor={`${ids}-from`}>Respond as</label>
            <select
              className="fd-input"
              id={`${ids}-from`}
              value={from}
              disabled={!agents?.length}
              aria-describedby={`${ids}-from-hint`}
              onChange={(event) => setFrom(event.target.value)}
            >
              {agents === null ? <option value="">Loading…</option> : null}
              {agents?.length === 0 ? (
                <option value="">No agent of yours can respond</option>
              ) : null}
              {(picker.agents ?? []).map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {plain(agent.name)}
                </option>
              ))}
            </select>
            {picker.field}
            <AgentHint
              id={`${ids}-from-hint`}
              room={room}
              agents={agents}
              hosts={hosts}
              failed={agentsFailed}
              onRetry={() => setAgentsAttempt((value) => value + 1)}
            />
          </div>
          <div className="fd-fl">
            <label htmlFor={`${ids}-note`}>
              Note <span className="fd-opt">(optional)</span>
            </label>
            <textarea
              className="fd-input"
              id={`${ids}-note`}
              rows={3}
              value={note}
              aria-invalid={noteTooLong(note) || undefined}
              aria-describedby={`${ids}-count`}
              onChange={(event) => {
                setNote(event.target.value);
                setProblem('');
              }}
            />
            <span className="fd-count" id={`${ids}-count`}>
              {count}/{FEED_RESPOND_LIMITS.noteMax}
              <span className="visually-hidden"> characters</span>
            </span>
          </div>
        </>
      )}
      {problem ? (
        <p className="fd-err" role="alert">
          <CircleAlert size={14} aria-hidden="true" />
          <span>{problem}</span>
        </p>
      ) : null}
      <p className="fd-fine">
        The poster sees your invitation in Messages and decides. You won’t hear if they decline.
      </p>
      {already ? null : (
        <button
          type="submit"
          className="fd-btn primary fd-respond-send"
          aria-disabled={Boolean(busy) || !from || undefined}
        >
          {busy === 'send' ? <LoaderCircle className="spin" size={14} aria-hidden="true" /> : null}
          {busy === 'send' ? 'Sending…' : 'Send'}
        </button>
      )}
    </form>
  );
}
