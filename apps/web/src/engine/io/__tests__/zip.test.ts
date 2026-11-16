import { InputSlotSchema } from '@hrflow/flow-schema';
import { Deflate, deflateSync, strToU8 } from 'fflate';
import { describe, expect, it } from 'vitest';
import { readSlot } from '../validation';
import { openXlsx } from '../xlsx-stream';
import {
  crc32Update,
  FILE_BUDGET_FLOOR_BYTES,
  fileInflateBudget,
  FileReadError,
  MAX_ENTRY_BYTES,
  ZipArchive,
} from '../zip';
import { deflated, HEAVY, rawZip, readFixture, sheetXml, workbookParts } from './helpers';

const MIB = 1024 * 1024;

/**
 * Raw DEFLATE of `prefix` + `mib` MiB of spaces + `suffix`, built in 1 MiB steps (never held
 * inflated); returns the true size and CRC-32 too.
 */
function deflateRepeated(
  mib: number,
  prefix = '',
  suffix = '',
): { data: Uint8Array; crc: number; size: number } {
  const block = new Uint8Array(MIB).fill(0x20);
  const out: Uint8Array[] = [];
  const d = new Deflate({ level: 1 }, (chunk) => out.push(chunk));
  let crc = 0;
  let size = 0;
  const push = (bytes: Uint8Array, final: boolean): void => {
    d.push(bytes, final);
    crc = crc32Update(crc, bytes);
    size += bytes.length;
  };
  push(strToU8(prefix), false);
  for (let i = 0; i < mib; i++) push(block, false);
  push(strToU8(suffix), true);
  const data = new Uint8Array(out.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of out) {
    data.set(c, at);
    at += c.length;
  }
  return { data, crc, size };
}

function errorKey(f: () => unknown): string {
  try {
    f();
  } catch (err) {
    if (err instanceof FileReadError) return err.messageKey;
    throw err;
  }
  return 'no error';
}

/** Reads every entry of `bytes` in order; returns the archive (for its stats) and the error key. */
function readAll(
  bytes: Uint8Array,
  names: readonly string[],
): { zip: ZipArchive | null; key: string } {
  let zip: ZipArchive | null = null;
  const key = errorKey(() => {
    zip = ZipArchive.open(bytes);
    for (const name of names) zip.read(zip.entry(name)!, () => undefined);
  });
  return { zip, key };
}

const BOMB_SLOT = InputSlotSchema.parse({
  key: 'ds',
  label: 'DS',
  sheet: { mode: 'firstMatchingHeaders' },
  columns: [{ key: 'ma_nv', aliases: ['Mã NV'], type: 'string', required: true }],
});

describe('zip limits (AC-B4-90, AC d)', () => {
  it('per-file budget is min(2 GiB, max(64 MiB, 200 × file size))', () => {
    expect(fileInflateBudget(1000)).toBe(FILE_BUDGET_FLOOR_BYTES);
    expect(fileInflateBudget(MIB)).toBe(200 * MIB);
    expect(fileInflateBudget(100 * MIB)).toBe(2048 * MIB);
  });

  it('refuses an entry declared above 2 GiB before inflating anything', () => {
    const entry = deflated('xl/workbook.xml', '<workbook/>', {
      size: MAX_ENTRY_BYTES + 1,
      compressedSize: 20 * MIB,
    });
    expect(errorKey(() => ZipArchive.open(rawZip([entry])))).toBe('validation.fileTooLarge');
  });

  it('refuses an entry above 16 MiB with a ratio above 1:200, before inflating', () => {
    const { data, crc } = deflateRepeated(20);
    const bomb = rawZip([
      { name: 'xl/worksheets/sheet1.xml', data, trueSize: 20 * MIB, trueCrc: crc },
    ]);
    expect(data.length * 200).toBeLessThan(20 * MIB);
    const { zip, key } = readAll(bomb, ['xl/worksheets/sheet1.xml']);
    expect(key).toBe('validation.fileTooLarge');
    expect(zip).toBeNull();
  });

  it('stops an entry that inflates past its declared size, within ~0.5 MiB', () => {
    const { data, crc, size } = deflateRepeated(8);
    const lie = rawZip([{ name: 'a.xml', data, trueSize: size, trueCrc: crc, size: MIB }]);
    const { zip, key } = readAll(lie, ['a.xml']);
    expect(key).toBe('validation.fileTooLarge');
    const stats = (zip as unknown as ZipArchive).stats;
    expect(stats.delivered).toBeLessThanOrEqual(MIB);
    expect(stats.produced).toBeLessThan(MIB + MIB / 2);
  });

  it('stops an entry declared 0 bytes that holds data', () => {
    const entry = deflated('a.xml', 'x'.repeat(5000), { size: 0 });
    const { zip, key } = readAll(rawZip([entry]), ['a.xml']);
    expect(key).toBe('validation.fileTooLarge');
    expect((zip as unknown as ZipArchive).stats.delivered).toBe(0);
  });

  it('stops small entries that add up past the per-file budget, across reads', () => {
    const { data, crc } = deflateRepeated(15);
    const entries = [0, 1, 2, 3, 4].map((i) => ({
      name: `p${i}.xml`,
      data,
      trueSize: 15 * MIB,
      trueCrc: crc,
    }));
    const bytes = rawZip(entries);
    const budget = fileInflateBudget(bytes.length);
    expect(budget).toBe(FILE_BUDGET_FLOOR_BYTES);
    const { zip, key } = readAll(
      bytes,
      entries.map((e) => e.name),
    );
    expect(key).toBe('validation.fileTooLarge');
    const stats = (zip as unknown as ZipArchive).stats;
    expect(stats.produced).toBeLessThanOrEqual(budget);
    expect(stats.produced).toBe(60 * MIB);
    // The same entry read again counts again.
    const again = readAll(rawZip([entries[0]!]), [
      'p0.xml',
      'p0.xml',
      'p0.xml',
      'p0.xml',
      'p0.xml',
    ]);
    expect(again.key).toBe('validation.fileTooLarge');
  });

  it('reports a sheet bomb on the file as validation.fileTooLarge (workbook with 5 × 15 MiB sheets)', () => {
    const sheet = deflateRepeated(
      15,
      sheetXml('<!--').replace('</sheetData></worksheet>', ''),
      '--></sheetData></worksheet>',
    );
    const names: Record<string, string> = {};
    for (let i = 1; i <= 5; i++) names[`S${i}`] = '';
    const parts = workbookParts(names);
    const bytes = rawZip(
      Object.entries(parts).map(([name, text]) =>
        name.startsWith('xl/worksheets/')
          ? { name, data: sheet.data, trueSize: sheet.size, trueCrc: sheet.crc }
          : deflated(name, text),
      ),
    );
    expect(bytes.length).toBeLessThan(500 * 1024);
    const { report } = readSlot(BOMB_SLOT, [{ name: 'bomb.xlsx', bytes }]);
    expect(report.issues).toEqual([
      expect.objectContaining({
        severity: 'error',
        messageKey: 'validation.fileTooLarge',
        params: { file: 'bomb.xlsx' },
        file: 'bomb.xlsx',
      }),
    ]);
  });

  it.runIf(HEAVY)(
    'stops a 1 GiB lie early (heavy)',
    () => {
      const { data, crc, size } = deflateRepeated(1024);
      const lie = rawZip([{ name: 'a.xml', data, trueSize: size, trueCrc: crc, size: 10 * MIB }]);
      const { zip, key } = readAll(lie, ['a.xml']);
      expect(key).toBe('validation.fileTooLarge');
      expect((zip as unknown as ZipArchive).stats.produced).toBeLessThan(11 * MIB);
    },
    120_000,
  );
});

describe('unreadable archives (AC e)', () => {
  it('refuses a bad CRC-32 (deflated and stored)', () => {
    const bad = deflated('a.xml', '<a/>', { crc: 1234 });
    expect(readAll(rawZip([bad]), ['a.xml']).key).toBe('validation.fileUnreadable');
    const text = strToU8('<a/>');
    const stored = { name: 'a.xml', data: text, method: 0, trueSize: text.length, trueCrc: 99 };
    expect(readAll(rawZip([stored]), ['a.xml']).key).toBe('validation.fileUnreadable');
  });

  it('refuses a fixture whose sheet CRC was altered, without a SheetJS fallback', () => {
    const bytes = readFixture('cham_cong_CN01_092026.xlsx').slice();
    const zip = ZipArchive.open(bytes);
    const sheet = zip.entry('xl/worksheets/sheet1.xml')!;
    // Flip the CRC in the central directory record of the sheet.
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let p = 0; p + 46 <= bytes.length; p++) {
      if (
        view.getUint32(p, true) === 0x02014b50 &&
        view.getUint32(p + 42, true) === sheet.localHeader
      ) {
        view.setUint32(p + 16, sheet.crc ^ 1, true);
      }
    }
    const slot = InputSlotSchema.parse({
      key: 'cc',
      label: 'CC',
      columns: [{ key: 'ma_nv', aliases: ['Mã nhân viên'], type: 'string' }],
    });
    const { report } = readSlot(slot, [{ name: 'x.xlsx', bytes }]);
    expect(report.issues.map((i) => i.messageKey)).toEqual(['validation.fileUnreadable']);
    expect(errorKey(() => openXlsx(bytes).readSheet(0))).toBe('validation.fileUnreadable');
  });

  it('refuses ZIP64, encryption, unknown methods, multi-disk, truncation and duplicate names', () => {
    const ok = deflated('a.xml', '<a/>');
    const cases: Uint8Array[] = [
      rawZip([{ ...ok, size: 0xffffffff }]),
      rawZip([{ ...ok, compressedSize: 0xffffffff }]),
      rawZip([{ ...ok, flags: 1 }]),
      rawZip([{ ...ok, flags: 0x40 }]),
      rawZip([{ ...ok, method: 12 }]),
      rawZip([{ ...ok, data: ok.data.subarray(0, 1), compressedSize: 1 }]),
      rawZip([ok, ok]),
      rawZip([{ ...ok, data: deflateSync(strToU8('<a/><b/>')).subarray(0, 3) }]),
    ];
    const multiDisk = rawZip([ok]);
    multiDisk[multiDisk.length - 18] = 1;
    cases.push(multiDisk);
    const eocdCount = rawZip([ok]);
    eocdCount[eocdCount.length - 12] = 0xff;
    eocdCount[eocdCount.length - 11] = 0xff;
    eocdCount[eocdCount.length - 14] = 0xff;
    eocdCount[eocdCount.length - 13] = 0xff;
    cases.push(eocdCount);
    const full = rawZip([ok]);
    cases.push(full.subarray(0, full.length - 30));
    cases.push(new Uint8Array(0), strToU8('PK\x03\x04 not a zip'));
    for (const bytes of cases)
      expect(readAll(bytes, ['a.xml']).key).toBe('validation.fileUnreadable');
  });
});
