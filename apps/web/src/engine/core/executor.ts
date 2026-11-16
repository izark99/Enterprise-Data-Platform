import type { FlowDefinition } from '@hrflow/flow-schema';
import {
  runsInSql,
  type NodeWarning,
  type PortSchemas,
  type PreviewResult,
  type RunContext,
  type SqlCountWarning,
  type SqlDialect,
  type SqlInput,
  type SqlInspector,
  type SqlQuery,
  type Translate,
} from '../nodes/index';
import { EngineError, isEngineError } from './errors';
import { perfMeasure, perfStart } from './perf';
import type { PlannedNode } from './planner';
import type { Table } from './table';
import type { Schema } from './types';

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
  /**
   * Opens the DuckDB runtime of this run (`loadSqlScope` of `engine/duckdb/scope.ts` in the
   * worker). Called at most once, and only when a node runs in DuckDB.
   */
  readonly sql?: () => Promise<SqlRuntime>;
}

/** A relation inside DuckDB: lazy (a chain of queries) or materialised (`rowCount` known). */
export interface SqlRelation {
  readonly columns: Schema;
  readonly rowCount: number | null;
}

/** The node a DuckDB query belongs to: id, and label (or id) for error messages. */
export interface SqlOwner {
  readonly id: string;
  readonly label: string;
}

/** What the executor needs from DuckDB (implemented by `engine/duckdb/scope.ts`). */
export interface SqlRuntime {
  readonly dialect: SqlDialect;
  /** DuckDB's parser and `DESCRIBE`, given to `compile` (`code.sql`). */
  readonly inspector: SqlInspector;
  upload(table: Table, node: string): SqlRelation;
  input(rel: SqlRelation): SqlInput;
  /** A lazy relation: `query` over `inputs`, owned by the node that compiled it. */
  derive(inputs: readonly SqlRelation[], query: SqlQuery, owner: SqlOwner): SqlRelation;
  count(inputs: readonly SqlRelation[], warning: SqlCountWarning, node: string): number;
  materialize(rel: SqlRelation, node: string): SqlRelation;
  read(rel: SqlRelation, node: string): Table;
  /** Keeps the tables a relation reads alive; `release` undoes it (dropped at zero). */
  retain(rel: SqlRelation): void;
  release(rel: SqlRelation): void;
  /** Drops every DuckDB object of the run. */
  dispose(): void;
}

/** A run-time warning of a node (keys and counts only, never data). */
export interface RunWarning extends NodeWarning {
  readonly nodeId: string;
}

export interface ExecuteResult {
  /** Output tables no node reads, per node id and port. */
  readonly outputs: Readonly<Record<string, Readonly<Record<string, Table>>>>;
  /** Run-time warnings, in node order. */
  readonly warnings: readonly RunWarning[];
  /** Tables kept by `output.preview` nodes, in node order (spec §12.1.10). */
  readonly previews: readonly PreviewResult[];
}

const slot = (nodeId: string, port: string): string => `${nodeId}\u0000${port}`;

/** Data on a port: a TS table, a DuckDB relation, or both once one was converted to the other. */
interface PortValue {
  table?: Table;
  rel?: SqlRelation;
  /** Node that produced it (a lazy chain that fails later is reported at this node). */
  readonly ownerId: string;
  readonly owner: string;
}

const schemaOf = (value: PortValue): Schema => value.table?.columns ?? value.rel!.columns;

function attach(err: unknown, nodeId: string, label: string): EngineError {
  // A non-engine error may carry data in its message: only the node is reported.
  return isEngineError(err)
    ? err.atNode(nodeId)
    : new EngineError('executor.error.nodeFailed', { node: label }, { nodeId });
}

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
  const live = new Map<string, PortValue>();
  const uses = new Map<Table, number>();
  const results = new Set<Table>();
  const outputs: Record<string, Record<string, Table>> = {};
  const warnings: RunWarning[] = [];
  const previews: PreviewResult[] = [];
  /** DuckDB copy of each TS table read by a DuckDB node (uploaded once). */
  const uploads = new Map<Table, SqlRelation>();

  let runtime = null as SqlRuntime | null;
  const openRuntime = async (): Promise<SqlRuntime> => {
    if (runtime) return runtime;
    if (!options.sql) throw new EngineError('duckdb.error.unavailable');
    runtime = await options.sql();
    return runtime;
  };

  const releaseTable = (table: Table): void => {
    uses.delete(table);
    if (results.has(table)) return;
    table.release();
    const up = uploads.get(table);
    if (up && runtime) {
      uploads.delete(table);
      runtime.release(up);
    }
  };

  /** The value as a TS table (a DuckDB relation is materialised and read once per port). */
  const asTable = (key: string, value: PortValue): Table => {
    if (value.table) return value.table;
    const started = perfStart();
    let table: Table;
    try {
      table = runtime!.read(value.rel!, value.owner);
    } catch (err) {
      throw attach(err, value.ownerId, value.owner);
    }
    perfMeasure('sql', started);
    value.table = table;
    uses.set(table, (uses.get(table) ?? 0) + (readers.get(key) ?? 1));
    return table;
  };

  /** The value as a DuckDB relation (a TS table is uploaded once). */
  const asRel = (sql: SqlRuntime, value: PortValue, node: string): SqlRelation => {
    if (value.rel) return value.rel;
    const table = value.table!;
    let rel = uploads.get(table);
    if (!rel) {
      const started = perfStart();
      rel = sql.upload(table, node);
      perfMeasure('upload', started);
      sql.retain(rel);
      uploads.set(table, rel);
    }
    return rel;
  };

  try {
    for (const [index, step] of plan.entries()) {
      const { node, plugin } = step;
      const label = node.label ?? node.id;
      const total = plan.length;
      options.onProgress?.({ type: 'node-started', nodeId: node.id, index, total });
      const started = perfStart();

      const values: Record<string, PortValue> = {};
      const schemas: Record<string, Schema> = {};
      for (const link of step.inputs) {
        const value = live.get(slot(link.from, link.fromPort));
        if (value === undefined) {
          throw new EngineError(
            'executor.error.missingInput',
            { node: label, port: link.port },
            { nodeId: node.id },
          );
        }
        values[link.port] = value;
        schemas[link.port] = schemaOf(value);
      }

      const produced: Record<string, PortValue> = {};
      const ctx = {
        nodeId: node.id,
        flow,
        t: options.t,
        run: options.run,
        warn: (w: NodeWarning) => warnings.push({ nodeId: node.id, ...w }),
        emitPreview: (p: PreviewResult) => previews.push(p),
      };
      let inSql: boolean;
      try {
        inSql = runsInSql(plugin, step.config, schemas as PortSchemas);
      } catch (err) {
        throw attach(err, node.id, label);
      }
      if (inSql) {
        try {
          const sql = await openRuntime();
          const rels: Record<string, SqlRelation> = {};
          const inputs: Record<string, SqlInput> = {};
          for (const [port, value] of Object.entries(values)) {
            rels[port] = asRel(sql, value, label);
            inputs[port] = sql.input(rels[port]);
          }
          const relList = Object.values(rels);
          const compiled = plugin.compile!(step.config, inputs, {
            ...ctx,
            sql: sql.dialect,
            inspect: sql.inspector,
          });
          const sqlStart = perfStart();
          for (const w of compiled.warnings ?? []) {
            const count = sql.count(relList, w, label);
            if (count > 0) ctx.warn({ messageKey: w.messageKey, params: { count } });
          }
          for (const port of step.outputPorts) {
            const query = compiled.ports[port.name];
            if (query === undefined) continue;
            const count = readers.get(slot(node.id, port.name)) ?? 0;
            let rel = sql.derive(relList, query, { id: node.id, label });
            if (query.finish !== undefined || count === 0) {
              const read = sql.read(rel, label);
              const table = query.finish ? query.finish(read) : read;
              if (table !== read) read.release();
              produced[port.name] = { table, ownerId: node.id, owner: label };
            } else {
              if (count > 1) rel = sql.materialize(rel, label);
              sql.retain(rel);
              produced[port.name] = { rel, ownerId: node.id, owner: label };
            }
          }
          perfMeasure('sql', sqlStart);
        } catch (err) {
          throw attach(err, node.id, label);
        }
      } else {
        const inputs: Record<string, Table> = {};
        for (const link of step.inputs) {
          inputs[link.port] = asTable(slot(link.from, link.fromPort), values[link.port]!);
        }
        let tables: Readonly<Record<string, Table>>;
        try {
          if (!plugin.execute) throw new EngineError('executor.error.nodeFailed', { node: label });
          tables = await plugin.execute(step.config, inputs, ctx);
        } catch (err) {
          throw attach(err, node.id, label);
        }
        for (const [port, table] of Object.entries(tables)) {
          produced[port] = { table, ownerId: node.id, owner: label };
        }
      }

      const rows: Record<string, number> = {};
      for (const port of step.outputPorts) {
        const value = produced[port.name];
        if (value === undefined) continue;
        const key = slot(node.id, port.name);
        const count = readers.get(key) ?? 0;
        const rowCount = value.table?.rowCount ?? value.rel?.rowCount ?? null;
        if (rowCount !== null) rows[port.name] = rowCount;
        if (count === 0) {
          // Only TS tables reach here: a DuckDB port without readers was read above.
          const table = value.table!;
          results.add(table);
          (outputs[node.id] ??= {})[port.name] = table;
        } else {
          live.set(key, value);
          if (value.table) uses.set(value.table, (uses.get(value.table) ?? 0) + count);
        }
      }

      for (const link of step.inputs) {
        const key = slot(link.from, link.fromPort);
        const value = live.get(key)!;
        const left = (readers.get(key) ?? 1) - 1;
        readers.set(key, left);
        if (left === 0) {
          live.delete(key);
          if (value.rel && runtime) runtime.release(value.rel);
        }
        const table = value.table;
        if (table === undefined) continue;
        const tableLeft = (uses.get(table) ?? 1) - 1;
        if (tableLeft > 0) uses.set(table, tableLeft);
        else releaseTable(table);
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
    for (const preview of previews) preview.table.release();
    throw err;
  } finally {
    runtime?.dispose();
    perfMeasure('run', runStart);
  }
  return { outputs, warnings, previews };
}
