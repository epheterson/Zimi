// Almanac hero clock — the live "now" header must read the VIEWER's own local
// time, never a stale/wrong stored almanac location's derived zone.
//
// Regression: a western longitude persisted with the wrong sign (e.g. Denver's
// -104.99 stored as +104.99) resolves to a far-eastern zone (GMT+8); the hero
// then painted "tomorrow morning" onto today's sky even though the device clock
// and timezone were correct. The live clock now always uses the device zone;
// only a scrubbed (non-today) focus keeps the location zone.
//
// Start a server first (no ZIMs needed):
//   ZIM_DIR=/tmp/zimi-empty python3 -m zimi serve --port 8877
// Run:
//   BASE_URL=http://localhost:8877 npx playwright test --config=tests/playwright.config.mjs tests/test_almanac_hero_clock.spec.mjs

import { test, expect } from '@playwright/test';

const BASE = process.env.BASE_URL || 'http://localhost:8877';

// 8:30pm Mountain on Jul 21 2026. The browser context's own zone is whatever
// Playwright provides; the point is that a far-eastern STORED location must not
// drag the live clock to the next morning.
const FIXED = new Date('2026-07-21T20:30:00-06:00');

async function heroFirstTwoLines(page) {
  return page.evaluate(() => {
    const head = document.getElementById('almanac-head');
    return head ? head.innerText.split('\n').slice(0, 2).join(' | ') : 'NO HEAD';
  });
}

async function openAlmanac(page, loc) {
  await page.goto(BASE);
  // Session-scoped, matching the app: the almanac location never persists.
  await page.evaluate(() => sessionStorage.removeItem('zimi_almanac_location'));
  if (loc) {
    await page.evaluate((l) => sessionStorage.setItem('zimi_almanac_location', JSON.stringify(l)), loc);
  }
  await page.goto(`${BASE}/#almanac`);
  await page.waitForTimeout(1500);
}

test.describe('Almanac hero clock', () => {
  test.beforeEach(async ({ page }) => {
    await page.clock.setFixedTime(FIXED);
  });

  test('sign-flipped stored location does NOT show tomorrow morning', async ({ page }) => {
    // -104.99 persisted as +104.99 → nearest anchor is a GMT+8 zone.
    await openAlmanac(page, { lat: 39.74, lon: 104.99, name: 'Denver' });
    const line = await heroFirstTwoLines(page);
    // The device's own "now" is still July 21 evening — never the 22nd, never AM.
    expect(line).toContain('July 21, 2026');
    expect(line).toContain('PM');
    expect(line).not.toContain('July 22');
    expect(line).not.toContain('GMT+8');
  });

  test('a correct local stored location shows the local evening time', async ({ page }) => {
    await openAlmanac(page, { lat: 39.74, lon: -104.99, name: 'Denver' });
    const line = await heroFirstTwoLines(page);
    expect(line).toContain('July 21, 2026');
    expect(line).toContain('PM');
  });

  test('fresh browser (no stored location) shows the device evening time', async ({ page }) => {
    await openAlmanac(page, null);
    const line = await heroFirstTwoLines(page);
    expect(line).toContain('July 21, 2026');
    expect(line).toContain('PM');
  });

  test('a scrubbed non-today focus still uses the stored location zone', async ({ page }) => {
    await openAlmanac(page, { lat: 39.74, lon: 104.99, name: 'Denver' });
    // A future date has no "now", so its header honors the location's zone.
    const line = await page.evaluate(() => {
      const future = new Date(Date.now() + 3 * 86400000);
      const tmp = document.createElement('div');
      tmp.innerHTML = _almHeadHtml(future);
      return tmp.innerText.split('\n').slice(0, 2).join(' | ');
    });
    expect(line).toContain('GMT+8');
  });
});
