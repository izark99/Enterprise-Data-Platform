import { IdentifierSchema, type DataType } from '@hrflow/flow-schema';
import { EngineError } from '../core/errors';
import type { SqlChecked, SqlDescribed, SqlInspector, SqlView } from '../nodes/index';
import type { DuckDb } from './db';
import { DUCKDB_TYPE, DuckDbError, quoteIdent, readKindOf } from './sql';

/**
 * Guard and `DESCRIBE` of Admin SQL (`code.sql`, spec §9.2, §12.1.8), with DuckDB's own parser
 * (`json_serialize_sql`), never a regex on the statement:
 * - exactly one `SELECT` / `WITH … SELECT` (anything else → `sql.error.notSelect`, a second
 *   statement → `sql.error.multipleStatements`, a parse error → `sql.error.syntax`);
 * - it reads only its input views and its own CTEs: every table function (`read_csv`,
 *   `pragma_*`, `duckdb_*`, `range`, …), every schema-qualified name and every other table (the
 *   run's own tables, `information_schema`) → `sql.error.forbidden` (allow-list; owner question 3,
 *   default A);
 * - `$key` must be a flow parameter (`sql.error.unknownParam`); `?` and `$1` are refused the same
 *   way. Each `$key` is replaced by a `VARCHAR` placeholder, the value is bound (owner 1A, MEMORY
 *   2026-11-16), and the rewritten statement is parsed again: it must equal the original except for
 *   the parameters, or the statement is refused (`sql.error.syntax`).
 * DuckDB's own text only ever goes to the screen-only `detail` of the error. A second layer of
 * defence is the locked configuration of `db.ts` (spec §13.1). A DuckDB opened without the `json`
 * extension (Vitest under Node) has no parser: `check` refuses with `duckdb.error.unavailable`.
 */

const PLACEHOLDER = 'CAST(? AS VARCHAR)';
/** Deepest `/* … *\/` nesting accepted (the parser is quadratic in it). */
const MAX_COMMENT_DEPTH = 32;
/** DuckDB's refusal of a statement that is not a query (`json_serialize_sql`). */
const NOT_SELECT = /^(Only SELECT statements|A CTE needs a SELECT)/;

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

interface Serialized {
  readonly error: boolean;
  readonly error_type?: string;
  readonly error_message?: string;
  readonly statements?: readonly {
    readonly node: Json;
    readonly named_param_map: readonly { key: string; value: number }[];
  }[];
}

function isObject(v: Json | undefined): v is JsonObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const fail = (key: string, params: Record<string, string> = {}, detail?: string): EngineError =>
  new EngineError(key, params, { path: ['sql'], ...(detail === undefined ? {} : { detail }) });

/** Names of the CTEs of one query node, in declaration order, with their query and recursion. */
function ctesOf(node: JsonObject): { name: string; query: Json; recursive: boolean }[] {
  const map = node['cte_map'];
  if (!isObject(map) || !Array.isArray(map['map'])) return [];
  const out: { name: string; query: Json; recursive: boolean }[] = [];
  for (const entry of map['map']) {
    if (!isObject(entry) || typeof entry['key'] !== 'string') continue;
    const value = entry['value'];
    const query = isObject(value) ? (value['query'] ?? null) : null;
    const inner = isObject(query) ? query['node'] : undefined;
    out.push({
      name: entry['key'].toLowerCase(),
      query,
      recursive: isObject(inner) && inner['type'] === 'RECURSIVE_CTE_NODE',
    });
  }
  return out;
}

/**
 * Table references (spec §9.2): an unqualified input view, or a CTE in scope where it is read —
 * the CTEs of an enclosing query, for a CTE body only the ones declared before it (and itself when
 * `RECURSIVE`), as DuckDB binds them. No table function. A CTE named like a run table therefore
 * never opens that table (verifier T-R1-08).
 */
function checkTables(value: Json, views: ReadonlySet<string>, scope: ReadonlySet<string>): void {
  if (Array.isArray(value)) {
    for (const v of value) checkTables(v, views, scope);
    return;
  }
  if (!isObject(value)) return;
  const type = value['type'];
  if (type === 'TABLE_FUNCTION' || type === 'SHOW_REF') throw fail('sql.error.forbidden');
  if (type === 'BASE_TABLE') {
    const qualified = Boolean(value['schema_name']) || Boolean(value['catalog_name']);
    const name = typeof value['table_name'] === 'string' ? value['table_name'].toLowerCase() : '';
    if (qualified || !(views.has(name) || scope.has(name))) throw fail('sql.error.forbidden');
  }
  const ctes = ctesOf(value);
  if (ctes.length > 0) {
    const before = new Set(scope);
    for (const cte of ctes) {
      const inBody = new Set(before);
      if (cte.recursive) inBody.add(cte.name);
      checkTables(cte.query, views, inBody);
      before.add(cte.name);
    }
    for (const [key, v] of Object.entries(value)) {
      if (key !== 'cte_map') checkTables(v, views, before);
    }
    return;
  }
  for (const v of Object.values(value)) checkTables(v, views, scope);
}

function hasOrderBy(node: Json): boolean {
  if (!isObject(node) || !Array.isArray(node['modifiers'])) return false;
  return node['modifiers'].some((m) => isObject(m) && m['type'] === 'ORDER_MODIFIER');
}

const IDENT_CHAR = /[A-Za-z0-9_$]/;
const WORD = /^[A-Za-z_][A-Za-z0-9_$]*/;
const DOLLAR_TAG = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/;
const PARAM = /^\$([A-Za-z_][A-Za-z0-9_]*)/;

/**
 * Replaces each `$key` outside strings, quoted names and comments by `PLACEHOLDER`, and drops a
 * final `;` (comments after it are kept) so the statement can be wrapped in a subquery. Whatever
 * this scanner gets wrong is caught by the second parse in `check`.
 */
export function replaceParams(sql: string): { sql: string; keys: string[]; commentDepth: number } {
  const keys: string[] = [];
  let commentDepth = 0;
  let out = '';
  let i = 0;
  const n = sql.length;
  /** Offset in `out` of a `;` followed so far only by whitespace and comments. */
  let semicolon = -1;
  const copyTo = (end: number): void => {
    out += sql.slice(i, end);
    i = end;
  };
  while (i < n) {
    const ch = sql[i]!;
    const rest = sql.slice(i, i + 256);
    const comment = (ch === '-' && sql[i + 1] === '-') || (ch === '/' && sql[i + 1] === '*');
    if (!comment && !/\s/.test(ch)) semicolon = ch === ';' ? out.length : -1;
    if (ch === "'" || ch === '"') {
      let j = i + 1;
      while (j < n && !(sql[j] === ch && sql[j + 1] !== ch)) j += sql[j] === ch ? 2 : 1;
      copyTo(Math.min(j + 1, n));
    } else if (ch === '-' && sql[i + 1] === '-') {
      const j = sql.indexOf('\n', i);
      copyTo(j < 0 ? n : j);
    } else if (ch === '/' && sql[i + 1] === '*') {
      let depth = 0;
      let j = i;
      while (j < n) {
        if (sql[j] === '/' && sql[j + 1] === '*') {
          depth += 1;
          commentDepth = Math.max(commentDepth, depth);
          j += 2;
        } else if (sql[j] === '*' && sql[j + 1] === '/') {
          depth -= 1;
          j += 2;
          if (depth === 0) break;
        } else j += 1;
      }
      copyTo(Math.min(j, n));
    } else if (ch === '$' && DOLLAR_TAG.test(rest)) {
      const tag = DOLLAR_TAG.exec(rest)![0];
      const j = sql.indexOf(tag, i + tag.length);
      copyTo(j < 0 ? n : j + tag.length);
    } else if (ch === '$' && PARAM.test(rest) && !(i > 0 && IDENT_CHAR.test(sql[i - 1]!))) {
      const m = PARAM.exec(rest)!;
      keys.push(m[1]!);
      out += PLACEHOLDER;
      i += m[0].length;
    } else if (WORD.test(rest) && !(i > 0 && IDENT_CHAR.test(sql[i - 1]!))) {
      const word = WORD.exec(rest)![0];
      if (/^e$/i.test(word) && sql[i + 1] === "'") {
        // E'…' string: a backslash escapes the next character.
        let j = i + 2;
        while (j < n && sql[j] !== "'") j += sql[j] === '\\' ? 2 : 1;
        copyTo(Math.min(j + 1, n));
      } else copyTo(i + word.length);
    } else copyTo(i + 1);
  }
  if (semicolon >= 0) out = out.slice(0, semicolon) + out.slice(semicolon + 1);
  return { sql: out, keys, commentDepth };
}

/**
 * A statement's AST without source positions, each parameter replaced by `{P: key, alias}`. In the
 * rewritten statement the parameter is the `CAST(? AS VARCHAR)` placed by `replaceParams`, whose
 * positional number gives its key.
 */
function normalize(value: Json, keys: readonly string[] | null): Json {
  if (Array.isArray(value)) return value.map((v) => normalize(v, keys));
  if (!isObject(value)) return value;
  if (keys === null && value['class'] === 'PARAMETER') {
    return { P: value['identifier'] ?? null, alias: value['alias'] ?? '' };
  }
  if (keys !== null && value['class'] === 'CAST') {
    const child = value['child'];
    const castType = value['cast_type'];
    if (
      isObject(child) &&
      child['class'] === 'PARAMETER' &&
      isObject(castType) &&
      castType['id'] === 'VARCHAR' &&
      value['try_cast'] === false
    ) {
      const index = Number(child['identifier']) - 1;
      return { P: keys[index] ?? null, alias: value['alias'] ?? '' };
    }
  }
  const out: JsonObject = {};
  for (const [k, v] of Object.entries(value)) {
    if (k !== 'query_location') out[k] = normalize(v, keys);
  }
  return out;
}

function same(a: Json, b: Json): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

const DATA_TYPE_OF_KIND = {
  string: 'string',
  boolean: 'boolean',
  integer: 'integer',
  decimal: 'decimal',
  double: 'decimal',
  date: 'date',
  datetime: 'datetime',
} as const satisfies Record<NonNullable<ReturnType<typeof readKindOf>>, DataType>;

/** Most digits before the decimal point of `DECIMAL(38,10)` (spec §9.4). */
const DECIMAL_LIMIT = '1e28';

export class DuckDbInspector implements SqlInspector {
  constructor(private readonly db: DuckDb) {}

  /** Without the `json` extension (or if it fails) there is no parser: never a raw error. */
  private serialize(sql: string): Serialized {
    let text: string | null;
    try {
      text = this.db.scalar('SELECT json_serialize_sql(CAST(? AS VARCHAR))', [sql]);
    } catch (err) {
      // The parser exists (checked by the caller): DuckDB refused the text (e.g. invalid UTF-16).
      throw fail('sql.error.syntax', {}, err instanceof DuckDbError ? err.message : undefined);
    }
    try {
      return JSON.parse(text ?? '{"error":true}') as Serialized;
    } catch {
      throw fail('sql.error.syntax');
    }
  }

  check(sql: string, views: readonly string[], params: readonly string[]): SqlChecked {
    if (!this.db.parser) throw fail('duckdb.error.unavailable');
    const rewritten = replaceParams(sql);
    // DuckDB's parser is quadratic in comment nesting; refuse before it runs (verifier T-R1-08).
    if (rewritten.commentDepth > MAX_COMMENT_DEPTH) throw fail('sql.error.syntax');
    const ast = this.serialize(sql);
    if (ast.error) {
      const message = ast.error_message ?? '';
      if (ast.error_type !== 'parser' && NOT_SELECT.test(message))
        throw fail('sql.error.notSelect');
      throw fail('sql.error.syntax', {}, message || undefined);
    }
    const statements = ast.statements ?? [];
    if (statements.length === 0) throw fail('sql.error.notSelect');
    if (statements.length > 1) throw fail('sql.error.multipleStatements');
    const stmt = statements[0]!;

    checkTables(stmt.node, new Set(views.map((v) => v.toLowerCase())), new Set());

    const declared = new Set(params);
    for (const { key } of stmt.named_param_map) {
      if (/^\d+$/.test(key) || !declared.has(key)) {
        throw fail('sql.error.unknownParam', { param: /^\d+$/.test(key) ? '?' : key });
      }
    }
    // DuckDB folds parameter names to one spelling: check every occurrence as written.
    for (const key of rewritten.keys) {
      if (!declared.has(key)) throw fail('sql.error.unknownParam', { param: key });
    }

    const again = this.serialize(rewritten.sql);
    const stmt2 = again.statements?.[0];
    if (
      again.error ||
      again.statements?.length !== 1 ||
      stmt2 === undefined ||
      stmt2.named_param_map.some((p) => !/^\d+$/.test(p.key)) ||
      !same(normalize(stmt.node, null), normalize(stmt2.node, rewritten.keys))
    ) {
      throw fail('sql.error.syntax');
    }
    return { sql: rewritten.sql, paramKeys: rewritten.keys, ordered: hasOrderBy(stmt.node) };
  }

  /**
   * Columns of the statement, by `DESCRIBE` over one empty typed temporary table per view (spec
   * §12.1.8). Temporary tables shadow run tables of the same name and keep the statement's own
   * column names (a subquery would rename a duplicate `a` to `a_1`); they are dropped at once.
   */
  describe(checked: SqlChecked, views: readonly SqlView[]): readonly SqlDescribed[] {
    const created: string[] = [];
    let rows: { column_name: string; column_type: string }[];
    try {
      for (const v of views) {
        const cols = v.columns.map((c) => `${quoteIdent(c.key)} ${DUCKDB_TYPE[c.type]}`);
        const name = `temp.main.${quoteIdent(v.name)}`;
        this.db.exec(`CREATE OR REPLACE TEMP TABLE ${quoteIdent(v.name)} (${cols.join(', ')})`);
        created.push(name);
      }
      const result = this.db.query(
        `DESCRIBE ${checked.sql}`,
        // A text, not NULL: DuckDB may type a NULL expression differently from a run.
        checked.paramKeys.map(() => ''),
      );
      rows = result
        .toArray()
        .map((r) => r.toJSON() as { column_name: string; column_type: string });
    } catch (err) {
      const detail = err instanceof DuckDbError ? err.message : undefined;
      throw fail('sql.error.runtime', {}, detail);
    } finally {
      for (const name of created) {
        try {
          this.db.exec(`DROP TABLE IF EXISTS ${name}`);
        } catch {
          // The temporary table lives only as long as the worker's database.
        }
      }
    }
    return rows.map((r) => {
      const kind = readKindOf(r.column_type);
      return {
        name: r.column_name,
        duckType: r.column_type,
        type: kind === null ? null : DATA_TYPE_OF_KIND[kind],
        double: kind === 'double',
      };
    });
  }

  canonical(expr: string, column: SqlDescribed, key: string): string {
    if (column.type === null) throw new TypeError('canonical: unsupported type');
    // `key` passed `IdentifierSchema`, so it is safe inside the marker text read by toEngineError.
    IdentifierSchema.parse(key);
    const target = DUCKDB_TYPE[column.type];
    if (column.double) {
      return (
        `CASE WHEN ${expr} IS NULL THEN NULL` +
        ` WHEN NOT isfinite(${expr}) THEN error('hr$notfinite:${key}')` +
        ` WHEN abs(${expr}) >= ${DECIMAL_LIMIT} THEN error('hr$overflow:${key}')` +
        ` ELSE CAST(format('{:.15g}', ${expr}) AS ${target}) END`
      );
    }
    if (column.type === 'decimal') {
      return (
        `CASE WHEN abs(${expr}) >= ${DECIMAL_LIMIT} THEN error('hr$overflow:${key}')` +
        ` ELSE CAST(${expr} AS ${target}) END`
      );
    }
    return `CAST(${expr} AS ${target})`;
  }
}
