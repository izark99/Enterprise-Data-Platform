/**
 * Column references of `transform.formula` (spec §12.2): typed as `[Tiêu đề]` or `[key]`, stored as
 * `[key]` (`toStored`), shown again by the current title (`toDisplay`). A `]` in a name is written
 * `]]`. A key matches first; otherwise a title matches after NFC, trimming and lower-casing, and a
 * title shared by two columns is ambiguous (`formula.error.ambiguousTitle`, use the key).
 */

/** A column a formula can reference (input column or formula column above). */
export interface RefColumn {
  readonly key: string;
  readonly title: string;
}

/** `name` as a reference: `[name]` with every `]` doubled. */
export function escapeRef(name: string): string {
  return `[${name.replaceAll(']', ']]')}]`;
}

function normTitle(title: string): string {
  return title.normalize('NFC').trim().toLowerCase();
}

export type Resolved =
  | { readonly kind: 'ok'; readonly key: string }
  | { readonly kind: 'ambiguous' }
  | { readonly kind: 'missing' };

/** The column a reference name means among `columns`. */
export function resolveRef(name: string, columns: readonly RefColumn[]): Resolved {
  if (columns.some((c) => c.key === name)) return { kind: 'ok', key: name };
  const wanted = normTitle(name);
  let found: string | null = null;
  for (const c of columns) {
    if (normTitle(c.title) !== wanted) continue;
    if (found !== null && found !== c.key) return { kind: 'ambiguous' };
    found = c.key;
  }
  return found === null ? { kind: 'missing' } : { kind: 'ok', key: found };
}

/**
 * Rewrites every complete `[…]` reference outside string constants with `map(name)` (`null` keeps
 * it as typed). Tolerant of text being typed: from an unterminated string or reference on, the
 * text is kept as it is.
 */
function mapRefs(text: string, map: (name: string) => string | null): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (c !== '"' && c !== '[') {
      out += c;
      i++;
      continue;
    }
    const close = c === '"' ? '"' : ']';
    let j = i + 1;
    let name = '';
    let closed = false;
    while (j < text.length) {
      if (text[j] === close) {
        if (text[j + 1] === close) {
          name += close;
          j += 2;
          continue;
        }
        j++;
        closed = true;
        break;
      }
      name += text[j];
      j++;
    }
    if (!closed) return out + text.slice(i);
    const replaced = c === '[' ? map(name) : null;
    out += replaced === null ? text.slice(i, j) : escapeRef(replaced);
    i = j;
  }
  return out;
}

/** `[Tiêu đề]` → `[key]` for the definition; a reference that does not resolve stays as typed. */
export function toStored(text: string, columns: readonly RefColumn[]): string {
  return mapRefs(text, (name) => {
    const r = resolveRef(name, columns);
    return r.kind === 'ok' ? r.key : null;
  });
}

/**
 * `[key]` → `[Tiêu đề]` for the editor, when the title leads back to the same column (else the key
 * is shown, e.g. for two columns with one title).
 */
export function toDisplay(text: string, columns: readonly RefColumn[]): string {
  return mapRefs(text, (name) => {
    const col = columns.find((c) => c.key === name);
    if (col === undefined || col.title === '') return null;
    const back = resolveRef(col.title, columns);
    return back.kind === 'ok' && back.key === col.key ? col.title : null;
  });
}
