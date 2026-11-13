---
name: release
description: Merge the working branch into main. Only when the owner asks.
disable-model-invocation: true
---

Production is served from the previous repository until phase P7 of `docs/redesign/06-plan.md`. Before P7, do steps 1–5 and skip step 6.

1. Working tree clean; branch up to date with `origin/main` (rebase if needed).
2. Run and require green: every check of `docs/redesign/07-conventions.md` §10 and the full E2E suite on a fresh E2E build.
3. Database changes in the range: the `db-migration` skill steps 6–9 are done and logged.
4. `verifier` verdict for the range is `PASS`.
5. Fast-forward `main` to the branch and push.
6. Open the production URL, sign in, run the acceptance flow once with the fixture files, confirm the result downloads.
7. Record the release (date, commit, checks) in the Progress Log.
