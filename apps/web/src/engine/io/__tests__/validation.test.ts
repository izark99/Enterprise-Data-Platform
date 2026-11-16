import { InputSlotSchema, type InputSlotInput } from '@hrflow/flow-schema';
import { describe, expect, it } from 'vitest';
import { isDecimal } from '../../core/decimal';
import { readSlot, SOURCE_FILE_COLUMN, type SourceFile } from '../validation';
import {
  FIXTURE_FILES,
  fixtureSlot,
  readFixture,
  rowXml,
  sheetXml,
  workbookParts,
  xlsxFrom,
} from './helpers';

const payrollFiles = (): SourceFile[] =>
  FIXTURE_FILES.filter((f) => f.startsWith('bang_luong')).map((name) => ({
    name,
    bytes: readFixture(name),
  }));
const timesheetFiles = (): SourceFile[] =>
  FIXTURE_FILES.filter((f) => f.startsWith('cham_cong')).map((name) => ({
    name,
    bytes: readFixture(name),
  }));

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
    multiple: { enabled: true },
    ...input,
  });
}

function file(name: string, rows: readonly (readonly (string | number | null)[])[]): SourceFile {
  const xml = sheetXml(rows.map((cells, i) => rowXml(i + 1, cells)).join(''));
  return { name, bytes: xlsxFrom(workbookParts({ Sheet1: xml })) };
}

describe('readSlot on the payroll fixtures', () => {
  it('reads 75 payroll rows without errors; MSNV maps to ma_nv (AC-02, AC-03)', () => {
    const { table, report } = readSlot(fixtureSlot('bang_luong'), payrollFiles());
    expect(report.issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(report.errorCount).toBe(0);
    expect(table.rowCount).toBe(75);
    expect(report.files.map((f) => f.dataRows)).toEqual([30, 25, 20]);
    // CN02 uses the header "MSNV".
    const cn02 = report.files[1]!;
    expect(cn02.file).toBe('bang_luong_CN02_092026.xlsx');
    expect(cn02.errorCount).toBe(0);
    const ids = table.column('ma_nv');
    const sources = table.column(SOURCE_FILE_COLUMN);
    const cn02Ids: string[] = [];
    for (let i = 0; i < table.rowCount; i++) {
      if (sources.get(i) === cn02.file) cn02Ids.push(ids.get(i) as string);
    }
    expect(cn02Ids).toHaveLength(25);
    expect(cn02Ids.every((id) => /^NV\d{5}$/.test(id))).toBe(true);
    // The "TỔNG CỘNG" rows are skipped, not data (key blank or key text).
    expect(report.skippedRows.length).toBeGreaterThanOrEqual(3);
    expect(isDecimal(table.get(0, 'cong'))).toBe(true);
    expect(table.columns.map((c) => c.key)).toEqual([
      'ma_nv',
      'ho_ten',
      'chi_nhanh',
      'cong',
      'ot',
      'phep',
      'khong_luong',
      SOURCE_FILE_COLUMN,
    ]);
  });

  it('reads 75 timesheet rows without errors (AC-03)', () => {
    const { table, report } = readSlot(fixtureSlot('cham_cong'), timesheetFiles());
    expect(report.errorCount).toBe(0);
    expect(table.rowCount).toBe(75);
  });
});

describe('readSlot rules', () => {
  it('reports a key shared by two files on both files, with file and row (AC-07)', () => {
    const a = file('a.xlsx', [
      ['Mã NV', 'Số'],
      ['NV1', 1],
      ['nv2 ', 2],
    ]);
    const b = file('b.xlsx', [
      ['Mã NV', 'Số'],
      ['X9', 3],
      ['NV2', 4],
    ]);
    const { report } = readSlot(slot(), [a, b]);
    const dup = report.issues.filter((i) => i.messageKey === 'validation.unique');
    expect(dup).toHaveLength(1);
    expect(dup[0]).toMatchObject({
      severity: 'error',
      file: 'b.xlsx',
      row: 3,
      relatedFile: 'a.xlsx',
      params: {
        file: 'b.xlsx',
        row: 3,
        otherFile: 'a.xlsx',
        otherRow: 3,
        value: 'NV2',
        otherValue: 'nv2',
      },
    });
    expect(report.files.map((f) => f.errorCount)).toEqual([1, 1]);
  });

  it('reports a missing key column once, with no row errors (AC-08)', () => {
    const f = file('thieu.xlsx', [
      ['Họ tên', 'Số'],
      ['A', 1],
      ['B', 'x'],
      ['', 3],
    ]);
    const { report, table } = readSlot(slot(), [f]);
    expect(report.issues).toHaveLength(1);
    expect(report.issues[0]).toMatchObject({
      severity: 'error',
      messageKey: 'validation.columnMissing',
      file: 'thieu.xlsx',
      column: 'ma_nv',
      params: { file: 'thieu.xlsx', sheet: 'Sheet1', column: 'Mã NV', headerRow: 1 },
    });
    expect(table.rowCount).toBe(0);
  });

  it('keeps 00123 as text, warns on "1,500" and on a header without data rows (AC g)', () => {
    const text = file('t.xlsx', [
      ['Mã NV', 'Số'],
      ['00123', '1,500'],
    ]);
    const { table, report } = readSlot(slot(), [text]);
    expect(table.get(0, 'ma_nv')).toBe('00123');
    const warning = report.issues.find((i) => i.messageKey === 'validation.numberAmbiguous');
    expect(warning).toMatchObject({
      severity: 'warning',
      row: 2,
      column: 'so',
      params: { value: '1,500', parsed: '1500' },
    });
    expect(report.errorCount).toBe(0);

    // A number shown with the format 00000 in a text column keeps its displayed zeros.
    const styles =
      '<styleSheet><numFmts count="1"><numFmt numFmtId="164" formatCode="00000"/></numFmts><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="164"/></cellXfs></styleSheet>';
    const formatted = sheetXml(
      rowXml(1, ['Mã NV', 'Số']) +
        '<row r="2"><c r="A2" s="1"><v>123</v></c><c r="B2"><v>1</v></c></row>',
    );
    const fromNumber = readSlot(slot(), [
      { name: 'n.xlsx', bytes: xlsxFrom(workbookParts({ S: formatted }, { styles })) },
    ]);
    expect(fromNumber.report.errorCount).toBe(0);
    expect(fromNumber.table.get(0, 'ma_nv')).toBe('00123');

    const empty = readSlot(slot(), [file('e.xlsx', [['Mã NV', 'Số']])]).report;
    expect(empty.issues).toEqual([
      expect.objectContaining({
        severity: 'warning',
        messageKey: 'validation.noDataRows',
        params: { file: 'e.xlsx', sheet: 'Sheet1' },
      }),
    ]);
  });
});
