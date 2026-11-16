/**
 * Messages between the E2E harness page and its engine worker (E2E build only, A-06-7, T-R1-08).
 * Fake data only: the specs build every table themselves; nothing is read from disk.
 */

/** A cell sent to the worker: decimals travel as `{ dec: '<text>' }`. */
export type WireCell = string | number | boolean | null | { readonly dec: string };

export interface WireColumn {
  readonly key: string;
  readonly title: string;
  readonly type: string;
}

export interface WireTable {
  readonly columns: readonly WireColumn[];
  readonly rows: readonly (readonly WireCell[])[];
}

/** An error as the screen and the run log would see it. */
export type WireError =
  | {
      readonly engine: true;
      readonly message: string;
      readonly info: Readonly<Record<string, unknown>>;
      readonly log: Readonly<Record<string, unknown>>;
    }
  | { readonly engine: false; readonly name: string; readonly message: string };

export type HarnessReply =
  | { readonly id: number; readonly ok: true; readonly value: unknown }
  | { readonly id: number; readonly ok: false; readonly error: WireError };

export interface HarnessRequest {
  readonly id: number;
  readonly op: string;
  readonly args: readonly unknown[];
}
