---
paths:
  - "docs/**"
  - "CLAUDE.md"
  - "README.md"
  - ".claude/**"
---

# Documents

- One fact lives in one file. Before adding a line, grep for where it already is and link to it instead.
- `CLAUDE.md` is the only always-loaded file and stays under 120 lines: only what cannot be read from the code. Area rules go to a path-scoped file in `.claude/rules/`, procedures to a skill, zero-exception rules to a hook or a `deny` rule (`docs/redesign/08-agent-system.md`).
- `docs/redesign/` is English, tables over prose, every claim about the code backed by a path; unverified claims are labelled UNVERIFIED; each file ends with decisions / assumptions / open questions.
- `docs/MEMORY.md` is Vietnamese, one line per decision, newest first in its group, only what the owner confirmed. It is not auto-loaded: grep it by topic.
- `docs/archive/` is frozen (hook-enforced).
- Project status lives only in the Progress Log of `docs/redesign/06-plan.md`.
- A code change that makes a document wrong fixes the document in the same commit.
- Do not create planning or analysis files unless the owner asks.
- `README.md` is the human-facing overview in Vietnamese (setup, backup / restore).
