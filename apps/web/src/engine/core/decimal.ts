import BigJs from 'big.js';

/**
 * Exact decimals (spec §9.4, 03 §4.5): money and day counts are big.js values, never floats.
 * `BigJs()` makes an independent constructor, so this configuration does not leak to other users of
 * big.js. Rounding is half-up (away from zero on a tie), as Excel `ROUND`.
 */
export const Big = BigJs();
Big.RM = Big.roundHalfUp;

export type Decimal = BigJs.Big;

/** Decimal places kept at the DuckDB boundary (`DECIMAL(38,10)`, spec §9.4). */
export const DECIMAL_SCALE = 10;

/** Significant digits an Excel number carries (spec §9.4). */
const EXCEL_PRECISION = 15;

export function isDecimal(v: unknown): v is Decimal {
  return v instanceof Big;
}

export function parseDecimal(text: string): Decimal {
  return new Big(text);
}

/**
 * A JS number (Excel cell, DuckDB `DOUBLE`) as a decimal with 15 significant digits, so float noise
 * disappears: `25.499999999999996` → `25.5`.
 */
export function decimalFromNumber(n: number): Decimal {
  // A double near Number.MAX_VALUE rounds up to Infinity at 15 digits: refuse it too.
  const rounded = Number(n.toPrecision(EXCEL_PRECISION));
  if (!Number.isFinite(rounded)) throw new RangeError('decimalFromNumber: not a finite number');
  return new Big(String(rounded));
}

/** Half-up rounding to the 10 decimal places of `DECIMAL(38,10)` (spec §9.4). */
export function roundDecimal(d: Decimal): Decimal {
  return d.round(DECIMAL_SCALE, Big.roundHalfUp);
}

/**
 * Lossless storage form of a decimal (spec §9.4): the double `x` when `String(x)` is exactly the
 * decimal's text, otherwise the exact text. The double is only an encoding; it is never computed on.
 */
export function encodeDecimal(d: Decimal): number | string {
  const text = d.toString();
  const x = Number(text);
  return String(x) === text ? x : text;
}

/** Inverse of `encodeDecimal`: reads always return a `Decimal`. */
export function decodeDecimal(stored: number | string): Decimal {
  return new Big(typeof stored === 'number' ? String(stored) : stored);
}
