// The games and the Almanac are Apps tiles with their own dot, not library cards; the status row has no dot.
//
//   ZIMI_MANAGE_OPEN=1 ZIMI_TORRENT=0 ZIMI_OFFLINE=1 ZIM_DIR=<empty dir> python3 -m zimi serve --port 9075
//   BASE_URL=http://localhost:9075 npx playwright test --config=tests/playwright.config.mjs tests/test_home_dots.spec.mjs

import { test, expect } from '@playwright/test';

const BASE = process.env.BASE_URL || 'http://localhost:9075';
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

async function home(page) {
  await page.goto(BASE);
  await page.evaluate(() => { localStorage.clear(); });
  await page.goto(BASE);
  await page.waitForFunction(() => typeof renderHome === 'function' && zimsCache && zimsCache.length >= 2);
  await page.evaluate(() => {
    const now = Date.now() / 1000, old = now - 20 * 86400, base = zimsCache[1];
    zimsCache.forEach((z) => { z.first_seen = old; });
    zimsCache.push(Object.assign({}, base, { name: 'extra_one', title: 'Extra One', first_seen: now - 7200, updated_at: null, category: 'Wikipedia' }));
    zimsCache.push(Object.assign({}, base, { name: 'extra_two', title: 'Extra Two', first_seen: old, updated_at: now - 100, category: 'Wikipedia' }));
    zimsCache[0].updated_at = now - 3600;   // an own ZIM, updated
    _libStart = { list: null, at: 0 }; _rebuildZimsMap(); renderHome();
  });
}

test('the own ZIMs are Apps tiles with a dot, and not library cards', async ({ page }) => {
  await home(page);
  await expect(page.locator('.app-tile.games-tile .rc-dot.tile.updated')).toHaveCount(1);
  await expect(page.locator('.stat-card[data-zim="zimi_games"]')).toHaveCount(0);
  await expect(page.locator('.stat-card[data-zim="zimi_almanac"]')).toHaveCount(0);
  await expect(page.locator('.stat-card[data-zim="extra_one"]')).toHaveCount(1);
});

test('the status row carries no dot, and a ZIM card keeps its own', async ({ page }) => {
  await home(page);
  await expect(page.locator('.stats-bar .rc-dot')).toHaveCount(0);
  await expect(page.locator('.stat-card[data-zim="extra_one"]')).toHaveCount(1);
});

test('behind a login gate the activity poll logs nothing', async ({ page }) => {
  // A gate (Cloudflare Access) answers /manage/activity with a redirect to another origin; a followed fetch is a
  // blocked request ("access control checks") in the console every few seconds.
  const bad = [];
  page.on('console', (m) => { if (m.type() === 'error') bad.push(m.text()); });
  page.on('requestfailed', (r) => { if (r.url().includes('127.0.0.1:9')) bad.push('followed to ' + r.url()); });   // the gate's origin: never followed
  await page.route('**/manage/activity', (route) => route.fulfill({ status: 302, headers: { location: 'http://127.0.0.1:9/login' } }));
  await page.goto(BASE);
  await page.waitForFunction(() => typeof _pollActivity === 'function' && zimsCache && zimsCache.length >= 2);
  await page.evaluate(() => _pollActivity());
  await page.waitForTimeout(1500);
  expect(bad.filter((t) => /activity|access control|CORS|127\.0\.0\.1:9/i.test(t))).toEqual([]);
});
