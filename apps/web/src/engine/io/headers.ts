import type { InputSlot } from '@hrflow/flow-schema';
import { isBlankRaw, type Grid } from './xlsx-stream';

/**
 * Header rows of a slot (spec §10): the texts of `headerRows` rows from `headerRow` are joined with
 * " / " per column, then matched to the column aliases after normalisation.
 */

/**
 * Header text for alias matching: Vietnamese diacritics removed (`đ` → `d`), lowercase, runs of
 * whitespace (line breaks, NBSP, zero-width space included) collapsed to one space, trimmed.
 * Punctuation is kept, so "OT (giờ)" and "OT" stay different.
 */
export function normalizeHeader(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
    .replace(/[\s\u00a0\u200b]+/g, ' ')
    .trim();
}

export interface HeaderMapping {
  /** Header text per sheet column (`""` when empty), as shown in messages. */
  readonly headers: readonly string[];
  /** Slot column key → sheet columns whose header matches an alias, in sheet order. */
  readonly matches: ReadonlyMap<string, readonly number[]>;
}

/**
 * Reads the header of `grid` for `slot`. Header cells always follow merged ranges (a group title
 * merged over several columns names each of them); a text repeated by a vertical merge is kept once.
 */
export function readHeaders(slot: InputSlot, grid: Grid): HeaderMapping {
  const headers: string[] = [];
  for (let c = 0; c <= grid.lastCol; c++) {
    const parts: string[] = [];
    for (let h = 0; h < slot.headerRows; h++) {
      const { value } = grid.cell(slot.headerRow - 1 + h, c, true);
      if (isBlankRaw(value)) continue;
      const text = String(value).replace(/\s+/g, ' ').trim();
      if (text !== '' && parts[parts.length - 1] !== text) parts.push(text);
    }
    headers.push(parts.join(' / '));
  }
  const normalized = headers.map(normalizeHeader);
  const matches = new Map<string, number[]>();
  for (const col of slot.columns) {
    const aliases = new Set(col.aliases.map(normalizeHeader));
    const found: number[] = [];
    normalized.forEach((h, c) => {
      if (h !== '' && aliases.has(h)) found.push(c);
    });
    matches.set(col.key, found);
  }
  return { headers, matches };
}

/** Every column with `presence: 'required'` has a matching header (`firstMatchingHeaders`). */
export function hasRequiredHeaders(slot: InputSlot, mapping: HeaderMapping): boolean {
  return slot.columns
    .filter((col) => col.presence === 'required')
    .every((col) => (mapping.matches.get(col.key) ?? []).length > 0);
}

/** snake_case key of a kept extra column (`extraColumns: 'keep'`); never starts with a digit. */
export function slugifyHeader(text: string): string {
  const slug = normalizeHeader(text)
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (slug === '') return 'col';
  return /^[0-9]/.test(slug) ? `col_${slug}` : slug;
}
