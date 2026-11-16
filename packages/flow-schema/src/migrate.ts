/**
 * Schema compatibility (spec §8.1): a published version is immutable and must load in every later
 * release. A breaking change comes with a step here that rewrites an old definition in memory
 * (never the stored copy) before `FlowDefinitionSchema` parses it, and returns a notice per change.
 *
 * Steps: `.csv` (MEMORY 2026-10-26 13:08) and `.xls` (MEMORY 2026-11-16, owner 1B) are removed
 * from `inputSlots[].accept`; a slot left with no format gets the default `.xlsx`. The last format
 * removed from such a slot gets the `…OnlyReplaced` notice, the others `…Removed`.
 */

export type FlowMigrationCode =
  'acceptCsvRemoved' | 'acceptCsvOnlyReplaced' | 'acceptXlsRemoved' | 'acceptXlsOnlyReplaced';

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

const REMOVED_FORMATS = [
  { ext: '.csv', removed: 'acceptCsvRemoved', onlyReplaced: 'acceptCsvOnlyReplaced' },
  { ext: '.xls', removed: 'acceptXlsRemoved', onlyReplaced: 'acceptXlsOnlyReplaced' },
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function formatOf(value: unknown): string | undefined {
  return typeof value === 'string' ? value.trim().toLowerCase() : undefined;
}

function migrateSlot(slot: unknown, index: number, notices: FlowMigrationNotice[]): unknown {
  if (!isRecord(slot) || !Array.isArray(slot.accept)) return slot;
  const accept = slot.accept as unknown[];
  const present = REMOVED_FORMATS.filter((f) => accept.some((v) => formatOf(v) === f.ext));
  if (present.length === 0) return slot;
  const key = typeof slot.key === 'string' ? slot.key : String(index);
  const label = typeof slot.label === 'string' && slot.label.trim() ? slot.label.trim() : key;
  const kept = accept.filter((v) => !present.some((f) => f.ext === formatOf(v)));
  present.forEach((f, i) => {
    const last = i === present.length - 1;
    notices.push({
      code: kept.length === 0 && last ? f.onlyReplaced : f.removed,
      slot: key,
      label,
    });
  });
  return { ...slot, accept: kept.length > 0 ? kept : ['.xlsx'] };
}

export function migrateFlowDefinition(raw: unknown): FlowMigrationResult {
  const notices: FlowMigrationNotice[] = [];
  if (!isRecord(raw) || !Array.isArray(raw.inputSlots)) return { definition: raw, notices };
  const inputSlots = (raw.inputSlots as unknown[]).map((slot, i) => migrateSlot(slot, i, notices));
  return notices.length === 0
    ? { definition: raw, notices }
    : { definition: { ...raw, inputSlots }, notices };
}
