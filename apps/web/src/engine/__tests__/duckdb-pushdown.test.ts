import {
  FlowDefinitionSchema,
  migrateFlowDefinition,
  type FlowDefinition,
} from '@hrflow/flow-schema';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { Big } from '../core/decimal';
import { executePlan, type RunProgressEvent } from '../core/executor';
import { planFlow } from '../core/planner';
import type { Schema } from '../core/types';
import type { DuckDb } from '../duckdb/db';
import { FIXTURE_FILES, readFixture } from '../io/__tests__/helpers';
import { readSlot, type SlotReadResult } from '../io/validation';
import { NODE_PLUGINS, type PortSchemas } from '../nodes/index';
import { nodeDuckDb } from './duckdb-node';
import {
  buildFlow,
  runFlow,
  schemaOf,
  scopeProvider,
  sourcePlugin,
  type NodeSpec,
  type SourceData,
} from './duckdb-transform-helpers';

/**
 * Pushdown (spec §13.1 "Thực thi", T-R1-07 AC g, i): consecutive DuckDB nodes run as one chain and
 * are materialised only before a TS node, for a result, or for several readers; DuckDB is opened
 * only for a DuckDB node; inferred schemas equal run schemas on a fixture-based flow.
 */

let db: DuckDb;
beforeAll(async () => {
  db = await nodeDuckDb();
});

/** Counts the statements that evaluate a chain into a table (`CREATE TABLE … AS …`). */
function countMaterialisations(): { readonly count: () => number; readonly stop: () => void } {
  const spy = vi.spyOn(db, 'exec');
  return {
    count: () =>
      spy.mock.calls.filter(([sql]) => /^CREATE TABLE "[a-z0-9_]+" AS /.test(sql)).length,
    stop: () => spy.mockRestore(),
  };
}

const people: SourceData = {
  columns: [
    { key: 'ma', title: 'Mã', type: 'string' },
    { key: 'cn', title: 'Chi nhánh', type: 'string' },
    { key: 'luong', title: 'Lương', type: 'decimal' },
  ],
  rows: [
    ['NV01', 'HN', new Big('10')],
    ['NV02', 'HCM', new Big('20.5')],
    ['NV03', 'HN', new Big('30')],
    ['NV04', 'ĐN', new Big('5')],
  ],
};
const bonus: SourceData = {
  columns: [
    { key: 'ma', title: 'Mã', type: 'string' },
    { key: 'thuong', title: 'Thưởng', type: 'decimal' },
  ],
  rows: [
    ['nv01', new Big('1')],
    ['NV03', new Big('2')],
    ['NV04', new Big('0.5')],
  ],
};
const data = { a: people, b: bonus };

const chain: NodeSpec[] = [
  ['a', 'test.source', { name: 'a' }],
  ['b', 'test.source', { name: 'b' }],
  ['sel', 'transform.select', { columns: [{ from: 'ma' }, { from: 'cn' }, { from: 'luong' }] }],
  ['flt', 'transform.filter', { conditions: [{ column: 'luong', op: 'gte', value: 10 }] }],
  ['jn', 'transform.join', { how: 'left', on: [{ left: 'ma', right: 'ma' }] }],
  [
    'grp',
    'transform.groupBy',
    {
      by: ['cn'],
      aggregations: [
        { key: 'tong', fn: 'sum', column: 'luong' },
        { key: 'thuong', fn: 'sum', column: 'thuong' },
      ],
    },
  ],
];

describe('pushdown (AC g)', () => {
  it('materialises a select → filter → join → groupBy chain once', async () => {
    const flow = buildFlow(chain, [
      ['a', 'sel'],
      ['sel', 'flt'],
      ['flt', 'jn', 'left'],
      ['b', 'jn', 'right'],
      ['jn', 'grp'],
    ]);
    const events: RunProgressEvent[] = [];
    const counter = countMaterialisations();
    try {
      const { outputs } = await runFlow(flow, data, {}, { onProgress: (e) => events.push(e) });
      expect(counter.count()).toBe(1);
      const out = outputs['grp']!['out']!;
      expect(out.rowCount).toBe(2);
      expect(out.get(0, 'cn')).toBe('HN');
      expect(String(out.get(0, 'tong'))).toBe('40');
      expect(String(out.get(0, 'thuong'))).toBe('3');
      expect(String(out.get(1, 'thuong'))).toBe('0');
    } finally {
      counter.stop();
    }
    // Rows of a lazy port are counted where it is materialised.
    const rows = Object.fromEntries(
      events.flatMap((e) => (e.type === 'node-finished' ? [[e.nodeId, e.rows]] : [])),
    );
    expect(rows).toEqual({
      a: { out: 4 },
      b: { out: 3 },
      sel: {},
      flt: {},
      jn: {},
      grp: { out: 2 },
    });
    const left = db.scalar("SELECT count(*) FROM duckdb_tables() WHERE table_name LIKE 'hr_tab_%'");
    expect(left).toBe('0');
  });

  it('materialises an output read by several nodes once, and before a TS node', async () => {
    const flow = buildFlow(
      [
        ['a', 'test.source', { name: 'a' }],
        ['sel', 'transform.select', { columns: [{ from: 'ma' }, { from: 'cn' }] }],
        ['f1', 'transform.filter', { conditions: [{ column: 'cn', op: 'eq', value: 'hn' }] }],
        ['f2', 'transform.filter', { conditions: [{ column: 'cn', op: 'neq', value: 'hn' }] }],
        ['srt', 'transform.sort', { by: [{ column: 'cn' }] }],
      ],
      [
        ['a', 'sel'],
        ['sel', 'f1'],
        ['sel', 'f2'],
        ['f2', 'srt'],
      ],
    );
    const counter = countMaterialisations();
    try {
      const { outputs } = await runFlow(flow, data);
      // `sel` (two readers), `f1` (a result), `f2` (read by the TS sort).
      expect(counter.count()).toBe(3);
      expect(outputs['f1']!['out']!.rowCount).toBe(2);
      expect(outputs['srt']!['out']!.rowCount).toBe(2);
      expect(outputs['srt']!['out']!.get(0, 'cn')).toBe('ĐN');
    } finally {
      counter.stop();
    }
  });
});

describe('lazy DuckDB (spec §13.1)', () => {
  it('opens no runtime for a flow without a DuckDB node', async () => {
    const provider = vi.fn(scopeProvider);
    const flow = buildFlow(
      [
        ['a', 'test.source', { name: 'a' }],
        [
          'srt',
          'transform.sort',
          { by: [{ column: 'cn' }, { column: 'luong', direction: 'desc' }] },
        ],
        ['p', 'output.preview', { title: 'Xem' }],
      ],
      [
        ['a', 'srt'],
        ['srt', 'p'],
      ],
    );
    const { previews } = await runFlow(flow, data, {}, { sql: provider });
    expect(provider).not.toHaveBeenCalled();
    expect(previews[0]!.table.rowCount).toBe(4);
  });

  it('opens the runtime once for a DuckDB flow', async () => {
    const provider = vi.fn(scopeProvider);
    const flow = buildFlow(chain, [
      ['a', 'sel'],
      ['sel', 'flt'],
      ['flt', 'jn', 'left'],
      ['b', 'jn', 'right'],
      ['jn', 'grp'],
    ]);
    await runFlow(flow, data, {}, { sql: provider });
    expect(provider).toHaveBeenCalledTimes(1);
  });

  it('reports duckdb.error.unavailable at the node when no runtime is given', async () => {
    const flow = buildFlow(chain.slice(0, 3), [['a', 'sel']]);
    const registry = { ...NODE_PLUGINS, 'test.source': sourcePlugin(data) };
    const err = await executePlan(flow, planFlow(flow, registry)).catch((e: unknown) => e);
    expect(err).toMatchObject({ messageKey: 'duckdb.error.unavailable', nodeId: 'sel' });
  });
});

describe('a failing step of a chain is reported at its node (owner 1A)', () => {
  // 31 integer digits: the cast of the bound value to DECIMAL(38,10) fails at run time.
  const tooBig = `1${'0'.repeat(30)}`;
  const params = [{ key: 'p', label: 'P', type: 'string' as const, required: false }];
  const over = (column: string) => ({
    conditions: [{ column, op: 'gt', value: { param: 'p' } }],
  });
  const fails = async (nodes: NodeSpec[], edges: [string, string][]) => {
    const flow = buildFlow([['a', 'test.source', { name: 'a' }], ...nodes], edges, params);
    const err = await runFlow(flow, data, { p: tooBig }).catch((e: unknown) => e);
    const left = db.scalar("SELECT count(*) FROM duckdb_tables() WHERE table_name LIKE 'hr_tab_%'");
    expect(left).toBe('0');
    return err;
  };
  const sel = (): NodeSpec => [
    'sel',
    'transform.select',
    { columns: [{ from: 'cn' }, { from: 'luong' }] },
  ];
  const grp = (): NodeSpec => [
    'grp',
    'transform.groupBy',
    { by: ['cn'], aggregations: [{ key: 'tong', fn: 'sum', column: 'luong' }] },
  ];

  it('in the middle of the chain', async () => {
    const err = await fails(
      [
        sel(),
        ['flt', 'transform.filter', over('luong')],
        ['srt', 'transform.sort', { by: [{ column: 'luong' }] }],
        grp(),
      ],
      [
        ['a', 'sel'],
        ['sel', 'flt'],
        ['flt', 'srt'],
        ['srt', 'grp'],
      ],
    );
    expect(err).toMatchObject({ messageKey: 'duckdb.error.queryFailed', nodeId: 'flt' });
    expect((err as { params: object }).params).toEqual({ node: 'flt' });
  });

  it('at the first step of the chain', async () => {
    const err = await fails(
      [['flt', 'transform.filter', over('luong')], sel(), grp()],
      [
        ['a', 'flt'],
        ['flt', 'sel'],
        ['sel', 'grp'],
      ],
    );
    expect(err).toMatchObject({ messageKey: 'duckdb.error.queryFailed', nodeId: 'flt' });
  });

  it('at the last step of the chain', async () => {
    const err = await fails(
      [sel(), grp(), ['flt', 'transform.filter', over('tong')]],
      [
        ['a', 'sel'],
        ['sel', 'grp'],
        ['grp', 'flt'],
      ],
    );
    expect(err).toMatchObject({ messageKey: 'duckdb.error.queryFailed', nodeId: 'flt' });
  });

  it('in a chain read by a TS node', async () => {
    const err = await fails(
      [
        ['flt', 'transform.filter', over('luong')],
        sel(),
        ['srt', 'transform.sort', { by: [{ column: 'cn' }] }],
      ],
      [
        ['a', 'flt'],
        ['flt', 'sel'],
        ['sel', 'srt'],
      ],
    );
    expect(err).toMatchObject({ messageKey: 'duckdb.error.queryFailed', nodeId: 'flt' });
  });
});

// --- AC (i): inferred schema = run schema on a fixture-based flow --------------------------------

function fixtureFlow(): FlowDefinition {
  const raw = JSON.parse(new TextDecoder().decode(readFixture('flow.json'))) as unknown;
  const base = FlowDefinitionSchema.parse(migrateFlowDefinition(raw).definition);
  const nodes: FlowDefinition['nodes'] = [
    { id: 'in_luong', type: 'input.excel', config: { slot: 'bang_luong' } },
    { id: 'in_cc', type: 'input.excel', config: { slot: 'cham_cong' } },
    {
      id: 'sel',
      type: 'transform.select',
      config: {
        columns: [
          { from: 'ma_nv' },
          { from: 'ho_ten', key: 'ten', title: 'Tên' },
          { from: 'chi_nhanh' },
          { from: 'cong' },
          { from: 'ot' },
          { from: '_source_file' },
        ],
      },
    },
    {
      id: 'flt',
      type: 'transform.filter',
      config: {
        conditions: [
          { column: 'cong', op: 'gt', value: '0' },
          { column: 'chi_nhanh', op: 'eq', value: { param: 'chi_nhanh' } },
        ],
      },
    },
    { id: 'srt', type: 'transform.sort', config: { by: [{ column: 'ten' }] } },
    {
      id: 'jn',
      type: 'transform.join',
      config: { how: 'full', on: [{ left: 'ma_nv', right: 'ma_nv' }] },
    },
    {
      id: 'un',
      type: 'transform.union',
      config: { sourceColumn: { key: 'nguon', labels: ['Lương', 'Chấm công'] } },
    },
    {
      id: 'grp',
      type: 'transform.groupBy',
      config: {
        by: ['chi_nhanh'],
        aggregations: [
          { key: 'tong_cong', fn: 'sum', column: 'cong' },
          { key: 'tb_ot', title: 'OT trung bình', fn: 'avg', column: 'ot' },
          { key: 'ten_dau', fn: 'min', column: 'ten' },
          { key: 'ma_cuoi', fn: 'max', column: 'ma_nv' },
          { key: 'so_cong', fn: 'count', column: 'cong_r' },
          { key: 'so_file', fn: 'countDistinct', column: '_source_file' },
          { key: 'so_dong', fn: 'countRows' },
        ],
      },
    },
    { id: 'dd', type: 'transform.dedupe', config: { keys: ['ma_nv'] } },
    { id: 'pv', type: 'output.preview', config: { title: 'Theo chi nhánh', maxRows: 2 } },
  ];
  const edges: FlowDefinition['edges'] = [
    { from: 'in_luong', to: 'sel' },
    { from: 'sel', to: 'flt' },
    { from: 'flt', to: 'srt' },
    { from: 'srt', to: 'jn', toPort: 'left' },
    { from: 'in_cc', to: 'jn', toPort: 'right' },
    { from: 'in_luong', to: 'un', toPort: 'in_1' },
    { from: 'in_cc', to: 'un', toPort: 'in_2' },
    { from: 'jn', to: 'grp' },
    { from: 'un', to: 'dd' },
    { from: 'grp', to: 'pv' },
  ];
  const params = [
    ...base.params,
    { key: 'chi_nhanh', label: 'Chi nhánh', type: 'string' as const, required: false },
  ];
  return { ...base, params, nodes, edges };
}

function readSlots(flow: FlowDefinition): Record<string, SlotReadResult> {
  const prefix: Record<string, string> = { bang_luong: 'bang_luong_', cham_cong: 'cham_cong_' };
  const out: Record<string, SlotReadResult> = {};
  for (const slot of flow.inputSlots) {
    const files = FIXTURE_FILES.filter((f) => f.startsWith(prefix[slot.key]!)).map((name) => ({
      name,
      bytes: readFixture(name),
    }));
    out[slot.key] = readSlot(slot, files);
  }
  return out;
}

/** Schemas of every port, inferred from the slots and configs only (spec §13.2). */
async function inferAll(flow: FlowDefinition): Promise<Map<string, PortSchemas>> {
  const byNode = new Map<string, PortSchemas>();
  for (const step of planFlow(flow)) {
    const inputs: Record<string, Schema> = {};
    for (const link of step.inputs) inputs[link.port] = byNode.get(link.from)![link.fromPort]!;
    byNode.set(step.node.id, await step.plugin.inferSchema(step.config, inputs, { flow }));
  }
  return byNode;
}

/** The flow cut down to `target` and its ancestors (as a Designer node preview runs it). */
function upTo(flow: FlowDefinition, target: string): FlowDefinition {
  const keep = new Set([target]);
  for (let grew = true; grew;) {
    grew = false;
    for (const e of flow.edges) {
      if (keep.has(e.to) && !keep.has(e.from)) {
        keep.add(e.from);
        grew = true;
      }
    }
  }
  return {
    ...flow,
    nodes: flow.nodes.filter((n) => keep.has(n.id)),
    edges: flow.edges.filter((e) => keep.has(e.to)),
  };
}

describe('inferred schema = run schema on the fixture files (AC i)', () => {
  const flow = fixtureFlow();

  it.each(['in_luong', 'sel', 'flt', 'srt', 'jn', 'un', 'grp', 'dd'])('%s', async (target) => {
    const inferred = (await inferAll(flow)).get(target)!;
    const sub = upTo(flow, target);
    const result = await executePlan(sub, planFlow(sub), {
      sql: scopeProvider,
      run: {
        slots: readSlots(sub),
        params: { ky_luong: '2026-09', chi_nhanh: '' },
        emitFile: () => undefined,
      },
    });
    const ran = result.outputs[target]!;
    expect(Object.keys(ran).sort()).toEqual(Object.keys(inferred).sort());
    for (const [port, schema] of Object.entries(inferred)) {
      expect(schemaOf(ran[port]!)).toEqual(schema);
      expect(ran[port]!.rowCount).toBeGreaterThan(0);
    }
  });

  it('pv: the preview keeps the inferred input columns', async () => {
    const inferred = await inferAll(flow);
    expect(inferred.get('pv')).toEqual({});
    const sub = upTo(flow, 'pv');
    const result = await executePlan(sub, planFlow(sub), {
      sql: scopeProvider,
      run: { slots: readSlots(sub), params: { ky_luong: '2026-09' }, emitFile: () => undefined },
    });
    const [preview] = result.previews;
    expect(schemaOf(preview!.table)).toEqual(inferred.get('grp')!['out']);
    expect(preview!.table.rowCount).toBe(2);
    expect(preview!.truncated).toBe(preview!.totalRows > 2);
  });
});
