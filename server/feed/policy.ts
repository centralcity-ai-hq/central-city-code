/*
 * What a Feed request may say (shared/feed.ts "Searched for"). Anyone may post, so every text is
 * cleaned the same way and checked before it is stored:
 *
 * 1. NFC; blank-looking letters (Hangul fillers, the blank Braille pattern) read as spaces;
 *    control characters (except newline and tab in the description), every default-ignorable
 *    code point (bidi and zero-width format characters, variation selectors, tags), other
 *    invisible marks and the Unicode line and paragraph separators dropped; spaces collapsed,
 *    three or more newlines cut to two, trimmed; lengths checked again after cleaning. A title
 *    needs at least two letters or digits; a name without any is no name.
 * 2. Refused (400): a run of more than 12 of one character, more than 30 lines, a credential
 *    (Central City and provider key shapes, a 64-hex private key, 12 or more words in a row from
 *    the BIP-39 list), an email address (also written "(at)" and "(dot)") or a clear phone
 *    number in the public text (contactIn: digits of every script read as ASCII; a number that
 *    starts with + or 00, follows a phone word, or has a phone shape: 3-3-4, an area code in
 *    brackets or a trunk prefix), a link or anything shaped like a web address in the title or
 *    display name, more than two links (with or without a scheme), a link that is not https, has
 *    credentials, an IP-literal, punycode or non-default-port host, a link shortener, or a path
 *    that looks like it carries a secret (server/results/sources.ts); a display name that reads
 *    as Central City or its team (also across word gaps), or that carries 9 or more digits.
 * 3. Held for review (stored, never listed; the poster sees 'held' without a reason): a risky
 *    money request (feedRiskOf), a link to a messenger invite (with or without a scheme), a link
 *    written in look-alike characters, any other run of 9 or more digits in the text or the
 *    reply link (a phone number in another layout or an id; dates, month ranges, times, prices,
 *    price tiers, ranges and version lists are not held), an email address written with spaces
 *    or "at" and "dot", or a link without a scheme to a loopback or private IPv4 address (an
 *    IPv4 range like "10.0.0.0/8" or a version pair like "1.0.2.13/1.0.2.14" is not a link).
 *
 * Link and risk checks run on an NFKC-folded copy (full-width and other compatibility forms read
 * as ASCII, invisible characters dropped), so look-alike spellings cannot slip past them. Links
 * are kept as text, query and fragment dropped (links without a scheme as written). A link
 * without a scheme counts when it reads as a web address: an IP literal, punycode, a port or an
 * address ending ("Node.js/Express" does not). The optional reply handle (checkReply) is a Base
 * address or an https link with no email address or phone number in it (every percent-decoded
 * layer is checked).
 */
import { createHash } from 'node:crypto';
import { getAddress, isAddress } from 'viem';
import { english } from 'viem/accounts';
import { FEED_LIMITS, feedRiskOf } from '../../shared/feed.js';
import { containsCredential } from '../elric/reply.js';
import { foldElricName } from '../elric/names.js';
import { normalizeHost, normalizeSources } from '../results/sources.js';

export const FEED_TEXT = {
  descriptionLinesMax: 30,
  runMax: 12,
  linksMax: 2,
} as const;

/**
 * Marks that show nothing: every default-ignorable code point (format characters, variation
 * selectors, Mongolian variation selectors, tags, the Hangul fillers) and the combining grapheme
 * joiner and Khmer vowels.
 */
const INVISIBLE_MARKS = '\\p{Default_Ignorable_Code_Point}\\u034f\\u17b4\\u17b5';
const DROP_ONE_LINE = new RegExp(`[\\p{Cc}\\p{Cf}\\u2028\\u2029${INVISIBLE_MARKS}]`, 'gu');
const DROP_MULTI_LINE = new RegExp(
  `(?![\\n\\t])[\\p{Cc}\\p{Cf}\\u2028\\u2029${INVISIBLE_MARKS}]`,
  'gu',
);
const DROP_INVISIBLE = new RegExp(`[\\p{Cf}${INVISIBLE_MARKS}]`, 'gu');
/**
 * Letters and symbols that render as a blank: the Hangul fillers and the blank Braille pattern.
 * Read as spaces before the invisible marks are dropped (the fillers are default-ignorable too).
 */
const BLANK_LOOKING = /[\u115f\u1160\u2800\u3164\uffa0]/gu;
/** The checked copy (foldForChecks) drops them as well: nothing hides between two characters. */
const DROP_FOR_CHECKS = new RegExp(
  `[\\p{Cf}${INVISIBLE_MARKS}\\u115f\\u1160\\u2800\\u3164\\uffa0]`,
  'gu',
);

/** One line: every whitespace run (and every blank-looking character) becomes one space. */
export function cleanLine(text: string): string {
  return text
    .normalize('NFC')
    .replace(/[\t\n\r]/g, ' ')
    .replace(BLANK_LOOKING, ' ')
    .replace(DROP_ONE_LINE, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Several lines: spaces collapsed per line, at most one empty line in a row. */
export function cleanText(text: string): string {
  return text
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .replace(BLANK_LOOKING, ' ')
    .replace(DROP_MULTI_LINE, '')
    .split('\n')
    .map((line) => line.replace(/[^\S\n]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export const codePoints = (text: string) => Array.from(text).length;

/** How many letters and digits a cleaned text shows (marks and symbols alone read as blank). */
export const lettersIn = (text: string) => (text.match(/[\p{L}\p{N}]/gu) ?? []).length;

/**
 * Lowercase, NFKC, invisible marks dropped, every run of anything but letters and digits (the
 * blank-looking letters included) one space.
 */
export function foldKey(text: string): string {
  return text
    .normalize('NFKC')
    .replace(BLANK_LOOKING, ' ')
    .replace(DROP_INVISIBLE, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export function contentKey(title: string, description: string): string {
  return createHash('sha256')
    .update(`${foldKey(title)}\n${foldKey(description)}`)
    .digest('hex');
}

export type PolicyResult =
  { ok: true; description: string; held: boolean } | { ok: false; status: 400; message: string };

/**
 * The copy every link and risk check reads: NFKC (full-width letters, digits, colons, slashes and
 * dots become ASCII), invisible and blank-looking characters dropped, and the ideographic full
 * stops browsers accept as a dot.
 */
export const foldForChecks = (text: string) =>
  text
    .normalize('NFKC')
    .replace(DROP_FOR_CHECKS, '')
    .replace(/[。．｡]/g, '.');

/** A scheme link or a www. host anywhere, even glued to a word ("xhttps://..."). */
const URL_IN_TEXT = /(?:https?:\/\/|www\.)[^\s<>"'`]+/gi;
const ANY_LINK = /(?:https?:\/\/|www\.)/i;
/**
 * A bare host with a path ("t.me/abc", "bit.ly/3abc", "-bit.ly/3abc"): the host is group 1. A
 * dash or dot in front does not hide it (the leftmost match starts at the host).
 */
const BARE_HOST_PATH =
  /(?<![\p{L}\p{N}@])((?:[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?\.)+\p{L}{2,24})(?=\/)/giu;
/**
 * A link without a scheme ("a.com/x", "1.2.3.4/x", "xn--abc.com/login", "a.com:8080/x"): group 1
 * the host and port, group 2 the path. Searched with the scheme links taken out.
 */
const BARE_LINK =
  /(?<![\p{L}\p{N}@])((?:(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?\.)+(?:\p{L}{2,24}|xn--[\p{L}\p{N}-]{1,59})|\d{1,3}(?:\.\d{1,3}){3})(?::\d{1,5})?)(\/[^\s<>"'`]*)/giu;
/** A host-shaped word; group 1 is its last label. A dash before or after does not hide it. */
const HOST_SHAPED =
  /(?<![\p{L}\p{N}])(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?\.)+(\p{L}{2,24})(?![\p{L}\p{N}])(\/)?/giu;
/** Endings that make a host-shaped word read as a web address (not "Node.js" or "e.g."). */
const ADDRESS_TLDS = new Set(
  (
    'com net org info biz xyz top site online store shop app dev me co cc io ai ly gg tk ml ga cf ' +
    'gq ru cn su pw link click live vip club pro fun icu buzz life world today money finance cash ' +
    'bet win page web tech space website network email chat cloud services support help ' +
    'de uk us eu ch fr nl'
  ).split(' '),
);
/** Product names shaped like addresses that are fine in a title. */
const NOT_ADDRESSES = new Set(['asp.net', 'ado.net', 'vb.net', 'socket.io']);
const EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.\p{L}{2,}/u;
/**
 * "name (at) example [dot] com", "name-(at)-example-(dot)-com", "name「at」example (.) com",
 * "name&#64;example.com": an email address (emailIn). Any bracket kind counts, and up to eight
 * joining signs on each side belong to the bracketed word; never a + or a bracket, so "(at) +20
 * 100 500 1000" keeps its +.
 */
/** "at" and "dot" in other languages ("arroba", "chiocciola", "punto", "ponto", "点"). */
const AT_WORDS = String.raw`at|ät|arroba|arobase|chiocciola|klammeraffe|bei|艾特|在`;
const DOT_WORDS = String.raw`dot|punkt|point|punto|ponto|period|点|點`;
/** Loose (unbracketed) forms use fewer words: "bei", "在", "point" and "period" are everyday words. */
const LOOSE_AT_WORDS = String.raw`at|ät|arroba|arobase|chiocciola|klammeraffe|艾特`;
const LOOSE_DOT_WORDS = String.raw`dot|punkt|punto|ponto|点|點`;
// A bracketed word ("(at)", "「dot」", also in quotation marks) spells an address: refused with an
// email ending. A bracketed sign ("(@)", "[.]") may be prose about the sign ("Use (@) and (.) in
// the regex"): held, never refused.
const BRACKETED_AT = new RegExp(
  String.raw`[\s._/~*|:-]{0,8}(?:[\p{Ps}<\\]\s*(?:${AT_WORDS})\s*[\p{Pe}>\\]|[\p{Pi}]\s*(?:${AT_WORDS})\s*[\p{Pf}])[\s._/~*|:-]{0,8}|&#0*64;|&#x0*40;|&commat;`,
  'giu',
);
const BRACKETED_DOT = new RegExp(
  String.raw`[\s._/~*|:-]{0,8}(?:[\p{Ps}<\\]\s*(?:${DOT_WORDS})\s*[\p{Pe}>\\]|[\p{Pi}]\s*(?:${DOT_WORDS})\s*[\p{Pf}])[\s._/~*|:-]{0,8}|&#0*46;|&#x0*2e;|&period;`,
  'giu',
);
const BRACKETED_AT_SIGN = /[\s._/~*|:-]{0,8}[\p{Ps}<\\]\s*@\s*[\p{Pe}>\\][\s._/~*|:-]{0,8}/gu;
const BRACKETED_DOT_SIGN = /[\s._/~*|:-]{0,8}[\p{Ps}<\\]\s*\.\s*[\p{Pe}>\\][\s._/~*|:-]{0,8}/gu;
/** Endings of email addresses: the address endings and the country endings mail lives under. */
const EMAIL_TLDS = new Set([
  ...ADDRESS_TLDS,
  ...(
    'at be dk se no fi ie es pt it pl cz sk hu ro bg gr tr il in jp kr cn tw hk sg my id th ' +
    'vn ph au nz ca mx br ar cl pe za ng ke ae sa edu gov mil int'
  ).split(' '),
]);
/** Every email address shape in a text. */
const EMAILS = new RegExp(EMAIL.source, 'gu');
/**
 * An email address with an email ending in its domain ("name@example.com", also
 * an address glued to the next word, such as a name, an at sign, example.com and then "Thanks"; never an image name such as icon, an at sign, 2x.png). Only text with an '@' is scanned.
 */
const knownEmail = (text: string) =>
  text.includes('@') &&
  Array.from(text.matchAll(EMAILS), (match) => match[0]).some((address) =>
    address
      .slice(address.indexOf('@') + 1)
      .split('.')
      .slice(1)
      .some((label) => EMAIL_TLDS.has(label.toLowerCase())),
  );
/** Single letters with a space between ("n a m e"): one word for the loose email check. */
const SPACED_LETTERS = /(?<![\p{L}\p{N}])(?:[\p{L}\p{N}] ){2,}[\p{L}\p{N}](?![\p{L}\p{N}])/gu;
/** A dot with spaces before an address ending ("example . com"). */
const SPACED_DOT = new RegExp(
  String.raw`\s*\.\s*(?=(?:${[...ADDRESS_TLDS].join('|')})(?![\p{L}\p{N}]))`,
  'giu',
);
/**
 * Dates are not phone numbers: 2026-10-14, 14.10.2026, 14/10/2026, 10/14/2026, 2026/10/14 and
 * months like 05/2026 or 2026-05 (real days, months and years only, so "01-70-1234" stays a
 * number).
 */
const DAY_OF = String.raw`(?:0?[1-9]|[12]\d|3[01])`;
const MONTH_OF = String.raw`(?:0?[1-9]|1[0-2])`;
const YEAR_OF = String.raw`(?:19|20)\d\d`;
const FULL_DATE = String.raw`${YEAR_OF}-${MONTH_OF}-${DAY_OF}|(?:${DAY_OF}[./-]${MONTH_OF}|${MONTH_OF}[./-]${DAY_OF})[./-]${YEAR_OF}|${YEAR_OF}[./]${MONTH_OF}[./]${DAY_OF}`;
const MONTH_DATE = String.raw`${MONTH_OF}[./-]${YEAR_OF}|${YEAR_OF}[./-]${MONTH_OF}`;
/** No digit right after an item, nor after one separator ("10.15" is no item of "10.15.7"). */
const ITEM_END = String.raw`(?![.,:']?\d)`;
/**
 * One item of a number chain, the longest reading first: group 1 a date or a month, 2 a time
 * ("09.00", "13:30"), 3 a number with thousands separators ("10.000", "1'500'000,50",
 * "10 000"), 4 a version or an IPv4 address or block ("1.0.2.13", "192.168.0.0/16"), 5 a decimal
 * ("25.50"), 6 plain digits.
 */
const NUMBER_ITEM = new RegExp(
  String.raw`(${FULL_DATE}|${MONTH_DATE})${ITEM_END}|((?:[01]?\d|2[0-4])[.:][0-5]\d)${ITEM_END}|(\d{1,3}(?:[.,']\d{3})+(?:[.,]\d{1,2})?${ITEM_END}|\d{1,3}(?: \d{3})+(?:[.,]\d{1,2})?(?! ?\d))|(\d+(?:\.\d+){2,}(?:\/\d{1,2}(?![.\d]))?)${ITEM_END}|(\d+[.,]\d{1,2})${ITEM_END}|(\d+)`,
  'y',
);
/**
 * Between two digits of a number: up to four characters that are neither letters nor digits
 * ("0170 / 123", "(555)-123", "+1 (555) 123", "10.000 - 20.000", "555_123_4567", "555 -- 123",
 * "555 🔸 123"). Every dash is a hyphen and every line break a space first (contactCopy,
 * numberCopy).
 */
const NUMBER_GAP = String.raw`(?:[^\p{L}\p{N}]{1,4})`;
/** Nine or more digits joined by gaps; group 1 is the number. */
const NUMBER_CHAIN = new RegExp(
  String.raw`(?:^|[^\p{L}\p{N}+])(\+?\d(?:${NUMBER_GAP}?\d){8,})(?![\p{L}\p{N}])`,
  'gu',
);
/** Words that dial a number ("Tel.", "Phone", "Handynummer", "Mon portable", "手机"). */
const DIAL_WORDS = String.raw`tel|tél|tele?fon|telefono|teléfono|telefone|telephone|téléphone|telefonnummer|rufnummer|handynummer|mobilnummer|phone|phones|ph|fax|mobile?|mob|handy|natel|cell|celular|cellulare|móvil|movil|portable|ruf|tlf|ring|call|тел|телефон|電話|电话|手机|☎|📞`;
/** Words that name a channel or a contact, not only a dial ("SMS to ...", "Contact: ..."). */
const CHANNEL_WORDS = String.raw`whats\s?app|sms|signal|telegram|viber|wechat|微信同号|微信|hotline|contact|kontakt|text\s+(?:me|us)|reach\s+(?:me|us)|imessage|(?:my|mera|our|mi|mon|meine)\s+(?:(?:phone|mobile|cell|whatsapp)\s+)?(?:number|nummer|numéro|número|nombor)|मेरा\s+नंबर`;
/** A word for "number" between the phone word and the number ("Phone number: ..."). */
const NUMBER_WORDS = String.raw`numbers?|nummer|numero|número|numéro|no|nr`;
/**
 * A word that says a phone number follows, right before it or two short words before it ("Tel.
 * 030 1234567", "tel:5551234567", "Whatsapp me 555 1234567", "call me at 555 1234567").
 */
// The signs between a phone word and its number ("Tel.: ", "WhatsApp: $800 ...").
const PHONE_WORD_BEFORE = new RegExp(
  String.raw`(?:^|[^\p{L}])(?:${DIAL_WORDS}|${CHANNEL_WORDS})\.?(?:[\s:#/.-]{1,3}(?:\p{L}{1,4}|${NUMBER_WORDS})){0,2}[\s:#/.$-]{0,3}$`,
  'iu',
);
/** A phone word right before the number, or only a word for "number" between ("WhatsApp 34 ..."). */
const PHONE_WORD_RIGHT_BEFORE = new RegExp(
  String.raw`(?:^|[^\p{L}])(?:${DIAL_WORDS}|${CHANNEL_WORDS})\.?(?:[\s:#/.-]{1,3}(?:${NUMBER_WORDS}))?[\s:#/.$-]{0,3}$`,
  'iu',
);
/** A dial word right before the number, or with only a word for "number" between ("Tel. 800 ..."). */
const DIAL_WORD_RIGHT_BEFORE = new RegExp(
  String.raw`(?:^|[^\p{L}])(?:${DIAL_WORDS})\.?(?:[\s:#/.-]{1,3}(?:${NUMBER_WORDS}))?[\s:#/.$-]{0,3}$`,
  'iu',
);
/** A trunk-prefix area code: 0 then one to four digits, never 00 ("030", "0170", "06"). */
const AREA_CODE = /^0[1-9]\d{0,3}$/;
/**
 * The copy the contact checks read (from foldForChecks): every dash and minus a hyphen, middle
 * dots, bullets and the hyphenation point a dot ("name@example‧com", "555–123–4567"), slash
 * look-alikes a slash, and the heavy plus signs NFKC keeps ("➕41") a plus.
 */
const contactCopy = (folded: string) =>
  folded
    .replace(/[\p{Pd}−⁃˗]/gu, '-')
    .replace(/[·‧∙⋅•・⸱]/gu, '.')
    .replace(/[⁄∕⧸]/gu, '/')
    .replace(/[➕✚✙\u{1F7A1}-\u{1F7A7}]/gu, '+');
const PRIVATE_KEY = /(?:^|[^0-9a-f])(?:0x)?[0-9a-f]{64}(?![0-9a-f])/i;
const BIP39 = new Set<string>(english);
const SHORTENERS = new Set([
  'bit.ly',
  't.co',
  'tinyurl.com',
  'goo.gl',
  'is.gd',
  'ow.ly',
  'buff.ly',
  'rebrand.ly',
  'cutt.ly',
  'shorturl.at',
  'tiny.cc',
  'rb.gy',
]);
const MESSENGERS = new Set(['t.me', 'telegram.me', 'wa.me', 'chat.whatsapp.com', 'discord.gg']);

/**
 * Display names an anonymous poster may not take: anything reading as Central City, Elric or a
 * staff role (look-alike characters folded).
 */
const RESERVED_SKELETONS = ['centralcity', 'elric', 'official', 'moderator'].map(foldElricName);
const RESERVED_WORDS = new Set(
  ['support', 'admin', 'administrator', 'staff', 'team', 'mod', 'mods', 'helpdesk'].map(
    foldElricName,
  ),
);
const RESERVED_PAIRS = new Set(['help desk']);

export function reservedDisplayName(name: string): boolean {
  const skeleton = foldElricName(name);
  if (RESERVED_SKELETONS.some((reserved) => skeleton.includes(reserved))) return true;
  // Each word, each run of single letters read as one word ("S u p p o r t"), and the two-word
  // spellings of a reserved word ("Help Desk", "H e l p Desk", "Help D e s k"), with and
  // without the runs joined. Short names like "Mo D" or "Sup Port" stay free.
  const words = foldKey(name).split(' ').filter(Boolean);
  const joined: string[] = [];
  let letters = '';
  for (const word of [...words, '']) {
    if (Array.from(word).length === 1) letters += word;
    else {
      if (letters) joined.push(letters);
      letters = '';
      if (word) joined.push(word);
    }
  }
  for (const list of [words, joined])
    for (let i = 0; i + 1 < list.length; i += 1)
      if (RESERVED_PAIRS.has(`${list[i]} ${list[i + 1]}`)) return true;
  return [...words, ...joined].some((word) => RESERVED_WORDS.has(foldElricName(word)));
}

/** True when the text holds a link or a word shaped like a web address. */
function addressShaped(text: string): boolean {
  const folded = foldForChecks(text);
  if (ANY_LINK.test(folded)) return true;
  for (const match of folded.matchAll(HOST_SHAPED)) {
    if (NOT_ADDRESSES.has(match[0].toLowerCase())) continue;
    if (match[2] === '/' || ADDRESS_TLDS.has(match[1]!.toLowerCase())) return true;
  }
  return false;
}

function longRun(text: string): boolean {
  let run = 0;
  let last = '';
  for (const char of text) {
    if (char === last && !/\s/.test(char)) {
      run += 1;
      if (run > FEED_TEXT.runMax) return true;
    } else {
      run = 1;
      last = char;
    }
  }
  return false;
}

function seedPhrase(text: string): boolean {
  let run = 0;
  for (const word of text.toLowerCase().split(/[^a-z]+/)) {
    if (!word) continue;
    run = BIP39.has(word) ? run + 1 : 0;
    if (run >= 12) return true;
  }
  return false;
}

/**
 * Whether digit groups read as a phone number, not a budget, price list, range, version list,
 * time table, invoice number or address block: a North American 3-3-4 run ("555 123 4567",
 * "1-800-555-1234"), an area code in brackets ("(555) 123-4567"), or a trunk-prefix area code
 * followed by the subscriber number ("0170 / 123 45 67", "01-70-1234 567", "06 12 34 56 78") with
 * 10 to 15 digits, where no later group of three or more starts with 0 (postcode ranges like
 * "01067 - 01099") and a group has three or more digits or every gap is the same (a time table
 * like "09.00-12.30 / 13.30-17.00" mixes its gaps). Reads ASCII digits (numberCopy).
 */
function phoneShaped(number: string): boolean {
  const groups = number.match(/\d+/g) ?? [];
  // 24-hour times without a colon are never an area code ("Shifts 0700-1900, 1900-0700").
  if (groups.length > 1 && groups.every((group) => /^(?:[01]\d|2[0-4])[0-5]\d$/.test(group)))
    return false;
  const gaps = number.split(/\d+/).slice(1, -1);
  const lengths = groups.map((group) => group.length);
  for (let i = 0; i + 2 < lengths.length; i += 1)
    if (lengths[i] === 3 && lengths[i + 1] === 3 && lengths[i + 2] === 4) return true;
  if (/(?:^|\D)\d{2,5}[)\]]/.test(number)) return true;
  for (let i = 0; i < groups.length; i += 1) {
    if (!AREA_CODE.test(groups[i]!)) continue;
    let digits = groups[i]!.length;
    let long = groups[i]!.length >= 3;
    for (let k = i + 1; k < groups.length; k += 1) {
      const group = groups[k]!;
      if (group.length >= 3 && group.startsWith('0')) break;
      digits += group.length;
      long ||= group.length >= 3;
      if (digits > 15) break;
      if (digits < 10) continue;
      const sameGaps = gaps.slice(i, k).every((gap) => gap === gaps[i]);
      if (long || sameGaps) return true;
    }
  }
  return false;
}

/** A sign joining the groups of a dialled number, spaced or not: never a comma. */
const DIAL_GAP = String.raw`(?: ?[-._~:|*/] ?| )`;
/** A whole North American number, its area code and exchange starting with 2 to 9. */
const NORTH_AMERICAN = new RegExp(
  String.raw`^(?:1${DIAL_GAP})?[2-9]\d\d${DIAL_GAP}[2-9]\d\d${DIAL_GAP}\d{4}$`,
);
const DIAL_GAP_ONLY = new RegExp(String.raw`^${DIAL_GAP}$`);
/**
 * A North American number standing apart inside a longer chain: its two gaps tight, the gaps
 * around it different ("250-300-1000, 1500"), never one step of a longer list ("200 300 400 500
 * 1000").
 */
function northAmericanIn(number: string): boolean {
  if (NORTH_AMERICAN.test(number)) return true;
  const groups = number.match(/\d+/g) ?? [];
  const gaps = number.split(/\d+/).slice(1, -1);
  for (let i = 0; i + 2 < groups.length; i += 1)
    if (
      /^[2-9]\d\d$/.test(groups[i]!) &&
      /^[2-9]\d\d$/.test(groups[i + 1]!) &&
      /^\d{4}$/.test(groups[i + 2]!) &&
      DIAL_GAP_ONLY.test(gaps[i]!) &&
      DIAL_GAP_ONLY.test(gaps[i + 1]!) &&
      (i === 0 || gaps[i - 1] !== gaps[i]) &&
      (i + 3 === groups.length || gaps[i + 2] !== gaps[i + 1])
    )
      return true;
  return false;
}
/**
 * A trunk-prefix number in three or more groups joined by a space, dot, dash or slash ("06 08 10
 * 12 14", "030/40 50 60 70", "0800 900 1000"); never a two-number range ("01067 - 01099").
 */
const TRUNK_DIALLED = /^0[1-9]\d*(?: ?[ ./-] ?\d+){2,}$/;
/** A word before a chain that says it prices or sizes something ("Budget 250 / 500 / 1000"). */
const TIER_CONTEXT_BEFORE =
  /(?:^|[^\p{L}])(?:budgets?|prices?|pricing|preise?|precios?|prix|tarifs?|tiers?|packages?|pakete?|packs?|plans?|quantit(?:y|ies)|qty|sizes?|größen|volumes?|bundles?|options?|levels?|stufen|costs?|kosten|fees?|amounts?|orders?)(?![\p{L}])[^.\n]{0,30}$/iu;
/** Currencies, written before or after an amount. */
const CURRENCIES = String.raw`usdc?|eur|euros?|chf|fr|sfr|franken|francs?|gbp|pounds?|cad|aud|nzd|jpy|yen|円|cny|rmb|yuan|inr|rs|sek|nok|dkk|kr|pln|zł|zl|czk|huf|brl|mxn|pesos?|rub|руб|try|zar|sgd|hkd|krw|eth|btc|sats?|dollars?|cents?`;
/** A currency or a unit next to a number chain: it counts something ("USD 250 500 1000"). */
// A dot after a currency only in an abbreviation ("Fr."), never a sentence end ("200 USD. 310 ...").
const COUNTED_BEFORE = new RegExp(
  String.raw`(?:[$€£¥₹]|r\$|(?<!\p{L})(?:${CURRENCIES})(?:(?<=fr|sfr|rs|kr)\.)?)\s?\)?\s?:?\s?$`,
  'iu',
);
// A unit counts only when no digit follows it ("hours 9-5" is a time, "x 12" an extension), and
// 'per' only before what it counts per ("per month", never "per text").
const COUNTED_AFTER = new RegExp(
  String.raw`^[\s-]?\(?\s?(?:[$€£¥₹%]|(?:${CURRENCIES}|words?|wörter|zeichen|pages?|seiten|pieces?|pcs|stück|stk|items?|units?|products?|skus?|users?|nutzer|kunden|seats?|members?|customers?|clients?|patients?|people|participants?|students?|employees?|agents?|riders?|dancers?|guests?|credits?|tokens?|calls?|requests?|tickets?|orders?|listings?|posts?|articles?|reviews?|photos?|banners?|logos?|apps?|sites?|domains?|accounts?|devices?|chats?|msgs?|messages?|emails?|numbers?|sms|minutes?|minuten|mins?|hours?|stunden|hrs?|days?|tage|weeks?|months?|monate|years?|jahre|ms|sec|seconds?|px|pixels?|dpi|kb|mb|gb|tb|kbps|mbps|gbps|mbit|gbit|hz|khz|mhz|ghz|g|kg|mg|ml|km|cm|mm|sqft|followers?|views?|subscribers?|installs?|downloads?|coins?|points?|leads?|rows?|records?|images?|videos?|files?|chars?|characters?|tiers?|plans?|packs?|packages?|per\s+(?:month|year|week|day|hour|minute|min|call|request|user|page|word|item|unit|piece|seat|person|head|night|mo|yr|hr|1000|k))\.?)(?![\p{L}\p{N}])(?![\s:-]{0,2}\d)`,
  'iu',
);

/**
 * Words right after a number that say it is called ("800-900-1000 calls welcome", "... x 12",
 * "USD 250 300 1000 call me", "650 700 3000 is my cell").
 */
const PHONE_HINT_AFTER = new RegExp(
  String.raw`^[^\p{L}\p{N}]{0,3}(?:\p{L}{1,4}[^\p{L}\p{N}]{1,3}){0,2}(?:calls?|x|ext|msgs?|messages?|numbers?|${DIAL_WORDS}|${CHANNEL_WORDS})(?!\p{L})`,
  'iu',
);

/**
 * Whether round bare digits that read as a tier (readsAsNumbers) could still be a number to call:
 * 'contact' for an area code in brackets before a 6-to-9-digit rest, whatever follows ("(250)
 * 300-1000", "{250} 300 1000 USD") or a phone word before a whole North American number ("Tel.
 * 800 900 1000"); 'hold' for that number alone ("250-300-1000"), with a unit after a phone word
 * or before a call word ("Call 250 300 1000 USD", "800-900-1000 calls"), or a phone word before
 * other groups of two or more digits ("Call me 1000 2000 3000"); null for a tier: a currency or a
 * unit next to it ("250 500 1000 EUR", "300-500-1000 Mbps"), years, single-digit steps ("Ring
 * size 6 7 8 9 10 11"), amounts with separators, or no phone sign at all.
 */
function dialledTier(numbers: string, start: number, end: number, phoneWord: boolean) {
  const number = numbers.slice(start, end);
  const { items } = numberItems(number);
  if (!items.every((item) => item.kind === 'digits')) return null;
  if (items.every((item) => /^(?:19|20)\d\d$/.test(item.raw))) return null;
  // An area code in brackets is dialled whatever follows ("(250) 300-1000 USD").
  const rest = /^\d{2,5}\s?[\p{Pe}\p{Pf}>\\]\s?(?:[-._~:|*]\s?)?(\d.*)$/u.exec(number);
  if (
    /[\p{Ps}\p{Pi}<\\]\s?$/u.test(numbers.slice(0, start)) &&
    rest &&
    /^\d{6,9}$/.test(rest[1]!.replace(/\D/g, ''))
  )
    return 'contact';
  const before = numbers.slice(0, start);
  const after = numbers.slice(end);
  const digits = number.replace(/\D/g, '').length;
  // Shaped like a number to dial: a whole North American number, or a trunk prefix and 9 to 12
  // digits in one tight run (never a slash or comma list: "Sizes 06 / 08 / 10" stays a list).
  const dialShape =
    northAmericanIn(number) || (TRUNK_DIALLED.test(number) && digits >= 9 && digits <= 11);
  const hinted = phoneWord || PHONE_HINT_AFTER.test(after);
  // A unit opens a tier, but a unit is one word to add after a number: a number shaped to dial
  // after a phone word or before a call word is held ("Call 250 300 1000 USD").
  if (COUNTED_BEFORE.test(before) || COUNTED_AFTER.test(after))
    return dialShape && hinted ? 'hold' : null;
  // Refused only right after a dial word ("Tel. 800 900 1000", "Mon portable : 06 08 10 12 14");
  // a channel word or words between ("SMS to 250 500 1000 customers") hold it; with no phone sign
  // a word that prices it keeps it a tier ("Budget 250 / 500 / 1000").
  if (dialShape) {
    if (DIAL_WORD_RIGHT_BEFORE.test(before)) return 'contact';
    return !hinted && TIER_CONTEXT_BEFORE.test(before) ? null : 'hold';
  }
  return phoneWord && items.every((item) => item.raw.length >= 2) ? 'hold' : null;
}

/** The international call prefix: 00 and a country code ("0049 170 ...", "00 41 44 ..."). */
const internationalPrefix = (groups: readonly string[]) =>
  groups.length > 1 &&
  (/^00[1-9]\d{0,2}$/.test(groups[0]!) || (groups[0] === '00' && /^[1-9]/.test(groups[1]!))) &&
  // Never zero-padded ids in a rising list ("Episodes 001 002 003").
  !(
    groups.every((group) => group.length === groups[0]!.length) &&
    groups.every((group, i) => i === 0 || Number(group) > Number(groups[i - 1]))
  );

type NumberItem = {
  kind: 'date' | 'time' | 'amount' | 'version' | 'digits';
  raw: string;
  value: number;
};

/** The value of an amount: thousands separators dropped, one or two decimals kept. */
function amountValue(raw: string): number {
  const cents = /[.,](\d{1,2})$/.exec(raw);
  const whole = (cents ? raw.slice(0, cents.index) : raw).replace(/\D/g, '');
  return Number(whole) + (cents ? Number(`0.${cents[1]}`) : 0);
}

/** The items of a number chain (NUMBER_ITEM) and the gaps between them. */
function numberItems(number: string): { items: NumberItem[]; gaps: string[] } {
  const items: NumberItem[] = [];
  const gaps: string[] = [];
  let gap = '';
  let at = 0;
  while (at < number.length) {
    if (!/\d/.test(number[at]!)) {
      gap += number[at];
      at += 1;
      continue;
    }
    NUMBER_ITEM.lastIndex = at;
    const match = NUMBER_ITEM.exec(number)!;
    const raw = match[0];
    if (items.length) gaps.push(gap);
    gap = '';
    at = NUMBER_ITEM.lastIndex;
    if (match[1]) items.push({ kind: 'date', raw, value: 0 });
    else if (match[2]) {
      const [hours, minutes] = raw.split(/[.:]/);
      items.push({ kind: 'time', raw, value: Number(hours) + Number(minutes) / 100 });
    } else if (match[3] || match[5]) items.push({ kind: 'amount', raw, value: amountValue(raw) });
    else if (match[4]) items.push({ kind: 'version', raw, value: 0 });
    else items.push({ kind: 'digits', raw, value: Number(raw) });
  }
  return { items, gaps };
}

const rising = (values: readonly number[]) =>
  values.every((value, i) => i === 0 || value >= values[i - 1]!);

/**
 * A version in a version list: three or four parts, no leading zeros, at most seven digits
 * ("1.0.2.13").
 */
const VERSION = /^(?=(?:\.?\d){3,7}$)[1-9]?\d(?:\.(?:0|[1-9]\d{0,2})){2,3}$/;

/**
 * Whether a number chain reads as something other than contact details or an id, so it is
 * neither held nor refused (a + or 00 prefix is refused before this is asked):
 * - dates, months and times, the times rising ("05/2026 - 08/2026", "09.00–12.30 / 13.30–17.00");
 * - prices and tiers: amounts with decimals or thousands separators and round whole numbers (a
 *   multiple of 10 or 25), rising, each at most ten times the one before ("25.50 / 30.00 / 45.00",
 *   "10.000 – 20.000", "250 / 500 / 1000", "25 / 50 / 100 / 250 / 1000");
 * - one round amount ("1.000.000.000");
 * - a range of two numbers of the same length that share their first two digits, joined by a dash
 *   ("10115 - 10999", "01067 - 01099");
 * - three or more whole numbers in even steps of 1 to 5 or a multiple of 5 ("06 / 08 / 10 / 12");
 * - two or more versions of one major version, rising ("1.0.2.13/1.0.2.14");
 * - IPv4 addresses on a local network and network blocks ("192.168.0.0/16").
 */
function readsAsNumbers(number: string): boolean {
  const { items, gaps } = numberItems(number);
  const kinds = new Set(items.map((item) => item.kind));
  const values = items.map((item) => item.value);
  if (items.every((item) => networkAddress(item.raw))) return true;
  if ([...kinds].every((kind) => kind === 'date' || kind === 'time'))
    return rising(items.filter((item) => item.kind === 'time').map((item) => item.value));
  if (kinds.has('date')) return false;
  if (kinds.has('version')) {
    if (kinds.size > 1 || items.length < 2 || !items.every((item) => VERSION.test(item.raw)))
      return false;
    const parts = items.map((item) => item.raw.split('.').map(Number));
    return (
      parts.every((part) => part[0] === parts[0]![0]) &&
      parts.every((part, i) => i === 0 || compareParts(part, parts[i - 1]!) >= 0)
    );
  }
  if (items.length === 1)
    return items[0]!.kind === 'amount' && /\d{3}$/.test(items[0]!.raw) && values[0]! % 1000 === 0;
  const priced = items.every(
    (item) =>
      item.value > 0 &&
      (item.kind !== 'digits' ||
        (!item.raw.startsWith('0') && (item.value % 10 === 0 || item.value % 25 === 0))),
  );
  if (
    priced &&
    rising(values) &&
    values.every((value, i) => i === 0 || value <= values[i - 1]! * 10)
  )
    return true;
  if (!kinds.has('digits') || kinds.size > 1) return false;
  const [first, second] = items as [NumberItem, NumberItem];
  if (
    items.length === 2 &&
    gaps[0]!.includes('-') &&
    first.raw.length === second.raw.length &&
    first.raw.length <= 8 &&
    first.raw.slice(0, 2) === second.raw.slice(0, 2) &&
    first.value < second.value &&
    // A tight 5-5 pair starting 6 to 9 is how an Indian mobile is written ("98450-98765").
    !(gaps[0] === '-' && first.raw.length === 5 && /^[6-9]/.test(first.raw))
  )
    return true;
  const step = second.value - first.value;
  return (
    items.length >= 3 &&
    step > 0 &&
    (step <= 5 || step % 5 === 0) &&
    values.every((value, i) => i === 0 || value - values[i - 1]! === step)
  );
}

/**
 * An IPv4 address on a local network (LOCAL_IP) or a network block of /30 or wider with its host
 * bits zero ("192.168.0.0/16", "52.14.200.0/24"): text, never contact details.
 */
function networkAddress(raw: string): boolean {
  const [address, prefix] = raw.split('/') as [string, string | undefined];
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => part > 255)) return false;
  if (prefix === undefined) return LOCAL_IP.test(address);
  const bits = Number(prefix);
  const value = parts.reduce((sum, part) => sum * 256 + part, 0);
  return bits <= 30 && value % 2 ** (32 - bits) === 0;
}

function compareParts(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** Decimal digits of every script read as ASCII: Unicode encodes each set as 0 to 9 in a row. */
const DECIMAL_DIGIT = /^\p{Nd}$/u;
const asciiDigits = new Map<string, string>();
function asciiDigit(char: string): string {
  let ascii = asciiDigits.get(char);
  if (ascii === undefined) {
    const code = char.codePointAt(0)!;
    let zero = code;
    while (zero > 0 && DECIMAL_DIGIT.test(String.fromCodePoint(zero - 1))) zero -= 1;
    ascii = String((code - zero) % 10);
    asciiDigits.set(char, ascii);
  }
  return ascii;
}
/** Circled digits NFKC keeps ("❶", "➀", "➊", "⓵", "⓫"): their numbers. */
function circledDigit(char: string): string {
  const code = char.codePointAt(0)!;
  if (code >= 0x2776) return String(((code - 0x2776) % 10) + 1);
  if (code === 0x24ff) return '0';
  if (code >= 0x24f5) return String(code - 0x24f4);
  return String(code - 0x24eb + 11);
}
/** A Base address or transaction hash: hex, never read as a number. */
const HEX_ID = /(?<![\p{L}\p{N}])0x(?:[0-9a-f]{64}|[0-9a-f]{40})(?![\p{L}\p{N}])/giu;

/**
 * The copy the number checks read (from contactCopy): every digit ASCII, combining marks after a
 * digit dropped ("5⃣"), Base addresses and hashes blanked, O, o, I and l read as digits in a word
 * of digits ("O17O"), a space between letters and digits ("Tel5551234567"), every line break a
 * space, and a sign repeated, with or without a space between, read once ("555 -- 123" and
 * "555 - - 123" read "555 - 123").
 */
function numberCopy(text: string): string {
  return text
    .replace(/(?![0-9])\p{Nd}/gu, asciiDigit)
    .replace(/[\u2776-\u2793\u24eb-\u24ff]/gu, circledDigit)
    .replace(/(\d)\p{M}+/gu, '$1')
    .replace(HEX_ID, ' ')
    .replace(/[\p{L}\p{N}]+/gu, (word) =>
      /^[\dOoIl]+$/.test(word) && /\d.*\d/.test(word)
        ? word.replace(/[Oo]/g, '0').replace(/[Il]/g, '1')
        : word,
    )
    .replace(/(?<=\p{L})(?=\d)|(?<=\d)(?=\p{L})/gu, ' ')
    .replace(/[’‘]/gu, "'")
    .replace(/、/gu, ',')
    .replace(/\s/gu, ' ')
    .replace(/([^\p{L}\p{N}])(?: ?\1)+/gu, '$1');
}

/**
 * An email address written loosely, held, not refused: with spaces ("name @ example . com",
 * "n a m e@example.com") or with "at" and "dot" as words ("name at example dot com"); joined by
 * other signs or in other languages ("name-at-example-dot-com", "name+at+example+dot+com",
 * "nome chiocciola libero punto it") only with an email ending, so "look-at-this.html",
 * "created_at_utc.csv", "Docs at: docs.example.com" and the domain list "firma.at / firma.de"
 * stay open. A joined "at" needs a sign (not only a space) on both sides.
 */
const LOOSE_AT = new RegExp(
  String.raw`\.(?:${LOOSE_AT_WORDS})\.|(?<=[\p{L}\p{N}])(?:\s?[_/~*|+-]{1,3}\s?|\s\.\s?)(?:${LOOSE_AT_WORDS})\s?[._/~*|+-]{1,3}\s?(?=[\p{L}\p{N}])|\s+(?:${LOOSE_AT_WORDS})\s+`,
  'giu',
);
const LOOSE_DOT = new RegExp(
  String.raw`[\s._/~*|:+-]{1,4}(?:${LOOSE_DOT_WORDS})[\s._/~*|:+-]{1,4}`,
  'giu',
);
/** Whether a text has an '@' or an "at" word at all (the email scans are skipped otherwise). */
const AT_SIGN = new RegExp(String.raw`@|(?:^|[^\p{L}])(?:${LOOSE_AT_WORDS})(?![\p{L}])`, 'iu');
function looseEmail(text: string): boolean {
  if (!AT_SIGN.test(text)) return false;
  const letters = text.replace(SPACED_LETTERS, (run) => run.replace(/ /g, ''));
  const close = (joined: string) => joined.replace(/\s*@\s*/gu, '@').replace(SPACED_DOT, '.');
  return (
    EMAIL.test(
      close(letters.replace(/\s+(?:at|ät)\s+/giu, '@').replace(/\s+(?:dot|punkt)\s+/giu, '.')),
    ) || knownEmail(close(letters.replace(LOOSE_AT, '@').replace(LOOSE_DOT, '.')))
  );
}

/**
 * Contact details in a folded text: 'contact' for an email address or a clear phone number
 * (refused), 'hold' for an email address written loosely or any other run of 9 or more digits
 * (held for review: a phone number in another layout, or an id), null for none. A clear phone
 * number starts with + or 00, follows a phone word (tel, phone, call, whatsapp ...), or (in
 * public text) has a phone shape (phoneShaped) or 10 to 15 digits in one group; in a reply link
 * these shapes are held, since a listing id looks the same. A number that reads as dates,
 * prices, tiers, a range, versions or a network (readsAsNumbers) is neither, unless its round
 * bare digits could be dialled (dialledTier). Every number is looked at, not only the first.
 */
function contactIn(folded: string, where: 'text' | 'reply' = 'text'): 'contact' | 'hold' | null {
  const copy = contactCopy(folded);
  // An address with an email ending is refused, written plainly or with bracketed words; any other
  // '@' shape is held (an image name such as icon, an at sign, 2x.png).
  const worded = copy.replace(BRACKETED_AT, '@').replace(BRACKETED_DOT, '.');
  const text = worded.replace(BRACKETED_AT_SIGN, '@').replace(BRACKETED_DOT_SIGN, '.');
  if (knownEmail(copy) || (worded !== copy && knownEmail(worded))) return 'contact';
  let found: 'hold' | null =
    (copy.includes('@') && EMAIL.test(copy)) ||
    (text !== copy && text.includes('@') && EMAIL.test(text)) ||
    looseEmail(text)
      ? 'hold'
      : null;
  const numbers = numberCopy(text);
  for (const match of numbers.matchAll(NUMBER_CHAIN)) {
    const number = match[1]!;
    const start = match.index + match[0].length - number.length;
    const end = match.index + match[0].length;
    // '+1000, +2500, +5000 followers': a '+' before each round amount is an increment, not a
    // country prefix ('+41 44 ..., +41 79 ...' stays a prefix).
    const increments = number.match(/\+\d+/g) ?? [];
    const plusList =
      increments.length > 1 && increments.every((plus) => Number(plus.slice(1)) % 100 === 0);
    // '+2,000,000,000': thousands commas make an amount; a phone number never has them.
    const plusAmount = /^\+\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(number);
    if (
      (number.startsWith('+') && !plusList && !plusAmount) ||
      internationalPrefix(number.match(/\d+/g) ?? [])
    )
      return 'contact';
    const before = numbers.slice(0, start);
    const phoneWord = PHONE_WORD_BEFORE.test(before);
    if (readsAsNumbers(number)) {
      // In a reply link a run that reads as numbers may still be an id or a number: held.
      if (where === 'reply') {
        found = 'hold';
        continue;
      }
      // One round amount of 9 or more digits right after a phone word is a number ("Tel. 600 300
      // 000"), unless thousands commas, a currency or a unit say what it counts.
      if (
        PHONE_WORD_RIGHT_BEFORE.test(before) &&
        numberItems(number).items.length === 1 &&
        number.replace(/\D/g, '').length >= 9 &&
        !number.replace(/\D/g, '').endsWith('000000') &&
        !number.includes(',') &&
        !COUNTED_BEFORE.test(before) &&
        !COUNTED_AFTER.test(numbers.slice(end))
      )
        return 'contact';
      const dialled = dialledTier(numbers, start, end, phoneWord);
      if (dialled === 'contact') return 'contact';
      if (dialled === 'hold') found = 'hold';
      continue;
    }
    // A list ("375, 768, 1024, 1440", "256 / 512 / 1024") or a unit after it ("256 512 1024
    // tokens") makes a phone-shaped chain held, not refused; a unit after a chain that is not
    // phone-shaped opens it ("phones 128 256 512 GB").
    const after = numbers.slice(end);
    const gaps = number.match(/\D+/g) ?? [];
    const list = gaps.length > 0 && gaps.every((gap) => /^(?:, |; | \/ )$/.test(gap));
    const counted = COUNTED_BEFORE.test(before) || COUNTED_AFTER.test(after);
    // One long run glued to letters is an id ("INV2026101300", "1Z999AA10123456784"): held.
    const glued =
      /^\d{10,15}$/.test(number) &&
      new RegExp(String.raw`\p{L}${number}|${number}\p{L}`, 'u').test(text);
    const shaped = phoneShaped(number) || (!glued && /(?<!\d)\d{10,15}(?!\d)/.test(number));
    if (counted && !shaped && !PHONE_HINT_AFTER.test(after)) continue;
    if (!list && !counted && (phoneWord || (where === 'text' && shaped))) return 'contact';
    found = 'hold';
  }
  return found;
}

/**
 * The text and each percent-decoded layer under it ("%252B" reads "%2B", then "+"). Every round
 * decodes each run of %XX escapes on its own, so an escape that does not decode ("50%25-off"
 * reads "50%-off") never stops the rest; a run that is not UTF-8 decodes its ASCII escapes only.
 * null when it is still changing after 16 rounds (held).
 */
function percentLayers(text: string): string[] | null {
  const layers = [text];
  for (let layer = text; ;) {
    const next = layer.replace(/(?:%[0-9a-f]{2})+/gi, decodeEscapes);
    if (next === layer) return layers;
    if (layers.length > 16) return null;
    layers.push(next);
    layer = next;
  }
}

function decodeEscapes(run: string): string {
  try {
    return decodeURIComponent(run);
  } catch {
    return run.replace(/%([0-9a-f]{2})/gi, (escape, hex: string) =>
      parseInt(hex, 16) < 0x80 ? String.fromCharCode(parseInt(hex, 16)) : escape,
    );
  }
}

/** The worst contact finding over every percent-decoded layer of a folded text. */
function contactInLayers(
  folded: string,
  where: 'text' | 'reply',
  prepare: (layer: string) => string = (layer) => layer,
): 'contact' | 'hold' | null {
  const layers = percentLayers(folded);
  if (layers === null) return 'hold';
  let found: 'hold' | null = null;
  for (const layer of layers) {
    const contact = contactIn(prepare(layer), where);
    if (contact === 'contact') return contact;
    found ??= contact;
  }
  return found;
}

/** Reserved example addresses (RFC 2606, RFC 6761): never anyone's contact ("user@example.com"). */
const EXAMPLE_EMAIL =
  /[\p{L}\p{N}._%+-]+@(?:[\p{L}\p{N}-]+\.)*(?:example\.(?:com|org|net)|[\p{L}\p{N}-]+\.(?:example|test|invalid|localhost))(?![\p{L}\p{N}-]|\.[\p{L}\p{N}])/giu;

/**
 * Whether a service listing's own public text carries contact details (product decision, 13 Oct:
 * such listings are hidden, never refused): an email address, or a phone number with a + or 00
 * prefix or right after a phone word, by the same rules as requests. Read like a reply link, so
 * a long run of digits alone is an id, never contact ("SEC accession 0000320193-26-000064", an
 * example account number).
 */
export function serviceContactIn(
  text: string,
  context: { contactData?: boolean; host?: string } = {},
): boolean {
  const folded = foldForChecks(text).replace(EXAMPLE_EMAIL, ' ');
  // A service that works on contact data (validates, parses or looks up email addresses and phone
  // numbers) shows example inputs, not its own contact: there only an address at its own domain counts.
  if (context.contactData) {
    const own = (context.host ?? '')
      .replace(/^www\./, '')
      .split('.')
      .slice(-2)
      .join('.');
    return (
      own.includes('.') &&
      new RegExp(
        `[\\p{L}\\p{N}._%+-]+@(?:[\\p{L}\\p{N}-]+\\.)*${own.replace(/\./g, '\\.')}(?![\\p{L}\\p{N}.-])`,
        'iu',
      ).test(folded)
    );
  }
  return contactInLayers(folded, 'reply') === 'contact';
}

/** A listing whose job is contact data itself: validating, parsing or looking up addresses and numbers. */
const CONTACT_DATA_SERVICE =
  /\b(?:validat\w*|verif\w*|pars(?:e|es|ing)|normali[sz]\w*|canonicali[sz]\w*|carrier|caller[\s-]?(?:id|name)|cnam|e\.?164|libphonenumber|deliverab\w*|disposable|mx\s+(?:record|lookup)\w*|line\s+type|register\s+number)\b/i;
export const contactDataService = (text: string) => CONTACT_DATA_SERVICE.test(foldForChecks(text));

const CONTACT_IN_TEXT =
  'The text is public: leave out email addresses and phone numbers. To be reached, add a Base address or an https link as the reply handle.';

/**
 * A key or a recovery phrase in the text, or contact details: a refusal message, 'hold' for
 * details that are held for review (contactIn), or null.
 */
function privateDetails(text: string): string | 'hold' | null {
  const folded = foldForChecks(text);
  if (containsCredential(folded) || PRIVATE_KEY.test(folded) || seedPhrase(folded))
    return 'Text may not contain a key, a token or a recovery phrase.';
  const contact = contactInLayers(folded, 'text');
  if (contact === 'contact') return CONTACT_IN_TEXT;
  return contact;
}

function sharedChecks(text: string): string | 'hold' | null {
  if (longRun(text)) return 'Text may not repeat one character more than 12 times in a row.';
  return privateDetails(text);
}

/** The stored form of an https link, or why it may not stay ('refuse': 400, 'risky': held). */
export function checkLink(raw: string): { stored: string } | { issue: 'refuse' | 'risky' } {
  let url: URL;
  try {
    url = new URL(raw.toLowerCase().startsWith('www.') ? `https://${raw}` : raw);
  } catch {
    return { issue: 'refuse' };
  }
  const host = normalizeHost(url.hostname);
  if (MESSENGERS.has(host)) return { issue: 'risky' };
  if (
    url.protocol !== 'https:' ||
    url.port !== '' ||
    host.startsWith('[') ||
    /^\d+(?:\.\d+){3}$/.test(host) ||
    host.split('.').some((label) => label.startsWith('xn--')) ||
    !host.includes('.') ||
    SHORTENERS.has(host)
  )
    return { issue: 'refuse' };
  const { sources, issues } = normalizeSources([{ url: url.href }], []);
  if (issues.length || !sources[0]) return { issue: 'refuse' };
  return { stored: sources[0].url };
}

const BAD_LINK =
  'Links must be public https pages: no shorteners, IP addresses, ports or secrets in the path.';

/** A title shows at least this many letters or digits (marks, symbols and blanks alone do not). */
export const TITLE_LETTERS_MIN = 2;

/**
 * Whether a host found by BARE_LINK (with its port) reads as a web address, not a product name
 * with a path ("Node.js/Express"): an IP literal, a punycode label, a port, or an address ending
 * (the title list) on a host that is not a known product name.
 */
function bareLink(hostAndPort: string): boolean {
  const host = hostAndPort.toLowerCase();
  if (host.includes(':') || /^[\d.]+$/.test(host)) return true;
  const labels = host.split('.');
  if (labels.some((label) => label.startsWith('xn--'))) return true;
  return ADDRESS_TLDS.has(labels[labels.length - 1]!) && !NOT_ADDRESSES.has(host);
}
/**
 * After an IPv4-shaped number, a CIDR prefix ("192.168.0.0/16", an address block) or another
 * dotted number ("1.0.2.13/1.0.2.14", a version pair): text, not a link.
 */
const NUMBER_PATH = /^\/(?:[0-9]|[12][0-9]|3[0-2]|\d+(?:\.\d+)+)[.,;:!?)\]}]*$/;
/**
 * A loopback, private or link-local IPv4 address (with or without a port): it opens on the
 * reader's own machine or network, never a public page. Written without a scheme it is held for
 * review (a config note like "127.0.0.1:8080/health"), not refused.
 */
const LOCAL_IP =
  /^(?:127\.|10\.|192\.168\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.)\d{1,3}\.\d{1,3}(?:\.\d{1,3})?(?::\d{1,5})?$|^0\.0\.0\.0(?::\d{1,5})?$/;
const trimLink = (match: string) => match.replace(/[.,;:!?)\]}]+$/, '');

/**
 * Why a cleaned display name may not be published (null when it may): a link or web address,
 * a name reading as Central City or its team, a long run, a credential, an email address, a
 * phone number or any other run of 9 or more digits (a name never needs one). Anonymous posters
 * are refused with it; an agent's name is withheld (server side).
 */
export function checkDisplayName(name: string): string | null {
  if (addressShaped(name)) return 'The display name may not contain a link or a web address.';
  if (reservedDisplayName(name)) return 'This display name is reserved. Choose another one.';
  const issue = sharedChecks(name);
  if (issue === 'hold' || (issue === null && digitsInName(name))) return CONTACT_IN_TEXT;
  return issue;
}

/** A name never needs 9 or more digits in a row: it is a number to call or an id ("Jane 800-900-1000"). */
const digitsInName = (name: string) =>
  numberCopy(contactCopy(foldForChecks(name))).search(NUMBER_CHAIN) !== -1;

/**
 * Whether a display name that breaks a rule (checkDisplayName) carries a key, a recovery phrase
 * or contact details. An agent's name that does holds the request for review; one that is only
 * reserved, address-shaped or a long run ("Support Assistant", "Writer.ai") is withheld and the
 * request is listed without it.
 */
export const displayNameHolds = (name: string) =>
  privateDetails(name) !== null || digitsInName(name);

/**
 * Checks the cleaned title, description and display name and the tags. On success the
 * description comes back with its scheme links in stored form (query and fragment dropped; links
 * without a scheme are counted and checked the same way but kept as written), and `held` says
 * whether the request goes to review instead of the list.
 */
export function checkRequestText(input: {
  title: string;
  description: string;
  displayName: string | null;
  capabilities: readonly string[];
}): PolicyResult {
  const refuse = (message: string) => ({ ok: false, status: 400, message }) as const;
  if (lettersIn(input.title) < TITLE_LETTERS_MIN)
    return refuse(`The title needs at least ${TITLE_LETTERS_MIN} letters or digits.`);
  if (addressShaped(input.title))
    return refuse('The title may not contain a link or a web address.');
  if (input.displayName !== null) {
    const issue = checkDisplayName(input.displayName);
    if (issue) return refuse(issue);
  }
  if (input.description.split('\n').length > FEED_TEXT.descriptionLinesMax)
    return refuse(`The description may have at most ${FEED_TEXT.descriptionLinesMax} lines.`);
  let held = false;
  // The tags are public too.
  for (const text of [input.title, input.description]) {
    const issue = sharedChecks(text);
    if (issue === 'hold') held = true;
    else if (issue) return refuse(issue);
  }
  // The tags are public too: only the contact check (a tag set is never a recovery phrase),
  // joined as a list so one tag is never read as the unit of the next ("800-900-1000", "calls").
  const tagContact = contactInLayers(foldForChecks(input.capabilities.join(' / ')), 'text');
  if (tagContact === 'contact') return refuse(CONTACT_IN_TEXT);
  if (tagContact === 'hold') held = true;
  const folded = foldForChecks(input.description);
  const links = (folded.match(URL_IN_TEXT) ?? []).map(trimLink);
  const bareMatches = Array.from(folded.replace(URL_IN_TEXT, ' ').matchAll(BARE_LINK)).filter(
    (match) => bareLink(match[1]!) && !(/^[\d.]+$/.test(match[1]!) && NUMBER_PATH.test(match[2]!)),
  );
  const bare = bareMatches.map((match) => trimLink(`${match[1]}${match[2]}`));
  const localHosts = new Set(
    bareMatches.filter((match) => LOCAL_IP.test(match[1]!)).map((match) => match[1]!),
  );
  if (links.length + bare.length > FEED_TEXT.linksMax)
    return refuse(`The description may contain at most ${FEED_TEXT.linksMax} links.`);
  let description = input.description;
  for (const raw of links) {
    const checked = checkLink(raw);
    if ('issue' in checked) {
      if (checked.issue === 'refuse') return refuse(BAD_LINK);
      held = true;
      continue;
    }
    // Written in look-alike characters: only the folded copy reads as a link. Review it.
    if (!description.includes(raw)) held = true;
    else description = description.replace(raw, () => checked.stored);
  }
  for (const [index, raw] of bare.entries()) {
    if (localHosts.has(bareMatches[index]![1]!)) {
      held = true;
      continue;
    }
    const checked = checkLink(`https://${raw}`);
    if ('issue' in checked) {
      if (checked.issue === 'refuse') return refuse(BAD_LINK);
      held = true;
    } else if (!description.includes(raw)) held = true;
  }
  for (const match of folded.matchAll(BARE_HOST_PATH)) {
    const host = normalizeHost(match[1]!);
    if (SHORTENERS.has(host)) return refuse(BAD_LINK);
    if (MESSENGERS.has(host)) held = true;
  }
  if (
    feedRiskOf(
      foldForChecks(input.title),
      folded,
      input.displayName === null ? null : foldForChecks(input.displayName),
      input.capabilities.join(' '),
    ) !== null
  )
    held = true;
  return { ok: true, description, held };
}

/**
 * The optional public reply handle: a Base address (stored checksummed) or an https link
 * (stored without query and fragment). null when empty. A messenger link holds the request.
 */
export function checkReply(
  raw: string | null | undefined,
): { ok: true; reply: string | null; held: boolean } | { ok: false; message: string } {
  const reply = raw ? cleanLine(raw) : '';
  if (!reply) return { ok: true, reply: null, held: false };
  const invalid = {
    ok: false,
    message:
      'The reply handle is a Base address (0x followed by 40 hex characters) or one https link.',
  } as const;
  if (codePoints(reply) > FEED_LIMITS.replyMax || /\s/.test(reply)) return invalid;
  if (/^0x[0-9a-fA-F]{40}$/.test(reply)) {
    // Mixed case must carry a valid checksum (a typo is caught, not stored).
    if (!isAddress(reply, { strict: true }) || /^0x0{40}$/.test(reply)) return invalid;
    return { ok: true, reply: getAddress(reply), held: false };
  }
  if (foldForChecks(reply) !== reply || !/^https:\/\//i.test(reply)) return invalid;
  if (containsCredential(reply)) return invalid;
  const checked = checkLink(reply);
  if ('issue' in checked && checked.issue === 'refuse') return invalid;
  const stored = 'stored' in checked ? checked.stored : reply;
  // The handle is public too: no email address or phone number in its path, encoded or not
  // (every percent-decoded layer, folded, with control characters and spaces dropped so nothing
  // hides between two characters). A run of 9 or more digits may be a listing id as well as a
  // phone number: review it.
  // Read once more with the spaces kept, so words spaced by %20 ("name%20at%20example%20dot%20com")
  // are read as words.
  const joined = contactInLayers(stored, 'reply', (layer) =>
    foldForChecks(layer).replace(/[\s\p{Cc}]/gu, ''),
  );
  const spaced = contactInLayers(stored, 'reply', (layer) =>
    foldForChecks(layer).replace(/\p{Cc}/gu, ' '),
  );
  const contact = joined === 'contact' || spaced === 'contact' ? 'contact' : (joined ?? spaced);
  if (contact === 'contact')
    return {
      ok: false,
      message:
        'The reply handle is public: leave out email addresses and phone numbers, also in the link.',
    };
  return { ok: true, reply: stored, held: !('stored' in checked) || contact === 'hold' };
}
