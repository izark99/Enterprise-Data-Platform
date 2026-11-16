import { z } from 'zod';

/**
 * Primitive schemas shared by every part of a flow definition: identifiers, data types (spec §9.4)
 * and literals. Defaults and limits not written in the spec: docs/redesign/03 §3.
 */

/** Machine name of a column, slot, param, port or node: `[a-z_][a-z0-9_]*`. */
export const IdentifierSchema = z
  .string()
  .regex(/^[a-z_][a-z0-9_]*$/, 'must be snake_case: [a-z_][a-z0-9_]*');
export type Identifier = z.infer<typeof IdentifierSchema>;

/** Canonical data types (spec §9.4). Money and day counts use `decimal`, never float. */
export const DATA_TYPES = ['string', 'integer', 'decimal', 'boolean', 'date', 'datetime'] as const;
export const DataTypeSchema = z.enum(DATA_TYPES);
export type DataType = z.infer<typeof DataTypeSchema>;

/** Level of a validation rule: `error` blocks the run, `warning` lets it go on (spec §10). */
export const SeveritySchema = z.enum(['error', 'warning']);
export type Severity = z.infer<typeof SeveritySchema>;

const DECIMAL_TEXT = /^-?\d+(\.\d+)?$/;

/** A decimal written as a JSON number or, preferred because it keeps every digit, a string ("0.5"). */
export const DecimalLiteralSchema = z.union([
  z.number().finite(),
  z.string().regex(DECIMAL_TEXT, 'must be a decimal string like "0.5"'),
]);
export type DecimalLiteral = z.infer<typeof DecimalLiteralSchema>;

/** A decimal literal that is not negative (a compare tolerance). */
export const NonNegativeDecimalLiteralSchema = DecimalLiteralSchema.refine(
  (v) => (typeof v === 'number' ? v >= 0 : !v.startsWith('-')),
  'must be >= 0',
);

/** A constant in a node config, read according to the column type (`date` as YYYY-MM-DD, …). */
export const LiteralSchema = z.union([z.string(), z.number().finite(), z.boolean()]);
export type Literal = z.infer<typeof LiteralSchema>;
