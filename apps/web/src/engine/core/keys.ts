import { isDecimal } from './decimal';
import type { Value } from './types';

/**
 * Normalised form of one key value (03 §4.4): NFC, every run of Unicode whitespace collapsed to one
 * space, trimmed, lowercase. Used by `control.compare`, the slot rule `unique`, and the
 * `normalizeKeys` / `normalizeText` options of join, dedupe and filter. The SQL twin
 * (`hrflow_norm_key`) must give the same result. Callers keep the original value for display.
 */
export function normalizeKeyPart(v: Value | undefined): string {
  if (v === null || v === undefined) return '';
  const text = isDecimal(v) ? v.toString() : String(v);
  return text.normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase();
}
