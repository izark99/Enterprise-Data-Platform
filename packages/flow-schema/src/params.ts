import { z } from 'zod';
import { IdentifierSchema } from './identifier';

/** Runtime parameter of a flow (docs/redesign/03 §3, spec §8). */

export const PARAM_TYPES = ['string', 'number', 'date', 'month', 'boolean', 'select'] as const;

export const ParamOptionsSchema = z.union([
  z.array(z.strictObject({ value: z.string(), label: z.string() })),
  z.strictObject({
    fromRefTable: z.string().min(1),
    valueColumn: z.string().min(1),
    labelColumn: z.string().min(1),
  }),
]);
export type ParamOptions = z.infer<typeof ParamOptionsSchema>;

export const FlowParamSchema = z.strictObject({
  key: IdentifierSchema,
  label: z.string().min(1),
  type: z.enum(PARAM_TYPES),
  required: z.boolean().default(false),
  /** Written to run_logs (03 §4.7): `true` always, `false` never, unset = by type (03 §3). */
  log: z.boolean().optional(),
  /** This param is the as-of date that selects the flow version (03 §4.2). */
  isAsOfDate: z.boolean().optional(),
  options: ParamOptionsSchema.optional(),
});
export type FlowParam = z.infer<typeof FlowParamSchema>;
export type FlowParamInput = z.input<typeof FlowParamSchema>;
