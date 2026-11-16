import { describe, expect, it } from 'vitest';
import { FlowDefinitionSchema } from '../flow';
import { migrateFlowDefinition } from '../migrate';

const column = { key: 'ma_nv', aliases: ['Mã NV'], type: 'string' };

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

describe('migrateFlowDefinition', () => {
  const raw = {
    schemaVersion: 1,
    inputSlots: [
      { key: 'bang_luong', label: 'Bảng lương', accept: ['.xlsx', '.CSV'], columns: [column] },
      { key: 'cham_cong', label: 'Chấm công', accept: ['.csv'], columns: [column] },
      { key: 'khac', label: 'Khác', accept: ['.xls'], columns: [column] },
    ],
    nodes: [{ id: 'a', type: 'input.excel', config: { slot: 'bang_luong' } }],
  };

  it('removes .csv, replaces a csv-only accept and names each slot label', () => {
    const before: unknown = JSON.parse(JSON.stringify(raw));
    const { definition, notices } = migrateFlowDefinition(deepFreeze(raw));
    expect(notices).toEqual([
      { code: 'acceptCsvRemoved', slot: 'bang_luong', label: 'Bảng lương' },
      { code: 'acceptCsvOnlyReplaced', slot: 'cham_cong', label: 'Chấm công' },
    ]);
    const parsed = FlowDefinitionSchema.parse(definition);
    expect(parsed.inputSlots.map((slot) => slot.accept)).toEqual([
      ['.xlsx'],
      ['.xlsx', '.xls'],
      ['.xls'],
    ]);
    expect(raw).toEqual(before);
  });

  it('returns the same object and no notice when nothing changes', () => {
    const clean = { schemaVersion: 1, inputSlots: [], nodes: [] };
    expect(migrateFlowDefinition(clean)).toEqual({ definition: clean, notices: [] });
    expect(migrateFlowDefinition(clean).definition).toBe(clean);
    expect(migrateFlowDefinition(null)).toEqual({ definition: null, notices: [] });
  });

  it('falls back to the key, then the index, for the notice label', () => {
    const { notices } = migrateFlowDefinition({
      inputSlots: [{ key: 'k', label: ' ', accept: ['.csv'] }, { accept: ['.csv'] }],
    });
    expect(notices.map((n) => [n.slot, n.label])).toEqual([
      ['k', 'k'],
      ['1', '1'],
    ]);
  });
});
