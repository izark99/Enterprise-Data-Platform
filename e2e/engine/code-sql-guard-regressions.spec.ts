// Regressions of the `code.sql` guard found by the second verification of T-R1-08 (spec §9.2,
// MEMORY 2026-11-16 14:30 point 4: a statement reads only its input views and its own CTEs), fixed
// after owner 1A 2A; plus the nesting limit and the random run-table names. Fake data only.
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

test.describe('code.sql guard regressions (verifier T-R1-08, second round)', () => {
  // The anchor (left branch) of a RECURSIVE CTE is bound by DuckDB before the CTE's own name, so a
  // recursive CTE named like a run table read the real table there; the guard now puts the name in
  // scope only for the recursive branch.
  test('a recursive CTE anchor never reads the run table it shadows', async ({ page }) => {
    await open(page);
    const sql =
      `WITH RECURSIVE ${CANARY_TABLE} AS (SELECT ma_nv FROM ${CANARY_TABLE}` +
      ` UNION ALL SELECT ma_nv FROM ${CANARY_TABLE} WHERE false) SELECT * FROM ${CANARY_TABLE}`;
    expect(keyOf(await call(page, 'check', sql, VIEWS, KEYS))).toBe('sql.error.forbidden');
    const run = await call(page, 'run', sqlFlow(sql), { luong: LUONG }, { ky_luong: 'K' });
    expect(JSON.stringify(run)).not.toContain(CANARY);
  });

  // The guard lowercased names with String.prototype.toLowerCase (Unicode); DuckDB folds ASCII
  // only, so a CTE named `duc<KELVIN>db_columns` opened the catalog view. Names now fold ASCII only
  // and a non-ASCII table or CTE name is refused.
  test('a CTE name with a non-ASCII case fold never opens a catalog view', async ({ page }) => {
    await open(page);
    const sql =
      `WITH "duc${KELVIN}db_columns" AS (SELECT 'x' AS t)` +
      " SELECT string_agg(table_name, ',') AS t FROM duckdb_columns";
    expect(keyOf(await call(page, 'check', sql, VIEWS, KEYS))).toBe('sql.error.forbidden');
    const run = await call(page, 'run', sqlFlow(sql), { luong: LUONG }, { ky_luong: 'K' });
    expect(JSON.stringify(run)).not.toContain(CANARY_TABLE);
  });

  // DuckDB ends a `--` comment at `\r` as well as `\n`; `replaceParams` now does too, so the
  // nesting after `-- x\r` is counted and refused before DuckDB's quadratic parser.
  test('deep comment nesting after "-- x\\r" is refused before the parser', async ({ page }) => {
    test.setTimeout(60_000);
    await open(page);
    const sql = `SELECT 1 AS a -- x\r${'/*'.repeat(10_000)}`;
    const started = Date.now();
    expect(keyOf(await call(page, 'check', sql, VIEWS, KEYS))).toBe('sql.error.syntax');
    expect(Date.now() - started).toBeLessThan(500);
  });

  // A name character (non-ASCII too) before `$a$` makes the `$` part of the name for DuckDB, not a
  // dollar quote; the scanner used to hide the nesting behind it.
  test('deep comment nesting after a non-ASCII name with "$a$" is refused before the parser', async ({
    page,
  }) => {
    test.setTimeout(60_000);
    await open(page);
    const sql = `SELECT 1 AS \u00e9$a$ ${'/*'.repeat(10_000)}`;
    const started = Date.now();
    expect(keyOf(await call(page, 'check', sql, VIEWS, KEYS))).toBe('sql.error.syntax');
    expect(Date.now() - started).toBeLessThan(500);
  });

  // Owner 2A: nesting above 16 parentheses (e.g. CTE inside CTE) is refused before the parser,
  // which needs seconds for it; 16 levels are still accepted.
  test('parenthesis nesting is limited to 16 levels', async ({ page }) => {
    test.setTimeout(60_000);
    await open(page);
    const nest = (levels: number): string => {
      let q = 'SELECT ma_nv FROM luong';
      for (let k = 0; k < levels; k += 1) q = `SELECT * FROM (${q}) AS t${k}`;
      return q;
    };
    let started = Date.now();
    expect(keyOf(await call(page, 'check', nest(17), VIEWS, KEYS))).toBe('sql.error.syntax');
    expect(Date.now() - started).toBeLessThan(500);
    const cte = (levels: number): string => {
      let q = 'SELECT ma_nv FROM luong';
      for (let k = 0; k < levels; k += 1) q = `WITH c${k} AS (${q}) SELECT * FROM c${k}`;
      return q;
    };
    started = Date.now();
    expect(keyOf(await call(page, 'check', cte(40), VIEWS, KEYS))).toBe('sql.error.syntax');
    expect(Date.now() - started).toBeLessThan(500);
    expect(keyOf(await call(page, 'check', nest(16), VIEWS, KEYS))).toBe('ok');
  });

  test('trailing semicolons are all dropped', async ({ page }) => {
    await open(page);
    const sql = 'SELECT ma_nv FROM luong;; ; -- end';
    expect(keyOf(await call(page, 'check', sql, VIEWS, KEYS))).toBe('ok');
    const run = await call(page, 'run', sqlFlow(sql), { luong: LUONG }, { ky_luong: 'K' });
    expect(keyOf(run)).toBe('ok');
  });

  // Defence in depth behind the guard: run tables carry a random suffix, so no name can be guessed.
  test('run tables have unguessable names', async ({ page }) => {
    await open(page);
    const sql = 'SELECT ma_nv FROM luong';
    const run = await call(page, 'run', sqlFlow(sql), { luong: LUONG }, { ky_luong: 'K' });
    expect(keyOf(run)).toBe('ok');
    const queries = (run as { ok: true; value: { queries: string[] } }).value.queries.join('\n');
    expect(queries).toMatch(/"hr_tab_\d+_[0-9a-f]{16}"/);
  });
});
