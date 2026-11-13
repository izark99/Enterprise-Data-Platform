// Data boundary (CLAUDE.md rule 1): the app calls no other origin and stores nothing in the browser.
import { expect, test } from '../support/fixtures';

test('loads without any request to another origin', async ({ page, offOriginRequests }) => {
  await page.goto('/', { waitUntil: 'networkidle' });
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  expect(offOriginRequests).toEqual([]);
});

test('leaves localStorage, sessionStorage and IndexedDB empty', async ({ page }) => {
  await page.goto('/', { waitUntil: 'networkidle' });
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  const storage = await page.evaluate(async () => ({
    localStorage: Object.keys(window.localStorage),
    sessionStorage: Object.keys(window.sessionStorage),
    indexedDB: (await window.indexedDB.databases()).map((db) => db.name ?? ''),
  }));
  expect(storage).toEqual({ localStorage: [], sessionStorage: [], indexedDB: [] });
});
