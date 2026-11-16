// Fuzz of the `code.sql` guard and the `$key` rewrite (T-R1-08; spec §9.2, §12.1.8; engine rule:
// code that parses external input is fuzzed by the verifier). The input is Admin-written SQL. Runs
// in Chromium on the E2E harness page (the parser lives in DuckDB's `json` extension, which Node
// cannot load). Fixed seed; a fast default run, more cases with HRFLOW_HEAVY=1. Fake data only.
//
// Oracles:
// - the guard never accepts a forbidden statement, and every refusal is an EngineError whose key
//   is a `sql.error.*` / `duckdb.error.*` key (never a raw error, never a hang);
// - an accepted statement with `$key` parameters returns exactly the values the original
//   statement means (strings, quoted names, dollar quotes and comments untouched) and no parameter
//   value ever appears in a DuckDB statement text;
// - an accepted mutated statement never returns the content of a run table it may not read.
import type { BrowserContext, Page } from '@playwright/test';
import type { EngineErrorReply, HarnessReply } from '../support/engine-harness';
import { expect, test } from '../support/fixtures';

const HEAVY =
  (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env[
    'HRFLOW_HEAVY'
  ] === '1';
const SCALE = HEAVY ? 10 : 1;
const CALL_TIMEOUT_MS = 20_000;

/** mulberry32: small, fixed-seed PRNG. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Rand = () => number;
const pick = <T>(r: Rand, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;

type Cell = string | number | boolean | null | { dec: string };
interface WireTable {
  columns: { key: string; title: string; type: string }[];
  rows: Cell[][];
}
interface RunValue {
  outputs: Record<string, Record<string, WireTable>>;
  queries: string[];
}

const LUONG: WireTable = {
  columns: [
    { key: 'ma_nv', title: 'Mã NV', type: 'string' },
    { key: 'ot', title: 'OT', type: 'integer' },
  ],
  rows: [
    ['NV1', 3],
    ['NV2', null],
  ],
};
const CHAM_CONG: WireTable = {
  columns: [
    { key: 'ma_nv', title: 'Mã nhân viên', type: 'string' },
    { key: 'cong', title: 'Công', type: 'decimal' },
  ],
  rows: [['NV1', { dec: '21' }]],
};
const DATA = { luong: LUONG, cham_cong: CHAM_CONG };
const PARAMS = [
  { key: 'ky_luong', label: 'Kỳ lương', type: 'string', required: true },
  { key: 'ten', label: 'Tên', type: 'string', required: false },
];
const VIEWS = ['luong', 'cham_cong'];
const KEYS = PARAMS.map((p) => p.key);
/** A run table that no `code.sql` node may read (stands for another node's `hr_tab_<n>`). */
const CANARY_TABLE = 'hr_tab_fuzz_canary';
const CANARY = 'CANARY_7f3a';

const ALLOWED_KEY = new RegExp(
  '^(sql\\.error\\.(notSelect|multipleStatements|syntax|forbidden|unknownParam|runtime|' +
    'invalidColumnName|duplicateColumn|unsupportedType|notFinite)|duckdb\\.error\\.[A-Za-z]+)$',
);

function sqlFlow(sql: string) {
  return {
    schemaVersion: 1,
    params: PARAMS,
    inputSlots: [],
    nodes: [
      { id: 'src_l', type: 'test.source', config: { name: 'luong' } },
      { id: 'src_c', type: 'test.source', config: { name: 'cham_cong' } },
      {
        id: 'sql',
        type: 'code.sql',
        config: { inputs: [{ port: 'luong' }, { port: 'cham_cong' }], sql },
      },
    ],
    edges: [
      { from: 'src_l', to: 'sql', toPort: 'luong' },
      { from: 'src_c', to: 'sql', toPort: 'cham_cong' },
    ],
  };
}

test.describe.configure({ mode: 'default' });

let context: BrowserContext;
let page: Page;

test.beforeAll(async ({ browser }, testInfo) => {
  context = await browser.newContext({ baseURL: testInfo.project.use.baseURL });
  page = await context.newPage();
  await page.goto('/e2e-engine.html');
  await expect(page.locator('#status')).toHaveText('ready');
  const made = await call('exec', `CREATE TABLE ${CANARY_TABLE} AS SELECT '${CANARY}' AS ma_nv`);
  expect(made.ok).toBe(true);
});

test.afterAll(async () => {
  await context.close();
});

async function call(op: string, ...args: unknown[]): Promise<HarnessReply> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const hang = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`hang: ${op} > ${CALL_TIMEOUT_MS} ms`)),
      CALL_TIMEOUT_MS,
    );
  });
  try {
    return await Promise.race([
      page.evaluate(([name, rest]) => window.__hrflowEngineHarness!.call(name, ...rest), [
        op,
        args,
      ] as const),
      hang,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

type Outcome = 'ok' | string;

/** `ok`, or the error key; a raw (non-EngineError) error or a foreign key fails the test. */
function outcomeOf(reply: HarnessReply, input: string, extra: readonly string[] = []): Outcome {
  if (reply.ok) return 'ok';
  const err = reply.error;
  expect(err.engine, `raw error for ${JSON.stringify(input.slice(0, 300))}`).toBe(true);
  const key = (err as EngineErrorReply).info.messageKey;
  if (!extra.includes(key)) {
    expect(key, `key for ${JSON.stringify(input.slice(0, 300))}`).toMatch(ALLOWED_KEY);
  }
  // DuckDB's text is screen-only: never a param, never in the run log.
  expect(Object.keys((err as EngineErrorReply).log).sort()).toEqual(
    expect.arrayContaining(['messageKey']),
  );
  for (const k of Object.keys((err as EngineErrorReply).log)) {
    expect(['messageKey', 'nodeId']).toContain(k);
  }
  return key;
}

const check = (sql: string) => call('check', sql, VIEWS, KEYS);

class Tally {
  readonly counts = new Map<string, Map<string, number>>();
  add(category: string, outcome: Outcome): void {
    const m = this.counts.get(category) ?? new Map<string, number>();
    m.set(outcome, (m.get(outcome) ?? 0) + 1);
    this.counts.set(category, m);
  }
  print(title: string): void {
    for (const [cat, m] of this.counts) {
      const parts = [...m].map(([k, n]) => `${k}=${n}`).join(' ');
      console.log(`[fuzz ${title}] ${cat}: ${parts}`);
    }
  }
}

// ---------------------------------------------------------------- decorations (casing, comments)

const SPACES = [' ', '  ', '\n', '\t', ' /* c */ ', ' /* /* n */ */ ', ' -- c\n', '\r\n'];

/** Random casing of SQL keywords, random whitespace / comments between tokens. */
function decorate(r: Rand, sql: string): string {
  // Only outside quotes: the generators below put quotes only around simple literals.
  const parts = sql.split(/('(?:[^']|'')*'|"[^"]*")/);
  return parts
    .map((p, i) => {
      if (i % 2 === 1) return p;
      let s = p.replace(/[A-Za-z_]+/g, (w) =>
        r() < 0.5 ? w : [...w].map((c) => (r() < 0.5 ? c.toUpperCase() : c.toLowerCase())).join(''),
      );
      s = s.replace(/ /g, () => (r() < 0.25 ? pick(r, SPACES) : ' '));
      return s;
    })
    .join('');
}

function lead(r: Rand): string {
  return pick(r, ['', '', '/* x */ ', '-- x\n', '\n  ', '/* /* y */ */\n']);
}
function trail(r: Rand): string {
  return pick(r, ['', '', ';', ' ;', '; -- z', ';\n/* z */', ' -- z', '\n']);
}

// ---------------------------------------------------------------- categories

const NOT_SELECT = [
  "COPY luong TO 'out.csv'",
  "COPY (SELECT * FROM luong) TO 'out.parquet' (FORMAT parquet)",
  "COPY luong FROM 'in.csv'",
  "ATTACH 'other.db' AS o",
  "ATTACH ':memory:' AS m",
  'DETACH m',
  'USE memory',
  'INSTALL httpfs',
  "INSTALL json FROM 'https://example.invalid'",
  'LOAD httpfs',
  "LOAD '/x/y.duckdb_extension'",
  'FORCE INSTALL httpfs',
  "EXPORT DATABASE 'dir'",
  "IMPORT DATABASE 'dir'",
  'PRAGMA version',
  "PRAGMA table_info('luong')",
  'SET threads = 1',
  'SET enable_external_access = true',
  'SET lock_configuration = false',
  "SET VARIABLE x = 'a'",
  'RESET threads',
  'CALL pragma_version()',
  "CALL query('SELECT 1')",
  'CREATE TABLE t AS SELECT * FROM luong',
  'CREATE TEMP TABLE t (a INT)',
  'CREATE VIEW v AS SELECT * FROM luong',
  'CREATE MACRO m(a) AS a',
  'CREATE MACRO m(a) AS TABLE SELECT a',
  'CREATE OR REPLACE FUNCTION f(a) AS a + 1',
  'CREATE SEQUENCE s',
  'CREATE SCHEMA s',
  "CREATE TYPE mood AS ENUM ('a')",
  'CREATE SECRET (TYPE s3)',
  'ALTER TABLE luong ADD COLUMN x INT',
  'DROP TABLE luong',
  `DROP TABLE ${CANARY_TABLE}`,
  "INSERT INTO luong VALUES ('x', 1)",
  `INSERT INTO ${CANARY_TABLE} SELECT 'x'`,
  "UPDATE luong SET ma_nv = 'x'",
  'DELETE FROM luong',
  `TRUNCATE ${CANARY_TABLE}`,
  'MERGE INTO luong USING cham_cong ON luong.ma_nv = cham_cong.ma_nv WHEN MATCHED THEN DELETE',
  'WITH x AS (DELETE FROM luong RETURNING *) SELECT * FROM x',
  'WITH x AS (INSERT INTO luong VALUES (1, 2) RETURNING *) SELECT * FROM x',
  'EXPLAIN SELECT * FROM luong',
  'EXPLAIN ANALYZE SELECT * FROM luong',
  'PREPARE p AS SELECT 1',
  'EXECUTE p',
  'DEALLOCATE p',
  'BEGIN TRANSACTION',
  'COMMIT',
  'CHECKPOINT',
  'VACUUM',
  'ANALYZE',
  'DESCRIBE TABLE luong',
  'PIVOT luong ON ma_nv USING sum(ot)',
  'UPDATE EXTENSIONS',
  'DETACH DATABASE IF EXISTS m',
  '-- only a comment',
  '/* only */',
  ';',
  '',
];

/** Sources the statement may never read. */
const FORBIDDEN_SOURCES = [
  "read_csv('x.csv')",
  "read_csv_auto('/etc/hosts')",
  "read_parquet('https://example.invalid/a.parquet')",
  "read_json('x.json')",
  "read_json_auto('x.json')",
  "read_text('x')",
  "read_blob('x')",
  "read_ndjson('x')",
  "parquet_scan('x')",
  "parquet_metadata('x')",
  "glob('*')",
  "sniff_csv('x')",
  'range(3)',
  'range(1, 3) t(n)',
  'generate_series(1, 3)',
  'unnest([1, 2])',
  "query('SELECT 1')",
  `query_table('${CANARY_TABLE}')`,
  "pragma_table_info('luong')",
  'pragma_version()',
  'pragma_database_list()',
  "pragma_storage_info('luong')",
  'duckdb_settings()',
  'duckdb_tables()',
  'duckdb_columns()',
  'duckdb_extensions()',
  'duckdb_functions()',
  'duckdb_secrets()',
  'test_all_types()',
  "json_execute_serialized_sql(json_serialize_sql('SELECT 1'))",
  "which_secret('s3://x', 's3')",
  "'x.csv'",
  "'https://example.invalid/x.parquet'",
  '"x.csv"',
  CANARY_TABLE,
  'HR_TAB_FUZZ_CANARY',
  `"${CANARY_TABLE}"`,
  'hr_tab_1',
  'duckdb_tables',
  'duckdb_columns',
  'duckdb_settings',
  'sqlite_master',
  'sqlite_schema',
  'pg_tables',
  'information_schema.tables',
  'main.luong',
  'memory.main.luong',
  'temp.main.luong',
  'temp.luong',
  '"main"."luong"',
  'memory.luong',
  'system.main.duckdb_tables',
  'pg_catalog.pg_class',
  '(SHOW TABLES)',
  '(DESCRIBE luong)',
  '(SUMMARIZE luong)',
  '(SHOW ALL TABLES)',
];

/** Places to put a source `S` (a `FROM` item). Every result must be refused. */
const CONTEXTS: ((s: string) => string)[] = [
  (s) => `SELECT * FROM ${s}`,
  (s) => `FROM ${s}`,
  (s) => `FROM ${s} SELECT *`,
  (s) => `WITH c AS (SELECT * FROM ${s}) SELECT * FROM c`,
  (s) => `WITH c AS MATERIALIZED (FROM ${s}) SELECT * FROM luong`,
  (s) => `WITH a AS (SELECT 1 AS x), b AS (SELECT * FROM ${s}) SELECT * FROM a`,
  (s) => `WITH c AS (WITH d AS (SELECT * FROM ${s}) SELECT * FROM d) SELECT * FROM c`,
  (s) => `SELECT * FROM (SELECT * FROM ${s}) q`,
  (s) => `SELECT * FROM luong, LATERAL (SELECT * FROM ${s}) q`,
  (s) => `SELECT * FROM luong JOIN ${s} ON true`,
  (s) => `SELECT * FROM luong LEFT JOIN (SELECT * FROM ${s}) q ON true`,
  (s) => `SELECT * FROM luong POSITIONAL JOIN ${s}`,
  (s) => `SELECT * FROM luong CROSS JOIN ${s}`,
  (s) => `SELECT * FROM luong ASOF JOIN ${s} ON true`,
  (s) => `SELECT ma_nv FROM luong UNION ALL SELECT * FROM ${s}`,
  (s) => `SELECT ma_nv FROM luong UNION BY NAME SELECT * FROM ${s}`,
  (s) => `SELECT ma_nv FROM luong INTERSECT SELECT * FROM ${s}`,
  (s) => `SELECT ma_nv FROM luong EXCEPT SELECT * FROM ${s}`,
  (s) => `(SELECT * FROM ${s}) UNION (SELECT ma_nv FROM luong)`,
  (s) => `SELECT (SELECT count(*) FROM ${s}) AS n`,
  (s) => `SELECT * FROM luong WHERE EXISTS (SELECT * FROM ${s})`,
  (s) => `SELECT * FROM luong WHERE ma_nv IN (SELECT * FROM ${s})`,
  (s) => `SELECT * FROM luong WHERE ma_nv = ANY (SELECT * FROM ${s})`,
  (s) => `SELECT CASE WHEN true THEN (SELECT 1 FROM ${s}) END AS c`,
  (s) => `SELECT * FROM luong ORDER BY (SELECT 1 FROM ${s})`,
  (s) => `SELECT ma_nv FROM luong GROUP BY ma_nv HAVING (SELECT count(*) FROM ${s}) > 0`,
  (s) => `SELECT * FROM luong LIMIT (SELECT 1 FROM ${s})`,
  (s) => `SELECT list(x) OVER () FROM (SELECT * FROM ${s}) t(x)`,
  (s) => `SELECT [x FOR x IN (SELECT 1 FROM ${s})] AS l`,
  (s) => `SELECT ARRAY(SELECT 1 FROM ${s}) AS l`,
  (s) =>
    `WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM r, ${s} WHERE n < 3) SELECT * FROM r`,
  (s) =>
    `WITH RECURSIVE r(n) AS (SELECT 1 FROM ${s} UNION ALL SELECT n + 1 FROM r WHERE n < 3) SELECT * FROM r`,
  (s) => `SELECT * FROM ${s} PIVOT (count(*) FOR ma_nv IN ('a'))`,
  (s) => `SELECT * FROM (SELECT * FROM ${s}) PIVOT (count(*) FOR ma_nv IN ('a'))`,
  (s) => `SELECT * FROM ${s} UNPIVOT (v FOR k IN (ma_nv))`,
  (s) => `UNPIVOT ${s} ON ma_nv INTO NAME k VALUE v`,
  (s) => `SELECT * FROM (UNPIVOT (SELECT * FROM ${s}) ON COLUMNS(*) INTO NAME k VALUE v)`,
  (s) => `SELECT * FROM (VALUES (1)) v(a), ${s}`,
  (s) => `SELECT * FROM (VALUES ((SELECT 1 FROM ${s}))) v(a)`,
  (s) => `SELECT * FROM luong QUALIFY (SELECT 1 FROM ${s}) = 1`,
  (s) => `SELECT * EXCLUDE (ma_nv) FROM ${s}`,
  (s) => `SELECT COLUMNS(* ) FROM ${s}`,
  (s) => `SELECT * FROM luong USING SAMPLE 1 ROWS, ${s}`,
  (s) => `SELECT * FROM (FROM (FROM (FROM ${s})))`,
  (s) => `SELECT 1 AS a WHERE (SELECT 1 FROM (SELECT 1 FROM (SELECT 1 FROM ${s})))`,
];

/** Second statements after a valid first one. */
const SECOND = [
  'SELECT 2',
  'SELECT * FROM luong',
  "COPY luong TO 'x.csv'",
  'DROP TABLE luong',
  'SET lock_configuration = false',
  'LOAD httpfs',
  "ATTACH 'x.db'",
  'PRAGMA version',
  `SELECT * FROM ${CANARY_TABLE}`,
];

// ---------------------------------------------------------------- rewrite fragments (oracle)

/** An expression and the value it must return when `$ten` = v and `$ky_luong` = '2026-09'. */
interface Fragment {
  readonly sql: string;
  readonly value: (v: string) => Cell;
  readonly params: readonly string[];
}

const F = (sql: string, value: (v: string) => Cell, params: string[] = []): Fragment => ({
  sql,
  value,
  params,
});

const FRAGMENTS: Fragment[] = [
  F('$ten', (v) => v, ['ten']),
  F('$ky_luong', () => '2026-09', ['ky_luong']),
  F("'$ten'", () => '$ten'),
  F("'it''s $ten'", () => "it's $ten"),
  F("E'\\' $ten'", () => "' $ten"),
  F("e'a\\\\' || $ten", (v) => `a\\${v}`, ['ten']),
  F("E'$ten\\n'", () => '$ten\n'),
  F('$$ $ten $$', () => ' $ten '),
  F('$$$$', () => ''),
  F('$q$ $ten $$ x $q$', () => ' $ten $$ x '),
  F('$t$$ten$t$', () => '$ten'),
  F('$ten$ x $ten$', () => ' x '),
  F('$a$ /* $ten */ -- $ten\n$a$', () => ' /* $ten */ -- $ten\n'),
  F("$ten || '$ten'", (v) => `${v}$ten`, ['ten']),
  F('concat($ten, $ky_luong)', (v) => `${v}2026-09`, ['ten', 'ky_luong']),
  F("length('$ten')", () => 4),
  F("'ư $ten 😀'", () => 'ư $ten 😀'),
  F('CAST($ten AS VARCHAR)', (v) => v, ['ten']),
  F('$ten::VARCHAR', (v) => v, ['ten']),
  F('TRY_CAST($ten AS VARCHAR)', (v) => v, ['ten']),
  F('(($ten))', (v) => v, ['ten']),
  F("coalesce($ten, 'x')", (v) => v, ['ten']),
  F('"ma_nv"', () => 'NV1'),
  F("CASE WHEN $ten IS NULL THEN 'n' ELSE $ten END", (v) => v, ['ten', 'ten']),
  F("(SELECT $ten || x FROM (SELECT '-' AS x) s)", (v) => `${v}-`, ['ten']),
  F('(WITH w AS (SELECT $ky_luong AS k) SELECT k || $ten FROM w)', (v) => `2026-09${v}`, [
    'ky_luong',
    'ten',
  ]),
  F("[$ten, '$ten'][2]", () => '$ten', ['ten']),
  F('list_transform([1], x -> $ten)[1]', (v) => v, ['ten']),
  F("format('{}', $ten)", (v) => v, ['ten']),
  F('strlen($ten) > -1', () => true, ['ten']),
];

const SEPARATORS = [
  ', ',
  ',\n',
  ' /* $ten */, ',
  ', /* /* $ten */ $ten */ ',
  ' -- $ten\n, ',
  ',/**/',
  ', -- $ky_luong ? $1\n',
];

const EVIL = [
  "x' OR 1=1 --",
  '$ky_luong',
  '?',
  '$1',
  '*/ SELECT 1 /*',
  '$$',
  '\\',
  "'",
  '"',
  'a\nb',
  'ư 😀 漢字',
  ');DROP TABLE luong;--',
  'CAST(? AS VARCHAR)',
];

function evilValue(r: Rand, i: number): string {
  return `ZQ${i}X${pick(r, EVIL)}`;
}

// ---------------------------------------------------------------- tests

test.describe('guard fuzz', () => {
  test('non-SELECT statements never pass (notSelect / syntax / multipleStatements)', async () => {
    test.setTimeout(300_000 * SCALE);
    const r = prng(0x5eed01);
    const tally = new Tally();
    const n = 3 * SCALE;
    for (const base of NOT_SELECT) {
      for (let k = 0; k < n; k += 1) {
        const sql = k === 0 ? base : lead(r) + decorate(r, base) + trail(r);
        const out = outcomeOf(await check(sql), sql);
        tally.add('notSelect', out);
        expect(out, sql).not.toBe('ok');
        // `DESCRIBE TABLE x` parses as a SELECT over a SHOW ref: forbidden.
        expect(
          [
            'sql.error.notSelect',
            'sql.error.syntax',
            'sql.error.multipleStatements',
            'sql.error.forbidden',
          ],
          sql,
        ).toContain(out);
      }
    }
    tally.print('notSelect');
  });

  test('a table function, file, catalog or foreign table never passes, in any position', async () => {
    test.setTimeout(600_000 * SCALE);
    const r = prng(0x5eed02);
    const tally = new Tally();
    const accepted: string[] = [];
    const total = 400 * SCALE;
    const cases: string[] = [];
    // Every context with every source once in heavy mode; a fixed sample by default.
    if (HEAVY) {
      for (const c of CONTEXTS) for (const s of FORBIDDEN_SOURCES) cases.push(c(s));
    }
    for (let k = 0; k < total; k += 1) {
      cases.push(lead(r) + decorate(r, pick(r, CONTEXTS)(pick(r, FORBIDDEN_SOURCES))) + trail(r));
    }
    for (const sql of cases) {
      const out = outcomeOf(await check(sql), sql);
      tally.add('forbidden', out);
      if (out === 'ok') accepted.push(sql);
      else {
        expect(['sql.error.forbidden', 'sql.error.syntax', 'sql.error.notSelect']).toContain(out);
      }
    }
    tally.print('forbidden');
    expect(accepted).toEqual([]);
  });

  test('a second statement never passes', async () => {
    test.setTimeout(120_000 * SCALE);
    const r = prng(0x5eed03);
    const tally = new Tally();
    for (let k = 0; k < 40 * SCALE; k += 1) {
      const sep = pick(r, [';', '; ', ';\n', ' ; -- c\n', '; /* c */', ';;']);
      const sql = `SELECT ma_nv FROM luong${sep}${decorate(r, pick(r, SECOND))}${trail(r)}`;
      const out = outcomeOf(await check(sql), sql);
      tally.add('multipleStatements', out);
      expect(['sql.error.multipleStatements', 'sql.error.syntax', 'sql.error.notSelect']).toContain(
        out,
      );
    }
    tally.print('multipleStatements');
  });

  test('an undeclared or positional parameter never passes', async () => {
    test.setTimeout(120_000 * SCALE);
    const r = prng(0x5eed04);
    const tally = new Tally();
    const bad = ['$khong_co', '$TEN', '$Ten', '$ten_x', '?', '$1', '$2', '$01', '?1'];
    const where = [
      (p: string) => `SELECT ${p} AS c FROM luong`,
      // The undeclared one first; `$ten, $Ten` is covered by the fixed findings below.
      (p: string) => `SELECT ${p} AS c, $ten AS a FROM luong`,
      (p: string) => `SELECT * FROM luong WHERE ma_nv = ${p}`,
      (p: string) => `WITH c AS (SELECT ${p} AS x) SELECT * FROM c`,
      (p: string) => `SELECT (SELECT ${p}) AS c`,
      (p: string) => `SELECT * FROM luong ORDER BY ${p}`,
      (p: string) => `SELECT * FROM luong LIMIT ${p}`,
      (p: string) => `SELECT list_transform([1], x -> ${p}) AS c`,
    ];
    for (let k = 0; k < 60 * SCALE; k += 1) {
      const sql = lead(r) + pick(r, where)(pick(r, bad)) + trail(r);
      const out = outcomeOf(await check(sql), sql);
      tally.add('unknownParam', out);
      // `$ten` with `$2` / `?`: DuckDB refuses to mix named and positional parameters with a
      // non-parser error, which the guard maps to `notSelect` (still refused).
      expect(['sql.error.unknownParam', 'sql.error.syntax', 'sql.error.notSelect'], sql).toContain(
        out,
      );
    }
    tally.print('unknownParam');
  });

  test('$key rewrite keeps the meaning and never puts a value into SQL text', async () => {
    test.setTimeout(600_000 * SCALE);
    const r = prng(0x5eed05);
    const tally = new Tally();
    const wrong: string[] = [];
    for (let i = 0; i < 120 * SCALE; i += 1) {
      const count = 1 + Math.floor(r() * 5);
      const items: Fragment[] = Array.from({ length: count }, () => pick(r, FRAGMENTS));
      let select = '';
      items.forEach((f, j) => {
        if (j > 0) select += pick(r, SEPARATORS);
        select += `${f.sql} AS ${r() < 0.5 ? `c${j}` : `"c${j}"`}`;
      });
      const alias = r() < 0.3 ? '' : pick(r, [' AS l', ' AS "x$ten"', ' "$ten"', ' AS "a""$ten"']);
      const filter = pick(r, [
        "WHERE ma_nv = 'NV1'",
        "WHERE ma_nv = 'NV1' AND $ky_luong = '2026-09'",
        "WHERE $ten IS NOT NULL AND ma_nv = 'NV1'",
        "WHERE ma_nv = 'NV1' -- $ten\n",
      ]);
      const sql = `${lead(r)}SELECT ${select} FROM luong${alias} ${filter}${trail(r)}`;
      const value = evilValue(r, i);
      const reply = await call('run', sqlFlow(sql), DATA, { ky_luong: '2026-09', ten: value });
      const out = outcomeOf(reply, sql);
      tally.add('rewrite', out);
      if (!reply.ok) {
        wrong.push(`${out}: ${sql}`);
        continue;
      }
      const result = reply.value as RunValue;
      const table = result.outputs['sql']!['out']!;
      expect(table.rows, sql).toEqual([items.map((f) => f.value(value))]);
      const leaked = result.queries.filter((q) => q.includes(`ZQ${i}X`));
      expect(leaked, sql).toEqual([]);
    }
    tally.print('rewrite');
    // A valid statement refused is a false refusal (correctness, not safety).
    expect(wrong).toEqual([]);
  });

  test('mutated statements: only allowed keys, no hang, never a foreign table read', async () => {
    test.setTimeout(900_000 * SCALE);
    const r = prng(0x5eed06);
    const tally = new Tally();
    const seeds = [
      "SELECT ma_nv, $ten AS t FROM luong WHERE ma_nv = 'NV1' ORDER BY 1",
      "WITH c AS (SELECT * FROM luong) SELECT ma_nv, '$ten' AS s FROM c",
      'SELECT l.ma_nv FROM luong l JOIN cham_cong c USING (ma_nv) -- $ten',
      "SELECT $$ $ten $$ AS a, E'\\' $ky_luong' AS b FROM luong /* /* x */ */",
      `SELECT * FROM ${CANARY_TABLE}`,
      "SELECT * FROM read_csv('x.csv')",
      'SELECT ma_nv FROM luong UNION ALL SELECT ma_nv FROM cham_cong',
    ];
    const tokens = [
      "'",
      '"',
      '$',
      '$$',
      '$t$',
      ';',
      '--',
      '/*',
      '*/',
      '\n',
      "E'",
      '\\',
      '(',
      ')',
      ',',
      ' ',
      '$ten',
      '$ky_luong',
      '$1',
      '?',
      'a$ten',
      '$ten$',
      ` ${CANARY_TABLE} `,
      ` "${CANARY_TABLE}" `,
      ` ${CANARY_TABLE.toUpperCase()} `,
      " read_csv('x') ",
      ` UNION ALL SELECT * FROM ${CANARY_TABLE}`,
      ` UNION ALL SELECT ma_nv FROM luong`,
      ' main.',
      ' SELECT ',
      ' FROM ',
      ' WITH ',
      ' AS ',
      ' luong ',
      'ư',
      '😀',
    ];
    for (let i = 0; i < 250 * SCALE; i += 1) {
      let sql = pick(r, seeds);
      const edits = 1 + Math.floor(r() * 4);
      for (let e = 0; e < edits; e += 1) {
        const at = Math.floor(r() * (sql.length + 1));
        const op = r();
        if (op < 0.6) sql = sql.slice(0, at) + pick(r, tokens) + sql.slice(at);
        else if (op < 0.85) sql = sql.slice(0, at) + sql.slice(at + 1 + Math.floor(r() * 6));
        else sql = sql.slice(at) + sql.slice(0, at);
      }
      const checked = await check(sql);
      const out = outcomeOf(checked, sql);
      tally.add('mutation/check', out);
      if (out !== 'ok') continue;
      const reply = await call('run', sqlFlow(sql), DATA, { ky_luong: '2026-09', ten: `ZQ${i}X` });
      const runOut = outcomeOf(reply, sql);
      tally.add('mutation/run', runOut);
      if (reply.ok) {
        expect(JSON.stringify((reply.value as RunValue).outputs), sql).not.toContain(CANARY);
        expect((reply.value as RunValue).queries.some((q) => q.includes(`ZQ${i}X`))).toBe(false);
      }
    }
    tally.print('mutation');
  });

  test('very long, deeply nested and odd inputs: allowed keys only, no hang', async () => {
    test.setTimeout(600_000);
    const tally = new Tally();
    const big = 100_000;
    const inputs: [string, string][] = [
      ['long string', `SELECT '${'$ten '.repeat(big / 5)}' AS c FROM luong`],
      ['long comment', `SELECT 1 AS c /* ${'x'.repeat(big)} */ FROM luong`],
      ['long line comments', `SELECT 1 AS c ${'-- $ten\n'.repeat(big / 8)} FROM luong`],
      ['many params', `SELECT ${'$ten || '.repeat(8_000)}'x' AS c FROM luong`],
      [
        'many columns',
        `SELECT ${Array.from({ length: 5_000 }, (_, i) => `$ten AS c${i}`).join(', ')}`,
      ],
      ['deep parens', `SELECT ${'('.repeat(5_000)}1${')'.repeat(5_000)} AS c`],
      ['deep parens 100k', `SELECT ${'('.repeat(big / 2)}1${')'.repeat(big / 2)} AS c`],
      [
        'deep subqueries',
        `SELECT * FROM ${'(SELECT * FROM '.repeat(500)}luong${') q'.repeat(500)}`,
      ],
      [
        'deep forbidden',
        `SELECT * FROM ${'(SELECT * FROM '.repeat(500)}${CANARY_TABLE}${') q'.repeat(500)}`,
      ],
      ['deep CTEs', `${'WITH c AS ('.repeat(300)}SELECT 1 AS c${') SELECT * FROM c'.repeat(300)}`],
      ['dollars', '$'.repeat(big)],
      ['dollar tags', 'SELECT ' + '$a$'.repeat(big / 3)],
      [
        'open dollar tags',
        'SELECT ' + Array.from({ length: 20_000 }, (_, i) => `$t${i}$`).join(' '),
      ],
      ['quotes', "'".repeat(big)],
      ['E quotes', "SELECT E'" + '\\'.repeat(big) + "'"],
      // Deep comment nesting is refused before the parser (more than 32 levels, fixed finding below).
      ['nested comments', `SELECT 1 ${'/*'.repeat(2_000)} ${'*/'.repeat(2_000)} AS c`],
      ['open nested comment', `SELECT 1 ${'/*'.repeat(2_000)}`],
      ['semicolons', `SELECT 1${';'.repeat(big)}`],
      ['semicolon comments', `SELECT 1 AS c FROM luong; ${'/* x */ -- y\n'.repeat(5_000)}`],
      ['unicode', `SELECT '${'ư😀\u0000‮'.repeat(10_000)}' AS c`],
      ['nul byte', 'SELECT 1 AS c\u0000; DROP TABLE luong'],
      ['bom', `${String.fromCharCode(0xfeff)}SELECT ma_nv FROM luong`],
      ['unicode ident', 'SELECT 1 AS c FROM ŀuong'],
      ['identifier-adjacent', 'SELECT a$ten, $ten$x$ten$, ma_nv$ten FROM luong'],
      ['param in name', 'SELECT 1 AS "$ten" FROM luong'],
      ['lone dollar', 'SELECT $ AS c'],
      ['dollar digit', 'SELECT $1ten AS c'],
    ];
    for (const [name, sql] of inputs) {
      const t0 = Date.now();
      const out = outcomeOf(await check(sql), name);
      tally.add(name, `${out} (${Date.now() - t0} ms)`);
      if (out === 'ok') {
        const reply = await call('run', sqlFlow(sql), DATA, { ky_luong: '2026-09', ten: 'ZQX' });
        // The config allows at most 100,000 characters of SQL (flow-schema).
        const runOut = outcomeOf(reply, name, ['executor.error.invalidConfig']);
        tally.add(`${name}/run`, runOut);
        if (reply.ok) {
          expect(JSON.stringify((reply.value as RunValue).outputs)).not.toContain(CANARY);
        }
      }
    }
    tally.print('stress');
  });
});

test.describe('unreferenced named WINDOW', () => {
  // DuckDB drops a named window that no window function uses, before the AST is serialized: the
  // guard does not see it, and DuckDB never runs it. Accepted, but it must never read anything.
  test('a forbidden source inside an unused WINDOW is never executed', async () => {
    const tally = new Tally();
    for (const s of FORBIDDEN_SOURCES) {
      const sql = `SELECT ma_nv FROM luong WINDOW w AS (ORDER BY (SELECT 1 FROM ${s}))`;
      const out = outcomeOf(await check(sql), sql);
      tally.add('window/check', out);
      if (out !== 'ok') continue;
      const reply = await call('run', sqlFlow(sql), DATA, { ky_luong: '2026-09' });
      const runOut = outcomeOf(reply, sql);
      tally.add('window/run', runOut);
      // Executed, a file / URL source would fail on the locked configuration.
      expect(runOut, sql).toBe('ok');
      expect(JSON.stringify(reply)).not.toContain(CANARY);
    }
    tally.print('window');
  });
});

// ------------------------------------------- fixed findings (verifier T-R1-08, first round)

test.describe('a CTE opens its name only where DuckDB binds it', () => {
  // Was: CTE names collected from the whole AST were allowed everywhere, so a CTE named like a run
  // table (or `duckdb_columns`) opened the real table outside the CTE's scope. `checkTables` now
  // walks the AST with DuckDB's CTE scopes.
  const SHADOWED = [
    `WITH ${CANARY_TABLE} AS (SELECT * FROM ${CANARY_TABLE}) SELECT * FROM ${CANARY_TABLE}`,
    `WITH a AS (SELECT * FROM ${CANARY_TABLE}), ${CANARY_TABLE} AS (SELECT 1) SELECT * FROM a`,
    `SELECT * FROM ${CANARY_TABLE} UNION ALL SELECT * FROM (WITH ${CANARY_TABLE} AS (SELECT 'x') SELECT * FROM ${CANARY_TABLE})`,
    `SELECT (SELECT ma_nv FROM ${CANARY_TABLE}) AS s, (WITH ${CANARY_TABLE} AS (SELECT 1) SELECT 1) AS t`,
    `WITH RECURSIVE ${CANARY_TABLE} AS (SELECT * FROM ${CANARY_TABLE}) SELECT * FROM ${CANARY_TABLE}`,
  ];
  for (const sql of SHADOWED) {
    test(`refuses: ${sql.slice(0, 80)}`, async () => {
      const out = outcomeOf(await check(sql), sql);
      expect(out).toBe('sql.error.forbidden');
    });
  }

  test('a code.sql run never returns the content of another run table', async () => {
    const sql = `WITH ${CANARY_TABLE} AS (SELECT * FROM ${CANARY_TABLE}) SELECT ma_nv FROM ${CANARY_TABLE}`;
    const reply = await call('run', sqlFlow(sql), DATA, { ky_luong: '2026-09' });
    expect(JSON.stringify(reply)).not.toContain(CANARY);
  });

  test('catalog views stay closed (duckdb_columns lists the run tables)', async () => {
    const sql =
      "SELECT string_agg(table_name, ',') AS t FROM duckdb_columns" +
      " UNION ALL SELECT * FROM (WITH duckdb_columns AS (SELECT 'x') SELECT * FROM duckdb_columns)";
    const reply = await call('run', sqlFlow(sql), DATA, { ky_luong: '2026-09' });
    expect(JSON.stringify(reply)).not.toContain(CANARY_TABLE);
  });
});

test.describe('every parameter spelling is checked', () => {
  // Was: DuckDB's `named_param_map` keeps one spelling per name ignoring case, so `$Ten` after
  // `$ten` was bound as NULL. Every `$key` as written is now checked, case-sensitively.
  for (const sql of [
    'SELECT $ten AS a, $Ten AS c FROM luong',
    'SELECT ma_nv FROM luong WHERE $ten IS NULL OR ma_nv = $TEN',
  ]) {
    test(`refuses: ${sql}`, async () => {
      expect(outcomeOf(await check(sql), sql)).toBe('sql.error.unknownParam');
    });
  }
});

test.describe('DESCRIBE types parameters as at run time', () => {
  // Was: `describe` bound parameters as NULL and DuckDB typed this subquery INTEGER; it now binds
  // empty texts, as VARCHAR like a run (AC d).
  test('a statement accepted at design time runs with the described schema', async () => {
    const sql =
      "SELECT (WITH w AS (SELECT $ky_luong AS k) SELECT k || $ten FROM w) AS c0, {'k': $ten}.k AS c4" +
      ' FROM luong';
    const reply = await call('run', sqlFlow(sql), DATA, { ky_luong: '2026-09', ten: 'V' });
    expect(outcomeOf(reply, sql)).toBe('ok');
  });
});

test.describe('deep comment nesting is refused before the parser', () => {
  // Was: DuckDB's parser is quadratic in comment nesting; 50,000 levels (100,000 characters, the
  // config maximum) blocked the worker. More than 32 levels is now `sql.error.syntax` at once.
  test('a 100,000-character statement is checked within the call timeout', async () => {
    test.setTimeout(60_000);
    const sql = `SELECT 1 ${'/*'.repeat(49_990)}`;
    expect(outcomeOf(await check(sql), 'open nested comment 100k')).toBe('sql.error.syntax');
  });
});
