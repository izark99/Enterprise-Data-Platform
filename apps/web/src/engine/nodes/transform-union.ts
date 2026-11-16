import { UnionConfigSchema, type UnionConfig } from '@hrflow/flow-schema';
import { EngineError } from '../core/errors';
import type { ColumnDef, PortDef, Schema } from '../core/types';
import type { NodePlugin, PortSchemas, SqlValue } from './index';

/**
 * `transform.union` (spec §12.1.5): stacks `in_1` … `in_N` (`N = inputCount`), matching columns by
 * key. Columns follow `in_1`, then new columns in order of appearance in later ports; a column
 * missing from a port is blank (`'null'`) or `union.error.missingColumn` (`'error'`). Types must be
 * equal (`integer` with `decimal` → `decimal`). `sourceColumn` adds a `string` column with the
 * label of each row's port. Rows: all of `in_1`, then `in_2`, …, each in its own order. DuckDB.
 */

const unionPorts = (config: UnionConfig): PortDef[] =>
  Array.from({ length: config.inputCount }, (_, i) => ({ name: `in_${i + 1}`, required: true }));

function plan(config: UnionConfig, inputs: PortSchemas): Schema {
  const ports = unionPorts(config).map((p) => ({ port: p.name, columns: inputs[p.name] ?? [] }));
  const out: ColumnDef[] = [];
  for (const { columns } of ports) {
    for (const col of columns) {
      const i = out.findIndex((c) => c.key === col.key);
      if (i < 0) {
        out.push({ key: col.key, title: col.title, type: col.type });
        continue;
      }
      const seen = out[i]!;
      if (seen.type === col.type) continue;
      const numeric = (t: string): boolean => t === 'integer' || t === 'decimal';
      if (!numeric(seen.type) || !numeric(col.type)) {
        throw new EngineError('union.error.typeMismatch', { column: col.key });
      }
      out[i] = { ...seen, type: 'decimal' };
    }
  }
  if (config.missingColumns === 'error') {
    for (const { port, columns } of ports) {
      const missing = out.find((c) => !columns.some((x) => x.key === c.key));
      if (missing) {
        throw new EngineError(
          'union.error.missingColumn',
          { port, column: missing.key },
          { path: ['missingColumns'] },
        );
      }
    }
  }
  if (config.sourceColumn) {
    const key = config.sourceColumn.key;
    if (out.some((c) => c.key === key)) {
      throw new EngineError('union.error.duplicateKey', { key }, { path: ['sourceColumn', 'key'] });
    }
    out.push({ key, title: key, type: 'string' });
  }
  return out;
}

export const transformUnionPlugin: NodePlugin<UnionConfig> = {
  type: 'transform.union',
  configSchema: UnionConfigSchema,
  ports: { inputs: [], outputs: [{ name: 'out', required: false }] },
  inputPorts: unionPorts,

  inferSchema(config, inputs) {
    return { out: plan(config, inputs) };
  },

  compile(config, inputs, { sql: d }) {
    const schemas: Record<string, Schema> = {};
    for (const [port, input] of Object.entries(inputs)) schemas[port] = input.columns;
    const columns = plan(config, schemas);
    const source = config.sourceColumn;
    const data = source ? columns.slice(0, -1) : columns;
    const part = d.aux('part');
    const ord = d.aux('ord');
    const params: SqlValue[] = [];
    const parts = unionPorts(config).map((port, i) => {
      const input = inputs[port.name]!;
      const list = data.map((c) => {
        const has = input.columns.some((x) => x.key === c.key);
        return `${d.cast(has ? d.ident(c.key) : 'NULL', c.type)} AS ${d.ident(c.key)}`;
      });
      if (source) {
        params.push(source.labels[i] ?? null);
        list.push(`${d.param} AS ${d.ident(source.key)}`);
      }
      list.push(`${i + 1} AS ${part}`, `${d.ord} AS ${ord}`);
      return `SELECT ${list.join(', ')} FROM ${input.ref}`;
    });
    const outer = columns.map((c) => d.ident(c.key));
    outer.push(`row_number() OVER (ORDER BY ${part}, ${ord}) AS ${d.ord}`);
    return {
      ports: {
        out: {
          sql: `SELECT ${outer.join(', ')} FROM (${parts.join(' UNION ALL ')})`,
          params,
          columns,
        },
      },
    };
  },
};
