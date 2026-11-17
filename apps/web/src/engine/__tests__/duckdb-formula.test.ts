import {
  FormulaConfigSchema,
  type FlowDefinition,
  type FormulaConfigInput,
} from '@hrflow/flow-schema';
import { describe, expect, it } from 'vitest';
import { parseDecimal } from '../core/decimal';
import { isEngineError, type EngineError } from '../core/errors';
import type { Schema, Value } from '../core/types';
import { DUCKDB_DIALECT } from '../duckdb/scope';
import { compileFormula, type FormulaParamDef } from '../formula/compile';
import { FUNCTIONS } from '../formula/functions';
import { toDisplay, toStored } from '../formula/refs';
import type { NodeWarning, ParamValue } from '../nodes/index';
import { transformFormulaPlugin } from '../nodes/transform-formula';
import { nodeDuckDb } from './duckdb-node';
import { buildFlow, rowsOf, runFlow, schemaOf, type SourceData } from './duckdb-transform-helpers';

/**
 * `transform.formula` on DuckDB (spec §12.2, §27.1–§27.2, T-R1-09 AC b–g). Fake data only.
 */

type Columns = FormulaConfigInput['columns'];

const PARAMS: FlowDefinition['params'] = [
  { key: 'ky_luong', label: 'Kỳ lương', type: 'month', required: false },
  { key: 'he_so', label: 'Hệ số', type: 'number', required: false },
  { key: 'ghi_chu', label: 'Ghi chú', type: 'string', required: false },
];

function flowOf(columns: Columns, label?: string): FlowDefinition {
  const flow = buildFlow(
    [
      ['src', 'test.source', { name: 'src' }],
      ['f', 'transform.formula', { columns }],
    ],
    [['src', 'f']],
    PARAMS,
  );
  if (label === undefined) return flow;
  return { ...flow, nodes: flow.nodes.map((n) => (n.id === 'f' ? { ...n, label } : n)) };
}

async function run(
  columns: Columns,
  src: SourceData,
  params: Record<string, ParamValue> = {},
  label?: string,
) {
  const result = await runFlow(flowOf(columns, label), { src }, params);
  return { table: result.outputs['f']!['out']!, warnings: result.warnings };
}

async function runError(columns: Columns, src: SourceData, label?: string): Promise<EngineError> {
  try {
    await run(columns, src, {}, label);
  } catch (err) {
    if (isEngineError(err)) return err;
    throw err;
  }
  throw new Error('the run did not fail');
}

function design(columns: Columns, input: Schema, warn?: (w: NodeWarning) => void): Schema {
  const config = FormulaConfigSchema.parse({ columns });
  const out = transformFormulaPlugin.inferSchema(
    config,
    { in: input },
    { flow: flowOf(columns), ...(warn ? { warn } : {}) },
  );
  return (out as { out: Schema }).out;
}

function designError(columns: Columns, input: Schema): EngineError {
  try {
    design(columns, input);
  } catch (err) {
    if (isEngineError(err)) return err;
    throw err;
  }
  throw new Error('no design error');
}

const dec = (key: string, title = key) => ({ key, title, type: 'decimal' as const });
const str = (key: string, title = key) => ({ key, title, type: 'string' as const });
const date = (key: string, title = key) => ({ key, title, type: 'date' as const });
const d = (text: string): Value => parseDecimal(text);

/** One column `r` per formula, over one row of `src`. */
async function values(
  formulas: readonly string[],
  src: SourceData,
): Promise<(string | number | boolean | null)[]> {
  const columns = formulas.map((formula, i) => ({ key: `r${i}`, formula }));
  const { table } = await run(columns, src);
  const row = rowsOf(table)[0]!;
  return row.slice(src.columns.length);
}

const BLANK_ROW: SourceData = {
  columns: [dec('a'), dec('b'), str('s')],
  rows: [[null, d('2'), null]],
};

describe('design-time errors (AC-B4-02, -03)', () => {
  const input = [dec('a')];

  it('unknown functions are refused at design time with the Join or code.sql hint', () => {
    const lookup = designError([{ key: 'r', formula: '=XLOOKUP([a],1,2)' }], input);
    expect(lookup.messageKey).toBe('formula.error.unknownFunction');
    expect(lookup.params).toMatchObject({
      fn: 'XLOOKUP',
      context: 'lookup',
      formulaColumn: 'r',
      pos: 2,
    });
    expect(lookup.path).toEqual(['columns', 0, 'formula']);
    expect(designError([{ key: 'r', formula: '=VLOOKUP(1,2,3)' }], input).params['context']).toBe(
      'lookup',
    );
    const other = designError([{ key: 'r', formula: '=FOO(1)' }], input);
    expect(other.params).toMatchObject({ fn: 'FOO', context: 'other' });
  });

  it('syntax errors carry the position, wrong argument counts give argCount', () => {
    const syntax = designError([{ key: 'r', formula: '=IF([a]>0,1' }], input);
    expect(syntax.messageKey).toBe('formula.error.syntax');
    expect(syntax.params['pos']).toBe(12);
    const args = designError([{ key: 'r', formula: '=ROUND(1)' }], input);
    expect(args.messageKey).toBe('formula.error.argCount');
    expect(args.params).toMatchObject({ fn: 'ROUND', min: 2, max: 2 });
    expect(designError([{ key: 'r', formula: '=IFS(TRUE,1,FALSE)' }], input).messageKey).toBe(
      'formula.error.argCount',
    );
    expect(designError([{ key: 'r', formula: 'ROUND(1,2)' }], input).params['context']).toBe(
      'missingEquals',
    );
    expect(designError([{ key: 'r', formula: '=PARAM(1)' }], input).messageKey).toBe(
      'formula.error.paramName',
    );
  });

  it('a key starting with "_" is reserved', () => {
    const err = designError([{ key: '_x', formula: '=1' }], input);
    expect(err.messageKey).toBe('formula.error.reservedKey');
    expect(err.path).toEqual(['columns', 0, 'key']);
  });

  it('every function of spec §9.1 compiles and runs on DuckDB (AC-B4-01)', async () => {
    const calls: Record<string, string> = {
      IF: 'IF([a]>0,1,2)',
      IFS: 'IFS([a]>0,1,TRUE,2)',
      AND: 'AND(TRUE,[a]=0)',
      OR: 'OR(FALSE,[a]=0)',
      NOT: 'NOT([a]>0)',
      SWITCH: 'SWITCH([a],0,"z","o")',
      IFERROR: 'IFERROR(1/[a],0)',
      ISBLANK: 'ISBLANK([a])',
      ISNUMBER: 'ISNUMBER([b])',
      ROUND: 'ROUND(2.5,0)',
      ROUNDUP: 'ROUNDUP(2.1,0)',
      ROUNDDOWN: 'ROUNDDOWN(2.9,0)',
      INT: 'INT(-0.5)',
      ABS: 'ABS(-1)',
      MIN: 'MIN(1,2)',
      MAX: 'MAX(1,2)',
      MOD: 'MOD(7,3)',
      SUM: 'SUM(1,2)',
      LEFT: 'LEFT("abc",2)',
      RIGHT: 'RIGHT("abc",2)',
      MID: 'MID("abc",2,1)',
      LEN: 'LEN("abc")',
      TRIM: 'TRIM(" a ")',
      UPPER: 'UPPER("a")',
      LOWER: 'LOWER("A")',
      PROPER: 'PROPER("ab cd")',
      CONCAT: 'CONCAT("a","b")',
      TEXTJOIN: 'TEXTJOIN("-",TRUE,"a","b")',
      SUBSTITUTE: 'SUBSTITUTE("aa","a","b",2)',
      FIND: 'FIND("b","abc")',
      SEARCH: 'SEARCH("B","abc")',
      VALUE: 'VALUE("2")',
      DATE: 'DATE(2026,1,2)',
      YEAR: 'YEAR(DATE(2026,1,2))',
      MONTH: 'MONTH(DATE(2026,1,2))',
      DAY: 'DAY(DATE(2026,1,2))',
      EDATE: 'EDATE(DATE(2026,1,2),1)',
      EOMONTH: 'EOMONTH(DATE(2026,1,2),0)',
      DATEDIF: 'DATEDIF(DATE(2026,1,2),DATE(2027,1,2),"Y")',
      WEEKDAY: 'WEEKDAY(DATE(2026,1,2))',
      PARAM: 'PARAM("he_so")',
    };
    expect(Object.keys(calls).sort()).toEqual(FUNCTIONS.map((f) => f.name).sort());
    const got = await values(
      Object.values(calls).map((c) => `=${c}`),
      BLANK_ROW,
    );
    expect(got).toEqual([
      '2',
      '2',
      true,
      true,
      true,
      'z',
      '0',
      true,
      true,
      '3',
      '3',
      '2',
      '-1',
      '1',
      '1',
      '2',
      '1',
      '3',
      'ab',
      'bc',
      'b',
      '3',
      'a',
      'A',
      'a',
      'Ab Cd',
      'ab',
      'a-b',
      'ab',
      '2',
      '2',
      '2',
      '2026-01-02',
      '2026',
      '1',
      '2',
      '2026-02-02',
      '2026-01-31',
      '1',
      '6',
      null,
    ]);
  });
});

describe('references and scope (AC-B4-04, -05, -06)', () => {
  it('[Title] and [key] give the same result; the stored form is [key] and survives a title change', async () => {
    const input = [dec('luong_co_ban', 'Lương cơ bản')];
    const src: SourceData = { columns: input, rows: [[d('1000.5')]] };
    const typed = '=[Lương cơ bản]*2';
    const stored = toStored(typed, input);
    expect(stored).toBe('=[luong_co_ban]*2');
    expect(await values([typed, stored], src)).toEqual(['2001', '2001']);
    // The node above renames the title: the stored formula still runs and shows the new title.
    const renamed = [dec('luong_co_ban', 'Lương CB')];
    expect(await values([stored], { columns: renamed, rows: [[d('1')]] })).toEqual(['2']);
    expect(toDisplay(stored, renamed)).toBe('=[Lương CB]*2');
  });

  it('a title shared by two columns is ambiguous; the key works; ]] reads as ]', async () => {
    const input = [str('ghi_chu', 'Ghi chú'), str('ghi_chu_2', 'Ghi chú'), str('ma_cu', 'Mã [cũ]')];
    const err = designError([{ key: 'r', formula: '=[Ghi chú]' }], input);
    expect(err.messageKey).toBe('formula.error.ambiguousTitle');
    expect(err.params['column']).toBe('Ghi chú');
    const src: SourceData = { columns: input, rows: [['x', 'y', 'z']] };
    expect(await values(['=[ghi_chu_2]', '=[Mã [cũ]]]'], src)).toEqual(['y', 'z']);
  });

  it('a column sees the columns above it, not below; an overwrite reads the old value in place', async () => {
    const input = [dec('luong'), dec('cong')];
    const src: SourceData = { columns: input, rows: [[d('100'), d('2')]] };
    const { table } = await run(
      [
        { key: 'a', formula: '=[luong]+1' },
        { key: 'b', formula: '=[a]*2' },
        { key: 'luong', formula: '=[luong]*1.1' },
      ],
      src,
    );
    expect(table.columns.map((c) => c.key)).toEqual(['luong', 'cong', 'a', 'b']);
    expect(rowsOf(table)).toEqual([['110', '2', '101', '202']]);
    const fwd = designError(
      [
        { key: 'a', formula: '=[b]+1' },
        { key: 'b', formula: '=1' },
      ],
      input,
    );
    expect(fwd.messageKey).toBe('formula.error.forwardReference');
    expect(fwd.path).toEqual(['columns', 0, 'formula']);
    expect(designError([{ key: 'a', formula: '=[zzz]' }], input).messageKey).toBe(
      'formula.error.unknownColumn',
    );
  });
});

describe('semantics (AC-B4-07 … -12)', () => {
  it('blank cells (AC-B4-07)', async () => {
    expect(
      await values(
        [
          '=[a]+1',
          '=[s]&"x"',
          '=ISBLANK([a])',
          '=[a]=""',
          '=[a]=0',
          '=[a]',
          '=IF(TRUE,[a],0)',
          '=SUM([a],[b])',
        ],
        BLANK_ROW,
      ),
    ).toEqual(['1', 'x', true, true, true, null, null, '2']);
  });

  it('exact decimals, DECIMAL(38,10) results and no DOUBLE in the SQL (AC-B4-08)', async () => {
    const src: SourceData = { columns: [dec('luong')], rows: [[d('1234567890123.25')]] };
    expect(await values(['=0.1+0.2', '=1/3', '=[luong]*1.1', '=-7/2', '=2/3'], src)).toEqual([
      '0.3',
      '0.3333333333',
      '1358024679135.575',
      '-3.5',
      '0.6666666667',
    ]);
    const compiled = compileFormula(
      FormulaConfigSchema.parse({ columns: [{ key: 'r', formula: '=[luong]*1.1/3+0.1' }] }).columns,
      src.columns,
      { dialect: DUCKDB_DIALECT, from: '"t"', params: [] },
    );
    expect(compiled.sql).not.toMatch(/DOUBLE|FLOAT|REAL/);
    expect(compiled.output.find((c) => c.key === 'r')!.type).toBe('decimal');
    const db = await nodeDuckDb();
    db.exec(
      'CREATE OR REPLACE TABLE t AS SELECT CAST(1 AS DECIMAL(38,10)) AS luong, 1 AS "hr$ord"',
    );
    const t = db.query(`SELECT typeof(r) FROM (${compiled.sql})`, compiled.params);
    expect(String(t.getChildAt(0)!.get(0))).toBe('DECIMAL(38,10)');
  });

  it('rounding like Excel (AC-B4-09)', async () => {
    expect(
      await values(
        [
          '=ROUND(2.675,2)',
          '=ROUND(-2.5,0)',
          '=ROUNDUP(-1.21,1)',
          '=ROUNDDOWN(1.29,1)',
          '=INT(-1.5)',
          '=MOD(-3,2)',
        ],
        BLANK_ROW,
      ),
    ).toEqual(['2.68', '-3', '-1.3', '1.2', '-2', '1']);
  });

  it('text (AC-B4-10)', async () => {
    expect(
      await values(
        [
          '="abc"="ABC"',
          '=FIND("a","ABa")',
          '=SEARCH("b*","aBc")',
          '=MID("Nguyễn",2,3)',
          '=LEN("Nguyễn")',
          '=PROPER("nguyễn văn a")',
          '=TEXTJOIN(", ",TRUE,"a","","b")',
        ],
        BLANK_ROW,
      ),
    ).toEqual([true, '3', '2', 'guy', '6', 'Nguyễn Văn A', 'a, b']);
  });

  it('implicit conversion (AC-B4-11)', async () => {
    const { table, warnings } = await run(
      [
        { key: 'r0', formula: '="12"+1' },
        { key: 'r1', formula: '="abc"+1' },
        { key: 'r2', formula: '=TRUE+1' },
        { key: 'r3', formula: '=VALUE("1.5")' },
      ],
      BLANK_ROW,
    );
    expect(rowsOf(table)[0]!.slice(3)).toEqual(['13', null, '2', '1.5']);
    expect(warnings.map((w) => w.params['error'])).toEqual(['#VALUE!']);
  });

  it('dates (AC-B4-12)', async () => {
    const src: SourceData = {
      columns: [date('ngay_vao'), date('ngay_ra')],
      rows: [['2026-01-15', '2026-03-01']],
    };
    const { table } = await run(
      [
        { key: 'r0', formula: '=[ngay_vao]+30' },
        { key: 'r1', formula: '=[ngay_ra]-[ngay_vao]' },
        { key: 'r2', formula: '=EOMONTH(DATE(2026,2,10),0)' },
        { key: 'r3', formula: '=EDATE(DATE(2026,1,31),1)' },
        { key: 'r4', formula: '=DATEDIF(DATE(2020,3,15),DATE(2026,3,14),"Y")' },
        { key: 'r5', formula: '=WEEKDAY(DATE(2026,10,30),2)' },
        { key: 'r6', formula: '=DATE(2026,13,1)' },
      ],
      src,
    );
    expect(table.columns.slice(2).map((c) => c.type)).toEqual([
      'date',
      'decimal',
      'date',
      'date',
      'decimal',
      'decimal',
      'date',
    ]);
    expect(rowsOf(table)[0]!.slice(2)).toEqual([
      '2026-02-14',
      '45',
      '2026-02-28',
      '2026-02-28',
      '5',
      '5',
      '2027-01-01',
    ]);
  });
});

describe('bound values (AC-B4-13, -14)', () => {
  const params: FormulaParamDef[] = PARAMS.map((p) => ({ key: p.key, type: p.type }));
  const injection = "'); DROP TABLE x; --";

  it('PARAM: month → first day, empty → blank, unknown → design error; values never in the SQL', async () => {
    const columns = [
      { key: 'ky', formula: '=PARAM("ky_luong")' },
      { key: 'hs', formula: '=PARAM("he_so")*2' },
      { key: 'gc', formula: '=PARAM("ghi_chu")' },
    ];
    const src: SourceData = { columns: [dec('a')], rows: [[null]] };
    const full = await run(columns, src, { ky_luong: '2026-09', he_so: 1.25, ghi_chu: 'Kỳ 9' });
    expect(rowsOf(full.table)).toEqual([[null, '2026-09-01', '2.5', 'Kỳ 9']]);
    expect(full.table.columnDef('ky')!.type).toBe('date');
    const empty = await run(columns, src, { ky_luong: null, he_so: '', ghi_chu: null });
    expect(rowsOf(empty.table)).toEqual([[null, null, '0', null]]);
    const err = designError([{ key: 'r', formula: '=PARAM("khong_co")' }], src.columns);
    expect(err.messageKey).toBe('formula.error.unknownParam');
    expect(err.params['param']).toBe('khong_co');

    const compiled = compileFormula(FormulaConfigSchema.parse({ columns }).columns, src.columns, {
      dialect: DUCKDB_DIALECT,
      from: '"t"',
      params,
      values: { ky_luong: '2026-09', he_so: 1.25, ghi_chu: 'Kỳ 9' },
    });
    expect(compiled.params).toEqual(expect.arrayContaining(['2026-09-01', '1.25', 'Kỳ 9']));
    for (const v of ['2026-09', '1.25', 'Kỳ 9']) expect(compiled.sql).not.toContain(v);
  });

  it('a string constant is bound: the result is the exact text, the SQL does not contain it', async () => {
    const formula = `="${injection}"&"|"&"x""y"`;
    expect(await values([formula], BLANK_ROW)).toEqual([`${injection}|x"y`]);
    const compiled = compileFormula(
      FormulaConfigSchema.parse({ columns: [{ key: 'r', formula }] }).columns,
      BLANK_ROW.columns,
      { dialect: DUCKDB_DIALECT, from: '"t"', params },
    );
    expect(compiled.params).toEqual(expect.arrayContaining([injection, '|', 'x"y']));
    expect(compiled.sql).not.toContain('DROP');
    expect(compiled.sql).not.toContain('x"y');
    // Number constants are bound too.
    const numbers = compileFormula(
      FormulaConfigSchema.parse({ columns: [{ key: 'r', formula: '=[a]*12345.678' }] }).columns,
      BLANK_ROW.columns,
      { dialect: DUCKDB_DIALECT, from: '"t"', params },
    );
    expect(numbers.sql).not.toContain('12345');
    expect(numbers.params).toContain('12345.678');
  });
});

describe('type inference (AC-B4-15)', () => {
  const input = [dec('a'), str('s')];

  it('infers decimal, string with mixedTypes, and checks the chosen type', async () => {
    const warnings: NodeWarning[] = [];
    const schema = design(
      [
        { key: 'x2', formula: '=[a]*2' },
        { key: 'len', formula: '=LEN([s])' },
        { key: 'len_i', formula: '=LEN([s])', type: 'integer' },
        { key: 'mixed', formula: '=IF([a]>0,"Có",0)' },
        { key: 'flag', formula: '=[a]>0' },
        { key: 'day', formula: '=DATE(2026,1,1)' },
      ],
      input,
      (w) => warnings.push(w),
    );
    expect(schema.slice(2).map((c) => [c.key, c.type])).toEqual([
      ['x2', 'decimal'],
      ['len', 'decimal'],
      ['len_i', 'integer'],
      ['mixed', 'string'],
      ['flag', 'boolean'],
      ['day', 'date'],
    ]);
    expect(warnings).toEqual([
      { messageKey: 'formula.warning.mixedTypes', params: { column: 'mixed' } },
    ]);
    const mismatch = designError([{ key: 'r', formula: '=LEN([s])', type: 'date' }], input);
    expect(mismatch.messageKey).toBe('formula.error.typeMismatch');
    expect(mismatch.params).toMatchObject({ type: 'date', inferred: 'decimal' });
    expect(mismatch.path).toEqual(['columns', 0, 'type']);
    expect(designError([{ key: 'r', formula: '=1', type: 'boolean' }], input).messageKey).toBe(
      'formula.error.typeMismatch',
    );
  });

  it('integer type: a non-integer result is #VALUE! by onError', async () => {
    const src: SourceData = { columns: input, rows: [[d('3'), 'abcd']] };
    const { table, warnings } = await run(
      [
        { key: 'half', formula: '=[a]/2', type: 'integer' },
        { key: 'len', formula: '=LEN([s])', type: 'integer' },
        { key: 'txt', formula: '=[a]/2', type: 'string' },
      ],
      src,
    );
    expect(rowsOf(table)).toEqual([['3', 'abcd', null, 4, '1.5']]);
    expect(warnings.map((w) => [w.params['column'], w.params['error']])).toEqual([
      ['half', '#VALUE!'],
    ]);
  });
});

describe('row errors (AC-B4-20 … -24)', () => {
  const ZERO_ROWS = [3, 50, 51, 200, 400, 777, 999];
  const src: SourceData = {
    columns: [dec('luong'), dec('cong')],
    rows: Array.from({ length: 1000 }, (_, i) => [
      d(String(7000000 + i * 13 + 0.25)),
      d(ZERO_ROWS.includes(i + 1) ? '0' : '26'),
    ]),
  };

  it('onError blank: 7 blank cells and one warning with the count and the first 5 rows, no cell value', async () => {
    const { table, warnings } = await run(
      [{ key: 'r', formula: '=[luong]/[cong]' }],
      src,
      {},
      'Tính lương',
    );
    const r = rowsOf(table).map((row) => row[2]);
    expect(r.filter((v) => v === null)).toHaveLength(7);
    expect(ZERO_ROWS.every((n) => r[n - 1] === null)).toBe(true);
    expect(warnings).toEqual([
      {
        nodeId: 'f',
        messageKey: 'formula.warning.rowErrors',
        params: {
          node: 'Tính lương',
          column: 'r',
          error: '#DIV/0!',
          count: 7,
          rows: '3, 50, 51, 200, 400',
        },
      },
    ]);
    const text = JSON.stringify(warnings);
    for (const row of src.rows) expect(text).not.toContain(String(row[0]));
  });

  it("onError 'fail': the run stops with rowError (node, column, error, first row)", async () => {
    const err = await runError(
      [{ key: 'r', formula: '=[luong]/[cong]', onError: 'fail' }],
      src,
      'Tính lương',
    );
    expect(err.messageKey).toBe('formula.error.rowError');
    expect(err.nodeId).toBe('f');
    expect(err.params).toEqual({
      node: 'Tính lương',
      column: 'r',
      error: '#DIV/0!',
      row: 3,
      count: 7,
    });
    expect(err.toLog()).toEqual({ messageKey: 'formula.error.rowError', nodeId: 'f' });
  });

  it('IFERROR catches: 7 zeros, no warning', async () => {
    const { table, warnings } = await run(
      [{ key: 'r', formula: '=IFERROR([luong]/[cong],0)' }],
      src,
    );
    expect(rowsOf(table).filter((row) => row[2] === '0')).toHaveLength(7);
    expect(warnings).toEqual([]);
  });

  it('a later column reads a failed cell as blank; inside one formula an error spreads', async () => {
    const { table, warnings } = await run(
      [
        { key: 'a_loi', formula: '=[luong]/[cong]' },
        { key: 'b', formula: '=[a_loi]+1' },
        { key: 'c', formula: '=([luong]/[cong])+1' },
      ],
      src,
    );
    const row3 = rowsOf(table)[2]!;
    expect(row3.slice(2)).toEqual([null, '1', null]);
    expect(warnings.map((w) => [w.params['column'], w.params['count']])).toEqual([
      ['a_loi', 7],
      ['c', 7],
    ]);
  });

  it('overflow is #NUM! by onError, never duckdb.error.decimalOverflow (AC-B4-24)', async () => {
    const big: SourceData = {
      columns: [dec('x')],
      rows: [[d('9999999999999999999999999999')], [d('2')]],
    };
    const { table, warnings } = await run(
      [
        { key: 'p', formula: '=10^30*10^30' },
        { key: 'q', formula: '=[x]*[x]' },
        { key: 's', formula: '=[x]+[x]' },
        { key: 't', formula: '=[x]/0.001' },
      ],
      big,
    );
    expect(rowsOf(table)).toEqual([
      ['9.999999999999999999999999999e+27', null, null, null, null],
      ['2', null, '4', '4', '2000'],
    ]);
    expect(warnings.map((w) => [w.params['column'], w.params['error'], w.params['count']])).toEqual(
      [
        ['p', '#NUM!', 2],
        ['q', '#NUM!', 1],
        ['s', '#NUM!', 1],
        ['t', '#NUM!', 1],
      ],
    );
    const err = await runError([{ key: 'p', formula: '=10^30*10^30', onError: 'fail' }], big);
    expect(err.messageKey).toBe('formula.error.rowError');
    expect(err.params['error']).toBe('#NUM!');
  });
});

describe('order and schema (AC-B4-16)', () => {
  it('rows keep their order, new columns come last in order, the inferred schema equals the run', async () => {
    const input = [str('ma', 'Mã'), dec('luong', 'Lương'), date('ngay', 'Ngày')];
    const src: SourceData = {
      columns: input,
      rows: [
        ['c', d('3'), '2026-01-03'],
        ['a', d('1'), null],
        ['b', d('2'), '2026-01-01'],
      ],
    };
    const columns = [
      { key: 'thuong', title: 'Thưởng', formula: '=[Lương]*10' },
      { key: 'luong', formula: '=[luong]+1', type: 'integer' as const },
      { key: 'nhan', formula: '=[Mã]&"-"&[thuong]' },
      { key: 'han', formula: '=[ngay]+1' },
    ];
    const inferred = design(columns, input);
    const { table } = await run(columns, src);
    expect(schemaOf(table)).toEqual(inferred);
    expect(inferred).toEqual([
      { key: 'ma', title: 'Mã', type: 'string' },
      { key: 'luong', title: 'Lương', type: 'integer' },
      { key: 'ngay', title: 'Ngày', type: 'date' },
      { key: 'thuong', title: 'Thưởng', type: 'decimal' },
      { key: 'nhan', title: 'nhan', type: 'string' },
      { key: 'han', title: 'han', type: 'date' },
    ]);
    expect(rowsOf(table)).toEqual([
      ['c', 4, '2026-01-03', '30', 'c-30', '2026-01-04'],
      ['a', 2, null, '10', 'a-10', '1900-01-01'],
      ['b', 3, '2026-01-01', '20', 'b-20', '2026-01-02'],
    ]);
  });

  it('a formula that cannot fail stays lazy and chains into the next DuckDB node', async () => {
    const flow = buildFlow(
      [
        ['src', 'test.source', { name: 'src' }],
        ['f', 'transform.formula', { columns: [{ key: 'x', formula: '=[s]&"!"' }] }],
        ['g', 'transform.filter', { conditions: [{ column: 'x', op: 'eq', value: 'b!' }] }],
      ],
      [
        ['src', 'f'],
        ['f', 'g'],
      ],
    );
    const result = await runFlow(flow, { src: { columns: [str('s')], rows: [['a'], ['b']] } });
    expect(rowsOf(result.outputs['g']!['out']!)).toEqual([['b', 'b!']]);
  });
});

describe('random formulas on DuckDB (fixed seed)', () => {
  it('every generated formula compiles and runs without a DuckDB error', async () => {
    const db = await nodeDuckDb();
    db.exec(`CREATE OR REPLACE TABLE fz AS SELECT * FROM (VALUES
      (CAST(NULL AS DECIMAL(38,10)), CAST(NULL AS VARCHAR), CAST(NULL AS BOOLEAN), CAST(NULL AS DATE), CAST(NULL AS BIGINT), 1),
      (CAST('-2.5' AS DECIMAL(38,10)), 'abc', TRUE, DATE '2024-02-29', 7, 2),
      (CAST('9999999999999999999999999999' AS DECIMAL(38,10)), ' 12 ', FALSE, DATE '1900-01-01', -3, 3),
      (CAST('0' AS DECIMAL(38,10)), '', FALSE, DATE '9999-12-31', 0, 4),
      (CAST('0.0000000001' AS DECIMAL(38,10)), 'Nguyễn*?~', TRUE, DATE '1899-01-01', 9007199254740991, 5)
    ) AS v(n, s, b, d, i, "hr$ord")`);
    const input: Schema = [
      dec('n'),
      str('s'),
      { key: 'b', title: 'b', type: 'boolean' },
      date('d'),
      { key: 'i', title: 'i', type: 'integer' },
    ];
    let seed = 20261117;
    const next = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)]!;
    const leaves = [
      '[n]',
      '[s]',
      '[b]',
      '[d]',
      '[i]',
      '0',
      '1',
      '-1',
      '2.5',
      '1e30',
      '"abc"',
      '""',
      '" 7 "',
      'TRUE',
      'FALSE',
      '"Y"',
      '"MD"',
      '"*"',
      '64',
      '-28',
      '99999999999',
      'DATE(2024,2,29)',
      'PARAM("he_so")',
    ];
    const fns = FUNCTIONS.filter((f) => f.name !== 'PARAM');
    const gen = (depth: number): string => {
      if (depth <= 0 || next() < 0.25) return pick(leaves);
      const k = next();
      if (k < 0.3)
        return `${gen(depth - 1)}${pick(['+', '-', '*', '/', '^', '&', '=', '<>', '<', '>='])}${gen(depth - 1)}`;
      if (k < 0.35) return `-${gen(depth - 1)}`;
      if (k < 0.38) return `(${gen(depth - 1)})%`;
      const f = pick(fns);
      let n = f.min + Math.floor(next() * (Math.min(f.max, f.min + 3) - f.min + 1));
      if (f.name === 'IFS' && n % 2 === 1) n++;
      return `${f.name}(${Array.from({ length: n }, () => gen(depth - 1)).join(',')})`;
    };
    const params = PARAMS.map((p) => ({ key: p.key, type: p.type }));
    const failures: string[] = [];
    const count = HEAVY ? 5000 : 300;
    for (let k = 0; k < count; k++) {
      const formula = `=${gen(4)}`;
      const type = pick(['auto', 'auto', 'string', 'decimal', 'integer'] as const);
      let compiled;
      try {
        compiled = compileFormula([{ key: 'r', formula, type, onError: 'blank' }], input, {
          dialect: DUCKDB_DIALECT,
          from: 'fz',
          params,
          values: { he_so: '1.5' },
        });
      } catch (err) {
        if (!isEngineError(err)) failures.push(`${formula}: ${String(err)}`);
        continue;
      }
      try {
        db.query(compiled.sql, compiled.params);
      } catch {
        failures.push(formula);
      }
    }
    expect(failures).toEqual([]);
  }, 600_000);
});

const HEAVY =
  (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env
    .HRFLOW_HEAVY === '1';
