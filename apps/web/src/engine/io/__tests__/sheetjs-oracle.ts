import type * as XLSX from 'xlsx';
import { ERROR_TEXTS, GridBuilder, type Grid } from '../xlsx-stream';

/**
 * Test oracle: SheetJS reads a workbook and its cells are put in the same grid as the streaming
 * reader builds, so `xlsx-stream.test.ts` compares the two cell by cell (AC f). Not app code: the
 * app reads only `.xlsx`, through `openXlsx` (MEMORY 2026-11-16, owner 1B).
 */

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
