import type { FlowDefinition } from '@hrflow/flow-schema';
import type { RunContext, Translate } from '../nodes/index';
import { EngineError, isEngineError } from './errors';
import { perfMeasure, perfStart } from './perf';
import type { PlannedNode } from './planner';
import type { Table } from './table';

/**
 * Executor (spec §13 step 4–5): runs the planned nodes in order, reports progress per node (rows
 * out per port, never data), releases a table as soon as no later node reads it, and stops on the
 * first error. Tables that no node reads are the results of the run.
 */

export type RunProgressEvent =
  | {
      readonly type: 'node-started';
      readonly nodeId: string;
      readonly index: number;
      readonly total: number;
    }
  | {
      readonly type: 'node-finished';
      readonly nodeId: string;
      readonly index: number;
      readonly total: number;
      /** Row count per output port. */
      readonly rows: Readonly<Record<string, number>>;
      readonly durationMs: number;
    };

export interface ExecuteOptions {
  readonly onProgress?: (event: RunProgressEvent) => void;
  /** Slots, parameters and file sink of the run, passed to every node (03 §4.9). */
  readonly run?: RunContext;
  /** Translator of output titles, passed to every node (03 §4.9). */
  readonly t?: Translate;
}

export interface ExecuteResult {
  /** Output tables no node reads, per node id and port. */
  readonly outputs: Readonly<Record<string, Readonly<Record<string, Table>>>>;
}

const slot = (nodeId: string, port: string): string => `${nodeId}\u0000${port}`;

export async function executePlan(
  flow: FlowDefinition,
  plan: readonly PlannedNode[],
  options: ExecuteOptions = {},
): Promise<ExecuteResult> {
  const runStart = perfStart();
  // Readers left per output port, and per table object (a plugin may pass a table through).
  const readers = new Map<string, number>();
  for (const step of plan) {
    for (const link of step.inputs) {
      const key = slot(link.from, link.fromPort);
      readers.set(key, (readers.get(key) ?? 0) + 1);
    }
  }
  const live = new Map<string, Table>();
  const uses = new Map<Table, number>();
  const results = new Set<Table>();
  const outputs: Record<string, Record<string, Table>> = {};

  try {
    for (const [index, step] of plan.entries()) {
      const { node, plugin } = step;
      const total = plan.length;
      options.onProgress?.({ type: 'node-started', nodeId: node.id, index, total });
      const started = perfStart();

      const inputs: Record<string, Table> = {};
      for (const link of step.inputs) {
        const table = live.get(slot(link.from, link.fromPort));
        if (table === undefined) {
          throw new EngineError(
            'executor.error.missingInput',
            { node: node.label ?? node.id, port: link.port },
            { nodeId: node.id },
          );
        }
        inputs[link.port] = table;
      }

      let produced: Readonly<Record<string, Table>>;
      try {
        if (!plugin.execute) {
          // `compile` plugins run in the DuckDB runtime, which this executor does not drive yet.
          throw new EngineError('executor.error.nodeFailed', { node: node.label ?? node.id });
        }
        produced = await plugin.execute(step.config, inputs, {
          nodeId: node.id,
          flow,
          t: options.t,
          run: options.run,
        });
      } catch (err) {
        // A non-engine error may carry data in its message: only the node is reported.
        throw isEngineError(err)
          ? err.atNode(node.id)
          : new EngineError(
              'executor.error.nodeFailed',
              { node: node.label ?? node.id },
              { nodeId: node.id },
            );
      }

      const rows: Record<string, number> = {};
      for (const port of step.outputPorts) {
        const table = produced[port.name];
        if (table === undefined) continue;
        rows[port.name] = table.rowCount;
        const key = slot(node.id, port.name);
        const count = readers.get(key) ?? 0;
        if (count === 0) {
          results.add(table);
          (outputs[node.id] ??= {})[port.name] = table;
        } else {
          live.set(key, table);
          uses.set(table, (uses.get(table) ?? 0) + count);
        }
      }

      for (const link of step.inputs) {
        const key = slot(link.from, link.fromPort);
        const table = live.get(key)!;
        const left = (readers.get(key) ?? 1) - 1;
        readers.set(key, left);
        if (left === 0) live.delete(key);
        const tableLeft = (uses.get(table) ?? 1) - 1;
        if (tableLeft > 0) {
          uses.set(table, tableLeft);
        } else {
          uses.delete(table);
          if (!results.has(table)) table.release();
        }
      }

      options.onProgress?.({
        type: 'node-finished',
        nodeId: node.id,
        index,
        total,
        rows,
        durationMs: performance.now() - started,
      });
    }
  } catch (err) {
    for (const table of uses.keys()) if (!results.has(table)) table.release();
    for (const table of results) table.release();
    throw err;
  } finally {
    perfMeasure('run', runStart);
  }
  return { outputs };
}
