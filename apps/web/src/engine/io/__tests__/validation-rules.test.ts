import { InputSlotSchema, type InputSlotInput } from '@hrflow/flow-schema';
import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { MAX_XLS_BYTES } from '../xls';
import { readSlot, type SourceFile } from '../validation';
import { rowXml, sheetXml, workbookParts, xlsxFrom } from './helpers';

function slot(input: Partial<InputSlotInput> = {}) {
  return InputSlotSchema.parse({
    key: 'ds',
    label: 'Danh sách',
    columns: [
      {
        key: 'ma_nv',
        aliases: ['Mã NV'],
        type: 'string',
        required: true,
        rules: [{ unique: true }],
      },
      { key: 'so', aliases: ['Số'], type: 'decimal', presence: 'required', defaultValue: 0 },
    ],
    skipRows: { whenBlank: ['ma_nv'], whenKeyContains: ['TỔNG CỘNG'] },
    ...input,
  });
}

const sheet = (rows: readonly (readonly (string | number | null)[])[], after = ''): string =>
  sheetXml(rows.map((cells, i) => rowXml(i + 1, cells)).join(''), after);

function file(
  name: string,
  rows: readonly (readonly (string | number | null)[])[],
  after = '',
): SourceFile {
  return { name, bytes: xlsxFrom(workbookParts({ Sheet1: sheet(rows, after) })) };
}

const keys = (r: ReturnType<typeof readSlot>): string[] => r.report.issues.map((i) => i.messageKey);

describe('readSlot: files and sheets', () => {
  it('checks the file count of the slot', () => {
    const f = file('a.xlsx', [
      ['Mã NV', 'Số'],
      ['A', 1],
    ]);
    expect(keys(readSlot(slot(), []))).toEqual(['validation.slotRequired']);
    expect(keys(readSlot(slot({ required: false }), []))).toEqual([]);
    expect(keys(readSlot(slot(), [f, f]))[0]).toBe('validation.filesTooMany');
    const many = slot({ multiple: { enabled: true, minFiles: 2, maxFiles: 3 } });
    expect(keys(readSlot(many, [f]))).toEqual(['validation.filesTooFew']);
  });

  it('refuses .csv and other extensions, unreadable bytes, and .xls of 64 MiB or more', () => {
    const csv = { name: 'a.csv', bytes: new TextEncoder().encode('Mã NV,Số\nA,1') };
    expect(readSlot(slot(), [csv]).report.issues[0]).toMatchObject({
      messageKey: 'validation.fileTypeNotAccepted',
      params: { file: 'a.csv', accept: '.xlsx, .xls' },
    });
    const junk = { name: 'a.xlsx', bytes: new Uint8Array([1, 2, 3, 4, 5]) };
    expect(keys(readSlot(slot(), [junk]))).toEqual(['validation.fileUnreadable']);
    const big = new Uint8Array(MAX_XLS_BYTES);
    big.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    expect(keys(readSlot(slot(), [{ name: 'big.xls', bytes: big }]))).toEqual([
      'validation.fileTooLarge',
    ]);
  });

  it('reads .xls through SheetJS with the same rules', () => {
    const ws = XLSX.utils.aoa_to_sheet([
      ['Mã NV', 'Số'],
      ['NV1', 1.5],
      ['TỔNG CỘNG', 1.5],
    ]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Data');
    const bytes = new Uint8Array(
      XLSX.write(wb, { bookType: 'biff8', type: 'array' }) as ArrayBuffer,
    );
    const { table, report } = readSlot(slot(), [{ name: 'old.xls', bytes }]);
    expect(report.errorCount).toBe(0);
    expect(table.rowCount).toBe(1);
    expect(String(table.get(0, 'so'))).toBe('1.5');
    expect(report.skippedRows[0]).toMatchObject({
      row: 3,
      messageKey: 'skipped.keyContains',
      params: { text: 'TỔNG CỘNG' },
    });
  });

  it('selects sheets by name (exact, then normalised), by index and by matching headers', () => {
    const parts = workbookParts({
      Bìa: sheet([['Tiêu đề']]),
      'Lương T9': sheet([
        ['Mã NV', 'Số'],
        ['A', 1],
      ]),
    });
    const bytes = xlsxFrom(parts);
    const f = { name: 'b.xlsx', bytes };
    expect(
      readSlot(slot({ sheet: { mode: 'byName', value: 'luong t9' } }), [f]).table.rowCount,
    ).toBe(1);
    expect(readSlot(slot({ sheet: { mode: 'byIndex', value: 1 } }), [f]).table.rowCount).toBe(1);
    expect(
      readSlot(slot({ sheet: { mode: 'firstMatchingHeaders' } }), [f]).report.files[0]?.sheet,
    ).toBe('Lương T9');
    expect(
      readSlot(slot({ sheet: { mode: 'byName', value: 'X' } }), [f]).report.issues[0],
    ).toMatchObject({
      messageKey: 'validation.sheetNotFound',
      params: { file: 'b.xlsx', sheet: 'X' },
    });
    expect(
      readSlot(slot({ sheet: { mode: 'byIndex', value: 5 } }), [f]).report.issues[0],
    ).toMatchObject({
      messageKey: 'validation.sheetIndexNotFound',
      params: { index: 6 },
    });
    const none = xlsxFrom(workbookParts({ A: sheet([['x']]) }));
    expect(
      keys(
        readSlot(slot({ sheet: { mode: 'firstMatchingHeaders' } }), [
          { name: 'n.xlsx', bytes: none },
        ]),
      ),
    ).toEqual(['validation.sheetNoMatchingHeaders']);
  });
});

describe('readSlot: columns and rows', () => {
  it('reports two headers matching a required column as an error, an optional one as a warning', () => {
    const s = slot({
      columns: [
        { key: 'ma_nv', aliases: ['Mã NV', 'MSNV'], type: 'string', required: true },
        { key: 'ten', aliases: ['Tên'], type: 'string' },
        { key: 'pb', aliases: ['Phòng'], type: 'string' },
      ],
    });
    const r = readSlot(s, [
      file('a.xlsx', [
        ['Mã NV', 'MSNV', 'Tên', 'Tên'],
        ['A', 'B', 'x', 'y'],
      ]),
    ]);
    expect(r.report.issues.map((i) => [i.severity, i.messageKey])).toEqual([
      ['error', 'validation.columnAmbiguousRequired'],
      ['warning', 'validation.columnAmbiguous'],
      ['warning', 'validation.columnMissingOptional'],
    ]);
    expect(r.report.issues[0]?.params.headers).toBe('"Mã NV", "MSNV"');
    expect(r.table.get(0, 'ten')).toBe('x');
    expect(r.table.get(0, 'pb')).toBeNull();
  });

  it('applies required, defaultValue, type, regex, min/max with their severity, original row numbers', () => {
    const s = slot({
      headerRow: 2,
      columns: [
        {
          key: 'ma_nv',
          aliases: ['Mã NV'],
          type: 'string',
          required: true,
          rules: [{ regex: '^NV\\d+$', severity: 'warning' }],
        },
        {
          key: 'so',
          aliases: ['Số'],
          type: 'decimal',
          defaultValue: 0,
          rules: [{ min: 0 }, { max: '10' }],
        },
        { key: 'ten', aliases: ['Tên'], type: 'string', required: true },
      ],
      skipRows: undefined,
    });
    const rows = [
      ['Báo cáo'],
      ['Mã NV', 'Số', 'Tên'],
      ['NV1', null, 'A'],
      ['X2', -1, 'B'],
      ['NV3', 'abc', null],
      ['NV4', 11, 'D'],
    ];
    const r = readSlot(s, [file('a.xlsx', rows)]);
    expect(r.report.issues.map((i) => [i.row, i.severity, i.messageKey, i.column])).toEqual([
      [4, 'warning', 'validation.regex', 'ma_nv'],
      [4, 'error', 'validation.min', 'so'],
      [5, 'error', 'validation.type', 'so'],
      [5, 'error', 'validation.required', 'ten'],
      [6, 'error', 'validation.max', 'so'],
    ]);
    expect(r.report.issues[2]?.params).toEqual({
      file: 'a.xlsx',
      row: 5,
      column: 'Số',
      value: 'abc',
      type: 'decimal',
    });
    expect(String(r.table.get(0, 'so'))).toBe('0');
    expect(r.table.rowCount).toBe(4);
  });

  it('skips total rows and blank keys, stops after blank rows, starts at dataStartRow', () => {
    const s = slot({ dataStartRow: 3, stopAt: { blankRows: 2 } });
    const rows = [
      ['Mã NV', 'Số'],
      ['bỏ qua', 9],
      ['A', 1],
      [null, 2],
      ['  Tổng   cộng  ', 3],
      [],
      ['B', 4],
      [],
      [],
      ['C', 5],
    ];
    const r = readSlot(s, [file('a.xlsx', rows)]);
    expect(r.table.rowCount).toBe(2);
    expect(r.report.skippedRows.map((x) => [x.row, x.messageKey])).toEqual([
      [4, 'skipped.keyBlank'],
      [5, 'skipped.keyContains'],
    ]);
    expect(r.report.files[0]).toMatchObject({ dataRows: 2, skippedRows: 2, errorCount: 0 });
  });

  it('fills merged data cells down only with unmergeCells: fillDown; Excel errors are type errors', () => {
    const rows = [
      ['Mã NV', 'Số', 'Nhóm'],
      ['A', 1, 'G1'],
      ['B', 2, null],
      ['C', 3, '#N/A'],
    ];
    const merged = '<mergeCells count="1"><mergeCell ref="C2:C3"/></mergeCells>';
    const s = (unmergeCells: 'none' | 'fillDown') =>
      slot({
        unmergeCells,
        columns: [...slot().columns, { key: 'nhom', aliases: ['Nhóm'], type: 'string' }],
      });
    const errCell = sheetXml(
      [
        rowXml(1, rows[0]!),
        rowXml(2, rows[1]!),
        rowXml(3, rows[2]!),
        '<row r="4"><c r="A4" t="inlineStr"><is><t>C</t></is></c><c r="B4"><v>3</v></c><c r="C4" t="e"><v>#N/A</v></c></row>',
      ].join(''),
      merged,
    );
    const f = { name: 'm.xlsx', bytes: xlsxFrom(workbookParts({ S: errCell })) };
    expect(readSlot(s('none'), [f]).table.get(1, 'nhom')).toBeNull();
    const filled = readSlot(s('fillDown'), [f]);
    expect(filled.table.get(1, 'nhom')).toBe('G1');
    expect(filled.report.issues).toEqual([
      expect.objectContaining({
        messageKey: 'validation.type',
        row: 4,
        params: expect.objectContaining({ value: '#N/A' }),
      }),
    ]);
  });

  it('keeps extra columns as text with extraColumns: keep, and warns above maxRows', () => {
    const s = slot({ extraColumns: 'keep', maxRows: 1, multiple: { enabled: true } });
    const a = file('a.xlsx', [
      ['Mã NV', 'Số', 'Ghi chú'],
      ['A', 1, 'x'],
      ['B', 2, 7],
    ]);
    const b = file('b.xlsx', [
      ['Mã NV', 'Số'],
      ['C', 3],
    ]);
    const r = readSlot(s, [a, b]);
    expect(r.table.columns.map((c) => c.key)).toEqual(['ma_nv', 'so', 'ghi_chu', '_source_file']);
    expect([0, 1, 2].map((i) => r.table.get(i, 'ghi_chu'))).toEqual(['x', '7', null]);
    expect(keys(r)).toEqual(['validation.rowsTooMany']);
  });
});
