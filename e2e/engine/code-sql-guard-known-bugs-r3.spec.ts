// Findings of the third verification of T-R1-08 (`code.sql` guard), pinned until fixed. Inputs stay
// within the guard's limits (≤ 16 parentheses, ≤ 32 comment levels, ≤ 100,000 characters) and
// still block the worker for seconds or break its DuckDB instance. Fake data only.
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

test.describe('KNOWN BUG: code.sql guard (verifier T-R1-08, third round)', () => {
  // DuckDB's lexer is quadratic in a run of adjacent empty comments: `/**/` is a run of operator
  // characters that each comment start rescans. Nesting depth is 1, so the depth limit does not
  // apply. Measured: 25,000 characters ≈ 1.5 s, 50,000 ≈ 5.5 s, 100,000 ≈ 45 s for `check` (two
  // parses) and ≈ 22 s more for the run.
  test.fail('adjacent empty comments are checked within the budget', async ({ page }) => {
    test.setTimeout(180_000);
    await open(page);
    const sql = `SELECT ma_nv FROM luong ${'/**/'.repeat(12_490)}`;
    expect(sql.length).toBeLessThanOrEqual(50_000);
    const started = Date.now();
    await call(page, 'check', sql, VIEWS, KEYS);
    expect(Date.now() - started).toBeLessThan(CHECK_BUDGET_MS);
  });

  // DuckDB's parser is exponential in nested `WITH` (each level doubles the time): 12 levels use 12
  // parentheses and 349 characters, well inside the limit of 16, and take ≈ 11 s to check; the run
  // then fails with "Allocation failure". 13–16 levels: ≈ 7 s, then "Allocation failure".
  test.fail(
    'nested WITH inside the parenthesis limit is checked within the budget',
    async ({ page }) => {
      test.setTimeout(180_000);
      await open(page);
      const levels = 12;
      const sql = `${'WITH c AS ('.repeat(levels)}SELECT 1 AS c${') SELECT * FROM c'.repeat(levels)}`;
      const started = Date.now();
      await call(page, 'check', sql, VIEWS, KEYS);
      expect(Date.now() - started).toBeLessThan(CHECK_BUDGET_MS);
    },
  );

  // A chain of 500 sibling CTEs (≈ 15,000 characters, one level of parentheses) passes the guard;
  // the run traps inside DuckDB-WASM ("memory access out of bounds") and the worker's DuckDB stays
  // broken: every later statement, even a plain check, fails until the worker is restarted.
  test.fail('a long CTE chain never leaves the worker database broken', async ({ page }) => {
    test.setTimeout(180_000);
    await open(page);
    const count = 500;
    const ctes = Array.from(
      { length: count },
      (_, i) => `c${i} AS (SELECT * FROM ${i === 0 ? 'luong' : `c${i - 1}`})`,
    );
    const sql = `WITH ${ctes.join(', ')} SELECT * FROM c${count - 1}`;
    expect(keyOf(await call(page, 'check', sql, VIEWS, KEYS))).toBe('ok');
    await call(page, 'run', sqlFlow(sql), { luong: LUONG }, { ky_luong: 'K' });
    const after = await call(page, 'check', 'SELECT ma_nv FROM luong', VIEWS, KEYS);
    expect(keyOf(after)).toBe('ok');
  });
});
