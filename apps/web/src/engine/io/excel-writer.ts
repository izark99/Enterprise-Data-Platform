import type { DataType } from '@hrflow/flow-schema';
import { isDecimal } from '../core/decimal';
import type { Table } from '../core/table';
import type { ColumnDef, Value } from '../core/types';
import { isoToUtcMs, writeStreamingWorkbook } from './xlsx-stream-writer';

/**
 * Workbook writer of `output.excel` (spec §11): one sheet per table, bold header row, frozen first
 * row, auto-filter over the header, column widths from the content, number format by column type.
 * Up to `STREAMING_CELLS` cells ExcelJS builds the file; above, the streaming writer writes the
 * same layout straight from the column vectors (spec §13: ExcelJS keeps one object per cell).
 * Decimals become Excel numbers only here, at the file boundary.
 */

export interface SheetSpec {
  readonly name: string;
  readonly table: Table;
}

/** Above this many cells (all sheets together) the streaming writer is used (spec §13). */
export const STREAMING_CELLS = 2_000_000;

/** Number format per column type; other types stay General. */
export const NUMBER_FORMATS: Partial<Record<DataType, string>> = {
  integer: '#,##0',
  decimal: '#,##0.00',
  date: 'dd/mm/yyyy',
  datetime: 'dd/mm/yyyy hh:mm:ss',
};

const MIN_WIDTH = 8;
const MAX_WIDTH = 50;
/** Rows looked at to size a column. */
const WIDTH_SAMPLE = 1000;

/** Layout of one sheet, shared by both writers so they write the same file. */
export interface SheetLayout {
  readonly name: string;
  readonly columns: readonly ColumnDef[];
  /** Column widths in characters. */
  readonly widths: readonly number[];
  /** Number format per column; `undefined` = General. */
  readonly numFmts: readonly (string | undefined)[];
}

export function sheetLayouts(sheets: readonly SheetSpec[]): SheetLayout[] {
  return sheets.map((s) => ({
    name: s.name,
    columns: s.table.columns,
    widths: s.table.columns.map((col) => columnWidth(col, s.table)),
    numFmts: s.table.columns.map((col) => NUMBER_FORMATS[col.type]),
  }));
}

function displayLength(v: Value, type: DataType): number {
  if (v === null) return 0;
  if (type === 'date') return 10;
  if (type === 'datetime') return 19;
  if (isDecimal(v) || typeof v === 'number') {
    const s = isDecimal(v) ? v.toFixed(2) : String(v);
    // Room for the thousands separators of the number format.
    return s.length + Math.floor(s.length / 3);
  }
  return String(v).length;
}

function columnWidth(col: ColumnDef, table: Table): number {
  const vector = table.column(col.key);
  let max = col.title.length;
  const n = Math.min(table.rowCount, WIDTH_SAMPLE);
  for (let i = 0; i < n; i++) max = Math.max(max, displayLength(vector.get(i), col.type));
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, max + 2));
}

type CellValue = string | number | boolean | Date | null;

function cellValue(v: Value, type: DataType): CellValue {
  if (v === null) return null;
  if (isDecimal(v)) return Number(v.toString());
  if ((type === 'date' || type === 'datetime') && typeof v === 'string') {
    const ms = isoToUtcMs(v);
    if (ms !== null) return new Date(ms);
  }
  return v;
}

/** Whether the cells of all sheets together are above `STREAMING_CELLS`. */
export function shouldStream(sheets: readonly SheetSpec[]): boolean {
  const cells = sheets.reduce((n, s) => n + s.table.rowCount * s.table.columns.length, 0);
  return cells > STREAMING_CELLS;
}

/**
 * Writes the sheets as one `.xlsx`. Sheet names were checked by `OutputExcelConfigSchema`
 * (length, characters, unique without case). `streaming` forces a writer (tests).
 */
export async function writeWorkbook(
  sheets: readonly SheetSpec[],
  options: { readonly streaming?: boolean } = {},
): Promise<Uint8Array> {
  const layouts = sheetLayouts(sheets);
  if (options.streaming ?? shouldStream(sheets)) {
    return writeStreamingWorkbook(
      layouts.map((layout, k) => ({ ...layout, table: sheets[k]!.table })),
    );
  }
  // Loaded on first write, so the engine worker starts without ExcelJS.
  const { default: ExcelJS } = await import('exceljs');
  const wb = new ExcelJS.Workbook();
  sheets.forEach((spec, k) => {
    const layout = layouts[k]!;
    const { columns } = spec.table;
    const ws = wb.addWorksheet(spec.name, { views: [{ state: 'frozen', ySplit: 1 }] });
    ws.columns = columns.map((col, j) => {
      const numFmt = layout.numFmts[j];
      return {
        header: col.title,
        key: col.key,
        width: layout.widths[j]!,
        ...(numFmt === undefined ? {} : { style: { numFmt } }),
      };
    });
    const vectors = columns.map((col) => spec.table.column(col.key));
    for (let i = 0; i < spec.table.rowCount; i++) {
      ws.addRow(columns.map((col, j) => cellValue(vectors[j]!.get(i), col.type)));
    }
    const header = ws.getRow(1);
    header.font = { bold: true };
    // Column styles reach the header row too: header cells stay General text.
    header.eachCell((cell) => {
      cell.numFmt = 'General';
    });
    if (columns.length > 0) {
      ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
    }
  });
  const buffer = await wb.xlsx.writeBuffer();
  return new Uint8Array(buffer as ArrayBuffer);
}
