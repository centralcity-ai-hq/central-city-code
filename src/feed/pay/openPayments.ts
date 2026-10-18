import { useSyncExternalStore } from 'react';
import {
  feedPayCallDone,
  type FeedPayCall,
  type FeedPayCallRequest,
  type FeedPayQuote,
} from '../../../shared/feed-pay';
import { onFeedForget } from '../feedPaths';
import type { InputDraft } from './payModel';

/*
 * The use sheet's memory outside the sheet, per service, for this page only (never written to
 * storage: it holds what the person typed; dropped on sign-out).
 *
 * An open payment: a confirm that may have started paying, from the click on Pay until the call
 * is done or the server said for sure that nothing started. The sheet can close while it is sent
 * or after its answer was lost (Back, Close, Escape, the scrim, a link to the wallet); opening the
 * service again shows that same payment with the same request and idempotency key, so the person
 * checks it again and never pays a second time with a new key (docs/FEED_PAY.md section 7).
 *
 * A draft: the inputs and the agent picked, so the sheet opens as it was (also after Set a
 * spending limit or Add funds, which leave for the agent's wallet and come back with Back).
 */

/**
 * 'sending': the request is out. 'lost': its answer never came, or said nothing for sure.
 * 'call': the call answered and isn't done. 'refused': the server said for sure that nothing
 * started, after the sheet had closed: the next sheet shows why, and the payment is no longer open.
 */
export type OpenPhase = 'sending' | 'lost' | 'call' | 'refused';

export interface OpenPayment {
  phase: OpenPhase;
  /** The confirmed request with its idempotency key: every send of this payment is exactly it. */
  body: FeedPayCallRequest;
  /** The price the person confirmed. */
  quote: FeedPayQuote;
  /** The agent's name, for the lines that name it. */
  agentName: string;
  /** Phase 'call': the call as last read. */
  call: FeedPayCall | null;
  /**
   * Phase 'lost' after asking again: the code of that answer (it still says nothing for sure);
   * null the first time.
   */
  stillLost: string | null;
  /** Phase 'sending': this send asks again about a lost answer (not a first payment). */
  asking: boolean;
  /** Phase 'refused': the refusal, in the page's words. */
  problem: string;
}

export interface SheetDraft {
  draft: InputDraft;
  agentId: string | null;
  /** The sheet left for the agent's wallet: opening the service shows the sheet again. */
  reopen: boolean;
  /** A refusal the sheet got after it closed (the answer came late), shown when it opens. */
  problem: string;
}

const open = new Map<string, OpenPayment>();
const drafts = new Map<string, SheetDraft>();
const listeners = new Set<() => void>();

function changed() {
  for (const listener of listeners) listener();
}

export function getOpenPayment(serviceId: string): OpenPayment | null {
  return open.get(serviceId) ?? null;
}

/** Sets (or, with null, ends) the open payment of a service. */
export function setOpenPayment(serviceId: string, next: OpenPayment | null) {
  if (next) open.set(serviceId, next);
  else open.delete(serviceId);
  changed();
}

/** A newer read of an open payment's call; a call that is done ends it. */
export function updateOpenCall(serviceId: string, call: FeedPayCall) {
  const current = open.get(serviceId);
  if (!current || current.phase !== 'call' || current.call?.callId !== call.callId) return;
  setOpenPayment(serviceId, feedPayCallDone(call) || call.done ? null : { ...current, call });
}

/**
 * What stays open once a send of this payment is answered with a call. A call that isn't done
 * stays open; a done one too when no sheet is left to show it (the sheet closed while it was
 * sent): the next sheet opens on that call, never on the confirm of the quote just paid, and
 * ends it there.
 */
export function answeredPayment(
  entry: OpenPayment,
  call: FeedPayCall,
  sheetShowsIt: boolean,
): OpenPayment | null {
  const done = feedPayCallDone(call) || call.done;
  return done && sheetShowsIt ? null : { ...entry, phase: 'call', call };
}

/** A call that can't be read any more (call_not_found): its open payment ends. */
export function endGoneCall(serviceId: string, callId: string) {
  const current = open.get(serviceId);
  if (!current || current.phase !== 'call' || current.call?.callId !== callId) return;
  setOpenPayment(serviceId, null);
}

/** The open payment of a service, live. */
export function useOpenPayment(serviceId: string): OpenPayment | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => open.get(serviceId) ?? null,
    // Only ever set in the browser, by a click: a server render has none.
    () => open.get(serviceId) ?? null,
  );
}

export function getSheetDraft(serviceId: string): SheetDraft | null {
  return drafts.get(serviceId) ?? null;
}

/** Keeps the sheet's inputs and agent (and, for a link to the wallet, that it should reopen). */
export function keepSheetDraft(serviceId: string, next: Partial<SheetDraft>) {
  const current = drafts.get(serviceId) ?? {
    draft: { values: {}, extra: '' },
    agentId: null,
    reopen: false,
    problem: '',
  };
  drafts.set(serviceId, { ...current, ...next });
}

/**
 * Opening this service should show the use sheet: a payment is open, or the sheet left for the
 * agent's wallet and is coming back.
 */
export function sheetWanted(serviceId: string): boolean {
  const payment = open.get(serviceId);
  return (
    (payment !== undefined && payment.phase !== 'refused') || drafts.get(serviceId)?.reopen === true
  );
}

/** Sign-out, or another account in this tab. */
export function forgetOpenPayments() {
  open.clear();
  drafts.clear();
  changed();
}
onFeedForget(forgetOpenPayments);
