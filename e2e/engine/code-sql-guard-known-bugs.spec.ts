// KNOWN BUG cases of the `code.sql` guard found by the second verification of T-R1-08 (spec §9.2,
// MEMORY 2026-11-16 14:30 point 4: a statement reads only its input views and its own CTEs).
// Each test states the required behaviour and is marked `test.fail` until the guard is fixed.
// Fake data only.
import type { Page } from '@playwright/test';
import type { EngineErrorReply, HarnessReply } from '../support/engine-harness';
import { expect, test } from '../support/fixtures';

/** Stands for another node's run table (`hr_tab_<n>`). */
const CANARY_TABLE = 'hr_tab_known_bug_canary';
const CANARY = 'CANARY_KB_51c2';
const VIEWS = ['luong'];
const KEYS = ['ky_luong'];
const PARAMS = [{ key: 'ky_luong', label: 'Kỳ lương', type: 'string', required: true }];
const LUONG = {
  columns: [{ key: 'ma_nv', title: 'Mã NV', type: 'string' }],
  rows: [['NV1']],
};
/** U+212A KELVIN SIGN: JavaScript lowercases it to ASCII `k`; DuckDB folds only ASCII. */
const KELVIN = 'K';

function sqlFlow(sql: string) {
  return {
    schemaVersion: 1,
    params: PARAMS,
    inputSlots: [],
    nodes: [
      { id: 'src', type: 'test.source', config: { name: 'luong' } },
      { id: 'sql', type: 'code.sql', config: { inputs: [{ port: 'luong' }], sql } },
    ],
    edges: [{ from: 'src', to: 'sql', toPort: 'luong' }],
  };
}

async function open(page: Page): Promise<void> {
  await page.goto('/e2e-engine.html');
  await expect(page.locator('#status')).toHaveText('ready');
  const made = await call(
    page,
    'exec',
    `CREATE TABLE ${CANARY_TABLE} AS SELECT '${CANARY}' AS ma_nv`,
  );
  expect(made.ok).toBe(true);
}

function call(page: Page, op: string, ...args: unknown[]): Promise<HarnessReply> {
  return page.evaluate(([name, rest]) => window.__hrflowEngineHarness!.call(name, ...rest), [
    op,
    args,
  ] as const);
}

function keyOf(reply: HarnessReply): string {
  if (reply.ok) return 'ok';
  return reply.error.engine ? (reply.error as EngineErrorReply).info.messageKey : 'raw';
}

test.describe('KNOWN BUG: code.sql guard (verifier T-R1-08, second round)', () => {
  // The anchor (left branch) of a RECURSIVE CTE is bound by DuckDB before the CTE's own name, so
  // a recursive CTE named like a run table reads the real table there. The guard puts the name in
  // scope for the whole body.
  test.fail('a recursive CTE anchor never reads the run table it shadows', async ({ page }) => {
    await open(page);
    const sql =
      `WITH RECURSIVE ${CANARY_TABLE} AS (SELECT ma_nv FROM ${CANARY_TABLE}` +
      ` UNION ALL SELECT ma_nv FROM ${CANARY_TABLE} WHERE false) SELECT * FROM ${CANARY_TABLE}`;
    expect(keyOf(await call(page, 'check', sql, VIEWS, KEYS))).toBe('sql.error.forbidden');
    const run = await call(page, 'run', sqlFlow(sql), { luong: LUONG }, { ky_luong: 'K' });
    expect(JSON.stringify(run)).not.toContain(CANARY);
  });

  // The guard lowercases names with String.prototype.toLowerCase (Unicode); DuckDB folds ASCII
  // only. A CTE named `duc<KELVIN>db_columns` puts `duckdb_columns` in the guard's scope, while
  // DuckDB binds `FROM duckdb_columns` to the catalog view (lists every run table).
  test.fail(
    'a CTE name with a non-ASCII case fold never opens a catalog view',
    async ({ page }) => {
      await open(page);
      const sql =
        `WITH "duc${KELVIN}db_columns" AS (SELECT 'x' AS t)` +
        " SELECT string_agg(table_name, ',') AS t FROM duckdb_columns";
      expect(keyOf(await call(page, 'check', sql, VIEWS, KEYS))).toBe('sql.error.forbidden');
      const run = await call(page, 'run', sqlFlow(sql), { luong: LUONG }, { ky_luong: 'K' });
      expect(JSON.stringify(run)).not.toContain(CANARY_TABLE);
    },
  );

  // DuckDB ends a `--` comment at `\r` as well as `\n`; `replaceParams` only at `\n`, so the
  // comment nesting after `-- x\r` is not counted and reaches DuckDB's quadratic parser.
  test.fail(
    'deep comment nesting after "-- x\\r" is refused before the parser',
    async ({ page }) => {
      test.setTimeout(60_000);
      await open(page);
      const sql = `SELECT 1 AS a -- x\r${'/*'.repeat(10_000)}`;
      const started = Date.now();
      expect(keyOf(await call(page, 'check', sql, VIEWS, KEYS))).toBe('sql.error.syntax');
      expect(Date.now() - started).toBeLessThan(500);
    },
  );
});
