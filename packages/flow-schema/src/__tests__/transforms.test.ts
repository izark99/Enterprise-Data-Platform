import { describe, expect, it } from 'vitest';
import {
  CodeSqlConfigSchema,
  DedupeConfigSchema,
  FilterConfigSchema,
  FormulaConfigSchema,
  GroupByConfigSchema,
  JoinConfigSchema,
  SelectConfigSchema,
  SortConfigSchema,
  UnionConfigSchema,
} from '../transforms';

function paths(result: { success: boolean; error?: { issues: { path: PropertyKey[] }[] } }) {
  return result.success ? [] : (result.error?.issues.map((issue) => issue.path) ?? []);
}

describe('transform defaults (minimal configs)', () => {
  it('select has no defaults and needs one column', () => {
    expect(SelectConfigSchema.parse({ columns: [{ from: 'a' }] })).toEqual({
      columns: [{ from: 'a' }],
    });
    expect(SelectConfigSchema.safeParse({ columns: [] }).success).toBe(false);
  });

  it('filter: match all, normalizeText true', () => {
    expect(FilterConfigSchema.parse({ conditions: [{ column: 'a', op: 'isBlank' }] })).toEqual({
      match: 'all',
      conditions: [{ column: 'a', op: 'isBlank' }],
      normalizeText: true,
    });
  });

  it('sort: direction asc, blanks last', () => {
    expect(SortConfigSchema.parse({ by: [{ column: 'a' }] })).toEqual({
      by: [{ column: 'a', direction: 'asc', blanks: 'last' }],
    });
  });

  it('join: normalizeKeys true, rightSuffix _r', () => {
    expect(JoinConfigSchema.parse({ how: 'left', on: [{ left: 'a', right: 'b' }] })).toEqual({
      how: 'left',
      on: [{ left: 'a', right: 'b' }],
      normalizeKeys: true,
      rightSuffix: '_r',
    });
  });

  it('union: inputCount 2, missingColumns null', () => {
    expect(UnionConfigSchema.parse({})).toEqual({ inputCount: 2, missingColumns: 'null' });
  });

  it('groupBy: by empty', () => {
    expect(GroupByConfigSchema.parse({ aggregations: [{ key: 'n', fn: 'countRows' }] })).toEqual({
      by: [],
      aggregations: [{ key: 'n', fn: 'countRows' }],
    });
  });

  it('dedupe: keep first, normalizeKeys true', () => {
    expect(DedupeConfigSchema.parse({ keys: ['a'] })).toEqual({
      keys: ['a'],
      keep: 'first',
      normalizeKeys: true,
    });
  });

  it('formula: type auto, onError blank', () => {
    expect(FormulaConfigSchema.parse({ columns: [{ key: 'x', formula: '=1' }] })).toEqual({
      columns: [{ key: 'x', formula: '=1', type: 'auto', onError: 'blank' }],
    });
  });
});

describe('transform limits and checks', () => {
  it('filter needs value or values according to the op', () => {
    const condition = (extra: object) => ({ conditions: [{ column: 'a', ...extra }] });
    expect(paths(FilterConfigSchema.safeParse(condition({ op: 'eq' })))).toEqual([
      ['conditions', 0, 'value'],
    ]);
    expect(paths(FilterConfigSchema.safeParse(condition({ op: 'in' })))).toEqual([
      ['conditions', 0, 'values'],
    ]);
    expect(
      FilterConfigSchema.safeParse(condition({ op: 'eq', value: { param: 'chi_nhanh' } })).success,
    ).toBe(true);
    expect(
      FilterConfigSchema.safeParse(condition({ op: 'in', values: Array(501).fill('x') })).success,
    ).toBe(false);
  });

  it('join rejects a suffix without a leading underscore', () => {
    expect(
      JoinConfigSchema.safeParse({
        how: 'inner',
        on: [{ left: 'a', right: 'a' }],
        rightSuffix: 'r',
      }).success,
    ).toBe(false);
  });

  it('union needs one label per input and 2..10 inputs', () => {
    expect(
      paths(
        UnionConfigSchema.safeParse({
          inputCount: 3,
          sourceColumn: { key: 'nguon', labels: ['a'] },
        }),
      ),
    ).toEqual([['sourceColumn', 'labels']]);
    expect(UnionConfigSchema.safeParse({ inputCount: 1 }).success).toBe(false);
    expect(UnionConfigSchema.safeParse({ inputCount: 11 }).success).toBe(false);
  });

  it('groupBy needs a column except for countRows', () => {
    expect(
      paths(GroupByConfigSchema.safeParse({ aggregations: [{ key: 's', fn: 'sum' }] })),
    ).toEqual([['aggregations', 0, 'column']]);
  });

  it('code.sql rejects a repeated port and bounds inputs and sql', () => {
    expect(
      paths(
        CodeSqlConfigSchema.safeParse({ inputs: [{ port: 'a' }, { port: 'a' }], sql: 'select 1' }),
      ),
    ).toEqual([['inputs', 1, 'port']]);
    expect(CodeSqlConfigSchema.safeParse({ inputs: [], sql: 'select 1' }).success).toBe(false);
    expect(CodeSqlConfigSchema.safeParse({ inputs: [{ port: 'a' }], sql: '' }).success).toBe(false);
    expect(
      CodeSqlConfigSchema.safeParse({ inputs: [{ port: 'a' }], sql: 'x'.repeat(100_001) }).success,
    ).toBe(false);
  });

  it('formula rejects a repeated key, a long formula and more than 50 columns', () => {
    const column = { key: 'x', formula: '=1' };
    expect(paths(FormulaConfigSchema.safeParse({ columns: [column, column] }))).toEqual([
      ['columns', 1, 'key'],
    ]);
    expect(
      FormulaConfigSchema.safeParse({ columns: [{ key: 'x', formula: '='.repeat(2001) }] }).success,
    ).toBe(false);
    const many = Array.from({ length: 51 }, (_, i) => ({ key: `c${i}`, formula: '=1' }));
    expect(FormulaConfigSchema.safeParse({ columns: many }).success).toBe(false);
    expect(
      FormulaConfigSchema.safeParse({ columns: [{ ...column, type: 'datetime' }] }).success,
    ).toBe(false);
  });
});
