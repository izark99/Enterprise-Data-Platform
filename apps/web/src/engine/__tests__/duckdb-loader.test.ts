import { afterEach, describe, expect, it, vi } from 'vitest';
import { EngineError } from '../core/errors';
import {
  CACHE_PREFIX,
  cacheName,
  loadWasmBytes,
  sha256Hex,
  withWasmUrl,
  type LoaderDeps,
} from '../duckdb/loader';
import { isDuckDbManifest, type DuckDbManifest } from '../duckdb/manifest';

/** DuckDB loader (T-R1-06 AC f, spec §13.1) with a fake `fetch` and a fake Cache Storage. */

const BASE = 'https://app.example.test/';

/** Fixed-seed bytes standing in for the `.wasm`. */
function fakeWasm(size: number): Uint8Array {
  const out = new Uint8Array(size);
  let x = 0x2545f491;
  for (let i = 0; i < size; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    out[i] = x & 0xff;
  }
  return out;
}

async function fakeBuild(size = 10_000, partBytes = 4_000) {
  const wasm = fakeWasm(size);
  const sha = await sha256Hex(wasm);
  const files = new Map<string, Uint8Array>();
  const parts = [];
  for (let i = 0, offset = 0; offset < size; i++, offset += partBytes) {
    const data = wasm.slice(offset, offset + partBytes);
    const file = `duckdb/1.32.0-${sha.slice(0, 12)}/duckdb-eh.wasm.part${i}`;
    files.set(BASE + file, data);
    parts.push({ file, bytes: data.length, sha256: await sha256Hex(data) });
  }
  const manifest: DuckDbManifest = { version: '1.32.0', totalBytes: size, sha256: sha, parts };
  return { wasm, manifest, files };
}

class FakeCache {
  readonly entries = new Map<string, { bytes: Uint8Array; type: string | null }>();

  async match(url: string): Promise<Response | undefined> {
    const hit = this.entries.get(url);
    return hit ? new Response(hit.bytes as Uint8Array<ArrayBuffer>) : undefined;
  }

  async put(url: string, res: Response): Promise<void> {
    const bytes = new Uint8Array(await res.arrayBuffer());
    this.entries.set(url, { bytes, type: res.headers.get('Content-Type') });
  }
}

class FakeCaches {
  readonly stores = new Map<string, FakeCache>();

  async keys(): Promise<string[]> {
    return [...this.stores.keys()];
  }

  async open(name: string): Promise<FakeCache> {
    let cache = this.stores.get(name);
    if (!cache) {
      cache = new FakeCache();
      this.stores.set(name, cache);
    }
    return cache;
  }

  async delete(name: string): Promise<boolean> {
    return this.stores.delete(name);
  }
}

interface FetchCall {
  url: string;
  init: RequestInit;
}

/** `fetch` serving `files`; `corrupt(url, n)` decides whether the n-th download of a URL is broken. */
function fakeFetch(
  files: Map<string, Uint8Array>,
  corrupt: (url: string, n: number) => boolean = () => false,
) {
  const calls: FetchCall[] = [];
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    calls.push({ url, init });
    const data = files.get(url);
    if (!data) return new Response(null, { status: 404 });
    const n = calls.filter((c) => c.url === url).length;
    const body = corrupt(url, n) ? data.map((b) => b ^ 0xff) : data;
    return new Response(body as Uint8Array<ArrayBuffer>);
  };
  return { fetch, calls };
}

function deps(fetch: LoaderDeps['fetch'], caches?: FakeCaches): LoaderDeps {
  return { fetch, caches: caches as unknown as CacheStorage | undefined, baseUrl: BASE };
}

const expectLoadFailed = async (work: Promise<unknown>): Promise<void> => {
  const err = await work.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(EngineError);
  expect((err as EngineError).messageKey).toBe('duckdb.error.loadFailed');
};

describe('DuckDB loader (AC f)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('loads good parts from the same origin, checks them and reports progress', async () => {
    const { wasm, manifest, files } = await fakeBuild();
    const { fetch, calls } = fakeFetch(files);
    const progress: number[] = [];
    const bytes = await loadWasmBytes(manifest, deps(fetch), (p) => progress.push(p.loadedBytes));
    expect(bytes).toEqual(wasm);
    expect(calls.map((c) => c.url)).toEqual([...files.keys()]);
    for (const c of calls) {
      expect(new URL(c.url).origin).toBe(new URL(BASE).origin);
      expect(c.init.credentials).toBe('same-origin');
    }
    expect(progress).toEqual([0, 4_000, 8_000, 10_000]);
  });

  it('keeps only the manifest-keyed WASM parts in Cache Storage and removes old DuckDB caches', async () => {
    const { wasm, manifest, files } = await fakeBuild();
    const caches = new FakeCaches();
    await caches.open(`${CACHE_PREFIX}1.31.0-${'0'.repeat(64)}`);
    await caches.open('someone-else');
    const first = fakeFetch(files);
    await loadWasmBytes(manifest, deps(first.fetch, caches));

    const name = cacheName(manifest);
    expect(name).toBe(`${CACHE_PREFIX}1.32.0-${manifest.sha256}`);
    expect((await caches.keys()).sort()).toEqual([name, 'someone-else'].sort());
    const store = caches.stores.get(name)!;
    expect([...store.entries.keys()]).toEqual([...files.keys()]);
    for (const [url, entry] of store.entries) {
      expect(entry.type).toBe('application/wasm');
      expect(entry.bytes).toEqual(files.get(url));
    }

    // A second load comes from the cache only.
    const second = fakeFetch(files);
    expect(await loadWasmBytes(manifest, deps(second.fetch, caches))).toEqual(wasm);
    expect(second.calls).toEqual([]);
  });

  it('reloads once when a part is bad, then fails with duckdb.error.loadFailed', async () => {
    const { manifest, files } = await fakeBuild();
    const bad = [...files.keys()][1]!;
    const caches = new FakeCaches();
    const { fetch, calls } = fakeFetch(files, (url) => url === bad);
    await expectLoadFailed(loadWasmBytes(manifest, deps(fetch, caches)));
    expect(calls.filter((c) => c.url === bad)).toHaveLength(2);
    expect(calls.filter((c) => c.url === bad).map((c) => c.init.cache)).toEqual([
      'default',
      'reload',
    ]);
    // Nothing half-verified stays behind.
    expect(await caches.keys()).toEqual([]);
  });

  it('recovers when the reload is good', async () => {
    const { wasm, manifest, files } = await fakeBuild();
    const bad = [...files.keys()][2]!;
    const { fetch, calls } = fakeFetch(files, (url, n) => url === bad && n === 1);
    expect(await loadWasmBytes(manifest, deps(fetch, new FakeCaches()))).toEqual(wasm);
    expect(calls.filter((c) => c.url === bad)).toHaveLength(2);
  });

  it('drops a corrupted cache and loads from the network once', async () => {
    const { wasm, manifest, files } = await fakeBuild();
    const caches = new FakeCaches();
    await loadWasmBytes(manifest, deps(fakeFetch(files).fetch, caches));
    const store = caches.stores.get(cacheName(manifest))!;
    const [firstUrl, entry] = [...store.entries][0]!;
    store.entries.set(firstUrl, { ...entry, bytes: entry.bytes.map((b) => b ^ 1) });

    const { fetch, calls } = fakeFetch(files);
    expect(await loadWasmBytes(manifest, deps(fetch, caches))).toEqual(wasm);
    expect(calls.map((c) => c.init.cache)).toEqual(['reload', 'reload', 'reload']);
    const fresh = caches.stores.get(cacheName(manifest))!;
    expect(fresh.entries.get(firstUrl)!.bytes).toEqual(files.get(firstUrl));
  });

  it('fails when a part cannot be downloaded twice', async () => {
    const { manifest, files } = await fakeBuild();
    files.delete([...files.keys()][0]!);
    const { fetch, calls } = fakeFetch(files);
    await expectLoadFailed(loadWasmBytes(manifest, deps(fetch)));
    expect(calls).toHaveLength(2);
  });

  it('fails when the parts are good but the whole file does not match', async () => {
    const { manifest, files } = await fakeBuild();
    const { fetch } = fakeFetch(files);
    await expectLoadFailed(loadWasmBytes({ ...manifest, sha256: 'a'.repeat(64) }, deps(fetch)));
  });

  it('refuses a manifest pointing outside duckdb/ or to another origin', async () => {
    const { manifest } = await fakeBuild();
    expect(isDuckDbManifest(manifest)).toBe(true);
    const withFile = (file: string) => ({
      ...manifest,
      parts: manifest.parts.map((p, i) => (i === 0 ? { ...p, file } : p)),
    });
    for (const file of [
      'https://cdn.example.test/duckdb/x/duckdb-eh.wasm.part0',
      '//cdn.example.test/duckdb/x/part0',
      '/duckdb/x/part0',
      'duckdb/../x/part0',
      'duckdb/x/../../part0',
      'other/x/part0',
    ]) {
      expect(isDuckDbManifest(withFile(file))).toBe(false);
    }
    expect(isDuckDbManifest({ ...manifest, totalBytes: manifest.totalBytes + 1 })).toBe(false);
    expect(isDuckDbManifest({ ...manifest, sha256: 'xyz' })).toBe(false);
    expect(isDuckDbManifest(null)).toBe(false);
  });

  it('hands the module over as a blob: URL and revokes it after start, also on failure', async () => {
    const revoke = vi.spyOn(URL, 'revokeObjectURL');
    const bytes = fakeWasm(64);
    let seen = '';
    const out = await withWasmUrl(bytes, async (url) => {
      seen = url;
      expect(url.startsWith('blob:')).toBe(true);
      expect(revoke).not.toHaveBeenCalled();
      return 'started';
    });
    expect(out).toBe('started');
    expect(revoke).toHaveBeenCalledWith(seen);

    revoke.mockClear();
    await expect(
      withWasmUrl(bytes, async (url) => {
        seen = url;
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(revoke).toHaveBeenCalledWith(seen);
  });
});

interface NodeFsModule {
  readFileSync(path: string): Uint8Array;
}
interface NodeModuleModule {
  createRequire(url: string): { resolve(id: string): string };
}
// Node built-ins without Node types in the app tsconfig (same pattern as `io/__tests__/helpers.ts`).
const nodeProcess = (
  globalThis as unknown as {
    process: {
      getBuiltinModule(id: 'node:fs'): NodeFsModule;
      getBuiltinModule(id: 'node:module'): NodeModuleModule;
    };
  }
).process;

declare const __HRFLOW_DUCKDB_MANIFEST__: unknown;

describe('manifest embedded by the build plugin (spec §13.1)', () => {
  it('describes the installed duckdb-eh.wasm in parts below 25 MiB that load and verify', async () => {
    const manifest: unknown = __HRFLOW_DUCKDB_MANIFEST__;
    expect(isDuckDbManifest(manifest)).toBe(true);
    const m = manifest as DuckDbManifest;
    const path = nodeProcess
      .getBuiltinModule('node:module')
      .createRequire(import.meta.url)
      .resolve('@duckdb/duckdb-wasm/dist/duckdb-eh.wasm');
    const wasm = new Uint8Array(nodeProcess.getBuiltinModule('node:fs').readFileSync(path));
    expect(m.version).toBe('1.32.0');
    expect(m.totalBytes).toBe(wasm.byteLength);
    expect(m.parts.length).toBeGreaterThan(1);
    for (const p of m.parts) expect(p.bytes).toBeLessThan(25 * 1024 * 1024);

    const files = new Map<string, Uint8Array>();
    let offset = 0;
    for (const p of m.parts) {
      files.set(BASE + p.file, wasm.subarray(offset, offset + p.bytes));
      offset += p.bytes;
    }
    const bytes = await loadWasmBytes(m, deps(fakeFetch(files).fetch));
    expect(bytes.byteLength).toBe(wasm.byteLength);
    expect(await sha256Hex(bytes)).toBe(m.sha256);
  });
});
