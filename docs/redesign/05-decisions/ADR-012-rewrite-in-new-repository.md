# ADR-012 — Full rewrite from the documents, in a new repository

Status: Accepted · 2026-11-13 (owner answers in two rounds). Supersedes ADR-001.

## Context

ADR-001 chose an incremental refactor inside the previous repository and listed a rewrite as
option A: very high cost (≈ 40k lines of app code and ≈ 40k lines of tests), risk of bringing back
solved bugs, no usable new app for weeks. The same day the owner asked to redo the work in a new
repository and was shown the options again with those costs.

## Decision

| Question | Owner's answer |
|----------|----------------|
| How to redo it | **Rewrite everything**, engine included. Not the incremental refactor, not "keep the engine, rewrite the UI". |
| Product scope | **Unchanged** (ADR-002 stands). |
| Git history | **One clean snapshot**; the earlier history stays in the previous repository. |
| Where new code lives | **The previous code is deleted from the tree now**; the app is built from the documents only. |
| Engine | **From scratch, from the documents.** The previous engine tests are not ported. |
| Database | **From scratch, in a new Supabase project.** |

## Consequences

- The documents are the specification: `../00` … `../04`, `../07`, and the frozen `docs/archive/spec.md` for node-level behaviour. A gap in them is closed by asking the owner or by reading the previous implementation in git history (import commit `6fd5868`) and writing the answer down — not by copying code (A-06-2).
- Kept in the tree because they are data, not code: `fixtures/` (acceptance flow with `expected.json`; 182 formula cases checked against real Excel), `vendor/` (SheetJS tarball), `docs/archive/locales-vi/` (the Vietnamese UI texts, edited by the owner).
- S1 of `../00-product-vision.md` keeps its meaning: the new engine must reproduce the two fixtures.
- The schema is written again from `../03-domain-and-data-model.md`; no migration, account, flow or setting is carried over from the previous project unless the owner asks (A-06-4).
- The incremental plan (32 tasks) is void and frozen in `docs/archive/refactor-plan-incremental.md`. The new plan is `../06-plan.md`.
- The previous repository stays as it is and keeps serving production until the cut-over phase (A-06-3).
- Honest downside: every problem the previous engine had already solved (zip bomb, decimal, Unicode keys, streaming xlsx, 1,000,000-row runs) has to be solved again, now without its tests. The engine phase therefore includes parser fuzzing by the `verifier` and a volume run.

## Effect on earlier ADRs

Task IDs `T-Pn-nn` cited in ADR-003 … ADR-011 refer to the archived incremental plan. The decisions
stand; the cited tasks do not. `06-refactor-plan.md`, named in earlier ADRs and in older
`docs/MEMORY.md` lines, is now `06-plan.md`.

| ADR | Still valid | Void |
|-----|-------------|------|
| 001 | — | Superseded |
| 002, 004, 006, 007, 008, 009 | Decision | Task references; anything described as "moved from" an old file |
| 003 | Layers and matrix | "Zones added in two steps" — all zones exist from the first commit of new code |
| 005 | Three token tiers, densities, closed component API, GATE-1 / GATE-2 owner approvals | The v2 / v3 coexistence window and the temporary 60 KiB CSS limit |
| 010 | Migrations applied only with a tool that records history; SQL tests on the real DB; types diff; backup with restore check before rewriting rows | Recording the six old migrations (the new project starts with a correct history) |
| 011 | Behaviour reference, never weaken behavioural assertions, known-bug and flaky rules, independent verification, CI smoke job | Rules about moving old tests and migrating baselines screen by screen (all tests are new) |
