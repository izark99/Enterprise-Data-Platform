import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';
import { duckDbBrowserBindings, duckDbWasm } from './build/duckdb-wasm.ts';
import { E2E_MODE, e2eHarnessGuard, HARNESS_PAGE } from './build/e2e-harness.ts';

// `vite preview` sends the production security headers (docs/redesign/06-plan.md T-R1-01), so E2E
// runs under the CSP of `public/_headers`. HSTS is left out: it would pin `localhost` to HTTPS.
const PREVIEW_OMITTED_HEADERS = new Set(['strict-transport-security']);

function readProductionHeaders(): Record<string, string> {
  const file = fileURLToPath(new URL('public/_headers', import.meta.url));
  const headers: Record<string, string> = {};
  let inAllPaths = false;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    if (!/^\s/.test(line)) {
      inAllPaths = line.trim() === '/*';
      continue;
    }
    if (!inAllPaths) continue;
    const colon = line.indexOf(':');
    if (colon < 0) throw new Error(`public/_headers: malformed header line "${line.trim()}"`);
    const name = line.slice(0, colon).trim();
    if (PREVIEW_OMITTED_HEADERS.has(name.toLowerCase())) continue;
    headers[name] = line.slice(colon + 1).trim();
  }
  if (!headers['Content-Security-Policy']) {
    throw new Error('public/_headers: no Content-Security-Policy in the /* block');
  }
  return headers;
}

export default defineConfig(({ mode }) => ({
  plugins: [react(), tailwindcss(), duckDbWasm(), e2eHarnessGuard()],
  // The engine E2E harness page (A-06-7) is a second entry only in `--mode e2e`.
  build:
    mode === E2E_MODE
      ? {
          rolldownOptions: {
            input: {
              index: fileURLToPath(new URL('index.html', import.meta.url)),
              e2eEngine: fileURLToPath(new URL(HARNESS_PAGE, import.meta.url)),
            },
          },
        }
      : {},
  // The engine worker is bundled with its own plugin list (spec §13.1: DuckDB runs in the worker).
  // ES module workers: the engine code may load parts lazily (`import()`).
  worker: {
    format: 'es' as const,
    plugins: () => [duckDbBrowserBindings()],
  },
  preview: {
    headers: readProductionHeaders(),
  },
  test: {
    include: ['src/**/*.test.{ts,tsx}'],
  },
}));
