import type { FlowDefinition } from '@hrflow/flow-schema';
import {
  codeSqlPlugin,
  DUCKDB_DIALECT,
  DuckDbInspector,
  EngineError,
  executePlan,
  isDecimal,
  loadDuckDb,
  NODE_PLUGINS,
  parseDecimal,
  planFlow,
  SqlScope,
  Table,
  type CompileContext,
  type DuckDb,
  type HarnessReply,
  type HarnessRequest,
  type NodePlugin,
  type NodeWarning,
  type ParamValue,
  type PortSchemas,
  type Schema,
  type SqlInput,
  type Value,
  type WireCell,
  type WireError,
  type WireTable,
} from '../engine/protocol';

/**
 * Engine worker of the E2E harness page (E2E build only, T-R1-08). It runs the real worker-side
 * engine in Chromium: DuckDB from the self-hosted parts with the `json` extension loaded before the
 * lock (loader.ts), the `code.sql` guard (`DuckDbInspector`) and the executor. Each operation
 * answers with plain JSON. Fake data only; nothing is logged.
 *
 * The DuckDB statements sent during the last operation are kept so a spec can check that a
 * parameter value never becomes SQL text and how often a chain is materialised.
 */

const recorded: { queries: string[]; created: number } = { queries: [], created: 0 };
let dbPending: Promise<DuckDb> | null = null;
let dbCurrent: DuckDb | null = null;

/**
 * The worker's DuckDB, with its statements recorded (the same instance `loadDuckDb` returns). A
 * database broken by a WebAssembly trap is dropped, and `loadDuckDb` opens a new one.
 */
function database(): Promise<DuckDb> {
  if (dbCurrent?.broken) {
    dbCurrent = null;
    dbPending = null;
  }
  dbPending ??= loadDuckDb().then((db) => {
    dbCurrent = db;
    const query = db.query.bind(db);
    const exec = db.exec.bind(db);
    db.query = (sql, params) => {
      recorded.queries.push(sql);
      return query(sql, params);
    };
    db.exec = (sql, params) => {
      if (/^CREATE TABLE "[^"]+" AS/.test(sql)) recorded.created += 1;
      exec(sql, params);
    };
    return db;
  });
  return dbPending;
}

function toValue(cell: WireCell): Value {
  return typeof cell === 'object' && cell !== null ? parseDecimal(cell.dec) : cell;
}

/** Cells as plain values: decimals as their exact text. */
function plain(v: Value): string | number | boolean | null {
  return isDecimal(v) ? v.toString() : v;
}

function wireTable(table: Table): WireTable {
  return {
    columns: table.columns.map((c) => ({ key: c.key, title: c.title, type: c.type })),
    rows: Array.from({ length: table.rowCount }, (_, i) =>
      table.columns.map((c) => plain(table.get(i, c.key))),
    ),
  };
}

/** `test.source`: emits the table named by its config (a fresh copy per run). */
function sourcePlugin(data: Readonly<Record<string, WireTable>>): NodePlugin {
  const tableOf = (config: unknown): WireTable => data[(config as { name: string }).name]!;
  return {
    type: 'test.source',
    configSchema: { safeParse: (input) => ({ success: true, data: input }) },
    ports: { inputs: [], outputs: [{ name: 'out', required: false }] },
    inferSchema: (config) => ({ out: tableOf(config).columns as Schema }),
    execute: (config) => {
      const t = tableOf(config);
      return {
        out: Table.fromRows(
          t.columns as Schema,
          t.rows.map((r) => r.map(toValue)),
        ),
      };
    },
  };
}

function emptyFlow(params: FlowDefinition['params']): FlowDefinition {
  return { schemaVersion: 1, params, inputSlots: [], nodes: [], edges: [] };
}

type Op = (...args: never[]) => unknown;

const OPS: Record<string, Op> = {
  /** `DuckDbInspector.check` (the guard). */
  async check(sql: string, views: readonly string[], params: readonly string[]) {
    const db = await database();
    return new DuckDbInspector(db).check(sql, views, params);
  },

  /** `code.sql` design-time schema and warnings (spec §13.2). */
  async infer(config: unknown, inputs: PortSchemas, params: FlowDefinition['params']) {
    const db = await database();
    const parsed = codeSqlPlugin.configSchema.safeParse(config);
    if (!parsed.success) throw new Error('config');
    const warnings: NodeWarning[] = [];
    const schemas = await codeSqlPlugin.inferSchema(parsed.data, inputs, {
      flow: emptyFlow(params),
      sql: new DuckDbInspector(db),
      warn: (w) => warnings.push(w),
    });
    return { schemas, warnings };
  },

  /** A whole run through the executor; outputs per node and port, plus the recorded statements. */
  async run(
    flow: FlowDefinition,
    data: Readonly<Record<string, WireTable>>,
    params: Readonly<Record<string, ParamValue>>,
  ) {
    const db = await database();
    recorded.queries = [];
    recorded.created = 0;
    const registry = { ...NODE_PLUGINS, 'test.source': sourcePlugin(data) };
    const result = await executePlan(flow, planFlow(flow, registry), {
      sql: async () => new SqlScope(db),
      run: { slots: {}, params, emitFile: () => undefined },
    });
    const outputs: Record<string, Record<string, WireTable>> = {};
    for (const [node, ports] of Object.entries(result.outputs)) {
      outputs[node] = {};
      for (const [port, table] of Object.entries(ports)) outputs[node][port] = wireTable(table);
    }
    return { outputs, queries: recorded.queries, materialised: recorded.created };
  },

  /** `code.sql` compile over existing tables (`inputs[port].ref`), without a run. */
  async compile(
    config: unknown,
    inputs: Readonly<Record<string, SqlInput>>,
    params: FlowDefinition['params'],
  ) {
    const db = await database();
    const parsed = codeSqlPlugin.configSchema.safeParse(config);
    if (!parsed.success) throw new Error('config');
    const ctx: CompileContext = {
      nodeId: 'sql',
      flow: emptyFlow(params),
      sql: DUCKDB_DIALECT,
      inspect: new DuckDbInspector(db),
    };
    const q = codeSqlPlugin.compile!(parsed.data, inputs, ctx).ports['out']!;
    return { sql: q.sql, params: q.params };
  },

  /** One statement (test setup). */
  async exec(sql: string) {
    (await database()).exec(sql);
    return null;
  },

  /** First column of the first row, as text. */
  async scalar(sql: string, params: readonly (string | null)[] = []) {
    return (await database()).scalar(sql, params);
  },
};

function wireError(err: unknown): WireError {
  if (err instanceof EngineError) {
    return {
      engine: true,
      message: err.message,
      info: { ...err.toInfo() },
      log: { ...err.toLog() },
    };
  }
  return {
    engine: false,
    name: err instanceof Error ? err.name : typeof err,
    message: err instanceof Error ? err.message : String(err),
  };
}

self.addEventListener('message', (event: MessageEvent<HarnessRequest>) => {
  const { id, op, args } = event.data;
  const work = OPS[op];
  const reply = (r: HarnessReply): void => self.postMessage(r);
  if (!work) {
    reply({ id, ok: false, error: { engine: false, name: 'Error', message: `unknown op ${op}` } });
    return;
  }
  Promise.resolve()
    .then(() => work(...(args as never[])))
    .then(
      (value) => reply({ id, ok: true, value: value ?? null }),
      (err: unknown) => reply({ id, ok: false, error: wireError(err) }),
    );
});
