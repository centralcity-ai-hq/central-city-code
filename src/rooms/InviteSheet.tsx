import { useEffect, useRef, useState } from 'react';
import { Check, ChevronRight, Copy, LoaderCircle, User } from 'lucide-react';
import { withRoomDeadline, type History, type JoinLink, type Room, type RoomsClient } from './api';
import { describe } from './useRoomThread';
import { cachedJoinLink, joinLinkCache } from './joinLinkCache';
import { PanelHead, SwitchRow } from './PanelV3';
// How an outside AI joins with the link: one wording, shared with the Connect page.
import { roomInviteCopyLine } from '../shell/roomInvite';

/** The member limit steps by 10 (the mockup's −/+), clamped to 2…10 000 and never below today's members. */
const CAP_STEP = 10;
const CAP_MAX = 10_000;

/** One join link per room for this page's lifetime (shared with the Add an AI sheet). */
const cache = joinLinkCache;

/**
 * "Invite a person" (docs/design/ROOM_WHO_JOINS.md §4): the link as one full-width copy button,
 * the room code under it, and the host's room access behind a disclosure — the four switches,
 * the −/+ member limit and the link's quiet footer line (New link / Revoke).
 */
export function InviteSheet({
  client,
  room,
  onClose,
  onRoomChanged,
}: {
  client: RoomsClient;
  room: Room;
  onClose: () => void;
  /** After the host changes a room setting (history). */
  onRoomChanged?: () => void;
}) {
  const [link, setLink] = useState<JoinLink | null>(() => cachedJoinLink(room.id));
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const [copyHint, setCopyHint] = useState('');
  const [confirmNew, setConfirmNew] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const [notice, setNotice] = useState('');
  const rotateKey = useRef(crypto.randomUUID());
  const copiedTimer = useRef(0);
  const dialog = useRef<HTMLDivElement>(null);
  const [attempt, setAttempt] = useState(0);
  const [history, setHistory] = useState<History>(room.history);
  const [historyBusy, setHistoryBusy] = useState(false);
  const [historyError, setHistoryError] = useState('');
  // A room read that answers while a change is saving may predate that change: it must not put
  // the switch back (the save's own answer sets it, and the next read agrees).
  const historySaving = useRef(false);
  useEffect(() => {
    if (!historySaving.current) setHistory(room.history);
  }, [room.history]);
  // Host settings for people (migration 31): both on by default.
  const [people, setPeople] = useState({
    join: room.peopleMayJoin !== false,
    bringAi: room.membersMayBringAi !== false,
    dm: room.membersMayDm !== false,
  });
  const [peopleError, setPeopleError] = useState('');
  // Member cap (people and AIs share it): −/+ steps it, never below today's members.
  const [cap, setCap] = useState(room.member_cap ?? 0);
  const [capNote, setCapNote] = useState('');
  const capSeq = useRef(0);
  useEffect(() => setCap(room.member_cap ?? 0), [room.member_cap]);
  const capFloor = Math.max(2, room.member_count);
  // The host's own maximum tops the stepper (the server refuses above it; standard rooms: 100).
  const capTop = Math.min(CAP_MAX, room.memberCapMax ?? CAP_MAX);
  const clampCap = (value: number) => Math.min(capTop, Math.max(capFloor, value));
  async function stepCap(delta: number) {
    const next = clampCap(cap + delta);
    if (next === cap) return;
    // Optimistic: the number follows the click; a failure puts it back and says so. Clicks that
    // race each other settle on the last one (seq).
    setCap(next);
    setCapNote('');
    const seq = ++capSeq.current;
    try {
      const updated = await withRoomDeadline(
        client.setMemberCap({ room_id: room.id, member_cap: next }),
      );
      if (seq === capSeq.current) setCap(updated.member_cap ?? next);
      onRoomChanged?.();
    } catch (err) {
      if (seq === capSeq.current) {
        setCap(room.member_cap ?? next);
        setCapNote(describe(err));
      }
    }
  }
  async function changePeople(next: { join: boolean; bringAi: boolean; dm: boolean }) {
    const previous = people;
    setPeople(next);
    setPeopleError('');
    try {
      const updated = await withRoomDeadline(
        client.setPeople({
          room_id: room.id,
          people_may_join: next.join,
          members_may_bring_ai: next.bringAi,
          members_may_dm: next.dm,
        }),
      );
      setPeople({
        join: updated.peopleMayJoin !== false,
        bringAi: updated.membersMayBringAi !== false,
        dm: updated.membersMayDm !== false,
      });
      onRoomChanged?.();
    } catch (err) {
      setPeople(previous);
      setPeopleError(describe(err));
    }
  }

  useEffect(() => {
    if (link) return;
    let active = true;
    setError('');
    withRoomDeadline(client.joinLink({ room_id: room.id }))
      .then((value) => {
        if (!active) return;
        cache.set(room.id, value);
        setLink(value);
      })
      .catch((err) => active && setError(describe(err)));
    return () => {
      active = false;
    };
  }, [client, room.id, link, attempt]);

  // The latest onClose, so the focus effect below runs once: the room passes a new onClose on
  // every render, and re-running the effect would move focus to the opener and back.
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => () => window.clearTimeout(copiedTimer.current), []);
  // Focus the dialog, trap Tab inside it, close on Escape.
  useEffect(() => {
    const element = dialog.current;
    const previous = document.activeElement as HTMLElement | null;
    element?.focus();
    const keys = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close.current();
      if (event.key !== 'Tab' || !element) return;
      const focusable = [
        ...element.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input, summary, [href], [tabindex="0"]',
        ),
      ];
      const first = focusable[0];
      const last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener('keydown', keys);
    return () => {
      document.removeEventListener('keydown', keys);
      previous?.focus?.();
    };
  }, []);

  async function copy() {
    if (!link) return;
    window.clearTimeout(copiedTimer.current);
    try {
      if (!navigator.clipboard) throw new Error('Clipboard unavailable');
      // One ready line for the AI (join and stay); the room code below is for people.
      await navigator.clipboard.writeText(roomInviteCopyLine(link.url));
      setCopyHint('');
      setCopied(true);
      copiedTimer.current = window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard blocked: show the link itself, so the person can copy it by hand.
      setCopied(false);
      setCopyHint(link.url);
    }
  }
  async function copyCode() {
    if (!link?.code) return;
    try {
      if (!navigator.clipboard) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(link.code);
      setNotice('Code copied.');
    } catch {
      // The code stays on screen; the person copies it by hand.
      setNotice('Copy the code above by hand.');
    }
  }
  async function makeNew() {
    setBusy(true);
    setError('');
    try {
      await withRoomDeadline(
        client.rotate({ room_id: room.id, idempotency_key: rotateKey.current }),
      );
      rotateKey.current = crypto.randomUUID();
      cache.delete(room.id);
      setNotice('The old link no longer works. This is a new one.');
      // A stale "Copied" or a blocked-copy fallback shows the old link's text: both end here.
      setCopied(false);
      setCopyHint('');
      setConfirmNew(false);
      setLink(null);
    } catch (err) {
      setError(describe(err));
    } finally {
      setBusy(false);
    }
  }
  async function revoke() {
    if (!link) return;
    setBusy(true);
    setError('');
    try {
      await withRoomDeadline(client.revokeJoinLink({ id: link.id }));
      // Only this code stops working; a fresh link replaces it in the sheet.
      cache.delete(room.id);
      setConfirmRevoke(false);
      setNotice('The old link no longer works. This is a new one.');
      setCopied(false);
      setCopyHint('');
      setLink(null);
    } catch (err) {
      setError(describe(err));
    } finally {
      setBusy(false);
    }
  }

  async function changeHistory(next: History) {
    const previous = history;
    // Optimistic: the box follows the click; a failure puts it back and says so.
    setHistory(next);
    setHistoryBusy(true);
    historySaving.current = true;
    setHistoryError('');
    try {
      const updated = await withRoomDeadline(
        client.setHistory({ room_id: room.id, history: next }),
      );
      setHistory(updated.history);
      onRoomChanged?.();
    } catch (err) {
      setHistory(previous);
      setHistoryError(describe(err));
    } finally {
      historySaving.current = false;
      setHistoryBusy(false);
    }
  }

  const expires = link ? new Date(link.expires_at) : null;
  return (
    <div
      className="rm-backdrop rm-v3-scrim"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <div
        className="rm-sheet rm-v3-sheet rm-invite"
        role="dialog"
        aria-modal="true"
        aria-labelledby="rm-invite-title"
        tabIndex={-1}
        ref={dialog}
      >
        <PanelHead closeLabel="Close" onClose={onClose} className="rm-invite-sheet-head">
          <span className="rm-invite-ghost" aria-hidden="true">
            <User size={19} />
          </span>
          <span className="rm-invite-titles">
            <h2 id="rm-invite-title">Invite a person</h2>
            <p className="rm-invite-sub">Share the link or the code.</p>
          </span>
        </PanelHead>
        {error ? (
          <div className="rm-inline-error" role="alert">
            <span>{link ? error : "The link couldn't be created."}</span>
            {link ? null : (
              <button type="button" className="rm-quiet" onClick={() => setAttempt((n) => n + 1)}>
                Retry
              </button>
            )}
          </div>
        ) : null}
        {link ? (
          <>
            {/* The one action: the invite line lands in the clipboard (mockup's wide button). */}
            <button
              type="button"
              className="rm-v3-btn rm-v3-btn-primary rm-invite-copy"
              onClick={() => void copy()}
            >
              {copied ? (
                <Check size={16} aria-hidden="true" />
              ) : (
                <Copy size={16} aria-hidden="true" />
              )}
              <span>{copied ? 'Copied' : 'Copy invite link'}</span>
            </button>
            {link.code ? (
              <>
                <p className="rm-invite-code">
                  <strong className="rm-code">{link.code}</strong>
                  <button
                    type="button"
                    className="rm-v3-icon-btn"
                    aria-label="Copy code"
                    onClick={() => void copyCode()}
                  >
                    <Copy size={14} aria-hidden="true" />
                  </button>
                </p>
                <p className="rm-meta rm-invite-codecap">
                  or join with this code at centralcity.ai
                </p>
              </>
            ) : null}
            {notice ? (
              <p className="rm-meta" role="status">
                {notice}
              </p>
            ) : null}
            {copyHint ? (
              <p className="rm-meta rm-invite-url" role="status">
                {copyHint}
              </p>
            ) : null}
            <span className="rm-visually-hidden" aria-live="polite">
              {copied ? 'Invite copied' : ''}
            </span>
          </>
        ) : error ? null : (
          <p className="rm-muted" role="status">
            <LoaderCircle className="spin" size={14} aria-hidden="true" /> Creating your link…
          </p>
        )}
        <details className="rm-disclosure rm-invite-access">
          <summary>
            <ChevronRight size={16} aria-hidden="true" />
            Room access
          </summary>
          <div className="rm-invite-options">
            <SwitchRow
              label="Can read earlier messages"
              checked={history === 'full'}
              disabled={historyBusy}
              onChange={(checked) => void changeHistory(checked ? 'full' : 'from_join')}
            />
            {historyError ? (
              <p className="rm-inline-error" role="alert">
                {historyError}
              </p>
            ) : null}
            <SwitchRow
              label="People join as themselves"
              checked={people.join}
              onChange={(checked) => void changePeople({ ...people, join: checked })}
            />
            <SwitchRow
              label="Members can bring their AI"
              checked={people.bringAi}
              onChange={(checked) => void changePeople({ ...people, bringAi: checked })}
            />
            <SwitchRow
              label="Private messages"
              checked={people.dm}
              onChange={(checked) => void changePeople({ ...people, dm: checked })}
            />
            {peopleError ? (
              <p className="rm-inline-error" role="alert">
                {peopleError}
              </p>
            ) : null}
            {room.member_cap !== undefined ? (
              <div className="rm-invite-cap">
                <span>Member limit</span>
                {/* The limit comes from the room (the server sets the ceiling per account). */}
                <div className="rm-stepper">
                  <button
                    type="button"
                    aria-label="Fewer members"
                    disabled={cap <= capFloor}
                    onClick={() => void stepCap(-CAP_STEP)}
                  >
                    −
                  </button>
                  <output aria-label="Member limit">{cap}</output>
                  <button
                    type="button"
                    aria-label="More members"
                    disabled={cap >= capTop}
                    onClick={() => void stepCap(CAP_STEP)}
                  >
                    +
                  </button>
                </div>
              </div>
            ) : null}
            {capNote ? (
              <p className="rm-inline-error" role="alert">
                {capNote}
              </p>
            ) : null}
            {confirmRevoke ? (
              <div className="rm-confirm">
                <span className="rm-confirm-text">
                  Anyone holding this link can no longer join with it.
                </span>
                <span className="rm-confirm-actions">
                  <button
                    type="button"
                    className="rm-danger"
                    disabled={busy}
                    onClick={() => void revoke()}
                  >
                    Revoke link
                  </button>
                  <button
                    type="button"
                    className="rm-quiet"
                    onClick={() => setConfirmRevoke(false)}
                  >
                    Cancel
                  </button>
                </span>
              </div>
            ) : confirmNew ? (
              <div className="rm-confirm">
                <span className="rm-confirm-text">The old link stops working.</span>
                <span className="rm-confirm-actions">
                  <button
                    type="button"
                    className="rm-danger"
                    disabled={busy}
                    onClick={() => void makeNew()}
                  >
                    {busy ? 'Making a new link…' : 'Make a new link'}
                  </button>
                  <button type="button" className="rm-quiet" onClick={() => setConfirmNew(false)}>
                    Cancel
                  </button>
                </span>
              </div>
            ) : link ? (
              <p className="rm-invite-foot">
                {expires ? <span>Link valid until {expires.toLocaleString()}</span> : null}
                <span className="rm-invite-foot-gap" aria-hidden="true" />
                <button
                  type="button"
                  className="rm-invite-foot-btn"
                  onClick={() => setConfirmNew(true)}
                >
                  New link
                </button>
                <button
                  type="button"
                  className="rm-invite-foot-btn rm-invite-foot-danger"
                  onClick={() => setConfirmRevoke(true)}
                >
                  Revoke
                </button>
              </p>
            ) : null}
          </div>
        </details>
      </div>
    </div>
  );
}
