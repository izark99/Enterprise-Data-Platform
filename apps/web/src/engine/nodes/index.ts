import type { DataType, FlowDefinition } from '@hrflow/flow-schema';
import type { EngineError, ErrorVars } from '../core/errors';
import type { Table } from '../core/table';
import type { PortDef, Schema } from '../core/types';
import type { SlotReadResult } from '../io/validation';
import { codeSqlPlugin } from './code-sql';
import { controlComparePlugin } from './control-compare';
import { inputExcelPlugin } from './input-excel';
import { outputExcelPlugin } from './output-excel';
import { outputPreviewPlugin } from './output-preview';
import { transformDedupePlugin } from './transform-dedupe';
import { transformFilterPlugin } from './transform-filter';
import { transformFormulaPlugin } from './transform-formula';
import { transformGroupByPlugin } from './transform-group-by';
import { transformJoinPlugin } from './transform-join';
import { transformSelectPlugin } from './transform-select';
import { transformSortPlugin } from './transform-sort';
import { transformUnionPlugin } from './transform-union';

/**
 * Node plugin contract (spec §12, ADR-006) and the registry of node types. One node type = one
 * plugin file in this folder, registered in `NODE_PLUGINS`; its config schema lives in
 * `@hrflow/flow-schema`. The core planner and executor are never edited for a new node.
 */

/** The part of a Zod schema the engine uses (the flow-schema `*ConfigSchema` objects fit). */
export interface ConfigSchema<Config> {
  safeParse(
    input: unknown,
  ):
    | { success: true; data: Config }
    | { success: false; error: { issues: readonly { path: readonly PropertyKey[] }[] } };
}

/** Tables or schemas keyed by port name. */
export type PortTables = Readonly<Record<string, Table>>;
export type PortSchemas = Readonly<Record<string, Schema>>;

/**
 * Translator of output titles (compare columns, summary rows; MEMORY 2026-11-16 12:41, 2A), built
 * by the caller from the owner-edited locale. The engine holds no UI text: without a translator
 * the key itself is used.
 */
export type Translate = (key: string, vars?: ErrorVars) => string;

/** Run parameter value; `month` and `date` parameters arrive as `YYYY-MM` / `YYYY-MM-DD`. */
export type ParamValue = string | number | boolean | null;

/** A file produced by a run (e.g. the workbook of `output.excel`); it stays in the browser. */
export interface RunFile {
  readonly fileName: string;
  readonly mimeType: string;
  readonly bytes: Uint8Array;
}

/**
 * Data of one run (MEMORY 2026-11-16 12:41, 1A): the slots read and validated before the run, by
 * slot key (reused, never read twice), the run parameters, and the sink of produced files. The run
 * owns the slot tables: the executor releases each one after its last reader.
 */
export interface RunContext {
  readonly slots: Readonly<Record<string, SlotReadResult>>;
  readonly params: Readonly<Record<string, ParamValue>>;
  readonly emitFile: (file: RunFile) => void;
}

/** A design-time warning: an i18n key `<node>.warning.<code>` with params (spec §12.1). */
export interface NodeWarning {
  readonly messageKey: string;
  readonly params: ErrorVars;
}

export interface DesignContext {
  readonly flow: FlowDefinition;
  readonly t?: Translate;
  /**
   * DuckDB parser and `DESCRIBE` for nodes whose schema needs them (`code.sql`, spec §13.2), given
   * by the Designer worker once DuckDB is loaded. Absent → such a node reports
   * `duckdb.error.unavailable` ("Đang xác định cột…").
   */
  readonly sql?: SqlInspector;
  /** Design-time warning of the node being inferred (e.g. `sql.warning.doubleColumn`). */
  readonly warn?: (warning: NodeWarning) => void;
}

/** What `output.preview` keeps for the Result screen (spec §12.1.10); it never leaves the worker. */
export interface PreviewResult {
  readonly nodeId: string;
  readonly title: string;
  /** At most `maxRows` rows, only the configured columns. */
  readonly table: Table;
  /** Rows of the input before the cut. */
  readonly totalRows: number;
  readonly truncated: boolean;
}

export interface ExecuteContext {
  readonly nodeId: string;
  readonly flow: FlowDefinition;
  readonly t?: Translate;
  /** Absent at design time; a node that needs it fails with `executor.error.noRunContext`. */
  readonly run?: RunContext;
  /** Run-time warning of this node (e.g. `join.warning.rowsMultiplied`, counts only). */
  readonly warn?: (warning: NodeWarning) => void;
  /** Sink of `output.preview` results, given by the executor. */
  readonly emitPreview?: (preview: PreviewResult) => void;
}

/** Value bound to a prepared statement: `VARCHAR` text or `NULL` (spec §9.2). */
export type SqlValue = string | null;

/**
 * SQL building blocks given to `compile` by the DuckDB runtime (`engine/duckdb/scope.ts`), so node
 * files never import DuckDB code (owner 1A, MEMORY 2026-11-16 13:11). Every name passes through
 * `ident` (`IdentifierSchema` + double quotes); every value is a `?` placeholder bound as `VARCHAR`.
 */
export interface SqlDialect {
  /** A column key, quoted; anything that is not an `IdentifierSchema` name throws. */
  ident(key: string): string;
  /** The hidden row-order column (`hr$ord`, 03 §4.9). */
  readonly ord: string;
  /** A helper column or alias local to one query (`"hr$<name>"`), never a user column. */
  aux(name: string): string;
  /** `hrflow_norm_key(expr)`, the SQL twin of `normalizeKeyPart`, for `VARCHAR` expressions. */
  normKey(expr: string): string;
  /** `CAST(expr AS <canonical type>)` (spec §9.4). */
  cast(expr: string, type: DataType): string;
  /** Blank test (spec §12.1): `NULL`, and for `string` also a text that is empty after trimming. */
  isBlank(expr: string, type: DataType): string;
  /** A `?` placeholder of type `VARCHAR`. */
  readonly param: string;
}

/** What `SqlInspector.check` found in an Admin SQL statement (spec §9.2). */
export interface SqlChecked {
  /** The statement with every `$key` replaced by a `VARCHAR` placeholder (values are bound). */
  readonly sql: string;
  /** Parameter key of each placeholder, in text order. */
  readonly paramKeys: readonly string[];
  /** Whether the outermost query has an `ORDER BY` (else `sql.warning.noOrderBy`). */
  readonly ordered: boolean;
}

/** A result column of an Admin SQL statement, as DuckDB `DESCRIBE` reports it. */
export interface SqlDescribed {
  readonly name: string;
  /** DuckDB type name, e.g. `DOUBLE`, `DECIMAL(18,3)`. */
  readonly duckType: string;
  /** Engine type (spec §9.4), `null` when the engine has none (`sql.error.unsupportedType`). */
  readonly type: DataType | null;
  /** `DOUBLE` / `FLOAT`: read with 15 significant digits (`sql.warning.doubleColumn`). */
  readonly double: boolean;
}

/** A view of an Admin SQL statement: an input port and its columns (no hidden order column). */
export interface SqlView {
  readonly name: string;
  readonly columns: Schema;
}

/**
 * DuckDB's parser and `DESCRIBE` for `code.sql` (spec §9.2, §12.1.8), implemented in
 * `engine/duckdb/sql-guard.ts`; nodes never import DuckDB code. Every method throws an
 * `EngineError` (`sql.error.*`) without a node: the caller attaches it.
 */
export interface SqlInspector {
  /** One `SELECT` / `WITH … SELECT` reading only `views` and its own CTEs, with known params. */
  check(sql: string, views: readonly string[], params: readonly string[]): SqlChecked;
  /** Result columns of a checked statement over empty views of these columns. */
  describe(checked: SqlChecked, views: readonly SqlView[]): readonly SqlDescribed[];
  /** SQL turning `expr` (a column of type `column.duckType`) into its canonical engine type. */
  canonical(expr: string, column: SqlDescribed, key: string): string;
}

/** An input port of a compiled node: the relation to read (already quoted) and its columns. */
export interface SqlInput {
  readonly ref: string;
  readonly columns: Schema;
}

/**
 * One output port of a compiled node: a `SELECT` over the input relations returning exactly
 * `columns` (canonical types, spec §9.4) plus the hidden order column. `params` fill its `?` in
 * text order. `finish` is a TypeScript step on the materialised result (e.g. the exact `avg` of
 * `transform.groupBy`); a port with `finish` is materialised at its node.
 */
export interface SqlQuery {
  readonly sql: string;
  readonly params: readonly SqlValue[];
  readonly columns: Schema;
  readonly finish?: (table: Table) => Table;
  /**
   * Error key of a DuckDB failure in this query (default `duckdb.error.queryFailed`), e.g.
   * `sql.error.runtime` for Admin SQL; DuckDB's own text then becomes the screen-only `detail`.
   */
  readonly runtimeErrorKey?: string;
}

/** A count query run with the node; a count above zero becomes the warning `{ count }`. */
export interface SqlCountWarning {
  readonly sql: string;
  readonly params: readonly SqlValue[];
  readonly messageKey: string;
}

export interface SqlCompiled {
  readonly ports: Readonly<Record<string, SqlQuery>>;
  readonly warnings?: readonly SqlCountWarning[];
}

export interface CompileContext extends ExecuteContext {
  readonly sql: SqlDialect;
  /** DuckDB's parser and `DESCRIBE` (`code.sql`). */
  readonly inspect: SqlInspector;
}

export interface NodePlugin<Config = unknown> {
  /** Node type id, `<group>.<camelName>` (07 §1). */
  readonly type: string;
  readonly configSchema: ConfigSchema<Config>;
  /** Fixed ports. Single-input nodes use `in`, single-output nodes `out` (spec §12.1). */
  readonly ports: { readonly inputs: readonly PortDef[]; readonly outputs: readonly PortDef[] };
  /** Input ports that depend on the config (e.g. one per sheet of `output.excel`). */
  inputPorts?(config: Config): readonly PortDef[];
  /**
   * Plan-time checks against the rest of the flow (e.g. the referenced slot exists). Returns the
   * problems; the planner attaches the node id.
   */
  checkConfig?(config: Config, flow: FlowDefinition): readonly EngineError[];
  /** Design-time warnings shown on the node; they never block a run (spec §12.1.9). */
  warnings?(config: Config, flow: FlowDefinition): readonly NodeWarning[];
  /**
   * Output columns per port from the input columns, without data (spec §13.2). Throws an
   * `EngineError` with the config field path for an unknown column, a wrong type or a clash. May be
   * async (e.g. `code.sql` needs DuckDB `DESCRIBE`).
   */
  inferSchema(
    config: Config,
    inputs: PortSchemas,
    ctx: DesignContext,
  ): PortSchemas | Promise<PortSchemas>;
  /** TypeScript implementation: output tables per port. */
  execute?(
    config: Config,
    inputs: PortTables,
    ctx: ExecuteContext,
  ): PortTables | Promise<PortTables>;
  /**
   * DuckDB implementation (spec §13.1): one query per output port over the input relations. The
   * executor chains the queries of consecutive DuckDB nodes (pushdown) and materialises only when
   * needed. Throws an `EngineError` like `inferSchema` (it sees the same input columns).
   */
  compile?(
    config: Config,
    inputs: Readonly<Record<string, SqlInput>>,
    ctx: CompileContext,
  ): SqlCompiled;
  /**
   * For a plugin with both `execute` and `compile`: whether this config on these input columns
   * runs in DuckDB (e.g. `transform.sort` on a `string` column runs in TypeScript). Without it a
   * plugin runs in DuckDB exactly when it has `compile` and no `execute`.
   */
  runsInSql?(config: Config, inputs: PortSchemas): boolean;
}

/** Whether a planned node runs in DuckDB for these input columns (spec §13.1). */
export function runsInSql(plugin: NodePlugin, config: unknown, inputs: PortSchemas): boolean {
  if (plugin.compile === undefined) return false;
  if (plugin.execute === undefined) return true;
  return plugin.runsInSql?.(config, inputs) ?? false;
}

/** Plugins by node type. */
export type NodeRegistry = Readonly<Record<string, NodePlugin>>;

/** Node types available to flows. */
export const NODE_PLUGINS: NodeRegistry = {
  [inputExcelPlugin.type]: inputExcelPlugin,
  [controlComparePlugin.type]: controlComparePlugin,
  [outputExcelPlugin.type]: outputExcelPlugin,
  [outputPreviewPlugin.type]: outputPreviewPlugin,
  [transformSelectPlugin.type]: transformSelectPlugin,
  [transformFilterPlugin.type]: transformFilterPlugin,
  [transformSortPlugin.type]: transformSortPlugin,
  [transformJoinPlugin.type]: transformJoinPlugin,
  [transformUnionPlugin.type]: transformUnionPlugin,
  [transformGroupByPlugin.type]: transformGroupByPlugin,
  [transformDedupePlugin.type]: transformDedupePlugin,
  [codeSqlPlugin.type]: codeSqlPlugin,
  [transformFormulaPlugin.type]: transformFormulaPlugin,
};
