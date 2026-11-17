import { describe, expect, it } from 'vitest';
import { EngineError } from '../../core/errors';
import { compileFormula, DESIGN_DIALECT, MAX_CHAIN } from '../compile';
import { FUNCTION_GROUPS, FUNCTIONS } from '../functions';
import { FormulaError, MAX_DEPTH, MAX_LENGTH, parseFormula } from '../parser';
import { escapeRef, resolveRef, toDisplay, toStored } from '../refs';
import * as surface from '../public';

/** Parser, references and function table of `transform.formula` (spec §9.1, §12.2). Pure TS. */

function parseError(text: string): FormulaError {
  try {
    parseFormula(text);
  } catch (err) {
    if (err instanceof FormulaError) return err;
    throw err;
  }
  throw new Error(`no error for ${text}`);
}

describe('parseFormula', () => {
  it('follows Excel precedence: -2^2 = (-2)^2, ^ is left-associative, % binds before ^', () => {
    const ast = parseFormula('=-2^2');
    expect(ast.kind).toBe('binary');
    if (ast.kind === 'binary') {
      expect(ast.op).toBe('^');
      expect(ast.left.kind).toBe('unary');
    }
    const chain = parseFormula('=2^3^2');
    expect(chain.kind === 'binary' && chain.left.kind === 'binary').toBe(true);
    const cmp = parseFormula('=1+2&"x"=3');
    expect(cmp.kind === 'binary' && cmp.op).toBe('=');
  });

  it('reads references with ]] escapes, strings with "" escapes, numbers and booleans', () => {
    const ast = parseFormula('=CONCAT([Mã [cũ]]], "a""b", 1.5e3, .5, TRUE, false)');
    expect(ast.kind).toBe('call');
    if (ast.kind !== 'call') return;
    expect(ast.args.map((a) => a.kind)).toEqual([
      'ref',
      'string',
      'number',
      'number',
      'boolean',
      'boolean',
    ]);
    const [ref, str, num] = ast.args;
    expect(ref?.kind === 'ref' && ref.name).toBe('Mã [cũ]');
    expect(str?.kind === 'string' && str.value).toBe('a"b');
    expect(num?.kind === 'number' && num.text).toBe('1.5e3');
  });

  it('upper-cases function names and drops the _xlfn. prefix', () => {
    const ast = parseFormula('=_xlfn.ifs(TRUE,1)');
    expect(ast.kind === 'call' && ast.name).toBe('IFS');
    expect(parseFormula('=round(1,2)').kind === 'call').toBe(true);
  });

  it('reports a missing "=", an unclosed call, a ";" with its hint and the character position (AC-B4-03)', () => {
    expect(parseError('IF([A]>0,1)').params).toMatchObject({ context: 'missingEquals', pos: 1 });
    const unclosed = parseError('=IF([A]>0,1');
    expect(unclosed.messageKey).toBe('formula.error.syntax');
    expect(unclosed.params).toMatchObject({ context: 'missingParen', pos: 12 });
    const semi = parseError('=ROUND([A];2)');
    expect(semi.params).toMatchObject({ context: 'semicolon', pos: 11 });
    expect(semi.start).toBe(10);
    expect(parseError('=').params['context']).toBe('empty');
    expect(parseError('=1+').params['context']).toBe('end');
    expect(parseError('=A1+1').params['context']).toBe('cellRef');
    expect(parseError('=abc').params['context']).toBe('name');
    expect(parseError('=1)').params['context']).toBe('unbalanced');
    expect(parseError('="abc').params['context']).toBe('unterminatedString');
    expect(parseError('=[abc').params['context']).toBe('unterminatedRef');
    expect(parseError('=[ ]').params['context']).toBe('emptyRef');
    expect(parseError('=1 # 2').params).toMatchObject({ context: 'unexpectedChar', pos: 4 });
    expect(parseError('=1 2').params['context']).toBe('unexpected');
  });

  it(`limits nesting to ${MAX_DEPTH} and the text to ${MAX_LENGTH} characters`, () => {
    expect(() => parseFormula(`=${'('.repeat(MAX_DEPTH)}1${')'.repeat(MAX_DEPTH)}`)).not.toThrow();
    const deep = parseError(`=${'('.repeat(MAX_DEPTH + 1)}1${')'.repeat(MAX_DEPTH + 1)}`);
    expect(deep.messageKey).toBe('formula.error.tooDeep');
    expect(deep.params['max']).toBe(MAX_DEPTH);
    expect(parseError(`=${'-'.repeat(MAX_DEPTH + 1)}1`).messageKey).toBe('formula.error.tooDeep');
    expect(
      parseError(`=${'ABS('.repeat(MAX_DEPTH + 1)}1${')'.repeat(MAX_DEPTH + 1)}`).messageKey,
    ).toBe('formula.error.tooDeep');
    expect(parseError(`=${'1+'.repeat(MAX_LENGTH)}1`).messageKey).toBe('formula.error.tooLong');
  });

  it('counts chained operations (tooComplex beyond 150)', () => {
    expect(parseFormula(`=1${'*1'.repeat(MAX_CHAIN)}`).height).toBe(MAX_CHAIN);
    const compile = (formula: string) =>
      compileFormula([{ key: 'r', formula, type: 'auto', onError: 'blank' }], [], {
        dialect: DESIGN_DIALECT,
        from: '"t"',
        params: [],
      });
    expect(() => compile(`=1${'*1'.repeat(MAX_CHAIN)}`)).not.toThrow();
    let err: unknown;
    try {
      compile(`=1${'*1'.repeat(MAX_CHAIN + 1)}`);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(EngineError);
    expect((err as EngineError).messageKey).toBe('formula.error.tooComplex');
    expect((err as EngineError).path).toEqual(['columns', 0, 'formula']);
  });

  it('fuzz: random text only ever fails with a FormulaError (fixed seed)', () => {
    let seed = 12345;
    const next = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const alphabet = '=()[]"",;.+-*/^&%<>=0123456789eEaZ_ IFROUNDSUMxé]]\u0000\n\t$#!';
    for (let k = 0; k < 20000; k++) {
      const len = Math.floor(next() * 40);
      let text = next() < 0.8 ? '=' : '';
      for (let i = 0; i < len; i++) text += alphabet[Math.floor(next() * alphabet.length)];
      try {
        parseFormula(text);
      } catch (err) {
        expect(err).toBeInstanceOf(FormulaError);
        const e = err as FormulaError;
        expect(e.messageKey).toMatch(/^formula\.error\./);
        expect(e.start).toBeGreaterThanOrEqual(0);
        expect(e.start).toBeLessThanOrEqual(text.length);
      }
    }
  });
});

describe('references (spec §12.2, AC-B4-04, AC-B4-05)', () => {
  const columns = [
    { key: 'luong_co_ban', title: 'Lương cơ bản' },
    { key: 'ghi_chu', title: 'Ghi chú' },
    { key: 'ghi_chu_2', title: 'Ghi chú' },
    { key: 'ma_cu', title: 'Mã [cũ]' },
  ];

  it('resolves a key first, then a unique title (NFC, case and surrounding spaces ignored)', () => {
    expect(resolveRef('luong_co_ban', columns)).toEqual({ kind: 'ok', key: 'luong_co_ban' });
    expect(resolveRef(' lương CƠ BẢN ', columns)).toEqual({ kind: 'ok', key: 'luong_co_ban' });
    expect(resolveRef('Lương cơ bản'.normalize('NFD'), columns)).toEqual({
      kind: 'ok',
      key: 'luong_co_ban',
    });
    expect(resolveRef('Ghi chú', columns)).toEqual({ kind: 'ambiguous' });
    expect(resolveRef('ghi_chu_2', columns)).toEqual({ kind: 'ok', key: 'ghi_chu_2' });
    expect(resolveRef('Mã [cũ]', columns)).toEqual({ kind: 'ok', key: 'ma_cu' });
    expect(resolveRef('khong_co', columns)).toEqual({ kind: 'missing' });
  });

  it('stores [Title] as [key] and shows [key] by the current title, outside strings only', () => {
    expect(toStored('=[Lương cơ bản]*2&"[Lương cơ bản]"', columns)).toBe(
      '=[luong_co_ban]*2&"[Lương cơ bản]"',
    );
    expect(toStored('=[Mã [cũ]]]', columns)).toBe('=[ma_cu]');
    expect(toStored('=[Ghi chú]', columns)).toBe('=[Ghi chú]');
    const renamed = [{ key: 'luong_co_ban', title: 'Lương CB' }, ...columns.slice(1)];
    expect(toDisplay('=[luong_co_ban]*2', renamed)).toBe('=[Lương CB]*2');
    expect(toDisplay('=[ma_cu]', columns)).toBe('=[Mã [cũ]]]');
    // A shared title cannot lead back to one column: the key is shown.
    expect(toDisplay('=[ghi_chu_2]', columns)).toBe('=[ghi_chu_2]');
    // Text being typed: an unterminated part is kept as typed.
    expect(toStored('=[Lương cơ bản]&"abc', columns)).toBe('=[luong_co_ban]&"abc');
    expect(toStored('=[Lương', columns)).toBe('=[Lương');
  });

  it('escapes ] as ]]', () => {
    expect(escapeRef('Mã [cũ]')).toBe('[Mã [cũ]]]');
    expect(escapeRef('a]]b')).toBe('[a]]]]b]');
  });
});

describe('function table (spec §9.1)', () => {
  it('lists the 41 functions of MEMORY 2026-10-30 17:24 in their groups', () => {
    expect(FUNCTIONS.map((f) => f.name)).toEqual([
      'IF',
      'IFS',
      'AND',
      'OR',
      'NOT',
      'SWITCH',
      'IFERROR',
      'ISBLANK',
      'ISNUMBER',
      'ROUND',
      'ROUNDUP',
      'ROUNDDOWN',
      'INT',
      'ABS',
      'MIN',
      'MAX',
      'MOD',
      'SUM',
      'LEFT',
      'RIGHT',
      'MID',
      'LEN',
      'TRIM',
      'UPPER',
      'LOWER',
      'PROPER',
      'CONCAT',
      'TEXTJOIN',
      'SUBSTITUTE',
      'FIND',
      'SEARCH',
      'VALUE',
      'DATE',
      'YEAR',
      'MONTH',
      'DAY',
      'EDATE',
      'EOMONTH',
      'DATEDIF',
      'WEEKDAY',
      'PARAM',
    ]);
    expect(FUNCTION_GROUPS).toEqual(['logic', 'math', 'text', 'date', 'param']);
    for (const f of FUNCTIONS) {
      expect(FUNCTION_GROUPS).toContain(f.group);
      expect(f.min).toBeLessThanOrEqual(f.max);
    }
  });

  it('public.ts exposes exactly the surface of 02 §3', () => {
    expect(Object.keys(surface).sort()).toEqual(
      ['FUNCTIONS', 'FUNCTION_GROUPS', 'FormulaError', 'escapeRef', 'toDisplay', 'toStored'].sort(),
    );
  });
});
