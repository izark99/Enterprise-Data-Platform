import type { DataType } from '@hrflow/flow-schema';
import { describe, expect, it } from 'vitest';
import { parseDecimal } from '../core/decimal';
import { ColumnBuilder, Table } from '../core/table';
import type { ColumnDef, Value } from '../core/types';

/** Fixed-seed PRNG for generated test data (mulberry32). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const col = (key: string, type: DataType): ColumnDef => ({ key, title: key.toUpperCase(), type });

const COLUMNS: ColumnDef[] = [
  col('ma_nv', 'string'),
  col('so_ngay', 'integer'),
  col('luong', 'decimal'),
  col('ngay', 'date'),
  col('luc', 'datetime'),
  col('dang_lam', 'boolean'),
];

const ROWS: Value[][] = [
  ['NV001', 22, parseDecimal('15000000.5'), '2026-09-01', '2026-09-01T08:00:00', true],
  [null, null, null, null, null, null],
  ['Đặng Thị Ánh', -3, parseDecimal('0.12345678901234567890'), '2026-12-31', null, false],
  ['', 0, parseDecimal('-0.1'), null, '2026-01-01T00:00:00', null],
];

const HEAVY =
  (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env
    .HRFLOW_HEAVY === '1';

/** Builds, measures and releases a generated table of `rowCount` rows × 30 columns (AC c). */
function buildGeneratedTable(rowCount: number): void {
  const types: DataType[] = ['string', 'decimal', 'integer', 'date', 'decimal', 'boolean'];
  const columns = Array.from({ length: 30 }, (_, j) => col(`c${j}`, types[j % types.length]!));
  const next = mulberry32(1_000_000);
  const builders = columns.map((c) => new ColumnBuilder(c.type));
  const cents = new Uint32Array(1000).map(() => Math.floor(next() * 10_000_000));
  const decimals = Array.from(cents, (c) => parseDecimal(String(c)).div(100));
  for (let r = 0; r < rowCount; r++) {
    const pick = Math.floor(next() * 1000);
    for (let j = 0; j < 30; j++) {
      const b = builders[j]!;
      if (pick % 97 === j) {
        b.append(null);
        continue;
      }
      switch (b.type) {
        case 'string':
          b.append(`NV${(r * 31 + j) % 100_000}`);
          break;
        case 'decimal':
          b.append(decimals[(pick + j) % 1000]!);
          break;
        case 'integer':
          b.append(pick - 500);
          break;
        case 'date':
          b.append(`2026-${String(1 + (pick % 12)).padStart(2, '0')}-15`);
          break;
        default:
          b.append(pick % 2 === 0);
      }
    }
  }
  const table = new Table(
    columns,
    builders.map((b) => b.finish()),
    rowCount,
  );
  expect(table.rowCount).toBe(rowCount);
  const last = table.get(rowCount - 1, 'c0');
  // A generated blank reads back as null (spec §12.1: blank = null).
  expect(last === null || (typeof last === 'string' && /^NV\d+$/.test(last))).toBe(true);
  const bytes = table.byteSize();
  const proc = (
    globalThis as {
      process?: {
        memoryUsage(): { heapUsed: number; arrayBuffers: number };
        stdout: { write(text: string): void };
      };
    }
  ).process;
  const mib = (n: number): string => `${(n / 1024 / 1024).toFixed(1)} MiB`;
  const mem = proc?.memoryUsage();
  proc?.stdout.write(
    `[engine] ${rowCount.toLocaleString('en')} x 30 table: column buffers ${mib(bytes)}` +
      (mem
        ? `, process heapUsed ${mib(mem.heapUsed)}, arrayBuffers ${mib(mem.arrayBuffers)}`
        : '') +
      '\n',
  );
  // 1,000,000 rows measured 240.6 MiB (T-R1-03); the bound leaves room per row.
  expect(bytes).toBeLessThan(rowCount * 420);
  table.release();
}

describe('Table (spec §13)', () => {
  it('reads back every value of every type, blanks as null', () => {
    const table = Table.fromRows(COLUMNS, ROWS);
    expect(table.rowCount).toBe(4);
    expect(table.columns.map((c) => c.title)).toEqual([
      'MA_NV',
      'SO_NGAY',
      'LUONG',
      'NGAY',
      'LUC',
      'DANG_LAM',
    ]);
    ROWS.forEach((row, r) => {
      COLUMNS.forEach((c, j) => {
        const got = table.get(r, c.key);
        const want = row[j] ?? null;
        if (c.type === 'decimal' && want !== null) {
          expect(String(got)).toBe(String(want));
        } else {
          expect(got).toEqual(want);
        }
        expect(table.column(c.key).isNull(r)).toBe(want === null);
      });
    });
    expect(table.columnDef('luong')?.type).toBe('decimal');
    expect(table.columnDef('nope')).toBeUndefined();
  });

  it('slices into an independent copy', () => {
    const table = Table.fromRows(COLUMNS, ROWS);
    const part = table.slice(1, 3);
    expect(part.rowCount).toBe(2);
    expect(part.get(0, 'ma_nv')).toBeNull();
    expect(part.get(1, 'ma_nv')).toBe('Đặng Thị Ánh');
    expect(String(part.get(1, 'luong'))).toBe('0.1234567890123456789');
    expect(part.get(1, 'dang_lam')).toBe(false);
    expect(table.slice(3).rowCount).toBe(1);
    expect(table.slice(10, 20).rowCount).toBe(0);
    table.release();
    expect(part.get(1, 'so_ngay')).toBe(-3);
  });

  it('throws on any read after release', () => {
    const table = Table.fromRows(COLUMNS, ROWS);
    table.release();
    table.release();
    expect(table.released).toBe(true);
    expect(() => table.get(0, 'ma_nv')).toThrow('read after release');
    expect(() => table.byteSize()).toThrow('read after release');
  });

  it('rejects a value whose JS type does not fit the column', () => {
    expect(() => new ColumnBuilder('integer').append(1.5)).toThrow(TypeError);
    expect(() => new ColumnBuilder('decimal').append(1.5)).toThrow(TypeError);
    expect(() => new ColumnBuilder('string').append(1)).toThrow(TypeError);
    expect(() => new ColumnBuilder('boolean').append('true')).toThrow(TypeError);
  });

  it('rejects duplicate keys and vectors that do not fit', () => {
    const a = new ColumnBuilder('string').finish();
    expect(() => new Table([col('a', 'string'), col('a', 'string')], [a, a], 0)).toThrow(
      'duplicate',
    );
    expect(() => new Table([col('a', 'integer')], [a], 0)).toThrow('does not fit');
  });

  it('builds a 100,000-row x 30-column generated table', () => {
    buildGeneratedTable(100_000);
  }, 30_000);

  // Heavy test (.claude/rules/testing.md): only with HRFLOW_HEAVY=1 (MEMORY, owner 1A).
  it.runIf(HEAVY)(
    'builds a 1,000,000-row x 30-column generated table',
    () => {
      buildGeneratedTable(1_000_000);
    },
    120_000,
  );
});
