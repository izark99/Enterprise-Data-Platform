# vendor/

Third-party packages committed to the repository because they are not published to the npm
registry. pnpm installs them via `file:` dependencies and records their integrity in
`pnpm-lock.yaml`, so `pnpm install --frozen-lockfile` fails if a tarball is changed.

## xlsx-0.20.3.tgz — SheetJS Community Edition

| Field       | Value                                                                       |
| ----------- | --------------------------------------------------------------------------- |
| Package     | `xlsx` (SheetJS CE)                                                         |
| Version     | 0.20.3                                                                      |
| Source      | https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz                         |
| License     | Apache-2.0 (see `package/LICENSE` inside the tarball)                       |
| SHA-256     | `8dc73fc3b00203e72d176e85b50938627c7b086e607c682e8d3c22c02bb99fe8`          |
| Used by     | `apps/web` (`"xlsx": "file:../../vendor/xlsx-0.20.3.tgz"`) — reading Excel |

SheetJS stopped publishing to the npm registry after 0.18.5; current versions are distributed
only from cdn.sheetjs.com.

## duckdb-json-1.4.3-wasm_eh.duckdb_extension.wasm — DuckDB `json` extension

| Field       | Value                                                                              |
| ----------- | ---------------------------------------------------------------------------------- |
| Package     | DuckDB `json` extension, WebAssembly build for the `eh` bundle                     |
| Version     | DuckDB v1.4.3 (the engine of `@duckdb/duckdb-wasm` 1.32.0)                         |
| Source      | https://extensions.duckdb.org/v1.4.3/wasm_eh/json.duckdb_extension.wasm            |
| License     | MIT (DuckDB); signed by the DuckDB Foundation (DuckDB checks the signature on load) |
| Size        | 820,646 bytes                                                                      |
| SHA-256     | `b997276c8e15cc3ebdeda340d73d15dc1c4f4755ad281280451cb0a2f79302e9`                 |
| Used by     | `apps/web` DuckDB runtime: loaded once before the configuration is locked, for the `code.sql` guard (`json_serialize_sql`, owner 1A of T-R1-08) |

The `eh` bundle links only `core_functions` statically, and the locked configuration refuses to
load extensions, so the parser behind `json_serialize_sql` is shipped here and loaded first. The
build copies it to `dist/` same-origin and checks this SHA-256; the file name must stay
`json.duckdb_extension.wasm` when served (DuckDB derives the extension name from it).

### Upgrading

When `@duckdb/duckdb-wasm` moves to a new DuckDB version, download
`https://extensions.duckdb.org/v<duckdb-version>/wasm_eh/json.duckdb_extension.wasm`, replace this
file (new name with the version), update the table above and the checksum the build checks.

### Upgrading

1. Download the new tarball from `https://cdn.sheetjs.com/xlsx-<version>/xlsx-<version>.tgz`
   into this folder and delete the old one.
2. Verify it: `sha256sum vendor/xlsx-<version>.tgz`, check `package/package.json` (name,
   version, license) and the SheetJS changelog.
3. Update the `xlsx` dependency in `apps/web/package.json`, run `pnpm install`, and update the
   table above (version, source, SHA-256).
