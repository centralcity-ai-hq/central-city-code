/*
 * The text transform kinds: base64, url-encode, case-convert, slugify and reading-time. Pure
 * functions of their input (OFFER_KIND_SPECS), linear in the text, no network. Every answer is at
 * most 64 KiB; one that would be larger is refused as an input error (textAnswer, jsonAnswer), in
 * check(), so before payment (pureKind).
 */
import { jsonAnswer, OfferKindInputError, pureKind, textAnswer } from './kind-core.js';
import { countWords } from './kinds-text.js';

// ---------------------------------------------------------------- base64

/** The most UTF-8 bytes base64 encodes: their Base64 is exactly 64 KiB. */
export const BASE64_ENCODE_MAX_BYTES = 49_152;
/** Standard alphabet, padded; checked as a whole before decoding (no regex backtracking). */
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** Base64 (RFC 4648, standard alphabet, padded) of a text's UTF-8 bytes. */
export function base64Encode(text: string): string {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length > BASE64_ENCODE_MAX_BYTES)
    throw new OfferKindInputError(
      `text is longer than ${BASE64_ENCODE_MAX_BYTES} bytes; its Base64 would be larger than 64 KiB.`,
    );
  return bytes.toString('base64');
}

/**
 * The UTF-8 text of canonical Base64: the standard alphabet, padded to a multiple of 4, no
 * whitespace, and no stray bits in the last character (it encodes back to itself). Anything else,
 * and bytes that are not UTF-8, is refused.
 */
export function base64Decode(text: string): string {
  if (text.length % 4 !== 0 || !BASE64.test(text))
    throw new OfferKindInputError(
      'text is not valid Base64 (standard alphabet, padded with =, no spaces).',
    );
  const bytes = Buffer.from(text, 'base64');
  if (bytes.toString('base64') !== text)
    throw new OfferKindInputError('text is not valid Base64 (its last character has stray bits).');
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new OfferKindInputError('The decoded bytes are not UTF-8 text.');
  }
}

export const base64Kind = pureKind('base64', ({ text, mode }) =>
  textAnswer(mode === 'encode' ? base64Encode(String(text)) : base64Decode(String(text))),
);

// ---------------------------------------------------------------- url-encode

/** encodeURIComponent: everything but A-Z a-z 0-9 - _ . ! ~ * ' ( ) is percent-encoded UTF-8. */
export function urlEncode(text: string): string {
  try {
    return encodeURIComponent(text);
  } catch {
    throw new OfferKindInputError('text has a lone surrogate, which has no UTF-8 encoding.');
  }
}

/** decodeURIComponent: every %XX sequence must be UTF-8; '+' stays '+'. */
export function urlDecode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    throw new OfferKindInputError('text is not valid percent-encoding of UTF-8.');
  }
}

export const urlEncodeKind = pureKind('url-encode', ({ text, mode }) =>
  textAnswer(mode === 'encode' ? urlEncode(String(text)) : urlDecode(String(text))),
);

// ---------------------------------------------------------------- case-convert

/**
 * The words of identifier cases: an upper case run before a capitalised word (HTML in
 * HTMLParser), a capitalised word, an upper case run, a lower case run, or digits. Every
 * alternative consumes what it matched, so the scan stays linear.
 */
const WORD_PARTS =
  /\p{Lu}+(?=\p{Lu}[\p{Ll}\p{M}])|\p{Lu}[\p{Ll}\p{M}]+|\p{Lu}[\p{Lu}\p{M}]*|[\p{Ll}\p{Lo}\p{Lt}\p{Lm}][\p{Ll}\p{Lo}\p{Lt}\p{Lm}\p{M}]*|\p{N}+/gu;
/** A word of title case: letters, marks and digits with inner apostrophes. */
const TITLE_WORD = /[\p{L}\p{M}\p{N}]+(?:['’][\p{L}\p{M}\p{N}]+)*/gu;

const capitalise = (word: string) => {
  const first = word.codePointAt(0);
  if (first === undefined) return word;
  const size = first > 0xffff ? 2 : 1;
  return word.slice(0, size).toUpperCase() + word.slice(size).toLowerCase();
};

/** The words of a text for snake, kebab, camel and pascal case. */
export function identifierWords(text: string): string[] {
  return text.match(WORD_PARTS) ?? [];
}

/** Lower case, then a capital at the start and after each . ! or ? that whitespace follows. */
function sentenceCase(text: string): string {
  const lower = text.toLowerCase();
  let out = '';
  let capitalNext = true;
  let afterEnd = false;
  for (const char of lower) {
    if (capitalNext && /[\p{L}\p{N}]/u.test(char)) {
      out += char.toUpperCase();
      capitalNext = false;
      afterEnd = false;
      continue;
    }
    out += char;
    if (char === '.' || char === '!' || char === '?') afterEnd = true;
    else if (/\s/u.test(char)) {
      if (afterEnd) capitalNext = true;
    } else afterEnd = false;
  }
  return out;
}

export function convertCase(text: string, to: string): string {
  switch (to) {
    case 'upper':
      return text.toUpperCase();
    case 'lower':
      return text.toLowerCase();
    case 'title':
      return text.replace(TITLE_WORD, capitalise);
    case 'sentence':
      return sentenceCase(text);
    case 'snake':
      return identifierWords(text)
        .map((word) => word.toLowerCase())
        .join('_');
    case 'kebab':
      return identifierWords(text)
        .map((word) => word.toLowerCase())
        .join('-');
    case 'camel':
      return identifierWords(text)
        .map((word, index) => (index === 0 ? word.toLowerCase() : capitalise(word)))
        .join('');
    case 'pascal':
      return identifierWords(text).map(capitalise).join('');
    default:
      throw new OfferKindInputError('to is not a case this service writes.');
  }
}

export const caseConvertKind = pureKind('case-convert', ({ text, to }) =>
  textAnswer(convertCase(String(text), String(to))),
);

// ---------------------------------------------------------------- slugify

export const SLUG_MAX_LENGTH = 200;

/** Latin letters that compatibility decomposition leaves as they are, in ASCII. */
const LATIN_LETTERS: Record<string, string> = {
  ß: 'ss',
  æ: 'ae',
  œ: 'oe',
  ø: 'o',
  đ: 'd',
  ð: 'd',
  ł: 'l',
  þ: 'th',
  ı: 'i',
  ħ: 'h',
  ŋ: 'ng',
  ſ: 's',
};
const LATIN_LETTER = /[ßæœøđðłþıħŋſ]/g;

/**
 * A URL slug: lower case, accents removed (compatibility decomposition, then the marks dropped:
 * é is e, ﬁ is fi), a few Latin letters spelled in ASCII (ß ss, æ ae, ø o, ł l...), every other
 * run of characters one hyphen, no hyphen at either end, at most SLUG_MAX_LENGTH characters.
 */
export function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .replace(LATIN_LETTER, (letter) => LATIN_LETTERS[letter] ?? '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, SLUG_MAX_LENGTH + 1);
  // Cut, then no hyphen at the end (the cut may leave one, or the text ended in one).
  let end = Math.min(slug.length, SLUG_MAX_LENGTH);
  while (end > 0 && slug[end - 1] === '-') end--;
  return slug.slice(0, end);
}

export const slugifyKind = pureKind('slugify', ({ text }) => {
  const slug = slugify(String(text));
  if (!slug) throw new OfferKindInputError('text has no letters or digits to make a slug of.');
  return textAnswer(slug);
});

// ---------------------------------------------------------------- reading-time

export const READING_WORDS_PER_MINUTE = 200;

export function readingTime(text: string, wordsPerMinute = READING_WORDS_PER_MINUTE) {
  const words = countWords(text);
  return {
    words,
    wordsPerMinute,
    /** One decimal. */
    minutes: Math.round((words * 10) / wordsPerMinute) / 10,
    /** Whole seconds. */
    seconds: Math.round((words * 60) / wordsPerMinute),
  };
}

export const readingTimeKind = pureKind('reading-time', (value) =>
  jsonAnswer(
    readingTime(
      String(value.text),
      value.words_per_minute === undefined
        ? READING_WORDS_PER_MINUTE
        : Number(value.words_per_minute),
    ),
  ),
);
