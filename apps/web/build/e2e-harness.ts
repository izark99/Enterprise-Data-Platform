import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import type { Plugin, ResolvedConfig } from 'vite';

/**
 * The engine E2E harness page (`e2e-engine.html` + `src/e2e-engine/`, A-06-7, T-R1-08) is built
 * only with `--mode e2e`. Any other build fails when its output holds the page or harness code
 * (found by `HARNESS_MARKER`, a string the harness code contains).
 */

export const E2E_MODE = 'e2e';
export const HARNESS_PAGE = 'e2e-engine.html';
/** Name of the test API the harness puts on `window`; present in every harness bundle. */
export const HARNESS_MARKER = '__hrflowEngineHarness';

function listFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? listFiles(path) : [path];
  });
}

/** Files of `outDir` that are, or contain, harness code (relative to `outDir`). */
export function harnessFiles(outDir: string): string[] {
  return listFiles(outDir)
    .filter(
      (file) =>
        file.endsWith(HARNESS_PAGE) ||
        (/\.(html|js|mjs)$/.test(file) && readFileSync(file, 'utf8').includes(HARNESS_MARKER)),
    )
    .map((file) => relative(outDir, file));
}

export function e2eHarnessGuard(): Plugin {
  let config: ResolvedConfig | undefined;
  return {
    name: 'hrflow:e2e-harness-guard',
    configResolved(resolved) {
      config = resolved;
    },
    closeBundle() {
      if (config?.command !== 'build' || config.mode === E2E_MODE) return;
      const outDir = resolve(config.root, config.build.outDir);
      if (!existsSync(outDir)) return;
      const found = harnessFiles(outDir);
      if (found.length > 0) {
        throw new Error(`The E2E harness must not be in a production build: ${found.join(', ')}`);
      }
    },
  };
}
