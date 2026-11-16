/**
 * Engine errors (spec §12.1, 03 §4.7, 07 §6): an i18n key of `locales/vi/engine.json`
 * (`<node>.error.<code>`, e.g. `executor.error.cycle`) plus variables. Variables are counts, row
 * numbers, node ids or labels, column keys or titles, port and sheet names: never cell values. The
 * `Error` message is the key only, so a logged error carries no data.
 */
export type ErrorVars = Readonly<Record<string, string | number>>;

/** Path of the config field at fault, e.g. `['columns', 0, 'key']` (Designer highlights it). */
export type FieldPath = readonly (string | number)[];

/** Plain form of an `EngineError` that crosses the worker boundary. */
export interface EngineErrorInfo {
  readonly messageKey: string;
  readonly params: ErrorVars;
  readonly nodeId?: string;
  readonly path?: FieldPath;
  /** Screen-only text (see `EngineError.detail`); never logged, never in a run log. */
  readonly detail?: string;
}

/** What a run log may keep of an error (03 §4.7): the key and the node, nothing else. */
export interface EngineErrorLog {
  readonly messageKey: string;
  readonly nodeId?: string;
}

/** Longest screen-only detail kept (spec §12.1.8: DuckDB's own message, at most 500 characters). */
export const MAX_DETAIL_LENGTH = 500;

export class EngineError extends Error {
  readonly messageKey: string;
  readonly params: ErrorVars;
  readonly nodeId: string | undefined;
  readonly path: FieldPath | undefined;
  /**
   * Text shown only on the screen of the machine that ran the flow, e.g. DuckDB's own message for
   * `sql.error.syntax` / `sql.error.runtime` (spec §12.1.8; it may quote cell values). It fills the
   * `{{message}}` of the text but is not a param: never logged, never in a run log (owner 2A,
   * MEMORY 2026-11-16). Cut to `MAX_DETAIL_LENGTH` characters.
   */
  readonly detail: string | undefined;

  constructor(
    messageKey: string,
    params: ErrorVars = {},
    where: { nodeId?: string; path?: FieldPath; detail?: string } = {},
  ) {
    super(messageKey);
    this.name = 'EngineError';
    this.messageKey = messageKey;
    this.params = params;
    this.nodeId = where.nodeId;
    this.path = where.path;
    this.detail = where.detail?.slice(0, MAX_DETAIL_LENGTH);
  }

  /** The same error attached to `nodeId`, unless it already names a node. */
  atNode(nodeId: string): EngineError {
    if (this.nodeId !== undefined) return this;
    return new EngineError(this.messageKey, this.params, {
      nodeId,
      path: this.path,
      detail: this.detail,
    });
  }

  /** For the screen (crosses the worker boundary), `detail` included. */
  toInfo(): EngineErrorInfo {
    return {
      messageKey: this.messageKey,
      params: this.params,
      ...(this.nodeId === undefined ? {} : { nodeId: this.nodeId }),
      ...(this.path === undefined ? {} : { path: this.path }),
      ...(this.detail === undefined ? {} : { detail: this.detail }),
    };
  }

  /** For a run log (`run_logs.error_code`, error node): the key and node only (03 §4.7). */
  toLog(): EngineErrorLog {
    return {
      messageKey: this.messageKey,
      ...(this.nodeId === undefined ? {} : { nodeId: this.nodeId }),
    };
  }
}

export function isEngineError(err: unknown): err is EngineError {
  return err instanceof EngineError;
}
