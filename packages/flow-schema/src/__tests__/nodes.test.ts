import { describe, expect, it } from 'vitest';
import {
  CompareConfigSchema,
  ExcelSheetNameSchema,
  InputExcelConfigSchema,
  OutputExcelConfigSchema,
  OutputPreviewConfigSchema,
} from '../nodes';

describe('input.excel', () => {
  it('needs an identifier slot', () => {
    expect(InputExcelConfigSchema.parse({ slot: 'bang_luong' })).toEqual({ slot: 'bang_luong' });
    expect(InputExcelConfigSchema.safeParse({ slot: 'Bảng lương' }).success).toBe(false);
  });
});

describe('control.compare', () => {
  const metric = { left: 'cong', right: 'cong', label: 'Công' };

  it('fills the defaults of a minimal config', () => {
    expect(CompareConfigSchema.parse({ keys: ['ma_nv'], metrics: [metric] })).toEqual({
      keys: ['ma_nv'],
      metrics: [{ ...metric, tolerance: '0' }],
      carryColumns: [],
      nullAsZero: true,
    });
  });

  it('rejects a negative tolerance and a repeated metric label', () => {
    expect(
      CompareConfigSchema.safeParse({ keys: ['k'], metrics: [{ ...metric, tolerance: '-1' }] })
        .success,
    ).toBe(false);
    const result = CompareConfigSchema.safeParse({ keys: ['k'], metrics: [metric, metric] });
    expect(result.success ? [] : result.error.issues.map((issue) => issue.path)).toEqual([
      ['metrics', 1, 'label'],
    ]);
  });
});

describe('output.excel', () => {
  const sheet = { name: 'Lệch', port: 'mismatched' };

  it('defaults the file name', () => {
    expect(OutputExcelConfigSchema.parse({ sheets: [sheet] })).toEqual({
      fileName: 'output.xlsx',
      sheets: [sheet],
    });
  });

  it('rejects sheet names Excel refuses and names equal without case', () => {
    for (const name of ['', 'a/b', 'x[1]', "'quoted", 'x'.repeat(32)]) {
      expect(ExcelSheetNameSchema.safeParse(name).success).toBe(false);
    }
    expect(ExcelSheetNameSchema.safeParse('Tổng hợp').success).toBe(true);
    const result = OutputExcelConfigSchema.safeParse({
      sheets: [sheet, { name: 'LỆCH', port: 'other' }],
    });
    expect(result.success ? [] : result.error.issues.map((issue) => issue.path)).toEqual([
      ['sheets', 1, 'name'],
    ]);
  });
});

describe('output.preview', () => {
  it('defaults maxRows to 100,000 and leaves columns unset', () => {
    expect(OutputPreviewConfigSchema.parse({ title: 'Xem trước' })).toEqual({
      title: 'Xem trước',
      maxRows: 100_000,
    });
  });

  it('bounds the title and maxRows', () => {
    expect(OutputPreviewConfigSchema.safeParse({ title: '  ' }).success).toBe(false);
    expect(OutputPreviewConfigSchema.safeParse({ title: 'x'.repeat(61) }).success).toBe(false);
    expect(OutputPreviewConfigSchema.safeParse({ title: 'a', maxRows: 0 }).success).toBe(false);
    expect(OutputPreviewConfigSchema.safeParse({ title: 'a', maxRows: 1_000_001 }).success).toBe(
      false,
    );
  });
});
