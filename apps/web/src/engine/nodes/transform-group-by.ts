import {
  GroupByConfigSchema,
  type AggregationFn,
  type DataType,
  type GroupByConfig,
} from '@hrflow/flow-schema';
import { isDecimal, parseDecimal, roundDecimal } from '../core/decimal';
import { EngineError } from '../core/errors';
import { ColumnBuilder, Table, type Vector } from '../core/table';
import type { ColumnDef, Schema } from '../core/types';
import type { NodePlugin, SqlDialect } from './index';

/**
 * `transform.groupBy` (spec §12.1.6): one row per group of the `by` columns (exact values, blanks
 * form their own group; empty `by` = exactly one row, even for no input row), in order of the
 * group's first row, then the aggregations in config order. Blanks are ignored by every function
 * but `countRows`; `sum` of only blanks is 0, `avg` / `min` / `max` of only blanks are blank.
 * Types: `sum` keeps the column type (an integer sum beyond the safe range becomes decimal on
 * read), `avg` is `decimal`, `min` / `max` keep the type (text in binary order, not the Vietnamese
 * sort), counts are `integer`. Runs in DuckDB; `avg` = DuckDB `SUM` and `COUNT` divided with
 * big.js, rounded half-up to 10 places.
 */

const NUMERIC: ReadonlySet<DataType> = new Set(['integer', 'decimal']);
const ORDERED: ReadonlySet<DataType> = new Set([
  'integer',
  'decimal',
  'date',
  'datetime',
  'string',
]);

interface Aggregation {
  readonly def: ColumnDef;
  readonly fn: AggregationFn;
  readonly source?: ColumnDef;
}

interface GroupPlan {
  readonly by: readonly ColumnDef[];
  readonly aggs: readonly Aggregation[];
  readonly columns: Schema;
}

function plan(config: GroupByConfig, input: Schema): GroupPlan {
  const columns: ColumnDef[] = [];
  const by = config.by.map((key, i) => {
    const col = input.find((c) => c.key === key);
    if (col === undefined) {
      throw new EngineError('groupBy.error.unknownColumn', { column: key }, { path: ['by', i] });
    }
    if (columns.some((c) => c.key === key)) {
      throw new EngineError('groupBy.error.duplicateKey', { key }, { path: ['by', i] });
    }
    columns.push({ key: col.key, title: col.title, type: col.type });
    return col;
  });
  const aggs = config.aggregations.map((a, i): Aggregation => {
    if (columns.some((c) => c.key === a.key)) {
      throw new EngineError(
        'groupBy.error.duplicateKey',
        { key: a.key },
        { path: ['aggregations', i, 'key'] },
      );
    }
    let source: ColumnDef | undefined;
    if (a.fn !== 'countRows' && a.column !== undefined) {
      source = input.find((c) => c.key === a.column);
      if (source === undefined) {
        throw new EngineError(
          'groupBy.error.unknownColumn',
          { column: a.column },
          { path: ['aggregations', i, 'column'] },
        );
      }
    }
    let type: DataType = 'integer';
    if (source && (a.fn === 'sum' || a.fn === 'avg' || a.fn === 'min' || a.fn === 'max')) {
      const allowed = a.fn === 'sum' || a.fn === 'avg' ? NUMERIC : ORDERED;
      if (!allowed.has(source.type)) {
        throw new EngineError(
          'groupBy.error.fnNotForType',
          { fn: a.fn, column: source.key, type: source.type },
          { path: ['aggregations', i, 'fn'] },
        );
      }
      type = a.fn === 'avg' ? 'decimal' : source.type;
    }
    const def: ColumnDef = { key: a.key, title: a.title ?? a.key, type };
    columns.push(def);
    return { def, fn: a.fn, ...(source ? { source } : {}) };
  });
  return { by, aggs, columns };
}

/** A column value with blank text as `NULL` (ignored by aggregates, one group for blanks). */
function value(d: SqlDialect, col: ColumnDef): string {
  const x = d.ident(col.key);
  return col.type === 'string' ? `CASE WHEN ${d.isBlank(x, 'string')} THEN NULL ELSE ${x} END` : x;
}

/** Keys of the hidden SUM / COUNT columns of each `avg`, unused by any output column. */
function avgKeys(p: GroupPlan): Map<number, { sum: string; count: string }> {
  const taken = new Set(p.columns.map((c) => c.key));
  const fresh = (base: string): string => {
    let key = base;
    while (taken.has(key)) key = `_${key}`;
    taken.add(key);
    return key;
  };
  const out = new Map<number, { sum: string; count: string }>();
  p.aggs.forEach((a, i) => {
    if (a.fn === 'avg')
      out.set(i, { sum: fresh(`_avg_sum_${i}`), count: fresh(`_avg_count_${i}`) });
  });
  return out;
}

/** `avg` columns from the hidden SUM / COUNT columns; other columns as read. */
function finishAvg(
  p: GroupPlan,
  hidden: ReadonlyMap<number, { sum: string; count: string }>,
  read: Table,
): Table {
  const n = read.rowCount;
  const defs: ColumnDef[] = [];
  const vectors: Vector[] = [];
  for (const col of p.columns) {
    const i = p.aggs.findIndex((a) => a.def.key === col.key);
    const keys = hidden.get(i);
    if (keys === undefined) {
      // Read type: an integer sum beyond the safe range was read as decimal.
      defs.push(read.columnDef(col.key)!);
      vectors.push(read.column(col.key));
      continue;
    }
    const sums = read.column(keys.sum);
    const counts = read.column(keys.count);
    const builder = new ColumnBuilder('decimal');
    for (let r = 0; r < n; r++) {
      const sum = sums.get(r);
      const count = counts.get(r);
      if (typeof count !== 'number' || count === 0 || sum === null) {
        builder.append(null);
        continue;
      }
      const total = isDecimal(sum) ? sum : parseDecimal(String(sum));
      builder.append(roundDecimal(total.div(count)));
    }
    defs.push(col);
    vectors.push(builder.finish());
  }
  return new Table(defs, vectors, n);
}

export const transformGroupByPlugin: NodePlugin<GroupByConfig> = {
  type: 'transform.groupBy',
  configSchema: GroupByConfigSchema,
  ports: { inputs: [{ name: 'in', required: true }], outputs: [{ name: 'out', required: false }] },

  inferSchema(config, inputs) {
    return { out: plan(config, inputs['in'] ?? []).columns };
  },

  compile(config, inputs, { sql: d }) {
    const input = inputs['in']!;
    const p = plan(config, input.columns);
    const hidden = avgKeys(p);
    const read: ColumnDef[] = [];
    const list = p.by.map((c) => {
      read.push(p.columns.find((x) => x.key === c.key)!);
      return `${value(d, c)} AS ${d.ident(c.key)}`;
    });
    p.aggs.forEach((a, i) => {
      const v = a.source ? value(d, a.source) : '';
      const key = d.ident(a.def.key);
      switch (a.fn) {
        case 'sum':
          // SUM of only blanks = 0, like Excel; an integer SUM is BIGINT again (DuckDB: HUGEINT).
          list.push(`${d.cast(`coalesce(sum(${v}), 0)`, a.def.type)} AS ${key}`);
          read.push(a.def);
          return;
        case 'avg': {
          const keys = hidden.get(i)!;
          list.push(`${d.cast(`sum(${v})`, 'decimal')} AS ${d.ident(keys.sum)}`);
          list.push(`count(${v}) AS ${d.ident(keys.count)}`);
          read.push(
            { key: keys.sum, title: keys.sum, type: 'decimal' },
            { key: keys.count, title: keys.count, type: 'integer' },
          );
          return;
        }
        case 'min':
        case 'max':
          list.push(`${a.fn}(${v}) AS ${key}`);
          break;
        case 'count':
          list.push(`count(${v}) AS ${key}`);
          break;
        case 'countDistinct':
          list.push(`count(DISTINCT ${v}) AS ${key}`);
          break;
        case 'countRows':
          list.push(`count(*) AS ${key}`);
          break;
      }
      read.push(a.def);
    });
    // Groups in order of their first row; empty `by` → one row, even for no input row.
    list.push(`coalesce(min(${d.ord}), 0) AS ${d.ord}`);
    const group = p.by.length > 0 ? ` GROUP BY ${p.by.map((c) => value(d, c)).join(', ')}` : '';
    const sql = `SELECT ${list.join(', ')} FROM ${input.ref}${group}`;
    if (hidden.size === 0) return { ports: { out: { sql, params: [], columns: p.columns } } };
    return {
      ports: {
        out: { sql, params: [], columns: read, finish: (table) => finishAvg(p, hidden, table) },
      },
    };
  },
};
