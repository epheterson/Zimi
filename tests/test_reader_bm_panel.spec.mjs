// Reader bookmarks panel (#65) + almanac month glide (#75).
//
// #65 — while reading, the #bm-panel-btn in the reader chrome opens the
// existing bookmarks tree as an overlay above the article; Escape closes the
// panel first (never the reader), and picking a bookmark navigates the reader.
// #75 — a month change in the almanac calendar slides the incoming grid in,
// but stays inert on the time-machine travel path (frozen layout / motion
// face), whose per-frame repaints the animation must never fight.
//
// Start a server first (uses the Bookmarks*.zim fixtures for real articles):
//   ZIM_DIR=/tmp/zimi-empty python3 -m zimi serve --port 8873
// Run:
//   BASE_URL=http://localhost:8873 npx playwright test \
//     --config=tests/playwright.config.mjs tests/test_reader_bm_panel.spec.mjs

import { test, expect } from '@playwright/test';

const BASE = process.env.BASE_URL || 'http://localhost:8873';

const BOOKMARKS = [
  { zim: 'Bookmarks-3', path: 'A/0_Aspirin', title: 'Aspirin', folder: '', order: 0 },
  { zim: 'Bookmarks-3', path: 'Title', title: 'Title page', folder: '', order: 1 },
];

// Open the reader on a real article with bookmarks seeded in storage.
async function openReaderWithBookmarks(page) {
  await page.goto(BASE);
  await page.evaluate((bm) => {
    localStorage.setItem('zimi_bookmarks', JSON.stringify(bm));
    localStorage.removeItem('zimi_bm_folders');
    localStorage.removeItem('zimi_bm_collapsed');
  }, BOOKMARKS);
  await page.goto(BASE + '/?a=Bookmarks-3/A/0_Aspirin');
  await page.waitForSelector('#reader.open');
}

test.describe('Reader bookmarks panel (#65)', () => {
  test('button shows only while reading and opens the tree over the article', async ({ page }) => {
    await page.goto(BASE);
    await expect(page.locator('#bm-panel-btn')).toBeHidden(); // home: library-btn already covers it
    await openReaderWithBookmarks(page);
    await expect(page.locator('#bm-panel-btn')).toBeVisible();
    await page.click('#bm-panel-btn');
    await expect(page.locator('#history-panel')).toHaveClass(/open/);
    // The one true tree renderer, over an untouched reader.
    await expect(page.locator('#bm-tree .bm-bk')).toHaveCount(2);
    await expect(page.locator('#reader')).toHaveClass(/open/);
    await expect(page.locator('#bm-panel-btn')).toHaveClass(/panel-open/);
  });

  test('Escape closes the panel first, not the reader', async ({ page }) => {
    await openReaderWithBookmarks(page);
    await page.click('#bm-panel-btn');
    await expect(page.locator('#history-panel')).toHaveClass(/open/);
    await page.keyboard.press('Escape');
    await expect(page.locator('#history-panel')).not.toHaveClass(/open/);
    await expect(page.locator('#reader')).toHaveClass(/open/);
  });

  test('picking a bookmark navigates the reader in place', async ({ page }) => {
    await openReaderWithBookmarks(page);
    await page.click('#bm-panel-btn');
    await page.click('.bm-row.bm-bk[data-path="Title"]');
    await expect(page.locator('#history-panel')).not.toHaveClass(/open/);
    await expect(page.locator('#reader')).toHaveClass(/open/);
    await expect(page).toHaveTitle(/Title/);
  });

  test('panel fits and scrolls on a 390px viewport', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openReaderWithBookmarks(page);
    await expect(page.locator('#bm-panel-btn')).toBeVisible();
    await page.click('#bm-panel-btn');
    const fits = await page.evaluate(() => {
      const r = document.getElementById('history-panel').getBoundingClientRect();
      return r.width <= innerWidth && r.right <= innerWidth + 1 &&
        document.documentElement.scrollWidth <= innerWidth + 1;
    });
    expect(fits).toBe(true);
  });
});

test.describe('Almanac month glide (#75)', () => {
  async function openCalendar(page) {
    await page.goto(BASE);
    await page.evaluate(() => openAlmanac());
    await page.waitForSelector('#almanac-calendar .alm-grid');
  }
  const gridClass = (page) =>
    page.evaluate(() => document.querySelector('#almanac-calendar .alm-grid').className);

  test('month changes glide directionally; same-month repaints do not', async ({ page }) => {
    await openCalendar(page);
    await page.evaluate(() => _almNext());
    expect(await gridClass(page)).toContain('alm-glide-next');
    await page.waitForTimeout(300);
    await page.evaluate(() => _almPrev());
    expect(await gridClass(page)).toContain('alm-glide-prev');
    await page.waitForTimeout(300);
    // Picking a day inside the visible month repaints without a glide.
    await page.evaluate(() => {
      const day = document.querySelector('#almanac-calendar .alm-day');
      _almSelectDay(Number(day.getAttribute('onclick').match(/\d+/)[0]));
    });
    expect(await gridClass(page)).not.toContain('alm-glide');
    // A day pick that lands in another month glides — the #75 ask.
    await page.waitForTimeout(300);
    await page.evaluate(() => _almSelectDay(_gregorianToJDN(_almYear, _almMonth, 15) + 40));
    expect(await gridClass(page)).toContain('alm-glide-next');
  });

  test('travel path stays inert: no glide while frozen or in motion', async ({ page }) => {
    await openCalendar(page);
    const cls = await page.evaluate(() => {
      const out = {};
      _almTravelFreeze();
      _almMonth = (_almMonth % 12) + 1;
      _drawAlmanacGrid();
      out.frozen = document.querySelector('#almanac-calendar .alm-grid').className;
      _almTravelUnfreeze();
      _almTmMode('motion');
      _almMonth = (_almMonth % 12) + 1;
      _drawAlmanacGrid();
      out.motion = document.querySelector('#almanac-calendar .alm-grid').className;
      _almTmMode('rest');
      return out;
    });
    expect(cls.frozen).not.toContain('alm-glide');
    expect(cls.motion).not.toContain('alm-glide');
  });
});
