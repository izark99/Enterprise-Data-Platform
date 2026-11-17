import type { DataType, FlowParam, FormulaConfig } from '@hrflow/flow-schema';
import { Big, roundDecimal, type Decimal } from '../core/decimal';
import { EngineError } from '../core/errors';
import type { ColumnDef, Schema } from '../core/types';
import type { ParamValue, SqlDialect, SqlValue } from '../nodes/index';
import { functionSpec, LOOKUP_FUNCTIONS } from './functions';
import { FormulaError, parseFormula, type Ast, type CompareOp } from './parser';
import { resolveRef, type RefColumn } from './refs';

/**
 * Transpiler of `transform.formula` (spec §12.2): formula columns → one DuckDB `SELECT`. Only the
 * whitelisted functions of spec §9.1 have a translation; nothing of the formula text reaches the
 * SQL except column keys through `SqlDialect.ident`. Every constant (number, string) and every
 * `PARAM` value is a prepared parameter (`SqlDialect.param`).
 *
 * Each expression compiles to a value and an error code (SQL `NULL` = no error; `ERROR_CODES`), so
 * a failing row never stops DuckDB: `IFERROR` and `onError` work per row. Numbers are
 * `DECIMAL(38,10)` throughout; `*` and `/` are exact (DuckDB itself would give `DECIMAL(38,20)`,
 * which overflows early, and `DOUBLE`), division and rounding are half away from zero on 10
 * places. The only `DOUBLE` is `^` with an exponent that is not a constant integer (15 significant
 * digits, spec §12.2). Overflow and out-of-range dates become `#NUM!`, never a DuckDB error.
 *
 * A subexpression used more than once is computed once into a hidden column `"hr$f<n>"` of an inner
 * projection (one nested `SELECT` per level), so the SQL grows linearly with the formula.
 */

export type FormulaColumn = FormulaConfig['columns'][number];
export type ParamType = FlowParam['type'];

/** A flow parameter as the formula sees it (`PARAM("key")`). */
export interface FormulaParamDef {
  readonly key: string;
  readonly type: ParamType;
}

/** Excel error of a row, by code (1-based) in the hidden error columns. */
export const ERROR_CODES = ['#DIV/0!', '#VALUE!', '#NUM!', '#N/A'] as const;
export type FormulaErrorCode = (typeof ERROR_CODES)[number];
const DIV0 = '1';
const VALUE = '2';
const NUM = '3';
const NA = '4';

/** Longest chain of operations in one node (spec §12.2 `tooComplex`). */
export const MAX_CHAIN = 150;
/**
 * Budgets of the generated SQL beyond which a node is `tooComplex` at design time, so every
 * accepted node plans safely in DuckDB (measured on the Node bindings of the same
 * `duckdb-eh.wasm`, T-R1-09 verifier round; numbers in docs):
 * - `MAX_SQL_DEPTH`: DuckDB refuses an expression depth above 1000 ("Max expression depth"); a
 *   nested `SELECT` counts 2, a parenthesis or `CASE` 1 (`sqlDepth`). 800 leaves a margin.
 * - `MAX_SQL_LENGTH`: planning memory grows with the SQL size; the smallest plan that ran out of
 *   memory was 2.56 MB, the largest one measured to plan was 3.2 MB of other operators.
 * - `MAX_PROJECTED`: planning time grows with the items of all projection lists.
 */
export const MAX_SQL_DEPTH = 800;
export const MAX_SQL_LENGTH = 1_500_000;
export const MAX_PROJECTED = 15_000;

const DEC = 'DECIMAL(38,10)';
const FRAC = 'DECIMAL(10,10)';
/** Serial number 0 (Excel's 1900-01-00): a blank date, `YEAR` 1900, `DAY` 0. */
const DAY_ZERO = "DATE '1899-12-31'";
const MIN_DATE = "DATE '1900-01-01'";
const MAX_DATE = "DATE '9999-12-31'";
const E10 = '10000000000';
const E28 = '10000000000000000000000000000';
/** Length / position / occurrence arguments are clamped to 2^31 − 1 (spec §12.2). */
const MAX_LEN = '2147483647';
/** Other integer arguments (digits, date parts, months) are clamped to ±10^15. */
const MAX_INT = '1000000000000000';
/**
 * Month and day offsets are clamped so their `INTEGER` casts never fail (DuckDB can evaluate a
 * repeated constant cast outside its `TRY`); both limits are far beyond 9999-12-31, so the result
 * stays `#NUM!`.
 */
const MAX_MONTHS = '1000000';
const MAX_DAYS = '100000000';
/** `[10, 100, …, 10^38]` as HUGEINT: 10^(10 − n) of `ROUND(x, n)` is element `10 − n`. */
const POWERS = `[${Array.from({ length: 38 }, (_, k) => `CAST(1${'0'.repeat(k + 1)} AS HUGEINT)`).join(', ')}]`;
/** Text that reads as a number (spec §12.2: `1.5`, `-2`, `1e3`; not "1,500", "50%"). */
const NUMBER_TEXT = String.raw`'\s*[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?\s*'`;
/** Excel `ERROR.TYPE`-like lookup of the SQL type of each formula type. */
type FT = 'number' | 'string' | 'boolean' | 'date';
const SQL_TYPE: Readonly<Record<FT, string>> = {
  number: DEC,
  string: 'VARCHAR',
  boolean: 'BOOLEAN',
  date: 'DATE',
};

/** A compiled expression. */
interface Ex {
  readonly t: FT;
  /** SQL value; `NULL` means blank when `blank`, else only when `e` is set. */
  readonly v: string;
  /** SQL error code (`NULL` = none); `null` = the expression cannot fail. */
  readonly e: string | null;
  readonly blank: boolean;
  /** A bare column reference (Excel ignores text in references for SUM, MIN, MAX, AND, OR). */
  readonly ref: boolean;
  /** `v` and `e` are names or literals: free to repeat in SQL. */
  readonly atom: boolean;
  /** Deepest projection level of the hidden columns it reads (0 = input columns only). */
  readonly lvl: number;
  /** Value of a number constant (the exponent of `^`). */
  readonly num?: Decimal;
}

interface Def {
  readonly name: string;
  readonly sql: string;
  readonly lvl: number;
}

/** One formula column after compilation. */
export interface CompiledColumn {
  readonly index: number;
  readonly key: string;
  readonly type: DataType;
  /** `auto` result type (spec §12.2 type inference). */
  readonly inferred: DataType;
  /** `IF` / `IFS` / `SWITCH` / `IFERROR` branches of different types (`mixedTypes`). */
  readonly mixedTypes: boolean;
  readonly onError: 'blank' | 'fail';
  /** Key of the hidden error-code column in the result, `null` when the formula cannot fail. */
  readonly errorKey: string | null;
}

export interface CompiledFormula {
  /** Output columns: input columns (overwritten ones in place), then new columns in order. */
  readonly output: Schema;
  readonly columns: readonly CompiledColumn[];
  /** `SELECT` over `from` returning `output`, the order column, then the error columns. */
  readonly sql: string;
  /** Values of the `?` placeholders of `sql`, in text order. */
  readonly params: readonly SqlValue[];
  /** `output` plus one `integer` column per formula that can fail (`errorKey`). */
  readonly resultColumns: Schema;
  /** Nested `SELECT`s of `sql` (bounded by `MAX_NESTING`). */
  readonly nesting: number;
  /** Items of all projection lists of `sql` (bounded by `MAX_PROJECTED`). */
  readonly projected: number;
}

export interface CompileOptions {
  readonly dialect: SqlDialect;
  /** Relation to read (already quoted). */
  readonly from: string;
  readonly params: readonly FormulaParamDef[];
  /** Run parameter values; absent at design time (every `PARAM` is then blank). */
  readonly values?: Readonly<Record<string, ParamValue>>;
}

/** Placeholder of a bound value until the SQL is finished (never part of a name or literal). */
const MARK = '\u0000';

const errOf = (...codes: (string | null)[]): string | null => {
  const list = [...new Set(codes.filter((c): c is string => c !== null))];
  if (list.length === 0) return null;
  return list.length === 1 ? list[0]! : `coalesce(${list.join(', ')})`;
};

const lvlOf = (...xs: readonly Ex[]): number => xs.reduce((m, x) => Math.max(m, x.lvl), 0);

/** Text of a parameter value for its type, or `null` (blank) — spec §12.2 `PARAM` typing. */
function paramText(type: ParamType, value: ParamValue | undefined): SqlValue {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const text = typeof value === 'boolean' ? String(value) : String(value).trim();
  if (type === 'month') return /^\d{4}-\d{2}$/.test(text) ? `${text}-01` : null;
  if (type === 'string' || type === 'select') return String(value);
  return text;
}

function paramFt(type: ParamType): FT {
  if (type === 'number') return 'number';
  if (type === 'boolean') return 'boolean';
  if (type === 'date' || type === 'month') return 'date';
  return 'string';
}

function ftOf(type: DataType): FT {
  if (type === 'integer' || type === 'decimal') return 'number';
  if (type === 'datetime') return 'date';
  return type;
}

/** The `auto` type of a result type. */
function autoType(t: FT): DataType {
  return t === 'number' ? 'decimal' : t;
}

/** Number constant → `DECIMAL(38,10)` text, or `null` when it overflows (`#NUM!`). */
function constantText(text: string): string | null {
  const d = new Big(text);
  // Exponent check first: `1e999999` must never be expanded to its digits.
  if (d.e > 27) return null;
  if (d.e < -11) return '0';
  const r = roundDecimal(d);
  return r.e > 27 ? null : r.toFixed();
}

/** Error at a column of the node, for the Designer (`path`) and the texts (`formulaColumn`). */
function columnError(
  index: number,
  key: string,
  field: 'key' | 'formula' | 'type',
  err: EngineError,
): EngineError {
  return new EngineError(
    err.messageKey,
    { ...err.params, formulaColumn: key },
    { path: ['columns', index, field] },
  );
}

class Compiler {
  private readonly defs: Def[] = [];
  private readonly levels = new Map<string, number>();
  private readonly seen = new Map<string, { name: string; lvl: number }>();
  private readonly values: SqlValue[] = [];
  private readonly hidden: RegExp;
  mixed = false;
  /** Nested `SELECT`s of the assembled SQL. */
  nesting = 0;
  /** Items of every projection list of the assembled SQL. */
  projected = 0;

  constructor(
    private readonly d: SqlDialect,
    private readonly params: readonly FormulaParamDef[],
    private readonly paramValues: Readonly<Record<string, ParamValue>>,
  ) {
    const probe = d.aux('f0');
    const at = probe.indexOf('f0');
    const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    this.hidden = new RegExp(`${esc(probe.slice(0, at))}f(\\d+)${esc(probe.slice(at + 2))}`, 'g');
  }

  // ---- SQL plumbing -------------------------------------------------------------------------

  /** A bound value: a marker replaced by `SqlDialect.param` when the SQL is finished. */
  private bind(value: SqlValue): string {
    this.values.push(value);
    return `${MARK}${this.values.length - 1}${MARK}`;
  }

  /**
   * `sql` computed once into a hidden column, one level above the deepest hidden column it reads
   * (the level comes from the SQL itself, so nothing waits a level for an error column it does
   * not read). The same SQL without bound values is computed once.
   */
  hoist(sql: string): { name: string; lvl: number } {
    const bound = sql.includes(MARK);
    const known = bound ? undefined : this.seen.get(sql);
    if (known !== undefined) return known;
    let deepest = 0;
    for (const m of sql.match(this.hidden) ?? [])
      deepest = Math.max(deepest, this.levels.get(m) ?? 0);
    const name = this.d.aux(`f${this.defs.length}`);
    this.defs.push({ name, sql, lvl: deepest + 1 });
    this.levels.set(name, deepest + 1);
    const out = { name, lvl: deepest + 1 };
    if (!bound) this.seen.set(sql, out);
    return out;
  }

  private isName(sql: string): boolean {
    this.hidden.lastIndex = 0;
    const m = this.hidden.exec(sql);
    return m !== null && m.index === 0 && m[0].length === sql.length;
  }

  /** `x` with value and error in hidden columns, so it can be repeated in SQL. */
  atom(x: Ex): Ex {
    if (x.atom) return x;
    const v = this.isName(x.v) ? { name: x.v, lvl: x.lvl } : this.hoist(x.v);
    const e =
      x.e === null || /^\d$/.test(x.e) || this.isName(x.e)
        ? { name: x.e, lvl: 0 }
        : this.hoist(x.e);
    return { ...x, v: v.name, e: e.name, atom: true, lvl: Math.max(v.lvl, e.lvl, x.lvl) };
  }

  /** A new value from `deps` (their errors first, then `own`, left to right like Excel). */
  private ex(t: FT, v: string, deps: readonly Ex[], own: (string | null)[] = []): Ex {
    return {
      t,
      v,
      e: errOf(...deps.map((x) => x.e), ...own),
      blank: false,
      ref: false,
      atom: false,
      lvl: lvlOf(...deps),
    };
  }

  /** `sql` hoisted; its `NULL` is the error `code` (overflow, out of range, not found…). */
  private checked(t: FT, sql: string, deps: readonly Ex[], code: string, pre: string[] = []) {
    const h = this.hoist(sql);
    const e = errOf(
      ...deps.map((x) => x.e),
      ...pre,
      `CASE WHEN ${h.name} IS NULL THEN ${code} END`,
    );
    return { t, v: h.name, e, blank: false, ref: false, atom: false, lvl: h.lvl } satisfies Ex;
  }

  private literal(t: FT, v: string, num?: Decimal): Ex {
    return { t, v, e: null, blank: false, ref: false, atom: true, lvl: 0, ...(num ? { num } : {}) };
  }

  private failed(t: FT, code: string): Ex {
    return { ...this.literal(t, `CAST(NULL AS ${SQL_TYPE[t]})`), e: code };
  }

  /** Blank test of a value that may be blank (a text reference: also empty after trimming). */
  isNull(x: Ex): string {
    return x.ref && x.t === 'string' ? this.d.isBlank(x.v, 'string') : `(${x.v} IS NULL)`;
  }

  /**
   * Final SQL: nested projections, innermost first. Each level passes on the input columns, the
   * order column and only the hidden columns read further out.
   */
  assemble(from: string, keep: readonly string[], select: readonly string[]): string {
    const refs = (sql: string): string[] => sql.match(this.hidden) ?? [];
    const byLevel = new Map<number, Def[]>();
    let top = 0;
    for (const def of this.defs) {
      const list = byLevel.get(def.lvl) ?? [];
      list.push(def);
      byLevel.set(def.lvl, list);
      top = Math.max(top, def.lvl);
    }
    let needed = new Set(select.flatMap(refs));
    const levels: { defs: Def[]; through: string[] }[] = [];
    for (let k = top; k >= 1; k--) {
      const defs = (byLevel.get(k) ?? []).filter((def) => needed.has(def.name));
      const names = new Set(defs.map((def) => def.name));
      const through = [...needed].filter((n) => !names.has(n));
      const before = new Set(through);
      for (const def of defs) for (const r of refs(def.sql)) before.add(r);
      levels[k] = { defs, through };
      needed = before;
    }
    let sql = `SELECT ${keep.join(', ')} FROM ${from}`;
    this.nesting = 2;
    this.projected = keep.length + select.length;
    for (let k = 1; k <= top; k++) {
      const level = levels[k]!;
      if (level.defs.length === 0) continue;
      this.nesting++;
      this.projected += keep.length + level.through.length + level.defs.length;
      const list = [
        ...keep,
        ...level.through,
        ...level.defs.map((def) => `${def.sql} AS ${def.name}`),
      ];
      sql = `SELECT ${list.join(', ')} FROM (${sql}) AS ${this.d.aux(`s${k}`)}`;
    }
    return `SELECT ${select.join(', ')} FROM (${sql}) AS ${this.d.aux('s')}`;
  }

  /** Markers → placeholders, values in text order. */
  finish(sql: string): { sql: string; params: SqlValue[] } {
    const parts = sql.split(MARK);
    const params: SqlValue[] = [];
    let out = '';
    for (let i = 0; i < parts.length; i++) {
      if (i % 2 === 0) out += parts[i];
      else {
        out += this.d.param;
        params.push(this.values[Number(parts[i])]!);
      }
    }
    return { sql: out, params };
  }

  // ---- conversions (spec §12.2 "Ô trống", "Chuyển kiểu ngầm") ---------------------------------

  /** Excel serial number of a date atom (1900 system, with the fictitious 1900-02-29). */
  private serial(v: string): string {
    return `(date_diff('day', DATE '1899-12-30', ${v}) - CASE WHEN ${v} < DATE '1900-03-01' THEN 1 ELSE 0 END)`;
  }

  num(x: Ex): Ex {
    switch (x.t) {
      case 'number':
        return x.blank
          ? {
              ...x,
              v: `coalesce(${x.v}, CAST(0 AS ${DEC}))`,
              blank: false,
              ref: false,
              atom: false,
            }
          : x;
      case 'boolean':
        return this.ex('number', `CAST(CASE WHEN ${x.v} THEN 1 ELSE 0 END AS ${DEC})`, [x]);
      case 'date': {
        const s = this.atom(x);
        return this.ex('number', `CAST(coalesce(${this.serial(s.v)}, 0) AS ${DEC})`, [s]);
      }
      case 'string': {
        const s = this.atom(x);
        const m = this.hoist(`regexp_full_match(${s.v}, ${NUMBER_TEXT})`);
        const p = this.hoist(`CASE WHEN ${m.name} THEN TRY_CAST(trim(${s.v}) AS ${DEC}) END`);
        // Reads as a number but does not fit DECIMAL(38,10) → #NUM!; not a number → #VALUE!.
        return {
          t: 'number',
          v: `coalesce(${p.name}, CAST(0 AS ${DEC}))`,
          e: errOf(
            s.e,
            `CASE WHEN ${p.name} IS NULL AND NOT ${this.isNull(s)} THEN CASE WHEN ${m.name} THEN ${NUM} ELSE ${VALUE} END END`,
          ),
          blank: false,
          ref: false,
          atom: false,
          lvl: p.lvl,
        };
      }
    }
  }

  str(x: Ex): Ex {
    switch (x.t) {
      case 'string':
        return x.blank ? this.ex('string', `coalesce(${x.v}, '')`, [x]) : x;
      case 'number':
        return this.ex('string', `coalesce(rtrim(rtrim(CAST(${x.v} AS VARCHAR), '0'), '.'), '')`, [
          x,
        ]);
      case 'boolean':
        return this.ex(
          'string',
          `CASE ${x.v} WHEN TRUE THEN 'TRUE' WHEN FALSE THEN 'FALSE' ELSE '' END`,
          [x],
        );
      case 'date': {
        const s = this.atom(x);
        return this.ex('string', `coalesce(CAST(${this.serial(s.v)} AS VARCHAR), '')`, [s]);
      }
    }
  }

  bool(x: Ex): Ex {
    switch (x.t) {
      case 'boolean':
        return x.blank ? this.ex('boolean', `coalesce(${x.v}, FALSE)`, [x]) : x;
      case 'number':
        return this.ex('boolean', `(coalesce(${x.v}, 0) <> 0)`, [x]);
      case 'date':
        return this.ex('boolean', `coalesce(${x.v} <> ${DAY_ZERO}, FALSE)`, [x]);
      case 'string': {
        const s = this.atom(x);
        const b = this.hoist(
          `CASE upper(trim(${s.v})) WHEN 'TRUE' THEN TRUE WHEN 'FALSE' THEN FALSE END`,
        );
        return {
          t: 'boolean',
          v: `coalesce(${b.name}, FALSE)`,
          e: errOf(s.e, `CASE WHEN ${b.name} IS NULL AND NOT ${this.isNull(s)} THEN ${VALUE} END`),
          blank: false,
          ref: false,
          atom: false,
          lvl: b.lvl,
        };
      }
    }
  }

  /** A date argument: a date, or a serial number (0 … 2958465). */
  date(x: Ex, result = false): Ex {
    if (x.t === 'date') {
      return x.blank ? this.ex('date', `coalesce(${x.v}, ${DAY_ZERO})`, [x]) : x;
    }
    const n = this.atom(this.num(x));
    // An argument may be serial 0 (a blank date, Excel's 1900-01-00); a date result may not:
    // spec §12.2, a result outside 1900-01-01 … 9999-12-31 is #NUM!.
    return this.checked(
      'date',
      `CASE WHEN ${n.v} >= ${result ? 1 : 0} AND ${n.v} < 2958466 THEN ${DAY_ZERO} + CAST(floor(greatest(least(${n.v}, 2958466), 0)) AS INTEGER) - CASE WHEN ${n.v} >= 61 THEN 1 ELSE 0 END END`,
      [n],
      NUM,
    );
  }

  /** `INT`: floor; just above −10^28 the floor does not fit `DECIMAL(38,10)` → `#NUM!`. */
  intPart(a: Ex): Ex {
    const x = this.num(a);
    return this.checked('number', `TRY(CAST(floor(${x.v}) AS ${DEC}))`, [x], NUM);
  }

  /** An integer argument (truncated toward zero like Excel), clamped to ±`limit`, as BIGINT. */
  int(x: Ex, limit: string = MAX_INT): Ex {
    const n = this.num(x);
    return this.ex(
      'number',
      `CAST(trunc(greatest(least(${n.v}, ${limit}), -${limit})) AS BIGINT)`,
      [n],
    );
  }

  private intConst(n: number): Ex {
    return this.literal('number', `CAST(${n} AS BIGINT)`);
  }

  /** A date result: `#NUM!` outside 1900-01-01 … 9999-12-31 (spec §12.2). */
  private dateResult(sql: string, deps: readonly Ex[]): Ex {
    const h = this.hoist(`TRY(CAST(${sql} AS DATE))`);
    return {
      t: 'date',
      v: h.name,
      e: errOf(
        ...deps.map((x) => x.e),
        `CASE WHEN ${h.name} IS NULL OR ${h.name} < ${MIN_DATE} OR ${h.name} > ${MAX_DATE} THEN ${NUM} END`,
      ),
      blank: false,
      ref: false,
      atom: false,
      lvl: h.lvl,
    };
  }

  /** Same type for the branches of IF / IFS / SWITCH / IFERROR; mixed → text (`mixedTypes`). */
  private unify(xs: readonly Ex[]): Ex[] {
    const t = xs[0]!.t;
    if (xs.every((x) => x.t === t)) return [...xs];
    this.mixed = true;
    return xs.map((x) => this.str(x));
  }

  // ---- numbers ---------------------------------------------------------------------------

  /** `trunc(x)` × 10^10 + fraction × 10^10: the exact scaled integer of a decimal atom. */
  private scaled(v: string): string {
    return `(CAST(trunc(${v}) AS HUGEINT) * ${E10} + CAST((${v} - trunc(${v})) * ${E10} AS HUGEINT))`;
  }

  /** Scaled HUGEINT → `DECIMAL(38,10)`, `NULL` when it does not fit. */
  private unscaled(s: string): string {
    return `TRY(CAST(CAST(${s} AS DECIMAL(38,0)) * CAST(0.0000000001 AS ${FRAC}) AS ${DEC}))`;
  }

  /** `n / d` of HUGEINTs rounded half away from zero. */
  private roundDiv(n: string, d: string): string {
    return `(${n} // ${d} + CASE WHEN abs(${n} % ${d}) >= abs(${d}) - abs(${n} % ${d}) THEN sign(${n}) * sign(${d}) ELSE 0 END)`;
  }

  mul(a: Ex, b: Ex): Ex {
    const x = this.atom(this.num(a));
    const y = this.atom(this.num(b));
    const fx = `CAST(${x.v} - trunc(${x.v}) AS ${FRAC})`;
    const fy = `CAST(${y.v} - trunc(${y.v}) AS ${FRAC})`;
    const sql =
      `TRY(CAST(trunc(${x.v}) * trunc(${y.v}) AS ${DEC}) + trunc(${x.v}) * ${fy} + ` +
      `${fx} * trunc(${y.v}) + CAST(${fx} * ${fy} AS ${DEC}))`;
    return this.checked('number', sql, [x, y], NUM);
  }

  div(a: Ex, b: Ex): Ex {
    const x = this.atom(this.num(a));
    const y = this.atom(this.num(b));
    const A = this.hoist(this.scaled(x.v)).name;
    const B = this.hoist(this.scaled(y.v)).name;
    // |A| < 10^28: A × 10^10 fits HUGEINT; else the integer part first (|B| < 10^28); else
    // (|a|, |b| ≥ 10^18) divide by the integer part of b.
    const s =
      `CASE WHEN ${B} = 0 THEN NULL ` +
      `WHEN abs(${A}) < ${E28} THEN ${this.roundDiv(`(${A} * ${E10})`, B)} ` +
      `WHEN abs(${B}) < ${E28} THEN (${A} // ${B}) * ${E10} + ${this.roundDiv(`((${A} % ${B}) * ${E10})`, B)} ` +
      `ELSE ${this.roundDiv(A, `(${B} // ${E10})`)} END`;
    const q = this.hoist(this.unscaled(`TRY(${s})`));
    return {
      t: 'number',
      v: q.name,
      e: errOf(
        x.e,
        y.e,
        `CASE WHEN ${y.v} = 0 THEN ${DIV0} WHEN ${q.name} IS NULL THEN ${NUM} END`,
      ),
      blank: false,
      ref: false,
      atom: false,
      lvl: q.lvl,
    };
  }

  /** `^`: exact for a constant integer exponent |n| ≤ 64, else 15 significant digits. */
  pow(a: Ex, b: Ex): Ex {
    const base = this.atom(this.num(a));
    const n = b.num !== undefined && b.e === null ? b.num : undefined;
    if (n !== undefined && n.eq(n.round(0, Big.roundDown)) && n.abs().lte(64)) {
      const k = Number(n.toFixed());
      if (k === 0) {
        return this.ex(
          'number',
          `CAST(1 AS ${DEC})`,
          [base],
          [`CASE WHEN ${base.v} = 0 THEN ${NUM} END`],
        );
      }
      let result: Ex | null = null;
      let square = base;
      for (let m = Math.abs(k); m > 0; m = Math.floor(m / 2)) {
        if (m % 2 === 1) result = result === null ? square : this.mul(result, square);
        if (m > 1) square = this.mul(square, square);
      }
      if (k > 0) return result!;
      // 1 / x^|k|: when x^|k| overflows (x ≠ 0) the exact result rounds to 0 on 10 places; only
      // an overflow of the result itself is #NUM! (spec §12.2).
      const p = this.atom(result!);
      const q = this.div(this.literal('number', `CAST(1 AS ${DEC})`), { ...p, e: base.e });
      return {
        t: 'number',
        v: `CASE WHEN ${p.v} IS NULL THEN CAST(0 AS ${DEC}) ELSE ${q.v} END`,
        e: `CASE WHEN ${p.v} IS NULL THEN ${base.e ?? 'NULL'} ELSE ${q.e ?? 'NULL'} END`,
        blank: false,
        ref: false,
        atom: false,
        lvl: Math.max(p.lvl, q.lvl),
      };
    }
    const exp = this.atom(this.num(b));
    const zeroNeg = `${base.v} = 0 AND ${exp.v} < 0`;
    return this.checked(
      'number',
      `CASE WHEN ${zeroNeg} THEN NULL ELSE TRY_CAST(printf('%.15g', pow(CAST(${base.v} AS DOUBLE), CAST(${exp.v} AS DOUBLE))) AS ${DEC}) END`,
      [base, exp],
      NUM,
      [`CASE WHEN ${zeroNeg} THEN ${DIV0} END`],
    );
  }

  /** `a + b − c …` as one checked sum; date ± days → date, date − date → days. */
  additive(terms: readonly { sign: 1 | -1; x: Ex }[]): Ex {
    const plusDates = terms.filter((t) => t.x.t === 'date' && t.sign === 1).length;
    const minusDates = terms.filter((t) => t.x.t === 'date' && t.sign === -1).length;
    const nums = terms.map((t) => ({ sign: t.sign, x: this.num(t.x) }));
    const sum = nums.map((t, i) => `${t.sign < 0 ? ' - ' : i === 0 ? '' : ' + '}${t.x.v}`).join('');
    const total = this.checked(
      'number',
      `TRY(CAST(${sum} AS ${DEC}))`,
      nums.map((t) => t.x),
      NUM,
    );
    return plusDates === 1 && minusDates === 0 ? this.date(total, true) : total;
  }

  // ---- comparison (Excel: numbers < text < logicals; text without case) -----------------------

  private blankOf(t: FT): Ex {
    switch (t) {
      case 'number':
        return this.literal('number', `CAST(0 AS ${DEC})`);
      case 'string':
        return this.literal('string', "''");
      case 'boolean':
        return this.literal('boolean', 'FALSE');
      case 'date':
        return this.literal('date', DAY_ZERO);
    }
  }

  /** `a op b` for two values of one kind (number and date are one kind). */
  private sameKind(op: CompareOp, a: Ex, b: Ex): { sql: string; deps: Ex[] } {
    if (a.t === 'date' && b.t === 'date') {
      const x = this.date(a);
      const y = this.date(b);
      return { sql: `(${x.v} ${op} ${y.v})`, deps: [x, y] };
    }
    if (a.t === 'string') {
      const x = this.str(a);
      const y = this.str(b);
      return { sql: `(lower(${x.v}) ${op} lower(${y.v}))`, deps: [x, y] };
    }
    if (a.t === 'boolean') {
      const x = this.bool(a);
      const y = this.bool(b);
      return { sql: `(${x.v} ${op} ${y.v})`, deps: [x, y] };
    }
    const x = this.num(a);
    const y = this.num(b);
    return { sql: `(${x.v} ${op} ${y.v})`, deps: [x, y] };
  }

  compare(op: CompareOp, l: Ex, r: Ex): Ex {
    const kind = (t: FT) => (t === 'date' ? 'number' : t);
    if (kind(l.t) === kind(r.t)) {
      const s = this.sameKind(op, l, r);
      return this.ex('boolean', s.sql, s.deps);
    }
    const rank = { number: 0, string: 1, boolean: 2 } as const;
    const lr = rank[kind(l.t)];
    const rr = rank[kind(r.t)];
    const outcome = {
      '=': false,
      '<>': true,
      '<': lr < rr,
      '<=': lr < rr,
      '>': lr > rr,
      '>=': lr > rr,
    }[op];
    const constant = outcome ? 'TRUE' : 'FALSE';
    if (!l.blank && !r.blank) return this.ex('boolean', constant, [l, r]);
    // A blank cell compares as the other side's blank value (0, "", FALSE).
    const a = l.blank ? this.atom(l) : l;
    const b = r.blank ? this.atom(r) : r;
    const parts: string[] = [];
    const deps: Ex[] = [a, b];
    const eq = op === '=' || op === '<=' || op === '>=';
    if (a.blank && b.blank) {
      parts.push(`WHEN ${this.isNull(a)} AND ${this.isNull(b)} THEN ${eq ? 'TRUE' : 'FALSE'}`);
    }
    if (a.blank) {
      const s = this.sameKind(op, this.blankOf(b.t), b);
      parts.push(`WHEN ${this.isNull(a)} THEN ${s.sql}`);
      deps.push(...s.deps);
    }
    if (b.blank) {
      const s = this.sameKind(op, a, this.blankOf(a.t));
      parts.push(`WHEN ${this.isNull(b)} THEN ${s.sql}`);
      deps.push(...s.deps);
    }
    return this.ex('boolean', `CASE ${parts.join(' ')} ELSE ${constant} END`, deps);
  }

  // ---- branches ----------------------------------------------------------------------------

  /** CASE WHEN c1 THEN v1 … ELSE fallback; no fallback → `#N/A`. Errors follow the branch taken. */
  branch(pairs: readonly [Ex, Ex][], fallback: Ex | null): Ex {
    const conds = pairs.map(([c]) => this.atom(this.bool(c)));
    const values = this.unify([...pairs.map(([, v]) => v), ...(fallback ? [fallback] : [])]);
    const t = values[0]!.t;
    const fb = fallback ? values[values.length - 1]! : null;
    const v = conds.map((c, i) => `WHEN ${c.v} THEN ${values[i]!.v}`).join(' ');
    const eParts: string[] = [];
    let anyErr = fb === null || fb.e !== null;
    conds.forEach((c, i) => {
      if (c.e !== null) {
        eParts.push(`WHEN ${c.e} IS NOT NULL THEN ${c.e}`);
        anyErr = true;
      }
      const ve = values[i]!.e;
      if (ve !== null) anyErr = true;
      eParts.push(`WHEN ${c.v} THEN ${ve ?? 'NULL'}`);
    });
    const all = [...conds, ...values];
    return {
      t,
      v: `CASE ${v} ELSE ${fb ? fb.v : `CAST(NULL AS ${SQL_TYPE[t]})`} END`,
      e: anyErr ? `CASE ${eParts.join(' ')} ELSE ${fb ? (fb.e ?? 'NULL') : NA} END` : null,
      blank: values.some((x) => x.blank),
      ref: false,
      atom: false,
      lvl: lvlOf(...all),
    };
  }

  iferror(x: Ex, alt: Ex): Ex {
    if (x.e === null) return x;
    const [vx, va] = this.unify([x, alt]) as [Ex, Ex];
    const err = this.hoist(vx.e!);
    return {
      t: vx.t,
      v: `CASE WHEN ${err.name} IS NULL THEN ${vx.v} ELSE ${va.v} END`,
      e: va.e === null ? null : `CASE WHEN ${err.name} IS NOT NULL THEN ${va.e} END`,
      blank: vx.blank || va.blank,
      ref: false,
      atom: false,
      lvl: Math.max(err.lvl, lvlOf(vx, va)),
    };
  }

  /** AND / OR: blank cells and text in references are ignored; nothing left → `#VALUE!`. */
  andOr(fn: 'AND' | 'OR', args: readonly Ex[]): Ex {
    const parts: { x: Ex; nullable: boolean }[] = [];
    for (const x of args) {
      if (x.ref && x.t === 'string') continue;
      if (x.ref && x.blank) {
        const s = this.atom(x);
        const b = this.bool({ ...s, blank: false });
        const p = this.atom(
          this.ex('boolean', `CASE WHEN ${this.isNull(s)} THEN NULL ELSE ${b.v} END`, [b]),
        );
        parts.push({ x: p, nullable: true });
      } else parts.push({ x: this.bool(x), nullable: false });
    }
    if (parts.length === 0) return this.failed('boolean', VALUE);
    const unit = fn === 'AND' ? 'TRUE' : 'FALSE';
    const v = parts
      .map((p) => (p.nullable ? `coalesce(${p.x.v}, ${unit})` : p.x.v))
      .join(fn === 'AND' ? ' AND ' : ' OR ');
    const none = parts.every((p) => p.nullable)
      ? `CASE WHEN ${parts.map((p) => `${p.x.v} IS NULL`).join(' AND ')} THEN ${VALUE} END`
      : null;
    return this.ex(
      'boolean',
      `(${v})`,
      parts.map((p) => p.x),
      [none],
    );
  }

  /** MIN / MAX: blank cells, text and logicals in references are ignored; nothing → 0. */
  minMax(fn: 'MIN' | 'MAX', args: readonly Ex[]): Ex {
    const kept = args.filter((x) => !(x.ref && (x.t === 'string' || x.t === 'boolean')));
    const sqlFn = fn === 'MIN' ? 'least' : 'greatest';
    if (kept.length > 0 && kept.every((x) => x.t === 'date')) {
      return {
        ...this.ex('date', `${sqlFn}(${kept.map((x) => x.v).join(', ')})`, kept),
        blank: true,
      };
    }
    const nums = kept.map((x) => {
      if (!(x.ref && x.blank)) return this.num(x);
      if (x.t === 'number') return x;
      const s = this.atom(x);
      return this.ex('number', `CAST(${this.serial(s.v)} AS ${DEC})`, [s]);
    });
    if (nums.length === 0) return this.literal('number', `CAST(0 AS ${DEC})`);
    return this.ex(
      'number',
      `coalesce(${sqlFn}(${nums.map((x) => x.v).join(', ')}), CAST(0 AS ${DEC}))`,
      nums,
    );
  }

  sum(args: readonly Ex[]): Ex {
    const nums = args
      .filter((x) => !(x.ref && (x.t === 'string' || x.t === 'boolean')))
      .map((x) => this.num(x));
    if (nums.length === 0) return this.literal('number', `CAST(0 AS ${DEC})`);
    return this.checked(
      'number',
      `TRY(CAST(${nums.map((x) => x.v).join(' + ')} AS ${DEC}))`,
      nums,
      NUM,
    );
  }

  round(mode: 'ROUND' | 'ROUNDUP' | 'ROUNDDOWN', a: Ex, b: Ex): Ex {
    const x = this.atom(this.num(a));
    const n = this.atom(this.int(b));
    const S = this.hoist(this.scaled(x.v));
    const p = this.hoist(`CASE WHEN ${n.v} < 10 AND ${n.v} >= -28 THEN ${POWERS}[10 - ${n.v}] END`);
    const s = S.name;
    const q = `${s} // ${p.name}`;
    const r = `${s} % ${p.name}`;
    const step =
      mode === 'ROUND'
        ? `CASE WHEN abs(${r}) >= ${p.name} - abs(${r}) THEN sign(${s}) ELSE 0 END`
        : mode === 'ROUNDUP'
          ? `CASE WHEN ${r} <> 0 THEN sign(${s}) ELSE 0 END`
          : '0';
    const beyond =
      mode === 'ROUNDUP' ? `CASE WHEN ${x.v} = 0 THEN CAST(0 AS ${DEC}) END` : `CAST(0 AS ${DEC})`;
    const sql =
      `CASE WHEN ${n.v} >= 10 THEN ${x.v} WHEN ${n.v} < -28 THEN ${beyond} ` +
      `ELSE ${this.unscaled(`TRY((${q} + ${step}) * ${p.name})`)} END`;
    const lvl = Math.max(S.lvl, p.lvl);
    return this.checked('number', sql, [x, n, { ...x, e: null, lvl }], NUM);
  }

  mod(a: Ex, b: Ex): Ex {
    const x = this.num(a);
    const y = this.atom(this.num(b));
    const r = this.hoist(`(${x.v} % NULLIF(${y.v}, 0))`);
    const v = `CASE WHEN ${r.name} <> 0 AND (${r.name} < 0) <> (${y.v} < 0) THEN ${r.name} + ${y.v} ELSE ${r.name} END`;
    return {
      ...this.ex('number', v, [x, y], [`CASE WHEN ${y.v} = 0 THEN ${DIV0} END`]),
      lvl: r.lvl,
    };
  }

  // ---- text --------------------------------------------------------------------------------

  /** Excel wildcards (`*`, `?`, `~` escape) of a text atom → RE2 pattern, every other char literal. */
  private wildcard(f: string): string {
    const protect = `replace(replace(replace(${f}, '~~', chr(1)), '~*', chr(2)), '~?', chr(3))`;
    const escaped = `regexp_replace(${protect}, '([.+*?()\\[\\]{}|^$\\\\])', '\\\\\\1', 'g')`;
    const wild = `replace(replace(${escaped}, '\\*', '.*'), '\\?', '.')`;
    return `replace(replace(replace(${wild}, chr(2), '\\*'), chr(3), '\\?'), chr(1), '~')`;
  }

  find(fn: 'FIND' | 'SEARCH', fx: Ex, wx: Ex, stx: Ex | undefined): Ex {
    const f = this.atom(this.str(fx));
    const w = this.atom(this.str(wx));
    const st = this.atom(stx ? this.int(stx, MAX_LEN) : this.intConst(1));
    const ok = `${st.v} >= 1 AND ${st.v} <= length(${w.v}) + 1`;
    const rest = `substring(${w.v}, ${st.v})`;
    let pos: string;
    if (fn === 'FIND') {
      pos = `CASE WHEN ${ok} THEN nullif(strpos(${rest}, ${f.v}), 0) END`;
    } else {
      const pat = this.hoist(this.wildcard(f.v)).name;
      pos =
        `TRY(CASE WHEN ${ok} AND regexp_matches(${rest}, '(?is)' || ${pat}) THEN ` +
        `length(regexp_extract(${rest}, '(?is)^(.*?)(?:' || ${pat} || ')', 1)) + 1 END)`;
    }
    return this.checked('number', `CAST(${pos} + ${st.v} - 1 AS ${DEC})`, [f, w, st], VALUE);
  }

  substitute(sx: Ex, ox: Ex, nx: Ex, kx: Ex | undefined): Ex {
    const s = this.atom(this.str(sx));
    const o = this.atom(this.str(ox));
    const nw = this.atom(this.str(nx));
    if (kx === undefined) {
      return this.ex(
        'string',
        `CASE WHEN ${o.v} = '' THEN ${s.v} ELSE replace(${s.v}, ${o.v}, ${nw.v}) END`,
        [s, o, nw],
      );
    }
    const k = this.atom(this.int(kx, MAX_LEN));
    const parts = this.hoist(
      `CASE WHEN ${o.v} <> '' AND ${k.v} >= 1 THEN string_split(${s.v}, ${o.v}) END`,
    );
    const pos = this.hoist(
      `CAST(list_sum(list_transform(${parts.name}[1:${k.v}], hrfx -> length(hrfx))) AS BIGINT) + (${k.v} - 1) * length(${o.v}) + 1`,
    );
    const v =
      `CASE WHEN ${k.v} < 1 THEN NULL WHEN ${o.v} = '' OR len(${parts.name}) - 1 < ${k.v} THEN ${s.v} ` +
      `ELSE substring(${s.v}, 1, ${pos.name} - 1) || ${nw.v} || substring(${s.v}, ${pos.name} + length(${o.v})) END`;
    return {
      ...this.ex('string', v, [s, o, nw, k], [`CASE WHEN ${k.v} < 1 THEN ${VALUE} END`]),
      lvl: pos.lvl,
    };
  }

  proper(x: Ex): Ex {
    const s = this.str(x);
    const chars = this.hoist(`string_split(lower(${s.v}), '')`);
    const c = chars.name;
    return {
      ...this.ex(
        'string',
        `array_to_string(list_transform(${c}, (hrfc, hrfi) -> CASE WHEN hrfi = 1 OR upper(${c}[hrfi - 1]) = lower(${c}[hrfi - 1]) THEN upper(hrfc) ELSE hrfc END), '')`,
        [s],
      ),
      lvl: chars.lvl,
    };
  }

  // ---- dates -------------------------------------------------------------------------------

  makeDate(yx: Ex, mx: Ex, dx: Ex): Ex {
    const y = this.atom(this.int(yx));
    const m = this.int(mx, MAX_MONTHS);
    const d = this.int(dx, MAX_DAYS);
    const year = `greatest(least(${y.v}, 9999), 0) + CASE WHEN ${y.v} < 1900 THEN 1900 ELSE 0 END`;
    const sql =
      `CASE WHEN ${y.v} >= 0 AND ${y.v} <= 9999 THEN ` +
      `CAST(make_date(${year}, 1, 1) + to_months(CAST(${m.v} - 1 AS INTEGER)) AS DATE) + CAST(${d.v} - 1 AS INTEGER) END`;
    return this.dateResult(sql, [y, m, d]);
  }

  datePart(fn: 'YEAR' | 'MONTH' | 'DAY', x: Ex): Ex {
    const d = this.atom(this.date(x));
    const zero = { YEAR: 1900, MONTH: 1, DAY: 0 }[fn];
    return this.ex(
      'number',
      `CAST(CASE WHEN ${d.v} = ${DAY_ZERO} THEN ${zero} ELSE ${fn.toLowerCase()}(${d.v}) END AS ${DEC})`,
      [d],
    );
  }

  shiftMonths(fn: 'EDATE' | 'EOMONTH', dx: Ex, mx: Ex): Ex {
    const d = this.date(dx);
    const m = this.int(mx, MAX_MONTHS);
    const shifted = `CAST(${d.v} + to_months(CAST(${m.v} AS INTEGER)) AS DATE)`;
    return this.dateResult(fn === 'EDATE' ? shifted : `last_day(${shifted})`, [d, m]);
  }

  datedif(sx: Ex, ex: Ex, ux: Ex): Ex {
    const s = this.atom(this.date(sx));
    const e = this.atom(this.date(ex));
    const us = this.str(ux);
    const u = this.atom(this.ex('string', `upper(trim(${us.v}))`, [us]));
    const lvl = lvlOf(s, e, u);
    const months = this.hoist(
      `(year(${e.v}) * 12 + month(${e.v})) - (year(${s.v}) * 12 + month(${s.v})) - CASE WHEN day(${e.v}) < day(${s.v}) THEN 1 ELSE 0 END`,
    ).name;
    const sy = this.hoist(
      `TRY(CAST(${s.v} + to_years(CAST(year(${e.v}) - year(${s.v}) AS INTEGER)) AS DATE))`,
    ).name;
    const md =
      `CASE WHEN day(${e.v}) >= day(${s.v}) THEN day(${e.v}) - day(${s.v}) ` +
      `ELSE day(${e.v}) + day(CAST(date_trunc('month', ${e.v}) AS DATE) - 1) - day(${s.v}) END`;
    const yd =
      `CASE WHEN ${sy} > ${e.v} THEN date_diff('day', TRY(CAST(${s.v} + to_years(CAST(year(${e.v}) - year(${s.v}) - 1 AS INTEGER)) AS DATE)), ${e.v}) ` +
      `ELSE date_diff('day', ${sy}, ${e.v}) END`;
    const sql =
      `CASE WHEN ${s.v} > ${e.v} THEN NULL ELSE CAST(CASE ${u.v} WHEN 'Y' THEN ${months} // 12 WHEN 'M' THEN ${months} ` +
      `WHEN 'D' THEN date_diff('day', ${s.v}, ${e.v}) WHEN 'YM' THEN ${months} % 12 WHEN 'MD' THEN ${md} ` +
      `WHEN 'YD' THEN ${yd} END AS ${DEC}) END`;
    return this.checked('number', `TRY(${sql})`, [s, e, u, { ...s, e: null, lvl: lvl + 1 }], NUM);
  }

  weekday(dx: Ex, tx: Ex | undefined): Ex {
    const d = this.atom(this.date(dx));
    const t = tx ? this.int(tx) : this.intConst(1);
    const sql = `CAST(CASE ${t.v} WHEN 1 THEN dayofweek(${d.v}) + 1 WHEN 2 THEN isodow(${d.v}) WHEN 3 THEN isodow(${d.v}) - 1 END AS ${DEC})`;
    return this.checked('number', sql, [d, t], NUM);
  }

  // ---- leaves ------------------------------------------------------------------------------

  numberConstant(text: string): Ex {
    const fixed = constantText(text);
    if (fixed === null) return this.failed('number', NUM);
    return this.literal('number', this.d.cast(this.bind(fixed), 'decimal'), new Big(fixed));
  }

  stringConstant(value: string): Ex {
    return this.literal('string', this.bind(value));
  }

  booleanConstant(value: boolean): Ex {
    return this.literal('boolean', value ? 'TRUE' : 'FALSE');
  }

  param(arg: Ast): Ex {
    if (arg.kind !== 'string') {
      throw new FormulaError('formula.error.paramName', {}, arg.start, arg.end);
    }
    const def = this.params.find((p) => p.key === arg.value);
    if (def === undefined) {
      throw new FormulaError(
        'formula.error.unknownParam',
        { param: arg.value },
        arg.start,
        arg.end,
      );
    }
    const t = paramFt(def.type);
    const text = paramText(def.type, this.paramValues[def.key]);
    return { ...this.literal(t, `TRY_CAST(${this.bind(text)} AS ${SQL_TYPE[t]})`), blank: true };
  }

  constant(t: FT, value: string, num?: Decimal): Ex {
    return this.literal(t, value, num);
  }
}

interface Visible {
  readonly key: string;
  readonly title: string;
  readonly ex: Ex;
  /** Chained operations of the formula column behind it (0 for an input column). */
  readonly chain: number;
}

/** Compiles one formula's syntax tree in the scope of the columns visible to it. */
class FormulaCompiler {
  /** Referenced keys of each reference node (for the chain count). */
  readonly refKeys = new Map<Ast, string>();

  constructor(
    private readonly c: Compiler,
    private readonly visible: ReadonlyMap<string, Visible>,
    private readonly later: readonly RefColumn[],
  ) {}

  private refs(): RefColumn[] {
    return [...this.visible.values()].map((v) => ({ key: v.key, title: v.title }));
  }

  compile(node: Ast): Ex {
    switch (node.kind) {
      case 'number':
        return this.c.numberConstant(node.text);
      case 'string':
        return this.c.stringConstant(node.value);
      case 'boolean':
        return this.c.booleanConstant(node.value);
      case 'ref':
        return this.ref(node);
      case 'unary': {
        const x = this.compile(node.arg);
        if (node.op === '+') return x;
        const n = this.c.num(x);
        return {
          ...n,
          v: `(-${n.v})`,
          atom: false,
          ...(n.num !== undefined ? { num: n.num.neg() } : {}),
        };
      }
      case 'percent':
        return this.c.mul(
          this.compile(node.arg),
          this.c.constant('number', `CAST(0.01 AS ${DEC})`),
        );
      case 'binary':
        return this.binary(node);
      case 'call':
        return this.call(node);
    }
  }

  private ref(node: Extract<Ast, { kind: 'ref' }>): Ex {
    const r = resolveRef(node.name, this.refs());
    if (r.kind === 'ok') {
      this.refKeys.set(node, r.key);
      return this.visible.get(r.key)!.ex;
    }
    if (r.kind === 'ambiguous') {
      throw new FormulaError(
        'formula.error.ambiguousTitle',
        { column: node.name },
        node.start,
        node.end,
      );
    }
    if (resolveRef(node.name, this.later).kind !== 'missing') {
      throw new FormulaError(
        'formula.error.forwardReference',
        { column: node.name },
        node.start,
        node.end,
      );
    }
    throw new FormulaError(
      'formula.error.unknownColumn',
      { column: node.name },
      node.start,
      node.end,
    );
  }

  private binary(node: Extract<Ast, { kind: 'binary' }>): Ex {
    switch (node.op) {
      case '+':
      case '-': {
        const terms: { sign: 1 | -1; x: Ex }[] = [];
        const walk = (a: Ast, sign: 1 | -1): void => {
          if (a.kind === 'binary' && (a.op === '+' || a.op === '-')) {
            walk(a.left, sign);
            walk(a.right, a.op === '-' ? (sign === 1 ? -1 : 1) : sign);
          } else terms.push({ sign, x: this.compile(a) });
        };
        walk(node, 1);
        return this.c.additive(terms);
      }
      case '*':
        return this.c.mul(this.compile(node.left), this.compile(node.right));
      case '/':
        return this.c.div(this.compile(node.left), this.compile(node.right));
      case '^':
        return this.c.pow(this.compile(node.left), this.compile(node.right));
      case '&': {
        const parts: Ex[] = [];
        const walk = (a: Ast): void => {
          if (a.kind === 'binary' && a.op === '&') {
            walk(a.left);
            walk(a.right);
          } else parts.push(this.c.str(this.compile(a)));
        };
        walk(node);
        return {
          t: 'string',
          v: `(${parts.map((p) => p.v).join(' || ')})`,
          e: errOf(...parts.map((p) => p.e)),
          blank: false,
          ref: false,
          atom: false,
          lvl: lvlOf(...parts),
        };
      }
      default:
        return this.c.compare(node.op, this.compile(node.left), this.compile(node.right));
    }
  }

  private call(node: Extract<Ast, { kind: 'call' }>): Ex {
    const spec = functionSpec(node.name);
    if (spec === undefined) {
      throw new FormulaError(
        'formula.error.unknownFunction',
        { fn: node.name, context: LOOKUP_FUNCTIONS.includes(node.name) ? 'lookup' : 'other' },
        node.start,
        node.nameEnd,
      );
    }
    const n = node.args.length;
    const odd = (node.name === 'IFS' && n % 2 !== 0) || (node.name === 'SWITCH' && n < 3);
    if (n < spec.min || n > spec.max || odd) {
      throw new FormulaError(
        'formula.error.argCount',
        { fn: node.name, min: spec.min, max: spec.max },
        node.start,
        node.end,
      );
    }
    if (node.name === 'PARAM') return this.c.param(node.args[0]!);
    const args = node.args;
    const arg = (i: number): Ex => this.compile(args[i]!);
    const opt = (i: number): Ex | undefined => (i < n ? arg(i) : undefined);
    const all = (): Ex[] => args.map((a) => this.compile(a));
    const c = this.c;
    switch (node.name) {
      case 'IF':
        return this.ifCall(arg(0), arg(1), opt(2));
      case 'IFS': {
        const pairs: [Ex, Ex][] = [];
        for (let i = 0; i < n; i += 2) pairs.push([arg(i), arg(i + 1)]);
        return this.branchCall(pairs, null);
      }
      case 'SWITCH': {
        const x = c.atom(arg(0));
        const pairs: [Ex, Ex][] = [];
        let i = 1;
        for (; i + 1 < n; i += 2) pairs.push([c.compare('=', x, arg(i)), arg(i + 1)]);
        return this.branchCall(pairs, i < n ? arg(i) : null);
      }
      case 'AND':
      case 'OR':
        return c.andOr(node.name, all());
      case 'NOT': {
        const b = c.bool(arg(0));
        return { ...b, v: `(NOT ${b.v})`, atom: false };
      }
      case 'IFERROR':
        return c.iferror(arg(0), arg(1));
      case 'ISBLANK': {
        const x = arg(0);
        if (!x.blank) return c.constant('boolean', 'FALSE');
        const s = c.atom(x);
        const test = c.isNull(s);
        return {
          ...c.constant('boolean', s.e === null ? test : `(${s.e} IS NULL AND ${test})`),
          atom: false,
          lvl: s.lvl,
        };
      }
      case 'ISNUMBER': {
        const x = arg(0);
        if (x.t !== 'number' && x.t !== 'date') return c.constant('boolean', 'FALSE');
        const s = c.atom(x);
        const v = `(${s.v} IS NOT NULL${s.e === null ? '' : ` AND ${s.e} IS NULL`})`;
        return { ...c.constant('boolean', v), atom: false, lvl: s.lvl };
      }
      case 'ROUND':
      case 'ROUNDUP':
      case 'ROUNDDOWN':
        return c.round(node.name, arg(0), arg(1));
      case 'INT':
        return c.intPart(arg(0));
      case 'ABS': {
        const x = c.num(arg(0));
        return { ...x, v: `abs(${x.v})`, atom: false, blank: false, ref: false };
      }
      case 'MIN':
      case 'MAX':
        return c.minMax(node.name, all());
      case 'MOD':
        return c.mod(arg(0), arg(1));
      case 'SUM':
        return c.sum(all());
      case 'LEFT':
      case 'RIGHT': {
        const s = c.str(arg(0));
        const len = c.atom(
          n > 1 ? c.int(arg(1), MAX_LEN) : c.constant('number', 'CAST(1 AS BIGINT)'),
        );
        return this.text(
          `CASE WHEN ${len.v} < 0 THEN NULL ELSE ${node.name.toLowerCase()}(${s.v}, ${len.v}) END`,
          [s, len],
          [`CASE WHEN ${len.v} < 0 THEN ${VALUE} END`],
        );
      }
      case 'MID': {
        const s = c.str(arg(0));
        const st = c.atom(c.int(arg(1), MAX_LEN));
        const len = c.atom(c.int(arg(2), MAX_LEN));
        const bad = `${st.v} < 1 OR ${len.v} < 0`;
        return this.text(
          `CASE WHEN ${bad} THEN NULL ELSE substring(${s.v}, ${st.v}, ${len.v}) END`,
          [s, st, len],
          [`CASE WHEN ${bad} THEN ${VALUE} END`],
        );
      }
      case 'LEN': {
        const s = c.str(arg(0));
        return { ...s, t: 'number', v: `CAST(length(${s.v}) AS ${DEC})`, atom: false };
      }
      case 'TRIM': {
        const s = c.str(arg(0));
        return this.text(`regexp_replace(trim(${s.v}, ' '), ' {2,}', ' ', 'g')`, [s]);
      }
      case 'UPPER':
      case 'LOWER': {
        const s = c.str(arg(0));
        return this.text(`${node.name.toLowerCase()}(${s.v})`, [s]);
      }
      case 'PROPER':
        return c.proper(arg(0));
      case 'CONCAT': {
        const parts = all().map((x) => c.str(x));
        return this.text(`(${parts.map((p) => p.v).join(' || ')})`, parts);
      }
      case 'TEXTJOIN':
        return this.textjoin(all());
      case 'SUBSTITUTE':
        return c.substitute(arg(0), arg(1), arg(2), opt(3));
      case 'FIND':
      case 'SEARCH':
        return c.find(node.name, arg(0), arg(1), opt(2));
      case 'VALUE': {
        const x = arg(0);
        if (x.t === 'boolean')
          return { ...c.constant('number', `CAST(0 AS ${DEC})`), e: errOf(x.e, VALUE), lvl: x.lvl };
        return c.num(x);
      }
      case 'DATE':
        return c.makeDate(arg(0), arg(1), arg(2));
      case 'YEAR':
      case 'MONTH':
      case 'DAY':
        return c.datePart(node.name, arg(0));
      case 'EDATE':
      case 'EOMONTH':
        return c.shiftMonths(node.name, arg(0), arg(1));
      case 'DATEDIF':
        return c.datedif(arg(0), arg(1), arg(2));
      case 'WEEKDAY':
        return c.weekday(arg(0), opt(1));
    }
    // Every whitelisted function is handled above.
    throw new FormulaError(
      'formula.error.unknownFunction',
      { fn: node.name, context: 'other' },
      node.start,
      node.nameEnd,
    );
  }

  private text(v: string, deps: readonly Ex[], own: (string | null)[] = []): Ex {
    return {
      t: 'string',
      v,
      e: errOf(...deps.map((x) => x.e), ...own),
      blank: false,
      ref: false,
      atom: false,
      lvl: lvlOf(...deps),
    };
  }

  private ifCall(cond: Ex, yes: Ex, no: Ex | undefined): Ex {
    return this.branchCall([[cond, yes]], no ?? this.c.constant('boolean', 'FALSE'));
  }

  private branchCall(pairs: [Ex, Ex][], fallback: Ex | null): Ex {
    return this.c.branch(pairs, fallback);
  }

  private textjoin(xs: readonly Ex[]): Ex {
    const c = this.c;
    const delim = c.atom(c.str(xs[0]!));
    const ignore = c.bool(xs[1]!);
    const dynamic = ignore.v !== 'TRUE' && ignore.v !== 'FALSE';
    const parts = xs.slice(2).map((x) => (dynamic ? c.atom(c.str(x)) : c.str(x)));
    const keep = `concat_ws(${delim.v}, ${parts.map((p) => p.v).join(', ')})`;
    const skip = `concat_ws(${delim.v}, ${parts.map((p) => `NULLIF(${p.v}, '')`).join(', ')})`;
    const v = !dynamic
      ? ignore.v === 'TRUE'
        ? skip
        : keep
      : `CASE WHEN ${ignore.v} THEN ${skip} ELSE ${keep} END`;
    return this.text(v, [delim, ignore, ...parts]);
  }

  /** Chained operations of a syntax tree (references count as the chain of their column). */
  chain(node: Ast): number {
    switch (node.kind) {
      case 'number':
      case 'string':
      case 'boolean':
        return 0;
      case 'ref': {
        const key = this.refKeys.get(node);
        return key === undefined ? 0 : (this.visible.get(key)?.chain ?? 0);
      }
      case 'unary':
      case 'percent':
        return this.chain(node.arg) + 1;
      case 'binary':
        return Math.max(this.chain(node.left), this.chain(node.right)) + 1;
      case 'call':
        return node.args.reduce((m, a) => Math.max(m, this.chain(a)), 0) + 1;
    }
  }
}

/** Which result types an explicit column type accepts (spec §12.2, MEMORY 2026-10-30 17:32). */
function accepts(type: DataType, t: FT): boolean {
  if (type === 'boolean') return t === 'boolean';
  if (type === 'date') return t === 'date';
  return true;
}

/** The value converted to the column type; text: `""` is blank (spec §12.1). */
function finalize(c: Compiler, x: Ex, type: DataType): Ex {
  const keepBlank = (conv: (s: Ex) => Ex): Ex => {
    if (!x.blank) return conv(x);
    const s = c.atom(x);
    const r = conv({ ...s, blank: false });
    return {
      ...r,
      v: `CASE WHEN ${c.isNull(s)} THEN NULL ELSE ${r.v} END`,
      atom: false,
      lvl: Math.max(r.lvl, s.lvl),
    };
  };
  switch (type) {
    case 'string': {
      if (x.t === 'string') return { ...x, v: `NULLIF(${x.v}, '')`, atom: false };
      if (x.t === 'date') return { ...x, t: 'string', v: `CAST(${x.v} AS VARCHAR)`, atom: false };
      const s = keepBlank((y) => c.str(y));
      return { ...s, v: `NULLIF(${s.v}, '')`, atom: false };
    }
    case 'decimal':
      return x.t === 'number' ? x : keepBlank((y) => c.num(y));
    case 'integer': {
      const n = c.atom(x.t === 'number' ? x : keepBlank((y) => c.num(y)));
      return {
        ...n,
        v: `CASE WHEN ${n.v} = trunc(${n.v}) THEN TRY_CAST(${n.v} AS BIGINT) END`,
        e: errOf(
          n.e,
          `CASE WHEN ${n.v} <> trunc(${n.v}) THEN ${VALUE} WHEN ${n.v} IS NOT NULL AND TRY_CAST(${n.v} AS BIGINT) IS NULL THEN ${NUM} END`,
        ),
        atom: false,
      };
    }
    default:
      return x;
  }
}

/**
 * Expression depth of generated SQL as DuckDB's parser counts it, at its deepest point: open
 * parentheses, plus one more for each one that opens a `SELECT`, plus open `CASE`s. String
 * literals and quoted names are skipped.
 */
export function sqlDepth(sql: string): number {
  let parens = 0;
  let cases = 0;
  let selects = 0;
  const stack: boolean[] = [];
  let max = 0;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]!;
    if (ch === "'" || ch === '"') {
      const end = sql.indexOf(ch, i + 1);
      i = end < 0 ? sql.length : end;
      continue;
    }
    if (ch === '(') {
      const select = sql.startsWith('SELECT', i + 1);
      stack.push(select);
      parens++;
      if (select) selects++;
    } else if (ch === ')') {
      if (stack.pop() === true) selects--;
      parens--;
    } else if (ch === 'C' && sql.startsWith('CASE ', i) && !/\w/.test(sql[i - 1] ?? ' ')) {
      cases++;
    } else if (
      ch === 'E' &&
      sql.startsWith('END', i) &&
      !/\w/.test(sql[i - 1] ?? ' ') &&
      !/\w/.test(sql[i + 3] ?? ' ')
    ) {
      cases--;
    }
    max = Math.max(max, parens + selects + cases);
  }
  return max;
}

/** Key of a hidden column not used by any output column. */
function freshKey(base: string, taken: Set<string>): string {
  let key = base;
  while (taken.has(key)) key = `_${key}`;
  taken.add(key);
  return key;
}

/**
 * Compiles the formula columns of a `transform.formula` node over the input columns. Throws an
 * `EngineError` with the field path (`['columns', i, 'key' | 'formula' | 'type']`) and the column
 * key (`formulaColumn`) for the first problem.
 */
export function compileFormula(
  columns: readonly FormulaColumn[],
  input: Schema,
  options: CompileOptions,
): CompiledFormula {
  const d = options.dialect;
  const c = new Compiler(d, options.params, options.values ?? {});
  const visible = new Map<string, Visible>();
  for (const col of input) {
    const name = d.ident(col.key);
    const v =
      col.type === 'integer'
        ? `CAST(${name} AS ${DEC})`
        : col.type === 'datetime'
          ? `CAST(${name} AS DATE)`
          : name;
    visible.set(col.key, {
      key: col.key,
      title: col.title,
      chain: 0,
      ex: { t: ftOf(col.type), v, e: null, blank: true, ref: true, atom: true, lvl: 0 },
    });
  }
  columns.forEach((col, i) => {
    if (col.key.startsWith('_')) {
      throw columnError(
        i,
        col.key,
        'key',
        new EngineError('formula.error.reservedKey', { key: col.key }),
      );
    }
  });

  const output: ColumnDef[] = input.map((col) => ({ ...col }));
  const compiled: CompiledColumn[] = [];
  const values = new Map<string, string>();
  const errors = new Map<string, string>();
  columns.forEach((col, i) => {
    const later = columns
      .slice(i)
      .filter((x) => !visible.has(x.key))
      .map((x) => ({ key: x.key, title: x.title ?? x.key }));
    const fc = new FormulaCompiler(c, visible, later);
    c.mixed = false;
    let x: Ex;
    let chain: number;
    try {
      const ast = parseFormula(col.formula);
      if (ast.height > MAX_CHAIN) {
        throw new FormulaError('formula.error.tooComplex', { max: MAX_CHAIN }, ast.start, ast.end);
      }
      x = fc.compile(ast);
      chain = fc.chain(ast);
      if (chain > MAX_CHAIN) {
        throw new FormulaError('formula.error.tooComplex', { max: MAX_CHAIN }, ast.start, ast.end);
      }
    } catch (err) {
      if (err instanceof EngineError) throw columnError(i, col.key, 'formula', err);
      throw err;
    }
    const type: DataType = col.type === 'auto' ? autoType(x.t) : col.type;
    if (!accepts(type, x.t)) {
      throw columnError(
        i,
        col.key,
        'type',
        new EngineError('formula.error.typeMismatch', { type, inferred: autoType(x.t) }),
      );
    }
    const fin = finalize(c, x, type);
    let value: { name: string; lvl: number };
    let error: string | null = null;
    if (fin.e === null) {
      value = c.hoist(fin.v);
    } else {
      const e = c.hoist(fin.e);
      value = c.hoist(`CASE WHEN ${e.name} IS NULL THEN ${fin.v} END`);
      error = e.name;
    }
    const prev = output.findIndex((o) => o.key === col.key);
    const title = col.title ?? (prev >= 0 ? output[prev]!.title : col.key);
    const def: ColumnDef = { key: col.key, title, type };
    if (prev >= 0) output[prev] = def;
    else output.push(def);
    values.set(col.key, value.name);
    if (error !== null) errors.set(col.key, error);
    visible.set(col.key, {
      key: col.key,
      title,
      chain,
      ex: {
        t: ftOf(type),
        v: type === 'integer' ? `CAST(${value.name} AS ${DEC})` : value.name,
        e: null,
        blank: true,
        ref: true,
        atom: true,
        lvl: value.lvl,
      },
    });
    compiled.push({
      index: i,
      key: col.key,
      type,
      inferred: autoType(x.t),
      mixedTypes: c.mixed,
      onError: col.onError,
      errorKey: null,
    });
  });

  const taken = new Set(output.map((o) => o.key));
  const keep = [...input.map((col) => d.ident(col.key)), d.ord];
  const errorKeys = new Map<string, string>();
  for (const col of compiled) {
    if (errors.has(col.key)) errorKeys.set(col.key, freshKey(`_err_${col.index}`, taken));
  }
  /** The SELECT of the output with the formula columns of `upTo` (all by default). */
  const build = (upTo: number) => {
    const shown = new Set(columns.slice(0, upTo).map((col) => col.key));
    const select = output.map((o) => {
      const v = shown.has(o.key) ? values.get(o.key) : undefined;
      return v === undefined ? d.ident(o.key) : `${d.cast(v, o.type)} AS ${d.ident(o.key)}`;
    });
    select.push(d.ord);
    for (const col of compiled.slice(0, upTo)) {
      const err = errors.get(col.key);
      if (err !== undefined) {
        select.push(`${d.cast(err, 'integer')} AS ${d.ident(errorKeys.get(col.key)!)}`);
      }
    }
    return c.finish(c.assemble(options.from, keep, select));
  };
  const fits = (sql: string): boolean =>
    sql.length <= MAX_SQL_LENGTH && c.projected <= MAX_PROJECTED && sqlDepth(sql) <= MAX_SQL_DEPTH;
  const done = build(columns.length);
  if (!fits(done.sql)) {
    // Error path only: the first column whose SQL no longer fits is the one to simplify.
    let at = columns.length - 1;
    for (let k = 1; k < columns.length; k++) {
      if (!fits(build(k).sql)) {
        at = k - 1;
        break;
      }
    }
    throw columnError(
      at,
      columns[at]!.key,
      'formula',
      new EngineError('formula.error.tooComplex', { max: MAX_CHAIN }),
    );
  }
  const resultColumns: ColumnDef[] = [...output];
  const withKeys = compiled.map((col) => {
    const errorKey = errorKeys.get(col.key);
    if (errorKey === undefined) return col;
    resultColumns.push({ key: errorKey, title: errorKey, type: 'integer' });
    return { ...col, errorKey };
  });
  return {
    output,
    columns: withKeys,
    sql: done.sql,
    params: done.params,
    resultColumns,
    nesting: c.nesting,
    projected: c.projected,
  };
}

/** DuckDB types of the engine types, as `SqlDialect.cast` of the DuckDB runtime writes them. */
const DESIGN_TYPES: Readonly<Record<DataType, string>> = {
  string: 'VARCHAR',
  integer: 'BIGINT',
  decimal: DEC,
  boolean: 'BOOLEAN',
  date: 'DATE',
  datetime: 'TIMESTAMP',
};

/**
 * Dialect for design-time compilation (schema inference, type checks, the `tooComplex` budgets):
 * the SQL built with it is never run, but it has the same text as with the DuckDB runtime's
 * dialect (`engine/duckdb/scope.ts`, equality tested), so the budgets give the same answer at
 * design time and at run time.
 */
export const DESIGN_DIALECT: SqlDialect = {
  ident: (key) => `"${key}"`,
  ord: '"hr$ord"',
  aux: (name) => `"hr$${name}"`,
  normKey: (expr) => `hrflow_norm_key(${expr})`,
  cast: (expr, type) => `CAST(${expr} AS ${DESIGN_TYPES[type]})`,
  isBlank: (expr, type) =>
    type === 'string' ? `(hrflow_norm_key(${expr}) = '')` : `(${expr} IS NULL)`,
  param: 'CAST(? AS VARCHAR)',
};
