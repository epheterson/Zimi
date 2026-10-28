// Home's status row: a solid amber dot for what was added and a ring for what was updated since you opened it, with
// counts; a tap is the recent filter, a second tap lets go. The games and the Almanac are Apps tiles, not library cards.
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

test('the status row has an amber dot and a ring with counts; a tap filters, again lets go', async ({ page }) => {
  await home(page);
  const added = page.locator('.stats-bar .rc-dot.added'), updated = page.locator('.stats-bar .rc-dot.updated');
  await expect(added).toHaveText('1');
  await expect(updated).toHaveText('1');
  await added.tap();
  await expect(page.locator('.stat-card[data-zim="extra_one"]')).toHaveCount(1);
  await expect(page.locator('.stat-card[data-zim="extra_two"]')).toHaveCount(0);
  await page.locator('.stats-bar .rc-dot.added').tap();
  await expect(page.locator('.stat-card[data-zim="extra_two"]')).toHaveCount(1);
});

test('opening a ZIM clears its dot', async ({ page }) => {
  await home(page);
  await page.evaluate(() => { _markZimOpened('extra_one'); renderHome(); });
  await expect(page.locator('.stats-bar .rc-dot.added')).toHaveCount(0);
  await expect(page.locator('.stats-bar .rc-dot.updated')).toHaveCount(1);
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
