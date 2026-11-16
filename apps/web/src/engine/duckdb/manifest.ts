/**
 * `duckdb-manifest.json` (spec §13.1): the self-hosted `duckdb-eh.wasm` split at build time into
 * parts below the 25 MiB per-file limit of Cloudflare Pages. Written by the Vite plugin
 * (`apps/web/build/duckdb-wasm.ts`) and embedded in the engine bundle, so the worker always checks
 * the parts of its own build.
 */
export interface DuckDbManifest {
  /** `@duckdb/duckdb-wasm` package version. */
  readonly version: string;
  readonly totalBytes: number;
  /** SHA-256 (lower-case hex) of the whole `.wasm`. */
  readonly sha256: string;
  /** In order; `file` is a path relative to the app base URL. */
  readonly parts: readonly DuckDbManifestPart[];
}

export interface DuckDbManifestPart {
  readonly file: string;
  readonly bytes: number;
  readonly sha256: string;
}

/** Cloudflare Pages refuses files of 25 MiB or more; every `dist/` file must stay below. */
export const MAX_DEPLOY_FILE_BYTES = 25 * 1024 * 1024;
/** Size of each `.wasm` part (the last one is smaller). */
export const WASM_PART_BYTES = 20 * 1024 * 1024;
/** Path of the manifest in `dist/`, relative to the app base URL. */
export const MANIFEST_FILE = 'duckdb/duckdb-manifest.json';

const SHA256_HEX = /^[0-9a-f]{64}$/;
/** Same-origin relative path under `duckdb/`: no scheme, no `..`, no leading slash. */
const PART_FILE = /^duckdb\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

const isByteCount = (n: unknown): n is number =>
  typeof n === 'number' && Number.isSafeInteger(n) && n > 0;

/** Checks the shape of a manifest (the build output is trusted, a broken one is still refused). */
export function isDuckDbManifest(value: unknown): value is DuckDbManifest {
  if (typeof value !== 'object' || value === null) return false;
  const m = value as Record<string, unknown>;
  if (typeof m['version'] !== 'string' || m['version'] === '') return false;
  if (!isByteCount(m['totalBytes'])) return false;
  if (typeof m['sha256'] !== 'string' || !SHA256_HEX.test(m['sha256'])) return false;
  const parts = m['parts'];
  if (!Array.isArray(parts) || parts.length === 0) return false;
  let sum = 0;
  for (const p of parts as unknown[]) {
    if (typeof p !== 'object' || p === null) return false;
    const part = p as Record<string, unknown>;
    if (typeof part['file'] !== 'string' || !PART_FILE.test(part['file'])) return false;
    if (part['file'].split('/').includes('..')) return false;
    if (!isByteCount(part['bytes']) || part['bytes'] >= MAX_DEPLOY_FILE_BYTES) return false;
    if (typeof part['sha256'] !== 'string' || !SHA256_HEX.test(part['sha256'])) return false;
    sum += part['bytes'];
  }
  return sum === m['totalBytes'];
}
