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
}

export class EngineError extends Error {
  readonly messageKey: string;
  readonly params: ErrorVars;
  readonly nodeId: string | undefined;
  readonly path: FieldPath | undefined;

  constructor(
    messageKey: string,
    params: ErrorVars = {},
    where: { nodeId?: string; path?: FieldPath } = {},
  ) {
    super(messageKey);
    this.name = 'EngineError';
    this.messageKey = messageKey;
    this.params = params;
    this.nodeId = where.nodeId;
    this.path = where.path;
  }

  /** The same error attached to `nodeId`, unless it already names a node. */
  atNode(nodeId: string): EngineError {
    if (this.nodeId !== undefined) return this;
    return new EngineError(this.messageKey, this.params, { nodeId, path: this.path });
  }

  toInfo(): EngineErrorInfo {
    return {
      messageKey: this.messageKey,
      params: this.params,
      ...(this.nodeId === undefined ? {} : { nodeId: this.nodeId }),
      ...(this.path === undefined ? {} : { path: this.path }),
    };
  }
}

export function isEngineError(err: unknown): err is EngineError {
  return err instanceof EngineError;
}
