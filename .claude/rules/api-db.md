---
paths:
  - "apps/web/src/api/**"
  - "supabase/**"
---

# Data access and database

- `src/api/**` is the only code that imports the Supabase client. One class per resource taking a narrowed client type; every failure is thrown as `ApiError { key }` (mapping in `api/errors.ts`). No raw server message reaches the UI.
- Every table has RLS. The client never uses a service-role key (`env.ts` refuses one).
- `database.types.ts` is hand-written: change it in the same commit as the migration and diff it against generated types (skill `db-migration`).
- The database is a new Supabase project built from `docs/redesign/03-domain-and-data-model.md` (ADR-012). A released migration file (one that is on `main`) is never edited (hook-enforced). New change = new file.
- New table: `revoke all … from public, anon, authenticated` first, then explicit grants, RLS enabled, policies, and a test in `supabase/tests/` wrapped in `begin … rollback`. Local Postgres lacks Supabase's default grants, so local tests do not catch a missing revoke.
- Through the Supabase MCP connection, SQL containing `drop` or `delete` hangs for 60 s and is cancelled: keep those words out of migrations where possible; otherwise give the owner the SQL for the dashboard SQL editor.
- RLS / RPC changes run the real-database tests (workflow "Database tests on Supabase") and the security advisor before reaching `main`.
- The repository is public: no dump, secret or unencrypted data in artifacts, logs or commits.
- Model and access matrix: `docs/redesign/03-domain-and-data-model.md`. Procedure for any change under `supabase/migrations`: skill `db-migration`.
