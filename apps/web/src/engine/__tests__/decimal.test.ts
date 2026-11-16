import { describe, expect, it } from 'vitest';
import {
  Big,
  decimalFromNumber,
  decodeDecimal,
  encodeDecimal,
  isDecimal,
  parseDecimal,
  roundDecimal,
} from '../core/decimal';

/** Fixed-seed PRNG for generated test data (mulberry32): same seed, same sequence. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A decimal text with 1–30 significant digits, a scale of 0–14 and either sign. */
function generatedText(next: () => number): string {
  const digits = 1 + Math.floor(next() * 30);
  let text = String(1 + Math.floor(next() * 9));
  for (let i = 1; i < digits; i++) text += String(Math.floor(next() * 10));
  const scale = Math.floor(next() * 15);
  const body =
    scale >= text.length
      ? `0.${'0'.repeat(scale - text.length)}${text}`
      : scale === 0
        ? text
        : `${text.slice(0, text.length - scale)}.${text.slice(text.length - scale)}`;
  return next() < 0.5 ? `-${body}` : body;
}

describe('decimal encoding (spec §9.4)', () => {
  it('round-trips 10,000 generated values exactly, using a double only when it is exact', () => {
    const next = mulberry32(20261116);
    let asDouble = 0;
    let asText = 0;
    for (let i = 0; i < 10_000; i++) {
      const value = parseDecimal(generatedText(next));
      const stored = encodeDecimal(value);
      if (typeof stored === 'number') {
        asDouble += 1;
        expect(String(stored)).toBe(value.toString());
      } else {
        asText += 1;
        expect(stored).toBe(value.toString());
      }
      const back = decodeDecimal(stored);
      expect(isDecimal(back)).toBe(true);
      expect(back.eq(value)).toBe(true);
      expect(back.toString()).toBe(value.toString());
    }
    // Both storage forms are exercised.
    expect(asDouble).toBeGreaterThan(1000);
    expect(asText).toBeGreaterThan(1000);
  });

  it('stores a value no double prints exactly as text', () => {
    expect(encodeDecimal(parseDecimal('26.5'))).toBe(26.5);
    expect(encodeDecimal(parseDecimal('15000000'))).toBe(15_000_000);
    expect(encodeDecimal(parseDecimal('0.12345678901234567890'))).toBe('0.1234567890123456789');
    expect(encodeDecimal(parseDecimal('12345678901234567890123'))).toBe(
      '1.2345678901234567890123e+22',
    );
  });

  it('adds 0.1 + 0.2 to exactly 0.3', () => {
    const sum = parseDecimal('0.1').plus(parseDecimal('0.2'));
    expect(sum.toString()).toBe('0.3');
    expect(sum.eq(new Big('0.3'))).toBe(true);
    expect(decimalFromNumber(0.1).plus(decimalFromNumber(0.2)).toString()).toBe('0.3');
  });
});

describe('decimalFromNumber', () => {
  it('keeps 15 significant digits, removing float noise', () => {
    expect(decimalFromNumber(25.499999999999996).toString()).toBe('25.5');
    expect(decimalFromNumber(0.1 + 0.2).toString()).toBe('0.3');
    expect(decimalFromNumber(1234567.891).toString()).toBe('1234567.891');
    expect(decimalFromNumber(Number('123456789012345678')).toString()).toBe('123456789012346000');
    expect(decimalFromNumber(-0).toString()).toBe('0');
  });

  it('rejects a non-finite number', () => {
    expect(() => decimalFromNumber(Number.NaN)).toThrow(RangeError);
    expect(() => decimalFromNumber(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
});

describe('roundDecimal', () => {
  it('rounds half-up (away from zero) to 10 decimal places', () => {
    expect(roundDecimal(parseDecimal('1.00000000005')).toString()).toBe('1.0000000001');
    expect(roundDecimal(parseDecimal('-1.00000000005')).toString()).toBe('-1.0000000001');
    expect(roundDecimal(parseDecimal('1.00000000004')).toString()).toBe('1');
    expect(roundDecimal(parseDecimal('2.5')).toString()).toBe('2.5');
  });

  it('uses half-up as the default rounding mode', () => {
    expect(parseDecimal('2.5').round().toString()).toBe('3');
    expect(parseDecimal('-2.5').round().toString()).toBe('-3');
  });
});
