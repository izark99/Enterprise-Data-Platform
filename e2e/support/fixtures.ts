// Shared E2E fixtures. Import `test` and `expect` from here, not from '@playwright/test'.
import { test as base, expect } from '@playwright/test';

interface Fixtures {
  /** URLs of every request made to an origin other than the app's (whole browser context). */
  offOriginRequests: string[];
}

// data: and blob: URLs are built in the page and never leave the browser.
const LOCAL_SCHEMES = new Set(['data:', 'blob:']);

export const test = base.extend<Fixtures>({
  offOriginRequests: async ({ context, baseURL }, use) => {
    if (!baseURL) throw new Error('baseURL is not configured');
    const appOrigin = new URL(baseURL).origin;
    const offOrigin: string[] = [];
    context.on('request', (request) => {
      const url = new URL(request.url());
      if (!LOCAL_SCHEMES.has(url.protocol) && url.origin !== appOrigin) offOrigin.push(url.href);
    });
    await use(offOrigin);
  },
});

export { expect };
