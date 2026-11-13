// Node-only values for playwright.config.ts. Plain JavaScript so the typed E2E code needs no
// @types/node (not in 02 §1.1); the types are declared in node-env.d.mts.
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The browser pre-installed on the agent machine; elsewhere Playwright's own Chromium is used.
const PREINSTALLED_CHROMIUM = '/opt/pw-browsers/chromium';

export const chromiumExecutable = existsSync(PREINSTALLED_CHROMIUM)
  ? PREINSTALLED_CHROMIUM
  : undefined;

// Test output never lands in the repository.
export const outputDir = join(tmpdir(), 'hrflow-e2e', 'test-results');
