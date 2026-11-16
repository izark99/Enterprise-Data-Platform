import type { FlowDefinition } from '@hrflow/flow-schema';
import { describe, expect, it } from 'vitest';
import { EngineError } from '../core/errors';
import { planFlow } from '../core/planner';
import type { Schema } from '../core/types';
import { NODE_PLUGINS, type PortSchemas } from '../nodes/index';

/**
 * Design-time checks of the transform nodes and `output.preview` (spec §12.1, §13.2, T-R1-07
 * AC a): every error key a node lists, with its config field path. No DuckDB needed.
 */

const flow = (nodes: FlowDefinition['nodes'] = [], params: FlowDefinition['params'] = []) =>
  ({ schemaVersion: 1, params, inputSlots: [], nodes, edges: [] }) as FlowDefinition;

const COLS: Schema = [
  { key: 'ma', title: 'Mã', type: 'string' },
  { key: 'so', title: 'Số', type: 'integer' },
  { key: 'tien', title: 'Tiền', type: 'decimal' },
  { key: 'co', title: 'Có', type: 'boolean' },
  { key: 'ngay', title: 'Ngày', type: 'date' },
  { key: '_source_file', title: '_source_file', type: 'string' },
];

function infer(type: string, config: unknown, inputs: PortSchemas = { in: COLS }) {
  const plugin = NODE_PLUGINS[type]!;
  const parsed = plugin.configSchema.safeParse(config);
  if (!parsed.success) throw new Error('test config does not parse');
  return plugin.inferSchema(parsed.data, inputs, { flow: flow() });
}

function failure(type: string, config: unknown, inputs?: PortSchemas): EngineError {
  try {
    infer(type, config, inputs);
  } catch (err) {
    if (err instanceof EngineError) return err;
    throw err;
  }
  throw new Error('expected an EngineError');
}

const expectError = (
  err: EngineError,
  messageKey: string,
  path: (string | number)[] | undefined,
  params?: object,
) => {
  expect(err.messageKey).toBe(messageKey);
  expect(err.path).toEqual(path);
  if (params) expect(err.params).toEqual(params);
};

describe('transform.select errors', () => {
  it('unknownColumn, duplicateKey, reservedKey', () => {
    expectError(
      failure('transform.select', { columns: [{ from: 'ma' }, { from: 'x' }] }),
      'select.error.unknownColumn',
      ['columns', 1, 'from'],
      { column: 'x' },
    );
    expectError(
      failure('transform.select', { columns: [{ from: 'ma' }, { from: 'so', key: 'ma' }] }),
      'select.error.duplicateKey',
      ['columns', 1, 'key'],
      { key: 'ma' },
    );
    expectError(
      failure('transform.select', { columns: [{ from: 'ma', key: '_ma' }] }),
      'select.error.reservedKey',
      ['columns', 0, 'key'],
    );
    // A system column keeps its own name.
    expect(infer('transform.select', { columns: [{ from: '_source_file' }] })).toEqual({
      out: [COLS[5]],
    });
  });
});

describe('transform.filter errors', () => {
  const cond = (c: object) => ({ conditions: [{ column: 'ma', op: 'isBlank' }, c] });

  it('unknownColumn, opNotForType, invalidValue', () => {
    expectError(
      failure('transform.filter', cond({ column: 'x', op: 'isBlank' })),
      'filter.error.unknownColumn',
      ['conditions', 1, 'column'],
    );
    expectError(
      failure('transform.filter', cond({ column: 'co', op: 'gt', value: true })),
      'filter.error.opNotForType',
      ['conditions', 1, 'op'],
      { column: 'co', type: 'boolean' },
    );
    expectError(
      failure('transform.filter', cond({ column: 'so', op: 'contains', value: '1' })),
      'filter.error.opNotForType',
      ['conditions', 1, 'op'],
    );
    for (const [column, value] of [
      ['so', 'abc'],
      ['so', 1.5],
      ['tien', '1,5'],
      ['ngay', '2026-13-01'],
      ['ngay', '01/02/2026'],
      ['co', 'yes'],
      ['ma', true],
    ] as const) {
      expectError(
        failure('transform.filter', cond({ column, op: 'eq', value })),
        'filter.error.invalidValue',
        ['conditions', 1, 'value'],
      );
    }
    expectError(
      failure('transform.filter', cond({ column: 'so', op: 'in', values: [1, 'x'] })),
      'filter.error.invalidValue',
      ['conditions', 1, 'values', 1],
    );
    expect(infer('transform.filter', cond({ column: 'tien', op: 'gte', value: '0.5' }))).toEqual({
      out: COLS,
    });
  });

  it('unknownParam at plan time, with the node id', () => {
    const config = { conditions: [{ column: 'ma', op: 'eq', value: { param: 'chi_nhanh' } }] };
    const plugin = NODE_PLUGINS['transform.filter']!;
    const parsed = plugin.configSchema.safeParse(config);
    if (!parsed.success) throw new Error('test config does not parse');
    const [problem] = plugin.checkConfig!(parsed.data, flow());
    expectError(problem!, 'filter.error.unknownParam', ['conditions', 0, 'value', 'param'], {
      param: 'chi_nhanh',
    });
    const declared = flow([], [{ key: 'chi_nhanh', label: 'CN', type: 'string', required: false }]);
    expect(plugin.checkConfig!(parsed.data, declared)).toEqual([]);
    const def = flow([{ id: 'f', type: 'transform.filter', config }]);
    expect(() => planFlow(def)).toThrow(
      expect.objectContaining({ messageKey: 'filter.error.unknownParam', nodeId: 'f' }),
    );
  });
});

describe('transform.sort errors', () => {
  it('unknownColumn', () => {
    expectError(
      failure('transform.sort', { by: [{ column: 'ma' }, { column: 'x' }] }),
      'sort.error.unknownColumn',
      ['by', 1, 'column'],
    );
  });

  it('runs in TypeScript only with a string column', () => {
    const plugin = NODE_PLUGINS['transform.sort']!;
    const on = (column: string) => plugin.runsInSql!({ by: [{ column }] }, { in: COLS });
    expect(on('ma')).toBe(false);
    expect(on('so')).toBe(true);
    expect(on('ngay')).toBe(true);
  });
});

describe('transform.join errors', () => {
  const right: Schema = [
    { key: 'ma', title: 'Mã', type: 'string' },
    { key: 'so', title: 'Số', type: 'decimal' },
    { key: 'so_r', title: 'Số R', type: 'integer' },
  ];
  const join = (config: object) =>
    failure('transform.join', { how: 'inner', ...config }, { left: COLS, right });

  it('unknownColumn, keyTypeMismatch, columnConflict', () => {
    expectError(join({ on: [{ left: 'x', right: 'ma' }] }), 'join.error.unknownColumn', [
      'on',
      0,
      'left',
    ]);
    expectError(join({ on: [{ left: 'ma', right: 'x' }] }), 'join.error.unknownColumn', [
      'on',
      0,
      'right',
    ]);
    expectError(
      join({ on: [{ left: 'ma', right: 'ma' }], rightColumns: ['x'] }),
      'join.error.unknownColumn',
      ['rightColumns', 0],
    );
    expectError(
      join({ on: [{ left: 'ma', right: 'so' }] }),
      'join.error.keyTypeMismatch',
      ['on', 0],
      {
        left: 'ma',
        right: 'so',
      },
    );
    // `so` → `so_r`, which the right side already has.
    expectError(
      join({ on: [{ left: 'ma', right: 'ma' }], rightColumns: ['so_r', 'so'] }),
      'join.error.columnConflict',
      ['rightColumns', 1],
      { column: 'so' },
    );
  });

  it('integer and decimal keys are compatible', () => {
    const out = infer(
      'transform.join',
      { how: 'full', on: [{ left: 'so', right: 'so' }], rightColumns: ['ma'] },
      { left: COLS, right },
    ) as PortSchemas;
    expect(out['out']!.map((c) => `${c.key}:${c.type}`)).toEqual([
      'ma:string',
      'so:decimal',
      'tien:decimal',
      'co:boolean',
      'ngay:date',
      '_source_file:string',
      'ma_r:string',
    ]);
  });
});

describe('transform.union errors', () => {
  const a: Schema = [{ key: 'ma', title: 'Mã', type: 'string' }];
  const b: Schema = [
    { key: 'ma', title: 'Mã', type: 'integer' },
    { key: 'x', title: 'X', type: 'string' },
  ];
  it('typeMismatch, missingColumn, duplicateKey', () => {
    expectError(
      failure('transform.union', {}, { in_1: a, in_2: b }),
      'union.error.typeMismatch',
      undefined,
      { column: 'ma' },
    );
    const c: Schema = [b[1]!];
    expectError(
      failure('transform.union', { missingColumns: 'error' }, { in_1: a, in_2: c }),
      'union.error.missingColumn',
      ['missingColumns'],
      { port: 'in_1', column: 'x' },
    );
    expectError(
      failure(
        'transform.union',
        { sourceColumn: { key: 'x', labels: ['A', 'B'] } },
        { in_1: a, in_2: c },
      ),
      'union.error.duplicateKey',
      ['sourceColumn', 'key'],
      { key: 'x' },
    );
  });

  it('has one required port per input', () => {
    const plugin = NODE_PLUGINS['transform.union']!;
    expect(plugin.inputPorts!({ inputCount: 3, missingColumns: 'null' })).toEqual([
      { name: 'in_1', required: true },
      { name: 'in_2', required: true },
      { name: 'in_3', required: true },
    ]);
  });
});

describe('transform.groupBy errors', () => {
  const agg = (a: object) => ({ by: ['ma'], aggregations: [a] });
  it('unknownColumn, fnNotForType, duplicateKey', () => {
    expectError(
      failure('transform.groupBy', { by: ['x'], aggregations: [{ key: 'n', fn: 'countRows' }] }),
      'groupBy.error.unknownColumn',
      ['by', 0],
    );
    expectError(
      failure('transform.groupBy', agg({ key: 'n', fn: 'sum', column: 'x' })),
      'groupBy.error.unknownColumn',
      ['aggregations', 0, 'column'],
    );
    for (const [fn, column] of [
      ['sum', 'ma'],
      ['avg', 'ngay'],
      ['min', 'co'],
      ['max', 'co'],
    ] as const) {
      expectError(
        failure('transform.groupBy', agg({ key: 'n', fn, column })),
        'groupBy.error.fnNotForType',
        ['aggregations', 0, 'fn'],
      );
    }
    expectError(
      failure('transform.groupBy', agg({ key: 'ma', fn: 'countRows' })),
      'groupBy.error.duplicateKey',
      ['aggregations', 0, 'key'],
    );
    expectError(
      failure('transform.groupBy', {
        by: ['ma', 'ma'],
        aggregations: [{ key: 'n', fn: 'countRows' }],
      }),
      'groupBy.error.duplicateKey',
      ['by', 1],
    );
  });
});

describe('transform.dedupe errors', () => {
  it('unknownColumn', () => {
    expectError(failure('transform.dedupe', { keys: ['ma', 'x'] }), 'dedupe.error.unknownColumn', [
      'keys',
      1,
    ]);
    expect(infer('transform.dedupe', { keys: ['ma'] })).toEqual({ out: COLS, removed: COLS });
  });
});

describe('output.preview errors', () => {
  it('unknownColumn', () => {
    expectError(
      failure('output.preview', { title: 'Xem', columns: ['ma', 'x'] }),
      'preview.error.unknownColumn',
      ['columns', 1],
    );
    expect(infer('output.preview', { title: 'Xem' })).toEqual({});
  });

  it('duplicateTitle against another preview or an Excel sheet, ignoring case', () => {
    const plugin = NODE_PLUGINS['output.preview']!;
    const nodes: FlowDefinition['nodes'] = [
      { id: 'p1', type: 'output.preview', config: { title: 'Tổng hợp' } },
      { id: 'p2', type: 'output.preview', config: { title: 'tổng hợp ' } },
      { id: 'p3', type: 'output.preview', config: { title: 'Lệch' } },
      {
        id: 'x',
        type: 'output.excel',
        config: { sheets: [{ name: 'LỆCH', port: 'a' }] },
      },
      { id: 'p4', type: 'output.preview', config: { title: 'Riêng' } },
    ];
    const check = (title: string) => {
      const parsed = plugin.configSchema.safeParse({ title });
      if (!parsed.success) throw new Error('test config does not parse');
      return plugin.checkConfig!(parsed.data, flow(nodes));
    };
    expectError(check('Tổng hợp')[0]!, 'preview.error.duplicateTitle', ['title']);
    expectError(check('Lệch')[0]!, 'preview.error.duplicateTitle', ['title']);
    expect(check('Riêng')).toEqual([]);
  });
});
