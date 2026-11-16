import type { DataType } from '@hrflow/flow-schema';
import { decodeDecimal, encodeDecimal, isDecimal } from './decimal';
import type { ColumnDef, Schema, Value } from './types';

/**
 * Columnar table (spec §13): one Arrow-style vector per column, so a million rows are a few dozen
 * typed arrays instead of millions of JS objects.
 *
 * - `string`, `date`, `datetime`: UTF-8 bytes + `Int32Array` offsets (dates as ISO text);
 * - `integer`: `Float64Array` (safe integers);
 * - `decimal`: `Float64Array` holding the double of a value whose `String(x)` is its exact text,
 *   plus a row → exact text map for the other values (spec §9.4); reads return a `Decimal`;
 * - `boolean`: one byte per row.
 *
 * Every vector has a validity bitmap (bit set = not blank; `null` = no blank). Vectors are
 * immutable once built. `release()` drops the buffers as soon as no later node needs the table.
 */

export interface Vector {
  readonly type: DataType;
  readonly length: number;
  isNull(row: number): boolean;
  get(row: number): Value;
  /** Bytes held by the buffers of this vector. */
  byteSize(): number;
  /** Copy of rows `[start, end)`; the copy does not share buffers with this vector. */
  slice(start: number, end: number): Vector;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function isValid(valid: Uint8Array | null, row: number): boolean {
  return valid === null || ((valid[row >> 3] ?? 0) & (1 << (row & 7))) !== 0;
}

function sliceBitmap(valid: Uint8Array | null, start: number, end: number): Uint8Array | null {
  if (valid === null) return null;
  const out = new Uint8Array((end - start + 7) >> 3);
  for (let i = start; i < end; i++) {
    if (isValid(valid, i)) out[(i - start) >> 3]! |= 1 << ((i - start) & 7);
  }
  return out;
}

const bitmapBytes = (valid: Uint8Array | null): number => valid?.byteLength ?? 0;

class Utf8Vector implements Vector {
  constructor(
    readonly type: DataType,
    readonly length: number,
    private readonly offsets: Int32Array,
    private readonly bytes: Uint8Array,
    private readonly valid: Uint8Array | null,
  ) {}

  isNull(row: number): boolean {
    return !isValid(this.valid, row);
  }

  get(row: number): string | null {
    if (!isValid(this.valid, row)) return null;
    return decoder.decode(this.bytes.subarray(this.offsets[row], this.offsets[row + 1]));
  }

  byteSize(): number {
    return this.offsets.byteLength + this.bytes.byteLength + bitmapBytes(this.valid);
  }

  slice(start: number, end: number): Vector {
    const from = this.offsets[start] ?? 0;
    const offsets = new Int32Array(end - start + 1);
    for (let i = start; i <= end; i++) offsets[i - start] = (this.offsets[i] ?? 0) - from;
    const bytes = this.bytes.slice(from, this.offsets[end] ?? from);
    return new Utf8Vector(
      this.type,
      end - start,
      offsets,
      bytes,
      sliceBitmap(this.valid, start, end),
    );
  }
}

class IntegerVector implements Vector {
  readonly type = 'integer';

  constructor(
    readonly length: number,
    private readonly values: Float64Array,
    private readonly valid: Uint8Array | null,
  ) {}

  isNull(row: number): boolean {
    return !isValid(this.valid, row);
  }

  get(row: number): number | null {
    return isValid(this.valid, row) ? (this.values[row] ?? null) : null;
  }

  byteSize(): number {
    return this.values.byteLength + bitmapBytes(this.valid);
  }

  slice(start: number, end: number): Vector {
    return new IntegerVector(
      end - start,
      this.values.slice(start, end),
      sliceBitmap(this.valid, start, end),
    );
  }
}

class DecimalVector implements Vector {
  readonly type = 'decimal';

  constructor(
    readonly length: number,
    private readonly values: Float64Array,
    /** Rows whose exact text has no double with the same shortest representation. */
    private readonly exact: ReadonlyMap<number, string>,
    private readonly valid: Uint8Array | null,
  ) {}

  isNull(row: number): boolean {
    return !isValid(this.valid, row);
  }

  get(row: number): Value {
    if (!isValid(this.valid, row)) return null;
    return decodeDecimal(this.exact.get(row) ?? this.values[row] ?? 0);
  }

  byteSize(): number {
    let text = 0;
    for (const s of this.exact.values()) text += s.length * 2 + 16;
    return this.values.byteLength + bitmapBytes(this.valid) + text;
  }

  slice(start: number, end: number): Vector {
    const exact = new Map<number, string>();
    for (const [row, text] of this.exact) {
      if (row >= start && row < end) exact.set(row - start, text);
    }
    return new DecimalVector(
      end - start,
      this.values.slice(start, end),
      exact,
      sliceBitmap(this.valid, start, end),
    );
  }
}

class BooleanVector implements Vector {
  readonly type = 'boolean';

  constructor(
    readonly length: number,
    private readonly values: Uint8Array,
    private readonly valid: Uint8Array | null,
  ) {}

  isNull(row: number): boolean {
    return !isValid(this.valid, row);
  }

  get(row: number): boolean | null {
    return isValid(this.valid, row) ? this.values[row] === 1 : null;
  }

  byteSize(): number {
    return this.values.byteLength + bitmapBytes(this.valid);
  }

  slice(start: number, end: number): Vector {
    return new BooleanVector(
      end - start,
      this.values.slice(start, end),
      sliceBitmap(this.valid, start, end),
    );
  }
}

const INITIAL_CAPACITY = 1024;

function grow<T extends Uint8Array | Int32Array | Float64Array>(buffer: T, needed: number): T {
  if (needed <= buffer.length) return buffer;
  let size = Math.max(buffer.length * 2, INITIAL_CAPACITY);
  while (size < needed) size *= 2;
  const next = new (buffer.constructor as new (n: number) => T)(size);
  next.set(buffer);
  return next;
}

/** Appends the values of one column; `finish()` trims the buffers to size. */
export class ColumnBuilder {
  private length = 0;
  private valid = new Uint8Array(0);
  private hasNull = false;
  private numbers = new Float64Array(0);
  private flags = new Uint8Array(0);
  private offsets = new Int32Array(1);
  private bytes = new Uint8Array(0);
  private readonly exact = new Map<number, string>();

  constructor(readonly type: DataType) {}

  /** Throws a `TypeError` when the JS type does not fit the column type (a bug, not a data error). */
  append(value: Value): void {
    const row = this.length;
    this.length += 1;
    this.valid = grow(this.valid, (this.length + 7) >> 3);
    if (this.type === 'string' || this.type === 'date' || this.type === 'datetime') {
      this.offsets = grow(this.offsets, this.length + 1);
    } else if (this.type === 'boolean') {
      this.flags = grow(this.flags, this.length);
    } else {
      this.numbers = grow(this.numbers, this.length);
    }
    if (value === null) {
      this.hasNull = true;
      if (this.type === 'string' || this.type === 'date' || this.type === 'datetime') {
        this.offsets[row + 1] = this.offsets[row]!;
      }
      return;
    }
    this.valid[row >> 3]! |= 1 << (row & 7);
    switch (this.type) {
      case 'string':
      case 'date':
      case 'datetime':
        if (typeof value !== 'string') throw new TypeError(`${this.type} column needs a string`);
        this.appendText(row, value);
        return;
      case 'integer':
        if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
          throw new TypeError('integer column needs a safe integer');
        }
        this.numbers[row] = value;
        return;
      case 'decimal': {
        if (!isDecimal(value)) throw new TypeError('decimal column needs a Decimal');
        const stored = encodeDecimal(value);
        if (typeof stored === 'number') this.numbers[row] = stored;
        else this.exact.set(row, stored);
        return;
      }
      case 'boolean':
        if (typeof value !== 'boolean') throw new TypeError('boolean column needs a boolean');
        this.flags[row] = value ? 1 : 0;
        return;
    }
  }

  private appendText(row: number, text: string): void {
    const start = this.offsets[row]!;
    // A UTF-16 code unit takes at most 3 UTF-8 bytes.
    this.bytes = grow(this.bytes, start + text.length * 3);
    let end = start;
    let ascii = true;
    for (let k = 0; k < text.length; k++) {
      const code = text.charCodeAt(k);
      if (code >= 0x80) {
        ascii = false;
        break;
      }
      this.bytes[end++] = code;
    }
    if (!ascii) end = start + encoder.encodeInto(text, this.bytes.subarray(start)).written;
    this.offsets[row + 1] = end;
  }

  finish(): Vector {
    const n = this.length;
    const valid = this.hasNull ? this.valid.slice(0, (n + 7) >> 3) : null;
    switch (this.type) {
      case 'string':
      case 'date':
      case 'datetime': {
        const offsets = this.offsets.slice(0, n + 1);
        return new Utf8Vector(this.type, n, offsets, this.bytes.slice(0, offsets[n]), valid);
      }
      case 'integer':
        return new IntegerVector(n, this.numbers.slice(0, n), valid);
      case 'decimal':
        return new DecimalVector(n, this.numbers.slice(0, n), new Map(this.exact), valid);
      case 'boolean':
        return new BooleanVector(n, this.flags.slice(0, n), valid);
    }
  }
}

export class Table {
  private vectors: readonly Vector[] | null;
  private readonly index: ReadonlyMap<string, number>;

  constructor(
    readonly columns: Schema,
    vectors: readonly Vector[],
    readonly rowCount: number,
  ) {
    if (vectors.length !== columns.length) throw new RangeError('Table: one vector per column');
    columns.forEach((col, i) => {
      const vector = vectors[i]!;
      if (vector.type !== col.type || vector.length !== rowCount) {
        throw new RangeError(`Table: vector of column "${col.key}" does not fit`);
      }
    });
    this.vectors = vectors;
    this.index = new Map(columns.map((col, i) => [col.key, i]));
    if (this.index.size !== columns.length) throw new RangeError('Table: duplicate column key');
  }

  /** Build a table from row arrays (values in column order); for small tables and tests. */
  static fromRows(columns: Schema, rows: readonly (readonly Value[])[]): Table {
    const builders = columns.map((col) => new ColumnBuilder(col.type));
    for (const row of rows) builders.forEach((b, j) => b.append(row[j] ?? null));
    return new Table(
      columns,
      builders.map((b) => b.finish()),
      rows.length,
    );
  }

  get released(): boolean {
    return this.vectors === null;
  }

  column(key: string): Vector {
    const i = this.index.get(key);
    if (i === undefined) throw new RangeError(`Table: no column "${key}"`);
    return this.live()[i]!;
  }

  columnDef(key: string): ColumnDef | undefined {
    const i = this.index.get(key);
    return i === undefined ? undefined : this.columns[i];
  }

  get(row: number, key: string): Value {
    return this.column(key).get(row);
  }

  /** Copy of rows `[start, end)` (clamped, like `Array.prototype.slice` with non-negative bounds). */
  slice(start: number, end: number = this.rowCount): Table {
    const from = Math.min(Math.max(0, start), this.rowCount);
    const to = Math.min(Math.max(from, end), this.rowCount);
    return new Table(
      this.columns,
      this.live().map((v) => v.slice(from, to)),
      to - from,
    );
  }

  /** Bytes held by the column buffers. */
  byteSize(): number {
    return this.live().reduce((sum, v) => sum + v.byteSize(), 0);
  }

  /** Drop the buffers. Any later read throws; releasing twice is a no-op. */
  release(): void {
    this.vectors = null;
  }

  private live(): readonly Vector[] {
    if (this.vectors === null) throw new Error('Table: read after release');
    return this.vectors;
  }
}
