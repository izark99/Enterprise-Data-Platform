import {
  CodeSqlConfigSchema,
  IdentifierSchema,
  type CodeSqlConfig,
  type FlowDefinition,
} from '@hrflow/flow-schema';
import { EngineError } from '../core/errors';
import type { ColumnDef, Schema } from '../core/types';
import type {
  NodePlugin,
  ParamValue,
  SqlChecked,
  SqlDescribed,
  SqlInspector,
  SqlValue,
  SqlView,
} from './index';

/**
 * `code.sql` (spec §12.1.8, §9.2): Admin SQL over one view per input port. Each view is named by
 * its port and has the port's columns, without the hidden order column. The statement is checked
 * by DuckDB's parser (`SqlInspector.check`: one SELECT reading only its views, declared `$key`
 * params bound as `VARCHAR` values), its columns come from `DESCRIBE` on empty typed views, and
 * each result column is cast to its canonical type (`DOUBLE` with 15 significant digits). Row order
 * is the order DuckDB returns (the Designer reminds about a missing outer `ORDER BY`). Runs in
 * DuckDB, inside the pushdown chain; a DuckDB failure is `sql.error.runtime` with DuckDB's text as
 * the screen-only `detail`.
 */

interface Planned {
  readonly checked: SqlChecked;
  readonly columns: readonly { readonly def: ColumnDef; readonly described: SqlDescribed }[];
}

const at = { path: ['sql'] as const };

function viewsOf(config: CodeSqlConfig, columnsOf: (port: string) => Schema): SqlView[] {
  return config.inputs.map((p) => ({ name: p.port, columns: columnsOf(p.port) }));
}

function plan(
  config: CodeSqlConfig,
  views: readonly SqlView[],
  inspector: SqlInspector,
  flow: FlowDefinition,
): Planned {
  const checked = inspector.check(
    config.sql,
    views.map((v) => v.name),
    flow.params.map((p) => p.key),
  );
  const described = inspector.describe(checked, views);
  const inputColumns = views.flatMap((v) => v.columns);
  // A result column may start with `_` only when it keeps a system column of an input.
  const system = new Set(inputColumns.filter((c) => c.key.startsWith('_')).map((c) => c.key));
  const seen = new Set<string>();
  const columns = described.map((d) => {
    const reserved = d.name.startsWith('_') && !system.has(d.name);
    if (!IdentifierSchema.safeParse(d.name).success || reserved) {
      throw new EngineError('sql.error.invalidColumnName', { column: d.name }, at);
    }
    if (seen.has(d.name)) {
      throw new EngineError('sql.error.duplicateColumn', { column: d.name }, at);
    }
    seen.add(d.name);
    if (d.type === null) {
      throw new EngineError('sql.error.unsupportedType', { column: d.name, type: d.duckType }, at);
    }
    const title = inputColumns.find((c) => c.key === d.name)?.title ?? d.name;
    return { def: { key: d.name, title, type: d.type }, described: d };
  });
  return { checked, columns };
}

/** A run parameter in the canonical `VARCHAR` form of spec §9.2; blank → `NULL`. */
function paramText(value: ParamValue | undefined): SqlValue {
  if (value === undefined || value === null) return null;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  const text = String(value);
  return text.trim() === '' ? null : text;
}

export const codeSqlPlugin: NodePlugin<CodeSqlConfig> = {
  type: 'code.sql',
  configSchema: CodeSqlConfigSchema,
  ports: { inputs: [], outputs: [{ name: 'out', required: false }] },

  inputPorts(config) {
    return config.inputs.map((p) => ({ name: p.port, required: true }));
  },

  inferSchema(config, inputs, ctx) {
    // `DESCRIBE` needs DuckDB, loaded in the Designer worker (spec §13.2 "Đang xác định cột…").
    if (ctx.sql === undefined) throw new EngineError('duckdb.error.unavailable', {}, at);
    const planned = plan(
      config,
      viewsOf(config, (port) => inputs[port] ?? []),
      ctx.sql,
      ctx.flow,
    );
    if (!planned.checked.ordered) ctx.warn?.({ messageKey: 'sql.warning.noOrderBy', params: {} });
    for (const c of planned.columns) {
      if (c.described.double) {
        ctx.warn?.({ messageKey: 'sql.warning.doubleColumn', params: { column: c.def.key } });
      }
    }
    return { out: planned.columns.map((c) => c.def) };
  },

  compile(config, inputs, ctx) {
    const d = ctx.sql;
    const planned = plan(
      config,
      viewsOf(config, (port) => inputs[port]?.columns ?? []),
      ctx.inspect,
      ctx.flow,
    );
    const views = config.inputs.map((p) => {
      const input = inputs[p.port]!;
      const cols = input.columns.map((c) => d.ident(c.key));
      return `${d.ident(p.port)} AS (SELECT ${cols.join(', ')} FROM ${input.ref})`;
    });
    const user = d.aux('user');
    const select = planned.columns.map(
      (c) =>
        `${ctx.inspect.canonical(`${user}.${d.ident(c.def.key)}`, c.described, c.def.key)}` +
        ` AS ${d.ident(c.def.key)}`,
    );
    select.push(`row_number() OVER () AS ${d.ord}`);
    const params = planned.checked.paramKeys.map((key) => paramText(ctx.run?.params[key]));
    return {
      ports: {
        out: {
          sql:
            `SELECT ${select.join(', ')} FROM (WITH ${views.join(', ')}` +
            ` SELECT * FROM (${planned.checked.sql}\n) AS ${d.aux('stmt')}) AS ${user}`,
          params,
          columns: planned.columns.map((c) => c.def),
          runtimeErrorKey: 'sql.error.runtime',
        },
      },
    };
  },
};
