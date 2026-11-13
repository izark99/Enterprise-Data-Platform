---
paths:
  - "apps/web/src/engine/**"
  - "packages/flow-schema/**"
---

# Engine and flow schema

- The engine is pure TypeScript: no React, no DOM, no `console`. It imports only `engine/**` and `@hrflow/flow-schema`. It must run under Node for tests.
- Code outside `engine/` imports only `engine/protocol` and `engine/formula/public`. To expose something new, re-export it from one of those two files.
- One node type = one plugin file in `engine/nodes/`, registered in `engine/nodes/index.ts`; config schema in `packages/flow-schema`. The core executor is not edited for a new node.
- Money and day counts use decimal (`big.js`, `DECIMAL(38,10)`), never float. Decimals cross to the UI as strings.
- Errors and validation messages are i18n keys with params (`locales/vi/engine.json`); they name the node, file, source row and column; they never contain cell content beyond what the validation report shows on screen.
- User-entered parameters are bound as values (prepared statement), never concatenated into SQL.
- No business format is hard-coded (e.g. employee-code shape): it is flow configuration.
- Never `arr.push(...big)` or spread a large array into a call (stack overflow above ~100k rows).
- Semantics that exist in both TypeScript and SQL (key normalisation, decimal, blank cells): change both sides and their equivalence test together.
- Code that parses external files (unzip, xlsx, formula parser): have the `verifier` fuzz it in the same round. The zip-bomb hole took five rounds to close.
- Results are checked against `fixtures/payroll-timesheet/expected.json` and the 182 formula golden cases; neither is edited to make a change pass.
- Behaviour reference: `docs/archive/spec.md` §8–§14, §24, §27. Summary of rules: `docs/redesign/03-domain-and-data-model.md` §4.
