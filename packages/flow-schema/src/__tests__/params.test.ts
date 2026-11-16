import { describe, expect, it } from 'vitest';
import { FlowParamSchema } from '../params';

describe('FlowParamSchema', () => {
  it('applies the defaults to a minimal param', () => {
    expect(FlowParamSchema.parse({ key: 'ky_luong', label: 'Kỳ lương', type: 'month' })).toEqual({
      key: 'ky_luong',
      label: 'Kỳ lương',
      type: 'month',
      required: false,
    });
  });

  it('keeps log, isAsOfDate and both option forms', () => {
    const fromList = FlowParamSchema.parse({
      key: 'chi_nhanh',
      label: 'Chi nhánh',
      type: 'select',
      log: false,
      isAsOfDate: false,
      options: [{ value: 'cn01', label: 'CN01' }],
    });
    expect(fromList.log).toBe(false);
    expect(fromList.options).toEqual([{ value: 'cn01', label: 'CN01' }]);
    const fromRef = FlowParamSchema.parse({
      key: 'chi_nhanh',
      label: 'Chi nhánh',
      type: 'select',
      options: { fromRefTable: 'DM_CHI_NHANH', valueColumn: 'ma', labelColumn: 'ten' },
    });
    expect(fromRef.options).toEqual({
      fromRefTable: 'DM_CHI_NHANH',
      valueColumn: 'ma',
      labelColumn: 'ten',
    });
  });

  it('rejects an unknown type, an empty label and an unknown field', () => {
    const base = { key: 'p', label: 'P', type: 'string' };
    expect(FlowParamSchema.safeParse({ ...base, type: 'text' }).success).toBe(false);
    expect(FlowParamSchema.safeParse({ ...base, label: '' }).success).toBe(false);
    expect(FlowParamSchema.safeParse({ ...base, extra: 1 }).success).toBe(false);
  });
});
