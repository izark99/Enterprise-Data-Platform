/**
 * The 41 functions of `transform.formula` (spec §9.1, MEMORY 2026-10-30 17:24): name, group and
 * argument count. Pure data shared by the transpiler and the Designer (completion, the "Hàm hỗ
 * trợ" table); syntax, description and example are owner-edited texts keyed by the name
 * (`designer:formula.fn.<NAME>.syntax|desc|example`), group titles `node.formula.groups.<group>`.
 */

export type FunctionGroup = 'logic' | 'math' | 'text' | 'date' | 'param';

export const FUNCTION_GROUPS: readonly FunctionGroup[] = ['logic', 'math', 'text', 'date', 'param'];

export interface FunctionSpec {
  readonly name: string;
  readonly group: FunctionGroup;
  /** Fewest arguments. */
  readonly min: number;
  /** Most arguments (Excel allows 255 for the variadic ones). */
  readonly max: number;
}

/** Excel's argument limit. */
const MANY = 255;

export const FUNCTIONS: readonly FunctionSpec[] = [
  { name: 'IF', group: 'logic', min: 2, max: 3 },
  { name: 'IFS', group: 'logic', min: 2, max: 254 },
  { name: 'AND', group: 'logic', min: 1, max: MANY },
  { name: 'OR', group: 'logic', min: 1, max: MANY },
  { name: 'NOT', group: 'logic', min: 1, max: 1 },
  { name: 'SWITCH', group: 'logic', min: 3, max: 254 },
  { name: 'IFERROR', group: 'logic', min: 2, max: 2 },
  { name: 'ISBLANK', group: 'logic', min: 1, max: 1 },
  { name: 'ISNUMBER', group: 'logic', min: 1, max: 1 },
  { name: 'ROUND', group: 'math', min: 2, max: 2 },
  { name: 'ROUNDUP', group: 'math', min: 2, max: 2 },
  { name: 'ROUNDDOWN', group: 'math', min: 2, max: 2 },
  { name: 'INT', group: 'math', min: 1, max: 1 },
  { name: 'ABS', group: 'math', min: 1, max: 1 },
  { name: 'MIN', group: 'math', min: 1, max: MANY },
  { name: 'MAX', group: 'math', min: 1, max: MANY },
  { name: 'MOD', group: 'math', min: 2, max: 2 },
  { name: 'SUM', group: 'math', min: 1, max: MANY },
  { name: 'LEFT', group: 'text', min: 1, max: 2 },
  { name: 'RIGHT', group: 'text', min: 1, max: 2 },
  { name: 'MID', group: 'text', min: 3, max: 3 },
  { name: 'LEN', group: 'text', min: 1, max: 1 },
  { name: 'TRIM', group: 'text', min: 1, max: 1 },
  { name: 'UPPER', group: 'text', min: 1, max: 1 },
  { name: 'LOWER', group: 'text', min: 1, max: 1 },
  { name: 'PROPER', group: 'text', min: 1, max: 1 },
  { name: 'CONCAT', group: 'text', min: 1, max: MANY },
  { name: 'TEXTJOIN', group: 'text', min: 3, max: 252 },
  { name: 'SUBSTITUTE', group: 'text', min: 3, max: 4 },
  { name: 'FIND', group: 'text', min: 2, max: 3 },
  { name: 'SEARCH', group: 'text', min: 2, max: 3 },
  { name: 'VALUE', group: 'text', min: 1, max: 1 },
  { name: 'DATE', group: 'date', min: 3, max: 3 },
  { name: 'YEAR', group: 'date', min: 1, max: 1 },
  { name: 'MONTH', group: 'date', min: 1, max: 1 },
  { name: 'DAY', group: 'date', min: 1, max: 1 },
  { name: 'EDATE', group: 'date', min: 2, max: 2 },
  { name: 'EOMONTH', group: 'date', min: 2, max: 2 },
  { name: 'DATEDIF', group: 'date', min: 3, max: 3 },
  { name: 'WEEKDAY', group: 'date', min: 1, max: 2 },
  { name: 'PARAM', group: 'param', min: 1, max: 1 },
];

/** The spec of a function name (upper case), `undefined` outside the whitelist. */
export function functionSpec(name: string): FunctionSpec | undefined {
  return FUNCTIONS.find((f) => f.name === name);
}

/** Lookup functions: the hint points to `transform.join` (spec §9.1, AC-B4-02). */
export const LOOKUP_FUNCTIONS: readonly string[] = ['XLOOKUP', 'VLOOKUP', 'HLOOKUP', 'LOOKUP'];
