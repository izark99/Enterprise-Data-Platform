import { createDuckDB, DEFAULT_RUNTIME, VoidLogger } from '@duckdb/duckdb-wasm/blocking';
import { EngineError } from '../core/errors';
import { DuckDb } from './db';
import { isDuckDbExtensionFile, isDuckDbManifest, type DuckDbManifest } from './manifest';

/**
 * Loads the self-hosted DuckDB-WASM in the engine worker (spec §13.1):
 * - the `.wasm` parts of the manifest come from the app's own origin only;
 * - every part and the reassembled file are checked against the manifest's SHA-256;
 * - verified parts are kept in Cache Storage under a name keyed by version + checksum; caches of
 *   other versions are removed; the cache holds only the WASM, never data;
 * - a bad checksum or a failed download clears the cache and loads once more from the network;
 *   a second failure is `duckdb.error.loadFailed`;
 * - the verified module reaches DuckDB as a local `blob:` URL, revoked once DuckDB has started;
 * - the `json` extension (DuckDB's parser for the `code.sql` guard) is always loaded from its
 *   same-origin path before the configuration is locked (db.ts); DuckDB fetches it itself and
 *   checks its signature, the build checked its SHA-256 (owner 2A, MEMORY 2026-11-16 14:30).
 *
 * Only a flow with a DuckDB node calls `loadDuckDb` (lazy load, spec §13.1).
 */

/** The manifest of this build, embedded by the Vite plugin (`apps/web/build/duckdb-wasm.ts`). */
declare const __HRFLOW_DUCKDB_MANIFEST__: unknown;
/** The `json` extension entry of this build (`DuckDbExtensionFile`), embedded by the same plugin. */
declare const __HRFLOW_DUCKDB_JSON_EXTENSION__: unknown;

export const CACHE_PREFIX = 'hrflow-duckdb-';

export interface LoadProgress {
  readonly loadedBytes: number;
  readonly totalBytes: number;
}

export interface LoaderDeps {
  readonly fetch: (url: string, init: RequestInit) => Promise<Response>;
  /** Cache Storage when available (secure contexts); absent → no caching. */
  readonly caches?: CacheStorage | undefined;
  /** Absolute base URL of the app; part paths are relative to it and must stay on its origin. */
  readonly baseUrl: string;
}

/** Cache Storage name of a manifest: one cache per DuckDB version and binary. */
export function cacheName(manifest: DuckDbManifest): string {
  return `${CACHE_PREFIX}${manifest.version}-${manifest.sha256}`;
}

export async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

class LoadAttemptFailed extends Error {}

/** Opens the cache of `name` after removing the DuckDB caches of every other manifest. */
async function openCache(deps: LoaderDeps, name: string): Promise<Cache | null> {
  if (!deps.caches) return null;
  try {
    for (const key of await deps.caches.keys()) {
      if (key.startsWith(CACHE_PREFIX) && key !== name) await deps.caches.delete(key);
    }
    return await deps.caches.open(name);
  } catch {
    return null;
  }
}

function partUrl(file: string, baseUrl: string): string {
  const base = new URL(baseUrl);
  const url = new URL(file, base);
  if (url.origin !== base.origin) throw new LoadAttemptFailed('origin');
  return url.href;
}

async function assemble(
  manifest: DuckDbManifest,
  deps: LoaderDeps,
  cache: Cache | null,
  fromNetworkOnly: boolean,
  onProgress?: (p: LoadProgress) => void,
): Promise<Uint8Array> {
  const out = new Uint8Array(manifest.totalBytes);
  let offset = 0;
  onProgress?.({ loadedBytes: 0, totalBytes: manifest.totalBytes });
  for (const part of manifest.parts) {
    const url = partUrl(part.file, deps.baseUrl);
    let bytes: Uint8Array | null = null;
    if (cache && !fromNetworkOnly) {
      const hit = await cache.match(url);
      if (hit) bytes = new Uint8Array(await hit.arrayBuffer());
    }
    const cached = bytes !== null;
    if (bytes === null) {
      const res = await deps.fetch(url, {
        credentials: 'same-origin',
        cache: fromNetworkOnly ? 'reload' : 'default',
      });
      if (!res.ok) throw new LoadAttemptFailed('download');
      bytes = new Uint8Array(await res.arrayBuffer());
    }
    if (bytes.byteLength !== part.bytes || (await sha256Hex(bytes)) !== part.sha256) {
      throw new LoadAttemptFailed('checksum');
    }
    if (offset + bytes.byteLength > out.byteLength) throw new LoadAttemptFailed('size');
    out.set(bytes, offset);
    offset += bytes.byteLength;
    if (cache && !cached) {
      const body = new Response(bytes as Uint8Array<ArrayBuffer>, {
        headers: { 'Content-Type': 'application/wasm' },
      });
      await cache.put(url, body).catch(() => undefined);
    }
    onProgress?.({ loadedBytes: offset, totalBytes: manifest.totalBytes });
  }
  if (offset !== manifest.totalBytes || (await sha256Hex(out)) !== manifest.sha256) {
    throw new LoadAttemptFailed('checksum');
  }
  return out;
}

async function dropCache(deps: LoaderDeps, name: string): Promise<void> {
  await deps.caches?.delete(name).catch(() => false);
}

/** The verified `.wasm` bytes; rejects with `duckdb.error.loadFailed`. */
export async function loadWasmBytes(
  manifest: DuckDbManifest,
  deps: LoaderDeps,
  onProgress?: (p: LoadProgress) => void,
): Promise<Uint8Array> {
  const name = cacheName(manifest);
  try {
    return await assemble(manifest, deps, await openCache(deps, name), false, onProgress);
  } catch {
    // Wrong or partial cache content, or a broken download: clear the cache, load once more.
    await dropCache(deps, name);
    try {
      return await assemble(manifest, deps, await openCache(deps, name), true, onProgress);
    } catch {
      await dropCache(deps, name);
      throw new EngineError('duckdb.error.loadFailed');
    }
  }
}

/**
 * Runs `start` with a local `blob:` URL of `bytes` and revokes the URL as soon as `start` settles,
 * so the module is never reachable after DuckDB has started.
 */
export async function withWasmUrl<T>(
  bytes: Uint8Array,
  start: (url: string) => Promise<T>,
): Promise<T> {
  const url = URL.createObjectURL(
    new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'application/wasm' }),
  );
  try {
    return await start(url);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** A module the browser refuses (CSP, broken binary) can leave instantiation pending forever. */
const INSTANTIATE_TIMEOUT_MS = 120_000;

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new EngineError('duckdb.error.loadFailed')), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new EngineError('duckdb.error.loadFailed'));
      },
    );
  });
}

async function open(onProgress?: (p: LoadProgress) => void): Promise<DuckDb> {
  const manifest =
    typeof __HRFLOW_DUCKDB_MANIFEST__ === 'undefined' ? undefined : __HRFLOW_DUCKDB_MANIFEST__;
  if (!isDuckDbManifest(manifest)) throw new EngineError('duckdb.error.loadFailed');
  const extension =
    typeof __HRFLOW_DUCKDB_JSON_EXTENSION__ === 'undefined'
      ? undefined
      : __HRFLOW_DUCKDB_JSON_EXTENSION__;
  if (!isDuckDbExtensionFile(extension)) throw new EngineError('duckdb.error.loadFailed');
  const baseUrl = new URL(import.meta.env.BASE_URL, self.location.origin).href;
  let jsonExtensionUrl: string;
  try {
    jsonExtensionUrl = partUrl(extension.file, baseUrl);
  } catch {
    throw new EngineError('duckdb.error.loadFailed');
  }
  const bytes = await loadWasmBytes(
    manifest,
    {
      fetch: (url, init) => fetch(url, init),
      caches: typeof caches === 'undefined' ? undefined : caches,
      baseUrl,
    },
    onProgress,
  );
  try {
    return await withWasmUrl(bytes, async (url) => {
      // Only the `eh` bundle is shipped; DEFAULT_RUNTIME has no file system and no network.
      const bundle = { mainModule: url, mainWorker: '' };
      const bindings = await createDuckDB(
        { mvp: bundle, eh: bundle },
        new VoidLogger(),
        DEFAULT_RUNTIME,
      );
      await withTimeout(
        bindings.instantiate(() => undefined),
        INSTANTIATE_TIMEOUT_MS,
      );
      return new DuckDb(bindings, { jsonExtensionUrl });
    });
  } catch {
    throw new EngineError('duckdb.error.loadFailed');
  }
}

let pending: Promise<DuckDb> | null = null;
let current: DuckDb | null = null;

/**
 * The worker's one DuckDB, loaded on first use; a failed load can be retried by the next run. A
 * database broken by a WebAssembly trap is replaced by a new one (`DuckDb.broken`).
 */
export function loadDuckDb(onProgress?: (p: LoadProgress) => void): Promise<DuckDb> {
  if (current?.broken) {
    current = null;
    pending = null;
  }
  pending ??= open(onProgress).then(
    (db) => {
      current = db;
      return db;
    },
    (err: unknown) => {
      pending = null;
      throw err;
    },
  );
  return pending;
}
