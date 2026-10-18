/*
 * csv-to-json, json-to-csv and csv-stats (at the end of this file): one linear pass each, at most
 * CSV_MAX_ROWS rows, answers of at most 64 KiB (measured as they are built, so a small input that
 * would expand is refused before the answer is made). Quoting is RFC 4180's: a field in double quotes may hold the delimiter, line
 * breaks and "" (one quote).
 */
import { CSV_DELIMITERS } from '../../../shared/feed-offers.js';
import {
  jsonAnswer,
  OFFER_ANSWER_MAX_BYTES,
  OfferKindInputError,
  pureKind,
  textAnswer,
} from './kind-core.js';

export const CSV_MAX_ROWS = 10_000;

const tooLarge = () =>
  new OfferKindInputError(
    `The answer would be larger than ${OFFER_ANSWER_MAX_BYTES} bytes; send a shorter input.`,
  );
const jsonBytes = (value: string) => Buffer.byteLength(JSON.stringify(value), 'utf8');

/**
 * The rows of a CSV text. Line breaks are CR LF, LF or CR; a line with nothing on it is skipped; a
 * final line break ends the last row. A quote inside an unquoted field, anything but the delimiter
 * or a line break after a closing quote, and a quote that never closes are refused, naming the row.
 */
export function parseCsv(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  const n = text.length;
  let i = 0;
  let row: string[] = [];
  /** The row's first character was read (a line with nothing on it is not a row). */
  let started = false;
  const line = () => rows.length + 1;
  const endRow = () => {
    if (started) {
      if (rows.length >= CSV_MAX_ROWS)
        throw new OfferKindInputError(`text has more than ${CSV_MAX_ROWS} rows.`);
      rows.push(row);
    }
    row = [];
    started = false;
  };
  const isBreak = (code: number) => code === 0x0a || code === 0x0d;
  const delimiterCode = delimiter.charCodeAt(0);
  while (i < n) {
    // A field starts at i.
    let field: string;
    if (text.charCodeAt(i) === 0x22) {
      started = true;
      i++;
      field = '';
      for (;;) {
        const quote = text.indexOf('"', i);
        if (quote < 0)
          throw new OfferKindInputError(`row ${line()} has a quote that never closes.`);
        field += text.slice(i, quote);
        if (text.charCodeAt(quote + 1) === 0x22) {
          field += '"';
          i = quote + 2;
          continue;
        }
        i = quote + 1;
        break;
      }
      if (i < n && text.charCodeAt(i) !== delimiterCode && !isBreak(text.charCodeAt(i)))
        throw new OfferKindInputError(
          `row ${line()} has characters after a closing quote (a quote inside a field is written "").`,
        );
    } else {
      const start = i;
      while (i < n) {
        const code = text.charCodeAt(i);
        if (code === delimiterCode || isBreak(code)) break;
        if (code === 0x22)
          throw new OfferKindInputError(
            `row ${line()} has a quote inside a field that does not start with one.`,
          );
        i++;
      }
      field = text.slice(start, i);
      if (field) started = true;
    }
    if (i < n && text.charCodeAt(i) === delimiterCode) {
      started = true;
      row.push(field);
      i++;
      // A delimiter at the very end ends the row with an empty field.
      if (i === n) row.push('');
      continue;
    }
    row.push(field);
    if (i < n) {
      // A line break: CR LF counts once.
      i += text.charCodeAt(i) === 0x0d && text.charCodeAt(i + 1) === 0x0a ? 2 : 1;
    }
    endRow();
  }
  if (started) endRow();
  return rows;
}

/** A plain object with these own properties (a key such as __proto__ is an ordinary key). */
function record(keys: readonly string[], values: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  keys.forEach((key, index) =>
    Object.defineProperty(out, key, {
      value: values[index],
      enumerable: true,
      writable: true,
      configurable: true,
    }),
  );
  return out;
}

export function csvToJson(
  text: string,
  delimiter: string,
  header: boolean,
): { columns?: string[]; rows: Array<string[] | Record<string, string>> } {
  const rows = parseCsv(text, delimiter);
  // The answer's size is counted as it is built: names repeat in every row, so a small text can
  // stand for a large answer.
  let size = 32;
  const add = (bytes: number) => {
    size += bytes;
    if (size > OFFER_ANSWER_MAX_BYTES) throw tooLarge();
  };
  if (!header) {
    for (const row of rows) {
      add(3);
      row.forEach((field, column) => add(jsonBytes(field) + (column ? 1 : 0)));
    }
    return { rows };
  }
  const columns = rows.shift() ?? [];
  if (new Set(columns).size !== columns.length)
    throw new OfferKindInputError('The header names a column more than once.');
  const keyBytes = columns.map(jsonBytes);
  for (const bytes of keyBytes) add(bytes + 1);
  const objects = rows.map((row, index) => {
    if (row.length !== columns.length)
      throw new OfferKindInputError(
        `row ${index + 2} has ${row.length} fields; the header has ${columns.length}.`,
      );
    add(3);
    row.forEach((field, column) =>
      add(keyBytes[column]! + 1 + jsonBytes(field) + (column ? 1 : 0)),
    );
    return record(columns, row);
  });
  return { columns, rows: objects };
}

export const csvToJsonKind = pureKind('csv-to-json', (value) => {
  const delimiter = value.delimiter === undefined ? ',' : String(value.delimiter);
  if (!(CSV_DELIMITERS as readonly string[]).includes(delimiter))
    throw new OfferKindInputError('delimiter is not one this service reads.');
  return jsonAnswer(csvToJson(String(value.text), delimiter, value.header !== false));
});

/** A CSV field: quoted when it holds a comma, a quote or a line break, with "" for a quote. */
export function csvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/**
 * CSV of a JSON array of flat objects: the header is every key in the order first seen, a row
 * leaves a key it does not have empty, null is empty, true and false are written as such, and a
 * number as the shortest form of the double JSON reads (so a number with more than 15 to 17
 * significant digits is written rounded). Lines end with CR LF.
 */
export function jsonToCsv(text: string): string {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new OfferKindInputError('text is not valid JSON.');
  }
  if (!Array.isArray(value) || value.length === 0)
    throw new OfferKindInputError('text must be a JSON array of at least one object.');
  if (value.length > CSV_MAX_ROWS)
    throw new OfferKindInputError(`text has more than ${CSV_MAX_ROWS} objects.`);
  const columns = new Map<string, number>();
  value.forEach((item, index) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item))
      throw new OfferKindInputError(`item ${index + 1} is not an object.`);
    for (const [key, field] of Object.entries(item)) {
      if (
        field !== null &&
        typeof field !== 'string' &&
        typeof field !== 'boolean' &&
        !(typeof field === 'number' && Number.isFinite(field))
      )
        throw new OfferKindInputError(
          `item ${index + 1} has a value that is not text, a number, true, false or null.`,
        );
      if (!columns.has(key)) columns.set(key, columns.size);
    }
  });
  const keys = [...columns.keys()];
  // Every row has a delimiter per column: refuse before building what cannot fit.
  if ((value.length + 1) * keys.length > OFFER_ANSWER_MAX_BYTES) throw tooLarge();
  const lines: string[] = [];
  let size = 0;
  const push = (cells: string[]) => {
    const line = `${cells.join(',')}\r\n`;
    size += Buffer.byteLength(line, 'utf8');
    if (size > OFFER_ANSWER_MAX_BYTES) throw tooLarge();
    lines.push(line);
  };
  push(keys.map(csvField));
  value.forEach((item: Record<string, unknown>) => {
    push(
      keys.map((key) => {
        if (!Object.prototype.hasOwnProperty.call(item, key)) return '';
        const field = item[key];
        return field === null ? '' : csvField(String(field));
      }),
    );
  });
  return lines.join('');
}

export const jsonToCsvKind = pureKind('json-to-csv', (value) =>
  textAnswer(jsonToCsv(String(value.text))),
);

// ---------------------------------------------------------------------------------------------
// csv-stats

/** The most distinct values counted per column; past it the count is `CSV_STATS_MAX_DISTINCT+`. */
export const CSV_STATS_MAX_DISTINCT = 1_000;
/** The most columns csv-stats describes (each one is a small object in the answer). */
export const CSV_STATS_MAX_COLUMNS = 200;

const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
const INTEGER = /^[+-]?\d+$/;
const BOOLEAN = /^(?:true|false)$/i;

export type CsvColumnType = 'empty' | 'integer' | 'number' | 'boolean' | 'string';

export interface CsvColumnStats {
  name: string;
  /**
   * What every non-empty value (trimmed) of the column reads as: integer, number (any decimal),
   * boolean (true or false, any case), string otherwise; empty when it has no value at all.
   */
  type: CsvColumnType;
  /** Rows (the header excluded). */
  count: number;
  /** Cells that are empty or only whitespace, a row too short to reach the column included. */
  empty: number;
  /** Distinct non-empty values as written, counted up to CSV_STATS_MAX_DISTINCT. */
  distinct: number;
  distinct_capped: boolean;
  /** integer and number columns only. */
  min?: number;
  max?: number;
  mean?: number;
  median?: number;
  sum?: number;
}

/** Rounds away binary noise in a computed statistic (12 significant digits). */
const tidy = (value: number) => Number(value.toPrecision(12));

export function csvStats(
  text: string,
  delimiter: string,
  header: boolean,
): { rows: number; columns: CsvColumnStats[] } {
  const rows = parseCsv(text, delimiter);
  const names = header ? (rows.shift() ?? []) : [];
  const width = Math.max(names.length, ...rows.map((row) => row.length), 0);
  if (width > CSV_STATS_MAX_COLUMNS)
    throw new OfferKindInputError(`text has more than ${CSV_STATS_MAX_COLUMNS} columns.`);
  const columns: CsvColumnStats[] = [];
  for (let column = 0; column < width; column++) {
    const distinct = new Set<string>();
    let empty = 0;
    let numeric = true;
    let integer = true;
    let boolean = true;
    const numbers: number[] = [];
    for (const row of rows) {
      const cell = (row[column] ?? '').trim();
      if (!cell) {
        empty++;
        continue;
      }
      if (distinct.size <= CSV_STATS_MAX_DISTINCT) distinct.add(cell);
      if (numeric && NUMBER.test(cell) && Number.isFinite(Number(cell))) {
        numbers.push(Number(cell));
        if (!INTEGER.test(cell)) integer = false;
      } else numeric = false;
      if (!BOOLEAN.test(cell)) boolean = false;
    }
    const filled = rows.length - empty;
    const type: CsvColumnType = !filled
      ? 'empty'
      : numeric
        ? integer
          ? 'integer'
          : 'number'
        : boolean
          ? 'boolean'
          : 'string';
    const stats: CsvColumnStats = {
      name: names[column] ?? `column_${column + 1}`,
      type,
      count: rows.length,
      empty,
      distinct: Math.min(distinct.size, CSV_STATS_MAX_DISTINCT),
      distinct_capped: distinct.size > CSV_STATS_MAX_DISTINCT,
    };
    if (type === 'integer' || type === 'number') {
      numbers.sort((a, b) => a - b);
      const sum = numbers.reduce((total, value) => total + value, 0);
      const middle = numbers.length >> 1;
      stats.min = numbers[0]!;
      stats.max = numbers[numbers.length - 1]!;
      stats.mean = tidy(sum / numbers.length);
      stats.median = tidy(
        numbers.length % 2 ? numbers[middle]! : (numbers[middle - 1]! + numbers[middle]!) / 2,
      );
      stats.sum = tidy(sum);
    }
    columns.push(stats);
  }
  return { rows: rows.length, columns };
}

export const csvStatsKind = pureKind('csv-stats', (value) => {
  const delimiter = value.delimiter === undefined ? ',' : String(value.delimiter);
  if (!(CSV_DELIMITERS as readonly string[]).includes(delimiter))
    throw new OfferKindInputError('delimiter is not one this service reads.');
  return jsonAnswer(csvStats(String(value.text), delimiter, value.header !== false));
});
