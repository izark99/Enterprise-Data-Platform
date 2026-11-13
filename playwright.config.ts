// E2E harness (docs/redesign/06-plan.md T-R0-03): Playwright against `vite preview` of the
// `build:e2e` output. `pnpm test:e2e` builds first; traces are off unless `--trace on` is passed.
import { defineConfig, devices } from '@playwright/test';
import { chromiumExecutable, outputDir } from './e2e/support/node-env.mjs';

const PORT = 4173;

export default defineConfig({
  testDir: 'e2e',
  testMatch: '**/*.spec.ts',
  outputDir,
  fullyParallel: true,
  reporter: 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'off',
    screenshot: 'off',
    video: 'off',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: chromiumExecutable ? { executablePath: chromiumExecutable } : {},
      },
    },
  ],
  webServer: {
    command: `pnpm --filter @hrflow/web exec vite preview --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: false,
  },
});
