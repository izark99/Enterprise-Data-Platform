import {
  FilterConfigSchema,
  type DataType,
  type FilterCondition,
  type FilterConfig,
  type Literal,
} from '@hrflow/flow-schema';
import { parseDecimal, roundDecimal } from '../core/decimal';
import { EngineError, type FieldPath } from '../core/errors';
import type { ColumnDef, Schema } from '../core/types';
import type { NodePlugin, ParamValue, SqlDialect, SqlValue } from './index';

/**
 * `transform.filter` (spec §12.1.2): keeps the rows that meet all (`match: 'all'`) or any of the
 * conditions. Values are bound as prepared parameters, cast to the column type; strings are
 * compared after key normalisation when `normalizeText` (default on). A blank cell meets only
 * `isBlank`, `neq`, `notIn` and `notContains`. A condition on a run parameter left empty is
 * skipped; with every condition skipped all rows pass. Runs in DuckDB, row order kept.
 */

const ORDERED_OPS: ReadonlySet<string> = new Set(['gt', 'gte', 'lt', 'lte']);
const TEXT_OPS: ReadonlySet<string> = new Set([
  'contains',
  'notContains',
  'startsWith',
  'endsWith',
]);
const COMPARE_SQL: Readonly<Record<string, string>> = {
  eq: '=',
  neq: '<>',
  gt: '>',
  gte: '>=',
  lt: '<',
  lte: '<=',
};

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATETIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/;
const INTEGER = /^-?\d+$/;
const DECIMAL = /^-?\d+(\.\d+)?$/;

function validDate(y: string, m: string, d: string): boolean {
  const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  return (
    date.getUTCFullYear() === Number(y) &&
    date.getUTCMonth() === Number(m) - 1 &&
    date.getUTCDate() === Number(d)
  );
}

/**
 * A constant or parameter value as the text DuckDB casts to the column type (spec §12.1.2: `date`
 * as `YYYY-MM-DD`, `decimal` as decimal text), or `undefined` when it does not read as that type.
 */
function valueText(value: Literal | ParamValue, type: DataType): string | undefined {
  if (value === null) return undefined;
  switch (type) {
    case 'string':
      return typeof value === 'boolean' ? undefined : String(value);
    case 'integer':
      if (typeof value === 'number') return Number.isSafeInteger(value) ? String(value) : undefined;
      return typeof value === 'string' &&
        INTEGER.test(value.trim()) &&
        Number.isSafeInteger(Number(value))
        ? String(Number(value))
        : undefined;
    case 'decimal': {
      const text = typeof value === 'number' ? String(value) : value;
      if (typeof text !== 'string') return undefined;
      if (typeof value === 'string' && !DECIMAL.test(text.trim())) return undefined;
      if (typeof value === 'number' && !Number.isFinite(value)) return undefined;
      return roundDecimal(parseDecimal(text.trim())).toFixed();
    }
    case 'boolean':
      if (typeof value === 'boolean') return String(value);
      return value === 'true' || value === 'false' ? value : undefined;
    case 'date': {
      const m = typeof value === 'string' ? DATE.exec(value) : null;
      return m && validDate(m[1]!, m[2]!, m[3]!) ? (value as string) : undefined;
    }
    case 'datetime': {
      const m = typeof value === 'string' ? DATETIME.exec(value) : null;
      return m &&
        validDate(m[1]!, m[2]!, m[3]!) &&
        Number(m[4]) < 24 &&
        Number(m[5]) < 60 &&
        Number(m[6]) < 60
        ? (value as string)
        : undefined;
    }
  }
}

/** A run parameter left empty (no value, or only whitespace): its condition is skipped. */
function isEmptyParam(value: ParamValue | undefined): boolean {
  return (
    value === undefined || value === null || (typeof value === 'string' && value.trim() === '')
  );
}

function invalid(column: ColumnDef, path: FieldPath): EngineError {
  return new EngineError(
    'filter.error.invalidValue',
    { column: column.key, type: column.type },
    { path },
  );
}

/** Column of each condition, after the column, op and constant-value checks. */
function plan(config: FilterConfig, input: Schema): ColumnDef[] {
  return config.conditions.map((cond, i) => {
    const column = input.find((c) => c.key === cond.column);
    if (column === undefined) {
      throw new EngineError(
        'filter.error.unknownColumn',
        { column: cond.column },
        { path: ['conditions', i, 'column'] },
      );
    }
    const wrongType =
      (ORDERED_OPS.has(cond.op) && column.type === 'boolean') ||
      (TEXT_OPS.has(cond.op) && column.type !== 'string');
    if (wrongType) {
      throw new EngineError(
        'filter.error.opNotForType',
        { column: column.key, type: column.type },
        { path: ['conditions', i, 'op'] },
      );
    }
    if (cond.op in COMPARE_SQL || TEXT_OPS.has(cond.op)) {
      const value = cond.value;
      const literal = typeof value === 'object' ? undefined : value;
      if (literal !== undefined && valueText(literal, column.type) === undefined) {
        throw invalid(column, ['conditions', i, 'value']);
      }
    }
    if (cond.op === 'in' || cond.op === 'notIn') {
      (cond.values ?? []).forEach((v, j) => {
        if (valueText(v, column.type) === undefined) {
          throw invalid(column, ['conditions', i, 'values', j]);
        }
      });
    }
    return column;
  });
}

/** SQL of one condition, or `null` when it is skipped (empty parameter). */
function conditionSql(
  cond: FilterCondition,
  i: number,
  column: ColumnDef,
  normalize: boolean,
  params: Readonly<Record<string, ParamValue>>,
  d: SqlDialect,
  out: SqlValue[],
): string | null {
  const col = d.ident(column.key);
  const blank = d.isBlank(col, column.type);
  const text = column.type === 'string';
  const x = text && normalize ? d.normKey(col) : col;
  const placeholder = (): string => {
    if (!text) return d.cast(d.param, column.type);
    return normalize ? d.normKey(d.param) : d.param;
  };
  const bind = (value: Literal | ParamValue, path: FieldPath): string => {
    const textValue = valueText(value, column.type);
    if (textValue === undefined) throw invalid(column, path);
    out.push(textValue);
    return placeholder();
  };

  if (cond.op === 'isBlank') return blank;
  if (cond.op === 'notBlank') return `(NOT ${blank})`;
  if (cond.op === 'in' || cond.op === 'notIn') {
    const list = (cond.values ?? []).map((v, j) => bind(v, ['conditions', i, 'values', j]));
    return cond.op === 'in'
      ? `(NOT ${blank} AND ${x} IN (${list.join(', ')}))`
      : `(${blank} OR ${x} NOT IN (${list.join(', ')}))`;
  }

  const raw = cond.value;
  let value: Literal | ParamValue;
  if (typeof raw === 'object' && raw !== null) {
    const given = params[raw.param];
    if (isEmptyParam(given)) return null;
    value = given!;
  } else {
    value = raw ?? null;
  }
  const v = bind(value, ['conditions', i, 'value']);
  switch (cond.op) {
    case 'neq':
      return `(${blank} OR ${x} <> ${v})`;
    case 'contains':
      return `(NOT ${blank} AND contains(${x}, ${v}))`;
    case 'notContains':
      return `(${blank} OR NOT contains(${x}, ${v}))`;
    case 'startsWith':
      return `(NOT ${blank} AND starts_with(${x}, ${v}))`;
    case 'endsWith':
      return `(NOT ${blank} AND ends_with(${x}, ${v}))`;
    default:
      return `(NOT ${blank} AND ${x} ${COMPARE_SQL[cond.op]!} ${v})`;
  }
}

export const transformFilterPlugin: NodePlugin<FilterConfig> = {
  type: 'transform.filter',
  configSchema: FilterConfigSchema,
  ports: { inputs: [{ name: 'in', required: true }], outputs: [{ name: 'out', required: false }] },

  checkConfig(config, flow) {
    const known = new Set(flow.params.map((p) => p.key));
    const problems: EngineError[] = [];
    config.conditions.forEach((cond, i) => {
      const value = cond.value;
      if (typeof value === 'object' && !known.has(value.param)) {
        problems.push(
          new EngineError(
            'filter.error.unknownParam',
            { param: value.param },
            { path: ['conditions', i, 'value', 'param'] },
          ),
        );
      }
    });
    return problems;
  },

  inferSchema(config, inputs) {
    const input = inputs['in'] ?? [];
    plan(config, input);
    return { out: input };
  },

  compile(config, inputs, ctx) {
    const input = inputs['in']!;
    const d = ctx.sql;
    const columns = plan(config, input.columns);
    const params: SqlValue[] = [];
    const runParams = ctx.run?.params ?? {};
    const parts: string[] = [];
    config.conditions.forEach((cond, i) => {
      const sql = conditionSql(cond, i, columns[i]!, config.normalizeText, runParams, d, params);
      if (sql !== null) parts.push(sql);
    });
    const where =
      parts.length === 0 ? 'TRUE' : parts.join(config.match === 'all' ? ' AND ' : ' OR ');
    const list = [...input.columns.map((c) => d.ident(c.key)), d.ord];
    return {
      ports: {
        out: {
          sql: `SELECT ${list.join(', ')} FROM ${input.ref} WHERE ${where}`,
          params,
          columns: input.columns,
        },
      },
    };
  },
};
