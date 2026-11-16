import type { FlowDefinition } from '@hrflow/flow-schema';
import { isDecimal } from '../core/decimal';
import { executePlan, type ExecuteOptions, type ExecuteResult } from '../core/executor';
import { planFlow } from '../core/planner';
import { Table } from '../core/table';
import type { Schema, Value } from '../core/types';
import { SqlScope } from '../duckdb/scope';
import { NODE_PLUGINS, type NodePlugin, type ParamValue } from '../nodes/index';
import { nodeDuckDb } from './duckdb-node';

/**
 * Test helpers of the transform nodes (T-R1-07): fake source tables, a flow builder and a run over
 * the Node DuckDB. Fake data only.
 */

export interface SourceData {
  readonly columns: Schema;
  readonly rows: readonly (readonly Value[])[];
}

/** `test.source` emits the table named by its config (a fresh copy per run: runs release it). */
export function sourcePlugin(data: Readonly<Record<string, SourceData>>): NodePlugin {
  return {
    type: 'test.source',
    configSchema: {
      safeParse: (input) => ({ success: true, data: input }),
    },
    ports: { inputs: [], outputs: [{ name: 'out', required: false }] },
    inferSchema: (config) => ({ out: data[(config as { name: string }).name]!.columns }),
    execute: (config) => {
      const d = data[(config as { name: string }).name]!;
      return { out: Table.fromRows(d.columns, d.rows) };
    },
  };
}

export type NodeSpec = [id: string, type: string, config: unknown];
export type EdgeSpec = [from: string, to: string, toPort?: string, fromPort?: string];

export function buildFlow(
  nodes: readonly NodeSpec[],
  edges: readonly EdgeSpec[],
  params: FlowDefinition['params'] = [],
): FlowDefinition {
  return {
    schemaVersion: 1,
    params,
    inputSlots: [],
    nodes: nodes.map(([id, type, config]) => ({
      id,
      type,
      config: config as Record<string, unknown>,
    })),
    edges: edges.map(([from, to, toPort, fromPort]) => ({
      from,
      to,
      ...(toPort ? { toPort } : {}),
      ...(fromPort ? { fromPort } : {}),
    })),
  };
}

export async function scopeProvider(): Promise<SqlScope> {
  return new SqlScope(await nodeDuckDb());
}

export async function runFlow(
  flow: FlowDefinition,
  data: Readonly<Record<string, SourceData>>,
  params: Readonly<Record<string, ParamValue>> = {},
  options: Partial<ExecuteOptions> = {},
): Promise<ExecuteResult> {
  const registry = { ...NODE_PLUGINS, 'test.source': sourcePlugin(data) };
  return executePlan(flow, planFlow(flow, registry), {
    sql: scopeProvider,
    run: { slots: {}, params, emitFile: () => undefined },
    ...options,
  });
}

/** Cells as plain values: decimals as their exact text. */
export function plain(v: Value): string | number | boolean | null {
  return isDecimal(v) ? v.toString() : v;
}

export function rowsOf(table: Table): (string | number | boolean | null)[][] {
  return Array.from({ length: table.rowCount }, (_, i) =>
    table.columns.map((c) => plain(table.get(i, c.key))),
  );
}

export function schemaOf(table: Table): Schema {
  return table.columns.map((c) => ({ key: c.key, title: c.title, type: c.type }));
}
