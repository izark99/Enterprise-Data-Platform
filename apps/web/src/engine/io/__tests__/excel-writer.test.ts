import { InputSlotSchema } from '@hrflow/flow-schema';
import ExcelJS from 'exceljs';
import { unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { Big, isDecimal } from '../../core/decimal';
import { Table } from '../../core/table';
import type { Schema, Value } from '../../core/types';
import { STREAMING_CELLS, shouldStream, writeWorkbook, type SheetSpec } from '../excel-writer';
import { readSlot } from '../validation';
import { HEAVY } from './helpers';

/** Generated tables (fake data, fixed seed) for the two workbook writers (spec §11, §13). */

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const COLUMNS: Schema = [
  { key: 'ma', title: 'Mã', type: 'string' },
  { key: 'ten', title: 'Tên & "ghi chú" <x>', type: 'string' },
  { key: 'so_lan', title: 'Số lần', type: 'integer' },
  { key: 'cong', title: 'Công', type: 'decimal' },
  { key: 'ngay', title: 'Ngày', type: 'date' },
  { key: 'luc', title: 'Lúc', type: 'datetime' },
  { key: 'co', title: 'Có', type: 'boolean' },
];

const pad = (n: number, w = 2): string => String(n).padStart(w, '0');

function generated(rows: number, seed: number): Table {
  const next = rng(seed);
  const pick = <T>(f: () => T): T | null => (next() < 0.1 ? null : f());
  const data: Value[][] = [];
  for (let i = 0; i < rows; i++) {
    const day = 1 + Math.floor(next() * 28);
    data.push([
      `NV${pad(i, 6)}`,
      pick(() => ['Đặng Văn A', 'Lê Thị B', 'Tab\tvà xuống\ndòng', '00123', 'x & y'][i % 5]!),
      pick(() => Math.floor(next() * 2_000_000) - 1_000_000),
      pick(() => new Big(Math.floor(next() * 1_000_000)).div(1000).minus(300)),
      pick(() => `2026-${pad(1 + (i % 12))}-${pad(day)}`),
      pick(() => `2026-09-${pad(day)}T${pad(i % 24)}:${pad(i % 60)}:${pad((i * 7) % 60)}`),
      pick(() => next() < 0.5),
    ]);
  }
  return Table.fromRows(COLUMNS, data);
}

async function loadExcelJs(bytes: Uint8Array): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  // ExcelJS types its input as a Node `Buffer`; it reads any ArrayBuffer.
  const copy = bytes.slice().buffer as unknown as Parameters<typeof wb.xlsx.load>[0];
  await wb.xlsx.load(copy);
  return wb;
}

interface SheetView {
  name: string;
  views: unknown;
  autoFilter: unknown;
  widths: (number | undefined)[];
  cells: unknown[][];
}

/** Everything a user sees of a sheet: values, number formats, bold, widths, frozen pane, filter. */
function describeSheet(ws: ExcelJS.Worksheet, rows: number, cols: number): SheetView {
  const cells: unknown[][] = [];
  for (let r = 1; r <= rows; r++) {
    const row: unknown[] = [];
    for (let c = 1; c <= cols; c++) {
      const cell = ws.getCell(r, c);
      const value = cell.value instanceof Date ? cell.value.getTime() : cell.value;
      row.push([value ?? null, cell.numFmt ?? 'General', cell.font?.bold === true]);
    }
    cells.push(row);
  }
  const widths: (number | undefined)[] = [];
  for (let c = 1; c <= cols; c++) widths.push(ws.getColumn(c).width);
  const views = ws.views.map((v) => ({
    state: v.state,
    ySplit: 'ySplit' in v ? v.ySplit : undefined,
    topLeftCell: 'topLeftCell' in v ? v.topLeftCell : undefined,
  }));
  return { name: ws.name, views, autoFilter: ws.autoFilter, widths, cells };
}

async function describeWorkbook(bytes: Uint8Array, sheets: readonly SheetSpec[]) {
  const wb = await loadExcelJs(bytes);
  return sheets.map((s, k) => {
    const ws = wb.worksheets[k]!;
    return describeSheet(ws, s.table.rowCount + 1, s.table.columns.length);
  });
}

/** The written sheet read back with the input reader of T-R1-04 (spec §10). */
function readBack(bytes: Uint8Array, sheet: string, columns: Schema): Table {
  const slot = InputSlotSchema.parse({
    key: 'ket_qua',
    label: 'Kết quả',
    sheet: { mode: 'byName', value: sheet },
    columns: columns.map((c) => ({ key: c.key, aliases: [c.title], type: c.type })),
  });
  const { table, report } = readSlot(slot, [{ name: 'ket_qua.xlsx', bytes }]);
  expect(report.errorCount).toBe(0);
  return table;
}

const plain = (v: Value): unknown => (isDecimal(v) ? `dec:${v.toString()}` : v);

function expectSameTable(actual: Table, expected: Table): void {
  expect(actual.rowCount).toBe(expected.rowCount);
  for (const col of expected.columns) {
    const a = actual.column(col.key);
    const e = expected.column(col.key);
    for (let i = 0; i < expected.rowCount; i++) {
      if (plain(a.get(i)) !== plain(e.get(i))) {
        expect({ row: i, column: col.key, value: plain(a.get(i)) }).toEqual({
          row: i,
          column: col.key,
          value: plain(e.get(i)),
        });
      }
    }
  }
}

describe('workbook writers', () => {
  const big = generated(10_000, 0x5eed0105);
  const small = Table.fromRows(COLUMNS.slice(0, 4), [
    ['NV1', 'Một', 1, new Big('0.5')],
    ['NV2', null, null, null],
  ]);
  const sheets: SheetSpec[] = [
    { name: 'Tổng hợp', table: big },
    { name: 'Lệch', table: small },
  ];

  it('ExcelJS and the streaming writer give the same values and styles on 10,000 rows (AC f)', async () => {
    const viaExcelJs = await writeWorkbook(sheets, { streaming: false });
    const viaStream = await writeWorkbook(sheets, { streaming: true });
    // Two different writers really ran (ExcelJS adds document properties).
    expect(Object.keys(unzipSync(viaExcelJs))).toContain('docProps/app.xml');
    expect(Object.keys(unzipSync(viaStream))).not.toContain('docProps/app.xml');

    const a = await describeWorkbook(viaExcelJs, sheets);
    const b = await describeWorkbook(viaStream, sheets);
    expect(b.map((s) => s.name)).toEqual(['Tổng hợp', 'Lệch']);
    expect(b).toEqual(a);
  }, 60_000);

  it('writes a bold header, a frozen first row, an auto-filter and number formats by type', async () => {
    for (const streaming of [false, true]) {
      const bytes = await writeWorkbook(sheets, { streaming });
      const [first] = await describeWorkbook(bytes, [sheets[0]!]);
      expect(first!.views).toEqual([{ state: 'frozen', ySplit: 1, topLeftCell: 'A2' }]);
      expect(first!.autoFilter).toBe('A1:G1');
      const header = first!.cells[0] as [unknown, string, boolean][];
      expect(header.map((c) => c[0])).toEqual(COLUMNS.map((c) => c.title));
      expect(header.every((c) => c[2] && c[1] === 'General')).toBe(true);
      const data = first!.cells[1] as [unknown, string, boolean][];
      expect(data.map((c) => c[1])).toEqual([
        'General',
        'General',
        '#,##0',
        '#,##0.00',
        'dd/mm/yyyy',
        'dd/mm/yyyy hh:mm:ss',
        'General',
      ]);
      expect(data.some((c) => c[2])).toBe(false);
      for (const w of first!.widths) expect(w).toBeGreaterThanOrEqual(8);
    }
  }, 60_000);

  it('reads back, through the input reader, the tables it wrote (both writers)', async () => {
    for (const streaming of [false, true]) {
      const bytes = await writeWorkbook(sheets, { streaming });
      expectSameTable(readBack(bytes, 'Tổng hợp', COLUMNS), big);
      expectSameTable(readBack(bytes, 'Lệch', small.columns), small);
    }
  }, 60_000);

  it('switches to the streaming writer above 2,000,000 cells', () => {
    const spec = (rows: number, cols: number): SheetSpec => ({
      name: 'S',
      table: { rowCount: rows, columns: COLUMNS.slice(0, cols) } as unknown as Table,
    });
    expect(STREAMING_CELLS).toBe(2_000_000);
    expect(shouldStream([spec(400_000, 5)])).toBe(false);
    expect(shouldStream([spec(400_000, 5), spec(1, 1)])).toBe(true);
    expect(shouldStream([spec(1_000_000, 2)])).toBe(false);
    expect(shouldStream([spec(1_000_001, 2)])).toBe(true);
  });

  it.skipIf(!HEAVY)(
    'writes 2,000,001 cells with the streaming writer and reads them back',
    async () => {
      const rows = Math.ceil(2_000_001 / COLUMNS.length);
      const table = generated(rows, 0x5eed0106);
      const bytes = await writeWorkbook([{ name: 'Lớn', table }]);
      expect(Object.keys(unzipSync(bytes))).not.toContain('docProps/app.xml');
      expectSameTable(readBack(bytes, 'Lớn', COLUMNS), table);
    },
    600_000,
  );
});
