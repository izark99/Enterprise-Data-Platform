import { Inflate } from 'fflate';

/**
 * ZIP reader for `.xlsx` packages (spec §13 "File rất lớn", AC-B4-90). Entries are inflated in
 * small steps (`fflate` `Inflate`) and handed to the caller chunk by chunk, so a sheet is never held
 * inflated in memory, and the inflate stops as soon as a limit is passed:
 *
 * - an entry inflates to at most 2 GiB, and an entry above 16 MiB to at most 200 × its compressed
 *   size (checked on the declared size of every entry when the archive opens, then on the bytes
 *   actually produced);
 * - an entry never produces more than its declared size (declared 0 with data included);
 * - all reads of one file together stay within min(2 GiB, max(64 MiB, 200 × file size)).
 *
 * A limit → `validation.fileTooLarge`. A bad CRC-32, a truncated or corrupt stream, ZIP64, an
 * encrypted entry, a multi-disk archive or any other structure this reader does not understand →
 * `validation.fileUnreadable`. There is no fallback to another reader (SheetJS inflates without a
 * limit).
 */

export type FileReadErrorKey = 'validation.fileTooLarge' | 'validation.fileUnreadable';

/** A file that cannot be read. The message is the key only: no file content. */
export class FileReadError extends Error {
  constructor(readonly messageKey: FileReadErrorKey) {
    super(messageKey);
    this.name = 'FileReadError';
  }
}

const tooLarge = (): FileReadError => new FileReadError('validation.fileTooLarge');
const unreadable = (): FileReadError => new FileReadError('validation.fileUnreadable');

const MIB = 1024 * 1024;
export const MAX_ENTRY_BYTES = 2048 * MIB;
export const RATIO_FLOOR_BYTES = 16 * MIB;
export const MAX_RATIO = 200;
export const MAX_FILE_INFLATE_BYTES = 2048 * MIB;
export const FILE_BUDGET_FLOOR_BYTES = 64 * MIB;

/** Inflated bytes one file may produce over all its reads (AC-B4-90). */
export function fileInflateBudget(fileBytes: number): number {
  return Math.min(MAX_FILE_INFLATE_BYTES, Math.max(FILE_BUDGET_FLOOR_BYTES, MAX_RATIO * fileBytes));
}

/** Largest size an entry may inflate to. */
function entryLimit(compressedSize: number): number {
  return Math.min(MAX_ENTRY_BYTES, Math.max(RATIO_FLOOR_BYTES, MAX_RATIO * compressedSize));
}

export interface ZipEntry {
  readonly name: string;
  readonly method: number;
  readonly flags: number;
  readonly crc: number;
  readonly compressedSize: number;
  readonly size: number;
  readonly localHeader: number;
}

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;
const EOCD_SIZE = 22;
const CENTRAL_SIZE = 46;
const LOCAL_SIZE = 30;
const FLAG_ENCRYPTED = 0x0001;
const FLAG_STRONG_ENCRYPTION = 0x0040;
const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;

function u16(b: Uint8Array, i: number): number {
  return (b[i] ?? 0) | ((b[i + 1] ?? 0) << 8);
}

function u32(b: Uint8Array, i: number): number {
  return (
    ((b[i] ?? 0) | ((b[i + 1] ?? 0) << 8) | ((b[i + 2] ?? 0) << 16) | ((b[i + 3] ?? 0) << 24)) >>> 0
  );
}

let crcTable: Int32Array | null = null;

function table(): Int32Array {
  if (crcTable) return crcTable;
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  crcTable = t;
  return t;
}

/** Running CRC-32 (ZIP): start with `crc32Update(0, …)`. */
export function crc32Update(crc: number, buf: Uint8Array): number {
  const t = table();
  let c = ~crc;
  for (let i = 0; i < buf.length; i++) c = t[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return ~c >>> 0;
}

/** Bytes produced by one read, for tests of the early stop. */
export interface InflateStats {
  /** Bytes the inflater produced, the chunk that passed a limit included. */
  produced: number;
  /** Bytes handed to the caller (never beyond a limit). */
  delivered: number;
}

/**
 * Compressed bytes pushed per step. Near a limit the step shrinks so that one step (at most ~1032
 * output bytes per input byte, plus fflate's carried input) cannot overshoot by more than ~0.5 MiB.
 */
const MAX_STEP = 16 * 1024;
const MIN_STEP = 64;
const MAX_DEFLATE_RATIO = 1100;

export class ZipArchive {
  private remaining: number;
  /** Totals over every read of this file. */
  readonly stats: InflateStats = { produced: 0, delivered: 0 };

  private constructor(
    private readonly bytes: Uint8Array,
    private readonly entries: ReadonlyMap<string, ZipEntry>,
  ) {
    this.remaining = fileInflateBudget(bytes.length);
  }

  /** Throws `FileReadError`. */
  static open(bytes: Uint8Array): ZipArchive {
    return new ZipArchive(bytes, readDirectory(bytes));
  }

  /** Case-insensitive lookup; a leading `/` is ignored. */
  entry(path: string): ZipEntry | undefined {
    return this.entries.get(normalisePath(path));
  }

  /**
   * Streams the inflated bytes of `entry` to `onChunk` (each chunk valid only during the call).
   * Throws `FileReadError`; an error thrown by `onChunk` stops the read and propagates.
   */
  read(entry: ZipEntry, onChunk: (chunk: Uint8Array) => void): void {
    if (entry.flags & (FLAG_ENCRYPTED | FLAG_STRONG_ENCRYPTION)) throw unreadable();
    const data = this.entryData(entry);
    if (entry.size > this.remaining) throw tooLarge();
    const limit = Math.min(entry.size, this.remaining);
    let crc = 0;
    let delivered = 0;
    const deliver = (chunk: Uint8Array): void => {
      if (chunk.length === 0) return;
      this.stats.produced += chunk.length;
      // More than declared (declared 0 with data included) or past the file budget: too large.
      if (delivered + chunk.length > limit) throw tooLarge();
      delivered += chunk.length;
      this.stats.delivered += chunk.length;
      crc = crc32Update(crc, chunk);
      onChunk(chunk);
    };
    if (entry.method === METHOD_STORED) {
      if (entry.compressedSize !== entry.size) throw unreadable();
      for (let i = 0; i < data.length; i += MAX_STEP) deliver(data.subarray(i, i + MAX_STEP));
    } else if (entry.method === METHOD_DEFLATE) {
      inflate(data, limit, deliver);
    } else {
      throw unreadable();
    }
    this.remaining -= delivered;
    if (delivered !== entry.size) throw unreadable();
    if (crc !== entry.crc) throw unreadable();
  }

  private entryData(entry: ZipEntry): Uint8Array {
    const h = entry.localHeader;
    if (h + LOCAL_SIZE > this.bytes.length || u32(this.bytes, h) !== SIG_LOCAL) throw unreadable();
    if (u16(this.bytes, h + 6) & (FLAG_ENCRYPTED | FLAG_STRONG_ENCRYPTION)) throw unreadable();
    const start = h + LOCAL_SIZE + u16(this.bytes, h + 26) + u16(this.bytes, h + 28);
    const end = start + entry.compressedSize;
    if (end > this.bytes.length) throw unreadable();
    return this.bytes.subarray(start, end);
  }
}

/** Raw DEFLATE, pushed in small steps; `deliver` throws to stop. */
function inflate(data: Uint8Array, limit: number, deliver: (chunk: Uint8Array) => void): void {
  let delivered = 0;
  let stop: Error | null = null;
  const inflater = new Inflate((chunk) => {
    if (stop !== null) return;
    try {
      delivered += chunk.length;
      deliver(chunk);
    } catch (err) {
      stop = err instanceof Error ? err : unreadable();
      // Abort the inflate: fflate does not catch, so this unwinds `push`.
      throw stop;
    }
  });
  let i = 0;
  do {
    const room = Math.max(0, limit - delivered);
    const step = Math.max(MIN_STEP, Math.min(MAX_STEP, Math.floor(room / MAX_DEFLATE_RATIO)));
    const end = Math.min(data.length, i + step);
    try {
      inflater.push(data.subarray(i, end), end >= data.length);
    } catch {
      if (stop !== null) throw stop;
      // fflate: corrupt or truncated stream.
      throw unreadable();
    }
    i = end;
  } while (i < data.length);
}

function normalisePath(path: string): string {
  return path.replace(/^\/+/, '').toLowerCase();
}

/** Central directory → entries by lower-case name. Throws `FileReadError`. */
function readDirectory(bytes: Uint8Array): Map<string, ZipEntry> {
  const eocd = findEocd(bytes);
  if (eocd < 0) throw unreadable();
  if (eocd >= 20 && u32(bytes, eocd - 20) === SIG_ZIP64_LOCATOR) throw unreadable();
  const disk = u16(bytes, eocd + 4);
  const cdDisk = u16(bytes, eocd + 6);
  const onDisk = u16(bytes, eocd + 8);
  const count = u16(bytes, eocd + 10);
  const cdSize = u32(bytes, eocd + 12);
  const cdOffset = u32(bytes, eocd + 16);
  if (disk !== 0 || cdDisk !== 0 || onDisk !== count) throw unreadable();
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw unreadable();
  if (cdOffset + cdSize > eocd) throw unreadable();
  const latin1 = new TextDecoder('latin1');
  const entries = new Map<string, ZipEntry>();
  let p = cdOffset;
  const cdEnd = cdOffset + cdSize;
  for (let k = 0; k < count; k++) {
    if (p + CENTRAL_SIZE > cdEnd || u32(bytes, p) !== SIG_CENTRAL) throw unreadable();
    const flags = u16(bytes, p + 8);
    const method = u16(bytes, p + 10);
    const crc = u32(bytes, p + 16);
    const compressedSize = u32(bytes, p + 20);
    const size = u32(bytes, p + 24);
    const nameLen = u16(bytes, p + 28);
    const extraLen = u16(bytes, p + 30);
    const commentLen = u16(bytes, p + 32);
    const startDisk = u16(bytes, p + 34);
    const localHeader = u32(bytes, p + 42);
    const next = p + CENTRAL_SIZE + nameLen + extraLen + commentLen;
    if (next > cdEnd) throw unreadable();
    if (compressedSize === 0xffffffff || size === 0xffffffff || localHeader === 0xffffffff) {
      throw unreadable(); // ZIP64
    }
    if (startDisk !== 0 || localHeader + LOCAL_SIZE > cdOffset) throw unreadable();
    const name = normalisePath(
      latin1.decode(bytes.subarray(p + CENTRAL_SIZE, p + CENTRAL_SIZE + nameLen)),
    );
    if (entries.has(name)) throw unreadable();
    // Declared sizes past the limits are refused before anything is inflated.
    if (method !== METHOD_STORED && size > entryLimit(compressedSize)) throw tooLarge();
    if (size > MAX_ENTRY_BYTES) throw tooLarge();
    entries.set(name, { name, method, flags, crc, compressedSize, size, localHeader });
    p = next;
  }
  return entries;
}

/** Offset of the end-of-central-directory record, or -1. */
function findEocd(bytes: Uint8Array): number {
  const last = bytes.length - EOCD_SIZE;
  const first = Math.max(0, last - 0xffff);
  for (let i = last; i >= first; i--) {
    if (bytes[i] === 0x50 && u32(bytes, i) === SIG_EOCD) {
      if (i + EOCD_SIZE + u16(bytes, i + 20) <= bytes.length) return i;
    }
  }
  return -1;
}
