import { JoinConfigSchema, type DataType, type JoinConfig } from '@hrflow/flow-schema';
import { EngineError } from '../core/errors';
import type { ColumnDef, Schema } from '../core/types';
import type { NodePlugin, SqlDialect } from './index';

/**
 * `transform.join` (spec §12.1.4): `inner` / `left` / `right` / `full` / `anti` on one or more key
 * pairs. Output: every `left` column in order, then the chosen `right` columns (default: every
 * non-key column); a right column whose key is taken gets `rightSuffix`, still taken →
 * `join.error.columnConflict`. Key columns appear once under the left name; with `right` / `full`
 * their value is the left one, else the right one. Blank keys never match; `string` keys are
 * compared after normalisation when `normalizeKeys` (default on); `integer` and `decimal` keys are
 * compatible. Rows follow the left order, then the right order; right-only rows come last.
 * A left key matching several right rows → `join.warning.rowsMultiplied` with the number of such
 * keys (never a key value). Runs in DuckDB.
 */

const NUMERIC: ReadonlySet<DataType> = new Set(['integer', 'decimal']);

interface KeyPair {
  readonly left: ColumnDef;
  readonly right: ColumnDef;
}

interface OutColumn {
  readonly def: ColumnDef;
  readonly side: 'left' | 'right';
  readonly from: string;
  /** For a left key column: its right partner. */
  readonly partner?: ColumnDef;
}

interface JoinPlan {
  readonly keys: readonly KeyPair[];
  readonly columns: readonly OutColumn[];
}

function find(input: Schema, key: string, path: (string | number)[]): ColumnDef {
  const col = input.find((c) => c.key === key);
  if (col === undefined)
    throw new EngineError('join.error.unknownColumn', { column: key }, { path });
  return col;
}

function plan(config: JoinConfig, left: Schema, right: Schema): JoinPlan {
  const keys = config.on.map((pair, i) => {
    const l = find(left, pair.left, ['on', i, 'left']);
    const r = find(right, pair.right, ['on', i, 'right']);
    if (l.type !== r.type && !(NUMERIC.has(l.type) && NUMERIC.has(r.type))) {
      throw new EngineError(
        'join.error.keyTypeMismatch',
        { left: l.key, right: r.key },
        { path: ['on', i] },
      );
    }
    return { left: l, right: r };
  });
  const keepsRight = config.how === 'right' || config.how === 'full';
  const columns: OutColumn[] = left.map((c) => {
    const pair = keys.find((k) => k.left.key === c.key);
    // A right/full key column holds right values too: integer with decimal → decimal.
    const type = pair && keepsRight && pair.right.type !== c.type ? 'decimal' : c.type;
    return {
      def: { key: c.key, title: c.title, type },
      side: 'left',
      from: c.key,
      ...(pair ? { partner: pair.right } : {}),
    };
  });
  if (config.how === 'anti') return { keys, columns };

  const rightKeys = new Set(config.on.map((p) => p.right));
  const picked: { col: ColumnDef; path: (string | number)[] }[] = config.rightColumns
    ? config.rightColumns.map((k, i) => ({
        col: find(right, k, ['rightColumns', i]),
        path: ['rightColumns', i],
      }))
    : right.filter((c) => !rightKeys.has(c.key)).map((col) => ({ col, path: ['rightSuffix'] }));
  const taken = new Set(columns.map((c) => c.def.key));
  for (const { col, path } of picked) {
    let key = col.key;
    if (taken.has(key)) key = `${key}${config.rightSuffix}`;
    if (taken.has(key)) {
      throw new EngineError('join.error.columnConflict', { column: col.key }, { path });
    }
    taken.add(key);
    columns.push({ def: { key, title: col.title, type: col.type }, side: 'right', from: col.key });
  }
  return { keys, columns };
}

/**
 * Key expression of one side: blank becomes `NULL` (never equal), normalised for `string` keys when
 * asked. The condition stays a plain equality so DuckDB can use a hash join.
 */
function keyExpr(d: SqlDialect, alias: string, col: ColumnDef, normalize: boolean): string {
  const x = `${alias}.${d.ident(col.key)}`;
  if (col.type !== 'string') return x;
  if (normalize) return `NULLIF(${d.normKey(x)}, '')`;
  return `CASE WHEN ${d.isBlank(x, 'string')} THEN NULL ELSE ${x} END`;
}

const JOIN_SQL = {
  inner: 'JOIN',
  left: 'LEFT JOIN',
  right: 'RIGHT JOIN',
  full: 'FULL OUTER JOIN',
} as const;

export const transformJoinPlugin: NodePlugin<JoinConfig> = {
  type: 'transform.join',
  configSchema: JoinConfigSchema,
  ports: {
    inputs: [
      { name: 'left', required: true },
      { name: 'right', required: true },
    ],
    outputs: [{ name: 'out', required: false }],
  },

  inferSchema(config, inputs) {
    const p = plan(config, inputs['left'] ?? [], inputs['right'] ?? []);
    return { out: p.columns.map((c) => c.def) };
  },

  compile(config, inputs, { sql: d }) {
    const left = inputs['left']!;
    const right = inputs['right']!;
    const p = plan(config, left.columns, right.columns);
    const columns = p.columns.map((c) => c.def);
    const n = config.normalizeKeys;
    const on = p.keys
      .map((k) => `${keyExpr(d, 'l', k.left, n)} = ${keyExpr(d, 'r', k.right, n)}`)
      .join(' AND ');

    if (config.how === 'anti') {
      const list = [...left.columns.map((c) => `l.${d.ident(c.key)}`), `l.${d.ord}`];
      const sql =
        `SELECT ${list.join(', ')} FROM ${left.ref} l ` +
        `WHERE NOT EXISTS (SELECT 1 FROM ${right.ref} r WHERE ${on})`;
      return { ports: { out: { sql, params: [], columns } } };
    }

    const keepsRight = config.how === 'right' || config.how === 'full';
    const list = p.columns.map((c) => {
      const out = d.ident(c.def.key);
      if (c.side === 'right') return `r.${d.ident(c.from)} AS ${out}`;
      if (c.partner && keepsRight) {
        const l = d.cast(`l.${d.ident(c.from)}`, c.def.type);
        const r = d.cast(`r.${d.ident(c.partner.key)}`, c.def.type);
        return `coalesce(${l}, ${r}) AS ${out}`;
      }
      return `l.${d.ident(c.from)} AS ${out}`;
    });
    list.push(`row_number() OVER (ORDER BY l.${d.ord} NULLS LAST, r.${d.ord}) AS ${d.ord}`);
    const sql = `SELECT ${list.join(', ')} FROM ${left.ref} l ${JOIN_SQL[config.how]} ${right.ref} r ON ${on}`;

    // Keys present on the left that match several right rows: a count, never a key value.
    const ks = p.keys.map((_, i) => d.aux(`k${i}`));
    const rk = p.keys.map((k, i) => `${keyExpr(d, 'r', k.right, n)} AS ${ks[i]!}`);
    const match = p.keys.map((k, i) => `${keyExpr(d, 'l', k.left, n)} = m.${ks[i]!}`);
    const multiplied =
      `SELECT count(*) FROM (SELECT ${ks.join(', ')} FROM (SELECT ${rk.join(', ')} FROM ${right.ref} r) ` +
      `WHERE ${ks.map((k) => `${k} IS NOT NULL`).join(' AND ')} GROUP BY ${ks.join(', ')} HAVING count(*) > 1) m ` +
      `WHERE EXISTS (SELECT 1 FROM ${left.ref} l WHERE ${match.join(' AND ')})`;
    return {
      ports: { out: { sql, params: [], columns } },
      warnings: [{ sql: multiplied, params: [], messageKey: 'join.warning.rowsMultiplied' }],
    };
  },
};
