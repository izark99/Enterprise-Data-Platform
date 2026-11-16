// `code.sql` and its guard in Chromium (docs/redesign/06-plan.md T-R1-08 AC a–f; spec §9.2,
// §12.1.8). DuckDB's parser comes from the `json` extension, which only the browser can load
// (MEMORY 2026-11-16 14:30, 3A), so these run on the E2E harness page `e2e-engine.html` against the
// real worker-side engine. Fake data only.
import type { BrowserContext, Page } from '@playwright/test';
import type {
  EngineErrorReply as EngineErrorWire,
  HarnessReply as Reply,
} from '../support/engine-harness';
import { expect, test } from '../support/fixtures';

type Cell = string | number | boolean | null | { dec: string };
interface Column {
  key: string;
  title: string;
  type: string;
}
interface WireTable {
  columns: Column[];
  rows: Cell[][];
}
interface RunValue {
  outputs: Record<string, Record<string, WireTable>>;
  queries: string[];
  materialised: number;
}

const dec = (text: string): Cell => ({ dec: text });

const LUONG: WireTable = {
  columns: [
    { key: 'ma_nv', title: 'Mã NV', type: 'string' },
    { key: 'cong', title: 'Công', type: 'decimal' },
    { key: 'ot', title: 'OT', type: 'integer' },
    { key: 'ngay', title: 'Ngày', type: 'date' },
    { key: 'dang_lam', title: 'Đang làm', type: 'boolean' },
  ],
  rows: [
    ['NV2', dec('20.5'), 3, '2026-09-02', true],
    ['NV1', dec('22'), null, '2026-09-01', false],
    ['NV3', null, 7, null, null],
  ],
};
const CHAM_CONG: WireTable = {
  columns: [
    { key: 'ma_nv', title: 'Mã nhân viên', type: 'string' },
    { key: 'cong', title: 'Công thực tế', type: 'decimal' },
    { key: '_source_file', title: '_source_file', type: 'string' },
  ],
  rows: [
    ['NV1', dec('21'), 'a.xlsx'],
    ['NV2', dec('20.5'), 'b.xlsx'],
  ],
};
const DATA = { luong: LUONG, cham_cong: CHAM_CONG };
const PARAMS = [
  { key: 'ky_luong', label: 'Kỳ lương', type: 'month', required: true },
  { key: 'ten', label: 'Tên', type: 'string', required: false },
  { key: 'chi_nhanh', label: 'Chi nhánh', type: 'string', required: false },
];
const VIEWS = ['luong', 'cham_cong'];
const KEYS = PARAMS.map((p) => p.key);

type NodeSpec = [id: string, type: string, config: unknown];
type EdgeSpec = [from: string, to: string, toPort?: string];

function buildFlow(nodes: NodeSpec[], edges: EdgeSpec[]) {
  return {
    schemaVersion: 1,
    params: PARAMS,
    inputSlots: [],
    nodes: nodes.map(([id, type, config]) => ({ id, type, config })),
    edges: edges.map(([from, to, toPort]) => ({ from, to, ...(toPort ? { toPort } : {}) })),
  };
}

function sqlFlow(sql: string) {
  return buildFlow(
    [
      ['src_l', 'test.source', { name: 'luong' }],
      ['src_c', 'test.source', { name: 'cham_cong' }],
      ['sql', 'code.sql', { inputs: [{ port: 'luong' }, { port: 'cham_cong' }], sql }],
    ],
    [
      ['src_l', 'sql', 'luong'],
      ['src_c', 'sql', 'cham_cong'],
    ],
  );
}

// One page (one DuckDB) for the whole file; tests run in order on one worker.
test.describe.configure({ mode: 'default' });

let context: BrowserContext;
let page: Page;

test.beforeAll(async ({ browser }, testInfo) => {
  context = await browser.newContext({ baseURL: testInfo.project.use.baseURL });
  page = await context.newPage();
  await page.goto('/e2e-engine.html');
  await expect(page.locator('#status')).toHaveText('ready');
});

test.afterAll(async () => {
  await context.close();
});

function call(op: string, ...args: unknown[]): Promise<Reply> {
  return page.evaluate(([name, rest]) => window.__hrflowEngineHarness!.call(name, ...rest), [
    op,
    args,
  ] as const);
}

async function ok<T>(op: string, ...args: unknown[]): Promise<T> {
  const reply = await call(op, ...args);
  if (!reply.ok) throw new Error(`${op} failed: ${JSON.stringify(reply.error)}`);
  return reply.value as T;
}

async function engineError(op: string, ...args: unknown[]): Promise<EngineErrorWire> {
  const reply = await call(op, ...args);
  if (reply.ok) throw new Error(`${op} succeeded: ${JSON.stringify(args[0])}`);
  if (!reply.error.engine) throw new Error(`not an EngineError: ${JSON.stringify(reply.error)}`);
  return reply.error;
}

const checkError = (sql: string) => engineError('check', sql, VIEWS, KEYS);
const run = (flow: unknown, params: Record<string, string | null> = { ky_luong: '2026-09' }) =>
  ok<RunValue>('run', flow, DATA, params);
const runError = (flow: unknown, params: Record<string, string | null> = { ky_luong: '2026-09' }) =>
  engineError('run', flow, DATA, params);

test.describe('DuckDB runtime', () => {
  test('loads json before the lock; afterwards no extension can load', async () => {
    expect(await ok('scalar', "SELECT current_setting('lock_configuration')::VARCHAR")).toBe(
      'true',
    );
    expect(await ok('scalar', "SELECT json_serialize_sql('SELECT 1') IS NOT NULL")).toBe('true');
    expect((await call('exec', 'LOAD httpfs')).ok).toBe(false);
    expect((await call('exec', 'SET lock_configuration = false')).ok).toBe(false);
    expect((await call('exec', "SELECT * FROM read_json('x.json')")).ok).toBe(false);
  });
});

test.describe('guard (AC a, b)', () => {
  const NOT_SELECT = [
    "COPY luong TO 'out.csv'",
    "COPY (SELECT * FROM luong) TO 'out.parquet' (FORMAT parquet)",
    "ATTACH 'other.db' AS o",
    'INSTALL httpfs',
    'LOAD httpfs',
    "EXPORT DATABASE 'dir'",
    'PRAGMA version',
    'SET threads = 1',
    'RESET threads',
    'CREATE TABLE t AS SELECT * FROM luong',
    'CREATE VIEW v AS SELECT * FROM luong',
    'DROP TABLE luong',
    "INSERT INTO luong VALUES ('x')",
    "UPDATE luong SET ma_nv = 'x'",
    'DELETE FROM luong',
    'WITH x AS (DELETE FROM luong RETURNING *) SELECT * FROM x',
    'CALL pragma_version()',
    '-- only a comment',
  ];
  test('refuses every statement that is not one SELECT (sql.error.notSelect)', async () => {
    for (const sql of NOT_SELECT) {
      expect((await checkError(sql)).info.messageKey, sql).toBe('sql.error.notSelect');
    }
  });

  const FORBIDDEN = [
    "SELECT * FROM read_csv('https://example.invalid/a.csv')",
    "SELECT * FROM read_csv_auto('/etc/hosts')",
    "SELECT * FROM 'data.csv'",
    "WITH c AS (SELECT * FROM read_parquet('a.parquet')) SELECT * FROM c",
    "/* x */ sElEcT * FrOm ReAd_JsOn('x.json') -- y",
    'SELECT * FROM luong WHERE ma_nv IN (SELECT * FROM range(3))',
    "SELECT * FROM luong, LATERAL (SELECT * FROM read_text('x'))",
    "SELECT * FROM pragma_table_info('luong')",
    'SELECT * FROM duckdb_settings()',
    'SELECT * FROM duckdb_tables()',
    'SELECT * FROM main.luong',
    'SELECT * FROM memory.main.luong',
    'SELECT * FROM information_schema.tables',
    'SELECT * FROM hr_tab_1',
    'SELECT * FROM "LUONG_KHAC"',
    'SELECT * FROM (SHOW TABLES)',
  ];
  test('refuses a file, URL, catalog or foreign table (sql.error.forbidden)', async () => {
    for (const sql of FORBIDDEN) {
      expect((await checkError(sql)).info.messageKey, sql).toBe('sql.error.forbidden');
    }
  });

  test('accepts its views (any case) and its own CTEs', async () => {
    for (const sql of [
      'SELECT * FROM luong',
      'select * from LUONG l join "cham_cong" c using (ma_nv)',
      'WITH c AS (SELECT ma_nv FROM luong), d AS (SELECT * FROM c) SELECT * FROM d',
      'SELECT ma_nv FROM luong UNION ALL SELECT ma_nv FROM cham_cong ORDER BY 1',
    ]) {
      expect((await call('check', sql, VIEWS, KEYS)).ok, sql).toBe(true);
    }
  });

  test('refuses two statements; a syntax error has screen-only detail', async () => {
    expect((await checkError('SELECT 1 FROM luong; SELECT 2 FROM luong')).info.messageKey).toBe(
      'sql.error.multipleStatements',
    );
    const syntax = await checkError('SELEC ma_nv FROM luong');
    expect(syntax.info.messageKey).toBe('sql.error.syntax');
    expect(syntax.info.params).toEqual({});
    expect(syntax.info.detail).toMatch(/syntax error/i);
    expect(syntax.info.path).toEqual(['sql']);
    expect(syntax.log).toEqual({ messageKey: 'sql.error.syntax' });
  });

  test('refuses unknown, positional and numbered parameters', async () => {
    const unknown = await checkError('SELECT $khong_co FROM luong');
    expect(unknown.info).toMatchObject({
      messageKey: 'sql.error.unknownParam',
      params: { param: 'khong_co' },
    });
    expect((await checkError('SELECT ? FROM luong')).info.params).toEqual({ param: '?' });
    expect((await checkError('SELECT $1 FROM luong')).info.params).toEqual({ param: '?' });
  });

  test('replaces only real parameters (not inside strings, names, comments)', async () => {
    const sql =
      "SELECT '$ten' AS a, \"$ten\" AS b, $$x $ten$$ AS c, $q$ $ten $q$ AS d, E'\\' $ten' AS e," +
      ' $ten AS p /* $ten */ -- $ten\nFROM luong WHERE $ky_luong IS NOT NULL';
    const checked = await ok<{ paramKeys: string[]; sql: string }>('check', sql, VIEWS, KEYS);
    expect(checked.paramKeys).toEqual(['ten', 'ky_luong']);
    expect(checked.sql.split('CAST(? AS VARCHAR)')).toHaveLength(3);
  });

  test('tells whether the outer query is ordered', async () => {
    const ordered = (sql: string) =>
      ok<{ ordered: boolean }>('check', sql, VIEWS, KEYS).then((c) => c.ordered);
    expect(await ordered('SELECT * FROM luong ORDER BY ma_nv')).toBe(true);
    expect(await ordered('SELECT * FROM (SELECT * FROM luong ORDER BY 1)')).toBe(false);
  });
});

test.describe('parameters (AC c)', () => {
  test('binds a value with a quote unchanged and never puts it in the SQL text', async () => {
    const evil = "x' OR 1=1 --";
    const result = await run(
      sqlFlow(
        "SELECT $ten AS t, '$ten' AS lit, ma_nv FROM luong WHERE ma_nv = 'NV1' OR $ten = 'zz'",
      ),
      { ten: evil, ky_luong: '2026-09' },
    );
    expect(result.outputs['sql']!['out']!.rows).toEqual([[evil, '$ten', 'NV1']]);
    expect(result.queries.length).toBeGreaterThan(0);
    expect(result.queries.some((t) => t.includes(evil))).toBe(false);
    expect(result.queries.some((t) => t.includes('OR 1=1'))).toBe(false);
  });

  test('binds parameters in the canonical text form; blank is NULL', async () => {
    const result = await run(
      sqlFlow(
        "SELECT CAST($ky_luong || '-01' AS DATE) AS ngay_dau, $ten IS NULL AS trong FROM luong " +
          "WHERE ma_nv = 'NV1'",
      ),
      { ky_luong: '2026-09', ten: '' },
    );
    expect(result.outputs['sql']!['out']!.rows).toEqual([['2026-09-01', true]]);
  });

  test('keeps upstream filter parameters and its own in order (pushdown)', async () => {
    const flow = buildFlow(
      [
        ['src_l', 'test.source', { name: 'luong' }],
        [
          'flt',
          'transform.filter',
          { conditions: [{ column: 'ma_nv', op: 'neq', value: { param: 'chi_nhanh' } }] },
        ],
        [
          'sql',
          'code.sql',
          { inputs: [{ port: 'luong' }], sql: 'SELECT ma_nv, $ten AS t FROM luong ORDER BY ma_nv' },
        ],
        ['sel', 'transform.select', { columns: [{ from: 't' }, { from: 'ma_nv' }] }],
      ],
      [
        ['src_l', 'flt'],
        ['flt', 'sql', 'luong'],
        ['sql', 'sel'],
      ],
    );
    const result = await run(flow, { chi_nhanh: 'NV2', ten: 'ok', ky_luong: '2026-09' });
    expect(result.outputs['sel']!['out']!.rows).toEqual([
      ['ok', 'NV1'],
      ['ok', 'NV3'],
    ]);
    // filter → code.sql → select run as one chain, materialised once for the result.
    expect(result.materialised).toBe(1);
  });
});

test.describe('schema (AC d, e)', () => {
  const SQL =
    'SELECT l.ma_nv, l.cong + 1 AS cong, l.ot, l.ngay, l.dang_lam, c._source_file,' +
    ' count(*) OVER () AS so_dong, sum(l.ot) OVER () AS tong_ot, 1 / 3 AS mot_phan_ba,' +
    " CAST('2026-09-01 08:30:45.5' AS TIMESTAMP) AS luc" +
    ' FROM luong l LEFT JOIN cham_cong c USING (ma_nv) ORDER BY l.ma_nv';

  test('DESCRIBE schema equals the run schema, titles from the inputs', async () => {
    const config = { inputs: [{ port: 'luong' }, { port: 'cham_cong' }], sql: SQL };
    const inferred = await ok<{
      schemas: Record<string, Column[]>;
      warnings: { messageKey: string; params: Record<string, unknown> }[];
    }>('infer', config, { luong: LUONG.columns, cham_cong: CHAM_CONG.columns }, PARAMS);
    const out = (await run(sqlFlow(SQL))).outputs['sql']!['out']!;
    expect(inferred.schemas['out']).toEqual(out.columns);
    expect(inferred.schemas['out']).toEqual([
      { key: 'ma_nv', title: 'Mã NV', type: 'string' },
      { key: 'cong', title: 'Công', type: 'decimal' },
      { key: 'ot', title: 'OT', type: 'integer' },
      { key: 'ngay', title: 'Ngày', type: 'date' },
      { key: 'dang_lam', title: 'Đang làm', type: 'boolean' },
      { key: '_source_file', title: '_source_file', type: 'string' },
      { key: 'so_dong', title: 'so_dong', type: 'integer' },
      { key: 'tong_ot', title: 'tong_ot', type: 'decimal' },
      { key: 'mot_phan_ba', title: 'mot_phan_ba', type: 'decimal' },
      { key: 'luc', title: 'luc', type: 'datetime' },
    ]);
    expect(out.rows[0]).toEqual([
      'NV1',
      '23',
      null,
      '2026-09-01',
      false,
      'a.xlsx',
      3,
      '10',
      '0.3333333333',
      '2026-09-01T08:30:45',
    ]);
    // AC e: the DOUBLE column is a decimal and the Designer gets the warning; ordered → no reminder.
    expect(inferred.warnings).toEqual([
      { messageKey: 'sql.warning.doubleColumn', params: { column: 'mot_phan_ba' } },
    ]);
  });

  test('runs a statement ending with a semicolon and a line comment', async () => {
    const result = await run(sqlFlow("SELECT ma_nv FROM luong WHERE ma_nv = 'NV1'; -- cuối"));
    expect(result.outputs['sql']!['out']!.rows).toEqual([['NV1']]);
  });

  test('reminds about a missing outer ORDER BY', async () => {
    const inferred = await ok<{ warnings: unknown[] }>(
      'infer',
      { inputs: [{ port: 'luong' }], sql: 'SELECT ma_nv FROM luong' },
      { luong: LUONG.columns },
      PARAMS,
    );
    expect(inferred.warnings).toEqual([{ messageKey: 'sql.warning.noOrderBy', params: {} }]);
  });

  test('reads DOUBLE with 15 significant digits; NaN and overflow name the column', async () => {
    const result = await run(sqlFlow('SELECT 25.499999999999996::DOUBLE AS x'));
    expect(result.outputs['sql']!['out']!.rows).toEqual([['25.5']]);
    expect((await runError(sqlFlow("SELECT 'nan'::DOUBLE AS x"))).info).toMatchObject({
      messageKey: 'sql.error.notFinite',
      params: { column: 'x' },
      nodeId: 'sql',
    });
    expect((await runError(sqlFlow('SELECT 1e30::DOUBLE AS big'))).info).toMatchObject({
      messageKey: 'duckdb.error.decimalOverflow',
      params: { column: 'big' },
    });
  });

  const REFUSED: [string, string, Record<string, string>][] = [
    ['SELECT ma_nv AS "Mã" FROM luong', 'sql.error.invalidColumnName', { column: 'Mã' }],
    ['SELECT ma_nv AS _rieng FROM luong', 'sql.error.invalidColumnName', { column: '_rieng' }],
    ['SELECT ma_nv, ma_nv FROM luong', 'sql.error.duplicateColumn', { column: 'ma_nv' }],
    ['SELECT [1, 2] AS l', 'sql.error.unsupportedType', { column: 'l', type: 'INTEGER[]' }],
    ['SELECT khong_co FROM luong', 'sql.error.runtime', {}],
  ];
  test('refuses invalid, duplicate and unsupported columns at the node', async () => {
    for (const [sql, key, params] of REFUSED) {
      const err = await runError(sqlFlow(sql));
      expect(err.info, sql).toMatchObject({
        messageKey: key,
        params,
        nodeId: 'sql',
        path: ['sql'],
      });
    }
  });
});

test.describe('errors (AC f)', () => {
  test('a run failure keeps DuckDB text on screen only, never in the run log', async () => {
    const err = await runError(sqlFlow('SELECT CAST(ma_nv AS INTEGER) AS n FROM luong'));
    expect(err.info.messageKey).toBe('sql.error.runtime');
    expect(err.info.nodeId).toBe('sql');
    expect(err.message).toBe('sql.error.runtime');
    expect(err.info.detail).toMatch(/NV\d/);
    expect(err.info.detail!.length).toBeLessThanOrEqual(500);
    expect(err.log).toEqual({ messageKey: 'sql.error.runtime', nodeId: 'sql' });
    expect(JSON.stringify(err.log)).not.toMatch(/NV\d/);
    expect(JSON.stringify(err.info.params)).not.toMatch(/NV\d/);
  });
});

test.describe('views', () => {
  test('a port named like a run table reads its own input, not the table', async () => {
    await ok(
      'exec',
      'CREATE TABLE hr_tab_code_sql_probe AS SELECT 99::BIGINT AS v, 1::BIGINT AS "hr$ord"',
    );
    await ok(
      'exec',
      'CREATE TABLE hr_tab_code_sql_input AS SELECT 7::BIGINT AS v, 1::BIGINT AS "hr$ord"',
    );
    const q = await ok<{ sql: string; params: (string | null)[] }>(
      'compile',
      { inputs: [{ port: 'hr_tab_code_sql_probe' }], sql: 'SELECT v FROM hr_tab_code_sql_probe' },
      {
        hr_tab_code_sql_probe: {
          ref: '"hr_tab_code_sql_input"',
          columns: [{ key: 'v', title: 'V', type: 'integer' }],
        },
      },
      PARAMS,
    );
    expect(await ok('scalar', `SELECT v FROM (${q.sql})`, q.params)).toBe('7');
    await ok('exec', 'DROP TABLE hr_tab_code_sql_probe');
    await ok('exec', 'DROP TABLE hr_tab_code_sql_input');
  });
});
