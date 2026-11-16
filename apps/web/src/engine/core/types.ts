import type { DataType } from '@hrflow/flow-schema';
import type { Decimal } from './decimal';

/**
 * Cell values inside the engine (spec §9.4):
 * - `string` → string; `date` → `"YYYY-MM-DD"`; `datetime` → `"YYYY-MM-DDTHH:mm:ss"`
 * - `integer` → number (safe integer)
 * - `decimal` → `Decimal` (big.js), never a JS float
 * - `boolean` → boolean
 * - blank → `null`
 */
export type Value = string | number | boolean | Decimal | null;

/** One column of a table or of an inferred schema (spec §12.1: `key` is referenced, `title` shown). */
export interface ColumnDef {
  readonly key: string;
  readonly title: string;
  readonly type: DataType;
}

/** Columns of one port, in order. */
export type Schema = readonly ColumnDef[];

/** An input or output port of a node (spec §12.1: `in` / `out`, `input.excel` has `table`). */
export interface PortDef {
  readonly name: string;
  readonly required: boolean;
}
