import type { InputSlot } from '@hrflow/flow-schema';
import { InputSlotSchema } from '@hrflow/flow-schema';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { openWorkbook, readSlot } from '../validation';
import { FileReadError } from '../zip';
import { FIXTURE_FILES, fixtureSlot, HEAVY, readFixture } from './helpers';

/**
 * Fuzz of the readers (T-R1-04 AC h). Fixed-seed PRNG: a failure names its category, seed and
 * iteration, so it reproduces. Fake data only (fixtures/payroll-timesheet). Fast by default;
 * `HRFLOW_HEAVY=1` runs many more iterations.
 */

const N = HEAVY ? 400 : 25;
const FILE_KEYS = new Set(['validation.fileTooLarge', 'validation.fileUnreadable']);
/** One case must stay well under the test timeout. */
const MAX_CASE_MS = 5_000;

function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Rand = () => number;
const int = (rnd: Rand, n: number): number => Math.floor(rnd() * n);
const pick = <T>(rnd: Rand, xs: readonly T[]): T => xs[int(rnd, xs.length)]!;

const fixtures = FIXTURE_FILES.map((name) => ({ name, bytes: readFixture(name) }));
const slots: Record<string, InputSlot> = {
  bang_luong: fixtureSlot('bang_luong'),
  cham_cong: fixtureSlot('cham_cong'),
};
const slotFor = (name: string): InputSlot =>
  name.startsWith('bang_luong') ? slots.bang_luong! : slots.cham_cong!;

/** Slot that reads every column type from columns A–F (numbers with hostile formats). */
const anySlot = InputSlotSchema.parse({
  key: 'ds',
  label: 'Danh sách',
  sheet: { mode: 'byIndex', value: 0 },
  columns: [
    { key: 'a', aliases: ['A'], type: 'string' },
    { key: 'b', aliases: ['B'], type: 'date' },
    { key: 'c', aliases: ['C'], type: 'datetime' },
    { key: 'd', aliases: ['D'], type: 'decimal', rules: [{ min: 0 }] },
    { key: 'e', aliases: ['E'], type: 'integer', rules: [{ unique: true }] },
    { key: 'f', aliases: ['F'], type: 'boolean' },
  ],
  extraColumns: 'keep',
});

interface Tally {
  cases: number;
  outcomes: Record<string, number>;
  maxMs: number;
}

const tallies: Record<string, Tally> = {};

/**
 * Runs one input through `openWorkbook` (+ every `readSheet`) and `readSlot`. Fails the test on an
 * exception that is not a `FileReadError`, on any file-read key other than the two, or on a slow case.
 */
function check(category: string, label: string, bytes: Uint8Array, slot: InputSlot, ext: string) {
  const t = (tallies[category] ??= { cases: 0, outcomes: {}, maxMs: 0 });
  const start = performance.now();
  try {
    const book = openWorkbook(bytes);
    for (let i = 0; i < book.sheetNames.length; i++) {
      try {
        book.readSheet(i);
      } catch (err) {
        if (!(err instanceof FileReadError)) {
          throw new Error(`${label}: readSheet threw ${String(err)}`, { cause: err });
        }
      }
    }
  } catch (err) {
    if (!(err instanceof FileReadError)) {
      throw new Error(`${label}: openWorkbook threw ${String(err)}`, { cause: err });
    }
    expect(FILE_KEYS.has(err.messageKey), label).toBe(true);
  }
  let result: ReturnType<typeof readSlot>;
  try {
    result = readSlot(slot, [{ name: `fuzz${ext}`, bytes }]);
  } catch (err) {
    throw new Error(`${label}: readSlot threw ${String(err)}`, { cause: err });
  }
  const ms = performance.now() - start;
  t.maxMs = Math.max(t.maxMs, ms);
  expect(ms, `${label}: ${ms.toFixed(0)} ms`).toBeLessThan(MAX_CASE_MS);
  const fileLevel = result.report.issues.filter(
    (i) => i.messageKey.startsWith('validation.file') && i.row === undefined,
  );
  for (const i of fileLevel)
    expect(FILE_KEYS.has(i.messageKey), `${label}: ${i.messageKey}`).toBe(true);
  // A file-read error carries only the file name: no content in the params.
  for (const i of fileLevel) expect(Object.keys(i.params ?? {}), label).toEqual(['file']);
  const outcome =
    fileLevel[0]?.messageKey ??
    (result.report.errorCount > 0 ? 'read, with row/column errors' : 'read');
  t.outcomes[outcome] = (t.outcomes[outcome] ?? 0) + 1;
  t.cases++;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function u16(b: Uint8Array, i: number): number {
  return b[i]! | (b[i + 1]! << 8);
}
function u32(b: Uint8Array, i: number): number {
  return (b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16) | (b[i + 3]! << 24)) >>> 0;
}
function put32(b: Uint8Array, i: number, v: number): void {
  b[i] = v & 0xff;
  b[i + 1] = (v >>> 8) & 0xff;
  b[i + 2] = (v >>> 16) & 0xff;
  b[i + 3] = (v >>> 24) & 0xff;
}
function put16(b: Uint8Array, i: number, v: number): void {
  b[i] = v & 0xff;
  b[i + 1] = (v >>> 8) & 0xff;
}

/** Offsets of the central-directory records and the EOCD of an honest archive. */
function centralRecords(b: Uint8Array): { eocd: number; records: number[] } {
  let eocd = -1;
  for (let i = b.length - 22; i >= 0; i--) {
    if (u32(b, i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  const records: number[] = [];
  let p = u32(b, eocd + 16);
  for (let k = 0; k < u16(b, eocd + 10); k++) {
    records.push(p);
    p += 46 + u16(b, p + 28) + u16(b, p + 30) + u16(b, p + 32);
  }
  return { eocd, records };
}

const HOSTILE_VALUES = [
  0, 0xffffffff, 0x7fffffff, 0x80000000, 1, 0xfffffffe, 0x10000, 0xffff,
] as const;

const XML_SNIPPETS: readonly string[] = [
  '<c r="A1"',
  '<c',
  '<',
  '>',
  '"',
  "'",
  '&',
  '<![CDATA[',
  ']]>',
  '<![CDATA[<c r="A2"><v>1</v></c>]]>',
  '&#xFFFFFFFFFFFF;',
  '&#0;',
  '&#xD800;',
  '_xD800_',
  '_x0000_',
  '&AMP;',
  '&#99999999999999999999999;',
  '<!--',
  '-->',
  '<?pi',
  '<!DOCTYPE x [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;&a;">]>',
  '&b;',
  '<c r="ZZZZ1"><v>1</v></c>',
  '<c r="XFD1048576"><v>1</v></c>',
  '<c r="XFE1"><v>1</v></c>',
  '<c r="A1048577"><v>1</v></c>',
  '<c r="A0"><v>1</v></c>',
  '<c r="1A"><v>1</v></c>',
  '<c r=""><v>1</v></c>',
  '<c r="a1" t="s"><v>0</v></c>',
  '<row r="-5">',
  '<row r="99999999999">',
  '<row r="1048576"><c><v>1</v></c></row>',
  '<row/>',
  '</row>',
  '</c>',
  '</sheetData>',
  '<sheetData>',
  '<c t="s"><v>999999</v></c>',
  '<c t="s"><v>-1</v></c>',
  '<c t="s"><v>NaN</v></c>',
  '<c t="d"><v>99999-99-99T99:99</v></c>',
  '<c t="d"><v>x</v></c>',
  '<c t="e"><v>#WTF?</v></c>',
  '<c t="b"><v>2</v></c>',
  '<c t="zz"><v>q</v></c>',
  '<c><v>1e999</v></c>',
  '<c><v>-1e999</v></c>',
  '<c><v>1e-400</v></c>',
  '<c><v>0x1F</v></c>',
  '<c><v>12345678901234567890123456789</v></c>',
  '<c s="999999999999"><v>1</v></c>',
  '<c s="-1"><v>1</v></c>',
  '<c t="inlineStr"><is><r><t>a</t></r><rPh><t>b</t></rPh></is></c>',
  '<c t="inlineStr"><is>',
  '<c t="inlineStr"><is/></c>',
  '<v><v><v>',
  '<mergeCell ref="A1:XFD1048576"/>',
  '<mergeCell ref="Z9:A1"/>',
  '<mergeCell ref=":"/>',
  '<mergeCells><mergeCell ref="A1:B9999"/></mergeCells>',
  '<si>',
  '</si>',
  '<si/>',
  '<t xml:space="preserve">  </t>',
  '<sheet name="" r:id="rId999"/>',
  '<sheet name="x" r:id="rId1"/>',
  '<Relationship Id="rId1" Type="x/officeDocument" Target="../../../../etc"/>',
  '<Relationship Id="rId9" Type="x/worksheet" Target="/"/>',
  '<workbookPr date1904="true"/>',
  '<numFmt numFmtId="164" formatCode="[h]:mm:ss;@"/>',
  '<xf numFmtId="999999"/>',
];

function hugeSnippet(rnd: Rand): string {
  const n = 1 + int(rnd, HEAVY ? 2_000_000 : 200_000);
  switch (int(rnd, 6)) {
    case 0:
      return `<c r="A2" s="${'9'.repeat(n)}"><v>1</v></c>`;
    case 1:
      return `<c r="A2" t="${'x'.repeat(n)}"><v>1</v></c>`;
    case 2:
      return '<a>'.repeat(Math.min(n, 100_000));
    case 3:
      return `<c r="A2" t="inlineStr"><is>${'<r><t>x</t></r>'.repeat(Math.min(n, 50_000))}</is></c>`;
    case 4:
      return `<x y="${'"'.repeat(n)}`;
    default:
      return 'é'.repeat(n);
  }
}

function mutateXml(rnd: Rand, xml: string): string {
  let s = xml;
  const ops = 1 + int(rnd, 4);
  for (let k = 0; k < ops; k++) {
    const at = int(rnd, s.length + 1);
    switch (int(rnd, 7)) {
      case 0:
        s = s.slice(0, at) + s.slice(at + 1 + int(rnd, 200));
        break;
      case 1:
      case 2:
        s = s.slice(0, at) + pick(rnd, XML_SNIPPETS) + s.slice(at);
        break;
      case 3:
        s = s.slice(0, at) + hugeSnippet(rnd) + s.slice(at);
        break;
      case 4: {
        const len = int(rnd, 400);
        s = s.slice(0, at) + s.slice(at, at + len).repeat(1 + int(rnd, 20)) + s.slice(at);
        break;
      }
      case 5:
        s = s.slice(0, at) + pick(rnd, ['<', '>', '"', "'", '&', '/', '=', ':']) + s.slice(at + 1);
        break;
      default:
        s = s.slice(0, at); // truncated part
    }
  }
  return s;
}

function rezip(parts: Record<string, Uint8Array>): Uint8Array {
  return zipSync(parts, { level: 6 });
}

const unzipped = fixtures.map((f) => ({ ...f, parts: unzipSync(f.bytes) }));

/** A sheet of numbers whose styles carry `formats` (one per row, columns A–F). */
function formatWorkbook(formats: readonly string[], values: readonly number[]): Uint8Array {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  const numFmts = formats
    .map((f, i) => `<numFmt numFmtId="${164 + i}" formatCode="${esc(f)}"/>`)
    .join('');
  const xfs = formats.map((_, i) => `<xf numFmtId="${164 + i}"/>`).join('');
  const header =
    '<row r="1">' +
    ['A', 'B', 'C', 'D', 'E', 'F']
      .map((h) => `<c r="${h}1" t="inlineStr"><is><t>${h}</t></is></c>`)
      .join('') +
    '</row>';
  const rows = formats
    .map((_, i) => {
      const v = values[i % values.length]!;
      const cells = ['A', 'B', 'C', 'D', 'E', 'F']
        .map((h) => `<c r="${h}${i + 2}" s="${i + 1}"><v>${v}</v></c>`)
        .join('');
      return `<row r="${i + 2}">${cells}</row>`;
    })
    .join('');
  const base = unzipped[0]!.parts;
  const parts: Record<string, Uint8Array> = {
    '[Content_Types].xml': base['[Content_Types].xml']!,
    '_rels/.rels': strToU8(
      '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    ),
    'xl/workbook.xml': strToU8(
      '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>',
    ),
    'xl/_rels/workbook.xml.rels': strToU8(
      '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>',
    ),
    'xl/styles.xml': strToU8(
      `<?xml version="1.0"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts>${numFmts}</numFmts><cellXfs><xf numFmtId="0"/>${xfs}</cellXfs></styleSheet>`,
    ),
    'xl/worksheets/sheet1.xml': strToU8(
      `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${header}${rows}</sheetData></worksheet>`,
    ),
  };
  return rezip(parts);
}

const FORMAT_TOKENS: readonly string[] = [
  '0',
  '#',
  '?',
  '/',
  '.',
  ',',
  'E+',
  'e-',
  'E',
  '%',
  '@',
  '*',
  '_',
  '\\',
  '"',
  '"lit"',
  ' ',
  ';',
  '[h]',
  '[mm]',
  '[ss]',
  '[Red]',
  '[Color99]',
  '[>100]',
  '[<=-5]',
  '[=1]',
  '[$-409]',
  '[$€-x]',
  '[DBNum1]',
  '[ENG]',
  '[',
  ']',
  'yyyy',
  'yy',
  'mmmmm',
  'mmm',
  'mm',
  'm',
  'dddd',
  'dd',
  'd',
  'hh',
  'h',
  'ss',
  's',
  '.000',
  'AM/PM',
  'A/P',
  'b2',
  'e',
  'g',
  'B1',
  'General',
  'gen',
  '0/0',
  '# ??/??',
  '?????????????????/?????????????????',
  '0.0E+00',
  '##0.0E+0',
  '(',
  ')',
  '-',
  '+',
  '$',
  '0'.repeat(120),
  '#'.repeat(300),
  '?'.repeat(300),
];

const NUMBERS: readonly number[] = [
  0, -0, 1, -1, 0.5, 1e-10, 123456789.123, -98765.4321, 2958465, 2958466, 60, 61, -1e5, 1e15, 1e21,
  1e100, 1.79e308, 5e-324, 4294967296.5, -2958465,
];

describe('reader fuzz (T-R1-04 AC h)', () => {
  it('random bytes, with and without ZIP / OLE2 signatures', { timeout: 120_000 }, () => {
    const rnd = prng(0x5eed0001);
    const prefixes = [
      new Uint8Array(0),
      new Uint8Array([0x50, 0x4b, 0x03, 0x04]),
      new Uint8Array([0x50, 0x4b, 0x05, 0x06]),
      new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
    ];
    for (let n = 0; n < N * 4; n++) {
      const len = int(rnd, n % 3 === 0 ? 64 : 20_000);
      const body = new Uint8Array(len);
      for (let i = 0; i < len; i++) body[i] = int(rnd, 256);
      const prefix = prefixes[n % prefixes.length]!;
      check('random', `random #${n}`, concat(prefix, body), slots.bang_luong!, '.xlsx');
    }
  });

  it('truncated fixture archives', { timeout: 120_000 }, () => {
    const rnd = prng(0x5eed0002);
    for (let n = 0; n < N * 2; n++) {
      const f = fixtures[n % fixtures.length]!;
      const cut = int(rnd, f.bytes.length);
      check(
        'truncated',
        `truncated #${n} ${f.name}@${cut}`,
        f.bytes.slice(0, cut),
        slotFor(f.name),
        '.xlsx',
      );
    }
    // Truncated from the front, keeping the end of central directory.
    for (let n = 0; n < N; n++) {
      const f = fixtures[n % fixtures.length]!;
      const cut = int(rnd, f.bytes.length);
      check(
        'truncated',
        `head-cut #${n} ${f.name}@${cut}`,
        f.bytes.slice(cut),
        slotFor(f.name),
        '.xlsx',
      );
    }
  });

  it('byte-mutated fixture archives', { timeout: 120_000 }, () => {
    const rnd = prng(0x5eed0003);
    for (let n = 0; n < N * 4; n++) {
      const f = fixtures[n % fixtures.length]!;
      const b = f.bytes.slice();
      const flips = 1 + int(rnd, 16);
      for (let k = 0; k < flips; k++) b[int(rnd, b.length)] = int(rnd, 256);
      check('byte-mutated', `mutated #${n} ${f.name}`, b, slotFor(f.name), '.xlsx');
    }
  });

  it('mutated size / CRC / offset / count / flag / method fields', { timeout: 120_000 }, () => {
    const rnd = prng(0x5eed0004);
    for (let n = 0; n < N * 4; n++) {
      const f = fixtures[n % fixtures.length]!;
      const b = f.bytes.slice();
      const { eocd, records } = centralRecords(b);
      const rec = pick(rnd, records);
      const local = u32(b, rec + 42);
      const v = rnd() < 0.5 ? pick(rnd, HOSTILE_VALUES) : int(rnd, 0x100000000);
      switch (int(rnd, 12)) {
        case 0:
          put32(b, rec + 16, v); // CRC
          break;
        case 1:
          put32(b, rec + 20, v); // compressed size
          break;
        case 2:
          put32(b, rec + 24, v); // size
          break;
        case 3:
          put32(b, rec + 42, v); // local header offset
          break;
        case 4:
          put16(b, rec + 8, v & 0xffff); // flags (encryption bits)
          break;
        case 5:
          put16(b, rec + 10, v & 0xffff); // method
          break;
        case 6:
          put16(b, rec + 28, v & 0xffff); // name length
          break;
        case 7:
          put16(b, local + 26, v & 0xffff); // local name length
          break;
        case 8:
          put16(b, local + 28, v & 0xffff); // local extra length
          break;
        case 9:
          put16(b, eocd + 10, v & 0xffff); // entry count
          break;
        case 10:
          put32(b, eocd + 12, v); // CD size
          break;
        default:
          put32(b, eocd + 16, v); // CD offset
      }
      check('header-fields', `fields #${n} ${f.name}`, b, slotFor(f.name), '.xlsx');
    }
  });

  it('malformed XML inside valid archives', { timeout: 300_000 }, () => {
    const rnd = prng(0x5eed0005);
    for (let n = 0; n < N * 4; n++) {
      const f = unzipped[n % unzipped.length]!;
      const names = Object.keys(f.parts).filter((p) => p.endsWith('.xml') || p.endsWith('.rels'));
      const sheetBias = names.filter(
        (p) => p.includes('worksheets/') || p.includes('sharedStrings'),
      );
      const target = rnd() < 0.6 ? pick(rnd, sheetBias) : pick(rnd, names);
      const parts = { ...f.parts };
      parts[target] = strToU8(mutateXml(rnd, strFromU8(f.parts[target]!)));
      check(
        'malformed-xml',
        `xml #${n} ${f.name}:${target}`,
        rezip(parts),
        slotFor(f.name),
        '.xlsx',
      );
    }
  });

  it('hostile number formats through SSF.format / SSF.is_date', { timeout: 300_000 }, () => {
    const rnd = prng(0x5eed0006);
    for (let n = 0; n < N; n++) {
      const formats: string[] = [];
      for (let k = 0; k < 20; k++) {
        let s = '';
        const len = 1 + int(rnd, 12);
        for (let j = 0; j < len; j++) s += pick(rnd, FORMAT_TOKENS);
        formats.push(s);
      }
      check('number-format', `fmt #${n}`, formatWorkbook(formats, NUMBERS), anySlot, '.xlsx');
    }
  });

  // Only `.xlsx` is read (owner 1B): OLE2 `.xls` bytes, honest or mutated, are always unreadable and
  // never reach SheetJS (which looped forever on some mutated BIFF streams, verifier T-R1-04).
  it('OLE2 (.xls) bytes renamed .xlsx, honest and mutated', { timeout: 120_000 }, () => {
    const rnd = prng(0x5eed0007);
    const xlsFiles = fixtures.map((f) => {
      const wb = XLSX.read(f.bytes, { type: 'array' });
      return {
        name: f.name,
        bytes: new Uint8Array(XLSX.write(wb, { bookType: 'biff8', type: 'array' }) as ArrayBuffer),
      };
    });
    for (const f of xlsFiles) {
      expect(
        readSlot(slotFor(f.name), [{ name: 'x.xlsx', bytes: f.bytes }]).report.issues.map(
          (i) => i.messageKey,
        ),
      ).toEqual(['validation.fileUnreadable']);
      check('ole2-renamed', `ole2 honest ${f.name}`, f.bytes, slotFor(f.name), '.xlsx');
    }
    for (let n = 0; n < N * 4; n++) {
      const f = xlsFiles[n % xlsFiles.length]!;
      let b = f.bytes.slice();
      switch (int(rnd, 4)) {
        case 0: {
          const flips = 1 + int(rnd, 32);
          for (let k = 0; k < flips; k++) b[int(rnd, b.length)] = int(rnd, 256);
          break;
        }
        case 1:
          b = b.slice(0, 8 + int(rnd, b.length - 8));
          break;
        case 2: {
          // OLE header fields: sector shifts, FAT / directory / mini-FAT starts and counts.
          const at = pick(rnd, [0x1e, 0x20, 0x2c, 0x30, 0x38, 0x3c, 0x40, 0x44, 0x48, 0x4c]);
          put32(b, at, rnd() < 0.5 ? pick(rnd, HOSTILE_VALUES) : int(rnd, 0x100000000));
          break;
        }
        default: {
          // A 512-byte sector overwritten with a repeating hostile value (FAT loops, bad chains).
          const sector = 1 + int(rnd, Math.max(1, Math.floor(b.length / 512) - 1));
          const v = pick(rnd, HOSTILE_VALUES);
          for (let i = sector * 512; i + 4 <= Math.min(b.length, sector * 512 + 512); i += 4) {
            put32(b, i, rnd() < 0.5 ? v : sector);
          }
        }
      }
      check('ole2-renamed', `ole2 #${n} ${f.name}`, b, slotFor(f.name), '.xlsx');
    }
  });

  it('summary of outcomes per category', () => {
    const total = Object.values(tallies).reduce((sum, t) => sum + t.cases, 0);
    expect(total).toBeGreaterThan(0);
    // `HRFLOW_FUZZ_REPORT=<path>` writes the counts (outside the repo, e.g. the OS temp dir).
    const proc = (
      globalThis as unknown as {
        process: {
          env: Record<string, string | undefined>;
          getBuiltinModule(id: 'node:fs'): { writeFileSync(path: string, data: string): void };
        };
      }
    ).process;
    const out = proc.env.HRFLOW_FUZZ_REPORT;
    if (out) proc.getBuiltinModule('node:fs').writeFileSync(out, JSON.stringify(tallies, null, 1));
  });
});

describe('fixed fuzz findings', () => {
  // Verifier T-R1-04: a finite double above 1.79769313486232e308 rounded to Infinity at 15 digits
  // in `decimalFromNumber` and the error escaped `readSlot`. It is now a type error of the cell.
  it('a decimal cell holding Number.MAX_VALUE is a type error, readSlot does not throw', () => {
    const bytes = formatWorkbook(['0.00'], [Number.MAX_VALUE]);
    let result: ReturnType<typeof readSlot> | undefined;
    expect(() => (result = readSlot(anySlot, [{ name: 'max.xlsx', bytes }]))).not.toThrow();
    const keys = result?.report.issues.map((i) => i.messageKey) ?? [];
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.every((k) => k === 'validation.type')).toBe(true);
  });
});
