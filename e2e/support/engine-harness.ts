// Test API of the engine E2E harness page `e2e-engine.html` (E2E build only, T-R1-08):
// `apps/web/src/e2e-engine/harness.ts` puts it on `window`. Shared so every spec sees one type.

export interface EngineErrorReply {
  engine: true;
  message: string;
  info: {
    messageKey: string;
    params: Record<string, string | number>;
    nodeId?: string;
    path?: (string | number)[];
    detail?: string;
  };
  log: Record<string, unknown>;
}

export type HarnessReply =
  | { id: number; ok: true; value: unknown }
  | {
      id: number;
      ok: false;
      error: EngineErrorReply | { engine: false; name: string; message: string };
    };

declare global {
  interface Window {
    __hrflowEngineHarness?: { call(op: string, ...args: unknown[]): Promise<HarnessReply> };
  }
}
