import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import {
  addFeedText,
  agentPayFailure,
  agentPayPanel,
  allowAgentPay,
  boundsText,
  changedText,
  notStoredText,
  readAgentPay,
  recheckAllow,
  recipientLines,
  statusText,
  unsureText,
  withdrawAgentPay,
  withdrawPrompt,
  withoutTryAgain,
  type AgentPayView,
} from '../../base/wallet/agentPay';
import { limitText, type LimitView } from '../../base/wallet/limits';

/*
 * "Paying on its own" under the limit card (Base Pay P2b; model: src/base/wallet/agentPay.ts). Only
 * for an active limit. It says plainly whom the agent may pay (other Central City agents; services
 * listed in the Feed only when the view offers them, with Central City's 10% fee on top for outside
 * services and included in the price for those sold by Central City agents) and that
 * every payment stays within the signed limit and, for a service, the per-call maximum. The owner
 * allows it with one explicit button, sees since when it is allowed, can also allow Feed services
 * when the view offers that, and withdraws it after a confirmation on the page itself. What a
 * confirm sends is exactly what the view on screen said (agentPay.ts consentRequest); when that
 * changed meanwhile, nothing is saved, the view is read again and the owner looks at it again. A
 * confirm that fails for any other reason reads the view again too: the screen shows what is
 * stored, or says plainly that it can't tell, never just what it showed before.
 * Nothing shows while the server doesn't offer this (404) or the limit isn't active.
 */

type Read =
  | { k: 'loading' }
  | { k: 'off' }
  /** Not read. `unsure`: a confirm got no clear answer and reading again failed too. */
  | { k: 'error'; message: string; unsure?: boolean }
  | { k: 'ready'; view: AgentPayView };
type Busy = 'allow' | 'also' | 'withdraw' | null;
/**
 * Where focus goes once the control that had it is gone. 'state': the status line, or the "limit
 * changed" line when the section shows that instead.
 */
type FocusTarget = 'status' | 'state' | 'error' | 'withdraw';

export function AgentPayConsent({
  agentId,
  name,
  limit,
  onLimitChanged,
}: {
  agentId: string;
  name: string;
  /** The limit on the card: the section is about it and nothing else. */
  limit: LimitView;
  /** Reads the limits again (the limit changed since the card was read). */
  onLimitChanged: () => void;
}) {
  const [read, setRead] = useState<Read>({ k: 'loading' });
  const [reading, setReading] = useState(false);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState('');
  const [confirming, setConfirming] = useState(false);
  const headingId = useId();
  const questionId = useId();
  const promptId = useId();
  const statusLine = useRef<HTMLParagraphElement>(null);
  const mismatchLine = useRef<HTMLParagraphElement>(null);
  const errorLine = useRef<HTMLParagraphElement>(null);
  const unreadLine = useRef<HTMLParagraphElement>(null);
  const withdrawButton = useRef<HTMLButtonElement>(null);
  const confirmBox = useRef<HTMLDivElement>(null);
  const focusNext = useRef<FocusTarget | null>(null);
  // Every read and request belongs to one generation: a newer read or request, another limit or
  // leaving the screen drops what an older one answers.
  const generation = useRef(0);

  const load = useCallback(async () => {
    const mine = ++generation.current;
    setReading(true);
    try {
      const answer = await readAgentPay(agentId);
      if (mine !== generation.current) return;
      setRead(answer.kind === 'off' ? { k: 'off' } : { k: 'ready', view: answer.view });
    } catch (err) {
      if (mine !== generation.current) return;
      // Still not read after a confirm with no clear answer: it stays "not sure", not just unread.
      setRead((now) =>
        now.k === 'error' && now.unsure ? now : { k: 'error', message: agentPayFailure(err) },
      );
      // Focus was on its way somewhere in the section: the message is what is there now.
      if (focusNext.current) focusNext.current = 'error';
    } finally {
      if (mine === generation.current) setReading(false);
    }
  }, [agentId]);

  // Read for this agent and this limit; a new limit starts with no confirmation open.
  useEffect(() => {
    setConfirming(false);
    void load();
  }, [load, limit.permissionHash]);
  useEffect(
    () => () => {
      generation.current += 1;
    },
    [],
  );

  useEffect(() => {
    const target = focusNext.current;
    if (!target || busy) return;
    const element =
      target === 'withdraw'
        ? withdrawButton.current
        : target === 'error'
          ? (errorLine.current ?? unreadLine.current ?? statusLine.current)
          : target === 'state'
            ? (statusLine.current ?? mismatchLine.current)
            : statusLine.current;
    // Not on screen yet (the section waits for the limit to be read again): it stays the target.
    if (!element) return;
    focusNext.current = null;
    element.focus();
  });
  useEffect(() => {
    if (confirming) confirmBox.current?.focus();
  }, [confirming]);

  /** A request starts a generation of its own: a read still on its way can't overwrite its answer. */
  const startRequest = () => {
    setReading(false);
    return ++generation.current;
  };

  async function allow(kind: 'allow' | 'also') {
    if (busy || read.k !== 'ready') return;
    // Exactly the view on screen: its limit and its confirmRecipients.
    const shown = read.view;
    const mine = startRequest();
    setBusy(kind);
    setError('');
    try {
      const result = await allowAgentPay(agentId, shown);
      if (mine !== generation.current) return;
      if (result.kind === 'allowed') {
        setRead({ k: 'ready', view: result.view });
        focusNext.current = 'status';
      } else {
        setRead(result.view ? { k: 'ready', view: result.view } : { k: 'off' });
        // In words that match the view read again (Feed services may no longer be offered).
        setError(changedText(result.change, name, kind === 'also', result.view));
        focusNext.current = 'error';
        if (result.change === 'limit') onLimitChanged();
      }
    } catch (err) {
      if (mine !== generation.current) return;
      // Not refused for a change: without a clear answer it may still have been stored, so the
      // view is read again and the screen shows that, never just what it showed before.
      const check = await recheckAllow(agentId, shown, err);
      if (mine !== generation.current) return;
      if (check.kind === 'stored') {
        setRead({ k: 'ready', view: check.view });
        focusNext.current = 'status';
      } else if (check.kind === 'not-stored') {
        if (check.view) setRead({ k: 'ready', view: check.view });
        setError(notStoredText(err, check.sure, kind === 'also'));
        focusNext.current = 'error';
        if (check.view && agentPayPanel(check.view, limit).k === 'mismatch') onLimitChanged();
      } else {
        // Neither an answer nor a new read: no status that could be wrong, only that it's unknown.
        setRead({ k: 'error', message: unsureText(name, kind === 'also'), unsure: true });
        focusNext.current = 'error';
      }
    } finally {
      setBusy(null);
    }
  }

  async function withdraw() {
    if (busy) return;
    const mine = startRequest();
    setBusy('withdraw');
    setError('');
    try {
      const view = await withdrawAgentPay(agentId);
      if (mine !== generation.current) return;
      setRead({ k: 'ready', view });
      setConfirming(false);
      focusNext.current = 'status';
    } catch (err) {
      // The confirmation stays, with why it didn't go through (withdrawing again is harmless).
      if (mine !== generation.current) return;
      setError(agentPayFailure(err));
    } finally {
      setBusy(null);
    }
  }

  const cancelWithdraw = () => {
    if (busy) return;
    focusNext.current = 'withdraw';
    setError('');
    setConfirming(false);
  };
  function confirmKeys(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== 'Escape') return;
    // Escape takes back the confirmation, not the screen.
    event.preventDefault();
    event.stopPropagation();
    cancelWithdraw();
  }
  /** Read again from a button that stays put (aria-disabled) while the read is on its way. */
  const readAgain = (target: FocusTarget, limitToo: boolean) => () => {
    if (reading) return;
    focusNext.current = target;
    if (limitToo) onLimitChanged();
    void load();
  };

  if (read.k === 'loading') return null;

  const heading = (
    <h4 id={headingId} className="w4-section">
      Paying on its own
    </h4>
  );
  const errorText = error ? (
    <p ref={errorLine} className="w4-error" role="alert" tabIndex={-1} data-k="agent-pay-error">
      {error}
    </p>
  ) : null;
  // No longer offered here: nothing to show, unless a message says why nothing was saved.
  if (read.k === 'off')
    return errorText ? (
      <section className="w4-steps w4-agentpay" aria-labelledby={headingId} data-k="agent-pay">
        {heading}
        {errorText}
      </section>
    ) : null;
  if (read.k === 'error')
    return (
      <section className="w4-steps w4-agentpay" aria-labelledby={headingId} data-k="agent-pay">
        {heading}
        <p
          ref={unreadLine}
          className="w4-caution"
          role="alert"
          tabIndex={-1}
          data-k={read.unsure ? 'agent-pay-unsure' : 'agent-pay-unread'}
        >
          <b>
            {read.unsure
              ? 'Not sure it went through.'
              : `Couldn’t read whether ${name} may pay on its own.`}
          </b>{' '}
          {withoutTryAgain(read.message)}{' '}
          {/* aria-disabled, not disabled: focus stays on it while the read is on its way. */}
          <button
            type="button"
            className="v4s-quiet"
            aria-disabled={reading || undefined}
            onClick={readAgain('state', false)}
          >
            {read.unsure ? 'Check again' : 'Try again'}
          </button>
        </p>
      </section>
    );

  const panel = agentPayPanel(read.view, limit);
  if (panel.k === 'hidden') return null;
  /** Null while the view is about another limit than the card, or none (both are read again). */
  const shown = panel.k === 'shown' ? panel : null;

  // What the owner can do now: allow, answer the withdraw confirmation, or withdraw.
  const action = !shown ? null : !shown.allowed ? (
    <button
      type="button"
      className="ap4-btn w4-wide"
      data-k="agent-pay-allow"
      aria-disabled={busy !== null || undefined}
      aria-busy={busy === 'allow' || undefined}
      onClick={() => void allow('allow')}
    >
      {busy === 'allow' ? 'Allowing…' : 'Allow these payments'}
    </button>
  ) : confirming ? (
    /* The buttons stay focusable while the request is on its way (aria-disabled), so focus
       stays put, also when it fails and the confirmation stays. Named by the question on screen. */
    <div
      ref={confirmBox}
      className="ap4-actions w4-confirm"
      role="group"
      aria-labelledby={questionId}
      aria-describedby={promptId}
      aria-busy={busy === 'withdraw' || undefined}
      tabIndex={-1}
      onKeyDown={confirmKeys}
    >
      <button
        type="button"
        className="ap4-btn ap4-danger-btn"
        aria-disabled={busy !== null || undefined}
        onClick={() => void withdraw()}
      >
        {busy === 'withdraw' ? 'Withdrawing…' : 'Yes, withdraw'}
      </button>
      <button
        type="button"
        className="ap4-btn ap4-ghost"
        aria-disabled={busy !== null || undefined}
        onClick={cancelWithdraw}
      >
        Keep it
      </button>
    </div>
  ) : (
    <button
      ref={withdrawButton}
      type="button"
      className="ap4-btn ap4-ghost w4-wide"
      data-k="agent-pay-withdraw"
      aria-disabled={busy !== null || undefined}
      onClick={() => {
        if (busy) return;
        setError('');
        setConfirming(true);
      }}
    >
      {/* Not just "Withdraw": on a wallet that reads as taking money out. */}
      Withdraw your permission
    </button>
  );

  // One layout for every state, the message always in the same place: when the section is drawn
  // again for a limit read again, the message that has focus stays the same element and keeps it.
  return (
    <section
      className="w4-steps w4-agentpay"
      aria-labelledby={headingId}
      data-k="agent-pay"
      data-allowed={shown ? shown.allowed : undefined}
    >
      {heading}
      {shown ? (
        <div className="w4-limit" data-k="agent-pay-card">
          <p
            ref={statusLine}
            className="w4-state"
            data-state={shown.allowed ? 'allowed' : 'not-allowed'}
            data-k="agent-pay-status"
            role="status"
            tabIndex={-1}
          >
            {statusText(shown, name)}
          </p>
          <p className="w4-hint">
            {shown.allowed ? `${name} may pay:` : `If you allow it, ${name} may pay:`}
          </p>
          <ul className="w4-facts" data-k="agent-pay-recipients">
            {recipientLines(shown.recipients, name).map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          <p className="w4-hint" data-k="agent-pay-bounds">
            {boundsText(name, limitText(limit))}
          </p>
          {shown.feedOff ? (
            <p className="w4-caution" data-k="agent-pay-feed-off">
              Paying services in the Feed is switched off right now.
            </p>
          ) : null}
        </div>
      ) : (
        <p
          ref={mismatchLine}
          className="w4-caution"
          role="status"
          tabIndex={-1}
          data-k="agent-pay-mismatch"
        >
          <b>The spending limit changed.</b>{' '}
          {/* This button goes once the section shows the new limit: its status takes focus. */}
          <button
            type="button"
            className="v4s-quiet"
            aria-disabled={reading || undefined}
            onClick={readAgain('status', true)}
          >
            Check again
          </button>
        </p>
      )}
      {/* One decision at a time: not while the withdraw confirmation is open. */}
      {shown?.addsFeed && !confirming ? (
        <div className="w4-steps" data-k="agent-pay-add-feed">
          <p className="w4-caution">{addFeedText(name)}</p>
          <button
            type="button"
            className="ap4-btn w4-wide"
            aria-disabled={busy !== null || undefined}
            aria-busy={busy === 'also' || undefined}
            onClick={() => void allow('also')}
          >
            {busy === 'also' ? 'Allowing…' : 'Also allow Feed services'}
          </button>
        </div>
      ) : null}
      {shown?.allowed && confirming ? (
        <p className="w4-caution" data-k="agent-pay-withdraw-prompt">
          <b id={questionId}>Withdraw your permission?</b>{' '}
          <span id={promptId}>{withdrawPrompt(name)}</span>
        </p>
      ) : null}
      {errorText}
      {action}
    </section>
  );
}
