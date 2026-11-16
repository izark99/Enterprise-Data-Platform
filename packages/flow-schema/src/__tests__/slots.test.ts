import { describe, expect, it } from 'vitest';
import { ColumnRuleSchema, InputSlotSchema, SlotColumnSchema } from '../slots';

const column = { key: 'ma_nv', aliases: ['Mã NV'], type: 'string' } as const;
const slot = { key: 'bang_luong', label: 'Bảng lương', columns: [column] };

function issuePaths(input: unknown): (string | number)[][] {
  const result = InputSlotSchema.safeParse(input);
  return result.success
    ? []
    : result.error.issues.map((issue) => issue.path as (string | number)[]);
}

describe('InputSlotSchema defaults', () => {
  it('fills every default of a minimal slot', () => {
    expect(InputSlotSchema.parse(slot)).toEqual({
      key: 'bang_luong',
      label: 'Bảng lương',
      required: true,
      accept: ['.xlsx'],
      sheet: { mode: 'byIndex', value: 0 },
      headerRow: 1,
      headerRows: 1,
      unmergeCells: 'none',
      columns: [
        {
          key: 'ma_nv',
          aliases: ['Mã NV'],
          type: 'string',
          presence: 'optional',
          required: false,
          rules: [],
          decimalSeparator: '.',
        },
      ],
      extraColumns: 'drop',
      multiple: { enabled: false, minFiles: 1, maxFiles: 50 },
    });
  });

  it('fills the defaults inside multiple and skipRows', () => {
    const parsed = InputSlotSchema.parse({
      ...slot,
      multiple: { enabled: true },
      skipRows: { whenBlank: ['ma_nv'] },
    });
    expect(parsed.multiple).toEqual({ enabled: true, minFiles: 1, maxFiles: 50 });
    expect(parsed.skipRows).toEqual({ whenBlank: ['ma_nv'], whenKeyContains: [] });
  });

  it('gives each rule the error severity', () => {
    expect(ColumnRuleSchema.parse({ unique: true })).toEqual({ unique: true, severity: 'error' });
    expect(ColumnRuleSchema.parse({ min: 0, severity: 'warning' })).toEqual({
      min: 0,
      severity: 'warning',
    });
  });
});

describe('SlotColumnSchema', () => {
  it('derives presence from required when presence is left out', () => {
    expect(SlotColumnSchema.parse({ ...column, required: true }).presence).toBe('required');
    expect(SlotColumnSchema.parse(column).presence).toBe('optional');
    expect(
      SlotColumnSchema.parse({ ...column, required: true, presence: 'optional' }).presence,
    ).toBe('optional');
  });

  it('checks defaultValue against required and the column type', () => {
    const decimal = { key: 'cong', aliases: ['Công'], type: 'decimal' } as const;
    expect(SlotColumnSchema.safeParse({ ...decimal, defaultValue: 0 }).success).toBe(true);
    expect(SlotColumnSchema.safeParse({ ...decimal, defaultValue: '1.5' }).success).toBe(true);
    expect(SlotColumnSchema.safeParse({ ...decimal, defaultValue: 'x' }).success).toBe(false);
    expect(
      SlotColumnSchema.safeParse({ ...decimal, required: true, defaultValue: 0 }).success,
    ).toBe(false);
    const date = { key: 'ngay', aliases: ['Ngày'], type: 'date' } as const;
    expect(SlotColumnSchema.safeParse({ ...date, defaultValue: '2026-09-01' }).success).toBe(true);
    expect(SlotColumnSchema.safeParse({ ...date, defaultValue: '01/09/2026' }).success).toBe(false);
  });

  it('rejects a reserved key, a broken regex and an unknown date format', () => {
    expect(SlotColumnSchema.safeParse({ ...column, key: '_x' }).success).toBe(false);
    expect(SlotColumnSchema.safeParse({ ...column, rules: [{ regex: '(' }] }).success).toBe(false);
    expect(SlotColumnSchema.safeParse({ ...column, dateFormats: ['dd/MM/yyyy'] }).success).toBe(
      true,
    );
    expect(SlotColumnSchema.safeParse({ ...column, dateFormats: ['%d'] }).success).toBe(false);
  });
});

describe('InputSlotSchema invariants', () => {
  it('reports a duplicate column key on the second column', () => {
    expect(issuePaths({ ...slot, columns: [column, column] })).toEqual([['columns', 1, 'key']]);
  });

  it('reports an unknown skipRows column', () => {
    expect(issuePaths({ ...slot, skipRows: { whenBlank: ['ma_nv', 'x'] } })).toEqual([
      ['skipRows', 'whenBlank', 1],
    ]);
  });

  it('reports a data row inside the header and minFiles above maxFiles', () => {
    expect(issuePaths({ ...slot, headerRow: 3, headerRows: 2, dataStartRow: 4 })).toEqual([
      ['dataStartRow'],
    ]);
    expect(issuePaths({ ...slot, multiple: { minFiles: 5, maxFiles: 2 } })).toEqual([
      ['multiple', 'minFiles'],
    ]);
  });

  it('rejects .csv, .xls and an empty accept list', () => {
    expect(InputSlotSchema.safeParse({ ...slot, accept: ['.csv'] }).success).toBe(false);
    expect(InputSlotSchema.safeParse({ ...slot, accept: ['.xls'] }).success).toBe(false);
    expect(InputSlotSchema.safeParse({ ...slot, accept: [] }).success).toBe(false);
  });
});
