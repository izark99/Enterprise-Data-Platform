import { describe, expect, it } from 'vitest';
import {
  DataTypeSchema,
  DecimalLiteralSchema,
  IdentifierSchema,
  LiteralSchema,
  NonNegativeDecimalLiteralSchema,
  SeveritySchema,
} from '../identifier';

describe('IdentifierSchema', () => {
  it.each(['ma_nv', '_source_file', 'a1', 'x'])('accepts %s', (name) => {
    expect(IdentifierSchema.safeParse(name).success).toBe(true);
  });

  it.each([
    ['starts with a digit', '1abc'],
    ['contains a space', 'ma nv'],
    ['contains a double quote', 'ma"nv'],
    ['contains a single quote', "ma'nv"],
    ['has upper case', 'MaNV'],
    ['is empty', ''],
  ])('rejects a name that %s', (_case, name) => {
    expect(IdentifierSchema.safeParse(name).success).toBe(false);
  });
});

describe('primitive schemas', () => {
  it('lists the six data types of spec §9.4', () => {
    expect(DataTypeSchema.options).toEqual([
      'string',
      'integer',
      'decimal',
      'boolean',
      'date',
      'datetime',
    ]);
    expect(SeveritySchema.options).toEqual(['error', 'warning']);
  });

  it('reads a decimal from a number or a decimal string', () => {
    expect(DecimalLiteralSchema.parse('0.5')).toBe('0.5');
    expect(DecimalLiteralSchema.parse(-12)).toBe(-12);
    expect(DecimalLiteralSchema.safeParse('1,5').success).toBe(false);
    expect(DecimalLiteralSchema.safeParse(Number.POSITIVE_INFINITY).success).toBe(false);
  });

  it('rejects a negative non-negative decimal', () => {
    expect(NonNegativeDecimalLiteralSchema.safeParse('0').success).toBe(true);
    expect(NonNegativeDecimalLiteralSchema.safeParse('-0.1').success).toBe(false);
    expect(NonNegativeDecimalLiteralSchema.safeParse(-1).success).toBe(false);
  });

  it('accepts string, number and boolean literals only', () => {
    for (const value of ['a', 1.5, true]) expect(LiteralSchema.safeParse(value).success).toBe(true);
    for (const value of [null, {}, []]) expect(LiteralSchema.safeParse(value).success).toBe(false);
  });
});
