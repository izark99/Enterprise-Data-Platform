/**
 * Public surface of the formula module for code outside `src/engine` (02 §3): the function
 * catalogue, reference rewriting and the error type. Kept free of the transpiler, so importing it
 * does not pull engine code into a chunk that does not need it (A-02-1).
 */
export { FUNCTION_GROUPS, FUNCTIONS } from './functions';
export type { FunctionGroup, FunctionSpec } from './functions';
export { escapeRef, toDisplay, toStored } from './refs';
export type { RefColumn } from './refs';
export { FormulaError } from './parser';
export type { FormulaParamDef } from './compile';
