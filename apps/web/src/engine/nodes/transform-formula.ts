import { FormulaConfigSchema, type FlowDefinition, type FormulaConfig } from '@hrflow/flow-schema';
import { EngineError, type ErrorVars } from '../core/errors';
import { Table } from '../core/table';
import type { Schema } from '../core/types';
import {
  compileFormula,
  DESIGN_DIALECT,
  ERROR_CODES,
  type CompiledFormula,
  type CompileOptions,
} from '../formula/compile';
import type { NodePlugin, NodeWarning } from './index';

/**
 * `transform.formula` (spec §12.2): computed columns written as Excel formulas, evaluated top to
 * bottom (a column sees the input columns and the columns above it), transpiled to one DuckDB
 * query (`engine/formula/compile.ts`). Output: input columns in order (an overwritten column keeps
 * its place), then the new columns; row order kept.
 *
 * A row error (`#DIV/0!`, `#VALUE!`, `#NUM!`, `#N/A`) not caught by `IFERROR` leaves the cell blank
 * and gives `formula.warning.rowErrors` per column and error (count, first 5 row numbers, no cell
 * value), or with `onError: 'fail'` stops the run with `formula.error.rowError`. Only a node with
 * a formula that can fail reads its result back (to count the errors); otherwise it stays lazy.
 */

/** Row numbers listed in `formula.warning.rowErrors` (spec §12.2). */
const LISTED_ROWS = 5;

function compileOptions(flow: FlowDefinition): Pick<CompileOptions, 'params'> {
  return { params: flow.params.map((p) => ({ key: p.key, type: p.type })) };
}

function nodeLabel(flow: FlowDefinition, nodeId: string): string {
  return flow.nodes.find((n) => n.id === nodeId)?.label ?? nodeId;
}

/** Counts the row errors of the hidden columns, warns or fails, and drops those columns. */
function finishErrors(
  compiled: CompiledFormula,
  read: Table,
  node: string,
  warn: ((w: NodeWarning) => void) | undefined,
): Table {
  for (const col of compiled.columns) {
    if (col.errorKey === null) continue;
    const codes = read.column(col.errorKey);
    const counts = new Map<number, { count: number; rows: number[] }>();
    let total = 0;
    let first: { row: number; code: number } | null = null;
    for (let r = 0; r < read.rowCount; r++) {
      const code = codes.get(r);
      if (typeof code !== 'number') continue;
      total++;
      first ??= { row: r + 1, code };
      const entry = counts.get(code) ?? { count: 0, rows: [] };
      entry.count++;
      if (entry.rows.length < LISTED_ROWS) entry.rows.push(r + 1);
      counts.set(code, entry);
    }
    if (first === null) continue;
    if (col.onError === 'fail') {
      throw new EngineError('formula.error.rowError', {
        node,
        column: col.key,
        error: ERROR_CODES[first.code - 1] ?? ERROR_CODES[1],
        row: first.row,
        count: total,
      });
    }
    for (const [code, entry] of [...counts.entries()].sort((a, b) => a[0] - b[0])) {
      const params: ErrorVars = {
        node,
        column: col.key,
        error: ERROR_CODES[code - 1] ?? ERROR_CODES[1],
        count: entry.count,
        rows: entry.rows.join(', '),
      };
      warn?.({ messageKey: 'formula.warning.rowErrors', params });
    }
  }
  const columns: Schema = compiled.output;
  return new Table(
    columns,
    columns.map((c) => read.column(c.key)),
    read.rowCount,
  );
}

export const transformFormulaPlugin: NodePlugin<FormulaConfig> = {
  type: 'transform.formula',
  configSchema: FormulaConfigSchema,
  ports: { inputs: [{ name: 'in', required: true }], outputs: [{ name: 'out', required: false }] },

  inferSchema(config, inputs, ctx) {
    const compiled = compileFormula(config.columns, inputs['in'] ?? [], {
      ...compileOptions(ctx.flow),
      dialect: DESIGN_DIALECT,
      from: '"in"',
    });
    for (const col of compiled.columns) {
      if (col.mixedTypes) {
        ctx.warn?.({ messageKey: 'formula.warning.mixedTypes', params: { column: col.key } });
      }
    }
    return { out: compiled.output };
  },

  compile(config, inputs, ctx) {
    const input = inputs['in']!;
    const compiled = compileFormula(config.columns, input.columns, {
      ...compileOptions(ctx.flow),
      dialect: ctx.sql,
      from: input.ref,
      values: ctx.run?.params ?? {},
    });
    const query = { sql: compiled.sql, params: compiled.params };
    if (compiled.columns.every((c) => c.errorKey === null)) {
      return { ports: { out: { ...query, columns: compiled.output } } };
    }
    const node = nodeLabel(ctx.flow, ctx.nodeId);
    return {
      ports: {
        out: {
          ...query,
          columns: compiled.resultColumns,
          finish: (table) => finishErrors(compiled, table, node, ctx.warn),
        },
      },
    };
  },
};
