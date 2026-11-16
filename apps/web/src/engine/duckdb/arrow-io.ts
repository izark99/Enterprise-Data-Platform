import type { DataType } from '@hrflow/flow-schema';
import {
  Bool,
  Field,
  Int64,
  makeData,
  RecordBatch,
  Schema as ArrowSchema,
  Struct,
  Table as ArrowTable,
  tableToIPC,
  Utf8,
  type Data,
  type DataType as ArrowType,
  type Vector as ArrowVector,
} from 'apache-arrow';
import { decimalFromNumber, isDecimal, parseDecimal } from '../core/decimal';
import { EngineError } from '../core/errors';
import { ColumnBuilder, Table, type Vector } from '../core/table';
import type { ColumnDef, Value } from '../core/types';
import type { DuckDb } from './db';
import {
  checkDecimalFits,
  decimalToSqlText,
  DuckDbError,
  DUCKDB_TYPE,
  ORD_COLUMN,
  quoteIdent,
  readExpr,
  readKindOf,
  toEngineError,
  uploadExpr,
  type ReadKind,
} from './sql';

/*
 * Engine `Table` ⇄ Arrow (spec §9.4, §13.1).
 *
 * Upload: one raw Arrow column per engine column plus `__ord`, in the form that DuckDB casts
 * exactly to the canonical type: text for `string`, `date`, `datetime` and `decimal` (the decimal
 * rounded half-up to 10 places, never a double), 64-bit integers for `integer`, booleans as bits.
 * Arrow data is assembled from typed arrays with `makeData`: apache-arrow's builders compile code
 * with `new Function`, which the CSP (no `'unsafe-eval'`) blocks.
 *
 * Read: the columns selected by `readExpr` (sql.ts) are text, booleans or doubles; text becomes
 * the engine value, doubles go through `decimalFromNumber` (spec §9.4).
 */

const encoder = new TextEncoder();

interface Validity {
  readonly nullCount: number;
  readonly nullBitmap?: Uint8Array;
}

function validityOf(vec: Vector, from: number, n: number): Validity {
  let nulls = 0;
  const bitmap = new Uint8Array((n + 7) >> 3);
  for (let i = 0; i < n; i++) {
    if (vec.isNull(from + i)) nulls += 1;
    else bitmap[i >> 3]! |= 1 << (i & 7);
  }
  return nulls === 0 ? { nullCount: 0 } : { nullCount: nulls, nullBitmap: bitmap };
}

function utf8Data(texts: readonly (string | null)[], valid: Validity): Data<Utf8> {
  const encoded = texts.map((t) => (t === null ? null : encoder.encode(t)));
  const offsets = new Int32Array(texts.length + 1);
  let size = 0;
  encoded.forEach((bytes, i) => {
    size += bytes?.length ?? 0;
    offsets[i + 1] = size;
  });
  const data = new Uint8Array(size);
  encoded.forEach((bytes, i) => {
    if (bytes) data.set(bytes, offsets[i]!);
  });
  return makeData({
    type: new Utf8(),
    length: texts.length,
    ...valid,
    valueOffsets: offsets,
    data,
  });
}

/** Raw Arrow data of rows `[from, from + n)` of one engine column. */
function rawColumn(vec: Vector, column: string, from: number, n: number, node?: string): Data {
  const valid = validityOf(vec, from, n);
  switch (vec.type) {
    case 'string':
    case 'date':
    case 'datetime': {
      const texts: (string | null)[] = [];
      for (let i = 0; i < n; i++) texts.push(vec.get(from + i) as string | null);
      return utf8Data(texts, valid);
    }
    case 'decimal': {
      const texts: (string | null)[] = [];
      for (let i = 0; i < n; i++) {
        const v = vec.get(from + i);
        texts.push(isDecimal(v) ? decimalToSqlText(v, column, node) : null);
      }
      return utf8Data(texts, valid);
    }
    case 'integer': {
      const values = new BigInt64Array(n);
      for (let i = 0; i < n; i++) {
        const v = vec.get(from + i);
        if (typeof v === 'number') values[i] = BigInt(v);
      }
      return makeData({ type: new Int64(), length: n, ...valid, data: values });
    }
    case 'boolean': {
      const bits = new Uint8Array((n + 7) >> 3);
      for (let i = 0; i < n; i++) if (vec.get(from + i) === true) bits[i >> 3]! |= 1 << (i & 7);
      return makeData({ type: new Bool(), length: n, ...valid, data: bits });
    }
  }
}

/** Dense 1-based row numbers `from + 1 … from + n` (`__ord`). */
function ordColumn(from: number, n: number): Data<Int64> {
  const values = new BigInt64Array(n);
  for (let i = 0; i < n; i++) values[i] = BigInt(from + i + 1);
  return makeData({ type: new Int64(), length: n, nullCount: 0, data: values });
}

/**
 * Rows `[from, from + n)` of `table` as one Arrow IPC stream: the engine columns by key, then
 * `__ord`. Built as an explicit schema + record batch (no object keyed by column name).
 */
export function tableChunkToIpc(table: Table, from: number, n: number, node?: string): Uint8Array {
  const children: Data[] = table.columns.map((c) =>
    rawColumn(table.column(c.key), c.key, from, n, node),
  );
  children.push(ordColumn(from, n));
  const fields = [...table.columns.map((c) => c.key), ORD_COLUMN].map(
    (name, i) => new Field(name, children[i]!.type as ArrowType, true),
  );
  const schema = new ArrowSchema(fields);
  const batch = new RecordBatch(
    schema,
    makeData({ type: new Struct(fields), length: n, nullCount: 0, children }),
  );
  return tableToIPC(new ArrowTable(schema, [batch]), 'stream');
}

/** A result column to read: its key and title in the engine, and how DuckDB returns it. */
export interface ReadColumn {
  readonly key: string;
  readonly title: string;
  readonly kind: ReadKind;
}

const isText = (v: unknown): v is string => typeof v === 'string';

/** `sql.error.notFinite` / overflow checks for a `DOUBLE` result, then 15 significant digits. */
function decimalOfDouble(v: number, column: string, node?: string): Value {
  if (!Number.isFinite(v)) {
    throw new EngineError(
      'sql.error.notFinite',
      node === undefined ? { column } : { node, column },
    );
  }
  return checkDecimalFits(decimalFromNumber(v), column, node);
}

/** One result column as an engine vector; integer results beyond the safe range become decimal. */
function readColumn(
  vec: ArrowVector,
  rows: number,
  col: ReadColumn,
  node?: string,
): { type: DataType; vector: Vector } {
  const cells: unknown[] = [];
  for (let i = 0; i < rows; i++) cells.push(vec.get(i));
  let type: DataType;
  let values: Value[];
  switch (col.kind) {
    case 'string':
    case 'date':
    case 'datetime':
      type = col.kind;
      values = cells.map((v) => (isText(v) ? v : null));
      break;
    case 'boolean':
      type = 'boolean';
      values = cells.map((v) => (typeof v === 'boolean' ? v : null));
      break;
    case 'double':
      type = 'decimal';
      values = cells.map((v) => (typeof v === 'number' ? decimalOfDouble(v, col.key, node) : null));
      break;
    case 'decimal':
      type = 'decimal';
      values = cells.map((v) =>
        isText(v) ? checkDecimalFits(parseDecimal(v), col.key, node) : null,
      );
      break;
    case 'integer': {
      const numbers = cells.map((v) => (isText(v) ? Number(v) : null));
      const safe = numbers.every((x) => x === null || Number.isSafeInteger(x));
      type = safe ? 'integer' : 'decimal';
      values = safe ? numbers : cells.map((v) => (isText(v) ? parseDecimal(v) : null));
      break;
    }
  }
  const builder = new ColumnBuilder(type);
  for (const v of values) builder.append(v);
  return { type, vector: builder.finish() };
}

/** Arrow result of `SELECT <readExpr …>` → engine table (spec §9.4). */
export function arrowToTable(
  result: ArrowTable,
  columns: readonly ReadColumn[],
  node?: string,
): Table {
  const rows = result.numRows;
  const defs: ColumnDef[] = [];
  const vectors: Vector[] = [];
  columns.forEach((col, i) => {
    const vec = result.getChildAt(i);
    if (vec === null) throw new Error('arrowToTable: missing result column');
    const { type, vector } = readColumn(vec, rows, col, node);
    defs.push({ key: col.key, title: col.title, type });
    vectors.push(vector);
  });
  return new Table(defs, vectors, rows);
}

/** Rows per Arrow batch on upload (one DuckDB row group). */
export const UPLOAD_CHUNK_ROWS = 122_880;

/**
 * Engine table → DuckDB table `name` with the canonical column types (spec §9.4) and a dense
 * 1-based `__ord` (spec §12.1). Each chunk lands in a raw table and is cast into the typed one, so
 * a value DuckDB cannot cast fails the upload instead of being stored differently.
 */
export function uploadTable(db: DuckDb, table: Table, name: string, node?: string): void {
  if (table.columns.some((c) => c.key === ORD_COLUMN)) {
    throw new TypeError(`uploadTable: a column may not be named ${ORD_COLUMN}`);
  }
  const target = quoteIdent(name);
  const raw = quoteIdent(`${name}__raw`);
  const defs = table.columns.map((c) => `${quoteIdent(c.key)} ${DUCKDB_TYPE[c.type]}`);
  const casts = table.columns.map((c) => `${uploadExpr(c.key, c.type)} AS ${quoteIdent(c.key)}`);
  const ord = quoteIdent(ORD_COLUMN);
  try {
    db.exec(`CREATE TABLE ${target} (${[...defs, `${ord} BIGINT`].join(', ')})`);
    for (let from = 0; from < table.rowCount; from += UPLOAD_CHUNK_ROWS) {
      const n = Math.min(UPLOAD_CHUNK_ROWS, table.rowCount - from);
      db.insertArrowIpc(tableChunkToIpc(table, from, n, node), `${name}__raw`, true);
      try {
        db.exec(`INSERT INTO ${target} SELECT ${[...casts, ord].join(', ')} FROM ${raw}`);
      } finally {
        db.exec(`DROP TABLE IF EXISTS ${raw}`);
      }
    }
  } catch (err) {
    throw toEngineError(err, node);
  }
}

export interface ReadOptions {
  /** Titles by column key (the inferred schema); a column without one takes its key as title. */
  readonly columns?: readonly ColumnDef[];
  /** Node label for error messages. */
  readonly node?: string;
}

/**
 * DuckDB table or view `name` → engine table (spec §9.4), in `__ord` order when the relation has
 * `__ord` (which is not returned). A column whose type the engine cannot hold →
 * `sql.error.unsupportedType` naming the column and its DuckDB type.
 */
export function readTable(db: DuckDb, name: string, options: ReadOptions = {}): Table {
  const { node } = options;
  const relation = quoteIdent(name);
  let described;
  try {
    described = db.query(
      'SELECT column_name, data_type FROM duckdb_columns() WHERE table_name = ? ORDER BY column_index',
      [name],
    );
  } catch (err) {
    throw toEngineError(err, node);
  }
  // No column: the relation does not exist (a bug of the caller, reported without detail).
  if (described.numRows === 0) throw toEngineError(new DuckDbError('no such relation'), node);
  const titles = new Map(options.columns?.map((c) => [c.key, c.title]));
  let ordered = false;
  const columns: ReadColumn[] = [];
  for (let i = 0; i < described.numRows; i++) {
    const key = String(described.getChildAt(0)?.get(i));
    const duckType = String(described.getChildAt(1)?.get(i));
    if (key === ORD_COLUMN) {
      ordered = true;
      continue;
    }
    const kind = readKindOf(duckType);
    if (kind === null) {
      throw new EngineError(
        'sql.error.unsupportedType',
        node === undefined
          ? { column: key, type: duckType }
          : { node, column: key, type: duckType },
      );
    }
    columns.push({ key, title: titles.get(key) ?? key, kind });
  }
  if (columns.length === 0) {
    throw new TypeError('readTable: a relation needs at least one column besides __ord');
  }
  const select = columns.map((c) => `${readExpr(c.key, c.kind)} AS ${quoteIdent(c.key)}`);
  const order = ordered ? ` ORDER BY ${quoteIdent(ORD_COLUMN)}` : '';
  let result;
  try {
    result = db.query(`SELECT ${select.join(', ')} FROM ${relation}${order}`);
  } catch (err) {
    throw toEngineError(err, node);
  }
  return arrowToTable(result, columns, node);
}
