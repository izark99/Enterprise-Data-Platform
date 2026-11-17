import type { DataType } from '@hrflow/flow-schema';
import { describe, expect, it } from 'vitest';
import { Big, isDecimal, parseDecimal } from '../core/decimal';
import { isEngineError } from '../core/errors';
import type { Schema, Value } from '../core/types';
import { FUNCTIONS } from '../formula/functions';
import { openXlsx } from '../io/xlsx-stream';
import { buildFlow, runFlow } from './duckdb-transform-helpers';

/**
 * Golden test of `transform.formula` (spec §12.2, AC-B4-30, T-R1-09 AC a): the 180 cases of
 * `fixtures/formula-golden/cases.json` (fake data), the function coverage check, and the comparison
 * with the values Excel computed and saved in `golden-excel.xlsx`. The fixture is the behaviour
 * reference: it is never edited to make a change pass.
 */

interface NodeFs {
  readFileSync(path: URL): Uint8Array;
}
const fs = (
  globalThis as unknown as { process: { getBuiltinModule(id: 'node:fs'): NodeFs } }
).process.getBuiltinModule('node:fs');

const fixture = (name: string): Uint8Array => {
  const bytes = fs.readFileSync(
    new URL(`../../../../../fixtures/formula-golden/${name}`, import.meta.url),
  );
  return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
};

type InputType = 'n' | 's' | 'b' | 'd';
type ExpectType = 'number' | 'string' | 'boolean' | 'date' | 'blank' | 'error';

interface GoldenCase {
  readonly id: string;
  readonly fn: string;
  readonly formula: string;
  readonly inputs: Readonly<Record<string, { type: InputType; value: string | boolean | null }>>;
  readonly expect: { readonly type: ExpectType; readonly value: string | boolean | null };
  readonly excel?: { readonly type: ExpectType; readonly value: string | boolean | null };
  readonly note?: string;
  readonly confirm?: string;
}

const CASES = JSON.parse(new TextDecoder().decode(fixture('cases.json'))) as GoldenCase[];

/**
 * Intended differences with Excel (the `excel` / `note` fields of cases.json): exact decimals, a
 * bare blank reference stays blank, an empty text is blank, dates stay dates, overflow is `#NUM!`.
 */
const INTENDED_DIFFERENCES = [
  'c005', // =[a] on a blank cell: blank (MEMORY 2026-10-30 13:18); Excel 0
  'c007', // =1/3: 10 decimal places; Excel 15 significant digits
  'c008', // =[a]*1.1: exact; Excel 15 significant digits
  'c017', // =10^30*10^30: beyond DECIMAL(38,10) → #NUM!; Excel computes 1e60
  'c024', // date + 30 is a date; Excel a serial number
  'c032', // =IF(TRUE,[a],0) on a blank cell: blank; Excel 0
  'c101', // LEFT of a blank cell: "" is blank; Excel ""
  'c108', // MID beyond the text: "" is blank; Excel ""
  'c148', // DATE(…) is a date; Excel a serial number
  'c149',
  'c150',
  'c151',
  'c163', // EDATE / EOMONTH results are dates; Excel serial numbers
  'c164',
  'c165',
  'c166',
  'c167',
  'c168',
];

const INPUT_TYPE: Readonly<Record<InputType, DataType>> = {
  n: 'decimal',
  s: 'string',
  b: 'boolean',
  d: 'date',
};

function sourceOf(c: GoldenCase): { columns: Schema; rows: Value[][] } {
  const entries = Object.entries(c.inputs);
  if (entries.length === 0) {
    return { columns: [{ key: 'a', title: 'a', type: 'decimal' }], rows: [[null]] };
  }
  const columns = entries.map(([key, v]) => ({ key, title: key, type: INPUT_TYPE[v.type] }));
  const row = entries.map(([, v]): Value => {
    if (v.value === null) return null;
    return v.type === 'n' ? parseDecimal(String(v.value)) : v.value;
  });
  return { columns, rows: [row] };
}

/** What the engine gave for a case, in the shape of `expect`. */
type Outcome = { readonly type: ExpectType; readonly value: string | boolean | null };

async function runCase(c: GoldenCase): Promise<Outcome> {
  const flow = buildFlow(
    [
      ['src', 'test.source', { name: 'src' }],
      ['f', 'transform.formula', { columns: [{ key: 'r', formula: c.formula, onError: 'fail' }] }],
    ],
    [['src', 'f']],
  );
  try {
    const result = await runFlow(flow, { src: sourceOf(c) });
    const table = result.outputs['f']!['out']!;
    const type = table.columnDef('r')!.type;
    const v = table.get(0, 'r');
    if (v === null) return { type: 'blank', value: null };
    if (isDecimal(v)) return { type: 'number', value: v.toString() };
    if (type === 'date') return { type: 'date', value: v as string };
    if (typeof v === 'boolean') return { type: 'boolean', value: v };
    return { type: 'string', value: String(v) };
  } catch (err) {
    if (isEngineError(err) && err.messageKey === 'formula.error.rowError') {
      return { type: 'error', value: String(err.params['error']) };
    }
    throw err;
  }
}

const results = new Map<string, Outcome>();

describe('formula golden cases (fixtures/formula-golden/cases.json)', () => {
  for (const c of CASES) {
    it(`${c.id} ${c.formula}`, async () => {
      const outcome = await runCase(c);
      results.set(c.id, outcome);
      expect(outcome).toEqual(
        c.expect.type === 'number'
          ? { type: 'number', value: new Big(String(c.expect.value)).toString() }
          : c.expect,
      );
    });
  }
});

describe('formula golden coverage and Excel', () => {
  it('covers every function of spec §9.1 except PARAM with at least 3 cases', () => {
    const counts = new Map<string, number>();
    for (const c of CASES) counts.set(c.fn, (counts.get(c.fn) ?? 0) + 1);
    const thin = FUNCTIONS.filter((f) => f.name !== 'PARAM' && (counts.get(f.name) ?? 0) < 3).map(
      (f) => f.name,
    );
    expect(thin).toEqual([]);
    expect(FUNCTIONS).toHaveLength(41);
    expect(CASES).toHaveLength(180);
  });

  it('matches the values Excel saved in golden-excel.xlsx (15 significant digits)', async () => {
    expect(INTENDED_DIFFERENCES).toEqual(CASES.filter((c) => c.excel).map((c) => c.id));
    const grid = openXlsx(fixture('golden-excel.xlsx')).readSheet(0);
    const ERROR_TYPE: Readonly<Record<number, string>> = {
      2: '#DIV/0!',
      3: '#VALUE!',
      6: '#NUM!',
      7: '#N/A',
    };
    const excelOf = (r: number): Outcome => {
      const cell = grid.cell(r, 6, false);
      const errorType = grid.cell(r, 7, false).value;
      if (cell.error !== undefined || typeof errorType === 'number') {
        return { type: 'error', value: cell.error ?? ERROR_TYPE[errorType as number] ?? '?' };
      }
      const v = cell.value;
      if (v === null) return { type: 'blank', value: null };
      if (typeof v === 'number') return { type: 'number', value: String(v) };
      if (typeof v === 'boolean') return { type: 'boolean', value: v };
      return { type: 'string', value: v };
    };
    const at15 = (text: string): string => String(Number(Number(text).toPrecision(15)));
    const byId = new Map(CASES.map((c) => [c.id, c]));
    const mismatches: string[] = [];
    let compared = 0;
    for (let r = 1; r <= grid.lastRow; r++) {
      const id = grid.cell(r, 0, false).value;
      const c = typeof id === 'string' ? byId.get(id) : undefined;
      if (c === undefined) continue;
      compared++;
      const excel = excelOf(r);
      // Intended difference: Excel saved what cases.json says Excel gives.
      let wanted: Outcome;
      if (c.excel) wanted = c.excel;
      else {
        // Every other case: the engine result equals Excel's.
        const ours = results.get(c.id) ?? (await runCase(c));
        wanted = ours.type === 'blank' ? { type: 'string', value: '' } : ours;
        if (ours.type === 'blank' && excel.type === 'blank') continue;
      }
      const ok =
        excel.type === 'number' && wanted.type === 'number'
          ? at15(String(excel.value)) === at15(String(wanted.value))
          : excel.type === wanted.type && excel.value === wanted.value;
      if (!ok)
        mismatches.push(`${c.id}: Excel ${JSON.stringify(excel)} ≠ ${JSON.stringify(wanted)}`);
    }
    expect(mismatches).toEqual([]);
    expect(compared).toBe(180);
  });
});
