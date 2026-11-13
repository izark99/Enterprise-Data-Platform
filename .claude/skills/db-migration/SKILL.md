---
name: db-migration
description: Create, test and apply a Supabase schema, RLS or RPC change. Use for any change under supabase/migrations.
---

Before the first write to the real database from this repository, check `docs/redesign/06-plan.md` §2: while question 3 (which database the rewrite uses) is open, do steps 1–4 only and ask the owner.

1. Write a new file `supabase/migrations/<UTC yyyymmddhhmmss>_<name>.sql`. Additive first; no edit of an existing file. New table: `revoke all … from public, anon, authenticated`, explicit grants, `enable row level security`, policies. Functions: `set search_path = ''`, `security invoker` unless a comment explains why definer is needed.
2. Write or extend a test in `supabase/tests/` wrapped in `begin; … rollback;` that proves each policy for admin, active user, inactive user and anon.
3. Update the hand-written `database.types.ts` in the same commit (legacy location `apps/web/src/lib/`, target `apps/web/src/api/`).
4. Local: run `scripts/db-tests.sh` against a local Postgres.
5. Before a migration that rewrites existing rows: run the "Supabase backup" workflow and wait for green (it includes a restore check).
6. Apply to the real database with the Supabase MCP `apply_migration` (records history). SQL containing `drop` or `delete` cannot go through MCP: give the owner the exact SQL for the dashboard SQL editor, including the history row.
7. Run the workflow "Database tests on Supabase"; read the log; every file must print its OK line.
8. Run the security advisor; new findings are fixed or explained in the Progress Log.
9. Generate types from the real database and diff against `database.types.ts`; fix differences.
10. Rollback note in the task: the forward-fix migration that undoes the change.
