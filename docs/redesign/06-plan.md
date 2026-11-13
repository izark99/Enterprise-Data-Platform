# 06 — Plan

> **Read this file first in every execution session** (skill `execute-task`).
> `src/` means `apps/web/src/`. The 32-task incremental plan of the previous repository is frozen in
> `docs/archive/refactor-plan-incremental.md`; its phase P2 is a source of detail for building `src/ui`.

## 1. Status

- 2026-11-13: full rewrite from the documents in this repository (ADR-012). The previous code was imported once, verified green (R-00), then removed from the tree (R-02). It stays readable in git: `git show 6fd5868:<path>`.
- The tree holds documents, `fixtures/`, `vendor/`, the agent system, the empty pnpm workspace of T-R0-01 (placeholder app, lint zones, the five checks) the T-R0-02 limits (bundle budget in `pnpm build`, `apps/web/public/_headers` guarded by `headers.test.ts`) and the T-R0-03 E2E harness (`pnpm test:e2e`: privacy + axe specs) with CI (`.github/workflows/ci.yml`). **P0 done; no feature code yet.** T-R1-01: `vite preview` sends the `_headers` security headers (minus HSTS), so E2E runs under the production CSP (`e2e/ui/csp.spec.ts`).
- P1 tasks written (§6b, MEMORY 2026-11-13 19:08). T-R1-01 done. Next task: **T-R1-02**.

## 2. Owner decisions

Settled (recorded in `docs/MEMORY.md`, 2026-11-13):

| Topic | Answer |
|-------|--------|
| Approach | Rewrite everything, engine included |
| Scope | Unchanged (HR Tools) |
| Old code | Deleted from the tree; build from the documents only |
| Engine | From scratch, from the documents |
| Database | From scratch, in a new Supabase project |

Not answered yet. The default in the last column is in force until the owner says otherwise:

| # | Question | A | B | Default in force |
|---|----------|---|---|------------------|
| 4 | E2E suite | Write a new suite from the documents (the old specs left with the old code) | Restore the old behavioural specs from git as the acceptance suite | A — follows from "build from the documents only" |
| 5 | Production | The previous repository keeps serving production until P7 | Stop production now | A |
| 6 | Phase order | Engine first (P1), then design system (P2): the engine is the largest risk and is checked by fixtures alone | Design system first, so GATE-1 / GATE-2 come early | A |
| 7 | Data of the old project (2 accounts, 2 flows, 3 versions, 1 reference table) | Not carried over; flows are re-created in the new Designer | Export the flow definitions and import them after P6 | A |
| 8 | Vietnamese UI texts edited by the owner (`docs/archive/locales-vi/`, 6 files) | Reuse them as the default texts of the new screens | Write new texts | A |

## 3. Owner actions

| Action | Needed by | Status |
|--------|-----------|--------|
| Make this repository private (Settings → General → Danger Zone) | Any time; it is public today (AUD-03) | todo |
| Approve the new Supabase project: name, region, free plan (a free organisation allows two active projects; the old one stays until P7) | Start of P3 | todo |
| Add GitHub secrets `SUPABASE_DB_URL`, `BACKUP_PASSPHRASE` for the new project | P3, after the project exists | todo |
| Point Cloudflare Pages at this repository | P7 | todo |

## 4. Phases

Tasks of a phase are written with the `clarify` skill when the phase starts (A-06-5); only P0 is detailed now.

| Phase | Builds | Specification | Exit criteria |
|-------|--------|---------------|---------------|
| P0 Foundation | Workspace, lint zones, bundle budget, security headers, E2E harness, CI | 02 §1.1, §3, §6.3, §7; 07 | Every check runs on an empty app; CI green |
| P1 Schema and engine | `packages/flow-schema`; `src/engine` (io, core, formula, duckdb, nodes, worker protocol) | `docs/archive/spec.md` §8–§14, §24, §27; 03 §3–§5; ADR-006 | S1: `fixtures/payroll-timesheet/expected.json` and the 180 cases of `fixtures/formula-golden/cases.json` reproduced (182 tests with the coverage check and the `golden-excel.xlsx` comparison); parsers fuzzed by `verifier`; one run of 1,000,000 rows × 30 columns completes |
| P2 Design system v3 | `src/ui`, showcase page | 04; ADR-005; archived plan P2 | Owner approves GATE-1 (tokens, first primitives) and GATE-2 (full set); guard test and axe pass |
| P3 Backend and data access | New Supabase project, migrations, RLS / RPC, Edge Function `admin-users`, keep-alive / backup / real-DB test workflows, `src/api`, `shared/auth` | 03 §2, §5–§8; ADR-004, ADR-010; 02 §6.4 | SQL tests green on the new project; security advisor reviewed; types match |
| P4 User screens | Sign-in, password change, idle sign-out, flow list, run wizard, result | 04 §4, §7; 02 §5.1 | Acceptance E2E: run the fixture flow and download a file equal to the expected result; privacy spec (no off-origin request, empty storage) |
| P5 Admin screens | Users / groups / assignments, flows and versions, reference tables, UI texts | 04 §3–§4; ADR-007 | E2E per screen: main path + error state |
| P6 Designer | Canvas, node forms, preview, save / publish | 04 §4; ADR-006; `spec.md` §24 | Node-coverage test; a 5–8 node flow built and published in the app |
| P7 Parity and cut-over | Check S1–S6 (00); production move | 00 | Owner runs the `release` skill; old repository archived |

## 5. Task rules and format

| Rule | Detail |
|------|--------|
| One task per session | Take the first `todo` task whose dependencies are `done`. |
| Every task ends green | Definition of done: `07-conventions.md` §10. |
| No scope growth | No feature, dependency, CSP change or schema change unless the task says so. |
| Sizes | S ≤ ½ session, M ≈ 1 session, L = 1 long session → delegate to `implementer`. A task expected to pass 400k subagent tokens or 12 acceptance criteria is split first. |
| Verification | Tasks marked **verify** and the last task of a phase end with the `verifier` subagent. |

Task format: `ID · Title · Size · Depends` — then Goal, Files, Steps, Acceptance criteria (AC), Verify (exact commands), Rollback (default: `git revert`).

## 6. Tasks — P0 Foundation

### T-R0-01 · Workspace and checks · M · Depends: —

**Goal.** A real, empty app on which every check runs, so each later task can end green.

**Files.** Create: `package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`, `tsconfig.base.json`, `.prettierrc.json`, `.prettierignore`, `eslint.config.js`, `apps/web/{package.json,index.html,vite.config.ts,tsconfig*.json}`, `apps/web/src/{main.tsx,index.css,app/App.tsx}`, `packages/flow-schema/{package.json,tsconfig.json,src/index.ts}`. Change: `CLAUDE.md`.

**Steps.**
1. pnpm 10 workspace (`apps/*`, `packages/*`); Node ≥ 22. Packages `@hrflow/web`, `@hrflow/flow-schema`. Root scripts with exactly these names: `dev`, `build`, `lint`, `typecheck`, `test`, `format`, `format:check`.
2. Install only what this task uses, only from 02 §1.1, at the versions listed there: TypeScript, React, Vite, Tailwind, Vitest, ESLint stack, Prettier, Zod. `xlsx` is not installed yet.
3. TypeScript `strict`; lint errors for `any`, `@ts-ignore`, missing `import type`, default exports. Prettier: `singleQuote`, `printWidth: 100`, `trailingComma: "all"`; ignore `*.md`, `.claude`, `fixtures`, `pnpm-lock.yaml`.
4. `eslint.config.js`: one `no-restricted-imports` zone per layer for the whole matrix of 02 §3 (`app`, `features/*`, `shared`, `api`, `ui`, `engine`), plus `no-console` and no React inside `src/engine/**`. Create the six folders with a `.gitkeep`.
5. `App.tsx` renders one placeholder heading through an i18n-free constant inside `<html lang="vi">`; one Vitest test in each package.
6. `CLAUDE.md`: replace the "Commands" section with the real commands (install, dev, the five checks, one test file).

**AC.** (a) `pnpm install --frozen-lockfile` exits 0 on a clean clone. (b) Each temporary probe fails `pnpm lint` and is then removed: a file in `src/engine` importing `react`; a file in `src/ui` importing `../api/x`; a file in `src/features/runner` importing `../admin/x`; a file in `src/features/runner` importing `../../engine/core/x`. (c) `git status --short fixtures/ vendor/` prints nothing.

**Verify.** `pnpm lint && pnpm format:check && pnpm typecheck && pnpm test && pnpm build`.

### T-R0-02 · Bundle budget and security headers · S · Depends: T-R0-01

**Goal.** The two limits that protect performance and the data boundary exist before any feature code.

**Files.** Create: `apps/web/bundle-budget.json`, `apps/web/scripts/check-bundle-size.mjs`, `apps/web/public/_headers`, `apps/web/src/app/__tests__/headers.test.ts`. Change: `apps/web/package.json` (`build` runs the check).

**Steps.**
1. Budget check per 02 §7: start-up JS (entry + `modulepreload` chunks, gzip level 9) ≤ 240 KiB; the five heavy libraries of 02 §7 must not be in the start-up JS (a library not installed yet is reported as "not present", not as a failure); CSS size is printed. `--measure` prints the numbers without failing.
2. `_headers` with the policy of 02 §6.3. Until P3 creates the project, `connect-src` is `'self' blob:` only.
3. `headers.test.ts` parses `_headers` and fails if `connect-src` names any host, if `script-src` allows `'unsafe-inline'` or `'unsafe-eval'`, or if a header of 02 §6.3 is missing.

**AC.** (a) `pnpm build` prints `bundle-budget: OK start-up JS … (limit 240.0 KiB …)`; record the number. (b) Adding `https://example.com` to `connect-src` makes `pnpm test` fail (then remove it).

**Verify.** The five commands of T-R0-01.

### T-R0-03 · E2E harness, privacy spec, CI · M · Depends: T-R0-02 · **verify (end of P0)**

**Goal.** Browser tests and CI run from the first screen on.

**Files.** Create: `playwright.config.ts`, `e2e/tsconfig.json`, `e2e/support/fixtures.ts`, `e2e/user/privacy.spec.ts`, `e2e/ui/a11y.spec.ts`, `.github/workflows/ci.yml`. Change: root `package.json` (`test:e2e`), `apps/web/package.json` (`build:e2e`), `CLAUDE.md` (E2E commands).

**Steps.**
1. `build:e2e` = `vite build --mode e2e`; `test:e2e` builds, then runs Playwright against `vite preview`. Chromium: `/opt/pw-browsers/chromium` when present, Playwright's own otherwise. Traces off by default. Test output goes to the OS temp directory.
2. `privacy.spec.ts`: load the app; fail on any request to another origin; `localStorage`, `sessionStorage` and IndexedDB are empty.
3. `a11y.spec.ts`: axe reports 0 violations on the placeholder page.
4. `ci.yml` on push and pull request: install, `lint`, `format:check`, `typecheck`, `test`, `build`, then a job that installs Chromium and runs `test:e2e`.

**AC.** (a) `pnpm test:e2e` passes locally; count recorded. (b) The CI run on the branch is green and linked in the Progress Log. (c) `verifier` verdict `PASS` for P0.

**Verify.** The five commands, `pnpm test:e2e`, the CI run.

## 6b. Tasks — P1 Schema and engine

Written 2026-11-13 with the `clarify` skill (MEMORY 2026-11-13 19:08, owner 1A 2A 3A 4A 5B). Behaviour source: `docs/archive/spec.md` (cited as `spec §…`), 03 §3–§5, ADR-006. Data in every test is fake (fixtures or generated); no real file is ever used. Engine code never logs (`no-console`), never touches DOM, never imports React. A node plugin = `configSchema` (flow-schema), `ports` / `inputPorts(config)`, `checkConfig`, `inferSchema` (may be async), and `execute` (TS) or `compile` (DuckDB SQL) — spec §12, ADR-006 (Designer parts of ADR-006 come in P6).

### T-R1-01 · Preview under the production CSP · S · Depends: T-R0-03

**Goal.** E2E runs the app under the CSP of `apps/web/public/_headers`, before P1 adds a worker and WASM (Q-06-3 item 4).

**Files.** Change: `apps/web/vite.config.ts`, `apps/web/tsconfig.node.json`, `apps/web/package.json` (`@types/node`), `docs/redesign/06-plan.md` (Q-06-3). Create: `e2e/ui/csp.spec.ts`.

**Steps.**
1. Install `@types/node@^22.18.0` as a devDependency of `@hrflow/web` (02 §1.1); add `"types": ["node"]` to `tsconfig.node.json` only. `tsconfig.app.json` keeps no Node types.
2. `vite.config.ts`: `preview.headers` = the headers of the `/*` block of `public/_headers`, parsed at config time, minus `Strict-Transport-Security` (would pin `localhost` to HTTPS).
3. `csp.spec.ts`: the response to `/` carries the same `Content-Security-Policy` string as `_headers`; loading the page fires no `securitypolicyviolation` event and no CSP console error.

**AC.** (a) `csp.spec.ts` passes. (b) Probe: an inline `<script>` added to `index.html` makes `csp.spec.ts` fail (then removed). (c) `pnpm --filter @hrflow/web exec tsc -p tsconfig.app.json` fails on a probe `process.env` in `src/` (then removed). (d) Q-06-3 item 4 marked done.

**Verify.** The five commands, `pnpm test:e2e`, the CI run.

### T-R1-02 · Flow schema package · M · Depends: T-R0-03

**Goal.** One Zod source for flow definitions, slots, params and the configs of every P1 node.

**Files.** Create in `packages/flow-schema/src/`: `identifier.ts`, `params.ts`, `slots.ts`, `nodes.ts`, `transforms.ts`, `flow.ts`, `migrate.ts`, `__tests__/*.test.ts`. Change: `index.ts`, `package.json` (`zod`), `apps/web/package.json` (`@hrflow/flow-schema: workspace:*`).

**Steps.**
1. Install `zod@^4.1.12` in `@hrflow/flow-schema` (only dependency of the package).
2. Schemas per spec §8 (flow, `ui` with `positions` and `notes`), §10 (slot: sheet modes, header rows, `stopAt`, `skipRows`, columns with `presence` / `required` / `defaultValue` / `rules` / `dateFormats`, `extraColumns`, `multiple`), 03 §3 (params incl. `isAsOfDate`, `log`), §9.4 data types, and the node configs of spec §12.1.1–§12.1.10, §12.2, §24.2 (`control.compare`) and §11 (`output.excel`), with the defaults written there.
3. `FlowDefinitionSchema` invariants (03 §3): unique node ids, edges reference existing nodes, unique slot keys, acyclic graph; each failure has its own issue path.
4. `migrateFlowDefinition` (spec §8.1): removes `.csv` from `accept`; a slot left with only `.csv` gets `.xlsx, .xls`; both return a notice naming the slot label. Input is never mutated.

**AC.** (a) `fixtures/payroll-timesheet/flow.json` parses. (b) Each invariant of step 3 has a failing test. (c) Every default of step 2 is asserted by a test that parses a minimal config. (d) `migrateFlowDefinition` returns the two notices and leaves its argument unchanged. (e) `IdentifierSchema` rejects a name starting with a digit, with a space and with a quote. (f) `pnpm --filter @hrflow/flow-schema test` lists ≥ 1 test file per source file.

**Verify.** The five commands.

### T-R1-03 · Engine core · L · Depends: T-R1-02

**Goal.** Columnar table, exact decimals, key normalisation, errors and the executor every node plugs into.

**Files.** Create in `src/engine/`: `core/{types.ts,decimal.ts,table.ts,keys.ts,errors.ts,planner.ts,executor.ts,perf.ts}`, `nodes/index.ts` (empty registry + plugin contract), `__tests__/*.test.ts`. Change: `apps/web/package.json`.

**Steps.**
1. Install `big.js@^7.0.1`, `@types/big.js@^7.0.0` (dev), `apache-arrow@17.0.0`.
2. `decimal.ts`: spec §9.4 storage rule (double only when `String(x) === big.toString()`, else exact text; reads always return `Big`); `decimalFromNumber` (15 significant digits, spec §9.4); half-up rounding to 10 places.
3. `table.ts`: one Arrow-style vector per column (typed arrays; text and dates as UTF-8 + offsets), spec §13; row count, column defs `{ key, title, type }`, slice, release.
4. `keys.ts`: `normalizeKeyPart` = NFC → collapse whitespace runs → trim → lowercase (03 §4.4).
5. `errors.ts`: `EngineError` = i18n key (`<node>.error.<code>`), node id, field path, numeric/text vars without cell values (03 §4.7).
6. `planner.ts`: topological order, port wiring, required-port and unknown-type checks; `executor.ts`: runs plugins in order, reports progress per node (rows out), releases a table as soon as no later node needs it, stops on the first error. `perf.ts`: User Timing marks with stage names only.

**AC.** (a) Decimal encoding round-trips 10,000 generated values (fixed seed) and `0.1 + 0.2` is exactly `0.3`. (b) `normalizeKeyPart` golden: NBSP, tab, double space, `ĐẶNG`/`đặng`, NFD input. (c) A 1,000,000-row × 30-column generated table is built in Vitest without error; its heap estimate is printed. (d) Planner rejects a cycle, a missing required port and an unknown node type, each with its key. (e) Executor releases intermediate tables (test with a spy plugin). (f) No file under `src/engine` imports React, DOM globals or `console` (lint). (g) Start-up JS unchanged (engine not reachable from `main.tsx`).

**Verify.** The five commands.

### T-R1-04 · Excel reading and slot validation · L · Depends: T-R1-03 · **verify**

**Goal.** Read `.xlsx` / `.xls` safely in the worker and produce the validation report of spec §10.

**Files.** Create in `src/engine/io/`: `zip.ts`, `xlsx-stream.ts`, `xls.ts`, `coerce.ts`, `headers.ts`, `validation.ts`, `__tests__/*`. Change: `apps/web/package.json`.

**Steps.**
1. Install `fflate@0.8.3` and `xlsx` from `vendor/xlsx-0.20.3.tgz` (checksum in `vendor/README.md`, verified before install).
2. `zip.ts` + `xlsx-stream.ts`: streaming `.xlsx` reader (`fflate` `Inflate`), cell values equal to SheetJS; archive limits of spec §13 and AC-B4-90 (2 GiB per entry, 1:200 above 16 MiB, per-file budget, declared-size and CRC checks) → `validation.fileTooLarge` / `validation.fileUnreadable`; ZIP64 / encrypted → `fileUnreadable`, never a SheetJS fallback.
3. `xls.ts`: `.xls` via SheetJS only below 64 MiB. `.csv` and other extensions rejected.
4. `headers.ts`: header rows (multi-row joined with " / "), alias match after normalisation (no diacritics, lowercase, single spaces), unmerge `fillDown`.
5. `coerce.ts` + `validation.ts`: every rule of spec §10 and 03 §4.6 (types, `presence`, `required`, `defaultValue`, `unique` with `normalizeKeyPart` across files, `skipRows.whenKeyContains`, `stopAt`, `_source_file`, error / warning levels, original Excel row numbers).

**AC.** (a) The 6 payroll fixture files give 75 payroll rows and 75 timesheet rows (AC-03); `MSNV` maps to `ma_nv` (AC-02). (b) Two files sharing one key → error on both files with file and row (AC-07). (c) Missing key column → exactly one error, no row errors (AC-08). (d) Generated zip bombs (each limit of AC-B4-90) stop early with `validation.fileTooLarge`, peak inflated bytes stay under the budget. (e) Bad CRC → `fileUnreadable`. (f) Streamed values equal SheetJS values on every fixture file. (g) `00123` kept as text; `"1,500"` gives a warning; header with no data rows gives a warning. (h) `verifier` fuzzes the readers (random bytes, truncated archives, malformed XML): no crash, no hang beyond the test timeout, only the two error keys.

**Verify.** The five commands; `verifier` report.

### T-R1-05 · Acceptance flow: input, compare, Excel output · L · Depends: T-R1-04

**Goal.** S1 part 1: the payroll–timesheet flow reproduces `fixtures/payroll-timesheet/expected.json` in TypeScript, without DuckDB.

**Files.** Create: `src/engine/nodes/{input-excel.ts,control-compare.ts,output-excel.ts}`, `src/engine/io/{excel-writer.ts,xlsx-stream-writer.ts}`, `src/engine/__tests__/payroll-timesheet.test.ts`. Change: `nodes/index.ts`, `apps/web/package.json`.

**Steps.**
1. Install `exceljs@^4.4.0`.
2. `input.excel` per spec §12.1.9 (schema from the slot, `_source_file` for multi-file slots, `extraColumns: 'keep'` runtime-only warning).
3. `control.compare` per spec §24.2 and 03 §4.3 (4 ports, `nullAsZero`, tolerance boundary, decimal arithmetic only).
4. `output.excel` per spec §11 (bold header, freeze row 1, auto-filter, widths, number formats by type); above 2,000,000 cells the streaming writer with the same layout.

**AC.** (a) Running `flow.json` on the 6 fixture files equals `expected.json` (63 match, 9 mismatched, 3 only payroll, 3 only timesheet — AC-04), compared field by field. (b) A 0.5 difference with tolerance 0.5 is a match (AC-05). (c) The written workbook has exactly the 4 sheet names of AC-06, bold header, frozen first row, auto-filter. (d) Raising the OT tolerance to 5 turns a 4-hour OT difference into a match (AC-10, engine level). (e) The written file read back by the T-R1-04 reader equals the result tables. (f) The streaming writer and ExcelJS produce the same cell values and styles on a 10,000-row table. (g) No DuckDB code is loaded by this flow (spec §13.1 lazy load; test asserts the loader is not called).

**Verify.** The five commands.

### T-R1-06 · DuckDB-WASM runtime · L · Depends: T-R1-03

**Goal.** A self-hosted, locked-down DuckDB with exact type mapping, loaded only when a flow needs it.

**Files.** Create: `apps/web/build/duckdb-wasm.ts` (Vite plugin), `src/engine/duckdb/{manifest.ts,loader.ts,db.ts,arrow-io.ts,sql.ts}`, `src/engine/__tests__/duckdb-node.ts` (test helper), tests. Change: `apps/web/vite.config.ts`, `apps/web/package.json`, `apps/web/bundle-budget.json` (only if a marker must change). Not changed: `apps/web/public/_headers` (02 §6.3 already allows `'wasm-unsafe-eval'`, `blob:` workers and `blob:` connects; any other CSP change needs the owner).

**Steps.**
1. Install `@duckdb/duckdb-wasm@1.32.0`.
2. Build plugin per spec §13.1: split `duckdb-eh.wasm` into parts < 25 MiB with `duckdb-manifest.json` (`version`, `totalBytes`, `sha256`, parts); fail the build if any `dist/` file is ≥ 25 MiB.
3. `loader.ts`: fetch parts same-origin, check each SHA-256 and the whole; Cache Storage keyed by version + sha256 (WASM only, old caches removed); one reload on mismatch, then `duckdb.error.loadFailed`; module given to DuckDB as a `blob:` URL revoked after start.
4. `db.ts`: `:memory:`, `enable_external_access = false`, `autoinstall_known_extensions = false`, `autoload_known_extensions = false`, then `lock_configuration = true`.
5. `arrow-io.ts` + `sql.ts`: the type table of spec §9.4 (decimal as text + `CAST` to `DECIMAL(38,10)`, never `DOUBLE`; `DOUBLE` results through `decimalFromNumber`; unsupported types → `sql.error.unsupportedType`; overflow → `duckdb.error.decimalOverflow`), hidden `__ord`, quoted identifiers checked by `IdentifierSchema`, values only as prepared parameters, `hrflow_norm_key` SQL macro.
6. Test helper: the same `duckdb-eh.wasm` through the Node blocking bindings (uses `@types/node`, test files only).

**AC.** (a) The four settings read back as set and `SET enable_external_access = true` fails. (b) `read_csv('https://…')`, `COPY … TO`, `LOAD httpfs` fail. (c) A prepared value `x' OR 1=1 --` comes back unchanged. (d) Every row of the §9.4 table round-trips; a `DOUBLE` never appears in generated SQL for decimals. (e) `hrflow_norm_key` equals `normalizeKeyPart` on the T-R1-03 golden list. (f) Loader unit tests (fake fetch / caches): good parts load; one bad part reloads once then gives `duckdb.error.loadFailed`; Cache Storage holds only the manifest-keyed WASM. (g) `pnpm build`: every `dist/` file < 25 MiB; DuckDB marker "not present" in start-up JS; start-up JS printed.

**Verify.** The five commands.

### T-R1-07 · Transform nodes and pushdown · L · Depends: T-R1-05, T-R1-06

**Goal.** The seven transform nodes and `output.preview`, compiled to DuckDB and chained without needless materialisation.

**Files.** Create: `src/engine/nodes/{transform-select,transform-filter,transform-sort,transform-join,transform-union,transform-group-by,transform-dedupe,output-preview}.ts`, `src/engine/duckdb/scope.ts`, tests. Change: `nodes/index.ts`, `core/executor.ts`.

**Steps.**
1. Each node exactly per spec §12.1 common rules and §12.1.1–§12.1.7, §12.1.10: ports, config defaults, output schema, row order by `__ord`, blank handling, error and warning keys.
2. `transform.sort` with any `string` column runs in TS with `Intl.Collator('vi')` (stable); otherwise in DuckDB. `groupBy` `avg` = DuckDB `SUM` / `COUNT` divided with big.js, half-up 10 places; `min`/`max` on text in binary order.
3. Pushdown (spec §13.1 "Thực thi"): consecutive DuckDB nodes become views; materialise only before a TS node, for a preview, or when an output feeds several nodes.

**AC.** (a) Each node has tests for every error key it lists in spec §12.1. (b) Row-order tests for join (left `__ord`, then right-only rows), union, groupBy (first appearance), dedupe (`removed` port). (c) Sort: "Đ" after "D" and before "E"; equal rows keep order. (d) Join: blank keys never match; `rowsMultiplied` warning carries a count, no key value. (e) Filter: a condition on an empty parameter is skipped. (f) `avg` of `0.1, 0.2` is exactly `0.15`. (g) A chain select → filter → join → groupBy materialises once (counted). (h) `output.preview` keeps `maxRows` rows and sets the truncated flag. (i) The inferred schema of every node equals the schema of its run result on a fixture-based flow.

**Verify.** The five commands.

### T-R1-08 · `code.sql` and its guard · M · Depends: T-R1-07

**Goal.** Admin SQL that can only read its input views.

**Files.** Create: `src/engine/nodes/code-sql.ts`, `src/engine/duckdb/sql-guard.ts`, tests. Change: `nodes/index.ts`.

**Steps.**
1. Node per spec §12.1.8: one view per input port (no `__ord`), schema by `DESCRIBE` on empty typed tables, column-name rules, `title` inheritance.
2. Guard per spec §9.2 with DuckDB's own parser (no regex): one `SELECT` / `WITH … SELECT`; rejects `COPY`, `ATTACH`, `INSTALL`, `LOAD`, `EXPORT`, `PRAGMA`, `SET`, DDL / DML and file / URL table functions.
3. Parameters `$key` bound as `VARCHAR` values in the canonical format of spec §9.2; unknown parameter → `sql.error.unknownParam`. DuckDB's raw message (≤ 500 chars) goes only into the result shown on screen, never to logs.

**AC.** (a) Every forbidden statement kind of step 2 gives `sql.error.forbidden` or `notSelect`, including inside a CTE and with comments / casing tricks. (b) Two statements → `sql.error.multipleStatements`. (c) A parameter value with a quote is returned unchanged and never appears in the SQL text. (d) `DESCRIBE` schema equals the run schema. (e) `DOUBLE` result column → decimal plus the Designer warning key. (f) Run log fields contain only `sql.error.runtime`, never the raw message (test on the error object).

**Verify.** The five commands.

### T-R1-09 · `transform.formula` · L · Depends: T-R1-07

**Goal.** S1 part 2: Excel formulas transpiled to DuckDB SQL reproduce the 180 golden cases.

**Files.** Create: `src/engine/formula/{parser.ts,functions.ts,refs.ts,compile.ts,public.ts}`, `src/engine/nodes/transform-formula.ts`, `src/engine/__tests__/formula-golden.test.ts`, tests. Change: `nodes/index.ts`.

**Steps.**
1. Parser, references and functions per spec §9.1 (41 functions) and §12.2 (syntax, `[Title]` / `[key]`, `]]`, forward reference, depth 64, `tooComplex`, `;` hint).
2. Compiler: whitelist only; constants and parameters as prepared values; `DECIMAL(38,10)` everywhere; blank, rounding, string, date and implicit-conversion semantics of spec §12.2; `#DIV/0!`, `#VALUE!`, `#NUM!` with `IFERROR` and `onError`.
3. `public.ts` = the surface of 02 §3 (`FUNCTIONS`, `FUNCTION_GROUPS`, `escapeRef`, `toDisplay`, `toStored`, `FormulaError`, `RefColumn`, `FormulaParamDef`).
4. Golden test: the 180 cases of `fixtures/formula-golden/cases.json`, the coverage check (every §9.1 function except `PARAM` has ≥ 3 cases), and the comparison with the cached values of `golden-excel.xlsx` (15 significant digits; intended differences listed in the test, from the `excel` / `note` fields).

**AC.** (a) 182 golden tests pass (180 + coverage + Excel). (b) AC-B4-02, -03, -04, -05, -06 as tests. (c) AC-B4-07 … -12 as tests. (d) AC-B4-13, -14: generated SQL contains neither parameter values nor string constants. (e) AC-B4-15 type inference. (f) AC-B4-20 … -24 runtime errors, warning without cell values. (g) AC-B4-16 order and schema. (h) Start-up JS unchanged when `formula/public.ts` is imported by a probe in `src/app` (A-02-1), then the probe is removed.

**Verify.** The five commands.

### T-R1-10 · Worker, protocol and engine E2E · L · Depends: T-R1-08, T-R1-09 · **verify (end of P1)**

**Goal.** The engine runs in a Web Worker behind a typed protocol, end to end in Chromium, including one 1,000,000 × 30 run in CI.

**Files.** Create: `src/engine/{worker.ts,protocol.ts,session.ts,design.ts,preview.ts}`, `src/shared/engine/engine-client.ts`, `apps/web/e2e-engine.html` + `apps/web/src/e2e-engine/harness.ts` (E2E build only), `e2e/engine/{acceptance.spec.ts,perf.spec.ts}`. Change: `eslint.config.js` (the `engine-client.ts` exception of 02 §3), `apps/web/vite.config.ts` (second entry only in `--mode e2e`), `.github/workflows/ci.yml` (job `perf`), `apps/web/package.json` (`comlink`), `docs/redesign/02-target-architecture.md` §4 (harness page).

**Steps.**
1. Install `comlink@^4.4.2`. `protocol.ts` (public surface of 02 §3): messages for upload / validate / run / rows page / download / cancel / design check / preview; no message carries file content back to the main thread except the result file blob and row pages requested by the UI.
2. `session.ts` (run lifecycle, cancel = terminate + restart, results released on new run), `design.ts` (`checkConfig` + `inferSchema` for a whole flow, spec §13.2, errors upstream suppress downstream), `preview.ts` (ancestors only, 200 rows per port, spec §13.3).
3. `engine-client.ts`: the only main-thread entry; the lint exception of 02 §3 configured and a probe from `features/` into `engine/worker` still fails lint.
4. Harness page, built only with `--mode e2e`: calls `engine-client` to load files picked by Playwright, run a flow and expose the result summary; also generates the fake 1,000,000 × 30 workbook inside the worker (fixed seed), so no data file is written to disk.
5. `acceptance.spec.ts`: the payroll fixture flow in Chromium equals `expected.json`; a formula + transform flow runs with DuckDB loaded from the split parts; the privacy assertions of `e2e/user/privacy.spec.ts` hold on the harness page.
6. `perf.spec.ts` (only with `HRFLOW_PERF=1`) and CI job `perf` (needs `e2e`, own runner, `timeout-minutes: 45`): input.excel → filter → join → groupBy → formula (10 columns) → output.excel on 1,000,000 × 30; prints stage timings (names and durations only).

**AC.** (a) Production `dist/` contains no `e2e-engine.html` and no harness code. (b) `acceptance.spec.ts` passes in CI. (c) Cancel during a run stops it and the next run works. (d) No off-origin request, empty storage except the DuckDB Cache Storage entry, on the harness page. (e) The `perf` job completes without a crash; timings recorded in the Progress Log. (f) Start-up JS ≤ 240 KiB with the five heavy libraries "not present". (g) `verifier` verdict `PASS` for P1, with S1 checked (expected.json, 182 golden tests) and the readers fuzzed (T-R1-04 report reused or re-run).

**Verify.** The five commands, `pnpm test:e2e`, the CI run including `perf`.

## 7. Product backlog (after P7)

Each item starts with the `clarify` skill.

| ID | Item | Source | Notes |
|----|------|--------|-------|
| B-01 | Reference tables round 2: node `input.refTable`, version by as-of date, `flow_versions.ref_tables`, User read policy, `fromRefTable` parameter, run log `ref_versions` | `docs/archive/PLAN.md` M1; `docs/archive/spec.md` §34 AC-RT-07…10 | Can be designed into P1 / P3 if the owner asks |
| B-02 | Owner builds 2 real flows; friction log | PLAN M2 | Measures S7 (00) |
| B-03 | Designer ease of use: auto-connect new node, drag from port to add, "create input slot from sample file", "duplicate flow", Vietnamese port labels | PLAN M3 | |
| B-04 | Activity history screen (run logs + audit logs with filters) | PLAN M4 | Adds a "Hệ thống" menu item |
| B-05 | Result screen for flows without `control.compare` | AUD-18 | Decide the content in P4 |
| B-06 | `output.template` (Excel template fill) | PLAN M5 | Needs a real report template from the owner |
| B-07 | Engine MINOR items of the previous implementation | AUD-31 | Check whether the new engine has them at all |
| B-08 | `code.python`, `output.chart`, English UI, dark mode | PLAN §6 | Only when the owner asks |
| B-09 | Owner runs the performance script on the real laptop (AC-B3-24) | PLAN M0.6 | Owner action, after P4 |

## 8. Assumptions and open questions

| ID | Type | Statement |
|----|------|-----------|
| A-06-1 | ASSUMPTION | Feature work (§7) waits until P7. |
| A-06-2 | ASSUMPTION | "From the documents only" allows reading the previous implementation in git history to close a gap in the documents, provided the answer is written into the documents and no code is copied. |
| A-06-3 | ASSUMPTION | Defaults 4A, 5A, 6A, 7A, 8A of §2 are in force until the owner answers. |
| A-06-4 | ASSUMPTION | Dependencies stay those of 02 §1.1 at the listed versions; a newer major version needs the owner's approval. |
| A-06-5 | ASSUMPTION | Tasks are written phase by phase, not all up front, because later phases depend on what the earlier ones teach. |
| A-06-6 | ASSUMPTION | Still waiting for the owner's confirmation: `docs/MEMORY.md` is consulted on demand, not auto-loaded (ADR-008 A-08-1); the two changes to the agent-system design (08 A-08-4, A-08-5). |
| A-06-7 | DECISION (MEMORY 2026-11-13 19:33, 1A) | T-R1-10 adds an E2E-only harness page (`apps/web/e2e-engine.html`, built only with `--mode e2e`, like `e2e-showcase.html` of 02 §4) because P1 has no screens. |
| A-06-8 | DECISION (MEMORY 2026-11-13 19:33, 2A) | The CI job `perf` (owner 5B) runs on every push and pull request like the other jobs while the repository is public. Free for a public repository; once the repository is private it uses Actions minutes (2,000 / month on the free plan) and the runner has less memory (7 GB): then it runs only on push to `main` and on manual dispatch. |
| Q-06-1 | OPEN QUESTION | Which UI decisions recorded in `docs/MEMORY.md` for the old screens carry over. Default: those not contradicted by 04 stay in force. |
| Q-06-2 | OPEN QUESTION | 03 summarises the old schema in 337 lines; the six migration files it was written from are gone from the tree. Gaps found in P3 are settled with the owner, not guessed. |
| Q-06-3 | DECIDED (MEMORY 2026-11-13 18:35, 3A) | P0 verifier MINOR findings, not fixed in T-R0-03; `clarify` puts each into a task of the phase that makes it matter (no extra P0 task): (1) `headers.test.ts` accepts scheme-only `connect-src` sources such as `https:` / `wss:` (allow-list instead, P3); (2) the privacy fixture does not see WebSocket connections (P3, Supabase realtime); (3) the privacy spec does not check cookies, Cache Storage, OPFS (P4); (4) ~~`vite preview` does not serve `_headers`, so E2E does not run under the production CSP (before P1 adds the worker)~~ done in T-R1-01; (5) CI actions pinned by tag, not by SHA. |

## 9. Progress Log

Status values: `todo` · `in progress` · `waiting-owner` · `done` · `blocked`. One row per task; updated in the same commit as the work.

| ID | Status | Date | Notes (numbers measured at completion) |
|----|--------|------|----------------------------------------|
| R-00 Import previous implementation | done | 2026-11-13 | Commit `6fd5868`: one snapshot of the previous repository at `fb1ba03`, tree byte-identical (`diff -rq`). Measured here: lint, format:check, typecheck, build exit 0; unit tests 1,348 passed / 4 expected-fail / 12 skipped; fixtures 188 / 188; start-up JS 214.6 KiB gzip; CSS 38.5 KiB gzip; E2E `privacy` + `acceptance` + `auth` 10 / 10. Full E2E (517 tests in 52 files by `--list`) not run. |
| R-01 Documents and agent system | done | 2026-11-13 | Commit `844301a`. Old documents frozen in `docs/archive/`; `CLAUDE.md` rewritten; rules, skills, subagents, hooks built (08). Verifier frontmatter hook not exercised with a live subagent. |
| R-02 Remove previous code; rewrite plan | done | 2026-11-13 | 473 tracked files removed (`apps`, `packages`, `e2e`, `supabase`, `scripts`, `.github`, root tooling). Kept: `fixtures/` (14 files, unchanged), `vendor/` (2), `docs/archive/locales-vi/` (6 text files), old README in the archive. Stack versions and the full CSP copied into 02 before removal. Hook tests re-run: 08 §4. No runnable checks exist until T-R0-01. |
| T-R0-01 | done | 2026-11-13 | pnpm 10.28.0 workspace (`@hrflow/web`, `@hrflow/flow-schema`), Node 22.23.4. Owner added `@types/react`, `@types/react-dom` and the ESLint-stack versions to 02 §1.1 (1A, 2A). Five checks exit 0; unit tests 2 / 2 (1 per package); start-up JS 219.6 KiB raw / 68.6 KiB gzip (Vite report, level-9 check comes in T-R0-02); CSS 1.47 KiB gzip. AC (a) `pnpm install --frozen-lockfile` exit 0 on a copy of the tracked files without `node_modules`; (b) 4 / 4 probes fail `pnpm lint` and were removed; (c) `git status --short fixtures/ vendor/` empty. Layer zones are `no-restricted-imports` regexes generated per folder depth (max 10) in `eslint.config.js`; the `engine-client.ts` exception of 02 §3 is not configured yet. No subagent used. |
| T-R0-02 | done | 2026-11-13 | `pnpm build` runs `apps/web/scripts/check-bundle-size.mjs`: `bundle-budget: OK start-up JS 66.2 KiB gzip in 1 file(s) (limit 240.0 KiB, zlib level 9); CSS 1.4 KiB gzip in 1 file(s)`; the 5 heavy libraries reported "not present" (none installed), so the marker check (markers taken from the previous `bundle-budget.json`) is not yet exercised on a real library. CSS is printed only (no limit in this task). `_headers` = 02 §6.3 with `connect-src 'self' blob:`. Five checks exit 0; unit tests 5 / 5 (web 4, flow-schema 1). AC (a) recorded above; (b) `https://example.com` in `connect-src` → `pnpm test` 1 failed / 3 passed, then reverted. Extra probes: `'unsafe-eval'` in `script-src` and a missing COOP header each fail the test; a 10 KiB limit makes the check exit 1, `--measure` exits 0. The test reads `_headers` via Vite `?raw` (no `@types/node`); the script imports `node:process` (no ESLint config change). No subagent used. |
| T-R0-03 | done | 2026-11-13 | `@playwright/test` 1.64.1 + `@axe-core/playwright` 4.14.0 (only these). `pnpm test:e2e` 3 / 3 passed (privacy 2, axe 1), `/opt/pw-browsers/chromium`, traces off, output in `$TMPDIR/hrflow-e2e`. Probe: an off-origin `fetch` + `localStorage` + IndexedDB write in `main.tsx` → both privacy tests failed, then reverted. Axe first reported `landmark-one-main` / `region`: placeholder wrapped in `<main>`, `App.test.tsx` expectation updated (still exact). No `@types/node`: Node-only config values in `e2e/support/node-env.mjs` (+ `.d.mts`); root `typecheck` also runs `tsc -p e2e/tsconfig.json`. Five checks exit 0; unit tests 5 / 5; start-up JS 66.2 KiB gzip (limit 240.0), CSS 1.4 KiB. CI green: https://github.com/izark99/Enterprise-Data-Platform/actions/runs/43417424001 (`checks` + `e2e`). `verifier` on `1a737bb^..11e647b`: PASS, 0 BLOCKING / 0 MAJOR, 5 MINOR → Q-06-3; ~43k subagent tokens. |
| T-R1-01 | done | 2026-11-13 | `@types/node` `^22.18.0` (resolved 22.20.5, + `undici-types` 6.21.0 transitive) as devDependency of `@hrflow/web`; `"types": ["node"]` only in `tsconfig.node.json`. `vite.config.ts` parses the `/*` block of `public/_headers` into `preview.headers`, minus HSTS (`curl -sI` on preview: CSP, XCTO, XFO, Referrer, Permissions, COOP present, no HSTS). Spec reads the expected CSP via a new `productionCsp` export of `e2e/support/node-env.mjs` (E2E still has no Node types: a probe `process.env` in `e2e/` fails `tsc -p e2e/tsconfig.json`). `pnpm test:e2e` 5 / 5 (csp 2, axe 1, privacy 2). AC (b) inline `<script>` in `index.html` → `csp.spec.ts` 1 failed (`script-src-elem inline`) / 4 passed, then removed; (c) `process.env` probe in `src/` → `tsc -p tsconfig.app.json` TS2591 exit 2, removed → exit 0; (d) Q-06-3 (4) marked done. Five checks exit 0; unit tests 5 / 5; start-up JS 66.2 KiB gzip (limit 240.0), CSS 1.4 KiB. No subagent used. |
| T-R1-02 | todo | | |
| T-R1-03 | todo | | |
| T-R1-04 | todo | | |
| T-R1-05 | todo | | |
| T-R1-06 | todo | | |
| T-R1-07 | todo | | |
| T-R1-08 | todo | | |
| T-R1-09 | todo | | |
| T-R1-10 | todo | | |
