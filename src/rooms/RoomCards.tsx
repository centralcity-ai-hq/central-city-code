import { useCallback, useEffect, useId, useState, type FormEvent } from 'react';
import { ApiError } from '../api';
import {
  answerApproval,
  approvalState,
  listCards,
  ownerDigest,
  recordDecision,
  taskSummary,
  type CardAnswer,
  type RoomCard,
  type RoomDigest,
} from './cards';
import { requestKey } from './requestKey';
import { withoutBidiControls } from './markdown/format';
import { PanelHead } from './PanelV3';

/*
 * Rooms P1 typed cards in the console (docs/ROOMS.md "Decisions and approvals"; design standard
 * rooms-p1-mockup-v4): the approval card under the line that asked, the decision as a one-line
 * centred event, and the quiet Decisions panel. Styles in rooms-p1-cards.css.
 * Titles, bodies and notes are untrusted text from other people and their AIs: shown as text,
 * never followed. Only the addressed owner sees the answer buttons (the server says can_answer).
 */

const REFRESH_MS = 30_000;
const timeFormat = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
const dayFormat = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' });

const clean = (text: string) => withoutBidiControls(text);

/** Calendar days from `now` to `date` (negative in the past), in local time. */
function dayOffset(date: Date, now: Date): number {
  const start = (value: Date) => new Date(value.toDateString()).getTime();
  return Math.round((start(date) - start(now)) / 86_400_000);
}

/** "today", "yesterday" or "29 Oct", for the panel's meta line. */
export function whenLabel(iso: string, now = new Date()): string {
  const date = new Date(iso);
  const days = dayOffset(date, now);
  if (days === 0) return 'today';
  if (days === -1) return 'yesterday';
  return dayFormat.format(date);
}

/** "expires today 12:00", "expires tomorrow 12:00" or "expires 31 Oct 12:00". */
export function expiryLabel(iso: string, now = new Date()): string {
  const date = new Date(iso);
  const days = dayOffset(date, now);
  const day = days === 0 ? 'today' : days === 1 ? 'tomorrow' : dayFormat.format(date);
  return `expires ${day} ${timeFormat.format(date)}`;
}

/**
 * The room's cards (all statuses), refreshed while the room is open and whenever `poke` changes
 * (a card line arrived). Null until the first load; stays null on a server without cards (404).
 */
export function useRoomCards(roomId: string, poke: number) {
  const [cards, setCards] = useState<RoomCard[] | null>(null);
  const refresh = useCallback(async () => {
    try {
      setCards((await listCards(roomId, { status: 'all' })).cards);
    } catch {
      // No cards on this server, or a failed read: the cards simply stay hidden.
    }
  }, [roomId]);
  useEffect(() => {
    setCards(null);
    void refresh();
    const timer = window.setInterval(() => void refresh(), REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);
  useEffect(() => {
    if (poke) void refresh();
  }, [poke, refresh]);
  const replace = useCallback((next: RoomCard[]) => {
    setCards((current) => {
      if (!current) return next;
      const byId = new Map(current.map((card) => [card.id, card]));
      for (const card of next) byId.set(card.id, card);
      return [...byId.values()];
    });
  }, []);
  return { cards, refresh, replace };
}

function message(err: unknown): string {
  return err instanceof ApiError ? err.message : 'Something went wrong. Try again.';
}

/**
 * The approval card (mockup v4 "ask"): the question, one meta line (who must answer, expiry or the
 * outcome) and, for the addressed owner only, the pills Approve / Not now / Suggest changes.
 */
export function ApprovalCard({
  card,
  onAnswered,
}: {
  card: RoomCard;
  onAnswered: (cards: RoomCard[]) => void;
}) {
  const [busy, setBusy] = useState<CardAnswer | null>(null);
  const [changes, setChanges] = useState(false);
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const noteId = useId();
  const approval = card.approval;
  if (!approval) return null;
  const pending = card.status === 'pending';
  const meta = pending
    ? `${approval.can_answer ? 'Needs your OK' : `Waiting for ${clean(approval.addressed_to)}`} · ${expiryLabel(approval.expires_at)}`
    : approvalState({
        ...card,
        approval: { ...approval, addressed_to: clean(approval.addressed_to) },
      });
  async function send(answer: CardAnswer) {
    setBusy(answer);
    setError('');
    try {
      const result = await answerApproval({
        roomId: card.room_id,
        ref: card.ref,
        answer,
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      onAnswered(result.decision ? [result.card, result.decision] : [result.card]);
      setChanges(false);
      setNote('');
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(null);
    }
  }
  return (
    <div
      className="rm-ask"
      data-testid="approval-card"
      data-ref={card.ref}
      data-status={card.status}
      role="group"
      aria-label={`Approval ${card.ref}`}
    >
      <div className="rm-ask-q">{clean(card.title)}</div>
      {card.body ? <div className="rm-ask-body">{clean(card.body)}</div> : null}
      <div className="rm-ask-d">
        <span className="rm-ask-ref">{card.ref}</span> · {clean(card.recorded_by)} asks · {meta}
        {!pending && approval.answer_note ? <> · “{clean(approval.answer_note)}”</> : null}
      </div>
      {pending && approval.can_answer ? (
        changes ? (
          <form
            className="rm-ask-changes"
            onSubmit={(event: FormEvent) => {
              event.preventDefault();
              if (note.trim()) void send('changes');
            }}
          >
            <label htmlFor={noteId} className="rm-visually-hidden">
              What should change
            </label>
            <textarea
              id={noteId}
              className="rm-input"
              rows={2}
              maxLength={500}
              value={note}
              placeholder="What should change?"
              onChange={(event) => setNote(event.target.value)}
              autoFocus
            />
            <div className="rm-ask-acts">
              <button
                type="submit"
                className="rm-pill rm-pill-primary"
                disabled={!note.trim() || busy !== null}
              >
                {busy === 'changes' ? 'Sending…' : 'Send'}
              </button>
              <button
                type="button"
                className="rm-pill"
                onClick={() => {
                  setChanges(false);
                  setNote('');
                }}
              >
                Cancel
              </button>
            </div>
          </form>
        ) : (
          <div className="rm-ask-acts">
            <button
              type="button"
              className="rm-pill rm-pill-primary"
              disabled={busy !== null}
              onClick={() => void send('approve')}
            >
              {busy === 'approve' ? 'Approving…' : 'Approve'}
            </button>
            <button
              type="button"
              className="rm-pill"
              disabled={busy !== null}
              onClick={() => void send('not_now')}
            >
              Not now
            </button>
            <button
              type="button"
              className="rm-pill"
              disabled={busy !== null}
              onClick={() => setChanges(true)}
            >
              Suggest changes
            </button>
          </div>
        )
      ) : null}
      {error ? (
        <div className="rm-ask-error" role="alert">
          {error}
        </div>
      ) : null}
    </div>
  );
}

/** A decision as the thread shows it (mockup v4 "event"): a green dot and one centred line. */
export function DecisionEvent({ card }: { card: RoomCard }) {
  const superseded = card.status === 'superseded';
  return (
    <div
      className="rm-decision-event"
      data-testid="decision-event"
      data-ref={card.ref}
      data-status={card.status}
    >
      <span className="rm-decision-dot" aria-hidden="true" />
      <span className="rm-decision-text">
        {clean(card.recorded_by)} decided: {clean(card.title)}
        {superseded && card.superseded_by ? (
          <span className="rm-decision-meta"> · superseded by {card.superseded_by}</span>
        ) : null}
      </span>
    </div>
  );
}

/**
 * The Decisions panel (mockup v4 side panel): approvals waiting for you first, then the current
 * decisions with ticks, newest first; superseded ones folded under a toggle. Members who may post
 * record a decision at the bottom.
 */
export function DecisionsPanel({
  roomId,
  cards,
  canRecord,
  agentId,
  onRecorded,
  onClose,
}: {
  roomId: string;
  cards: RoomCard[] | null;
  /** Whether the viewer may record decisions here (a posting member, room open). */
  canRecord: boolean;
  /** The member the viewer records as (the console's person, or its only AI). */
  agentId?: string | undefined;
  onRecorded: (cards: RoomCard[]) => void;
  onClose: () => void;
}) {
  const [showOld, setShowOld] = useState(false);
  const [title, setTitle] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [key] = useState(() => requestKey());
  const titleId = useId();
  const list = cards ?? [];
  const decisions = list
    .filter((card) => card.kind === 'decision')
    .sort((a, b) => b.number - a.number);
  const current = decisions.filter((card) => card.status === 'current');
  const old = decisions.filter((card) => card.status !== 'current');
  const waiting = list
    .filter((card) => card.kind === 'approval' && card.approval?.can_answer)
    .sort((a, b) => b.number - a.number);
  async function submit(event: FormEvent) {
    event.preventDefault();
    const text = title.trim();
    if (!text) return;
    setSaving(true);
    setError('');
    try {
      const card = await recordDecision({
        roomId,
        title: text,
        ...(agentId ? { agentId } : {}),
        idempotencyKey: key.for({ title: text, agentId: agentId ?? null }),
      });
      key.done();
      onRecorded([card]);
      setTitle('');
    } catch (err) {
      setError(message(err));
    } finally {
      setSaving(false);
    }
  }
  return (
    <aside
      className="rm-panel rm-decisions-panel rm-v3-panel"
      aria-label="Decisions"
      data-testid="decisions-panel"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <PanelHead closeLabel="Close decisions" onClose={onClose}>
        <h2>
          Decisions{' '}
          <span className="rm-v3-head-count" aria-label={`${current.length} current`}>
            {current.length}
          </span>
        </h2>
      </PanelHead>
      <div className="rm-v3-body rm-cards-body">
        {cards === null ? <p className="rm-cards-empty">Loading…</p> : null}
        {waiting.length ? (
          <section className="rm-cards-section" aria-label="Waiting for you">
            <h3>Waiting for you</h3>
            {waiting.map((card) => (
              <ApprovalCard key={card.id} card={card} onAnswered={onRecorded} />
            ))}
          </section>
        ) : null}
        <section className="rm-cards-section" aria-label="Current decisions">
          {cards !== null && !current.length ? (
            <p className="rm-cards-empty">No decisions yet.</p>
          ) : null}
          <ul className="rm-cards-list">
            {current.map((card) => (
              <li
                key={card.id}
                className="rm-card-it"
                data-testid="decision-row"
                data-ref={card.ref}
                data-human={card.recorded_by_kind === 'person' || undefined}
              >
                <span className="rm-tick" aria-hidden="true" />
                <div className="rm-card-x">
                  {clean(card.title)}
                  <div className="rm-card-s">
                    {card.ref} · {clean(card.recorded_by)} · {whenLabel(card.created_at)}
                    {card.from_approval ? (
                      <span className="rm-card-human">
                        {' '}
                        · owner's answer to {card.from_approval}
                      </span>
                    ) : card.recorded_by_kind === 'person' ? (
                      <span className="rm-card-human"> · by a person</span>
                    ) : null}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </section>
        {old.length ? (
          <section className="rm-cards-section" aria-label="Superseded decisions">
            <button
              type="button"
              className="rm-cards-toggle"
              aria-expanded={showOld}
              onClick={() => setShowOld((value) => !value)}
            >
              {showOld ? 'Hide' : 'Show'} {old.length} superseded
            </button>
            {showOld ? (
              <ul className="rm-cards-list rm-cards-old">
                {old.map((card) => (
                  <li key={card.id} className="rm-card-it" data-ref={card.ref}>
                    <span className="rm-tick rm-tick-off" aria-hidden="true" />
                    <div className="rm-card-x">
                      {clean(card.title)}
                      <div className="rm-card-s">
                        {card.ref} · superseded by {card.superseded_by ?? 'a newer decision'}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            ) : null}
          </section>
        ) : null}
        {canRecord ? (
          <form className="rm-cards-record" onSubmit={(event) => void submit(event)}>
            <label htmlFor={titleId} className="rm-cards-record-label">
              Record a decision
            </label>
            <input
              id={titleId}
              className="rm-input"
              value={title}
              maxLength={200}
              placeholder="What did the room decide?"
              onChange={(event) => setTitle(event.target.value)}
            />
            <button
              type="submit"
              className="rm-pill rm-pill-primary"
              disabled={!title.trim() || saving}
            >
              {saving ? 'Saving…' : 'Record'}
            </button>
            {error ? (
              <div className="rm-ask-error" role="alert">
                {error}
              </div>
            ) : null}
          </form>
        ) : null}
      </div>
    </aside>
  );
}

/**
 * "Rooms today" on the rooms list (mockup v4 "Your daily summary"): per room with something to
 * say in the last 24 hours, what needs you, what was decided and how the tasks stand. Built by
 * the server from cards and task states only, never from chat. Hidden when there is nothing.
 */
export function RoomsToday({ onOpen }: { onOpen: (roomId: string) => void }) {
  const [rooms, setRooms] = useState<RoomDigest[] | null>(null);
  useEffect(() => {
    let live = true;
    const load = async () => {
      try {
        const digest = await ownerDigest(24);
        if (live) setRooms(digest.rooms);
      } catch {
        // No digest on this server, or a failed read: the summary simply stays hidden.
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), 5 * REFRESH_MS);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, []);
  if (!rooms?.length) return null;
  const titles = (items: Array<{ ref: string; title: string }>) =>
    items.map((entry) => clean(entry.title)).join(' · ');
  return (
    <section className="rm-today" aria-labelledby="rm-today-title" data-testid="rooms-today">
      <h2 id="rm-today-title">Rooms today</h2>
      {rooms.map((room) => {
        const tasks = taskSummary(room.tasks);
        return (
          <div key={room.room_id} className="rm-today-room" data-testid="rooms-today-room">
            <div className="rm-today-name">{clean(room.name)}</div>
            {room.needs_you.length ? (
              <div className="rm-today-row">
                <span>Needs you</span>
                <span>{titles(room.needs_you)}</span>
              </div>
            ) : null}
            {room.decided.length ? (
              <div className="rm-today-row">
                <span>Decided</span>
                <span>{titles(room.decided)}</span>
              </div>
            ) : null}
            {room.answered.length ? (
              <div className="rm-today-row">
                <span>Answered</span>
                <span>
                  {room.answered
                    .map((entry) => `${clean(entry.title)} (${entry.status.replace('_', ' ')})`)
                    .join(' · ')}
                </span>
              </div>
            ) : null}
            {tasks ? (
              <div className="rm-today-row">
                <span>Tasks</span>
                <span>{tasks}</span>
              </div>
            ) : null}
            <div className="rm-ask-acts">
              <button
                type="button"
                className={`rm-pill${room.needs_you.length ? ' rm-pill-primary' : ''}`}
                onClick={() => onOpen(room.room_id)}
              >
                Open room
              </button>
            </div>
          </div>
        );
      })}
    </section>
  );
}
