import { z } from 'zod';
import { IdentifierSchema, LiteralSchema } from './identifier';

/**
 * Configs of the transform nodes (spec §12.1.1–§12.1.8) and `transform.formula` (§12.2).
 * Column references are `key`s of the upstream schema; the node plugin checks they exist.
 */

const ColumnRefSchema = z.string().min(1);

function duplicateIssues<T>(
  items: readonly T[],
  keyOf: (item: T) => string,
  path: (i: number) => (string | number)[],
  what: string,
  ctx: z.RefinementCtx,
): void {
  const seen = new Set<string>();
  items.forEach((item, i) => {
    const key = keyOf(item);
    if (seen.has(key)) {
      ctx.addIssue({ code: 'custom', path: path(i), message: `duplicate ${what} "${key}"` });
    }
    seen.add(key);
  });
}

/** `transform.select`: pick, rename and reorder columns. */
export const SelectConfigSchema = z.strictObject({
  columns: z
    .array(
      z.strictObject({
        from: ColumnRefSchema,
        key: IdentifierSchema.optional(),
        title: z.string().min(1).optional(),
      }),
    )
    .min(1),
});
export type SelectConfig = z.infer<typeof SelectConfigSchema>;

export const FILTER_OPS = [
  'eq',
  'neq',
  'gt',
  'gte',
  'lt',
  'lte',
  'in',
  'notIn',
  'isBlank',
  'notBlank',
  'contains',
  'notContains',
  'startsWith',
  'endsWith',
] as const;
export type FilterOp = (typeof FILTER_OPS)[number];

/** Ops that compare with one `value` (a literal or a run parameter). */
export const FILTER_SINGLE_VALUE_OPS: readonly FilterOp[] = [
  'eq',
  'neq',
  'gt',
  'gte',
  'lt',
  'lte',
  'contains',
  'notContains',
  'startsWith',
  'endsWith',
];
/** Ops that take the `values` list. */
export const FILTER_LIST_OPS: readonly FilterOp[] = ['in', 'notIn'];

export const FilterConditionSchema = z
  .strictObject({
    column: ColumnRefSchema,
    op: z.enum(FILTER_OPS),
    value: z.union([LiteralSchema, z.strictObject({ param: IdentifierSchema })]).optional(),
    values: z.array(LiteralSchema).min(1).max(500).optional(),
  })
  .superRefine((condition, ctx) => {
    if (FILTER_SINGLE_VALUE_OPS.includes(condition.op) && condition.value === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['value'],
        message: `op "${condition.op}" needs a value`,
      });
    }
    if (FILTER_LIST_OPS.includes(condition.op) && condition.values === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['values'],
        message: `op "${condition.op}" needs values`,
      });
    }
  });
export type FilterCondition = z.infer<typeof FilterConditionSchema>;

/** `transform.filter`. */
export const FilterConfigSchema = z.strictObject({
  match: z.enum(['all', 'any']).default('all'),
  conditions: z.array(FilterConditionSchema).min(1),
  /** Compare strings after key normalisation (03 §4.4). */
  normalizeText: z.boolean().default(true),
});
export type FilterConfig = z.infer<typeof FilterConfigSchema>;

/** `transform.sort`. */
export const SortConfigSchema = z.strictObject({
  by: z
    .array(
      z.strictObject({
        column: ColumnRefSchema,
        direction: z.enum(['asc', 'desc']).default('asc'),
        blanks: z.enum(['first', 'last']).default('last'),
      }),
    )
    .min(1),
});
export type SortConfig = z.infer<typeof SortConfigSchema>;

/** `transform.join`. Ports `left`, `right`. */
export const JoinConfigSchema = z.strictObject({
  how: z.enum(['inner', 'left', 'right', 'full', 'anti']),
  on: z.array(z.strictObject({ left: ColumnRefSchema, right: ColumnRefSchema })).min(1),
  normalizeKeys: z.boolean().default(true),
  /** Columns taken from `right`; left out = every right column that is not a key. */
  rightColumns: z.array(ColumnRefSchema).optional(),
  rightSuffix: z
    .string()
    .regex(/^_[a-z0-9_]+$/, 'must look like "_r"')
    .default('_r'),
});
export type JoinConfig = z.infer<typeof JoinConfigSchema>;

/** `transform.union`. Ports `in_1` … `in_N`, N = `inputCount`. */
export const UnionConfigSchema = z
  .strictObject({
    inputCount: z.number().int().min(2).max(10).default(2),
    missingColumns: z.enum(['null', 'error']).default('null'),
    sourceColumn: z.strictObject({ key: IdentifierSchema, labels: z.array(z.string()) }).optional(),
  })
  .superRefine((config, ctx) => {
    if (config.sourceColumn && config.sourceColumn.labels.length !== config.inputCount) {
      ctx.addIssue({
        code: 'custom',
        path: ['sourceColumn', 'labels'],
        message: `needs exactly ${config.inputCount} labels`,
      });
    }
  });
export type UnionConfig = z.infer<typeof UnionConfigSchema>;

export const AGGREGATION_FNS = [
  'sum',
  'avg',
  'min',
  'max',
  'count',
  'countDistinct',
  'countRows',
] as const;
export type AggregationFn = (typeof AGGREGATION_FNS)[number];

/** `transform.groupBy`. Empty `by` = one total row. */
export const GroupByConfigSchema = z.strictObject({
  by: z.array(ColumnRefSchema).default([]),
  aggregations: z
    .array(
      z
        .strictObject({
          key: IdentifierSchema,
          title: z.string().min(1).optional(),
          fn: z.enum(AGGREGATION_FNS),
          column: ColumnRefSchema.optional(),
        })
        .superRefine((aggregation, ctx) => {
          if (aggregation.fn !== 'countRows' && aggregation.column === undefined) {
            ctx.addIssue({
              code: 'custom',
              path: ['column'],
              message: `fn "${aggregation.fn}" needs a column`,
            });
          }
        }),
    )
    .min(1),
});
export type GroupByConfig = z.infer<typeof GroupByConfigSchema>;

/** `transform.dedupe`. Ports `out` (kept rows), `removed` (dropped rows). */
export const DedupeConfigSchema = z.strictObject({
  keys: z.array(ColumnRefSchema).min(1),
  keep: z.enum(['first', 'last']).default('first'),
  normalizeKeys: z.boolean().default(true),
});
export type DedupeConfig = z.infer<typeof DedupeConfigSchema>;

/** `code.sql`: one view per input port, one SELECT (spec §9.2). */
export const CodeSqlConfigSchema = z
  .strictObject({
    inputs: z
      .array(z.strictObject({ port: IdentifierSchema }))
      .min(1)
      .max(10),
    sql: z.string().min(1).max(100_000),
  })
  .superRefine((config, ctx) => {
    duplicateIssues(
      config.inputs,
      (input) => input.port,
      (i) => ['inputs', i, 'port'],
      'port',
      ctx,
    );
  });
export type CodeSqlConfig = z.infer<typeof CodeSqlConfigSchema>;

/** Column types of `transform.formula`; `auto` = inferred from the formula. */
export const FORMULA_TYPES = ['auto', 'string', 'integer', 'decimal', 'boolean', 'date'] as const;
export type FormulaType = (typeof FORMULA_TYPES)[number];

/** `transform.formula`: computed columns, evaluated top to bottom. */
export const FormulaConfigSchema = z
  .strictObject({
    columns: z
      .array(
        z.strictObject({
          /** A new column, or the key of an input column to overwrite. */
          key: IdentifierSchema,
          title: z.string().trim().min(1).max(200).optional(),
          /** Must start with "=": the parser reports it with the character position. */
          formula: z.string().max(2000),
          type: z.enum(FORMULA_TYPES).default('auto'),
          onError: z.enum(['blank', 'fail']).default('blank'),
        }),
      )
      .min(1)
      .max(50),
  })
  .superRefine((config, ctx) => {
    duplicateIssues(
      config.columns,
      (column) => column.key,
      (i) => ['columns', i, 'key'],
      'column',
      ctx,
    );
  });
export type FormulaConfig = z.infer<typeof FormulaConfigSchema>;
export type FormulaConfigInput = z.input<typeof FormulaConfigSchema>;
