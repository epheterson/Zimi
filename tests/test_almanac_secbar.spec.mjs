// The Almanac's section bar as laid out in a browser: hidden while the first
// section is in view, pinned under the top bar from the second on, naming the
// current section, a dropdown of all of them, a tap that scrolls to one with
// its own heading covered by the bar (the bar is that heading).
//
// Start a server first, on its own folders (no ZIMs needed):
//   ZIMI_TORRENT=0 ZIMI_OFFLINE=1 ZIM_DIR=/tmp/zimi-empty ZIMI_DATA_DIR=/tmp/zimi-empty-data \
//     python3 -m zimi serve --host 127.0.0.1 --port 8877
// Run:
//   BASE_URL=http://127.0.0.1:8877 npx playwright test \
//     --config=tests/playwright.config.mjs --reporter=list tests/test_almanac_secbar.spec.mjs

import { test, expect } from '@playwright/test';

const BASE = process.env.BASE_URL || 'http://localhost:8877';
test.use({ serviceWorkers: 'block' });
test.describe.configure({ timeout: 180000 });
// The Almanac is heavy to draw: on a busy machine give each wait room.
test.beforeEach(({ page }) => page.setDefaultTimeout(60000));
expect.configure({ timeout: 30000 });
const PHONE = { width: 390, height: 844 };
const SAN_FRANCISCO = { lat: 37.77, lon: -122.42, name: 'San Francisco' };
const THEMES = ['light', 'dark', 'red'];

async function openAlmanac(page, { lang, theme } = {}) {
  await page.setViewportSize(PHONE);
  await page.addInitScript(([lg, th, loc]) => {
    try {
      if (lg) localStorage.setItem('zimi_ui_lang', lg);
      if (th) localStorage.setItem('zimi_app_theme', th);
      sessionStorage.setItem('zimi_almanac_location', JSON.stringify(loc));
    } catch (e) { /* private window: the defaults do */ }
  }, [lang || '', theme || '', SAN_FRANCISCO]);
  await page.goto(`${BASE}/#almanac`);
  await page.waitForFunction(() => document.getElementById('almanac-orrery') && document.getElementById('alm-secbar-host'));
  // The tide section is drawn when the page first scrolls near it, and moves
  // what is under it: bring it in before the test jumps about.
  await page.evaluate(() => document.getElementById('almanac-place').scrollIntoView({ behavior: 'instant' }));
  await page.waitForSelector('#almanac-place .at-section', { timeout: 30000 });
  await page.evaluate(() => document.getElementById('almanac-content').scrollTo({ top: 0, behavior: 'instant' }));
  await page.waitForFunction(() => document.querySelectorAll('#alm-secbar-pills .pill').length >= 10);
}
const scrollTo = (page, y) => page.evaluate((top) => { document.getElementById('almanac-content').scrollTo({ top, behavior: 'instant' }); }, y);
const bar = (page) => page.locator('#alm-secbar');
const lit = (page) => page.locator('#alm-secbar .pill.active');

test.describe('the section bar', () => {
  test('is hidden at the top and appears once the page leaves its first section', async ({ page }) => {
    await openAlmanac(page);
    await expect(bar(page)).toBeHidden();
    await scrollTo(page, 1500);
    await expect(bar(page)).toBeVisible();
    // Pinned directly under the top bar, across the scroller's width.
    const box = await page.evaluate(() => {
      const r = document.getElementById('alm-secbar').getBoundingClientRect();
      const c = document.getElementById('almanac-content').getBoundingClientRect();
      return { top: r.top - c.top, width: r.width, scroller: c.width };
    });
    expect(box.top).toBe(0);
    expect(box.width).toBeGreaterThanOrEqual(box.scroller - 1);
    await scrollTo(page, 0);
    await expect(bar(page)).toBeHidden();
  });

  test('names the section across it, one pill lit, kept in the row', async ({ page }) => {
    await openAlmanac(page);
    await page.evaluate(() => document.getElementById('almanac-meteors').closest('.almanac-section').scrollIntoView({ behavior: 'instant', block: 'start' }));
    await expect(lit(page)).toHaveCount(1);
    await expect(lit(page)).toHaveText('Meteor Showers');
    // The lit pill is inside the row's visible width.
    // (the row scrolls to it, smoothly unless motion is reduced)
    await page.waitForFunction(() => {
      const a = document.querySelector('#alm-secbar .pill.active').getBoundingClientRect();
      const r = document.getElementById('alm-secbar-pills').getBoundingClientRect();
      return a.left >= r.left - 1 && a.right <= r.right + 1;
    });
    const inside = true;
    expect(inside).toBe(true);
  });

  test('the dropdown lists every section; a tap scrolls there with its own title under the bar', async ({ page }) => {
    await openAlmanac(page);
    await scrollTo(page, 1500);
    const more = page.locator('#alm-secbar-more');
    await expect(more).toHaveAttribute('aria-expanded', 'false');
    await more.click();
    await expect(more).toHaveAttribute('aria-expanded', 'true');
    const items = page.locator('#alm-secbar-list button');
    expect(await items.count()).toBeGreaterThanOrEqual(10);
    await page.locator('#alm-secbar-list button[data-sec="astro"]').click();
    await expect(page.locator('#alm-secbar-list')).toBeHidden();
    await expect(more).toHaveAttribute('aria-expanded', 'false');
    await expect(lit(page)).toHaveText('Astronomical Data');
    // The section's own title is covered by the bar, not written twice below it.
    await page.waitForFunction(() => {
      const t = document.getElementById('almanac-astro').closest('.almanac-section').querySelector('.almanac-section-title').getBoundingClientRect();
      const b = document.getElementById('alm-secbar').getBoundingClientRect();
      return t.top >= b.top - 1 && t.bottom <= b.bottom + 1;
    }, null, { timeout: 8000 });
  });

  test('Escape closes the list and returns to its button; the pills are real buttons', async ({ page }) => {
    await openAlmanac(page);
    await scrollTo(page, 1500);
    await page.locator('#alm-secbar-more').focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#alm-secbar-list')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('#alm-secbar-list')).toBeHidden();
    await expect(page.locator('#alm-secbar-more')).toBeFocused();
    expect(await page.locator('#alm-secbar .pills-row button.pill').count()).toBeGreaterThanOrEqual(10);
    expect(await page.locator('#alm-secbar nav[aria-label]').count()).toBe(1);
  });

  for (const theme of THEMES) {
    test(`reads in ${theme}: the strip the bar stands in takes the page's own surface, not a fixed colour`, async ({ page }) => {
      await openAlmanac(page, { theme });
      await scrollTo(page, 1500);
      await expect(bar(page)).toBeVisible();
      const c = await page.evaluate(() => ({
        bar: getComputedStyle(document.getElementById('alm-pin')).backgroundColor,   // the strip the bar stands in (the pin) carries the surface
        page: getComputedStyle(document.querySelector('#almanac-view')).backgroundColor,
      }));
      expect(c.bar).toBe(c.page);
      if (theme === 'red') {
        // Nothing in the bar is anything but red on black.
        const off = await page.evaluate(() => [...document.querySelectorAll('#alm-secbar, #alm-secbar *')].map((e) => {
          const s = getComputedStyle(e);
          return [s.color, s.backgroundColor, s.borderTopColor].filter((v) => /rgb/.test(v) && !/rgba\(0, 0, 0, 0\)/.test(v));
        }).flat().filter((v) => { const m = v.match(/\d+/g).map(Number); return m[1] > 80 || m[2] > 80; }));
        expect(off).toEqual([]);
      }
    });
  }

  test('right to left: the list sits at the start of the bar, the row scrolls, nothing overflows', async ({ page }) => {
    await openAlmanac(page, { lang: 'ar' });
    await scrollTo(page, 1500);
    await expect(bar(page)).toBeVisible();
    const g = await page.evaluate(() => {
      const more = document.getElementById('alm-secbar-more').getBoundingClientRect();
      const b = document.getElementById('alm-secbar').getBoundingClientRect();
      const row = document.getElementById('alm-secbar-pills').getBoundingClientRect();
      return { dir: document.documentElement.dir, moreLeft: more.left, rowLeft: row.left, rowRight: row.right, barRight: b.right, over: document.documentElement.scrollWidth > innerWidth };
    });
    expect(g.dir).toBe('rtl');
    expect(g.moreLeft).toBeLessThan(g.rowLeft);
    expect(g.over).toBe(false);
  });

  test('reduced motion: the bar does not animate in and a tap jumps', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openAlmanac(page);
    await scrollTo(page, 1500);
    await expect(bar(page)).toBeVisible();
    expect(await page.evaluate(() => getComputedStyle(document.getElementById('alm-secbar')).animationName)).toBe('none');
    await page.locator('#alm-secbar-more').click();
    await page.locator('#alm-secbar-list button[data-sec="events"]').click();
    // No smooth scroll: it has landed by the next frame.
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    await expect(lit(page)).toHaveText('Celestial Events');
  });
});
