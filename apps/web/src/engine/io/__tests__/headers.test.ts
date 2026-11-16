import { InputSlotSchema } from '@hrflow/flow-schema';
import { describe, expect, it } from 'vitest';
import { normalizeHeader, readHeaders, slugifyHeader } from '../headers';
import { GridBuilder } from '../xlsx-stream';

describe('headers', () => {
  it('normalises diacritics, case and whitespace, keeps punctuation', () => {
    expect(normalizeHeader('  Mã  NV\n')).toBe('ma nv');
    expect(normalizeHeader('ĐẶNG Thị')).toBe('dang thi');
    expect(normalizeHeader('OT (giờ)')).toBe('ot (gio)');
    expect(normalizeHeader('Mà')).toBe('ma');
    expect(slugifyHeader('2024 Ghi chú!')).toBe('col_2024_ghi_chu');
    expect(slugifyHeader('***')).toBe('col');
  });

  it('joins multi-row headers with " / ", follows merged group titles, matches aliases', () => {
    const g = new GridBuilder();
    g.text(0, 0, 'Mã NV');
    g.text(0, 1, 'Thu nhập');
    g.text(1, 1, 'Lương');
    g.text(1, 2, 'Phụ cấp');
    g.text(0, 3, 'Ghi chú');
    g.merge({ r1: 0, c1: 0, r2: 1, c2: 0 });
    g.merge({ r1: 0, c1: 1, r2: 0, c2: 2 });
    const slot = InputSlotSchema.parse({
      key: 's',
      label: 'S',
      headerRows: 2,
      columns: [
        { key: 'ma', aliases: ['ma nv'], type: 'string' },
        { key: 'luong', aliases: ['THU NHAP / LUONG'], type: 'decimal' },
        { key: 'pc', aliases: ['Thu nhập / Phụ cấp', 'Ghi chú'], type: 'decimal' },
      ],
    });
    const m = readHeaders(slot, g.finish());
    expect(m.headers).toEqual(['Mã NV', 'Thu nhập / Lương', 'Thu nhập / Phụ cấp', 'Ghi chú']);
    expect(m.matches.get('ma')).toEqual([0]);
    expect(m.matches.get('luong')).toEqual([1]);
    expect(m.matches.get('pc')).toEqual([2, 3]);
  });
});
