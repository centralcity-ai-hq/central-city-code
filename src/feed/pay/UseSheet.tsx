import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import { CircleAlert, LoaderCircle, RefreshCw } from 'lucide-react';
import {
  feedPayCallDone,
  type FeedPayAgent,
  type FeedPayCall,
  type FeedPayCallRequest,
  type FeedPayInputs,
  type FeedPayNotPayableReason,
  type FeedPayQuote,
} from '../../../shared/feed-pay';
import type { FeedService } from '../../../shared/feed';
import { newIdempotencyKey } from '../feedApi';
import { workspaceClick } from '../feedNav';
import { avatarStyle } from '../../shell/avatarColor';
import { Avatar, CopyButton } from '../FeedParts';
import { initialsOf, plain } from '../feedFormat';
import { askFeedSignInAgain, SIGN_IN_LABEL } from '../feedSignIn';
import { callService, payFailure, quoteService } from '../payApi';
import { CallCard, MoneyLines } from './CallCard';
import {
  answeredPayment,
  endGoneCall,
  getOpenPayment,
  getSheetDraft,
  keepSheetDraft,
  setOpenPayment,
  updateOpenCall,
  useOpenPayment,
  type OpenPayment,
} from './openPayments';
import {
  agentLines,
  agentOrder,
  AGENTS_MORE,
  ASKING_AGAIN,
  buildInputs,
  confirmText,
  draftFromExample,
  EMPTY_INPUT_DRAFT,
  firstChoice,
  inputForm,
  LOST_ANSWER,
  lostAnswer,
  maxFits,
  maxProblemText,
  maxSavedText,
  notPayableBody,
  notPayableView,
  perCallMaxRange,
  payButtonText,
  payeeLine,
  perCallMaxRaw,
  priceLine,
  priceRoseText,
  quoteCheck,
  quoteFeeRaw,
  quoteLines,
  quoteTotalRaw,
  recheckNote,
  recheckWhy,
  refusalText,
  serverProblems,
  stillLostText,
  usdcText,
  vsListingText,
  type AgentFix,
  type FormProblem,
  type RecheckWhy,
  type InputControl,
  type InputDraft,
} from './payModel';
import { loadPayAccess, savePerCallMax, type PayAccess } from './usePayAccess';

/*
 * "Use with my agent" (docs/FEED_PAY.md section 15), the drawer's step after the details: the
 * agent that pays (a row of cards), the inputs as a form from the listing (the example is a hint
 * and a placeholder, sent only once accepted with Fill with example), the live price (one unpaid
 * request; with Central City's fee on top, the price, the fee and the total; fee included, the price and Central City's part of it),
 * one confirm that names the amount, the agent and the
 * payee, then the call card until it is done. Every confirm click has its own idempotency key,
 * kept for a double click and for a lost answer, so a payment is never sent twice. From the click on Pay until the call is done or the server said for sure that
 * nothing started, the payment is kept outside the sheet (openPayments.ts): leaving the sheet and
 * coming back shows that same payment with the same key, never a new one. Every refusal says that
 * nothing was paid; a lost answer says it can't tell yet.
 */

/** Links to the agent in My agents, or one of its wallet screens (MyAgentsV2 reads #agent=<id>:<screen>). */
export const agentScreenHref = (
  agentId: string,
  screen: 'wallet' | 'wallet-limits' | 'wallet-add' | null = null,
) => `/agents#agent=${encodeURIComponent(agentId)}${screen ? `:${screen}` : ''}`;

const FIX_SCREEN: Record<AgentFix, 'wallet-limits' | 'wallet-add' | null> = {
  limit: 'wallet-limits',
  funds: 'wallet-add',
  agent: null,
};

/** A link that leaves the sheet for one of the agent's screens; the sheet reopens on Back. */
function FixLink({
  agentId,
  fix,
  label,
  onLeave,
}: {
  agentId: string;
  fix: AgentFix;
  label: string;
  onLeave: () => void;
}) {
  const href = agentScreenHref(agentId, FIX_SCREEN[fix]);
  const go = workspaceClick(href);
  return (
    <a
      className="fd-link"
      href={href}
      onClick={(event) => {
        onLeave();
        go(event);
      }}
    >
      {label}
    </a>
  );
}

type Quote =
  | { k: 'idle' }
  | { k: 'checking'; note?: string }
  | { k: 'quoted'; quote: FeedPayQuote; inputs: FeedPayInputs; note?: string }
  | { k: 'not_payable'; reason: FeedPayNotPayableReason }
  | { k: 'error'; text: string };

const EXAMPLE_SHOWN = 160;
const short = (text: string) =>
  text.length > EXAMPLE_SHOWN ? `${text.slice(0, EXAMPLE_SHOWN - 1).trimEnd()}…` : text;

function Control({
  control,
  id,
  value,
  problem,
  locked,
  onChange,
}: {
  control: InputControl;
  id: string;
  value: string;
  problem: string | null;
  locked: boolean;
  onChange: (value: string) => void;
}) {
  const hint = `${id}-h`;
  const err = `${id}-e`;
  const described = [control.description || control.example ? hint : '', problem ? err : '']
    .filter(Boolean)
    .join(' ');
  const common = {
    id,
    className: 'fd-input',
    value,
    readOnly: locked,
    'aria-invalid': problem ? true : undefined,
    'aria-required': control.required || undefined,
    'aria-describedby': described || undefined,
  } as const;
  // The listing's example as a placeholder only: nothing is sent until Fill with example.
  const placeholder = control.example ? short(control.example) : undefined;
  return (
    <div className="fd-fl fp-field" data-key={control.key}>
      {/* The name on the left, Required or Optional on the right. */}
      <label htmlFor={id}>
        <code>{control.name}</code>
        <span className="fp-req" data-req={control.required ? 'true' : undefined}>
          {control.required ? 'Required' : 'Optional'}
        </span>
      </label>
      {control.kind === 'boolean' ? (
        <select {...common} disabled={locked} onChange={(event) => onChange(event.target.value)}>
          <option value="">Not set</option>
          <option value="true">true</option>
          <option value="false">false</option>
        </select>
      ) : control.kind === 'json' && control.in === 'body' ? (
        <textarea
          {...common}
          className="fd-input fp-json"
          placeholder={placeholder}
          spellCheck={false}
          rows={3}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : (
        <input
          {...common}
          placeholder={placeholder}
          type="text"
          inputMode={
            control.kind === 'integer'
              ? 'numeric'
              : control.kind === 'number'
                ? 'decimal'
                : undefined
          }
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
      {control.description || control.example ? (
        <p className="fd-hint" id={hint}>
          {control.description}
          {control.description && control.example ? ' · ' : ''}
          {control.example ? `Example: ${short(control.example)}` : ''}
        </p>
      ) : null}
      {problem ? (
        <p className="fd-err" id={err}>
          <CircleAlert size={14} aria-hidden="true" />
          <span>{problem}</span>
        </p>
      ) : null}
    </div>
  );
}

function AgentCard({
  agent,
  name,
  checked,
  locked,
  whyId,
  onPick,
}: {
  agent: FeedPayAgent;
  name: string;
  checked: boolean;
  locked: boolean;
  /** The id of its why-line under the row (an agent that can't pay). */
  whyId: string;
  onPick: () => void;
}) {
  const id = useId();
  const lines = agentLines(agent);
  const blocked = lines.blocked;
  const sub = blocked ? 'Can’t pay yet' : lines.usdc;
  // A compact card in a row: the avatar, the name and one muted line on one line (its USDC, or
  // "Can’t pay yet"; the reason in its title). The radio stays (arrow keys move the pick);
  // its full lines stay for screen readers, and the why-line with its fix link sits under the row.
  return (
    <li
      className="fp-agent"
      data-blocked={blocked ? 'true' : undefined}
      data-checked={checked || undefined}
    >
      <label className="fp-a-pick">
        <input
          type="radio"
          name={name}
          value={agent.agentId}
          checked={checked}
          disabled={Boolean(blocked) || (locked && !checked)}
          aria-labelledby={`${id}-n`}
          aria-describedby={blocked ? `${id}-l ${whyId}` : `${id}-l`}
          onChange={onPick}
        />
        <Avatar className="fp-a-av" style={avatarStyle(agent.agentId)}>
          {initialsOf(agent.name)}
        </Avatar>
        <span className="fp-a-text" title={blocked ? blocked.text : sub}>
          <b id={`${id}-n`}>{plain(agent.name)}</b>
          <span className="fp-a-sub" aria-hidden="true">
            {sub}
          </span>
          <span className="fp-a-lines fp-vh" id={`${id}-l`}>
            <span>{lines.usdc}</span>
            {lines.left ? <span>{lines.left}</span> : null}
            <span>{lines.ready}</span>
            <span>{lines.max}</span>
          </span>
        </span>
      </label>
    </li>
  );
}

/**
 * Under the agent row: why each agent that can't pay can't, once, with the link that fixes it
 * (agents that can't pay can't be picked, so their lines are said here and not in the cards).
 */
function BlockedLines({
  agents,
  whyId,
  onLeave,
}: {
  agents: FeedPayAgent[];
  whyId: (agentId: string) => string;
  onLeave: () => void;
}) {
  const blocked = agents.flatMap((agent) => {
    const why = agentLines(agent).blocked;
    return why ? [{ agent, why }] : [];
  });
  if (!blocked.length) return null;
  return (
    <ul className="fp-whys">
      {blocked.map(({ agent, why }) => (
        <li key={agent.agentId} className="fp-why" id={whyId(agent.agentId)}>
          <span>{why.text}</span>
          {why.action && why.label ? (
            <FixLink agentId={agent.agentId} fix={why.action} label={why.label} onLeave={onLeave} />
          ) : null}
        </li>
      ))}
    </ul>
  );
}

const RAW_UNITS = /^\d{1,30}$/;

/**
 * Under the price: what the picked agent may still spend, as a thin bar and one fine line, in the
 * words and numbers of its card (agentLines). Display only: the bar's width is the left amount
 * over the limit, the same two numbers the line shows; nothing here decides a payment.
 */
function Allowance({ agent }: { agent: FeedPayAgent }) {
  const lines = agentLines(agent);
  if (!lines.left) return null;
  const name = plain(agent.name) || 'This agent';
  const known = agent.limitLeftRaw !== null;
  const share =
    known &&
    agent.limitRaw !== null &&
    RAW_UNITS.test(agent.limitLeftRaw!) &&
    RAW_UNITS.test(agent.limitRaw) &&
    Number(agent.limitRaw) > 0
      ? Math.min(1, Math.max(0, Number(agent.limitLeftRaw) / Number(agent.limitRaw)))
      : null;
  return (
    <div className="fp-allow">
      {share !== null ? (
        <div className="fp-bar" role="img" aria-label={lines.left}>
          <i style={{ width: `${(share * 100).toFixed(1)}%` }} />
        </div>
      ) : null}
      <p className="fd-fine fp-allow-line">
        {known ? `${name} has ${lines.left}` : lines.left} · most per call{' '}
        {usdcText(agent.perCallMaxRaw)}
      </p>
    </div>
  );
}

/** The per-call maximum of one agent, changed in place (PUT /api/feed/pay/agents/:id). */
export function MaxEditor({
  agent,
  onDone,
}: {
  agent: FeedPayAgent;
  /** Saved (the agent as the server now has it) or cancelled (null). */
  onDone: (saved: FeedPayAgent | null) => void;
}) {
  const id = useId();
  const [text, setText] = useState(usdcText(agent.perCallMaxRaw) ?? '');
  const [problem, setProblem] = useState('');
  const [saving, setSaving] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.focus({ preventScroll: true });
    // On a phone the editor opens low in the sheet: Save comes into view with it.
    root.current?.scrollIntoView?.({ block: 'nearest' });
  }, []);
  async function save(raw: string | null) {
    if (saving) return;
    setSaving(true);
    setProblem('');
    try {
      onDone(await savePerCallMax(agent.agentId, raw));
    } catch (error) {
      setProblem(maxProblemText(payFailure(error)));
      setSaving(false);
    }
  }
  // Not a form of its own: it sits inside the use sheet's form (forms can't nest).
  const submit = () => {
    const raw = perCallMaxRaw(text, agent.perCallMaxCapRaw);
    if (!raw) return setProblem(perCallMaxRange(agent.perCallMaxCapRaw));
    void save(raw);
  };
  return (
    <div
      className="fp-max"
      role="group"
      ref={root}
      aria-labelledby={`${id}-t`}
      onKeyDown={(event) => {
        if (event.key === 'Enter' && event.target === input.current) {
          event.preventDefault();
          submit();
        }
        if (event.key !== 'Escape') return;
        event.preventDefault();
        onDone(null);
      }}
    >
      <p id={`${id}-t`} className="fp-max-t">
        Per-call maximum for {plain(agent.name)}
      </p>
      <div className="fd-suffix">
        <input
          ref={input}
          id={`${id}-i`}
          className="fd-input"
          inputMode="decimal"
          autoComplete="off"
          aria-label={`Per-call maximum for ${plain(agent.name)}, in USDC`}
          aria-invalid={problem ? true : undefined}
          aria-describedby={problem ? `${id}-e` : `${id}-h`}
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
        <span>USDC</span>
      </div>
      {problem ? (
        <p className="fd-err" id={`${id}-e`} role="alert">
          <CircleAlert size={14} aria-hidden="true" />
          <span>{problem}</span>
        </p>
      ) : (
        <p className="fd-hint" id={`${id}-h`}>
          The most {plain(agent.name)} pays for one service call. Default 0.10 USDC.
        </p>
      )}
      <div className="fp-row">
        <button
          type="button"
          className="fd-btn primary"
          aria-disabled={saving || undefined}
          onClick={submit}
        >
          {saving ? <LoaderCircle className="spin" size={14} aria-hidden="true" /> : null}
          Save
        </button>
        {agent.perCallMaxIsDefault ? null : (
          <button type="button" className="fd-btn" onClick={() => void save(null)}>
            Use the default
          </button>
        )}
        <button type="button" className="fd-btn ghost" onClick={() => onDone(null)}>
          Cancel
        </button>
      </div>
    </div>
  );
}

export function UseSheet({
  service,
  access,
  onBack,
  onClose,
}: {
  service: FeedService;
  access: Extract<PayAccess, { phase: 'on' }>;
  onBack: () => void;
  onClose?: () => void;
}) {
  const ids = useId();
  const form = useMemo(() => inputForm(service), [service]);
  const agents = useMemo(() => agentOrder(access.list.agents), [access.list.agents]);
  const open = useOpenPayment(service.id);
  // What the sheet opens with: a payment that may have started, as it was confirmed; else the
  // inputs and agent it had (openPayments.ts).
  const [start] = useState(() => ({
    open: getOpenPayment(service.id),
    kept: getSheetDraft(service.id),
  }));
  const [draft, setDraft] = useState<InputDraft>(() => start.kept?.draft ?? EMPTY_INPUT_DRAFT);
  const [problems, setProblems] = useState<FormProblem[]>([]);
  const [agentId, setAgentId] = useState<string | null>(
    () =>
      start.open?.body.agentId ??
      (start.kept?.agentId && agents.some((item) => item.agentId === start.kept!.agentId)
        ? start.kept.agentId
        : firstChoice(agents)),
  );
  const [quote, setQuote] = useState<Quote>(() =>
    start.open && start.open.phase !== 'refused'
      ? { k: 'quoted', quote: start.open.quote, inputs: start.open.body.inputs }
      : { k: 'idle' },
  );
  const [confirming, setConfirming] = useState(
    () => Boolean(start.open) && start.open?.phase !== 'refused',
  );
  const [callProblem, setCallProblem] = useState(() => start.kept?.problem ?? '');
  /** The session lapsed (a 401): the footer offers sign-in. */
  const [signIn, setSignIn] = useState(false);
  const [call, setCall] = useState<FeedPayCall | null>(() =>
    start.open?.phase === 'call' ? start.open.call : null,
  );
  const [editingMax, setEditingMax] = useState(false);
  const [maxSaved, setMaxSaved] = useState('');
  /** The call can't be read any more (call_not_found): the sheet treats it as finished. */
  const [gone, setGone] = useState(false);
  const keys = useRef(new Map<string, string>());
  /** This copy of the sheet sent a payment (its own answers set the quote and the confirm). */
  const sentHere = useRef(false);
  const callRef = useRef(call);
  callRef.current = call;
  const checking = useRef(false);
  const mounted = useRef(true);
  const heading = useRef<HTMLHeadingElement>(null);
  const summary = useRef<HTMLDivElement>(null);
  const confirmLine = useRef<HTMLParagraphElement>(null);
  const quoteBox = useRef<HTMLDivElement>(null);
  const checkButton = useRef<HTMLButtonElement>(null);
  const changeMax = useRef<HTMLButtonElement>(null);

  const sending = open?.phase === 'sending';
  const lost = open?.phase === 'lost' ? open : null;
  const agent = agents.find((item) => item.agentId === agentId) ?? null;
  const quoted = quote.k === 'quoted' ? quote : null;
  const check = quoted && agent ? quoteCheck(quoted.quote, agent) : null;
  const canConfirm = Boolean(quoted && agent && check?.kind === 'ok');
  const lines = quoted ? quoteLines(quoted.quote) : null;
  const locked = sending || quote.k === 'checking' || Boolean(lost);

  useEffect(() => {
    mounted.current = true;
    // Balances change: the agents are read again when the sheet opens.
    void loadPayAccess(true);
    heading.current?.focus();
    keepSheetDraft(service.id, { reopen: false, problem: '' });
    return () => {
      mounted.current = false;
    };
  }, [service.id]);
  // The inputs and the agent stay for the next time this service's sheet opens.
  useEffect(() => keepSheetDraft(service.id, { draft, agentId }), [service.id, draft, agentId]);
  // The agents' first read came after the sheet opened: the only one that can pay is picked.
  useEffect(() => {
    if (agentId === null) setAgentId(firstChoice(agents));
  }, [agents, agentId]);
  // The open payment moved on while another copy of this sheet sent it (it was closed and
  // opened again): its call, or the refusal that came late.
  const lastOpen = useRef(open);
  useEffect(() => {
    const was = lastOpen.current;
    lastOpen.current = open;
    if (open?.phase === 'call' && open.call) {
      const next = open.call;
      setCall((current) => (current?.callId === next.callId ? current : next));
      // Done while no sheet showed it: it is shown here now, so the payment is no longer open.
      if (feedPayCallDone(next) || next.done) setOpenPayment(service.id, null);
    }
    // Ended while another copy sent it, with no call here: its confirm is never shown again.
    if (!open && was && was.phase !== 'refused' && !sentHere.current && !callRef.current) {
      setConfirming(false);
      setQuote({ k: 'idle' });
    }
    if (open?.phase === 'refused') {
      setOpenPayment(service.id, null);
      setConfirming(false);
      setQuote({ k: 'idle' });
      setCallProblem(open.problem);
    }
  }, [open, service.id]);
  // A new answer about the price: it scrolls into view, and focus goes to the confirm when there
  // is one (it names what is paid), else to the answer itself.
  const answerKey = quote.k === 'quoted' ? quote.quote.quoteId : quote.k;
  useEffect(() => {
    if (quote.k === 'idle' || quote.k === 'checking') return;
    quoteBox.current?.scrollIntoView?.({ block: 'nearest' });
    if (confirming && canConfirm) confirmLine.current?.focus({ preventScroll: true });
    else if (!editingMax) quoteBox.current?.focus({ preventScroll: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [answerKey, confirming, canConfirm]);

  const keyFor = (quoteId: string, agent: string) => {
    const at = `${quoteId}|${agent}`;
    let key = keys.current.get(at);
    if (!key) {
      key = newIdempotencyKey();
      keys.current.set(at, key);
    }
    return key;
  };

  /** Any change to the inputs drops the price: a quote is for exactly the inputs it was made for. */
  const edit = (next: InputDraft) => {
    setDraft(next);
    setProblems((list) => list.filter((problem) => problem.key === 'agent'));
    if (quote.k !== 'idle' && quote.k !== 'checking') setQuote({ k: 'idle' });
    setConfirming(false);
    setCallProblem('');
    setMaxSaved('');
  };

  /** A link to the agent's wallet: the sheet opens again as it is when the person comes back. */
  const leave = () => keepSheetDraft(service.id, { draft, agentId, reopen: true });

  /** The id of an agent's why-line under the row (its radio is described by it). */
  const whyId = (agentId: string) => `${ids}-w-${agents.findIndex((a) => a.agentId === agentId)}`;

  const problemOf = (key: string) => problems.find((problem) => problem.key === key)?.text ?? null;

  /**
   * One unpaid request for the live price. `before` is the price confirmed before (an expired
   * or mismatched price check, checked again by itself): the note says when it changed.
   */
  async function checkPrice(recheck?: {
    why: RecheckWhy;
    beforeRaw: string | null;
    beforeFeeRaw: string | null;
  }) {
    if (checking.current || getOpenPayment(service.id)) return;
    const built = buildInputs(form, draft);
    const found = [...built.problems];
    if (!agentId) found.push({ key: 'agent', text: 'Pick the agent that pays.' });
    setProblems(found);
    setCallProblem('');
    setSignIn(false);
    setConfirming(false);
    setMaxSaved('');
    if (found.length) {
      setQuote({ k: 'idle' });
      window.setTimeout(() => summary.current?.focus(), 0);
      return;
    }
    checking.current = true;
    setQuote({
      k: 'checking',
      ...(recheck ? { note: recheckWhy(recheck.why) } : {}),
    });
    try {
      const answer = await quoteService(service.id, built.inputs);
      if (!answer.payable) setQuote({ k: 'not_payable', reason: answer.reason });
      else {
        setQuote({
          k: 'quoted',
          quote: answer,
          inputs: built.inputs,
          ...(recheck
            ? {
                note: recheckNote(recheck.why, recheck.beforeRaw, answer.amount.raw, {
                  beforeRaw: recheck.beforeFeeRaw,
                  nowRaw: quoteFeeRaw(answer),
                  included: answer.feeIncluded === true,
                }),
              }
            : {}),
        });
        setConfirming(true);
      }
    } catch (error) {
      const failure = payFailure(error);
      if (failure.code === 'invalid_inputs' && failure.detail.fields?.length) {
        setProblems(serverProblems(form, failure.detail.fields));
        setQuote({ k: 'idle' });
        window.setTimeout(() => summary.current?.focus(), 0);
      } else if (failure.code === 'not_payable' && failure.detail.reason)
        setQuote({ k: 'not_payable', reason: failure.detail.reason });
      else {
        setQuote({
          k: 'error',
          text: refusalText(failure, { agentName: agent?.name, period: agent?.limitPeriod }),
        });
        if (failure.code === 'signed_out') setSignIn(true);
        // Signed out, or paying switched off: the drawer behind the sheet follows.
        if (failure.code === 'signed_out' || failure.code === 'not_found') void loadPayAccess(true);
      }
    } finally {
      checking.current = false;
    }
  }

  /**
   * Sends a confirmed payment, or the same one again after a lost answer (the same request and
   * key: the server answers the same call). One at a time per service, across copies of the sheet.
   */
  async function send(body: FeedPayCallRequest, confirmed: FeedPayQuote, agentName: string) {
    const before = getOpenPayment(service.id);
    if (before && before.phase !== 'lost') return;
    const askingAgain = before?.phase === 'lost';
    sentHere.current = true;
    const period = agents.find((item) => item.agentId === body.agentId)?.limitPeriod ?? null;
    const entry: OpenPayment = {
      phase: 'sending',
      body,
      quote: confirmed,
      agentName,
      call: null,
      stillLost: before?.stillLost ?? null,
      asking: askingAgain,
      problem: '',
    };
    setOpenPayment(service.id, entry);
    setCallProblem('');
    setSignIn(false);
    let failure;
    try {
      const answer = await callService(service.id, body);
      setOpenPayment(service.id, answeredPayment(entry, answer, mounted.current));
      if (!mounted.current) return;
      setConfirming(false);
      setCall(answer);
      return;
    } catch (error) {
      failure = payFailure(error);
    }
    if (lostAnswer(failure, askingAgain)) {
      // It may have started: the same request and key ask again and answer the same call.
      setOpenPayment(service.id, {
        ...entry,
        phase: 'lost',
        stillLost: askingAgain ? failure.code : null,
      });
      return;
    }
    // The server said for sure that nothing started: the payment is no longer open.
    const text = refusalText(failure, { agentName, period });
    if (!mounted.current) {
      setOpenPayment(service.id, { ...entry, phase: 'refused', problem: text });
      return;
    }
    setOpenPayment(service.id, null);
    if (failure.code === 'price_above_max' && failure.detail.quote) {
      const fresh = failure.detail.quote;
      setQuote({
        k: 'quoted',
        quote: fresh,
        inputs: body.inputs,
        note: priceRoseText(confirmed.amount.raw, fresh.amount.raw),
      });
      setConfirming(true);
      return;
    }
    if (failure.code === 'quote_expired' || failure.code === 'quote_mismatch') {
      void checkPrice({
        why: failure.code === 'quote_expired' ? 'expired' : 'mismatch',
        beforeRaw: confirmed.amount.raw,
        beforeFeeRaw: quoteFeeRaw(confirmed),
      });
      return;
    }
    if (failure.code === 'invalid_inputs' && failure.detail.fields?.length) {
      setProblems(serverProblems(form, failure.detail.fields));
      setQuote({ k: 'idle' });
      setConfirming(false);
      window.setTimeout(() => summary.current?.focus(), 0);
      return;
    }
    setConfirming(false);
    setCallProblem(text);
    if (failure.code === 'signed_out') setSignIn(true);
    // Balances, limits, the session or the switch may be what changed.
    void loadPayAccess(true);
  }

  function pay() {
    if (!quoted || !agent || !canConfirm) return;
    void send(
      {
        agentId: agent.agentId,
        inputs: quoted.inputs,
        quoteId: quoted.quote.quoteId,
        maxAmountRaw: quoted.quote.amount.raw,
        // The total confirmed, fee included: a fee that applies only since this quote is refused.
        maxTotalRaw: quoteTotalRaw(quoted.quote),
        idempotencyKey: keyFor(quoted.quote.quoteId, agent.agentId),
      },
      quoted.quote,
      agent.name,
    );
  }

  function cancelConfirm() {
    setConfirming(false);
    setQuote({ k: 'idle' });
    window.setTimeout(() => checkButton.current?.focus(), 0);
  }

  function again() {
    setCall(null);
    setGone(false);
    setQuote({ k: 'idle' });
    setConfirming(false);
    void loadPayAccess(true);
    window.setTimeout(() => heading.current?.focus(), 0);
  }

  function maxDone(saved: FeedPayAgent | null) {
    setEditingMax(false);
    setConfirming(true);
    if (saved) setMaxSaved(maxSavedText(saved.name, saved.perCallMaxRaw));
    // Cancelled, or still below the price: focus goes back to Change maximum (when the price
    // fits now, the confirm takes it).
    const fits = saved && quoted && maxFits(quoted.quote, saved.perCallMaxRaw);
    if (!fits) window.setTimeout(() => changeMax.current?.focus(), 0);
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    // A confirm open is cancelled first; Escape again closes the drawer.
    if (confirming && !sending && !lost) {
      event.preventDefault();
      cancelConfirm();
    }
  };

  // Enter in a field checks the price; it never pays. Only the Pay button pays. A price the agent
  // can't pay (above its maximum or its limit) has no confirm: Check price again asks again.
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if ((confirming && canConfirm) || sending || lost || quote.k === 'checking' || editingMax)
      return;
    void checkPrice();
  };

  const callDone = call ? gone || feedPayCallDone(call) || call.done : false;
  const agentProblem = problemOf('agent');
  const listed = problems.filter((problem) => problem.key !== 'agent' || agentProblem);
  const noAgents = agents.length === 0 && !access.loading;
  const unpayable = quote.k === 'not_payable' ? notPayableView(quote.reason) : null;
  const signInButton = (
    <button
      type="button"
      className="fd-btn primary fp-main"
      onClick={() => askFeedSignInAgain('use')}
    >
      {SIGN_IN_LABEL.use}
    </button>
  );

  if (call)
    return (
      <div className="fp-sheet-wrap" onKeyDown={onKeyDown}>
        <div className="fd-d-body fp-sheet">
          <CallCard
            call={call}
            onUpdate={(next) => {
              setCall(next);
              updateOpenCall(service.id, next);
            }}
            onGone={() => {
              setGone(true);
              endGoneCall(service.id, call.callId);
            }}
            heading="Your call"
            headingId={`${ids}-call`}
            focusOnMount
          />
        </div>
        <footer className="fd-d-foot">
          {callDone ? (
            <button type="button" className="fd-btn primary" onClick={again}>
              Use it again
            </button>
          ) : null}
          <button type="button" className="fd-btn" onClick={onBack}>
            Back to the service
          </button>
          <span className="fd-sp" />
          {onClose ? (
            <button type="button" className="fd-btn ghost" onClick={onClose}>
              Close
            </button>
          ) : null}
        </footer>
      </div>
    );

  return (
    <div className="fp-sheet-wrap" onKeyDown={onKeyDown}>
      <form className="fd-d-form" aria-labelledby={`${ids}-h`} onSubmit={submit} noValidate>
        <div className="fd-d-body fp-sheet">
          <div className="fp-head">
            <button type="button" className="fd-link fp-back" onClick={onBack}>
              Back to the service
            </button>
            <h3 id={`${ids}-h`} tabIndex={-1} ref={heading}>
              Use with my agent
            </h3>
            <p className="fd-fine">
              Your agent pays from its own wallet. You see what it pays, and to whom, before
              anything is paid.
            </p>
          </div>

          {listed.length ? (
            <div className="fd-errsum" tabIndex={-1} ref={summary} role="alert">
              <b>Check {listed.length === 1 ? 'this' : 'these'} first.</b>
              <ul>
                {listed.map((problem) => (
                  <li key={`${problem.key}:${problem.text}`}>{problem.text}</li>
                ))}
              </ul>
            </div>
          ) : null}

          <fieldset
            className="fd-sec fp-agents"
            aria-describedby={agentProblem ? `${ids}-ae` : undefined}
          >
            <legend>Agent that pays</legend>
            {agents.length ? (
              <ul className="fp-agent-list">
                {agents.map((item) => (
                  <AgentCard
                    key={item.agentId}
                    agent={item}
                    name={`${ids}-agent`}
                    checked={item.agentId === agentId}
                    locked={locked}
                    whyId={whyId(item.agentId)}
                    onPick={() => {
                      setAgentId(item.agentId);
                      setEditingMax(false);
                      setMaxSaved('');
                      setCallProblem('');
                      setProblems((list) => list.filter((problem) => problem.key !== 'agent'));
                      if (quoted) setConfirming(true);
                    }}
                  />
                ))}
              </ul>
            ) : access.loading ? (
              <p className="fd-fine">
                <LoaderCircle className="spin" size={14} aria-hidden="true" /> Loading your agents…
              </p>
            ) : (
              <p className="fp-none">
                <span className="fd-muted">You have no agent with a wallet on Base yet.</span>
                <a className="fd-link" href="/agents" onClick={workspaceClick('/agents')}>
                  Go to My agents
                </a>
              </p>
            )}
            <BlockedLines agents={agents} whyId={whyId} onLeave={leave} />
            {agents.length && access.list.more ? <p className="fd-fine">{AGENTS_MORE}</p> : null}
            {agentProblem ? (
              <p className="fd-err" id={`${ids}-ae`}>
                <CircleAlert size={14} aria-hidden="true" />
                <span>{agentProblem}</span>
              </p>
            ) : null}
          </fieldset>

          <section className="fd-sec fp-inputs" aria-labelledby={`${ids}-in`}>
            <div className="fp-sec-row">
              <h4 id={`${ids}-in`}>What to send</h4>
              {/* Gone while a payment is open: its inputs are the ones it was confirmed with. */}
              {form.example && !sending && !lost ? (
                <button
                  type="button"
                  className="fd-link fp-fill"
                  disabled={locked}
                  onClick={() => edit(draftFromExample(form))}
                >
                  Fill with example
                </button>
              ) : null}
            </div>
            {form.exampleText ? (
              <p className="fd-hint fp-example">
                Example: <code>{short(form.exampleText.replace(/\s+/g, ' '))}</code>
                {form.exampleShortened ? ' The listing shortened it, so it is a hint only.' : ''}
              </p>
            ) : null}
            {form.controls.length === 0 && !form.extra ? (
              <p className="fd-fine">
                The listing describes no inputs. The service address is called as listed.
              </p>
            ) : null}
            {form.controls.map((control, index) => (
              <Control
                key={control.key}
                control={control}
                id={`${ids}-f${index}`}
                value={draft.values[control.key] ?? ''}
                problem={problemOf(control.key)}
                locked={locked}
                onChange={(value) =>
                  edit({ ...draft, values: { ...draft.values, [control.key]: value } })
                }
              />
            ))}
            {form.extra ? (
              <div className="fd-fl fp-field">
                <label htmlFor={`${ids}-x`}>
                  More inputs <span className="fd-opt">(JSON, optional)</span>
                </label>
                <textarea
                  id={`${ids}-x`}
                  className="fd-input fp-json"
                  spellCheck={false}
                  rows={3}
                  readOnly={locked}
                  value={draft.extra}
                  aria-invalid={problemOf('extra') ? true : undefined}
                  aria-describedby={`${ids}-xh`}
                  onChange={(event) => edit({ ...draft, extra: event.target.value })}
                />
                <p className="fd-hint" id={`${ids}-xh`}>
                  {form.extra === 'body'
                    ? 'Fields the listing doesn’t name, sent in the request body.'
                    : 'Fields the listing doesn’t name, sent in the address.'}
                </p>
                {problemOf('extra') ? (
                  <p className="fd-err">
                    <CircleAlert size={14} aria-hidden="true" />
                    <span>{problemOf('extra')}</span>
                  </p>
                ) : null}
              </div>
            ) : null}
            {form.unsent.length ? (
              <p className="fd-fine">
                Not sent:{' '}
                {form.unsent
                  .map((field) => `${field.name} (${field.why.replace(/\.$/, '')})`)
                  .join(', ')}
                .
              </p>
            ) : null}
          </section>

          <section className="fp-price-sec" aria-labelledby={`${ids}-pr`}>
            <h4 id={`${ids}-pr`}>Price</h4>
            <div className="fp-quote" ref={quoteBox} tabIndex={-1} aria-live="polite">
              {quote.k === 'checking' ? (
                <p className="fp-state" data-tone="busy">
                  <LoaderCircle className="spin" size={16} aria-hidden="true" />
                  <span>{quote.note ? `${quote.note} ` : ''}Checking the price…</span>
                </p>
              ) : quote.k === 'not_payable' && unpayable ? (
                <div className="fp-box" data-tone={unpayable.tone}>
                  <b>{unpayable.title}</b>
                  <p>{notPayableBody(quote.reason)}</p>
                </div>
              ) : quote.k === 'error' ? (
                <div className="fp-box" data-tone="bad" role="alert">
                  <p>{quote.text}</p>
                </div>
              ) : quoted ? (
                <div
                  className="fp-box"
                  data-tone={
                    (check && check.kind !== 'ok') || vsListingText(quoted.quote) ? 'warn' : 'ok'
                  }
                >
                  {lines ? (
                    <MoneyLines lines={lines} label="What this call costs" />
                  ) : (
                    <p className="fp-price">
                      <span>Price now</span>
                      <b>{priceLine(quoted.quote)}</b>
                    </p>
                  )}
                  {agent ? <Allowance agent={agent} /> : null}
                  {check?.kind === 'ok' ? (
                    <p className="fp-ok">Price checked with the service just now</p>
                  ) : null}
                  {quoted.note ? <p className="fp-note">{quoted.note}</p> : null}
                  {vsListingText(quoted.quote) ? (
                    <p className="fp-note">{vsListingText(quoted.quote)}</p>
                  ) : null}
                  <p className="fd-fine">{payeeLine(quoted.quote)}</p>
                  {check && check.kind !== 'ok' ? (
                    <>
                      <p className="fp-note" data-tone="warn">
                        {check.text}
                      </p>
                      {check.kind === 'over_max' && agent && !editingMax ? (
                        <div className="fp-row">
                          <button
                            type="button"
                            className="fd-btn"
                            ref={changeMax}
                            onClick={() => {
                              setMaxSaved('');
                              setEditingMax(true);
                            }}
                          >
                            Change maximum
                          </button>
                        </div>
                      ) : check.kind === 'no_funds' && agent ? (
                        <div className="fp-row">
                          <FixLink
                            agentId={agent.agentId}
                            fix="funds"
                            label="Add funds"
                            onLeave={leave}
                          />
                        </div>
                      ) : null}
                    </>
                  ) : null}
                  {maxSaved ? (
                    <p className="fd-fine" role="status">
                      {maxSaved}
                    </p>
                  ) : null}
                  {!agent ? <p className="fd-fine">Pick the agent that pays to go on.</p> : null}
                </div>
              ) : null}
              {editingMax && agent ? <MaxEditor agent={agent} onDone={maxDone} /> : null}
            </div>
            {/* Before a price: what the picked agent may still spend (with a price, it sits under
                the price's lines). */}
            {!quoted && agent && !agentLines(agent).blocked ? <Allowance agent={agent} /> : null}
          </section>
        </div>

        <footer className="fd-d-foot fp-foot">
          {lost ? (
            <>
              <p className="fp-foot-line" role="alert">
                {lost.stillLost ? stillLostText(lost.stillLost, lost.agentName) : LOST_ANSWER}
              </p>
              {lost.stillLost === 'signed_out' ? (
                signInButton
              ) : (
                <button
                  type="button"
                  className="fd-btn primary fp-main"
                  onClick={() => void send(lost.body, lost.quote, lost.agentName)}
                >
                  <RefreshCw size={14} aria-hidden="true" />
                  Check again
                </button>
              )}
            </>
          ) : sending && open ? (
            <>
              <p className="fp-foot-line" id={`${ids}-c`}>
                {open.asking ? ASKING_AGAIN : confirmText(open.quote, open.agentName)}
              </p>
              <button type="button" className="fd-btn fp-main fp-ink" aria-disabled="true">
                <LoaderCircle className="spin" size={14} aria-hidden="true" />
                {open.asking ? 'Checking…' : 'Paying…'}
              </button>
            </>
          ) : confirming && canConfirm && quoted && agent ? (
            <>
              <p
                className="fp-foot-line fp-confirm"
                tabIndex={-1}
                ref={confirmLine}
                id={`${ids}-c`}
              >
                {confirmText(quoted.quote, agent.name)}
              </p>
              <button
                type="button"
                className="fd-btn fp-main fp-ink"
                onClick={pay}
                aria-describedby={`${ids}-c`}
              >
                {payButtonText(quoted.quote)}
              </button>
              <button type="button" className="fd-btn" onClick={cancelConfirm}>
                Cancel
              </button>
            </>
          ) : unpayable ? (
            <>
              {unpayable.copy ? (
                <CopyButton
                  text={service.url}
                  label="Copy service address"
                  kind="none"
                  className="fd-btn primary fp-main"
                />
              ) : null}
              {unpayable.checkAgain ? (
                <button key="again" type="submit" ref={checkButton} className="fd-btn">
                  Check price again
                </button>
              ) : null}
            </>
          ) : editingMax || noAgents ? null : (
            <>
              {callProblem ? (
                <p className="fp-foot-line" role="alert" data-tone="bad">
                  {callProblem}
                </p>
              ) : null}
              {signIn ? signInButton : null}
              {/* Keyed: React never turns the confirm's Cancel (same place) into this submit
                  button during Cancel's own click, which would check the price again. */}
              <button
                key="check"
                type="submit"
                ref={checkButton}
                className={signIn ? 'fd-btn' : 'fd-btn primary fp-main'}
                aria-disabled={quote.k === 'checking' || undefined}
              >
                {quote.k === 'checking' ? (
                  <LoaderCircle className="spin" size={14} aria-hidden="true" />
                ) : null}
                {quote.k === 'checking'
                  ? 'Checking the price…'
                  : quoted || callProblem
                    ? 'Check price again'
                    : 'Check price'}
              </button>
            </>
          )}
          <span className="fd-sp" />
          {onClose ? (
            <button type="button" className="fd-btn ghost" onClick={onClose}>
              Close
            </button>
          ) : null}
        </footer>
      </form>
    </div>
  );
}
