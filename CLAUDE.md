# CLAUDE.md — HR Tools

Internal web app: an Admin configures Excel data flows, a User runs them. All file content is
processed in the browser (Web Worker + DuckDB-WASM); the server (Supabase) holds metadata only.
Owner and only maintainer: Harold (HR analytics, IT background).

## State of this repository

- The app is being **rewritten from scratch, from the documents** (ADR-012, owner decision 2026-11-13). The previous implementation was removed from the tree; only the empty workspace exists (T-R0-01: `apps/web`, `packages/flow-schema`, lint zones, checks).
- The documents are the specification. `fixtures/` holds the acceptance data the new engine must reproduce. `vendor/` holds the vendored SheetJS tarball.
- `docs/redesign/06-plan.md` holds the phases, the tasks of the current phase, the open owner decisions, and the Progress Log (the only project status). Read it at the start of every session. Run tasks with the `execute-task` skill, one task per session.
- The previous repository (`HR-System`) is left exactly as it is: no edit, commit or push there, even when it is attached to the session.
- When the documents do not answer a question: ask the owner, or read the previous implementation in git (`git show 6fd5868:<path>`) to learn the behaviour, then write the answer into the documents. Never paste old code back.

## Commands

Node ≥ 22, pnpm 10, run from the repository root.

- Install: `pnpm install --frozen-lockfile`
- Dev server: `pnpm dev`
- The five checks (all must exit 0): `pnpm lint && pnpm format:check && pnpm typecheck && pnpm test && pnpm build`
- `pnpm build` ends with the bundle budget (`apps/web/bundle-budget.json`); numbers only, never failing: `pnpm --filter @hrflow/web exec node scripts/check-bundle-size.mjs --measure` (after a build)
- Fix formatting: `pnpm format`
- One test file: `pnpm --filter @hrflow/web exec vitest run src/app/__tests__/App.test.tsx`
- E2E (builds with `build:e2e`, then Playwright against `vite preview`; traces off, output in the OS temp dir; uses `/opt/pw-browsers/chromium` when present, never run `playwright install` there): `pnpm test:e2e`
- One E2E spec: `pnpm --filter @hrflow/web build:e2e && pnpm exec playwright test e2e/user/privacy.spec.ts`
- Hook tests: `docs/redesign/08-agent-system.md` §4

## Rules

1. **Data boundary.** File content and HR data never leave the browser: not uploaded, not logged (including `console`), not stored (`localStorage`, IndexedDB), not in URLs, not in run logs. Files are read only in the Web Worker. The server stores accounts, flow configuration, reference tables without personal data, and run metadata (file names as SHA-256, error keys). No new external origin, CSP change or dependency beyond `docs/redesign/02-target-architecture.md` §1.1 without the owner's approval (licence MIT / Apache / BSD preferred; a package from outside npm is vendored with a checksum in `vendor/`).
2. **Real data.** The owner tests with real files on his own machine. That content never goes into chat, screenshots, fixtures or commits. If data in a file, screenshot or message looks real, say so and do not copy it.
3. **Behaviour reference.** `fixtures/payroll-timesheet/expected.json` and the 182 cases of `fixtures/formula-golden/cases.json` are never edited to make a change pass. No test is skipped or weakened to get green.
4. **Architecture** (`docs/redesign/02-target-architecture.md` §3): `app → features → shared → api`; `ui` and `engine` stand alone; outside `src/engine` import only `engine/protocol` and `engine/formula/public`; only `src/api` talks to Supabase; no feature imports another feature.
5. **Never change the design silently.** A task that cannot be done as written, or a decision the documents do not make → stop and ask. Before changing behaviour in an area, grep `docs/MEMORY.md` for the topic; a request that contradicts it or `docs/redesign/` → stop and ask.
6. **Git.** Never write the owner's company name anywhere (use "the company"). No secrets; only `.env.example` files are committed. English Conventional Commits, task ID in the subject, one purpose per commit. `main` moves only through the `release` skill.
7. **Truthful reports.** Quote the command and its result. Failed or skipped steps are named.

Also stop and ask when: start-up JS would exceed 240 KiB gzip; a check fails twice for the same cause; SQL with `drop` / `delete` must run on the real database (it cannot go through the MCP connection); anything would create or change cloud resources (Supabase project, Cloudflare Pages, GitHub settings).

## Working with the owner

- Talk to him in Vietnamese, keeping English technical terms. Conclusion first, then reasons. Minimal formatting.
- Questions are numbered, each with 2–3 options A/B/C, one marked recommended with a one-line trade-off. He answers like "1A, 2B".
- Risky matters (data, security, cost): give the facts and the options; he decides.

## Decisions

- When the owner settles something, add one line at the top of the right group in `docs/MEMORY.md`: `YYYY-MM-DD HH:MM - <decision>` (Vietnamese; time from `TZ=Asia/Ho_Chi_Minh date '+%Y-%m-%d %H:%M'`), and update the affected file in `docs/redesign/` in the same commit. Record only what he confirmed.
- A changed decision is never deleted: move the old line to `docs/MEMORY-archive.md` as `~~…~~ → thay bởi <time>`.
- Precedence on conflict: `docs/MEMORY.md` > `docs/redesign/` > code > `docs/archive/`.

## Documents (read only the sections a task cites)

| File | Content |
|------|---------|
| `docs/redesign/00-product-vision.md` | Scope, users, success criteria |
| `docs/redesign/01-current-state-audit.md` | What was wrong in the previous implementation (AUD-xx) and the design answer to each |
| `docs/redesign/02-target-architecture.md` | Stack, layers, dependency rules, folder tree, CSP |
| `docs/redesign/03-domain-and-data-model.md` | Entities, business rules, access matrix |
| `docs/redesign/04-ui-ux-system.md` | Design System v3: tokens, components, pages |
| `docs/redesign/05-decisions/` | ADR-001 … ADR-012 |
| `docs/redesign/06-plan.md` | Phases, current tasks, open owner decisions, backlog, Progress Log |
| `docs/redesign/07-conventions.md` | Naming, style, API, errors, tests, commits |
| `docs/redesign/08-agent-system.md` | How rules, skills, subagents and hooks are organised |
| `docs/archive/` | Frozen: `spec.md` (node behaviour §8–§14, §24, §27, §34), `locales-vi/` (the Vietnamese UI texts the owner edited), old plans |

Area rules load on their own when a matching file is opened (`.claude/rules/`: engine, ui, api-db, testing, docs). Edits to `vendor/`, `docs/archive/`, env files and released migrations are blocked by a hook.
