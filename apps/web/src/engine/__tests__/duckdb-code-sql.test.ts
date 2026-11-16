import { beforeAll, describe, expect, it } from 'vitest';
import { EngineError } from '../core/errors';
import type { Schema } from '../core/types';
import type { DuckDb } from '../duckdb/db';
import { DUCKDB_DIALECT } from '../duckdb/scope';
import { DuckDbInspector, replaceParams } from '../duckdb/sql-guard';
import { DuckDbError, toEngineError } from '../duckdb/sql';
import { codeSqlPlugin } from '../nodes/code-sql';
import type {
  CompileContext,
  NodeWarning,
  SqlChecked,
  SqlDescribed,
  SqlInspector,
} from '../nodes/index';
import { nodeDuckDb } from './duckdb-node';
import { buildFlow } from './duckdb-transform-helpers';

/**
 * `code.sql` and its guard (spec §9.2, §12.1.8; T-R1-08), the parts that do not need DuckDB's
 * parser. The parser (`json_serialize_sql`) lives in the `json` extension, which Node cannot load,
 * so the guard, `DESCRIBE` = run schema, parameters and runtime errors (AC a–f) are tested in
 * Chromium: `e2e/engine/code-sql.spec.ts` (MEMORY 2026-11-16 14:30, 3A). Fake data only.
 */

const LUONG: Schema = [
  { key: 'ma_nv', title: 'Mã NV', type: 'string' },
  { key: 'cong', title: 'Công', type: 'decimal' },
];
const CHAM_CONG: Schema = [
  { key: 'ma_nv', title: 'Mã nhân viên', type: 'string' },
  { key: '_source_file', title: '_source_file', type: 'string' },
];
const PARAMS = [
  { key: 'ky_luong', label: 'Kỳ lương', type: 'month' as const, required: true },
  { key: 'ten', label: 'Tên', type: 'string' as const, required: false },
  { key: 'co', label: 'Có', type: 'boolean' as const, required: false },
];
const FLOW = buildFlow([], [], PARAMS);

let db: DuckDb;
beforeAll(async () => {
  db = await nodeDuckDb();
}, 60_000);

const col = (name: string, duckType: string, type: SqlDescribed['type'], double = false) => ({
  name,
  duckType,
  type,
  double,
});

/** An inspector without a parser: `check` only rewrites `$key`, `describe` returns `columns`. */
function fakeInspector(columns: readonly SqlDescribed[], ordered = true): SqlInspector {
  return {
    check: (sql) => {
      const out = replaceParams(sql);
      return { sql: out.sql, paramKeys: out.keys, ordered };
    },
    describe: () => columns,
    canonical: (expr, column) => `CAST(${expr} AS ${column.duckType})`,
  };
}

function failure(work: () => unknown): EngineError {
  try {
    work();
  } catch (err) {
    if (err instanceof EngineError) return err;
    throw err;
  }
  throw new Error('expected a failure');
}

describe('replaceParams (the `$key` lexer)', () => {
  it('replaces only real parameters (not inside strings, names, comments)', () => {
    const sql =
      "SELECT '$ten' AS a, \"$ten\" AS b, $$x $ten$$ AS c, $q$ $ten $q$ AS d, E'\\' $ten' AS e," +
      ' $ten AS p /* $ten */ -- $ten\nFROM luong WHERE $ky_luong IS NOT NULL';
    const out = replaceParams(sql);
    expect(out.keys).toEqual(['ten', 'ky_luong']);
    expect(out.sql.split('CAST(? AS VARCHAR)')).toHaveLength(3);
    expect(out.sql).toContain("'$ten' AS a");
    expect(out.sql).toContain('/* $ten */ -- $ten\n');
  });

  it('ignores a `$` inside a word and keeps `$1` / `?` for the parser to refuse', () => {
    expect(replaceParams('SELECT a$ten FROM luong').keys).toEqual([]);
    expect(replaceParams('SELECT $1, ? FROM luong')).toEqual({
      sql: 'SELECT $1, ? FROM luong',
      keys: [],
      commentDepth: 0,
    });
  });

  it('measures comment nesting outside strings (deep nesting is refused before the parser)', () => {
    expect(replaceParams('SELECT 1 /* a /* b /* c */ */ */').commentDepth).toBe(3);
    expect(replaceParams("SELECT '/* /* /*' AS s -- /* /*\n").commentDepth).toBe(0);
    expect(replaceParams(`SELECT 1 ${'/*'.repeat(40)}`).commentDepth).toBe(40);
  });

  it('drops only a final semicolon, keeping comments after it', () => {
    expect(replaceParams('SELECT 1 AS a; -- x').sql).toBe('SELECT 1 AS a -- x');
    expect(replaceParams('SELECT 1 AS a;\n/* y */ ').sql).toBe('SELECT 1 AS a\n/* y */ ');
    expect(replaceParams("SELECT ';' AS a").sql).toBe("SELECT ';' AS a");
    expect(replaceParams('SELECT 1; SELECT 2').sql).toBe('SELECT 1; SELECT 2');
  });
});

describe('DuckDB without the json extension (Node)', () => {
  it('has no parser, and the guard refuses with duckdb.error.unavailable, never a raw error', () => {
    expect(db.parser).toBe(false);
    const err = failure(() =>
      new DuckDbInspector(db).check('SELECT * FROM luong', ['luong'], ['ten']),
    );
    expect(err.messageKey).toBe('duckdb.error.unavailable');
    expect(err.detail).toBeUndefined();
    expect(err.path).toEqual(['sql']);
  });
});

describe('describe (empty typed temporary tables)', () => {
  const inspector = (): DuckDbInspector => new DuckDbInspector(db);
  const checked = (sql: string, paramKeys: string[] = []): SqlChecked => ({
    sql,
    paramKeys,
    ordered: false,
  });

  it('keeps the statement column names and types, with NULL parameters', () => {
    const cols = inspector().describe(
      checked(
        'SELECT l.ma_nv, l.ma_nv, l.cong * 2 AS gap, 1 / 3 AS d, CAST(? AS VARCHAR) AS p,' +
          ' [1] AS l2 FROM luong l JOIN cham_cong c USING (ma_nv)',
        ['ten'],
      ),
      [
        { name: 'luong', columns: LUONG },
        { name: 'cham_cong', columns: CHAM_CONG },
      ],
    );
    expect(cols).toEqual([
      col('ma_nv', 'VARCHAR', 'string'),
      col('ma_nv', 'VARCHAR', 'string'),
      col('gap', 'DECIMAL(38,10)', 'decimal'),
      col('d', 'DOUBLE', 'decimal', true),
      col('p', 'VARCHAR', 'string'),
      col('l2', 'INTEGER[]', null),
    ]);
  });

  it('shadows a run table of the same name and leaves no temporary table', () => {
    db.exec('CREATE TABLE hr_tab_describe_probe AS SELECT 1::INTEGER AS z');
    const cols = inspector().describe(checked('SELECT * FROM hr_tab_describe_probe'), [
      { name: 'hr_tab_describe_probe', columns: LUONG },
    ]);
    expect(cols.map((c) => c.name)).toEqual(['ma_nv', 'cong']);
    expect(db.scalar('SELECT count(*) FROM duckdb_tables() WHERE temporary')).toBe('0');
    expect(db.scalar('SELECT z FROM hr_tab_describe_probe')).toBe('1');
    db.exec('DROP TABLE hr_tab_describe_probe');
  });

  it('a DuckDB failure is sql.error.runtime with screen-only detail', () => {
    const err = failure(() =>
      inspector().describe(checked('SELECT khong_co FROM luong'), [
        { name: 'luong', columns: LUONG },
      ]),
    );
    expect(err.messageKey).toBe('sql.error.runtime');
    expect(err.params).toEqual({});
    expect(err.detail).toMatch(/khong_co/);
    expect(err.toLog()).toEqual({ messageKey: 'sql.error.runtime' });
    expect(db.scalar('SELECT count(*) FROM duckdb_tables() WHERE temporary')).toBe('0');
  });
});

describe('canonical casts and error mapping', () => {
  const inspector = (): DuckDbInspector => new DuckDbInspector(db);
  const value = (expr: string, column: SqlDescribed, key = 'x'): string | null =>
    db.scalar(`SELECT CAST(${inspector().canonical(expr, column, key)} AS VARCHAR)`);
  const mapped = (expr: string, column: SqlDescribed, key: string): EngineError => {
    try {
      value(expr, column, key);
    } catch (err) {
      const e = toEngineError(err, 'Node SQL', 'sql.error.runtime');
      if (e instanceof EngineError) return e;
    }
    throw new Error('expected a failure');
  };

  it('reads DOUBLE with 15 significant digits', () => {
    expect(value('25.499999999999996::DOUBLE', col('x', 'DOUBLE', 'decimal', true))).toBe(
      '25.5000000000',
    );
  });

  it('NaN and overflow name the column, never DuckDB text', () => {
    const nan = mapped("'nan'::DOUBLE", col('x', 'DOUBLE', 'decimal', true), 'x');
    expect(nan.messageKey).toBe('sql.error.notFinite');
    expect(nan.params).toMatchObject({ column: 'x' });
    expect(nan.detail).toBeUndefined();
    const big = mapped('1e30::DOUBLE', col('big', 'DOUBLE', 'decimal', true), 'big');
    expect(big.messageKey).toBe('duckdb.error.decimalOverflow');
    expect(big.params).toMatchObject({ column: 'big' });
  });

  it('another failure is the runtime key with detail, or queryFailed without detail', () => {
    const raw = new DuckDbError("Conversion Error: Could not convert string 'NV1' to INT32");
    const runtime = toEngineError(raw, 'Node SQL', 'sql.error.runtime') as EngineError;
    expect(runtime.messageKey).toBe('sql.error.runtime');
    expect(runtime.detail).toContain('NV1');
    expect(JSON.stringify(runtime.params)).not.toContain('NV1');
    expect(JSON.stringify(runtime.atNode('sql').toLog())).toBe(
      '{"messageKey":"sql.error.runtime","nodeId":"sql"}',
    );
    const plain = toEngineError(raw, 'Node SQL') as EngineError;
    expect(plain.messageKey).toBe('duckdb.error.queryFailed');
    expect(plain.detail).toBeUndefined();
  });
});

describe('EngineError detail (AC f, error object)', () => {
  it('is cut to 500 characters, shown by toInfo and absent from toLog', () => {
    const err = new EngineError(
      'sql.error.runtime',
      {},
      { nodeId: 'sql', detail: 'x'.repeat(2000) },
    );
    expect(err.detail).toHaveLength(500);
    expect(err.message).toBe('sql.error.runtime');
    expect(err.toInfo().detail).toBe(err.detail);
    expect(err.toLog()).toEqual({ messageKey: 'sql.error.runtime', nodeId: 'sql' });
  });
});

describe('code.sql planning (fake inspector)', () => {
  const infer = (columns: readonly SqlDescribed[], ordered = true, sql = 'SELECT 1') => {
    const warnings: NodeWarning[] = [];
    const schemas = codeSqlPlugin.inferSchema(
      { inputs: [{ port: 'luong' }, { port: 'cham_cong' }], sql },
      { luong: LUONG, cham_cong: CHAM_CONG },
      { flow: FLOW, sql: fakeInspector(columns, ordered), warn: (w) => warnings.push(w) },
    ) as Record<string, Schema>;
    return { schema: schemas['out'], warnings };
  };

  it('takes titles from the inputs and warns about DOUBLE and a missing ORDER BY', () => {
    const { schema, warnings } = infer(
      [
        col('ma_nv', 'VARCHAR', 'string'),
        col('_source_file', 'VARCHAR', 'string'),
        col('ty_le', 'DOUBLE', 'decimal', true),
      ],
      false,
    );
    expect(schema).toEqual([
      { key: 'ma_nv', title: 'Mã NV', type: 'string' },
      { key: '_source_file', title: '_source_file', type: 'string' },
      { key: 'ty_le', title: 'ty_le', type: 'decimal' },
    ]);
    expect(warnings).toEqual([
      { messageKey: 'sql.warning.noOrderBy', params: {} },
      { messageKey: 'sql.warning.doubleColumn', params: { column: 'ty_le' } },
    ]);
  });

  it.each([
    [[col('Mã', 'VARCHAR', 'string')], 'sql.error.invalidColumnName', { column: 'Mã' }],
    [[col('_rieng', 'VARCHAR', 'string')], 'sql.error.invalidColumnName', { column: '_rieng' }],
    [
      [col('ma_nv', 'VARCHAR', 'string'), col('ma_nv', 'VARCHAR', 'string')],
      'sql.error.duplicateColumn',
      { column: 'ma_nv' },
    ],
    [
      [col('l', 'INTEGER[]', null)],
      'sql.error.unsupportedType',
      { column: 'l', type: 'INTEGER[]' },
    ],
  ] as const)('refuses %j', (columns, key, params) => {
    const err = failure(() => infer(columns));
    expect(err).toMatchObject({ messageKey: key, params, path: ['sql'] });
  });

  it('needs DuckDB at design time', () => {
    const err = failure(() =>
      codeSqlPlugin.inferSchema(
        { inputs: [{ port: 'luong' }], sql: 'SELECT 1 AS a' },
        { luong: LUONG },
        { flow: FLOW },
      ),
    );
    expect(err.messageKey).toBe('duckdb.error.unavailable');
  });

  it('compiles to views per port, binds parameters as canonical text, blank as NULL', () => {
    const ctx: CompileContext = {
      nodeId: 'sql',
      flow: FLOW,
      sql: DUCKDB_DIALECT,
      inspect: fakeInspector([col('t', 'VARCHAR', 'string'), col('c', 'VARCHAR', 'string')]),
      run: {
        slots: {},
        params: { ten: "x' OR 1=1 --", ky_luong: '  ', co: true },
        emitFile: () => undefined,
      },
    };
    const q = codeSqlPlugin.compile!(
      { inputs: [{ port: 'luong' }], sql: 'SELECT $ten AS t, $co AS c, $ky_luong AS k FROM luong' },
      { luong: { ref: '"hr_tab_1"', columns: LUONG } },
      ctx,
    ).ports['out']!;
    expect(q.params).toEqual(["x' OR 1=1 --", 'true', null]);
    expect(q.sql).not.toContain('OR 1=1');
    expect(q.sql).toContain('"luong" AS (SELECT "ma_nv", "cong" FROM "hr_tab_1")');
    expect(q.sql).toContain('row_number() OVER () AS "hr$ord"');
    expect(q.runtimeErrorKey).toBe('sql.error.runtime');
    expect(q.columns).toEqual([
      { key: 't', title: 't', type: 'string' },
      { key: 'c', title: 'c', type: 'string' },
    ]);
  });
});
