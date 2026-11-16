import * as XLSX from 'xlsx';
import { FileReadError, ZipArchive } from './zip';

/**
 * Streaming `.xlsx` reader (spec §10, §13 "File rất lớn"). Only the parts a read needs are
 * inflated, chunk by chunk (`zip.ts`, with the AC-B4-90 limits), and the XML bytes are scanned
 * straight into a compact sparse grid: no sheet XML string, no object per cell. Cell values follow
 * SheetJS read with `dense`, `cellNF`, `cellText: false`, `cellDates: false` (`xls.ts` builds the
 * same grid from SheetJS), so validation sees the same values whichever reader made the grid.
 *
 * Every failure is a `FileReadError` (`validation.fileTooLarge` / `validation.fileUnreadable`).
 */

/** A cell value as the sheet holds it (dates are Excel serial numbers). */
export type RawValue = string | number | boolean | null;

export interface CellRead {
  readonly value: RawValue;
  /** Excel error text (`#N/A`, …); `value` is then `null`. */
  readonly error?: string;
  /** Number format of a numeric cell, absent when `General` or unknown. */
  readonly numFmt?: string;
}

/** One sheet, 0-based rows and columns. */
export interface Grid {
  /** -1 when the sheet has no cell. */
  readonly lastRow: number;
  readonly lastCol: number;
  /** With `followMerges`, a blank cell inside a merged range reads the range's top-left cell. */
  cell(r: number, c: number, followMerges: boolean): CellRead;
  /** No cell of the row holds a value (blank text counts as no value). */
  isRowBlank(r: number): boolean;
}

export interface WorkbookSource {
  readonly sheetNames: readonly string[];
  readonly date1904: boolean;
  /** Throws `FileReadError`. */
  readSheet(index: number): Grid;
}

const unreadable = (): FileReadError => new FileReadError('validation.fileUnreadable');

/** Excel limits: a reference beyond them is not a sheet Excel wrote. */
export const MAX_ROWS = 1_048_576;
export const MAX_COLS = 16_384;

// ---------------------------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------------------------

const ENTITIES: Readonly<Record<string, string>> = {
  '&quot;': '"',
  '&apos;': "'",
  '&gt;': '>',
  '&lt;': '<',
  '&amp;': '&',
};
const ENTITY = /&(?:quot|apos|gt|lt|amp|#x?([\da-fA-F]+));/gi;
const CODE = /_x([\da-fA-F]{4})_/gi;
const CDATA_OPEN = '<![CDATA[';
const CDATA_CLOSE = ']]>';

function unescapePlain(s: string): string {
  if (s.indexOf('&') < 0 && s.indexOf('_x') < 0) return s;
  return s
    .replace(ENTITY, (all: string, code: string | undefined) => {
      const known = ENTITIES[all];
      if (known !== undefined) return known;
      return String.fromCharCode(parseInt(code ?? '', all.indexOf('x') > -1 ? 16 : 10)) || all;
    })
    .replace(CODE, (_all: string, c: string) => String.fromCharCode(parseInt(c, 16)));
}

/**
 * SheetJS `unescapexml(text, xlsx)`: entities (case as SheetJS: an unknown case of a named entity
 * becomes U+0000), `_xHHHH_` escapes, CDATA kept verbatim; `xlsx` also turns CRLF into LF.
 */
export function unescapeXml(text: string, xlsx: boolean): string {
  let out = '';
  let i = 0;
  for (;;) {
    const open = text.indexOf(CDATA_OPEN, i);
    if (open < 0) break;
    const close = text.indexOf(CDATA_CLOSE, open + CDATA_OPEN.length);
    if (close < 0) break;
    out += unescapePlain(text.slice(i, open)) + text.slice(open + CDATA_OPEN.length, close);
    i = close + CDATA_CLOSE.length;
  }
  out += unescapePlain(text.slice(i));
  return xlsx && out.indexOf('\r') >= 0 ? out.replace(/\r\n/g, '\n') : out;
}

const utf8 = new TextDecoder();

function decode(buf: Uint8Array, a: number, b: number): string {
  if (b - a <= 32) {
    let ascii = true;
    for (let i = a; i < b; i++) {
      if (buf[i]! >= 0x80) {
        ascii = false;
        break;
      }
    }
    if (ascii) {
      let out = '';
      for (let i = a; i < b; i++) out += String.fromCharCode(buf[i]!);
      return out;
    }
  }
  return utf8.decode(buf.subarray(a, b));
}

// ---------------------------------------------------------------------------------------------
// XML scanner
// ---------------------------------------------------------------------------------------------

interface XmlHandler {
  /**
   * Attributes are the bytes `[a, b)` between the element name and `>` or `/>`. A self-closing
   * element gets no `close` call.
   */
  open(name: string, buf: Uint8Array, a: number, b: number, selfClosing: boolean): void;
  close(name: string): void;
  /** `cdata`: the bytes of a CDATA section, to keep verbatim. */
  text(buf: Uint8Array, a: number, b: number, cdata: boolean): void;
  /** Called before the scanner reuses its buffer: byte ranges kept from callbacks expire. */
  flush?(): void;
}

const LT = 0x3c;
const GT = 0x3e;
const SLASH = 0x2f;
const BANG = 0x21;
const QMARK = 0x3f;
const DQUOTE = 0x22;
const SQUOTE = 0x27;
const COLON = 0x3a;

const isSpace = (c: number | undefined): boolean =>
  c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d;

function startsAt(buf: Uint8Array, at: number, end: number, text: string): boolean {
  if (at + text.length > end) return false;
  for (let k = 0; k < text.length; k++) if (buf[at + k] !== text.charCodeAt(k)) return false;
  return true;
}

function indexOfText(buf: Uint8Array, from: number, end: number, text: string): number {
  const first = text.charCodeAt(0);
  for (
    let i = buf.indexOf(first, from);
    i >= 0 && i + text.length <= end;
    i = buf.indexOf(first, i + 1)
  ) {
    if (startsAt(buf, i, end, text)) return i;
  }
  return -1;
}

const NAME_CACHE = new Map<number, string>();

/** Local name (prefix dropped) of the element name at bytes `[a, b)`. */
function localName(buf: Uint8Array, a: number, b: number): string {
  for (let i = a; i < b; i++) if (buf[i] === COLON) a = i + 1;
  const len = b - a;
  if (len > 24) return '';
  if (len <= 4) {
    let key = len;
    for (let i = a; i < b; i++) key = key * 256 + buf[i]!;
    let name = NAME_CACHE.get(key);
    if (name === undefined) {
      name = decode(buf, a, b);
      NAME_CACHE.set(key, name);
    }
    return name;
  }
  return decode(buf, a, b);
}

/**
 * Incremental, lenient XML tokenizer. Bytes are appended to one buffer that grows geometrically;
 * a construct that spans chunks is resumed where its search stopped, so a long run without `>` or
 * `<` costs linear time. Malformed input never throws: unknown constructs are skipped.
 */
class XmlScanner {
  private buf = new Uint8Array(64 * 1024);
  private len = 0;
  /** Where the search for the end of the pending construct resumes. */
  private resume = 0;
  private quote = 0;

  constructor(private readonly h: XmlHandler) {}

  feed(chunk: Uint8Array): void {
    if (this.len + chunk.length > this.buf.length) {
      let size = this.buf.length * 2;
      while (size < this.len + chunk.length) size *= 2;
      const next = new Uint8Array(size);
      next.set(this.buf.subarray(0, this.len));
      this.buf = next;
    }
    this.buf.set(chunk, this.len);
    this.len += chunk.length;
    this.scan(false);
  }

  end(): void {
    this.scan(true);
    this.len = 0;
  }

  private scan(final: boolean): void {
    const { buf, h } = this;
    const end = this.len;
    let p = 0;
    while (p < end) {
      if (buf[p] !== LT) {
        const lt = buf.indexOf(LT, Math.max(p, this.resume));
        if (lt < 0 || lt >= end) {
          if (!final) {
            this.resume = end;
            break;
          }
          h.text(buf, p, end, false);
          p = end;
          break;
        }
        h.text(buf, p, lt, false);
        p = lt;
        this.resume = p;
      }
      // `buf[p]` is `<`.
      const next = this.construct(p, end, final);
      if (next < 0) break;
      p = next;
      this.resume = p;
      this.quote = 0;
    }
    h.flush?.();
    if (p > 0) {
      buf.copyWithin(0, p, end);
      this.len = end - p;
      this.resume = Math.max(0, this.resume - p);
    }
    if (final) this.len = 0;
  }

  /** Handles the construct at `p` (a `<`); returns the offset after it, or -1 to wait for bytes. */
  private construct(p: number, end: number, final: boolean): number {
    const { buf, h } = this;
    if (p + 1 >= end) return final ? end : -1;
    const c1 = buf[p + 1];
    if (c1 === BANG) {
      if (p + 9 > end && !final) return -1;
      if (startsAt(buf, p, end, CDATA_OPEN)) {
        const close = indexOfText(buf, Math.max(p + 9, this.resume - 2), end, CDATA_CLOSE);
        if (close < 0) return this.wait(end, final);
        h.text(buf, p + 9, close, true);
        return close + 3;
      }
      if (startsAt(buf, p, end, '<!--')) {
        const close = indexOfText(buf, Math.max(p + 4, this.resume - 2), end, '-->');
        if (close < 0) return this.wait(end, final);
        return close + 3;
      }
    }
    if (c1 === BANG || c1 === QMARK) {
      const gt = buf.indexOf(GT, Math.max(p + 2, this.resume));
      if (gt < 0 || gt >= end) return this.wait(end, final);
      return gt + 1;
    }
    // Element tag: find `>` outside quoted attribute values.
    let j = Math.max(p + 1, this.resume);
    let quote = this.quote;
    for (; j < end; j++) {
      const c = buf[j]!;
      if (quote !== 0) {
        if (c === quote) quote = 0;
      } else if (c === DQUOTE || c === SQUOTE) quote = c;
      else if (c === GT) break;
    }
    if (j >= end) {
      this.quote = quote;
      return this.wait(end, final);
    }
    if (c1 === SLASH) {
      let n = p + 2;
      while (n < j && !isSpace(buf[n])) n++;
      h.close(localName(buf, p + 2, n));
    } else {
      let n = p + 1;
      while (n < j && !isSpace(buf[n]) && buf[n] !== SLASH) n++;
      const self = buf[j - 1] === SLASH;
      const name = localName(buf, p + 1, n);
      h.open(name, buf, n, self ? j - 1 : j, self);
    }
    return j + 1;
  }

  private wait(end: number, final: boolean): number {
    this.resume = end;
    return final ? end : -1;
  }
}

/** Byte ranges of one attribute, filled by `nextAttr`. */
interface AttrRange {
  ns: number;
  ne: number;
  vs: number;
  ve: number;
}

/**
 * Reads the next `name="value"` attribute of `[i, b)` into `out`; returns the offset after it, or
 * -1 when there is none. Always advances, so a loop over it ends.
 */
function nextAttr(buf: Uint8Array, i: number, b: number, out: AttrRange): number {
  while (i < b) {
    while (i < b && isSpace(buf[i])) i++;
    const ns = i;
    while (i < b && buf[i] !== 0x3d && !isSpace(buf[i])) i++;
    const ne = i;
    while (i < b && isSpace(buf[i])) i++;
    if (i >= b || buf[i] !== 0x3d) {
      if (i === ns) i++;
      continue;
    }
    i++;
    while (i < b && isSpace(buf[i])) i++;
    const q = buf[i];
    if (q !== DQUOTE && q !== SQUOTE) continue;
    const vs = i + 1;
    let ve = vs;
    while (ve < b && buf[ve] !== q) ve++;
    i = ve + 1;
    if (ne > ns) {
      out.ns = ns;
      out.ne = ne;
      out.vs = vs;
      out.ve = ve;
      return i;
    }
  }
  return -1;
}

const ATTR: AttrRange = { ns: 0, ne: 0, vs: 0, ve: 0 };

/** Value of the attribute with local name `name` (prefix ignored), unescaped, or undefined. */
function attr(buf: Uint8Array, a: number, b: number, name: string): string | undefined {
  for (let i = nextAttr(buf, a, b, ATTR); i >= 0; i = nextAttr(buf, i, b, ATTR)) {
    const { ns, ne, vs, ve } = ATTR;
    let s = ns;
    for (let k = ns; k < ne; k++) if (buf[k] === COLON) s = k + 1;
    if (ne - s === name.length && startsAt(buf, s, ne, name)) {
      return unescapeXml(decode(buf, vs, ve), false);
    }
  }
  return undefined;
}

function parsexmlbool(v: string | undefined): boolean {
  return v === '1' || v === 'true';
}

/** `A1` → 0-based column and row; -1 for a missing part. */
function decodeRef(buf: Uint8Array, a: number, b: number): { c: number; r: number } {
  let k = a;
  let c = 0;
  let letters = 0;
  for (; k < b; k++) {
    const d = buf[k]! - 64;
    if (d < 1 || d > 26) break;
    c = c * 26 + d;
    if (++letters > 3) return { c: MAX_COLS, r: -1 };
  }
  let r = 0;
  let digits = 0;
  for (; k < b; k++) {
    const d = buf[k]! - 48;
    if (d < 0 || d > 9) break;
    r = r * 10 + d;
    if (++digits > 7) return { c: letters > 0 ? c - 1 : -1, r: MAX_ROWS };
  }
  return { c: letters > 0 ? c - 1 : -1, r: digits > 0 ? r - 1 : -1 };
}

function decodeRefText(ref: string): { c: number; r: number } {
  const bytes = new Uint8Array(ref.length);
  for (let i = 0; i < ref.length; i++) bytes[i] = ref.charCodeAt(i) & 0xff;
  return decodeRef(bytes, 0, bytes.length);
}

// ---------------------------------------------------------------------------------------------
// Grid
// ---------------------------------------------------------------------------------------------

const enum Kind {
  Number = 1,
  Text = 2,
  Shared = 3,
  Bool = 4,
  Error = 5,
}

/** Error texts SheetJS knows (`RBErr`); `#WTF?` is shown as `#ERROR`. */
export const ERROR_TEXTS: readonly string[] = [
  '#NULL!',
  '#DIV/0!',
  '#VALUE!',
  '#REF!',
  '#NAME?',
  '#NUM!',
  '#N/A',
  '#GETTING_DATA',
  '#ERROR',
];
const ERROR_IN_FILE = [...ERROR_TEXTS.slice(0, 8), '#WTF?'];

export interface MergeRange {
  readonly r1: number;
  readonly c1: number;
  readonly r2: number;
  readonly c2: number;
}

function grow<T extends Int32Array | Uint8Array | Uint16Array | Float64Array>(a: T, n: number): T {
  if (n <= a.length) return a;
  const next = new (a.constructor as new (size: number) => T)(Math.max(n, a.length * 2, 1024));
  next.set(a);
  return next;
}

/**
 * Collects cells in any order into parallel typed arrays (about 19 bytes per cell, empty cells
 * cost nothing), then sorts them by row and column; the last write of a cell wins, as in SheetJS.
 */
export class GridBuilder {
  private n = 0;
  private rows = new Int32Array(0);
  private cols = new Int32Array(0);
  private kinds = new Uint8Array(0);
  private nums = new Float64Array(0);
  private fmts = new Uint16Array(0);
  private ordered = true;
  private readonly texts: string[] = [];
  private readonly formats: string[] = [''];
  private readonly formatIds = new Map<string, number>();
  private readonly merges: MergeRange[] = [];

  constructor(private readonly shared: readonly (string | null)[] = []) {}

  private push(r: number, c: number, kind: Kind, num: number, fmt: number): void {
    if (r >= MAX_ROWS || c >= MAX_COLS) throw unreadable();
    // A cell before the first row (no reference, no <row>): SheetJS cannot place it either.
    if (r < 0 || c < 0) return;
    const i = this.n;
    if (i > 0) {
      const pr = this.rows[i - 1]!;
      if (r < pr || (r === pr && c <= this.cols[i - 1]!)) this.ordered = false;
    }
    const n = i + 1;
    this.rows = grow(this.rows, n);
    this.cols = grow(this.cols, n);
    this.kinds = grow(this.kinds, n);
    this.nums = grow(this.nums, n);
    this.fmts = grow(this.fmts, n);
    this.rows[i] = r;
    this.cols[i] = c;
    this.kinds[i] = kind;
    this.nums[i] = num;
    this.fmts[i] = fmt;
    this.n = n;
  }

  private formatId(numFmt: string | undefined): number {
    if (numFmt === undefined || numFmt === 'General') return 0;
    let id = this.formatIds.get(numFmt);
    if (id === undefined) {
      if (this.formats.length >= 0xffff) return 0;
      id = this.formats.length;
      this.formats.push(numFmt);
      this.formatIds.set(numFmt, id);
    }
    return id;
  }

  number(r: number, c: number, value: number, numFmt?: string): void {
    this.push(r, c, Kind.Number, value, this.formatId(numFmt));
  }

  text(r: number, c: number, value: string): void {
    this.texts.push(value);
    this.push(r, c, Kind.Text, this.texts.length - 1, 0);
  }

  /** A shared-string cell; an index outside the table makes the file unreadable (as SheetJS). */
  sharedText(r: number, c: number, index: number): void {
    if (!(index >= 0 && index < this.shared.length)) throw unreadable();
    this.push(r, c, Kind.Shared, index, 0);
  }

  bool(r: number, c: number, value: boolean): void {
    this.push(r, c, Kind.Bool, value ? 1 : 0, 0);
  }

  error(r: number, c: number, text: string): void {
    const code = ERROR_IN_FILE.indexOf(text);
    if (code >= 0) this.push(r, c, Kind.Error, code, 0);
  }

  merge(range: MergeRange): void {
    const { r1, c1, r2, c2 } = range;
    if (r1 < 0 || c1 < 0 || r2 < r1 || c2 < c1 || r2 >= MAX_ROWS || c2 >= MAX_COLS) return;
    this.merges.push(range);
  }

  finish(): Grid {
    let n = this.n;
    let { rows, cols, kinds, nums, fmts } = this;
    if (!this.ordered) {
      const order = new Uint32Array(n);
      for (let i = 0; i < n; i++) order[i] = i;
      order.sort((x, y) => rows[x]! - rows[y]! || cols[x]! - cols[y]! || x - y);
      // Keep the last write of each cell.
      const keep: number[] = [];
      for (let k = 0; k < n; k++) {
        const i = order[k]!;
        const j = order[k + 1];
        if (j !== undefined && rows[j] === rows[i] && cols[j] === cols[i]) continue;
        keep.push(i);
      }
      n = keep.length;
      const pick = <T extends Int32Array | Uint8Array | Uint16Array | Float64Array>(a: T): T => {
        const out = new (a.constructor as new (size: number) => T)(n);
        for (let k = 0; k < n; k++) out[k] = a[keep[k]!]!;
        return out;
      };
      rows = pick(rows);
      cols = pick(cols);
      kinds = pick(kinds);
      nums = pick(nums);
      fmts = pick(fmts);
    }
    return new SparseGrid(
      n,
      rows,
      cols,
      kinds,
      nums,
      fmts,
      this.texts,
      this.shared,
      this.formats,
      this.merges,
    );
  }
}

const NO_CELL: CellRead = { value: null };

class SparseGrid implements Grid {
  readonly lastRow: number;
  readonly lastCol: number;
  /** Cells of row `r` are `[rowStart[r], rowStart[r + 1])`. */
  private readonly rowStart: Int32Array;
  private readonly mergeIndex = new Map<number, { starts: Int32Array; ranges: MergeRange[] }>();

  constructor(
    n: number,
    private readonly rows: Int32Array,
    private readonly cols: Int32Array,
    private readonly kinds: Uint8Array,
    private readonly nums: Float64Array,
    private readonly fmts: Uint16Array,
    private readonly texts: readonly string[],
    private readonly shared: readonly (string | null)[],
    private readonly formats: readonly string[],
    private readonly merges: readonly MergeRange[],
  ) {
    let lastCol = -1;
    for (let i = 0; i < n; i++) if (cols[i]! > lastCol) lastCol = cols[i]!;
    this.lastCol = lastCol;
    this.lastRow = n > 0 ? rows[n - 1]! : -1;
    const rowStart = new Int32Array(this.lastRow + 2);
    let i = 0;
    for (let r = 0; r <= this.lastRow + 1; r++) {
      while (i < n && rows[i]! < r) i++;
      rowStart[r] = i;
    }
    this.rowStart = rowStart;
  }

  private find(r: number, c: number): number {
    if (r < 0 || r > this.lastRow) return -1;
    let lo = this.rowStart[r]!;
    let hi = this.rowStart[r + 1]! - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const mc = this.cols[mid]!;
      if (mc === c) return mid;
      if (mc < c) lo = mid + 1;
      else hi = mid - 1;
    }
    return -1;
  }

  private read(i: number): CellRead {
    if (i < 0) return NO_CELL;
    const num = this.nums[i]!;
    switch (this.kinds[i] as Kind) {
      case Kind.Number: {
        const f = this.fmts[i]!;
        return f === 0 ? { value: num } : { value: num, numFmt: this.formats[f]! };
      }
      case Kind.Text:
        return { value: this.texts[num]! };
      case Kind.Shared:
        return { value: this.shared[num] ?? null };
      case Kind.Bool:
        return { value: num === 1 };
      case Kind.Error:
        return { value: null, error: ERROR_TEXTS[num]! };
    }
  }

  cell(r: number, c: number, followMerges: boolean): CellRead {
    const own = this.read(this.find(r, c));
    if (!followMerges || own.error !== undefined || !isBlankRaw(own.value)) return own;
    const origin = this.mergeOrigin(r, c);
    return origin === null ? own : this.read(this.find(origin.r1, origin.c1));
  }

  isRowBlank(r: number): boolean {
    if (r < 0 || r > this.lastRow) return true;
    for (let i = this.rowStart[r]!; i < this.rowStart[r + 1]!; i++) {
      const kind = this.kinds[i] as Kind;
      if (kind === Kind.Text) {
        if (!isBlankRaw(this.texts[this.nums[i]!]!)) return false;
      } else if (kind === Kind.Shared) {
        if (!isBlankRaw(this.shared[this.nums[i]!] ?? null)) return false;
      } else return false;
    }
    return true;
  }

  /**
   * The merged range holding `(r, c)` as a non-origin cell. Indexed per column on first use, so a
   * huge merged range costs nothing more than a small one.
   */
  private mergeOrigin(r: number, c: number): MergeRange | null {
    if (this.merges.length === 0) return null;
    let index = this.mergeIndex.get(c);
    if (index === undefined) {
      const ranges = this.merges.filter((m) => m.c1 <= c && c <= m.c2).sort((x, y) => x.r1 - y.r1);
      index = { starts: Int32Array.from(ranges, (m) => m.r1), ranges };
      this.mergeIndex.set(c, index);
    }
    let lo = 0;
    let hi = index.starts.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (index.starts[mid]! <= r) {
        found = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    if (found < 0) return null;
    const m = index.ranges[found]!;
    if (r > m.r2 || (r === m.r1 && c === m.c1)) return null;
    return m;
  }
}

/** Blank as SheetJS-based validation sees it: no value, or text of whitespace only. */
export function isBlankRaw(v: RawValue | undefined): boolean {
  return v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
}

// ---------------------------------------------------------------------------------------------
// Rich text (`<si>` of the shared strings, `<is>` of an inline string), SheetJS `parse_si`
// ---------------------------------------------------------------------------------------------

/**
 * SheetJS `parse_si`: when the first child is `<t>`, only that `<t>` counts; otherwise, when there
 * is a run (`<r>`), every `<t>` outside phonetic runs (`<rPh>`) is joined; otherwise no value (an
 * empty item is `""`).
 */
class RichText {
  private sawElement = false;
  private sawText = false;
  private firstIsT = false;
  private hasRun = false;
  private tDepth = 0;
  private tCount = 0;
  private phonetic = 0;
  private first = '';
  private all = '';

  open(name: string, self: boolean): void {
    if (!this.sawElement) {
      this.sawElement = true;
      this.firstIsT = name === 't';
    }
    if (name === 'r') this.hasRun = true;
    else if (name === 'rPh') {
      if (!self) this.phonetic++;
    } else if (name === 't' && !self) {
      this.tDepth++;
      if (this.tDepth === 1) this.tCount++;
    }
  }

  close(name: string): void {
    if (name === 'rPh' && this.phonetic > 0) this.phonetic--;
    else if (name === 't' && this.tDepth > 0) this.tDepth--;
  }

  text(buf: Uint8Array, a: number, b: number, cdata: boolean): void {
    const s = decode(buf, a, b);
    const piece = cdata ? `${CDATA_OPEN}${s}${CDATA_CLOSE}` : s;
    if (!this.sawElement && s.trim() !== '') this.sawText = true;
    if (this.tDepth === 0) return;
    if (this.tCount === 1 && this.phonetic === 0) this.first += piece;
    if (this.phonetic === 0) this.all += piece;
  }

  /** The text, or null for an item SheetJS gives no value. */
  result(): string | null {
    if (this.firstIsT) return unescapeXml(this.first, true);
    if (this.hasRun) return unescapeXml(this.all, true);
    return this.sawElement || this.sawText ? null : '';
  }
}

// ---------------------------------------------------------------------------------------------
// Parts
// ---------------------------------------------------------------------------------------------

class SharedStringsParser implements XmlHandler {
  private readonly strings: (string | null)[] = [];
  private item: RichText | null = null;
  /** SheetJS drops `<si/>` and reads the next item as one that does not start with `<t>`. */
  private afterEmpty = false;
  private sawRoot = false;

  /**
   * The items, plus the one SheetJS reads after the last `</si>` (`""`, or no value after a
   * trailing `<si/>`): a reference one past the end is valid there.
   */
  result(): readonly (string | null)[] {
    if (this.sawRoot) this.strings.push(this.afterEmpty ? null : '');
    return this.strings;
  }

  open(name: string, _buf: Uint8Array, _a: number, _b: number, self: boolean): void {
    if (this.item === null) {
      if (name === 'sst') this.sawRoot = true;
      if (name !== 'si') return;
      if (self) {
        this.afterEmpty = true;
        return;
      }
      this.item = new RichText();
      if (this.afterEmpty) this.item.open('si', true);
      this.afterEmpty = false;
      return;
    }
    this.item.open(name, self);
  }

  close(name: string): void {
    if (this.item === null) return;
    if (name === 'si') {
      this.strings.push(this.item.result());
      this.item = null;
    } else this.item.close(name);
  }

  text(buf: Uint8Array, a: number, b: number, cdata: boolean): void {
    this.item?.text(buf, a, b, cdata);
  }
}

const DATE_RE = /^(\d+)-(\d+)-(\d+)(?:[T ](\d+):(\d+)(?::(\d+))?(?:\.\d+)?)?/;
const MS_PER_DAY = 86_400_000;

/** SheetJS `datenum(parseDate(text))` for an ISO date cell (`t="d"`), as an Excel serial. */
function isoToSerial(text: string, date1904: boolean): number {
  const m = DATE_RE.exec(text);
  const ms = m
    ? Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0))
    : NaN;
  let serial = (ms - Date.UTC(1899, 11, 30)) / MS_PER_DAY;
  if (date1904) {
    serial -= 1462;
    return serial < -1402 ? serial - 1 : serial;
  }
  return serial < 60 ? serial - 1 : serial;
}

const POW10 = Array.from({ length: 23 }, (_, i) => 10 ** i);

/** `parseFloat` of ASCII number text; exact fast path for up to 15 digits (one rounding). */
function parseNumber(buf: Uint8Array, a: number, b: number): number {
  let i = a;
  const neg = buf[i] === 0x2d;
  if (neg) i++;
  let m = 0;
  let digits = 0;
  let frac = -1;
  for (; i < b; i++) {
    const c = buf[i]!;
    if (c === 0x2e && frac < 0) {
      frac = 0;
      continue;
    }
    const d = c - 48;
    if (d < 0 || d > 9 || digits >= 15) return parseFloat(decode(buf, a, b));
    m = m * 10 + d;
    digits++;
    if (frac >= 0) frac++;
  }
  if (digits === 0 || frac > 22) return parseFloat(decode(buf, a, b));
  const x = frac > 0 ? m / POW10[frac]! : m;
  return neg ? -x : x;
}

class SheetParser implements XmlHandler {
  readonly grid: GridBuilder;
  private inData = false;
  private row = -1;
  private col = -1;
  // Current cell
  private inCell = false;
  private cellR = 0;
  private cellC = 0;
  private cellT: string | undefined;
  private cellS = -1;
  private vState = 0; // 0 none yet, 1 inside the first <v>, 2 done
  private v = '';
  private vBytes: { buf: Uint8Array; a: number; b: number } | null = null;
  private vPieces = 0;
  private inline: RichText | null = null;
  private inlineDepth = 0;
  private hasInline = false;

  constructor(
    shared: readonly (string | null)[],
    private readonly styles: readonly (string | undefined)[],
    private readonly date1904: boolean,
  ) {
    this.grid = new GridBuilder(shared);
  }

  open(name: string, buf: Uint8Array, a: number, b: number, self: boolean): void {
    // A cell left open (malformed XML) ends where the next cell or row starts, as SheetJS splits.
    if (this.inCell && (name === 'c' || name === 'row')) this.endCell();
    if (this.inCell) {
      if (this.inline !== null) {
        if (!self) this.inlineDepth++;
        this.inline.open(name, self);
      } else if (name === 'v' && this.vState === 0) {
        this.vState = self ? 2 : 1;
      } else if (name === 'is' && !this.hasInline) {
        this.hasInline = true;
        if (!self) {
          this.inline = new RichText();
          this.inlineDepth = 0;
        } else this.inlineText = '';
      }
      return;
    }
    if (name === 'sheetData') {
      this.inData = !self;
    } else if (!this.inData) {
      if (name === 'mergeCell') this.mergeCell(buf, a, b);
    } else if (name === 'row') {
      // SheetJS ignores a self-closing row (it does not move the row counter either).
      if (self) return;
      const r = attr(buf, a, b, 'r');
      const n = r === undefined ? NaN : parseInt(r, 10);
      this.row = Number.isFinite(n) ? n - 1 : this.row + 1;
      this.col = -1;
    } else if (name === 'c') {
      this.startCell(buf, a, b);
      if (self) this.endCell();
    }
  }

  close(name: string): void {
    if (this.inCell) {
      if (this.inline !== null) {
        if (this.inlineDepth <= 0 && (name === 'is' || name === 'c')) {
          this.inlineText = this.inline.result();
          this.inline = null;
          if (name === 'c') this.endCell();
        } else {
          this.inlineDepth--;
          this.inline.close(name);
        }
      } else if (name === 'v' && this.vState === 1) this.vState = 2;
      else if (name === 'c') this.endCell();
      return;
    }
    if (name === 'sheetData') this.inData = false;
  }

  text(buf: Uint8Array, a: number, b: number, cdata: boolean): void {
    if (!this.inCell) return;
    if (this.inline !== null) {
      this.inline.text(buf, a, b, cdata);
      return;
    }
    if (this.vState !== 1) return;
    // Usually the value is one piece: keep its bytes (numbers are parsed without a string).
    if (this.vPieces === 0 && !cdata) this.vBytes = { buf, a, b };
    else {
      this.flushBytes();
      const s = decode(buf, a, b);
      this.v += cdata ? `${CDATA_OPEN}${s}${CDATA_CLOSE}` : s;
    }
    this.vPieces++;
  }

  private inlineText: string | null = null;

  flush(): void {
    this.flushBytes();
  }

  private flushBytes(): void {
    if (this.vBytes !== null) {
      this.v += decode(this.vBytes.buf, this.vBytes.a, this.vBytes.b);
      this.vBytes = null;
    }
  }

  private startCell(buf: Uint8Array, a: number, b: number): void {
    let ref: { c: number; r: number } | null = null;
    let t: string | undefined;
    let s = -1;
    for (let i = nextAttr(buf, a, b, ATTR); i >= 0; i = nextAttr(buf, i, b, ATTR)) {
      const { ns, ne, vs, ve } = ATTR;
      if (ne - ns !== 1) continue;
      const n = buf[ns];
      if (n === 0x72 && ref === null) ref = decodeRef(buf, vs, ve);
      else if (n === 0x74 && t === undefined) t = decode(buf, vs, ve);
      else if (n === 0x73 && s < 0) {
        let x = 0;
        let any = false;
        for (let k = vs; k < ve && k < vs + 9; k++) {
          const d = buf[k]! - 48;
          if (d < 0 || d > 9) break;
          x = x * 10 + d;
          any = true;
        }
        s = any ? x : -1;
      }
    }
    const found = ref as { c: number; r: number } | null;
    let r = this.row;
    let c: number;
    if (found !== null && found.c >= 0) {
      c = found.c;
      if (found.r >= 0) r = found.r;
    } else c = this.col + 1;
    this.col = c;
    this.inCell = true;
    this.cellR = r;
    this.cellC = c;
    this.cellT = t;
    this.cellS = s;
    this.vState = 0;
    this.v = '';
    this.vBytes = null;
    this.vPieces = 0;
    this.inline = null;
    this.inlineText = null;
    this.hasInline = false;
  }

  /** `<v>` text unescaped once (SheetJS `p.v`), or undefined when absent or empty. */
  private vText(): string | undefined {
    this.flushBytes();
    return this.v === '' ? undefined : unescapeXml(this.v, false);
  }

  private numFmt(): string | undefined {
    return this.cellS >= 0 ? this.styles[this.cellS] : 'General';
  }

  private endCell(): void {
    this.inCell = false;
    this.inline = null;
    const { cellR: r, cellC: c, grid } = this;
    const t = this.cellT ?? 'n';
    if (t === 'n' && this.vBytes !== null && this.vPieces === 1) {
      const { buf, a, b } = this.vBytes;
      this.vBytes = null;
      let plain = b > a;
      for (let k = a; k < b && plain; k++) if (buf[k] === 0x26) plain = false;
      if (plain) {
        grid.number(r, c, parseNumber(buf, a, b), this.numFmt());
        return;
      }
      this.v = decode(buf, a, b);
    }
    const v = this.vText();
    switch (t) {
      case 'n':
        if (v !== undefined) grid.number(r, c, parseFloat(v), this.numFmt());
        return;
      case 's':
        if (v !== undefined) grid.sharedText(r, c, parseInt(v, 10));
        return;
      case 'str':
        grid.text(r, c, v === undefined ? '' : unescapeXml(v, true));
        return;
      case 'inlineStr': {
        const text = this.hasInline ? (this.inlineText ?? null) : '';
        if (text !== null) grid.text(r, c, text);
        return;
      }
      case 'b':
        grid.bool(r, c, parsexmlbool(v));
        return;
      case 'e':
        if (v !== undefined) grid.error(r, c, v);
        return;
      case 'd':
        if (v !== undefined) grid.number(r, c, isoToSerial(v, this.date1904), this.numFmt());
        return;
      default:
        if (v !== undefined) grid.text(r, c, v);
    }
  }

  private mergeCell(buf: Uint8Array, a: number, b: number): void {
    const ref = attr(buf, a, b, 'ref');
    if (ref === undefined) return;
    const [from, to] = ref.split(':');
    const s = decodeRefText(from ?? '');
    const e = decodeRefText(to ?? from ?? '');
    this.grid.merge({ r1: s.r, c1: s.c, r2: e.r, c2: e.c });
  }
}

interface Relationship {
  readonly type: string;
  readonly target: string;
}

function relationshipsHandler(out: Map<string, Relationship>): XmlHandler {
  return {
    open(name, buf, a, b) {
      if (name !== 'Relationship') return;
      const id = attr(buf, a, b, 'Id');
      if (id !== undefined && !out.has(id)) {
        out.set(id, {
          type: attr(buf, a, b, 'Type') ?? '',
          target: attr(buf, a, b, 'Target') ?? '',
        });
      }
    },
    close() {},
    text() {},
  };
}

/** Path of `target` relative to the folder of `base` (both package paths, no leading `/`). */
function resolvePath(base: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1);
  const parts = base.split('/').slice(0, -1);
  for (const seg of target.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg !== '.' && seg !== '') parts.push(seg);
  }
  return parts.join('/');
}

function relsPathOf(part: string): string {
  const i = part.lastIndexOf('/');
  return `${part.slice(0, i + 1)}_rels/${part.slice(i + 1)}.rels`;
}

/** Built-in number formats as SheetJS knows them before reading any file. */
const BUILTIN_FORMATS: Readonly<Record<number, string>> = {
  ...(XLSX.SSF as { get_table(): Record<number, string> }).get_table(),
};

/** Cell style index → number format (SheetJS `cell.z` with `cellNF`). */
function stylesHandler(formats: (string | undefined)[]): XmlHandler {
  const custom = new Map<number, string>();
  const xfIds: number[] = [];
  let inCellXfs = false;
  return {
    open(name, buf, a, b, self) {
      if (name === 'numFmt') {
        const id = parseInt(attr(buf, a, b, 'numFmtId') ?? '', 10);
        if (Number.isFinite(id)) custom.set(id, attr(buf, a, b, 'formatCode') ?? '');
      } else if (name === 'cellXfs') {
        inCellXfs = !self;
      } else if (name === 'xf' && inCellXfs) {
        const id = attr(buf, a, b, 'numFmtId');
        xfIds.push(id === undefined ? 0 : parseInt(id, 10));
      }
    },
    close(name) {
      if (name === 'cellXfs') {
        inCellXfs = false;
        for (const id of xfIds)
          formats.push(Number.isFinite(id) ? (custom.get(id) ?? BUILTIN_FORMATS[id]) : undefined);
      }
    },
    text() {},
  };
}

/**
 * Opens an `.xlsx` package. Throws `FileReadError`: `fileTooLarge` past a limit, `fileUnreadable`
 * for anything else (no workbook part, binary `.xlsb`, ZIP64, encryption, corrupt data).
 */
export function openXlsx(bytes: Uint8Array): WorkbookSource {
  const zip = ZipArchive.open(bytes);
  const readPart = (path: string, h: XmlHandler): boolean => {
    const entry = zip.entry(path);
    if (entry === undefined) return false;
    const scanner = new XmlScanner(h);
    zip.read(entry, (chunk) => scanner.feed(chunk));
    scanner.end();
    return true;
  };

  const rootRels = new Map<string, Relationship>();
  readPart('_rels/.rels', relationshipsHandler(rootRels));
  let workbookPath = 'xl/workbook.xml';
  for (const rel of rootRels.values()) {
    if (rel.type.endsWith('/officeDocument')) workbookPath = resolvePath('', rel.target);
  }
  if (!workbookPath.toLowerCase().endsWith('.xml')) throw unreadable();

  const sheets: { name: string; rid: string }[] = [];
  let date1904 = false;
  const found = readPart(workbookPath, {
    open(name, buf, a, b) {
      if (name === 'sheet') {
        sheets.push({ name: attr(buf, a, b, 'name') ?? '', rid: attr(buf, a, b, 'id') ?? '' });
      } else if (name === 'workbookPr') {
        date1904 = parsexmlbool(attr(buf, a, b, 'date1904'));
      }
    },
    close() {},
    text() {},
  });
  if (!found) throw unreadable();

  const wbRels = new Map<string, Relationship>();
  readPart(relsPathOf(workbookPath), relationshipsHandler(wbRels));
  let sharedPath: string | null = null;
  let stylesPath: string | null = null;
  for (const rel of wbRels.values()) {
    if (rel.type.endsWith('/sharedStrings')) sharedPath = resolvePath(workbookPath, rel.target);
    else if (rel.type.endsWith('/styles')) stylesPath = resolvePath(workbookPath, rel.target);
  }
  sharedPath ??= 'xl/sharedStrings.xml';
  stylesPath ??= 'xl/styles.xml';
  const styles: (string | undefined)[] = [];
  readPart(stylesPath, stylesHandler(styles));

  const sheetPaths = sheets.map((s, i) => {
    const rel = wbRels.get(s.rid);
    return rel ? resolvePath(workbookPath, rel.target) : `xl/worksheets/sheet${i + 1}.xml`;
  });

  let shared: readonly (string | null)[] | null = null;
  const sharedStrings = (): readonly (string | null)[] => {
    if (shared === null) {
      const parser = new SharedStringsParser();
      readPart(sharedPath, parser);
      shared = parser.result();
    }
    return shared;
  };

  return {
    sheetNames: sheets.map((s) => s.name),
    date1904,
    readSheet(index) {
      const path = sheetPaths[index];
      if (path === undefined) throw unreadable();
      const parser = new SheetParser(sharedStrings(), styles, date1904);
      readPart(path, parser);
      return parser.grid.finish();
    },
  };
}
