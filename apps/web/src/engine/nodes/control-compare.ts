import { CompareConfigSchema, type CompareConfig, type DataType } from '@hrflow/flow-schema';
import { Big, isDecimal, type Decimal } from '../core/decimal';
import { EngineError, type ErrorVars, type FieldPath } from '../core/errors';
import { normalizeKeyPart } from '../core/keys';
import { ColumnBuilder, Table } from '../core/table';
import type { ColumnDef, Schema, Value } from '../core/types';
import { displayValue } from '../io/coerce';
import type { NodePlugin, Translate } from './index';

/**
 * `control.compare` (spec §24.2, 03 §4.3): reconciles two tables by key.
 *
 * - Keys are matched after `normalizeKeyPart`; a key on one side only goes to `only_left` /
 *   `only_right` (input columns kept).
 * - Per metric: diff = right − left, mismatch when |diff| > tolerance (|diff| == tolerance matches),
 *   decimal arithmetic only. With `nullAsZero` a blank counts as 0 but stays blank in the output;
 *   without it blank vs blank matches and blank vs a number mismatches with a blank diff.
 * - `mismatched`: one row per key with a failing metric: keys, carry columns, three columns per
 *   metric and the labels of the failing metrics. `summary`: one row per metric plus a total row
 *   counted per key.
 *
 * Titles come from the translator of the context (MEMORY 2026-11-16 12:41, 2A); without one the
 * i18n key is the title.
 */

export const COMPARE_PORTS = ['summary', 'mismatched', 'only_left', 'only_right'] as const;
type ComparePort = (typeof COMPARE_PORTS)[number];

/** Column listing the labels of the failing metrics of a `mismatched` row. */
export const MISMATCHED_METRICS_COLUMN = '_mismatched_metrics';

const METRICS_SEPARATOR = ', ';
const KEY_DISPLAY_SEPARATOR = ' | ';
const NUMERIC: ReadonlySet<DataType> = new Set(['decimal', 'integer']);

function translator(t: Translate | undefined): Translate {
  return (key, vars) => (t === undefined ? key : t(key, vars));
}

interface Sides {
  readonly left: string;
  readonly right: string;
}

function sideNames(config: CompareConfig, t: Translate): Sides {
  return {
    left: config.sideLabels?.left ?? t('compare.side.left'),
    right: config.sideLabels?.right ?? t('compare.side.right'),
  };
}

interface MetricPlan {
  readonly label: string;
  readonly left: string;
  readonly right: string;
  readonly tolerance: Decimal;
  readonly keyLeft: string;
  readonly keyRight: string;
  readonly keyDiff: string;
}

/**
 * Output keys `<column>__left/right/diff` (`<left>_<right>` when the two columns differ). A key
 * already taken (by a key or carry column, or an earlier metric on the same columns) gets the
 * 1-based metric index as suffix, so the keys of the first metric stay stable.
 */
function metricPlans(config: CompareConfig, carry: readonly string[]): MetricPlan[] {
  const taken = new Set<string>([...config.keys, ...carry, MISMATCHED_METRICS_COLUMN]);
  return config.metrics.map((metric, i) => {
    const base = metric.left === metric.right ? metric.left : `${metric.left}_${metric.right}`;
    const keysOf = (id: string): string[] => [`${id}__left`, `${id}__right`, `${id}__diff`];
    let keys = keysOf(base);
    for (let n = i + 1; keys.some((k) => taken.has(k)); n++) keys = keysOf(`${base}_${n}`);
    for (const k of keys) taken.add(k);
    return {
      label: metric.label,
      left: metric.left,
      right: metric.right,
      tolerance: new Big(metric.tolerance),
      keyLeft: keys[0]!,
      keyRight: keys[1]!,
      keyDiff: keys[2]!,
    };
  });
}

/** Carry columns that are not keys, without repeats. */
function carryColumns(config: CompareConfig): string[] {
  return [...new Set(config.carryColumns)].filter((c) => !config.keys.includes(c));
}

function fail(key: string, params: ErrorVars, path: FieldPath): never {
  throw new EngineError(key, params, { path });
}

/** Referenced columns exist; metric columns are numeric (spec §12.1 design checks). */
function checkColumns(config: CompareConfig, left: Schema, right: Schema, sides: Sides): void {
  const need = (cols: Schema, side: string, column: string, numeric: boolean, path: FieldPath) => {
    const col = cols.find((c) => c.key === column);
    if (col === undefined) fail('compare.error.missingColumn', { side, column }, path);
    if (numeric && !NUMERIC.has(col.type)) {
      fail('compare.error.notNumeric', { side, column }, path);
    }
  };
  config.keys.forEach((key, i) => {
    need(left, sides.left, key, false, ['keys', i]);
    need(right, sides.right, key, false, ['keys', i]);
  });
  config.metrics.forEach((metric, i) => {
    need(left, sides.left, metric.left, true, ['metrics', i, 'left']);
    need(right, sides.right, metric.right, true, ['metrics', i, 'right']);
  });
  config.carryColumns.forEach((column, i) => {
    if (!left.some((c) => c.key === column) && !right.some((c) => c.key === column)) {
      fail('compare.error.missingColumn', { side: sides.left, column }, ['carryColumns', i]);
    }
  });
}

function outputSchemas(
  config: CompareConfig,
  left: Schema,
  right: Schema,
  sides: Sides,
  t: Translate,
): Record<ComparePort, Schema> {
  const find = (key: string): ColumnDef =>
    (left.find((c) => c.key === key) ?? right.find((c) => c.key === key))!;
  const carry = carryColumns(config);

  const summary: ColumnDef[] = [
    { key: 'metric', title: t('compare.summary.metric'), type: 'string' },
    { key: 'tolerance', title: t('compare.summary.tolerance'), type: 'decimal' },
    { key: 'matched', title: t('compare.summary.matched'), type: 'integer' },
    { key: 'mismatched', title: t('compare.summary.mismatched'), type: 'integer' },
    {
      key: 'only_left',
      title: t('compare.summary.onlyLeft', { side: sides.left }),
      type: 'integer',
    },
    {
      key: 'only_right',
      title: t('compare.summary.onlyRight', { side: sides.right }),
      type: 'integer',
    },
    { key: 'total_diff', title: t('compare.summary.totalDiff'), type: 'decimal' },
  ];

  const mismatched: ColumnDef[] = [...config.keys, ...carry].map((key) => {
    const col = find(key);
    return { key: col.key, title: col.title, type: col.type };
  });
  for (const m of metricPlans(config, carry)) {
    mismatched.push(
      {
        key: m.keyLeft,
        title: t('compare.column.left', { metric: m.label, side: sides.left }),
        type: 'decimal',
      },
      {
        key: m.keyRight,
        title: t('compare.column.right', { metric: m.label, side: sides.right }),
        type: 'decimal',
      },
      { key: m.keyDiff, title: t('compare.column.diff', { metric: m.label }), type: 'decimal' },
    );
  }
  mismatched.push({
    key: MISMATCHED_METRICS_COLUMN,
    title: t('compare.column.mismatchedMetrics'),
    type: 'string',
  });

  return { summary, mismatched, only_left: [...left], only_right: [...right] };
}

/** A numeric cell as a decimal (integer columns hold safe integers). */
function toDecimal(v: Value): Decimal | null {
  if (v === null) return null;
  if (isDecimal(v)) return v;
  if (typeof v === 'number') return new Big(v);
  // Column types were checked first: another value here is a bug.
  throw new TypeError('compare: metric value is not numeric');
}

/**
 * Normalised key → row, in row order. A repeated key fails with the key as the file shows it: the
 * one on-screen exception of 03 §4.7 (MEMORY 2026-11-16 12:41, 3B), never written to run logs.
 */
function indexByKey(table: Table, keys: readonly string[], side: string): Map<string, number> {
  const vectors = keys.map((k) => table.column(k));
  const index = new Map<string, number>();
  for (let row = 0; row < table.rowCount; row++) {
    const parts = vectors.map((v) => normalizeKeyPart(v.get(row)));
    const id = parts.length === 1 ? parts[0]! : parts.join('\u0000');
    if (index.has(id)) {
      const key = vectors.map((v) => displayValue(v.get(row)).trim()).join(KEY_DISPLAY_SEPARATOR);
      throw new EngineError('compare.error.duplicateKey', { side, key });
    }
    index.set(id, row);
  }
  return index;
}

/** Copy of the given rows of `table`, same columns. */
function takeRows(table: Table, rows: readonly number[]): Table {
  const vectors = table.columns.map((col) => {
    const source = table.column(col.key);
    const builder = new ColumnBuilder(col.type);
    for (const row of rows) builder.append(source.get(row));
    return builder.finish();
  });
  return new Table(table.columns, vectors, rows.length);
}

function inputsOf<T>(inputs: Readonly<Record<string, T>>): { left: T; right: T } {
  const { left, right } = inputs;
  if (left === undefined || right === undefined)
    throw new EngineError('compare.error.missingInput');
  return { left, right };
}

export function executeCompare(
  config: CompareConfig,
  left: Table,
  right: Table,
  translate?: Translate,
): Record<ComparePort, Table> {
  const t = translator(translate);
  const sides = sideNames(config, t);
  checkColumns(config, left.columns, right.columns, sides);
  const schemas = outputSchemas(config, left.columns, right.columns, sides, t);
  const carry = carryColumns(config);
  const plans = metricPlans(config, carry);
  const leftIndex = indexByKey(left, config.keys, sides.left);
  const rightIndex = indexByKey(right, config.keys, sides.right);

  const builders = new Map(schemas.mismatched.map((c) => [c.key, new ColumnBuilder(c.type)]));
  const out = (key: string): ColumnBuilder => builders.get(key)!;
  const vectors = plans.map((m) => [left.column(m.left), right.column(m.right)] as const);
  const stats = plans.map(() => ({ matched: 0, mismatched: 0, totalDiff: new Big(0) }));
  const zero = new Big(0);
  const onlyLeft: number[] = [];
  let matchedKeys = 0;
  let mismatchedKeys = 0;

  for (const [id, li] of leftIndex) {
    const ri = rightIndex.get(id);
    if (ri === undefined) {
      onlyLeft.push(li);
      continue;
    }
    const failed: string[] = [];
    const cells: (Decimal | null)[] = [];
    plans.forEach((m, i) => {
      const [lv, rv] = vectors[i]!;
      const sourceLeft = toDecimal(lv.get(li));
      const sourceRight = toDecimal(rv.get(ri));
      const l = config.nullAsZero ? (sourceLeft ?? zero) : sourceLeft;
      const r = config.nullAsZero ? (sourceRight ?? zero) : sourceRight;
      let diff: Decimal | null = null;
      let mismatch: boolean;
      if (l === null || r === null) {
        mismatch = l !== r;
      } else {
        diff = r.minus(l);
        mismatch = diff.abs().gt(m.tolerance);
        stats[i]!.totalDiff = stats[i]!.totalDiff.plus(diff);
      }
      if (mismatch) {
        stats[i]!.mismatched += 1;
        failed.push(m.label);
      } else {
        stats[i]!.matched += 1;
      }
      // A blank source stays blank in the output even when compared as 0 (spec §24.2).
      cells.push(sourceLeft, sourceRight, diff);
    });
    if (failed.length === 0) {
      matchedKeys += 1;
      continue;
    }
    mismatchedKeys += 1;
    for (const key of config.keys) out(key).append(left.get(li, key));
    for (const column of carry) out(column).append(carryValue(left, li, right, ri, column));
    plans.forEach((m, i) => {
      out(m.keyLeft).append(cells[3 * i]!);
      out(m.keyRight).append(cells[3 * i + 1]!);
      out(m.keyDiff).append(cells[3 * i + 2]!);
    });
    out(MISMATCHED_METRICS_COLUMN).append(failed.join(METRICS_SEPARATOR));
  }

  const onlyRight: number[] = [];
  for (const [id, ri] of rightIndex) if (!leftIndex.has(id)) onlyRight.push(ri);

  const summaryRows: Value[][] = plans.map((m, i) => [
    m.label,
    m.tolerance,
    stats[i]!.matched,
    stats[i]!.mismatched,
    onlyLeft.length,
    onlyRight.length,
    stats[i]!.totalDiff,
  ]);
  summaryRows.push([
    t('compare.summary.totalRow'),
    null,
    matchedKeys,
    mismatchedKeys,
    onlyLeft.length,
    onlyRight.length,
    null,
  ]);

  return {
    summary: Table.fromRows(schemas.summary, summaryRows),
    mismatched: new Table(
      schemas.mismatched,
      schemas.mismatched.map((c) => builders.get(c.key)!.finish()),
      mismatchedKeys,
    ),
    only_left: takeRows(left, onlyLeft),
    only_right: takeRows(right, onlyRight),
  };
}

/** Carry value from the left row; the right row fills a blank or a column the left lacks. */
function carryValue(left: Table, li: number, right: Table, ri: number, column: string): Value {
  const l = left.columnDef(column);
  const r = right.columnDef(column);
  const value = l === undefined ? null : left.get(li, column);
  if (value !== null || r === undefined || (l !== undefined && l.type !== r.type)) return value;
  return right.get(ri, column);
}

export const controlComparePlugin: NodePlugin<CompareConfig> = {
  type: 'control.compare',
  configSchema: CompareConfigSchema,
  ports: {
    inputs: [
      { name: 'left', required: true },
      { name: 'right', required: true },
    ],
    outputs: COMPARE_PORTS.map((name) => ({ name, required: false })),
  },

  inferSchema(config, inputs, ctx) {
    const { left, right } = inputsOf(inputs);
    const t = translator(ctx.t);
    const sides = sideNames(config, t);
    checkColumns(config, left, right, sides);
    return outputSchemas(config, left, right, sides, t);
  },

  execute(config, inputs, ctx) {
    const { left, right } = inputsOf(inputs);
    return executeCompare(config, left, right, ctx.t);
  },
};
