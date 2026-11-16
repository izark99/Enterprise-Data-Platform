import type { InputSlot, Severity, SlotColumn } from '@hrflow/flow-schema';
import { Big, decimalFromNumber, isDecimal, type Decimal } from '../core/decimal';
import type { ErrorVars } from '../core/errors';
import { normalizeKeyPart } from '../core/keys';
import { ColumnBuilder, Table } from '../core/table';
import type { ColumnDef, Value } from '../core/types';
import { coerceCell, coerceValue, displayRaw, displayValue } from './coerce';
import {
  hasRequiredHeaders,
  normalizeHeader,
  readHeaders,
  slugifyHeader,
  type HeaderMapping,
} from './headers';
import { isBlankRaw, openXlsx, type CellRead, type Grid, type WorkbookSource } from './xlsx-stream';
import { FileReadError } from './zip';

/**
 * Reads the files of one input slot and builds the validation report shown before a run (spec §10,
 * 03 §4.6). Each file is read and checked with the slot config, the rows of all files are joined
 * (with `_source_file` when the slot takes several files), and `unique` rules are checked on the
 * joined rows, so a duplicate across two files is reported on both. Row numbers are the original
 * 1-based Excel rows. Messages are i18n keys of `locales/vi/engine.json` with params; a cell value
 * appears only in the params of the row messages the report shows on screen.
 */

/** File handed over by the UI; its name and bytes stay in the browser. */
export interface SourceFile {
  readonly name: string;
  readonly bytes: Uint8Array;
}

export interface ValidationIssue {
  readonly severity: Severity;
  readonly messageKey: string;
  readonly params: ErrorVars;
  /** Position of the file in the slot's file list, and its name. */
  readonly fileIndex?: number;
  readonly file?: string;
  readonly sheet?: string;
  /** Original 1-based Excel row. */
  readonly row?: number;
  /** Slot column key. */
  readonly column?: string;
  /** The other file of a duplicate across files: the issue also counts for that file's status. */
  readonly relatedFileIndex?: number;
  readonly relatedFile?: string;
}

/** A row left out as not data (total or signature row). Shown for information, never blocks. */
export interface SkippedRow {
  readonly fileIndex: number;
  readonly file: string;
  readonly sheet: string;
  readonly row: number;
  readonly messageKey: string;
  readonly params: ErrorVars;
}

export interface FileSummary {
  readonly fileIndex: number;
  readonly file: string;
  readonly sheet?: string;
  readonly dataRows: number;
  readonly skippedRows: number;
  readonly errorCount: number;
  readonly warningCount: number;
}

export interface ValidationReport {
  readonly issues: readonly ValidationIssue[];
  readonly skippedRows: readonly SkippedRow[];
  readonly files: readonly FileSummary[];
  readonly errorCount: number;
  readonly warningCount: number;
}

export interface SlotReadResult {
  readonly table: Table;
  readonly report: ValidationReport;
}

/** System column with the name of the file each row comes from (multi-file slots, spec §10). */
export const SOURCE_FILE_COLUMN = '_source_file';

const ZIP_SIGNATURES = [
  [0x50, 0x4b, 0x03, 0x04],
  [0x50, 0x4b, 0x05, 0x06],
];

/**
 * Opens a workbook by its content (the extension was checked against `accept` before): only a ZIP
 * package (`.xlsx`) is read, by the streaming reader. Anything else, an OLE2 `.xls` renamed
 * included, is unreadable (MEMORY 2026-11-16, owner 1B). Throws `FileReadError` only.
 */
export function openWorkbook(bytes: Uint8Array): WorkbookSource {
  return guarded(() => {
    if (ZIP_SIGNATURES.some((sig) => sig.every((b, i) => bytes[i] === b))) return openXlsx(bytes);
    throw new FileReadError('validation.fileUnreadable');
  });
}

/** Any failure of a reader is one of the two file keys (a crash is never shown as a crash). */
function guarded<T>(f: () => T): T {
  try {
    return f();
  } catch (err) {
    if (err instanceof FileReadError) throw err;
    throw new FileReadError('validation.fileUnreadable');
  }
}

function extensionOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i < 0 ? '' : name.slice(i).toLowerCase();
}

export function columnTitle(col: SlotColumn): string {
  return col.label ?? col.aliases[0] ?? col.key;
}

/** Value of a blank cell in a column that is not required: `defaultValue` in the column type. */
function blankValue(col: SlotColumn): Value {
  const d = col.defaultValue;
  if (d === undefined || typeof d === 'boolean') return d ?? null;
  switch (col.type) {
    case 'decimal':
      return typeof d === 'number' ? decimalFromNumber(d) : new Big(d);
    case 'integer':
      return Number(d);
    default:
      return d;
  }
}

interface ExtraColumn {
  readonly def: ColumnDef;
  readonly builder: ColumnBuilder;
}

interface UniqueSeen {
  readonly fileIndex: number;
  readonly row: number;
  readonly value: string;
}

interface NumberBound {
  readonly kind: 'min' | 'max';
  readonly bound: Decimal;
  readonly text: string;
  readonly severity: Severity;
}

/** Per-column state of one slot read. */
interface ColumnPlan {
  readonly col: SlotColumn;
  readonly title: string;
  readonly fallback: Value;
  readonly regexes: readonly { re: RegExp; severity: Severity }[];
  readonly bounds: readonly NumberBound[];
  readonly unique: { severity: Severity; seen: Map<string, UniqueSeen> } | null;
  readonly builder: ColumnBuilder;
}

class SlotReader {
  private readonly issues: ValidationIssue[] = [];
  private readonly skipped: SkippedRow[] = [];
  private readonly summaries: Omit<FileSummary, 'errorCount' | 'warningCount'>[] = [];
  private readonly plans: ColumnPlan[];
  private readonly extras = new Map<string, ExtraColumn>();
  private readonly source: ColumnBuilder | null;
  private rowCount = 0;

  constructor(private readonly slot: InputSlot) {
    this.plans = slot.columns.map((col) => {
      const regexes: { re: RegExp; severity: Severity }[] = [];
      const bounds: NumberBound[] = [];
      let unique: ColumnPlan['unique'] = null;
      for (const rule of col.rules) {
        if ('unique' in rule) unique ??= { severity: rule.severity, seen: new Map() };
        else if ('regex' in rule)
          regexes.push({ re: new RegExp(rule.regex), severity: rule.severity });
        else if ('min' in rule) {
          bounds.push({
            kind: 'min',
            bound: new Big(rule.min),
            text: String(rule.min),
            severity: rule.severity,
          });
        } else {
          bounds.push({
            kind: 'max',
            bound: new Big(rule.max),
            text: String(rule.max),
            severity: rule.severity,
          });
        }
      }
      return {
        col,
        title: columnTitle(col),
        fallback: blankValue(col),
        regexes,
        bounds,
        unique,
        builder: new ColumnBuilder(col.type),
      };
    });
    this.source = slot.multiple.enabled ? new ColumnBuilder('string') : null;
  }

  read(files: readonly SourceFile[]): SlotReadResult {
    this.checkFileCount(files.length);
    files.forEach((file, fileIndex) => this.readFile(file, fileIndex));
    return { table: this.table(), report: this.report() };
  }

  private add(issue: ValidationIssue): void {
    this.issues.push(issue);
  }

  private checkFileCount(count: number): void {
    const { multiple, required, label } = this.slot;
    const min = multiple.enabled ? multiple.minFiles : 1;
    const max = multiple.enabled ? multiple.maxFiles : 1;
    if (count === 0) {
      if (required)
        this.add({
          severity: 'error',
          messageKey: 'validation.slotRequired',
          params: { slot: label },
        });
    } else if (count < min) {
      this.add({ severity: 'error', messageKey: 'validation.filesTooFew', params: { min, count } });
    } else if (count > max) {
      this.add({
        severity: 'error',
        messageKey: 'validation.filesTooMany',
        params: { max, count },
      });
    }
  }

  private fileIssue(
    fileIndex: number,
    file: string,
    messageKey: string,
    params: ErrorVars = {},
  ): void {
    this.add({ severity: 'error', messageKey, params: { file, ...params }, fileIndex, file });
  }

  private readFile(file: SourceFile, fileIndex: number): void {
    const summary = { fileIndex, file: file.name, dataRows: 0, skippedRows: 0 };
    if (!(this.slot.accept as readonly string[]).includes(extensionOf(file.name))) {
      this.fileIssue(fileIndex, file.name, 'validation.fileTypeNotAccepted', {
        accept: this.slot.accept.join(', '),
      });
      this.summaries.push(summary);
      return;
    }
    let picked: PickedSheet | null;
    try {
      picked = guarded(() => this.pickSheet(openWorkbook(file.bytes), fileIndex, file.name));
    } catch (err) {
      const key = err instanceof FileReadError ? err.messageKey : 'validation.fileUnreadable';
      this.fileIssue(fileIndex, file.name, key);
      this.summaries.push(summary);
      return;
    }
    if (picked === null) {
      this.summaries.push(summary);
      return;
    }
    const counts = this.readRows(picked, fileIndex, file.name);
    this.summaries.push({ ...summary, sheet: picked.sheet, ...counts });
  }

  private pickSheet(book: WorkbookSource, fileIndex: number, file: string): PickedSheet | null {
    const sel = this.slot.sheet;
    const load = (i: number): PickedSheet => {
      const grid = book.readSheet(i);
      return {
        sheet: book.sheetNames[i] ?? '',
        grid,
        mapping: readHeaders(this.slot, grid),
        date1904: book.date1904,
      };
    };
    if (sel.mode === 'byName') {
      let i = book.sheetNames.indexOf(sel.value);
      if (i < 0) {
        const wanted = normalizeHeader(sel.value);
        i = book.sheetNames.findIndex((n) => normalizeHeader(n) === wanted);
      }
      if (i >= 0) return load(i);
      this.fileIssue(fileIndex, file, 'validation.sheetNotFound', { sheet: sel.value });
      return null;
    }
    if (sel.mode === 'byIndex') {
      if (sel.value < book.sheetNames.length) return load(sel.value);
      this.fileIssue(fileIndex, file, 'validation.sheetIndexNotFound', { index: sel.value + 1 });
      return null;
    }
    for (let i = 0; i < book.sheetNames.length; i++) {
      const sheet = load(i);
      if (hasRequiredHeaders(this.slot, sheet.mapping)) return sheet;
    }
    this.fileIssue(fileIndex, file, 'validation.sheetNoMatchingHeaders');
    return null;
  }

  /** Column checks, then the data rows. Returns the file's row counts. */
  private readRows(
    { sheet, grid, mapping, date1904 }: PickedSheet,
    fileIndex: number,
    file: string,
  ): { dataRows: number; skippedRows: number } {
    const slot = this.slot;
    const at = { fileIndex, file, sheet };
    const columnOf = new Map<string, number>();
    for (const plan of this.plans) {
      const { col, title } = plan;
      const found = mapping.matches.get(col.key) ?? [];
      const required = col.presence === 'required';
      if (found.length === 0) {
        this.add({
          severity: required ? 'error' : 'warning',
          messageKey: required ? 'validation.columnMissing' : 'validation.columnMissingOptional',
          params: {
            file,
            sheet,
            column: title,
            aliases: col.aliases.join(', '),
            headerRow: slot.headerRow,
          },
          ...at,
          column: col.key,
        });
        continue;
      }
      if (found.length > 1) {
        this.add({
          severity: required ? 'error' : 'warning',
          messageKey: required
            ? 'validation.columnAmbiguousRequired'
            : 'validation.columnAmbiguous',
          params: {
            file,
            sheet,
            column: title,
            headers: found.map((c) => `"${mapping.headers[c] ?? ''}"`).join(', '),
          },
          ...at,
          column: col.key,
        });
      }
      columnOf.set(col.key, found[0]!);
    }

    // A missing key column (`skipRows.whenBlank`) makes every row unidentifiable: only the column
    // error is reported, no error per row (spec §10, MEMORY 2026-10-26 08:59).
    const keys = slot.skipRows?.whenBlank ?? [];
    const keyMissing = keys.some(
      (k) => !columnOf.has(k) && slot.columns.find((c) => c.key === k)?.presence === 'required',
    );
    if (keyMissing) return { dataRows: 0, skippedRows: 0 };

    const keyCols = keys.map((k) => columnOf.get(k));
    const skipActive = keyCols.length > 0 && keyCols.every((c) => c !== undefined);
    const keyTitles = keys.map((k) => columnTitle(slot.columns.find((c) => c.key === k)!));
    const skipTexts = (slot.skipRows?.whenKeyContains ?? [])
      .map((text) => ({ text, norm: normalizeHeader(text) }))
      .filter((x) => x.norm !== '');

    const fileExtras = this.extraColumns(mapping);
    const fillDown = slot.unmergeCells === 'fillDown';
    const values: Value[] = new Array<Value>(this.plans.length).fill(null);
    const first = (slot.dataStartRow ?? slot.headerRow + slot.headerRows) - 1;
    const stopAfter = slot.stopAt?.blankRows;
    let blankRun = 0;
    let dataRows = 0;
    let skippedRows = 0;

    for (let r = first; r <= grid.lastRow; r++) {
      if (grid.isRowBlank(r)) {
        blankRun++;
        if (stopAfter !== undefined && blankRun >= stopAfter) break;
        continue;
      }
      blankRun = 0;
      const row = r + 1;
      const cellAt = (c: number): CellRead => grid.cell(r, c, fillDown);

      if (skipActive) {
        const skip = this.skipReason(keyCols as number[], keyTitles, skipTexts, cellAt, file, row);
        if (skip !== null) {
          this.skipped.push({ ...at, row, ...skip });
          skippedRows++;
          continue;
        }
      }

      const rowAt = { ...at, row };
      this.plans.forEach((plan, k) => {
        const c = columnOf.get(plan.col.key);
        values[k] = c === undefined ? null : this.cellValue(plan, cellAt(c), date1904, rowAt);
      });
      this.plans.forEach((plan, k) => plan.builder.append(values[k] ?? null));
      for (const [key, extra] of this.extras) {
        const c = fileExtras.get(key);
        let v: Value = null;
        if (c !== undefined) {
          const coerced = coerceValue(displayRaw(cellAt(c), date1904), 'string');
          v = coerced.ok ? coerced.value : null;
        }
        extra.builder.append(v);
      }
      this.source?.append(file);
      this.checkUnique(values, fileIndex, file, row);
      this.rowCount++;
      dataRows++;
    }

    if (dataRows === 0 && columnOf.size > 0) {
      this.add({
        severity: 'warning',
        messageKey: 'validation.noDataRows',
        params: { file, sheet },
        ...at,
      });
    }
    if (slot.maxRows !== undefined && dataRows > slot.maxRows) {
      this.add({
        severity: 'warning',
        messageKey: 'validation.rowsTooMany',
        params: { file, count: dataRows, max: slot.maxRows },
        ...at,
      });
    }
    return { dataRows, skippedRows };
  }

  private skipReason(
    keyCols: readonly number[],
    keyTitles: readonly string[],
    skipTexts: readonly { text: string; norm: string }[],
    cellAt: (c: number) => CellRead,
    file: string,
    row: number,
  ): { messageKey: string; params: ErrorVars } | null {
    if (keyCols.every((c) => isBlankRaw(cellAt(c).value) && cellAt(c).error === undefined)) {
      return {
        messageKey: 'skipped.keyBlank',
        params: { file, row, columns: keyTitles.join(', ') },
      };
    }
    for (let i = 0; i < keyCols.length && skipTexts.length > 0; i++) {
      const v = cellAt(keyCols[i]!).value;
      if (isBlankRaw(v)) continue;
      const norm = normalizeHeader(String(v));
      const hit = skipTexts.find((t) => norm.includes(t.norm));
      if (hit) {
        return {
          messageKey: 'skipped.keyContains',
          params: { file, row, column: keyTitles[i]!, text: hit.text },
        };
      }
    }
    return null;
  }

  /** Extra columns of this file (`extraColumns: 'keep'`): key → sheet column. */
  private extraColumns(mapping: HeaderMapping): Map<string, number> {
    const out = new Map<string, number>();
    if (this.slot.extraColumns !== 'keep') return out;
    const used = new Set<number>();
    for (const found of mapping.matches.values()) for (const c of found) used.add(c);
    const taken = new Set<string>([...this.slot.columns.map((c) => c.key), SOURCE_FILE_COLUMN]);
    mapping.headers.forEach((header, c) => {
      if (used.has(c) || header === '') return;
      const base = slugifyHeader(header);
      let key = base;
      for (let i = 2; taken.has(key) || out.has(key); i++) key = `${base}_${i}`;
      out.set(key, c);
      if (!this.extras.has(key)) {
        const builder = new ColumnBuilder('string');
        for (let i = 0; i < this.rowCount; i++) builder.append(null);
        this.extras.set(key, { def: { key, title: header, type: 'string' }, builder });
      }
    });
    return out;
  }

  private cellValue(
    plan: ColumnPlan,
    cell: CellRead,
    date1904: boolean,
    at: { fileIndex: number; file: string; sheet: string; row: number },
  ): Value {
    const { col, title } = plan;
    const where = { ...at, column: col.key };
    const params = { file: at.file, row: at.row, column: title };
    if (cell.error !== undefined) {
      this.add({
        severity: 'error',
        messageKey: 'validation.type',
        params: { ...params, value: cell.error, type: col.type },
        ...where,
      });
      return null;
    }
    const coerced = coerceCell(cell, col.type, {
      dateFormats: col.dateFormats,
      decimalSeparator: col.decimalSeparator,
      date1904,
    });
    if (!coerced.ok) {
      this.add({
        severity: 'error',
        messageKey: 'validation.type',
        params: { ...params, value: String(displayRaw(cell, date1904)), type: col.type },
        ...where,
      });
      return null;
    }
    const value = coerced.value;
    if (value === null) {
      if (col.required) {
        this.add({ severity: 'error', messageKey: 'validation.required', params, ...where });
        return null;
      }
      return plan.fallback;
    }
    if (coerced.ambiguous) {
      this.add({
        severity: 'warning',
        messageKey: 'validation.numberAmbiguous',
        params: { ...params, value: String(cell.value), parsed: displayValue(value) },
        ...where,
      });
    }
    const text = displayValue(value);
    for (const { re, severity } of plan.regexes) {
      re.lastIndex = 0;
      if (!re.test(text)) {
        this.add({
          severity,
          messageKey: 'validation.regex',
          params: { ...params, value: text },
          ...where,
        });
      }
    }
    if (plan.bounds.length > 0) {
      const n = isDecimal(value) ? value : typeof value === 'number' ? new Big(value) : null;
      if (n !== null) {
        for (const b of plan.bounds) {
          if (b.kind === 'min' ? n.lt(b.bound) : n.gt(b.bound)) {
            this.add({
              severity: b.severity,
              messageKey: `validation.${b.kind}`,
              params: { ...params, value: text, [b.kind]: b.text },
              ...where,
            });
          }
        }
      }
    }
    return value;
  }

  /**
   * `unique` on the joined rows. Text compares with `normalizeKeyPart` (case, whitespace, NFC), as
   * `control.compare` does (MEMORY 2026-10-26 09:12); messages show both original values.
   */
  private checkUnique(
    values: readonly Value[],
    fileIndex: number,
    file: string,
    row: number,
  ): void {
    this.plans.forEach((plan, k) => {
      const v = values[k] ?? null;
      if (plan.unique === null || v === null) return;
      const key = plan.col.type === 'string' ? normalizeKeyPart(v) : displayValue(v);
      const seen = plan.unique.seen.get(key);
      const shown = displayValue(v);
      if (seen === undefined) {
        plan.unique.seen.set(key, { fileIndex, row, value: shown });
        return;
      }
      const otherFile = this.summaryName(seen.fileIndex, file, fileIndex);
      this.add({
        severity: plan.unique.severity,
        messageKey: 'validation.unique',
        params: {
          column: plan.title,
          value: shown,
          file,
          row,
          otherValue: seen.value,
          otherFile,
          otherRow: seen.row,
        },
        fileIndex,
        file,
        row,
        column: plan.col.key,
        ...(seen.fileIndex === fileIndex
          ? {}
          : { relatedFileIndex: seen.fileIndex, relatedFile: otherFile }),
      });
    });
  }

  private summaryName(index: number, current: string, currentIndex: number): string {
    if (index === currentIndex) return current;
    return this.summaries.find((s) => s.fileIndex === index)?.file ?? '';
  }

  private table(): Table {
    const columns: ColumnDef[] = this.plans.map((p) => ({
      key: p.col.key,
      title: p.title,
      type: p.col.type,
    }));
    const vectors = this.plans.map((p) => p.builder.finish());
    for (const extra of this.extras.values()) {
      columns.push(extra.def);
      vectors.push(extra.builder.finish());
    }
    if (this.source !== null) {
      columns.push({ key: SOURCE_FILE_COLUMN, title: SOURCE_FILE_COLUMN, type: 'string' });
      vectors.push(this.source.finish());
    }
    return new Table(columns, vectors, this.rowCount);
  }

  private report(): ValidationReport {
    const errors = new Array<number>(this.summaries.length).fill(0);
    const warnings = new Array<number>(this.summaries.length).fill(0);
    let errorCount = 0;
    let warningCount = 0;
    for (const issue of this.issues) {
      const counts = issue.severity === 'error' ? errors : warnings;
      if (issue.severity === 'error') errorCount++;
      else warningCount++;
      if (issue.fileIndex !== undefined)
        counts[issue.fileIndex] = (counts[issue.fileIndex] ?? 0) + 1;
      if (issue.relatedFileIndex !== undefined) {
        counts[issue.relatedFileIndex] = (counts[issue.relatedFileIndex] ?? 0) + 1;
      }
    }
    return {
      issues: this.issues,
      skippedRows: this.skipped,
      files: this.summaries.map((s) => ({
        ...s,
        errorCount: errors[s.fileIndex] ?? 0,
        warningCount: warnings[s.fileIndex] ?? 0,
      })),
      errorCount,
      warningCount,
    };
  }
}

interface PickedSheet {
  readonly sheet: string;
  readonly grid: Grid;
  readonly mapping: HeaderMapping;
  readonly date1904: boolean;
}

/** Reads and validates every file of `slot`. Never throws for file content. */
export function readSlot(slot: InputSlot, files: readonly SourceFile[]): SlotReadResult {
  return new SlotReader(slot).read(files);
}
