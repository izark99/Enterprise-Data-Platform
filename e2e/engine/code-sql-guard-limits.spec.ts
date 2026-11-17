// Limits of the `code.sql` guard added after the third verification of T-R1-08 (owner 1A 2A): the
// inputs that blocked the worker for seconds or crashed DuckDB-WASM are refused before DuckDB's
// parser, a crashed DuckDB is replaced, and scalar functions reading DuckDB's own state are
// refused. Fake data only.
import type { Page } from '@playwright/test';
import type { EngineErrorReply, HarnessReply } from '../support/engine-harness';
import { expect, test } from '../support/fixtures';

const VIEWS = ['luong'];
const KEYS = ['ky_luong'];
const PARAMS = [{ key: 'ky_luong', label: 'Kỳ lương', type: 'string', required: true }];
const LUONG = {
  columns: [{ key: 'ma_nv', title: 'Mã NV', type: 'string' }],
  rows: [['NV1']],
};
/** A check that blocks the worker longer than this is a finding (the guard runs at design time). */
const CHECK_BUDGET_MS = 2_000;

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
  // Load DuckDB first, so the time budgets below measure the check only.
  expect(keyOf(await call(page, 'check', 'SELECT ma_nv FROM luong', VIEWS, KEYS))).toBe('ok');
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

test.describe('code.sql guard limits (verifier T-R1-08, third round)', () => {
  // Was: DuckDB's lexer is quadratic in adjacent empty comments (100,000 characters ≈ 45 s).
  // More than 256 comments are now refused before the parser.
  test('many adjacent empty comments are refused within the budget', async ({ page }) => {
    test.setTimeout(60_000);
    await open(page);
    const sql = `SELECT ma_nv FROM luong ${'/**/'.repeat(12_490)}`;
    const started = Date.now();
    expect(keyOf(await call(page, 'check', sql, VIEWS, KEYS))).toBe('sql.error.syntax');
    expect(Date.now() - started).toBeLessThan(CHECK_BUDGET_MS);
    const few = `SELECT ma_nv FROM luong ${'/**/'.repeat(200)}`;
    expect(keyOf(await call(page, 'check', few, VIEWS, KEYS))).toBe('ok');
  });

  // Was: nested WITH is exponential in DuckDB's parser (12 levels ≈ 11 s, then out of memory).
  // More than 4 nested WITH clauses are now refused before the parser.
  test('nested WITH beyond 4 levels is refused within the budget', async ({ page }) => {
    test.setTimeout(60_000);
    await open(page);
    const nested = (levels: number): string =>
      `${'WITH c AS ('.repeat(levels)}SELECT 1 AS c${') SELECT * FROM c'.repeat(levels)}`;
    const started = Date.now();
    expect(keyOf(await call(page, 'check', nested(12), VIEWS, KEYS))).toBe('sql.error.syntax');
    expect(keyOf(await call(page, 'check', nested(5), VIEWS, KEYS))).toBe('sql.error.syntax');
    expect(Date.now() - started).toBeLessThan(CHECK_BUDGET_MS);
    expect(keyOf(await call(page, 'check', nested(4), VIEWS, KEYS))).toBe('ok');
  });

  // Was: 500 sibling CTEs passed the check and crashed DuckDB-WASM at run time. More than 64 CTEs
  // are now refused (scanner before the parser, and on the AST).
  test('more than 64 CTEs are refused', async ({ page }) => {
    test.setTimeout(60_000);
    await open(page);
    const chain = (count: number): string => {
      const ctes = Array.from(
        { length: count },
        (_, i) => `c${i} AS (SELECT * FROM ${i === 0 ? 'luong' : `c${i - 1}`})`,
      );
      return `WITH ${ctes.join(', ')} SELECT * FROM c${count - 1}`;
    };
    expect(keyOf(await call(page, 'check', chain(500), VIEWS, KEYS))).toBe('sql.error.syntax');
    expect(keyOf(await call(page, 'check', chain(65), VIEWS, KEYS))).toBe('sql.error.syntax');
    expect(keyOf(await call(page, 'check', chain(64), VIEWS, KEYS))).toBe('ok');
    const run = await call(page, 'run', sqlFlow(chain(64)), { luong: LUONG }, { ky_luong: 'K' });
    expect(keyOf(run)).toBe('ok');
  });

  // A WebAssembly trap leaves DuckDB's memory unusable; the worker now opens a new DuckDB on the
  // next use. The trap is provoked through the harness-only `exec` (it bypasses the guard).
  test('a DuckDB broken by a WebAssembly trap is replaced on the next use', async ({ page }) => {
    test.setTimeout(120_000);
    await open(page);
    const ctes = Array.from(
      { length: 500 },
      (_, i) => `c${i} AS (SELECT 1 AS x FROM ${i === 0 ? 'range(1)' : `c${i - 1}`})`,
    );
    const crash = await call(
      page,
      'exec',
      `CREATE TABLE t AS WITH ${ctes.join(', ')} SELECT * FROM c499`,
    );
    expect(crash.ok).toBe(false);
    if (!crash.ok) {
      expect(crash.error.message, 'the trap this test needs').toMatch(
        /memory access out of bounds|table index is out of bounds|unreachable/i,
      );
    }
    const after = await call(page, 'check', 'SELECT ma_nv FROM luong', VIEWS, KEYS);
    expect(keyOf(after)).toBe('ok');
    const run = await call(
      page,
      'run',
      sqlFlow('SELECT ma_nv FROM luong'),
      { luong: LUONG },
      {
        ky_luong: 'K',
      },
    );
    expect(keyOf(run)).toBe('ok');
  });

  // Owner 2A: scalar functions that read DuckDB's own state (settings, the running statement with
  // the random run-table names, variables, the environment) are refused.
  test('scalar functions reading DuckDB state are refused', async ({ page }) => {
    await open(page);
    for (const sql of [
      'SELECT current_query() AS q FROM luong',
      "SELECT current_setting('threads') AS s FROM luong",
      "SELECT getvariable('x') AS v FROM luong",
      "SELECT GETENV('HOME') AS e FROM luong",
      'SELECT version() AS v FROM luong',
      'SELECT current_database() AS d FROM luong',
      'SELECT (SELECT current_query()) AS q FROM luong',
      "WITH c AS (SELECT current_setting('memory_limit') AS s) SELECT * FROM c",
    ]) {
      expect(keyOf(await call(page, 'check', sql, VIEWS, KEYS)), sql).toBe('sql.error.forbidden');
    }
    expect(
      keyOf(await call(page, 'check', 'SELECT upper(ma_nv) AS m FROM luong', VIEWS, KEYS)),
    ).toBe('ok');
  });
});
