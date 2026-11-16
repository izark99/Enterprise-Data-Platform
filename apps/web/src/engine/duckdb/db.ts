import type { DuckDBBindings } from '@duckdb/duckdb-wasm/blocking';
import { tableFromIPC, type Table as ArrowTable } from 'apache-arrow';
import { DuckDbError, ENGINE_MACROS, type SqlParam } from './sql';

/**
 * One locked-down, in-memory DuckDB (spec §13.1), over DuckDB-WASM's synchronous ("blocking")
 * bindings. The same class runs in the engine worker (browser bindings, loader.ts) and in Vitest
 * (Node bindings, `__tests__/duckdb-node.ts`), over the same `duckdb-eh.wasm`.
 *
 * Results cross as Arrow IPC bytes decoded by the app's own `apache-arrow`, so the engine never
 * depends on DuckDB's internal Arrow objects. Nothing here logs: DuckDB messages can quote cells.
 */

/** Settings applied right after the connection opens, then locked (spec §13.1, in this order). */
export const SECURE_SETTINGS: readonly string[] = [
  'SET enable_external_access = false',
  'SET autoinstall_known_extensions = false',
  'SET autoload_known_extensions = false',
  'SET lock_configuration = true',
];

type Connection = ReturnType<DuckDBBindings['connect']>;

export interface DuckDbOptions {
  /**
   * Absolute same-origin URL of the `json` extension (DuckDB's parser for the `code.sql` guard,
   * 02 §1.1), loaded before the settings are locked; DuckDB fetches it and checks its signature.
   * The worker always passes it (loader.ts). `null` only where the extension cannot load (Vitest
   * under Node): then `parser` is false and the guard refuses with `duckdb.error.unavailable`.
   */
  readonly jsonExtensionUrl: string | null;
}

export class DuckDb {
  private readonly conn: Connection;
  /** The `json` extension is loaded (`json_serialize_sql` is available). */
  readonly parser: boolean;

  /**
   * Opens `:memory:` (no OPFS, no file), loads the `json` extension when given, then applies and
   * locks the settings (afterwards no extension can load) and creates the macros.
   */
  constructor(bindings: DuckDBBindings, options: DuckDbOptions) {
    bindings.open({
      path: ':memory:',
      query: { castBigIntToDouble: false, castDecimalToDouble: false },
    });
    this.conn = bindings.connect();
    const url = options.jsonExtensionUrl;
    if (url !== null) this.exec(`LOAD '${url.replaceAll("'", "''")}'`);
    this.parser = url !== null;
    for (const sql of SECURE_SETTINGS) this.exec(sql);
    for (const sql of ENGINE_MACROS) this.exec(sql);
  }

  private wrap<T>(work: (b: DuckDBBindings, conn: number) => T): T {
    try {
      return this.conn.useUnsafe(work);
    } catch (err) {
      throw new DuckDbError(err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * Runs one statement. With `params` it is prepared and the values are bound as `VARCHAR` / `NULL`
   * (spec §9.2); a value never becomes SQL text.
   */
  query(sql: string, params: readonly SqlParam[] = []): ArrowTable {
    const bytes = this.wrap((b, conn) => {
      if (params.length === 0) return b.runQuery(conn, sql);
      const stmt = b.createPrepared(conn, sql);
      try {
        return b.runPrepared(conn, stmt, [...params]);
      } finally {
        b.closePrepared(conn, stmt);
      }
    });
    return tableFromIPC(bytes);
  }

  exec(sql: string, params: readonly SqlParam[] = []): void {
    this.query(sql, params);
  }

  /** Arrow IPC stream → table `name` (created when `create`, else appended by column name). */
  insertArrowIpc(ipc: Uint8Array, name: string, create: boolean): void {
    this.wrap((b, conn) => b.insertArrowFromIPCStream(conn, ipc, { name, create }));
  }

  /** First column of the first row, as text (settings, counts); `null` for SQL `NULL`. */
  scalar(sql: string, params: readonly SqlParam[] = []): string | null {
    const value: unknown = this.query(sql, params).getChildAt(0)?.get(0);
    return value === null || value === undefined ? null : String(value);
  }
}
