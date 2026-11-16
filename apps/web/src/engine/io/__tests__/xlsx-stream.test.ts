import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { gridFromWorksheet, SHEETJS_READ_OPTIONS } from '../xls';
import { openXlsx, type CellRead, type Grid } from '../xlsx-stream';
import { FIXTURE_FILES, readFixture, sheetXml, workbookParts, xlsxFrom } from './helpers';

/** Every cell of both grids (over the larger range), as comparable plain values. */
function cells(
  grid: Grid,
  lastRow: number,
  lastCol: number,
  followMerges: boolean,
): (CellRead | null)[][] {
  const out: (CellRead | null)[][] = [];
  for (let r = 0; r <= lastRow; r++) {
    const row: (CellRead | null)[] = [];
    for (let c = 0; c <= lastCol; c++) {
      const cell = grid.cell(r, c, followMerges);
      row.push(cell.value === null && cell.error === undefined ? null : { ...cell });
    }
    out.push(row);
  }
  return out;
}

/** Streamed grid and SheetJS grid of every sheet are equal, cell by cell, blank rows included. */
function expectSameAsSheetJs(bytes: Uint8Array): number {
  const stream = openXlsx(bytes);
  const wb = XLSX.read(bytes, SHEETJS_READ_OPTIONS);
  expect(stream.sheetNames).toEqual(wb.SheetNames);
  let compared = 0;
  stream.sheetNames.forEach((name, i) => {
    const mine = stream.readSheet(i);
    const oracle = gridFromWorksheet(wb.Sheets[name]!);
    const lastRow = Math.max(mine.lastRow, oracle.lastRow);
    const lastCol = Math.max(mine.lastCol, oracle.lastCol);
    for (const follow of [false, true]) {
      expect(cells(mine, lastRow, lastCol, follow)).toEqual(
        cells(oracle, lastRow, lastCol, follow),
      );
    }
    for (let r = 0; r <= lastRow + 1; r++) expect(mine.isRowBlank(r)).toBe(oracle.isRowBlank(r));
    compared += (lastRow + 1) * (lastCol + 1);
  });
  return compared;
}

describe('streaming .xlsx reader equals SheetJS (AC f)', () => {
  it.each(FIXTURE_FILES)('%s', (name) => {
    expect(expectSameAsSheetJs(readFixture(name))).toBeGreaterThan(100);
  });

  it('on shared strings, rich text, inline strings, formats, errors, booleans and merges', () => {
    const sst = `<sst xmlns="x"><si><t>Họ  tên</t><t>bỏ</t></si><si><r><t>A</t></r><rPh><t>no</t></rPh><r><t xml:space="preserve"> &amp;B</t></r></si><si><rPh><t>k</t></rPh></si><si/><si><t>a_x0041_&#x42;&#67;</t></si><si><t>a_x0041_&#x42;&#67;&AMP;</t></si></sst>`;
    const styles = `<styleSheet><numFmts count="1"><numFmt numFmtId="164" formatCode="00000"/></numFmts><cellStyleXfs count="1"><xf numFmtId="0"/></cellStyleXfs><cellXfs count="4"><xf numFmtId="0"/><xf numFmtId="164"/><xf numFmtId="14"/><xf numFmtId="4"/></cellXfs></styleSheet>`;
    const rows = [
      '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c><c r="D1" t="s"><v>3</v></c><c r="E1" t="s"><v>4</v></c><c r="F1" t="s"><v>5</v></c></row>',
      '<row r="2"><c r="A2" s="1"><v>123</v></c><c r="B2" s="2"><v>45293</v></c><c r="C2" s="3"><v>1234.5</v></c><c r="D2"><v>-0.1</v></c><c r="E2"><v>1E-3</v></c><c r="F2"><v>12345678901234567</v></c></row>',
      '<row r="3"><c r="A3" t="b"><v>1</v></c><c r="B3" t="b"/><c r="C3" t="e"><v>#N/A</v></c><c r="D3" t="e"><v>#FOO</v></c><c r="E3" t="str"><v>Mã &amp;amp; số&#13;&#10;x</v></c><c r="F3" t="inlineStr"><is><t>Lương</t><t>x</t></is></c></row>',
      '<row r="5"/><row><c><v>5</v></c><c t="d"><v>2024-01-02T12:00:00</v></c><c t="zz"><v>q&amp;</v></c><c r="AB6"><v>7</v></c></row>',
      '<row r="8"><c r="A8" t="s"><v>3</v></c><c r="B8" t="inlineStr"><is><t>  </t></is></c></row>',
      '<row r="9"><c r="C9"><v>2</v></c><c r="A9"><v>1</v></c><c r="C9"><v>3</v></c></row>',
    ].join('');
    const merges =
      '<mergeCells count="2"><mergeCell ref="A1:C1"/><mergeCell ref="A10:B12"/></mergeCells>';
    const bytes = xlsxFrom(
      workbookParts(
        { 'S&amp;1': sheetXml(rows, merges), Hai: sheetXml('') },
        { sharedStrings: sst, styles },
      ),
    );
    expectSameAsSheetJs(bytes);
    const grid = openXlsx(bytes).readSheet(0);
    expect(grid.cell(1, 0, false)).toEqual({ value: 123, numFmt: '00000' });
    expect(grid.cell(0, 1, true)).toEqual({ value: 'A &B' });
    expect(grid.cell(9, 1, true)).toEqual({ value: null });
    expect(grid.cell(8, 2, false)).toEqual({ value: 3 });
    expect(grid.isRowBlank(7)).toBe(true);
  });

  it('on a sheet spread over many inflate chunks', () => {
    const rows: string[] = [];
    for (let r = 1; r <= 3000; r++) {
      rows.push(
        `<row r="${r}"><c r="A${r}" t="inlineStr"><is><t>Nhân viên ${r} – Đặng</t></is></c><c r="B${r}"><v>${r * 1.25}</v></c><c r="C${r}" t="str"><v>x&amp;${r}</v></c></row>`,
      );
    }
    expectSameAsSheetJs(xlsxFrom(workbookParts({ Data: sheetXml(rows.join('')) })));
  });
});
