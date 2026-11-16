// Production CSP (docs/redesign/06-plan.md T-R1-01): `vite preview` serves the headers of
// `apps/web/public/_headers`, and the app loads under that policy without any violation.
import { productionCsp } from '../support/node-env.mjs';
import '../support/engine-harness';
import { expect, test } from '../support/fixtures';

declare global {
  interface Window {
    __cspViolations?: string[];
  }
}

test('serves the Content-Security-Policy of _headers', async ({ request }) => {
  const response = await request.get('/');
  expect(response.ok()).toBe(true);
  expect(response.headers()['content-security-policy']).toBe(productionCsp);
});

test('loads without any CSP violation', async ({ page }) => {
  const cspConsoleErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error' && /content security policy/i.test(message.text())) {
      cspConsoleErrors.push(message.text());
    }
  });
  // Registered before any page script runs, so a violation during start-up is recorded too.
  await page.addInitScript(() => {
    window.__cspViolations = [];
    document.addEventListener('securitypolicyviolation', (event) => {
      window.__cspViolations?.push(`${event.violatedDirective} ${event.blockedURI}`);
    });
  });

  await page.goto('/', { waitUntil: 'networkidle' });
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

  const violations = await page.evaluate(() => window.__cspViolations ?? []);
  expect(violations).toEqual([]);
  expect(cspConsoleErrors).toEqual([]);
});

// The engine E2E harness page (E2E build only): DuckDB, its `.wasm` parts and the `json` extension
// (loaded by DuckDB itself before the lock) start under the same policy, from the app origin only.
test('the engine harness loads DuckDB and the json extension without any CSP violation', async ({
  page,
  offOriginRequests,
}) => {
  const cspConsoleErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error' && /content security policy/i.test(message.text())) {
      cspConsoleErrors.push(message.text());
    }
  });
  await page.addInitScript(() => {
    window.__cspViolations = [];
    document.addEventListener('securitypolicyviolation', (event) => {
      window.__cspViolations?.push(`${event.violatedDirective} ${event.blockedURI}`);
    });
  });

  const response = await page.goto('/e2e-engine.html');
  expect(response?.headers()['content-security-policy']).toBe(productionCsp);
  await expect(page.locator('#status')).toHaveText('ready');
  // The guard needs `json_serialize_sql`: it works only when the extension loaded.
  const reply = await page.evaluate(() =>
    window.__hrflowEngineHarness!.call('check', 'SELECT * FROM luong', ['luong'], []),
  );
  expect(reply.ok).toBe(true);

  const violations = await page.evaluate(() => window.__cspViolations ?? []);
  expect(violations).toEqual([]);
  expect(cspConsoleErrors).toEqual([]);
  expect(offOriginRequests).toEqual([]);
});
