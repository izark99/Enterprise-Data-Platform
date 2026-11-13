// Production CSP (docs/redesign/06-plan.md T-R1-01): `vite preview` serves the headers of
// `apps/web/public/_headers`, and the app loads under that policy without any violation.
import { productionCsp } from '../support/node-env.mjs';
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
