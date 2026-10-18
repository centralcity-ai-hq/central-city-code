/*
 * The number, color and date kinds: roman-numerals, number-to-words, color-convert and date-diff.
 * Pure arithmetic on small inputs (OFFER_KIND_SPECS), the same answer for the same input.
 */
import { jsonAnswer, OfferKindInputError, pureKind } from './kind-core.js';

// ---------------------------------------------------------------- roman-numerals

const ROMAN_DIGITS: ReadonlyArray<[number, string]> = [
  [1000, 'M'],
  [900, 'CM'],
  [500, 'D'],
  [400, 'CD'],
  [100, 'C'],
  [90, 'XC'],
  [50, 'L'],
  [40, 'XL'],
  [10, 'X'],
  [9, 'IX'],
  [5, 'V'],
  [4, 'IV'],
  [1, 'I'],
];
/** The standard (subtractive, shortest) form of 1 to 3999, and nothing else. */
const CANONICAL_ROMAN = /^M{0,3}(?:CM|CD|D?C{0,3})(?:XC|XL|L?X{0,3})(?:IX|IV|V?I{0,3})$/;

export function toRoman(value: number): string {
  if (!Number.isInteger(value) || value < 1 || value > 3999)
    throw new OfferKindInputError('value must be a whole number from 1 to 3999.');
  let rest = value;
  let out = '';
  for (const [size, digits] of ROMAN_DIGITS)
    while (rest >= size) {
      out += digits;
      rest -= size;
    }
  return out;
}

/** The number of Roman numerals in their standard form (any case); IIII, IC or VX are refused. */
export function fromRoman(text: string): number {
  const upper = text.toUpperCase();
  if (!upper || !CANONICAL_ROMAN.test(upper))
    throw new OfferKindInputError(
      'text must be Roman numerals in their standard form, from I to MMMCMXCIX.',
    );
  let value = 0;
  let at = 0;
  for (const [size, digits] of ROMAN_DIGITS)
    while (upper.startsWith(digits, at)) {
      value += size;
      at += digits.length;
    }
  return value;
}

export const romanNumeralsKind = pureKind('roman-numerals', ({ value, text }) => {
  if ((value === undefined) === (text === undefined))
    throw new OfferKindInputError('Give one of value or text.');
  const number = value !== undefined ? Number(value) : fromRoman(String(text));
  return jsonAnswer({ value: number, roman: toRoman(number) });
});

// ---------------------------------------------------------------- number-to-words

const SMALL = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
  'thirteen',
  'fourteen',
  'fifteen',
  'sixteen',
  'seventeen',
  'eighteen',
  'nineteen',
];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const SCALES: ReadonlyArray<[number, string]> = [
  [1e9, 'billion'],
  [1e6, 'million'],
  [1e3, 'thousand'],
];
export const NUMBER_WORDS_MAX = 999_999_999_999;

function underThousand(value: number): string {
  const words: string[] = [];
  const hundreds = Math.floor(value / 100);
  const rest = value % 100;
  if (hundreds) words.push(`${SMALL[hundreds]} hundred`);
  if (rest >= 20)
    words.push(rest % 10 ? `${TENS[Math.floor(rest / 10)]}-${SMALL[rest % 10]}` : TENS[rest / 10]!);
  else if (rest) words.push(SMALL[rest]!);
  return words.join(' ');
}

/**
 * A whole number in English words (short scale, no "and"): 1234 is "one thousand two hundred
 * thirty-four", -5 "minus five".
 */
export function numberToWords(value: number): string {
  if (!Number.isSafeInteger(value) || Math.abs(value) > NUMBER_WORDS_MAX)
    throw new OfferKindInputError(
      'value must be a whole number from -999999999999 to 999999999999.',
    );
  if (value === 0) return 'zero';
  if (value < 0) return `minus ${numberToWords(-value)}`;
  const words: string[] = [];
  let rest = value;
  for (const [size, name] of SCALES) {
    const count = Math.floor(rest / size);
    if (count) words.push(`${underThousand(count)} ${name}`);
    rest %= size;
  }
  if (rest) words.push(underThousand(rest));
  return words.join(' ');
}

export const numberToWordsKind = pureKind('number-to-words', (input) => {
  const value = Number(input.value);
  // -0 is 0.
  return jsonAnswer({ value: value || 0, words: numberToWords(value) });
});

// ---------------------------------------------------------------- color-convert

const HEX_COLOR = /^#([0-9a-f]{3}|[0-9a-f]{6})$/;
const RGB_COLOR = /^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/;
const NUMBER = '(\\d{1,3}(?:\\.\\d{1,6})?)';
const HSL_COLOR = new RegExp(`^hsl\\(\\s*${NUMBER}\\s*,\\s*${NUMBER}%\\s*,\\s*${NUMBER}%\\s*\\)$`);

export interface Rgb {
  r: number;
  g: number;
  b: number;
}
export interface Hsl {
  h: number;
  s: number;
  l: number;
}

const oneDecimal = (value: number) => {
  const rounded = Math.round(value * 10) / 10;
  return Object.is(rounded, -0) ? 0 : rounded;
};

export function rgbToHsl({ r, g, b }: Rgb): Hsl {
  const [red, green, blue] = [r / 255, g / 255, b / 255];
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const l = (max + min) / 2;
  const delta = max - min;
  if (delta === 0) return { h: 0, s: 0, l: oneDecimal(l * 100) };
  const s = delta / (1 - Math.abs(2 * l - 1));
  let h =
    max === red
      ? ((green - blue) / delta) % 6
      : max === green
        ? (blue - red) / delta + 2
        : (red - green) / delta + 4;
  h *= 60;
  if (h < 0) h += 360;
  const hue = oneDecimal(h);
  return { h: hue === 360 ? 0 : hue, s: oneDecimal(s * 100), l: oneDecimal(l * 100) };
}

export function hslToRgb({ h, s, l }: Hsl): Rgb {
  const sat = s / 100;
  const light = l / 100;
  const chroma = (1 - Math.abs(2 * light - 1)) * sat;
  const sector = (h % 360) / 60;
  const x = chroma * (1 - Math.abs((sector % 2) - 1));
  const [r1, g1, b1] =
    sector < 1
      ? [chroma, x, 0]
      : sector < 2
        ? [x, chroma, 0]
        : sector < 3
          ? [0, chroma, x]
          : sector < 4
            ? [0, x, chroma]
            : sector < 5
              ? [x, 0, chroma]
              : [chroma, 0, x];
  const m = light - chroma / 2;
  const channel = (value: number) => Math.min(255, Math.max(0, Math.round((value + m) * 255)));
  return { r: channel(r1), g: channel(g1), b: channel(b1) };
}

const toHex = ({ r, g, b }: Rgb) =>
  `#${[r, g, b].map((value) => value.toString(16).padStart(2, '0')).join('')}`;

/** A color as hex, RGB and HSL; HSL given is kept (rounded to one decimal), never re-derived. */
export function convertColor(color: string): { hex: string; rgb: Rgb; hsl: Hsl } {
  const value = color.trim().toLowerCase();
  const hex = HEX_COLOR.exec(value);
  if (hex) {
    const digits =
      hex[1]!.length === 3
        ? hex[1]!
            .split('')
            .map((digit) => digit + digit)
            .join('')
        : hex[1]!;
    const rgb = {
      r: parseInt(digits.slice(0, 2), 16),
      g: parseInt(digits.slice(2, 4), 16),
      b: parseInt(digits.slice(4, 6), 16),
    };
    return { hex: toHex(rgb), rgb, hsl: rgbToHsl(rgb) };
  }
  const rgbMatch = RGB_COLOR.exec(value);
  if (rgbMatch) {
    const [r, g, b] = rgbMatch.slice(1, 4).map(Number) as [number, number, number];
    if (r > 255 || g > 255 || b > 255)
      throw new OfferKindInputError('color has an RGB channel above 255.');
    const rgb = { r, g, b };
    return { hex: toHex(rgb), rgb, hsl: rgbToHsl(rgb) };
  }
  const hslMatch = HSL_COLOR.exec(value);
  if (hslMatch) {
    const [h, s, l] = hslMatch.slice(1, 4).map(Number) as [number, number, number];
    if (h > 360 || s > 100 || l > 100)
      throw new OfferKindInputError('color has a hue above 360 or a percentage above 100.');
    const hsl = { h: oneDecimal(h % 360), s: oneDecimal(s), l: oneDecimal(l) };
    const rgb = hslToRgb({ h: h % 360, s, l });
    return { hex: toHex(rgb), rgb, hsl };
  }
  throw new OfferKindInputError('color must be #rrggbb, #rgb, rgb(r, g, b) or hsl(h, s%, l%).');
}

export const colorConvertKind = pureKind('color-convert', (input) => {
  const { hex, rgb, hsl } = convertColor(String(input.color));
  return jsonAnswer({
    hex,
    rgb,
    hsl,
    css: {
      rgb: `rgb(${rgb.r}, ${rgb.g}, ${rgb.b})`,
      hsl: `hsl(${hsl.h}, ${hsl.s}%, ${hsl.l}%)`,
    },
  });
});

// ---------------------------------------------------------------- date-diff

interface CivilDate {
  year: number;
  month: number;
  day: number;
}

const isLeap = (year: number) => (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
export const daysInMonth = (year: number, month: number) =>
  month === 2 ? (isLeap(year) ? 29 : 28) : [4, 6, 9, 11].includes(month) ? 30 : 31;

/** Days since 1970-01-01 of a proleptic Gregorian date (exact for every year 1 to 9999). */
export function dayNumber({ year, month, day }: CivilDate): number {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yearOfEra = y - era * 400;
  const dayOfYear = Math.floor((153 * ((month + 9) % 12) + 2) / 5) + day - 1;
  const dayOfEra =
    yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  return era * 146_097 + dayOfEra - 719_468;
}

function parseDate(field: 'from' | 'to', value: string): CivilDate {
  const [year, month, day] = value.split('-').map(Number) as [number, number, number];
  if (
    !(year >= 1 && year <= 9999) ||
    !(month >= 1 && month <= 12) ||
    !(day >= 1 && day <= daysInMonth(year, month))
  )
    throw new OfferKindInputError(`${field} is not a date of the years 1 to 9999.`);
  return { year, month, day };
}

/** `months` calendar months after `date`; a day the month does not have is its last day. */
function addMonths(date: CivilDate, months: number): CivilDate {
  const index = date.year * 12 + (date.month - 1) + months;
  const year = Math.floor(index / 12);
  const month = (index % 12) + 1;
  return { year, month, day: Math.min(date.day, daysInMonth(year, month)) };
}

/**
 * The time from `from` to `to`: signed days, whole weeks, and the calendar difference: the most
 * whole months from the earlier date (a month after the 31st is the next month's last day when it
 * is shorter), then the days left. Every number is negative when `to` is before `from`.
 */
export function dateDiff(fromText: string, toText: string) {
  const from = parseDate('from', fromText);
  const to = parseDate('to', toText);
  const days = dayNumber(to) - dayNumber(from);
  const [start, end] = days < 0 ? [to, from] : [from, to];
  let months = (end.year - start.year) * 12 + (end.month - start.month);
  let landed = addMonths(start, months);
  if (dayNumber(landed) > dayNumber(end)) landed = addMonths(start, --months);
  const sign = days < 0 ? -1 : 1;
  const signed = (value: number) => (value === 0 ? 0 : sign * value);
  return {
    from: fromText,
    to: toText,
    days,
    weeks: Math.trunc(days / 7) || 0,
    calendar: {
      years: signed(Math.floor(months / 12)),
      months: signed(months % 12),
      days: signed(dayNumber(end) - dayNumber(landed)),
    },
  };
}

export const dateDiffKind = pureKind('date-diff', ({ from, to }) =>
  jsonAnswer(dateDiff(String(from), String(to))),
);
