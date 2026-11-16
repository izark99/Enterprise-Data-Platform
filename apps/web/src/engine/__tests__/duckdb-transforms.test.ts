import { describe, expect, it } from 'vitest';
import { Big } from '../core/decimal';
import type { Schema } from '../core/types';
import {
  buildFlow,
  rowsOf,
  runFlow,
  schemaOf,
  type NodeSpec,
  type SourceData,
} from './duckdb-transform-helpers';

/**
 * Run behaviour of the transform nodes and `output.preview` (spec §12.1.1–§12.1.7, §12.1.10,
 * T-R1-07 AC b–f, h) over the Node DuckDB. Fake data only.
 */

const S = (key: string, type: Schema[number]['type'] = 'string', title = key.toUpperCase()) => ({
  key,
  title,
  type,
});

const PARAMS = ['chi_nhanh', 'p'].map((key) => ({
  key,
  label: key,
  type: 'string' as const,
  required: false,
}));

/** Runs `src → node` and returns the tables of the node's ports. */
async function runOne(
  data: Record<string, SourceData>,
  node: NodeSpec,
  inputs: [source: string, port?: string][] = [['a']],
  params: Record<string, string | number | boolean | null> = {},
) {
  const nodes: NodeSpec[] = Object.keys(data).map((name) => [name, 'test.source', { name }]);
  nodes.push(node);
  const flow = buildFlow(
    nodes,
    inputs.map(([src, port]) => [src, node[0], port]),
    PARAMS,
  );
  const result = await runFlow(flow, data, params);
  return { ports: result.outputs[node[0]] ?? {}, result };
}

describe('transform.select', () => {
  it('lists, renames and repeats columns in config order, titles default to the source', async () => {
    const a = {
      columns: [S('ma'), S('ten'), S('_source_file')],
      rows: [
        ['1', 'An', 'f1.xlsx'],
        ['2', 'Bình', 'f2.xlsx'],
      ],
    };
    const { ports } = await runOne({ a }, [
      'sel',
      'transform.select',
      {
        columns: [
          { from: 'ten', key: 'ho_ten', title: 'Họ tên' },
          { from: 'ma' },
          { from: 'ma', key: 'ma_2' },
          { from: '_source_file' },
        ],
      },
    ]);
    const out = ports['out']!;
    expect(schemaOf(out)).toEqual([
      { key: 'ho_ten', title: 'Họ tên', type: 'string' },
      { key: 'ma', title: 'MA', type: 'string' },
      { key: 'ma_2', title: 'MA', type: 'string' },
      { key: '_source_file', title: '_SOURCE_FILE', type: 'string' },
    ]);
    expect(rowsOf(out)).toEqual([
      ['An', '1', '1', 'f1.xlsx'],
      ['Bình', '2', '2', 'f2.xlsx'],
    ]);
  });
});

describe('transform.filter', () => {
  const a = {
    columns: [S('k'), S('n', 'integer'), S('d', 'decimal'), S('dt', 'date')],
    rows: [
      ['Hà Nội', 1, new Big('1.5'), '2026-01-01'],
      ['  ', 2, null, null],
      [null, null, new Big('2'), '2026-02-01'],
      ['HÀ  NỘI', 3, new Big('0.25'), '2026-03-01'],
      ['Huế', 4, new Big('10'), '2026-04-01'],
    ],
  };
  const keys = async (config: unknown, params: Record<string, string | null> = {}) => {
    const { ports } = await runOne({ a }, ['f', 'transform.filter', config], [['a']], params);
    return rowsOf(ports['out']!).map((r) => r[1]);
  };

  it('compares strings after normalisation by default, exactly when normalizeText is off', async () => {
    const eq = { column: 'k', op: 'eq', value: 'hà nội' };
    expect(await keys({ conditions: [eq] })).toEqual([1, 3]);
    expect(await keys({ conditions: [eq], normalizeText: false })).toEqual([]);
    expect(await keys({ conditions: [{ ...eq, value: 'Hà Nội' }], normalizeText: false })).toEqual([
      1,
    ]);
  });

  it('lets a blank cell meet only isBlank, neq, notIn and notContains', async () => {
    const on = (op: string, extra: object = {}) =>
      keys({ conditions: [{ column: 'k', op, ...extra }] });
    expect(await on('isBlank')).toEqual([2, null]);
    expect(await on('notBlank')).toEqual([1, 3, 4]);
    expect(await on('neq', { value: 'huế' })).toEqual([1, 2, null, 3]);
    expect(await on('notIn', { values: ['huế'] })).toEqual([1, 2, null, 3]);
    expect(await on('in', { values: ['huế', 'hà nội'] })).toEqual([1, 3, 4]);
    expect(await on('notContains', { value: 'nội' })).toEqual([2, null, 4]);
    expect(await on('contains', { value: 'nội' })).toEqual([1, 3]);
    expect(await on('startsWith', { value: 'h' })).toEqual([1, 3, 4]);
    expect(await on('endsWith', { value: 'ế' })).toEqual([4]);
  });

  it('casts values to the column type: integer, decimal, date', async () => {
    expect(await keys({ conditions: [{ column: 'n', op: 'gte', value: 3 }] })).toEqual([3, 4]);
    expect(await keys({ conditions: [{ column: 'd', op: 'lt', value: '1.5' }] })).toEqual([3]);
    expect(await keys({ conditions: [{ column: 'd', op: 'eq', value: 2 }] })).toEqual([null]);
    expect(await keys({ conditions: [{ column: 'dt', op: 'gt', value: '2026-02-01' }] })).toEqual([
      3, 4,
    ]);
  });

  it('combines with match all / any', async () => {
    const conditions = [
      { column: 'n', op: 'gt', value: 1 },
      { column: 'd', op: 'gt', value: '1' },
    ];
    expect(await keys({ conditions })).toEqual([4]);
    expect(await keys({ conditions, match: 'any' })).toEqual([1, 2, null, 3, 4]);
  });

  it('skips a condition whose parameter is empty (AC e)', async () => {
    const config = {
      conditions: [
        { column: 'k', op: 'eq', value: { param: 'chi_nhanh' } },
        { column: 'n', op: 'lte', value: 3 },
      ],
    };
    for (const empty of [null, '', '   ']) {
      expect(await keys(config, { chi_nhanh: empty })).toEqual([1, 2, 3]);
    }
    expect(await keys(config, {})).toEqual([1, 2, 3]);
    expect(await keys(config, { chi_nhanh: 'HUẾ' })).toEqual([]);
    expect(await keys(config, { chi_nhanh: 'Hà Nội' })).toEqual([1, 3]);
    // Every condition skipped: every row passes.
    expect(await keys({ conditions: [config.conditions[0]] }, { chi_nhanh: '' })).toEqual([
      1,
      2,
      null,
      3,
      4,
    ]);
  });

  it('binds a quote in a value as a value', async () => {
    const config = { conditions: [{ column: 'k', op: 'eq', value: "x' OR 1=1 --" }] };
    expect(await keys(config)).toEqual([]);
  });

  it('rejects a run parameter that does not read as the column type', async () => {
    const config = { conditions: [{ column: 'n', op: 'eq', value: { param: 'p' } }] };
    await expect(
      runOne({ a }, ['f', 'transform.filter', config], [['a']], { p: 'abc' }),
    ).rejects.toMatchObject({
      messageKey: 'filter.error.invalidValue',
      nodeId: 'f',
      path: ['conditions', 0, 'value'],
    });
  });
});

describe('transform.sort', () => {
  const names = {
    columns: [S('ten'), S('n', 'integer')],
    rows: [
      ['Em', 1],
      ['đào', 2],
      ['Dung', 3],
      [null, 4],
      ['dung', 5],
      ['Đặng', 6],
      ['Anh', 7],
      ['DUNG', 8],
    ],
  };

  it('sorts text in the Vietnamese alphabet without case, stable (AC c)', async () => {
    const { ports } = await runOne({ a: names }, [
      's',
      'transform.sort',
      { by: [{ column: 'ten' }] },
    ]);
    expect(rowsOf(ports['out']!)).toEqual([
      ['Anh', 7],
      ['Dung', 3],
      ['dung', 5],
      ['DUNG', 8],
      ['đào', 2],
      ['Đặng', 6],
      ['Em', 1],
      [null, 4],
    ]);
  });

  it('puts blanks first or last and sorts descending', async () => {
    const { ports } = await runOne({ a: names }, [
      's',
      'transform.sort',
      { by: [{ column: 'ten', direction: 'desc', blanks: 'first' }] },
    ]);
    expect(rowsOf(ports['out']!).map((r) => r[1])).toEqual([4, 1, 6, 2, 3, 5, 8, 7]);
  });

  it('sorts non-text columns in DuckDB, stable on equal keys', async () => {
    const a = {
      columns: [S('d', 'decimal'), S('n', 'integer'), S('dt', 'date')],
      rows: [
        [new Big('2'), 1, '2026-01-02'],
        [null, 2, '2026-01-01'],
        [new Big('1.5'), 3, '2026-01-01'],
        [new Big('2'), 4, null],
        [new Big('-1'), 5, '2026-01-03'],
      ],
    };
    const by = [{ column: 'd', direction: 'desc' }];
    const { ports } = await runOne({ a }, ['s', 'transform.sort', { by }]);
    expect(rowsOf(ports['out']!).map((r) => r[1])).toEqual([1, 4, 3, 5, 2]);
    const byDate = [
      { column: 'dt', blanks: 'first' },
      { column: 'n', direction: 'desc' },
    ];
    const second = await runOne({ a }, ['s', 'transform.sort', { by: byDate }]);
    expect(rowsOf(second.ports['out']!).map((r) => r[1])).toEqual([4, 3, 2, 1, 5]);
  });
});

describe('transform.join', () => {
  const left = {
    columns: [S('ma'), S('ten'), S('so', 'integer')],
    rows: [
      ['NV01', 'An', 1],
      ['nv02 ', 'Bình', 2],
      [null, 'Không mã', 3],
      ['NV03', 'Chi', 4],
      ['  ', 'Trắng', 5],
    ],
  };
  const right = {
    columns: [S('ma'), S('ten'), S('so', 'decimal'), S('luong', 'decimal')],
    rows: [
      ['NV02', 'B2', new Big('2'), new Big('20')],
      ['nv01', 'A1', new Big('1'), new Big('10')],
      [null, 'R-null', new Big('9'), new Big('90')],
      ['NV09', 'Z', new Big('9.5'), new Big('95')],
      ['  ', 'R-blank', new Big('8'), new Big('80')],
      ['NV01', 'A2', new Big('1'), new Big('11')],
    ],
  };
  const join = async (config: object) => {
    const { ports, result } = await runOne(
      { a: left, b: right },
      ['j', 'transform.join', { on: [{ left: 'ma', right: 'ma' }], ...config }],
      [
        ['a', 'left'],
        ['b', 'right'],
      ],
    );
    return { out: ports['out']!, warnings: result.warnings };
  };

  it('keeps left order then right order; right-only rows last; blank keys never match (AC b, d)', async () => {
    const { out } = await join({ how: 'full' });
    expect(out.columns.map((c) => c.key)).toEqual(['ma', 'ten', 'so', 'ten_r', 'so_r', 'luong']);
    expect(rowsOf(out).map((r) => [r[0], r[1], r[3]])).toEqual([
      ['NV01', 'An', 'A1'],
      ['NV01', 'An', 'A2'],
      ['nv02 ', 'Bình', 'B2'],
      [null, 'Không mã', null],
      ['NV03', 'Chi', null],
      ['  ', 'Trắng', null],
      [null, null, 'R-null'],
      ['NV09', null, 'Z'],
      ['  ', null, 'R-blank'],
    ]);
  });

  it('inner, left, right and anti', async () => {
    const tens = async (how: string) => rowsOf((await join({ how })).out).map((r) => [r[1], r[3]]);
    expect(await tens('inner')).toEqual([
      ['An', 'A1'],
      ['An', 'A2'],
      ['Bình', 'B2'],
    ]);
    expect((await tens('left')).map((r) => r[0])).toEqual([
      'An',
      'An',
      'Bình',
      'Không mã',
      'Chi',
      'Trắng',
    ]);
    expect(await tens('right')).toEqual([
      ['An', 'A1'],
      ['An', 'A2'],
      ['Bình', 'B2'],
      [null, 'R-null'],
      [null, 'Z'],
      [null, 'R-blank'],
    ]);
    const anti = (await join({ how: 'anti' })).out;
    expect(anti.columns.map((c) => c.key)).toEqual(['ma', 'ten', 'so']);
    expect(rowsOf(anti).map((r) => r[1])).toEqual(['Không mã', 'Chi', 'Trắng']);
  });

  it('matches exact text when normalizeKeys is off', async () => {
    const { out } = await join({ how: 'inner', normalizeKeys: false });
    expect(rowsOf(out).map((r) => r[3])).toEqual(['A2']);
  });

  it('matches integer with decimal keys; a right/full key column becomes decimal', async () => {
    const { ports } = await runOne(
      { a: left, b: right },
      [
        'j',
        'transform.join',
        { how: 'right', on: [{ left: 'so', right: 'so' }], rightColumns: ['ten'] },
      ],
      [
        ['a', 'left'],
        ['b', 'right'],
      ],
    );
    const out = ports['out']!;
    expect(out.columnDef('so')!.type).toBe('decimal');
    expect(rowsOf(out).map((r) => [r[2], r[3]])).toEqual([
      ['1', 'A1'],
      ['1', 'A2'],
      ['2', 'B2'],
      ['9', 'R-null'],
      ['9.5', 'Z'],
      ['8', 'R-blank'],
    ]);
  });

  it('warns with the number of multiplied keys only (AC d)', async () => {
    const { warnings } = await join({ how: 'left' });
    expect(warnings).toEqual([
      { nodeId: 'j', messageKey: 'join.warning.rowsMultiplied', params: { count: 1 } },
    ]);
    expect((await join({ how: 'anti' })).warnings).toEqual([]);
  });
});

describe('transform.union', () => {
  it('stacks ports in order, by key, blank for a missing column, integer + decimal = decimal (AC b)', async () => {
    const a = {
      columns: [S('ma'), S('so', 'integer')],
      rows: [
        ['A1', 1],
        ['A2', 2],
      ],
    };
    const b = {
      columns: [S('so', 'decimal', 'Số B'), S('ghi_chu'), S('ma')],
      rows: [[new Big('2.5'), 'x', 'B1']],
    };
    const { ports } = await runOne(
      { a, b },
      ['u', 'transform.union', { sourceColumn: { key: 'nguon', labels: ['Bên A', "Bên 'B'"] } }],
      [
        ['a', 'in_1'],
        ['b', 'in_2'],
      ],
    );
    const out = ports['out']!;
    expect(schemaOf(out)).toEqual([
      { key: 'ma', title: 'MA', type: 'string' },
      { key: 'so', title: 'SO', type: 'decimal' },
      { key: 'ghi_chu', title: 'GHI_CHU', type: 'string' },
      { key: 'nguon', title: 'nguon', type: 'string' },
    ]);
    expect(rowsOf(out)).toEqual([
      ['A1', '1', null, 'Bên A'],
      ['A2', '2', null, 'Bên A'],
      ['B1', '2.5', 'x', "Bên 'B'"],
    ]);
  });
});

describe('transform.groupBy', () => {
  const a = {
    columns: [S('cn'), S('ten'), S('d', 'decimal'), S('n', 'integer')],
    rows: [
      ['HN', 'Zung', new Big('0.1'), 1],
      ['HCM', 'An', new Big('1'), 2],
      ['HN', 'Đặng', new Big('0.2'), null],
      [null, 'X', null, 4],
      ['HCM', 'An', null, 5],
      ['  ', 'Y', new Big('3'), 6],
    ],
  };
  const aggregations = [
    { key: 'tong', fn: 'sum', column: 'd' },
    { key: 'tb', title: 'Trung bình', fn: 'avg', column: 'd' },
    { key: 'nho', fn: 'min', column: 'ten' },
    { key: 'lon', fn: 'max', column: 'ten' },
    { key: 'dem', fn: 'count', column: 'd' },
    { key: 'khac', fn: 'countDistinct', column: 'ten' },
    { key: 'dong', fn: 'countRows' },
    { key: 'tong_n', fn: 'sum', column: 'n' },
  ];

  it('groups in order of first appearance, blanks as one group, avg exact (AC b, f)', async () => {
    const { ports } = await runOne({ a }, ['g', 'transform.groupBy', { by: ['cn'], aggregations }]);
    const out = ports['out']!;
    expect(schemaOf(out)).toEqual([
      { key: 'cn', title: 'CN', type: 'string' },
      { key: 'tong', title: 'tong', type: 'decimal' },
      { key: 'tb', title: 'Trung bình', type: 'decimal' },
      { key: 'nho', title: 'nho', type: 'string' },
      { key: 'lon', title: 'lon', type: 'string' },
      { key: 'dem', title: 'dem', type: 'integer' },
      { key: 'khac', title: 'khac', type: 'integer' },
      { key: 'dong', title: 'dong', type: 'integer' },
      { key: 'tong_n', title: 'tong_n', type: 'integer' },
    ]);
    expect(rowsOf(out)).toEqual([
      // "Đặng" is above "Zung" in code-point order (binary), unlike the Vietnamese sort.
      ['HN', '0.3', '0.15', 'Zung', 'Đặng', 2, 2, 2, 1],
      ['HCM', '1', '1', 'An', 'An', 1, 1, 2, 7],
      [null, '3', '3', 'X', 'Y', 1, 2, 2, 10],
    ]);
  });

  it('rounds avg half-up to 10 places', async () => {
    const avgOf = async (values: string[]) => {
      const b = { columns: [S('d', 'decimal')], rows: values.map((v) => [new Big(v)]) };
      const avg = { aggregations: [{ key: 'tb', fn: 'avg', column: 'd' }] };
      const { ports } = await runOne({ a: b }, ['g', 'transform.groupBy', avg]);
      return ports['out']!.get(0, 'tb') as InstanceType<typeof Big>;
    };
    expect((await avgOf(['0.0000000003', '0'])).toFixed()).toBe('0.0000000002');
    expect((await avgOf(['-0.0000000003', '0'])).toFixed()).toBe('-0.0000000002');
    expect((await avgOf(['2', '0', '0'])).toFixed()).toBe('0.6666666667');
  });

  it('gives exactly one row for an empty by, even with no input row', async () => {
    const empty = { columns: a.columns, rows: [] };
    const { ports } = await runOne({ a: empty }, ['g', 'transform.groupBy', { aggregations }]);
    expect(rowsOf(ports['out']!)).toEqual([['0', null, null, null, 0, 0, 0, 0]]);
  });
});

describe('transform.dedupe', () => {
  const a = {
    columns: [S('ma'), S('n', 'integer')],
    rows: [
      ['NV01', 1],
      ['nv01 ', 2],
      [null, 3],
      ['NV02', 4],
      ['  ', 5],
      ['NV01', 6],
      [null, 7],
    ],
  };
  const run = async (config: object) => {
    const { ports } = await runOne({ a }, ['dd', 'transform.dedupe', { keys: ['ma'], ...config }]);
    return [rowsOf(ports['out']!).map((r) => r[1]), rowsOf(ports['removed']!).map((r) => r[1])];
  };

  it('keeps the first of each key, the others go to removed, input order kept (AC b)', async () => {
    expect(await run({})).toEqual([
      [1, 3, 4, 5, 7],
      [2, 6],
    ]);
  });

  it('keeps the last when asked; all-blank keys are never duplicates', async () => {
    expect(await run({ keep: 'last' })).toEqual([
      [3, 4, 5, 6, 7],
      [1, 2],
    ]);
  });

  it('compares exact text when normalizeKeys is off', async () => {
    expect(await run({ normalizeKeys: false })).toEqual([[1, 2, 3, 4, 5, 7], [6]]);
  });
});

describe('output.preview', () => {
  const a = {
    columns: [S('ma'), S('n', 'integer'), S('x')],
    rows: Array.from({ length: 7 }, (_, i) => [`M${i}`, i, 'x']),
  };

  it('keeps maxRows rows of the chosen columns and flags the cut (AC h)', async () => {
    const files: unknown[] = [];
    const flow = buildFlow(
      [
        ['a', 'test.source', { name: 'a' }],
        ['p', 'output.preview', { title: 'Xem', columns: ['n', 'ma'], maxRows: 3 }],
        ['q', 'output.preview', { title: 'Đủ' }],
      ],
      [
        ['a', 'p'],
        ['a', 'q'],
      ],
    );
    const result = await runFlow(
      flow,
      { a },
      {},
      {
        run: { slots: {}, params: {}, emitFile: (f) => files.push(f) },
      },
    );
    expect(files).toEqual([]);
    expect(result.outputs).toEqual({});
    const [p, q] = result.previews;
    expect(p).toMatchObject({ nodeId: 'p', title: 'Xem', totalRows: 7, truncated: true });
    expect(schemaOf(p!.table).map((c) => c.key)).toEqual(['n', 'ma']);
    expect(rowsOf(p!.table)).toEqual([
      [0, 'M0'],
      [1, 'M1'],
      [2, 'M2'],
    ]);
    expect(q).toMatchObject({ nodeId: 'q', totalRows: 7, truncated: false });
    expect(q!.table.rowCount).toBe(7);
  });
});
