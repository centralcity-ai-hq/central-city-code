/*
 * unit-convert: length, mass, volume and temperature, the units of UNIT_CONVERT_UNITS
 * (shared/feed-offers.ts). Linear units convert through their dimension's base unit with exact
 * factors (the international yard and pound, the US gallon and fluid ounce). Temperature is
 * converted directly between the two units (never through kelvin), and its offsets are added in
 * exact decimal arithmetic on the value as written, so a small value or a difference near an
 * offset keeps its digits. A value converted to its own unit comes back unchanged. Results are
 * rounded to 15 significant digits, enough for every factor (at most 12 digits); a whole result
 * that fits exactly in a double is returned as it is.
 */
import { UNIT_CONVERT_UNITS } from '../../../shared/feed-offers.js';
import { jsonAnswer, OfferKindInputError, pureKind } from './kind-core.js';

export type Dimension = keyof typeof UNIT_CONVERT_UNITS;
export type Unit = (typeof UNIT_CONVERT_UNITS)[Dimension][number];

/** Factor to the dimension's base unit (metre, kilogram, litre); temperature is not linear. */
const UNITS = {
  m: { dimension: 'length', factor: 1 },
  km: { dimension: 'length', factor: 1000 },
  cm: { dimension: 'length', factor: 0.01 },
  mm: { dimension: 'length', factor: 0.001 },
  mi: { dimension: 'length', factor: 1609.344 },
  yd: { dimension: 'length', factor: 0.9144 },
  ft: { dimension: 'length', factor: 0.3048 },
  in: { dimension: 'length', factor: 0.0254 },
  kg: { dimension: 'mass', factor: 1 },
  g: { dimension: 'mass', factor: 0.001 },
  mg: { dimension: 'mass', factor: 0.000001 },
  lb: { dimension: 'mass', factor: 0.45359237 },
  oz: { dimension: 'mass', factor: 0.028349523125 },
  l: { dimension: 'volume', factor: 1 },
  ml: { dimension: 'volume', factor: 0.001 },
  // The US gallon is 231 cubic inches, exactly 3.785411784 l; a US fluid ounce is 1/128 of it.
  gal: { dimension: 'volume', factor: 3.785411784 },
  floz: { dimension: 'volume', factor: 0.0295735295625 },
  c: { dimension: 'temperature', factor: 0 },
  f: { dimension: 'temperature', factor: 0 },
  k: { dimension: 'temperature', factor: 0 },
} as const satisfies Record<Unit, { dimension: Dimension; factor: number }>;

export const UNIT_NAMES = Object.keys(UNITS) as [Unit, ...Unit[]];

/** A decimal: `digits` times ten to the `exponent`, exact. */
interface Decimal {
  digits: bigint;
  exponent: number;
}

const decimal = (digits: bigint, exponent: number): Decimal => ({ digits, exponent });

/** The value as its shortest round-trip decimal (what the buyer wrote, for a JSON number). */
function toDecimal(value: number): Decimal {
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:e([+-]\d+))?$/.exec(String(value));
  if (!match) throw new RangeError('not a finite number');
  const fraction = match[3] ?? '';
  return decimal(
    BigInt(`${match[1]}${match[2]}${fraction}`),
    Number(match[4] ?? 0) - fraction.length,
  );
}

function addDecimal(a: Decimal, b: Decimal): Decimal {
  const exponent = Math.min(a.exponent, b.exponent);
  const scale = (x: Decimal) => x.digits * 10n ** BigInt(x.exponent - exponent);
  return decimal(scale(a) + scale(b), exponent);
}

const mulDecimal = (a: Decimal, b: Decimal): Decimal =>
  decimal(a.digits * b.digits, a.exponent + b.exponent);

/** The nearest double (one rounding). */
const fromDecimal = (value: Decimal): number => Number(`${value.digits}e${value.exponent}`);

const NINE_FIFTHS = decimal(18n, -1);
/** The offset of each scale from kelvin-sized degrees: C + 273.15 = K, F + 459.67 = R. */
const ABSOLUTE_ZERO_C = decimal(27315n, -2);
const ABSOLUTE_ZERO_F = decimal(45967n, -2);
const FREEZING_F = decimal(32n, 0);
const negate = (value: Decimal) => decimal(-value.digits, value.exponent);

/**
 * A temperature in another unit, or null below absolute zero. Additions and the 9/5 product are
 * exact; a 5/9 product is two roundings of a value that no longer cancels.
 */
function convertTemperature(value: number, from: Unit, to: Unit): number | null {
  const given = toDecimal(value);
  // Degrees above absolute zero in the source's own degree size.
  const above = addDecimal(
    given,
    from === 'c' ? ABSOLUTE_ZERO_C : from === 'f' ? ABSOLUTE_ZERO_F : decimal(0n, 0),
  );
  if (above.digits < 0n) return null;
  if (from === to) return value;
  const fiveNinths = (x: Decimal) => (fromDecimal(x) * 5) / 9;
  if (from === 'c' && to === 'f')
    return fromDecimal(addDecimal(mulDecimal(given, NINE_FIFTHS), FREEZING_F));
  if (from === 'f' && to === 'c') return fiveNinths(addDecimal(given, negate(FREEZING_F)));
  if (from === 'c' && to === 'k') return fromDecimal(above);
  if (from === 'k' && to === 'c') return fromDecimal(addDecimal(given, negate(ABSOLUTE_ZERO_C)));
  if (from === 'f' && to === 'k') return fiveNinths(above);
  // k to f.
  return fromDecimal(addDecimal(mulDecimal(given, NINE_FIFTHS), negate(ABSOLUTE_ZERO_F)));
}

/**
 * Rounds to 15 significant digits (float noise goes, every factor's digits stay); a whole number
 * that is exact as a double is kept as it is; -0 reads as 0.
 */
export function significant(value: number): number {
  const rounded = Number.isSafeInteger(value) ? value : Number(value.toPrecision(15));
  return Object.is(rounded, -0) ? 0 : rounded;
}

export type UnitConversion =
  | { ok: true; dimension: Dimension; result: number }
  | {
      ok: false;
      code: 'incompatible_units' | 'below_absolute_zero' | 'out_of_range';
      message: string;
    };

export function convertUnit(value: number, from: Unit, to: Unit): UnitConversion {
  const source = UNITS[from];
  const target = UNITS[to];
  if (source.dimension !== target.dimension)
    return {
      ok: false,
      code: 'incompatible_units',
      message: `${from} is a unit of ${source.dimension} and ${to} a unit of ${target.dimension}.`,
    };
  if (!Number.isFinite(value))
    return { ok: false, code: 'out_of_range', message: 'The value is not a finite number.' };
  let result: number;
  if (source.dimension === 'temperature') {
    const converted = convertTemperature(value, from, to);
    if (converted === null)
      return {
        ok: false,
        code: 'below_absolute_zero',
        message: 'The temperature is below absolute zero.',
      };
    result = converted;
  } else result = from === to ? value : (value * source.factor) / target.factor;
  if (!Number.isFinite(result))
    return { ok: false, code: 'out_of_range', message: 'The result is too large to represent.' };
  // The same unit is the value itself: nothing to round away.
  if (from === to)
    return { ok: true, dimension: source.dimension, result: Object.is(result, -0) ? 0 : result };
  return { ok: true, dimension: source.dimension, result: significant(result) };
}

/** unit-convert: a value between two units of one dimension (OFFER_KIND_SPECS['unit-convert']). */
export const unitConvertKind = pureKind('unit-convert', (input) => {
  const { value, from, to } = input as { value: number; from: Unit; to: Unit };
  const converted = convertUnit(value, from, to);
  if (!converted.ok) throw new OfferKindInputError(converted.message);
  return jsonAnswer({ value, from, to, dimension: converted.dimension, result: converted.result });
});
