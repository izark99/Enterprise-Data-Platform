---
name: execute-task
description: Run one task of docs/redesign/06-plan.md from start to finish. Use at the start of every execution session or when the owner says "continue the plan".
---

1. `git fetch origin main`. Open `docs/redesign/06-plan.md`, read the Progress Log. Pick the first `todo` task whose dependencies are all `done` (or the ID the owner gave). Set it to `in progress` with today's date. If no task is `todo`, do not invent one: at a phase boundary write the next phase's tasks with the `clarify` skill (plan §4); otherwise report which owner decisions in §2 are open and stop.
2. Read the whole task and the sections it cites. Do not read other documents.
3. If the task is size L, delegate it to the `implementer` subagent with the task ID and a context pack (files, sections, risks). Otherwise do it yourself. One subagent at a time; a subagent stopped by the usage limit is resumed with a message to the same agent, not replaced.
4. Follow the steps literally. A step that cannot be done as written, or a needed decision the documents do not make: stop, ask the owner (A/B/C, one recommended). Never redesign silently.
5. Run every verification command of the task. Quote each command and its result in the report. A failing check is fixed or reported, never hidden.
6. If the task is marked **verify**, or it is the last task of a phase, run the `verifier` subagent on the commit range; fix BLOCKING / MAJOR findings and re-verify once. A second failure: stop and report.
7. Update the Progress Log row (status `done`, date, one-line note with numbers measured now: tests passed, start-up JS, tokens used by subagents). Update any redesign document the change made wrong.
8. Commit (English, Conventional Commits, task ID in the subject) and push to the working branch.
9. Report to the owner in Vietnamese: done / evidence / not done / questions.
