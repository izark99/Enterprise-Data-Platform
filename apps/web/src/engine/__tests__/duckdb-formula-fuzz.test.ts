import type { FlowDefinition, FormulaConfigInput } from '@hrflow/flow-schema';
import { describe, expect, it } from 'vitest';
import { parseDecimal } from '../core/decimal';
import { isEngineError } from '../core/errors';
import type { Schema, Value } from '../core/types';
import { DUCKDB_DIALECT } from '../duckdb/scope';
import {
  compileFormula,
  DESIGN_DIALECT,
  MAX_PROJECTED,
  MAX_SQL_DEPTH,
  MAX_SQL_LENGTH,
  sqlDepth,
  type FormulaParamDef,
} from '../formula/compile';
import { FUNCTIONS } from '../formula/functions';
import { FormulaError, MAX_LENGTH, parseFormula } from '../formula/parser';
import type { NodeWarning } from '../nodes/index';
import { nodeDuckDb } from './duckdb-node';
import { buildFlow, runFlow, type SourceData } from './duckdb-transform-helpers';

/**
 * Fuzz of the `transform.formula` parser and transpiler (T-R1-09 verifier round; engine rule: code
 * that parses external input is fuzzed). The formula text is Admin input. Properties:
 * - the parser and the compiler throw only `FormulaError` / `EngineError` (never a raw error),
 *   stay fast on hostile text up to `MAX_LENGTH`, and report positions inside the text;
 * - every formula the compiler accepts runs on DuckDB without a DuckDB error (row errors are
 *   error codes, never a failed query);
 * - no string constant, number constant, parameter value or column title reaches the SQL text
 *   (AC-B4-13, -14): only placeholders;
 * - `onError: 'blank'` warnings and `onError: 'fail'` errors carry no cell value (spec §12.2,
 *   03 §4.7).
 * Fixed seed; more cases with HRFLOW_HEAVY=1. Fake data only.
 */

const HEAVY =
  (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env
    .HRFLOW_HEAVY === '1';

function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const dec = (key: string, title = key) => ({ key, title, type: 'decimal' as const });
const str = (key: string, title = key) => ({ key, title, type: 'string' as const });
const d = (text: string): Value => parseDecimal(text);

const INPUT: Schema = [
  dec('n'),
  str('s'),
  { key: 'b', title: 'b', type: 'boolean' },
  { key: 'd', title: 'd', type: 'date' },
  { key: 'i', title: 'i', type: 'integer' },
  str('k', 'a]b'),
];

const PARAM_DEFS: FormulaParamDef[] = [
  { key: 'he_so', type: 'number' },
  { key: 'ky', type: 'month' },
  { key: 'ghi', type: 'string' },
  { key: 'ngay', type: 'date' },
  { key: 'co', type: 'boolean' },
];
const PARAM_VALUES = { he_so: '1.5', ky: '2026-11', ghi: 'ghi chú', ngay: '2026-02-29', co: true };

const FZ_TABLE = `CREATE OR REPLACE TABLE fz AS SELECT * FROM (VALUES
  (CAST(NULL AS DECIMAL(38,10)), CAST(NULL AS VARCHAR), CAST(NULL AS BOOLEAN), CAST(NULL AS DATE), CAST(NULL AS BIGINT), CAST(NULL AS VARCHAR), 1),
  (CAST('-2.5' AS DECIMAL(38,10)), 'abc', TRUE, DATE '2024-02-29', 7, 'x', 2),
  (CAST('9999999999999999999999999999.9999999999' AS DECIMAL(38,10)), ' 12 ', FALSE, DATE '1900-01-01', -9007199254740991, ' ', 3),
  (CAST('0' AS DECIMAL(38,10)), '', FALSE, DATE '9999-12-31', 0, '', 4),
  (CAST('0.0000000001' AS DECIMAL(38,10)), 'Nguyễn*?~ 😀', TRUE, DATE '1900-02-28', 9007199254740991, '[(.*\\', 5),
  (CAST('2147483647' AS DECIMAL(38,10)), 'a~*b?c', FALSE, DATE '1900-03-01', 2147483647, 'MD', 6),
  (CAST('-9999999999999999999999999999' AS DECIMAL(38,10)), '1e3', TRUE, DATE '2000-12-31', -1, 'YD', 7)
) AS v(n, s, b, d, i, k, "hr$ord")`;

/** Literal pieces of formula text. */
const LEAVES = [
  '[n]',
  '[s]',
  '[b]',
  '[d]',
  '[i]',
  '[k]',
  '[a]]b]',
  '0',
  '1',
  '-1',
  '0.5',
  '.5',
  '2147483647',
  '2147483648',
  '99999999999',
  '1e15',
  '1e30',
  '1e-30',
  '9999999999999999999999999999',
  '0.0000000001',
  '-28',
  '9',
  '10',
  '64',
  '65',
  '-64',
  '2958465',
  '2958466',
  '60',
  '61',
  '""',
  '" "',
  '"abc"',
  '"*"',
  '"?"',
  '"~"',
  '"~*"',
  '"a*b?"',
  '"[(.*"',
  '"\\d"',
  '"Y"',
  '"M"',
  '"D"',
  '"MD"',
  '"YM"',
  '"YD"',
  '"1e3"',
  '" 7 "',
  '"TRUE"',
  '"😀"',
  '"Nguyễn"',
  '""""',
  'TRUE',
  'FALSE',
  'DATE(1900,1,1)',
  'DATE(9999,12,31)',
  'DATE(1900,2,29)',
  'PARAM("he_so")',
  'PARAM("ky")',
  'PARAM("ghi")',
  'PARAM("ngay")',
  'PARAM("co")',
];

const OPS = ['+', '-', '*', '/', '^', '&', '=', '<>', '<', '>', '<=', '>='];

function generator(next: () => number) {
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)]!;
  const fns = FUNCTIONS.filter((f) => f.name !== 'PARAM');
  const gen = (depth: number): string => {
    if (depth <= 0 || next() < 0.2) return pick(LEAVES);
    const k = next();
    if (k < 0.3) return `${gen(depth - 1)}${pick(OPS)}${gen(depth - 1)}`;
    if (k < 0.35) return `-${gen(depth - 1)}`;
    if (k < 0.38) return `(${gen(depth - 1)})%`;
    if (k < 0.4) return `(${gen(depth - 1)})`;
    const f = pick(fns);
    let n = f.min + Math.floor(next() * (Math.min(f.max, f.min + 3) - f.min + 1));
    if (f.name === 'IFS' && n % 2 === 1) n++;
    return `${f.name}(${Array.from({ length: n }, () => gen(depth - 1)).join(',')})`;
  };
  return { gen, pick };
}

describe('parser fuzz (no DuckDB)', () => {
  const TOKENS = [
    '[',
    ']',
    ']]',
    '"',
    '""',
    '(',
    ')',
    ',',
    ';',
    '=',
    '<>',
    '<=',
    '>=',
    '<',
    '>',
    '+',
    '-',
    '*',
    '/',
    '^',
    '&',
    '%',
    ' ',
    '\t',
    '\n',
    ' ',
    '﻿',
    '\u0000',
    '\ud800',
    '😀',
    'ễ',
    '1',
    '0',
    '.',
    'e',
    'E',
    '1e999999999',
    '1e-999999999',
    '0.5',
    'TRUE',
    'IF',
    'SUM',
    'ROUND',
    '_xlfn.',
    '_XLWS.',
    'A1',
    'XFD1048576',
    'PARAM',
    'n',
    '[n]',
    '[s]',
    '[a]]b]',
    '"x"',
    '{',
    '#',
    '$',
    '!',
    "'",
    '\\',
    '@',
    ':',
    '?',
  ];

  it('random token soup: only FormulaError / EngineError, positions inside the text, fast', () => {
    const next = prng(20261117);
    const count = HEAVY ? 100_000 : 5_000;
    const keys = new Map<string, number>();
    const bump = (k: string) => keys.set(k, (keys.get(k) ?? 0) + 1);
    const raw: string[] = [];
    let worst = { ms: 0, text: '' };
    for (let k = 0; k < count; k++) {
      const len = next() < 0.1 ? Math.floor(next() * 2100) : Math.floor(next() * 40);
      let text = next() < 0.8 ? '=' : '';
      while (text.length < len) text += TOKENS[Math.floor(next() * TOKENS.length)]!;
      const t0 = performance.now();
      try {
        parseFormula(text);
        bump('parsed');
        try {
          compileFormula([{ key: 'r', formula: text, type: 'auto', onError: 'blank' }], INPUT, {
            dialect: DESIGN_DIALECT,
            from: '"in"',
            params: PARAM_DEFS,
          });
          bump('compiled');
        } catch (err) {
          if (!isEngineError(err)) raw.push(`compile ${JSON.stringify(text)}: ${String(err)}`);
          else bump(`compile:${err.messageKey}`);
        }
      } catch (err) {
        if (!(err instanceof FormulaError)) {
          raw.push(`parse ${JSON.stringify(text)}: ${String(err)}`);
        } else {
          const ctx = err.params['context'];
          bump(`${err.messageKey}${typeof ctx === 'string' ? `:${ctx}` : ''}`);
          if (err.start < 0 || err.start > text.length || err.end > text.length + 1) {
            raw.push(`position ${JSON.stringify(text)}: [${err.start}, ${err.end})`);
          }
          if (err.params['pos'] !== err.start + 1) raw.push(`pos ${JSON.stringify(text)}`);
        }
      }
      const ms = performance.now() - t0;
      if (ms > worst.ms) worst = { ms, text: text.slice(0, 60) };
    }
    expect(raw).toEqual([]);
    expect(worst.ms).toBeLessThan(500);
    expect(keys.get('parsed') ?? 0).toBeGreaterThan(0);
  }, 600_000);

  it('mutated valid formulas: only FormulaError / EngineError from parser and compiler', () => {
    const next = prng(31337);
    const { gen } = generator(next);
    const count = HEAVY ? 50_000 : 3_000;
    const keys = new Map<string, number>();
    const bump = (k: string) => keys.set(k, (keys.get(k) ?? 0) + 1);
    const raw: string[] = [];
    let worst = 0;
    for (let k = 0; k < count; k++) {
      let text = `=${gen(1 + Math.floor(next() * 5))}`;
      const edits = Math.floor(next() * 4);
      for (let e = 0; e < edits; e++) {
        const at = Math.floor(next() * (text.length + 1));
        const m = next();
        if (m < 0.3) text = text.slice(0, at) + text.slice(at + 1);
        else if (m < 0.6)
          text = text.slice(0, at) + TOKENS[Math.floor(next() * TOKENS.length)]! + text.slice(at);
        else if (m < 0.8) text = text.slice(0, at) + text.slice(at, at + 20) + text.slice(at);
        else text = text.slice(0, at);
      }
      const t0 = performance.now();
      try {
        compileFormula([{ key: 'r', formula: text, type: 'auto', onError: 'blank' }], INPUT, {
          dialect: DESIGN_DIALECT,
          from: '"in"',
          params: PARAM_DEFS,
        });
        bump('compiled');
      } catch (err) {
        if (!isEngineError(err)) raw.push(`${JSON.stringify(text)}: ${String(err)}`);
        else bump(err.messageKey);
      }
      worst = Math.max(worst, performance.now() - t0);
    }
    expect(raw).toEqual([]);
    expect(keys.get('compiled') ?? 0).toBeGreaterThan(count / 10);
    expect(worst).toBeLessThan(2_000);
  });

  it('hostile text up to MAX_LENGTH parses or fails with a key, in linear time', () => {
    const fill = (prefix: string, unit: string, suffix = '') => {
      let s = prefix;
      while (s.length + unit.length + suffix.length <= MAX_LENGTH) s += unit;
      return s + suffix;
    };
    const cases = [
      fill('=[', ']]', ']'),
      fill('=[', ']]'),
      fill('="', '""', '"'),
      fill('="', '""'),
      fill('="', 'ễ😀', '"'),
      fill('=', '('),
      fill('=', ')'),
      fill('=', '-', '1'),
      fill('=', '+', '1'),
      fill('=1', '+1'),
      fill('=1', '^1'),
      fill('=1', '%'),
      fill('=1', '&1'),
      fill('=1', '=1'),
      fill('=', '9'),
      fill('=', '9', 'e99999999999999999999'),
      fill('=0.', '0', '1'),
      fill('=', 'A'),
      fill('=', 'A', '('),
      fill('=', 'A', '()'),
      fill('=SUM(', '1,', '1)'),
      fill('=SUM(', ',', ')'),
      fill('=IF(', 'IF(', ''),
      fill('=', '[n]'),
      fill('=', ' '),
      fill('=', ' ', '1'),
      fill('=', ';'),
      `=${'1'.repeat(MAX_LENGTH - 1)}`,
      `=${'a'.repeat(MAX_LENGTH)}`,
    ];
    const raw: string[] = [];
    let worst = 0;
    for (const text of cases) {
      for (const formula of [text, text.slice(0, MAX_LENGTH)]) {
        const t0 = performance.now();
        try {
          compileFormula([{ key: 'r', formula, type: 'auto', onError: 'blank' }], INPUT, {
            dialect: DESIGN_DIALECT,
            from: '"in"',
            params: PARAM_DEFS,
          });
        } catch (err) {
          if (!isEngineError(err)) raw.push(`${formula.slice(0, 20)}…: ${String(err)}`);
        }
        worst = Math.max(worst, performance.now() - t0);
      }
    }
    expect(raw).toEqual([]);
    expect(worst).toBeLessThan(1000);
  });
});

describe('transpiler fuzz on DuckDB (fixed seed)', () => {
  it('generated formulas run without a DuckDB error; outcome counts per error code', async () => {
    const db = await nodeDuckDb();
    db.exec(FZ_TABLE);
    const next = prng(4242);
    const { gen, pick } = generator(next);
    const count = HEAVY ? 20_000 : 1_000;
    const outcome = new Map<string, number>();
    const bump = (k: string) => outcome.set(k, (outcome.get(k) ?? 0) + 1);
    const failures: string[] = [];
    let worstCompile = { ms: 0, formula: '' };
    let worstQuery = { ms: 0, formula: '', sql: 0 };
    for (let k = 0; k < count; k++) {
      const formula = `=${gen(1 + Math.floor(next() * 5))}`;
      if (formula.length > MAX_LENGTH) continue;
      const type = pick(['auto', 'auto', 'auto', 'string', 'decimal', 'integer'] as const);
      let compiled;
      const t0 = performance.now();
      try {
        compiled = compileFormula([{ key: 'r', formula, type, onError: 'blank' }], INPUT, {
          dialect: DUCKDB_DIALECT,
          from: 'fz',
          params: PARAM_DEFS,
          values: PARAM_VALUES,
        });
      } catch (err) {
        if (!isEngineError(err)) failures.push(`${formula}: ${String(err)}`);
        else bump(`compile:${err.messageKey}`);
        continue;
      }
      const ms = performance.now() - t0;
      if (ms > worstCompile.ms) worstCompile = { ms, formula };
      const t1 = performance.now();
      try {
        const table = db.query(compiled.sql, compiled.params);
        const errKey = compiled.columns[0]!.errorKey;
        const column = errKey === null ? null : table.getChild(errKey);
        const seen = new Set<number>();
        for (let r = 0; column !== null && r < table.numRows; r++) {
          const code: unknown = column.get(r);
          if (code !== null && code !== undefined) seen.add(Number(code));
        }
        if (seen.size === 0) bump('ok');
        for (const c of seen) bump(`row:${['#DIV/0!', '#VALUE!', '#NUM!', '#N/A'][c - 1]}`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        failures.push(`${formula}: ${message.slice(0, 200)}`);
      }
      const qms = performance.now() - t1;
      if (qms > worstQuery.ms) worstQuery = { ms: qms, formula, sql: compiled.sql.length };
    }
    expect(failures).toEqual([]);
    expect(outcome.get('ok') ?? 0).toBeGreaterThan(count / 10);
    expect(worstCompile.ms).toBeLessThan(5_000);
    expect(worstQuery.ms).toBeLessThan(10_000);
  }, 1_800_000);

  it('edge formulas near the limits run without a DuckDB error', async () => {
    const db = await nodeDuckDb();
    db.exec(FZ_TABLE);
    const formulas = [
      '=MID([s],2147483647,2147483647)',
      '=MID([s],99999999999,1e30)',
      '=LEFT([s],1e20)',
      '=RIGHT([k],2147483648)',
      '=FIND([k],[s],2147483647)',
      '=SEARCH([k],[s],1e15)',
      '=SEARCH([s],[k])',
      '=SEARCH("[(.*\\","[(.*\\x")',
      '=SUBSTITUTE([s],[k],"b",2147483647)',
      '=SUBSTITUTE([s],"",[k],1e20)',
      '=PROPER([s]&[k])',
      '=DATEDIF(DATE(1900,1,1),DATE(9999,12,31),"YD")',
      '=DATEDIF([d],DATE(9999,12,31),[k])',
      '=DATEDIF(0,2958465,"MD")',
      '=WEEKDAY(2958465,3)',
      '=WEEKDAY([d],1e20)',
      '=2^1e20',
      '=[n]^[n]',
      '=[n]^64',
      '=[n]^-64',
      '=(-8)^(1/3)',
      '=ROUND([n],-1e20)',
      '=ROUND([n],1e20)',
      '=ROUNDUP([n],-27)',
      '=ROUNDDOWN([n],-28)',
      '=DATE(1e20,1e20,1e20)',
      '=DATE(-1e20,-1e20,-1e20)',
      '=DATE(9999,1000000,100000000)',
      '=EDATE(DATE(9999,12,31),1e20)',
      '=EOMONTH([d],-1e20)',
      '=[d]+1e20',
      '=[d]+[n]',
      '=YEAR([n])',
      '=LEN([s])',
      '=LOWER([s])&UPPER([k])',
      '=VALUE("1e28")',
      '=VALUE([s])',
      '=MOD([n],0.0000000001)',
      '=MOD([n],-[n])',
      '=ABS([n])',
      '=-[n]*-[n]',
      '=[n]/0.0000000001',
      '=[i]*[i]*[i]',
      '=SUM([n],[n],[i])',
      '=TEXTJOIN([k],[b],[s],[n],[d],[i])',
      '=IFERROR(1/0,1/0)',
      `=[n]${'^2'.repeat(150)}`,
      `=[n]${'%'.repeat(150)}`,
      `=1${'/[n]'.repeat(150)}`,
    ];
    const failures: string[] = [];
    for (const formula of formulas) {
      const c = compileFormula([{ key: 'r', formula, type: 'auto', onError: 'blank' }], INPUT, {
        dialect: DUCKDB_DIALECT,
        from: 'fz',
        params: PARAM_DEFS,
        values: PARAM_VALUES,
      });
      try {
        db.query(c.sql, c.params);
      } catch (err) {
        failures.push(`${formula.slice(0, 60)}: ${(err as Error).message.slice(0, 120)}`);
      }
    }
    expect(failures).toEqual([]);
  }, 600_000);
});

describe('bound values never reach the SQL (AC-B4-13, -14)', () => {
  it('string / number constants, parameter values and titles are placeholders only', () => {
    const next = prng(777);
    const { gen } = generator(next);
    const params: FormulaParamDef[] = [
      { key: 'p_num', type: 'number' },
      { key: 'p_str', type: 'string' },
      { key: 'p_date', type: 'date' },
    ];
    const values = { p_num: '86420.13579', p_str: "QZp'); DROP TABLE x; --", p_date: '2031-07-19' };
    const input: Schema = [dec('n', 'QZTITLE_N'), str('s', 'QZTITLE_S')];
    const leaves = (k: number) => [
      `"QZ${k}' OR 1=1 --"`,
      `"QZ${k}"""`,
      `${86420 + k}.97531`,
      'PARAM("p_num")',
      'PARAM("p_str")',
      'PARAM("p_date")',
      '[QZTITLE_N]',
      '[QZTITLE_S]',
    ];
    const literals = new Set<string>();
    const leaks: string[] = [];
    const count = HEAVY ? 20_000 : 1_000;
    for (let k = 0; k < count; k++) {
      const ls = leaves(k);
      let formula = `=${gen(3)}`;
      // Replace every generated leaf by a marked constant, parameter or titled reference.
      formula = formula.replace(/\[[^\]]*\]|"(?:[^"]|"")*"|\b\d+(?:\.\d+)?(?:e-?\d+)?\b/g, () => {
        return ls[Math.floor(next() * ls.length)]!;
      });
      let compiled;
      try {
        compiled = compileFormula([{ key: 'r', formula, type: 'auto', onError: 'blank' }], input, {
          dialect: DUCKDB_DIALECT,
          from: 'fz',
          params,
          values,
        });
      } catch {
        continue;
      }
      const sql = compiled.sql;
      for (const needle of ['QZ', 'DROP', '86420', '97531', '13579', '2031', 'ghi']) {
        if (sql.includes(needle)) leaks.push(`${needle} in SQL of ${formula}`);
      }
      for (const m of sql.matchAll(/'(?:[^']|'')*'/g)) literals.add(m[0]);
      const placeholders = sql.split('CAST(? AS VARCHAR)').length - 1;
      if (placeholders !== compiled.params.length) leaks.push(`placeholder count of ${formula}`);
    }
    expect(leaks).toEqual([]);
    // Every SQL literal is one of the transpiler's own fixed strings.
    for (const lit of literals) expect(lit).not.toMatch(/QZ|86420|97531|2031/);
    expect(literals.size).toBeLessThan(60);
  });
});

describe('row errors carry no cell value (spec §12.2, 03 §4.7)', () => {
  const SECRET_ROWS: SourceData = {
    columns: [dec('n'), str('s'), { key: 'd', title: 'd', type: 'date' }],
    rows: [
      [d('424242.4242'), 'SECRETCELL1', '2024-02-29'],
      [d('0'), 'SECRETCELL2', null],
      [null, '313131', '2031-07-19'],
      [d('-9876.5'), 'SECRET*?', '1900-01-01'],
    ],
  };
  const PARAMS: FlowDefinition['params'] = [
    { key: 'he_so', label: 'Hệ số', type: 'number', required: false },
    { key: 'ky', label: 'Kỳ', type: 'month', required: false },
    { key: 'ghi', label: 'Ghi', type: 'string', required: false },
    { key: 'ngay', label: 'Ngày', type: 'date', required: false },
    { key: 'co', label: 'Có', type: 'boolean', required: false },
  ];
  const flowOf = (columns: FormulaConfigInput['columns']) =>
    buildFlow(
      [
        ['src', 'test.source', { name: 'src' }],
        ['f', 'transform.formula', { columns }],
      ],
      [['src', 'f']],
      PARAMS,
    );

  it('random failing formulas: blank → warnings, fail → rowError; params without cell values', async () => {
    const next = prng(9001);
    const { gen } = generator(next);
    const count = HEAVY ? 2_000 : 120;
    const leaks: string[] = [];
    const raw: string[] = [];
    const keys = new Map<string, number>();
    const bump = (k: string) => keys.set(k, (keys.get(k) ?? 0) + 1);
    const allowedWarning = ['node', 'column', 'error', 'count', 'rows'];
    const allowedError = ['node', 'column', 'error', 'row', 'count'];
    const secret = /SECRET|424242|313131|9876|2031/;
    for (let k = 0; k < count; k++) {
      const base = gen(3).replace(
        /\[[a-z]\]/g,
        () => ['[n]', '[s]', '[d]'][Math.floor(next() * 3)]!,
      );
      const formula = `=${base}/[n]`;
      const onError = next() < 0.5 ? 'blank' : 'fail';
      const warnings: NodeWarning[] = [];
      try {
        const result = await runFlow(
          flowOf([{ key: 'r', formula, onError }]),
          { src: SECRET_ROWS },
          { he_so: '2' },
        );
        warnings.push(...result.warnings);
        bump(`ran:${onError}`);
      } catch (err) {
        if (!isEngineError(err)) {
          raw.push(`${formula}: ${String(err)}`);
          continue;
        }
        bump(`error:${err.messageKey}`);
        if (err.messageKey === 'formula.error.rowError') {
          if (onError !== 'fail') leaks.push(`rowError with blank: ${formula}`);
          for (const key of Object.keys(err.params)) {
            if (!allowedError.includes(key)) leaks.push(`error param ${key}: ${formula}`);
          }
          if (typeof err.params['row'] !== 'number') leaks.push(`no first row: ${formula}`);
        } else if (err.messageKey.startsWith('duckdb.')) {
          raw.push(`${formula}: ${err.messageKey}`);
        }
        if (secret.test(JSON.stringify(err.params)) || secret.test(err.message)) {
          leaks.push(`cell value in error: ${formula}`);
        }
      }
      for (const w of warnings) {
        if (w.messageKey !== 'formula.warning.rowErrors') continue;
        bump('warning');
        for (const key of Object.keys(w.params)) {
          if (!allowedWarning.includes(key)) leaks.push(`warning param ${key}: ${formula}`);
        }
        if (secret.test(JSON.stringify(w.params))) leaks.push(`cell value in warning: ${formula}`);
      }
    }
    expect(raw).toEqual([]);
    expect(leaks).toEqual([]);
    expect(keys.get('warning') ?? 0).toBeGreaterThan(0);
    expect(keys.get('error:formula.error.rowError') ?? 0).toBeGreaterThan(0);
  }, 600_000);
});

describe('size and planning time within the limits', () => {
  // Measured in this round: 1 × 150 `/` ≈ 1.0 MB SQL, ~2.5 s; 8 × 50 `/` ≈ 1.3 MB, ~3.2 s.
  it('one column of 150 chained divisions and 8 columns of 50 run in bounded time', async () => {
    const db = await nodeDuckDb();
    db.exec(FZ_TABLE);
    const nodes = [
      [1, 150],
      [8, 50],
      ...(HEAVY ? [[20, 20] as const, [50, 10] as const] : []),
    ] as const;
    for (const [cols, ops] of nodes) {
      const formula = `=1${'/[n]'.repeat(ops)}`;
      const columns = Array.from({ length: cols }, (_, i) => ({
        key: `r${i}`,
        formula,
        type: 'auto' as const,
        onError: 'blank' as const,
      }));
      const compiled = compileFormula(columns, INPUT, {
        dialect: DUCKDB_DIALECT,
        from: 'fz',
        params: PARAM_DEFS,
      });
      expect(compiled.sql.length).toBeLessThan(4_000_000);
      const t0 = performance.now();
      db.query(compiled.sql, compiled.params);
      expect(performance.now() - t0).toBeLessThan(60_000);
    }
  }, 1_800_000);
});

describe('verifier findings, fixed (T-R1-09 round 1)', () => {
  async function runs(formula: string): Promise<void> {
    const db = await nodeDuckDb();
    db.exec(FZ_TABLE);
    const c = compileFormula([{ key: 'r', formula, type: 'auto', onError: 'blank' }], INPUT, {
      dialect: DUCKDB_DIALECT,
      from: 'fz',
      params: PARAM_DEFS,
    });
    db.query(c.sql, c.params);
  }

  /** Result of a constant formula on the one-row blank source: value text or Excel error. */
  async function result(formula: string): Promise<string | null> {
    const { table, warnings } = await (async () => {
      const flow = buildFlow(
        [
          ['src', 'test.source', { name: 'src' }],
          ['f', 'transform.formula', { columns: [{ key: 'r', formula }] }],
        ],
        [['src', 'f']],
      );
      const out = await runFlow(flow, {
        src: { columns: [{ key: 'd', title: 'd', type: 'date' }], rows: [[null]] },
      });
      return { table: out.outputs['f']!['out']!, warnings: out.warnings };
    })();
    const error = warnings.find((w) => w.messageKey === 'formula.warning.rowErrors');
    if (error !== undefined) return String(error.params['error']);
    const v = table.get(0, 'r');
    return v === null ? null : String(v);
  }

  // Spec §12.2 "Ngày": a date result outside 1900-01-01 … 9999-12-31 is #NUM!. `date ± number`
  // mapped serial 0 to 1899-12-31 and returned it as a date (EDATE of the same date gave #NUM!).
  it('DATE(1900,1,1)-1 and [blank date]+0 are #NUM!, not the date 1899-12-31', async () => {
    expect(await result('=DATE(1900,1,1)-1')).toBe('#NUM!');
    expect(await result('=[d]+0')).toBe('#NUM!');
  });

  // Spec §12.2: `^` with a constant integer exponent |n| ≤ 64 is exact, and only overflow is
  // #NUM!. 10^-30 = 1e-30 rounds to 0 on 10 places; 1 / 10^30 overflowed on the way.
  it('10^-30 is 0 (rounded to 10 places), not #NUM!', async () => {
    expect(await result('=10^-30')).toBe('0');
  });

  // Spec §12.2: a text that reads as a number is used as that number; beyond DECIMAL(38,10) a
  // number is #NUM! (the constant =1e28 is #NUM!); VALUE("1e28") gave #VALUE!.
  it('VALUE("1e28") overflows to #NUM! like the constant 1e28', async () => {
    expect(await result('=1e28')).toBe('#NUM!');
    expect(await result('=VALUE("1e28")')).toBe('#NUM!');
  });

  // compile.ts INT: `CAST(floor(x) AS DECIMAL(38,10))` was outside TRY; floor of a value in
  // (-10^28, -10^28 + 1) is -10^28, which does not fit: the query failed instead of #NUM!.
  it('INT of a negative value just above -10^28 is #NUM!, not a DuckDB error', async () => {
    await runs('=INT([n]-0.5)');
  });

  it('INT(-9999999999999999999999999999.5) compiles to a query DuckDB can run', async () => {
    await runs('=INT(-9999999999999999999999999999.5)');
  });

  // Were accepted at design time and refused by DuckDB ("Max expression depth limit of 1000
  // exceeded" / "Parser Error: memory exhausted"). Now each hidden column sits one level above
  // what it reads and repeated SQL is computed once (305 nested SELECTs), and the depth DuckDB
  // counts is bounded at design time (`MAX_SQL_DEPTH`, tested below).
  it('a chain of 50 `^64` (153 characters) runs on DuckDB', async () => {
    await runs(`=[n]${'^64'.repeat(50)}`);
  });

  it('a chain of 150 `^3` runs on DuckDB', async () => {
    await runs(`=[n]${'^3'.repeat(150)}`);
  });

  // Planning ran out of DuckDB's memory (SQL ≈ 1.3 MB); repeated SQL is now computed once and the
  // SQL size, projection items and depth are bounded at design time (tested below).
  it('50 columns of 30 chained multiplications run', async () => {
    const db = await nodeDuckDb();
    db.exec(FZ_TABLE);
    const formula = `=[n]${'*[n]'.repeat(30)}`;
    const columns = Array.from({ length: 50 }, (_, i) => ({
      key: `r${i}`,
      formula,
      type: 'auto' as const,
      onError: 'blank' as const,
    }));
    const c = compileFormula(columns, INPUT, {
      dialect: DUCKDB_DIALECT,
      from: 'fz',
      params: PARAM_DEFS,
    });
    expect(c.sql.length).toBeLessThan(4_000_000);
    db.query(c.sql, c.params);
  }, 600_000);

  /** One column per index with a distinct bound constant `#` (so nothing is computed once). */
  const distinct = (cols: number, formula: string) =>
    Array.from({ length: cols }, (_, i) => ({
      key: `r${i}`,
      formula: formula.replaceAll('#', String(i + 2)),
      type: 'auto' as const,
      onError: 'blank' as const,
    }));

  function tooComplexAt(columns: ReturnType<typeof distinct>): number {
    try {
      compileFormula(columns, INPUT, { dialect: DUCKDB_DIALECT, from: 'fz', params: PARAM_DEFS });
    } catch (err) {
      if (isEngineError(err) && err.messageKey === 'formula.error.tooComplex') {
        const path = err.path ?? [];
        expect(path[0]).toBe('columns');
        expect(path[2]).toBe('formula');
        return Number(path[1]);
      }
      throw err;
    }
    return -1;
  }

  // Measured (Node bindings, same duckdb-eh.wasm): distinct columns of chained `/[n]` planned in
  // 8.3 s at 1.93 MB of SQL and ran out of memory at 2.56 MB (40 × 50) and 2.89 MB (15 × 150).
  it('nodes that ran out of planning memory are tooComplex at design time, at the column that overflows', () => {
    expect(tooComplexAt(distinct(40, `=#${'/[n]'.repeat(50)}`))).toBeGreaterThan(0);
    expect(tooComplexAt(distinct(15, `=#${'/[n]'.repeat(150)}`))).toBeGreaterThan(0);
    expect(tooComplexAt(distinct(50, `=#${'/[n]'.repeat(150)}`))).toBeLessThan(15);
    // Deeper than DuckDB's expression depth: 150 `^64` (6 exact multiplications each).
    expect(tooComplexAt(distinct(1, `=[n]${'^64'.repeat(150)}`))).toBe(0);
    expect(tooComplexAt(distinct(1, `=[n]${'^64'.repeat(66)}`))).toBe(0);
  });

  it('nodes within the budgets plan and run: distinct 10 × 50 and 2 × 150 `/`, 50 × 30 `*`', async () => {
    const db = await nodeDuckDb();
    db.exec(FZ_TABLE);
    const cases = [
      distinct(10, `=#${'/[n]'.repeat(50)}`),
      distinct(2, `=#${'/[n]'.repeat(150)}`),
      distinct(50, `=[n]${'*[n]*#'.repeat(15)}`),
      distinct(1, `=[n]${'^64'.repeat(60)}`),
    ];
    for (const columns of cases) {
      expect(tooComplexAt(columns)).toBe(-1);
      const c = compileFormula(columns, INPUT, {
        dialect: DUCKDB_DIALECT,
        from: 'fz',
        params: PARAM_DEFS,
      });
      expect(c.sql.length).toBeLessThanOrEqual(MAX_SQL_LENGTH);
      expect(c.projected).toBeLessThanOrEqual(MAX_PROJECTED);
      expect(sqlDepth(c.sql)).toBeLessThanOrEqual(MAX_SQL_DEPTH);
      db.query(c.sql, c.params);
    }
  }, 600_000);

  it('the design-time dialect builds the same SQL as the DuckDB runtime (same budgets)', () => {
    const columns = distinct(3, '=IF(ISBLANK([s]),LEN([s])*#,ROUND([n]/#,2))&TEXT_JOIN_X');
    const formula = columns.map((c) => ({
      ...c,
      formula: c.formula.replace('&TEXT_JOIN_X', '&[d]&[i]'),
    }));
    const options = { from: 'fz', params: PARAM_DEFS, values: PARAM_VALUES };
    const a = compileFormula(formula, INPUT, { ...options, dialect: DESIGN_DIALECT });
    const b = compileFormula(formula, INPUT, { ...options, dialect: DUCKDB_DIALECT });
    expect(a.sql).toBe(b.sql);
  });

  it('sqlDepth counts what DuckDB counts: a nested SELECT 2, a parenthesis or CASE 1', async () => {
    const db = await nodeDuckDb();
    const nested = (n: number) =>
      `SELECT x FROM ${'(SELECT x + 1 AS x FROM '.repeat(n)}(SELECT 1 AS x) AS t${') AS t'.repeat(n)}`;
    // DuckDB refuses a depth above 1000; 495 nested SELECTs plan, 499 do not.
    expect(sqlDepth(nested(495))).toBeLessThan(1000);
    db.query(nested(495));
    expect(sqlDepth(nested(499))).toBeGreaterThanOrEqual(998);
    expect(() => db.query(nested(499))).toThrow(/expression depth/);
    expect(sqlDepth(`SELECT ${'abs('.repeat(10)}1${')'.repeat(10)}`)).toBe(10);
    expect(sqlDepth("SELECT CASE WHEN TRUE THEN CASE WHEN 'END(' = '' THEN 1 END END")).toBe(2);
  });
});

describe('KNOWN BUG', () => {
  /** Result of a constant formula on the one-row blank source: value text or Excel error. */
  async function result(formula: string): Promise<string | null> {
    const { table, warnings } = await (async () => {
      const flow = buildFlow(
        [
          ['src', 'test.source', { name: 'src' }],
          ['f', 'transform.formula', { columns: [{ key: 'r', formula }] }],
        ],
        [['src', 'f']],
      );
      const out = await runFlow(flow, {
        src: { columns: [{ key: 'd', title: 'd', type: 'date' }], rows: [[null]] },
      });
      return { table: out.outputs['f']!['out']!, warnings: out.warnings };
    })();
    const error = warnings.find((w) => w.messageKey === 'formula.warning.rowErrors');
    if (error !== undefined) return String(error.params['error']);
    const v = table.get(0, 'r');
    return v === null ? null : String(v);
  }

  // Spec §12.2 "Ô trống" (blank = 0 as a number argument) and "theo Excel": Excel's WEEKDAY(0)
  // is 7 (serial 0 is a Saturday in the 1900 system); the engine reads serial 0 as 1899-12-31,
  // a Sunday, and gives 1. Serials 1 … 59 (Jan–Feb 1900) are one weekday off the same way.
  it.fails('WEEKDAY of a blank date is 7 like Excel', async () => {
    expect(await result('=WEEKDAY([d])')).toBe('7');
    expect(await result('=WEEKDAY(1)')).toBe('1');
  });

  // T-R1-09 verifier round 2. `sqlDepth` counts parentheses, CASE and nested SELECTs, but DuckDB
  // also counts each binary operator of a flat chain (`a + b + …`, `a || b || …`: 1100 `+` fail
  // alone). SUM / CONCAT of 255 arguments write one flat chain of 254 operators into the level-1
  // SELECT, the deepest point of the text; with another column that nests ~395 SELECTs (sqlDepth
  // 791 ≤ MAX_SQL_DEPTH) the node passes design checks and the run fails with
  // "Max expression depth limit of 1000 exceeded" (duckdb.error.queryFailed).
  it.fails('a deep column plus SUM / CONCAT of 255 arguments is tooComplex or runs', async () => {
    const db = await nodeDuckDb();
    db.exec(FZ_TABLE);
    const many = (fn: string, a: string) =>
      `=${fn}(${Array.from({ length: 255 }, () => a).join(',')})`;
    const failures: string[] = [];
    for (const wide of [many('SUM', '[n]'), many('CONCAT', '[s]')]) {
      const columns = [
        { key: 'a', formula: `=[n]${'^64'.repeat(65)}`, type: 'auto' as const },
        { key: 'b', formula: wide, type: 'auto' as const },
      ].map((c) => ({ ...c, onError: 'blank' as const }));
      let c;
      try {
        compileFormula(columns, INPUT, { dialect: DESIGN_DIALECT, from: '"in"', params: [] });
        c = compileFormula(columns, INPUT, { dialect: DUCKDB_DIALECT, from: 'fz', params: [] });
      } catch (err) {
        if (isEngineError(err) && err.messageKey === 'formula.error.tooComplex') continue;
        throw err;
      }
      try {
        db.query(c.sql, c.params);
      } catch (err) {
        failures.push(`${wide.slice(0, 12)}: ${(err as Error).message.slice(0, 60)}`);
      }
    }
    expect(failures).toEqual([]);
  });
});
