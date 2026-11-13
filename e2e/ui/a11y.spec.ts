// Accessibility: axe finds no violation on the placeholder page.
import { AxeBuilder } from '@axe-core/playwright';
import { expect, test } from '../support/fixtures';

test('placeholder page has no axe violations', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
});
