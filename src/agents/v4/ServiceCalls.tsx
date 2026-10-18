import {
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { Wallet, X } from 'lucide-react';
import {
  DEFAULT_PER_CALL_MAX_RAW,
  FEED_PAY_TERMINAL_STATES,
  RESULT_KEEP_DAYS,
  type FeedPayAgent,
  type FeedPayFloatMove,
  type FeedPayHistory,
  type FeedPayHistoryItem,
} from '../../../shared/feed-pay';
import { workspaceClick } from '../../feed/feedNav';
import { feedHref } from '../../feed/feedPaths';
import { getServiceCalls, payFailure } from '../../feed/payApi';
import {
  agentLines,
  callMoneyLines,
  feeOpen,
  feeTxHref,
  historyAmountRaw,
  historyLine,
  historyMoneyText,
  MAX_HELP,
  maxProblemText,
  maxSavedText,
  moveLine,
  perCallMaxRange,
  potSavedText,
  POT_RANGE,
  POT_HELP,
  floatTargetRaw,
  perCallMaxRaw,
  usdcText,
} from '../../feed/pay/payModel';
import { saveFloatTarget, savePerCallMax, usePayAccess } from '../../feed/pay/usePayAccess';

/*
 * An agent's services in its Wallet (Feed pay, docs/FEED_PAY.md section 15): two tiles, "Ready to
 * spend" (the USDC its spender account keeps to pay services; unused USDC goes back) and its
 * per-call maximum (Change, while Feed pay is on for the owner), with what is left of its spending
 * limit in the Use sheet's own words; then Activity, one line per entry grouped by day, whose
 * details open in a sheet: the service calls it paid,
 * from the Feed or the owner's AI (with Central City's fee on top: the price, the fee and the
 * total, the amount being the total; fee included: the price, which is the amount, and Central
 * City's part of it), and the USDC moved between its own two accounts, which are never
 * payments to anyone. A call whose result is still kept opens it (/feed/calls/<id>). Read when
 * shown, and again every POLL_MS only while a call, its fee or a move is still going on; nothing
 * shows while Feed pay never touched this agent. WalletScreen loads this lazily: the workspace
 * doesn't carry the Feed pay client until a wallet is opened.
 */

const POLL_MS = 20_000;
const SHOWN = 20;

/** A call (or its Central City fee) or a move that may still change: worth reading again. */
function pending(history: FeedPayHistory): boolean {
  return (
    history.calls.some(
      (item) =>
        item.moneyMoved === 'pending' || !FEED_PAY_TERMINAL_STATES.has(item.state) || feeOpen(item),
    ) || history.moves.some((move) => move.state === 'pending')
  );
}

/** A Base transaction, in a new tab (said to assistive technology). */
function TxLink({
  href,
  label = 'Base transaction',
  className,
}: {
  href: string;
  label?: string;
  className?: string;
}) {
  return (
    <a className={className} href={href} target="_blank" rel="noopener noreferrer">
      {label}
      <span className="visually-hidden"> (opens in a new tab)</span>
    </a>
  );
}

const DAY_MS = 86_400_000;
const DEFAULT_MAX = usdcText(String(DEFAULT_PER_CALL_MAX_RAW));

const clock = (at: number) =>
  new Date(at).toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });

/** "Today", "Yesterday", else "Oct 14": the local day an entry belongs to. */
function dayText(at: number, now: number): string {
  const day = new Date(at).toDateString();
  if (day === new Date(now).toDateString()) return 'Today';
  if (day === new Date(now - DAY_MS).toDateString()) return 'Yesterday';
  return new Date(at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** The colour behind a service's letter: always the same for one host, dark enough for white. */
const MARKS = [
  '#1d4ed8',
  '#047857',
  '#b45309',
  '#be123c',
  '#6d28d9',
  '#0e7490',
  '#4d7c0f',
  '#c2410c',
  '#475569',
  '#a21caf',
];
function markColour(host: string): string {
  let hash = 0;
  for (const char of host) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return MARKS[hash % MARKS.length]!;
}

type Line =
  | { kind: 'call'; key: string; at: number; item: FeedPayHistoryItem }
  | { kind: 'move'; key: string; at: number; move: FeedPayFloatMove };

type Show = 'all' | 'call' | 'move';
const SHOWS: { value: Show; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'call', label: 'Payments' },
  { value: 'move', label: 'Transfers' },
];

function Mark({ line }: { line: Line }) {
  if (line.kind === 'move')
    return (
      <span className="w4-mark w4-mark-move" aria-hidden="true">
        <Wallet size={16} strokeWidth={1.8} />
      </span>
    );
  const host = line.item.service.host;
  return (
    <span className="w4-mark" style={{ background: markColour(host) }} aria-hidden="true">
      {(host.match(/[a-z0-9]/i)?.[0] ?? '?').toUpperCase()}
    </span>
  );
}

/** A call's state in a word or two, as historyLine says it; null for a paid call that worked. */
function callState(item: FeedPayHistoryItem): string | null {
  if (item.state === 'paid_no_result') return 'No result';
  if (item.moneyMoved === 'yes') return null;
  if (item.moneyMoved === 'pending' || !FEED_PAY_TERMINAL_STATES.has(item.state)) return 'Paying';
  if (item.state === 'result_saved') return 'No money moved';
  return 'Didn’t go through';
}

const moveState = (move: FeedPayFloatMove) =>
  move.state === 'pending' ? 'Pending' : move.state === 'failed' ? 'Didn’t go through' : null;

const origin = (item: FeedPayHistoryItem) => (item.origin === 'mcp' ? 'By your AI' : 'Feed');

/** The amount a line shows: a call's total (minus once paid), a move's amount (never minus). */
function Amount({ line }: { line: Line }) {
  if (line.kind === 'move')
    return <span className="w4-amt w4-pend w4-neutral">{usdcText(line.move.amount.raw)}</span>;
  const amount = historyAmountRaw(line.item);
  if (!amount) return null;
  const paid = line.item.moneyMoved === 'yes';
  return (
    <span className={`w4-amt${paid ? '' : ' w4-pend'}`}>
      {paid ? '−' : ''}
      {usdcText(amount)}
    </span>
  );
}

function Row({
  line,
  id,
  now,
  onOpen,
}: {
  line: Line;
  id: string;
  now: number;
  onOpen: () => void;
}) {
  const call = line.kind === 'call' ? line.item : null;
  const state = line.kind === 'call' ? callState(line.item) : moveState(line.move);
  return (
    <button
      type="button"
      id={id}
      className="w4-act"
      aria-haspopup="dialog"
      onClick={onOpen}
      {...(call
        ? { 'data-k': 'service-call', 'data-state': call.state, 'data-money': call.moneyMoved }
        : { 'data-k': 'float-move', 'data-state': line.kind === 'move' ? line.move.state : '' })}
    >
      <Mark line={line} />
      <span className="w4-act-who">
        <b>
          {call
            ? call.service.host
            : line.kind === 'move' && line.move.kind === 'top_up'
              ? 'To Ready to spend'
              : 'Back to the wallet'}
        </b>
        <span>
          {call ? origin(call) : 'Own accounts'}
          {' · '}
          {clock(line.at)}
          {state ? ` · ${state}` : ''}
        </span>
      </span>
      <Amount line={line} />
      <span className="visually-hidden">{dayText(line.at, now)}</span>
    </button>
  );
}

/** One fact of the sheet: a label, its value, and a small grey tag. */
function Fact({
  label,
  children,
  tag,
}: {
  label: string;
  children: ReactNode;
  tag?: string | null;
}) {
  return (
    <div className="w4-fact">
      <dt>{label}</dt>
      <dd>
        {children}
        {tag ? <span className="w4-tag">{tag}</span> : null}
      </dd>
    </div>
  );
}

function CallSheetBody({ item, now }: { item: FeedPayHistoryItem; now: number }) {
  const href = feedHref.call(item.callId);
  const tx = item.payment?.explorerUrl;
  const money = callMoneyLines(item);
  // The fee's own transaction, shown where the History showed it: with a fee on top.
  const feeTx = historyMoneyText(item) ? feeTxHref(item) : null;
  const oldEnough = now - item.createdAt > RESULT_KEEP_DAYS * DAY_MS;
  const state = callState(item);
  return (
    <>
      <dl
        className="w4-facts-card"
        data-k={money ? 'service-call-fee' : undefined}
        aria-label="Payment"
      >
        {money ? (
          money.map((line) => (
            <Fact key={line.key} label={line.label} tag={line.note}>
              {line.key === 'total' ? (
                <b>{usdcText(line.raw)} USDC</b>
              ) : (
                `${usdcText(line.raw)} USDC`
              )}
            </Fact>
          ))
        ) : item.payment ? (
          <Fact label="Price">{usdcText(item.payment.amountRaw)} USDC</Fact>
        ) : null}
        <Fact label="Found in">{origin(item)}</Fact>
        <Fact label="Status">
          {item.state === 'paid_no_result' ? 'Paid, no result' : (state ?? 'Paid')}
        </Fact>
      </dl>
      <div className="w4-sheet-actions">
        {item.resultAvailable ? (
          <a className="ap4-btn" href={href} onClick={workspaceClick(href)}>
            Open result
          </a>
        ) : oldEnough ? (
          <p className="w4-hint">Result deleted after {RESULT_KEEP_DAYS} days</p>
        ) : (
          <a className="ap4-btn ap4-ghost" href={href} onClick={workspaceClick(href)}>
            Details
          </a>
        )}
        {tx ? <TxLink className="ap4-btn ap4-ghost" href={tx} /> : null}
        {feeTx ? (
          <TxLink className="ap4-btn ap4-ghost" href={feeTx} label="Fee transaction" />
        ) : null}
      </div>
    </>
  );
}

function MoveSheetBody({ move }: { move: FeedPayFloatMove }) {
  return (
    <>
      <dl className="w4-facts-card" aria-label="Transfer">
        <Fact label="Between">Wallet and Ready to spend</Fact>
        <Fact label="Status">{moveState(move) ?? 'Final on Base'}</Fact>
      </dl>
      {move.explorerUrl ? (
        <div className="w4-sheet-actions">
          <TxLink className="ap4-btn ap4-ghost" href={move.explorerUrl} />
        </div>
      ) : null}
    </>
  );
}

/**
 * One entry's details, over the page: a side sheet (a bottom sheet on phones). A dialog: the rest
 * of the page is inert while it is open, focus starts on Close, and Escape, the scrim or Close
 * closes it and gives focus back to the line that opened it.
 */
function Sheet({
  line,
  now,
  returnTo,
  onClose,
}: {
  line: Line;
  now: number;
  returnTo: string;
  onClose: () => void;
}) {
  const id = useId();
  const [host] = useState(() =>
    typeof document === 'undefined'
      ? null
      : (document.querySelector<HTMLElement>('.app-shell') ?? document.body),
  );
  const layer = useRef<HTMLDivElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const back = useRef(returnTo);
  back.current = returnTo;

  useEffect(() => {
    if (!host) return;
    const others = Array.from(host.children).filter(
      (element) => element !== layer.current && !element.hasAttribute('inert'),
    );
    for (const element of others) element.setAttribute('inert', '');
    close.current?.focus();
    return () => {
      for (const element of others) element.removeAttribute('inert');
      document.getElementById(back.current)?.focus({ preventScroll: true });
    };
  }, [host]);

  if (!host) return null;
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    // Handled here: the pane leaves a handled Escape alone, so it doesn't go back too.
    event.preventDefault();
    onClose();
  };
  const call = line.kind === 'call' ? line.item : null;
  const title = call
    ? call.service.host
    : line.kind === 'move' && line.move.kind === 'top_up'
      ? 'To Ready to spend'
      : 'Back to the wallet';
  return createPortal(
    <div className="ap4 w4-sheet-layer" ref={layer} onKeyDown={onKeyDown}>
      <div className="w4-scrim" aria-hidden="true" onClick={onClose} />
      <aside
        className="w4-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-t`}
        data-k="call-sheet"
        tabIndex={-1}
      >
        <header className="w4-sheet-head">
          <Mark line={line} />
          <div className="w4-act-who">
            <b id={`${id}-t`}>{title}</b>
            <span>
              {dayText(line.at, now)}, {clock(line.at)}
            </span>
          </div>
          <button type="button" ref={close} className="w4-x" aria-label="Close" onClick={onClose}>
            <X size={16} aria-hidden="true" />
          </button>
        </header>
        <div className="w4-sheet-amt">
          <Amount line={line} /> <small>USDC</small>
        </div>
        <p
          className="w4-sheet-line"
          data-state={call ? call.state : undefined}
          data-k={call ? undefined : 'float-move-line'}
        >
          {call ? historyLine(call) : line.kind === 'move' ? moveLine(line.move) : null}
        </p>
        {call ? (
          <CallSheetBody item={call} now={now} />
        ) : line.kind === 'move' ? (
          <MoveSheetBody move={line.move} />
        ) : null}
      </aside>
    </div>,
    host,
  );
}

/**
 * What share of its limit the agent may still spend, as the words next to it say ("3.50 of 5.00
 * USDC left"): a bar's width only, never a number shown.
 */
function leftShare(leftRaw: string, limitRaw: string): number | null {
  if (!/^\d{1,30}$/.test(leftRaw) || !/^\d{1,30}$/.test(limitRaw)) return null;
  const limit = BigInt(limitRaw);
  if (limit <= 0n) return null;
  const left = BigInt(leftRaw);
  return Math.min(
    1,
    Math.max(0, Number(((left > limit ? limit : left) * 10_000n) / limit) / 10_000),
  );
}

function MaxForm({
  agent,
  current,
  capRaw,
  onDone,
}: {
  agent: { id: string; name: string };
  current: string;
  /** The most the owner may set now (history.perCallMaxCapRaw); 0.10 USDC when unknown. */
  capRaw?: string;
  onDone: (saved: FeedPayAgent | null) => void;
}) {
  const id = useId();
  const [text, setText] = useState(usdcText(current) ?? '');
  const [problem, setProblem] = useState('');
  const [saving, setSaving] = useState(false);
  async function save(raw: string | null) {
    if (saving) return;
    setSaving(true);
    setProblem('');
    try {
      // The same save as the Feed's editor: the use sheet shows the new maximum at once.
      onDone(await savePerCallMax(agent.id, raw));
    } catch (error) {
      setProblem(maxProblemText(payFailure(error)));
      setSaving(false);
    }
  }
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const raw = perCallMaxRaw(text, capRaw);
    if (!raw) return setProblem(perCallMaxRange(capRaw));
    void save(raw);
  };
  return (
    <form
      className="w4-steps w4-maxform"
      aria-label={`Per-call maximum for ${agent.name}`}
      onSubmit={submit}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        onDone(null);
      }}
    >
      <label className="w4-field" htmlFor={`${id}-i`}>
        Per-call maximum, in USDC
        <input
          id={`${id}-i`}
          inputMode="decimal"
          autoComplete="off"
          // eslint-disable-next-line jsx-a11y/no-autofocus
          autoFocus
          value={text}
          aria-invalid={problem ? true : undefined}
          aria-describedby={`${id}-h`}
          onChange={(event) => setText(event.target.value)}
        />
        <small id={`${id}-h`}>{MAX_HELP}</small>
      </label>
      {problem ? (
        <p className="w4-error" role="alert">
          {problem}
        </p>
      ) : null}
      <div className="ap4-actions">
        <button type="submit" className="ap4-btn" aria-disabled={saving || undefined}>
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button type="button" className="ap4-btn ap4-ghost" onClick={() => void save(null)}>
          Use the default
        </button>
        <button type="button" className="ap4-btn ap4-ghost" onClick={() => onDone(null)}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function PotForm({
  agent,
  current,
  onDone,
}: {
  agent: { id: string; name: string };
  current: string;
  onDone: (saved: FeedPayAgent | null) => void;
}) {
  const id = useId();
  const [text, setText] = useState(usdcText(current) ?? '');
  const [problem, setProblem] = useState('');
  const [saving, setSaving] = useState(false);
  async function save(raw: string | null) {
    if (saving) return;
    setSaving(true);
    setProblem('');
    try {
      onDone(await saveFloatTarget(agent.id, raw));
    } catch (error) {
      setProblem(maxProblemText(payFailure(error)));
      setSaving(false);
    }
  }
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const raw = floatTargetRaw(text);
    if (!raw) return setProblem(POT_RANGE);
    void save(raw);
  };
  return (
    <form
      className="w4-steps w4-maxform"
      aria-label={`Pot target for ${agent.name}`}
      onSubmit={submit}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        onDone(null);
      }}
    >
      <label className="w4-field" htmlFor={`${id}-i`}>
        Pot target, in USDC
        <input
          id={`${id}-i`}
          inputMode="decimal"
          autoComplete="off"
          // eslint-disable-next-line jsx-a11y/no-autofocus
          autoFocus
          value={text}
          aria-invalid={problem ? true : undefined}
          aria-describedby={`${id}-h`}
          onChange={(event) => setText(event.target.value)}
        />
        <small id={`${id}-h`}>{POT_HELP}</small>
      </label>
      {problem ? (
        <p className="w4-error" role="alert">
          {problem}
        </p>
      ) : null}
      <div className="ap4-actions">
        <button type="submit" className="ap4-btn" aria-disabled={saving || undefined}>
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button type="button" className="ap4-btn ap4-ghost" onClick={() => void save(null)}>
          Use the default
        </button>
        <button type="button" className="ap4-btn ap4-ghost" onClick={() => onDone(null)}>
          Cancel
        </button>
      </div>
    </form>
  );
}

export function ServiceCalls({ agentId, name }: { agentId: string; name: string }) {
  const [history, setHistory] = useState<FeedPayHistory | null>(null);
  // Feed pay is on for the owner and this agent is one that pays: the maximum can change. The
  // same read the Feed uses (kept for a minute), not one of its own.
  const access = usePayAccess();
  const on = access.phase === 'on' && access.list.agents.some((agent) => agent.agentId === agentId);
  const [editing, setEditing] = useState(false);
  const [editingPot, setEditingPot] = useState(false);
  const [saved, setSaved] = useState('');
  const [now, setNow] = useState(() => Date.now());
  const change = useRef<HTMLButtonElement>(null);
  const refocus = useRef(false);
  const [show, setShow] = useState<Show>('all');
  const [open, setOpen] = useState<string | null>(null);
  const rowId = useId();

  useEffect(() => {
    if (editing || !refocus.current) return;
    refocus.current = false;
    change.current?.focus();
  }, [editing]);

  useEffect(() => {
    let stop = false;
    let timer = 0;
    const tick = async () => {
      window.clearTimeout(timer);
      if (stop || document.visibilityState === 'hidden') return;
      let again = false;
      try {
        const read = await getServiceCalls(agentId);
        if (stop) return;
        setHistory(read);
        setNow(Date.now());
        again = read !== null && pending(read);
      } catch {
        // What was shown stays; the next read tries again.
        again = true;
      }
      if (!stop && again) timer = window.setTimeout(() => void tick(), POLL_MS);
    };
    const shown = () => {
      if (document.visibilityState === 'visible') void tick();
    };
    document.addEventListener('visibilitychange', shown);
    void tick();
    return () => {
      stop = true;
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', shown);
    };
  }, [agentId]);

  if (!history) return null;
  const ready = history.readyForServices;
  const touched =
    history.calls.length > 0 || history.moves.length > 0 || (ready !== null && ready.raw !== '0');
  if (!on && !touched) return null;
  const all: Line[] = [
    ...history.calls.map((item) => ({
      kind: 'call' as const,
      key: `c-${item.callId}`,
      at: item.createdAt,
      item,
    })),
    ...history.moves.map((move) => ({
      kind: 'move' as const,
      key: `m-${move.moveId}`,
      at: move.createdAt,
      move,
    })),
  ].sort((a, b) => b.at - a.at);
  const lines = all.filter((line) => show === 'all' || line.kind === show).slice(0, SHOWN);
  const days: { label: string; lines: Line[] }[] = [];
  for (const line of lines) {
    const label = dayText(line.at, now);
    const last = days[days.length - 1];
    if (last && last.label === label) last.lines.push(line);
    else days.push({ label, lines: [line] });
  }
  const opened = open ? (all.find((line) => line.key === open) ?? null) : null;
  // What is left of its spending limit, in the Use sheet's words, with a bar of what is left.
  const payAgent =
    access.phase === 'on'
      ? access.list.agents.find((agent) => agent.agentId === agentId)
      : undefined;
  const leftText =
    payAgent && payAgent.limitLeftRaw !== null && payAgent.limitRaw !== null
      ? agentLines(payAgent).left
      : null;
  const left = leftText && payAgent ? leftShare(payAgent.limitLeftRaw!, payAgent.limitRaw!) : null;
  return (
    <>
      <p className="w4-section">Services</p>
      <div className="ap4-group w4-svc" role="group" aria-label={`Services: ${name}`}>
        <div className="w4-tiles">
          <div className="w4-tile" data-k="ready-for-services">
            <span className="w4-tile-k">Ready to spend</span>
            <span className="w4-tile-v">
              {ready ? (
                <>
                  {usdcText(ready.raw)} <small>USDC</small>
                </>
              ) : (
                'Not known now'
              )}
            </span>
            <span className="w4-tile-note">Unused USDC goes back to the wallet</span>
          </div>
          <div className="w4-tile" data-k="per-call-max">
            <span className="w4-tile-k">Most per call</span>
            <span className="w4-tile-row">
              <span className="w4-tile-v">
                {usdcText(history.perCallMax.raw)} <small>USDC</small>
              </span>
              {on && !editing ? (
                <button
                  type="button"
                  ref={change}
                  className="w4-copy"
                  aria-label={`Change the per-call maximum of ${name}`}
                  onClick={() => {
                    setSaved('');
                    setEditing(true);
                  }}
                >
                  Change
                </button>
              ) : null}
            </span>
            <span className="w4-tile-note">Default {DEFAULT_MAX} USDC</span>
          </div>
          {payAgent?.floatTargetRaw ? (
            <div className="w4-tile" data-k="pot-target">
              <span className="w4-tile-k">Pot target</span>
              <span className="w4-tile-row">
                <span className="w4-tile-v">
                  {usdcText(payAgent.floatTargetRaw)} <small>USDC</small>
                </span>
                {on && !editingPot ? (
                  <button
                    type="button"
                    className="w4-copy"
                    aria-label={`Change the pot target of ${name}`}
                    onClick={() => {
                      setSaved('');
                      setEditingPot(true);
                    }}
                  >
                    Change
                  </button>
                ) : null}
              </span>
              <span className="w4-tile-note">Loaded in one top-up</span>
            </div>
          ) : null}
        </div>
        {leftText ? (
          <div className="w4-meter" data-k="limit-left">
            <span className="w4-meter-row">
              <span>Limit left</span>
              <span>{leftText}</span>
            </span>
            {left !== null ? (
              <span className="w4-bar w4-meter-bar" aria-hidden="true">
                <i style={{ width: `${left * 100}%` }} />
              </span>
            ) : null}
          </div>
        ) : null}
      </div>
      {editingPot && payAgent?.floatTargetRaw ? (
        <PotForm
          agent={{ id: agentId, name }}
          current={payAgent.floatTargetRaw}
          onDone={(agent) => {
            setEditingPot(false);
            if (agent?.floatTargetRaw) setSaved(potSavedText(name, agent.floatTargetRaw));
          }}
        />
      ) : null}
      {editing ? (
        <MaxForm
          agent={{ id: agentId, name }}
          current={history.perCallMax.raw}
          capRaw={history.perCallMaxCapRaw}
          onDone={(agent) => {
            // Focus goes back to Change (it was gone while editing).
            refocus.current = true;
            setEditing(false);
            if (!agent) return;
            setHistory((current) =>
              current
                ? {
                    ...current,
                    perCallMax: {
                      raw: agent.perCallMaxRaw,
                      decimals: 6,
                      display: usdcText(agent.perCallMaxRaw) ?? agent.perCallMaxRaw,
                    },
                  }
                : current,
            );
            setSaved(maxSavedText(name, agent.perCallMaxRaw));
          }}
        />
      ) : null}
      {saved ? (
        <p className="w4-done" role="status">
          {saved}
        </p>
      ) : null}
      <div className="w4-section w4-acthead">
        <span>Activity</span>
        {all.length ? (
          <span className="w4-filter" role="group" aria-label="Show">
            {SHOWS.map((option) => (
              <button
                key={option.value}
                type="button"
                aria-pressed={show === option.value}
                onClick={() => setShow(option.value)}
              >
                {option.label}
              </button>
            ))}
          </span>
        ) : null}
      </div>
      {lines.length ? (
        <div className="ap4-group w4-acts" role="group" aria-label={`Service calls: ${name}`}>
          {days.map((day) => (
            <div key={day.label} className="w4-day">
              <p className="w4-day-k" aria-hidden="true">
                {day.label}
              </p>
              {day.lines.map((line) => (
                <Row
                  key={line.key}
                  line={line}
                  id={`${rowId}-${line.key}`}
                  now={now}
                  onOpen={() => setOpen(line.key)}
                />
              ))}
            </div>
          ))}
        </div>
      ) : (
        <p className="w4-hint">
          {!all.length
            ? 'No service calls yet.'
            : show === 'call'
              ? 'No payments yet.'
              : 'No transfers yet.'}
        </p>
      )}
      <p className="w4-hint">Amounts in USDC. Results are kept for {RESULT_KEEP_DAYS} days.</p>
      {opened ? (
        <Sheet
          line={opened}
          now={now}
          returnTo={`${rowId}-${opened.key}`}
          onClose={() => setOpen(null)}
        />
      ) : null}
    </>
  );
}
