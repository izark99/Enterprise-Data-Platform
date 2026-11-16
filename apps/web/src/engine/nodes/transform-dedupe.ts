import { DedupeConfigSchema, type DedupeConfig } from '@hrflow/flow-schema';
import { EngineError } from '../core/errors';
import type { ColumnDef, Schema } from '../core/types';
import type { NodePlugin, SqlDialect } from './index';

/**
 * `transform.dedupe` (spec §12.1.7): rows are duplicates when every key column is equal (`string`
 * keys after normalisation when `normalizeKeys`, default on); the `first` or `last` of each group
 * goes to `out`, the others to `removed`. A row whose key columns are all blank is never a
 * duplicate (always kept). Both ports have the input columns and keep the input order. DuckDB.
 */

function plan(config: DedupeConfig, input: Schema): ColumnDef[] {
  return config.keys.map((key, i) => {
    const col = input.find((c) => c.key === key);
    if (col === undefined) {
      throw new EngineError('dedupe.error.unknownColumn', { column: key }, { path: ['keys', i] });
    }
    return col;
  });
}

/** Partition expression of one key: blank text as `NULL` (equal to other blanks of the column). */
function keyExpr(d: SqlDialect, col: ColumnDef, normalize: boolean): string {
  const x = d.ident(col.key);
  if (col.type !== 'string') return x;
  if (normalize) return `NULLIF(${d.normKey(x)}, '')`;
  return `CASE WHEN ${d.isBlank(x, 'string')} THEN NULL ELSE ${x} END`;
}

export const transformDedupePlugin: NodePlugin<DedupeConfig> = {
  type: 'transform.dedupe',
  configSchema: DedupeConfigSchema,
  ports: {
    inputs: [{ name: 'in', required: true }],
    outputs: [
      { name: 'out', required: false },
      { name: 'removed', required: false },
    ],
  },

  inferSchema(config, inputs) {
    const input = inputs['in'] ?? [];
    plan(config, input);
    return { out: input, removed: input };
  },

  compile(config, inputs, { sql: d }) {
    const input = inputs['in']!;
    const keys = plan(config, input.columns);
    const parts = keys.map((k) => keyExpr(d, k, config.normalizeKeys));
    const rn = d.aux('rn');
    const allBlank = d.aux('all_blank');
    const cols = [...input.columns.map((c) => d.ident(c.key)), d.ord];
    const direction = config.keep === 'first' ? 'ASC' : 'DESC';
    const ranked =
      `SELECT ${cols.join(', ')}, ` +
      `row_number() OVER (PARTITION BY ${parts.join(', ')} ORDER BY ${d.ord} ${direction}) AS ${rn}, ` +
      `(${keys.map((k) => d.isBlank(d.ident(k.key), k.type)).join(' AND ')}) AS ${allBlank} ` +
      `FROM ${input.ref}`;
    const select = (where: string): string =>
      `SELECT ${cols.join(', ')} FROM (${ranked}) WHERE ${where}`;
    return {
      ports: {
        out: { sql: select(`${allBlank} OR ${rn} = 1`), params: [], columns: input.columns },
        removed: {
          sql: select(`NOT ${allBlank} AND ${rn} > 1`),
          params: [],
          columns: input.columns,
        },
      },
    };
  },
};
