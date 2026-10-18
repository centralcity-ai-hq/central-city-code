import {
  FEED_PAY_ERROR_MESSAGES,
  FEED_PAY_LIMITS,
  FEED_PAY_NOT_PAYABLE_MESSAGES,
  FEED_PAY_TERMINAL_STATES,
  RESULT_KEEP_DAYS,
  RESULT_MAX_BYTES,
  feedPayListingCheck,
  type FeedPayAgent,
  type FeedPayCall,
  type FeedPayFloatMove,
  type FeedPayHistoryItem,
  type FeedPayInputProblem,
  type FeedPayInputs,
  type FeedPayJson,
  type FeedPayNotPayableReason,
  type FeedPayQuote,
  type FeedPayResult,
} from '../../../shared/feed-pay';
import { rawToUsdc, type FeedField, type FeedService } from '../../../shared/feed';
import type { LimitPeriod } from '../../../shared/base/spend-limits';
import { WALLET_EXPLORER } from '../../../shared/base/wallet-network';
import type { PayFailure } from '../payApi';
import { plain, utcText } from '../feedFormat';

/*
 * The words and rules of "Use with my agent" (docs/FEED_PAY.md section 15), kept pure so the unit
 * tests read them without a browser: the form built from the listing's inputs, the agent lines,
 * the quote checks, the confirm, the call's progress and result, and the wallet's History lines.
 * Every sentence a person reads is here or in shared/feed-pay.ts; none comes from a server or a
 * service. A service's own text (field names, descriptions, results) is shown as plain text only.
 */

// ---------------------------------------------------------------------------------------------
// Words

/** Apostrophes as the rest of the Feed writes them (’), for the contract's sentences. */
export const typo = (text: string) => text.replace(/'/g, '’');

/** USDC from base units, at least two decimals: "100000" is "0.10", "7000" is "0.007". */
export function usdcText(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined || !/^\d{1,30}$/.test(raw)) return null;
  const text = rawToUsdc(raw);
  const [whole, fraction = ''] = text.split('.');
  return `${whole}.${fraction.padEnd(2, '0')}`;
}

/** "0.02 USDC". */
export const usdcWords = (raw: string | null | undefined) => `${usdcText(raw) ?? '?'} USDC`;

export const periodWord = (period: LimitPeriod | null) => period ?? 'period';

/** "today", "this week", "this month" (a limit's period as the person says it). */
export const periodPhrase = (period: LimitPeriod | null) =>
  period === 'day' ? 'today' : `this ${periodWord(period)}`;

const berlinClock = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Berlin',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});
const berlinDay = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Berlin',
  day: 'numeric',
  month: 'short',
});

/**
 * "Spending limit starts at 00:00 (Berlin), 15 Oct." for a limit that starts later on Base (its
 * fixed periods count from 00:00 Berlin time, as the wallet's limit screen says); null without a
 * readable time.
 */
export function limitStartsText(startsAt: string | null | undefined): string | null {
  const ms = typeof startsAt === 'string' ? Date.parse(startsAt) : Number.NaN;
  if (!Number.isFinite(ms)) return null;
  return `Spending limit starts at ${berlinClock.format(ms)} (Berlin), ${berlinDay.format(ms)}.`;
}

/** The page's addition after every quote and call error: nothing was signed or sent. */
export const NOTHING_PAID = 'Nothing was paid.';
export const NO_MONEY_MOVED = 'No money moved.';

/** A sentence, then the money part once: a sentence that already says it gets nothing more. */
export function withMoney(sentence: string, money: string): string {
  return /nothing was paid|no money moved/i.test(sentence) ? sentence : `${sentence} ${money}`;
}

// ---------------------------------------------------------------------------------------------
// Who may use it, before anything is asked

/**
 * What the drawer shows for paying, from the listing alone: the button, the reason it needs its
 * own setup, or nothing (withdrawn).
 */
export function listingPayState(
  service: Pick<FeedService, 'url' | 'method' | 'scheme' | 'input' | 'status'>,
): { kind: 'payable' } | { kind: 'own_setup'; reason: FeedPayNotPayableReason } | { kind: 'none' } {
  if (service.status === 'withdrawn') return { kind: 'none' };
  const reason = feedPayListingCheck(service);
  return reason ? { kind: 'own_setup', reason } : { kind: 'payable' };
}

export const OWN_SETUP_TITLE = 'This one needs its own setup.';
export const PAYEE_STOP_TITLE = 'We stopped before paying.';
export const OWN_SERVICE_TITLE = 'Pick another agent.';

export const notPayableText = (reason: FeedPayNotPayableReason) =>
  typo(FEED_PAY_NOT_PAYABLE_MESSAGES[reason]);

/**
 * The words under a not-payable title. A payee stop says its title once (the server's sentence
 * ends with it), then that nothing was paid.
 */
export function notPayableBody(reason: FeedPayNotPayableReason): string {
  const text = notPayableText(reason);
  if (reason !== 'payee_mismatch') return text;
  const said = text.endsWith(PAYEE_STOP_TITLE)
    ? text.slice(0, -PAYEE_STOP_TITLE.length).trim()
    : text;
  return withMoney(said, NOTHING_PAID);
}

/** Reasons that may pass by themselves (the service is down or moved for a while). */
const PASSING: ReadonlySet<FeedPayNotPayableReason> = new Set([
  'no_payment_request',
  'unreadable_payment_request',
]);

/**
 * How a live quote that can't be paid is shown. A payee that isn't the listing's is a safety stop
 * (ops are alerted): said as one, and the address is not offered to pay it another way. A listing
 * paid to the picked agent's own wallet asks for another agent (no address: nothing to set up).
 * Any other reason needs the service's own setup: Copy service address first, and Check price
 * again where the reason may pass by itself.
 */
export function notPayableView(reason: FeedPayNotPayableReason): {
  title: string;
  tone: 'warn' | 'bad';
  copy: boolean;
  checkAgain: boolean;
} {
  if (reason === 'payee_mismatch')
    return { title: PAYEE_STOP_TITLE, tone: 'bad', copy: false, checkAgain: false };
  if (reason === 'own_service')
    return { title: OWN_SERVICE_TITLE, tone: 'warn', copy: false, checkAgain: false };
  return { title: OWN_SETUP_TITLE, tone: 'warn', copy: true, checkAgain: PASSING.has(reason) };
}

// ---------------------------------------------------------------------------------------------
// Inputs: a form from the listing's input summary

export type InputKind = 'text' | 'number' | 'integer' | 'boolean' | 'json';

export interface InputControl {
  /** `${in}:${name}`, unique in the form. */
  key: string;
  name: string;
  in: 'query' | 'body';
  kind: InputKind;
  required: boolean;
  /** Provider text, plain; '' when absent. */
  description: string;
  /** The listing's example value for this field, as text (a hint only); null when none. */
  example: string | null;
}

export interface InputForm {
  controls: InputControl[];
  /** Listed fields that are never sent: header and path inputs, a body on GET. */
  unsent: Array<{ name: string; why: string }>;
  /** A JSON box for inputs the listing has but doesn't name (more fields, or none described). */
  extra: 'query' | 'body' | null;
  /**
   * The listing's example, as one object "Use example" puts in the form: null when there is none,
   * it is not an object, or the listing shortened it (its values may end in "…").
   */
  example: Record<string, unknown> | null;
  /** The example as the listing gives it, for the hint line. */
  exampleText: string | null;
  /** The listing shortened the example to fit (shared/feed.ts FeedExampleState): a hint only. */
  exampleShortened: boolean;
}

/** The draft: each control's text by key, and the extra JSON box. */
export interface InputDraft {
  values: Record<string, string>;
  extra: string;
}

export const EMPTY_INPUT_DRAFT: InputDraft = { values: {}, extra: '' };

const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH']);

export const takesBody = (method: string | null) => Boolean(method && BODY_METHODS.has(method));

/**
 * The control for a listed type text ("string", "integer | null", "string | number"), as the
 * server checks it (server/feed/pay/inputs.ts fits): null is never typed in a form, so it is left
 * out; one type left is its own control; a union with string takes text (any text fits it).
 */
function kindOf(type: string): InputKind {
  const parts = type
    .toLowerCase()
    .split('|')
    .map((part) => part.trim())
    .filter((part) => part && part !== 'null');
  if (parts.length === 1) {
    const base = parts[0];
    if (base === 'string') return 'text';
    if (base === 'number') return 'number';
    if (base === 'integer') return 'integer';
    if (base === 'boolean') return 'boolean';
    return 'json';
  }
  return parts.includes('string') ? 'text' : 'json';
}

function parseExample(text: string | null): Record<string, unknown> | null {
  if (!text) return null;
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** A value as the form's text: strings as they are, everything else as JSON. */
export function valueText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined) return '';
  return JSON.stringify(value, null, typeof value === 'object' && value !== null ? 2 : undefined);
}

export function inputForm(service: Pick<FeedService, 'method' | 'input'>): InputForm {
  const body = takesBody(service.method);
  const fields: FeedField[] = service.input?.fields ?? [];
  const example = parseExample(service.input?.example ?? null);
  const exampleShortened = service.input?.exampleState === 'shortened';
  const controls: InputControl[] = [];
  const unsent: InputForm['unsent'] = [];
  for (const field of fields) {
    const name = plain(field.name);
    if (!name) continue;
    if (field.in === 'header') {
      unsent.push({ name, why: 'Headers are never sent.' });
      continue;
    }
    if (field.in === 'path') {
      unsent.push({ name, why: 'The address is called as listed.' });
      continue;
    }
    // Where the listing doesn't say: the body for POST, PUT and PATCH, else the query.
    const place = field.in === 'body' || (field.in === null && body) ? 'body' : 'query';
    if (place === 'body' && !body) {
      unsent.push({ name, why: `A ${service.method ?? 'GET'} call carries no body.` });
      continue;
    }
    const key = `${place}:${name}`;
    if (controls.some((control) => control.key === key)) continue;
    const known = example && Object.prototype.hasOwnProperty.call(example, field.name);
    controls.push({
      key,
      name,
      in: place,
      kind: kindOf(field.type),
      required: field.required,
      description: plain(field.description),
      example: known ? valueText(example[field.name]) : null,
    });
  }
  // More inputs than the named ones, only where the server takes them: it refuses a name the
  // listing doesn't give once the listing names all its fields (server/feed/pay/inputs.ts).
  const more = (service.input?.more ?? 0) > 0;
  const unnamed =
    example !== null && Object.keys(example).some((key) => !controls.some((c) => c.name === key));
  const extra = more || (unnamed && fields.length === 0) ? (body ? 'body' : 'query') : null;
  return {
    controls,
    unsent,
    extra,
    example: exampleShortened ? null : example,
    exampleText: service.input?.example ? plain(service.input.example) : null,
    exampleShortened,
  };
}

/** "Use example": the listing's example in the form, with one click. Nothing else fills it. */
export function draftFromExample(form: InputForm): InputDraft {
  const values: Record<string, string> = {};
  const rest: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(form.example ?? {})) {
    const control = form.controls.find((item) => item.name === name);
    if (control) values[control.key] = valueText(value);
    else rest[name] = value;
  }
  return {
    values,
    extra: form.extra && Object.keys(rest).length ? JSON.stringify(rest, null, 2) : '',
  };
}

/** One problem the page found before asking anything (or the server's, mapped to a control). */
export interface FormProblem {
  /** The control's key, 'extra' for the JSON box, '' for the inputs as a whole. */
  key: string;
  text: string;
}

const KIND_WORDS: Record<InputKind, string> = {
  text: 'text',
  number: 'a number',
  integer: 'a whole number',
  boolean: 'true or false',
  json: 'valid JSON',
};

export function problemText(
  name: string,
  problem: FeedPayInputProblem['problem'],
  kind?: InputKind,
) {
  switch (problem) {
    case 'missing':
      return `Fill in ${name}.`;
    case 'wrong_type':
      return `${name} must be ${kind ? KIND_WORDS[kind] : 'of the type the service expects'}.`;
    case 'not_allowed':
      return `This service doesn’t take ${name}.`;
    case 'too_large':
      return `The inputs are too long. Keep them under ${Math.round(FEED_PAY_LIMITS.inputsMaxBytes / 1024)} KB.`;
  }
}

const NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][-+]?\d+)?$/;
const INTEGER = /^-?(?:0|[1-9]\d*)$/;

function typed(
  control: InputControl,
  text: string,
): { ok: true; value: FeedPayJson } | { ok: false } {
  switch (control.kind) {
    case 'text':
      return { ok: true, value: text };
    case 'number':
      return NUMBER.test(text) && Number.isFinite(Number(text))
        ? { ok: true, value: control.in === 'query' ? text : Number(text) }
        : { ok: false };
    case 'integer':
      return INTEGER.test(text) && Number.isSafeInteger(Number(text))
        ? { ok: true, value: control.in === 'query' ? text : Number(text) }
        : { ok: false };
    case 'boolean':
      return text === 'true' || text === 'false'
        ? { ok: true, value: control.in === 'query' ? text : text === 'true' }
        : { ok: false };
    case 'json':
      if (control.in === 'query') return { ok: true, value: text };
      try {
        return { ok: true, value: JSON.parse(text) as FeedPayJson };
      } catch {
        return { ok: false };
      }
  }
}

const utf8Bytes = (text: string) => new TextEncoder().encode(text).length;

/**
 * The inputs to send, exactly as typed or accepted (FeedPayInputs), or what is wrong first. A
 * field left empty is not sent; nothing the person didn't type or accept is ever added.
 */
export function buildInputs(
  form: InputForm,
  draft: InputDraft,
): { inputs: FeedPayInputs; problems: FormProblem[] } {
  const problems: FormProblem[] = [];
  const query: Record<string, string> = {};
  const body: Record<string, FeedPayJson> = {};
  let hasQuery = false;
  let hasBody = false;
  if (form.extra && draft.extra.trim()) {
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(draft.extra);
    } catch {
      parsed = undefined;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      problems.push({
        key: 'extra',
        text: 'More inputs must be a JSON object, like {"name": "value"}.',
      });
    else
      for (const [name, value] of Object.entries(parsed as Record<string, FeedPayJson>)) {
        if (form.extra === 'body') {
          body[name] = value;
          hasBody = true;
        } else if (
          typeof value === 'string' ||
          typeof value === 'number' ||
          typeof value === 'boolean'
        ) {
          query[name] = String(value);
          hasQuery = true;
        } else {
          problems.push({ key: 'extra', text: `${name} must be text in a query.` });
        }
      }
  }
  for (const control of form.controls) {
    const text = (draft.values[control.key] ?? '').trim();
    if (!text) {
      if (control.required)
        problems.push({ key: control.key, text: problemText(control.name, 'missing') });
      continue;
    }
    const value = typed(control, text);
    if (!value.ok) {
      problems.push({
        key: control.key,
        text: problemText(control.name, 'wrong_type', control.kind),
      });
      continue;
    }
    if (control.in === 'query') {
      query[control.name] = String(value.value);
      hasQuery = true;
    } else {
      body[control.name] = value.value;
      hasBody = true;
    }
  }
  const inputs: FeedPayInputs = {};
  if (hasQuery) inputs.query = query;
  if (hasBody) inputs.body = body;
  const names = Object.keys(query);
  if (
    names.length > FEED_PAY_LIMITS.queryParamsMax ||
    names.some(
      (name) =>
        name.length > FEED_PAY_LIMITS.queryNameMax ||
        query[name]!.length > FEED_PAY_LIMITS.queryValueMax,
    ) ||
    utf8Bytes(JSON.stringify(inputs)) > FEED_PAY_LIMITS.inputsMaxBytes
  )
    problems.push({ key: '', text: problemText('', 'too_large') });
  else if (nestedTooDeep({ inputs })) problems.push({ key: '', text: INPUTS_TOO_DEEP });
  return { inputs, problems };
}

/** Under the agent list when the server listed only some of the person's agents (list.more). */
export const AGENTS_MORE = `Only ${FEED_PAY_LIMITS.agentsMax} of your agents are shown, those ready to pay first.`;

export const INPUTS_TOO_DEEP = `The inputs are nested too deeply. Keep them under ${FEED_PAY_LIMITS.inputsMaxDepth} levels.`;

/**
 * The server refuses a request whose objects and arrays nest FEED_PAY_LIMITS.inputsMaxDepth levels
 * or more (the inputs sit one level under the request's own object, as here).
 */
export function nestedTooDeep(value: unknown, max: number = FEED_PAY_LIMITS.inputsMaxDepth) {
  const stack: Array<[unknown, number]> = [[value, 0]];
  while (stack.length) {
    const [item, depth] = stack.pop()!;
    if (typeof item !== 'object' || item === null) continue;
    if (depth >= max) return true;
    for (const child of Array.isArray(item) ? item : Object.values(item))
      if (typeof child === 'object' && child !== null) stack.push([child, depth + 1]);
  }
  return false;
}

/** The server's problems with the inputs, on the controls they belong to. */
export function serverProblems(form: InputForm, fields: FeedPayInputProblem[]): FormProblem[] {
  return fields.map((field) => {
    const control = form.controls.find(
      (item) => item.name === field.field && (field.in === null || item.in === field.in),
    );
    if (control)
      return { key: control.key, text: problemText(control.name, field.problem, control.kind) };
    if (!field.field) return { key: '', text: problemText('', field.problem) };
    const name = plain(field.field);
    return {
      key: form.extra ? 'extra' : '',
      text: problemText(name, field.problem),
    };
  });
}

// ---------------------------------------------------------------------------------------------
// The agent that pays

/** The screen a blocked agent's link opens: its spending limit, Add funds, or the agent. */
export type AgentFix = 'limit' | 'funds' | 'agent';

export interface AgentLines {
  usdc: string;
  left: string | null;
  ready: string;
  max: string;
  /**
   * Why it can't pay now, and the link that fixes it (its words in `label`); null when it can (as
   * far as known).
   */
  blocked: { text: string; action: AgentFix | null; label: string | null } | null;
  /** A balance couldn't be read: the person may still try (the call checks for real). */
  unknown: boolean;
}

export const BALANCE_UNKNOWN = 'Balance not available right now.';

/**
 * The limit left, with the limit itself when less of it is usable now: with the default model,
 * Base lets an agent spend half its limit per Base period, so "0.50 of 1.00 USDC left today"
 * shows both numbers instead of a limit that looks halved.
 */
function leftLine(agent: FeedPayAgent): string {
  const left = agent.limitLeftRaw!;
  const phrase = periodPhrase(agent.limitPeriod);
  if (
    agent.limitRaw !== null &&
    /^\d{1,30}$/.test(agent.limitRaw) &&
    big(left) < big(agent.limitRaw)
  )
    return `${usdcText(left)} of ${usdcText(agent.limitRaw)} USDC left ${phrase}`;
  return `${usdcWords(left)} left ${phrase}`;
}

export function agentLines(agent: FeedPayAgent): AgentLines {
  const name = plain(agent.name) || 'This agent';
  const blocked = ((): AgentLines['blocked'] => {
    switch (agent.notReady) {
      case 'paused':
        return { text: `${name} is paused.`, action: 'agent', label: `Open ${name}` };
      case 'wallet_not_usable':
        return {
          text: `${name}’s wallet can’t pay right now.`,
          action: 'agent',
          label: `Open ${name}`,
        };
      case 'no_limit':
        return {
          text: `${name} needs a spending limit first.`,
          action: 'limit',
          label: 'Set a spending limit',
        };
      case 'limit_not_started':
        return {
          text:
            limitStartsText(agent.limitStartsAt) ?? typo(FEED_PAY_ERROR_MESSAGES.limit_not_started),
          action: null,
          label: null,
        };
      case 'limit_used':
        return {
          text: `${name} has used its limit for ${periodPhrase(agent.limitPeriod)}.`,
          action: 'limit',
          label: 'Change the spending limit',
        };
      case 'no_funds':
        return { text: `${name} has no USDC yet.`, action: 'funds', label: 'Add funds' };
      default:
        return null;
    }
  })();
  // A limit that hasn't started has nothing left to show: the line above says when it starts.
  const notStarted = agent.notReady === 'limit_not_started';
  return {
    usdc: agent.usdcRaw === null ? BALANCE_UNKNOWN : `${usdcWords(agent.usdcRaw)}`,
    left: notStarted
      ? null
      : agent.limitLeftRaw === null
        ? agent.hasLimit
          ? 'Limit left: not known now'
          : 'No spending limit'
        : leftLine(agent),
    ready:
      agent.floatRaw === null
        ? 'Ready for services: not known now'
        : `Ready for services: ${usdcWords(agent.floatRaw)}`,
    max: `Per-call maximum: ${usdcWords(agent.perCallMaxRaw)}`,
    blocked,
    unknown:
      agent.usdcRaw === null ||
      agent.floatRaw === null ||
      (agent.limitLeftRaw === null && !notStarted),
  };
}

/** The agent picked first: the only one that can pay, else none (the person picks). */
export function firstChoice(agents: FeedPayAgent[]): string | null {
  const able = agents.filter((agent) => !agentLines(agent).blocked);
  return able.length === 1 ? able[0]!.agentId : null;
}

/** The picker's order: agents that can pay first, each group in the server's order. */
export function agentOrder(agents: FeedPayAgent[]): FeedPayAgent[] {
  const able = agents.filter((agent) => !agentLines(agent).blocked);
  return [...able, ...agents.filter((agent) => agentLines(agent).blocked)];
}

// ---------------------------------------------------------------------------------------------
// The quote and the confirm

function big(raw: string) {
  return BigInt(raw);
}

// ---------------------------------------------------------------------------------------------
// Central City's fee (docs/protocol/FEES.md): with protocol fees on, an external service costs its
// price plus Central City's 10% on top, and every cap holds for that total. A service sold by a
// Central City agent is fee included: the price is what the agent pays, 10% of it goes to Central
// City in the same transaction. Off, a quote has no fee and everything reads as before: one price.

/** The fee's name wherever its amount is shown. */
export const FEE_LABEL = 'Central City fee (10%)';
/** The fee's name for a service sold by a Central City agent: part of the price, not on top. */
export const FEE_INCLUDED_LABEL = 'Central City fee (10%, included)';
/** The price's name when the fee is part of it: the price is all the agent pays. */
export const PRICE_INCLUDED_LABEL = 'Price, fee included';

const RAW = /^\d{1,30}$/;

/** "$0.02": the quote's and the call's price lines. */
export const dollarText = (raw: string | null | undefined) => `$${usdcText(raw) ?? '?'}`;

/** Central City's fee of this quote in base units (on top, or part of the price); null while off. */
export function quoteFeeRaw(quote: Pick<FeedPayQuote, 'protocolFee'>): string | null {
  const raw = quote.protocolFee?.raw;
  return raw !== undefined && RAW.test(raw) ? raw : null;
}

/**
 * What the agent spends for this call: the price plus the fee on top; the price alone while fees
 * are off, or with the fee included.
 */
export function quoteTotalRaw(
  quote: Pick<FeedPayQuote, 'amount' | 'protocolFee' | 'total' | 'feeIncluded'>,
) {
  const total = quote.total?.raw;
  if (total !== undefined && RAW.test(total)) return total;
  const fee = quoteFeeRaw(quote);
  return fee === null || quote.feeIncluded
    ? quote.amount.raw
    : (big(quote.amount.raw) + big(fee)).toString(10);
}

export interface MoneyLine {
  key: 'price' | 'fee' | 'total';
  label: string;
  value: string;
}

/**
 * The quote's three lines, Price, Central City fee (10%) and Total; null while fees are off (the
 * sheet then shows the one price, as before). Fee included, two: the price, which is all the agent
 * pays, and Central City's part of it; no total, so nothing reads as price plus fee.
 */
export function quoteLines(quote: FeedPayQuote): MoneyLine[] | null {
  const fee = quoteFeeRaw(quote);
  if (fee === null) return null;
  if (quote.feeIncluded)
    return [
      { key: 'price', label: PRICE_INCLUDED_LABEL, value: dollarText(quote.amount.raw) },
      { key: 'fee', label: FEE_INCLUDED_LABEL, value: dollarText(fee) },
    ];
  return [
    { key: 'price', label: 'Price', value: dollarText(quote.amount.raw) },
    { key: 'fee', label: FEE_LABEL, value: dollarText(fee) },
    { key: 'total', label: 'Total', value: dollarText(quoteTotalRaw(quote)) },
  ];
}

/** Under the price: where it goes (and, with the fee, where the fee goes). */
export const payeeLine = (quote: FeedPayQuote) =>
  quote.feeIncluded
    ? "One payment: 90% of the price goes to the selling agent's wallet, the address its listing names, and 10% to Central City."
    : quoteFeeRaw(quote) === null
      ? `Paid to ${quote.host}, the address its listing names.`
      : `The price goes to ${quote.host}, the address its listing names. The fee goes to Central City.`;

export type QuoteCheck =
  | { kind: 'ok' }
  | { kind: 'over_max'; text: string }
  | { kind: 'over_cap'; text: string }
  | { kind: 'fee_too_small'; text: string }
  | { kind: 'over_limit'; text: string }
  | { kind: 'no_funds'; text: string };

/** "0.022 USDC in total" with the fee, "0.02 USDC" without: the amount the caps are about. */
const spendWords = (quote: FeedPayQuote) =>
  `${usdcText(quoteTotalRaw(quote))} USDC${quoteFeeRaw(quote) === null ? '' : ' in total'}`;

/**
 * The agent's own limits and USDC against what the call costs (the price, plus Central City's fee
 * when it applies), checked before any confirm: the hard maximum of one call, the per-call
 * maximum, then the limit left, then what it has (its wallet plus Ready for services). What isn't
 * known now is no refusal here: the call checks for real.
 */
export function quoteCheck(quote: FeedPayQuote, agent: FeedPayAgent): QuoteCheck {
  const name = plain(agent.name) || 'This agent';
  const total = quoteTotalRaw(quote);
  const fee = quoteFeeRaw(quote);
  // The fee rounds down to nothing on a tiny price: the server refuses such a call.
  if (fee !== null && big(fee) === 0n)
    return {
      kind: 'fee_too_small',
      text: `This price is too small to pay with Central City’s fee ${quote.feeIncluded ? 'included' : 'on top'}.`,
    };
  // Above the most one call may cost now, fee included (0.10 USDC, or 100 USDC while fee router 2
  // is on): a higher per-call maximum can't help.
  const cap = agent.perCallMaxCapRaw ?? String(FEED_PAY_LIMITS.perCallMaxMaxRaw);
  if (fee !== null && big(total) > BigInt(cap))
    return {
      kind: 'over_cap',
      text: `${spendWords(quote)} is above ${usdcText(cap)} USDC, the most an agent pays for one call.`,
    };
  if (big(total) > big(agent.perCallMaxRaw))
    return {
      kind: 'over_max',
      text: `${spendWords(quote)} is above ${name}’s per-call maximum of ${usdcText(agent.perCallMaxRaw)} USDC.`,
    };
  if (agent.limitLeftRaw !== null && big(total) > big(agent.limitLeftRaw))
    return {
      kind: 'over_limit',
      text: `${spendWords(quote)} is more than ${name} may still spend ${periodPhrase(agent.limitPeriod)}.`,
    };
  if (agent.usdcRaw !== null && agent.floatRaw !== null) {
    const has = big(agent.usdcRaw) + big(agent.floatRaw);
    if (big(total) > has)
      return {
        kind: 'no_funds',
        text: `${name} has ${usdcText(has.toString(10))} USDC, less than this call costs.`,
      };
  }
  return { kind: 'ok' };
}

/** The per-call maximum is enough for this quote now (after Change maximum). */
export const maxFits = (quote: FeedPayQuote, perCallMaxRaw: string) =>
  big(quoteTotalRaw(quote)) <= big(perCallMaxRaw);

/** A price that rose since the confirm (price_above_max): what was confirmed, and what is asked. */
export const priceRoseText = (confirmedRaw: string, nowRaw: string) =>
  `The price went up from ${usdcText(confirmedRaw)} to ${usdcText(nowRaw)} USDC. ${NOTHING_PAID} Confirm the new price.`;

export type RecheckWhy = 'expired' | 'mismatch';

/** Why the price is checked again by itself (while it is checked). */
export const recheckWhy = (why: RecheckWhy) =>
  why === 'expired'
    ? 'The price check expired, so we checked again.'
    : 'The price check didn’t match this payment, so we checked again.';

/**
 * After the price was checked again by itself: why, the change when the price changed, and
 * Central City's fee when it applies now but did not before (or the other way round). `included`:
 * the fee is part of the price now (a service sold by a Central City agent), not on top.
 */
export function recheckNote(
  why: RecheckWhy,
  beforeRaw: string | null,
  nowRaw: string,
  fee: { beforeRaw: string | null; nowRaw: string | null; included?: boolean } = {
    beforeRaw: null,
    nowRaw: null,
  },
) {
  const changed =
    beforeRaw !== null && beforeRaw !== nowRaw
      ? ` It was ${usdcText(beforeRaw)} USDC, now ${usdcText(nowRaw)} USDC.`
      : '';
  const feeNow =
    fee.beforeRaw === null && fee.nowRaw !== null
      ? fee.included
        ? ` Central City’s fee of ${usdcText(fee.nowRaw)} USDC is now included in the price.`
        : ` Central City’s fee of ${usdcText(fee.nowRaw)} USDC now comes on top.`
      : fee.beforeRaw !== null && fee.nowRaw === null
        ? ' Central City’s fee no longer applies.'
        : '';
  return `${recheckWhy(why)}${changed}${feeNow} Confirm to pay.`;
}

/** While a lost answer is asked about again. */
export const ASKING_AGAIN = 'Checking whether the payment started…';

/** "The service asks 0.03 USDC now. The listing says 0.02 USDC." when it asks more. */
export function vsListingText(quote: FeedPayQuote): string | null {
  if (quote.vsListing !== 'higher' || !quote.listed) return null;
  return `The service asks ${usdcText(quote.amount.raw)} USDC now. The listing says ${usdcText(quote.listed.raw)} USDC.`;
}

export const priceLine = (quote: FeedPayQuote) => `${usdcText(quote.amount.raw)} USDC per call`;

/**
 * "Pay 0.02 USDC from hhuo to www.ax1.vc? You can’t undo it." With the fee: "Pay 0.022 USDC from
 * hhuo: 0.02 to www.ax1.vc and 0.002 Central City fee? You can’t undo it." Fee included: "Pay 0.05
 * USDC from hhuo to the selling agent, fee included (0.005 to Central City)? You can’t undo it."
 */
export function confirmText(quote: FeedPayQuote, agentName: string) {
  const fee = quoteFeeRaw(quote);
  if (fee === null)
    return `Pay ${usdcText(quote.amount.raw)} USDC from ${plain(agentName)} to ${quote.host}? You can’t undo it.`;
  if (quote.feeIncluded)
    return `Pay ${usdcText(quote.amount.raw)} USDC from ${plain(agentName)} to the selling agent, fee included (${usdcText(fee)} to Central City)? You can’t undo it.`;
  return `Pay ${usdcText(quoteTotalRaw(quote))} USDC from ${plain(agentName)}: ${usdcText(quote.amount.raw)} to ${quote.host} and ${usdcText(fee)} Central City fee? You can’t undo it.`;
}

/** The button pays the total: "Pay 0.022 USDC" (the price alone while fees are off). */
export const payButtonText = (quote: FeedPayQuote) => `Pay ${usdcText(quoteTotalRaw(quote))} USDC`;

// ---------------------------------------------------------------------------------------------
// Errors of quote and call: the page's own words, then whether money moved

export interface RefusalContext {
  agentName?: string;
  period?: LimitPeriod | null;
}

/** Plain words for a refusal, without the money part (the wallet's own editor, the call page). */
export function refusalSentence(failure: PayFailure, context: RefusalContext = {}): string {
  const name = plain(context.agentName ?? '') || 'The agent';
  switch (failure.code) {
    case 'network':
      return 'We couldn’t reach Central City. Check your connection and try again.';
    case 'rate_limited':
      return 'Too many tries in a short time. Try again in a minute.';
    case 'signed_out':
      return 'You’re signed out. Sign in again, then try once more.';
    case 'server':
    case 'unknown':
      return 'Something went wrong on our side. Try again in a moment.';
    case 'not_payable':
      return failure.detail.reason
        ? notPayableText(failure.detail.reason)
        : typo(FEED_PAY_ERROR_MESSAGES.not_payable);
    case 'over_per_call_max':
      if (failure.detail.neededRaw && failure.detail.perCallMaxRaw)
        return `${usdcText(failure.detail.neededRaw)} USDC is above ${name}’s per-call maximum of ${usdcText(failure.detail.perCallMaxRaw)} USDC.`;
      break;
    case 'over_limit':
      if (failure.detail.neededRaw)
        return `${usdcText(failure.detail.neededRaw)} USDC is more than ${name} may still spend ${periodPhrase(context.period ?? null)}.`;
      break;
    case 'limit_not_started':
      return (
        limitStartsText(failure.detail.startsAt) ?? typo(FEED_PAY_ERROR_MESSAGES.limit_not_started)
      );
    default:
      break;
  }
  const code = failure.code as keyof typeof FEED_PAY_ERROR_MESSAGES;
  return typo(FEED_PAY_ERROR_MESSAGES[code] ?? 'Something went wrong.');
}

/**
 * Plain words for a quote or call refusal the server answered for sure; every one of them means
 * nothing was signed or sent, said once, last.
 */
export const refusalText = (failure: PayFailure, context: RefusalContext = {}) =>
  withMoney(refusalSentence(failure, context), NOTHING_PAID);

/**
 * A call whose answer never came (the connection dropped, or a gateway answered for us): it may
 * have started. The same key asks again and answers the same call, never a second payment.
 */
export const LOST_ANSWER =
  'We didn’t get an answer, so we can’t tell yet whether the payment started. Check again: it never pays twice.';

/**
 * Codes that may come before the server looked for the call's key, or from more than one place
 * (the session, the switch, the rate limit, the request's shape, the database or Base for a
 * moment, a gateway): they say nothing about a call already started with that key.
 */
const BEFORE_THE_KEY: ReadonlySet<string> = new Set([
  'network',
  'server',
  'unknown',
  'busy',
  'unavailable',
  'rate_limited',
  'signed_out',
  'not_found',
  'invalid_request',
]);

/**
 * The answer to a call says nothing for sure about the payment: it may have started. The first
 * send of a confirm: no answer came, or the server was busy or Base unavailable for a moment
 * (both may come after the work started). Sending a lost call again: anything the server may
 * answer before it looks up the key. Only the engine's own answer after that says nothing was
 * paid. The page keeps the request and its key, and asks again with them.
 */
export function lostAnswer(failure: PayFailure, askingAgain = false): boolean {
  if (askingAgain) return BEFORE_THE_KEY.has(failure.code);
  return (
    failure.code === 'network' ||
    failure.code === 'server' ||
    failure.code === 'unknown' ||
    failure.code === 'busy' ||
    failure.code === 'unavailable'
  );
}

/**
 * The line while a lost call is still not answered for sure, after asking again. Signed out or
 * paying switched off, Check again can't tell either: the agent's wallet shows the call once it
 * can be read.
 */
export function stillLostText(code: string, agentName: string): string {
  const name = plain(agentName) || 'the agent';
  if (code === 'signed_out')
    return `You’re signed out, so we can’t tell yet whether the payment started. After you sign in, look in ${name}’s wallet before you pay again.`;
  if (code === 'not_found')
    return `Paying services isn’t available right now, so we can’t tell yet whether the payment started. Look in ${name}’s wallet before you pay again.`;
  return 'We still can’t tell whether the payment started. Check again in a minute: it never pays twice.';
}

// ---------------------------------------------------------------------------------------------
// The call, while paying and after

export type CallTone = 'busy' | 'ok' | 'warn' | 'bad';

const failureSentence = (call: FeedPayCall, fallback: string) =>
  typo(call.failure?.message ?? fallback);

/** The one line that says where the call is (by state, then whether money moved). */
export function callLine(call: FeedPayCall): { text: string; tone: CallTone } {
  const host = call.service.host;
  const amount = usdcText(call.payment?.amountRaw ?? call.maxAmount.raw);
  switch (call.state) {
    case 'reserved':
      return { text: 'Starting…', tone: 'busy' };
    case 'float_topup':
      return { text: 'Getting USDC ready for services…', tone: 'busy' };
    case 'authorized':
      return { text: `Paying ${host}…`, tone: 'busy' };
    case 'calling':
      return { text: `Waiting for ${host}…`, tone: 'busy' };
    case 'reconciling':
      return { text: 'Checking on Base whether the payment went through…', tone: 'busy' };
    case 'settled':
      return { text: 'Paid. Saving the result…', tone: 'busy' };
    case 'not_settled':
      return { text: `${host} didn’t take the payment. Cancelling it…`, tone: 'busy' };
    case 'result_saved':
      if (call.moneyMoved === 'yes') return { text: `Paid ${amount} USDC to ${host}.`, tone: 'ok' };
      if (call.moneyMoved === 'pending')
        return { text: 'Result received. Confirming the payment on Base…', tone: 'busy' };
      return { text: `Result received. ${NO_MONEY_MOVED}`, tone: 'ok' };
    case 'paid_no_result':
      return {
        text: `Paid ${amount} USDC to ${host}, but it sent no result. We told our team.`,
        tone: 'bad',
      };
    case 'cancelled':
    case 'expired':
      if (call.moneyMoved === 'pending')
        return { text: 'Checking on Base whether the payment went through…', tone: 'busy' };
      return {
        text: withMoney(failureSentence(call, 'The call didn’t go through.'), NO_MONEY_MOVED),
        tone: 'warn',
      };
    case 'refused':
      return {
        text: withMoney(failureSentence(call, 'The call was stopped before paying.'), NOTHING_PAID),
        tone: 'warn',
      };
  }
}

/**
 * The call page's line under its title: "paid by" only when money moved; a call that was refused,
 * cancelled or is still deciding is "from" the agent's wallet.
 */
export const callPageSub = (call: FeedPayCall) =>
  `${call.service.host} · ${call.moneyMoved === 'yes' ? 'paid by' : 'from'} ${plain(call.agent.name)} · ${utcText(call.createdAt)}`;

/** A call that can't be read any more while it was followed (no longer the person's to see). */
export const CALL_GONE = 'This call can’t be read any more. Its agent’s wallet shows how it ended.';

/** "0.02 USDC from hhuo to www.ax1.vc" (the payment line under the result). */
export const paymentLine = (call: FeedPayCall) =>
  call.payment
    ? `${usdcText(call.payment.amountRaw)} USDC from ${plain(call.agent.name)} to ${call.payment.host}`
    : null;

/** The payment's own state, in words, while Base hasn't decided yet. */
export function paymentNote(call: FeedPayCall): string | null {
  if (!call.payment) return null;
  if (call.payment.state === 'settled') return null;
  if (call.moneyMoved === 'pending') return 'Confirming on Base';
  return 'Not paid';
}

const TX_HASH = /^0x[0-9a-fA-F]{64}$/;
/** A transaction on the wallet network's explorer (as the server links the payment's). */
const txHref = (hash: string | null | undefined) =>
  hash && TX_HASH.test(hash) ? `${WALLET_EXPLORER}/tx/${hash}` : null;

/** One line of a call's money: its amount, where it stands, and its Base transaction. */
export interface CallMoneyLine extends MoneyLine {
  raw: string;
  /** "to www.ax1.vc" (the price), "from hhuo" (the total); null for the fee. */
  sub: string | null;
  /** The state while Base hasn't decided, or a fee that wasn't charged; null when done. */
  note: string | null;
  tx: { href: string; label: string } | null;
}

type CallMoney = Pick<FeedPayCall, 'payment' | 'protocolFee' | 'moneyMoved'> & {
  agent?: FeedPayCall['agent'];
};

/**
 * The call is done, but Central City's fee is still being charged (it goes after the price is
 * paid, so a call is done before its fee): the page follows it a while longer for its
 * transaction.
 */
export const feeOpen = (call: Pick<FeedPayCall, 'payment' | 'protocolFee'>) =>
  call.payment?.state === 'settled' &&
  (call.protocolFee?.state === 'pending' || call.protocolFee?.state === 'sent');

/** How long a done call is followed for its fee, at most. */
export const FEE_FOLLOW_MS = 120_000;

/** The fee counts in the total while it is owed or charged; failed or not owed, it doesn't. */
const feeCounts = (fee: NonNullable<FeedPayCall['protocolFee']>) =>
  fee.state === 'pending' || fee.state === 'sent' || fee.state === 'charged';

function feeNote(fee: NonNullable<FeedPayCall['protocolFee']>, priceSettled: boolean) {
  if (fee.state === 'charged') return null;
  if (!feeCounts(fee)) return 'Not charged';
  return priceSettled ? 'Confirming on Base' : 'After the price is paid';
}

/**
 * A call's price, Central City's fee and the total, each with its Base transaction once known;
 * fee included, the price and Central City's part of it, with the one transaction. Null when there
 * is no fee to show (fees off, nothing paid, or no fee owed): the payment line alone then says it,
 * as before.
 */
export function callMoneyLines(call: CallMoney): CallMoneyLine[] | null {
  const fee = call.protocolFee;
  const payment = call.payment;
  if (!fee || !payment || call.moneyMoved === 'no' || fee.state === 'not_owed') return null;
  if (!RAW.test(fee.amountRaw) || !RAW.test(payment.amountRaw)) return null;
  const settled = payment.state === 'settled';
  const name = call.agent ? plain(call.agent.name) : '';
  const price: CallMoneyLine = {
    key: 'price',
    label: 'Price',
    raw: payment.amountRaw,
    value: dollarText(payment.amountRaw),
    sub: `to ${payment.host}`,
    note: settled ? null : call.moneyMoved === 'pending' ? 'Confirming on Base' : 'Not paid',
    tx: payment.explorerUrl ? { href: payment.explorerUrl, label: 'Base transaction' } : null,
  };
  // Fee included (a service sold by a Central City agent): the price is all the agent paid, and
  // Central City's 10% of it went in the same transaction. No total, no fee transaction of its own.
  if (fee.included)
    return [
      {
        ...price,
        label: PRICE_INCLUDED_LABEL,
        sub: name ? `from ${name} to ${payment.host}` : price.sub,
      },
      {
        key: 'fee',
        label: FEE_INCLUDED_LABEL,
        raw: fee.amountRaw,
        value: dollarText(fee.amountRaw),
        sub: null,
        note: feeCounts(fee) ? null : 'Not charged',
        tx: null,
      },
    ];
  const total = feeCounts(fee)
    ? (big(payment.amountRaw) + big(fee.amountRaw)).toString(10)
    : payment.amountRaw;
  const feeTx = txHref(fee.txHash);
  return [
    price,
    {
      key: 'fee',
      label: FEE_LABEL,
      raw: fee.amountRaw,
      value: dollarText(fee.amountRaw),
      sub: null,
      note: feeNote(fee, settled),
      tx: feeTx ? { href: feeTx, label: 'Fee transaction' } : null,
    },
    {
      key: 'total',
      label: 'Total',
      raw: total,
      value: dollarText(total),
      sub: name ? `from ${name}` : null,
      note: null,
      tx: null,
    },
  ];
}

/**
 * The wallet History's line under a call with a fee, in USDC like the rest of the list:
 * "Price 0.02 · Central City fee (10%) 0.002 · Total 0.022". Fee included, the price alone with
 * Central City's part of it: "0.05 USDC, fee included (0.005 to Central City)". Null without a fee
 * to show.
 */
export function historyMoneyText(item: FeedPayHistoryItem): string | null {
  const lines = callMoneyLines(item);
  if (!lines) return null;
  if (item.protocolFee?.included) {
    const [price, fee] = lines;
    const notCharged = fee!.note === 'Not charged' ? ', not charged' : '';
    return `${usdcText(price!.raw)} USDC, fee included (${usdcText(fee!.raw)} to Central City${notCharged})`;
  }
  return lines
    .map(
      (line) =>
        `${line.label} ${usdcText(line.raw)}${line.key === 'fee' && line.note === 'Not charged' ? ', not charged' : ''}`,
    )
    .join(' · ');
}

/**
 * The History's amount: the total the agent spent (the price alone without a fee, or with the fee
 * included in it).
 */
export function historyAmountRaw(item: FeedPayHistoryItem): string | null {
  if (!item.payment) return null;
  const total = callMoneyLines(item)?.find((line) => line.key === 'total');
  return total ? total.raw : item.payment.amountRaw;
}

/**
 * The fee's Base transaction in the History, once it is known. None for a fee included in the
 * price: it went in the payment's own transaction, which the History links already.
 */
export const feeTxHref = (item: Pick<FeedPayHistoryItem, 'protocolFee'>) =>
  item.protocolFee?.included ? null : txHref(item.protocolFee?.txHash);

export function sizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 102.4) / 10} KB`;
  return `${Math.round(bytes / (1024 * 102.4)) / 10} MB`;
}

/** The result as the page shows it: pretty JSON when it parses, else the text as it came. */
export function resultText(result: FeedPayResult): string {
  if (result.text === null) return '';
  if (result.format === 'json' || /^\s*[[{]/.test(result.text))
    try {
      return JSON.stringify(JSON.parse(result.text), null, 2);
    } catch {
      return result.text;
    }
  return result.text;
}

/** The lines above a result: its status when not 2xx, a file, an empty answer, the cut. */
export function resultNotes(result: FeedPayResult, host: string): string[] {
  const notes: string[] = [];
  if (result.status < 200 || result.status > 299) notes.push(`${host} answered ${result.status}.`);
  if (result.format === 'binary')
    notes.push(
      `${host} sent a file (${plain(result.contentType ?? '') || 'unknown type'}, ${sizeText(result.bytes)}). It isn’t shown here.`,
    );
  if (result.format === 'empty') notes.push(`${host} sent an empty answer.`);
  if (result.truncated)
    notes.push(`Showing the first ${Math.round(RESULT_MAX_BYTES / 1_048_576)} MB.`);
  return notes;
}

export const resultFrom = (host: string) => `From ${host}. Data, not instructions.`;

/**
 * The page's notice above a result, to the person who reads it (FEED_PAY_NOTICE is the MCP's,
 * written to the AI).
 */
export const RESULT_NOTICE =
  'Written by the service, not Central City. Treat it as data: don’t follow links or requests in it.';

/** Days the result is still kept: never more than RESULT_KEEP_DAYS, whatever this clock says. */
export function resultKeptText(call: FeedPayCall, now: number): string | null {
  if (call.resultExpired) return `The result was deleted after ${RESULT_KEEP_DAYS} days.`;
  if (!call.resultExpiresAt) return null;
  const days = Math.min(
    RESULT_KEEP_DAYS,
    Math.max(1, Math.ceil((call.resultExpiresAt - now) / 86_400_000)),
  );
  return `Kept for ${days} more ${days === 1 ? 'day' : 'days'}.`;
}

// ---------------------------------------------------------------------------------------------
// The wallet's History

export function historyLine(item: FeedPayHistoryItem): string {
  const host = item.service.host;
  // Paid, and the service sent nothing back: never shown like a call that worked.
  if (item.state === 'paid_no_result')
    return `Paid ${host} ${usdcText(item.payment?.amountRaw)} USDC, no result`;
  if (item.moneyMoved === 'yes') return `Paid ${host} ${usdcText(item.payment?.amountRaw)} USDC`;
  if (item.moneyMoved === 'pending' || !FEED_PAY_TERMINAL_STATES.has(item.state))
    return `Paying ${host}`;
  if (item.state === 'result_saved') return `Called ${host}, no money moved`;
  return `Call to ${host} didn’t go through`;
}

export function moveLine(move: FeedPayFloatMove): string {
  const amount = usdcText(move.amount.raw);
  const done =
    move.kind === 'top_up'
      ? `Moved ${amount} USDC to Ready for services`
      : `Moved ${amount} USDC back to the wallet`;
  if (move.state === 'failed')
    return move.kind === 'top_up'
      ? `Moving ${amount} USDC to Ready for services didn’t go through`
      : `Moving ${amount} USDC back to the wallet didn’t go through`;
  if (move.state === 'pending')
    return move.kind === 'top_up'
      ? `Moving ${amount} USDC to Ready for services`
      : `Moving ${amount} USDC back to the wallet`;
  return done;
}

/** A per-call maximum that couldn't be saved, in the editor's words (no money is involved). */
export const maxProblemText = (failure: PayFailure) =>
  failure.code === 'invalid_request' ? PER_CALL_MAX_RANGE : refusalSentence(failure);

/** "Saved. hhuo now pays at most 0.25 USDC per call." */
export const maxSavedText = (agentName: string, raw: string) =>
  `Saved. ${plain(agentName) || 'This agent'} now pays at most ${usdcText(raw)} USDC per call.`;

export const READY_HELP =
  'USDC this agent keeps ready to pay services. Unused USDC goes back to the wallet.';
export const MAX_HELP = 'The most this agent pays for one service call. Default 0.10 USDC.';

/**
 * A per-call maximum as typed ("0.25"), in base units within the allowed range (up to `capRaw`:
 * 0.10 USDC, or the agent's perCallMaxCapRaw while fee router 2 is on); else null.
 */
export function perCallMaxRaw(
  text: string,
  capRaw: string = String(FEED_PAY_LIMITS.perCallMaxMaxRaw),
): string | null {
  const value = text.trim();
  if (!/^(?:0|[1-9]\d{0,8})(?:\.\d{1,6})?$/.test(value)) return null;
  const [whole, fraction = ''] = value.split('.');
  const raw = BigInt(whole!) * 1_000_000n + BigInt(fraction.padEnd(6, '0'));
  if (raw < BigInt(FEED_PAY_LIMITS.perCallMaxMinRaw) || raw > BigInt(capRaw)) return null;
  return raw.toString();
}

/** The allowed range as a sentence, up to `capRaw` (the agent's perCallMaxCapRaw when known). */
export const perCallMaxRange = (capRaw: string = String(FEED_PAY_LIMITS.perCallMaxMaxRaw)) =>
  `Use an amount from 0.000001 to ${usdcText(capRaw)} USDC.`;

export const PER_CALL_MAX_RANGE = perCallMaxRange();

/** The pot target's help line (docs/protocol/FEE_ROUTER_2.md section 6). */
export const POT_HELP =
  'How much one top-up loads, so calls are paid from it without a top-up each time. Default 1 USDC, at most 100 USDC and never above the spending limit per period.';
export const POT_RANGE = 'Use an amount from 1 to 100 USDC.';

/** A pot target as typed ("25"), in base units from 1 to 100 USDC; else null. */
export function floatTargetRaw(text: string): string | null {
  const value = text.trim();
  if (!/^(?:0|[1-9]\d{0,8})(?:\.\d{1,6})?$/.test(value)) return null;
  const [whole, fraction = ''] = value.split('.');
  const raw = BigInt(whole!) * 1_000_000n + BigInt(fraction.padEnd(6, '0'));
  if (raw < 1_000_000n || raw > BigInt(FEED_PAY_LIMITS.perCallMaxMaxRouter2Raw)) return null;
  return raw.toString();
}

/** What the page says once a pot target is saved. */
export const potSavedText = (name: string, raw: string) =>
  `${name} now tops up to ${usdcText(raw)} USDC at a time.`;
