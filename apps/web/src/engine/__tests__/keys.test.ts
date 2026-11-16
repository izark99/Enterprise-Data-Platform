import { describe, expect, it } from 'vitest';
import { parseDecimal } from '../core/decimal';
import { normalizeKeyPart } from '../core/keys';

describe('normalizeKeyPart (03 §4.4)', () => {
  it.each([
    ['NBSP', 'NV 001', 'nv 001'],
    ['tab', 'NV\t001', 'nv 001'],
    ['double space', 'Nguyễn  Văn   An', 'nguyễn văn an'],
    ['leading and trailing whitespace', '  NV001\t\n', 'nv001'],
    ['Vietnamese capitals', 'ĐẶNG', 'đặng'],
    ['Vietnamese lowercase', 'đặng', 'đặng'],
    ['NFD input', 'Đặng'.normalize('NFD'), 'đặng'],
    ['NFD capitals', 'NGUYỄN'.normalize('NFD'), 'nguyễn'],
  ])('%s', (_case, input, expected) => {
    const out = normalizeKeyPart(input);
    expect(out).toBe(expected);
    expect(out).toBe(out.normalize('NFC'));
  });

  it('makes ĐẶNG, đặng and their NFD form the same key', () => {
    const keys = new Set(['ĐẶNG', 'đặng', 'ĐẶNG'.normalize('NFD'), ' đặng '].map(normalizeKeyPart));
    expect(keys.size).toBe(1);
  });

  it('maps blank to the empty string and other values to their text', () => {
    expect(normalizeKeyPart(null)).toBe('');
    expect(normalizeKeyPart(undefined)).toBe('');
    expect(normalizeKeyPart(123)).toBe('123');
    expect(normalizeKeyPart(true)).toBe('true');
    expect(normalizeKeyPart(parseDecimal('1.50'))).toBe('1.5');
  });
});
