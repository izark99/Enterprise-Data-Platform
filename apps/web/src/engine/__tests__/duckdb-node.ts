import { createDuckDB, DEFAULT_RUNTIME, VoidLogger } from '@duckdb/duckdb-wasm/blocking';
import { DuckDb } from '../duckdb/db';

/**
 * DuckDB for Vitest: the same package, the same `duckdb-eh.wasm` and the same runtime without file
 * system or network (`DEFAULT_RUNTIME`) as the worker (loader.ts), through the Node blocking
 * bindings. One instance per test file. Without the `json` extension: Node cannot load it (the
 * `LOAD` hangs), so tests that need DuckDB's parser run in Chromium (`e2e/engine/code-sql.spec.ts`).
 */
interface NodeModule {
  createRequire(url: string): { resolve(id: string): string };
}

// Node built-ins without Node types in the app tsconfig (same pattern as `io/__tests__/helpers.ts`).
const require = (
  globalThis as unknown as { process: { getBuiltinModule(id: 'node:module'): NodeModule } }
).process
  .getBuiltinModule('node:module')
  .createRequire(import.meta.url);

let pending: Promise<DuckDb> | null = null;

export function nodeDuckDb(): Promise<DuckDb> {
  pending ??= (async () => {
    const eh = require.resolve('@duckdb/duckdb-wasm/dist/duckdb-eh.wasm');
    const bundle = { mainModule: eh, mainWorker: '' };
    const bindings = await createDuckDB(
      { mvp: bundle, eh: bundle },
      new VoidLogger(),
      DEFAULT_RUNTIME,
    );
    await bindings.instantiate(() => undefined);
    return new DuckDb(bindings, { jsonExtensionUrl: null });
  })();
  return pending;
}
