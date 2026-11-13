# 06 — Plan

> **Read this file first in every execution session** (skill `execute-task`).
> `src/` means `apps/web/src/`. The 32-task incremental plan of the previous repository is frozen in
> `docs/archive/refactor-plan-incremental.md`; its phase P2 is a source of detail for building `src/ui`.

## 1. Status

- 2026-11-13: full rewrite from the documents in this repository (ADR-012). The previous code was imported once, verified green (R-00), then removed from the tree (R-02). It stays readable in git: `git show 6fd5868:<path>`.
- The tree holds documents, `fixtures/`, `vendor/`, the agent system, the empty pnpm workspace of T-R0-01 (placeholder app, lint zones, the five checks) the T-R0-02 limits (bundle budget in `pnpm build`, `apps/web/public/_headers` guarded by `headers.test.ts`) and the T-R0-03 E2E harness (`pnpm test:e2e`: privacy + axe specs) with CI (`.github/workflows/ci.yml`). **P0 done; no feature code yet.**
- Next: **P1 Schema and engine**. Its tasks are not written yet: run the `clarify` skill to write them (§4, A-06-5) before any P1 work.

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
| P1 Schema and engine | `packages/flow-schema`; `src/engine` (io, core, formula, duckdb, nodes, worker protocol) | `docs/archive/spec.md` §8–§14, §24, §27; 03 §3–§5; ADR-006 | S1: `fixtures/payroll-timesheet/expected.json` and the 182 cases of `fixtures/formula-golden/cases.json` reproduced; parsers fuzzed by `verifier`; one run of 1,000,000 rows × 30 columns completes |
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
| Q-06-1 | OPEN QUESTION | Which UI decisions recorded in `docs/MEMORY.md` for the old screens carry over. Default: those not contradicted by 04 stay in force. |
| Q-06-2 | OPEN QUESTION | 03 summarises the old schema in 337 lines; the six migration files it was written from are gone from the tree. Gaps found in P3 are settled with the owner, not guessed. |
| Q-06-3 | OPEN QUESTION | P0 verifier MINOR findings, not fixed in T-R0-03 (out of its scope); each needs a task before the phase that makes it matter: (1) `headers.test.ts` accepts scheme-only `connect-src` sources such as `https:` / `wss:` (allow-list instead, P3); (2) the privacy fixture does not see WebSocket connections (P3, Supabase realtime); (3) the privacy spec does not check cookies, Cache Storage, OPFS (P4); (4) `vite preview` does not serve `_headers`, so E2E does not run under the production CSP (before P1 adds the worker); (5) CI actions pinned by tag, not by SHA. |

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
