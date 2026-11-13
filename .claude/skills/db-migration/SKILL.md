---
name: db-migration
description: Create, test and apply a Supabase schema, RLS or RPC change. Use for any change under supabase/migrations.
---

The database is a new Supabase project (ADR-012). Until the plan task that creates it is `done`, do steps 1–4 only. Creating or changing a project needs the owner's approval first.

1. Write a new file `supabase/migrations/<UTC yyyymmddhhmmss>_<name>.sql`. Additive first; no edit of an existing file. New table: `revoke all … from public, anon, authenticated`, explicit grants, `enable row level security`, policies. Functions: `set search_path = ''`, `security invoker` unless a comment explains why definer is needed.
2. Write or extend a test in `supabase/tests/` wrapped in `begin; … rollback;` that proves each policy for admin, active user, inactive user and anon.
3. Update the hand-written `apps/web/src/api/database.types.ts` in the same commit.
4. Local: run every file of `supabase/tests/` against a local Postgres.
5. Before a migration that rewrites existing rows: run the backup workflow and wait for green (it includes a restore check; ADR-010).
6. Apply to the real database with the Supabase MCP `apply_migration` (records history). SQL containing `drop` or `delete` cannot go through MCP: give the owner the exact SQL for the dashboard SQL editor, including the history row.
7. Run the real-database test workflow (ADR-010); read the log; every file must print its OK line.
8. Run the security advisor; new findings are fixed or explained in the Progress Log.
9. Generate types from the real database and diff against `database.types.ts`; fix differences.
10. Rollback note in the task: the forward-fix migration that undoes the change.
