// The Almanac's orrery and 3D Earth as laid out in a browser, at a phone's
// width and a desktop's: the pieces the UX pass moved, held where a person
// needs them. The logic half is tests/test_almanac_ux.cjs.
//
//   1. The orrery's tip lets the planets under it through: from Earth's tip
//      the pointer reaches Mars, and still reaches a tip's Fly button by
//      crossing the tip's text. On a phone its button is a finger's size.
//   2. The Earth view: a tapped satellite's card stands above the controls
//      however tall the note under them grows; the first-open hint stays
//      off the "You" dot; a place's dot sits on the place, whichever side
//      its label hangs, left to right or right to left; a tapped button does
//      not keep a hover look on a phone.
//
// Start a server first, on its own folders (no ZIMs needed):
//   ZIMI_TORRENT=0 ZIMI_OFFLINE=1 ZIM_DIR=/tmp/zimi-empty ZIMI_DATA_DIR=/tmp/zimi-empty-data \
//     python3 -m zimi serve --port 8877
// Run:
//   BASE_URL=http://localhost:8877 npx playwright test \
//     --config=tests/playwright.config.mjs --reporter=list tests/test_almanac_ux.spec.mjs

import { test, expect } from '@playwright/test';

const BASE = process.env.BASE_URL || 'http://localhost:8877';
// The satellites route is stood in for below; a service worker's fetches
// would pass it by.
test.use({ serviceWorkers: 'block' });
const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1440, height: 900 };
const SAN_FRANCISCO = { lat: 37.77, lon: -122.42, name: 'San Francisco' };
const DAY = 86400000;

async function openAlmanac(page, { lang } = {}) {
  await page.addInitScript(([lg, loc]) => {
    try {
      if (lg) localStorage.setItem('zimi_ui_lang', lg);
      sessionStorage.setItem('zimi_almanac_location', JSON.stringify(loc));
    } catch (e) { /* private window: the defaults do */ }
  }, [lang || '', SAN_FRANCISCO]);
  await page.goto(`${BASE}/#almanac`);
  await page.waitForFunction(() => typeof window.openAlmanacEarth === 'function' && document.getElementById('almanac-orrery'));
  // Hold the orrery at now (1x) so the planets stay put under the pointer.
  await page.evaluate(() => {
    _orrerySnapToNow();
    document.getElementById('almanac-orrery').scrollIntoView({ block: 'center' });
  });
  // On a phone the header steps aside as the page scrolls: wait for the
  // canvas to settle before aiming at a planet.
  let last = null;
  for (let i = 0; i < 40; i++) {
    const top = await page.evaluate(() => document.getElementById('almanac-orrery').getBoundingClientRect().top);
    if (top === last) break;
    last = top;
    await page.waitForTimeout(150);
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
const tipName = (page) => page.evaluate(() => document.getElementById('orrery-tooltip').innerText.split('\n')[0]);

test.describe('the orrery', () => {
  test('its tip lets the planets under it through, and its button is still reached', async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await openAlmanac(page);
    // Earth's tip is placed among the inner planets; stand it on Mars.
    const earth = await bodyAt(page, 'Earth');
    await page.mouse.move(earth.x, earth.y);
    await expect(page.locator('#orrery-tooltip')).toBeVisible();
    await page.evaluate(() => {
      const tip = document.getElementById('orrery-tooltip');
      const r = document.getElementById('almanac-orrery').getBoundingClientRect();
      const mars = _orreryPlanetPositions.find((p) => p.name === 'Mars');
      const s = _orreryWorldToScreen(mars.x, mars.y);
      const w = tip.parentElement.getBoundingClientRect();
      tip.style.left = (r.left - w.left + s.x - 4) + 'px';
      tip.style.top = (r.top - w.top + s.y - 4) + 'px';
    });
    const mars = await bodyAt(page, 'Mars');
    await page.mouse.move(mars.x, mars.y, { steps: 4 });
    expect(await tipName(page)).toContain('Mars');

    // From Mars to its Fly button, slowly, across the tip's own text.
    const btn = await page.locator('#orrery-tooltip [data-orr-fly]').boundingBox();
    await page.mouse.move(btn.x + btn.width / 2, btn.y + btn.height / 2, { steps: 25 });
    await page.mouse.down();
    await page.mouse.up();
    expect(await page.evaluate(() => _orreryRockets.length && _orreryRockets[0].target)).toBe('Mars');
  });

  test('on a phone its Fly button and sliders are a finger\'s size', async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: PHONE, hasTouch: true, isMobile: true, serviceWorkers: 'block' });
    const page = await ctx.newPage();
    await openAlmanac(page);
    const mars = await bodyAt(page, 'Mars');
    await page.touchscreen.tap(mars.x, mars.y);
    const btn = await page.locator('#orrery-tooltip [data-orr-fly]').boundingBox();
    expect(btn.height).toBeGreaterThanOrEqual(32);
    const slider = await page.locator('#orrery-slider').boundingBox();
    expect(slider.height).toBeGreaterThanOrEqual(24);
    await ctx.close();
  });
});

// The view, opened at now with the satellites the server has.
async function openEarth(page) {
  await page.evaluate(() => window.openAlmanacEarth());
  await page.waitForFunction(() => _ae && _ae.gl && _ae.scene && _ae.sats && _ae.positions.length > 0, null, { timeout: 20000 });
}

// The dot of a place label against where the place projects.
function markOffset(page, id, latlon) {
  return page.evaluate(([id, ll]) => {
    const sc = _ae.scene;
    const p = _aeProject(_aeFixedToScene(_aeGeodeticToFixed(ll.lat, ll.lon), sc.gast));
    const c = document.getElementById('ae-canvas').getBoundingClientRect();
    const m = document.querySelector('#' + id + ' .ae-mark').getBoundingClientRect();
    return Math.hypot(m.left + m.width / 2 - (c.left + p.x), m.top + m.height / 2 - (c.top + p.y));
  }, [id, latlon]);
}

for (const lang of ['', 'he']) {
  test(`the Earth view on a phone${lang ? ' (' + lang + ')' : ''}: card, hint and the You dot`, async ({ browser }) => {
    test.setTimeout(120000);   // software WebGL: the first open builds the scene and loads the maps
    const ctx = await browser.newContext({ viewport: PHONE, hasTouch: true, isMobile: true, serviceWorkers: 'block' });
    const page = await ctx.newPage();
    // ISS data three weeks old: the note under the controls grows a second line.
    await page.route('**/almanac-satellites', async (route) => {
      const res = await route.fetch();
      const data = await res.json();
      data.iss = Object.assign({}, data.iss, { EPOCH: new Date(Date.now() - 21 * DAY).toISOString().replace('Z', '') });
      await route.fulfill({ response: res, json: data });
    });
    await openAlmanac(page, { lang });
    await openEarth(page);

    // The first-open hint stands clear of the You dot at the middle.
    const hint = await page.locator('#ae-hint').boundingBox();
    const you = await page.locator('#ae-lbl-you').boundingBox();
    expect(you, 'the You label is shown').not.toBeNull();
    expect(hint.y >= you.y + you.height || hint.y + hint.height <= you.y).toBe(true);

    // The dot sits on the place, whichever way the label hangs.
    expect(await markOffset(page, 'ae-lbl-you', SAN_FRANCISCO)).toBeLessThan(2);
    for (const turn of [0.05, -0.1]) {
      await page.evaluate((d) => { _aeTurnBy(d, 0); }, turn);
      await page.waitForTimeout(400);
      if (await page.locator('#ae-lbl-you').isVisible()) {
        expect(await markOffset(page, 'ae-lbl-you', SAN_FRANCISCO)).toBeLessThan(2);
      }
    }

    // A tapped satellite's card stands above the controls.
    await page.evaluate(() => {
      const p = _ae.positions.find((q) => !_ae.sats.list[q.idx].iss);
      _ae.selected = { norad: _ae.sats.list[p.idx].omm.NORAD_CAT_ID, tapMs: _aeDisplayMs() };
      _aeRenderCard();
    });
    await expect(page.locator('#ae-card')).toBeVisible();
    // The ISS's orbit-only line makes the note two lines (it was one that
    // the card's fixed offset had been measured against).
    await expect.poll(async () => (await page.locator('.ae-note').boundingBox()).height).toBeGreaterThan(20);
    const card = await page.locator('#ae-card').boundingBox();
    const views = await page.locator('#ae-views').boundingBox();
    expect(card.y + card.height).toBeLessThanOrEqual(views.y - 4);
    expect(card.y).toBeGreaterThan(0);

    // A tapped button keeps no hover look (it read as pressed).
    const idle = await page.locator('[data-ae-speed="60"]').evaluate((b) => getComputedStyle(b).backgroundColor);
    // (A software-rendered WebGL frame can be slow on a busy machine, and a
    // tap waits for the button to hold still across frames.)
    await page.locator('#ae-eclipse').tap({ timeout: 30000 });
    await page.waitForTimeout(300);
    const tapped = await page.locator('#ae-eclipse').evaluate((b) => getComputedStyle(b).backgroundColor);
    expect(tapped).toBe(idle);
    await ctx.close();
  });
}
