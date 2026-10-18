import { useEffect, useId, useRef, useState } from 'react';
import { CircleAlert, CircleCheck, LoaderCircle, TriangleAlert } from 'lucide-react';
import {
  FEED_PAY_LIMITS,
  FEED_PAY_RESULT_LABEL,
  feedPayCallDone,
  type FeedPayCall,
  type FeedPayResult,
} from '../../../shared/feed-pay';
import { plain } from '../feedFormat';
import { CopyButton, OutLink } from '../FeedParts';
import { getCall, payFailure } from '../payApi';
import {
  CALL_GONE,
  callLine,
  callMoneyLines,
  FEE_FOLLOW_MS,
  feeOpen,
  paymentLine,
  paymentNote,
  resultFrom,
  resultKeptText,
  RESULT_NOTICE,
  resultNotes,
  resultText,
  type CallMoneyLine,
  type MoneyLine,
} from './payModel';

/*
 * One call, while it pays and after: where it is (one line, read out as it changes), the payment
 * with its Base transaction once known (with Central City's fee: the price, the fee and the
 * total, each with its own), and the result, marked External: the service's answer as plain
 * text, never as instructions (no HTML, no Markdown, links don't open). The same card is the
 * drawer's last step and the call's own page (/feed/calls/<id>).
 */

const ICONS = { busy: LoaderCircle, ok: CircleCheck, warn: TriangleAlert, bad: CircleAlert };

/**
 * Reads the call every pollMs until it is done (feedPayCallDone): a terminal state, and Base
 * decided about the money; then, while Central City's fee is still being charged, up to
 * FEE_FOLLOW_MS more for its transaction. Paused while the tab is hidden; a failed read tries
 * again later. A call that can't be found any more stops it, and `gone` (and onGone) says so (no
 * spinner left turning).
 */
export function useCallPolling(
  initial: FeedPayCall,
  onUpdate?: (call: FeedPayCall) => void,
  onGone?: () => void,
): { call: FeedPayCall; gone: boolean } {
  const [call, setCall] = useState(initial);
  const [gone, setGone] = useState(false);
  useEffect(() => setCall(initial), [initial]);
  const report = useRef(onUpdate);
  report.current = onUpdate;
  const reportGone = useRef(onGone);
  reportGone.current = onGone;
  const done = (feedPayCallDone(call) || call.done) && !feeOpen(call);
  const callId = call.callId;
  useEffect(() => {
    if (done) return;
    let stop = false;
    let timer = 0;
    let misses = 0;
    let doneAt: number | null = null;
    const controller = new AbortController();
    const tick = async () => {
      if (stop) return;
      if (document.visibilityState === 'hidden') {
        timer = window.setTimeout(() => void tick(), FEED_PAY_LIMITS.pollMs);
        return;
      }
      try {
        const next = await getCall(callId, { signal: controller.signal });
        if (stop) return;
        misses = 0;
        setCall(next);
        report.current?.(next);
        if (feedPayCallDone(next) || next.done) {
          doneAt ??= Date.now();
          if (!feeOpen(next) || Date.now() - doneAt > FEE_FOLLOW_MS) return;
        }
      } catch (error) {
        if (stop) return;
        // A call that is not found any more stops here; anything else is read again, slower.
        if (payFailure(error).code === 'call_not_found') {
          setGone(true);
          reportGone.current?.();
          return;
        }
        misses += 1;
      }
      timer = window.setTimeout(
        () => void tick(),
        FEED_PAY_LIMITS.pollMs * Math.min(8, 2 ** Math.min(misses, 3)),
      );
    };
    timer = window.setTimeout(() => void tick(), FEED_PAY_LIMITS.pollMs);
    return () => {
      stop = true;
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [callId, done]);
  return { call, gone };
}

export function ResultBlock({ result, host }: { result: FeedPayResult; host: string }) {
  const id = useId();
  const text = resultText(result);
  const notes = resultNotes(result, host);
  return (
    <figure className="fp-result" aria-labelledby={id}>
      <figcaption id={id}>
        <span className="fp-ext">{FEED_PAY_RESULT_LABEL}</span>
        <span>{resultFrom(host)}</span>
      </figcaption>
      <p className="fd-fine">{RESULT_NOTICE}</p>
      {notes.map((note) => (
        <p key={note} className="fp-note">
          {note}
        </p>
      ))}
      {text ? (
        <>
          <pre className="fd-code fp-out" tabIndex={0} aria-label={`Result from ${host}`}>
            {text}
          </pre>
          <div className="fp-row">
            <CopyButton text={result.text ?? text} label="Copy" hidden=" the result" />
          </div>
        </>
      ) : null}
    </figure>
  );
}

/**
 * Price, Central City's fee and the total (or, fee included, the price and Central City's part of
 * it), one line each with its amount on the right: the quote before the confirm, and the call after
 * it (where each line also says where it stands and links its Base transaction).
 */
export function MoneyLines({
  lines,
  label,
  money,
}: {
  lines: Array<MoneyLine | CallMoneyLine>;
  label: string;
  money?: FeedPayCall['moneyMoved'];
}) {
  return (
    <dl className="fp-lines" aria-label={label} data-money={money}>
      {lines.map((line) => {
        const call = 'tx' in line ? line : null;
        const extra = call && (call.sub || call.note || call.tx);
        return (
          <div key={line.key} className="fp-line" data-k={line.key}>
            <dt>{line.label}</dt>
            <dd className="fp-line-v">{line.value}</dd>
            {extra ? (
              <dd className="fp-line-sub">
                {call.sub ? <span>{call.sub}</span> : null}
                {call.note ? <span className="fp-tag">{call.note}</span> : null}
                {call.tx ? (
                  <OutLink className="fd-link" href={call.tx.href} hidden="">
                    {call.tx.label}
                  </OutLink>
                ) : null}
              </dd>
            ) : null}
          </div>
        );
      })}
    </dl>
  );
}

export function CallCard({
  call: initial,
  onUpdate,
  onGone,
  headingId,
  heading,
  now = Date.now(),
  focusOnMount = false,
}: {
  call: FeedPayCall;
  /** Each newer read of the call (the drawer's footer follows it). */
  onUpdate?: (call: FeedPayCall) => void;
  /** The call can't be found any more (the drawer's footer treats it as finished). */
  onGone?: () => void;
  headingId?: string;
  /** The card's heading (the drawer: "Your call"; the call's page: the service's title). */
  heading: string;
  now?: number;
  focusOnMount?: boolean;
}) {
  const { call, gone } = useCallPolling(initial, onUpdate, onGone);
  const line = gone ? { text: CALL_GONE, tone: 'warn' as const } : callLine(call);
  const Icon = ICONS[line.tone];
  const done = feedPayCallDone(call) || call.done;
  const head = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (focusOnMount) head.current?.focus();
  }, [focusOnMount]);
  const payment = paymentLine(call);
  const note = paymentNote(call);
  // With Central City's fee: price, fee and total, each with its transaction (fee included: the
  // price and the fee's part of it, one transaction). Without: one line.
  const money = callMoneyLines(call);
  const kept = resultKeptText(call, now);
  return (
    <section className="fp-call" aria-labelledby={headingId} data-state={call.state}>
      <h3 id={headingId} tabIndex={-1} ref={head}>
        {heading}
      </h3>
      <p className="fp-state" data-tone={line.tone} role="status">
        <Icon size={16} aria-hidden="true" className={line.tone === 'busy' ? 'spin' : undefined} />
        <span>{line.text}</span>
      </p>
      {done || gone ? null : (
        <p className="fd-fine">
          You can close this. The call goes on and shows in {plain(call.agent.name)}’s wallet.
        </p>
      )}
      {money ? (
        <MoneyLines lines={money} label="Payment" money={call.moneyMoved} />
      ) : payment ? (
        <p className="fp-pay" data-money={call.moneyMoved}>
          <span>{payment}</span>
          {note ? <span className="fp-tag">{note}</span> : null}
          {call.payment?.explorerUrl ? (
            <OutLink className="fd-link" href={call.payment.explorerUrl} hidden="">
              Base transaction
            </OutLink>
          ) : null}
        </p>
      ) : null}
      {call.result ? <ResultBlock result={call.result} host={call.service.host} /> : null}
      {kept ? <p className="fd-fine">{kept}</p> : null}
    </section>
  );
}
