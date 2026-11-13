# 08 — Agent System

> Decision record: `05-decisions/ADR-009-agent-system.md`. This file explains how the instruction
> files are organised and why. **The files themselves are the source of truth** — their content is
> not repeated here. Guidance used: Claude Code docs *How Claude remembers your project*,
> *Best practices*, *Custom subagents*, *Skills* (read 2026-11-13).

## 1. Where each kind of instruction lives

| Kind of instruction | Home | Loaded |
|---------------------|------|--------|
| Facts every session needs and cannot read from the code: commands, state of the repo, non-negotiables, how to work with the owner | `CLAUDE.md` (≤ 120 lines) | Every session |
| Rules for one area of the code | `.claude/rules/{engine,ui,api-db,testing,docs}.md`, each with `paths:` | When a matching file is read or edited |
| Multi-step procedures | `.claude/skills/<name>/SKILL.md` | Description always; body when invoked |
| Rules with zero exceptions | `.claude/settings.json` (`deny`, hooks) + `.claude/hooks/*.sh` | Enforced by the harness |
| Isolated workers | `.claude/agents/{implementer,verifier}.md` | When the main session delegates |
| Project state | Progress Log in `06-plan.md` | Start of each execution session |
| Owner decisions | `docs/MEMORY.md` (Vietnamese) | On demand: grep by topic |

Test for a new line: *would a session get it wrong without this line, and is it true for every
task?* Yes to both → `CLAUDE.md`. True for one area → a path-scoped rule. A procedure → a skill.
Must never be broken → a hook. Derivable from the code → nowhere.

## 2. Session protocol

1. `git fetch origin main`; `CLAUDE.md` loads by itself; read the Progress Log.
2. Take the first task that is `todo` with all dependencies `done` (skill `execute-task`). One task per session. No `todo` task → at a phase boundary write the next phase's tasks (skill `clarify`); otherwise report the open owner decisions of `06-plan.md` §2. Do not invent work.
3. A request that is not a task in the plan goes through the skill `clarify` first.
4. Finish = verification commands pass, Progress Log updated, commit pushed. Report in Vietnamese: done, evidence (command + result), not done, open questions.

## 3. Delegation

| Situation | Who |
|-----------|-----|
| Task size S or M | Main session |
| Task size L | `implementer`, with the task ID and a context pack: files, sections to read, risks |
| End of each phase; tasks marked **verify** | `verifier`, with: commit range, task IDs, acceptance criteria, risk points |
| Broad code search | Built-in Explore agent |

Never two subagents at once (owner's usage limit). A subagent stopped by the limit is resumed with
a message to the same agent, not replaced. Tokens per subagent run go into the Progress Log notes.
The main session re-checks any important claim in a subagent report before passing it to the owner.

## 4. Deterministic guards

| Guard | Blocks | Tested 2026-11-13 (stdin `{"tool_input":{"file_path":"…"}}`) |
|-------|--------|----------------------------------------------------------------|
| `deny` in `settings.json` | Reading `.env`, `.env.local`, `apps/web/.env.local`, `**/.env.*.local` | Not exercised (needs a live permission prompt) |
| `protect-files.sh` (PreToolUse `Edit\|Write`) | `vendor/**`, `docs/archive/**` except its index `README.md`, env files except `*.env.example`, released migrations (file exists on `origin/main`) | Exit 2 for `vendor/README.md`, `docs/archive/spec.md`, `apps/web/.env.local`, `.env`, and (in a scratch repository) a migration file present on `origin/main`; exit 0 for `docs/archive/README.md`, `apps/web/.env.example`, a new migration file, `apps/web/src/app/App.tsx`, `docs/redesign/06-plan.md` |
| `verifier-test-only.sh` (frontmatter of `verifier.md`) | Any verifier write outside `e2e/`, `fixtures/`, `supabase/tests/`, `__tests__/`, `*.test.ts(x)`, `*.spec.ts` | Exit 2 for `apps/web/src/app/App.tsx`; exit 0 for one path of each allowed kind |
| `format.sh` (PostToolUse `Edit\|Write`) | Nothing; runs Prettier on the edited file | Exit 0; a badly formatted `.js` file was reformatted |

Limits: hooks match the `Edit` and `Write` tools only — a shell command can still write a file, so
the rules stay stated in prose as well. `*.md` and `.claude/**` are ignored by Prettier. Hooks need
`jq`, `bash` and `git`; without `jq` the two blocking hooks fail closed. A hook that proves too
strict is changed in a reviewed commit, never bypassed.

## 5. Decisions, assumptions, open questions

| ID | Type | Statement |
|----|------|-----------|
| D-08-1 | DECISION | Two subagents, three hooks, `deny` rules, path-scoped rules, Progress Log as the only state (ADR-009). |
| A-08-4 | ASSUMPTION | **Changed from the first design, needs the owner's confirmation:** the always-loaded `core.md` rule file is merged into `CLAUDE.md`. Reason: a rule file without `paths:` loads exactly like `CLAUDE.md`, and the two repeated the data, git and owner-communication rules. |
| A-08-5 | ASSUMPTION | **Changed from the first design, needs the owner's confirmation:** the skills `add-node` and `ui-screen` are not created yet. They name files that do not exist before the rewrite builds them (`src/ui/`, `features/designer/nodes/registry.ts`); they are added by the tasks that create those files. Their first drafts: `git show 6fd5868:docs/redesign/08-agent-system.md` §8.3–§8.4. |
| A-08-2 | ASSUMPTION | The `hooks:` block in subagent frontmatter has the YAML shape used in `verifier.md` (confirmed in the Claude Code subagent docs). Not exercised with a live subagent; project-level frontmatter hooks run only after the workspace trust dialog is accepted. |
| Q-08-1 | OPEN QUESTION | Should a `Stop` hook run `pnpm typecheck` automatically? Default: no (≈ 1 minute per turn); `execute-task` and CI cover it. |
