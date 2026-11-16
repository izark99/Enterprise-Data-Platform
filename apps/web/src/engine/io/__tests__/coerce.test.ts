import { describe, expect, it } from 'vitest';
import { isDecimal } from '../../core/decimal';
import {
  coerceCell,
  coerceValue,
  displayRaw,
  excelSerialToParts,
  isAmbiguousNumberText,
  normalizeNumberText,
  parseDateText,
  type CoerceResult,
} from '../coerce';

const value = (r: CoerceResult): unknown => {
  if (!r.ok) return 'FAIL';
  return isDecimal(r.value) ? `big:${r.value.toString()}` : r.value;
};

describe('coerce', () => {
  it('string columns take the displayed text (00123, dates, 15 digits)', () => {
    expect(value(coerceCell({ value: 123, numFmt: '00000' }, 'string'))).toBe('00123');
    expect(value(coerceCell({ value: 45293, numFmt: 'm/d/yy' }, 'string'))).toBe('02/01/2024');
    expect(value(coerceCell({ value: 0.1 + 0.2 }, 'string'))).toBe('0.3');
    expect(value(coerceCell({ value: true }, 'string'))).toBe('TRUE');
    expect(value(coerceCell({ value: '  NV01 ' }, 'string'))).toBe('NV01');
    expect(value(coerceCell({ value: '   ' }, 'string'))).toBeNull();
    expect(displayRaw({ value: 5 }, false)).toBe(5);
  });

  it('decimals: 15 significant digits from Excel numbers, exact from text, separators', () => {
    expect(value(coerceValue(25.499999999999996, 'decimal'))).toBe('big:25.5');
    expect(value(coerceValue('1,234.50', 'decimal'))).toBe('big:1234.5');
    expect(value(coerceValue('1.234,5', 'decimal', { decimalSeparator: ',' }))).toBe('big:1234.5');
    expect(value(coerceValue('1,5', 'decimal'))).toBe('FAIL');
    expect(value(coerceValue('abc', 'decimal'))).toBe('FAIL');
    expect(value(coerceValue(Number.NaN, 'decimal'))).toBe('FAIL');
    expect(value(coerceValue(true, 'decimal'))).toBe('FAIL');
    expect(value(coerceValue('1e9999', 'decimal'))).toBe('FAIL');
    expect(coerceValue('1,500', 'decimal')).toMatchObject({ ok: true, ambiguous: true });
    expect(coerceValue('1,500.25', 'decimal')).not.toHaveProperty('ambiguous');
  });

  it('flags "1,500" and "1.500" as ambiguous, not "1500" or "12,500.5"', () => {
    expect(isAmbiguousNumberText('1,500')).toBe(true);
    expect(isAmbiguousNumberText(' 1.500 ')).toBe(true);
    expect(isAmbiguousNumberText('1500')).toBe(false);
    expect(isAmbiguousNumberText('12,500.5')).toBe(false);
    expect(normalizeNumberText('-.5', '.')).toBe('-0.5');
    expect(normalizeNumberText('+5.', '.')).toBe('5');
  });

  it('integers and booleans', () => {
    expect(value(coerceValue(3, 'integer'))).toBe(3);
    expect(value(coerceValue(2.9999999999999996, 'integer'))).toBe(3);
    expect(value(coerceValue(1.5, 'integer'))).toBe('FAIL');
    expect(value(coerceValue('1,000', 'integer'))).toBe(1000);
    expect(value(coerceValue('Có', 'boolean'))).toBe(true);
    expect(value(coerceValue('không', 'boolean'))).toBe(false);
    expect(value(coerceValue(2, 'boolean'))).toBe('FAIL');
  });

  it('dates: formats, Excel serials, real date cells always accepted', () => {
    expect(value(coerceValue('02/01/2024', 'date', { dateFormats: ['dd/MM/yyyy'] }))).toBe(
      '2024-01-02',
    );
    expect(value(coerceValue('31/02/2024', 'date', { dateFormats: ['dd/MM/yyyy'] }))).toBe('FAIL');
    expect(value(coerceValue(45293.5, 'datetime'))).toBe('2024-01-02T12:00:00');
    expect(value(coerceValue(45293, 'date', { dateFormats: ['dd/MM/yyyy'] }))).toBe('FAIL');
    // A real date cell (date number format) is a date whatever dateFormats says.
    expect(
      value(
        coerceCell({ value: 45293, numFmt: 'dd/mm/yyyy' }, 'date', { dateFormats: ['dd/MM/yyyy'] }),
      ),
    ).toBe('2024-01-02');
    expect(value(coerceValue(1, 'date', { date1904: true }))).toBe('1904-01-02');
    expect(excelSerialToParts(60)).toBeNull();
    expect(excelSerialToParts(59)).toMatchObject({ y: 1900, m: 2, d: 28 });
    expect(excelSerialToParts(61)).toMatchObject({ y: 1900, m: 3, d: 1 });
    expect(parseDateText('2024-1-2 7:05:09', 'yyyy-M-d H:mm:ss')).toMatchObject({
      y: 2024,
      m: 1,
      d: 2,
      hh: 7,
      mi: 5,
      ss: 9,
    });
  });
});
