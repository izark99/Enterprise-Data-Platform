---
name: release
description: Merge the working branch into main. Only when the owner asks.
disable-model-invocation: true
---

Production is still served from the previous repository. Whether and when `main` of this repository deploys is question 5 in `docs/redesign/06-plan.md` §2: while it is open, do steps 1–5 and skip step 6.

1. Working tree clean; branch up to date with `origin/main` (rebase if needed).
2. Run and require green: `pnpm lint`, `pnpm format:check`, `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm test:e2e` (full, on the fresh `build:e2e`).
3. Database changes in the range: the `db-migration` skill steps 6–9 are done and logged.
4. `verifier` verdict for the range is `PASS`.
5. Fast-forward `main` to the branch and push.
6. Open the production URL, sign in, run the acceptance flow once with the fixture files, confirm the result downloads.
7. Record the release (date, commit, checks) in the Progress Log.
