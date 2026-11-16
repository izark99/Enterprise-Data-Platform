import {
  FlowDefinitionSchema,
  InputSlotSchema,
  migrateFlowDefinition,
  type CompareConfig,
  type CompareConfigInput,
  type FlowDefinition,
} from '@hrflow/flow-schema';
import { CompareConfigSchema } from '@hrflow/flow-schema';
import ExcelJS from 'exceljs';
import { describe, expect, it, vi } from 'vitest';
import { Big, isDecimal, type Decimal } from '../core/decimal';
import { EngineError } from '../core/errors';
import { executePlan } from '../core/executor';
import { planFlow } from '../core/planner';
import { Table } from '../core/table';
import type { Schema, Value } from '../core/types';
import { FIXTURE_FILES, readFixture } from '../io/__tests__/helpers';
import { readSlot, type SlotReadResult } from '../io/validation';
import { MISMATCHED_METRICS_COLUMN, executeCompare } from '../nodes/control-compare';
import { NODE_PLUGINS, type RunFile, type Translate } from '../nodes/index';
import { XLSX_MIME } from '../nodes/output-excel';
import * as duckdbLoader from '../duckdb/loader';

// Spy on the DuckDB loader (T-R1-06 step 7): this flow has no DuckDB node, so it never loads DuckDB.
vi.mock('../duckdb/loader', { spy: true });

/**
 * Acceptance flow of spec §24 (T-R1-05): the payroll–timesheet flow on the six fake fixture files
 * reproduces `fixtures/payroll-timesheet/expected.json`, without DuckDB.
 */

interface NodeFs {
  readFileSync(path: URL): Uint8Array;
  readdirSync(path: URL, options: { recursive: true }): string[];
}

// Node built-ins without Node types in the app tsconfig (same pattern as `io/__tests__/helpers.ts`).
const fs = (
  globalThis as unknown as { process: { getBuiltinModule(id: 'node:fs'): NodeFs } }
).process.getBuiltinModule('node:fs');

const readJson = (url: URL): unknown => JSON.parse(new TextDecoder().decode(fs.readFileSync(url)));

/** Translator from the owner-edited locale (read only; MEMORY 2026-11-16 12:41, 2A). */
function localeTranslator(): Translate {
  const texts = readJson(
    new URL('../../../../../docs/archive/locales-vi/engine.json', import.meta.url),
  ) as Record<string, unknown>;
  return (key, vars = {}) => {
    let node: unknown = texts;
    for (const part of key.split('.')) node = (node as Record<string, unknown> | undefined)?.[part];
    if (typeof node !== 'string') throw new Error(`missing locale key ${key}`);
    return node.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(vars[name] ?? ''));
  };
}

const t = localeTranslator();

interface Expected {
  tolerance: Record<string, string>;
  counts: Record<
    | 'payroll_rows'
    | 'timesheet_rows'
    | 'matched'
    | 'mismatched'
    | 'only_in_payroll'
    | 'only_in_timesheet',
    number
  >;
  mismatched: { ma_nv: string; diffs: Record<string, string> }[];
  only_in_payroll: string[];
  only_in_timesheet: string[];
}

const expected = readJson(
  new URL('../../../../../fixtures/payroll-timesheet/expected.json', import.meta.url),
) as Expected;

function fixtureFlow(): FlowDefinition {
  const raw = JSON.parse(new TextDecoder().decode(readFixture('flow.json'))) as unknown;
  return FlowDefinitionSchema.parse(migrateFlowDefinition(raw).definition);
}

/** The slots read and validated before the run (fresh tables: a run releases them). */
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

function withCompare(
  flow: FlowDefinition,
  change: (c: CompareConfigInput) => void,
): FlowDefinition {
  const nodes = flow.nodes.map((n) => {
    if (n.type !== 'control.compare') return n;
    const config = structuredClone(n.config) as CompareConfigInput;
    change(config);
    return { ...n, config };
  });
  return { ...flow, nodes };
}

/** The same flow without `output.excel`: the compare tables become the run results. */
function withoutOutput(flow: FlowDefinition): FlowDefinition {
  return {
    ...flow,
    nodes: flow.nodes.filter((n) => n.type !== 'output.excel'),
    edges: flow.edges.filter((e) => e.to !== 'out'),
  };
}

async function run(flow: FlowDefinition) {
  const files: RunFile[] = [];
  const slots = readSlots(flow);
  const result = await executePlan(flow, planFlow(flow), {
    t,
    run: { slots, params: { ky_luong: '2026-09' }, emitFile: (f) => files.push(f) },
  });
  return { files, slots, outputs: result.outputs };
}

async function compareTables(flow: FlowDefinition): Promise<Record<string, Table>> {
  const { outputs } = await run(withoutOutput(flow));
  return outputs['cmp']!;
}

function rows(table: Table): Record<string, Value>[] {
  return Array.from({ length: table.rowCount }, (_, i) =>
    Object.fromEntries(table.columns.map((c) => [c.key, table.get(i, c.key)])),
  );
}

const dec = (v: Value | undefined): Decimal => {
  if (!isDecimal(v)) throw new Error('not a decimal');
  return v;
};

/** Metric label → metric column key in `expected.json`. */
function metricKeys(flow: FlowDefinition): Map<string, string> {
  const node = flow.nodes.find((n) => n.type === 'control.compare')!;
  const config = CompareConfigSchema.parse(node.config);
  return new Map(config.metrics.map((m) => [m.label, m.left]));
}

describe('payroll–timesheet acceptance flow (spec §24, T-R1-05)', () => {
  const flow = fixtureFlow();
  const metrics = metricKeys(flow);

  it('reproduces expected.json field by field (AC a, AC-04)', async () => {
    const left = readSlots(flow);
    expect(left['bang_luong']!.report.errorCount).toBe(0);
    expect(left['cham_cong']!.report.errorCount).toBe(0);
    const tables = await compareTables(flow);
    expect(left['bang_luong']!.table.rowCount).toBe(expected.counts.payroll_rows);
    expect(left['cham_cong']!.table.rowCount).toBe(expected.counts.timesheet_rows);

    const summary = rows(tables['summary']!);
    const total = summary.at(-1)!;
    expect(total['metric']).toBe('Tổng (theo khóa)');
    expect(total['matched']).toBe(expected.counts.matched);
    expect(total['mismatched']).toBe(expected.counts.mismatched);
    expect(total['only_left']).toBe(expected.counts.only_in_payroll);
    expect(total['only_right']).toBe(expected.counts.only_in_timesheet);

    // One summary row per metric: tolerance, and the keys failing that metric in expected.json.
    expect(summary.slice(0, -1).map((r) => r['metric'])).toEqual([...metrics.keys()]);
    for (const r of summary.slice(0, -1)) {
      const key = metrics.get(r['metric'] as string)!;
      expect(dec(r['tolerance']).eq(new Big(expected.tolerance[key]!))).toBe(true);
      const failing = expected.mismatched.filter((m) => key in m.diffs).length;
      expect(r['mismatched']).toBe(failing);
      expect(r['matched']).toBe(expected.counts.matched + expected.counts.mismatched - failing);
      expect(r['only_left']).toBe(expected.counts.only_in_payroll);
      expect(r['only_right']).toBe(expected.counts.only_in_timesheet);
    }

    const mismatched = rows(tables['mismatched']!);
    expect(mismatched.map((r) => r['ma_nv'])).toEqual(expected.mismatched.map((m) => m.ma_nv));
    mismatched.forEach((r, i) => {
      const want = expected.mismatched[i]!;
      const failed = (r[MISMATCHED_METRICS_COLUMN] as string).split(', ');
      expect(failed.map((label) => metrics.get(label)).sort()).toEqual(
        Object.keys(want.diffs).sort(),
      );
      expect(r['ho_ten']).not.toBeNull();
      expect(r['chi_nhanh']).not.toBeNull();
      for (const key of metrics.values()) {
        const diff = dec(r[`${key}__diff`]);
        expect(diff.eq(dec(r[`${key}__right`]).minus(dec(r[`${key}__left`])))).toBe(true);
        const shouldDiffer = want.diffs[key];
        if (shouldDiffer === undefined) {
          expect(diff.abs().lte(new Big(expected.tolerance[key]!))).toBe(true);
        } else {
          expect(diff.eq(new Big(shouldDiffer))).toBe(true);
        }
      }
    });

    expect(rows(tables['only_left']!).map((r) => r['ma_nv'])).toEqual(expected.only_in_payroll);
    expect(rows(tables['only_right']!).map((r) => r['ma_nv'])).toEqual(expected.only_in_timesheet);
    // only_left / only_right keep the input columns.
    expect(tables['only_left']!.columns).toEqual(left['bang_luong']!.table.columns);
    expect(tables['only_right']!.columns).toEqual(left['cham_cong']!.table.columns);

    // Titles from the locale (owner 2A) with the configured side labels.
    expect(tables['mismatched']!.columns.map((c) => c.title)).toEqual([
      'Mã NV',
      'Họ tên',
      'Chi nhánh',
      ...[...metrics.keys()].flatMap((l) => [
        `${l} (lương)`,
        `${l} (chấm công)`,
        `${l} (chênh lệch)`,
      ]),
      'Chỉ tiêu lệch',
    ]);
  }, 60_000);

  it('counts a 0.5 difference with tolerance 0.5 as a match (AC b, AC-05)', async () => {
    // The fixture has one employee per branch whose work days differ by exactly 0.5.
    const slots = readSlots(flow);
    const pay = slots['bang_luong']!.table;
    const time = slots['cham_cong']!.table;
    const timeByKey = new Map(rows(time).map((r) => [r['ma_nv'], r]));
    const halfDay = rows(pay)
      .filter((r) => {
        const other = timeByKey.get(r['ma_nv']);
        return other !== undefined && dec(other['cong']).minus(dec(r['cong'])).abs().eq('0.5');
      })
      .map((r) => r['ma_nv']);
    expect(halfDay).toHaveLength(3);
    const tables = await compareTables(flow);
    const mismatchedKeys = rows(tables['mismatched']!).map((r) => r['ma_nv']);
    for (const key of halfDay) expect(mismatchedKeys).not.toContain(key);

    // Engine level, both signs; just above the tolerance is a mismatch.
    const cols: Schema = [
      { key: 'k', title: 'K', type: 'string' },
      { key: 'v', title: 'V', type: 'decimal' },
    ];
    const l = Table.fromRows(cols, [
      ['a', new Big('22')],
      ['b', new Big('22')],
      ['c', new Big('22')],
    ]);
    const r = Table.fromRows(cols, [
      ['a', new Big('22.5')],
      ['b', new Big('21.5')],
      ['c', new Big('22.5000000001')],
    ]);
    const config = CompareConfigSchema.parse({
      keys: ['k'],
      metrics: [{ left: 'v', right: 'v', label: 'V', tolerance: '0.5' }],
    });
    const out = executeCompare(config, l, r, t);
    expect(rows(out['mismatched']!).map((x) => x['k'])).toEqual(['c']);
  }, 60_000);

  it('writes the 4 sheets of AC-06 with a bold header, a frozen first row and an auto-filter (AC c)', async () => {
    const { files } = await run(flow);
    expect(files).toHaveLength(1);
    const file = files[0]!;
    expect(file.fileName).toBe('DoiChieu_2026-09.xlsx');
    expect(file.mimeType).toBe(XLSX_MIME);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(file.bytes.slice().buffer as unknown as Parameters<typeof wb.xlsx.load>[0]);
    expect(wb.worksheets.map((ws) => ws.name)).toEqual([
      'Tổng hợp',
      'Lệch',
      'Chỉ có trong lương',
      'Chỉ có trong chấm công',
    ]);
    for (const ws of wb.worksheets) {
      const header = ws.getRow(1);
      expect(header.cellCount).toBeGreaterThan(0);
      header.eachCell((cell) => expect(cell.font?.bold).toBe(true));
      expect(ws.views.map((v) => ({ state: v.state, ySplit: 'ySplit' in v && v.ySplit }))).toEqual([
        { state: 'frozen', ySplit: 1 },
      ]);
      expect(ws.autoFilter).toBeTruthy();
    }
  }, 60_000);

  it('turns the 4-hour OT differences into matches with OT tolerance 5 (AC d, AC-10)', async () => {
    const otFour = expected.mismatched.filter((m) => m.diffs['ot'] === '4.0').map((m) => m.ma_nv);
    expect(otFour).toHaveLength(3);
    const raised = withCompare(flow, (c) => {
      c.metrics.find((m) => m.left === 'ot')!.tolerance = '5';
    });
    const tables = await compareTables(raised);
    const keys = rows(tables['mismatched']!).map((r) => r['ma_nv']);
    for (const key of otFour) expect(keys).not.toContain(key);
    const total = rows(tables['summary']!).at(-1)!;
    expect(total['matched']).toBe(expected.counts.matched + otFour.length);
    expect(total['mismatched']).toBe(expected.counts.mismatched - otFour.length);
  }, 60_000);

  it('reads back, through the T-R1-04 reader, the tables it wrote (AC e)', async () => {
    const { files } = await run(flow);
    const tables = await compareTables(flow);
    const sheets: [string, string][] = [
      ['Tổng hợp', 'summary'],
      ['Lệch', 'mismatched'],
      ['Chỉ có trong lương', 'only_left'],
      ['Chỉ có trong chấm công', 'only_right'],
    ];
    const plain = (v: Value): unknown => (isDecimal(v) ? `dec:${v.toString()}` : v);
    for (const [sheet, port] of sheets) {
      const table = tables[port]!;
      // Slot keys cannot start with `_` (`_source_file`, `_mismatched_metrics`): keys by position.
      const slot = InputSlotSchema.parse({
        key: 'ket_qua',
        label: 'Kết quả',
        sheet: { mode: 'byName', value: sheet },
        columns: table.columns.map((c, j) => ({ key: `c${j}`, aliases: [c.title], type: c.type })),
      });
      const back = readSlot(slot, [{ name: 'ket_qua.xlsx', bytes: files[0]!.bytes }]);
      expect(back.report.errorCount).toBe(0);
      expect(back.table.rowCount).toBe(table.rowCount);
      expect(table.rowCount).toBeGreaterThan(0);
      for (let i = 0; i < table.rowCount; i++) {
        expect(table.columns.map((_, j) => plain(back.table.get(i, `c${j}`)))).toEqual(
          table.columns.map((c) => plain(table.get(i, c.key))),
        );
      }
    }
  }, 60_000);

  it('runs without calling the DuckDB loader (AC g, T-R1-06 step 7, spec §13.1 lazy load)', async () => {
    vi.mocked(duckdbLoader.loadDuckDb).mockClear();
    vi.mocked(duckdbLoader.loadWasmBytes).mockClear();
    const { files } = await run(flow);
    expect(files).toHaveLength(1);
    expect(duckdbLoader.loadDuckDb).not.toHaveBeenCalled();
    expect(duckdbLoader.loadWasmBytes).not.toHaveBeenCalled();
  });

  it('runs only TypeScript nodes and no core, io or node file imports DuckDB (AC g, owner 1A)', () => {
    for (const type of ['input.excel', 'control.compare', 'output.excel']) {
      const plugin = NODE_PLUGINS[type]!;
      expect(typeof plugin.execute).toBe('function');
      expect(plugin.compile).toBeUndefined();
    }
    const root = new URL('../', import.meta.url);
    const files = fs
      .readdirSync(root, { recursive: true })
      .filter((f) => /\.(ts|tsx)$/.test(f) && !f.endsWith('payroll-timesheet.test.ts'))
      // The DuckDB runtime itself and its tests (T-R1-06) are the only importers allowed.
      .filter((f) => !/^duckdb\//.test(f) && !/^__tests__\/duckdb-/.test(f));
    expect(files.length).toBeGreaterThan(20);
    const duckdb =
      /(from\s+|import\s*\(?\s*)['"]([^'"]*\/duckdb(\/[^'"]*)?|@duckdb\/duckdb-wasm[^'"]*)['"]/;
    const offending = files.filter((f) =>
      duckdb.test(new TextDecoder().decode(fs.readFileSync(new URL(f, root)))),
    );
    expect(offending).toEqual([]);
  });
});

describe('control.compare rules (03 §4.3, spec §24.2)', () => {
  const cols: Schema = [
    { key: 'k', title: 'K', type: 'string' },
    { key: 'v', title: 'V', type: 'decimal' },
  ];
  const base = (extra: Partial<CompareConfigInput> = {}): CompareConfig =>
    CompareConfigSchema.parse({
      keys: ['k'],
      metrics: [{ left: 'v', right: 'v', label: 'V' }],
      ...extra,
    });

  it('matches keys after normalisation and keeps a blank source blank (nullAsZero on)', () => {
    const l = Table.fromRows(cols, [
      ['NV003 ', null],
      ['nv004', new Big('1')],
    ]);
    const r = Table.fromRows(cols, [
      ['nv003', new Big('0')],
      ['NV004', null],
    ]);
    const out = executeCompare(base(), l, r, t);
    expect(rows(out['only_left']!)).toEqual([]);
    const [row] = rows(out['mismatched']!);
    expect(row!['k']).toBe('nv004');
    expect(row!['v__left']).toEqual(new Big('1'));
    expect(row!['v__right']).toBeNull();
    expect(dec(row!['v__diff']).eq(-1)).toBe(true);
  });

  it('with nullAsZero off: blank vs blank matches, blank vs a number mismatches with a blank diff', () => {
    const l = Table.fromRows(cols, [
      ['a', null],
      ['b', null],
    ]);
    const r = Table.fromRows(cols, [
      ['a', null],
      ['b', new Big('0')],
    ]);
    const out = executeCompare(base({ nullAsZero: false }), l, r, t);
    const mismatched = rows(out['mismatched']!);
    expect(mismatched.map((x) => x['k'])).toEqual(['b']);
    expect(mismatched[0]!['v__diff']).toBeNull();
  });

  it('reports a duplicated key with its value (owner 3B)', () => {
    const l = Table.fromRows(cols, [
      ['NV1', null],
      [' nv1', null],
    ]);
    const r = Table.fromRows(cols, []);
    const err = (() => {
      try {
        executeCompare(base({ sideLabels: { left: 'lương', right: 'chấm công' } }), l, r, t);
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(EngineError);
    expect((err as EngineError).messageKey).toBe('compare.error.duplicateKey');
    expect((err as EngineError).params).toEqual({ side: 'lương', key: 'nv1' });
  });

  it('uses the keys as titles without a translator', () => {
    const l = Table.fromRows(cols, [['a', new Big('1')]]);
    const out = executeCompare(base(), l, Table.fromRows(cols, [['a', new Big('2')]]));
    expect(out['mismatched']!.columns.map((c) => c.title)).toEqual([
      'K',
      'compare.column.left',
      'compare.column.right',
      'compare.column.diff',
      'compare.column.mismatchedMetrics',
    ]);
  });
});

describe('run context (MEMORY 2026-11-16 12:41, 1A)', () => {
  const flow = fixtureFlow();

  it('input.excel and output.excel need the run context', async () => {
    await expect(executePlan(flow, planFlow(flow), { t })).rejects.toMatchObject({
      messageKey: 'executor.error.noRunContext',
      nodeId: 'in_luong',
    });
  });

  it('input.excel refuses a slot whose report has errors', async () => {
    const slots = readSlots(flow);
    const bad = readSlot(flow.inputSlots[0]!, [
      { name: 'a.xlsx', bytes: readFixture(FIXTURE_FILES[0]) },
      { name: 'b.xlsx', bytes: readFixture(FIXTURE_FILES[0]) },
    ]);
    expect(bad.report.errorCount).toBeGreaterThan(0);
    const run = { slots: { ...slots, bang_luong: bad }, params: {}, emitFile: () => {} };
    await expect(executePlan(flow, planFlow(flow), { t, run })).rejects.toMatchObject({
      messageKey: 'executor.error.inputInvalid',
      params: { slot: flow.inputSlots[0]!.label, count: bad.report.errorCount },
      nodeId: 'in_luong',
    });
  });
});
