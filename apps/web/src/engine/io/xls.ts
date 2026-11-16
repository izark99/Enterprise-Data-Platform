import * as XLSX from 'xlsx';
import { ERROR_TEXTS, GridBuilder, type Grid, type WorkbookSource } from './xlsx-stream';
import { FileReadError } from './zip';

/**
 * `.xls` (BIFF in an OLE2 container) through SheetJS, only below 64 MiB (spec §13): SheetJS holds
 * the whole workbook in memory. ZIP packages never come here (`openXlsx`, no fallback).
 */

export const MAX_XLS_BYTES = 64 * 1024 * 1024;

const OLE_SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

export function isOleFile(bytes: Uint8Array): boolean {
  return OLE_SIGNATURE.every((b, i) => bytes[i] === b);
}

/** SheetJS options whose cell values the streaming reader reproduces. */
export const SHEETJS_READ_OPTIONS: XLSX.ParsingOptions = {
  type: 'array',
  dense: true,
  cellDates: false,
  cellFormula: false,
  cellHTML: false,
  cellText: false,
  cellNF: true,
};

/** SheetJS error code → text (`BErr`); an unknown code reads as `#ERROR`. */
const ERROR_BY_CODE: Readonly<Record<number, string>> = {
  0x00: '#NULL!',
  0x07: '#DIV/0!',
  0x0f: '#VALUE!',
  0x17: '#REF!',
  0x1d: '#NAME?',
  0x24: '#NUM!',
  0x2a: '#N/A',
  0x2b: '#GETTING_DATA',
};

/** The grid of a SheetJS worksheet read with `SHEETJS_READ_OPTIONS`. */
export function gridFromWorksheet(ws: XLSX.WorkSheet): Grid {
  const builder = new GridBuilder();
  const data: (XLSX.CellObject | undefined)[][] = ws['!data'] ?? [];
  for (let r = 0; r < data.length; r++) {
    const row = data[r];
    if (!row) continue;
    for (let c = 0; c < row.length; c++) {
      const cell = row[c];
      if (!cell || cell.t === 'z' || cell.v === undefined) continue;
      const v = cell.v;
      if (cell.t === 'e') {
        const text = typeof v === 'number' ? ERROR_BY_CODE[v] : undefined;
        builder.error(r, c, text ?? ERROR_TEXTS[ERROR_TEXTS.length - 1]!);
      } else if (typeof v === 'number') {
        builder.number(r, c, v, typeof cell.z === 'string' ? cell.z : undefined);
      } else if (typeof v === 'string') {
        builder.text(r, c, v);
      } else if (typeof v === 'boolean') {
        builder.bool(r, c, v);
      }
    }
  }
  for (const m of ws['!merges'] ?? [])
    builder.merge({ r1: m.s.r, c1: m.s.c, r2: m.e.r, c2: m.e.c });
  return builder.finish();
}

/** Opens an `.xls` file. Throws `FileReadError`. */
export function openXls(bytes: Uint8Array): WorkbookSource {
  if (bytes.length >= MAX_XLS_BYTES) throw new FileReadError('validation.fileTooLarge');
  if (!isOleFile(bytes)) throw new FileReadError('validation.fileUnreadable');
  let wb: XLSX.WorkBook;
  try {
    wb = XLSX.read(bytes, SHEETJS_READ_OPTIONS);
  } catch {
    throw new FileReadError('validation.fileUnreadable');
  }
  return {
    sheetNames: wb.SheetNames,
    date1904: Boolean(wb.Workbook?.WBProps?.date1904),
    readSheet(index) {
      const ws = wb.Sheets[wb.SheetNames[index] ?? ''];
      if (!ws) throw new FileReadError('validation.fileUnreadable');
      return gridFromWorksheet(ws);
    },
  };
}
