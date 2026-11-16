import { SortConfigSchema, type SortConfig } from '@hrflow/flow-schema';
import { isDecimal } from '../core/decimal';
import { EngineError } from '../core/errors';
import { normalizeKeyPart } from '../core/keys';
import { ColumnBuilder, Table } from '../core/table';
import type { ColumnDef, Schema, Value } from '../core/types';
import type { NodePlugin } from './index';

/**
 * `transform.sort` (spec §12.1.3, 03 §4.5): stable sort (equal rows keep their order) by the listed
 * columns, each `asc` / `desc` with blanks `first` / `last`. `string` columns follow the Vietnamese
 * alphabet without case (`Intl.Collator('vi')`, "Đ" after "D" and before "E"); DuckDB-WASM has no
 * such collation without the ICU extension, so a sort on any `string` column runs in TypeScript.
 * A sort on other columns only runs in DuckDB.
 */

interface Key {
  readonly column: ColumnDef;
  readonly desc: boolean;
  readonly blanksFirst: boolean;
}

function plan(config: SortConfig, input: Schema): Key[] {
  return config.by.map((by, i) => {
    const column = input.find((c) => c.key === by.column);
    if (column === undefined) {
      throw new EngineError(
        'sort.error.unknownColumn',
        { column: by.column },
        { path: ['by', i, 'column'] },
      );
    }
    return { column, desc: by.direction === 'desc', blanksFirst: by.blanks === 'first' };
  });
}

const collator = new Intl.Collator('vi', { sensitivity: 'accent' });

function isBlank(v: Value, column: ColumnDef): boolean {
  return v === null || (column.type === 'string' && normalizeKeyPart(v) === '');
}

/** Order of two non-blank values of one column. */
function compareValues(a: Value, b: Value, column: ColumnDef): number {
  if (column.type === 'string') return collator.compare(a as string, b as string);
  if (isDecimal(a) && isDecimal(b)) return a.cmp(b);
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b);
  const x = String(a);
  const y = String(b);
  // Dates and datetimes are ISO text: code-unit order is time order.
  return x < y ? -1 : x > y ? 1 : 0;
}

/** The TypeScript sort (any column type). */
function sortTable(table: Table, keys: readonly Key[]): Table {
  const n = table.rowCount;
  const cols = keys.map((k) => {
    const vec = table.column(k.column.key);
    const values: Value[] = new Array<Value>(n);
    for (let i = 0; i < n; i++) values[i] = vec.get(i);
    return values;
  });
  const order = Array.from({ length: n }, (_, i) => i);
  order.sort((a, b) => {
    for (let k = 0; k < keys.length; k++) {
      const key = keys[k]!;
      const va = cols[k]![a]!;
      const vb = cols[k]![b]!;
      const ba = isBlank(va, key.column);
      const bb = isBlank(vb, key.column);
      if (ba || bb) {
        if (ba && bb) continue;
        return ba === key.blanksFirst ? -1 : 1;
      }
      const c = compareValues(va, vb, key.column);
      if (c !== 0) return key.desc ? -c : c;
    }
    return a - b;
  });
  const vectors = table.columns.map((col) => {
    const vec = table.column(col.key);
    const builder = new ColumnBuilder(col.type);
    for (const row of order) builder.append(vec.get(row));
    return builder.finish();
  });
  return new Table(table.columns, vectors, n);
}

export const transformSortPlugin: NodePlugin<SortConfig> = {
  type: 'transform.sort',
  configSchema: SortConfigSchema,
  ports: { inputs: [{ name: 'in', required: true }], outputs: [{ name: 'out', required: false }] },

  inferSchema(config, inputs) {
    const input = inputs['in'] ?? [];
    plan(config, input);
    return { out: input };
  },

  runsInSql(config, inputs) {
    // An unknown column is reported by `compile`.
    const input = inputs['in'] ?? [];
    return !config.by.some((by) => input.find((c) => c.key === by.column)?.type === 'string');
  },

  execute(config, inputs) {
    const table = inputs['in']!;
    return { out: sortTable(table, plan(config, table.columns)) };
  },

  compile(config, inputs, { sql: d }) {
    const input = inputs['in']!;
    const keys = plan(config, input.columns).map(
      (k) =>
        `${d.ident(k.column.key)} ${k.desc ? 'DESC' : 'ASC'} NULLS ${k.blanksFirst ? 'FIRST' : 'LAST'}`,
    );
    keys.push(d.ord);
    const list = input.columns.map((c) => d.ident(c.key));
    list.push(`row_number() OVER (ORDER BY ${keys.join(', ')}) AS ${d.ord}`);
    return {
      ports: {
        out: {
          sql: `SELECT ${list.join(', ')} FROM ${input.ref}`,
          params: [],
          columns: input.columns,
        },
      },
    };
  },
};
