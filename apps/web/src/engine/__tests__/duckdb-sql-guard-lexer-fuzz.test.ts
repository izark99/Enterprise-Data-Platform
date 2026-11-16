import { describe, expect, it } from 'vitest';
import { replaceParams } from '../duckdb/sql-guard';

/**
 * Fuzz of the `$key` scanner of the `code.sql` guard (`replaceParams`, T-R1-08) alone, without
 * DuckDB's parser (the parser-backed fuzz is `e2e/engine/code-sql-fuzz.spec.ts`). Admin SQL is
 * external input. Properties, on random text over the characters that matter to the scanner:
 * - it never throws and stays linear (100,000 characters in well under a second);
 * - it only replaces `$key` by the placeholder and drops at most one `;`: putting `$key` back
 *   gives the input again (minus that `;`), and every dropped `;` is followed only by blanks and
 *   comments;
 * - it never replaces inside quotes, quoted names, dollar quotes or comments it has recognised.
 * Fixed seed; more cases with HRFLOW_HEAVY=1.
 */

const HEAVY =
  (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env
    .HRFLOW_HEAVY === '1';

const PLACEHOLDER = 'CAST(? AS VARCHAR)';

function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// No `?` anywhere, so the placeholder in the output can only come from the scanner.
const TOKENS = [
  "'",
  "''",
  '"',
  '""',
  '$',
  '$$',
  '$t$',
  '$ten',
  '$ky_luong',
  '$1',
  'a$ten',
  '$ten$',
  ';',
  ' ',
  '\n',
  '--',
  '/*',
  '*/',
  'E',
  "E'",
  'e',
  '\\',
  '\\\\',
  'SELECT',
  'x',
  '_',
  '9',
  'ư',
  '😀',
  '(',
  ')',
  ',',
];

function randomSql(r: () => number, length: number): string {
  let s = '';
  while (s.length < length) s += TOKENS[Math.floor(r() * TOKENS.length)]!;
  return s;
}

/** `out` with each placeholder put back as `$key` (keys in order). */
function restore(out: string, keys: readonly string[]): string {
  const parts = out.split(PLACEHOLDER);
  expect(parts.length - 1).toBe(keys.length);
  return parts.reduce((acc, part, i) => acc + (i === 0 ? '' : `$${keys[i - 1]!}`) + part, '');
}

describe('replaceParams fuzz', () => {
  it('only replaces $key and drops at most one trailing ;', () => {
    const r = prng(0x1e7e5);
    const runs = HEAVY ? 50_000 : 5_000;
    for (let k = 0; k < runs; k += 1) {
      const sql = randomSql(r, 1 + Math.floor(r() * 60));
      const { sql: out, keys } = replaceParams(sql);
      for (const key of keys) expect(key).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/);
      const back = restore(out, keys);
      if (back !== sql) {
        // Exactly one `;` was removed, and only blanks / comments followed it.
        expect(back.length, JSON.stringify(sql)).toBe(sql.length - 1);
        let i = 0;
        while (i < back.length && back[i] === sql[i]) i += 1;
        expect(sql[i], JSON.stringify(sql)).toBe(';');
        expect(sql.slice(0, i) + sql.slice(i + 1), JSON.stringify(sql)).toBe(back);
      }
    }
  });

  it('never replaces inside strings, quoted names, dollar quotes or comments', () => {
    const r = prng(0xc0ffee);
    const wrappers: ((inner: string) => string)[] = [
      (x) => `'${x.replaceAll("'", "''")}'`,
      (x) => `"${x.replaceAll('"', '""')}"`,
      (x) => `$$${x.replaceAll('$$', '')}$$`,
      (x) => `$q$${x.replaceAll('$q$', '')}$q$`,
      (x) => `/* ${x.replaceAll('/*', '').replaceAll('*/', '')} */`,
      (x) => `-- ${x.replaceAll('\n', ' ')}\n`,
      (x) => `E'${x.replaceAll('\\', '').replaceAll("'", "\\'")}'`,
    ];
    for (let k = 0; k < (HEAVY ? 20_000 : 2_000); k += 1) {
      const inner = randomSql(r, 1 + Math.floor(r() * 30));
      const wrap = wrappers[Math.floor(r() * wrappers.length)]!;
      const quoted = wrap(inner);
      const sql = `SELECT ${quoted} AS c, $ten AS d FROM luong`;
      const out = replaceParams(sql);
      expect(out.keys, JSON.stringify(sql)).toEqual(['ten']);
      expect(out.sql, JSON.stringify(sql)).toBe(
        `SELECT ${quoted} AS c, ${PLACEHOLDER} AS d FROM luong`,
      );
    }
  });

  it('stays linear on 100,000 characters of hostile input', () => {
    const big = 100_000;
    const inputs = [
      '$'.repeat(big),
      '$a'.repeat(big / 2),
      '$a$'.repeat(big / 3),
      Array.from({ length: big / 8 }, (_, i) => `$t${i}$`).join(''),
      "'".repeat(big),
      "E'".repeat(big / 2),
      '/*'.repeat(big / 2),
      '/*'.repeat(big / 4) + '*/'.repeat(big / 4),
      '--'.repeat(big / 2),
      ';'.repeat(big),
      '; '.repeat(big / 2),
      'a'.repeat(big),
      '\\'.repeat(big),
      `SELECT ${'$ten,'.repeat(big / 5)}1`,
      randomSql(prng(7), big),
    ];
    for (const sql of inputs) {
      const t0 = performance.now();
      const out = replaceParams(sql);
      const ms = performance.now() - t0;
      expect(ms, sql.slice(0, 20)).toBeLessThan(1_000);
      expect(restore(out.sql, out.keys).length).toBeGreaterThanOrEqual(sql.length - 1);
    }
  });
});
