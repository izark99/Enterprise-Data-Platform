import { z } from 'zod';
import { IdentifierSchema, NonNegativeDecimalLiteralSchema } from './identifier';

/**
 * Configs of the input, control and output nodes: `input.excel` (spec §12.1.9),
 * `control.compare` (§24.2, 03 §4.3), `output.excel` (§11), `output.preview` (§12.1.10).
 * Whether a referenced column exists depends on the rest of the flow: the node plugin checks it.
 */

const ColumnRefSchema = z.string().min(1);

export const InputExcelConfigSchema = z.strictObject({
  slot: IdentifierSchema,
});
export type InputExcelConfig = z.infer<typeof InputExcelConfigSchema>;

export const CompareMetricSchema = z.strictObject({
  left: ColumnRefSchema,
  right: ColumnRefSchema,
  label: z.string().min(1),
  /** Mismatch when |right − left| > tolerance. */
  tolerance: NonNegativeDecimalLiteralSchema.default('0'),
});
export type CompareMetric = z.infer<typeof CompareMetricSchema>;

export const CompareConfigSchema = z
  .strictObject({
    /** Key columns, same name on both sides. */
    keys: z.array(ColumnRefSchema).min(1),
    metrics: z.array(CompareMetricSchema).min(1),
    /** Display columns carried into `mismatched`. */
    carryColumns: z.array(ColumnRefSchema).default([]),
    nullAsZero: z.boolean().default(true),
    /** Side names in output column titles, e.g. "Công (lương)"; left out = i18n "A" / "B". */
    sideLabels: z.strictObject({ left: z.string().min(1), right: z.string().min(1) }).optional(),
  })
  .superRefine((config, ctx) => {
    const labels = config.metrics.map((metric) => metric.label);
    labels.forEach((label, i) => {
      if (labels.indexOf(label) !== i) {
        ctx.addIssue({
          code: 'custom',
          path: ['metrics', i, 'label'],
          message: `duplicate metric label "${label}"`,
        });
      }
    });
  });
export type CompareConfig = z.infer<typeof CompareConfigSchema>;
export type CompareConfigInput = z.input<typeof CompareConfigSchema>;

/** 1–31 characters, none of `: \ / ? * [ ]`, no apostrophe at either end (Excel rejects those). */
export const ExcelSheetNameSchema = z
  .string()
  .min(1)
  .max(31)
  .regex(/^[^:\\/?*[\]]+$/, 'invalid Excel sheet name')
  .refine((name) => !name.startsWith("'") && !name.endsWith("'"), {
    message: 'an Excel sheet name cannot start or end with an apostrophe',
  });

export const OutputExcelConfigSchema = z
  .strictObject({
    /** `{param_key}` placeholders are replaced by the run parameters. */
    fileName: z.string().min(1).default('output.xlsx'),
    /** One sheet per input port of the node. */
    sheets: z.array(z.strictObject({ name: ExcelSheetNameSchema, port: z.string().min(1) })).min(1),
  })
  .superRefine((config, ctx) => {
    // Excel compares sheet names without case ("Lệch" and "LỆCH" clash).
    const seen = new Set<string>();
    config.sheets.forEach((sheet, i) => {
      const name = sheet.name.toLowerCase();
      if (seen.has(name)) {
        ctx.addIssue({
          code: 'custom',
          path: ['sheets', i, 'name'],
          message: `duplicate sheet name "${sheet.name}" (case-insensitive)`,
        });
      }
      seen.add(name);
    });
  });
export type OutputExcelConfig = z.infer<typeof OutputExcelConfigSchema>;

export const OutputPreviewConfigSchema = z.strictObject({
  /** Result tab name; uniqueness across the flow is checked by the plugin. */
  title: z.string().trim().min(1).max(60),
  /** Left out = every input column. */
  columns: z.array(ColumnRefSchema).optional(),
  maxRows: z.number().int().min(1).max(1_000_000).default(100_000),
});
export type OutputPreviewConfig = z.infer<typeof OutputPreviewConfigSchema>;
