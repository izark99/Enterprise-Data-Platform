import { beforeAll, describe, expect, it, vi } from 'vitest';
import { Big, isDecimal, parseDecimal } from '../core/decimal';
import { EngineError } from '../core/errors';
import { normalizeKeyPart } from '../core/keys';
import { Table } from '../core/table';
import type { Schema, Value } from '../core/types';
import { readTable, uploadTable } from '../duckdb/arrow-io';
import { SECURE_SETTINGS, type DuckDb } from '../duckdb/db';
import { decimalToSqlText, normKeySql, ORD_SQL, quoteIdent, toEngineError } from '../duckdb/sql';
import { nodeDuckDb } from './duckdb-node';

/**
 * DuckDB runtime (T-R1-06, spec §9.4, §12.1, §13.1) over the real `duckdb-eh.wasm` (Node blocking
 * bindings). Fake values only.
 */

let db: DuckDb;
let seq = 0;
const nextName = (): string => `t${++seq}`;

beforeAll(async () => {
  db = await nodeDuckDb();
}, 60_000);

const failure = (work: () => unknown): Error => {
  try {
    work();
  } catch (err) {
    return err as Error;
  }
  throw new Error('expected a failure');
};

const engineFailure = (work: () => unknown): EngineError => {
  const err = failure(work);
  expect(err).toBeInstanceOf(EngineError);
  return err as EngineError;
};

/** Upload `table`, read it back, and return the read table. */
function roundTrip(table: Table): Table {
  const name = nextName();
  uploadTable(db, table, name, 'n1');
  return readTable(db, name, { columns: table.columns, node: 'n1' });
}

const plain = (v: Value): unknown => (isDecimal(v) ? `dec:${v.toString()}` : v);
const rowsOf = (t: Table): unknown[][] =>
  Array.from({ length: t.rowCount }, (_, i) => t.columns.map((c) => plain(t.get(i, c.key))));

/** Result of a query materialised into a fresh table, read back through `readTable`. */
function readQuery(sql: string): Table {
  const name = nextName();
  try {
    db.exec(`CREATE TABLE ${quoteIdent(name)} AS ${sql}`);
  } catch (err) {
    throw toEngineError(err, 'n1');
  }
  return readTable(db, name, { node: 'n1' });
}

describe('secure settings (AC a)', () => {
  it('reads back the four settings as set', () => {
    expect(SECURE_SETTINGS).toEqual([
      'SET enable_external_access = false',
      'SET autoinstall_known_extensions = false',
      'SET autoload_known_extensions = false',
      'SET lock_configuration = true',
    ]);
    const settings = db.query(
      `SELECT current_setting('enable_external_access') AS a,
              current_setting('autoinstall_known_extensions') AS b,
              current_setting('autoload_known_extensions') AS c,
              current_setting('lock_configuration') AS d`,
    );
    expect(settings.toArray().map((r) => r.toJSON())).toEqual([
      { a: false, b: false, c: false, d: true },
    ]);
  });

  it('refuses to change a locked setting', () => {
    expect(failure(() => db.exec('SET enable_external_access = true')).name).toBe('DuckDbError');
    expect(failure(() => db.exec('SET lock_configuration = false')).name).toBe('DuckDbError');
    expect(failure(() => db.exec('RESET enable_external_access')).name).toBe('DuckDbError');
    expect(failure(() => db.exec('SET autoload_known_extensions = true')).name).toBe('DuckDbError');
    expect(db.scalar("SELECT current_setting('enable_external_access')")).toBe('false');
  });

  it('is an in-memory database', () => {
    expect(db.scalar('SELECT current_database()')).toBe('memory');
  });
});

describe('no file, network or extension access (AC b)', () => {
  const fetchSpy = vi.spyOn(globalThis, 'fetch');

  it.each([
    ['read_csv over https', "SELECT * FROM read_csv('https://example.invalid/a.csv')"],
    ['read_parquet over https', "SELECT * FROM read_parquet('https://example.invalid/a.parquet')"],
    ['read_csv of a local file', "SELECT * FROM read_csv('/etc/hosts')"],
    ['COPY … TO', "COPY (SELECT 1 AS x) TO 'out.csv'"],
    ['ATTACH', "ATTACH 'other.db'"],
    ['LOAD httpfs', 'LOAD httpfs'],
    ['LOAD an extension by URL', "LOAD 'https://example.invalid/x.duckdb_extension'"],
  ])('%s fails', (_case, sql) => {
    expect(failure(() => db.exec(sql)).name).toBe('DuckDbError');
  });

  it('loads no extension after INSTALL and made no network request', () => {
    // INSTALL itself is a no-op in this build: the runtime has no file system and no network.
    try {
      db.exec('INSTALL httpfs');
    } catch {
      // Refusing it is fine too.
    }
    expect(failure(() => db.exec('LOAD httpfs')).name).toBe('DuckDbError');
    const loaded = db.query(
      "SELECT extension_name FROM duckdb_extensions() WHERE loaded AND install_mode <> 'STATICALLY_LINKED'",
    );
    expect(loaded.numRows).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('values only as prepared parameters (AC c)', () => {
  it('returns an injection attempt unchanged', () => {
    const value = "x' OR 1=1 --";
    expect(db.scalar('SELECT ? AS v', [value])).toBe(value);
    expect(db.scalar('SELECT typeof(?)', [value])).toBe('VARCHAR');
  });

  it('matches it as a value, not as SQL', () => {
    const name = nextName();
    const cols: Schema = [{ key: 'k', title: 'K', type: 'string' }];
    uploadTable(db, Table.fromRows(cols, [['a'], ["x' OR 1=1 --"], ['b']]), name);
    const sql = `SELECT count(*) FROM ${quoteIdent(name)} WHERE "k" = ?`;
    expect(db.scalar(sql, ["x' OR 1=1 --"])).toBe('1');
    expect(db.scalar(sql, ["' OR '1'='1"])).toBe('0');
    expect(db.scalar('SELECT ? IS NULL', [null])).toBe('true');
  });

  it('quotes only IdentifierSchema names', () => {
    expect(quoteIdent('ma_nv')).toBe('"ma_nv"');
    for (const bad of ['a"b', '1a', 'a b', 'A', '', 'x; DROP TABLE t']) {
      expect(() => quoteIdent(bad)).toThrow(TypeError);
    }
  });
});

describe('type mapping of spec §9.4 (AC d)', () => {
  const allTypes: Schema = [
    { key: 's', title: 'Chuỗi', type: 'string' },
    { key: 'i', title: 'Số nguyên', type: 'integer' },
    { key: 'd', title: 'Thập phân', type: 'decimal' },
    { key: 'b', title: 'Đúng/sai', type: 'boolean' },
    { key: 'dt', title: 'Ngày', type: 'date' },
    { key: 'ts', title: 'Ngày giờ', type: 'datetime' },
  ];

  it('round-trips every engine type, blanks included, with titles and row order', () => {
    const rows: Value[][] = [
      ['Nguyễn Văn An', 1, parseDecimal('0.1'), true, '2026-09-15', '2026-09-15T08:30:00'],
      ['', -42, parseDecimal('-1234567.8901234567'), false, '1900-03-01', '2000-02-29T23:59:59'],
      [null, null, null, null, null, null],
      [
        'NV 001\t"quoted"',
        Number.MAX_SAFE_INTEGER,
        parseDecimal('9999999999999999999999999999.9999999999'),
        true,
        '9999-12-31',
        '1970-01-01T00:00:00',
      ],
      ['ĐẶNG', Number.MIN_SAFE_INTEGER, parseDecimal('1e-10'), null, '0001-01-01', null],
    ];
    const back = roundTrip(Table.fromRows(allTypes, rows));
    expect(back.columns).toEqual(allTypes);
    expect(rowsOf(back)).toEqual(rows.map((r) => r.map(plain)));
  });

  it('round-trips a user column named __ord: the hidden column is hr$ord (owner 2A)', () => {
    const cols: Schema = [
      { key: '__ord', title: 'Thứ tự của User', type: 'integer' },
      { key: 'v', title: 'V', type: 'string' },
    ];
    const rows = [
      [7, 'b'],
      [3, 'a'],
    ];
    const back = roundTrip(Table.fromRows(cols, rows));
    expect(back.columns).toEqual(cols);
    expect(rowsOf(back)).toEqual(rows);
  });

  it('keeps the row order of a large upload (several chunks) in hr$ord', () => {
    const cols: Schema = [{ key: 'n', title: 'N', type: 'integer' }];
    const n = 250_000;
    const table = Table.fromRows(
      cols,
      Array.from({ length: n }, (_, i) => [n - i]),
    );
    const name = nextName();
    uploadTable(db, table, name);
    expect(db.scalar(`SELECT count(DISTINCT ${ORD_SQL}) FROM ${name}`)).toBe(String(n));
    expect(db.scalar(`SELECT count(*) FROM ${name} WHERE "n" + ${ORD_SQL} <> ${n + 1}`)).toBe('0');
    const back = readTable(db, name);
    expect(back.rowCount).toBe(n);
    expect(back.get(0, 'n')).toBe(n);
    expect(back.get(n - 1, 'n')).toBe(1);
    expect(back.columns.map((c) => c.key)).toEqual(['n']);
  }, 60_000);

  it('creates the canonical DuckDB types (decimal is DECIMAL(38,10), never DOUBLE)', () => {
    const name = nextName();
    uploadTable(db, Table.fromRows(allTypes, []), name);
    const types = db
      .query(
        'SELECT column_name, data_type FROM duckdb_columns() WHERE table_name = ? ORDER BY column_index',
        [name],
      )
      .toArray()
      .map((r) => `${String(r['column_name'])} ${String(r['data_type'])}`);
    expect(types).toEqual([
      's VARCHAR',
      'i BIGINT',
      'd DECIMAL(38,10)',
      'b BOOLEAN',
      'dt DATE',
      'ts TIMESTAMP',
      'hr$ord BIGINT',
    ]);
  });

  it('generates no DOUBLE or FLOAT in the SQL of a decimal upload and read', () => {
    const cols: Schema = [{ key: 'tien', title: 'Tiền', type: 'decimal' }];
    const spy = vi.spyOn(db, 'query');
    try {
      const back = roundTrip(Table.fromRows(cols, [[parseDecimal('0.3')], [null]]));
      expect(back.get(0, 'tien')).toEqual(parseDecimal('0.3'));
      const statements = spy.mock.calls.map(([sql]) => sql);
      expect(statements.length).toBeGreaterThan(2);
      for (const sql of statements) expect(sql).not.toMatch(/DOUBLE|FLOAT|REAL/i);
    } finally {
      spy.mockRestore();
    }
  });

  it('rounds decimals half-up to 10 places before they cross (decimal text, plain notation)', () => {
    expect(decimalToSqlText(parseDecimal('0.00000000005'), 'c')).toBe('0.0000000001');
    expect(decimalToSqlText(parseDecimal('-0.00000000005'), 'c')).toBe('-0.0000000001');
    expect(decimalToSqlText(parseDecimal('1e20'), 'c')).toBe('100000000000000000000');
    expect(decimalToSqlText(parseDecimal('1.23456789012345'), 'c')).toBe('1.2345678901');
    const cols: Schema = [{ key: 'c', title: 'C', type: 'decimal' }];
    const back = roundTrip(Table.fromRows(cols, [[parseDecimal('2.00000000005')]]));
    expect(back.get(0, 'c')).toEqual(parseDecimal('2.0000000001'));
  });

  it('adds 0.1 and 0.2 to exactly 0.3 inside DuckDB', () => {
    const cols: Schema = [
      { key: 'a', title: 'A', type: 'decimal' },
      { key: 'b', title: 'B', type: 'decimal' },
    ];
    const name = nextName();
    uploadTable(db, Table.fromRows(cols, [[parseDecimal('0.1'), parseDecimal('0.2')]]), name);
    const sum = readQuery(`SELECT "a" + "b" AS s FROM ${name}`);
    expect(sum.columns[0]!.type).toBe('decimal');
    expect((sum.get(0, 's') as Big).eq(new Big('0.3'))).toBe(true);
  });

  it('reads DOUBLE / FLOAT results through decimalFromNumber (15 significant digits)', () => {
    const t = readQuery(
      'SELECT 0.1::DOUBLE + 0.2::DOUBLE AS x, 1::DOUBLE / 3 AS y, 25.499999999999996::DOUBLE AS z, 0.5::FLOAT AS f',
    );
    expect(t.columns.map((c) => c.type)).toEqual(['decimal', 'decimal', 'decimal', 'decimal']);
    expect(plain(t.get(0, 'x'))).toBe('dec:0.3');
    expect(plain(t.get(0, 'y'))).toBe('dec:0.333333333333333');
    expect(plain(t.get(0, 'z'))).toBe('dec:25.5');
    expect(plain(t.get(0, 'f'))).toBe('dec:0.5');
  });

  it('reads HUGEINT and other DECIMAL(p,s) as decimal, exactly', () => {
    const t = readQuery(
      "SELECT 12345678901234567890123::HUGEINT AS h, 12.34::DECIMAL(10,2) AS d, '-0.000000000000000001'::DECIMAL(38,20) AS small",
    );
    expect(t.columns.map((c) => c.type)).toEqual(['decimal', 'decimal', 'decimal']);
    expect(plain(t.get(0, 'h'))).toBe('dec:1.2345678901234567890123e+22');
    expect((t.get(0, 'h') as Big).toFixed()).toBe('12345678901234567890123');
    expect(plain(t.get(0, 'd'))).toBe('dec:12.34');
    expect((t.get(0, 'small') as Big).eq(new Big('-1e-18'))).toBe(true);
  });

  it('reads integers as integer, and a result beyond the safe range as decimal', () => {
    const t = readQuery(
      'SELECT 7::TINYINT AS a, 9007199254740991::BIGINT AS b, 9007199254740993::BIGINT AS c, 18446744073709551615::UBIGINT AS u',
    );
    expect(t.columns.map((c) => c.type)).toEqual(['integer', 'integer', 'decimal', 'decimal']);
    expect(t.get(0, 'b')).toBe(Number.MAX_SAFE_INTEGER);
    expect((t.get(0, 'c') as Big).toFixed()).toBe('9007199254740993');
    expect((t.get(0, 'u') as Big).toFixed()).toBe('18446744073709551615');
  });

  it('cuts fractional seconds of a TIMESTAMP and reads DATE as ISO text', () => {
    const t = readQuery(
      "SELECT TIMESTAMP '2026-09-15 08:30:59.987654' AS ts, '2026-09-15 08:30:59.5'::TIMESTAMP_MS AS ms, DATE '2026-02-28' AS d",
    );
    expect(t.columns.map((c) => c.type)).toEqual(['datetime', 'datetime', 'date']);
    expect(t.get(0, 'ts')).toBe('2026-09-15T08:30:59');
    expect(t.get(0, 'ms')).toBe('2026-09-15T08:30:59');
    expect(t.get(0, 'd')).toBe('2026-02-28');
  });

  it.each([
    ['TIMESTAMP WITH TIME ZONE', "TIMESTAMPTZ '2026-09-15 08:30:00+07'"],
    ['INTERVAL', 'INTERVAL 1 DAY'],
    ['INTEGER[]', '[1, 2]'],
    ['STRUCT(a INTEGER)', "{'a': 1}"],
    ['MAP(VARCHAR, INTEGER)', "MAP {'a': 1}"],
    ['BLOB', "'ab'::BLOB"],
    ['UUID', "'00000000-0000-0000-0000-000000000001'::UUID"],
    ['TIME', "TIME '08:30:00'"],
  ])('refuses %s with sql.error.unsupportedType naming the column', (type, expr) => {
    const err = engineFailure(() => readQuery(`SELECT 'ok' AS fine, ${expr} AS bad_col`));
    expect(err.messageKey).toBe('sql.error.unsupportedType');
    expect(err.params).toEqual({ node: 'n1', column: 'bad_col', type });
  });

  it('gives duckdb.error.decimalOverflow above 28 integer digits, both ways', () => {
    const cols: Schema = [{ key: 'luong', title: 'Lương', type: 'decimal' }];
    const up = engineFailure(() =>
      uploadTable(db, Table.fromRows(cols, [[parseDecimal('1e28')]]), nextName(), 'n1'),
    );
    expect(up.messageKey).toBe('duckdb.error.decimalOverflow');
    expect(up.params).toEqual({ node: 'n1', column: 'luong' });
    // 28 integer digits still fit.
    const fits = roundTrip(Table.fromRows(cols, [[parseDecimal('9999999999999999999999999999')]]));
    expect((fits.get(0, 'luong') as Big).toFixed()).toBe('9999999999999999999999999999');

    const read = engineFailure(() => readQuery('SELECT 10::HUGEINT ^ 30 AS h'));
    expect(read.messageKey).toBe('duckdb.error.decimalOverflow');
    const hugeint = engineFailure(() =>
      readQuery('SELECT 1000000000000000000000000000000::HUGEINT AS h'),
    );
    expect(hugeint.params).toEqual({ node: 'n1', column: 'h' });
    const double = engineFailure(() => readQuery('SELECT 1e300::DOUBLE AS x'));
    expect(double.messageKey).toBe('duckdb.error.decimalOverflow');
  });

  it('maps DuckDB arithmetic overflow to duckdb.error.decimalOverflow without its text', () => {
    const cols: Schema = [{ key: 'v', title: 'V', type: 'decimal' }];
    const name = nextName();
    uploadTable(db, Table.fromRows(cols, [[parseDecimal('9999999999999999999999999999')]]), name);
    const err = engineFailure(() =>
      readQuery(`SELECT CAST("v" * 10 AS DECIMAL(38,10)) AS v FROM ${name}`),
    );
    expect(err.messageKey).toBe('duckdb.error.decimalOverflow');
  });

  it('rejects a non-finite DOUBLE with sql.error.notFinite', () => {
    const err = engineFailure(() => readQuery("SELECT 'nan'::DOUBLE AS x"));
    expect(err.messageKey).toBe('sql.error.notFinite');
    expect(err.params).toEqual({ node: 'n1', column: 'x' });
  });

  it('gives duckdb.error.queryFailed without the DuckDB text for any other failure', () => {
    const missing = engineFailure(() => readTable(db, 'no_such_table_x', { node: 'n1' }));
    expect(missing.messageKey).toBe('duckdb.error.queryFailed');
    expect(missing.params).toEqual({ node: 'n1' });
    // DuckDB's text would quote the value; the engine error carries only the key.
    const cast = engineFailure(() => readQuery("SELECT CAST('Nguyễn Văn An' AS INTEGER) AS x"));
    expect(cast.messageKey).toBe('duckdb.error.queryFailed');
    expect(cast.message).toBe('duckdb.error.queryFailed');
    expect(JSON.stringify(cast.toInfo())).not.toContain('Nguyễn');
  });

  it('reads a view in hr$ord order', () => {
    const cols: Schema = [{ key: 'v', title: 'V', type: 'integer' }];
    const base = nextName();
    uploadTable(db, Table.fromRows(cols, [[3], [1], [2]]), base);
    const view = nextName();
    db.exec(`CREATE VIEW ${view} AS SELECT "v" * 10 AS w, ${ORD_SQL} FROM ${base}`);
    const t = readTable(db, view);
    expect(t.columns).toEqual([{ key: 'w', title: 'w', type: 'integer' }]);
    expect(rowsOf(t)).toEqual([[30], [10], [20]]);
  });
});

describe('hrflow_norm_key equals normalizeKeyPart (AC e)', () => {
  // The golden list of T-R1-03 (`keys.test.ts`), plus every JavaScript whitespace and U+0130.
  const golden = [
    'NV 001',
    'NV\t001',
    'Nguyễn  Văn   An',
    '  NV001\t\n',
    'ĐẶNG',
    'đặng',
    'Đặng'.normalize('NFD'),
    'NGUYỄN'.normalize('NFD'),
    ' đặng ',
    '123',
    '1.5',
    'true',
    '',
    'İSTANBUL',
    'ẞ Straße',
    'Ǆ ǅ',
    ...'\t\n\v\f\r                  　﻿'.split('').map((ws) => `${ws}A${ws}${ws}B${ws}`),
    'A​B', // zero-width space is not whitespace for either side
  ];

  it.each(golden.map((v) => [JSON.stringify(v), v]))('%s', (_label, input) => {
    expect(db.scalar(`SELECT ${normKeySql('?')}`, [input])).toBe(normalizeKeyPart(input));
  });

  it('maps NULL to the empty string', () => {
    expect(db.scalar(`SELECT ${normKeySql('?')}`, [null])).toBe(normalizeKeyPart(null));
  });

  it('gives the same keys over an uploaded column', () => {
    const cols: Schema = [{ key: 'k', title: 'K', type: 'string' }];
    const name = nextName();
    uploadTable(
      db,
      Table.fromRows(
        cols,
        golden.map((v) => [v]),
      ),
      name,
    );
    const out = db
      .query(`SELECT ${normKeySql('"k"')} AS n FROM ${name} ORDER BY ${ORD_SQL}`)
      .toArray()
      .map((r) => r['n'] as string);
    expect(out).toEqual(golden.map((v) => normalizeKeyPart(v)));
  });
});
