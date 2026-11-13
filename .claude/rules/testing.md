---
paths:
  - "**/__tests__/**"
  - "**/*.test.ts"
  - "**/*.test.tsx"
  - "e2e/**"
  - "fixtures/**"
---

# Testing

- Fake data only (`fixtures/`, generated with a fixed seed). Never real data.
- The acceptance flow must match `fixtures/payroll-timesheet/expected.json`; the 182 formula golden cases must pass. These are not edited to make a change pass.
- Never skip or disable a test to get green. Known bug: `it.fails` / `test.fail` in a "KNOWN BUG" group.
- Behavioural E2E assertions (text, roles, network, storage, downloads) are never weakened. Visual-value assertions and screenshot baselines change only in the task that builds or restyles that screen, and each regenerated image is inspected.
- Flaky test or screenshot: do not raise a threshold; on the second occurrence find the cause.
- Heavy tests (volume, performance) are opt-in behind an environment flag, never part of the default run.
- E2E runs only on an E2E build that just exited 0 (a silent build failure once ran the tests on a stale bundle), with the pre-installed Chromium (no `playwright install` locally) and traces off. A stopped run can leave `vite preview` on port 4173: find it (`ps -eo pid,args | grep "vite.js preview"`) and stop it first.
- Changing a default text breaks text-bound E2E tests and baselines: run the full E2E, not only unit tests.
- Test output goes to the OS temp directory, never into the repo.
- Counts and measurements written into documents come from a command just run.
