import type { DataType } from '@hrflow/flow-schema';
import { IdentifierSchema } from '@hrflow/flow-schema';
import { EngineError } from '../core/errors';
import type { SqlOwner, SqlRelation, SqlRuntime } from '../core/executor';
import type { Table } from '../core/table';
import type { Schema } from '../core/types';
import type { SqlCountWarning, SqlDialect, SqlInput, SqlQuery, SqlValue } from '../nodes/index';
import { readTable, uploadTable } from './arrow-io';
import type { DuckDb } from './db';
import { loadDuckDb, type LoadProgress } from './loader';
import { DUCKDB_TYPE, normKeySql, ORD_SQL, quoteIdent, toEngineError } from './sql';

/**
 * DuckDB side of one run (spec §13.1 "Thực thi"): the `SqlRuntime` the executor drives.
 *
 * - A TS table is uploaded once as a table with canonical types and `hr$ord` (arrow-io.ts).
 * - A node's query becomes a lazy relation: one CTE appended to the CTE chain of its inputs, so
 *   consecutive DuckDB nodes run as one statement (pushdown); nothing is evaluated yet.
 * - `materialize` evaluates a chain into a table with a dense `hr$ord`; `read` brings a relation
 *   back as an engine `Table` (materialising first when lazy).
 * - Tables are reference-counted by the relations that read them and dropped at zero; `dispose`
 *   drops everything this scope created.
 *
 * Values are bound only as prepared parameters; DuckDB's text never reaches an `EngineError`.
 */

interface Cte {
  readonly name: string;
  readonly sql: string;
  readonly params: readonly SqlValue[];
  readonly columns: Schema;
  /** Node whose query this is (a failure found by probing is reported at it). */
  readonly owner: SqlOwner;
}

class Rel implements SqlRelation {
  constructor(
    readonly columns: Schema,
    /** Quoted name to read in `FROM` (a table, or the last CTE of `ctes`). */
    readonly ref: string,
    readonly ctes: readonly Cte[],
    /** Known once materialised. */
    readonly rowCount: number | null,
    /** Tables this relation reads. */
    readonly bases: readonly string[],
  ) {}
}

const AUX_NAME = /^[a-z_][a-z0-9_]*$/;

/** The dialect given to plugins' `compile` (nodes never import DuckDB code). */
export const DUCKDB_DIALECT: SqlDialect = {
  ident: quoteIdent,
  ord: ORD_SQL,
  aux(name) {
    if (!AUX_NAME.test(name)) throw new TypeError('aux: not an identifier');
    return `"hr$${name}"`;
  },
  normKey: normKeySql,
  cast: (expr, type: DataType) => `CAST(${expr} AS ${DUCKDB_TYPE[type]})`,
  isBlank: (expr, type) => (type === 'string' ? `(${normKeySql(expr)} = '')` : `(${expr} IS NULL)`),
  param: 'CAST(? AS VARCHAR)',
};

/** Merges the CTE chains of several inputs, each CTE once, in chain order. */
function mergeCtes(rels: readonly Rel[]): Cte[] {
  const seen = new Set<string>();
  const out: Cte[] = [];
  for (const rel of rels) {
    for (const cte of rel.ctes) {
      if (seen.has(cte.name)) continue;
      seen.add(cte.name);
      out.push(cte);
    }
  }
  return out;
}

/** `WITH …` prefix and its parameters (CTEs come first in the text, so params line up). */
function withClause(ctes: readonly Cte[]): { sql: string; params: SqlValue[] } {
  if (ctes.length === 0) return { sql: '', params: [] };
  const params: SqlValue[] = [];
  const parts = ctes.map((c) => {
    for (const p of c.params) params.push(p);
    return `${c.name} AS (${c.sql})`;
  });
  return { sql: `WITH ${parts.join(', ')} `, params };
}

let counter = 0;

export class SqlScope implements SqlRuntime {
  readonly dialect = DUCKDB_DIALECT;
  private readonly refs = new Map<string, number>();
  private readonly created = new Set<string>();

  constructor(private readonly db: DuckDb) {}

  private rel(value: SqlRelation): Rel {
    if (!(value instanceof Rel)) throw new TypeError('SqlScope: foreign relation');
    return value;
  }

  /** Table names are `IdentifierSchema` names (arrow-io quotes them); unique per worker. */
  private tableName(): string {
    counter += 1;
    const name = `hr_tab_${counter}`;
    IdentifierSchema.parse(name);
    return name;
  }

  private run(sql: string, params: readonly SqlValue[], node: string): void {
    try {
      this.db.exec(sql, params);
    } catch (err) {
      throw toEngineError(err, node);
    }
  }

  private drop(name: string): void {
    this.created.delete(name);
    this.refs.delete(name);
    try {
      this.db.exec(`DROP TABLE IF EXISTS ${quoteIdent(name)}`);
    } catch {
      // Best effort: the database lives only as long as the worker.
    }
  }

  upload(table: Table, node: string): SqlRelation {
    const name = this.tableName();
    this.created.add(name);
    try {
      uploadTable(this.db, table, name, node);
    } catch (err) {
      this.drop(name);
      throw err;
    }
    return new Rel(table.columns, quoteIdent(name), [], table.rowCount, [name]);
  }

  input(value: SqlRelation): SqlInput {
    const rel = this.rel(value);
    return { ref: rel.ref, columns: rel.columns };
  }

  derive(inputs: readonly SqlRelation[], query: SqlQuery, owner: SqlOwner): SqlRelation {
    const rels = inputs.map((r) => this.rel(r));
    counter += 1;
    const cte: Cte = {
      name: `"hr$q${counter}"`,
      sql: query.sql,
      params: query.params,
      columns: query.columns,
      owner,
    };
    const bases = [...new Set(rels.flatMap((r) => r.bases))];
    return new Rel(query.columns, cte.name, [...mergeCtes(rels), cte], null, bases);
  }

  /**
   * A chain failed: probe its steps in order, each with a count over every column (so no
   * column is skipped; nothing is materialised), and report the error at the first step whose
   * probe fails. No probe fails → `failure` (the error of the statement itself). Error path only.
   */
  private blame(ctes: readonly Cte[], failure: Error): Error {
    for (let k = 0; k < ctes.length; k++) {
      const cte = ctes[k]!;
      const w = withClause(ctes.slice(0, k + 1));
      const counts = ['count(*)', ...cte.columns.map((c) => `count(${quoteIdent(c.key)})`)];
      try {
        this.db.query(`${w.sql}SELECT ${counts.join(', ')} FROM ${cte.name}`, w.params);
      } catch (err) {
        const found = toEngineError(err, cte.owner.label);
        if (found instanceof EngineError) return found.atNode(cte.owner.id);
        return found;
      }
    }
    return failure;
  }

  count(inputs: readonly SqlRelation[], warning: SqlCountWarning, node: string): number {
    const ctes = mergeCtes(inputs.map((r) => this.rel(r)));
    const w = withClause(ctes);
    try {
      return Number(this.db.scalar(`${w.sql}${warning.sql}`, [...w.params, ...warning.params]));
    } catch (err) {
      throw this.blame(ctes, toEngineError(err, node));
    }
  }

  materialize(value: SqlRelation, node: string): SqlRelation {
    const rel = this.rel(value);
    if (rel.ctes.length === 0) return rel;
    const name = this.tableName();
    this.created.add(name);
    const w = withClause(rel.ctes);
    const cols = rel.columns.map((c) => quoteIdent(c.key));
    cols.push(`row_number() OVER (ORDER BY ${ORD_SQL}) AS ${ORD_SQL}`);
    try {
      this.run(
        `CREATE TABLE ${quoteIdent(name)} AS ${w.sql}SELECT ${cols.join(', ')} FROM ${rel.ref}`,
        w.params,
        node,
      );
    } catch (err) {
      this.drop(name);
      throw this.blame(rel.ctes, err instanceof Error ? err : toEngineError(err, node));
    }
    let rows: number;
    try {
      rows = Number(this.db.scalar(`SELECT count(*) FROM ${quoteIdent(name)}`));
    } catch (err) {
      this.drop(name);
      throw toEngineError(err, node);
    }
    return new Rel(rel.columns, quoteIdent(name), [], rows, [name]);
  }

  read(value: SqlRelation, node: string): Table {
    const rel = this.rel(value);
    const done = this.materialize(rel, node) as Rel;
    const name = done.bases[0]!;
    try {
      const table = readTable(this.db, name, { columns: rel.columns, node });
      return table;
    } finally {
      // A table made only for this read is not needed afterwards.
      if (done !== rel && (this.refs.get(name) ?? 0) === 0) this.drop(name);
    }
  }

  retain(value: SqlRelation): void {
    for (const name of this.rel(value).bases) this.refs.set(name, (this.refs.get(name) ?? 0) + 1);
  }

  release(value: SqlRelation): void {
    for (const name of this.rel(value).bases) {
      const left = (this.refs.get(name) ?? 1) - 1;
      if (left > 0) this.refs.set(name, left);
      else this.drop(name);
    }
  }

  dispose(): void {
    for (const name of [...this.created]) this.drop(name);
  }
}

/**
 * The runtime provider of the engine worker (`ExecuteOptions.sql`): loads DuckDB on first use
 * (lazy load, spec §13.1) and opens a scope for one run.
 */
export async function loadSqlScope(onProgress?: (p: LoadProgress) => void): Promise<SqlScope> {
  return new SqlScope(await loadDuckDb(onProgress));
}
