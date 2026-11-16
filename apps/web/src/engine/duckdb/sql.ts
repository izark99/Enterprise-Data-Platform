import { IdentifierSchema, type DataType } from '@hrflow/flow-schema';
import { Big, roundDecimal, type Decimal } from '../core/decimal';
import { EngineError, type ErrorVars } from '../core/errors';

/**
 * SQL building blocks of the DuckDB runtime (spec §9.2, §9.4, §12.1 "Quy ước chung"):
 * - column keys enter SQL only after `IdentifierSchema` accepts them, inside double quotes;
 * - values enter SQL only as prepared-statement parameters, never as text;
 * - every table uploaded to DuckDB has the hidden row-order column `hr$ord` (`ORD_COLUMN`);
 * - decimals are `DECIMAL(38,10)` and cross as decimal text, never through `DOUBLE`;
 * - `hrflow_norm_key` is the SQL twin of `normalizeKeyPart` (engine/core/keys.ts, 03 §4.4).
 */

/** Value bound to a prepared statement: every parameter is bound as `VARCHAR` or `NULL` (spec §9.2). */
export type SqlParam = string | null;

/**
 * Hidden row-order column (spec §12.1 `__ord`): 1-based, dense on upload, never shown to the Admin.
 * Named `hr$ord` so no column key can clash with it: `IdentifierSchema` never accepts `$` (owner
 * 2A, MEMORY 2026-11-16). It is written as `ORD_SQL`, never through `quoteIdent`.
 */
export const ORD_COLUMN = 'hr$ord';
/** `ORD_COLUMN` quoted for SQL. */
export const ORD_SQL = `"${ORD_COLUMN}"`;

/** Canonical DuckDB type of each engine type (spec §9.4). */
export const DUCKDB_TYPE: Readonly<Record<DataType, string>> = {
  string: 'VARCHAR',
  integer: 'BIGINT',
  decimal: 'DECIMAL(38,10)',
  boolean: 'BOOLEAN',
  date: 'DATE',
  datetime: 'TIMESTAMP',
};

/** `DECIMAL(38,10)` holds at most 38 − 10 integer digits (spec §9.4). */
export const MAX_DECIMAL_INTEGER_DIGITS = 28;

/**
 * Double-quoted identifier. Only `IdentifierSchema` names are accepted (`[a-z_][a-z0-9_]*`), so a
 * name can never contain a quote; anything else is a bug in the caller and throws.
 */
export function quoteIdent(name: string): string {
  if (!IdentifierSchema.safeParse(name).success) {
    throw new TypeError('quoteIdent: not an IdentifierSchema name');
  }
  return `"${name}"`;
}

/**
 * Unicode whitespace exactly as JavaScript's `\s` (ECMAScript WhiteSpace + LineTerminator), in RE2
 * syntax: DuckDB's own `\s` matches ASCII whitespace only.
 */
const JS_WHITESPACE_RE2 = String.raw`[\t\n\x0B\f\r \x{00A0}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}]+`;

/** Name of the SQL twin of `normalizeKeyPart`. */
export const NORM_KEY_MACRO = 'hrflow_norm_key';

/**
 * Macros created on every connection (db.ts). `hrflow_norm_key(x)` = NFC → every run of Unicode
 * whitespace to one space → trim (only spaces are left) → lowercase; `NULL` → `''`, as
 * `normalizeKeyPart`. DuckDB's `lower` uses simple case mapping: the one unconditional
 * multi-character lowercase mapping of JavaScript, U+0130 (İ → i + U+0307), is applied first.
 */
export const ENGINE_MACROS: readonly string[] = [
  `CREATE MACRO ${NORM_KEY_MACRO}(x) AS coalesce(lower(trim(regexp_replace(replace(nfc_normalize(x), chr(304), 'i' || chr(775)), '${JS_WHITESPACE_RE2}', ' ', 'g'))), '')`,
];

/** `hrflow_norm_key(<expr>)`; for `VARCHAR` expressions only. */
export function normKeySql(expr: string): string {
  return `${NORM_KEY_MACRO}(${expr})`;
}

const withNode = (vars: Record<string, string | number>, node: string | undefined): ErrorVars =>
  node === undefined ? vars : { node, ...vars };

/** `duckdb.error.decimalOverflow` (spec §9.4); the column is named when it is known. */
export function decimalOverflow(column: string | undefined, node?: string): EngineError {
  return new EngineError(
    'duckdb.error.decimalOverflow',
    withNode(column === undefined ? {} : { column }, node),
  );
}

/** Integer digits of a decimal (`0.5` has none). */
function integerDigits(d: Decimal): number {
  const int = d.abs().round(0, Big.roundDown);
  return int.eq(0) ? 0 : int.toFixed().length;
}

/** Throws `duckdb.error.decimalOverflow` when `d` has more than 28 integer digits. */
export function checkDecimalFits(d: Decimal, column: string, node?: string): Decimal {
  if (integerDigits(d) > MAX_DECIMAL_INTEGER_DIGITS) throw decimalOverflow(column, node);
  return d;
}

/**
 * A decimal as the text DuckDB casts to `DECIMAL(38,10)` (spec §9.4): rounded half-up to 10 places,
 * plain notation (no exponent). More than 28 integer digits → `duckdb.error.decimalOverflow`.
 */
export function decimalToSqlText(d: Decimal, column: string, node?: string): string {
  const rounded = roundDecimal(d);
  checkDecimalFits(rounded, column, node);
  return rounded.toFixed();
}

/** How a DuckDB result column is read back into the engine (spec §9.4). */
export type ReadKind =
  'string' | 'boolean' | 'integer' | 'decimal' | 'double' | 'date' | 'datetime';

const INTEGER_TYPES = new Set([
  'TINYINT',
  'SMALLINT',
  'INTEGER',
  'BIGINT',
  'UTINYINT',
  'USMALLINT',
  'UINTEGER',
  'UBIGINT',
]);
const TIMESTAMP_TYPES = new Set(['TIMESTAMP', 'TIMESTAMP_S', 'TIMESTAMP_MS', 'TIMESTAMP_NS']);

/**
 * Read kind of a DuckDB type name (`duckdb_columns().data_type`), or `null` when the engine has no
 * type for it (`TIMESTAMP WITH TIME ZONE`, `INTERVAL`, `LIST`, `STRUCT`, `MAP`, `BLOB`, `UUID`, …):
 * the caller raises `sql.error.unsupportedType` and the Admin must `CAST`.
 */
export function readKindOf(duckType: string): ReadKind | null {
  const t = duckType.trim().toUpperCase();
  if (t === 'VARCHAR') return 'string';
  if (t === 'BOOLEAN') return 'boolean';
  if (INTEGER_TYPES.has(t)) return 'integer';
  if (t === 'HUGEINT' || t === 'UHUGEINT' || /^DECIMAL\(\d+,\d+\)$/.test(t)) return 'decimal';
  if (t === 'DOUBLE' || t === 'FLOAT') return 'double';
  if (t === 'DATE') return 'date';
  if (TIMESTAMP_TYPES.has(t)) return 'datetime';
  return null;
}

/**
 * Expression reading a column of the given kind into what arrow-io decodes: text for exact numbers
 * and dates (`CAST(… AS VARCHAR)`, never `DOUBLE`), ISO text without fractional seconds for
 * timestamps, the column itself for `VARCHAR`, `BOOLEAN` and `DOUBLE`/`FLOAT`.
 */
export function readExpr(column: string, kind: ReadKind): string {
  const c = quoteIdent(column);
  switch (kind) {
    case 'string':
    case 'boolean':
    case 'double':
      return c;
    case 'datetime':
      return `strftime(${c}, '%Y-%m-%dT%H:%M:%S')`;
    case 'integer':
    case 'decimal':
    case 'date':
      return `CAST(${c} AS VARCHAR)`;
  }
}

/** Expression casting an uploaded raw Arrow column to its canonical type (spec §9.4, §13.1). */
export function uploadExpr(column: string, type: DataType): string {
  return `CAST(${quoteIdent(column)} AS ${DUCKDB_TYPE[type]})`;
}

/** Error raised by DuckDB. Its text can quote cell values: never logged, never put in an `EngineError`. */
export class DuckDbError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DuckDbError';
  }
}

/**
 * DuckDB failure → engine error without DuckDB's text (it may hold data). Only an out-of-range
 * decimal is told apart (`duckdb.error.decimalOverflow`), because the Admin can act on it.
 */
export function toEngineError(err: unknown, node?: string): Error {
  if (err instanceof EngineError) return err;
  if (err instanceof DuckDbError) {
    if (/Out of Range Error|overflow/i.test(err.message)) return decimalOverflow(undefined, node);
    return new EngineError('duckdb.error.queryFailed', withNode({}, node));
  }
  return err instanceof Error ? err : new Error('DuckDB: unexpected failure');
}
