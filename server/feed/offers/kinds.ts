/*
 * What an offer's kind does when it is bought: the registry of built-in, deterministic services
 * (OFFER_KINDS and their input schemas in shared/feed-offers.ts).
 *
 * Each kind implements OfferKind and is registered in OFFER_KIND_REGISTRY below, under its name
 * from OFFER_KINDS. `hash` is the reference implementation; the other kinds register here the
 * same way, one entry each, with no change anywhere else. A kind that is not registered cannot be
 * offered: the writer refuses it ('kind_unavailable', server/feed/offers/store.ts).
 *
 * Rules every kind keeps:
 * - Side-effect free: it writes nothing (no database, no transaction) and sends at most https GET
 *   requests. Delivery runs a kind at least once (a crash after run() and before the answer is
 *   stored runs it again on recovery); the stored result is written once, so the buyer gets one answer.
 * - Deterministic: the same input answers the same body (a chain read answers what the chain
 *   says at the block it reads; the answer names that block).
 * - Every refusal that depends on the input alone is in the kind's pure, synchronous check():
 *   the purchase path calls checkOffer (schema, then check) BEFORE the buyer pays. run() starts
 *   after payment; it calls check() again (it never trusts its caller), then can only fail with
 *   OfferKindFailure (an outside read or a limit), never with OfferKindInputError.
 * - Bounded: answers at most 64 KiB, starts no model call, and reads no workspace data.
 *   ctx.signal is checked between steps and ends any network or chain wait at once; a pure
 *   computation is synchronous and runs to its end (its input is at most 64 KiB, so that is
 *   short). `ctx.now` is the only clock it reads.
 * - What it answers is the seller's product, delivered to any payer: never a secret, a key or
 *   another account's data.
 */
import { createHash } from 'node:crypto';
import { type OfferKindName } from '../../../shared/feed-offers.js';
import { jsonAnswer, pureKind, type OfferKind } from './kind-core.js';
import { addressChecksumKind, baseBlockKind, baseUsdcBalanceKind } from './kinds-base.js';
import { baseErc20BalanceKind, baseGasKind, baseTxKind } from './kinds-base-tx.js';
import { csvStatsKind, csvToJsonKind, jsonToCsvKind } from './kinds-csv.js';
import { jsonQueryKind, jsonSchemaCheckKind } from './kinds-json.js';
import { markdownToTextKind } from './kinds-markdown.js';
import {
  colorConvertKind,
  dateDiffKind,
  numberToWordsKind,
  romanNumeralsKind,
} from './kinds-numbers.js';
import {
  base64Kind,
  caseConvertKind,
  readingTimeKind,
  slugifyKind,
  urlEncodeKind,
} from './kinds-strings.js';
import { jsonCheckKind, textStatsKind } from './kinds-text.js';
import { unitConvertKind } from './kinds-units.js';
import { webReadKind } from './kinds-web.js';
import { webLinksKind, webMetaKind } from './kinds-web-meta.js';
import { keywordDensityKind, textDiffKind } from './kinds-words.js';

// The contract, the input check and the readers live in kind-core.ts (the kinds import them from
// there); they are exported here as well, the one module callers use.
export {
  checked,
  checkOffer,
  jsonAnswer,
  OFFER_ANSWER_MAX_BYTES,
  OfferKindFailure,
  OfferKindInputError,
  offerKindDeps,
  pureKind,
  resetOfferKindDeps,
  setOfferKindDeps,
  textAnswer,
  type OfferKind,
  type OfferKindAnswer,
  type OfferKindContext,
  type OfferKindDeps,
  type OfferKindDepsUpdate,
} from './kind-core.js';

/** The reference kind: sha256 of a text's UTF-8 bytes (at most 8 KiB), as lowercase hex. */
export const hashKind: OfferKind = pureKind('hash', ({ text }) => {
  // The schema caps text at 8 KiB, so the answer is always small; check() is the schema alone.
  const bytes = Buffer.from(String(text), 'utf8');
  return jsonAnswer({
    algorithm: 'sha256',
    hex: createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.length,
  });
});

/** The registered kinds by name. Register a kind here, once, under its own name. */
export const OFFER_KIND_REGISTRY: ReadonlyMap<OfferKindName, OfferKind> = new Map<
  OfferKindName,
  OfferKind
>(
  [
    webReadKind,
    textStatsKind,
    jsonCheckKind,
    hashKind,
    baseUsdcBalanceKind,
    baseBlockKind,
    unitConvertKind,
    base64Kind,
    urlEncodeKind,
    caseConvertKind,
    slugifyKind,
    readingTimeKind,
    csvToJsonKind,
    jsonToCsvKind,
    markdownToTextKind,
    romanNumeralsKind,
    numberToWordsKind,
    colorConvertKind,
    dateDiffKind,
    addressChecksumKind,
    webMetaKind,
    webLinksKind,
    keywordDensityKind,
    textDiffKind,
    jsonQueryKind,
    jsonSchemaCheckKind,
    csvStatsKind,
    baseTxKind,
    baseErc20BalanceKind,
    baseGasKind,
  ].map((kind) => [kind.name, kind]),
);

/** The registered kind of this name, or null (not offered yet). */
export function offerKind(
  name: OfferKindName,
  registry: ReadonlyMap<OfferKindName, OfferKind> = OFFER_KIND_REGISTRY,
): OfferKind | null {
  const kind = registry.get(name);
  return kind && kind.name === name ? kind : null;
}
