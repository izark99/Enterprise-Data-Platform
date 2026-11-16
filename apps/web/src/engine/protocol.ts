/**
 * Public surface of the engine for code outside `src/engine` (02 §3, CLAUDE.md rule 4): only this
 * file and `formula/public.ts` may be imported from outside the engine.
 *
 * T-R1-08 created it early (owner 1C, MEMORY 2026-11-16): today it holds the messages of the E2E
 * harness page (`src/e2e-engine/`, built only with `--mode e2e`) and, at the end, the few engine
 * parts its worker needs. T-R1-10 adds the real worker messages (upload, validate, run, rows page,
 * download, cancel, design check, preview) and replaces the harness re-exports with them.
 */

/** Harness: a cell sent to the worker: decimals travel as `{ dec: '<text>' }`. */
export type WireCell = string | number | boolean | null | { readonly dec: string };

export interface WireColumn {
  readonly key: string;
  readonly title: string;
  readonly type: string;
}

export interface WireTable {
  readonly columns: readonly WireColumn[];
  readonly rows: readonly (readonly WireCell[])[];
}

/** An error as the screen and the run log would see it. */
export type WireError =
  | {
      readonly engine: true;
      readonly message: string;
      readonly info: Readonly<Record<string, unknown>>;
      readonly log: Readonly<Record<string, unknown>>;
    }
  | { readonly engine: false; readonly name: string; readonly message: string };

export type HarnessReply =
  | { readonly id: number; readonly ok: true; readonly value: unknown }
  | { readonly id: number; readonly ok: false; readonly error: WireError };

export interface HarnessRequest {
  readonly id: number;
  readonly op: string;
  readonly args: readonly unknown[];
}

// Harness only (E2E build; T-R1-08). T-R1-10 removes this block: features never import it.
export { isDecimal, parseDecimal } from './core/decimal';
export { EngineError } from './core/errors';
export { executePlan } from './core/executor';
export { planFlow } from './core/planner';
export { Table } from './core/table';
export type { Schema, Value } from './core/types';
export type { DuckDb } from './duckdb/db';
export { loadDuckDb } from './duckdb/loader';
export { DUCKDB_DIALECT, SqlScope } from './duckdb/scope';
export { DuckDbInspector } from './duckdb/sql-guard';
export { codeSqlPlugin } from './nodes/code-sql';
export {
  NODE_PLUGINS,
  type CompileContext,
  type NodePlugin,
  type NodeWarning,
  type ParamValue,
  type PortSchemas,
  type SqlInput,
} from './nodes/index';
