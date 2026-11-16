import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin, ResolvedConfig } from 'vite';
import {
  JSON_EXTENSION_NAME,
  MANIFEST_FILE,
  MAX_DEPLOY_FILE_BYTES,
  WASM_PART_BYTES,
  type DuckDbExtensionFile,
  type DuckDbManifest,
} from '../src/engine/duckdb/manifest.ts';

/**
 * Self-hosted DuckDB-WASM (spec §13.1). `duckdb-eh.wasm` (~34 MB) is above the 25 MiB per-file
 * limit of Cloudflare Pages, so the build splits it into parts of `WASM_PART_BYTES` and writes
 * `duckdb/duckdb-manifest.json` (`{ version, totalBytes, sha256, parts: [{ file, bytes, sha256 }] }`).
 * The same manifest is embedded in the engine through the `__HRFLOW_DUCKDB_MANIFEST__` define, so
 * the worker checks the parts of its own build. Part paths carry the version and the checksum, so
 * the parts of two builds never mix. `vite dev` serves the parts from memory.
 *
 * The vendored DuckDB `json` extension (`vendor/README.md`, MEMORY 2026-11-16 14:30) is copied
 * next to the parts as `duckdb/<version>-<checksum>/json.duckdb_extension.wasm` (DuckDB derives the
 * extension name from the file name) and embedded as `__HRFLOW_DUCKDB_JSON_EXTENSION__`; the build
 * (and `vite dev`) fails when its SHA-256 is not `JSON_EXTENSION_SHA256` (owner 2A: checked at build
 * time; at run time DuckDB checks the extension's signature).
 *
 * After the build every file of the output directory must be below 25 MiB, else the build fails.
 */

const require = createRequire(import.meta.url);

interface Split {
  readonly manifest: DuckDbManifest;
  readonly parts: readonly { readonly file: string; readonly data: Buffer }[];
}

let cached: Split | undefined;

/** `vendor/duckdb-json-1.4.3-wasm_eh.duckdb_extension.wasm` (checksum of `vendor/README.md`). */
const JSON_EXTENSION_VENDOR_FILE = fileURLToPath(
  new URL('../../../vendor/duckdb-json-1.4.3-wasm_eh.duckdb_extension.wasm', import.meta.url),
);
export const JSON_EXTENSION_SHA256 =
  'b997276c8e15cc3ebdeda340d73d15dc1c4f4755ad281280451cb0a2f79302e9';

interface Extension {
  readonly entry: DuckDbExtensionFile;
  readonly data: Buffer;
}

let cachedExtension: Extension | undefined;

const sha256 = (data: Buffer): string => createHash('sha256').update(data).digest('hex');

/** Splits the `.wasm` of the installed `@duckdb/duckdb-wasm` (read once per process). */
export function splitDuckDbWasm(): Split {
  if (cached) return cached;
  const wasmPath = require.resolve('@duckdb/duckdb-wasm/dist/duckdb-eh.wasm');
  const wasm = readFileSync(wasmPath);
  const pkg = JSON.parse(readFileSync(join(dirname(wasmPath), '..', 'package.json'), 'utf8')) as {
    version: string;
  };
  const whole = sha256(wasm);
  const dir = `duckdb/${pkg.version}-${whole.slice(0, 12)}`;
  const parts: { file: string; data: Buffer }[] = [];
  for (let i = 0, offset = 0; offset < wasm.length; i++, offset += WASM_PART_BYTES) {
    parts.push({
      file: `${dir}/duckdb-eh.wasm.part${i}`,
      data: wasm.subarray(offset, offset + WASM_PART_BYTES),
    });
  }
  cached = {
    manifest: {
      version: pkg.version,
      totalBytes: wasm.length,
      sha256: whole,
      parts: parts.map((p) => ({ file: p.file, bytes: p.data.length, sha256: sha256(p.data) })),
    },
    parts,
  };
  return cached;
}

/** The vendored `json` extension at its served path; throws when its SHA-256 is not the pinned one. */
export function jsonExtension(): Extension {
  if (cachedExtension) return cachedExtension;
  const data = readFileSync(JSON_EXTENSION_VENDOR_FILE);
  const digest = sha256(data);
  if (digest !== JSON_EXTENSION_SHA256) {
    throw new Error(
      `vendor/: the DuckDB json extension has SHA-256 ${digest}, expected ${JSON_EXTENSION_SHA256}`,
    );
  }
  const dir = dirname(splitDuckDbWasm().parts[0]!.file);
  cachedExtension = {
    entry: { file: `${dir}/${JSON_EXTENSION_NAME}`, bytes: data.length, sha256: digest },
    data,
  };
  return cachedExtension;
}

function listFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? listFiles(path) : [path];
  });
}

/** Files of `outDir` of 25 MiB or more, relative to `outDir`. */
export function oversizedFiles(outDir: string): string[] {
  return listFiles(outDir)
    .filter((file) => statSync(file).size >= MAX_DEPLOY_FILE_BYTES)
    .map((file) => relative(outDir, file));
}

const BLOCKING_BINDINGS = '@duckdb/duckdb-wasm/blocking';

/**
 * `@duckdb/duckdb-wasm/blocking` outside Node points at `dist/duckdb-node-blocking.mjs`, a file the
 * package does not ship. Browser builds (the app and, once it exists, the engine worker) get the
 * synchronous browser bindings `dist/duckdb-browser-blocking.mjs` instead; it has the same API as
 * the exported types. Node (Vitest) keeps the package's own `node` export.
 */
export function duckDbBrowserBindings(): Plugin {
  return {
    name: 'hrflow:duckdb-browser-bindings',
    enforce: 'pre',
    resolveId(id, _importer, options) {
      if (id !== BLOCKING_BINDINGS || options.ssr) return null;
      return join(
        dirname(require.resolve('@duckdb/duckdb-wasm/dist/duckdb-eh.wasm')),
        'duckdb-browser-blocking.mjs',
      );
    },
  };
}

/** Emits the parts + manifest, embeds the manifest, serves the parts in dev, checks file sizes. */
export function duckDbWasm(): Plugin[] {
  return [duckDbBrowserBindings(), duckDbAssets()];
}

function duckDbAssets(): Plugin {
  let config: ResolvedConfig | undefined;
  return {
    name: 'hrflow:duckdb-wasm',
    config() {
      return {
        define: {
          __HRFLOW_DUCKDB_MANIFEST__: JSON.stringify(splitDuckDbWasm().manifest),
          __HRFLOW_DUCKDB_JSON_EXTENSION__: JSON.stringify(jsonExtension().entry),
        },
      };
    },
    configResolved(resolved) {
      config = resolved;
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = (req.url ?? '').split('?')[0]!.replace(/^\//, '');
        if (!path.startsWith('duckdb/')) return next();
        const split = splitDuckDbWasm();
        if (path === MANIFEST_FILE) {
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(split.manifest));
          return;
        }
        const ext = jsonExtension();
        if (path === ext.entry.file) {
          res.setHeader('Content-Type', 'application/wasm');
          res.end(ext.data);
          return;
        }
        const part = split.parts.find((p) => p.file === path);
        if (!part) return next();
        res.setHeader('Content-Type', 'application/octet-stream');
        res.end(part.data);
      });
    },
    generateBundle() {
      const split = splitDuckDbWasm();
      for (const part of split.parts) {
        this.emitFile({ type: 'asset', fileName: part.file, source: part.data });
      }
      const ext = jsonExtension();
      this.emitFile({ type: 'asset', fileName: ext.entry.file, source: ext.data });
      this.emitFile({
        type: 'asset',
        fileName: MANIFEST_FILE,
        source: `${JSON.stringify(split.manifest, null, 2)}\n`,
      });
    },
    closeBundle() {
      if (config?.command !== 'build') return;
      const outDir = resolve(config.root, config.build.outDir);
      const tooBig = oversizedFiles(outDir);
      if (tooBig.length > 0) {
        throw new Error(
          `Files of 25 MiB or more cannot be deployed to Cloudflare Pages: ${tooBig.join(', ')}`,
        );
      }
    },
  };
}
