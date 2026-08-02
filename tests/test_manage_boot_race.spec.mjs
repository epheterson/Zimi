// The settings gear is live before the library finishes loading (#44). That
// makes the rest of boot a race: /list can settle minutes later on a large
// library, and whatever it does then must not paint over the manage view the
// user already opened.
//
// Start a server first, then:
//   BASE_URL=http://localhost:8873 npx playwright test \
//     --config=tests/playwright.config.mjs tests/test_manage_boot_race.spec.mjs

import { test, expect } from '@playwright/test';

const BASE = process.env.BASE_URL || 'http://localhost:8873';
const LIST_DELAY_MS = 6000;   // stands in for a large library
const CLICK_AT_MS = 1500;     // gear used well before /list returns

test('manage opened during a slow library load survives /list settling', async ({ page }) => {
  test.setTimeout(60000);
  await page.route('**/list*', async (route) => {
    await new Promise((r) => setTimeout(r, LIST_DELAY_MS));
    await route.continue();
  });
  await page.goto(BASE, { waitUntil: 'commit' });
  await page.waitForTimeout(CLICK_AT_MS);
  await page.locator('#manage-btn').click();
  await expect(page.locator('#manage-status')).toBeAttached();

  // Let /list resolve and the secondary boot finish.
  await page.waitForTimeout(LIST_DELAY_MS + 2500);

  // Manage is still mounted, and the home view has not been drawn underneath it.
  await expect(page.locator('#manage-status')).toBeAttached();
  await expect(page.locator('.manage-tab-content')).not.toHaveCount(0);
  await expect(page.locator('.stat-card')).toHaveCount(0);
});
