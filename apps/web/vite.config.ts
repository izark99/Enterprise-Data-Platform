import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

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

export default defineConfig({
  plugins: [react(), tailwindcss()],
  preview: {
    headers: readProductionHeaders(),
  },
  test: {
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
