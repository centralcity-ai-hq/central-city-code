/*
 * What every offer kind shares (kinds.ts re-exports all of it): the OfferKind contract, the input
 * check every call starts with (checkOffer), the two errors a kind may throw, the 64 KiB answer
 * cap, and the outside readers a kind may use (setOfferKindDeps). Kept apart from kinds.ts so the
 * kinds in kinds-*.ts can import it while kinds.ts imports them into its registry, without an
 * import cycle.
 *
 * PAYMENT ORDER: the buyer pays BEFORE run() starts. So every refusal that depends on the input
 * alone lives in the kind's check() (checkOffer before payment); after payment only reads of the
 * outside world (a page, the chain) and this process's limits can fail, as OfferKindFailure.
 */
import {
  checkOfferInput,
  OFFER_KIND_SPECS,
  type OfferInputField,
  type OfferInputValue,
  type OfferKindName,
} from '../../../shared/feed-offers.js';
import type { OfferBaseReader } from './kinds-base.js';
import { createSafeFetch, type FetchPublic } from './safe-fetch.js';

export interface OfferKindContext {
  /**
   * Aborts when the call's time is up. A kind checks it between steps and it ends a network or
   * chain wait at once; a synchronous computation (at most 64 KiB of input) runs to its end.
   */
  signal: AbortSignal;
  /** The call's time (ms since epoch). */
  now: number;
}

export interface OfferKindAnswer {
  body: string | object;
  mime: string;
}

export type OfferKind = {
  name: OfferKindName;
  /** The kind's input fields (OFFER_KIND_SPECS[name].input). */
  inputSchema: readonly OfferInputField[];
  outputMime: string;
  /**
   * Pure and synchronous: throws OfferKindInputError for EVERY input this kind refuses whatever
   * the outside world says (its schema first, then the kind's own rules, an answer over 64 KiB
   * included). No network, no clock, no shared state: a pure kind may compute its answer here and
   * discard it. Called before payment (checkOffer); an input it accepts never makes run() throw
   * OfferKindInputError.
   */
  check(input: unknown): void;
  /**
   * The answer. Runs AFTER the buyer paid; it calls check() first (it never trusts its caller),
   * then may only fail with OfferKindFailure (an outside read or a limit) or the signal's reason.
   */
  run(input: unknown, ctx: OfferKindContext): Promise<OfferKindAnswer>;
};

/**
 * Thrown by check() (and so by run(), which calls it first) for an input the kind refuses. The
 * purchase path calls checkOffer before payment and answers 400 with the message: nothing is paid.
 */
export class OfferKindInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OfferKindInputError';
  }
}

/**
 * Thrown by run() for an input check() accepted that could still not be answered: a page or chain
 * that could not be read, a block not there yet, a fetcher limit. The buyer has ALREADY PAID when
 * this is thrown: it is the call's outcome, never a refusal before payment. `status` is the HTTP
 * status the call's outcome carries (422 the target's fault, 429 or 503 a limit, 502 or 504 the
 * network's), `message` a fixed sentence (never a URL, an address or a secret).
 *
 * `retryable`: a NEW, separately paid call with the same input may succeed (a busy limit, a
 * network failure, a block not mined yet); false when the same input would fail the same way.
 *
 * `outboundSent`: true when the call had already sent a request to a third party's server (web-read
 * once a connection was opened), whatever went wrong after. It only labels the paid call's outcome
 * (paid_no_result, with or without a request that reached a third party); it never decides whether
 * money moves: the payment happened before run().
 */
export class OfferKindFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: 422 | 429 | 502 | 503 | 504,
    readonly options: { retryable?: boolean; outboundSent?: boolean } = {},
  ) {
    super(message);
    this.name = 'OfferKindFailure';
  }

  get retryable(): boolean {
    return this.options.retryable ?? (this.status >= 500 || this.status === 429);
  }

  get outboundSent(): boolean {
    return this.options.outboundSent ?? false;
  }
}

/** The input after checkOfferInput (the kind's schema), or OfferKindInputError. */
export function checked(kind: OfferKindName, input: unknown): Record<string, OfferInputValue> {
  const result = checkOfferInput(kind, input);
  if (!result.ok) throw new OfferKindInputError(result.reason);
  return result.value;
}

/**
 * The whole pre-payment check of a call: the kind's schema (checkOfferInput), then the kind's own
 * rules (kind.check). Throws OfferKindInputError; returns the input with only the schema's fields.
 * The purchase path calls this BEFORE the buyer pays.
 */
export function checkOffer(kind: OfferKind, input: unknown): Record<string, OfferInputValue> {
  const value = checked(kind.name, input);
  kind.check(input);
  return value;
}

/** The largest answer a kind sends: its body as sent (JSON text or plain text), in UTF-8 bytes. */
export const OFFER_ANSWER_MAX_BYTES = 64 * 1024;

const tooLarge = () =>
  new OfferKindInputError(
    `The answer would be larger than ${OFFER_ANSWER_MAX_BYTES} bytes; send a shorter input.`,
  );

/**
 * A JSON answer of at most OFFER_ANSWER_MAX_BYTES. A larger one is refused as an input error: the
 * answer is a function of the input alone, so a pure kind meets it in check() (before payment).
 */
export function jsonAnswer(body: object): OfferKindAnswer {
  if (Buffer.byteLength(JSON.stringify(body), 'utf8') > OFFER_ANSWER_MAX_BYTES) throw tooLarge();
  return { body, mime: 'application/json' };
}

/**
 * A text/plain answer of at most OFFER_ANSWER_MAX_BYTES (a larger one as jsonAnswer). A NUL
 * character (U+0000, as a decode of 'AA==' or '%00' gives) is refused the same way: the stored
 * result is Postgres text, which cannot hold it, so the answer could never be saved after payment.
 */
export function textAnswer(body: string): OfferKindAnswer {
  if (body.includes('\u0000'))
    throw new OfferKindInputError('The answer would contain a NUL character (U+0000).');
  if (Buffer.byteLength(body, 'utf8') > OFFER_ANSWER_MAX_BYTES) throw tooLarge();
  return { body, mime: 'text/plain' };
}

/** What kinds read outside the process. Configured once at startup (setOfferKindDeps). */
export interface OfferKindDeps {
  /** The only way out to the web (one createSafeFetch() per process). */
  fetchPublic: FetchPublic;
  /** Base mainnet reads (offerBaseReader in kinds-base.ts). */
  readBase: OfferBaseReader;
}

/**
 * What setOfferKindDeps takes: any reader may be left out (it keeps its value), and readBase may be
 * null, "not configured" (offerBaseReaderFromEnv's null), so the Base kinds answer 'unavailable'.
 */
export type OfferKindDepsUpdate = Partial<Omit<OfferKindDeps, 'readBase'>> & {
  readBase?: OfferBaseReader | null;
};

const unavailable = () =>
  new OfferKindFailure('unavailable', 'Base reads are not available right now.', 503);

/** Until configured, every Base read refuses: a chain kind never answers from nothing. */
const UNCONFIGURED_BASE: OfferBaseReader = {
  getBlock: () => Promise.reject(unavailable()),
  readContract: () => Promise.reject(unavailable()),
  call: () => Promise.reject(unavailable()),
  getTransaction: () => Promise.reject(unavailable()),
  getTransactionReceipt: () => Promise.reject(unavailable()),
  getFeeHistory: () => Promise.reject(unavailable()),
  getGasPrice: () => Promise.reject(unavailable()),
};

let deps: OfferKindDeps | null = null;

/**
 * The kinds' readers. fetchPublic defaults to one safe fetcher for the process (built on first
 * use); readBase to a reader that refuses with 'unavailable' (503) until one is set.
 */
export function offerKindDeps(): OfferKindDeps {
  if (!deps) deps = { fetchPublic: createSafeFetch(), readBase: UNCONFIGURED_BASE };
  return deps;
}

/**
 * Sets the kinds' readers (once at startup; tests set fakes). Absent ones keep their value; a null
 * readBase is "not configured": the Base kinds then answer 'unavailable' (503), never a chain
 * failure. The startup call:
 *
 *   setOfferKindDeps({ readBase: offerBaseReaderFromEnv(process.env, { hosted }) });
 */
export function setOfferKindDeps(next: OfferKindDepsUpdate): void {
  const current = offerKindDeps();
  deps = {
    fetchPublic: next.fetchPublic ?? current.fetchPublic,
    readBase:
      next.readBase === undefined
        ? current.readBase
        : next.readBase === null
          ? UNCONFIGURED_BASE
          : next.readBase,
  };
}

/** Back to the defaults (tests). */
export function resetOfferKindDeps(): void {
  deps = null;
}

/**
 * A kind whose answer is a function of its input alone (no network, no chain): check() computes the
 * answer and discards it, so every refusal, the 64 KiB cap included, happens before payment; run()
 * calls check() first, then computes the same answer again. `answer` gets the schema-checked input.
 */
export function pureKind(
  name: OfferKindName,
  answer: (value: Record<string, OfferInputValue>) => OfferKindAnswer,
): OfferKind {
  const kind: OfferKind = {
    name,
    inputSchema: OFFER_KIND_SPECS[name].input,
    outputMime: OFFER_KIND_SPECS[name].outputMime,
    check(input) {
      answer(checked(name, input));
    },
    async run(input, ctx) {
      ctx.signal.throwIfAborted();
      kind.check(input);
      ctx.signal.throwIfAborted();
      const result = answer(checked(name, input));
      ctx.signal.throwIfAborted();
      return result;
    },
  };
  return kind;
}
