import { z } from 'zod';
import {
  DataTypeSchema,
  DecimalLiteralSchema,
  IdentifierSchema,
  SeveritySchema,
  type DataType,
} from './identifier';

/** Input slot: the file a User uploads (spec §10). Defaults and limits: docs/redesign/03 §3. */

const severity = SeveritySchema.default('error');

function regexCompiles(source: string): boolean {
  try {
    new RegExp(source);
    return true;
  } catch {
    return false;
  }
}

export const ColumnRuleSchema = z.union([
  z.strictObject({ unique: z.literal(true), severity }),
  z.strictObject({
    regex: z.string().min(1).refine(regexCompiles, 'regex does not compile'),
    severity,
  }),
  z.strictObject({ min: DecimalLiteralSchema, severity }),
  z.strictObject({ max: DecimalLiteralSchema, severity }),
]);
export type ColumnRule = z.infer<typeof ColumnRuleSchema>;

/** Tokens `yyyy`, `MM`/`M`, `dd`/`d`, `HH`, `mm`, `ss` with separators, or `excelSerial`. */
export const DateFormatSchema = z.union([
  z.literal('excelSerial'),
  z.string().regex(/^[dMyHms/.\-: T]+$/, 'unsupported date format'),
]);

export const ColumnPresenceSchema = z.enum(['required', 'optional']);
export type ColumnPresence = z.infer<typeof ColumnPresenceSchema>;

export const ColumnDefaultValueSchema = z.union([z.string(), z.number().finite(), z.boolean()]);
export type ColumnDefaultValue = z.infer<typeof ColumnDefaultValueSchema>;

const DECIMAL_TEXT = /^-?\d+(\.\d+)?$/;
const INTEGER_TEXT = /^-?\d+$/;
const DATE_TEXT = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME_TEXT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;

function defaultFitsType(value: ColumnDefaultValue, type: DataType): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'boolean':
      return typeof value === 'boolean';
    case 'decimal':
      return typeof value === 'number' || (typeof value === 'string' && DECIMAL_TEXT.test(value));
    case 'integer':
      return typeof value === 'number'
        ? Number.isSafeInteger(value)
        : typeof value === 'string' && INTEGER_TEXT.test(value) && Number.isSafeInteger(+value);
    case 'date':
      return typeof value === 'string' && DATE_TEXT.test(value);
    case 'datetime':
      return typeof value === 'string' && DATETIME_TEXT.test(value);
  }
}

/**
 * A column of a slot. `presence` = the column must exist in the header; `required` = every data
 * row needs a value. `presence` left out follows `required`; the parsed column always has it.
 */
export const SlotColumnSchema = z
  .strictObject({
    key: IdentifierSchema,
    label: z.string().optional(),
    aliases: z.array(z.string().min(1)).min(1),
    type: DataTypeSchema,
    presence: ColumnPresenceSchema.optional(),
    required: z.boolean().default(false),
    defaultValue: ColumnDefaultValueSchema.optional(),
    rules: z.array(ColumnRuleSchema).default([]),
    dateFormats: z.array(DateFormatSchema).min(1).optional(),
    decimalSeparator: z.enum(['.', ',']).default('.'),
  })
  .superRefine((column, ctx) => {
    if (column.key.startsWith('_')) {
      ctx.addIssue({
        code: 'custom',
        path: ['key'],
        message: `column key "${column.key}" must not start with "_" (reserved for system columns)`,
      });
    }
    if (column.defaultValue === undefined) return;
    if (column.required) {
      ctx.addIssue({
        code: 'custom',
        path: ['defaultValue'],
        message: 'defaultValue is only used when required is false',
      });
    } else if (!defaultFitsType(column.defaultValue, column.type)) {
      ctx.addIssue({
        code: 'custom',
        path: ['defaultValue'],
        message: `defaultValue does not fit column type "${column.type}"`,
      });
    }
  })
  .transform((column) => ({
    ...column,
    presence: column.presence ?? (column.required ? 'required' : 'optional'),
  }));
export type SlotColumn = z.infer<typeof SlotColumnSchema>;
export type SlotColumnInput = z.input<typeof SlotColumnSchema>;

export const SheetSelectorSchema = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('byName'), value: z.string().min(1) }),
  /** 0-based sheet index. */
  z.strictObject({ mode: z.literal('byIndex'), value: z.number().int().min(0) }),
  /** First sheet whose header holds every column with `presence: 'required'`. */
  z.strictObject({ mode: z.literal('firstMatchingHeaders') }),
]);
export type SheetSelector = z.infer<typeof SheetSelectorSchema>;

/** CSV is not accepted (MEMORY 2026-10-26 13:08). */
export const SUPPORTED_FILE_TYPES = ['.xlsx', '.xls'] as const;

export const InputSlotSchema = z
  .strictObject({
    key: IdentifierSchema,
    label: z.string().min(1),
    required: z.boolean().default(true),
    accept: z
      .array(z.enum(SUPPORTED_FILE_TYPES))
      .min(1)
      .default([...SUPPORTED_FILE_TYPES]),
    sheet: SheetSelectorSchema.default({ mode: 'byIndex', value: 0 }),
    /** 1-based Excel row of the first header row. */
    headerRow: z.number().int().min(1).default(1),
    /** More than 1: the texts of each column are joined with " / ". */
    headerRows: z.number().int().min(1).max(5).default(1),
    /** 1-based Excel row of the first data row; left out = headerRow + headerRows. */
    dataStartRow: z.number().int().min(1).optional(),
    stopAt: z.strictObject({ blankRows: z.number().int().min(1) }).optional(),
    /** A row whose `whenBlank` columns are all blank, or contain a `whenKeyContains` text, is not data. */
    skipRows: z
      .strictObject({
        whenBlank: z.array(IdentifierSchema).min(1),
        whenKeyContains: z.array(z.string().trim().min(1)).default([]),
      })
      .optional(),
    unmergeCells: z.enum(['none', 'fillDown']).default('none'),
    columns: z.array(SlotColumnSchema).min(1),
    extraColumns: z.enum(['drop', 'keep']).default('drop'),
    multiple: z
      .strictObject({
        enabled: z.boolean().default(false),
        minFiles: z.number().int().min(1).default(1),
        maxFiles: z.number().int().min(1).default(50),
      })
      .default({ enabled: false, minFiles: 1, maxFiles: 50 }),
    /** Warn when a file has more data rows than this. */
    maxRows: z.number().int().min(1).optional(),
  })
  .superRefine((slot, ctx) => {
    const keys = slot.columns.map((column) => column.key);
    keys.forEach((key, i) => {
      if (keys.indexOf(key) !== i) {
        ctx.addIssue({
          code: 'custom',
          path: ['columns', i, 'key'],
          message: `duplicate column key "${key}"`,
        });
      }
    });
    slot.skipRows?.whenBlank.forEach((key, i) => {
      if (!keys.includes(key)) {
        ctx.addIssue({
          code: 'custom',
          path: ['skipRows', 'whenBlank', i],
          message: `unknown column key "${key}"`,
        });
      }
    });
    if (slot.dataStartRow !== undefined && slot.dataStartRow < slot.headerRow + slot.headerRows) {
      ctx.addIssue({
        code: 'custom',
        path: ['dataStartRow'],
        message: 'dataStartRow must come after the header rows',
      });
    }
    if (slot.multiple.minFiles > slot.multiple.maxFiles) {
      ctx.addIssue({
        code: 'custom',
        path: ['multiple', 'minFiles'],
        message: 'minFiles must be <= maxFiles',
      });
    }
  });
export type InputSlot = z.infer<typeof InputSlotSchema>;
export type InputSlotInput = z.input<typeof InputSlotSchema>;
