// The orrery's overlays at a phone's width and a desktop's: its tip (with
// "See the Sun up close" / "Fly there"), a probe's card and the Earth view's
// settings. Each puts itself away when a press lands outside it, on Escape,
// and on a phone by a 44px x; and the tip's button is always where a finger
// can reach it (the whole tip is on the screen, nothing over it).
//
// Start a server first, on its own fresh folders (no ZIMs needed):
//   ZIMI_TORRENT=0 ZIMI_OFFLINE=1 ZIM_DIR=/tmp/zimi-empty ZIMI_DATA_DIR=/tmp/zimi-empty-data \
//     python3 -m zimi serve --port 8877
// Run (SHOTS_DIR keeps the screenshots somewhere to read them):
//   BASE_URL=http://localhost:8877 SHOTS_DIR=/tmp/overlay-shots npx playwright test \
//     --config=tests/playwright.config.mjs --reporter=list tests/test_almanac_overlays.spec.mjs

import { test, expect } from '@playwright/test';

const BASE = process.env.BASE_URL || 'http://localhost:8877';
// A fresh data dir greets with "Welcome to Zimi" until a password is set;
// loopback may set it, as the other specs do.
test.beforeAll(async ({ request }) => {
  await request.post(`${BASE}/manage/set-password`, { headers: { 'Content-Type': 'application/json' }, data: { password: 'overlay-spec-pw' } });
});
const SHOTS = process.env.SHOTS_DIR || 'test-results/overlays';
test.use({ serviceWorkers: 'block' });
const PHONE = { width: 390, height: 664 };   // a phone's page under Safari's bars
const DESKTOP = { width: 1440, height: 900 };
const SAN_FRANCISCO = { lat: 37.77, lon: -122.42, name: 'San Francisco' };
const X_TARGET_PX = 44;

async function phone(browser) {
  return browser.newContext({ viewport: PHONE, hasTouch: true, isMobile: true, deviceScaleFactor: 2, serviceWorkers: 'block' });
}

async function openAlmanac(page) {
  await page.addInitScript((loc) => {
    try {
      localStorage.setItem('zimi_app_theme', 'dark');
      sessionStorage.setItem('zimi_almanac_location', JSON.stringify(loc));
    } catch (e) { /* private window: the defaults do */ }
  }, SAN_FRANCISCO);
  await page.goto(`${BASE}/#almanac`);
  await page.waitForFunction(() => typeof window.openAlmanacEarth === 'function' && document.getElementById('almanac-orrery'));
  await page.evaluate(() => _orreryClockReset());
}

// Scroll the page so the orrery's top edge stands `top` px from the window's.
async function orreryAt(page, top) {
  for (let i = 0; i < 3; i++) {
    await page.evaluate((t) => {
      const c = document.getElementById('almanac-orrery');
      let s = c.parentElement;
      while (s && !(s.scrollHeight > s.clientHeight + 5 && /auto|scroll/.test(getComputedStyle(s).overflowY))) s = s.parentElement;
      (s || document.scrollingElement).scrollTop += c.getBoundingClientRect().top - t;
    }, top);
    await page.waitForTimeout(500);
  }
}

// A body's place on the page (CSS px).
function bodyAt(page, name) {
  return page.evaluate((n) => {
    const r = document.getElementById('almanac-orrery').getBoundingClientRect();
    const q = n === 'Sun' ? _orrerySunPos : _orreryPlanetPositions.find((p) => p.name === n);
    const s = _orreryWorldToScreen(q.x, q.y);
    return { x: r.left + s.x, y: r.top + s.y };
  }, name);
}
const shown = (page, id) => page.evaluate((i) => { const e = document.getElementById(i); return !!e && e.getClientRects().length > 0; }, id);
// Somewhere on the page that is none of the orrery's: its section's title.
async function outsidePoint(page) {
  return page.evaluate(() => {
    const h = document.getElementById('almanac-orrery').closest('.almanac-section').firstElementChild;
    const r = h.getBoundingClientRect();
    return { x: r.left + 20, y: r.top + r.height / 2 };
  });
}
async function tipOnSun(page, tap) {
  const sun = await bodyAt(page, 'Sun');
  if (tap) await page.touchscreen.tap(sun.x, sun.y);
  else { await page.mouse.move(sun.x + 40, sun.y + 40); await page.mouse.move(sun.x, sun.y, { steps: 6 }); }
  await expect(page.locator('#orrery-tooltip')).toBeVisible();
}

test.describe('on a phone', () => {
  test('the Sun\'s button is on the screen, under no one\'s finger but its own, and opens the view', async ({ browser }) => {
    const ctx = await phone(browser);
    const page = await ctx.newPage();
    await openAlmanac(page);
    // The orrery half below the fold: the Sun low on the screen.
    await orreryAt(page, 350);
    await tipOnSun(page, true);
    const btn = page.locator('#orrery-tooltip [data-orr-earth="sun"]');
    await expect(btn).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/sun-tip-low.png` });
    const where = await page.evaluate(() => {
      const b = document.querySelector('#orrery-tooltip [data-orr-earth="sun"]').getBoundingClientRect();
      const bar = document.querySelector('.topbar').getBoundingClientRect();
      const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
      return { top: b.top, bottom: b.bottom, barBottom: bar.bottom, vh: innerHeight, onTop: !!hit && hit.matches('[data-orr-earth]') };
    });
    expect(where.top).toBeGreaterThanOrEqual(where.barBottom);
    expect(where.bottom).toBeLessThanOrEqual(where.vh);
    expect(where.onTop).toBe(true);
    await btn.tap();
    await expect(page.locator('#ae-view')).toHaveClass(/open/);
    expect(await page.evaluate(() => _ae.target)).toBe('sun');
    await ctx.close();
  });

  test('the tip closes on a press outside it, and by its x, a 44px target round a small glyph', async ({ browser }) => {
    const ctx = await phone(browser);
    const page = await ctx.newPage();
    await openAlmanac(page);
    await orreryAt(page, 200);
    await tipOnSun(page, true);
    const x = page.locator('#orrery-tooltip .alm-dismiss-x');
    await expect(x).toBeVisible();
    const box = await x.boundingBox();
    expect(box.width).toBeGreaterThanOrEqual(X_TARGET_PX);
    expect(box.height).toBeGreaterThanOrEqual(X_TARGET_PX);
    expect(parseFloat(await x.evaluate((e) => getComputedStyle(e).fontSize))).toBeLessThanOrEqual(20);
    await page.screenshot({ path: `${SHOTS}/sun-tip-x.png` });

    await x.tap();
    expect(await shown(page, 'orrery-tooltip')).toBe(false);

    await tipOnSun(page, true);
    const out = await outsidePoint(page);
    await page.touchscreen.tap(out.x, out.y);
    expect(await shown(page, 'orrery-tooltip')).toBe(false);

    // Closed, the body is a fresh first tap: the tip again, not the view.
    await tipOnSun(page, true);
    expect(await page.evaluate(() => document.getElementById('ae-view') && document.getElementById('ae-view').classList.contains('open'))).toBeFalsy();
    await ctx.close();
  });

  test('a planet\'s tip, Fly there, closes the same way', async ({ browser }) => {
    const ctx = await phone(browser);
    const page = await ctx.newPage();
    await openAlmanac(page);
    await orreryAt(page, 200);
    const mars = await bodyAt(page, 'Mars');
    await page.touchscreen.tap(mars.x, mars.y);
    await expect(page.locator('#orrery-tooltip [data-orr-fly]')).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/mars-tip.png` });
    const out = await outsidePoint(page);
    await page.touchscreen.tap(out.x, out.y);
    expect(await shown(page, 'orrery-tooltip')).toBe(false);
    await ctx.close();
  });

  test('a probe\'s card closes by a press outside and by its x', async ({ browser }) => {
    const ctx = await phone(browser);
    const page = await ctx.newPage();
    await openAlmanac(page);
    await orreryAt(page, 200);
    await page.evaluate(() => _showVoyagerCard(0));
    await expect(page.locator('#voyager-card')).toBeVisible();
    const box = await page.locator('#voyager-card .alm-dismiss-x').boundingBox();
    expect(box.width).toBeGreaterThanOrEqual(X_TARGET_PX);
    expect(box.height).toBeGreaterThanOrEqual(X_TARGET_PX);
    await page.screenshot({ path: `${SHOTS}/voyager-card.png` });
    await page.locator('#voyager-card .alm-dismiss-x').tap();
    expect(await shown(page, 'voyager-card')).toBe(false);

    await page.evaluate(() => _showVoyagerCard(0));
    const out = await outsidePoint(page);
    await page.touchscreen.tap(out.x, out.y);
    expect(await shown(page, 'voyager-card')).toBe(false);
    await ctx.close();
  });

  test('the Earth view\'s settings close by a press outside and by their x', async ({ browser }) => {
    const ctx = await phone(browser);
    const page = await ctx.newPage();
    await openAlmanac(page);
    await page.evaluate(() => window.openAlmanacEarth());
    await expect(page.locator('#ae-view')).toHaveClass(/open/);
    await page.locator('#ae-gear').tap();
    await expect(page.locator('#ae-set')).toBeVisible();
    const box = await page.locator('#ae-set .alm-dismiss-x').boundingBox();
    expect(box.width).toBeGreaterThanOrEqual(X_TARGET_PX);
    await page.screenshot({ path: `${SHOTS}/earth-settings.png` });
    await page.locator('#ae-set .alm-dismiss-x').tap();
    await expect(page.locator('#ae-set')).toBeHidden();

    await page.locator('#ae-gear').tap();
    await expect(page.locator('#ae-set')).toBeVisible();
    await page.touchscreen.tap(60, 400);
    await expect(page.locator('#ae-set')).toBeHidden();
    await ctx.close();
  });
});

test.describe('on a desktop', () => {
  test('Escape and a click outside put the tip and the probe\'s card away, and no x shows', async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await openAlmanac(page);
    await orreryAt(page, 300);
    await tipOnSun(page, false);
    expect(await page.locator('#orrery-tooltip .alm-dismiss-x').isVisible()).toBe(false);
    await page.keyboard.press('Escape');
    expect(await shown(page, 'orrery-tooltip')).toBe(false);

    await tipOnSun(page, false);
    const out = await outsidePoint(page);
    await page.mouse.click(out.x, out.y);
    expect(await shown(page, 'orrery-tooltip')).toBe(false);

    await page.evaluate(() => _showVoyagerCard(0));
    await expect(page.locator('#voyager-card')).toBeVisible();
    await page.keyboard.press('Escape');
    expect(await shown(page, 'voyager-card')).toBe(false);
  });

  test('the Sun\'s tip button opens the Sun view with the mouse', async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await openAlmanac(page);
    await orreryAt(page, 300);
    await tipOnSun(page, false);
    const btn = await page.locator('#orrery-tooltip [data-orr-earth="sun"]').boundingBox();
    await page.mouse.move(btn.x + btn.width / 2, btn.y + btn.height / 2, { steps: 20 });
    await page.mouse.down();
    await page.mouse.up();
    await expect(page.locator('#ae-view')).toHaveClass(/open/);
    expect(await page.evaluate(() => _ae.target)).toBe('sun');
  });
});
