# ADR-012 — Full rewrite in a new repository

Status: Accepted · 2026-11-13 (owner answers 1C, 2A, 3B, 4C). Supersedes ADR-001.

## Context

ADR-001 chose an incremental refactor inside the previous repository and listed a rewrite as
option A: very high cost (≈ 40k lines of app code and ≈ 40k lines of tests), risk of bringing back
solved bugs, no usable new app for weeks. The same day the owner asked to redo the work in a new
repository and was shown the three options again with those costs.

## Decision

| # | Question | Owner's answer |
|---|----------|----------------|
| 1 | How to redo it | **C — rewrite everything**, engine included. Not the incremental refactor, not "keep the engine, rewrite the UI". |
| 2 | Product scope | **A — unchanged** (ADR-002 stands). |
| 3 | Git history | **B — one clean snapshot**; the earlier history stays in the previous repository. |
| 4 | First session | **C — import and verify the baseline only**; no rewrite task started. |

## Consequences

- The imported code is the **legacy baseline**: a behaviour reference that passes every check (`../06-plan.md`, R-00). It is not the starting structure of the new app.
- The incremental plan (32 tasks) is void and frozen in `docs/archive/refactor-plan-incremental.md`. The rewrite plan is written after the owner answers `../06-plan.md` §2 — "rewrite everything" leaves five things undecided: where new code lives, what the new engine must prove, which database, what happens to the E2E suite, when production moves.
- The target documents (02 architecture, 03 domain model, 04 design system, 07 conventions) describe the result and stay valid.
- Until `../06-plan.md` §2 question 2 is answered, `fixtures/payroll-timesheet/expected.json` and the 182 formula golden cases remain the acceptance reference for any engine code.
- Honest downside, unchanged from ADR-001: every bug the legacy engine already solved (zip bomb, decimal, Unicode keys, streaming xlsx) must be solved again or its tests ported first.

## Effect on earlier ADRs

Task IDs `T-Pn-nn` cited in ADR-003 … ADR-011 refer to the archived incremental plan. The decisions
stand; the cited tasks do not. `06-refactor-plan.md`, named in earlier ADRs and in older
`docs/MEMORY.md` lines, is now `06-plan.md`.

| ADR | Still valid | Void |
|-----|-------------|------|
| 001 | — | Superseded |
| 002, 004, 006, 007, 008, 009 | Decision | Task references only |
| 003 | Layers and matrix | "Zones added in two steps" — a rewrite enforces all zones from the first commit of new code |
| 005 | Three token tiers, densities, closed component API, GATE-1 / GATE-2 owner approvals | The v2 / v3 coexistence window and the temporary 60 KiB CSS limit |
| 010 | History baseline, real-DB tests, types diff | "No migration is part of the refactor" (depends on `../06-plan.md` §2 question 3) |
| 011 | Behaviour reference, never weaken behavioural assertions, known-bug and flaky rules | Rules about moving tests with their module and migrating baselines screen by screen (depends on §2 question 4) |
