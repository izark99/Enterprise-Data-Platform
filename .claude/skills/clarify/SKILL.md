---
name: clarify
description: Clarify and settle a new or vague requirement with the owner before any code - fact-check first, ask A/B/C questions, write acceptance criteria, record the decision. Use for any request that is not already a task in the plan.
---

1. Analyse. Grep `docs/MEMORY.md` for the topic; read only the relevant sections of `docs/redesign/` (and `docs/archive/spec.md` when behaviour detail is needed). Identify the goal, the role (Admin / User), the data involved, the risks (personal data, performance, free tier, usage limit). Verify what can be verified in code or vendor docs first; label statements [Certain] / [High confidence] / [Speculative].
2. Conflict with `docs/MEMORY.md` or `docs/redesign/` → state it at once and ask.
3. Questions (Vietnamese): only those that change the design, at most 5 per round, ordered by impact:
   `N. <question>?` then `A (đề xuất): … / B: … / C: …`, each with a one-line trade-off. The owner answers "1A, 2B".
4. Record: one line per settled decision in `docs/MEMORY.md` (format in `CLAUDE.md`, "Decisions"); update the affected `docs/redesign/` file in the same commit; unsettled items go to that file's open-questions table.
5. Write the work as tasks in the format of `docs/redesign/06-plan.md` §4 (goal, files, steps, acceptance criteria that can be tested, verification commands, rollback, size ≤ L) and add them to the plan with status `todo`. A task expected to need more than 12 acceptance criteria is split first.
6. UI work: build an Artifact mock-up with fake data and get approval before the tasks are written.
