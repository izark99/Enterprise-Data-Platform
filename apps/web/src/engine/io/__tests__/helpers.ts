import { InputSlotSchema, type InputSlot } from '@hrflow/flow-schema';
import { deflateSync, strToU8, zipSync } from 'fflate';
import { crc32Update } from '../zip';

/** Test helpers: fixture files, slots and hand-made ZIP packages (fake data only). */

interface NodeFs {
  readFileSync(path: URL): Uint8Array;
}

// Node built-ins without Node types in the app tsconfig (types stay `vite/client`).
const fs = (
  globalThis as unknown as { process: { getBuiltinModule(id: 'node:fs'): NodeFs } }
).process.getBuiltinModule('node:fs');

export const FIXTURE_FILES = [
  'bang_luong_CN01_092026.xlsx',
  'bang_luong_CN02_092026.xlsx',
  'bang_luong_CN03_092026.xlsx',
  'cham_cong_CN01_092026.xlsx',
  'cham_cong_CN02_092026.xlsx',
  'cham_cong_CN03_092026.xlsx',
] as const;

export function readFixture(name: string): Uint8Array {
  const bytes = fs.readFileSync(
    new URL(`../../../../../../fixtures/payroll-timesheet/${name}`, import.meta.url),
  );
  return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

export function fixtureSlot(key: 'bang_luong' | 'cham_cong'): InputSlot {
  const flow = JSON.parse(new TextDecoder().decode(readFixture('flow.json'))) as {
    inputSlots: { key: string }[];
  };
  return InputSlotSchema.parse(flow.inputSlots.find((s) => s.key === key));
}

export const HEAVY =
  (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env
    .HRFLOW_HEAVY === '1';

export interface RawEntry {
  name: string;
  /** Bytes written as the entry data (already compressed for method 8). */
  data: Uint8Array;
  method?: number;
  flags?: number;
  /** Declared values; default to the true ones. */
  crc?: number;
  size?: number;
  compressedSize?: number;
}

function le16(n: number): number[] {
  return [n & 0xff, (n >>> 8) & 0xff];
}

function le32(n: number): number[] {
  return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
}

/** A ZIP archive whose headers may lie (sizes, CRC, flags, method). */
export function rawZip(
  entries: readonly (RawEntry & { trueSize: number; trueCrc: number })[],
): Uint8Array {
  const parts: Uint8Array[] = [];
  const central: number[][] = [];
  let offset = 0;
  for (const e of entries) {
    const name = strToU8(e.name);
    const method = e.method ?? 8;
    const flags = e.flags ?? 0;
    const crc = e.crc ?? e.trueCrc;
    const size = e.size ?? e.trueSize;
    const csize = e.compressedSize ?? e.data.length;
    const fields = [
      ...le16(flags),
      ...le16(method),
      0,
      0,
      0,
      0,
      ...le32(crc),
      ...le32(csize),
      ...le32(size),
    ];
    const local = new Uint8Array([
      ...le32(0x04034b50),
      ...le16(20),
      ...fields,
      ...le16(name.length),
      ...le16(0),
    ]);
    central.push([
      ...le32(0x02014b50),
      ...le16(20),
      ...le16(20),
      ...fields,
      ...le16(name.length),
      ...le16(0),
      ...le16(0),
      ...le16(0),
      ...le16(0),
      ...le32(0),
      ...le32(offset),
      ...name,
    ]);
    parts.push(local, name, e.data);
    offset += local.length + name.length + e.data.length;
  }
  const cd = new Uint8Array(central.flat());
  const eocd = new Uint8Array([
    ...le32(0x06054b50),
    0,
    0,
    0,
    0,
    ...le16(entries.length),
    ...le16(entries.length),
    ...le32(cd.length),
    ...le32(offset),
    0,
    0,
  ]);
  parts.push(cd, eocd);
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** An entry deflated from `content`, true sizes and CRC filled in. */
export function deflated(name: string, content: Uint8Array | string, lie: Partial<RawEntry> = {}) {
  const bytes = typeof content === 'string' ? strToU8(content) : content;
  return {
    name,
    data: deflateSync(bytes, { level: 6 }),
    trueSize: bytes.length,
    trueCrc: crc32Update(0, bytes),
    ...lie,
  };
}

const NS_MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const NS_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const NS_PKG = 'http://schemas.openxmlformats.org/package/2006/relationships';

/** Parts of a minimal workbook; `sheets` maps sheet name → worksheet XML. */
export function workbookParts(
  sheets: Record<string, string>,
  extra: { sharedStrings?: string; styles?: string } = {},
): Record<string, string> {
  const names = Object.keys(sheets);
  const parts: Record<string, string> = {
    '[Content_Types].xml': `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${names
      .map(
        (_, i) =>
          `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
      )
      .join(
        '',
      )}${extra.sharedStrings ? '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>' : ''}${extra.styles ? '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' : ''}</Types>`,
    '_rels/.rels': `<?xml version="1.0"?><Relationships xmlns="${NS_PKG}"><Relationship Id="rId1" Type="${NS_REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    'xl/workbook.xml': `<?xml version="1.0"?><workbook xmlns="${NS_MAIN}" xmlns:r="${NS_REL}"><sheets>${names
      .map((n, i) => `<sheet name="${n}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
      .join('')}</sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': `<?xml version="1.0"?><Relationships xmlns="${NS_PKG}">${names
      .map(
        (_, i) =>
          `<Relationship Id="rId${i + 1}" Type="${NS_REL}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
      )
      .join(
        '',
      )}${extra.sharedStrings ? `<Relationship Id="rIdS" Type="${NS_REL}/sharedStrings" Target="sharedStrings.xml"/>` : ''}${extra.styles ? `<Relationship Id="rIdT" Type="${NS_REL}/styles" Target="styles.xml"/>` : ''}</Relationships>`,
  };
  names.forEach((n, i) => {
    parts[`xl/worksheets/sheet${i + 1}.xml`] = sheets[n]!;
  });
  if (extra.sharedStrings) parts['xl/sharedStrings.xml'] = extra.sharedStrings;
  if (extra.styles) parts['xl/styles.xml'] = extra.styles;
  return parts;
}

/** Worksheet XML with `<sheetData>` content `rows` and optional trailing XML (merges). */
export function sheetXml(rows: string, after = ''): string {
  return `<?xml version="1.0"?><worksheet xmlns="${NS_MAIN}"><sheetData>${rows}</sheetData>${after}</worksheet>`;
}

/** Inline-string row: `cells` in column order from A; numbers stay numbers, null leaves a gap. */
export function rowXml(r: number, cells: readonly (string | number | null)[]): string {
  const xml = cells
    .map((v, i) => {
      if (v === null) return '';
      const ref = `${colName(i)}${r}`;
      if (typeof v === 'number') return `<c r="${ref}"><v>${v}</v></c>`;
      return `<c r="${ref}" t="inlineStr"><is><t>${escapeXml(v)}</t></is></c>`;
    })
    .join('');
  return `<row r="${r}">${xml}</row>`;
}

export function colName(c: number): string {
  let s = '';
  for (let n = c + 1; n > 0; n = Math.floor((n - 1) / 26))
    s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** An honest `.xlsx` package from part texts (fflate `zipSync`). */
export function xlsxFrom(parts: Record<string, string>): Uint8Array {
  const files: Record<string, Uint8Array> = {};
  for (const [name, text] of Object.entries(parts)) files[name] = strToU8(text);
  return zipSync(files);
}
