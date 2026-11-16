import type { HarnessReply, HarnessRequest } from './protocol';

/**
 * Engine E2E harness page (A-06-7, brought forward to T-R1-08; built only with `--mode e2e`, never
 * in production: `build/e2e-harness.ts`). It starts the harness engine worker and puts a small test
 * API on `window.__hrflowEngineHarness`: `call(op, ...args)` posts to the worker and resolves with
 * the JSON reply. Playwright drives it with fake data only.
 */

declare global {
  interface Window {
    __hrflowEngineHarness?: {
      call(op: string, ...args: unknown[]): Promise<HarnessReply>;
    };
  }
}

const worker = new Worker(new URL('./engine-worker.ts', import.meta.url), { type: 'module' });
const waiting = new Map<number, (reply: HarnessReply) => void>();
let nextId = 0;

worker.addEventListener('message', (event: MessageEvent<HarnessReply>) => {
  const done = waiting.get(event.data.id);
  waiting.delete(event.data.id);
  done?.(event.data);
});

window.__hrflowEngineHarness = {
  call(op, ...args) {
    nextId += 1;
    const id = nextId;
    const request: HarnessRequest = { id, op, args };
    return new Promise((resolve) => {
      waiting.set(id, resolve);
      worker.postMessage(request);
    });
  },
};

const status = document.getElementById('status');
if (status) status.textContent = 'ready';
