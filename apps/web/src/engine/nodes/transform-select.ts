import { SelectConfigSchema, type SelectConfig } from '@hrflow/flow-schema';
import { EngineError } from '../core/errors';
import type { ColumnDef, Schema } from '../core/types';
import type { NodePlugin } from './index';

/**
 * `transform.select` (spec §12.1.1): the listed columns, in the listed order; `key` defaults to
 * `from`, `title` to the source title, the type is kept. A source column may be picked several
 * times under different keys. A new key may not start with `_` (system columns such as
 * `_source_file` keep their own name only). Runs in DuckDB.
 */

interface Pick {
  readonly from: string;
  readonly def: ColumnDef;
}

function plan(config: SelectConfig, input: Schema): Pick[] {
  const seen = new Set<string>();
  return config.columns.map((col, i) => {
    const source = input.find((c) => c.key === col.from);
    if (source === undefined) {
      throw new EngineError(
        'select.error.unknownColumn',
        { column: col.from },
        { path: ['columns', i, 'from'] },
      );
    }
    const key = col.key ?? col.from;
    if (key.startsWith('_') && key !== col.from) {
      throw new EngineError('select.error.reservedKey', { key }, { path: ['columns', i, 'key'] });
    }
    if (seen.has(key)) {
      throw new EngineError('select.error.duplicateKey', { key }, { path: ['columns', i, 'key'] });
    }
    seen.add(key);
    return { from: col.from, def: { key, title: col.title ?? source.title, type: source.type } };
  });
}

export const transformSelectPlugin: NodePlugin<SelectConfig> = {
  type: 'transform.select',
  configSchema: SelectConfigSchema,
  ports: { inputs: [{ name: 'in', required: true }], outputs: [{ name: 'out', required: false }] },

  inferSchema(config, inputs) {
    return { out: plan(config, inputs['in'] ?? []).map((p) => p.def) };
  },

  compile(config, inputs, { sql: d }) {
    const input = inputs['in']!;
    const picks = plan(config, input.columns);
    const list = picks.map((p) => `${d.ident(p.from)} AS ${d.ident(p.def.key)}`);
    list.push(d.ord);
    return {
      ports: {
        out: {
          sql: `SELECT ${list.join(', ')} FROM ${input.ref}`,
          params: [],
          columns: picks.map((p) => p.def),
        },
      },
    };
  },
};
