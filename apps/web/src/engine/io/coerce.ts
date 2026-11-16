import type { DataType } from '@hrflow/flow-schema';
import * as XLSX from 'xlsx';
import { Big, decimalFromNumber, isDecimal } from '../core/decimal';
import type { Value } from '../core/types';
import { normalizeHeader } from './headers';
import { isBlankRaw, type CellRead, type RawValue } from './xlsx-stream';

/**
 * Cell → typed value of a slot column (spec §9.4, §10; 03 §4.5). A `string` column takes the text
 * Excel displays (keeps `00123`, dates in their display format); a `date` column always accepts a
 * real Excel date cell; a number typed as text that reads two ways (`"1,500"`) is flagged.
 */

export type CoerceResult =
  | { readonly ok: true; readonly value: Value; readonly ambiguous?: boolean }
  | { readonly ok: false };

export interface CoerceOptions {
  readonly dateFormats?: readonly string[] | undefined;
  readonly decimalSeparator?: '.' | ',';
  /** The workbook uses the 1904 date system. */
  readonly date1904?: boolean;
}

/** Formats of a `date` / `datetime` column that declares none (learned from 6fd5868). */
export const DEFAULT_DATE_FORMATS: readonly string[] = ['dd/MM/yyyy', 'yyyy-MM-dd', 'excelSerial'];

/** Words of a `boolean` column, compared after `normalizeHeader` (learned from 6fd5868). */
const TRUE_WORDS = new Set(['true', '1', 'yes', 'y', 'x', 'co', 'dung']);
const FALSE_WORDS = new Set(['false', '0', 'no', 'n', 'khong', 'sai']);

const ok = (value: Value, ambiguous = false): CoerceResult =>
  ambiguous ? { ok: true, value, ambiguous } : { ok: true, value };
const FAIL: CoerceResult = { ok: false };

const SSF = XLSX.SSF as {
  format(fmt: string, value: number, opts?: { date1904?: boolean }): string;
  is_date(fmt: string): boolean;
};

/**
 * Excel's locale short date (built-in format 14, which SheetJS names `m/d/yy`) is shown as
 * `dd/mm/yyyy`, the convention of the company's files (learned from 6fd5868).
 */
const LOCALE_SHORT_DATE = 'm/d/yy';
const SHORT_DATE_SHOWN = 'dd/mm/yyyy';

/** A numeric cell whose number format is a date format. */
export function isDateCell(cell: CellRead): boolean {
  if (typeof cell.value !== 'number' || cell.numFmt === undefined) return false;
  try {
    return SSF.is_date(cell.numFmt);
  } catch {
    return false;
  }
}

/** The text Excel displays for a numeric cell with a number format; otherwise the raw value. */
export function displayRaw(cell: CellRead, date1904: boolean): RawValue {
  if (typeof cell.value !== 'number' || cell.numFmt === undefined) return cell.value;
  const fmt = cell.numFmt === LOCALE_SHORT_DATE ? SHORT_DATE_SHOWN : cell.numFmt;
  try {
    return SSF.format(fmt, cell.value, { date1904 });
  } catch {
    return cell.value;
  }
}

/** Coerces a non-error cell to `type`; a blank cell is `null` (the caller applies defaults). */
export function coerceCell(cell: CellRead, type: DataType, opts: CoerceOptions = {}): CoerceResult {
  if (type === 'string') return coerceValue(displayRaw(cell, opts.date1904 ?? false), type, opts);
  if ((type === 'date' || type === 'datetime') && isDateCell(cell)) {
    // A real Excel date cell, whatever the configured text formats (MEMORY 2026-10-26 08:59).
    return coerceValue(cell.value, type, { ...opts, dateFormats: ['excelSerial'] });
  }
  return coerceValue(cell.value, type, opts);
}

export function coerceValue(raw: RawValue, type: DataType, opts: CoerceOptions = {}): CoerceResult {
  if (isBlankRaw(raw) || raw === null) return ok(null);
  const sep = opts.decimalSeparator ?? '.';
  switch (type) {
    case 'string':
      if (typeof raw === 'number') return ok(numberText(raw));
      if (typeof raw === 'boolean') return ok(raw ? 'TRUE' : 'FALSE');
      return ok(raw.trim());
    case 'decimal': {
      if (typeof raw === 'number') return Number.isFinite(raw) ? ok(decimalFromNumber(raw)) : FAIL;
      if (typeof raw !== 'string') return FAIL;
      const text = normalizeNumberText(raw, sep);
      if (text === null) return FAIL;
      return ok(new Big(text), isAmbiguousNumberText(raw));
    }
    case 'integer': {
      if (typeof raw === 'number') {
        if (!Number.isFinite(raw)) return FAIL;
        const n = Number(raw.toPrecision(15));
        return Number.isSafeInteger(n) ? ok(n === 0 ? 0 : n) : FAIL;
      }
      if (typeof raw !== 'string') return FAIL;
      const text = normalizeNumberText(raw, sep);
      if (text === null) return FAIL;
      const n = Number(text);
      return Number.isSafeInteger(n) ? ok(n === 0 ? 0 : n, isAmbiguousNumberText(raw)) : FAIL;
    }
    case 'boolean': {
      if (typeof raw === 'boolean') return ok(raw);
      if (typeof raw === 'number') return raw === 1 ? ok(true) : raw === 0 ? ok(false) : FAIL;
      const word = normalizeHeader(raw);
      if (TRUE_WORDS.has(word)) return ok(true);
      if (FALSE_WORDS.has(word)) return ok(false);
      return FAIL;
    }
    case 'date':
    case 'datetime': {
      const parts = parseDateValue(raw, opts.dateFormats ?? DEFAULT_DATE_FORMATS, opts.date1904);
      if (parts === null) return FAIL;
      return ok(type === 'date' ? formatDate(parts) : formatDateTime(parts));
    }
  }
}

/** A General-format number as Excel shows it: 15 significant digits. */
function numberText(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  const x = Number(n.toPrecision(15));
  return (x === 0 ? 0 : x).toString();
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const NUMBER_SPACES = /[\s\u00a0]/g;

/**
 * A number typed as text → plain `"-123.45"`, or null. With decimal separator `.` the thousands
 * separator is `,` (and the reverse); thousands groups must have 3 digits, so `"1,5"` is not a
 * number with `.`.
 */
export function normalizeNumberText(text: string, decimalSeparator: '.' | ','): string | null {
  const s = text.replace(NUMBER_SPACES, '');
  if (s.length > 400) return null;
  const thousands = decimalSeparator === '.' ? ',' : '.';
  const d = escapeRegex(decimalSeparator);
  const th = escapeRegex(thousands);
  const plain = new RegExp(`^[+-]?(\\d+(${d}\\d*)?|${d}\\d+)([eE][+-]?\\d+)?$`);
  const grouped = new RegExp(`^[+-]?\\d{1,3}(${th}\\d{3})+(${d}\\d*)?$`);
  let out: string;
  if (plain.test(s)) out = s;
  else if (grouped.test(s)) out = s.split(thousands).join('');
  else return null;
  out = out.replace(decimalSeparator, '.').replace(/^\+/, '');
  if (out.endsWith('.')) out = out.slice(0, -1);
  if (out.startsWith('.')) out = `0${out}`;
  if (out.startsWith('-.')) out = `-0${out.slice(1)}`;
  // big.js refuses exponents beyond its range: not a number then.
  const exp = /[eE]([+-]?\d+)$/.exec(out);
  if (exp && Math.abs(Number(exp[1])) > 1000) return null;
  return out;
}

/** `"1,500"` / `"1.500"`: 1500 or 1.5 depending on the file's convention. */
export function isAmbiguousNumberText(text: string): boolean {
  return /^[+-]?\d{1,3}[.,]\d{3}$/.test(text.replace(NUMBER_SPACES, ''));
}

// ---------------------------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------------------------

export interface DateParts {
  y: number;
  m: number;
  d: number;
  hh: number;
  mi: number;
  ss: number;
}

const MS_PER_DAY = 86_400_000;
/** 9999-12-31. */
const MAX_SERIAL = 2_958_465;

/**
 * Excel serial → calendar parts. Excel's 1900 leap-year bug: serial 60 (1900-02-29, which never
 * existed) is refused, serials below 60 are one day off.
 */
export function excelSerialToParts(serial: number, date1904 = false): DateParts | null {
  if (!Number.isFinite(serial)) return null;
  const totalSeconds = Math.round(serial * 86_400);
  let days = Math.floor(totalSeconds / 86_400);
  const secs = totalSeconds - days * 86_400;
  if (date1904) days += 1462;
  if (days < 1 || days > MAX_SERIAL || days === 60) return null;
  if (days < 60) days += 1;
  const date = new Date(Date.UTC(1899, 11, 30) + days * MS_PER_DAY);
  return {
    y: date.getUTCFullYear(),
    m: date.getUTCMonth() + 1,
    d: date.getUTCDate(),
    hh: Math.floor(secs / 3600),
    mi: Math.floor((secs % 3600) / 60),
    ss: secs % 60,
  };
}

const TOKEN = /yyyy|MM|dd|HH|mm|ss|M|d|H/g;
const formatCache = new Map<string, { re: RegExp; fields: string[] }>();

function compileFormat(format: string): { re: RegExp; fields: string[] } {
  const cached = formatCache.get(format);
  if (cached) return cached;
  const fields: string[] = [];
  let pattern = '';
  let last = 0;
  for (const m of format.matchAll(TOKEN)) {
    pattern += escapeRegex(format.slice(last, m.index));
    const tok = m[0];
    fields.push(tok[0]!);
    pattern += tok === 'yyyy' ? '(\\d{4})' : '(\\d{1,2})';
    last = m.index + tok.length;
  }
  pattern += escapeRegex(format.slice(last));
  const compiled = { re: new RegExp(`^${pattern}$`), fields };
  formatCache.set(format, compiled);
  return compiled;
}

/** Text against one format (`dd/MM/yyyy`, `yyyy-MM-dd HH:mm:ss`, …). */
export function parseDateText(text: string, format: string): DateParts | null {
  const { re, fields } = compileFormat(format);
  const match = re.exec(text.trim());
  if (!match) return null;
  const p: DateParts = { y: NaN, m: NaN, d: NaN, hh: 0, mi: 0, ss: 0 };
  fields.forEach((f, i) => {
    const n = Number(match[i + 1]);
    if (f === 'y') p.y = n;
    else if (f === 'M') p.m = n;
    else if (f === 'd') p.d = n;
    else if (f === 'H') p.hh = n;
    else if (f === 'm') p.mi = n;
    else if (f === 's') p.ss = n;
  });
  return validParts(p) ? p : null;
}

function validParts(p: DateParts): boolean {
  if (![p.y, p.m, p.d].every(Number.isInteger)) return false;
  if (p.hh > 23 || p.mi > 59 || p.ss > 59) return false;
  const dt = new Date(Date.UTC(p.y, p.m - 1, p.d));
  return dt.getUTCFullYear() === p.y && dt.getUTCMonth() === p.m - 1 && dt.getUTCDate() === p.d;
}

export function parseDateValue(
  raw: RawValue,
  formats: readonly string[],
  date1904 = false,
): DateParts | null {
  if (typeof raw === 'number') {
    return formats.includes('excelSerial') ? excelSerialToParts(raw, date1904) : null;
  }
  if (typeof raw !== 'string') return null;
  for (const f of formats) {
    if (f === 'excelSerial') {
      if (/^\d+(\.\d+)?$/.test(raw.trim())) {
        const parts = excelSerialToParts(Number(raw), date1904);
        if (parts) return parts;
      }
      continue;
    }
    const parts = parseDateText(raw, f);
    if (parts) return parts;
  }
  return null;
}

const pad = (n: number, w = 2): string => String(n).padStart(w, '0');

export function formatDate(p: DateParts): string {
  return `${pad(p.y, 4)}-${pad(p.m)}-${pad(p.d)}`;
}

export function formatDateTime(p: DateParts): string {
  return `${formatDate(p)}T${pad(p.hh)}:${pad(p.mi)}:${pad(p.ss)}`;
}

/** Text of a value in messages and rule checks (decimals as their exact text). */
export function displayValue(v: Value): string {
  if (v === null) return '';
  if (isDecimal(v)) return v.toString();
  return String(v);
}
