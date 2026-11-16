/**
 * Schema compatibility (spec §8.1): a published version is immutable and must load in every later
 * release. A breaking change comes with a step here that rewrites an old definition in memory
 * (never the stored copy) before `FlowDefinitionSchema` parses it, and returns a notice per change.
 *
 * Steps: `.csv` is removed from `inputSlots[].accept` (MEMORY 2026-10-26 13:08); a slot that
 * accepted only `.csv` gets the default `.xlsx, .xls`.
 */

export type FlowMigrationCode = 'acceptCsvRemoved' | 'acceptCsvOnlyReplaced';

export interface FlowMigrationNotice {
  code: FlowMigrationCode;
  /** Slot key, or its index when the key is missing. */
  slot: string;
  /** What the Admin sees: the slot label, else the key or index. */
  label: string;
}

export interface FlowMigrationResult {
  /** The rewritten raw definition; the argument itself is never mutated. */
  definition: unknown;
  notices: FlowMigrationNotice[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCsv(value: unknown): boolean {
  return typeof value === 'string' && value.trim().toLowerCase() === '.csv';
}

function migrateSlot(slot: unknown, index: number, notices: FlowMigrationNotice[]): unknown {
  if (!isRecord(slot) || !Array.isArray(slot.accept) || !slot.accept.some(isCsv)) return slot;
  const key = typeof slot.key === 'string' ? slot.key : String(index);
  const label = typeof slot.label === 'string' && slot.label.trim() ? slot.label.trim() : key;
  const kept = (slot.accept as unknown[]).filter((value) => !isCsv(value));
  if (kept.length > 0) {
    notices.push({ code: 'acceptCsvRemoved', slot: key, label });
    return { ...slot, accept: kept };
  }
  notices.push({ code: 'acceptCsvOnlyReplaced', slot: key, label });
  return { ...slot, accept: ['.xlsx', '.xls'] };
}

export function migrateFlowDefinition(raw: unknown): FlowMigrationResult {
  const notices: FlowMigrationNotice[] = [];
  if (!isRecord(raw) || !Array.isArray(raw.inputSlots)) return { definition: raw, notices };
  const inputSlots = (raw.inputSlots as unknown[]).map((slot, i) => migrateSlot(slot, i, notices));
  return notices.length === 0
    ? { definition: raw, notices }
    : { definition: { ...raw, inputSlots }, notices };
}
