import type { FlowDefinition } from '@hrflow/flow-schema';
import type { EngineError, ErrorVars } from '../core/errors';
import type { Table } from '../core/table';
import type { PortDef, Schema } from '../core/types';
import type { SlotReadResult } from '../io/validation';
import { controlComparePlugin } from './control-compare';
import { inputExcelPlugin } from './input-excel';
import { outputExcelPlugin } from './output-excel';

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
}

export interface ExecuteContext {
  readonly nodeId: string;
  readonly flow: FlowDefinition;
  readonly t?: Translate;
  /** Absent at design time; a node that needs it fails with `executor.error.noRunContext`. */
  readonly run?: RunContext;
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
   * DuckDB implementation (spec §13.1): one SQL query over the input ports, each given as the name
   * of a relation. Run by the DuckDB runtime (T-R1-06).
   */
  compile?(config: Config, inputs: Readonly<Record<string, string>>): string;
}

/** Plugins by node type. */
export type NodeRegistry = Readonly<Record<string, NodePlugin>>;

/** Node types available to flows. */
export const NODE_PLUGINS: NodeRegistry = {
  [inputExcelPlugin.type]: inputExcelPlugin,
  [controlComparePlugin.type]: controlComparePlugin,
  [outputExcelPlugin.type]: outputExcelPlugin,
};
