// The Earth view's "Satellite data from the internet", at a phone's width:
// the offer of fresh data under the controls (Ask first, the default) and
// the gear's panel, in the dark and light themes and in a right-to-left
// language. Everything stays on screen, nothing scrolls sideways, and Get
// fresh data redraws the view from its answer.
//
// Start a server first, on a fresh data folder (no ZIMs needed; the shipped
// orbital snapshot is more than six hours old, so there is stale data to
// offer, and on the host itself there is no admin gate):
//   ZIMI_BT=off ZIMI_NEARBY=off ZIM_DIR=/tmp/zimi-empty ZIMI_DATA_DIR=/tmp/zimi-empty-data \
//     python3 -m zimi serve --port 8877
// Run (SHOTS_DIR keeps the screenshots somewhere to read them):
//   BASE_URL=http://localhost:8877 SHOTS_DIR=/tmp/earth-shots npx playwright test \
//     --config=tests/playwright.config.mjs --reporter=list tests/test_almanac_earth_settings.spec.mjs
//
// The fetch itself is stood in for (the route answers as the server would
// after reaching CelesTrak), so the test never reaches the internet;
// tests/test_almanac_satellites.py drives the real route.

import { test, expect } from '@playwright/test';

const BASE = process.env.BASE_URL || 'http://localhost:8877';
const SHOTS = process.env.SHOTS_DIR || 'test-results/earth-settings';
// A service worker's fetches pass page.route by, and the stand-in for the
// fetch has to catch the POST: without this the test reached CelesTrak.
test.use({ serviceWorkers: 'block' });
const PHONE = { width: 390, height: 844 };
const SAN_FRANCISCO = { lat: 37.77, lon: -122.42, name: 'San Francisco' };

async function openEarth(page, { theme, lang }) {
  await page.setViewportSize(PHONE);
  await page.addInitScript(([th, lg, loc]) => {
    try {
      localStorage.setItem('zimi_app_theme', th);
      if (lg) localStorage.setItem('zimi_ui_lang', lg);
      sessionStorage.setItem('zimi_almanac_location', JSON.stringify(loc));
    } catch (e) { /* private window: the defaults do */ }
  }, [theme, lang || '', SAN_FRANCISCO]);
  await page.goto(`${BASE}/#almanac`);
  await page.waitForFunction(() => typeof window.openAlmanacEarth === 'function');
  await page.evaluate(() => window.openAlmanacEarth());
  await expect(page.locator('#ae-view')).toHaveClass(/open/);
  // The offer is written with the rest of the view's text, a few times a second.
  await expect(page.locator('#ae-ask')).toBeVisible();
}

// Nothing reaches past the screen's edges.
async function expectOnScreen(page, selector) {
  const box = await page.locator(selector).boundingBox();
  expect(box, selector + ' has a box').not.toBeNull();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(PHONE.width);
  expect(box.y + box.height).toBeLessThanOrEqual(PHONE.height);
}

async function expectNoSidewaysScroll(page) {
  const wide = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(wide).toBeLessThanOrEqual(PHONE.width);
}

for (const [theme, lang] of [['dark', ''], ['light', ''], ['dark', 'he']]) {
  const name = `${theme}${lang ? '-' + lang : ''}`;
  test(`the offer and the gear at 390px, ${name}`, async ({ page }) => {
    await openEarth(page, { theme, lang });
    if (lang === 'he') await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');

    // Ask first, stale data, the host itself: dated, and offered fresh.
    await expect(page.locator('#ae-fresh')).toBeVisible();
    await expectOnScreen(page, '#ae-fresh');
    await expectNoSidewaysScroll(page);
    if (!lang) {
      await expect(page.locator('#ae-ask-text')).toContainText('Orbital data from');
      await expect(page.locator('#ae-fresh')).toHaveText('Get fresh data');
      await expect(page.locator('#ae-note')).not.toContainText('Orbital data from');
    }
    await page.screenshot({ path: `${SHOTS}/ask-${name}.png` });

    // The gear: the three choices, Ask first chosen, an admin may change it.
    await page.locator('#ae-gear').click();
    const panel = page.locator('#ae-set');
    await expect(panel).toBeVisible();
    await expect(page.locator('#ae-gear')).toHaveAttribute('aria-expanded', 'true');
    await expect(panel.locator('input[name="ae-sat-mode"]')).toHaveCount(3);
    await expect(panel.locator('input[value="ask"]')).toBeChecked();
    await expect(panel.locator('input[value="never"]')).toBeEnabled();
    await expectOnScreen(page, '#ae-set');
    if (lang === 'he') {
      // Right to left, the gear and its panel sit on the left.
      const gear = await page.locator('#ae-gear').boundingBox();
      const back = await page.locator('#ae-back').boundingBox();
      expect(gear.x).toBeLessThan(back.x);
      expect((await panel.boundingBox()).x).toBeLessThan(PHONE.width / 2);
    }
    await page.screenshot({ path: `${SHOTS}/gear-${name}.png` });
    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();
    await expect(page.locator('#ae-view')).toHaveClass(/open/);
  });
}

test('the same setting in Server settings, saved on the server', async ({ page }) => {
  await page.setViewportSize(PHONE);
  await page.goto(`${BASE}/?manage=server`);
  const select = page.locator('#ms-sat-mode');
  await expect(select).toBeVisible({ timeout: 20000 });
  await expect(select.locator('option')).toHaveCount(3);
  await expect(select).toHaveValue('ask');
  await select.scrollIntoViewIfNeeded();
  await expectNoSidewaysScroll(page);
  await page.screenshot({ path: `${SHOTS}/server-settings.png` });
  await select.selectOption('never');
  await expect.poll(async () => (await (await fetch(`${BASE}/almanac-satellites`)).json()).mode).toBe('never');
  await expect(page.locator('#ms-sat-mode')).toHaveValue('never');
  await page.locator('#ms-sat-mode').selectOption('ask');
  await expect.poll(async () => (await (await fetch(`${BASE}/almanac-satellites`)).json()).mode).toBe('ask');
});

test('Get fresh data is one POST, and the view redraws from its answer', async ({ page }) => {
  const posts = [];
  await page.route('**/manage/satellites/refresh', async (route) => {
    posts.push(route.request().method());
    const now = await (await fetch(`${BASE}/almanac-satellites`)).json();
    await route.fulfill({
      json: Object.assign(now, { source: 'cache', fetched: new Date().toISOString().slice(0, 19) + 'Z', stale: false, can_change: true }),
    });
  });
  await openEarth(page, { theme: 'dark' });
  await page.locator('#ae-fresh').click();
  await expect(page.locator('#ae-ask')).toBeHidden();
  expect(posts).toEqual(['POST']);
  await expect(page.locator('#ae-note')).toContainText('Orbital data from');
  expect(await page.evaluate(() => _ae.sats.source)).toBe('cache');
});
