import type { DataType } from '@hrflow/flow-schema';
import { Deflate } from 'fflate';
import { isDecimal } from '../core/decimal';
import type { Table, Vector } from '../core/table';
import type { ColumnDef } from '../core/types';
import { crc32Update } from './zip';

/**
 * Streaming `.xlsx` writer for large results (spec §13: above 2,000,000 cells, "cùng bố cục với
 * ExcelJS"). ExcelJS keeps one object per cell; this writer renders the sheet XML from the column
 * vectors in chunks and deflates each chunk at once (`fflate` `Deflate`), so only compressed bytes
 * pile up. The layout is the one the ExcelJS writer produces (`excel-writer.ts`): bold header row,
 * frozen first row, auto-filter over the header, column widths, number format per column, dates as
 * date serials, booleans as booleans, text as inline strings (never a formula).
 */

export interface StreamSheet {
  readonly name: string;
  readonly columns: readonly ColumnDef[];
  readonly table: Table;
  /** Column widths in characters. */
  readonly widths: readonly number[];
  /** Number format per column; `undefined` = General. */
  readonly numFmts: readonly (string | undefined)[];
}

const encoder = new TextEncoder();
/** Text gathered before it is encoded and deflated. */
const CHUNK_CHARS = 1 << 16;

interface ZipEntryRecord {
  readonly name: Uint8Array;
  readonly crc: number;
  readonly compressed: number;
  readonly size: number;
  readonly offset: number;
}

/** ZIP package written entry by entry (deflate, sizes in the local header, no ZIP64). */
class ZipWriter {
  private readonly parts: Uint8Array[] = [];
  private offset = 0;
  private readonly entries: ZipEntryRecord[] = [];

  /** One entry whose text is produced by `produce(write)`. */
  entry(path: string, produce: (write: (text: string) => void) => void): void {
    const chunks: Uint8Array[] = [];
    let compressed = 0;
    const deflate = new Deflate({ level: 6 });
    deflate.ondata = (chunk) => {
      chunks.push(chunk);
      compressed += chunk.length;
    };
    let crc = 0;
    let size = 0;
    let pending = '';
    const flush = (final: boolean): void => {
      const bytes = encoder.encode(pending);
      pending = '';
      crc = crc32Update(crc, bytes);
      size += bytes.length;
      deflate.push(bytes, final);
    };
    produce((text) => {
      pending += text;
      if (pending.length >= CHUNK_CHARS) flush(false);
    });
    flush(true);

    const name = encoder.encode(path);
    const header = new Uint8Array(30 + name.length);
    const h = new DataView(header.buffer);
    h.setUint32(0, 0x04034b50, true);
    h.setUint16(4, 20, true);
    h.setUint16(6, 0x0800, true); // UTF-8 names
    h.setUint16(8, 8, true); // deflate
    h.setUint32(14, crc, true);
    h.setUint32(18, compressed, true);
    h.setUint32(22, size, true);
    h.setUint16(26, name.length, true);
    header.set(name, 30);
    this.entries.push({ name, crc, compressed, size, offset: this.offset });
    this.push(header);
    for (const chunk of chunks) this.push(chunk);
  }

  finish(): Uint8Array {
    const start = this.offset;
    for (const e of this.entries) {
      const cd = new Uint8Array(46 + e.name.length);
      const c = new DataView(cd.buffer);
      c.setUint32(0, 0x02014b50, true);
      c.setUint16(4, 20, true);
      c.setUint16(6, 20, true);
      c.setUint16(8, 0x0800, true);
      c.setUint16(10, 8, true);
      c.setUint32(16, e.crc, true);
      c.setUint32(20, e.compressed, true);
      c.setUint32(24, e.size, true);
      c.setUint16(28, e.name.length, true);
      c.setUint32(42, e.offset, true);
      cd.set(e.name, 46);
      this.push(cd);
    }
    const end = new Uint8Array(22);
    const v = new DataView(end.buffer);
    v.setUint32(0, 0x06054b50, true);
    v.setUint16(8, this.entries.length, true);
    v.setUint16(10, this.entries.length, true);
    v.setUint32(12, this.offset - start, true);
    v.setUint32(16, start, true);
    this.push(end);
    const out = new Uint8Array(this.offset);
    let p = 0;
    for (const part of this.parts) {
      out.set(part, p);
      p += part.length;
    }
    this.parts.length = 0;
    return out;
  }

  private push(bytes: Uint8Array): void {
    this.parts.push(bytes);
    this.offset += bytes.length;
  }
}

// Characters XML 1.0 does not allow are dropped.
// eslint-disable-next-line no-control-regex
const XML_SPECIAL = /[&<>"\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g;

function esc(text: string): string {
  return text.replace(XML_SPECIAL, (ch) => {
    switch (ch) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '';
    }
  });
}

/** Column letters of a 0-based column index (`0` → `A`, `26` → `AA`). */
export function columnLetters(index: number): string {
  let s = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  }
  return s;
}

const MS_PER_DAY = 86_400_000;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2}))?$/;

/**
 * Milliseconds since 1970 of an ISO date / datetime read as UTC wall time (ExcelJS turns a `Date`
 * into a serial from its UTC time), or `null` when the text is not ISO.
 */
export function isoToUtcMs(text: string): number | null {
  const m = ISO_DATE.exec(text);
  if (m === null) return null;
  const [, y, mo, d, hh = '0', mi = '0', ss = '0'] = m;
  return Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(hh), Number(mi), Number(ss));
}

/** Excel serial of an ISO date / datetime, computed as ExcelJS does. */
function isoSerial(text: string): number | null {
  const ms = isoToUtcMs(text);
  return ms === null ? null : 25569 + ms / MS_PER_DAY;
}

/** Excel built-in number formats; any other format gets an id from 164 on. */
const BUILTIN_FORMATS: Readonly<Record<string, number>> = {
  '0': 1,
  '0.00': 2,
  '#,##0': 3,
  '#,##0.00': 4,
};

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const NS_MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const NS_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const NS_PKG_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const CT = 'application/vnd.openxmlformats-officedocument.spreadsheetml';

function inlineString(ref: string, style: string, text: string): string {
  return `<c r="${ref}"${style} t="inlineStr"><is><t xml:space="preserve">${esc(text)}</t></is></c>`;
}

function cellXml(vector: Vector, type: DataType, row: number, ref: string, xf: number): string {
  const style = xf === 0 ? '' : ` s="${xf}"`;
  const v = vector.get(row);
  // A blank cell of a formatted column keeps the column style, as ExcelJS writes it.
  if (v === null) return xf === 0 ? '' : `<c r="${ref}"${style}/>`;
  if (isDecimal(v)) return `<c r="${ref}"${style}><v>${Number(v.toString())}</v></c>`;
  if (typeof v === 'number') return `<c r="${ref}"${style}><v>${v}</v></c>`;
  if (typeof v === 'boolean') return `<c r="${ref}"${style} t="b"><v>${v ? 1 : 0}</v></c>`;
  if (type === 'date' || type === 'datetime') {
    const serial = isoSerial(v);
    if (serial !== null) return `<c r="${ref}"${style}><v>${serial}</v></c>`;
  }
  return inlineString(ref, style, v);
}

/** Writes the sheets as one `.xlsx` package. */
export function writeStreamingWorkbook(sheets: readonly StreamSheet[]): Uint8Array {
  // Cell formats: 0 = default, 1 = bold header, then one per distinct number format.
  const formatIds = new Map<string, number>();
  const xfOfFormat = new Map<string, number>();
  let nextCustom = 164;
  for (const sheet of sheets) {
    for (const f of sheet.numFmts) {
      if (f === undefined || xfOfFormat.has(f)) continue;
      formatIds.set(f, BUILTIN_FORMATS[f] ?? nextCustom++);
      xfOfFormat.set(f, 2 + xfOfFormat.size);
    }
  }

  const zip = new ZipWriter();
  sheets.forEach((sheet, k) => {
    const { columns, table } = sheet;
    const refs = columns.map((_, j) => columnLetters(j));
    const xfs = sheet.numFmts.map((f) => (f === undefined ? 0 : xfOfFormat.get(f)!));
    const vectors = columns.map((col) => table.column(col.key));
    const last = refs[refs.length - 1];
    zip.entry(`xl/worksheets/sheet${k + 1}.xml`, (write) => {
      const cols = sheet.widths
        .map((w, j) => {
          const style = xfs[j] === 0 ? '' : ` style="${xfs[j]}"`;
          return `<col min="${j + 1}" max="${j + 1}" width="${w}"${style} customWidth="1"/>`;
        })
        .join('');
      write(
        `${XML_HEAD}<worksheet xmlns="${NS_MAIN}" xmlns:r="${NS_REL}">` +
          `<dimension ref="${last === undefined ? 'A1' : `A1:${last}${table.rowCount + 1}`}"/>` +
          '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft"/></sheetView></sheetViews>' +
          '<sheetFormatPr defaultRowHeight="15"/>' +
          (cols === '' ? '' : `<cols>${cols}</cols>`) +
          '<sheetData>',
      );
      if (columns.length > 0) {
        let header = '<row r="1" s="1" customFormat="1">';
        columns.forEach((col, j) => {
          header += inlineString(`${refs[j]}1`, ' s="1"', col.title);
        });
        write(`${header}</row>`);
      }
      for (let i = 0; i < table.rowCount; i++) {
        const r = i + 2;
        let row = `<row r="${r}">`;
        for (let j = 0; j < columns.length; j++) {
          row += cellXml(vectors[j]!, columns[j]!.type, i, `${refs[j]}${r}`, xfs[j]!);
        }
        write(`${row}</row>`);
      }
      write(
        '</sheetData>' +
          (last === undefined ? '' : `<autoFilter ref="A1:${last}1"/>`) +
          '<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/></worksheet>',
      );
    });
  });

  const one =
    (text: string) =>
    (write: (t: string) => void): void =>
      write(text);
  const numFmts = [...formatIds]
    .filter(([, id]) => id >= 164)
    .map(([f, id]) => `<numFmt numFmtId="${id}" formatCode="${esc(f)}"/>`);
  const formatXfs = [...xfOfFormat.keys()]
    .map(
      (f) =>
        `<xf numFmtId="${formatIds.get(f)}" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>`,
    )
    .join('');
  zip.entry(
    'xl/styles.xml',
    one(
      `${XML_HEAD}<styleSheet xmlns="${NS_MAIN}">` +
        (numFmts.length === 0
          ? ''
          : `<numFmts count="${numFmts.length}">${numFmts.join('')}</numFmts>`) +
        // The same fonts as ExcelJS: its default font, and the bold header font.
        '<fonts count="2"><font><color theme="1"/><family val="2"/><scheme val="minor"/><sz val="11"/><name val="Calibri"/></font><font><b/></font></fonts>' +
        '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
        '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
        '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
        `<cellXfs count="${2 + xfOfFormat.size}"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>${formatXfs}</cellXfs>` +
        '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
        '</styleSheet>',
    ),
  );
  const sheetList = sheets
    .map((s, k) => `<sheet name="${esc(s.name)}" sheetId="${k + 1}" r:id="rId${k + 1}"/>`)
    .join('');
  zip.entry(
    'xl/workbook.xml',
    one(
      `${XML_HEAD}<workbook xmlns="${NS_MAIN}" xmlns:r="${NS_REL}"><bookViews><workbookView/></bookViews><sheets>${sheetList}</sheets></workbook>`,
    ),
  );
  const sheetRels = sheets
    .map(
      (_, k) =>
        `<Relationship Id="rId${k + 1}" Type="${NS_REL}/worksheet" Target="worksheets/sheet${k + 1}.xml"/>`,
    )
    .join('');
  zip.entry(
    'xl/_rels/workbook.xml.rels',
    one(
      `${XML_HEAD}<Relationships xmlns="${NS_PKG_REL}">${sheetRels}<Relationship Id="rId${sheets.length + 1}" Type="${NS_REL}/styles" Target="styles.xml"/></Relationships>`,
    ),
  );
  zip.entry(
    '_rels/.rels',
    one(
      `${XML_HEAD}<Relationships xmlns="${NS_PKG_REL}"><Relationship Id="rId1" Type="${NS_REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    ),
  );
  const overrides = sheets
    .map(
      (_, k) =>
        `<Override PartName="/xl/worksheets/sheet${k + 1}.xml" ContentType="${CT}.worksheet+xml"/>`,
    )
    .join('');
  zip.entry(
    '[Content_Types].xml',
    one(
      `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        `<Override PartName="/xl/workbook.xml" ContentType="${CT}.sheet.main+xml"/>` +
        `<Override PartName="/xl/styles.xml" ContentType="${CT}.styles+xml"/>` +
        `${overrides}</Types>`,
    ),
  );
  return zip.finish();
}
