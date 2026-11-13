# 06 — Plan

> **Read this file first in every execution session** (skill `execute-task`). It replaces the
> incremental plan of the previous repository, now frozen in
> `docs/archive/refactor-plan-incremental.md` (32 tasks; a source of detail when rewrite tasks are
> written, especially its phase P2 — building `src/ui`). `src/` means `apps/web/src/`.

## 1. Status

- 2026-11-13: the owner chose a **full rewrite in this repository** (ADR-012). Scope unchanged (ADR-002).
- The legacy code was imported as one snapshot and verified green here (Progress Log, R-00).
- **No rewrite task exists yet.** Tasks are written with the `clarify` skill once the owner answers §2. Until then the only work allowed is documentation, the owner actions of §3, and answering §2.

## 2. Owner decisions needed before the rewrite plan

Each question fixes what "rewrite everything" means in one area. A = recommended.

| # | Question | A (recommended) | B | C |
|---|----------|-----------------|---|---|
| 1 | Where does new code live while the legacy code is still needed as reference? | Move the legacy app to `legacy/` (read-only reference, deleted at the end); new code starts from an empty `apps/web`. Clean tree; the reference stays one `grep` away. | Rewrite in place, module by module; the app stays runnable but old and new patterns sit side by side. | Delete the legacy code now; build from the documents only. Loses the behaviour reference for anything the documents do not cover. |
| 2 | What must the new engine prove? | Pass the legacy engine tests ported unchanged (unit tests, `expected.json`, 182 golden cases) before any legacy engine file is dropped. Highest safety; the tests become the engine spec. | Pass `expected.json` and the 182 golden cases only; write other tests anew. Faster; edge cases solved earlier (zip bomb, decimal, Unicode keys) may return. | — |
| 3 | Which database does the rewrite use? | The existing Supabase project and its 6 released migrations, unchanged (schema is not rewritten; accounts and flows stay). | A new Supabase project with one consolidated migration; data moved by hand; a second project to keep alive on the free tier. | — |
| 4 | What happens to the 517 E2E tests? | Keep the behavioural specs as the acceptance suite (so texts, roles and i18n keys stay identical); rewrite only visual-value specs and baselines. | Write a new, smaller E2E suite from the documents. | — |
| 5 | When does production move to this repository? | The previous repository keeps serving production until the rewrite passes the acceptance suite; then Cloudflare Pages is pointed here. | Point Cloudflare Pages here now (the legacy baseline deploys from this repository's `main`). | — |

Cost known today (ADR-001, measured on the legacy code): ≈ 40k lines of app code and ≈ 40k lines of tests.

## 3. Owner actions pending (independent of §2)

| Action | Why | Status |
|--------|-----|--------|
| Make this repository private (Settings → General → Danger Zone) | AUD-03; it is public today | todo |
| Add GitHub secrets `SUPABASE_DB_URL`, `BACKUP_PASSPHRASE` to this repository (steps in `README.md`, "Sao lưu và khôi phục") | Needed by `db-tests.yml` and `backup.yml`; never run on the real DB (AUD-02) | todo |
| Then: run "Database tests on Supabase" and "Supabase backup"; record the run links here | ADR-010 item 1 | todo |
| In the app, tab "Cài đặt UI": press "Khôi phục tất cả" once | AUD-29 (105 override rows equal the defaults) | todo |

## 4. Task rules and format

| Rule | Detail |
|------|--------|
| One task per session | Take the first `todo` task whose dependencies are `done`. |
| Every task ends green | Definition of done: `07-conventions.md` §10. Commands: `CLAUDE.md`. |
| No scope growth | No feature, dependency, CSP change or schema change unless the task says so. |
| Sizes | S ≤ ½ session, M ≈ 1 session, L = 1 long session → delegate to `implementer`. A task expected to pass 400k subagent tokens or 12 acceptance criteria is split first. |
| Verification | Tasks marked **verify** and the last task of a phase end with the `verifier` subagent. |

Task format: `ID · Title · Size · Depends` — then Goal, Files, Steps, Acceptance criteria, Verify (exact commands), Rollback.

## 5. Product backlog (after the rewrite)

Each item starts with the `clarify` skill.

| ID | Item | Source | Notes |
|----|------|--------|-------|
| B-01 | Reference tables round 2: node `input.refTable`, version by as-of date, `flow_versions.ref_tables`, User read policy, `fromRefTable` parameter, run log `ref_versions` | `docs/archive/PLAN.md` M1; `docs/archive/spec.md` §34 AC-RT-07…10 | First feature on the new structure |
| B-02 | Owner builds 2 real flows; friction log | PLAN M2 | Measures S7 (00) |
| B-03 | Designer ease of use: auto-connect new node, drag from port to add, "create input slot from sample file", "duplicate flow", Vietnamese port labels | PLAN M3 | |
| B-04 | Activity history screen (run logs + audit logs with filters) | PLAN M4 | Adds a "Hệ thống" menu item |
| B-05 | Result screen for flows without `control.compare` | AUD-18 | Confirm on screen first |
| B-06 | `output.template` (Excel template fill) | PLAN M5 | Needs a real report template from the owner |
| B-07 | Engine MINOR items | AUD-31 | Only when they hurt |
| B-08 | `code.python`, `output.chart`, English UI, dark mode | PLAN §6 | Only when the owner asks |
| B-09 | Owner runs `pnpm perf:local` on the real laptop (AC-B3-24) | PLAN M0.6 | Owner action |

## 6. Assumptions and open questions

| ID | Type | Statement |
|----|------|-----------|
| A-06-1 | ASSUMPTION | Feature work (§5) waits until the rewrite reaches parity with the legacy baseline. |
| A-06-2 | ASSUMPTION | The target documents 02, 03, 04 and 07 stay valid for the rewrite as written; only their execution path changed (ADR-012). |
| A-06-3 | ASSUMPTION | Still waiting for the owner's confirmation: `docs/MEMORY.md` is consulted on demand, not auto-loaded (ADR-008 A-08-1); the two changes to the agent-system design (08 A-08-4, A-08-5). |
| Q-06-1 | OPEN QUESTION | Which of the UI decisions recorded in `docs/MEMORY.md` for the v2 screens carry over to the rewritten screens. Default: those not contradicted by 04 stay in force. |
| Q-06-2 | OPEN QUESTION | Full E2E in CI needs GitHub Actions minutes once the repository is private (free plan limit UNVERIFIED). Default: smoke job only (ADR-011). |

## 7. Progress Log

Status values: `todo` · `in progress` · `waiting-owner` · `done` · `blocked`. One row per task; updated in the same commit as the work.

| ID | Status | Date | Notes (numbers measured at completion) |
|----|--------|------|----------------------------------------|
| R-00 Import legacy baseline | done | 2026-11-13 | One snapshot of the previous repository at `fb1ba03`, tree byte-identical (`diff -rq`). Here: lint, format:check, typecheck, build exit 0; unit tests 1,348 passed / 4 expected-fail / 12 skipped; behaviour reference 188 / 188; start-up JS 214.6 KiB gzip; CSS 38.5 KiB gzip; E2E `privacy` + `acceptance` + `auth` 10 / 10. Full E2E (517 tests in 52 files by `--list`) not run. |
| R-01 Documents and agent system | done | 2026-11-13 | Legacy documents frozen in `docs/archive/`; `CLAUDE.md` rewritten; rules, skills, subagents, hooks built (08). Hook tests: 08 §4. Verifier frontmatter hook not exercised with a live subagent. |
| R-02 Rewrite plan | waiting-owner | | Needs the answers to §2. |
